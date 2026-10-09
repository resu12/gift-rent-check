"""Request caps apply across automatic batches, jobs, restarts, and retries."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

import marketapp_rent.api as api_module
import marketapp_rent.dashboard_jobs as jobs_module
import marketapp_rent.dashboard_view as view_module
import marketapp_rent.pricing_window as window_module
from marketapp_rent.config import Settings, load_settings
from marketapp_rent.dashboard_jobs import JobStore, execute_job
from marketapp_rent.discovery import DiscoveryResult
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.domain import BudgetExceeded
from marketapp_rent.storage import Store


WALLET = "0:" + "01" * 32
COLLECTION = "0:" + "03" * 32


@pytest.fixture
def setup(tmp_path, monkeypatch):
    clock = SimpleNamespace(now=0.0, waits=[])
    epoch = datetime(2026, 10, 9, tzinfo=timezone.utc)

    class ClockDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = epoch + timedelta(seconds=clock.now)
            return value.astimezone(tz) if tz else value.replace(tzinfo=None)

    def sleep(seconds):
        clock.waits.append(seconds)
        clock.now += seconds

    monkeypatch.setattr(jobs_module, "datetime", ClockDateTime)
    monkeypatch.setattr(api_module, "datetime", ClockDateTime)
    monkeypatch.setattr(window_module, "datetime", ClockDateTime)
    monkeypatch.setattr(jobs_module, "monotonic", lambda: clock.now)
    monkeypatch.setattr(jobs_module.time, "time", lambda: epoch.timestamp() + clock.now)
    monkeypatch.setattr(jobs_module.time, "sleep", sleep)
    monkeypatch.setattr(view_module, "build_dashboard", lambda *args: {"gifts": [
        {"is_portfolio": True, "collection_address": COLLECTION, "model": "Model"}]})
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    settings = Settings(token="fake-secret", db_path=tmp_path / "portfolio.sqlite3", max_pages=1)
    return jobs, settings, clock


def install_transport(monkeypatch, clock, responder):
    original = api_module.ApiClient.__init__

    def initialize(self, *args, **kwargs):
        kwargs.update(transport=httpx.MockTransport(responder), monotonic=lambda: clock.now, random=lambda: 0)
        original(self, *args, **kwargs)

    monkeypatch.setattr(api_module.ApiClient, "__init__", initialize)


def pending_pages(attempts, clock):
    def respond(request):
        attempts.append((clock.now, request.url.path))
        if request.url.path.endswith("collections/gifts/"):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"cursor": str(len(attempts)), "items": []})
    return respond


def test_total_attempt_cap_stops_auto_batches_and_resume_keeps_checkpoint(setup, monkeypatch):
    jobs, settings, clock = setup
    settings = replace(settings, dashboard_max_attempts=3)
    attempts = []
    install_transport(monkeypatch, clock, pending_pages(attempts, clock))
    job, _ = jobs.enqueue("rental_prices", WALLET)
    first = execute_job(job, jobs, settings, DiscoverySettings())
    assert first["state"] == "partial" and "refresh safety limit (3 attempts)" in first["reason"]
    assert len(attempts) == 3 and first["pages_committed"] == 3
    budget = jobs.get(job["id"])["progress"]["marketapp_budget"]
    assert budget["invocation_used"] == 3 and budget["rolling_24h_used"] == 3
    jobs.finish(job["id"], "partial", first["reason"], first)
    resumed, _ = jobs.enqueue(resume_job_id=job["id"])
    second = execute_job(resumed, jobs, settings, DiscoverySettings())
    assert second["state"] == "partial" and second["run_id"] == first["run_id"]
    assert len(attempts) == 6
    assert sum(path.endswith("collections/gifts/") for _, path in attempts) == 1
    assert jobs.get(job["id"])["progress"]["marketapp_budget"]["rolling_24h_used"] == 6


@pytest.mark.parametrize("kind,attempt_limit", [("rental_prices", 2), ("collect", 4)])
def test_windowed_history_job_cap_resume_and_timeframe_completion(setup, monkeypatch, kind, attempt_limit):
    jobs, settings, clock = setup
    settings = replace(settings, dashboard_max_attempts=attempt_limit)
    cutoff = int(datetime(2026, 10, 2, tzinfo=timezone.utc).timestamp())
    window = {"timeframe": "7d", "window_from": "2026-10-02T00:00:00+00:00", "window_to": "2026-10-09T00:00:00+00:00", "timezone": "UTC"}
    attempts = []

    def respond(request):
        attempts.append((request.url.path, request.url.params.get("cursor")))
        if request.url.path.endswith("collections/gifts/"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/attributes/"):
            return httpx.Response(200, json={"attributes": []})
        if request.url.path == "/v1/rent/gifts/":
            return httpx.Response(200, json={"cursor": None, "items": []})
        cursor = request.url.params.get("cursor")
        assert cursor in {None, "boundary"}
        record = {"address": "0:" + "02" * 32, "name": "Example #1", "collection_address": COLLECTION,
                  "ts": cutoff + 60 if cursor is None else cutoff - 60,
                  "src": "source", "dst": "destination", "price": "0.15", "price_nano": "150000000",
                  "currency": "GRAM", "duration": 86400}
        return httpx.Response(200, json={"cursor": "boundary" if cursor is None else "older-unneeded", "items": [record]})

    install_transport(monkeypatch, clock, respond)
    job, _ = jobs.enqueue(kind, WALLET, collection_window=window)
    first = execute_job(job, jobs, settings, DiscoverySettings())
    assert first["state"] == "partial" and len(attempts) == attempt_limit
    jobs.finish(job["id"], "partial", first["reason"], first)
    resumed, _ = jobs.enqueue(resume_job_id=job["id"])
    second = execute_job(resumed, jobs, settings, DiscoverySettings())
    assert second["state"] == "complete" and second["reason"] == "timeframe_covered"
    assert second["run_id"] == first["run_id"] and len(attempts) == attempt_limit + 1
    assert attempts[-1][1] == "boundary"
    with Store(settings.db_path) as store:
        assert store.get_run(first["run_id"])["settings"]["history_since"] == cutoff
        history = next(stream for stream in store.streams(first["run_id"]) if stream["kind"] == "history")
        assert history["state"] == "complete" and history["reason"] == "timeframe_covered"
        assert history["pages"] == 2


def test_daily_limit_shared_by_new_jobs_resume_and_reopened_store(setup, monkeypatch):
    jobs, settings, clock = setup
    settings = replace(settings, dashboard_daily_max_attempts=2)
    attempts = []
    install_transport(monkeypatch, clock, pending_pages(attempts, clock))
    first, _ = jobs.enqueue("rental_prices", WALLET)
    result = execute_job(first, jobs, settings, DiscoverySettings())
    jobs.finish(first["id"], "partial", result["reason"], result)
    reopened = JobStore(jobs.path)
    second, _ = reopened.enqueue("rental_prices", WALLET)
    result = execute_job(second, reopened, settings, DiscoverySettings())
    assert "rolling 24-hour safety limit" in result["reason"]
    assert len(attempts) == 2
    assert reopened.marketapp_usage(2)["remaining_24h"] == 0
    assert reopened.get(second["id"])["progress"]["marketapp_budget"]["invocation_used"] == 0


def test_separate_jobs_preserve_request_pacing_after_reopening(setup, monkeypatch):
    jobs, settings, clock = setup
    attempts = []

    def respond(request):
        attempts.append(clock.now)
        return httpx.Response(200, json=[])

    monkeypatch.setattr(view_module, "build_dashboard", lambda *args: {"gifts": []})
    install_transport(monkeypatch, clock, respond)
    first, _ = jobs.enqueue("prices", WALLET)
    result = execute_job(first, jobs, settings, DiscoverySettings())
    jobs.finish(first["id"], result["state"], result=result)
    jobs = JobStore(jobs.path)
    second, _ = jobs.enqueue("prices", WALLET)
    execute_job(second, jobs, settings, DiscoverySettings())
    assert len(attempts) == 2 and attempts[1] - attempts[0] >= 1


def test_ton_requests_are_separate_from_marketapp_ledger(setup, monkeypatch):
    jobs, settings, clock = setup
    attempts = []

    def discover(store, configuration, token, **kwargs):
        def respond(request):
            attempts.append(request.url.host)
            return httpx.Response(200, json={"nft_items": []})
        with kwargs["ton_client_factory"](None, transport=httpx.MockTransport(respond), monotonic=lambda: clock.now) as client:
            client.get("/api/v3/nft/items", {})
        return DiscoveryResult(1, "complete", None, 0)

    monkeypatch.setattr(jobs_module, "discover", discover)
    job, _ = jobs.enqueue("discover", WALLET)
    result = execute_job(job, jobs, settings, DiscoverySettings())
    assert result["state"] == "complete" and attempts == ["toncenter.com"]
    assert jobs.marketapp_usage(500)["used_24h"] == 0


@pytest.mark.parametrize("network", [False, True])
def test_retries_consume_shared_budget_before_transport(setup, monkeypatch, network):
    jobs, settings, clock = setup
    settings = replace(settings, dashboard_max_attempts=2, retry_attempts=4)
    attempts = []

    def respond(request):
        attempts.append(request.url.path)
        if network:
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(503, json={})

    install_transport(monkeypatch, clock, respond)
    job, _ = jobs.enqueue("rental_prices", WALLET)
    result = execute_job(job, jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and "refresh safety limit" in result["reason"]
    assert len(attempts) == 2 and jobs.marketapp_usage(500)["used_24h"] == 2


def test_duration_is_not_reset_by_batches_and_rate_never_exceeds_one(setup, monkeypatch):
    jobs, settings, clock = setup
    settings = replace(settings, dashboard_run_seconds=2.5, requests_per_second=100)
    attempts = []
    install_transport(monkeypatch, clock, pending_pages(attempts, clock))
    job, _ = jobs.enqueue("rental_prices", WALLET)
    result = execute_job(job, jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and "duration" in result["reason"]
    assert len(attempts) == 3 and clock.now <= 2.5
    assert all(b[0] - a[0] >= 1 for a, b in zip(attempts, attempts[1:]))


def test_retry_after_larger_than_total_duration_pauses_promptly(setup, monkeypatch):
    jobs, settings, clock = setup
    settings = replace(settings, dashboard_run_seconds=5)
    attempts = []

    def respond(request):
        attempts.append(request.url.path)
        return httpx.Response(429, headers={"Retry-After": "120"}, json={})

    install_transport(monkeypatch, clock, respond)
    job, _ = jobs.enqueue("rental_prices", WALLET)
    result = execute_job(job, jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and "duration" in result["reason"]
    assert len(attempts) == 1 and clock.now == 0
    with Store(settings.db_path) as store:
        assert store.retry_not_before()


def test_rolling_day_expiry_and_concurrent_reservations(tmp_path):
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    job, _ = jobs.enqueue("collect", WALLET)

    def reserve(index):
        try:
            jobs.reserve_marketapp_attempt(job["id"], str(index), 100, 3, now=100000)
            return True
        except BudgetExceeded as exc:
            assert exc.reason == "dashboard_daily_budget"
            return False

    with ThreadPoolExecutor(max_workers=6) as pool:
        assert sum(pool.map(reserve, range(6))) == 3
    assert jobs.marketapp_usage(3, now=186399)["remaining_24h"] == 0
    assert jobs.marketapp_usage(3, now=186400)["remaining_24h"] == 3
    assert jobs.reserve_marketapp_attempt(job["id"], "later", 100, 3, now=186400)["rolling_24h_used"] == 1


def test_progress_updates_cannot_erase_budget_and_collection_window_is_frozen(tmp_path):
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    window = window_module.window_metadata(window_module.dashboard_window("7d"))
    job, _ = jobs.enqueue("rental_prices", WALLET, collection_window=window)
    jobs.reserve_marketapp_attempt(job["id"], "run", 100, 500)
    jobs.progress(job["id"], {"pages": 7})
    assert jobs.get(job["id"])["progress"]["marketapp_budget"]["invocation_used"] == 1
    jobs.finish(job["id"], "partial")
    with pytest.raises(ValueError, match="timeframe"):
        jobs.enqueue(resume_job_id=job["id"], collection_window={"window_from": "2025-01-01"})
    resumed, _ = jobs.enqueue(resume_job_id=job["id"])
    assert resumed["collection_window"] == window


def test_dashboard_limit_configuration_preserves_cli_defaults(tmp_path):
    settings = load_settings(tmp_path / "missing", {"MARKETAPP_DASHBOARD_MAX_ATTEMPTS": "7", "MARKETAPP_DASHBOARD_DAILY_MAX_ATTEMPTS": "20", "MARKETAPP_DASHBOARD_RUN_SECONDS": "15"})
    assert (settings.dashboard_max_attempts, settings.dashboard_daily_max_attempts, settings.dashboard_run_seconds) == (7, 20, 15)
    assert (settings.max_attempts, settings.run_seconds) == (25, 300)


@pytest.mark.parametrize("value", [{"dashboard_max_attempts": 0}, {"dashboard_daily_max_attempts": True}, {"dashboard_run_seconds": float("inf")}])
def test_invalid_dashboard_limits(value):
    with pytest.raises(ValueError):
        Settings(**value)
