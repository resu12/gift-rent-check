"""Integration coverage through the real client, collector, SQLite, and CLI."""

import csv
import json
import os
from dataclasses import replace

import httpx
import pytest

from marketapp_rent import cli
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH, LISTINGS_PATH
from marketapp_rent.collector import collect
from marketapp_rent.config import Settings
from marketapp_rent.reports import export_reports, status
from marketapp_rent.storage import Store


def listing(address="gift-a", **changes):
    return {
        "nft_address": address, "nft_name": "Example gift", "owner": "observed-owner",
        "attributes": [], "min_duration": 60, "max_duration": 3600,
        "price_per_day": "1234567890", "discount_per_day": 0, "listed_at": None,
        **changes,
    }


def history(address="gift-a", **changes):
    return {
        "address": address, "name": "Example gift", "collection_address": "collection-a",
        "ts": 123, "src": "source-wallet", "dst": "destination-wallet",
        "price": "1.23456789", "price_nano": "1234567890", "currency": "GRAM",
        "tx_hash": "shared-hash", **changes,
    }


def portfolio_file(tmp_path, rows=(('gift-a', 'collection-a'),)):
    path = tmp_path / "portfolio.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["nft_address", "collection_address"])
        writer.writerows(rows)
    return path


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


class MockAPI:
    """Keep the real API validation/retry path while advancing a fake clock."""

    def __init__(self, handler):
        self.handler = handler
        self.requests = []
        self.now = 0.0
        self.clients_created = 0

    def sleep(self, seconds):
        self.now += seconds

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET"
        assert request.headers["Authorization"] == "integration-test-token"
        result = self.handler(request)
        if result is not None:
            return result if isinstance(result, httpx.Response) else httpx.Response(200, json=result)
        if request.url.path == COLLECTIONS_PATH:
            return httpx.Response(200, json=[{"name": "Collection", "address": "collection-a", "extra_data": {}}])
        if request.url.path.endswith("/attributes/"):
            assert not request.url.params
            return httpx.Response(200, json={"attributes": []})
        assert request.url.path in {LISTINGS_PATH, HISTORY_PATH}
        return httpx.Response(200, json={"cursor": None, "items": []})

    def factory(self, *args, **kwargs):
        self.clients_created += 1
        return ApiClient(
            *args, **kwargs, transport=httpx.MockTransport(self.respond),
            monotonic=lambda: self.now, sleep=self.sleep, random=lambda: 0,
        )


@pytest.fixture
def settings():
    return Settings(token="integration-test-token")


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "collector.sqlite3") as value:
        value.import_portfolio(portfolio_file(tmp_path))
        yield value


def stream_of(store, run_id, kind):
    return next(stream for stream in store.streams(run_id) if stream["kind"] == kind)


