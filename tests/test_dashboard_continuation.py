"""Continuous dashboard batches retain checkpoints, pacing, and safe stops."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import sqlite3

import httpx
import pytest

import marketapp_rent.api as api_module
import marketapp_rent.dashboard_jobs as jobs_module
import marketapp_rent.dashboard_view as view_module
import marketapp_rent.pricing_window as window_module
from marketapp_rent.collector import CollectionResult
from marketapp_rent.config import Settings
from marketapp_rent.dashboard_jobs import JobStore, execute_job
from marketapp_rent.discovery import DiscoveryResult
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.storage import Store


WALLET = "0:" + "01" * 32
COLLECTION = "0:" + "03" * 32


@pytest.fixture
def setup(tmp_path, monkeypatch):
    clock = SimpleNamespace(now=0.0, waits=[], on_wait=None)
    epoch = datetime(2026, 10, 8, tzinfo=timezone.utc)

    class FakeDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = epoch + timedelta(seconds=clock.now)
            return value.astimezone(tz) if tz else value.replace(tzinfo=None)

    def sleep(seconds):
        clock.waits.append(seconds)
        clock.now += seconds
        # The real worker renews its lease while the collector waits. Model
        # that heartbeat when advancing the persisted pacing clock here.
        with jobs.connect() as connection:
            lease = connection.execute("SELECT worker FROM dashboard_lease WHERE id=1").fetchone()
        if lease and lease["worker"] == "worker":
            jobs.lease("worker")
        if clock.on_wait:
            clock.on_wait(seconds)

    monkeypatch.setattr(jobs_module, "datetime", FakeDateTime)
    monkeypatch.setattr(api_module, "datetime", FakeDateTime)
    monkeypatch.setattr(window_module, "datetime", FakeDateTime)
    monkeypatch.setattr(jobs_module, "monotonic", lambda: clock.now)
    monkeypatch.setattr(jobs_module.time, "time", lambda: epoch.timestamp() + clock.now)
    monkeypatch.setattr(jobs_module.time, "sleep", sleep)
    monkeypatch.setattr(view_module, "build_dashboard", lambda *args: {"gifts": [
        {"is_portfolio": True, "collection_address": COLLECTION, "model": "Model"}]})
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    settings = Settings(token="fake-secret", db_path=tmp_path / "portfolio.sqlite3", max_pages=1)
    return jobs, settings, clock


def transport(monkeypatch, clock, responder):
    original = api_module.ApiClient.__init__

    def initialize(self, *args, **kwargs):
        kwargs.update(transport=httpx.MockTransport(responder), monotonic=lambda: clock.now, random=lambda: 0)
        original(self, *args, **kwargs)

    monkeypatch.setattr(api_module.ApiClient, "__init__", initialize)


def claimed(jobs, kind="rental_prices"):
    jobs.enqueue(kind, WALLET)
    jobs.lease("worker")
    return jobs.claim("worker")


@pytest.mark.parametrize("limits", [{"max_pages": 1}, {"max_attempts": 1}, {"run_seconds": 0.5}])
def test_routine_limits_continue_same_run_with_sequential_pacing(setup, monkeypatch, limits):
    from dataclasses import replace
    jobs, settings, clock = setup
    settings = replace(settings, **limits)
    calls = []

    def respond(request):
        assert jobs.get(1)["state"] == "running"
        calls.append((clock.now, request.url.path, request.url.params.get("cursor")))
        if request.url.path.endswith("collections/gifts/"):
            return httpx.Response(200, json=[])
        next_cursor = {None: "page2", "page2": "page3", "page3": None}[request.url.params.get("cursor")]
        return httpx.Response(200, json={"items": [], "cursor": next_cursor})

    transport(monkeypatch, clock, respond)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "complete" and result["pages_committed"] == 4
    assert [call[2] for call in calls] == [None, None, "page2", "page3"]
    assert all(later[0] - earlier[0] >= 1 for earlier, later in zip(calls, calls[1:]))
    with Store(settings.db_path) as store:
        assert store.connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 1
        assert sum(stream["pages"] for stream in store.streams(result["run_id"])) == 4


def test_retry_after_longer_than_batch_budget_waits_then_resumes(setup, monkeypatch):
    from dataclasses import replace
    jobs, settings, clock = setup
    settings = replace(settings, run_seconds=5)
    times = []

    def respond(request):
        times.append(clock.now)
        if len(times) == 1:
            return httpx.Response(429, headers={"Retry-After": "12"}, json={})
        return httpx.Response(200, json=[] if request.url.path.endswith("collections/gifts/") else {"items": [], "cursor": None})

    transport(monkeypatch, clock, respond)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "complete"
    assert times[1] >= 12 and times[2] - times[1] >= 1
    assert max(clock.waits) <= 1
    with Store(settings.db_path) as store:
        assert store.retry_not_before() is not None


def test_stop_during_persisted_cooldown_preserves_run_without_retry(setup, monkeypatch):
    from dataclasses import replace
    jobs, settings, clock = setup
    settings = replace(settings, run_seconds=5)
    attempts = []

    def respond(request):
        attempts.append(request.url.path)
        return httpx.Response(429, headers={"Retry-After": "120"}, json={})

    transport(monkeypatch, clock, respond)
    clock.on_wait = lambda seconds: jobs.request_stop(1) if seconds == 1 else None
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and "Stopped by you" in result["reason"]
    assert len(attempts) == 1 and clock.now <= 1.1
    assert jobs.get(1)["run_id"] == result["run_id"]
    with Store(settings.db_path) as store:
        assert store.get_run(result["run_id"])["state"] == "partial"
        assert sum(stream["pages"] for stream in store.streams(result["run_id"])) == 0
        assert store.retry_not_before()


def test_stop_during_response_leaves_last_committed_cursor(setup, monkeypatch):
    jobs, settings, clock = setup
    attempts = []

    def respond(request):
        attempts.append(request.url.path)
        if len(attempts) == 1:
            return httpx.Response(200, json=[])
        jobs.request_stop(1)
        return httpx.Response(200, json={"items": [], "cursor": "uncommitted"})

    transport(monkeypatch, clock, respond)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and "Stopped by you" in result["reason"]
    assert len(attempts) == 2
    with Store(settings.db_path) as store:
        history = next(stream for stream in store.streams(result["run_id"]) if stream["kind"] == "history")
        assert history["pages"] == 0 and history["next_cursor"] is None
    jobs.finish(1, "partial", result["reason"], result, "worker")
    resumed, duplicate = jobs.enqueue(resume_job_id=1)
    assert not duplicate and not resumed["stop_requested"] and resumed["run_id"] == result["run_id"]


@pytest.mark.parametrize("response, expected", [
    (lambda: httpx.Response(401, json={}), "Authentication"),
    (lambda: httpx.Response(200, content=b"bad JSON"), "stream_failure"),
    (lambda: httpx.Response(503, json={}), "stream_failure"),
])
def test_errors_require_attention_instead_of_restarting(setup, monkeypatch, response, expected):
    jobs, settings, clock = setup
    calls = []

    def respond(request):
        calls.append(request.url.path)
        return response()

    transport(monkeypatch, clock, respond)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] in {"partial", "failed"} and expected in result["reason"]
    assert len(calls) <= settings.retry_attempts * 2  # catalog + one history stream


@pytest.mark.parametrize("network", [False, True])
def test_retry_count_and_backoff_do_not_reset_with_one_attempt_batches(setup, monkeypatch, network):
    from dataclasses import replace
    jobs, settings, clock = setup
    settings = replace(settings, max_attempts=1, retry_attempts=4)
    calls = []
    times = []

    def respond(request):
        calls.append(request.url.path)
        times.append(clock.now)
        if network:
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(503, json={})

    transport(monkeypatch, clock, respond)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "failed" and "stream_failure" in result["reason"]
    assert calls.count("/v1/collections/gifts/") == 4
    assert calls.count("/v1/rent/gifts/history/") == 0
    assert times == pytest.approx([0, 1, 3, 7])


def test_failed_stream_is_not_hidden_by_later_attempt_budget(setup, monkeypatch):
    from dataclasses import replace
    jobs, settings, clock = setup
    settings = replace(settings, max_attempts=2)
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if len(calls) == 1:
            return httpx.Response(200, json=[])
        return httpx.Response(200, content=b"malformed")

    # A general collection has attributes/listings/history; the attributes
    # failure is followed by an attempt-budget stop in a different stream.
    transport(monkeypatch, clock, respond)
    result = execute_job(claimed(jobs, "collect"), jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and result["reason"].startswith("stream_failure:")
    assert len(calls) == 2


def test_no_progress_stops_instead_of_busy_loop(setup, monkeypatch):
    jobs, settings, clock = setup
    calls = []

    def stalled(store, settings, **kwargs):
        run = kwargs["resume_id"] or store.create_run({}, [], [])
        kwargs["on_run_created"](run)
        calls.append(run)
        return CollectionResult(run, "partial", "attempt_budget", 0)

    monkeypatch.setattr(jobs_module, "collect_rental_prices", stalled)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and "No committed progress" in result["reason"]
    assert 2 <= len(calls) <= 3 and len(set(calls)) == 1
    assert clock.now <= 0.3


def test_scope_limit_and_unknown_partial_reason_do_not_continue(setup, monkeypatch):
    jobs, settings, clock = setup
    calls = []

    def limited(store, settings, **kwargs):
        calls.append(1)
        return CollectionResult(1, "partial", "scope_limit", 0)

    monkeypatch.setattr(jobs_module, "collect_rental_prices", limited)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["reason"] == "scope_limit" and len(calls) == 1


def test_discovery_continues_same_run_and_catalog(setup, monkeypatch):
    jobs, settings, clock = setup
    calls = []

    def discover(store, settings, token, **kwargs):
        ds = DiscoveryStore(store)
        run = kwargs["resume_id"] or ds.create_run(WALLET, {})
        kwargs["on_run_created"](run)
        calls.append(kwargs["resume_id"])
        with store.connection:
            store.connection.execute("UPDATE discovery_runs SET catalog_committed=1 WHERE id=?", (run,))
            store.connection.execute("UPDATE discovery_checkpoints SET pages=pages+1 WHERE run_id=?", (run,))
        return DiscoveryResult(run, "partial" if len(calls) < 3 else "complete", "page_limit" if len(calls) < 3 else None, 2)

    monkeypatch.setattr(jobs_module, "discover", discover)
    result = execute_job(claimed(jobs, "discover"), jobs, settings, DiscoverySettings())
    assert result["state"] == "complete" and result["pages_committed"] == 6
    assert calls == [None, result["discovery_run_id"], result["discovery_run_id"]]


def test_finish_race_allows_already_complete_batch_but_no_next_batch(setup, monkeypatch):
    jobs, settings, clock = setup

    def complete(store, settings, **kwargs):
        jobs.request_stop(1)
        return CollectionResult(1, "complete", None, 1)

    monkeypatch.setattr(jobs_module, "collect_rental_prices", complete)
    result = execute_job(claimed(jobs), jobs, settings, DiscoverySettings())
    assert result["state"] == "complete"


def test_queued_stop_is_idempotent_and_resume_clears_it(setup):
    jobs, _, _ = setup
    queued, _ = jobs.enqueue("rental_prices", WALLET)
    stopped = jobs.request_stop(queued["id"])
    assert stopped["state"] == "partial" and stopped["stop_requested"] is True
    assert jobs.request_stop(queued["id"]) == stopped
    assert jobs.lease("worker") and jobs.claim("worker") is None
    resumed, _ = jobs.enqueue(resume_job_id=queued["id"])
    assert resumed["stop_requested"] is False


def test_existing_queue_migration_preserves_saved_job(tmp_path):
    path = tmp_path / "v1.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript("""
          CREATE TABLE dashboard_jobs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
              wallet TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT,
              run_id INTEGER, worker TEXT, result_json TEXT, progress_json TEXT NOT NULL DEFAULT '{}');
          INSERT INTO dashboard_jobs VALUES(1,'rental_prices','partial',NULL,'date','date','page_limit',17,NULL,NULL,'{"pages":42}');
          PRAGMA user_version=1;
        """)
    jobs = JobStore(path)
    assert jobs.get(1)["run_id"] == 17 and jobs.get(1)["progress"] == {"pages": 42}
    assert jobs.get(1)["stop_requested"] is False
    reopened = JobStore(path)
    assert reopened.get(1) == jobs.get(1)
    with jobs.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 3
