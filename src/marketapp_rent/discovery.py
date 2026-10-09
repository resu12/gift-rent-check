"""Bounded wallet enumeration and evidence-based portfolio enrollment."""
from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Callable

from .addresses import canonical_address
from .api import ApiClient, COLLECTIONS_PATH
from .discovery_models import item_collection, logical_time, parse_ton
from .discovery_store import DiscoveryStore
from .domain import ApiError, BudgetExceeded, ValidationError
from .models import parse_page
from .ton_api import TonClient, NFT_ITEMS_PATH, NFT_TRANSFERS_PATH, ACCOUNT_STATES_PATH
from .ton_decoder import DECODER_VERSION, decode_contract


@dataclass(frozen=True)
class DiscoveryResult:
    discovery_run_id: int
    state: str
    reason: str | None
    pages_committed: int


def _response(path, params, response, provider="toncenter") -> dict:
    return {"provider": provider, "path": path, "params": params,
            "body": response.body, "status_code": response.status_code, "observed_at": response.observed_at}


def _unique_items(items: list[dict], expected: set[str] | None = None) -> dict[str, dict]:
    result = {}
    for item in items:
        address = canonical_address(item["address"])
        if address in result or expected is not None and address not in expected:
            raise ValidationError("TON batch returned duplicate or unexpected addresses")
        result[address] = item
    return result


def _identity(item: dict) -> tuple:
    return (canonical_address(item["owner_address"]) if item.get("owner_address") else None,
            logical_time(item["last_transaction_lt"]) if item.get("last_transaction_lt") is not None else None,
            item_collection(item), item.get("init"))


