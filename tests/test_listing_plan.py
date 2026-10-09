"""Adaptive listing traversals preserve unbiased provenance and bounded resumes."""
from dataclasses import replace
from datetime import datetime, timezone
import json

import httpx
import pytest

from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, LISTINGS_PATH
from marketapp_rent.config import Settings
from marketapp_rent.listing_plan import COVERED_REASON, POLICY, listing_refresh_summary
from marketapp_rent.price_collection import collect_prices
from marketapp_rent.pricing import enrich_pricing
from marketapp_rent.storage import Store


COLLECTION = "0:" + "33" * 32
OTHER = "0:" + "44" * 32
NFT = "0:" + "22" * 32
OWNER = "0:" + "11" * 32
GIFT = {"nft_address": NFT, "collection_address": COLLECTION, "model": "A",
        "backdrop": "Black", "is_portfolio": True, "category": "portfolio"}
SETTINGS = Settings(token="mock", page_size=100, max_pages=2)


def listing(nft=NFT, model="A", backdrop="Black", nano="100000000", attributes=None):
    return {"nft_address": nft, "nft_name": "Irrelevant name #1", "owner": OWNER,
            "attributes": attributes if attributes is not None else [
                {"trait_type": field, "value": value} for field, value in (("Model", model), ("Backdrop", backdrop)) if value is not None],
            "min_duration": 1, "max_duration": 30, "price_per_day": nano,
            "discount_per_day": 0, "listed_at": None}


def page(cursor=None, *items):
    return {"cursor": cursor, "items": list(items)}


class Market:
    def __init__(self, pages):
        self.pages, self.requests, self.now = pages, [], 0.0

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET" and request.headers["Authorization"] == "mock"
        if request.url.path == COLLECTIONS_PATH:
            return httpx.Response(200, json=[])
        assert request.url.path == LISTINGS_PATH
        assert set(request.url.params) <= {"collection_address", "sort_by", "limit", "model", "backdrop", "cursor"}
        key = tuple(request.url.params.get(field) for field in ("model", "backdrop", "cursor"))
        return httpx.Response(200, json=self.pages[key])

    def sleep(self, seconds):
        self.now += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond), sleep=self.sleep, monotonic=lambda: self.now)

    @property
    def listings(self):
        return [request for request in self.requests if request.url.path == LISTINGS_PATH]


def collect(store, market, **kwargs):
    return collect_prices(store, kwargs.pop("settings", SETTINGS), gifts=[GIFT], client_factory=market.factory, **kwargs)


def streams(store, result):
    return [stream for stream in store.streams(result.run_id) if stream["kind"] == "listing"]


def test_complete_broad_scan_reuses_model_and_black_without_fabricated_targeted_observations():
    api = Market({(None, None, None): page(None, listing(),
        listing("0:" + "55" * 32, backdrop="Red", nano="200000000"),
        listing("0:" + "66" * 32, model="B", nano="300000000"))})
    with Store(":memory:") as store:
        result = collect(store, api)
        assert result.state == "complete" and len(api.listings) == 1
        broad, model, black = streams(store, result)
        assert broad["pages"] == 1 and model["pages"] == black["pages"] == 0
        assert model["reason"] == black["reason"] == f"{COVERED_REASON}{broad['id']}"
        assert all("model" not in observation["params"] and "backdrop" not in observation["params"] for observation in store.observations("listing"))
        assert len(store.observations("listing")) == 3
        assert listing_refresh_summary(store.get_run(result.run_id)["settings"], store.streams(result.run_id)) == {
            "version": 1, "planned_streams": 3, "reused_streams": 2, "provider_streams": 1}
        subject = dict(GIFT)
        enrich_pricing(store, [subject], now=datetime.now(timezone.utc), min_samples=1)
        assert subject["pricing"]["collection"]["mean"] == "0.2"
        assert subject["pricing"]["model"]["mean"] == "0.15"
        assert subject["pricing"]["model_black"]["mean"] == "0.1"


