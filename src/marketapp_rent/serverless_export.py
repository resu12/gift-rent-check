"""Prepare a private, offline seed for the Telegram dashboard; never upload it."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from .addresses import address_key
from .dashboard_view import build_dashboard
from .discovery_models import item_collection, parse_ton
from .storage import Store


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _when(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (AttributeError, ValueError):
        return None


@contextmanager
def readonly_store(path):
    """Use Store's projections without its creating/migrating constructor."""
    path = Path(path).resolve(strict=True)
    store = Store.__new__(Store)
    store.path = path
    store.connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    store.connection.row_factory = sqlite3.Row
    store.connection.execute("PRAGMA query_only=ON")
    try:
        if store.connection.execute("PRAGMA user_version").fetchone()[0] != 2:
            raise ValueError("Export requires an existing v2 database")
        # A stable read transaction includes WAL data but cannot change the source.
        store.connection.execute("BEGIN")
        yield store
    finally:
        store.close()


def prepare_records(store, *, wallet=None, review_path=None, now=None, days=90):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or type(days) is not int or not 1 <= days <= 90:
        raise ValueError("Use an aware timestamp and a 1–90 day comparison window")
    now = now.astimezone(timezone.utc)
    cutoff = now - timedelta(days=days)
    dashboard = build_dashboard(store, wallet, review_path)
    records = []
    seen = set()
    def add(kind, record, observed_at=None):
        digest = hashlib.sha256(_json(record).encode()).hexdigest()
        key = f"seed:{kind}:{digest}"
        if key not in seen:
            records.append({"kind": kind, "key": key, "observed_at": observed_at or now.isoformat(), "record": record})
            seen.add(key)
    owned = {address_key(g["nft_address"]) for g in dashboard["gifts"] if g["is_portfolio"]}
    scopes = {address_key(g["collection_address"]) for g in dashboard["gifts"] if g.get("collection_address")}
    for gift in dashboard["gifts"]:
        gift = {k: v for k, v in gift.items() if k not in {"pricing", "rental_history", "review_source_filename"}}
        add("portfolio", gift, gift.get("observed_at"))
    add("settings", {"wallet": dashboard["wallet"], "imported_at": now.isoformat(),
        "comparison_from": cutoff.isoformat(), "comparison_to": now.isoformat(),
        "ownership_refresh": "local_snapshot", "coverage_note": "Imported observations, not a live ownership scan. Saved owned-gift history may be older than the pricing window."})

    collections = defaultdict(set)
    conflicts = set()
    def collection(nft, value):
        if nft and value:
            collections[address_key(nft)].add(address_key(value))
    for member in store.portfolio():
        collection(member["nft_address"], member.get("collection_address"))
        for value in member.get("collection_addresses", []):
            collection(member["nft_address"], value)
        if member.get("collection_conflict"):
            conflicts.add(address_key(member["nft_address"]))
    relevant = set(owned) | {address_key(g["nft_address"]) for g in dashboard["gifts"]}
    included_collections = defaultdict(set)
    compacted = {}
    # Price observations retain the exact original item JSON and query provenance.
    for kind in ("listing", "history"):
        for row in store.observations(kind):
            nft = address_key(row["identity"])
            source = json.loads(row["source_json"])
            scope = row.get("collection_address") or source.get("collection_address")
            collection(nft, scope)
            for values in row.get("collection_evidence", {}).values():
                for value in values if isinstance(values, list) else [values]:
                    collection(nft, value)
            if row.get("collection_conflict"):
                conflicts.add(nft)
            when = _when(row["observed_at"])
            in_scope = scope and address_key(scope) in scopes
            if kind == "history":
                ts = source.get("ts")
                event_in_window = type(ts) is int and cutoff.timestamp() <= ts <= now.timestamp()
                include = (nft in owned or in_scope and event_in_window) and when is not None and when <= now
            else:
                # Keep future-dated latest listings as exclusion evidence. Dropping
                # them could resurrect an older price that Python rejects.
                include = (nft in relevant or in_scope) and when is not None and cutoff <= when
            if not include:
                continue
            relevant.add(nft)
            value = {key: row[key] for key in ("identity", "source_json", "observed_at", "params", "collection_address", "collection_source", "collection_conflict", "collection_evidence", "fingerprint")}
            if scope:
                included_collections[nft].add(address_key(scope))
            # The original database keeps every page occurrence. The cloud seed
            # groups exact representations while keeping all observation dates,
            # so replay weight and custom as-of windows remain unchanged.
            group_key = (kind, _json({k: v for k, v in value.items() if k != "observed_at"}))
            if group_key not in compacted:
                compacted[group_key] = {**value, "occurrence_times": [], "occurrence_count": 0}
            group = compacted[group_key]
            group["occurrence_count"] += 1
            group["occurrence_times"].append(row["observed_at"])
    for (kind, _), value in compacted.items():
        value["occurrence_times"] = sorted(set(value["occurrence_times"]), key=_when)
        value["observed_at"] = value["occurrence_times"][-1]
        add(kind, value, value["observed_at"])

    for row in store.connection.execute("SELECT nft_key,evidence_json FROM ownership_observations"):
        collection(row["nft_key"], json.loads(row["evidence_json"]).get("collection_address"))
    for row in store.connection.execute("SELECT nft_key,source_json FROM discovery_candidate_sources"):
        collection(row["nft_key"], json.loads(row["source_json"]).get("collection_address"))

    # Only structured NFT attributes are carried over, never arbitrary remote URLs
    # or complete account/contract responses. Keep old traits with their true age.
    for row in store.connection.execute("""SELECT body,observed_at FROM discovery_responses
            WHERE provider='toncenter' AND path='/api/v3/nft/items' AND status_code=200
            AND purpose IN ('enumeration','verification') ORDER BY id"""):
        when = _when(row["observed_at"])
        if when is None or when > now:
            continue
        try:
            items = parse_ton(row["body"], "nft_items")
            body = json.loads(row["body"])
        except (ValueError, TypeError):
            continue
        known = set()
        for item in items:
            nft = address_key(item["address"])
            known.add(nft)
            scope, issue = item_collection(item)
            collection(nft, scope)
            if issue:
                conflicts.add(nft)
            attrs = (item.get("content") or {}).get("attributes")
            if nft in relevant and attrs is not None:
                add("metadata", {"nft_address": nft, "collection_address": scope, "attributes": attrs,
                    "source": "TON content", "observed_at": row["observed_at"], "collection_conflict": bool(issue)}, row["observed_at"])
        metadata = body.get("metadata")
        if not isinstance(metadata, dict):
            continue
        for address, details in metadata.items():
            nft = address_key(address)
            if nft not in known or nft not in relevant or not isinstance(details, dict) or not isinstance(details.get("token_info"), list):
                continue
            for token in details["token_info"]:
                if not isinstance(token, dict) or token.get("type") != "nft_items" or token.get("valid") is False:
                    continue
                extra = token.get("extra")
                if isinstance(extra, dict) and extra.get("attributes") is not None:
                    add("metadata", {"nft_address": nft, "attributes": extra["attributes"], "source": "TON metadata", "observed_at": row["observed_at"]}, row["observed_at"])
    for nft in sorted(relevant):
        if nft in conflicts or collections[nft] != included_collections[nft]:
            add("metadata", {"nft_address": nft, "collections": sorted(collections[nft]), "collection_conflict": nft in conflicts})
    return records, {"portfolio_gifts": len(owned), "unresolved_gifts": len(dashboard["gifts"]) - len(owned),
                     "collection_scopes": len(scopes), "comparison_days": days, "comparison_from": cutoff.isoformat(),
                     "comparison_to": now.isoformat(), "records_by_kind": dict(Counter(r["kind"] for r in records))}