def _verify_batch(ds, run_id, client, wallet, catalog, candidates):
    """All requests finish before approval; a crash leaves pending work intact."""
    addresses = [candidate["nft_address"] for candidate in candidates]
    params = {"address": addresses, "limit": len(addresses)}
    response = client.get(NFT_ITEMS_PATH, params)
    items = _unique_items(parse_ton(response.body, "nft_items"), set(addresses))
    responses = [_response(NFT_ITEMS_PATH, params, response)]
    evidence = {}
    rental_items = {}
    candidate_by_nft = {candidate["nft_address"]: candidate for candidate in candidates}
    for nft in addresses:
        item = items.get(nft)
        row = {"wallet_address": wallet, "nft_address": nft, "verified": False,
               "reason": "item_not_found", "observed_at": response.observed_at,
               "provider": "toncenter", "decoder_version": DECODER_VERSION,
               "rental_state": "unknown", "collection_address": None}
        evidence[nft] = row
        if item is None:
            continue
        collection, issue = item_collection(item)
        candidate_collections = candidate_by_nft[nft].get("collection_addresses", [])
        if collection and any(canonical_address(value) != collection for value in candidate_collections):
            issue = "collection_conflict"
        row["collection_evidence"] = {"candidate_sources": candidate_collections, "current_nft": collection}
        row.update(collection_address=collection, nft_observed_at=response.observed_at,
                   nft_last_transaction_lt=str(item.get("last_transaction_lt")) if item.get("last_transaction_lt") is not None else None,
                   holding_contract=canonical_address(item["owner_address"]) if item.get("owner_address") else None,
                   label=(item.get("content") or {}).get("name"))
        if not isinstance(row["label"], str):
            row["label"] = None
        if issue or collection is None:
            row["reason"] = issue or "missing_collection"
        elif collection not in catalog:
            row["reason"] = "unsupported_collection"
        elif item.get("init") is not True:
            row["reason"] = "uninitialized_or_unknown_item"
        elif row["nft_last_transaction_lt"] is None:
            row["reason"] = "missing_nft_logical_time"
        elif not row["holding_contract"]:
            row["reason"] = "missing_owner"
        elif row["holding_contract"] == wallet:
            row.update(verified=True, reason="direct_owner_match", rental_state="held_directly", ownership_type="direct", holding_contract=None)
        else:
            rental_items[nft] = item

    # Preserve independent progress even if a later contract read exhausts
    # this invocation's budget. A replay cannot enroll these rows twice.
    for nft, row in evidence.items():
        if nft not in rental_items:
            ds.commit_verification(run_id, nft, row, responses)
    contract_candidates = set(rental_items)

    # Each iteration uses fresh NFT state. Repeated movement is terminal,
    # inspectable uncertainty rather than evidence that the gift is owned.
    for check in range(2):
        if not rental_items:
            break
        holders = sorted({canonical_address(item["owner_address"]) for item in rental_items.values()
                          if canonical_address(item["owner_address"]) != wallet})
        states = {}
        if holders:
            state_params = {"address": holders, "include_boc": True}
            state_response = client.get(ACCOUNT_STATES_PATH, state_params)
            states = _unique_items(parse_ton(state_response.body, "accounts"), set(holders))
            responses.append(_response(ACCOUNT_STATES_PATH, state_params, state_response))
        recheck_params = {"address": sorted(rental_items), "limit": len(rental_items)}
        recheck_response = client.get(NFT_ITEMS_PATH, recheck_params)
        rechecked = _unique_items(parse_ton(recheck_response.body, "nft_items"), set(rental_items))
        responses.append(_response(NFT_ITEMS_PATH, recheck_params, recheck_response))
        moved = {}
        for nft, item in rental_items.items():
            row = evidence[nft]
            after = rechecked.get(nft)
            if after is None or _identity(after) != _identity(item):
                row.update(verified=False, reason="changed_during_verification", rental_state="unknown",
                           observed_at=recheck_response.observed_at)
                if check == 0 and after and after.get("owner_address"):
                    new_collection, issue = item_collection(after)
                    source_collections = candidate_by_nft[nft].get("collection_addresses", [])
                    if new_collection and any(canonical_address(value) != new_collection for value in source_collections):
                        issue = "collection_conflict"
                    if issue:
                        row.update(reason=issue, collection_address=new_collection,
                                   collection_evidence={"candidate_sources": source_collections, "current_nft": new_collection})
                    if new_collection in catalog and not issue and after.get("init") is True and after.get("last_transaction_lt") is not None:
                        moved[nft] = after
                        row.update(collection_address=new_collection,
                                   nft_last_transaction_lt=str(after["last_transaction_lt"]),
                                   nft_observed_at=recheck_response.observed_at,
                                   holding_contract=canonical_address(after["owner_address"]))
                continue
            holder = canonical_address(item["owner_address"])
            if holder == wallet:
                row.update(verified=True, reason="direct_owner_match", rental_state="held_directly",
                           ownership_type="direct", holding_contract=None,
                           observed_at=recheck_response.observed_at, nft_rechecked_at=recheck_response.observed_at)
                continue
            state = states.get(holder)
            if state is None:
                row["reason"] = "holding_account_not_found"
            else:
                row.update(decode_contract(state, nft, wallet, state_response.observed_at))
                row.update(ownership_type="rental", wallet_address=wallet, nft_address=nft,
                           holding_contract=holder, contract_observed_at=state_response.observed_at,
                           nft_rechecked_at=recheck_response.observed_at,
                           observed_at=recheck_response.observed_at,
                           rental_duration_unit="seconds", rental_until_unit="Unix seconds",
                           price_per_day_raw_unit="nanoGRAM", payment_semantics="contract terms; not received proceeds")
        rental_items = moved
    for nft in contract_candidates:
        ds.commit_verification(run_id, nft, evidence[nft], responses)


