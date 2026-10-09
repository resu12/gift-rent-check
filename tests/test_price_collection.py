"""Real collector/storage workflows for bounded, immutable comparison cohorts."""
from dataclasses import replace

import httpx
import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, LISTINGS_PATH
from marketapp_rent.collector import collect
from marketapp_rent.config import Settings
from marketapp_rent.price_collection import build_price_targets, collect_prices
from marketapp_rent.storage import Store


COLLECTION = "0:" + "33" * 32
OTHER = "0:" + "44" * 32
NFT = "0:" + "22" * 32


def gift(collection=COLLECTION, model="Nightmare", backdrop="Black", **changes):
    return {"nft_address": NFT, "collection_address": collection, "model": model,
            "backdrop": backdrop, "is_portfolio": True, "category": "portfolio", **changes}


def listing():
    return {"nft_address": NFT, "nft_name": "Example #1", "owner": "owner",
            "attributes": [{"trait_type": "Model", "value": "Nightmare"},
                           {"trait_type": "Backdrop", "value": "Black"}],
            "min_duration": 86400, "max_duration": 604800,
            "price_per_day": "12500000", "discount_per_day": 0, "listed_at": None}


class MockMarket:
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
        assert request.url.path == LISTINGS_PATH
        cursor = "opaque /?+= cursor" if self.paginated and "cursor" not in request.url.params else None
        return httpx.Response(200, json={"cursor": cursor, "items": [listing()] if self.items else []})

    def sleep(self, seconds):
        self.now += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond),
                         sleep=self.sleep, monotonic=lambda: self.now)


def test_targets_deduplicate_aliases_and_plan_broad_cohorts_before_exact_black():
    targets = build_price_targets([
        gift(OTHER, "A model", "Onyx Black"),
        gift(model="Z model"), gift(preferred_address(COLLECTION), "Z model"),
        gift(model="A model", backdrop="Red"),
        gift(OTHER, None),
    ])
    assert targets == [
        {"collection_address": COLLECTION}, {"collection_address": OTHER},
        {"collection_address": COLLECTION, "model": "A model"},
        {"collection_address": COLLECTION, "model": "Z model"},
        {"collection_address": OTHER, "model": "A model"},
        {"collection_address": COLLECTION, "model": "Z model", "backdrop": "Black"},
        {"collection_address": COLLECTION, "model": "A model", "backdrop": "Black"},
        {"collection_address": OTHER, "model": "A model", "backdrop": "Black"},
    ]
    assert build_price_targets(list(reversed([
        gift(OTHER, "A model", "Onyx Black"), gift(model="Z model"),
        gift(model="A model", backdrop="Red"),
    ]))) == targets


def test_targets_skip_unresolved_or_conflicting_identity_and_keep_unknown_model_baseline():
    targets = build_price_targets([
        gift(category="unresolved"), gift(is_portfolio=False), gift(collection_conflict=True),
        gift(collection=None), gift(collection="legacy-opaque-collection"),
        gift(model=None), gift(model=""),
    ])
    assert targets == [{"collection_address": COLLECTION}]


def test_price_collection_uses_only_documented_catalog_and_listing_parameters():
    with Store(":memory:") as store:
        api, linked = MockMarket(), []
        result = collect_prices(store, Settings(token="mock", page_size=100), gifts=[gift()],
                                client_factory=api.factory, on_run_created=linked.append)
        assert result.state == "complete"
        assert linked == [result.run_id]
        assert len(api.requests) == 2
        common = {"collection_address": preferred_address(COLLECTION), "sort_by": "recently_touch", "limit": "100"}
        assert [dict(request.url.params) for request in api.requests[1:]] == [
            common,
        ]
        run = store.get_run(result.run_id)
        assert run["settings"]["mode"] == "pricing"
        assert run["settings"]["requested_comparison_targets"] == [
            {"collection_address": preferred_address(COLLECTION)},
            {"collection_address": preferred_address(COLLECTION), "model": "Nightmare"},
            {"collection_address": preferred_address(COLLECTION), "model": "Nightmare", "backdrop": "Black"},
        ]
        assert {stream["kind"] for stream in store.streams(result.run_id)} == {"collection", "listing"}


def test_all_target_collections_are_planned_without_default_three_scope_limit():
    gifts = [gift(collection="0:" + f"{number:064x}", model=None) for number in range(1, 6)]
    with Store(":memory:") as store:
        api = MockMarket()
        result = collect_prices(store, Settings(token="mock", max_collections=1), gifts=gifts, client_factory=api.factory)
        assert result.state == "complete"
        run = store.get_run(result.run_id)
        assert len(run["scopes"]) == 5
        assert run["skipped_scopes"] == []
        assert len(store.streams(result.run_id)) == 6


def test_explicit_target_aliases_deduplicate_without_merging_distinct_backdrops():
    with Store(":memory:") as store:
        api = MockMarket()
        result = collect(store, Settings(token="mock"), comparison_targets=[
            {"collection_address": COLLECTION, "model": "Nightmare", "backdrop": "Black"},
            {"collection_address": preferred_address(COLLECTION), "model": "Nightmare", "backdrop": "Black"},
            {"collection_address": COLLECTION, "model": "Nightmare", "backdrop": "Onyx Black"},
        ], client_factory=api.factory)
        assert result.state == "complete"
        assert len(api.requests) == 3
        assert [request.url.params["backdrop"] for request in api.requests[1:]] == ["Black", "Onyx Black"]
        assert len(store.get_run(result.run_id)["settings"]["requested_comparison_targets"]) == 2


