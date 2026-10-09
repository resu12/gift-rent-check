"""Observed rental-history daily rates, using pinned Marketapp UI semantics.

This interpretation is evidenced in docs/rental-history-evidence.md rather
than guaranteed by the OpenAPI schema. Rates are not the owner's net income.
"""
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, localcontext, ROUND_HALF_UP

from .models import History, _nano_to_gram
from .pricing import _instant, _key, _load, _stats, _trait_key, _text_decimal, _NANO
from .pricing_window import window_metadata
from .util import canonical_json


SEMANTICS = "marketapp-rent-history-ui-v1"
WARNINGS = [
    "Daily rate = reported full rental price × 86,400 / duration. Seconds and full-price semantics were cross-checked against Marketapp's UI; they are not guaranteed by the OpenAPI schema.",
    "Arithmetic mean per distinct rental record, excluding extensions with unverified incremental semantics. It is not weighted by rental duration and is not net income or evidence of rental completion.",
    "History has no traits: model and backdrop use saved structured NFT metadata, which may have been observed after the rental.",
    "Only saved history is covered. A timeframe selection does not fetch or establish complete market history. Missing or invalid records are excluded, not replaced with listing prices.",
    "Identical records count once. Ambiguous variants sharing NFT, timestamp and parties are excluded; transaction hashes alone do not identify unique events.",
    "Eligible rentals of your portfolio gifts, including the gift being compared, are included on the same terms as other rental records.",
]


def _rental_stats(peers):
    result = _stats(peers)
    result["distinct_nft_count"] = len({peer["nft"] for peer in peers})
    result["extension_count"] = sum(peer["is_extend"] is True for peer in peers)
    result["unknown_extension_count"] = sum(peer["is_extend"] is None for peer in peers)
    result["missing_hash_count"] = sum(not peer["tx_hash"] for peer in peers)
    with localcontext() as ctx:
        ctx.prec = max([50, *(max(len(value.as_tuple().digits), value.adjusted() + 10) + 20 for value in (peer["price"] for peer in peers))])
        for key in ("median", "minimum", "maximum"):
            if result[key] is not None:
                result[key] = _text_decimal(Decimal(result[key]).quantize(_NANO, rounding=ROUND_HALF_UP))
    return result