def validate_app_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*", value) or int(value) > 2**53 - 1:
        raise ValueError("Supply --app-id with the destination Telegram app's numeric ID")
    return value


def write_export(records, preview, directory, *, app_id, chunk_bytes=240000):
    app_id = validate_app_id(app_id)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    encoded = [_json(record) for record in records]
    digest = hashlib.sha256("\n".join(encoded).encode()).hexdigest()
    chunks, current = [], []
    for record in records:
        trial = [*current, record]
        if len(trial) > 250 or len(_json({"records": trial}).encode()) > chunk_bytes:
            if not current:
                raise ValueError("A seed record exceeds the bounded import chunk size")
            chunks.append(current)
            current = [record]
            if len(_json({"records": current}).encode()) > chunk_bytes:
                raise ValueError("A seed record exceeds the bounded import chunk size")
        else:
            current = trial
    if current:
        chunks.append(current)
    paths = []
    for index, chunk in enumerate(chunks):
        name = f"chunk-{index:05d}.json"
        payload = {"import_id": digest, "chunk_id": str(index), "records": chunk}
        (directory / name).write_text(_json(payload), encoding="utf-8")
        paths.append({"file": name, "sha256": hashlib.sha256(_json(payload).encode()).hexdigest(), "records": len(chunk)})
    manifest = {"format": "marketapp-cloud-seed-v1", "destination": f"Telegram Serverless app {app_id}", "destination_app_id": app_id,
        "dataset_sha256": digest, "records": len(records), "chunks": paths,
        "bytes": sum((directory / p["file"]).stat().st_size for p in paths), **preview,
        "contains": ["Wallet and NFT addresses, portfolio membership and unresolved candidates", "Dated ownership summaries, labels and image links", "Saved listing and rental records, traits, collection mappings and provenance"],
        "excludes": ["API tokens and bot credentials", "Raw TON account/contract state", "Complete local database and raw provider response pages", "Local filesystem paths"],
        "compaction": "Identical representations with matching provenance share one record; distinct observation times and occurrence counts are preserved. Original pages remain in the local database.",
        "uploaded": False}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--app-id", required=True, type=validate_app_id, help="Explicit destination Telegram app ID; export remains offline")
    parser.add_argument("--wallet")
    parser.add_argument("--review-directory", type=Path)
    parser.add_argument("--days", type=int, default=90)
    args = parser.parse_args(argv)
    with readonly_store(args.db) as store:
        records, preview = prepare_records(store, wallet=args.wallet, review_path=args.review_directory, days=args.days)
    manifest = write_export(records, preview, args.out, app_id=args.app_id)
    print(json.dumps({k: manifest[k] for k in ("destination_app_id", "portfolio_gifts", "unresolved_gifts", "collection_scopes", "records_by_kind", "records", "bytes", "dataset_sha256", "uploaded")}, indent=2))


if __name__ == "__main__":
    main()