def test_partial_broad_never_skips_model_but_complete_model_can_cover_black_without_biasing_collection():
    api = Market({(None, None, None): page("more", listing("0:" + "55" * 32, model="B", nano="300000000")),
                  ("A", None, None): page(None, listing())})
    with Store(":memory:") as store:
        result = collect(store, api, settings=replace(SETTINGS, max_pages=1))
        broad, model, black = streams(store, result)
        assert result.state == "partial" and len(api.listings) == 2
        assert broad["state"] == "partial" and model["state"] == black["state"] == "complete"
        assert black["reason"] == f"{COVERED_REASON}{model['id']}"
        subject = dict(GIFT)
        enrich_pricing(store, [subject], now=datetime.now(timezone.utc), min_samples=1)
        assert subject["pricing"]["collection"]["mean"] == "0.3"
        assert subject["pricing"]["model"]["mean"] == subject["pricing"]["model_black"]["mean"] == "0.1"


def test_partial_broad_and_partial_model_keep_black_fallback():
    api = Market({(None, None, None): page("broad-next", listing()),
                  ("A", None, None): page("model-next", listing()),
                  ("A", "Black", None): page(None, listing())})
    with Store(":memory:") as store:
        result = collect(store, api, settings=replace(SETTINGS, max_pages=1))
        assert result.state == "partial" and len(api.listings) == 3
        assert [stream["state"] for stream in streams(store, result)] == ["partial", "partial", "complete"]
        assert not any((stream["reason"] or "").startswith(COVERED_REASON) for stream in streams(store, result))


@pytest.mark.parametrize("attributes", [
    [], [{"trait_type": "Model", "value": 1}],
    [{"trait_type": "Model", "value": "A"}, {"trait_type": "Model", "value": "B"}],
])
def test_unknown_or_conflicting_model_traits_keep_filtered_fallback(attributes):
    api = Market({(None, None, None): page(None, listing(attributes=attributes)),
                  ("A", None, None): page(None, listing())})
    with Store(":memory:") as store:
        result = collect(store, api)
        assert result.state == "complete" and len(api.listings) == 2
        broad, model, black = streams(store, result)
        assert model["pages"] == 1 and black["reason"] == f"{COVERED_REASON}{model['id']}"


def test_missing_backdrop_only_keeps_black_fallback():
    api = Market({(None, None, None): page(None, listing(backdrop=None)),
                  ("A", "Black", None): page(None, listing())})
    with Store(":memory:") as store:
        result = collect(store, api)
        broad, model, black = streams(store, result)
        assert len(api.listings) == 2 and black["pages"] == 1
        assert model["reason"] == f"{COVERED_REASON}{broad['id']}"


def test_missing_backdrop_for_definitely_other_model_does_not_force_black_fallback():
    api = Market({(None, None, None): page(None, listing(model="B", backdrop=None))})
    with Store(":memory:") as store:
        result = collect(store, api)
        assert result.state == "complete" and len(api.listings) == 1


def test_conflicting_traits_across_overlapping_pages_disable_reuse():
    api = Market({(None, None, None): page("second", listing()),
                  (None, None, "second"): page(None, listing(model="B")),
                  ("A", None, None): page(None, listing())})
    with Store(":memory:") as store:
        result = collect(store, api)
        assert result.state == "complete" and len(api.listings) == 3
        assert len(store.observations("listing")) == 3
        broad, model, black = streams(store, result)
        assert model["pages"] == 1 and black["reason"] == f"{COVERED_REASON}{model['id']}"


def test_collection_conflict_keeps_all_filtered_fallbacks(tmp_path):
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address\n{NFT},{OTHER}\n")
    api = Market({(None, None, None): page(None, listing()), ("A", None, None): page(None, listing()),
                  ("A", "Black", None): page(None, listing())})
    with Store(":memory:") as store:
        store.import_portfolio(portfolio)
        result = collect(store, api)
        assert result.state == "complete" and len(api.listings) == 3
        assert all(observation["collection_conflict"] for observation in store.observations("listing"))


