import json

import pytest

from marketapp_rent.dashboard_jobs import JobStore


def price_run(jobs, **overrides):
    run = {"state": "running", "deadline": 200_000, "lease_until": 0, **overrides}
    with jobs.connect() as db:
        db.execute("CREATE TABLE owned_price_runs(id INTEGER PRIMARY KEY, document TEXT)")
        db.execute("INSERT INTO owned_price_runs(document) VALUES(?)", (json.dumps(run),))


@pytest.mark.parametrize("kind", ["refresh", "discover"])
@pytest.mark.parametrize("resume", [False, True])
def test_ownership_cannot_overlap_price_check(tmp_path, monkeypatch, kind, resume):
    monkeypatch.setattr("marketapp_rent.dashboard_jobs.time.time", lambda: 100)
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    job = None
    if resume:
        job, _ = jobs.enqueue(kind, "wallet")
        jobs.finish(job["id"], "partial")
    price_run(jobs)
    with pytest.raises(ValueError, match="rent price check"):
        jobs.enqueue(kind, "wallet", resume_job_id=job["id"] if job else None)
    assert all(row["state"] == "partial" for row in jobs.list())


@pytest.mark.parametrize("state,deadline,lease,blocked", [
    ("partial", 90_000, 150_000, True),
    ("running", 90_000, 0, False),
    ("complete", 200_000, 0, False),
    ("partial", 200_000, 0, False),
])
def test_stopped_inflight_request_retains_exclusion(tmp_path, monkeypatch, state, deadline, lease, blocked):
    monkeypatch.setattr("marketapp_rent.dashboard_jobs.time.time", lambda: 100)
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    price_run(jobs, state=state, deadline=deadline, lease_until=lease)
    if blocked:
        with pytest.raises(ValueError, match="rent price check"):
            jobs.enqueue("refresh", "wallet")
    else:
        assert jobs.enqueue("refresh", "wallet")[0]["state"] == "queued"


def test_marketapp_jobs_and_legacy_database_are_unaffected(tmp_path, monkeypatch):
    monkeypatch.setattr("marketapp_rent.dashboard_jobs.time.time", lambda: 100)
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    job, _ = jobs.enqueue("refresh", "wallet")
    jobs.finish(job["id"], "complete")
    price_run(jobs)
    assert jobs.enqueue("prices", "wallet")[0]["state"] == "queued"


@pytest.mark.parametrize("delay", [1000, 3_600_000])
def test_completed_price_check_cooldown_blocks_ownership_only(tmp_path, monkeypatch, delay):
    monkeypatch.setattr("marketapp_rent.dashboard_jobs.time.time", lambda: 100)
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    price_run(jobs, state="partial", lease_until=0)
    with jobs.connect() as db:
        db.execute("CREATE TABLE owned_price_state(singleton INTEGER PRIMARY KEY, next_allowed_at INTEGER)")
        db.execute("INSERT INTO owned_price_state VALUES(1, ?)", (100_000 + delay,))
    with pytest.raises(ValueError, match="TON is cooling down"):
        jobs.enqueue("refresh", "wallet")
    job, _ = jobs.enqueue("prices", "wallet")
    jobs.finish(job["id"], "complete")
    monkeypatch.setattr("marketapp_rent.dashboard_jobs.time.time", lambda: 100 + delay / 1000)
    assert jobs.enqueue("refresh", "wallet")[0]["state"] == "queued"