def test_bounded_resume_preserves_queries_and_fresh_run_retains_snapshots(store, settings):
    cursor = "opaque /?+=& cursor"

    def handler(request):
        if request.url.path == LISTINGS_PATH:
            assert dict(request.url.params) == {
                "collection_address": "collection-a", "sort_by": "recently_touch",
                "limit": "10", "model": "Blue model", "symbol": "Star", "backdrop": "Night",
                **({"cursor": cursor} if "cursor" in request.url.params else {}),
            }
            return {"cursor": None, "items": [listing(), listing("gift-b")]} if "cursor" in request.url.params else {"cursor": cursor, "items": [listing()]}
        if request.url.path == HISTORY_PATH:
            assert request.url.params["order_by"] == "new_to_old"
            assert request.url.params["limit"] == "10"
            assert not {"model", "symbol", "backdrop"} & set(request.url.params)
            return {"cursor": None, "items": [history(), history(duration=2), history("gift-b")]} if "cursor" in request.url.params else {"cursor": "history-cursor", "items": [history()]}

    api = MockAPI(handler)
    initial = collect(
        store, replace(settings, max_pages=1), model="Blue model", symbol="Star", backdrop="Night",
        client_factory=api.factory,
    )
    assert initial.state == "partial"
    assert stream_of(store, initial.run_id, "listing")["next_cursor"] == cursor
    before = len(api.requests)
    # Environment/default changes do not mutate the saved request parameters.
    resumed = collect(
        store, replace(settings, page_size=77, sort_by="min_price", order_by="old_to_new"),
        resume_id=initial.run_id, client_factory=api.factory,
    )
    assert resumed.state == "complete"
    assert [request.url.path for request in api.requests[before:]] == [LISTINGS_PATH, HISTORY_PATH]
    assert len(store.records("listing")) == 2
    assert len(store.records("history")) == 3
    assert len(store.observations("listing")) == 3
    assert len(store.observations("history")) == 4
    assert len(store.observations("collection")) == 1
    fresh_start = len(api.requests)
    fresh = collect(
        store, settings, model="Blue model", symbol="Star", backdrop="Night",
        client_factory=api.factory,
    )
    assert fresh.state == "complete"
    assert fresh.run_id != initial.run_id
    first_listing = next(request for request in api.requests[fresh_start:] if request.url.path == LISTINGS_PATH)
    assert "cursor" not in first_listing.url.params
    assert len(store.records("history")) == 3
    assert len(store.observations("history")) == 8
    assert len(store.observations("listing")) == 6
    assert len(store.observations("collection")) == 2
    assert status(store)["resumable_runs"] == []


def test_empty_page_with_cursor_does_not_end_traversal(store, settings):
    def handler(request):
        if request.url.path == LISTINGS_PATH:
            if "cursor" not in request.url.params:
                return {"cursor": "after-empty", "items": []}
            assert request.url.params["cursor"] == "after-empty"
            return {"cursor": None, "items": [listing()]}

    api = MockAPI(handler)
    result = collect(store, settings, client_factory=api.factory)
    assert result.state == "complete"
    assert stream_of(store, result.run_id, "listing")["pages"] == 2
    assert len(store.observations("listing")) == 1


def test_process_failure_after_page_commit_resumes_at_saved_cursor(store, settings):
    def fail_after_first_page(request):
        if request.url.path == LISTINGS_PATH:
            if "cursor" in request.url.params:
                raise RuntimeError("simulated process failure")
            return {"cursor": "committed-next", "items": [listing()]}

    with pytest.raises(RuntimeError, match="simulated process failure"):
        collect(store, settings, client_factory=MockAPI(fail_after_first_page).factory)
    run = store.runs()[-1]
    assert run["state"] == "failed"
    assert stream_of(store, run["id"], "listing")["next_cursor"] == "committed-next"
    assert len(store.observations("listing")) == 1

    def finish_page(request):
        if request.url.path == LISTINGS_PATH:
            assert request.url.params["cursor"] == "committed-next"
            return {"cursor": None, "items": [listing("gift-b")]}

    api = MockAPI(finish_page)
    resumed = collect(store, settings, resume_id=run["id"], client_factory=api.factory)
    assert resumed.state == "complete"
    # The first history page completed in the initial round, before listings deepened.
    assert [request.url.path for request in api.requests] == [LISTINGS_PATH]
    assert len(store.observations("listing")) == 2
    assert len(store.observations("collection")) == 1


def test_cycle_keeps_raw_failed_response_and_committed_checkpoint(store, settings):
    api = MockAPI(lambda request: {"cursor": "cycle", "items": [listing()]} if request.url.path == LISTINGS_PATH else None)
    result = collect(store, settings, client_factory=api.factory)
    stream = stream_of(store, result.run_id, "listing")
    assert result.state == "partial"
    assert stream["state"] == "failed"
    assert stream["pages"] == 1
    assert stream["next_cursor"] == "cycle"
    assert len(store.observations("listing")) == 1
    attempts = store.connection.execute("SELECT body FROM attempts WHERE path=? ORDER BY id", (LISTINGS_PATH,)).fetchall()
    assert len(attempts) == 2
    assert json.loads(attempts[-1][0])["cursor"] == "cycle"
    assert any("cycle" in issue["message"] for issue in store.issues())


