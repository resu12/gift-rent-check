"""Bounded collection orchestration with immutable traversal parameters."""

import logging
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote

from . import history_refresh
from .api import ApiClient
from .addresses import address_key, canonical_address, preferred_address
from .config import Settings
from .domain import ApiError, AuthError, BudgetExceeded, ValidationError
from .history_refresh import (ORDER_UNVERIFIED, SCOPE_UNVERIFIED, build_history_refresh_plan,
                              stream_cutoff, stream_refresh_mode, validate_saved_plan)
from .models import parse_page
from .storage import Store

logger = logging.getLogger(__name__)

_TIMEFRAME_UNVERIFIED = ORDER_UNVERIFIED


def _valid_history_timestamp(value: Any) -> bool:
    """Apply the same Unix-second interpretation as local rental pricing."""
    if type(value) is not int or value <= 0:
        return False
    try:
        datetime.fromtimestamp(value, timezone.utc)
    except (ValueError, OverflowError, OSError):
        return False
    return True


def _history_window_complete(
    store: Store, run_id: int, stream_id: int, parsed: Any, since: int, collection: str | None = None,
    *, maximum_timestamp: int | None = None,
) -> bool:
    """Stop only after an ordered, interpretable page passes the inclusive cutoff.

    Empty pages can have continuations. An ordering or timestamp anomaly
    disables the shortcut for the rest of this stream, including after resume.
    The normal HTTP and run budgets continue to bound that conservative scan.
    """
    if not parsed.records or store.connection.execute(
        "SELECT 1 FROM issues WHERE stream_id=? AND reason IN (?,?) LIMIT 1",
        (stream_id, _TIMEFRAME_UNVERIFIED, SCOPE_UNVERIFIED),
    ).fetchone():
        return False
    if collection is not None and any(address_key(record.data.get("collection_address")) != address_key(collection)
                                      for record in parsed.records):
        store.record_issue(run_id, stream_id, SCOPE_UNVERIFIED,
                           "History includes an incompatible collection identity; timeframe stopping and history reuse are disabled.")
        return False
    timestamps = [record.data.get("ts") for record in parsed.records]
    previous = store.connection.execute("""SELECT r.data_json FROM observations o
        JOIN pages p ON p.id=o.page_id JOIN records r ON r.id=o.record_id
        WHERE p.stream_id=? ORDER BY p.id DESC,o.item_index DESC LIMIT 1""", (stream_id,)).fetchone()
    previous_ts = json.loads(previous[0]).get("ts") if previous else None
    valid = all(_valid_history_timestamp(value) and (maximum_timestamp is None or value <= maximum_timestamp)
                for value in timestamps)
    ordered = valid and all(left >= right for left, right in zip(timestamps, timestamps[1:]))
    if previous is not None:
        ordered = ordered and _valid_history_timestamp(previous_ts) and previous_ts >= timestamps[0]
    if not ordered:
        store.record_issue(run_id, stream_id, _TIMEFRAME_UNVERIFIED,
                           "History timestamps are invalid, in the future, or not newest first; timeframe stopping is disabled for this stream.")
        return False
    return timestamps[-1] < since


def _scopes(addresses: list[str]) -> list[str]:
    """Deduplicate friendly/raw spellings while keeping legacy opaque identifiers."""
    keyed = {address_key(address.strip()): preferred_address(address.strip()) for address in addresses}
    return [keyed[key] for key in sorted(keyed)]


def _scope_keys(addresses: list[str] | None) -> list[str] | None:
    return sorted({address_key(address.strip()) for address in addresses}) if addresses is not None else None


def _manifest_scopes(manifest: list[str | None]) -> list[str | None]:
    """An explicit wallet scope: None means unfiltered; an empty list means none."""
    if not isinstance(manifest, list) or any(
        address is not None and (not isinstance(address, str) or not address.strip())
        for address in manifest
    ):
        raise ValueError("Scope manifest must contain nonempty collection addresses or null")
    scopes: list[str | None] = _scopes([address for address in manifest if address is not None])
    if None in manifest:
        scopes.append(None)
    return scopes


def _manifest_keys(manifest: list[str | None] | None) -> list[str | None] | None:
    if manifest is None:
        return None
    return [address_key(address) if address is not None else None for address in _manifest_scopes(manifest)]


