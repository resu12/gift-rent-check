"""Frozen collection scheduling derived from atomically committed page counts."""
from __future__ import annotations

from urllib.parse import unquote

from .addresses import address_key


def scheduling(settings: dict) -> str:
    value = settings.get("scheduling", "sequential")
    if value not in ("sequential", "round_robin"):
        raise ValueError("Saved collection scheduling is incompatible; start a fresh collection")
    return value


def next_stream(streams: list[dict], policy: str, *, excluded=frozenset(), broad_first=False) -> dict | None:
    """Resume unfinished rounds before deepening an already visited stream.

    Stable collection rounds break ties, and the catalog always comes first.
    Failed streams are excluded by the caller only for the current invocation;
    a later explicit resume retries them using their saved checkpoint.
    """
    available = [stream for stream in streams if stream["state"] != "complete" and stream.get("id") not in excluded]
    if not available:
        return None
    catalog = next((stream for stream in available if stream["kind"] == "collection"), None)
    if catalog is not None or policy == "sequential":
        return catalog or available[0]
    positions, counts, scopes = {}, {}, {}
    for stream in streams:
        if stream["kind"] == "collection":
            continue
        scope = collection_key(stream)
        scopes.setdefault(scope, len(scopes))
        group = (scope, stream["kind"])
        ordinal = counts.get(group, 0)
        # Metadata exists only for known scopes. It must not move an
        # unfiltered listing ahead of the first known collection's listing.
        positions[id(stream)] = ({"attribute": 0, "listing": 1, "history": 2}.get(stream["kind"], 3), ordinal, scopes[scope])
        counts[group] = ordinal + 1
    def priority(stream):
        # Finish collection-wide work within its invocation page cap before
        # issuing optional narrower requests that a completed parent can cover.
        breadth = sum(key in stream.get("params", {}) for key in ("model", "backdrop")) if broad_first else 0
        return (breadth, stream.get("pages", 0), *positions[id(stream)])
    return min(available, key=priority)


def collection_key(stream: dict):
    scope = stream.get("params", {}).get("collection_address")
    if scope is None and stream["kind"] == "attribute":
        path = stream["path"]
        if path.startswith("/v1/collections/") and path.endswith("/attributes/"):
            scope = unquote(path[len("/v1/collections/"):-len("/attributes/")])
    return address_key(scope)


def efficiency_progress(settings: dict, streams: list[dict]) -> dict:
    manifest = settings.get("streams")
    planned = manifest if isinstance(manifest, list) else streams
    scopes = {collection_key(stream) for stream in planned if stream["kind"] != "collection"}
    started = {collection_key(stream) for stream in streams
               if stream["kind"] in ("listing", "history") and (stream["pages"] > 0 or stream["state"] == "complete")}
    size = settings.get("page_size")
    if type(size) is not int:
        size = next((stream["params"].get("limit") for stream in streams if stream["kind"] in ("listing", "history")), None)
    return {"page_size": size, "recommended_page_size": 100, "scheduling": scheduling(settings),
            "collections_started": len((started & scopes) - {None}),
            "collections_total": None if None in scopes else len(scopes)}