@pytest.mark.parametrize("bad_body", [b'{"cursor":null,"items":[{"nft_address":"bad"}]}', b'{invalid-json'])
def test_invalid_response_retained_without_checkpoint_and_resume_recovers(store, settings, bad_body):
    failed_api = MockAPI(lambda request: httpx.Response(200, content=bad_body) if request.url.path == LISTINGS_PATH else None)
    first = collect(store, settings, client_factory=failed_api.factory)
    stream = stream_of(store, first.run_id, "listing")
    assert first.state == "partial"
    assert stream["pages"] == 0 and stream["next_cursor"] is None
    assert not store.observations("listing")
    assert store.connection.execute("SELECT body FROM attempts WHERE path=?", (LISTINGS_PATH,)).fetchone()[0] == bad_body
    repaired_api = MockAPI(lambda request: {"cursor": None, "items": [listing()]} if request.url.path == LISTINGS_PATH else None)
    resumed = collect(store, settings, resume_id=first.run_id, client_factory=repaired_api.factory)
    assert resumed.state == "complete"
    assert len(repaired_api.requests) == 1
    assert "cursor" not in repaired_api.requests[0].url.params
    assert len(store.observations("listing")) == 1


def test_authentication_failure_halts_remaining_streams(store, settings):
    api = MockAPI(lambda request: httpx.Response(401, json={"detail": "unauthorized"}))
    result = collect(store, settings, client_factory=api.factory)
    assert result.state == "failed"
    assert len(api.requests) == 1
    assert api.requests[0].url.path == COLLECTIONS_PATH
    assert len(store.observations()) == 0
    assert store.issues()[0]["reason"] == "authentication"