def test_empty_continuation_is_partial_and_reuses_only_after_true_end_on_resume():
    api = Market({(None, None, None): page("end"), (None, None, "end"): page(), ("A", None, None): page()})
    with Store(":memory:") as store:
        first = collect(store, api, settings=replace(SETTINGS, max_pages=1))
        assert first.state == "partial" and len(api.listings) == 2
        assert streams(store, first)[0]["next_cursor"] == "end"
        original = store.get_run(first.run_id)["settings"]
        result = collect_prices(store, replace(SETTINGS, page_size=10, sort_by="min_price"), gifts=[{**GIFT, "model": "Different"}],
                                resume_id=first.run_id, client_factory=api.factory)
        assert result.state == "complete" and len(api.listings) == 3
        assert api.listings[-1].url.params["limit"] == "100" and api.listings[-1].url.params["cursor"] == "end"
        assert store.get_run(first.run_id)["settings"] == original


def test_finished_broad_page_survives_crash_before_reuse_without_repeating_http(monkeypatch):
    api = Market({(None, None, None): page(None, listing())})
    with Store(":memory:") as store:
        original = store.set_stream_state

        def crash(stream_id, state, reason=None):
            if reason and reason.startswith(COVERED_REASON):
                raise RuntimeError("interrupted before reuse commit")
            return original(stream_id, state, reason)

        monkeypatch.setattr(store, "set_stream_state", crash)
        with pytest.raises(RuntimeError, match="reuse commit"):
            collect(store, api)
        saved = store.runs()[-1]
        assert len(api.listings) == 1
        monkeypatch.setattr(store, "set_stream_state", original)
        result = collect(store, api, resume_id=saved["id"])
        assert result.state == "complete" and len(api.listings) == 1
        assert len(store.observations("listing")) == 1


def test_reuse_finishes_without_spending_more_requests_after_attempt_budget_is_consumed():
    api = Market({(None, None, None): page()})
    with Store(":memory:") as store:
        result = collect(store, api, settings=replace(SETTINGS, max_attempts=2))
        assert result.state == "complete" and len(api.requests) == 2
        assert [stream["pages"] for stream in streams(store, result)] == [1, 0, 0]


def test_fresh_run_restarts_broad_traversal_and_keeps_new_observation_even_after_prior_reuse():
    api = Market({(None, None, None): page(None, listing())})
    with Store(":memory:") as store:
        first = collect(store, api)
        replay = collect(store, api, resume_id=first.run_id)
        assert replay.pages_committed == 0 and len(api.listings) == 1
        second = collect(store, api)
        assert second.run_id != first.run_id and len(api.listings) == 2
        assert len(store.observations("listing")) == 2


def test_legacy_resume_does_not_adopt_reuse_and_incompatible_policy_rejected_before_http():
    api = Market({(None, None, None): page(None, listing()), ("A", None, None): page(None, listing()),
                  ("A", "Black", None): page(None, listing())})
    with Store(":memory:") as store:
        first = collect(store, api, settings=replace(SETTINGS, max_attempts=1))
        saved = store.get_run(first.run_id)["settings"]
        saved["listing_refresh"] = {**POLICY, "version": 2}
        with store.connection:
            store.connection.execute("UPDATE runs SET settings_json=? WHERE id=?", (json.dumps(saved), first.run_id))
        with pytest.raises(ValueError, match="incompatible"):
            collect(store, api, resume_id=first.run_id)
        assert len(api.requests) == 1
        saved.pop("listing_refresh")
        with store.connection:
            store.connection.execute("UPDATE runs SET settings_json=? WHERE id=?", (json.dumps(saved), first.run_id))
        final = collect(store, api, resume_id=first.run_id)
        assert final.state == "complete" and len(api.listings) == 3
        assert listing_refresh_summary(saved, store.streams(first.run_id)) is None
