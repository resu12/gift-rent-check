"""Bounded, read-only TON contract price refresh for already known gifts.

This service owns only its ``owned_price_*`` tables in the dashboard jobs
database. It never changes discovery, portfolio membership or Marketapp data.
Each step reserves one HTTP attempt durably before releasing SQLite's lock;
the subsequent evidence commit is fenced by that reservation's lease.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

from .addresses import canonical_address
from .discovery_models import item_collection, parse_ton
from .ton_decoder import MARKETAPP_OPERATOR, decode_contract

OWNED_PRICE_LIMITS = {
    "batch_size": 50, "interval_ms": 1000, "timeout_ms": 20000,
    "lease_ms": 120000, "invocation_attempts": 60, "daily_attempts": 1000,
    "duration_ms": 120000, "retry_attempts": 3, "response_bytes": 1048576,
}
_ROUTES = {"before": "/api/v3/nft/items", "accounts": "/api/v3/accountStates", "after": "/api/v3/nft/items"}
_SUMMARY = ("id", "state", "total", "checked", "updated", "unresolved", "reason", "started_at", "completed_at")


def _address(value):
    try:
        return canonical_address(value)
    except (ValueError, TypeError):
        return None


def _iso(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec="milliseconds")


def _json(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def _lt(value):
    return isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,19})", value) is not None and int(value) < 2 ** 64


def _amount(value):
    return isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,36})", value) is not None and int(value) < 2 ** 120


class OwnedPriceService:
    """Synchronous one-request steps; suitable for FastAPI's worker threadpool.

    ``now`` is an epoch-milliseconds callback. ``targets`` returns the existing
    portfolio scope; no network discovery occurs here. Production limits can
    be reduced, but request pacing and lease safety cannot be weakened.
    """

    def __init__(self, database_path, *, wallet, targets, api_key=None,
                 transport=None, now=None, decoder=decode_contract, limits=None, cooldown=None):
        self.path = str(Path(database_path))
        self.wallet = _address(wallet)
        if wallet and self.wallet is None:
            raise ValueError("A valid mainnet TON wallet is required")
        if not callable(targets):
            raise ValueError("Portfolio targets must be provided locally")
        if cooldown is not None and not callable(cooldown):
            raise ValueError("Provider cooldown must be provided locally")
        if api_key is not None and (not isinstance(api_key, str) or any(ord(char) < 32 or ord(char) > 126 for char in api_key)):
            raise ValueError("Invalid TON API key")
        self.targets = targets
        self.cooldown = cooldown
        self.api_key = api_key.strip() if api_key else None
        self.transport, self.decoder = transport, decoder
        self.clock = now or (lambda: int(time.time() * 1000))
        self.cap = dict(OWNED_PRICE_LIMITS)
        for key, value in (limits or {}).items():
            if key not in self.cap or type(value) is not int or value <= 0 or (key not in {"interval_ms", "lease_ms"} and value > self.cap[key]):
                raise ValueError("Invalid price-refresh limit")
            self.cap[key] = value
        if self.cap["interval_ms"] < 1000 or self.cap["lease_ms"] <= self.cap["timeout_ms"]:
            raise ValueError("Unsafe price-refresh pacing")
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS owned_price_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), next_allowed_at INTEGER NOT NULL);
                INSERT OR IGNORE INTO owned_price_state VALUES(1,0);
                CREATE TABLE IF NOT EXISTS owned_price_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS owned_price_sessions (
                    session_id TEXT PRIMARY KEY, wallet TEXT, run_id INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS owned_price_attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, attempted_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS owned_price_attempt_time ON owned_price_attempts(attempted_at);
                CREATE TABLE IF NOT EXISTS owned_price_responses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
                    stage TEXT NOT NULL, observed_at TEXT NOT NULL, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS owned_price_observations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, position INTEGER NOT NULL,
                    wallet TEXT NOT NULL, nft_address TEXT NOT NULL, observed_at TEXT NOT NULL,
                    document TEXT NOT NULL, UNIQUE(run_id, position));
                CREATE INDEX IF NOT EXISTS owned_price_wallet_observation ON owned_price_observations(wallet,id);
            """)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def _transaction(self):
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def _now(self):
        value = self.clock()
        if type(value) is not int or not 0 < value <= 253402300799000:
            raise ValueError("The server clock is unavailable")
        return value

    def _save(self, db, run):
        db.execute("UPDATE owned_price_runs SET document=? WHERE id=?", (_json(run), run["id"]))

    def _load(self, db, run_id=None, *, latest=False):
        if latest:
            row = db.execute("SELECT document FROM owned_price_runs ORDER BY id DESC LIMIT 1").fetchone()
        else:
            if type(run_id) is not int or not 0 < run_id <= 2 ** 53 - 1:
                raise ValueError("Invalid price-refresh identifier")
            row = db.execute("SELECT document FROM owned_price_runs WHERE id=?", (run_id,)).fetchone()
        run = json.loads(row["document"]) if row else None
        if not latest and (run is None or run["wallet"] != self.wallet):
            raise ValueError("Unknown price-refresh run")
        return run

    @staticmethod
    def _finish(run, now, state, reason=None, keep_lease=False):
        run.update(state=state, reason=reason, completed_at=_iso(now))
        if not keep_lease:
            run.update(lease=None, lease_until=0)

    def _budget(self, db, run, now):
        if run["state"] != "running":
            return False
        # Manual discovery and this price-only refresh use the same provider.
        # Inspect its queue under the same SQLite write lock used to reserve
        # attempts; JobStore uses the reciprocal guard when enqueueing TON work.
        jobs_exist = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_jobs'").fetchone()
        if jobs_exist and db.execute("SELECT 1 FROM dashboard_jobs WHERE kind IN ('discover','refresh') AND state IN ('queued','running') LIMIT 1").fetchone():
            self._finish(run, now, "partial", "ownership_refresh_active", run["lease_until"] > now)
            return True
        if self.cooldown is not None:
            try:
                floor = self.cooldown()
                if type(floor) is not int or not 0 <= floor <= 253402300799000:
                    raise ValueError("Invalid provider cooldown")
            except Exception:
                self._finish(run, now, "partial", "provider_cooldown_unavailable", run["lease_until"] > now)
                return True
            db.execute("UPDATE owned_price_state SET next_allowed_at=MAX(next_allowed_at,?) WHERE singleton=1", (floor,))
        pace = db.execute("SELECT next_allowed_at FROM owned_price_state WHERE singleton=1").fetchone()[0]
        attempts = db.execute("SELECT COUNT(*) FROM owned_price_attempts WHERE attempted_at>?", (now - 86400000,)).fetchone()[0]
        reason = "duration_limit" if now >= run["deadline"] or pace >= run["deadline"] else "daily_limit" if attempts >= self.cap["daily_attempts"] else "invocation_limit" if run["attempts"] >= self.cap["invocation_attempts"] else None
        if reason:
            self._finish(run, now, "partial", reason, run["lease_until"] > now)
        return reason is not None

    def _project(self, db, run, now):
        summary = {key: run.get(key) for key in _SUMMARY} if run else None
        if run and run["state"] == "running" and now >= run["deadline"]:
            summary.update(state="partial", reason="duration_limit", completed_at=_iso(run["deadline"]))
        pace = db.execute("SELECT next_allowed_at FROM owned_price_state WHERE singleton=1").fetchone()[0]
        latest = self._load(db, latest=True)
        return {"run": summary, "next_allowed_at": max(pace, latest["lease_until"] if latest else 0), "server_time": now}

    def get_status(self):
        with self._db() as db:
            row = db.execute("SELECT document FROM owned_price_runs WHERE wallet IS ? ORDER BY id DESC LIMIT 1", (self.wallet,)).fetchone()
            return self._project(db, json.loads(row[0]) if row else None, self._now())

    def _scope(self):
        gifts, conflicts = {}, set()
        for row in self.targets():
            if not isinstance(row, dict):
                continue
            nft, collection = _address(row.get("nft_address")), _address(row.get("collection_address"))
            if not nft:
                continue
            if row.get("collection_conflict") or not collection:
                conflicts.add(nft)
                continue
            if row.get("is_portfolio") is False:
                continue
            previous = gifts.get(nft)
            if previous and previous["collection_address"] != collection:
                conflicts.add(nft)
            gifts[nft] = {"nft_address": nft, "collection_address": collection}
        return [gifts[nft] for nft in sorted(gifts) if nft not in conflicts]

    def start(self, session_id):
        if not isinstance(session_id, str) or re.fullmatch(r"[A-Za-z0-9._:-]{16,160}", session_id) is None:
            raise ValueError("Invalid page-session identifier")
        with self._transaction() as db:
            now = self._now()
            previous = db.execute("SELECT wallet,run_id FROM owned_price_sessions WHERE session_id=?", (session_id,)).fetchone()
            if previous:
                if previous["wallet"] != self.wallet:
                    raise ValueError("Page session belongs to another wallet")
                return self._project(db, self._load(db, previous["run_id"]), now)
            latest = self._load(db, latest=True)
            if latest and latest["state"] == "running" and now >= latest["deadline"]:
                self._finish(latest, now, "partial", "duration_limit", latest["lease_until"] > now)
                self._save(db, latest)
            if latest and (latest["state"] == "running" or latest["lease_until"] > now):
                if latest["wallet"] != self.wallet:
                    raise ValueError("A different wallet has an unfinished price request")
                run = latest
            else:
                targets = self._scope()
                now = self._now()
                run_id = db.execute("INSERT INTO owned_price_runs(wallet,document) VALUES(?,?)", (self.wallet, "{}")).lastrowid
                run = {"id": run_id, "wallet": self.wallet, "state": "running", "reason": None,
                       "total": len(targets), "checked": 0, "updated": 0, "unresolved": 0,
                       "started_at": _iso(now), "completed_at": None, "targets": targets,
                       "offset": 0, "stage": "before", "stage_attempts": 0, "pending": [],
                       "attempts": 0, "deadline": now + self.cap["duration_ms"], "lease": None, "lease_until": 0}
                if not self.wallet:
                    self._finish(run, now, "partial", "wallet_not_configured")
                elif not targets:
                    self._finish(run, now, "complete", "no_known_portfolio")
                else:
                    self._budget(db, run, now)
                self._save(db, run)
            db.execute("INSERT INTO owned_price_sessions VALUES(?,?,?)", (session_id, self.wallet, run["id"]))
            return self._project(db, run, now)

    def stop(self, run_id):
        with self._transaction() as db:
            run, now = self._load(db, run_id), self._now()
            if run["state"] == "running":
                self._finish(run, now, "partial", "stopped_by_you", run["lease_until"] > now)
                self._save(db, run)
            return self._project(db, run, now)

    def observations(self, wallet):
        identity = _address(wallet)
        if identity is None:
            return []
        with self._db() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT document FROM owned_price_observations WHERE wallet=? ORDER BY id", (identity,))]

    def _plan(self, run):
        stage = run["stage"]
        targets = run["targets"][run["offset"]:run["offset"] + self.cap["batch_size"]]
        addresses = list(dict.fromkeys(row["holding_contract"] for row in run["pending"] if not row.get("reason"))) if stage == "accounts" else [row["nft_address"] for row in targets]
        if stage not in _ROUTES or not addresses or len(addresses) > self.cap["batch_size"] or any(_address(value) != value for value in addresses):
            raise ValueError("Invalid saved price-refresh checkpoint")
        params = [("address", value) for value in addresses]
        params.append(("include_boc", "true") if stage == "accounts" else ("limit", str(self.cap["batch_size"])))
        return {"stage": stage, "targets": targets, "addresses": addresses, "params": params}

    @staticmethod
    def _nft(item, target, wallet):
        if not item:
            return {"reason": "nft_missing"}
        collection, conflict = item_collection(item)
        if conflict or collection != target["collection_address"]:
            return {"reason": conflict or "collection_mismatch"}
        holder = _address(item.get("owner_address"))
        if item.get("init") is not True or not holder or not _lt(item.get("last_transaction_lt")):
            return {"reason": "invalid_nft_state"}
        if holder == wallet:
            return {"reason": "held_directly", "observed_owner": holder, "nft_last_transaction_lt": item["last_transaction_lt"]}
        return {"holding_contract": holder, "nft_last_transaction_lt": item["last_transaction_lt"]}

    @staticmethod
    def _unresolved(row, reason):
        return {"nft_address": row["nft_address"], "collection_address": row["collection_address"], "verified": False, "reason": reason,
                **{key: row[key] for key in ("holding_contract", "observed_owner") if row.get(key)}}

    def _batch(self, db, run, rows, now):
        for index, row in enumerate(rows):
            record = {**row, "wallet_address": run["wallet"], "provider": "toncenter",
                      "observed_at": row["contract_observed_at"] if row["verified"] else _iso(now), "checked_at": _iso(now)}
            if row["verified"]:
                record.update(rechecked_at=_iso(now), currency="GRAM", price_unit="nanoGRAM/day")
            db.execute("INSERT INTO owned_price_observations(run_id,position,wallet,nft_address,observed_at,document) VALUES(?,?,?,?,?,?)",
                       (run["id"], run["offset"] + index, run["wallet"], row["nft_address"], record["observed_at"], _json(record)))
        run["checked"] += len(rows)
        run["updated"] += sum(row["verified"] is True for row in rows)
        run["unresolved"] += sum(row["verified"] is not True for row in rows)
        run.update(offset=run["offset"] + len(rows), pending=[], stage="before", stage_attempts=0)
        if run["offset"] >= run["total"]:
            self._finish(run, now, "complete")

    def _decode(self, pending, accounts, wallet, now):
        rows = []
        for row in pending:
            if row.get("reason"):
                rows.append(row)
                continue
            account = accounts.get(row["holding_contract"])
            try:
                result = {"verified": False, "reason": "account_missing"} if not account else {"verified": False, "reason": "invalid_account_state"} if not _lt(account.get("last_transaction_lt")) else self.decoder(account, row["nft_address"], wallet, _iso(now))
            except Exception:
                result = {"verified": False, "reason": "invalid_contract_data"}
            if not isinstance(result, dict):
                result = {}
            reason = result.get("reason")
            if not isinstance(reason, str) or not re.fullmatch(r"[a-z_]{1,100}", reason):
                reason = "unverified_contract"
            if result.get("verified") is True:
                reason = next((reason for invalid, reason in (
                    (result.get("rental_state") not in {"idle_rental_contract", "rented", "expired_pending_return"}, "unsupported_rental_state"),
                    (not _amount(result.get("configured_price_per_day_raw")), "invalid_configured_price"),
                    (_address(result.get("owner")) != wallet, "owner_mismatch"),
                    (_address(result.get("nft")) != row["nft_address"], "nft_mismatch"),
                    (_address(result.get("holding_contract")) != row["holding_contract"], "holder_mismatch"),
                    (_address(result.get("marketplace")) != MARKETAPP_OPERATOR, "operator_mismatch"),
                    (result.get("code_hash_verified") is not True or result.get("data_hash_verified") is not True, "unverified_contract_hashes"),
                ) if invalid), None)
            verified = result.get("verified") is True and reason is None
            evidence = {"verified": verified, "reason": "verified_contract_price" if verified else reason}
            for key in ("code_hash", "data_hash", "decoder_version", "contract_variant", "storage_layout_version", "rental_state", "account_last_transaction_lt", "code_hash_verified", "data_hash_verified", "marketplace", "role", "status", "counterpart"):
                if type(result.get(key)) in (str, bool, int) or key == "counterpart" and key in result and result[key] is None:
                    evidence[key] = result[key]
            if verified:
                evidence.update(owner=wallet, configured_price_per_day_raw=result["configured_price_per_day_raw"], contract_observed_at=_iso(now))
            rows.append({**row, "decoded": evidence})
        return rows

    def _retry_at(self, response, attempts, now):
        value = response.headers.get("Retry-After") if response is not None else None
        delay = 0
        if value:
            try:
                if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value.strip()):
                    delay = int((Decimal(value.strip()) * 1000).to_integral_value(rounding=ROUND_CEILING))
                else:
                    stamp = parsedate_to_datetime(value)
                    if stamp.tzinfo is None:
                        return None
                    delay = max(0, int(stamp.timestamp() * 1000) - now)
            except (ValueError, OverflowError, TypeError):
                return None
        result = now + max(delay, min(30000, 1000 * 2 ** (attempts - 1)))
        return result if result < 253402300799000 else None

    def step(self, run_id):
        with self._transaction() as db:
            run, began = self._load(db, run_id), self._now()
            pace = db.execute("SELECT next_allowed_at FROM owned_price_state WHERE singleton=1").fetchone()[0]
            if run["state"] != "running" or run["lease_until"] > began:
                return self._project(db, run, began)
            if self._budget(db, run, began):
                self._save(db, run)
                return self._project(db, run, began)
            # Reading the other collector's cooldown can take time and can
            # extend this deadline. Reserve against fresh values, not the
            # values from before that cross-database read.
            began = self._now()
            if began >= run["deadline"]:
                self._finish(run, began, "partial", "duration_limit")
                self._save(db, run)
                return self._project(db, run, began)
            pace = db.execute("SELECT next_allowed_at FROM owned_price_state WHERE singleton=1").fetchone()[0]
            if pace > began:
                return self._project(db, run, began)
            if run["stage_attempts"] >= self.cap["retry_attempts"]:
                self._finish(run, began, "failed", "retry_exhausted")
                self._save(db, run)
                return self._project(db, run, began)
            plan = self._plan(run)
            run.update(lease=uuid.uuid4().hex, lease_until=began + self.cap["lease_ms"], stage_attempts=run["stage_attempts"] + 1, attempts=run["attempts"] + 1)
            self._save(db, run)
            db.execute("INSERT INTO owned_price_attempts(run_id,attempted_at) VALUES(?,?)", (run_id, began))
            db.execute("UPDATE owned_price_state SET next_allowed_at=? WHERE singleton=1", (began + self.cap["interval_ms"],))
        snapshot = run
        # The SQLite commit (or a suspended worker) may have consumed the
        # remaining invocation budget. A reservation is not permission to send
        # after its deadline, and still counts if the process stops here.
        request_began = self._now()
        if request_began >= snapshot["deadline"] or request_began >= snapshot["lease_until"]:
            with self._transaction() as db:
                run = self._load(db, run_id)
                if run["lease"] == snapshot["lease"] and run["state"] == "running":
                    self._finish(run, request_began, "partial", "request_lease_expired" if request_began >= snapshot["lease_until"] else "duration_limit")
                    self._save(db, run)
                return self._project(db, run, request_began)
        response, body, failure, parsed = None, b"", None, None
        url = "https://toncenter.com" + _ROUTES[plan["stage"]]
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        timeout_ms = min(self.cap["timeout_ms"], snapshot["deadline"] - request_began, snapshot["lease_until"] - request_began)
        monotonic_started = time.monotonic()
        def expired_request():
            # HTTPX's read timeout is an inactivity limit. This additional
            # check prevents continuously arriving chunks from extending the
            # request indefinitely, including when the system clock changes.
            return self._now() - request_began >= timeout_ms or (time.monotonic() - monotonic_started) * 1000 >= timeout_ms
        try:
            with httpx.Client(transport=self.transport, timeout=timeout_ms / 1000, follow_redirects=False, trust_env=False) as client:
                with client.stream("GET", url, params=plan["params"], headers=headers) as response:
                    for chunk in response.iter_bytes():
                        if expired_request():
                            failure = "request_timeout"
                            break
                        body += chunk
                        if len(body) > self.cap["response_bytes"]:
                            body = body[:self.cap["response_bytes"] + 1]
                            break
                    if failure:
                        pass
                    elif len(body) > self.cap["response_bytes"]:
                        failure = "response_too_large"
                    elif response.is_redirect:
                        failure = "unexpected_redirect"
                    elif response.status_code == 429 or response.status_code in {500, 502, 503, 504}:
                        failure = "transient_http"
                    elif not 200 <= response.status_code < 300:
                        failure = "http_error"
        except httpx.TimeoutException:
            failure = "request_timeout"
        except (httpx.HTTPError, OSError):
            failure = "network_error"
        now = self._now()
        if expired_request():
            failure = "request_timeout"
        if not failure:
            try:
                items = parse_ton(body, "accounts" if plan["stage"] == "accounts" else "nft_items")
                parsed = {}
                for item in items:
                    identity = _address(item["address"])
                    if identity not in plan["addresses"] or identity in parsed:
                        raise ValueError("Unexpected TON identity")
                    parsed[identity] = item
            except Exception:
                failure = "invalid_response"
        retryable = failure in {"transient_http", "network_error", "request_timeout"}
        retry_at = self._retry_at(response, snapshot["stage_attempts"], now) if retryable else None
        if retryable and retry_at is None:
            retryable, failure = False, "invalid_retry_after"
        decoded = self._decode(snapshot["pending"], parsed, snapshot["wallet"], now) if not failure and plan["stage"] == "accounts" else None
        with self._transaction() as db:
            now, run = self._now(), self._load(db, run_id)
            if retry_at is not None:
                db.execute("UPDATE owned_price_state SET next_allowed_at=MAX(next_allowed_at,?) WHERE singleton=1", (retry_at,))
            truncated = len(body) > self.cap["response_bytes"]
            raw = None if truncated else body.decode("utf-8", errors="replace")
            if raw is not None and self.api_key:
                raw = raw.replace(self.api_key, "[REDACTED]")
            evidence = {"provider": "toncenter", "endpoint": _ROUTES[plan["stage"]], "addresses": plan["addresses"], "stage": plan["stage"], "status": response.status_code if response is not None else None, "failure": failure, "body": raw, "truncated": truncated, "observed_at": _iso(now)}
            db.execute("INSERT INTO owned_price_responses(run_id,stage,observed_at,document) VALUES(?,?,?,?)", (run_id, plan["stage"], _iso(now), _json(evidence)))
            if run["lease"] != snapshot["lease"]:
                return self._project(db, run, now)
            expired = now >= run["lease_until"]
            run.update(lease=None, lease_until=0)
            if run["state"] != "running":
                pass
            elif now >= run["deadline"] or expired:
                self._finish(run, now, "partial", "request_lease_expired" if expired else "duration_limit")
            elif failure:
                if retryable and run["stage_attempts"] < self.cap["retry_attempts"]:
                    run["reason"] = "retry_wait"
                    self._budget(db, run, now)
                else:
                    reason = "retry_exhausted" if retryable else failure
                    self._batch(db, run, [self._unresolved(row, reason) for row in plan["targets"]], now)
                    self._finish(run, now, "failed", reason)
            else:
                run.update(reason=None, stage_attempts=0)
                if plan["stage"] == "before":
                    run["pending"] = [{**row, **self._nft(parsed.get(row["nft_address"]), row, run["wallet"])} for row in plan["targets"]]
                    if any(not row.get("reason") for row in run["pending"]):
                        run["stage"] = "accounts"
                    else:
                        self._batch(db, run, [self._unresolved(row, row["reason"]) for row in run["pending"]], now)
                elif plan["stage"] == "accounts":
                    run.update(pending=decoded, stage="after")
                else:
                    rows = []
                    for row in run["pending"]:
                        if row.get("reason"):
                            rows.append(self._unresolved(row, row["reason"]))
                            continue
                        after = self._nft(parsed.get(row["nft_address"]), row, run["wallet"])
                        if after.get("reason"):
                            rows.append(self._unresolved(row, after["reason"]))
                        elif after["holding_contract"] != row["holding_contract"] or after["nft_last_transaction_lt"] != row["nft_last_transaction_lt"]:
                            rows.append(self._unresolved(row, "nft_changed_during_refresh"))
                        else:
                            rows.append({**self._unresolved(row, row["decoded"]["reason"]), **row["decoded"], "nft_last_transaction_lt": row["nft_last_transaction_lt"]})
                    self._batch(db, run, rows, now)
                self._budget(db, run, now)
            self._save(db, run)
            return self._project(db, run, now)
