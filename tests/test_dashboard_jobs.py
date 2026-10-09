"""Durable dashboard jobs exercised without the optional web dependencies."""

from concurrent.futures import Future, ThreadPoolExecutor
import json
import threading
from types import SimpleNamespace

import pytest
import httpx

import marketapp_rent.dashboard_jobs as jobs_module
from marketapp_rent.dashboard_jobs import JobStore, JobWorker, execute_job
from marketapp_rent.config import Settings
from marketapp_rent.discovery import DiscoveryResult
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse
from marketapp_rent.domain import BudgetExceeded
from marketapp_rent.collector import CollectionResult
from marketapp_rent.addresses import preferred_address
from marketapp_rent.storage import Store


WALLET = "0:" + "01" * 32
NFT = "0:" + "02" * 32
COLLECTION = "0:" + "03" * 32


@pytest.fixture
def jobs(tmp_path):
    return JobStore(tmp_path / "jobs.sqlite3")


@pytest.fixture
def clock(monkeypatch):
    value = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(jobs_module, "time", SimpleNamespace(time=lambda: value.now, sleep=lambda _: None))
    return value


def test_concurrent_duplicate_clicks_persist_one_active_job(jobs):
    barrier = threading.Barrier(6)

    def click(_):
        barrier.wait(timeout=10)
        return jobs.enqueue("refresh", WALLET)

    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(click, range(6)))
    assert len({row["id"] for row, _ in results}) == 1
    assert sum(not duplicate for _, duplicate in results) == 1
    reopened = JobStore(jobs.path)
    assert len(reopened.list()) == 1
    assert reopened.list()[0]["state"] == "queued"


def test_duplicate_running_click_does_not_start_another_operation(jobs, clock):
    first, _ = jobs.enqueue("refresh", WALLET)
    assert jobs.lease("worker-a")
    claimed = jobs.claim("worker-a")
    second, duplicate = jobs.enqueue("discover", WALLET)
    assert duplicate and second["id"] == first["id"] == claimed["id"]
    assert second["kind"] == "refresh"
    assert jobs.claim("worker-a") is None


def test_claim_requires_current_live_lease(jobs, clock):
    jobs.enqueue("refresh", WALLET)
    assert jobs.claim("worker-a") is None
    assert jobs.lease("worker-a")
    assert jobs.claim("worker-b") is None
    clock.now += 16
    assert jobs.claim("worker-a") is None
    assert jobs.get(1)["state"] == "queued"


def test_expired_lease_recovers_saved_run_and_progress_without_auto_restart(jobs, clock):
    job, _ = jobs.enqueue("refresh", WALLET)
    assert jobs.lease("worker-a")
    assert jobs.claim("worker-a")["id"] == job["id"]
    jobs.link_run(job["id"], 41)
    jobs.progress(job["id"], {"pending": 2, "verified": 3})
    assert not jobs.lease("worker-b")
    clock.now += 16
    assert jobs.lease("worker-b")
    recovered = JobStore(jobs.path).get(job["id"])
    assert recovered["state"] == "partial"
    assert recovered["run_id"] == 41
    assert recovered["progress"] == {"pending": 2, "verified": 3}
    assert "resume" in recovered["reason"].lower()
    assert jobs.claim("worker-b") is None
    resumed, duplicate = jobs.enqueue(resume_job_id=job["id"], wallet=WALLET)
    assert not duplicate and resumed["run_id"] == 41
    assert jobs.claim("worker-b")["id"] == job["id"]
    assert len(jobs.list()) == 1


def test_stale_worker_cannot_overwrite_reclaimed_job(jobs, clock):
    job, _ = jobs.enqueue("refresh", WALLET)
    assert jobs.lease("worker-a")
    jobs.claim("worker-a")
    assert jobs.link_run(job["id"], 41, "worker-a")
    clock.now += 16
    assert jobs.lease("worker-b")
    jobs.enqueue(resume_job_id=job["id"])
    jobs.claim("worker-b")
    assert jobs.owns(job["id"], "worker-b")
    assert not jobs.owns(job["id"], "worker-a")
    assert not jobs.link_run(job["id"], 999, "worker-a")
    assert not jobs.progress(job["id"], {"wrong": True}, "worker-a")
    assert not jobs.finish(job["id"], "complete", result={"wrong": True}, worker="worker-a")
    current = jobs.get(job["id"])
    assert current["state"] == "running" and current["run_id"] == 41
    assert current["progress"] == {} and current["result"] is None
    assert jobs.finish(job["id"], "complete", worker="worker-b")


