"""Bounded listing or rental-history collection for portfolio comparisons."""
from __future__ import annotations

from typing import Any, Callable

from .addresses import canonical_address
from .api import ApiClient
from .collector import CollectionResult, collect
from .config import Settings
from .storage import Store


def build_price_targets(gifts: list[dict]) -> list[dict]:
    """Prioritize precise Black cohorts, then models and collection baselines.

    Unknown models still permit a collection comparison. Unknown or conflicting
    collection identities never create an unfiltered market scan.
    """
    collections: set[str] = set()
    models: set[tuple[str, str]] = set()
    own_black: set[tuple[str, str]] = set()
    for gift in gifts:
        if gift.get("is_portfolio") is not True or gift.get("category") == "unresolved" or gift.get("collection_conflict"):
            continue
        try:
            collection = canonical_address(gift.get("collection_address"))
        except ValueError:
            continue
        collections.add(collection)
        model = gift.get("model")
        if not isinstance(model, str) or not model.strip():
            continue
        pair = (collection, model)
        models.add(pair)
        backdrop = gift.get("backdrop")
        if isinstance(backdrop, str) and backdrop.strip().casefold() == "black":
            own_black.add(pair)
    return (
        [{"collection_address": collection, "model": model, "backdrop": "Black"} for collection, model in sorted(own_black)]
        + [{"collection_address": collection, "model": model} for collection, model in sorted(models)]
        + [{"collection_address": collection} for collection in sorted(collections)]
        + [{"collection_address": collection, "model": model, "backdrop": "Black"} for collection, model in sorted(models - own_black)]
    )


def collect_prices(
    store: Store, settings: Settings, *, gifts: list[dict] | None = None,
    resume_id: int | None = None, client_factory: Callable[..., ApiClient] = ApiClient,
    on_run_created: Callable[[int], None] | None = None,
) -> CollectionResult:
    """Collect explicit cohorts; a resume always uses its saved original targets.

    The caller supplies wallet-scoped gifts and page size. An absent or empty
    gift list starts a catalog-only run rather than selecting another wallet.
    """
    if resume_id is not None:
        if store.get_run(resume_id)["settings"].get("mode") != "pricing":
            raise ValueError("Only a pricing collection run can be resumed here")
        targets = None
    else:
        targets = build_price_targets(gifts or [])
    return collect(store, settings, resume_id=resume_id, comparison_targets=targets,
                   client_factory=client_factory, on_run_created=on_run_created)


def build_rental_targets(gifts: list[dict]) -> list[str]:
    """History has no model/backdrop filters; collect each eligible collection once."""
    return sorted({target["collection_address"] for target in build_price_targets(gifts)})


def collect_rental_prices(
    store: Store, settings: Settings, *, gifts: list[dict] | None = None,
    resume_id: int | None = None, client_factory: Callable[..., ApiClient] = ApiClient,
    on_run_created: Callable[[int], None] | None = None,
    explicit_stream_options: dict[str, Any] | None = None,
    history_since: int | None = None,
) -> CollectionResult:
    """Collect saved rental representations for local, timeframe-based comparisons.

    Enumeration is bounded by the usual page, HTTP-attempt, and duration limits.
    An optional inclusive Unix-second cutoff uses the same observed timestamp
    interpretation as rental pricing. Complete pages remain saved, including
    older records at the boundary. A resume keeps its original cutoff and scopes.
    """
    if resume_id is not None:
        if store.get_run(resume_id)["settings"].get("mode") != "rental_pricing":
            raise ValueError("Only a rental pricing collection run can be resumed here")
        targets = None
    else:
        targets = build_rental_targets(gifts or [])
    return collect(store, settings, resume_id=resume_id, rental_targets=targets,
                   client_factory=client_factory, on_run_created=on_run_created,
                   explicit_stream_options=explicit_stream_options, history_since=history_since)