def _comparison_targets(targets: list[dict]) -> list[dict]:
    """Validate exact cohort filters and retain their first requested order."""
    if not isinstance(targets, list):
        raise ValueError("Comparison targets must be a list")
    result, seen = [], set()
    for target in targets:
        if not isinstance(target, dict) or not set(target) <= {"collection_address", "model", "backdrop"}:
            raise ValueError("Comparison targets support only collection_address, model, and backdrop")
        collection = target.get("collection_address")
        if not isinstance(collection, str) or not collection.strip():
            raise ValueError("Comparison targets require a collection address")
        canonical = canonical_address(collection.strip())
        normalized = {"collection_address": preferred_address(canonical)}
        for field in ("model", "backdrop"):
            if field in target:
                if not isinstance(target[field], str) or not target[field].strip():
                    raise ValueError("Comparison model and backdrop filters must be nonempty strings")
                normalized[field] = target[field]
        key = (canonical, normalized.get("model"), normalized.get("backdrop"))
        if key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def _comparison_keys(targets: list[dict] | None) -> list[tuple] | None:
    if targets is None:
        return None
    return sorted((canonical_address(target["collection_address"]), target.get("model", ""), target.get("backdrop", ""))
                  for target in _comparison_targets(targets))


def _rental_targets(targets: list[str]) -> list[str]:
    """History accepts collection scopes, never listing-only trait filters."""
    if not isinstance(targets, list) or any(not isinstance(target, str) or not target.strip() for target in targets):
        raise ValueError("Rental targets must be a list of nonempty collection addresses")
    return [preferred_address(address) for address in sorted({canonical_address(target.strip()) for target in targets})]


def _rental_keys(targets: list[str] | None) -> list[str] | None:
    return sorted(canonical_address(target) for target in _rental_targets(targets)) if targets is not None else None


@dataclass(frozen=True)
class CollectionResult:
    run_id: int
    state: str
    reason: str | None
    pages_committed: int


def select_scopes(
    store: Store, maximum: int, explicit: list[str] | None,
    *, scope_manifest: list[str | None] | None = None,
) -> tuple[list, list]:
    if explicit is not None and scope_manifest is not None:
        raise ValueError("Scope manifest and collection addresses are mutually exclusive")
    if scope_manifest is not None:
        candidates = _manifest_scopes(scope_manifest)
    elif explicit is not None:
        if not explicit or any(not address.strip() for address in explicit):
            raise ValueError("Collection addresses cannot be blank")
        candidates = _scopes(explicit)
    else:
        portfolio = store.portfolio()
        candidates = _scopes([row["collection_address"] for row in portfolio if row.get("collection_address")])
        if not portfolio or any(not row.get("collection_address") for row in portfolio):
            candidates.append(None)
    return candidates[:maximum], [scope or "<unfiltered>" for scope in candidates[maximum:]]