@pytest.mark.parametrize("state", ["partial", "failed"])
def test_resume_reuses_job_and_run_but_rejects_different_wallet(jobs, state):
    job, _ = jobs.enqueue("refresh", WALLET)
    jobs.link_run(job["id"], 19)
    jobs.finish(job["id"], state, "bounded", {"state": state})
    with pytest.raises(ValueError, match="wallet"):
        jobs.enqueue(resume_job_id=job["id"], wallet=NFT)
    resumed, duplicate = jobs.enqueue(resume_job_id=job["id"], wallet=WALLET)
    assert not duplicate
    assert resumed["state"] == "queued" and resumed["run_id"] == 19
    assert resumed["id"] == job["id"] and resumed["reason"] is None


def test_complete_jobs_cannot_resume_and_new_click_starts_new_run(jobs):
    job, _ = jobs.enqueue("refresh", WALLET)
    jobs.finish(job["id"], "complete")
    with pytest.raises(ValueError, match="partial or failed"):
        jobs.enqueue(resume_job_id=job["id"])
    new, duplicate = jobs.enqueue("refresh", WALLET)
    assert not duplicate and new["id"] != job["id"] and new["run_id"] is None
    with pytest.raises(ValueError, match="Unknown"):
        jobs.enqueue("submit_transaction", WALLET)


class ImmediateExecutor:
    """Exercise the worker loop deterministically without a background thread."""

    def __init__(self, *args, **kwargs):
        self.closed = False

    def submit(self, function, *args):
        future = Future()
        try:
            future.set_result(function(*args))
        except Exception as exc:
            future.set_exception(exc)
        return future

    def shutdown(self, wait=True):
        self.closed = True


def run_worker_once(jobs, clock, monkeypatch, execute, secrets=()):
    monkeypatch.setattr(jobs_module, "ThreadPoolExecutor", ImmediateExecutor)
    worker = JobWorker(jobs, jobs.path.parent / "portfolio.sqlite3", None, secrets=secrets)

    def bounded(job):
        try:
            return execute(job)
        finally:
            worker.stop_event.set()

    worker.execute = bounded
    worker.run()
    return worker


def test_worker_partial_then_resume_keeps_provider_run_identity(jobs, clock, monkeypatch):
    job, _ = jobs.enqueue("refresh", WALLET)
    invocations = []

    def first(row):
        invocations.append(row["run_id"])
        jobs.link_run(row["id"], 73)
        return {"state": "partial", "reason": "attempt_budget", "discovery_run_id": 73, "pages_committed": 0}

    run_worker_once(jobs, clock, monkeypatch, first)
    assert jobs.get(job["id"])["state"] == "partial"
    jobs.enqueue(resume_job_id=job["id"], wallet=WALLET)

    def second(row):
        invocations.append(row["run_id"])
        return {"state": "complete", "reason": None, "discovery_run_id": row["run_id"], "pages_committed": 0}

    run_worker_once(jobs, clock, monkeypatch, second)
    final = JobStore(jobs.path).get(job["id"])
    assert invocations == [None, 73]
    assert final["state"] == "complete" and final["result"]["discovery_run_id"] == 73
    assert len(jobs.list()) == 1


@pytest.mark.parametrize("failure", [False, True])
def test_worker_redacts_result_reason_and_exception_before_persistence(jobs, clock, monkeypatch, failure):
    secret_a, secret_b = "fake-market-secret-123", "fake-ton-secret-456"
    job, _ = jobs.enqueue("refresh", WALLET)

    def execute(_):
        reason = f"provider error: {secret_a}; key={secret_b}"
        if failure:
            raise RuntimeError(reason)
        return {"state": "failed", "reason": reason, "discovery_run_id": 4}

    run_worker_once(jobs, clock, monkeypatch, execute, secrets=(secret_a, "", secret_b))
    row = JobStore(jobs.path).get(job["id"])
    assert row["state"] == "failed"
    assert "[REDACTED]" in row["reason"]
    with jobs.connect() as connection:
        persisted = json.dumps(dict(connection.execute("SELECT * FROM dashboard_jobs").fetchone()))
        assert connection.execute("SELECT COUNT(*) FROM dashboard_lease").fetchone()[0] == 0
    assert secret_a not in persisted and secret_b not in persisted


def test_worker_discards_late_completion_after_another_worker_recovers_lease(jobs, clock, monkeypatch):
    job, _ = jobs.enqueue("refresh", WALLET)

    def execute(row):
        jobs.link_run(row["id"], 17, row["lease_owner"])
        clock.now += 16
        assert jobs.lease("worker-b")
        return {"state": "complete", "reason": None, "discovery_run_id": 17}

    run_worker_once(jobs, clock, monkeypatch, execute)
    recovered = jobs.get(job["id"])
    assert recovered["state"] == "partial" and recovered["run_id"] == 17
    assert recovered["result"] is None
    with jobs.connect() as connection:
        assert connection.execute("SELECT worker FROM dashboard_lease").fetchone()[0] == "worker-b"