def enrich_rental_pricing(store, gifts, wallet, *, window, context, min_samples=3, backdrop=None):
    if type(min_samples) is not int or min_samples < 1:
        raise ValueError("Pricing min_samples must be a positive integer")
    rejected, groups = Counter(), defaultdict(dict)
    collected_at = {}
    for observation in store.observations("history"):
        when = _instant(observation["observed_at"])
        if when and when <= window["now"]:
            collected_at[observation["fingerprint"]] = max(when, collected_at.get(observation["fingerprint"], when))
    for record in store.records("history"):
        if record["fingerprint"] not in collected_at:
            rejected["invalid_observation_time"] += 1
            continue
        try:
            item = _load(record["source_json"])
            History.model_validate(item)
            nft, collection = _key(item["address"]), _key(item["collection_address"])
            if nft is None or collection is None:
                raise ValueError
            when = datetime.fromtimestamp(item["ts"], timezone.utc)
            if item["ts"] <= 0:
                raise ValueError
        except (ValueError, TypeError, KeyError, OverflowError, OSError):
            rejected["malformed_history"] += 1
            continue
        if not window["from"] <= when <= window["to"]:
            rejected["outside_timeframe"] += 1
            continue
        if nft in context["conflicts"] or len(context["collections"][nft]) > 1:
            rejected["collection_conflict"] += 1
            continue
        # Canonical aliases and page replays must not add statistical weight.
        normalized = {**item, "address": nft, "collection_address": collection,
                      "src": _key(item["src"]), "dst": _key(item["dst"])}
        key = (nft, item["ts"], normalized["src"], normalized["dst"], item.get("is_extend"))
        groups[key][canonical_json(normalized)] = (item, nft, collection, when)

    peers = []
    for variants in groups.values():
        if len(variants) != 1:
            rejected["ambiguous_history_variants"] += len(variants)
            continue
        item, nft, collection, when = next(iter(variants.values()))
        if item["currency"] != "GRAM":
            rejected["non_gram_currency"] += 1
            continue
        if item.get("is_extend") is not False:
            rejected["unverified_extension_semantics"] += 1
            continue
        duration = item.get("duration")
        if type(duration) is not int or duration <= 0:
            rejected["missing_or_nonpositive_duration"] += 1
            continue
        try:
            amount, nano = Decimal(item["price"]), Decimal(item["price_nano"])
            if not amount.is_finite() or not nano.is_finite() or amount < 0 or nano < 0:
                raise ValueError
            if amount != _nano_to_gram(nano):
                rejected["inconsistent_gram_amounts"] += 1
                continue
            with localcontext() as ctx:
                ctx.prec = max(50, max(len(amount.as_tuple().digits), amount.adjusted() + 10) + len(str(duration)) + 30)
                daily = amount * Decimal(86400) / Decimal(duration)
        except (ValueError, ArithmeticError):
            rejected["invalid_amount"] += 1
            continue
        metadata = context["traits"].get(nft, {})
        if metadata.get("invalid"):
            rejected["invalid_or_conflicting_traits"] += 1
            continue
        if backdrop and (not metadata.get("backdrop_fresh") or _trait_key(metadata.get("backdrop")) != "black"):
            rejected["outside_backdrop_scope"] += 1
            continue
        peers.append({"nft": nft, "collection": collection, "when": when, "price": daily,
                      "model": _trait_key(metadata.get("model")) if metadata.get("model_fresh") else None,
                      "backdrop": _trait_key(metadata.get("backdrop")) if metadata.get("backdrop_fresh") else None,
                      "is_extend": item.get("is_extend"), "tx_hash": item.get("tx_hash")})

    metadata = {"source": "rentals", "unit": "GRAM/day", "sample_unit": "rental records", "daily_comparable": True,
                "time_basis": "rental_event", "semantics_version": SEMANTICS, "backdrop": backdrop, **window_metadata(window)}
    warnings = list(WARNINGS)
    if backdrop:
        warnings.append("All comparison groups use only verified exact Black backdrops. Missing backdrop metadata is excluded. Collection + Black spans all models; no all-backdrop fallback is used.")
    recommended = 0
    for gift in gifts:
        nft = _key(gift.get("nft_address"))
        traits = context["traits"].get(nft, {})
        conflict = nft in context["conflicts"] or len(context["collections"][nft]) > 1
        collection = None if conflict else next(iter(context["collections"][nft]), None)
        comparable = [p for p in peers if p["collection"] == collection] if collection else []
        model = _trait_key(gift.get("model"))
        model_peers = [p for p in comparable if model is not None and p["model"] == model]
        pricing = {"collection": _rental_stats(comparable), "model": _rental_stats(model_peers),
                   "model_black": _rental_stats([p for p in model_peers if p["backdrop"] == "black"]),
                   "recommended_price_per_day": None, "basis": None, "confidence": "none",
                   "reason": f"Rental records from at least {min_samples} distinct peer NFTs are required.",
                   "warnings": list(gift.get("trait_uncertainties", [])) + warnings, **metadata}
        if not gift.get("is_portfolio"):
            pricing["reason"] = "Portfolio membership is unresolved; comparisons are shown without a recommendation."
        elif collection is None:
            pricing["reason"] = "Collection evidence conflicts." if conflict else "Collection identity is unknown."
        elif backdrop and (not traits.get("backdrop_fresh") or _trait_key(gift.get("backdrop")) != "black"):
            pricing["reason"] = "This gift has no current evidence for the selected exact Black backdrop."
        else:
            expected = "model_black" if model and _trait_key(gift.get("backdrop")) == "black" else "model" if model else "collection"
            choices = []
            if traits.get("model_fresh"):
                if traits.get("backdrop_fresh") and _trait_key(gift.get("backdrop")) == "black":
                    choices.append("model_black")
                if not backdrop:
                    choices.append("model")
            for basis in [*choices, "collection"]:
                if pricing[basis]["distinct_nft_count"] >= min_samples:
                    fallback = basis != expected
                    pricing.update(recommended_price_per_day=pricing[basis]["mean"], basis=basis, confidence="low",
                                   reason=f"Mean observed daily rental rate for the {basis.replace('_', ' + ')} comparison.")
                    if fallback:
                        pricing["reason"] += " Using a broader group because more specific evidence is insufficient."
                        pricing["warnings"].append("Broader averages may not capture this model or backdrop's price premium.")
                    if backdrop and basis == "collection":
                        pricing["reason"] = f"The same-model + Black group has fewer than {min_samples} distinct gifts or insufficient model evidence; using the collection + Black mean."
                    recommended += 1
                    break
        gift["pricing"] = pricing
    return {**metadata, "generated_at": window["now"].isoformat(), "min_samples": min_samples,
            "fresh_peer_count": len({p["nft"] for p in peers}), "rental_record_count": len(peers),
            "excluded_counts": dict(sorted(rejected.items())), "recommended_count": recommended,
            "coverage": "observed_sample", "methodology": "Arithmetic mean of observed rental daily rates, one weight per unambiguous rental record; minimum three distinct peer NFTs for a recommendation.",
            "warnings": warnings}
