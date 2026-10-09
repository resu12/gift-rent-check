"""Fair page scheduling is resumable from committed evidence, without a new cursor."""
from dataclasses import replace
import json

import httpx
import pytest

from marketapp_rent.addresses import address_key, preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH, LISTINGS_PATH
from marketapp_rent.collection_schedule import efficiency_progress, next_stream
from marketapp_rent.collector import collect
from marketapp_rent.config import Settings
from marketapp_rent.dashboard_jobs import progress_for
from marketapp_rent.storage import Store


A = "0:" + "33" * 32
B = "0:" + "44" * 32
SETTINGS = Settings(token="mock", page_size=100, max_pages=10, max_attempts=100)


class Market:
    def __init__(self, end_after=3, respond=None):
        self.end_after, self.custom = end_after, respond
        self.requests, self.clock = [], 0.0

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET" and request.headers["Authorization"] == "mock"
        if request.url.path == COLLECTIONS_PATH:
            return httpx.Response(200, json=[])
        assert request.url.path == HISTORY_PATH
        scope = address_key(request.url.params["collection_address"])
        page = int(request.url.params.get("cursor", "page-0").split("-")[1])
        if self.custom:
            value = self.custom(scope, page)
            if value is not None:
                return value
        return httpx.Response(200, json={"cursor": None if page + 1 >= self.end_after else f"page-{page + 1}", "items": []})

    def sleep(self, seconds):
        self.clock += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond),
                         sleep=self.sleep, monotonic=lambda: self.clock, random=lambda: 0)

    @property
    def pages(self):
        return [(address_key(request.url.params["collection_address"]), request.url.params.get("cursor"))
                for request in self.requests if request.url.path == HISTORY_PATH]


def start(store, market, settings=SETTINGS, **options):
    return collect(store, settings, rental_targets=[A, B] if options.get("resume_id") is None else None,
                   client_factory=market.factory, **options)


def test_new_run_visits_every_scope_before_deepening_and_keeps_catalog_first():
    api = Market()
    with Store(":memory:") as store:
        result = start(store, api)
        assert result.state == "complete"
        assert store.get_run(result.run_id)["settings"]["scheduling"] == "round_robin"
        assert api.requests[0].url.path == COLLECTIONS_PATH
        assert api.pages == [(A, None), (B, None), (A, "page-1"), (B, "page-1"), (A, "page-2"), (B, "page-2")]


def test_mixed_kinds_alternate_collections_and_report_the_active_scope_inside_requests(tmp_path):
    database = tmp_path / "mixed.sqlite3"
    requests, active = [], []
    def response(request):
        requests.append(request)
        if request.url.path == COLLECTIONS_PATH:
            return httpx.Response(200, json=[{"address": A, "name": "Collection A", "extra_data": {}},
                                             {"address": B, "name": "Collection B", "extra_data": {}}])
        if request.url.path.endswith("/attributes/"):
            return httpx.Response(200, json={"attributes": []})
        scope = address_key(request.url.params["collection_address"])
        projected = progress_for(database, {"kind": "collect", "run_id": 1})
        active.append((scope, projected["sync"]["current_collection"], projected["sync"]["phase"]))
        return httpx.Response(200, json={"cursor": "end" if "cursor" not in request.url.params else None, "items": []})
    clock = [0.0]
    def sleep(seconds):
        clock[0] += seconds
    def factory(*args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(response), sleep=sleep, monotonic=lambda: clock[0])
    with Store(database) as store:
        result = collect(store, SETTINGS, collection_addresses=[A, B], client_factory=factory)
        assert result.state == "complete"
    data_requests = [(address_key(request.url.params["collection_address"]), request.url.path, request.url.params.get("cursor"))
                     for request in requests if request.url.path in (LISTINGS_PATH, HISTORY_PATH)]
    assert data_requests == [(A, LISTINGS_PATH, None), (B, LISTINGS_PATH, None), (A, HISTORY_PATH, None), (B, HISTORY_PATH, None),
                             (A, LISTINGS_PATH, "end"), (B, LISTINGS_PATH, "end"), (A, HISTORY_PATH, "end"), (B, HISTORY_PATH, "end")]
    assert all(name == ("Collection A" if scope == A else "Collection B") for scope, name, _ in active)
    assert [phase for _, _, phase in active] == ["listings", "listings", "rentals", "rentals"] * 2


