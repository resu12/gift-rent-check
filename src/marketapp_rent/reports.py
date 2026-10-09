"""Offline inspection reports; observations do not establish revenue or ownership."""

from __future__ import annotations

import csv
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from .addresses import address_key
from .discovery_store import DiscoveryStore
from .history_refresh import history_refresh_summary
from .listing_plan import listing_refresh_summary
from .storage import Store


_MONEY_FIELDS = {"price", "price_nano", "price_gram", "price_per_day_nano", "price_per_day_gram", "floor", "rent_floor"}
_OBSERVATION_FIELDS = ["record_id", "fingerprint", "run_id", "stream_id", "page_id", "item_index", "observed_at", "collection_address", "collection_source", "collection_conflict", "collection_evidence", "source_fields", "uncertainties"]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _cell(key: str, value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        value = _json(value)
    elif isinstance(value, bool):
        return "true" if value else "false"
    elif isinstance(value, Decimal):
        return format(value, "f")
    else:
        value = str(value)
    if key in _MONEY_FIELDS:
        try:
            numeric = Decimal(value)
            if numeric.is_finite():
                return format(numeric, "f")
        except InvalidOperation:
            pass
    # Prevent spreadsheet formulas in remote strings, labels and identifiers.
    if value and (value[0] in "\t\r\n" or value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


def _write(path: Path, rows: list[dict], required: list[str]) -> None:
    fields = list(dict.fromkeys(required + sorted({key for row in rows for key in row})))
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _cell(key, row.get(key)) for key in fields})


def _provenance(store: Store, observation: dict) -> dict:
    if observation["kind"] == "listing":
        return store.collection_evidence(observation["data"].get("nft_address"), observation["params"].get("collection_address"))
    return {key: observation[key] for key in ("collection_address", "collection_source", "collection_conflict", "collection_evidence")}


def _observation_row(store: Store, observation: dict) -> dict:
    row = dict(observation["data"])
    row.update({key: observation[key] for key in ("record_id", "fingerprint", "run_id", "stream_id", "page_id", "item_index", "observed_at")})
    row.update(_provenance(store, observation))
    row["source_fields"] = sorted(json.loads(observation["source_json"]))
    row["source_json"] = observation["source_json"]
    row["uncertainties"] = row.get("uncertainties", [])
    return row


