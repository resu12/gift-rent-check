"""Explicit wallet collection scopes cannot widen into the whole database."""
from dataclasses import replace

import httpx
import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH, LISTINGS_PATH
from marketapp_rent.collector import collect
from marketapp_rent.config import Settings
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.storage import Store


COLLECTION = "0:" + "33" * 32
OTHER_COLLECTION = "0:" + "44" * 32
NFT = "0:" + "22" * 32
WALLET = "0:" + "11" * 32


class MockMarket:
    def __init__(self, *, continue_listings=False):
        self.requests = []
        self.now = 0.0
        self.continue_listings = continue_listings

    def respond(self, request):
        self.requests.append(request)
        if request.url.path == COLLECTIONS_PATH:
            body = []
        elif request.url.path.endswith("/attributes/"):
            body = {"attributes": []}
        else:
            cursor = "saved-cursor" if self.continue_listings and request.url.path == LISTINGS_PATH and "cursor" not in request.url.params else None
            body = {"cursor": cursor, "items": []}
        return httpx.Response(200, json=body)

    def sleep(self, seconds):
        self.now += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond),
                         monotonic=lambda: self.now, sleep=self.sleep)


@pytest.mark.parametrize("scopes,expected", [
    ([COLLECTION, None], [preferred_address(COLLECTION), None]),
    ([None], [None]),
    ([], []),
])
def test_explicit_wallet_scope_includes_unknown_and_never_falls_back(tmp_path, scopes, expected):
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address\n{NFT},{OTHER_COLLECTION}\n")
    with Store(":memory:") as store:
        store.import_portfolio(portfolio)
        api = MockMarket()
        result = collect(store, Settings(token="mock"), scope_manifest=scopes, client_factory=api.factory)
        assert result.state == "complete"
        assert store.get_run(result.run_id)["scopes"] == expected
        for path in (LISTINGS_PATH, HISTORY_PATH):
            assert [request.url.params.get("collection_address") for request in api.requests if request.url.path == path] == expected
        if not expected:
            assert [request.url.path for request in api.requests] == [COLLECTIONS_PATH]


def test_scope_manifest_is_saved_canonical_and_immutable_when_resuming():
    with Store(":memory:") as store:
        api = MockMarket(continue_listings=True)
        settings = Settings(token="mock", max_pages=1)
        first = collect(store, settings, scope_manifest=[None, COLLECTION, preferred_address(COLLECTION), None], client_factory=api.factory)
        assert first.state == "partial"
        assert store.get_run(first.run_id)["settings"]["requested_scope_manifest"] == [preferred_address(COLLECTION), None]
        count = len(api.requests)
        for changed in ([COLLECTION], [None], [], [OTHER_COLLECTION, None]):
            with pytest.raises(ValueError, match="Cannot change scope manifest"):
                collect(store, settings, resume_id=first.run_id, scope_manifest=changed, client_factory=api.factory)
        assert len(api.requests) == count
        resumed = collect(store, replace(settings, max_collections=1), resume_id=first.run_id,
                          scope_manifest=[preferred_address(COLLECTION), None], client_factory=api.factory)
        assert resumed.state == "complete"
        resumed_requests = api.requests[count:]
        assert len(resumed_requests) == 2
        assert all(request.url.path == LISTINGS_PATH and request.url.params["cursor"] == "saved-cursor" for request in resumed_requests)
        assert {request.url.params.get("collection_address") for request in resumed_requests} == {preferred_address(COLLECTION), None}


def test_resume_without_scope_manifest_uses_saved_streams():
    with Store(":memory:") as store:
        api = MockMarket(continue_listings=True)
        settings = Settings(token="mock", max_pages=1)
        first = collect(store, settings, scope_manifest=[None], client_factory=api.factory)
        resumed = collect(store, settings, resume_id=first.run_id, client_factory=api.factory)
        assert resumed.state == "complete"
        assert store.get_run(first.run_id)["scopes"] == [None]


def test_manifest_scope_limit_reports_skipped_unfiltered_work():
    with Store(":memory:") as store:
        api = MockMarket()
        result = collect(store, Settings(token="mock", max_collections=1),
                         scope_manifest=[COLLECTION, None], client_factory=api.factory)
        run = store.get_run(result.run_id)
        assert result.state == "partial"
        assert result.reason == "scope_limit"
        assert run["skipped_scopes"] == ["<unfiltered>"]
        assert run["settings"]["requested_scope_manifest"] == [preferred_address(COLLECTION), None]


@pytest.mark.parametrize("manifest", [[""], [" "], [123], "collection", [False]])
def test_invalid_scope_manifest_is_rejected_before_creating_work(manifest):
    with Store(":memory:") as store:
        with pytest.raises(ValueError, match="Scope manifest"):
            collect(store, Settings(token="mock"), scope_manifest=manifest)
        assert store.runs() == []


def test_collection_filters_and_scope_manifest_are_mutually_exclusive():
    with Store(":memory:") as store:
        with pytest.raises(ValueError, match="mutually exclusive"):
            collect(store, Settings(token="mock"), collection_addresses=[COLLECTION], scope_manifest=[])
        assert store.runs() == []


def test_late_conflicting_collection_is_collected_only_through_unfiltered_scope():
    with Store(":memory:") as store:
        discovery = DiscoveryStore(store)
        run = discovery.create_run(WALLET, {})
        discovery.save_catalog(run, {"body": b"[]", "status_code": 200,
                                     "observed_at": "2026-10-08T09:00:00+00:00"}, [COLLECTION])
        discovery.add_candidates(run, [{"nft_address": NFT, "source": "holdings", "collection_address": COLLECTION}])
        discovery.commit_verification(run, NFT, {
            "verified": True, "wallet_address": WALLET, "nft_address": NFT,
            "collection_address": COLLECTION, "rental_state": "held_directly",
            "observed_at": "2026-10-08T10:00:00+00:00",
        }, [])
        discovery.add_candidates(run, [{"nft_address": NFT, "source": "transfers", "collection_address": OTHER_COLLECTION}])
        gift = store.portfolio()[0]
        assert gift["collection_conflict"] is True
        assert gift["collection_address"] is None
        api = MockMarket()
        result = collect(store, Settings(token="mock"), scope_manifest=[gift["collection_address"]], client_factory=api.factory)
        assert result.state == "complete"
        assert store.get_run(result.run_id)["scopes"] == [None]
        assert all("collection_address" not in request.url.params for request in api.requests)