def test_empty_gifts_are_catalog_only_even_with_an_existing_portfolio(tmp_path):
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address\n{NFT},{OTHER}\n")
    with Store(":memory:") as store:
        store.import_portfolio(portfolio)
        api = MockMarket()
        result = collect_prices(store, Settings(token="mock"), gifts=[], client_factory=api.factory)
        assert result.state == "complete"
        assert [request.url.path for request in api.requests] == [COLLECTIONS_PATH]
        assert store.get_run(result.run_id)["settings"]["requested_comparison_targets"] == []
        assert store.get_run(result.run_id)["scopes"] == []


def test_bounded_price_resume_keeps_filters_cursors_and_page_size_despite_changed_view():
    with Store(":memory:") as store:
        api = MockMarket(paginated=True)
        settings = Settings(token="mock", page_size=100, max_pages=1)
        first = collect_prices(store, settings, gifts=[gift()], client_factory=api.factory)
        assert first.state == "partial"
        before = len(api.requests)
        result = collect_prices(store, replace(settings, page_size=10, sort_by="min_price"),
                                gifts=[gift(OTHER, "Different", "Red")], resume_id=first.run_id,
                                client_factory=api.factory)
        assert result.state == "complete"
        assert len(api.requests[before:]) == 1
        for request in api.requests[before:]:
            assert request.url.path == LISTINGS_PATH
            assert request.url.params["collection_address"] == preferred_address(COLLECTION)
            assert request.url.params["limit"] == "100"
            assert request.url.params["sort_by"] == "recently_touch"
            assert request.url.params["cursor"] == "opaque /?+= cursor"


def test_attempt_budget_retains_unstarted_targets_for_resume():
    with Store(":memory:") as store:
        api = MockMarket()
        settings = Settings(token="mock", max_attempts=1)
        first = collect_prices(store, settings, gifts=[gift()], client_factory=api.factory)
        assert first.state == "partial"
        assert len(api.requests) == 1
        assert len(store.streams(first.run_id)) == 4
        result = collect_prices(store, replace(settings, max_attempts=25), resume_id=first.run_id, client_factory=api.factory)
        assert result.state == "complete"
        assert len(api.requests) == 2


def test_comparison_replay_preserves_occurrences_and_fresh_snapshots():
    with Store(":memory:") as store:
        api = MockMarket(items=True)
        first = collect_prices(store, Settings(token="mock"), gifts=[gift()], client_factory=api.factory)
        assert store.connection.execute("SELECT count(*) FROM observations").fetchone()[0] == 1
        collect_prices(store, Settings(token="mock"), resume_id=first.run_id, client_factory=api.factory)
        assert len(api.requests) == 2
        fresh = collect_prices(store, Settings(token="mock"), gifts=[gift()], client_factory=api.factory)
        assert fresh.run_id != first.run_id
        assert store.connection.execute("SELECT count(*) FROM observations").fetchone()[0] == 2
        assert store.connection.execute("SELECT count(*) FROM records WHERE kind='listing'").fetchone()[0] == 1


def test_explicit_changed_resume_targets_are_rejected_before_http_and_aliases_are_allowed():
    with Store(":memory:") as store:
        api = MockMarket(paginated=True)
        settings = Settings(token="mock", max_pages=1)
        original = [{"collection_address": COLLECTION, "model": "Nightmare", "backdrop": "Black"}]
        first = collect(store, settings, comparison_targets=original, client_factory=api.factory)
        before = len(api.requests)
        for targets in ([], [{"collection_address": COLLECTION, "model": "Other"}], [{"collection_address": OTHER}]):
            with pytest.raises(ValueError, match="Cannot change comparison targets"):
                collect(store, settings, resume_id=first.run_id, comparison_targets=targets, client_factory=api.factory)
        assert len(api.requests) == before
        result = collect(store, settings, resume_id=first.run_id,
                         comparison_targets=[{**original[0], "collection_address": preferred_address(COLLECTION)}], client_factory=api.factory)
        assert result.state == "complete"


def test_price_resume_rejects_normal_collection_runs_before_http():
    with Store(":memory:") as store:
        api = MockMarket()
        first = collect(store, Settings(token="mock"), scope_manifest=[], client_factory=api.factory)
        with pytest.raises(ValueError, match="Only a pricing collection run"):
            collect_prices(store, Settings(token="mock"), resume_id=first.run_id, client_factory=api.factory)
        assert len(api.requests) == 1


@pytest.mark.parametrize("options", [
    {"scope_manifest": []}, {"collection_addresses": [COLLECTION]},
    {"model": "A"}, {"backdrop": "Black"}, {"symbol": "Sun"},
])
def test_comparison_targets_are_mutually_exclusive_with_global_filters(options):
    with Store(":memory:") as store:
        with pytest.raises(ValueError, match="mutually exclusive"):
            collect(store, Settings(token="mock"), comparison_targets=[], **options)
        assert store.runs() == []


@pytest.mark.parametrize("targets", [
    {}, [None], [{}], [{"collection_address": "legacy"}],
    [{"collection_address": COLLECTION, "model": ""}],
    [{"collection_address": COLLECTION, "model": None}],
    [{"collection_address": COLLECTION, "backdrop": 12}],
    [{"collection_address": COLLECTION, "symbol": "Sun"}],
])
def test_invalid_comparison_targets_create_no_run(targets):
    with Store(":memory:") as store:
        with pytest.raises(ValueError):
            collect(store, Settings(token="mock"), comparison_targets=targets)
        assert store.runs() == []