def _coverage(store: Store, owner_address: str | None = None) -> list[dict]:
    listings = store.observations("listing")
    latest_by_nft: dict[str, dict] = {}
    for observation in listings:
        nft = address_key(observation["data"].get("nft_address"))
        old = latest_by_nft.get(nft)
        if old is None or (observation["observed_at"], observation["id"]) > (old["observed_at"], old["id"]):
            latest_by_nft[nft] = observation
    runs = store.runs()
    latest_run = runs[-1] if runs else None
    history_nfts = {address_key(record["data"].get("nft_address")) for record in store.records("history")}
    discovery = DiscoveryStore(store)
    latest_discovery_by_wallet = {address_key(run["wallet_address"]): run for run in discovery.runs()}
    candidates_by_run_nft = {(candidate["run_id"], address_key(candidate["nft_address"])): candidate
                             for candidate in discovery.candidates()}
    ownership_by_nft: dict[str, dict] = {}
    for evidence in discovery.ownership_observations():
        if owner_address and address_key(evidence.get("wallet_address")) != address_key(owner_address):
            continue
        key = address_key(evidence.get("nft_address"))
        old = ownership_by_nft.get(key)
        if old is None or (evidence["observed_at"], evidence["id"]) > (old["observed_at"], old["id"]):
            ownership_by_nft[key] = evidence
    result = []
    for member in store.portfolio():
        nft = member["nft_address"]
        nft_key = address_key(nft)
        observation = latest_by_nft.get(nft_key)
        provenance = store.collection_evidence(nft, observation["params"].get("collection_address") if observation else None)
        owner = observation["data"].get("owner") if observation else None
        comparison = "unverified" if not owner_address or not owner else ("match" if address_key(owner) == address_key(owner_address) else "conflict")
        seen_latest = bool(observation and latest_run and observation["run_id"] == latest_run["id"])
        sources = member.get("membership_sources", ["user_declared"])
        ownership = ownership_by_nft.get(nft_key, {})
        selected_wallet = owner_address or ownership.get("wallet_address")
        latest_discovery = latest_discovery_by_wallet.get(address_key(selected_wallet))
        seen_latest_discovery = bool(ownership and latest_discovery and ownership["run_id"] == latest_discovery["id"])
        latest_candidate = candidates_by_run_nft.get((latest_discovery["id"], nft_key), {}) if latest_discovery else {}
        candidate_conflict = latest_candidate.get("verified") is False and latest_candidate.get("reason") == "collection_conflict"
        uncertainties = ["Listing observation is not an instantaneous current-state guarantee"]
        if "user_declared" in sources:
            uncertainties.append("User-declared membership is not proof of ownership")
        if "ton_verified" in sources:
            uncertainties.append("TON membership retains earlier verification; consult the latest ownership observation")
        row = {
            "nft_address": nft, "label": member["label"], "membership": ";".join(sources),
            "membership_sources": sources,
            "declared_at": member["declared_at"], "portfolio_collection_address": member["collection_address"],
            **provenance, "current_visibility": "observed_in_latest_run" if seen_latest else "unknown",
            "last_observed_at": observation["observed_at"] if observation else None,
            "last_observed_run_id": observation["run_id"] if observation else None,
            "latest_run_id": latest_run["id"] if latest_run else None,
            "latest_run_state": latest_run["state"] if latest_run else None,
            "last_observed_owner": owner, "configured_owner": owner_address,
            "last_observed_owner_comparison": comparison,
            "price_per_day_nano": observation["data"].get("price_per_day_nano") if observation else None,
            "price_per_day_gram": observation["data"].get("price_per_day_gram") if observation else None,
            "has_portfolio_gift_history": nft_key in history_nfts,
            "ton_ownership_state": ownership.get("rental_state") if seen_latest_discovery and not candidate_conflict else "unknown",
            "ton_verified": False if candidate_conflict else (ownership.get("verified") if seen_latest_discovery else None),
            "ton_last_observed_ownership_state": ownership.get("rental_state"),
            "ton_last_observation_verified": ownership.get("verified"),
            "ton_observation_run_id": ownership.get("run_id"),
            "ton_ownership_reason": "collection_conflict" if candidate_conflict else ownership.get("reason"),
            "ton_observed_at": ownership.get("observed_at"),
            "ton_wallet_address": ownership.get("wallet_address"),
            "ton_holding_contract": ownership.get("holding_contract"),
            "uncertainties": uncertainties,
        }
        result.append(row)
    return result


def _discovery_run_rows(discovery: DiscoveryStore) -> list[dict]:
    rows = []
    for run in discovery.runs():
        candidates = discovery.candidates(run["id"])
        checkpoints = discovery.checkpoints(run["id"])
        attempts_by_provider = {row[0]: row[1] for row in discovery.connection.execute(
            "SELECT provider,COUNT(*) FROM discovery_responses WHERE run_id=? AND purpose='attempt' GROUP BY provider",
            (run["id"],),
        )}
        # Checkpoints are exported in the discovery run so the committed
        # pagination boundary remains inspectable without network access.
        streams = list(checkpoints.values()) if isinstance(checkpoints, dict) else checkpoints
        rows.append({
            **run, "candidate_count": len(candidates),
            "http_attempt_count": sum(attempts_by_provider.values()),
            "http_attempts_by_provider": attempts_by_provider,
            "pending_verification_count": sum(item["state"] == "pending" for item in candidates),
            "verified_candidate_count": sum(item.get("verified") is True for item in candidates),
            "unresolved_candidate_count": sum(_unresolved(item) for item in candidates),
            "excluded_candidate_count": sum(item.get("reason") == "unsupported_collection" for item in candidates),
            "checkpoints": streams,
            "enumeration_complete": run["settings"].get("mode", "full") == "full" and bool(streams) and all(item.get("state") == "complete" for item in streams),
            "operation": run["settings"].get("mode", "full"),
            "coverage_note": "Indexed enumeration is not an instantaneous or guaranteed exhaustive ownership snapshot",
        })
    return rows


