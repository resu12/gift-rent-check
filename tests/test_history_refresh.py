"""Real SQLite checkpoints and mocked HTTP exercise incremental history savings."""
import csv
import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from marketapp_rent import history_refresh
from marketapp_rent.addresses import preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH
from marketapp_rent.config import Settings
from marketapp_rent.domain import ApiResponse
from marketapp_rent.history_refresh import FULL_SCAN_INTERVAL_SECONDS, OVERLAP_SECONDS, history_refresh_summary
from marketapp_rent.models import parse_page
from marketapp_rent.price_collection import collect_rental_prices
from marketapp_rent.storage import Store


DAY = 86400
NOW = 2_000_000_000
SINCE = NOW - 30 * DAY
COLLECTION = "0:" + "33" * 32
OTHER = "0:" + "44" * 32
NFT = "0:" + "22" * 32
GIFT = {"nft_address": NFT, "collection_address": COLLECTION, "model": "A",
        "is_portfolio": True, "category": "portfolio"}
SETTINGS = Settings(token="mock", page_size=100, max_pages=10)


def record(ts, **changes):
    return {"address": NFT, "name": "Example #1", "collection_address": COLLECTION,
            "ts": ts, "src": "source", "dst": "destination", "price": "0.15",
            "price_nano": "150000000", "currency": "GRAM", "duration": 86400, **changes}


def page(cursor, *timestamps):
    return {"cursor": cursor, "items": [record(ts) for ts in timestamps]}


class HistoryAPI:
    def __init__(self, pages):
        self.pages, self.requests, self.clock = pages, [], 0.0

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET" and request.headers["Authorization"] == "mock"
        if request.url.path == COLLECTIONS_PATH:
            return httpx.Response(200, json=[])
        assert request.url.path == HISTORY_PATH
        assert set(request.url.params) <= {"collection_address", "order_by", "limit", "cursor"}
        return httpx.Response(200, json=self.pages[request.url.params.get("cursor")])

    def sleep(self, seconds):
        self.clock += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond),
                         sleep=self.sleep, monotonic=lambda: self.clock)

    @property
    def history_requests(self):
        return [request for request in self.requests if request.url.path == HISTORY_PATH]


@pytest.fixture
def clock(monkeypatch):
    current = [NOW]
    monkeypatch.setattr(history_refresh, "utc_seconds", lambda: current[0])
    return current


def run(store, api, **kwargs):
    return collect_rental_prices(store, kwargs.pop("settings", SETTINGS), gifts=[GIFT],
                                 client_factory=api.factory, **kwargs)


def plan(store, run_id):
    return store.get_run(run_id)["settings"]["history_refresh"]["streams"][0]


def baseline(store):
    api = HistoryAPI({None: page("middle", NOW - DAY), "middle": page("old", NOW - 10 * DAY),
                      "old": page("more", SINCE - 1)})
    result = run(store, api, history_since=SINCE)
    assert result.state == "complete"
    return result, api


def test_incremental_uses_request_start_watermark_and_saves_requests_without_changing_window(clock):
    with Store(":memory:") as store:
        first, api = baseline(store)
        initial = plan(store, first.run_id)
        assert initial == {"collection_address": COLLECTION, "mode": "full", "window_since": SINCE,
                           "coverage_since": SINCE, "scan_since": SINCE, "checked_through": NOW,
                           "full_scan_at": NOW, "baseline": None}
        assert len(api.history_requests) == 3
        clock[0] += DAY
        # The first representation is identical to saved history. It does not stop the scan.
        fresh = HistoryAPI({None: page("overlap", NOW - DAY), "overlap": page("not-needed", NOW - 3 * DAY),
                            "not-needed": page(None, SINCE - 1)})
        second = run(store, fresh, history_since=SINCE + DAY)
        updated = plan(store, second.run_id)
        assert updated["mode"] == "incremental"
        assert updated["scan_since"] == NOW - OVERLAP_SECONDS
        assert updated["checked_through"] == NOW + DAY  # Never max returned event timestamp.
        assert updated["coverage_since"] == SINCE + DAY
        assert updated["full_scan_at"] == NOW
        assert updated["baseline"]["run_id"] == first.run_id
        assert len(fresh.history_requests) == 2
        saved = store.get_run(second.run_id)["settings"]
        assert saved["history_since"] == SINCE + DAY
        assert history_refresh_summary(saved) == {"version": 1, "overlap_seconds": OVERLAP_SECONDS,
            "full_scan_interval_seconds": FULL_SCAN_INTERVAL_SECONDS, "full_streams": 0, "incremental_streams": 1}
        assert len(store.observations("history")) == 5
        assert len(store.records("history")) == 4


