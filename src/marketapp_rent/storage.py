"""Transactional, append-only observations and user-declared portfolio membership."""

from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from .addresses import address_key, preferred_address
from .util import utc_now


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _cursor_key(cursor: str | None) -> str:
    return "head" if cursor is None else "cursor:" + cursor


_SCHEMA = """
CREATE TABLE portfolio (
    nft_address TEXT PRIMARY KEY, collection_address TEXT, label TEXT,
    declared_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE portfolio_evidence (
    id INTEGER PRIMARY KEY, nft_address TEXT NOT NULL REFERENCES portfolio(nft_address),
    collection_address TEXT, label TEXT, imported_at TEXT NOT NULL, source_path TEXT NOT NULL,
    fingerprint TEXT NOT NULL
);
CREATE TABLE runs (
    id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, scopes_json TEXT NOT NULL,
    skipped_scopes_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL, finished_at TEXT, reason TEXT
);
CREATE TABLE streams (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL, path TEXT NOT NULL, params_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', pages INTEGER NOT NULL DEFAULT 0,
    next_cursor TEXT, reason TEXT, updated_at TEXT NOT NULL,
    UNIQUE(run_id,kind,path,params_json)
);
CREATE TABLE attempts (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
    path TEXT NOT NULL, params_json TEXT NOT NULL, observed_at TEXT NOT NULL,
    status_code INTEGER, body BLOB, error TEXT, retry_after_at TEXT
);
CREATE TABLE pages (
    id INTEGER PRIMARY KEY, stream_id INTEGER NOT NULL REFERENCES streams(id),
    request_cursor TEXT, request_cursor_key TEXT NOT NULL, next_cursor TEXT,
    observed_at TEXT NOT NULL, status_code INTEGER NOT NULL, body BLOB NOT NULL,
    body_sha256 TEXT NOT NULL, UNIQUE(stream_id, request_cursor_key)
);
CREATE TABLE records (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, identity TEXT,
    fingerprint TEXT NOT NULL, source_json TEXT NOT NULL, data_json TEXT NOT NULL,
    UNIQUE(kind, fingerprint)
);
CREATE TABLE observations (
    id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id),
    item_index INTEGER NOT NULL, record_id INTEGER NOT NULL REFERENCES records(id),
    collection_address TEXT, collection_source TEXT, collection_conflict INTEGER NOT NULL DEFAULT 0,
    collection_evidence_json TEXT NOT NULL DEFAULT '{}', UNIQUE(page_id,item_index)
);
CREATE TABLE issues (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id),
    stream_id INTEGER REFERENCES streams(id), reason TEXT NOT NULL,
    message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX observations_record ON observations(record_id);
CREATE INDEX streams_run ON streams(run_id);
CREATE INDEX records_identity ON records(kind,identity);
CREATE INDEX attempts_run ON attempts(run_id);
PRAGMA user_version = 1;
"""