def test_adaptive_breadth_tiers_preserve_broad_completion_before_optional_cohorts():
    values = [{"id": index + 1, "kind": "listing", "path": LISTINGS_PATH, "params": params,
               "state": "pending", "pages": pages} for index, (params, pages) in enumerate([
                   ({"collection_address": A}, 1), ({"collection_address": B}, 0),
                   ({"collection_address": A, "model": "A"}, 0), ({"collection_address": B, "model": "A"}, 0),
                   ({"collection_address": A, "model": "A", "backdrop": "Black"}, 0)])]
    assert next_stream(values, "round_robin", broad_first=True)["id"] == 2
    values[1]["pages"] = 1
    assert next_stream(values, "round_robin", broad_first=True)["id"] == 1
    assert next_stream(values, "round_robin", broad_first=True, excluded={1, 2})["id"] == 3


def test_attribute_only_work_does_not_reorder_known_and_unfiltered_listing_scopes():
    values = [{"id": 1, "kind": "attribute", "path": f"/v1/collections/{A}/attributes/", "params": {}, "state": "complete", "pages": 1},
              {"id": 2, "kind": "listing", "path": LISTINGS_PATH, "params": {"collection_address": A}, "state": "pending", "pages": 0},
              {"id": 3, "kind": "history", "path": HISTORY_PATH, "params": {"collection_address": A}, "state": "pending", "pages": 0},
              {"id": 4, "kind": "listing", "path": LISTINGS_PATH, "params": {}, "state": "pending", "pages": 0},
              {"id": 5, "kind": "history", "path": HISTORY_PATH, "params": {}, "state": "pending", "pages": 0}]
    order = []
    for _ in range(4):
        selected = next_stream(values, "round_robin")
        order.append(selected["id"])
        selected["pages"] += 1
    assert order == [2, 4, 3, 5]


def test_attempt_budget_resume_starts_the_unvisited_collection_without_resetting_page_size(tmp_path):
    database = tmp_path / "fair.sqlite3"
    api = Market()
    with Store(database) as store:
        first = start(store, api, replace(SETTINGS, max_attempts=2))
        assert first.state == "partial" and api.pages == [(A, None)]
        progress = progress_for(database, {"kind": "rental_prices", "run_id": first.run_id})
        assert progress["efficiency"] == {"page_size": 100, "recommended_page_size": 100,
                                           "scheduling": "round_robin", "collections_started": 1, "collections_total": 2}
        resumed = start(store, api, replace(SETTINGS, max_attempts=1, page_size=10), resume_id=first.run_id)
        assert resumed.state == "partial" and api.pages == [(A, None), (B, None)]
        assert api.requests[-1].url.params["limit"] == "100"
        assert progress_for(database, {"kind": "rental_prices", "run_id": first.run_id})["efficiency"]["collections_started"] == 2
        final = start(store, api, resume_id=first.run_id)
        assert final.state == "complete"
        assert api.pages == [(A, None), (B, None), (A, "page-1"), (B, "page-1"), (A, "page-2"), (B, "page-2")]


@pytest.mark.parametrize("after_commit", [False, True])
def test_crash_before_or_after_first_page_commit_restores_the_correct_round(tmp_path, monkeypatch, after_commit):
    api = Market(end_after=2)
    with Store(tmp_path / "crash.sqlite3") as store:
        original = store.commit_page

        def crash(stream_id, *args, **kwargs):
            stream = next(value for value in store.streams(1) if value["id"] == stream_id)
            if stream["kind"] == "history":
                if after_commit:
                    original(stream_id, *args, **kwargs)
                raise RuntimeError("simulated process failure")
            return original(stream_id, *args, **kwargs)

        monkeypatch.setattr(store, "commit_page", crash)
        with pytest.raises(RuntimeError, match="simulated"):
            start(store, api)
        before = len(api.pages)
        monkeypatch.setattr(store, "commit_page", original)
        result = start(store, api, resume_id=1)
        assert result.state == "complete"
        assert api.pages[before] == (B if after_commit else A, None)
        assert [stream["pages"] for stream in store.streams(1) if stream["kind"] == "history"] == [2, 2]


