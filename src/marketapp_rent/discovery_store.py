"""Durable TON discovery checkpoints and ownership evidence, separate from market runs."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .addresses import address_key, canonical_address
from .domain import ValidationError
from .storage import _json
from .util import utc_now


SCHEMA_V2 = """
ALTER TABLE portfolio_evidence ADD COLUMN source_nft_address TEXT;
CREATE TABLE discovery_runs (
    id INTEGER PRIMARY KEY, wallet_address TEXT NOT NULL, settings_json TEXT NOT NULL,
    catalog_json TEXT NOT NULL DEFAULT '[]', catalog_committed INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'running', reason TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE discovery_checkpoints (
    run_id INTEGER NOT NULL REFERENCES discovery_runs(id), kind TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
    pages INTEGER NOT NULL DEFAULT 0, upper_lt TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(run_id,kind)
);
CREATE TABLE discovery_responses (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES discovery_runs(id),
    provider TEXT NOT NULL, purpose TEXT NOT NULL, path TEXT NOT NULL, params_json TEXT NOT NULL,
    observed_at TEXT NOT NULL, status_code INTEGER, body BLOB, body_sha256 TEXT,
    error TEXT, retry_after_at TEXT
);
CREATE TABLE discovery_pages (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES discovery_runs(id),
    kind TEXT NOT NULL, request_json TEXT NOT NULL, response_id INTEGER NOT NULL REFERENCES discovery_responses(id),
    body_sha256 TEXT NOT NULL, next_params_json TEXT, UNIQUE(run_id,kind,request_json)
);
CREATE TABLE discovery_occurrences (
    page_id INTEGER NOT NULL REFERENCES discovery_pages(id), item_index INTEGER NOT NULL,
    source_json TEXT NOT NULL, PRIMARY KEY(page_id,item_index)
);
CREATE TABLE discovery_candidates (
    run_id INTEGER NOT NULL REFERENCES discovery_runs(id), nft_key TEXT NOT NULL,
    nft_address TEXT NOT NULL, priority INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    verified INTEGER, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(run_id,nft_key)
);
CREATE TABLE discovery_candidate_sources (
    run_id INTEGER NOT NULL, nft_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    source_json TEXT NOT NULL,
    FOREIGN KEY(run_id,nft_key) REFERENCES discovery_candidates(run_id,nft_key),
    PRIMARY KEY(run_id,nft_key,fingerprint)
);
CREATE TABLE ownership_observations (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES discovery_runs(id),
    nft_key TEXT NOT NULL, wallet_address TEXT NOT NULL, verified INTEGER NOT NULL,
    observed_at TEXT NOT NULL, evidence_json TEXT NOT NULL,
    UNIQUE(run_id,nft_key)
);
CREATE TABLE ton_memberships (
    nft_key TEXT NOT NULL, wallet_address TEXT NOT NULL, nft_address TEXT NOT NULL,
    collection_address TEXT NOT NULL, label TEXT, first_verified_at TEXT NOT NULL,
    last_verified_at TEXT NOT NULL, observation_id INTEGER NOT NULL REFERENCES ownership_observations(id),
    PRIMARY KEY(nft_key,wallet_address)
);
CREATE TABLE ownership_response_links (
    observation_id INTEGER NOT NULL REFERENCES ownership_observations(id),
    response_id INTEGER NOT NULL REFERENCES discovery_responses(id),
    PRIMARY KEY(observation_id,response_id)
);
CREATE INDEX discovery_response_provider ON discovery_responses(provider,retry_after_at);
CREATE INDEX discovery_pending ON discovery_candidates(run_id,state,priority);
CREATE INDEX discovery_sources_nft ON discovery_candidate_sources(nft_key);
CREATE INDEX ownership_observations_nft ON ownership_observations(nft_key,id);
PRAGMA user_version = 2;
"""


def _body(response: Any) -> dict:
    if isinstance(response, dict):
        result = dict(response)
    else:
        result = {name: getattr(response, name) for name in ("body", "status_code", "observed_at")}
    value = result.get("body")
    if value is not None and not isinstance(value, bytes):
        result["body"] = bytes(value) if isinstance(value, bytearray) else str(value).encode("utf-8")
    return result


class DiscoveryStore:
    """Use the parent Store connection so evidence and enrollment commit atomically."""

    def __init__(self, store):
        self.store = store
        self.connection = store.connection

    def create_run(self, wallet: str, settings: dict) -> int:
        wallet = canonical_address(wallet)
        now = utc_now()
        with self.connection:
            cursor = self.connection.execute(
                "INSERT INTO discovery_runs(wallet_address,settings_json,created_at) VALUES (?,?,?)",
                (wallet, _json(settings), now),
            )
            run_id = int(cursor.lastrowid)
            self.connection.executemany(
                "INSERT INTO discovery_checkpoints(run_id,kind,updated_at) VALUES (?,?,?)",
                [(run_id, kind, now) for kind in ("holdings", "transfers")],
            )
        return run_id

    def get_run(self, run_id: int) -> dict:
        row = self.connection.execute("SELECT * FROM discovery_runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise ValueError(f"Discovery run {run_id} does not exist")
        result = dict(row)
        for key in ("settings", "catalog"):
            result[key] = json.loads(result.pop(key + "_json"))
        result["catalog_committed"] = bool(result["catalog_committed"])
        return result

    def runs(self) -> list[dict]:
        return [self.get_run(row[0]) for row in self.connection.execute("SELECT id FROM discovery_runs ORDER BY id")]

    def finish_run(self, run_id: int, state: str, reason: str | None = None) -> None:
        with self.connection:
            self.connection.execute(
                "UPDATE discovery_runs SET state=?,reason=?,finished_at=? WHERE id=?",
                (state, reason, None if state == "running" else utc_now(), run_id),
            )

    def _response(self, run_id: int, provider: str, purpose: str, response: Any, **defaults) -> int:
        value = {**defaults, **_body(response)}
        body = value.get("body")
        digest = hashlib.sha256(body).hexdigest() if body is not None else None
        if purpose == "verification":
            prior = self.connection.execute(
                """SELECT id FROM discovery_responses WHERE run_id=? AND provider=? AND purpose=?
                AND path=? AND params_json=? AND observed_at=? AND body_sha256 IS ?""",
                (run_id, provider, purpose, value.get("path", ""), _json(value.get("params", {})),
                 value.get("observed_at"), digest),
            ).fetchone()
            if prior:
                return int(prior[0])
        cursor = self.connection.execute(
            """INSERT INTO discovery_responses(run_id,provider,purpose,path,params_json,observed_at,
               status_code,body,body_sha256,error,retry_after_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (run_id, provider, purpose, value.get("path", ""), _json(value.get("params", {})),
             value.get("observed_at", utc_now()), value.get("status_code"), body,
             digest,
             value.get("error"), value.get("retry_after_at")),
        )
        return int(cursor.lastrowid)

    def record_attempt(self, run_id: int, provider: str, attempt: dict) -> None:
        with self.connection:
            self._response(run_id, provider, "attempt", attempt)

    def retry_not_before(self, provider: str) -> str | None:
        value = self.connection.execute(
            "SELECT MAX(retry_after_at) FROM discovery_responses WHERE provider=?", (provider,),
        ).fetchone()[0]
        if provider == "marketapp":
            other = self.connection.execute("SELECT MAX(retry_after_at) FROM attempts").fetchone()[0]
            return max((v for v in (value, other) if v), default=None)
        return value

    def save_catalog(self, run_id: int, response: Any, collections: list[str]) -> None:
        normalized = sorted({canonical_address(value) for value in collections})
        with self.connection:
            run = self.get_run(run_id)
            if run["catalog_committed"]:
                previous = self.connection.execute(
                    "SELECT body FROM discovery_responses WHERE run_id=? AND purpose='catalog'", (run_id,),
                ).fetchone()
                if run["catalog"] != normalized or previous[0] != _body(response).get("body"):
                    raise ValueError("The discovery catalog is already committed; start a fresh run")
                return
            self._response(run_id, "marketapp", "catalog", response, path="/v1/collections/gifts/", params={})
            self.connection.execute(
                "UPDATE discovery_runs SET catalog_json=?,catalog_committed=1 WHERE id=?", (_json(normalized), run_id),
            )

    def checkpoints(self, run_id: int) -> list[dict]:
        result = []
        for row in self.connection.execute("SELECT * FROM discovery_checkpoints WHERE run_id=? ORDER BY kind", (run_id,)):
            value = dict(row)
            value["params"] = json.loads(value.pop("params_json"))
            result.append(value)
        return result

    def _add_candidates(self, run_id: int, candidates: list[dict]) -> None:
        now = utc_now()
        for item in candidates:
            nft = canonical_address(item["nft_address"])
            source = dict(item)
            if item.get("collection_address"):
                canonical_address(item["collection_address"])
            priority = int(item.get("priority", 10))
            self.connection.execute(
                """INSERT INTO discovery_candidates(run_id,nft_key,nft_address,priority,created_at,updated_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,nft_key) DO UPDATE SET
                priority=MIN(discovery_candidates.priority,excluded.priority)""",
                (run_id, address_key(nft), nft, priority, now, now),
            )
            source_json = _json(source)
            self.connection.execute(
                "INSERT OR IGNORE INTO discovery_candidate_sources VALUES (?,?,?,?)",
                (run_id, address_key(nft), hashlib.sha256(source_json.encode()).hexdigest(), source_json),
            )
            if len(self._candidate_collections(run_id, address_key(nft))) > 1:
                # A later enumeration page may contradict an earlier verification.
                # Preserve that observation and enrollment; current confidence is separate.
                self.connection.execute(
                    """UPDATE discovery_candidates SET verified=0,reason='collection_conflict',updated_at=?
                    WHERE run_id=? AND nft_key=? AND state='done' AND verified=1""",
                    (now, run_id, address_key(nft)),
                )

    def _candidate_collections(self, run_id: int, nft_key: str) -> set[str]:
        addresses = set()
        for row in self.connection.execute(
            "SELECT source_json FROM discovery_candidate_sources WHERE run_id=? AND nft_key=?", (run_id, nft_key),
        ):
            source = json.loads(row[0])
            if source.get("collection_address"):
                addresses.add(canonical_address(source["collection_address"]))
        latest = self.connection.execute(
            "SELECT evidence_json FROM ownership_observations WHERE nft_key=? ORDER BY id DESC LIMIT 1", (nft_key,),
        ).fetchone()
        if latest:
            collection = json.loads(latest[0]).get("collection_address")
            if collection:
                addresses.add(canonical_address(collection))
        return addresses

    def add_candidates(self, run_id: int, candidates: list[dict]) -> None:
        with self.connection:
            self._add_candidates(run_id, candidates)

    def commit_enumeration(self, run_id: int, kind: str, request_params: dict, response: Any,
                           items: list[dict], candidates: list[dict], next_params: dict | None) -> bool:
        response = _body(response)
        digest = hashlib.sha256(response["body"]).hexdigest()
        request_json = _json(request_params)
        with self.connection:
            prior = self.connection.execute(
                "SELECT body_sha256,next_params_json FROM discovery_pages WHERE run_id=? AND kind=? AND request_json=?",
                (run_id, kind, request_json),
            ).fetchone()
            next_json = _json(next_params) if next_params is not None else None
            if prior:
                if prior["body_sha256"] != digest or prior["next_params_json"] != next_json:
                    raise ValidationError("A committed discovery page returned different content; start a fresh run")
                return False
            checkpoint = self.connection.execute(
                "SELECT * FROM discovery_checkpoints WHERE run_id=? AND kind=?", (run_id, kind),
            ).fetchone()
            if checkpoint is None:
                raise ValidationError("Unknown discovery stream")
            if checkpoint["state"] == "complete":
                raise ValidationError("Cannot append to a completed discovery stream")
            if checkpoint["pages"] and checkpoint["params_json"] != request_json:
                raise ValidationError("Discovery request does not match the committed checkpoint")
            if items:
                item_json = [_json(item) for item in items]
                for previous in self.connection.execute(
                    "SELECT id FROM discovery_pages WHERE run_id=? AND kind=?", (run_id, kind),
                ):
                    old_items = [row[0] for row in self.connection.execute(
                        "SELECT source_json FROM discovery_occurrences WHERE page_id=? ORDER BY item_index", (previous[0],),
                    )]
                    if old_items == item_json:
                        raise ValidationError("Discovery pagination repeated a page without progress; start a fresh run")
            response_id = self._response(run_id, "toncenter", "enumeration", response,
                                         path="/api/v3/nft/items" if kind == "holdings" else "/api/v3/nft/transfers",
                                         params=request_params)
            page_id = self.connection.execute(
                "INSERT INTO discovery_pages(run_id,kind,request_json,response_id,body_sha256,next_params_json) VALUES (?,?,?,?,?,?)",
                (run_id, kind, request_json, response_id, digest, next_json),
            ).lastrowid
            self.connection.executemany("INSERT INTO discovery_occurrences VALUES (?,?,?)",
                                        [(page_id, index, _json(item)) for index, item in enumerate(items)])
            self._add_candidates(run_id, candidates)
            upper_lt = checkpoint["upper_lt"]
            if kind == "transfers" and not checkpoint["pages"] and items:
                logical_times = [int(item["transaction_lt"]) for item in items if item.get("transaction_lt") is not None]
                upper_lt = str(max(logical_times)) if logical_times else None
            self.connection.execute(
                "UPDATE discovery_checkpoints SET params_json=?,state=?,pages=pages+1,upper_lt=?,updated_at=? WHERE run_id=? AND kind=?",
                (next_json or "{}", "complete" if next_params is None else "pending", upper_lt, utc_now(), run_id, kind),
            )
        return True

    def candidates(self, run_id: int | None = None) -> list[dict]:
        query = "SELECT * FROM discovery_candidates" + (" WHERE run_id=?" if run_id is not None else "")
        result = []
        for row in self.connection.execute(query + " ORDER BY run_id,priority,nft_key", (run_id,) if run_id is not None else ()):
            value = dict(row)
            sources = [json.loads(source[0]) for source in self.connection.execute(
                "SELECT source_json FROM discovery_candidate_sources WHERE run_id=? AND nft_key=? ORDER BY fingerprint",
                (value["run_id"], value["nft_key"]),
            )]
            value["source_evidence"] = sources
            value["sources"] = sorted({s.get("source", "unknown") for s in sources})
            value["collection_addresses"] = sorted(self._candidate_collections(value["run_id"], value["nft_key"]))
            value["collection_conflict"] = len(value["collection_addresses"]) > 1
            value["verified"] = None if value["verified"] is None else bool(value["verified"])
            result.append(value)
        return result

    def pending(self, run_id: int, limit: int) -> list[dict]:
        return [row for row in self.candidates(run_id) if row["state"] == "pending"][:limit]

    def commit_verification(self, run_id: int, nft_address: str, evidence: dict, responses: list[dict]) -> None:
        nft_key = address_key(canonical_address(nft_address))
        run = self.get_run(run_id)
        value = dict(evidence)
        if value.get("nft_address") and address_key(value["nft_address"]) != nft_key:
            raise ValueError("Ownership evidence NFT does not match its candidate")
        if value.get("wallet_address") and canonical_address(value["wallet_address"]) != run["wallet_address"]:
            raise ValueError("Ownership evidence wallet does not match its discovery run")
        value.setdefault("nft_address", nft_address)
        value["wallet_address"] = run["wallet_address"]
        value.setdefault("observed_at", utc_now())
        verified = value.get("verified") is True
        if verified:
            collection = canonical_address(value["collection_address"])
            if not run["catalog_committed"] or collection not in run["catalog"]:
                raise ValueError("Verified enrollment requires membership in the committed catalog")
        with self.connection:
            candidate = self.connection.execute(
                "SELECT * FROM discovery_candidates WHERE run_id=? AND nft_key=?", (run_id, nft_key),
            ).fetchone()
            if candidate is None:
                raise ValueError("Unknown discovery candidate")
            prior = self.connection.execute(
                "SELECT evidence_json FROM ownership_observations WHERE run_id=? AND nft_key=?", (run_id, nft_key),
            ).fetchone()
            if prior:
                if prior[0] != _json(value):
                    raise ValueError("Verification already committed; start a fresh discovery run")
                return
            if verified and len(self._candidate_collections(run_id, nft_key) | {collection}) > 1:
                raise ValidationError("Conflicting collection evidence cannot approve portfolio enrollment")
            response_ids = [self._response(run_id, response.get("provider", "toncenter"), "verification", response)
                            for response in responses]
            observation_id = self.connection.execute(
                "INSERT INTO ownership_observations(run_id,nft_key,wallet_address,verified,observed_at,evidence_json) VALUES (?,?,?,?,?,?)",
                (run_id, nft_key, run["wallet_address"], int(verified), value["observed_at"], _json(value)),
            ).lastrowid
            self.connection.executemany("INSERT OR IGNORE INTO ownership_response_links VALUES (?,?)",
                                        [(observation_id, response_id) for response_id in response_ids])
            if verified:
                self.connection.execute(
                    """INSERT INTO ton_memberships VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(nft_key,wallet_address)
                    DO UPDATE SET collection_address=excluded.collection_address,
                    label=COALESCE(excluded.label,ton_memberships.label), last_verified_at=excluded.last_verified_at,
                    observation_id=excluded.observation_id""",
                    (nft_key, run["wallet_address"], canonical_address(nft_address), collection, value.get("label"),
                     value["observed_at"], value["observed_at"], observation_id),
                )
            self.connection.execute(
                "UPDATE discovery_candidates SET state='done',verified=?,reason=?,updated_at=? WHERE run_id=? AND nft_key=?",
                (int(verified), value.get("reason"), utc_now(), run_id, nft_key),
            )

    def ownership_observations(self) -> list[dict]:
        result = []
        for row in self.connection.execute("SELECT * FROM ownership_observations ORDER BY id"):
            value = dict(row)
            evidence = json.loads(value.pop("evidence_json"))
            result.append({**evidence, **value, "verified": bool(value["verified"])})
        return result

    def memberships(self, wallet: str | None = None) -> list[dict]:
        query = "SELECT * FROM ton_memberships" + (" WHERE wallet_address=?" if wallet else "")
        return [dict(row) for row in self.connection.execute(
            query + " ORDER BY nft_key,wallet_address", (canonical_address(wallet),) if wallet else (),
        )]
