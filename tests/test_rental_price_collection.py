"""Bounded historical comparisons use collection scopes and saved cursors only."""
import json
from dataclasses import replace

import httpx
import pytest

from marketapp_rent import cli
from marketapp_rent.addresses import preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH
from marketapp_rent.collector import collect
from marketapp_rent.config import Settings
from marketapp_rent.price_collection import build_rental_targets, collect_prices, collect_rental_prices
from marketapp_rent.storage import Store


COLLECTION = "0:" + "33" * 32
OTHER = "0:" + "44" * 32
NFT = "0:" + "22" * 32


def gift(collection=COLLECTION, **changes):
    return {"nft_address": NFT, "collection_address": collection, "model": "Nightmare",
            "backdrop": "Black", "is_portfolio": True, "category": "portfolio", **changes}


def history():
    return {"address": NFT, "name": "Example #1", "collection_address": COLLECTION,
            "ts": 1_791_475_200, "src": "source", "dst": "destination", "price": "0.15",
            "price_nano": "150000000", "currency": "GRAM", "duration": 86400}


class MockHistory:
    def __init__(self, *, paginated=False, items=False):
        self.requests = []
        self.now = 0.0
        self.paginated, self.items = paginated, items

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET"
        assert request.headers["Authorization"] == "mock"
        if request.url.path == COLLECTIONS_PATH:
            assert not request.url.params
            return httpx.Response(200, json=[])
        assert request.url.path == HISTORY_PATH
        assert set(request.url.params) <= {"collection_address", "order_by", "limit", "cursor"}
        cursor = "opaque /?+= cursor" if self.paginated and "cursor" not in request.url.params else None
        return httpx.Response(200, json={"cursor": cursor, "items": [history()] if self.items else []})

    def sleep(self, seconds):
        self.now += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond),
                         sleep=self.sleep, monotonic=lambda: self.now)


def test_rental_targets_are_unique_eligible_collections_without_trait_filters():
    assert build_rental_targets([
        gift(), gift(preferred_address(COLLECTION), model="Other", backdrop="Onyx Black"),
        gift(OTHER, model=None), gift(collection=None), gift(collection="legacy"),
        gift("0:" + "55" * 32, collection_conflict=True),
        gift("0:" + "66" * 32, category="unresolved"), gift("0:" + "77" * 32, is_portfolio=False),
    ]) == [COLLECTION, OTHER]


def test_only_catalog_and_documented_collection_history_parameters_are_requested():
    with Store(":memory:") as store:
        api, linked = MockHistory(), []
        result = collect_rental_prices(store, Settings(token="mock", page_size=100),
                                       gifts=[gift(), gift(model="Other")], client_factory=api.factory,
                                       on_run_created=linked.append)
        assert result.state == "complete"
        assert linked == [result.run_id]
        assert len(api.requests) == 2
        assert dict(api.requests[1].url.params) == {
            "collection_address": preferred_address(COLLECTION), "order_by": "new_to_old", "limit": "100",
        }
        run = store.get_run(result.run_id)
        assert run["settings"]["mode"] == "rental_pricing"
        assert run["settings"]["requested_rental_targets"] == [preferred_address(COLLECTION)]
        assert [stream["kind"] for stream in store.streams(result.run_id)] == ["collection", "history"]


def test_all_rental_scopes_are_planned_even_when_invocation_budget_stops_before_them():
    gifts = [gift("0:" + f"{number:064x}") for number in range(1, 6)]
    with Store(":memory:") as store:
        api = MockHistory()
        settings = Settings(token="mock", max_collections=1, max_attempts=2)
        first = collect_rental_prices(store, settings, gifts=gifts, client_factory=api.factory)
        assert first.state == "partial"
        assert len(api.requests) == 2
        run = store.get_run(first.run_id)
        assert len(run["scopes"]) == 5 and run["skipped_scopes"] == []
        assert len(store.streams(first.run_id)) == 6
        result = collect_rental_prices(store, replace(settings, max_attempts=25), resume_id=first.run_id,
                                       client_factory=api.factory)
        assert result.state == "complete"
        assert len(api.requests) == 6


def test_empty_targets_never_trigger_an_unfiltered_history_scan():
    with Store(":memory:") as store:
        api = MockHistory()
        result = collect_rental_prices(store, Settings(token="mock"), gifts=[], client_factory=api.factory)
        assert result.state == "complete"
        assert [request.url.path for request in api.requests] == [COLLECTIONS_PATH]
        assert store.get_run(result.run_id)["settings"]["requested_rental_targets"] == []


def test_empty_history_page_with_continuation_resumes_frozen_scope_order_size_and_cursor():
    with Store(":memory:") as store:
        api = MockHistory(paginated=True)
        settings = Settings(token="mock", page_size=100, max_pages=1)
        first = collect_rental_prices(store, settings, gifts=[gift()], client_factory=api.factory)
        assert first.state == "partial"
        result = collect_rental_prices(store, replace(settings, page_size=10, order_by="old_to_new"),
                                       gifts=[gift(OTHER)], resume_id=first.run_id, client_factory=api.factory)
        assert result.state == "complete"
        assert len(api.requests) == 3
        assert dict(api.requests[-1].url.params) == {
            "collection_address": preferred_address(COLLECTION), "order_by": "new_to_old",
            "limit": "100", "cursor": "opaque /?+= cursor",
        }