def test_retries_stay_on_same_page_before_round_advances():
    failures = 0

    def transient(scope, page):
        nonlocal failures
        if scope == A and page == 0 and failures == 0:
            failures += 1
            return httpx.Response(503, json={"error": "busy"})

    api = Market(end_after=2, respond=transient)
    with Store(":memory:") as store:
        result = start(store, api)
        assert result.state == "complete"
        assert api.pages == [(A, None), (A, None), (B, None), (A, "page-1"), (B, "page-1")]


def test_failed_stream_does_not_starve_remaining_scope_or_loop_during_same_invocation():
    api = Market(end_after=2, respond=lambda scope, _: httpx.Response(400, json={}) if scope == A else None)
    with Store(":memory:") as store:
        result = start(store, api)
        assert result.state == "partial" and result.reason == "stream_failure"
        assert api.pages == [(A, None), (B, None), (B, "page-1")]


def test_per_stream_page_limits_apply_in_each_invocation_without_losing_round_order():
    api = Market(end_after=20)
    with Store(":memory:") as store:
        first = start(store, api, replace(SETTINGS, max_pages=2))
        assert first.state == "partial" and first.reason == "page_limit"
        assert api.pages == [(A, None), (B, None), (A, "page-1"), (B, "page-1")]
        second = start(store, api, replace(SETTINGS, max_pages=1), resume_id=first.run_id)
        assert second.state == "partial"
        assert api.pages[-2:] == [(A, "page-2"), (B, "page-2")]
        assert all(stream["state"] == "partial" and stream["pages"] == 3 for stream in store.streams(first.run_id)[1:])


def test_legacy_resume_remains_sequential_and_explicit_schedule_change_is_rejected():
    api = Market()
    with Store(":memory:") as store:
        first = start(store, api, replace(SETTINGS, max_attempts=1, page_size=10))
        settings = store.get_run(first.run_id)["settings"]
        settings.pop("scheduling")
        with store.connection:
            store.connection.execute("UPDATE runs SET settings_json=? WHERE id=?", (json.dumps(settings), first.run_id))
        with pytest.raises(ValueError, match="Cannot change scheduling"):
            start(store, api, resume_id=first.run_id, explicit_stream_options={"scheduling": "round_robin"})
        assert not api.pages
        result = start(store, api, resume_id=first.run_id)
        assert result.state == "complete"
        assert api.pages == [(A, None), (A, "page-1"), (A, "page-2"), (B, None), (B, "page-1"), (B, "page-2")]
        assert efficiency_progress(settings, store.streams(first.run_id))["scheduling"] == "sequential"
        assert all(request.url.params["limit"] == "10" for request in api.requests if request.url.path == HISTORY_PATH)


def test_unknown_saved_schedule_rejected_before_network():
    api = Market()
    with Store(":memory:") as store:
        first = start(store, api, replace(SETTINGS, max_attempts=1))
        settings = store.get_run(first.run_id)["settings"]
        settings["scheduling"] = "unsupported"
        with store.connection:
            store.connection.execute("UPDATE runs SET settings_json=? WHERE id=?", (json.dumps(settings), first.run_id))
        with pytest.raises(ValueError, match="scheduling is incompatible"):
            start(store, api, resume_id=first.run_id)
        assert len(api.requests) == 1


def test_efficiency_canonicalizes_scopes_and_counts_reuse_but_not_metadata_only():
    specs = [{"kind": "listing", "path": "/v1/rent/gifts/", "params": {"collection_address": A}},
             {"kind": "listing", "path": "/v1/rent/gifts/", "params": {"collection_address": preferred_address(A), "model": "A"}},
             {"kind": "attribute", "path": f"/v1/collections/{B}/attributes/", "params": {}}]
    settings = {"streams": specs, "page_size": 10}
    values = [{**spec, "state": "pending", "pages": 0} for spec in specs]
    values[2].update(state="complete", pages=1)
    assert efficiency_progress(settings, values) == {"page_size": 10, "recommended_page_size": 100,
        "scheduling": "sequential", "collections_started": 0, "collections_total": 2}
    values[1].update(state="complete", reason="covered_by_listing_stream:1")
    assert efficiency_progress(settings, values)["collections_started"] == 1