def _unresolved(candidate: dict) -> bool:
    return candidate["state"] == "done" and candidate.get("verified") is not True and candidate.get("reason") != "unsupported_collection"


def status(store: Store) -> dict[str, Any]:
    """Summarize local progress without constructing an API client."""
    coverage = _coverage(store)
    runs = store.runs()
    streams = [stream for run in runs for stream in store.streams(run["id"])]
    discovery = DiscoveryStore(store)
    discovery_runs = _discovery_run_rows(discovery)
    candidates = discovery.candidates()
    return {
        "portfolio_count": len(coverage), "run_count": len(runs),
        "latest_run": runs[-1] if runs else None,
        "unresolved_gifts": [row["nft_address"] for row in coverage if not row["collection_address"] or row["last_observed_at"] is None],
        "unknown_current_visibility": [row["nft_address"] for row in coverage if row["current_visibility"] == "unknown"],
        "unknown_current_ton_ownership": [row["nft_address"] for row in coverage if row["ton_ownership_state"] == "unknown"],
        "collection_conflicts": [row["nft_address"] for row in coverage if row["collection_conflict"]],
        "resumable_runs": sorted({stream["run_id"] for stream in streams if stream["state"] != "complete"}),
        "streams": streams, "errors": store.issues(),
        "discovery_run_count": len(discovery_runs),
        "discovery_runs": discovery_runs,
        "latest_discovery_run": discovery_runs[-1] if discovery_runs else None,
        "resumable_discovery_runs": [run["id"] for run in discovery_runs if run["state"] != "complete"],
        "pending_discovery_verifications": [candidate for candidate in candidates if candidate["state"] == "pending"],
        "unresolved_discovery_candidates": [candidate for candidate in candidates if _unresolved(candidate)],
        "coverage_note": "Completed traversals contain observations at different times; missing gifts have unknown current state.",
    }


