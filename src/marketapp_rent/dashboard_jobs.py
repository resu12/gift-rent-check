"""Durable dashboard jobs that continue bounded batches until done or stopped."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Callable
from urllib.parse import unquote

from .addresses import address_key, canonical_address, preferred_address
from .api import ApiClient, RETRY_STATUSES
from .collector import collect
from .price_collection import collect_prices, collect_rental_prices
from .pricing_window import dashboard_window, validate_new_history_window, validate_saved_dashboard_window, window_metadata
from .discovery import discover
from .discovery_store import DiscoveryStore
from .domain import BudgetExceeded
from .storage import Store
from .ton_api import TonClient
from .util import utc_now


class JobStore:
    """A separate queue database leaves collector schema v2 backward compatible."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS dashboard_jobs (
                    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
                    wallet TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    reason TEXT, run_id INTEGER, worker TEXT,
                    result_json TEXT, progress_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE UNIQUE INDEX IF NOT EXISTS dashboard_one_active_job
                    ON dashboard_jobs((1)) WHERE state IN ('queued','running');
                CREATE TABLE IF NOT EXISTS dashboard_lease (
                    id INTEGER PRIMARY KEY CHECK(id=1), worker TEXT NOT NULL, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS dashboard_marketapp_attempts (
                    id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL,
                    invocation TEXT NOT NULL, attempted_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS dashboard_marketapp_attempt_time
                    ON dashboard_marketapp_attempts(attempted_at);
                CREATE INDEX IF NOT EXISTS dashboard_marketapp_attempt_invocation
                    ON dashboard_marketapp_attempts(invocation);
            """)
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(dashboard_jobs)")}
            if "stop_requested" not in columns:
                connection.execute("ALTER TABLE dashboard_jobs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0")
            if "marketapp_budget_json" not in columns:
                connection.execute("ALTER TABLE dashboard_jobs ADD COLUMN marketapp_budget_json TEXT NOT NULL DEFAULT '{}'")
            if "collection_window_json" not in columns:
                connection.execute("ALTER TABLE dashboard_jobs ADD COLUMN collection_window_json TEXT")
            connection.execute("PRAGMA user_version=3")

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def row(row):
        if row is None:
            raise ValueError("Job does not exist")
        value = dict(row)
        value["progress"] = json.loads(value.pop("progress_json"))
        budget = json.loads(value.pop("marketapp_budget_json"))
        if budget:
            value["progress"]["marketapp_budget"] = budget
        value["collection_window"] = json.loads(value.pop("collection_window_json")) if value.get("collection_window_json") else None
        value.pop("collection_window_json", None)
        value["result"] = json.loads(value.pop("result_json")) if value.get("result_json") else None
        value.pop("result_json", None)
        value.pop("worker", None)
        value["stop_requested"] = bool(value["stop_requested"])
        return value

    def get(self, job_id):
        with self.connect() as connection:
            return self.row(connection.execute("SELECT * FROM dashboard_jobs WHERE id=?", (job_id,)).fetchone())

    def list(self):
        with self.connect() as connection:
            return [self.row(row) for row in connection.execute("SELECT * FROM dashboard_jobs ORDER BY id DESC LIMIT 100")]

    @staticmethod
    def _check_price_refresh(connection, kind):
        """Serialize TON ownership work with the browser's targeted price check."""
        if kind not in {"refresh", "discover"}:
            return
        now_ms = int(time.time() * 1000)
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owned_price_state'").fetchone():
            cooldown = connection.execute("SELECT next_allowed_at FROM owned_price_state WHERE singleton=1").fetchone()
            if cooldown and cooldown[0] > now_ms:
                when = datetime.fromtimestamp(cooldown[0] / 1000, timezone.utc).isoformat()
                raise ValueError(f"TON is cooling down; retry ownership refresh after {when}.")
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owned_price_runs'").fetchone():
            return
        row = connection.execute("SELECT document FROM owned_price_runs ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            return
        run = json.loads(row["document"])
        if run.get("lease_until", 0) > now_ms or (run.get("state") == "running" and run.get("deadline", 0) > now_ms):
            raise ValueError("Wait for the rent price check to finish, or stop it before refreshing ownership.")

    def enqueue(self, kind=None, wallet=None, resume_job_id=None, *, collection_window=None):
        if kind is not None and kind not in {"refresh", "discover", "collect", "prices", "rental_prices"}:
            raise ValueError("Unknown refresh operation")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("SELECT * FROM dashboard_jobs WHERE state IN ('queued','running')").fetchone()
            if existing:
                return self.row(existing), True
            now = utc_now()
            if resume_job_id is not None:
                previous = self.row(connection.execute("SELECT * FROM dashboard_jobs WHERE id=?", (resume_job_id,)).fetchone())
                if previous["state"] not in {"partial", "failed"}:
                    raise ValueError("Only partial or failed work can be resumed")
                if wallet and previous["wallet"] != wallet:
                    raise ValueError("Resume wallet differs from the configured wallet")
                if previous["kind"] in {"rental_prices", "collect"}:
                    validate_saved_dashboard_window(previous["collection_window"])
                if collection_window is not None and previous["collection_window"] != collection_window:
                    raise ValueError("Resume timeframe differs from the saved collection timeframe")
                self._check_price_refresh(connection, previous["kind"])
                connection.execute("UPDATE dashboard_jobs SET state='queued',reason=NULL,updated_at=?,worker=NULL,stop_requested=0 WHERE id=?", (now, resume_job_id))
                job_id = resume_job_id
            else:
                if kind is None:
                    raise ValueError("Choose a refresh operation")
                self._check_price_refresh(connection, kind)
                if kind in {"prices", "rental_prices", "collect"}:
                    if collection_window is None:
                        collection_window = window_metadata(dashboard_window())
                    validate_saved_dashboard_window(collection_window)
                    if kind in {"rental_prices", "collect"}:
                        validate_new_history_window(collection_window)
                job_id = connection.execute("INSERT INTO dashboard_jobs(kind,state,wallet,created_at,updated_at,collection_window_json) VALUES (?,'queued',?,?,?,?)", (kind, wallet, now, now, json.dumps(collection_window) if collection_window is not None else None)).lastrowid
            return self.row(connection.execute("SELECT * FROM dashboard_jobs WHERE id=?", (job_id,)).fetchone()), False

    def marketapp_usage(self, limit, now=None):
        """Read the shared rolling budget; no provider credentials are stored."""
        now = time.time() if now is None else now
        with self.connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS used, MIN(attempted_at) AS oldest FROM dashboard_marketapp_attempts WHERE attempted_at>?", (now - 86400,)).fetchone()
        return {"used_24h": row["used"], "remaining_24h": max(0, limit - row["used"]),
                "resets_at": datetime.fromtimestamp(row["oldest"] + 86400, timezone.utc).isoformat() if row["oldest"] is not None else None}

    def marketapp_wait_seconds(self, requests_per_second, now=None):
        now = time.time() if now is None else now
        with self.connect() as connection:
            latest = connection.execute("SELECT MAX(attempted_at) FROM dashboard_marketapp_attempts").fetchone()[0]
        return max(0, latest + max(1, 1 / requests_per_second) - now) if latest is not None else 0

    def start_marketapp_budget(self, job_id, settings, worker=None):
        usage = self.marketapp_usage(settings.dashboard_daily_max_attempts)
        budget = {"invocation_used": 0, "invocation_limit": settings.dashboard_max_attempts,
                  "rolling_24h_used": usage["used_24h"], "rolling_24h_limit": settings.dashboard_daily_max_attempts,
                  "resets_at": usage["resets_at"], "run_seconds": settings.dashboard_run_seconds}
        return self._update(job_id, "marketapp_budget_json=?", (json.dumps(budget),), worker)

    def reserve_marketapp_attempt(self, job_id, invocation, attempt_limit, daily_limit, *, duration_limit=300, worker=None, now=None):
        """Reserve before transport, atomically across processes and resumes.

        A crash after reservation may conservatively consume an unused slot;
        it must never allow an uncounted request to reach the provider.
        """
        now = time.time() if now is None else now
        reason = None
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if worker is not None and not connection.execute("SELECT 1 FROM dashboard_jobs j JOIN dashboard_lease l ON l.id=1 WHERE j.id=? AND j.state='running' AND j.worker=? AND l.worker=? AND l.expires>?", (job_id, worker, worker, now)).fetchone():
                raise BudgetExceeded("Worker lease changed; resume saved work", reason="worker_lease_lost")
            row = connection.execute("SELECT stop_requested FROM dashboard_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise ValueError("Job does not exist")
            if row["stop_requested"]:
                raise BudgetExceeded("Stopped by you; resume saved work", reason="user_stopped")
            used = connection.execute("SELECT COUNT(*) FROM dashboard_marketapp_attempts WHERE invocation=?", (invocation,)).fetchone()[0]
            daily = connection.execute("SELECT COUNT(*) AS used, MIN(attempted_at) AS oldest FROM dashboard_marketapp_attempts WHERE attempted_at>?", (now - 86400,)).fetchone()
            daily_used, oldest = daily["used"], daily["oldest"]
            if daily_used >= daily_limit:
                reason = "dashboard_daily_budget"
            elif used >= attempt_limit:
                reason = "dashboard_attempt_budget"
            else:
                connection.execute("INSERT INTO dashboard_marketapp_attempts(job_id,invocation,attempted_at) VALUES (?,?,?)", (job_id, invocation, now))
                used += 1
                daily_used += 1
                oldest = now if oldest is None else oldest
            budget = {"invocation_used": used, "invocation_limit": attempt_limit,
                      "rolling_24h_used": daily_used, "rolling_24h_limit": daily_limit,
                      "resets_at": datetime.fromtimestamp(oldest + 86400, timezone.utc).isoformat() if oldest is not None else None,
                      "run_seconds": duration_limit}
            connection.execute("UPDATE dashboard_jobs SET marketapp_budget_json=? WHERE id=?", (json.dumps(budget), job_id))
        if reason:
            message = (f"Marketapp rolling 24-hour safety limit ({daily_limit} attempts) reached; resume after {budget['resets_at']}"
                       if reason == "dashboard_daily_budget" else
                       f"Marketapp refresh safety limit ({attempt_limit} attempts) reached; resume saved work manually")
            raise BudgetExceeded(message, retryable=True, reason=reason)
        return budget

    def request_stop(self, job_id):
        """Persist a user stop; an in-flight request exits through its guard."""
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self.row(connection.execute("SELECT * FROM dashboard_jobs WHERE id=?", (job_id,)).fetchone())
            if row["state"] == "queued":
                connection.execute("UPDATE dashboard_jobs SET state='partial',stop_requested=1,reason='Stopped by you; resume saved work',updated_at=? WHERE id=?", (utc_now(), job_id))
            elif row["state"] == "running" and not row["stop_requested"]:
                connection.execute("UPDATE dashboard_jobs SET stop_requested=1,updated_at=? WHERE id=?", (utc_now(), job_id))
            return self.row(connection.execute("SELECT * FROM dashboard_jobs WHERE id=?", (job_id,)).fetchone())

    def lease(self, worker, now=None):
        now = time.time() if now is None else now
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            lease = connection.execute("SELECT * FROM dashboard_lease WHERE id=1").fetchone()
            if lease and lease["worker"] != worker and lease["expires"] > now:
                return False
            if not lease or lease["worker"] != worker:
                # Committed run IDs and provider checkpoints remain intact.
                connection.execute("UPDATE dashboard_jobs SET state='partial',reason='Worker interrupted; resume committed work',updated_at=?,worker=NULL WHERE state='running'", (utc_now(),))
            connection.execute("INSERT INTO dashboard_lease VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET worker=excluded.worker,expires=excluded.expires", (worker, now + 15))
            return True

    def claim(self, worker):
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            lease = connection.execute("SELECT * FROM dashboard_lease WHERE id=1").fetchone()
            if not lease or lease["worker"] != worker or lease["expires"] <= time.time():
                return None
            row = connection.execute("SELECT * FROM dashboard_jobs WHERE state='queued' ORDER BY id LIMIT 1").fetchone()
            if row is None:
                return None
            connection.execute("UPDATE dashboard_jobs SET state='running',worker=?,updated_at=? WHERE id=?", (worker, utc_now(), row["id"]))
            value = self.row(row)
            value["state"] = "running"
            value["lease_owner"] = worker
            return value

    def owns(self, job_id, worker):
        with self.connect() as connection:
            return bool(connection.execute("SELECT 1 FROM dashboard_jobs j JOIN dashboard_lease l ON l.id=1 WHERE j.id=? AND j.state='running' AND j.worker=? AND l.worker=? AND l.expires>?", (job_id, worker, worker, time.time())).fetchone())

    def _update(self, job_id, assignments, params, worker=None):
        condition = ""
        values = (*params, job_id)
        if worker is not None:
            condition = " AND state='running' AND worker=? AND EXISTS (SELECT 1 FROM dashboard_lease WHERE id=1 AND worker=? AND expires>?)"
            values += (worker, worker, time.time())
        with self.connect() as connection:
            return connection.execute("UPDATE dashboard_jobs SET " + assignments + " WHERE id=?" + condition, values).rowcount == 1

    def link_run(self, job_id, run_id, worker=None):
        return self._update(job_id, "run_id=?,updated_at=?", (run_id, utc_now()), worker)

    def finish(self, job_id, state, reason=None, result=None, worker=None):
        if state not in {"complete", "partial", "failed"}:
            raise ValueError("Invalid job completion state")
        return self._update(job_id, "state=?,reason=?,result_json=?,updated_at=?,worker=NULL", (state, reason, json.dumps(result) if result else None, utc_now()), worker)

    def progress(self, job_id, progress, worker=None):
        return self._update(job_id, "progress_json=?,updated_at=?", (json.dumps(progress), utc_now()), worker)

    def release(self, worker):
        with self.connect() as connection:
            connection.execute("DELETE FROM dashboard_lease WHERE worker=?", (worker,))


def _sync_progress(phase, completed=0, total=None, *, unit="collections", current_collection=None, processed_items=0):
    return {"phase": phase, "completed": completed, "total": total, "unit": unit,
            "current_collection": current_collection, "processed_items": processed_items}


def _market_sync_progress(store, job, settings, streams):
    def signature(stream):
        return stream["kind"], stream["path"], json.dumps(stream.get("params", {}), sort_keys=True)

    saved = {signature(stream): stream for stream in streams}
    manifest = settings.get("streams")
    planned = manifest if isinstance(manifest, list) else streams
    work = [{**spec, "state": saved.get(signature(spec), {}).get("state", "pending")} for spec in planned]
    groups = {}
    for stream in work:
        if stream["kind"] == "collection":
            continue
        scope = stream.get("params", {}).get("collection_address")
        if scope is None and stream["kind"] == "attribute":
            path = stream["path"]
            if path.startswith("/v1/collections/") and path.endswith("/attributes/"):
                scope = unquote(path[len("/v1/collections/"):-len("/attributes/")])
        stream["scope"] = address_key(scope)
        groups.setdefault(stream["scope"], []).append(stream)
    # Unfiltered scans cannot truthfully claim a known collection denominator.
    total = None if None in groups else len(groups)
    completed = sum(all(stream["state"] == "complete" for stream in values)
                    for scope, values in groups.items() if scope is not None)
    processed = store.connection.execute("""SELECT count(*) FROM observations o JOIN pages p ON p.id=o.page_id
        JOIN streams s ON s.id=p.stream_id WHERE s.run_id=? AND s.kind IN ('listing','history')""", (job["run_id"],)).fetchone()[0]
    running = next((stream for stream in work if stream["state"] == "running"), None)
    current = running or next((stream for stream in work if stream["state"] != "complete"), None)
    if ((running is None or running["kind"] == "collection")
            and any(stream["kind"] == "collection" and stream["state"] != "complete" for stream in work)):
        return _sync_progress("preparing", total=total, processed_items=processed)
    if current is None:
        return _sync_progress("complete", completed, total, processed_items=processed)
    phase = {"listing": "listings", "history": "rentals"}.get(current["kind"], "preparing")
    name = None
    if current.get("scope") is not None:
        for row in store.connection.execute("""SELECT r.data_json FROM observations o JOIN pages p ON p.id=o.page_id
            JOIN streams s ON s.id=p.stream_id JOIN records r ON r.id=o.record_id
            WHERE s.run_id=? AND r.kind='collection' ORDER BY o.id DESC""", (job["run_id"],)):
            collection = json.loads(row[0])
            if address_key(collection.get("collection_address")) == current["scope"]:
                value = collection.get("name")
                name = value.strip() if isinstance(value, str) and value.strip() else None
                break
    return _sync_progress(phase, completed, total, current_collection=name, processed_items=processed)


def progress_for(database, job):
    if not job.get("run_id"):
        return {"sync": _sync_progress("preparing", unit="gifts" if job["kind"] in {"refresh", "discover"} else "collections")}
    with Store(database) as store:
        if job["kind"] in {"collect", "prices", "rental_prices"}:
            from .history_refresh import history_refresh_summary
            from .listing_plan import listing_refresh_summary
            streams = store.streams(job["run_id"])
            progress = {"pages": sum(row["pages"] for row in streams), "streams_complete": sum(row["state"] == "complete" for row in streams), "streams_total": len(streams)}
            settings = store.get_run(job["run_id"])["settings"]
            history = history_refresh_summary(settings)
            if history:
                progress["history_refresh"] = history
            listing = listing_refresh_summary(settings, streams)
            if listing:
                progress["listing_refresh"] = listing
            progress["sync"] = _market_sync_progress(store, job, settings, streams)
            return progress
        discovery = DiscoveryStore(store)
        run = discovery.get_run(job["run_id"])
        checkpoints = discovery.checkpoints(job["run_id"])
        counts = store.connection.execute("""SELECT count(*) AS candidates,
            coalesce(sum(verified=1),0) AS verified,coalesce(sum(state='pending'),0) AS pending,
            coalesce(sum(state='done'),0) AS checked FROM discovery_candidates WHERE run_id=?""", (job["run_id"],)).fetchone()
        fixed = run["settings"].get("mode") == "portfolio_refresh" or job["kind"] == "refresh"
        total = counts["candidates"]
        if fixed:
            seeds = {address_key(value.get("nft_address")) for value in run["settings"].get("seed_candidates", [])
                     if isinstance(value, dict) and value.get("nft_address")}
            total = max(total, len(seeds))
        enumerated = fixed or bool(checkpoints) and all(row["state"] == "complete" for row in checkpoints)
        if not run["catalog_committed"]:
            sync = _sync_progress("preparing", total=total if fixed else None, unit="gifts", processed_items=counts["checked"])
        elif not enumerated:
            sync = _sync_progress("discovering", counts["checked"], unit="gifts", processed_items=counts["checked"])
        else:
            sync = _sync_progress("complete" if counts["checked"] == total else "verifying", counts["checked"], total,
                                  unit="gifts", processed_items=counts["checked"])
        return {"pages": sum(row["pages"] for row in checkpoints), "candidates": counts["candidates"],
                "verified": counts["verified"], "pending": counts["pending"], "sync": sync}


def _checkpoint_signature(store, kind, run_id):
    """Compare committed work, excluding repeated raw verification requests."""
    if run_id is None:
        return None
    if kind in {"collect", "prices", "rental_prices"}:
        return tuple((row["id"], row["pages"], row["next_cursor"], row["state"] == "complete")
                     for row in store.streams(run_id))
    ds = DiscoveryStore(store)
    row = store.connection.execute("SELECT catalog_committed FROM discovery_runs WHERE id=?", (run_id,)).fetchone()
    return (
        row[0] if row else None,
        tuple((cp["kind"], cp["pages"], cp["state"] == "complete") for cp in ds.checkpoints(run_id)),
        tuple((candidate["nft_key"], candidate["state"]) for candidate in ds.candidates(run_id)),
    )


def execute_job(job, jobs, settings, discovery_settings, review_path=None, cancel_event=None):
    from .dashboard_view import build_dashboard

    # Validate old queued jobs as well as explicit resumes before any provider
    # request. Saved bounded windows retain their original dates when resumed.
    history_since = None
    if job["kind"] in {"rental_prices", "collect"}:
        try:
            window = validate_saved_dashboard_window(job.get("collection_window"))
        except ValueError as exc:
            return {"run_id": job.get("run_id"), "state": "partial", "reason": str(exc), "pages_committed": 0}
        start = datetime.fromisoformat(window["window_from"])
        history_since = int((start - datetime(1970, 1, 1, tzinfo=timezone.utc)).total_seconds())

    owner = job.get("lease_owner")
    invocation = uuid.uuid4().hex
    deadline = monotonic() + settings.dashboard_run_seconds
    jobs.start_marketapp_budget(job["id"], settings, owner)

    def guard(*, check_stop=True, check_budget=True):
        if owner and not jobs.owns(job["id"], owner):
            raise BudgetExceeded("Worker lease changed; resume saved work", reason="worker_lease_lost")
        if check_stop and cancel_event and cancel_event.is_set():
            raise BudgetExceeded("Dashboard stopped; resume saved work", reason="interrupted")
        if check_stop and jobs.get(job["id"])["stop_requested"]:
            raise BudgetExceeded("Stopped by you; resume saved work", reason="user_stopped")
        if check_budget and monotonic() >= deadline:
            raise BudgetExceeded("Dashboard refresh duration limit reached; resume saved work manually", reason="dashboard_time_budget")

    def interruptible_sleep(seconds):
        # Retry-After and rate-limit waits must not postpone shutdown for the
        # entire invocation budget. Lease changes are noticed within a second.
        guard()
        if seconds >= deadline - monotonic():
            raise BudgetExceeded("Provider cooldown exceeds the remaining refresh duration; resume saved work later", reason="dashboard_time_budget")
        while seconds > 0:
            guard()
            interval = min(seconds, 1)
            if cancel_event:
                cancel_event.wait(interval)
            else:
                time.sleep(interval)
            seconds -= interval
        guard()

    # Clients are recreated for each bounded batch, but pacing and incomplete
    # request retries belong to the whole job, not to an individual client.
    next_attempt = {}
    retry_failures = {}
    last_budget = None
    failure_attempts = 0

    class GuardedWait:
        def __init__(self, *args, **kwargs):
            clock = kwargs.get("monotonic", monotonic)
            delay = max(0, next_attempt.get(self.provider, clock()) - clock())
            if self.provider == "marketapp":
                delay = max(delay, jobs.marketapp_wait_seconds(kwargs.get("requests_per_second", 1)))
            if kwargs.get("not_before"):
                try:
                    when = datetime.fromisoformat(kwargs["not_before"])
                    if when.tzinfo is not None:
                        delay = max(delay, (when - datetime.now(timezone.utc)).total_seconds())
                except (TypeError, ValueError, OverflowError):
                    pass  # The underlying client validates saved timestamps.
            # Per-batch deadlines may reset, but the dashboard invocation's
            # deadline includes all cooldowns and cannot reset across batches.
            if delay > 0:
                interruptible_sleep(delay)
            kwargs["sleep"] = interruptible_sleep
            if self.provider == "marketapp":
                kwargs["requests_per_second"] = min(kwargs.get("requests_per_second", 1), 1)
            super().__init__(*args, **kwargs)
            self._deadline = min(self._deadline, self._clock() + max(0, deadline - monotonic()))
            self._next_attempt_at = max(self._next_attempt_at, next_attempt.get(self.provider, self._clock()))
            if self.provider == "marketapp":
                # HTTPX invokes this immediately before each transport attempt,
                # including retries. Reservations survive failures and crashes.
                self._client.event_hooks["request"].append(self._reserve_attempt)

        def _reserve_attempt(self, request):
            guard()
            jobs.reserve_marketapp_attempt(job["id"], invocation, settings.dashboard_max_attempts,
                                           settings.dashboard_daily_max_attempts,
                                           duration_limit=settings.dashboard_run_seconds, worker=owner)

        def _observe(self, path, params, status, body, error, retry_after_at=None):
            nonlocal failure_attempts
            # Preserve a response/cooldown arriving during Stop, but never let
            # an executor whose lease was lost publish provider observations.
            guard(check_stop=False, check_budget=False)
            key = getattr(self, "_request_key", None)
            if key is not None:
                if status is None or status in RETRY_STATUSES:
                    retry_failures[key] = retry_failures.get(key, 0) + 1
                    failure_attempts += 1
                    # ApiClient can exhaust the invocation attempt budget
                    # before its local backoff is calculated. Carry cumulative
                    # backoff across that boundary as well as Retry-After.
                    delay = 2 ** (retry_failures[key] - 1) + self._random()
                    self._next_attempt_at = max(self._next_attempt_at, self._clock() + delay)
                elif status == 200:
                    retry_failures.pop(key, None)
            return super()._observe(path, params, status, body, error, retry_after_at)

        def _wait(self, seconds):
            guard()
            if max(0, seconds) >= deadline - monotonic():
                raise BudgetExceeded("Provider wait exceeds the remaining refresh duration; resume saved work later", reason="dashboard_time_budget")
            super()._wait(seconds)
            guard()

        def get(self, path, params):
            nonlocal last_budget
            guard()
            self._request_key = (self.provider, path, json.dumps(params, sort_keys=True))
            original_retries = self._retry_attempts
            self._retry_attempts = max(1, original_retries - retry_failures.get(self._request_key, 0))
            try:
                response = super().get(path, params)
                # A valid response may commit even if its request used the
                # final moment of the budget. No following request may start.
                guard(check_budget=False)
                return response
            except BudgetExceeded as exc:
                last_budget = exc.reason
                raise
            finally:
                self._retry_attempts = original_retries
                next_attempt[self.provider] = max(next_attempt.get(self.provider, 0), self._next_attempt_at)

    class GuardedMarket(GuardedWait, ApiClient):
        provider = "marketapp"

    class GuardedTon(GuardedWait, TonClient):
        provider = "toncenter"

    with Store(settings.db_path) as store:
        wallet = job["wallet"]
        view = build_dashboard(store, wallet, review_path)
        def callback(run_id):
            if not jobs.link_run(job["id"], run_id, owner):
                guard()
        def batch(resume_id):
            if job["kind"] in {"prices", "rental_prices"}:
                collector = collect_rental_prices if job["kind"] == "rental_prices" else collect_prices
                window_options = {}
                if job["kind"] == "rental_prices":
                    window_options["history_since"] = history_since
                return collector(store, replace(settings, page_size=100), gifts=view["gifts"],
                                 resume_id=resume_id, on_run_created=callback, client_factory=GuardedMarket, **window_options)
            if job["kind"] == "collect":
                portfolio = [gift for gift in view["gifts"] if gift["is_portfolio"]]
                scopes = sorted({preferred_address(gift["collection_address"]) for gift in portfolio if gift.get("collection_address")})
                if any(not gift.get("collection_address") for gift in portfolio):
                    scopes.append(None)
                configured = replace(settings, max_collections=max(settings.max_collections, len(scopes)))
                return collect(store, configured, resume_id=resume_id, scope_manifest=scopes if resume_id is None else None, on_run_created=callback, client_factory=GuardedMarket, history_since=history_since)
            seeds = []
            if job["kind"] == "refresh":
                for gift in view["gifts"]:
                    try:
                        nft = canonical_address(gift["nft_address"])
                        collection = canonical_address(gift["collection_address"]) if gift.get("collection_address") else None
                    except ValueError:
                        continue
                    seeds.append({"nft_address": nft, "collection_address": collection, "source": "dashboard_refresh_candidate", "priority": 1 if gift["is_portfolio"] else 5})
            return discover(store, discovery_settings, settings.token, wallet=wallet, resume_id=resume_id, mode="portfolio_refresh" if job["kind"] == "refresh" else "full", seed_candidates=seeds, on_run_created=callback, ton_client_factory=GuardedTon, marketapp_client_factory=GuardedMarket)

        resume_id = job["run_id"]
        stalled = 0
        pages = 0
        previous = _checkpoint_signature(store, job["kind"], resume_id)
        while True:
            last_budget = None
            prior_failures = failure_attempts
            try:
                result = asdict(batch(resume_id))
            except BudgetExceeded as exc:
                # A persisted provider cooldown can be interrupted before its
                # client exists, outside the collector's per-request guard.
                linked = jobs.get(job["id"])["run_id"]
                is_collection = job["kind"] in {"collect", "prices", "rental_prices"}
                if linked is not None and (not owner or jobs.owns(job["id"], owner)):
                    if is_collection:
                        store.finish_run(linked, "partial", str(exc))
                    else:
                        DiscoveryStore(store).finish_run(linked, "partial", exc.reason)
                result = {"run_id" if is_collection else "discovery_run_id": linked,
                          "state": "partial", "reason": str(exc), "pages_committed": 0}
                last_budget = exc.reason
            pages += result["pages_committed"]
            result["pages_committed"] = pages
            current = jobs.get(job["id"])
            resume_id = current["run_id"]
            jobs.progress(job["id"], progress_for(settings.db_path, current), owner)
            reason = last_budget or result.get("reason")
            routine = result["state"] == "partial" and reason in {"page_limit", "attempt_budget", "time_budget", "invocation_budget"}
            if reason in {"page_limit", "attempt_budget", "time_budget", "invocation_budget"} and job["kind"] in {"collect", "prices", "rental_prices"}:
                failed = [stream for stream in store.streams(resume_id) if stream["state"] == "failed"]
                if failed:
                    result["reason"] = "stream_failure: " + (failed[0].get("reason") or "Resolve failed streams before resuming")
                    routine = False
            if not routine:
                if result.get("reason") == "user_stopped":
                    result["reason"] = "Stopped by you; resume saved work"
                return result
            try:
                guard()
                current_signature = _checkpoint_signature(store, job["kind"], resume_id)
                progressed = current_signature != previous or failure_attempts > prior_failures
                stalled = 0 if progressed else stalled + 1
                if resume_id is None or stalled >= 2:
                    result["reason"] = "No committed progress across batches; increase the request/time budgets or resolve the provider issue, then resume"
                    return result
                previous = current_signature
                # A positive, interruptible yield also prevents busy loops with
                # misconfigured subsecond budgets or already-finished scopes.
                interruptible_sleep(0.1)
            except BudgetExceeded as exc:
                result["reason"] = str(exc)
                return result


class JobWorker:
    def __init__(self, jobs: JobStore, database, execute: Callable, secrets=()):
        self.jobs, self.database, self.execute = jobs, database, execute
        self.secrets = tuple(secret for secret in secrets if secret)
        self.identity = uuid.uuid4().hex
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.run, name="dashboard-worker", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def clean(self, value):
        for secret in self.secrets:
            value = value.replace(secret, "[REDACTED]")
        return value

    def run(self):
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dashboard-collection")
        future = job = None
        try:
            while not self.stop_event.is_set() or future is not None:
                try:
                    if not self.jobs.lease(self.identity):
                        if future is not None and future.done():
                            # Another worker owns this job now. Never publish
                            # the stale executor's completion or exception.
                            future = job = None
                        time.sleep(1) if self.stop_event.is_set() else self.stop_event.wait(1)
                        continue
                    if future is not None:
                        if future.done():
                            try:
                                result = future.result()
                                # Result contains run IDs and a sanitized reason,
                                # never settings or credentials.
                                reason = self.clean(result.get("reason") or "") or None
                                result["reason"] = reason
                                self.jobs.finish(job["id"], result["state"], reason, result, self.identity)
                            except Exception as exc:
                                self.jobs.finish(job["id"], "failed", self.clean(str(exc))[:500], worker=self.identity)
                            future = job = None
                        elif job:
                            self.jobs.progress(job["id"], progress_for(self.database, self.jobs.get(job["id"])), self.identity)
                    elif not self.stop_event.is_set():
                        job = self.jobs.claim(self.identity)
                        if job:
                            future = executor.submit(self.execute, job)
                except (sqlite3.Error, OSError, ValueError):
                    # A transient local lock does not duplicate a provider run.
                    pass
                time.sleep(1) if self.stop_event.is_set() and future else self.stop_event.wait(1)
        finally:
            executor.shutdown(wait=True)
            self.jobs.release(self.identity)
