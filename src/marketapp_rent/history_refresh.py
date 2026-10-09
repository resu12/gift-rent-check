"""Immutable, conservative overlap plans for collection rental-history refreshes.

The plan lives in the run manifest, never in provider query parameters. A plan
becomes reusable only when its existing atomic page checkpoint is complete.
"""
from __future__ import annotations

import json
import time
from typing import Any

from .addresses import canonical_address
from .storage import Store


VERSION = 1
OVERLAP_SECONDS = 48 * 60 * 60
FULL_SCAN_INTERVAL_SECONDS = 7 * 24 * 60 * 60
ORDER_UNVERIFIED = "history_timeframe_order_unverified"
SCOPE_UNVERIFIED = "history_collection_scope_unverified"


def utc_seconds() -> int:
    return int(time.time())


def _collection(specification: dict) -> str | None:
    if not isinstance(specification, dict):
        return None
    if specification.get("kind") != "history" or specification.get("path") != "/v1/rent/gifts/history/":
        return None
    params = specification.get("params", {})
    if not isinstance(params, dict) or params.get("order_by") != "new_to_old":
        return None
    try:
        return canonical_address(params.get("collection_address"))
    except (ValueError, TypeError):
        return None


def _valid_plan(plan: Any) -> bool:
    if not isinstance(plan, dict) or plan.get("mode") not in ("full", "incremental"):
        return False
    try:
        if canonical_address(plan.get("collection_address")) != plan.get("collection_address"):
            return False
    except (ValueError, TypeError):
        return False
    fields = ("window_since", "coverage_since", "scan_since", "checked_through", "full_scan_at")
    if any(type(plan.get(field)) is not int or plan[field] <= 0 for field in fields):
        return False
    if not (plan["coverage_since"] <= plan["window_since"] <= plan["scan_since"]
            and plan["full_scan_at"] <= plan["checked_through"]):
        return False
    if plan["mode"] == "full":
        return (plan["coverage_since"] == plan["window_since"] == plan["scan_since"]
                and plan["full_scan_at"] == plan["checked_through"] and plan.get("baseline") is None)
    baseline = plan.get("baseline")
    return (isinstance(baseline, dict)
            and all(type(baseline.get(key)) is int and baseline[key] > 0 for key in ("run_id", "stream_id"))
            and all(type(baseline.get(key)) is int and baseline[key] > 0
                    for key in ("coverage_since", "checked_through", "full_scan_at"))
            and baseline["coverage_since"] <= plan["window_since"]
            and baseline["coverage_since"] <= baseline["checked_through"] <= plan["checked_through"]
            and baseline["full_scan_at"] <= baseline["checked_through"]
            and plan["checked_through"] - baseline["full_scan_at"] < FULL_SCAN_INTERVAL_SECONDS
            and plan["full_scan_at"] == baseline["full_scan_at"]
            and plan["window_since"] < plan["scan_since"] <= plan["checked_through"]
            and plan["scan_since"] == max(plan["window_since"], baseline["checked_through"] - OVERLAP_SECONDS))


def _plans(settings: dict) -> dict[str, dict] | None:
    if not isinstance(settings, dict):
        return None
    policy = settings.get("history_refresh")
    if (not isinstance(policy, dict) or type(policy.get("version")) is not int or policy.get("version") != VERSION
            or settings.get("order_by") != "new_to_old"
            or settings.get("history_timestamp_semantics") != "marketapp-rent-history-ui-v1"):
        return None
    if (policy.get("overlap_seconds") != OVERLAP_SECONDS
            or policy.get("full_scan_interval_seconds") != FULL_SCAN_INTERVAL_SECONDS):
        return None
    values = policy.get("streams")
    if not isinstance(values, list) or any(not _valid_plan(value) for value in values):
        return None
    plans = {value["collection_address"]: value for value in values}
    if len(plans) != len(values):
        return None
    manifest = settings.get("streams")
    if not isinstance(manifest, list):
        return None
    scopes = {_collection(spec) for spec in manifest} - {None}
    if set(plans) != scopes or any(plan["window_since"] != settings.get("history_since") for plan in values):
        return None
    return plans