def test_explicit_target_changes_rejected_on_resume_but_address_aliases_allowed():
    with Store(":memory:") as store:
        api = MockHistory(paginated=True)
        settings = Settings(token="mock", max_pages=1)
        first = collect(store, settings, rental_targets=[COLLECTION], client_factory=api.factory)
        for targets in ([], [OTHER]):
            with pytest.raises(ValueError, match="Cannot change rental targets"):
                collect(store, settings, resume_id=first.run_id, rental_targets=targets, client_factory=api.factory)
            with pytest.raises(ValueError, match="Cannot change requested_rental_targets"):
                collect(store, settings, resume_id=first.run_id,
                        explicit_stream_options={"requested_rental_targets": targets}, client_factory=api.factory)
        assert len(api.requests) == 2
        result = collect(store, settings, resume_id=first.run_id,
                         rental_targets=[preferred_address(COLLECTION)], client_factory=api.factory)
        assert result.state == "complete"


def test_collection_modes_reject_cross_resume_without_http():
    with Store(":memory:") as store:
        api = MockHistory()
        settings = Settings(token="mock")
        rental = collect_rental_prices(store, settings, gifts=[], client_factory=api.factory)
        prices = collect_prices(store, settings, gifts=[], client_factory=api.factory)
        normal = collect(store, settings, scope_manifest=[], client_factory=api.factory)
        for other in (prices, normal):
            with pytest.raises(ValueError, match="Only a rental pricing collection run"):
                collect_rental_prices(store, settings, resume_id=other.run_id, client_factory=api.factory)
            with pytest.raises(ValueError, match="Cannot change rental targets"):
                collect(store, settings, resume_id=other.run_id, rental_targets=[], client_factory=api.factory)
        with pytest.raises(ValueError, match="Only a pricing collection run"):
            collect_prices(store, settings, resume_id=rental.run_id, client_factory=api.factory)
        with pytest.raises(ValueError, match="Cannot change comparison targets"):
            collect(store, settings, resume_id=rental.run_id, comparison_targets=[], client_factory=api.factory)
        assert len(api.requests) == 3


def test_replayed_completed_run_is_noop_and_fresh_run_preserves_history_occurrences():
    with Store(":memory:") as store:
        api = MockHistory(items=True)
        settings = Settings(token="mock")
        first = collect_rental_prices(store, settings, gifts=[gift()], client_factory=api.factory)
        collect_rental_prices(store, settings, resume_id=first.run_id, client_factory=api.factory)
        assert len(api.requests) == 2
        second = collect_rental_prices(store, settings, gifts=[gift()], client_factory=api.factory)
        assert first.run_id != second.run_id
        assert len(store.observations("history")) == 2
        assert store.connection.execute("SELECT count(*) FROM records WHERE kind='history'").fetchone()[0] == 1


@pytest.mark.parametrize("options", [
    {"scope_manifest": []}, {"collection_addresses": [COLLECTION]}, {"comparison_targets": []},
    {"model": "A"}, {"backdrop": "Black"}, {"symbol": "Sun"},
])
def test_rental_targets_reject_other_scopes_or_traits(options):
    with Store(":memory:") as store:
        with pytest.raises(ValueError, match="mutually exclusive"):
            collect(store, Settings(token="mock"), rental_targets=[], **options)
        assert not store.runs()


@pytest.mark.parametrize("targets", [{}, [None], [""], ["legacy"], [{"collection_address": COLLECTION}]])
def test_invalid_rental_targets_create_no_run(targets):
    with Store(":memory:") as store:
        with pytest.raises(ValueError):
            collect(store, Settings(token="mock"), rental_targets=targets)
        assert not store.runs()


def test_rental_cli_bounded_scan_resume_and_offline_history(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "mock")
    monkeypatch.delenv("MARKETAPP_OWNER_ADDRESS", raising=False)
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address,label\n{NFT},{COLLECTION},Owned gift\n")
    database = tmp_path / "rental-prices.sqlite3"
    args = ["--env-file", str(tmp_path / "absent.env"), "--db", str(database)]
    api = MockHistory(paginated=True, items=True)
    monkeypatch.setattr(cli, "collect_rental_prices", lambda store, settings, **kwargs:
                        collect_rental_prices(store, settings, client_factory=api.factory, **kwargs))
    assert cli.main(args + ["import-portfolio", str(portfolio)]) == 0
    capsys.readouterr()
    assert cli.main(args + ["collect-rental-prices", "--max-pages", "1"]) == 3
    first = json.loads(capsys.readouterr().out)
    assert first["state"] == "partial"
    assert cli.main(args + ["collect-rental-prices", "--resume", str(first["run_id"]), "--page-size", "10"]) == 2
    assert len(api.requests) == 2
    capsys.readouterr()
    assert cli.main(args + ["collect-rental-prices", "--resume", str(first["run_id"])]) == 0
    assert json.loads(capsys.readouterr().out)["run_id"] == first["run_id"]
    assert len(api.requests) == 3
    assert all(request.url.params.get("limit") == "100" for request in api.requests[1:])
    monkeypatch.delenv("MARKETAPP_API_TOKEN")
    with Store(database) as store:
        assert len(store.observations("history")) == 2
        assert store.observations("listing") == []
    assert cli.main(args + ["status"]) == 0
    assert len(api.requests) == 3


def test_rental_cli_missing_token_does_not_create_database(tmp_path, monkeypatch):
    monkeypatch.delenv("MARKETAPP_API_TOKEN", raising=False)
    database = tmp_path / "absent.sqlite3"
    assert cli.main(["--env-file", str(tmp_path / "none.env"), "--db", str(database), "collect-rental-prices"]) == 2
    assert not database.exists()