def test_incremental_retains_equal_boundary_ties_late_records_and_changed_variants(clock):
    cutoff = NOW - OVERLAP_SECONDS
    with Store(":memory:") as store:
        first = run(store, HistoryAPI({None: {"cursor": None, "items": [record(cutoff, tx_hash="same")]}}), history_since=SINCE)
        clock[0] += DAY
        changed = record(cutoff, tx_hash="same", price="0.20", price_nano="200000000")
        late = record(cutoff, address="0:" + "55" * 32)
        api = HistoryAPI({None: {"cursor": "tie", "items": [changed]},
                          "tie": {"cursor": "lower", "items": [late]},
                          "lower": page("unneeded", cutoff - 1, cutoff - DAY)})
        second = run(store, api, history_since=SINCE)
        assert plan(store, second.run_id)["baseline"]["run_id"] == first.run_id
        assert len(api.history_requests) == 3
        assert len(store.records("history")) == 5
        assert len(store.observations("history")) == 5
        assert store.streams(second.run_id)[-1]["next_cursor"] == "unneeded"
        assert {item["data"]["price"] for item in store.records("history") if item["data"].get("tx_hash") == "same"} == {"0.15", "0.20"}


def test_dashboard_progress_and_offline_report_distinguish_reused_history(clock, tmp_path):
    from marketapp_rent.dashboard_jobs import progress_for
    from marketapp_rent.reports import export_reports

    database = tmp_path / "history.sqlite3"
    with Store(database) as store:
        baseline(store)
        clock[0] += DAY
        result = run(store, HistoryAPI({None: page("older", NOW - 3 * DAY)}), history_since=SINCE + DAY)
        expected = history_refresh_summary(store.get_run(result.run_id)["settings"])
        export_reports(store, tmp_path / "exports")
    progress = progress_for(database, {"kind": "rental_prices", "run_id": result.run_id})
    assert progress["history_refresh"] == expected
    assert progress["streams_complete"] == progress["streams_total"] == 2
    with (tmp_path / "exports" / "run_status.csv").open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    incremental = next(row for row in rows if row["id"] == str(result.run_id))
    assert "reuses older completed coverage" in incremental["coverage_note"]
    assert "older corrections may await a full scan" in incremental["coverage_note"]


@pytest.mark.parametrize("elapsed,since,expected", [
    (DAY, SINCE - 1, "full"),
    (FULL_SCAN_INTERVAL_SECONDS - 1, SINCE, "incremental"),
    (FULL_SCAN_INTERVAL_SECONDS, SINCE, "full"),
    (8 * DAY, SINCE, "full"),
    (-1, SINCE, "full"),
    (DAY, NOW - DAY, "full"),  # Entire selected window fits inside the overlap.
    (DAY, NOW + 1, "full"),  # A narrower window cannot carry older coverage across a gap.
])
def test_widened_stale_clock_reversal_and_short_windows_select_safe_full_pass(clock, elapsed, since, expected):
    with Store(":memory:") as store:
        baseline(store)
        clock[0] = NOW + elapsed
        result = run(store, HistoryAPI({None: page(None)}), history_since=since)
        planned = plan(store, result.run_id)
        assert planned["mode"] == expected
        assert planned["coverage_since"] == since
        if expected == "full":
            assert planned["scan_since"] == since and planned["full_scan_at"] == clock[0]