def export_reports(store: Store, out: Path, owner_address: str | None = None) -> list[Path]:
    """Export evidence-oriented CSVs from local storage. All monetary cells are exact."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    portfolio = {address_key(member["nft_address"]) for member in store.portfolio()}
    discovery = DiscoveryStore(store)
    rows: dict[str, list[dict]] = {
        "portfolio_coverage": _coverage(store, owner_address),
        "listing_observations": [], "history_records": [], "history_occurrences": [],
        "collections": [], "attributes": [], "run_status": [], "stream_status": [], "issues": store.issues(),
        "discovery_runs": _discovery_run_rows(discovery),
        "discovery_candidates": discovery.candidates(),
        "ownership_observations": discovery.ownership_observations(),
    }
    history: dict[int, dict] = {}
    for observation in store.observations():
        row = _observation_row(store, observation)
        kind = observation["kind"]
        if kind == "listing":
            row["portfolio_member"] = address_key(row.get("nft_address")) in portfolio
            row["price_unit"] = "GRAM; source price_per_day is nanoGRAM"
            row["discount_semantics"] = "unspecified"
            rows["listing_observations"].append(row)
        elif kind == "history":
            row["portfolio_member"] = address_key(row.get("nft_address")) in portfolio
            row["history_classification"] = "portfolio gift history" if row["portfolio_member"] else "market gift history"
            row["timestamp_unit"] = "unspecified"
            row["duration_unit"] = "unspecified"
            row["src_dst_roles"] = "unspecified"
            row["gross_net_semantics"] = "unspecified"
            row["event_identity"] = "canonical content fingerprint; transaction hash is linkage only"
            rows["history_occurrences"].append(row)
            existing = history.get(row["record_id"])
            if existing is None:
                existing = {**row, "occurrence_count": 0, "first_observed_at": row["observed_at"], "last_observed_at": row["observed_at"], "observed_run_ids": []}
                history[row["record_id"]] = existing
            existing["occurrence_count"] += 1
            existing["first_observed_at"] = min(existing["first_observed_at"], row["observed_at"])
            existing["last_observed_at"] = max(existing["last_observed_at"], row["observed_at"])
            if row["run_id"] not in existing["observed_run_ids"]:
                existing["observed_run_ids"].append(row["run_id"])
        elif kind in ("collection", "attribute"):
            row["rental_floor_unit"] = "unspecified"
            rows["collections" if kind == "collection" else "attributes"].append(row)
    rows["history_records"] = list(history.values())
    for run in store.runs():
        streams = store.streams(run["id"])
        attempts = store.connection.execute("SELECT COUNT(*) FROM attempts WHERE run_id=?", (run["id"],)).fetchone()[0]
        coverage_note = "Traversal completion is not an instantaneous market snapshot"
        if run["settings"].get("history_since") is not None:
            coverage_note += "; history traversal is scoped to its saved lower time boundary, not lifetime history"
        history_refresh = history_refresh_summary(run["settings"])
        if history_refresh and history_refresh["incremental_streams"]:
            coverage_note += "; incremental history rereads recent overlap and reuses older completed coverage; older corrections may await a full scan"
        listing_refresh = listing_refresh_summary(run["settings"], streams)
        if listing_refresh and listing_refresh["reused_streams"]:
            coverage_note += f"; {listing_refresh['reused_streams']} listing groups reuse completed broader streams from this run with original observations"
        rows["run_status"].append({**run, "stream_count": len(streams), "complete_stream_count": sum(s["state"] == "complete" for s in streams), "http_attempt_count": attempts, "coverage_note": coverage_note})
        rows["stream_status"].extend(streams)
    required = {
        "portfolio_coverage": ["nft_address", "label", "membership", "membership_sources", "collection_address", "collection_source", "collection_conflict", "current_visibility", "last_observed_at", "last_observed_owner_comparison", "ton_ownership_state", "ton_verified", "ton_observed_at", "ton_wallet_address"],
        "listing_observations": ["nft_address", "owner", "price_per_day_nano", "price_per_day_gram", "portfolio_member"] + _OBSERVATION_FIELDS,
        "history_records": ["nft_address", "history_classification", "currency", "price", "price_nano", "price_gram", "amounts_consistent", "tx_hash", "occurrence_count", "first_observed_at", "last_observed_at"] + _OBSERVATION_FIELDS,
        "history_occurrences": ["nft_address", "history_classification", "currency", "price", "price_nano", "price_gram"] + _OBSERVATION_FIELDS,
        "collections": ["collection_address", "name", "rental_floor_unit"] + _OBSERVATION_FIELDS,
        "attributes": ["collection_address", "trait_type", "value", "count", "perc", "floor", "rent_floor", "rental_floor_unit"] + _OBSERVATION_FIELDS,
        "run_status": ["id", "state", "created_at", "finished_at", "reason", "scopes", "skipped_scopes"],
        "stream_status": ["id", "run_id", "kind", "state", "pages", "next_cursor", "reason"],
        "issues": ["id", "run_id", "stream_id", "reason", "message", "created_at"],
        "discovery_runs": ["id", "wallet_address", "state", "reason", "created_at", "finished_at", "catalog_committed", "enumeration_complete", "candidate_count", "pending_verification_count", "verified_candidate_count", "unresolved_candidate_count", "excluded_candidate_count", "http_attempt_count", "http_attempts_by_provider", "checkpoints", "coverage_note"],
        "discovery_candidates": ["run_id", "nft_address", "state", "sources", "collection_addresses", "verified", "reason", "created_at", "updated_at"],
        "ownership_observations": ["id", "run_id", "wallet_address", "nft_address", "collection_address", "verified", "reason", "rental_state", "holding_contract", "code_hash", "data_hash", "decoder_version", "observed_at", "rental_duration", "rental_duration_unit", "rental_until", "rental_until_unit", "price_per_day_raw", "price_per_day_raw_unit", "payment_semantics"],
    }
    paths = []
    for name, content in rows.items():
        path = out / (name + ".csv")
        _write(path, content, required[name])
        paths.append(path)
    return paths