def _enumerate(ds, run_id, client, wallet, page_size, checkpoint):
    kind = checkpoint["kind"]
    params = dict(checkpoint["params"])
    if not params:
        params = {"owner_address": [wallet], "limit": page_size, "offset": 0}
        params.update({"include_on_sale": False} if kind == "holdings" else {"sort": "desc"})
    path = NFT_ITEMS_PATH if kind == "holdings" else NFT_TRANSFERS_PATH
    response = client.get(path, params)
    items = parse_ton(response.body, "nft_items" if kind == "holdings" else "nft_transfers")
    candidates = []
    if kind == "holdings":
        for item in items:
            # Owner-filter responses do not override the owner's actual value.
            candidates.append({"nft_address": canonical_address(item["address"]), "source": "holdings",
                               "collection_address": item.get("collection_address"), "priority": 10})
        next_params = {**params, "offset": params["offset"] + len(items)} if items else None
    else:
        times = [logical_time(item["transaction_lt"]) for item in items]
        if times != sorted(times, reverse=True) or times and "end_lt" in params and times[0] > int(params["end_lt"]):
            raise ValidationError("TON transfer order or logical-time boundary was violated")
        for item in items:
            involved = [canonical_address(item[key]) for key in ("old_owner", "new_owner") if item.get(key)]
            if not item["transaction_aborted"] and wallet in involved:
                candidates.append({"nft_address": canonical_address(item["nft_address"]), "source": "transfer",
                                   "collection_address": item.get("nft_collection"), "priority": 20})
        if times:
            boundary = times[-1]
            offset = times.count(boundary)
            if "end_lt" in params and boundary == int(params["end_lt"]):
                offset += params.get("offset", 0)
            next_params = {**params, "end_lt": boundary, "offset": offset}
        else:
            next_params = None
    return ds.commit_enumeration(run_id, kind, params, response, items, candidates, next_params)