def test_unrelated_collection_has_no_baseline_and_aliases_reuse_same_collection(clock):
    with Store(":memory:") as store:
        baseline(store)
        clock[0] += DAY
        api = HistoryAPI({None: page(None)})
        result = collect_rental_prices(store, SETTINGS, gifts=[GIFT, {**GIFT, "collection_address": OTHER},
                                        {**GIFT, "collection_address": preferred_address(COLLECTION)}],
                                        history_since=SINCE, client_factory=api.factory)
        planned = store.get_run(result.run_id)["settings"]["history_refresh"]["streams"]
        assert [(value["collection_address"], value["mode"]) for value in planned] == [(COLLECTION, "incremental"), (OTHER, "full")]
        assert len(api.history_requests) == 2


def test_partial_or_failed_stream_does_not_establish_baseline(clock):
    with Store(":memory:") as store:
        pending = run(store, HistoryAPI({None: page("pending", NOW)}), history_since=SINCE,
                      settings=replace(SETTINGS, max_pages=1))
        assert pending.state == "partial"
        clock[0] += DAY
        result = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, result.run_id)["mode"] == "full"


def test_order_anomaly_disables_shortcut_and_prevents_baseline_promotion(clock):
    with Store(":memory:") as store:
        first, _ = baseline(store)
        clock[0] += DAY
        api = HistoryAPI({None: page("next", NOW - 3 * DAY, NOW),
                          "next": page("last", SINCE - 1), "last": page(None, SINCE - 2)})
        anomaly = run(store, api, history_since=SINCE)
        assert anomaly.state == "complete" and len(api.history_requests) == 3
        assert any(issue["reason"] == history_refresh.ORDER_UNVERIFIED for issue in store.issues())
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["baseline"]["run_id"] == first.run_id
        assert plan(store, following.run_id)["scan_since"] == NOW - OVERLAP_SECONDS


@pytest.mark.parametrize("wrong_collection", [OTHER, "malformed-TON-address"])
def test_wrong_collection_preserves_records_disables_cutoff_across_resume_and_prevents_reuse(clock, wrong_collection):
    with Store(":memory:") as store:
        api = HistoryAPI({None: {"cursor": "next", "items": [record(SINCE - 1, collection_address=wrong_collection)]},
                          "next": page("last", SINCE - 2), "last": page(None, SINCE - 3)})
        first = run(store, api, history_since=SINCE, settings=replace(SETTINGS, max_pages=1))
        assert first.state == "partial" and len(api.history_requests) == 1
        assert store.issues()[0]["reason"] == history_refresh.SCOPE_UNVERIFIED
        resumed = run(store, api, resume_id=first.run_id)
        assert resumed.state == "complete" and resumed.reason is None
        assert len(api.history_requests) == 3 and len(store.observations("history")) == 3
        assert store.records("history")[0]["data"]["collection_address"] == wrong_collection
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["mode"] == "full"


def test_matching_collection_alias_does_not_disable_reuse(clock):
    with Store(":memory:") as store:
        api = HistoryAPI({None: {"cursor": "older", "items": [record(SINCE - 1, collection_address=preferred_address(COLLECTION))]}})
        first = run(store, api, history_since=SINCE)
        assert first.reason == "timeframe_covered" and not store.issues()
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["mode"] == "incremental"


@pytest.mark.parametrize("offset,expected", [(300, "incremental"), (301, "full"), (10 * DAY, "full")])
def test_implausibly_future_timestamp_at_natural_end_does_not_promote_coverage(clock, offset, expected):
    with Store(":memory:") as store:
        first = run(store, HistoryAPI({None: page(None, NOW + offset)}), history_since=SINCE)
        assert first.state == "complete"
        assert bool(store.issues()) == (offset > 300)
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["mode"] == expected