def test_authentication_after_metadata_preserves_pages_and_cli_exits_one(store, settings, monkeypatch, capsys):
    api = MockAPI(lambda request: httpx.Response(401, json={"detail": "unauthorized"}) if request.url.path == LISTINGS_PATH else None)
    monkeypatch.setattr(cli, "load_settings", lambda *args: replace(settings, db_path=store.path))
    monkeypatch.setattr(cli, "collect", lambda *args, **kwargs: collect(*args, **kwargs, client_factory=api.factory))
    assert cli.main(["collect"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["state"] == "failed"
    assert result["pages_committed"] == 2
    assert [request.url.path for request in api.requests] == [
        COLLECTIONS_PATH, "/v1/collections/collection-a/attributes/", LISTINGS_PATH,
    ]
    assert len(store.observations("collection")) == 1
    assert stream_of(store, result["run_id"], "listing")["state"] == "failed"
    assert stream_of(store, result["run_id"], "history")["state"] == "pending"


def test_interrupted_stream_initialization_restores_saved_manifest(store, settings, monkeypatch):
    original_add_stream = store.add_stream
    created = 0

    def interrupted_add_stream(*args, **kwargs):
        nonlocal created
        created += 1
        if created == 2:
            raise RuntimeError("simulated stream initialization failure")
        return original_add_stream(*args, **kwargs)

    api = MockAPI(lambda request: None)
    monkeypatch.setattr(store, "add_stream", interrupted_add_stream)
    with pytest.raises(RuntimeError, match="stream initialization failure"):
        collect(store, settings, model="Saved model", client_factory=api.factory)
    run = store.runs()[-1]
    manifest = run["settings"]["streams"]
    assert len(manifest) == 4
    assert len(store.streams(run["id"])) == 1
    assert not api.requests
    monkeypatch.setattr(store, "add_stream", original_add_stream)
    resumed = collect(store, replace(settings, page_size=55), resume_id=run["id"], client_factory=api.factory)
    assert resumed.state == "complete"
    streams = store.streams(run["id"])
    assert len(streams) == len(manifest)
    assert [{key: stream[key] for key in ("kind", "path", "params")} for stream in streams] == manifest
    request = next(request for request in api.requests if request.url.path == LISTINGS_PATH)
    assert request.url.params["model"] == "Saved model"
    assert request.url.params["limit"] == "10"


def test_explicit_collection_whitespace_normalizes_consistently_on_resume(store, settings):
    def handler(request):
        if request.url.path == LISTINGS_PATH:
            assert request.url.params["collection_address"] == "collection-a"
            return {"cursor": None if "cursor" in request.url.params else "continue", "items": []}

    api = MockAPI(handler)
    initial = collect(
        store, replace(settings, max_pages=1), collection_addresses=[" collection-a ", "collection-a"],
        client_factory=api.factory,
    )
    assert initial.state == "partial"
    assert store.get_run(initial.run_id)["settings"]["requested_collections"] == ["collection-a"]
    resumed = collect(
        store, settings, resume_id=initial.run_id, collection_addresses=["collection-a "],
        explicit_stream_options={"requested_collections": [" collection-a", "collection-a "]},
        client_factory=api.factory,
    )
    assert resumed.state == "complete"
    assert len(store.streams(initial.run_id)) == 4


@pytest.mark.parametrize("resume", [False, True])
def test_retry_after_is_durable_across_later_invocations(store, settings, resume):
    limited = replace(settings, run_seconds=1)
    first_api = MockAPI(lambda request: httpx.Response(429, headers={"Retry-After": "3600"}, json={"detail": "rate limited"}))
    first = collect(store, limited, client_factory=first_api.factory)
    assert first.state == "partial"
    assert first.pages_committed == 0
    assert len(first_api.requests) == 1
    assert store.retry_not_before() is not None
    next_api = MockAPI(lambda request: None)
    later = collect(store, limited, resume_id=first.run_id if resume else None, client_factory=next_api.factory)
    assert later.state == "partial"
    assert later.pages_committed == 0
    assert not next_api.requests
    assert store.connection.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 1
    assert not store.observations()


def test_scopes_are_sorted_and_all_skipped_scopes_remain_partial(tmp_path, settings):
    with Store(tmp_path / "scopes.sqlite3") as store:
        store.import_portfolio(portfolio_file(tmp_path, [("gift-c", "collection-c"), ("gift-b", "collection-b"), ("gift-a", "collection-a"), ("unknown", "")]))
        api = MockAPI(lambda request: None)
        first = collect(store, replace(settings, max_collections=2), client_factory=api.factory)
        run = store.get_run(first.run_id)
        assert run["scopes"] == ["collection-a", "collection-b"]
        assert run["skipped_scopes"] == ["collection-c", "<unfiltered>"]
        assert first.state == "partial" and first.reason == "scope_limit"
        assert all(stream["state"] == "complete" for stream in store.streams(first.run_id))
        call_count = len(api.requests)
        resumed = collect(store, settings, resume_id=first.run_id, client_factory=api.factory)
        assert resumed.state == "partial" and resumed.reason == "scope_limit"
        assert len(api.requests) == call_count


@pytest.mark.parametrize("changed", [
    {"page_size": 11}, {"sort_by": "min_price"}, {"order_by": "old_to_new"},
    {"model": "different"}, {"requested_collections": ["collection-b"]},
])
def test_incompatible_explicit_resume_options_fail_before_http(store, settings, changed):
    api = MockAPI(lambda request: {"cursor": "continue", "items": []} if request.url.path == LISTINGS_PATH else None)
    first = collect(store, replace(settings, max_pages=1), client_factory=api.factory)
    count = len(api.requests)
    clients = api.clients_created
    with pytest.raises(ValueError, match="Cannot change"):
        collect(store, settings, resume_id=first.run_id, explicit_stream_options=changed, client_factory=api.factory)
    assert len(api.requests) == count
    assert api.clients_created == clients


def test_address_only_history_provenance_does_not_claim_personal_proceeds(tmp_path, settings):
    def handler(request):
        if request.url.path == LISTINGS_PATH:
            assert "collection_address" not in request.url.params
            return {"cursor": None, "items": [listing()]}
        if request.url.path == HISTORY_PATH:
            return {"cursor": None, "items": [history(), history("non-portfolio")]}

    with Store(tmp_path / "provenance.sqlite3") as store:
        store.import_portfolio(portfolio_file(tmp_path, [("gift-a", ""), ("absent-gift", "")]))
        result = collect(store, settings, client_factory=MockAPI(handler).factory)
        assert result.state == "complete"
        out = tmp_path / "exports"
        export_reports(store, out, owner_address="configured-wallet")
        coverage = {row["nft_address"]: row for row in read_csv(out / "portfolio_coverage.csv")}
        assert coverage["gift-a"]["collection_address"] == "collection-a"
        assert coverage["gift-a"]["collection_source"] == "observed_history"
        assert coverage["gift-a"]["last_observed_owner_comparison"] == "conflict"
        assert coverage["absent-gift"]["current_visibility"] == "unknown"
        assert coverage["absent-gift"]["price_per_day_gram"] == ""
        rows = {row["nft_address"]: row for row in read_csv(out / "history_records.csv")}
        assert rows["gift-a"]["history_classification"] == "portfolio gift history"
        assert rows["non-portfolio"]["history_classification"] == "market gift history"
        assert rows["gift-a"]["src_dst_roles"] == "unspecified"
        assert rows["gift-a"]["gross_net_semantics"] == "unspecified"
        assert rows["gift-a"]["timestamp_unit"] == rows["gift-a"]["duration_unit"] == "unspecified"
        assert not {"revenue", "net_income", "owner_proceeds"} & set(rows["gift-a"])


def test_missing_gift_in_new_run_keeps_prior_observation_without_current_claim(store, settings, tmp_path):
    first_api = MockAPI(lambda request: {"cursor": None, "items": [listing()]} if request.url.path == LISTINGS_PATH else None)
    first = collect(store, settings, client_factory=first_api.factory)
    second = collect(store, settings, client_factory=MockAPI(lambda request: None).factory)
    assert first.state == second.state == "complete"
    out = tmp_path / "missing-gift-export"
    export_reports(store, out)
    row = read_csv(out / "portfolio_coverage.csv")[0]
    assert row["current_visibility"] == "unknown"
    assert row["last_observed_run_id"] == str(first.run_id)
    assert row["latest_run_id"] == str(second.run_id)
    assert row["price_per_day_gram"] == "1.234567890"
    assert row["membership"] == "user_declared"
    assert status(store)["unknown_current_visibility"] == ["gift-a"]


def test_cli_import_collect_status_and_reports_offline(tmp_path, settings, monkeypatch, capsys):
    for name in list(os.environ):
        if name.startswith("MARKETAPP_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("MARKETAPP_API_TOKEN", settings.token)
    csv_path = portfolio_file(tmp_path)
    prefix = ["--env-file", str(tmp_path / "missing.env"), "--db", str(tmp_path / "cli.sqlite3")]
    assert cli.main(prefix + ["import-portfolio", str(csv_path)]) == 0
    assert json.loads(capsys.readouterr().out)["inserted"] == 1
    api = MockAPI(lambda request: {"cursor": None, "items": [listing()]} if request.url.path == LISTINGS_PATH else None)
    monkeypatch.setattr(cli, "collect", lambda *args, **kwargs: collect(*args, **kwargs, client_factory=api.factory))
    assert cli.main(prefix + ["collect"]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "complete"
    monkeypatch.delenv("MARKETAPP_API_TOKEN")

    def no_network(*args, **kwargs):
        raise AssertionError("Offline CLI command attempted HTTP")

    monkeypatch.setattr(httpx.Client, "get", no_network)
    assert cli.main(prefix + ["status"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["portfolio_count"] == summary["run_count"] == 1
    out = tmp_path / "cli-exports"
    assert cli.main(prefix + ["report", "--out", str(out), "--owner-address", "observed-owner"]) == 0
    exported = json.loads(capsys.readouterr().out)["reports"]
    assert len(exported) >= 6
    assert read_csv(out / "portfolio_coverage.csv")[0]["last_observed_owner_comparison"] == "match"
    assert read_csv(out / "listing_observations.csv")[0]["price_per_day_gram"] == "1.234567890"