def test_shutdown_guard_stops_before_provider_request_and_keeps_resumable_run(jobs, clock, monkeypatch):
    monkeypatch.setattr(jobs_module.ApiClient, "get", lambda *args, **kwargs: pytest.fail("Cancelled job made a request"))
    job, _ = jobs.enqueue("refresh", WALLET)
    assert jobs.lease("worker-a")
    claimed = jobs.claim("worker-a")
    cancel = threading.Event()
    cancel.set()
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    result = execute_job(claimed, jobs, settings, DiscoverySettings(), cancel_event=cancel)
    assert result["state"] == "partial" and result["reason"] == "interrupted"
    assert jobs.get(job["id"])["run_id"] == result["discovery_run_id"]
    with Store(settings.db_path) as store:
        assert not DiscoveryStore(store).get_run(result["discovery_run_id"])["catalog_committed"]
        assert store.connection.execute("SELECT COUNT(*) FROM discovery_responses").fetchone()[0] == 0


def test_provider_response_after_lease_loss_does_not_commit_catalog(jobs, clock, monkeypatch):
    def losing_lease(*args, **kwargs):
        clock.now += 16
        assert jobs.lease("worker-b")
        return ApiResponse(json.dumps([{"address": COLLECTION, "name": "Supported", "extra_data": {}}]).encode(),
                           200, "2026-10-08T10:00:00+00:00")

    monkeypatch.setattr(jobs_module.ApiClient, "get", losing_lease)
    job, _ = jobs.enqueue("refresh", WALLET)
    assert jobs.lease("worker-a")
    claimed = jobs.claim("worker-a")
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    result = execute_job(claimed, jobs, settings, DiscoverySettings())
    assert result["state"] == "partial" and result["reason"] == "worker_lease_lost"
    assert jobs.get(job["id"])["run_id"] == result["discovery_run_id"]
    with Store(settings.db_path) as store:
        ds = DiscoveryStore(store)
        assert not ds.get_run(result["discovery_run_id"])["catalog_committed"]
        assert ds.memberships() == []


def test_executor_links_discovery_run_before_provider_work_and_resumes_it(jobs, monkeypatch):
    import marketapp_rent.dashboard_view as view_module

    monkeypatch.setattr(view_module, "build_dashboard", lambda *args: {
        "gifts": [{"nft_address": NFT, "collection_address": COLLECTION, "is_portfolio": True}]
    })
    calls = []

    def fake_discover(store, settings, token, **kwargs):
        calls.append(kwargs)
        run_id = kwargs["resume_id"] or DiscoveryStore(store).create_run(WALLET, {"mode": "portfolio_refresh"})
        kwargs["on_run_created"](run_id)
        # This assertion executes where the first HTTP attempt would occur.
        assert JobStore(jobs.path).get(1)["run_id"] == run_id
        return DiscoveryResult(run_id, "partial" if len(calls) == 1 else "complete", None, 0)

    monkeypatch.setattr(jobs_module, "discover", fake_discover)
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    first, _ = jobs.enqueue("refresh", WALLET)
    result = execute_job(first, jobs, settings, DiscoverySettings())
    jobs.finish(first["id"], result["state"], result=result)
    resumed, _ = jobs.enqueue(resume_job_id=first["id"])
    second = execute_job(resumed, jobs, settings, DiscoverySettings())
    assert second["state"] == "complete"
    assert [call["resume_id"] for call in calls] == [None, result["discovery_run_id"]]
    assert all(call["mode"] == "portfolio_refresh" for call in calls)
    assert calls[0]["seed_candidates"][0]["nft_address"] == NFT


@pytest.mark.parametrize("gifts, expected", [
    ([{"is_portfolio": True, "collection_address": COLLECTION}, {"is_portfolio": True, "collection_address": None}], [preferred_address(COLLECTION), None]),
    ([{"is_portfolio": True, "collection_address": None}], [None]),
    ([{"is_portfolio": False, "collection_address": COLLECTION}], []),
])
def test_collection_job_uses_only_selected_wallet_scopes_including_unknown(jobs, monkeypatch, gifts, expected):
    import marketapp_rent.dashboard_view as view_module
    monkeypatch.setattr(view_module, "build_dashboard", lambda *args: {"gifts": gifts})
    calls = []
    def fake_collect(store, settings, **kwargs):
        calls.append(kwargs)
        assert settings.max_collections >= len(expected)
        return CollectionResult(1, "complete", None, 0)
    monkeypatch.setattr(jobs_module, "collect", fake_collect)
    job, _ = jobs.enqueue("collect", WALLET)
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    assert execute_job(job, jobs, settings, DiscoverySettings())["state"] == "complete"
    assert calls[0]["scope_manifest"] == expected
    assert "collection_addresses" not in calls[0]