def test_future_timestamp_new_guard_does_not_change_legacy_resume(clock):
    with Store(":memory:") as store:
        api = HistoryAPI({None: page("end", NOW), "end": page(None, NOW + DAY)})
        pending = run(store, api, history_since=SINCE, settings=replace(SETTINGS, max_pages=1))
        rewrite_settings(store, pending.run_id, lambda saved: saved.pop("history_refresh"))
        # Natural order is descending relative to the saved first page.
        api.pages["end"] = page(None, NOW - 1)
        clock[0] = NOW - DAY
        resumed = run(store, api, resume_id=pending.run_id)
        assert resumed.state == "complete" and not store.issues()


@pytest.mark.parametrize("after_commit", [False, True])
def test_crash_resume_preserves_plan_page_size_and_atomic_boundary(clock, monkeypatch, after_commit):
    with Store(":memory:") as store:
        baseline(store)
        clock[0] += DAY
        api = HistoryAPI({None: page("end", NOW), "end": page("older", NOW - 3 * DAY)})
        pending = run(store, api, history_since=SINCE, settings=replace(SETTINGS, max_pages=1))
        frozen = plan(store, pending.run_id)
        original = store.commit_page

        def crash(*args, **kwargs):
            if after_commit:
                original(*args, **kwargs)
            raise RuntimeError("simulated page crash")

        monkeypatch.setattr(store, "commit_page", crash)
        with pytest.raises(RuntimeError, match="simulated page crash"):
            run(store, api, resume_id=pending.run_id)
        before = len(api.history_requests)
        monkeypatch.setattr(store, "commit_page", original)
        clock[0] += 10 * DAY
        result = run(store, api, resume_id=pending.run_id, settings=replace(SETTINGS, page_size=10, order_by="old_to_new"))
        assert result.state == "complete"
        assert plan(store, pending.run_id) == frozen
        assert len(api.history_requests) == before + (0 if after_commit else 1)
        assert api.history_requests[-1].url.params["cursor"] == "end"
        assert api.history_requests[-1].url.params["limit"] == "100"
        assert len([obs for obs in store.observations("history") if obs["run_id"] == pending.run_id]) == 2


def rewrite_settings(store, run_id, modify):
    saved = store.get_run(run_id)["settings"]
    modify(saved)
    with store.connection:
        store.connection.execute("UPDATE runs SET settings_json=? WHERE id=?", (json.dumps(saved), run_id))


def test_legacy_bounded_resume_is_unchanged_but_cannot_seed_new_policy(clock):
    with Store(":memory:") as store:
        api = HistoryAPI({None: page("end", NOW), "end": page("older", SINCE - 1)})
        pending = run(store, api, history_since=SINCE, settings=replace(SETTINGS, max_pages=1))
        rewrite_settings(store, pending.run_id, lambda saved: saved.pop("history_refresh"))
        clock[0] += DAY
        resumed = run(store, api, resume_id=pending.run_id)
        assert resumed.state == "complete" and len(api.history_requests) == 2
        assert history_refresh_summary(store.get_run(resumed.run_id)["settings"]) is None
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["mode"] == "full"


@pytest.mark.parametrize("mutate", [
    lambda saved: saved["history_refresh"].update(version=2),
    lambda saved: saved.update(history_timestamp_semantics="unknown-units"),
    lambda saved: saved.update(order_by="old_to_new"),
    lambda saved: saved["history_refresh"]["streams"][0].update(checked_through=True),
    lambda saved: saved["history_refresh"]["streams"][0].update(window_since=SINCE - 1),
])
def test_incompatible_saved_policy_cannot_seed_or_resume(clock, mutate):
    with Store(":memory:") as store:
        first, api = baseline(store)
        rewrite_settings(store, first.run_id, mutate)
        with pytest.raises(ValueError, match="incompatible"):
            run(store, api, resume_id=first.run_id)
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["mode"] == "full"


def test_no_baseline_for_unbounded_history_runs(clock):
    with Store(":memory:") as store:
        previous = run(store, HistoryAPI({None: page(None, NOW)}))
        assert "history_refresh" not in store.get_run(previous.run_id)["settings"]
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["mode"] == "full"


POLICY_CASES = json.loads((Path(__file__).parent / "fixtures/marketapp/history-refresh-policy.json").read_text())["cases"]


