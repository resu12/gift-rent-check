"""Avoid narrower listing traversals only after a complete usable broader one.

Records retain their original request provenance. Completing a covered target
does not invent another observation or imply a simultaneous market snapshot.
"""
from __future__ import annotations

import json

from .addresses import address_key
from .storage import Store


POLICY = {"version": 1, "strategy": "complete_broader_streams", "trait_normalization": "pricing-traits-v1"}
COVERED_REASON = "covered_by_listing_stream:"
_TRAITS = ("model", "backdrop")
_QUERY_KEYS = {"collection_address", "sort_by", "limit", *_TRAITS}


def ordered_targets(targets: list[dict]) -> list[dict]:
    """Stable breadth-first traversal: collection, one trait, then both traits."""
    return sorted(targets, key=lambda target: sum(field in target for field in _TRAITS))


def validate_listing_plan(settings: dict) -> None:
    if "listing_refresh" not in settings:
        return
    policy = settings["listing_refresh"]
    if (not isinstance(policy, dict) or policy != POLICY or type(policy.get("version")) is not int
            or settings.get("mode") != "pricing"):
        raise ValueError("Saved listing refresh plan is incompatible; start a fresh collection")
    requested = settings.get("requested_comparison_targets")
    if not isinstance(requested, list) or any(not isinstance(target, dict) for target in requested):
        raise ValueError("Saved listing refresh targets are incompatible; start a fresh collection")
    expected = [{"kind": "collection", "path": "/v1/collections/gifts/", "params": {}}]
    expected.extend({"kind": "listing", "path": "/v1/rent/gifts/", "params": {
        **target, "sort_by": settings.get("sort_by"), "limit": settings.get("page_size"),
    }} for target in ordered_targets(requested))
    if settings.get("streams") != expected:
        raise ValueError("Saved listing refresh streams are incompatible; start a fresh collection")


def listing_refresh_summary(settings: dict, streams: list[dict]) -> dict | None:
    if settings.get("listing_refresh") != POLICY:
        return None
    listings = [stream for stream in streams if stream["kind"] == "listing"]
    return {"version": 1, "planned_streams": len(listings),
            "reused_streams": sum(stream["state"] == "complete" and str(stream.get("reason", "")).startswith(COVERED_REASON)
                                  for stream in listings),
            "provider_streams": sum(stream["pages"] > 0 for stream in listings)}


def _trait(value) -> str | None:
    return " ".join(value.split()).casefold() if isinstance(value, str) and value.strip() else None


def _filters(params: dict) -> dict | None:
    if not set(params) <= _QUERY_KEYS:
        return None
    filters = {field: _trait(params[field]) for field in _TRAITS if field in params}
    return filters if all(filters.values()) else None


def _attributes(values) -> dict | None:
    if not isinstance(values, list):
        return None
    result: dict[str, set[str | None]] = {}
    for value in values:
        if not isinstance(value, dict):
            return None
        field = _trait(value.get("trait_type"))
        if field in _TRAITS:
            result.setdefault(field, set()).add(_trait(value.get("value")))
    return {field: next(iter(items)) if len(items) == 1 and None not in items else None
            for field, items in result.items()}


def _classifiable(store: Store, source: dict, target_filters: dict, source_filters: dict, collection: str) -> bool:
    # Unknown or contradictory trait evidence must retain targeted fallback.
    # Each occurrence is checked, including overlaps, instead of trusting only
    # one representation of a gift that moved or changed during traversal.
    known: dict[str, dict[str, set[str]]] = {}
    rows = store.connection.execute("""SELECT o.collection_address,o.collection_conflict,r.identity,r.data_json
        FROM observations o JOIN pages p ON p.id=o.page_id JOIN records r ON r.id=o.record_id
        WHERE p.stream_id=? ORDER BY o.id""", (source["id"],))
    for row in rows:
        if row["collection_conflict"] or address_key(row["collection_address"]) != collection:
            return False
        nft = address_key(row["identity"])
        if not isinstance(nft, str) or not nft.strip():
            return False
        traits = _attributes(json.loads(row["data_json"]).get("attributes"))
        if traits is None or any(traits.get(field) != value for field, value in source_filters.items()):
            return False
        # A known nonmatching model excludes an item from that model's Black
        # cohort even when its backdrop is missing. All potentially matching
        # items must still have every required trait.
        if any(traits.get(field) is not None and traits[field] != value for field, value in target_filters.items()):
            fields = [field for field in target_filters if traits.get(field) is not None]
        else:
            fields = list(target_filters)
            if any(traits.get(field) is None for field in fields):
                return False
        observed = known.setdefault(nft, {})
        for field in fields:
            observed.setdefault(field, set()).add(traits[field])
            if len(observed[field]) > 1:
                return False
    return True


def covering_listing_stream(store: Store, run_id: int, target: dict) -> dict | None:
    """Return a completed same-run superset; partial samples never cover a cohort."""
    if target["kind"] != "listing" or target["path"] != "/v1/rent/gifts/":
        return None
    target_filters = _filters(target["params"])
    if not target_filters:
        return None
    collection = address_key(target["params"].get("collection_address"))
    if collection is None:
        return None
    for source in store.streams(run_id):
        if (source["id"] == target["id"] or source["kind"] != "listing" or source["path"] != target["path"]
                or source["state"] != "complete" or source["next_cursor"] is not None or source["pages"] < 1
                or source["reason"] is not None):
            continue
        params = source["params"]
        source_filters = _filters(params)
        if (source_filters is None or len(source_filters) >= len(target_filters)
                or address_key(params.get("collection_address")) != collection
                or params.get("sort_by") != target["params"].get("sort_by")
                or any(target_filters.get(field) != value for field, value in source_filters.items())):
            continue
        if _classifiable(store, source, target_filters, source_filters, collection):
            return source
    return None
