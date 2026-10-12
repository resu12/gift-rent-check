"""Read-only, observed asking-price changes and saved gift rental activity.

The configured contract price and Marketapp listing price are separate series.
Gift history is neither confirmed wallet income nor evidence that a price change
caused a change in demand. All calculations use committed local observations.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import re

from .addresses import canonical_address
from .models import History, Listing, _nano_to_gram
from .pricing import _instant, _key, _load, _text_decimal
from .ton_decoder import MARKETAPP_OPERATOR, SUPPORTED_CODE_HASHES
from .util import canonical_json
from .monetary import bounded_decimal


SEMANTICS = "observed-price-performance-v1"
_NANO = Decimal("0.000000001")
_DAY = Decimal(86400)
_NON_RENTAL_ACTIONS = {"return", "returned", "cancel", "cancelled", "canceled", "transfer"}
_RENTAL_STATES = {"idle_rental_contract", "rented", "expired_pending_return"}


def _money(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        return None
    if isinstance(value, str) and len(value) > 1100:
        return None
    if isinstance(value, str) and not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value.strip()):
        return None
    try:
        amount = bounded_decimal(value)
        return amount if amount.is_finite() and amount >= 0 and len(amount.as_tuple().digits) <= 1100 and abs(amount.as_tuple().exponent) <= 1000 else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def _nanos(value, *, limit=120):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    raw = str(value)
    return _nano_to_gram(Decimal(raw)) if re.fullmatch(r"[0-9]{1," + str(limit) + r"}", raw) else None


def _sum(values):
    values = list(values)
    if not values:
        return None
    with localcontext() as ctx:
        # A small addend may be thousands of places from a large one. The
        # accepted representation/scale limits bound this span, while reserving
        # it preserves every terminating monetary digit before serialization.
        ctx.prec = max(50, max(value.adjusted() + 1 for value in values)
                       - min(value.as_tuple().exponent for value in values)
                       + len(str(len(values))) + 2)
        return _text_decimal(sum(values, Decimal(0)))


def _saved_rentals(store, wanted, current):
    """Deduplicate page occurrences and reject changed possible-event variants."""
    groups = defaultdict(dict)
    observed = set()
    excluded = defaultdict(Counter)
    for row in store.observations("history", identities=wanted):
        nft = _key(row.get("identity"))
        if nft not in wanted:
            continue
        when = _instant(row.get("observed_at"))
        if when is None or when > current:
            excluded[nft]["invalid_observation_time"] += 1
            continue
        observed.add(nft)
        item = None
        try:
            item = _load(row["source_json"])
            History.model_validate(item)
            if _key(item["address"]) != nft:
                raise ValueError
            happened = datetime.fromtimestamp(item["ts"], timezone.utc)
            if item["ts"] <= 0 or happened > current:
                raise ValueError
            normalized = {**item, "address": nft,
                          "collection_address": _key(item["collection_address"]),
                          "src": _key(item["src"]), "dst": _key(item["dst"])}
            if any(normalized[field] is None for field in ("collection_address", "src", "dst")):
                raise ValueError
            key = (nft, item["ts"], normalized["src"], normalized["dst"])
            groups[key][canonical_json(normalized)] = (item, happened)
        except (ValueError, TypeError, KeyError, OverflowError, OSError):
            # Identical malformed representations count once, as valid ones do.
            key = (nft, "malformed", row.get("fingerprint", row.get("source_json")))
            happened = None
            try:
                if type(item.get("ts")) is int and item["ts"] > 0:
                    candidate = datetime.fromtimestamp(item["ts"], timezone.utc)
                    if candidate <= current:
                        happened = candidate
            except (AttributeError, ValueError, TypeError, OverflowError, OSError, UnboundLocalError):
                pass
            groups[key]["malformed"] = (None, happened)
    accepted = defaultdict(list)

    def rejected(nft, when, reason, count=1):
        excluded[nft][reason] += count
        if when is not None:
            accepted[nft].append({"when": when, "reason": reason, "count": count})

    for key, variants in groups.items():
        nft = key[0]
        if len(variants) != 1:
            rejected(nft, datetime.fromtimestamp(key[1], timezone.utc), "ambiguous_history_variants", len(variants))
            continue
        item, happened = next(iter(variants.values()))
        if item is None:
            rejected(nft, happened, "malformed_history")
            continue
        if any(isinstance(item.get(field), str) and item[field].strip().casefold() in _NON_RENTAL_ACTIONS
               for field in ("action", "event_type")):
            rejected(nft, happened, "non_rental_action")
            continue
        if item.get("is_extend") is not False:
            rejected(nft, happened, "extensions" if item.get("is_extend") is True else "unknown_extension_status")
            continue
        amount, reason = None, None
        if item["currency"] != "GRAM":
            reason = "non_gram_currency"
        else:
            amount, nano = _money(item["price"]), _money(item["price_nano"])
            if amount is None or nano is None:
                amount, reason = None, "invalid_amount"
            elif amount != _nano_to_gram(nano):
                amount, reason = None, "inconsistent_gram_amounts"
            duration = item.get("duration")
            if amount is not None:
                if type(duration) is not int or duration <= 0:
                    reason = "missing_or_nonpositive_duration"
        if reason is not None:
            excluded[nft][reason] += 1
        accepted[nft].append({"when": happened, "amount": amount, "reason": reason,
                              "duration": item.get("duration"),
                              "collection": _key(item["collection_address"]), "currency": item["currency"]})
    return accepted, observed, excluded


def _ton_observation(row, gift, wallet, current):
    if not isinstance(row, dict):
        return None
    try:
        if canonical_address(row.get("wallet_address")) != wallet:
            return None
        if row.get("wallet") is not None and canonical_address(row.get("wallet")) != wallet:
            return None
        if canonical_address(row.get("nft_address")) != _key(gift.get("nft_address")):
            return None
    except ValueError:
        return None
    when = _instant(row.get("observed_at")) or _instant(row.get("checked_at"))
    if when is None or when > current:
        return None
    price = _nanos(row.get("configured_price_per_day_raw")) if row.get("verified") is True and isinstance(row.get("configured_price_per_day_raw"), str) else None
    try:
        holder = canonical_address(row.get("holding_contract"))
    except ValueError:
        holder = None
    reason = row.get("reason") if isinstance(row.get("reason"), str) else "invalid_contract_observation"
    try:
        if canonical_address(row.get("collection_address")) != _key(gift.get("collection_address")):
            price, reason = None, "collection_mismatch"
    except ValueError:
        price, reason = None, "collection_mismatch"
    if holder is None:
        price, reason = None, "missing_holding_contract"
    if _key(row.get("owner")) != wallet:
        price, reason = None, "owner_mismatch"
    if row.get("marketplace") is not None and _key(row.get("marketplace")) != MARKETAPP_OPERATOR:
        price, reason = None, "operator_mismatch"
    if row.get("code_hash_verified") is False or row.get("data_hash_verified") is False:
        price, reason = None, "unverified_contract_hashes"
    if row.get("code_hash") is not None and row.get("code_hash") not in SUPPORTED_CODE_HASHES:
        price, reason = None, "unsupported_code_hash"
    if row.get("data_hash") is not None and (not isinstance(row.get("data_hash"), str) or not re.fullmatch(r"[0-9a-f]{64}", row["data_hash"])):
        price, reason = None, "invalid_data_hash"
    if row.get("nft") is not None and _key(row.get("nft")) != _key(gift.get("nft_address")):
        price, reason = None, "nft_mismatch"
    if row.get("observed_owner") is not None and _key(row.get("observed_owner")) != holder:
        price, reason = None, "holder_mismatch"
    if row.get("rental_state") is not None and row.get("rental_state") not in _RENTAL_STATES:
        price, reason = None, "unsupported_rental_state"
    if row.get("currency") is not None and row.get("currency") != "GRAM":
        price, reason = None, "unsupported_price_currency"
    if row.get("price_unit") is not None and row.get("price_unit") != "nanoGRAM/day":
        price, reason = None, "unsupported_price_unit"
    return {"when": when, "price": price, "identity": holder, "reason": reason}


def _listing_observation(row, gift, current):
    nft = _key(gift.get("nft_address"))
    if _key(row.get("identity")) != nft:
        return None
    when = _instant(row.get("observed_at"))
    if when is None or when > current:
        return None
    price, owner, reason = None, None, "malformed_listing"
    collection = _key(gift.get("collection_address"))
    evidence = {_key(row.get("collection_address"))} - {None}
    for values in row.get("collection_evidence", {}).values():
        evidence.update(_key(value) for value in (values if isinstance(values, list) else [values]) if _key(value))
    conflict = row.get("collection_conflict") or collection is None or evidence and evidence != {collection}
    try:
        item = _load(row["source_json"])
        Listing.model_validate(item)
        owner = _key(item["owner"])
        if _key(item["nft_address"]) != nft or owner is None:
            raise ValueError
        if not conflict:
            price, reason = _nanos(item["price_per_day"], limit=1000), None
        else:
            reason = "collection_conflict"
    except (ValueError, TypeError, KeyError):
        pass
    return {"when": when, "price": price, "identity": owner, "reason": reason}


def _change_amount(before, after):
    with localcontext() as ctx:
        ctx.prec = max(50, max(len(value.as_tuple().digits) for value in (before, after)) + 40)
        difference = after - before
        percent = (difference * Decimal(100) / before).quantize(_NANO, rounding=ROUND_HALF_UP) if before else None
    return _text_decimal(difference), _text_decimal(percent) if percent is not None else None


def _timeline(rows):
    """Observed changes require adjacent valid observations in one identity."""
    groups = defaultdict(list)
    for row in rows:
        groups[row["when"]].append(row)
    points, changes, barriers = [], [], Counter()
    prior, segment = None, None
    interrupted = False
    for when, group in sorted(groups.items()):
        signatures = {(row["identity"], row["price"]) for row in group}
        if any(row["price"] is None for row in group) or len(signatures) != 1:
            reason = "conflicting_simultaneous_observations" if len(signatures) > 1 else group[-1]["reason"] or "invalid_price"
            barriers[reason] += 1
            if segment is not None:
                segment["ceiling"] = prior["when"]
            segment = None
            prior = None
            interrupted = True
            continue
        row = group[-1]
        if prior is not None and prior["identity"] != row["identity"]:
            segment["ceiling"] = prior["when"]
            segment, prior, interrupted = None, None, True
            barriers["holder_or_listing_owner_changed"] += 1
        if segment is None:
            segment = {"floor": when if interrupted else None, "ceiling": None}
        if prior is not None and prior["identity"] == row["identity"] and prior["price"] != row["price"]:
            difference, percent = _change_amount(prior["price"], row["price"])
            changes.append({"when": when, "previous_when": prior["when"], "identity": row["identity"],
                            "from_price": prior["price"], "to_price": row["price"],
                            "difference": difference, "percent": percent, "segment": segment})
        points.append({"when": when, "price": row["price"], "identity": row["identity"]})
        prior = row
    return points, changes, barriers


def _iso(when):
    return when.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _days(duration):
    microseconds = duration.days * 86_400_000_000 + duration.seconds * 1_000_000 + duration.microseconds
    with localcontext() as ctx:
        ctx.prec = 50
        return _text_decimal((Decimal(microseconds) / Decimal(86_400_000_000)).quantize(_NANO, rounding=ROUND_HALF_UP))


def _period(events, start, end, collection):
    excluded = Counter()
    eligible = []
    if start < end:
        for event in events:
            if not start <= event["when"] < end:
                continue
            reason = event.get("reason")
            if not reason and event.get("collection") != collection:
                reason = "collection_mismatch"
            if reason:
                excluded[reason] += event.get("count", 1)
            else:
                eligible.append(event)
    count = len(eligible) if start < end else None
    total_amount = _sum(event["amount"] for event in eligible)
    total_seconds = sum(event["duration"] for event in eligible)
    daily, rental_days = None, None
    if eligible:
        with localcontext() as ctx:
            ctx.prec = max(50, len(Decimal(total_amount).as_tuple().digits) + len(str(total_seconds)) + 30)
            daily = _text_decimal((Decimal(total_amount) * _DAY / Decimal(total_seconds)).quantize(_NANO, rounding=ROUND_HALF_UP))
            rental_days = _text_decimal((Decimal(total_seconds) / _DAY).quantize(_NANO, rounding=ROUND_HALF_UP))
    return {"window_from": _iso(start), "window_to": _iso(end), "recorded_rentals": count,
            "recorded_volume": (total_amount or "0") if count is not None else None,
            "average_daily_rate": daily,
            "rental_days": (rental_days or "0") if count is not None else None,
            "excluded_counts": dict(sorted(excluded.items())), "coverage": "observed_sample"}


def _comparisons(changes, index, events, current, collection):
    change = changes[index]
    prior = changes[index - 1] if index else None
    following = changes[index + 1] if index + 1 < len(changes) else None
    elapsed = max(timedelta(), current - change["when"])
    structural = []
    if prior:
        structural.append(max(timedelta(), change["previous_when"] - prior["when"]))
    if following:
        structural.append(max(timedelta(), following["previous_when"] - change["when"]))
    if change["segment"]["floor"] is not None:
        structural.append(max(timedelta(), change["previous_when"] - change["segment"]["floor"]))
    if change["segment"]["ceiling"] is not None:
        structural.append(max(timedelta(), change["segment"]["ceiling"] - change["when"]))
    result = []
    for days in (7, 14, 30):
        requested = timedelta(days=days)
        duration = min(requested, elapsed, *structural)
        status = "partial" if any(cap < requested for cap in structural) else "ready" if elapsed >= requested else "pending"
        result.append({"days": days, "status": status, "comparable_days": _days(duration),
                       "before": _period(events, change["previous_when"] - duration, change["previous_when"], collection),
                       "after": _period(events, change["when"], change["when"] + duration, collection)})
    return result


def enrich_price_tracking(store, gifts, wallet=None, *, owned_price_observations=(), now=None):
    """Attach bounded, JSON-safe tracking evidence without I/O or writes.

    The performance windows have equal elapsed lengths and omit the interval
    between the last old and first new price observations. Starts and their
    whole reported amounts/durations are assigned to half-open windows; these
    are not accrued revenue, net proceeds, occupancy or causal comparisons.
    """
    current = _instant(now) if now is not None else datetime.now(timezone.utc)
    if current is None:
        raise ValueError("Price tracking time must be a timezone-aware datetime")
    try:
        selected_wallet = canonical_address(wallet) if wallet else None
    except ValueError:
        selected_wallet = None
    wanted = {_key(gift.get("nft_address")): gift for gift in gifts if gift.get("is_portfolio")}
    wanted.pop(None, None)
    listings, ton = defaultdict(list), defaultdict(list)
    for row in store.observations("listing", identities=wanted):
        nft = _key(row.get("identity"))
        gift = wanted.get(nft)
        if gift and not gift.get("collection_conflict"):
            observation = _listing_observation(row, gift, current)
            if observation:
                listings[nft].append(observation)
    if selected_wallet:
        for row in owned_price_observations:
            nft = _key(row.get("nft_address")) if isinstance(row, dict) else None
            gift = wanted.get(nft)
            if gift and not gift.get("collection_conflict"):
                observation = _ton_observation(row, gift, selected_wallet, current)
                if observation:
                    ton[nft].append(observation)
    events, observed_history, rejected = _saved_rentals(store, wanted, current)
    for gift in gifts:
        nft = _key(gift.get("nft_address"))
        warnings = [
            "Only saved observations and eligible base GRAM rental records are included; coverage may be incomplete.",
            "Gift history does not establish wallet proceeds, net income, rental completion or a causal effect of changing a price.",
            "Equal-length before/after windows exclude the uncertain change interval; whole rental amounts and durations are assigned by rental start, not accrued revenue or occupancy.",
        ]
        ton_points, ton_changes, ton_barriers = _timeline(ton[nft])
        if ton_points:
            source, points, changes, barriers = "TON contract", ton_points, ton_changes, ton_barriers
            warnings.append("Configured contract prices do not prove Marketapp listing visibility or the rate of an ongoing rental.")
        else:
            points, changes, barriers = _timeline(listings[nft])
            source = "Marketapp listing" if points else None
            if ton_barriers and points:
                warnings.append("TON configured-price observations could not be verified; Marketapp listing evidence is used when available.")
        if barriers:
            warnings.append("Unverified or conflicting price evidence interrupts the timeline; changes across those gaps are not inferred.")
        if rejected[nft]:
            warnings.append("Ambiguous, malformed, extension, currency or amount records are excluded from the affected performance samples.")
        if nft not in observed_history:
            warnings.append("No saved rental history is available for this gift; recorded zeroes do not establish actual rental activity.")
        if gift.get("collection_conflict"):
            warnings.append("Conflicting collection evidence prevents price tracking for this gift.")
        if not points:
            warnings.append("Refresh saved prices to establish a baseline; the first observation is not a price change.")
        output = []
        for index in range(len(changes) - 1, max(-1, len(changes) - 6), -1):
            change = changes[index]
            observed_at = _iso(change["when"])
            output.append({"id": canonical_json([nft, source, observed_at]),
                           "observed_at": observed_at, "previous_observed_at": _iso(change["previous_when"]),
                           "from_price_per_day": _text_decimal(change["from_price"]),
                           "to_price_per_day": _text_decimal(change["to_price"]),
                           "delta_per_day": change["difference"], "percent_change": change["percent"],
                           "comparisons": _comparisons(changes, index, events[nft], current, _key(gift.get("collection_address")))})
        gift["price_tracking"] = {
            "version": 1, "semantics_version": SEMANTICS, "source": source, "unit": "GRAM/day",
            "observation_count": len(points), "change_count": len(changes),
            "last_observed_at": _iso(points[-1]["when"]) if points else None,
            "baseline_price_per_day": _text_decimal(points[0]["price"]) if points else None,
            "baseline_observed_at": _iso(points[0]["when"]) if points else None,
            "coverage": "observed_sample" if points else "no_observations", "changes": output,
            "warnings": warnings,
        }