class Store:
    """A local SQLite store. Each page and each CSV import is a transaction."""

    def __init__(self, path: Path | str):
        self.path = Path(path) if str(path) != ":memory:" else path
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(path), timeout=30)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 30000")
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 2:
            self.connection.close()
            raise ValueError("Database is newer than this application supports")
        if version == 0:
            self.connection.executescript("BEGIN IMMEDIATE;\n" + _SCHEMA + "\nCOMMIT;")
            version = 1
        if version == 1:
            from .discovery_store import SCHEMA_V2
            try:
                self.connection.executescript("BEGIN IMMEDIATE;\n" + SCHEMA_V2 + "\nCOMMIT;")
            except Exception:
                self.connection.rollback()
                self.connection.close()
                raise

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self.connection.close()

    def import_portfolio(self, path: Path | str) -> dict[str, int]:
        """Import the whole validated CSV atomically; omitted CSV rows remain members."""
        rows: dict[str, tuple[str, dict[str, str | None]]] = {}
        originals: list[tuple[str, dict[str, str | None]]] = []
        with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fields = reader.fieldnames or []
            if "nft_address" not in fields:
                raise ValueError("Portfolio CSV requires an nft_address column")
            if len(fields) != len(set(fields)):
                raise ValueError("Portfolio CSV contains duplicate column names")
            provided = set(fields) & {"collection_address", "label"}
            for line, row in enumerate(reader, 2):
                if None in row or any(value is None for value in row.values()):
                    raise ValueError(f"Portfolio CSV row {line} has the wrong number of columns")
                address = (row["nft_address"] or "").strip()
                if not address:
                    raise ValueError(f"Portfolio CSV row {line} has a blank nft_address")
                record = {key: (row[key] or "").strip() or None for key in provided}
                key = address_key(address)
                if key in rows:
                    previous = rows[key][1]
                    if previous.get("label") != record.get("label") or address_key(previous.get("collection_address")) != address_key(record.get("collection_address")):
                        raise ValueError(f"Portfolio CSV row {line} conflicts with an earlier duplicate")
                else:
                    rows[key] = (address, record)
                originals.append((address, record))
        counts = {"inserted": 0, "updated": 0, "unchanged": 0, "total": len(rows)}
        now = utc_now()
        with self.connection:
            existing = {address_key(row["nft_address"]): row for row in self.connection.execute("SELECT * FROM portfolio ORDER BY updated_at,nft_address")}
            stored_addresses = {}
            for key, (address, supplied) in rows.items():
                old = existing.get(key)
                stored_address = old["nft_address"] if old else address
                stored_addresses[key] = stored_address
                collection = supplied.get("collection_address", old["collection_address"] if old else None)
                label = supplied.get("label", old["label"] if old else None)
                if old and address_key(old["collection_address"]) == address_key(collection) and old["label"] == label:
                    counts["unchanged"] += 1
                    continue
                if old:
                    self.connection.execute(
                        "UPDATE portfolio SET collection_address=?,label=?,updated_at=? WHERE nft_address=?",
                        (collection, label, now, stored_address),
                    )
                    counts["updated"] += 1
                else:
                    self.connection.execute("INSERT INTO portfolio VALUES (?,?,?,?,?)", (address, collection, label, now, now))
                    counts["inserted"] += 1
            # Keep every original spelling as evidence even when two aliases share membership.
            for address, supplied in originals:
                stored_address = stored_addresses[address_key(address)]
                current = self.connection.execute("SELECT * FROM portfolio WHERE nft_address=?", (stored_address,)).fetchone()
                collection = supplied.get("collection_address", current["collection_address"])
                label = supplied.get("label", current["label"])
                fingerprint = hashlib.sha256(_json([address, collection, label]).encode("utf-8")).hexdigest()
                if self.connection.execute("SELECT 1 FROM portfolio_evidence WHERE nft_address=? AND fingerprint=?", (stored_address, fingerprint)).fetchone():
                    continue
                self.connection.execute(
                    "INSERT INTO portfolio_evidence(nft_address,collection_address,label,imported_at,source_path,fingerprint,source_nft_address) VALUES (?,?,?,?,?,?,?)",
                    (stored_address, collection, label, now, str(Path(path).resolve()), fingerprint, address),
                )
        return counts

    def portfolio(self) -> list[dict[str, Any]]:
        """Effective membership, preserving declarations separately from verified TON evidence."""
        members: dict[str, dict] = {}
        for row in self.connection.execute("SELECT * FROM portfolio ORDER BY updated_at,nft_address"):
            value = dict(row)
            key = address_key(value["nft_address"])
            old = members.get(key)
            value.update(nft_key=key, membership_sources=["user_declared"],
                         address_aliases=list(old["address_aliases"]) if old else [],
                         collection_addresses=list(old["collection_addresses"]) if old else [])
            value["address_aliases"].append(value["nft_address"])
            if value["collection_address"]:
                value["collection_addresses"].append(value["collection_address"])
            members[key] = value
        for row in self.connection.execute("SELECT nft_address,source_nft_address FROM portfolio_evidence WHERE source_nft_address IS NOT NULL"):
            key = address_key(row["nft_address"])
            if key in members:
                members[key]["address_aliases"].append(row["source_nft_address"])
        for row in self.connection.execute("SELECT * FROM ton_memberships ORDER BY nft_key,wallet_address"):
            key = row["nft_key"]
            if key not in members:
                members[key] = {"nft_key": key, "nft_address": preferred_address(row["nft_address"]),
                                "collection_address": row["collection_address"], "label": row["label"],
                                "declared_at": None, "updated_at": row["last_verified_at"],
                                "membership_sources": [], "address_aliases": [], "collection_addresses": []}
            value = members[key]
            value["membership_sources"].append("ton_verified")
            value["address_aliases"].append(row["nft_address"])
            value["collection_addresses"].append(row["collection_address"])
            if "user_declared" not in value["membership_sources"] and row["label"]:
                value["label"] = row["label"]
        for value in members.values():
            for addresses in self._ton_collection_evidence(value["nft_key"]).values():
                value["collection_addresses"].extend(addresses)
            value["membership_sources"] = sorted(set(value["membership_sources"]))
            value["address_aliases"] = sorted(set(value["address_aliases"]))
            collections = {address_key(item): item for item in reversed(value["collection_addresses"])}
            value["collection_addresses"] = [collections[key] for key in sorted(collections)]
            value["collection_conflict"] = len(collections) > 1
            value["collection_address"] = next(iter(collections.values())) if len(collections) == 1 else None
        return sorted(members.values(), key=lambda value: value["nft_address"])

    def create_run(self, settings: dict, scopes: list[str | None], skipped_scopes: list[str]) -> int:
        with self.connection:
            result = self.connection.execute(
                "INSERT INTO runs(settings_json,scopes_json,skipped_scopes_json,created_at) VALUES (?,?,?,?)",
                (_json(settings), _json(scopes), _json(skipped_scopes), utc_now()),
            )
        return int(result.lastrowid)

    def get_run(self, run_id: int) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise ValueError(f"Collection run {run_id} does not exist")
        result = dict(row)
        for name in ("settings", "scopes", "skipped_scopes"):
            result[name] = json.loads(result.pop(name + "_json"))
        return result

    def runs(self) -> list[dict[str, Any]]:
        return [self.get_run(row[0]) for row in self.connection.execute("SELECT id FROM runs ORDER BY id")]

    def add_stream(self, run_id: int, kind: str, path: str, params: dict) -> int:
        with self.connection:
            self.connection.execute(
                "INSERT OR IGNORE INTO streams(run_id,kind,path,params_json,updated_at) VALUES (?,?,?,?,?)",
                (run_id, kind, path, _json(params), utc_now()),
            )
            result = self.connection.execute(
                "SELECT id FROM streams WHERE run_id=? AND kind=? AND path=? AND params_json=?",
                (run_id, kind, path, _json(params)),
            ).fetchone()[0]
        return int(result)

    def streams(self, run_id: int) -> list[dict[str, Any]]:
        result = []
        for row in self.connection.execute("SELECT * FROM streams WHERE run_id=? ORDER BY id", (run_id,)):
            item = dict(row)
            item["params"] = json.loads(item.pop("params_json"))
            result.append(item)
        return result

    def record_attempt(self, run_id: int, attempt: dict) -> None:
        with self.connection:
            self.connection.execute(
                "INSERT INTO attempts(run_id,path,params_json,observed_at,status_code,body,error,retry_after_at) VALUES (?,?,?,?,?,?,?,?)",
                (run_id, attempt["path"], _json(attempt.get("params", {})), attempt.get("observed_at", utc_now()),
                 attempt.get("status_code"), attempt.get("body"), attempt.get("error"), attempt.get("retry_after_at")),
            )

    def retry_not_before(self) -> str | None:
        """Return the durable server throttle deadline shared by all local runs."""
        return self.connection.execute("""SELECT MAX(deadline) FROM (
            SELECT MAX(retry_after_at) AS deadline FROM attempts
            UNION ALL SELECT MAX(retry_after_at) AS deadline FROM discovery_responses WHERE provider='marketapp')""").fetchone()[0]

    def collection_evidence(self, nft_address: str | None, scope: str | None = None) -> dict[str, Any]:
        """Return provenance without deciding between contradicting address evidence."""
        index = self._collection_evidence_index([nft_address])
        return self._resolve_collection_evidence(index.get(address_key(nft_address), {}), scope)

    def _collection_evidence_index(self, nft_addresses) -> dict[str, dict[str, set[str]]]:
        """Read each evidence source once for this call's requested NFT identities.

        The map is page-local, never retained on Store: the next page and every
        standalone lookup see newly committed history and membership evidence.
        Only collections for the requested keys are retained in memory.
        """
        keys = {address_key(address) for address in nft_addresses if address}
        index: dict[str, dict[str, set[str]]] = {key: {} for key in keys}
        if not keys:
            return index

        def remember(key, source, collection):
            if key in index and (collection or source == "ton_verified"):
                index[key].setdefault(source, set()).add(collection)

        for row in self.connection.execute("SELECT nft_address,collection_address FROM portfolio"):
            remember(address_key(row["nft_address"]), "portfolio_import", row["collection_address"])

        # TON tables already store canonical NFT keys and have lookup indexes.
        # Normal API pages contain at most 100 entries. Chunk only oversized
        # internal callers to stay below this SQLite connection's parameter cap.
        ordered_keys = sorted(keys)
        batch_size = self.connection.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER)
        for start in range(0, len(ordered_keys), batch_size):
            batch = ordered_keys[start:start + batch_size]
            placeholders = ",".join("?" for _ in batch)
            for row in self.connection.execute(
                f"SELECT nft_key,collection_address FROM ton_memberships WHERE nft_key IN ({placeholders})", batch,
            ):
                remember(row["nft_key"], "ton_verified", row["collection_address"])
            for source, table, column in (("ton_observed", "ownership_observations", "evidence_json"),
                                           ("ton_candidate_sources", "discovery_candidate_sources", "source_json")):
                for row in self.connection.execute(
                    f"SELECT nft_key,{column} FROM {table} WHERE nft_key IN ({placeholders})", batch,
                ):
                    remember(row["nft_key"], source, json.loads(row[column]).get("collection_address"))

        for row in self.connection.execute("SELECT identity,data_json FROM records WHERE kind='history'"):
            key = address_key(row["identity"])
            if key in index:
                remember(key, "observed_history", json.loads(row["data_json"]).get("collection_address"))
        return index

    @staticmethod
    def _resolve_collection_evidence(sources: dict[str, set[str]], scope: str | None) -> dict[str, Any]:
        """Use one provenance policy for individual lookups and page commits."""
        evidence: dict[str, Any] = {}
        if scope:
            evidence["filtered_request"] = scope
        for source in ("portfolio_import", "ton_verified", "ton_observed", "ton_candidate_sources", "observed_history"):
            values = sources.get(source)
            if values:
                evidence[source] = next(iter(values)) if source == "portfolio_import" and len(values) == 1 else sorted(values)
        addresses: dict[str, str] = {}
        for value in evidence.values():
            for candidate in value if isinstance(value, list) else [value]:
                addresses.setdefault(address_key(candidate), candidate)
        conflict = len(addresses) > 1
        address = next(iter(addresses.values())) if len(addresses) == 1 else None
        return {"collection_address": address, "collection_source": "+".join(evidence) or "unknown",
                "collection_conflict": conflict, "collection_evidence": evidence}

    def _ton_collection_evidence(self, nft_key: str) -> dict[str, list[str]]:
        """Retain source mappings and observed metadata even after confidence changes."""
        result = {}
        for name, table, column in (("ton_observed", "ownership_observations", "evidence_json"),
                                    ("ton_candidate_sources", "discovery_candidate_sources", "source_json")):
            addresses = set()
            for row in self.connection.execute(f"SELECT {column} FROM {table} WHERE nft_key=?", (nft_key,)):
                value = json.loads(row[0]).get("collection_address")
                if value:
                    addresses.add(value)
            if addresses:
                result[name] = sorted(addresses)
        return result

    def commit_page(
        self, stream_id: int, request_cursor: str | None, response: Any, parsed: Any,
        *, completion_reason: str | None = None,
    ) -> bool:
        """Commit the full provider page and an optional bounded completion together.

        A timeframe-bounded stream retains the provider's actual next cursor;
        completion must not erase evidence that older history remains available.
        """
        body = bytes(response.body)
        digest = hashlib.sha256(body).hexdigest()
        with self.connection:
            old = self.connection.execute("SELECT body_sha256 FROM pages WHERE stream_id=? AND request_cursor_key=?", (stream_id, _cursor_key(request_cursor))).fetchone()
            if old:
                if old[0] != digest:
                    raise ValueError("A committed cursor returned different content; start a fresh run")
                return False
            stream = self.connection.execute("SELECT * FROM streams WHERE id=?", (stream_id,)).fetchone()
            if stream is None:
                raise ValueError("Unknown collection stream")
            if stream["pages"] and request_cursor != stream["next_cursor"]:
                raise ValueError("Page cursor does not match the committed checkpoint")
            if stream["state"] == "complete":
                raise ValueError("Cannot append to a completed stream")
            params = json.loads(stream["params_json"])
            path_scope = None
            if stream["kind"] == "attribute" and stream["path"].startswith("/v1/collections/") and stream["path"].endswith("/attributes/"):
                encoded = stream["path"][len("/v1/collections/"):-len("/attributes/")]
                if encoded and "/" not in encoded:
                    path_scope = unquote(encoded)
            inserted = self.connection.execute(
                "INSERT INTO pages(stream_id,request_cursor,request_cursor_key,next_cursor,observed_at,status_code,body,body_sha256) VALUES (?,?,?,?,?,?,?,?)",
                (stream_id, request_cursor, _cursor_key(request_cursor), parsed.next_cursor, response.observed_at, response.status_code, body, digest),
            )
            page_id = inserted.lastrowid
            listing_evidence = self._collection_evidence_index(
                record.data.get("nft_address") for record in parsed.records if record.kind == "listing"
            )
            for index, record in enumerate(parsed.records):
                source_json = record.source_json
                if not isinstance(source_json, str):
                    source_json = _json(source_json)
                # The normalizer supplies canonical JSON, preserving missing/null and exact numeric values.
                fingerprint = hashlib.sha256(source_json.encode("utf-8")).hexdigest()
                record_inserted = self.connection.execute(
                    "INSERT OR IGNORE INTO records(kind,identity,fingerprint,source_json,data_json) VALUES (?,?,?,?,?)",
                    (record.kind, record.identity, fingerprint, source_json, _json(record.data)),
                ).rowcount
                record_id = self.connection.execute("SELECT id FROM records WHERE kind=? AND fingerprint=?", (record.kind, fingerprint)).fetchone()[0]
                if record_inserted and record.kind == "history" and listing_evidence:
                    # Preserve the previous sequential semantics even for an
                    # internal mixed-kind page: later listings see this history.
                    key = address_key(record.identity)
                    if key in listing_evidence and record.data.get("collection_address"):
                        listing_evidence[key].setdefault("observed_history", set()).add(record.data["collection_address"])
                provenance = self._resolve_collection_evidence(
                    listing_evidence.get(address_key(record.data.get("nft_address")), {}), params.get("collection_address"),
                ) if record.kind == "listing" else {
                    "collection_address": record.data.get("collection_address") or params.get("collection_address") or path_scope,
                    "collection_source": "api_record" if record.data.get("collection_address") else ("filtered_request" if params.get("collection_address") else ("request_path" if path_scope else "unknown")),
                    "collection_conflict": False, "collection_evidence": {"request_path": path_scope} if path_scope else {},
                }
                self.connection.execute(
                    "INSERT INTO observations(page_id,item_index,record_id,collection_address,collection_source,collection_conflict,collection_evidence_json) VALUES (?,?,?,?,?,?,?)",
                    (page_id, index, record_id, provenance["collection_address"], provenance["collection_source"], int(provenance["collection_conflict"]), _json(provenance["collection_evidence"])),
                )
            self.connection.execute(
                "UPDATE streams SET pages=pages+1,next_cursor=?,state=?,reason=?,updated_at=? WHERE id=?",
                (parsed.next_cursor, "complete" if parsed.next_cursor is None or completion_reason else "pending",
                 completion_reason, utc_now(), stream_id),
            )
        return True

    def set_stream_state(self, stream_id: int, state: str, reason: str | None = None) -> None:
        with self.connection:
            self.connection.execute("UPDATE streams SET state=?,reason=?,updated_at=? WHERE id=?", (state, reason, utc_now(), stream_id))

    def finish_run(self, run_id: int, state: str, reason: str | None = None) -> None:
        with self.connection:
            self.connection.execute("UPDATE runs SET state=?,reason=?,finished_at=? WHERE id=?", (state, reason, None if state == "running" else utc_now(), run_id))

    def has_cursor(self, stream_id: int, cursor: str) -> bool:
        return self.connection.execute("SELECT 1 FROM pages WHERE stream_id=? AND request_cursor_key=?", (stream_id, _cursor_key(cursor))).fetchone() is not None

    def record_issue(self, run_id: int, stream_id: int | None, reason: str, message: str) -> None:
        with self.connection:
            self.connection.execute("INSERT INTO issues(run_id,stream_id,reason,message,created_at) VALUES (?,?,?,?,?)", (run_id, stream_id, reason, message, utc_now()))

    def issues(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.connection.execute("SELECT * FROM issues ORDER BY id")]

    def records(self, kind: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM records" + (" WHERE kind=?" if kind else "") + " ORDER BY id"
        result = []
        for row in self.connection.execute(query, (kind,) if kind else ()):
            record = dict(row)
            record["data"] = json.loads(record.pop("data_json"))
            result.append(record)
        return result

    def observations(self, kind: str | None = None) -> list[dict[str, Any]]:
        query = """SELECT o.*,p.observed_at,p.stream_id,s.run_id,s.params_json,r.kind,r.identity,
            r.fingerprint,r.source_json,r.data_json FROM observations o JOIN pages p ON p.id=o.page_id
            JOIN streams s ON s.id=p.stream_id JOIN records r ON r.id=o.record_id"""
        if kind:
            query += " WHERE r.kind=?"
        result = []
        for row in self.connection.execute(query + " ORDER BY o.id", (kind,) if kind else ()):
            item = dict(row)
            for field in ("data", "params", "collection_evidence"):
                item[field] = json.loads(item.pop(field + "_json"))
            result.append(item)
        return result