def discover(store, settings, marketapp_token: str, *, wallet=None, resume_id=None,
             explicit_options=None, ton_client_factory=TonClient, marketapp_client_factory=ApiClient,
             monotonic: Callable[[], float] = time.monotonic, mode="full",
             seed_candidates=None, on_run_created=None) -> DiscoveryResult:
    """Start at the head or continue committed enumeration and verification."""
    started = monotonic()
    if mode not in {"full", "portfolio_refresh"}:
        raise ValueError("Unknown discovery mode")
    ds = DiscoveryStore(store)
    if resume_id is not None:
        run = ds.get_run(resume_id)
        wallet_value = run["wallet_address"]
        if wallet is not None and canonical_address(wallet) != wallet_value:
            raise ValueError("Cannot change wallet on resume; start a fresh discovery run")
        saved = run["settings"]
        if saved.get("mode", "full") != mode:
            raise ValueError("Cannot change discovery mode on resume; start a fresh run")
        for key in ("page_size", "batch_size"):
            if key in (explicit_options or {}) and explicit_options[key] != saved[key]:
                raise ValueError(f"Cannot change {key} on resume; start a fresh discovery run")
        if saved["decoder_version"] != DECODER_VERSION:
            raise ValueError("Decoder version changed; start a fresh discovery run")
        settings = replace(settings, page_size=saved["page_size"], batch_size=saved["batch_size"])
        run_id = resume_id
        if run["state"] == "complete":
            return DiscoveryResult(run_id, "complete", None, 0)
        if not run["catalog_committed"] and not marketapp_token:
            raise ValueError("Set MARKETAPP_API_TOKEN to acquire the discovery run's collection catalog")
    else:
        if not wallet:
            raise ValueError("Supply --wallet or MARKETAPP_OWNER_ADDRESS")
        wallet_value = canonical_address(wallet)
        if not marketapp_token:
            raise ValueError("Set MARKETAPP_API_TOKEN before starting wallet discovery")
        refresh_manifest = []
        if mode == "portfolio_refresh":
            refresh_manifest = list(seed_candidates or []) + [
                {"nft_address": member["nft_address"], "source": "previously_verified",
                 "collection_address": member["collection_address"], "priority": 0}
                for member in ds.memberships(wallet_value)
            ]
        run_id = ds.create_run(wallet_value, {"page_size": settings.page_size, "batch_size": settings.batch_size,
                                            "decoder_version": DECODER_VERSION, "mode": mode,
                                            "seed_candidates": refresh_manifest})
        run = ds.get_run(run_id)
    if on_run_created:
        on_run_created(run_id)
    if mode == "portfolio_refresh":
        # This operation checks a fixed candidate manifest. No history or
        # holdings traversal is claimed, even after all candidates finish.
        with ds.connection:
            ds.connection.execute("UPDATE discovery_checkpoints SET state='not_requested' WHERE run_id=?", (run_id,))
        ds.add_candidates(run_id, run["settings"].get("seed_candidates", []))
    # Also seed on resume: a process can stop immediately after create_run.
    # Existing completed candidates remain completed; this is idempotent.
    if mode == "full":
        ds.add_candidates(run_id, [{"nft_address": member["nft_address"], "source": "previously_verified",
                                   "collection_address": member["collection_address"], "priority": 0}
                                  for member in ds.memberships(wallet_value)])
    pages = 0
    used_attempts = 0
    ds.finish_run(run_id, "running")
    try:
        if not run["catalog_committed"]:
            with marketapp_client_factory(marketapp_token, timeout=settings.timeout,
                    requests_per_second=settings.requests_per_second, max_attempts=settings.max_attempts,
                    retry_attempts=settings.retry_attempts, run_seconds=settings.run_seconds,
                    monotonic=monotonic, not_before=ds.retry_not_before("marketapp"),
                    observer=lambda attempt: ds.record_attempt(run_id, "marketapp", attempt)) as market:
                response = market.get(COLLECTIONS_PATH, {})
                parsed = parse_page("collection", response.body)
                try:
                    catalog = sorted({canonical_address(record.data["collection_address"]) for record in parsed.records})
                except ValueError as exc:
                    raise ValidationError("Marketapp catalog contains an invalid TON collection address") from exc
                ds.save_catalog(run_id, response, catalog)
                used_attempts = market.attempts_used
        else:
            catalog = run["catalog"]
        remaining = settings.run_seconds - (monotonic() - started)
        if used_attempts >= settings.max_attempts or remaining <= 0:
            raise BudgetExceeded("Invocation budget reached", reason="invocation_budget")
        with ton_client_factory(settings.api_key, timeout=settings.timeout,
                requests_per_second=settings.requests_per_second, max_attempts=settings.max_attempts - used_attempts,
                retry_attempts=settings.retry_attempts, run_seconds=remaining,
                monotonic=monotonic, not_before=ds.retry_not_before("toncenter"),
                observer=lambda attempt: ds.record_attempt(run_id, "toncenter", attempt)) as client:
            counts = {"holdings": 0, "transfers": 0}
            while True:
                pending = ds.pending(run_id, settings.batch_size)
                if pending:
                    _verify_batch(ds, run_id, client, wallet_value, set(catalog), pending)
                eligible = [cp for cp in ds.checkpoints(run_id)
                            if mode == "full" and cp["state"] != "complete" and counts[cp["kind"]] < settings.max_pages]
                for checkpoint in eligible:
                    if _enumerate(ds, run_id, client, wallet_value, settings.page_size, checkpoint):
                        pages += 1
                    counts[checkpoint["kind"]] += 1
                if not eligible and not ds.pending(run_id, 1):
                    break
        incomplete = mode == "full" and any(cp["state"] != "complete" for cp in ds.checkpoints(run_id))
        state, reason = ("partial", "page_limit") if incomplete else ("complete", None)
    except BudgetExceeded as exc:
        state, reason = "partial", exc.reason
    except (ApiError, ValidationError) as exc:
        reason = getattr(exc, "reason", "invalid_response: " + str(exc))
        # Persist actionable schema/stalled-traversal diagnostics without keys.
        for secret in (marketapp_token, settings.api_key):
            if secret:
                reason = reason.replace(secret, "[REDACTED]")
        state = "failed"
    except KeyboardInterrupt:
        state, reason = "partial", "interrupted"
    ds.finish_run(run_id, state, reason)
    return DiscoveryResult(run_id, state, reason, pages)
