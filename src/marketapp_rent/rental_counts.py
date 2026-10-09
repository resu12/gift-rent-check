"""Conservative, offline rental-start counts for portfolio gifts.

These are counts in saved Marketapp history, not lifetime totals or proof that
the configured wallet was the landlord. The endpoint has no guaranteed event
ID, so changed representations of a possible event remain unresolved.
"""

from collections import Counter, defaultdict
from datetime import datetime, timezone

from .models import History
from .pricing import _instant, _key, _load
from .util import canonical_json


SEMANTICS = "marketapp-recorded-rental-starts-v1"
_NOTE = (
    "Distinct rental starts in all saved Marketapp history, independent of the "
    "pricing timeframe. Coverage may be incomplete; this is not a lifetime "
    "total or proof that these rentals occurred during your ownership. "
    "Extensions are excluded."
)
# The pinned rental-history schema has no action discriminator. If a future
# response explicitly describes an incompatible action, do not count it as a
# rental merely because the rest of its fields resemble the current schema.
_NON_RENTAL_ACTIONS = {"return", "returned", "cancel", "cancelled", "canceled", "transfer"}


def enrich_rental_counts(store, gifts, *, now=None):
    """Add ``rental_history`` evidence to each gift without network access.

    Monetary values and duration do not decide whether a rental start counts.
    ``is_extend`` must be explicitly false; its schema default is not evidence.
    No confirmed starts is unknown, rather than an inferred zero lifetime total.
    """
    current = _instant(now) if now is not None else datetime.now(timezone.utc)
    if current is None:
        raise ValueError("Rental count time must be a timezone-aware datetime")
    wanted = {_key(gift.get("nft_address")) for gift in gifts if gift.get("is_portfolio")}
    wanted.discard(None)
    observed = defaultdict(dict)
    latest = {}
    for observation in store.observations("history"):
        nft = _key(observation["identity"])
        if nft not in wanted:
            continue
        when = _instant(observation["observed_at"])
        if when is not None and when <= current:
            observed[nft][observation["fingerprint"]] = when
            latest[nft] = max(when, latest.get(nft, when))

    groups = defaultdict(dict)
    excluded = defaultdict(Counter)
    for record in store.records("history"):
        nft = _key(record["identity"])
        if nft not in wanted or record["fingerprint"] not in observed[nft]:
            continue
        try:
            item = _load(record["source_json"])
            History.model_validate(item)
            if _key(item["address"]) != nft:
                raise ValueError
            when = datetime.fromtimestamp(item["ts"], timezone.utc)
            if item["ts"] <= 0 or when > current:
                raise ValueError
            normalized = {**item, "address": nft,
                          "collection_address": _key(item["collection_address"]),
                          "src": _key(item["src"]), "dst": _key(item["dst"])}
            if any(normalized[field] is None for field in ("collection_address", "src", "dst")):
                raise ValueError
            # A hash links records, but is neither globally nor per-gift a
            # guaranteed event ID. Parties and the timestamp locate possible
            # events; aliases and identical page occurrences add no weight.
            key = (nft, item["ts"], normalized["src"], normalized["dst"])
            groups[key][canonical_json(normalized)] = (item, when)
        except (ValueError, TypeError, KeyError, OverflowError, OSError):
            excluded[nft]["malformed_history"] += 1

    accepted = defaultdict(list)
    for key, variants in groups.items():
        nft = key[0]
        if len(variants) != 1:
            excluded[nft]["ambiguous_history_variants"] += len(variants)
            continue
        item, when = next(iter(variants.values()))
        if any(isinstance(item.get(field), str) and item[field].strip().casefold() in _NON_RENTAL_ACTIONS
               for field in ("action", "event_type")):
            excluded[nft]["non_rental_action"] += 1
        elif item.get("is_extend") is True:
            excluded[nft]["extensions"] += 1
        elif item.get("is_extend") is not False:
            excluded[nft]["unknown_extension_status"] += 1
        else:
            accepted[nft].append(when)

    for gift in gifts:
        nft = _key(gift.get("nft_address"))
        member = bool(gift.get("is_portfolio"))
        times = accepted[nft] if member else []
        reasons = dict(sorted(excluded[nft].items())) if member else {}
        coverage = "not_applicable" if not member else "partial" if observed[nft] else "no_history"
        note = _NOTE
        if not member:
            note = "Portfolio membership is unresolved; an owned-gift rental count is not assigned."
        elif not observed[nft]:
            note = "No saved Marketapp rental history for this gift. This does not establish that it has never been rented."
        elif not times:
            note = "No unambiguous rental starts could be counted in the saved history. " + _NOTE
        elif reasons:
            note += " Ambiguous or unsupported records are excluded."
        gift["rental_history"] = {
            "recorded_count": len(times) if times else None,
            "coverage": coverage,
            "note": note,
            "observed_at": latest[nft].isoformat() if member and nft in latest else None,
            "first_rental_at": min(times).isoformat() if times else None,
            "last_rental_at": max(times).isoformat() if times else None,
            "excluded_counts": reasons,
            "semantics_version": SEMANTICS,
        }