@pytest.mark.parametrize("case", POLICY_CASES, ids=lambda case: case["name"])
def test_shared_python_cloud_policy_vectors_use_committed_stream_eligibility(case):
    specification = {"kind": "history", "path": HISTORY_PATH,
                     "params": {"collection_address": COLLECTION, "order_by": "new_to_old", "limit": 100}}
    with Store(":memory:") as store:
        previous = case["previous"]
        if previous:
            checked = previous["checked_through"]
            scan_since = max(previous["coverage_since"], checked - OVERLAP_SECONDS) if type(checked) is int else previous["coverage_since"]
            previous_plan = {"collection_address": COLLECTION, "mode": "incremental",
                             "window_since": previous["coverage_since"], "coverage_since": previous["coverage_since"],
                             "scan_since": scan_since, "checked_through": previous["checked_through"],
                             "full_scan_at": previous["full_scan_at"], "baseline": {"run_id": 1, "stream_id": 1,
                             "coverage_since": previous["coverage_since"], "checked_through": previous["checked_through"],
                             "full_scan_at": previous["full_scan_at"]}}
            settings = {"streams": [specification], "order_by": "new_to_old", "history_since": previous["coverage_since"],
                        "history_timestamp_semantics": "marketapp-rent-history-ui-v1",
                        "history_refresh": {"version": previous["version"], "overlap_seconds": OVERLAP_SECONDS,
                                            "full_scan_interval_seconds": FULL_SCAN_INTERVAL_SECONDS, "streams": [previous_plan]}}
            run_id = store.create_run(settings, [COLLECTION], [])
            stream_id = store.add_stream(run_id, **specification)
            body = json.dumps(page(None)).encode()
            store.commit_page(stream_id, None, ApiResponse(body, 200, "2026-10-09T12:00:00Z"), parse_page("history", body))
            if not previous["complete"]:
                store.set_stream_state(stream_id, "partial")
            if not previous["ordered"]:
                store.record_issue(run_id, stream_id, history_refresh.ORDER_UNVERIFIED, "Fixture unordered history")
        result = history_refresh.build_history_refresh_plan(store, [specification], case["requested_since"], now=case["now"])["streams"][0]
        assert {key: result[key] for key in case["expected"]} == case["expected"]


@pytest.mark.parametrize("alter", [
    lambda plan: plan.update(scan_since=plan["scan_since"] + 1),
    lambda plan: plan.update(scan_since=plan["window_since"]),
    lambda plan: plan.update(full_scan_at=plan["full_scan_at"] + 1),
    lambda plan: plan["baseline"].pop("checked_through"),
    lambda plan: plan["baseline"].update(coverage_since=plan["window_since"] + 1),
    lambda plan: plan["baseline"].update(checked_through=plan["checked_through"] + 1),
    lambda plan: plan["baseline"].update(full_scan_at=plan["checked_through"] - FULL_SCAN_INTERVAL_SECONDS),
])
def test_altered_incremental_scan_or_baseline_rejected_before_resume_or_reuse(clock, alter):
    with Store(":memory:") as store:
        full, _ = baseline(store)
        clock[0] += DAY
        api = HistoryAPI({None: page("end", NOW), "end": page("more", NOW - 3 * DAY)})
        pending = run(store, api, history_since=SINCE, settings=replace(SETTINGS, max_pages=1))
        assert plan(store, pending.run_id)["mode"] == "incremental"
        rewrite_settings(store, pending.run_id, lambda saved: alter(saved["history_refresh"]["streams"][0]))
        requests_before = len(api.requests)
        with pytest.raises(ValueError, match="incompatible"):
            run(store, api, resume_id=pending.run_id)
        assert len(api.requests) == requests_before
        # Even if a malformed plan claims completion, it cannot supply a newer watermark.
        store.set_stream_state(store.streams(pending.run_id)[-1]["id"], "complete")
        clock[0] += DAY
        following = run(store, HistoryAPI({None: page(None)}), history_since=SINCE)
        assert plan(store, following.run_id)["baseline"]["run_id"] == full.run_id