@pytest.mark.parametrize("provider", ["marketapp", "toncenter"])
def test_stop_interrupts_retry_after_without_another_http_attempt(jobs, monkeypatch, provider):
    class CancelDuringWait:
        stopped = False
        waits = []
        def is_set(self):
            return self.stopped
        def wait(self, seconds):
            self.waits.append(seconds)
            self.stopped = True
    cancel = CancelDuringWait()
    attempts = []
    def respond(request):
        attempts.append(request.url.path)
        return httpx.Response(429, headers={"Retry-After": "120"}, json={})
    def fake_discover(store, settings, token, **kwargs):
        factory = kwargs["marketapp_client_factory" if provider == "marketapp" else "ton_client_factory"]
        with factory(token, transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(BudgetExceeded) as error:
                client.get("/v1/collections/gifts/" if provider == "marketapp" else "/api/v3/nft/items", {})
        assert error.value.reason == "interrupted"
        return DiscoveryResult(1, "partial", "interrupted", 0)
    monkeypatch.setattr(jobs_module, "discover", fake_discover)
    job, _ = jobs.enqueue("refresh", WALLET)
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    result = execute_job(job, jobs, settings, DiscoverySettings(), cancel_event=cancel)
    assert result["reason"] == "interrupted"
    assert len(attempts) == 1 and cancel.waits == [1]


@pytest.mark.parametrize("kind, collector", [("prices", "collect_prices"), ("rental_prices", "collect_rental_prices")])
def test_price_job_links_collection_run_and_resumes_without_new_targets(jobs, monkeypatch, kind, collector):
    import marketapp_rent.dashboard_view as view_module
    monkeypatch.setattr(view_module, "build_dashboard", lambda *args: {"gifts": [
        {"is_portfolio": True, "nft_address": NFT, "collection_address": COLLECTION, "model": "Example", "backdrop": "Black"}]})
    calls = []
    def fake_prices(store, settings, **kwargs):
        calls.append(kwargs)
        assert settings.page_size == 100
        run_id = kwargs["resume_id"] or store.create_run({"mode": kind}, [COLLECTION], [])
        kwargs["on_run_created"](run_id)
        assert jobs.get(1)["run_id"] == run_id
        return CollectionResult(run_id, "partial" if len(calls) == 1 else "complete", None, 0)
    monkeypatch.setattr(jobs_module, collector, fake_prices)
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    first, _ = jobs.enqueue(kind, WALLET)
    result = execute_job(first, jobs, settings, DiscoverySettings())
    jobs.finish(first["id"], result["state"], result=result)
    resumed, _ = jobs.enqueue(resume_job_id=first["id"])
    assert execute_job(resumed, jobs, settings, DiscoverySettings())["state"] == "complete"
    assert [call["resume_id"] for call in calls] == [None, jobs.get(first["id"])["run_id"]]


def test_rental_price_progress_uses_history_stream_checkpoints(jobs):
    database = jobs.path.parent / "portfolio.sqlite3"
    with Store(database) as store:
        run = store.create_run({"mode": "rental_pricing"}, [COLLECTION], [])
        catalog = store.add_stream(run, "collection", "/v1/collections/gifts/", {})
        history = store.add_stream(run, "history", "/v1/rent/gifts/history/", {"collection_address": COLLECTION})
        from marketapp_rent.models import parse_page
        store.commit_page(catalog, None, ApiResponse(b"[]", 200, "2026-10-08T10:00:00Z"), parse_page("collection", b"[]"))
        body = b'{"cursor":"next","items":[]}'
        store.commit_page(history, None, ApiResponse(body, 200, "2026-10-08T10:00:01Z"), parse_page("history", body))
    assert jobs_module.progress_for(database, {"kind": "rental_prices", "run_id": run}) == {
        "pages": 2, "streams_complete": 1, "streams_total": 2,
        "sync": {"phase": "rentals", "completed": 0, "total": 1, "unit": "collections",
                 "current_collection": None, "processed_items": 0},
    }


def test_rental_price_shutdown_guard_keeps_new_run_resumable_without_http(jobs, monkeypatch):
    monkeypatch.setattr(jobs_module.ApiClient, "get", lambda *args, **kwargs: pytest.fail("Cancelled job made a request"))
    job, _ = jobs.enqueue("rental_prices", WALLET)
    cancel = threading.Event()
    cancel.set()
    settings = Settings(token="fake-market-token", db_path=jobs.path.parent / "portfolio.sqlite3")
    result = execute_job(job, jobs, settings, DiscoverySettings(), cancel_event=cancel)
    assert result["state"] == "partial"
    assert jobs.get(job["id"])["run_id"] == result["run_id"]
    with Store(settings.db_path) as store:
        assert store.get_run(result["run_id"])["settings"]["mode"] == "rental_pricing"
        assert sum(stream["pages"] for stream in store.streams(result["run_id"])) == 0