def validate_saved_plan(settings: dict) -> None:
    """Legacy runs retain their old full-window traversal, including on resume."""
    if "history_refresh" in settings and _plans(settings) is None:
        raise ValueError("Saved history refresh plan is incompatible; start a fresh collection")


def history_refresh_summary(settings: dict) -> dict | None:
    plans = _plans(settings)
    if plans is None:
        return None
    return {
        "version": VERSION,
        "overlap_seconds": OVERLAP_SECONDS,
        "full_scan_interval_seconds": FULL_SCAN_INTERVAL_SECONDS,
        "full_streams": sum(plan["mode"] == "full" for plan in plans.values()),
        "incremental_streams": sum(plan["mode"] == "incremental" for plan in plans.values()),
    }


def stream_cutoff(settings: dict, stream: dict) -> int | None:
    """Use the frozen scan boundary without changing the displayed time window."""
    plans = _plans(settings)
    plan = plans.get(_collection(stream)) if plans is not None else None
    return plan["scan_since"] if plan else settings.get("history_since")


def stream_refresh_mode(settings: dict, stream: dict) -> str | None:
    plans = _plans(settings)
    plan = plans.get(_collection(stream)) if plans is not None else None
    return plan["mode"] if plan else None


def build_history_refresh_plan(store: Store, manifest: list[dict], since: int, *, now: int | None = None) -> dict:
    now = utc_seconds() if now is None else now
    collections = {_collection(specification) for specification in manifest} - {None}
    baselines: dict[str, tuple[dict, dict]] = {}
    settings_cache: dict[int, dict | None] = {}
    rows = store.connection.execute("""SELECT s.*, r.settings_json FROM streams s
        JOIN runs r ON r.id=s.run_id WHERE s.kind='history' AND s.state='complete' AND s.pages>0
        AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.stream_id=s.id AND i.reason IN (?,?))""",
        (ORDER_UNVERIFIED, SCOPE_UNVERIFIED))
    for row in rows:
        stream = dict(row)
        stream["params"] = json.loads(stream["params_json"])
        collection = _collection(stream)
        if collection not in collections:
            continue
        if stream["run_id"] not in settings_cache:
            settings_cache[stream["run_id"]] = _plans(json.loads(stream["settings_json"]))
        plans = settings_cache[stream["run_id"]]
        previous = plans.get(collection) if plans is not None else None
        if (previous is None or previous["coverage_since"] > since
                or previous["checked_through"] > now or previous["window_since"] > previous["checked_through"]
                or not 0 <= now - previous["full_scan_at"] < FULL_SCAN_INTERVAL_SECONDS):
            continue
        current = baselines.get(collection)
        if current is None or (previous["checked_through"], stream["id"]) > (current[0]["checked_through"], current[1]["id"]):
            baselines[collection] = previous, stream
    plans = []
    for collection in sorted(collections):
        plan = {"collection_address": collection, "mode": "full", "window_since": since,
                "coverage_since": since, "scan_since": since, "checked_through": now,
                "full_scan_at": now, "baseline": None}
        if collection in baselines and since <= now:
            previous, stream = baselines[collection]
            scan_since = max(since, previous["checked_through"] - OVERLAP_SECONDS)
            if scan_since > since:
                plan.update(mode="incremental", scan_since=scan_since, full_scan_at=previous["full_scan_at"],
                            baseline={"run_id": stream["run_id"], "stream_id": stream["id"],
                                      "coverage_since": previous["coverage_since"], "checked_through": previous["checked_through"],
                                      "full_scan_at": previous["full_scan_at"]})
        plans.append(plan)
    return {"version": VERSION, "overlap_seconds": OVERLAP_SECONDS,
            "full_scan_interval_seconds": FULL_SCAN_INTERVAL_SECONDS, "streams": plans}
