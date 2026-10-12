"""Projection work stays scoped, reusable and bounded without losing evidence."""
from collections import Counter
from datetime import datetime, timezone
import json

from marketapp_rent.addresses import preferred_address
from marketapp_rent.domain import ApiResponse
from marketapp_rent.models import parse_page
from marketapp_rent.storage import Store, ProjectionContext
import marketapp_rent.dashboard_view as views


WALLET, NFT, OTHER, COLLECTION = ("0:" + character * 64 for character in "1234")
NOW = datetime(2026, 10, 11, 12, tzinfo=timezone.utc)
STAMP = "2026-10-10T12:00:00Z"


def history(nft, *, name="Synthetic", timestamp=1791633600):
    return {"address": nft, "name": name, "collection_address": COLLECTION,
            "src": WALLET, "dst": OTHER, "ts": timestamp, "price": "0.3",
            "price_nano": "300000000", "currency": "GRAM", "duration": 86400,
            "is_extend": False, "tx_hash": None}


def save(store, items, stamp=STAMP):
    run = store.create_run({}, [COLLECTION], [])
    stream = store.add_stream(run, "history", "/v1/rent/gifts/history/", {"collection_address": COLLECTION})
    raw = json.dumps({"items": items, "cursor": None}).encode()
    store.commit_page(stream, None, ApiResponse(raw, 200, stamp), parse_page("history", raw))


def portfolio(store, tmp_path):
    path = tmp_path / "synthetic.csv"
    path.write_text(f"nft_address,collection_address,label\n{NFT},{COLLECTION},Synthetic gift\n")
    store.import_portfolio(path)


def freeze(monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(NOW.timestamp(), tz)
    import marketapp_rent.pricing as pricing
    import marketapp_rent.pricing_window as windows
    import marketapp_rent.rental_counts as counts
    import marketapp_rent.price_tracking as tracking
    for module in (pricing, windows, counts, tracking):
        monkeypatch.setattr(module, "datetime", FixedDatetime)
    monkeypatch.setattr(views, "utc_now", lambda: NOW.isoformat())


def test_scoped_reads_keep_friendly_aliases_and_opaque_legacy_identities():
    with Store(":memory:") as store:
        save(store, [history(NFT), history(preferred_address(NFT)), history(OTHER), history("legacy")])
        rows = store.observations("history", identities={NFT})
        assert len(rows) == 2
        assert {row["identity"] for row in rows} == {NFT, preferred_address(NFT)}
        assert len(store.records("history", identities={NFT})) == 2
        assert [row["identity"] for row in store.observations("history", identities={"legacy"})] == ["legacy"]
        assert store.observations("history", identities=[]) == []


def test_request_context_reuses_reads_and_does_not_leak_new_commits():
    with Store(":memory:") as store:
        save(store, [history(NFT), history(OTHER)])
        calls = Counter()
        original = store.iter_observations
        def counted(kind=None, **options):
            calls[kind] += 1
            yield from original(kind, **options)
        store.iter_observations = counted
        context = ProjectionContext(store)
        before = list(context.observations("history"))
        assert list(context.observations("history")) == before
        assert len(list(context.observations("history", identities={NFT}))) == 1
        assert calls["history"] == 1
        save(store, [history(NFT, name="Later")])
        assert list(context.observations("history")) == before
        assert len(list(ProjectionContext(store).observations("history"))) == 3


def test_cache_limits_stream_every_row_without_retaining_partial_results():
    with Store(":memory:") as store:
        save(store, [history(NFT), history(OTHER)])
        expected = store.observations("history")
        for limits in ({"max_rows": 1}, {"max_bytes": 1}):
            context = ProjectionContext(store, **limits)
            assert list(context.observations("history")) == expected
            assert list(context.observations("history")) == expected
            assert context._cached_rows == 0 and context._cached_bytes == 0


def test_dashboard_matches_uncached_evidence_and_loads_each_scope_once(tmp_path, monkeypatch):
    freeze(monkeypatch)
    with Store(":memory:") as store:
        portfolio(store, tmp_path)
        save(store, [history(NFT), history(preferred_address(NFT)), history(OTHER)])
        save(store, [history(NFT), history(OTHER)])
        with monkeypatch.context() as patch:
            patch.setattr(views, "ProjectionContext", lambda original: original)
            expected = views.build_dashboard(store, WALLET, pricing_source="rentals")
        calls = Counter()
        original = store.iter_observations
        def counted(kind=None, **options):
            scope = options.get("identities")
            calls[(kind, None if scope is None else tuple(scope))] += 1
            yield from original(kind, **options)
        store.iter_observations = counted
        actual = views.build_dashboard(store, WALLET, pricing_source="rentals")
        assert actual == expected
        assert calls[("history", (NFT,))] == 1
        assert calls[("history", None)] == 1
        assert all(count == 1 for count in calls.values())


def test_activity_formats_only_the_newest_hundred_with_stable_ties(tmp_path, monkeypatch):
    freeze(monkeypatch)
    with Store(":memory:") as store:
        portfolio(store, tmp_path)
        for _ in range(3):
            save(store, [history(NFT)] * 100)
        prices = []
        original = views._decimal
        def counted(value, **options):
            if value is not None:
                prices.append(value)
            return original(value, **options)
        monkeypatch.setattr(views, "_decimal", counted)
        result = views.build_dashboard(store, WALLET)
        assert len(result["activity"]) == 100
        assert [row["id"] for row in result["activity"]] == [f"history-{index}" for index in range(1, 101)]
        assert prices == ["0.3"] * 100
        assert store.connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 300


def test_legacy_oversized_numeric_extension_is_excluded_without_deleting_history(tmp_path, monkeypatch):
    freeze(monkeypatch)
    with Store(":memory:") as store:
        portfolio(store, tmp_path)
        save(store, [history(NFT)])
        source = store.connection.execute("SELECT source_json FROM records WHERE kind='history'").fetchone()[0]
        unsafe = source[:-1] + ',"legacy_extra":1e10000}'
        store.connection.execute("UPDATE records SET source_json=? WHERE kind='history'", (unsafe,))
        store.connection.commit()
        result = views.build_dashboard(store, WALLET, pricing_source="rentals")
        assert result["gifts"][0]["pricing"]["recommended_price_per_day"] is None
        assert result["pricing"]["excluded_counts"]["malformed_history"] == 1
        assert store.connection.execute("SELECT source_json FROM records WHERE kind='history'").fetchone()[0] == unsafe


def test_legacy_oversized_history_amount_does_not_allocate_expanded_activity_text(tmp_path, monkeypatch):
    freeze(monkeypatch)
    with Store(":memory:") as store:
        portfolio(store, tmp_path)
        save(store, [history(NFT)])
        row = store.connection.execute("SELECT source_json,data_json FROM records WHERE kind='history'").fetchone()
        source, data = json.loads(row[0]), json.loads(row[1])
        source.update(price="1e10000", price_nano="1e10009")
        data.update(price="1e10000", price_nano="1e10009")
        store.connection.execute("UPDATE records SET source_json=?,data_json=? WHERE kind='history'", (json.dumps(source), json.dumps(data)))
        store.connection.commit()
        result = views.build_dashboard(store, WALLET, pricing_source="rentals")
        assert result["activity"][0]["price"] is None
        assert result["gifts"][0]["pricing"]["recommended_price_per_day"] is None
        assert store.connection.execute("SELECT COUNT(*) FROM records WHERE kind='history'").fetchone()[0] == 1