def collect(
    store: Store, settings: Settings, *, resume_id: int | None = None,
    collection_addresses: list[str] | None = None,
    scope_manifest: list[str | None] | None = None,
    comparison_targets: list[dict] | None = None,
    rental_targets: list[str] | None = None,
    history_since: int | None = None,
    model: str | None = None, symbol: str | None = None, backdrop: str | None = None,
    explicit_stream_options: dict[str, Any] | None = None,
    client_factory: Callable[..., ApiClient] = ApiClient,
    on_run_created: Callable[[int], None] | None = None,
) -> CollectionResult:
    if not settings.token:
        raise ValueError("Set MARKETAPP_API_TOKEN in your local .env before collecting")
    if history_since is not None and not _valid_history_timestamp(history_since):
        raise ValueError("History cutoff must be a positive Unix timestamp in seconds")
    if resume_id is None and history_since is not None and settings.order_by != "new_to_old":
        raise ValueError("A history cutoff requires new_to_old ordering")
    if rental_targets is not None:
        if (collection_addresses is not None or scope_manifest is not None or comparison_targets is not None
                or any(value is not None for value in (model, symbol, backdrop))):
            raise ValueError("Rental targets are mutually exclusive with other collection scopes and trait filters")
        rental_targets = _rental_targets(rental_targets)
    if comparison_targets is not None:
        if collection_addresses is not None or scope_manifest is not None or any(value is not None for value in (model, symbol, backdrop)):
            raise ValueError("Comparison targets are mutually exclusive with collection scopes and global trait filters")
        comparison_targets = _comparison_targets(comparison_targets)
    if collection_addresses is not None and scope_manifest is not None:
        raise ValueError("Scope manifest and collection addresses are mutually exclusive")
    if scope_manifest is not None:
        scope_manifest = _manifest_scopes(scope_manifest)
    if collection_addresses is not None:
        if any(not address.strip() for address in collection_addresses):
            raise ValueError("Collection addresses cannot be blank")
        collection_addresses = _scopes(collection_addresses)
    filters = {key: value for key, value in {"model": model, "symbol": symbol, "backdrop": backdrop}.items() if value is not None}
    stream_settings = {
        "page_size": settings.page_size, "sort_by": settings.sort_by,
        "order_by": settings.order_by, **filters,
        "requested_collections": sorted(set(collection_addresses)) if collection_addresses is not None else None,
        "requested_scope_manifest": scope_manifest,
    }
    if comparison_targets is not None:
        stream_settings.update(mode="pricing", requested_comparison_targets=comparison_targets)
    if rental_targets is not None:
        stream_settings.update(mode="rental_pricing", requested_rental_targets=rental_targets)
    if history_since is not None:
        stream_settings.update(history_since=history_since, history_timestamp_semantics="marketapp-rent-history-ui-v1")
    if resume_id is not None:
        run = store.get_run(resume_id)
        saved = run["settings"]
        validate_saved_plan(saved)
        if history_since is not None and saved.get("history_since") != history_since:
            raise ValueError("Cannot change history cutoff on resume; start a fresh collection")
        history_since = saved.get("history_since")
        for key, value in (explicit_stream_options or {}).items():
            if key == "requested_rental_targets":
                if _rental_keys(saved.get(key)) != _rental_keys(value):
                    raise ValueError(f"Cannot change {key} on resume; start a fresh collection")
                continue
            if key == "requested_comparison_targets":
                if _comparison_keys(saved.get(key)) != _comparison_keys(value):
                    raise ValueError(f"Cannot change {key} on resume; start a fresh collection")
                continue
            if key == "requested_scope_manifest":
                if _manifest_keys(saved.get(key)) != _manifest_keys(value):
                    raise ValueError(f"Cannot change {key} on resume; start a fresh collection")
                continue
            if key == "requested_collections":
                if _scope_keys(saved.get(key)) != _scope_keys(value):
                    raise ValueError(f"Cannot change {key} on resume; start a fresh collection")
                continue
            if saved.get(key) != value:
                raise ValueError(f"Cannot change {key} on resume; start a fresh collection")
        # Direct Python callers receive the same guard as the CLI for filters.
        for key, value in filters.items():
            if saved.get(key) != value:
                raise ValueError(f"Cannot change {key} on resume; start a fresh collection")
        if collection_addresses is not None and _scope_keys(saved.get("requested_collections")) != _scope_keys(collection_addresses):
            raise ValueError("Cannot change collection addresses on resume; start a fresh collection")
        if scope_manifest is not None and _manifest_keys(saved.get("requested_scope_manifest")) != _manifest_keys(scope_manifest):
            raise ValueError("Cannot change scope manifest on resume; start a fresh collection")
        if comparison_targets is not None and (
            saved.get("mode") != "pricing" or
            _comparison_keys(saved.get("requested_comparison_targets")) != _comparison_keys(comparison_targets)
        ):
            raise ValueError("Cannot change comparison targets on resume; start a fresh collection")
        if rental_targets is not None and (
            saved.get("mode") != "rental_pricing" or
            _rental_keys(saved.get("requested_rental_targets")) != _rental_keys(rental_targets)
        ):
            raise ValueError("Cannot change rental targets on resume; start a fresh collection")
        run_id = resume_id
        if run["state"] == "complete":
            return CollectionResult(run_id, "complete", run["reason"], 0)
        manifest = saved["streams"]
    else:
        manifest = [{"kind": "collection", "path": "/v1/collections/gifts/", "params": {}}]
        if rental_targets is not None:
            scopes, skipped = rental_targets, []
            for collection in rental_targets:
                manifest.append({"kind": "history", "path": "/v1/rent/gifts/history/", "params": {
                    "collection_address": collection, "order_by": settings.order_by, "limit": settings.page_size,
                }})
        elif comparison_targets is not None:
            scopes, skipped = _scopes([target["collection_address"] for target in comparison_targets]), []
            for target in comparison_targets:
                manifest.append({"kind": "listing", "path": "/v1/rent/gifts/", "params": {
                    **target, "sort_by": settings.sort_by, "limit": settings.page_size,
                }})
        else:
            scopes, skipped = select_scopes(store, settings.max_collections, collection_addresses, scope_manifest=scope_manifest)
            for scope in scopes:
                scope_params = {"collection_address": scope} if scope else {}
                # Preserve unfiltered scope attribution: never parse a gift name to infer collection.
                if scope:
                    manifest.append({"kind": "attribute", "path": f"/v1/collections/{quote(scope, safe='')}/attributes/", "params": {}})
                manifest.append({"kind": "listing", "path": "/v1/rent/gifts/", "params": {
                    **scope_params, "sort_by": settings.sort_by, "limit": settings.page_size, **filters,
                }})
                manifest.append({"kind": "history", "path": "/v1/rent/gifts/history/", "params": {
                    **scope_params, "order_by": settings.order_by, "limit": settings.page_size,
                }})
        # Persist intended work before creating stream rows so an interrupted
        # initialization can recover every scope on the next invocation.
        stream_settings["streams"] = manifest
        if history_since is not None:
            stream_settings["history_refresh"] = build_history_refresh_plan(store, manifest, history_since)
        run_id = store.create_run(stream_settings, scopes, skipped)
    saved_settings = store.get_run(run_id)["settings"]
    if on_run_created:
        on_run_created(run_id)
    for specification in manifest:
        store.add_stream(run_id, **specification)
    pages = 0
    stop_reason: str | None = None
    failed = False
    auth_failed = False

    def observe(attempt: dict) -> None:
        store.record_attempt(run_id, attempt)
        logger.info("HTTP attempt", extra={"event": "http_attempt", "context": {
            "run_id": run_id, "path": attempt["path"], "status_code": attempt.get("status_code"),
        }})

    store.finish_run(run_id, "running")
    try:
        with client_factory(
            settings.token, timeout=settings.timeout, requests_per_second=settings.requests_per_second,
            max_attempts=settings.max_attempts, retry_attempts=settings.retry_attempts,
            run_seconds=settings.run_seconds, observer=observe, not_before=store.retry_not_before(),
        ) as client:
            for stream in store.streams(run_id):
                if stream["state"] == "complete":
                    continue
                stream_id = stream["id"]
                cursor = stream["next_cursor"]
                history_scan_since = stream_cutoff(saved_settings, stream)
                refresh_mode = stream_refresh_mode(saved_settings, stream)
                window_reason = ("incremental_history_covered" if refresh_mode == "incremental"
                                 else "timeframe_covered")
                store.set_stream_state(stream_id, "running")
                for _ in range(settings.max_pages):
                    params = dict(stream["params"])
                    if cursor is not None:
                        params["cursor"] = cursor
                    try:
                        response = client.get(stream["path"], params)
                        parsed = parse_page(stream["kind"], response.body)
                        next_cursor = parsed.next_cursor
                        if next_cursor is not None and (
                            next_cursor == cursor or store.has_cursor(stream_id, next_cursor)
                        ):
                            raise ValidationError("Pagination cursor cycle detected; start a fresh collection")
                        window_complete = (stream["kind"] == "history" and history_scan_since is not None
                                           and stream["params"].get("order_by") == "new_to_old"
                                           and _history_window_complete(store, run_id, stream_id, parsed, history_scan_since,
                                                                        stream["params"].get("collection_address"),
                                                                        maximum_timestamp=history_refresh.utc_seconds() + 300 if refresh_mode else None))
                        completion_reason = window_reason if window_complete and next_cursor is not None else None
                        if store.commit_page(stream_id, cursor, response, parsed, completion_reason=completion_reason):
                            pages += 1
                        cursor = next_cursor
                        if cursor is None or window_complete:
                            break
                    except BudgetExceeded as exc:
                        stop_reason = str(exc)
                        store.set_stream_state(stream_id, "partial", stop_reason)
                        store.record_issue(run_id, stream_id, "budget", stop_reason)
                        break
                    except (ApiError, ValidationError) as exc:
                        reason = str(exc)
                        if isinstance(exc, ApiError) and exc.status_code in (400, 404, 410, 422) and cursor is not None:
                            reason += "; saved cursor may be invalid: start a fresh collection"
                        store.set_stream_state(stream_id, "failed", reason)
                        store.record_issue(run_id, stream_id, getattr(exc, "reason", "invalid_response"), reason)
                        failed = True
                        if isinstance(exc, AuthError):
                            auth_failed = True
                            stop_reason = reason
                        break
                else:
                    store.set_stream_state(stream_id, "partial", "page_limit")
                if stop_reason:
                    break
    except KeyboardInterrupt:
        store.finish_run(run_id, "partial", "interrupted")
        raise
    except Exception:
        store.finish_run(run_id, "failed", "local_error; resume after resolving the local problem")
        raise

    run = store.get_run(run_id)
    streams = store.streams(run_id)
    all_complete = all(stream["state"] == "complete" for stream in streams)
    skipped = run.get("skipped_scopes", [])
    if auth_failed:
        state, reason = "failed", stop_reason
    elif all_complete and not skipped:
        state = "complete"
        reason = ("incremental_history_covered" if any(stream["reason"] == "incremental_history_covered" for stream in streams)
                  else "timeframe_covered" if any(stream["reason"] == "timeframe_covered" for stream in streams) else None)
    elif failed and not any(stream["pages"] for stream in streams):
        state, reason = "failed", stop_reason or "stream_failure"
    else:
        state = "partial"
        reason = stop_reason or ("stream_failure" if failed else "scope_limit" if skipped else "page_limit")
    store.finish_run(run_id, state, reason)
    logger.info("Collection finished", extra={"event": "collection_finished", "context": {
        "run_id": run_id, "state": state, "pages_committed": pages,
    }})
    return CollectionResult(run_id, state, reason, pages)
