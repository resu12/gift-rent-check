"""Offline, exact-decimal comparisons of observed base daily asking prices.

No sale prices, contract terms, rental history, floor fields or inferred traits
enter these cohorts. A bounded collection supplies a sample, never a census.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import json

from .addresses import address_key
from .discovery_models import item_collection, parse_ton
from .models import Listing, _reject_constant, _unique_object


_NANO = Decimal("0.000000001")
_FIELDS = ("model", "backdrop")
_LABELS = {"model": "Model", "backdrop": "Backdrop"}


def _instant(value):
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def _key(value):
    # Retain legacy opaque identifiers, with the same exact-match semantics as
    # the portfolio, while valid TON address aliases share a canonical key.
    return address_key(value) if isinstance(value, str) and value.strip() else None


def _trait_key(value):
    return " ".join(value.split()).casefold() if isinstance(value, str) else None


def _load(value):
    return json.loads(value, parse_float=Decimal, parse_constant=_reject_constant, object_pairs_hook=_unique_object)


def _remember_traits(evidence, nft, attributes, source, observed_at):
    if attributes is None:
        return
    parsed = defaultdict(list)
    malformed = not isinstance(attributes, list)
    if not malformed:
        for attribute in attributes:
            if not isinstance(attribute, dict) or not isinstance(attribute.get("trait_type"), str):
                malformed = True
                break
            field = _trait_key(attribute["trait_type"])
            if field in _FIELDS:
                value = attribute.get("value")
                parsed[field].append(" ".join(value.split()) if isinstance(value, str) and value.strip() else None)
    for field in _FIELDS:
        if malformed or field in parsed:
            values = parsed[field]
            error = "malformed" if malformed or None in values else None
            if len({_trait_key(value) for value in values}) > 1:
                error = "conflicting"
            evidence[nft][field].append({
                "value": values[0] if values and error is None else None,
                "error": error, "source": source, "when": observed_at,
            })


def _traits(evidence, cutoff, now):
    result = {"warnings": [], "invalid": False}
    sources, times = set(), []
    for field in _FIELDS:
        records = [record for record in evidence.get(field, []) if record["when"] <= now]
        fresh = [record for record in records if record["when"] >= cutoff]
        # Source preference must never hide a newer contradictory observation.
        # Equally recent contradictions are unresolved rather than tie-broken.
        pool = fresh or records
        if not pool:
            result[field], result[field + "_fresh"] = None, False
            result["warnings"].append(f"{_LABELS[field]} is unknown.")
            continue
        latest = max(record["when"] for record in pool)
        selected = [record for record in pool if record["when"] == latest]
        values = {_trait_key(record["value"]) for record in selected}
        errors = {record["error"] for record in selected if record["error"]}
        invalid = bool(errors) or len(values) > 1
        result[field] = None if invalid else selected[-1]["value"]
        result[field + "_fresh"] = not invalid and latest >= cutoff
        sources.update(record["source"] for record in selected)
        times.append(latest)
        if invalid:
            result["invalid"] = True
            issue = "conflicting" if "conflicting" in errors or len(values) > 1 else "malformed"
            result["warnings"].append(f"{_LABELS[field]} evidence is {issue}.")
        elif latest < cutoff:
            result["warnings"].append(f"{_LABELS[field]} evidence is older than the comparison freshness window.")
    result["source"] = "+".join(sorted(sources)) or None
    result["observed_at"] = max(times).isoformat() if times else None
    return result


def _eligible_sources(observations, metadata, cutoff, now):
    """Keep targeted samples from biasing the broader averages.

    Eligibility can be supplied by an earlier fresh occurrence, while the
    latest valid observation supplies this NFT's price. Repeated occurrences
    therefore improve freshness without adding sample weight.
    """
    eligible = {"collection": False, "collection_black": False, "model": False, "model_black": False}
    for observation in observations:
        if not observation["valid"] or not cutoff <= observation["when"] <= now:
            continue
        params = observation["params"]
        filters = {key: params[key] for key in ("model", "backdrop", "symbol") if key in params and params[key] is not None}
        if "symbol" in filters:
            continue
        if any(not isinstance(value, str) or not value.strip() for value in filters.values()):
            continue
        if any(_trait_key(value) != _trait_key(metadata[key]) for key, value in filters.items()):
            continue
        eligible["collection"] |= not filters
        # A Black collection sample must still span all models. A targeted
        # model + Black request cannot represent that broader population.
        eligible["collection_black"] |= "model" not in filters and ("backdrop" not in filters or _trait_key(filters["backdrop"]) == "black")
        eligible["model"] |= "backdrop" not in filters
        eligible["model_black"] |= "backdrop" not in filters or _trait_key(filters["backdrop"]) == "black"
    return eligible


def _text_decimal(value):
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _stats(peers):
    result = {"mean": None, "median": None, "minimum": None, "maximum": None,
              "sample_count": len(peers), "observed_from": None, "observed_to": None,
              "coverage": "observed_sample"}
    if not peers:
        return result
    prices = sorted(peer["price"] for peer in peers)
    # Prices can exceed Decimal's ambient 28-digit precision. Reserve room for
    # the sum, division, and nanoGRAM rounding without a binary float step.
    with localcontext() as context:
        context.prec = max(40, max(max(len(price.as_tuple().digits), price.adjusted() + 10) for price in prices) + len(str(len(prices))) + 20)
        mean = (sum(prices, Decimal(0)) / Decimal(len(prices))).quantize(_NANO, rounding=ROUND_HALF_UP)
        middle = len(prices) // 2
        median = prices[middle] if len(prices) % 2 else (prices[middle - 1] + prices[middle]) / Decimal(2)
    result.update(mean=_text_decimal(mean), median=_text_decimal(median),
                  minimum=_text_decimal(prices[0]), maximum=_text_decimal(prices[-1]),
                  observed_from=min(peer["when"] for peer in peers).isoformat(),
                  observed_to=max(peer["when"] for peer in peers).isoformat())
    return result


def _enrich_listings(store, gifts, wallet=None, *, now=None, max_age_hours=24, min_samples=3, as_of=False, return_context=False, backdrop=None):
    """Mutate gift comparison fields and return a JSON-safe sample summary.

    Known old subject traits remain visible, with their age warning, so a later
    collection can target them. They do not qualify a model recommendation.
    A new listing observation supersedes an earlier price; duplicates never
    inflate the distinct-NFT sample size.
    """
    instant = datetime.now(timezone.utc) if now is None else _instant(now)
    if instant is None:
        raise ValueError("Pricing now must have a timezone")
    try:
        age = Decimal(str(max_age_hours))
        if isinstance(max_age_hours, bool) or not age.is_finite() or age <= 0:
            raise ValueError
        cutoff = instant - timedelta(microseconds=int(age * Decimal(3_600_000_000)))
    except (InvalidOperation, ValueError, OverflowError):
        raise ValueError("Pricing max_age_hours must be finite and positive") from None
    if type(min_samples) is not int or min_samples < 1:
        raise ValueError("Pricing min_samples must be a positive integer")

    traits = defaultdict(lambda: defaultdict(list))
    collections = defaultdict(set)
    collection_conflicts = set()
    listing_groups = defaultdict(list)
    rejected = Counter()

    def remember_collection(nft, value):
        if nft and (identity := _key(value)):
            collections[nft].add(identity)

    members = store.portfolio()
    for member in [*members, *gifts]:
        nft = _key(member.get("nft_address"))
        remember_collection(nft, member.get("collection_address"))
        for collection in member.get("collection_addresses", []):
            remember_collection(nft, collection)
        if member.get("collection_conflict"):
            collection_conflicts.add(nft)
    # These address mappings carry provenance; names are never consulted.
    for record in store.records("history"):
        remember_collection(_key(record["identity"]), record["data"].get("collection_address"))
    for row in store.connection.execute("SELECT nft_key,evidence_json FROM ownership_observations"):
        remember_collection(row["nft_key"], _load(row["evidence_json"]).get("collection_address"))
    for row in store.connection.execute("SELECT nft_key,source_json FROM discovery_candidate_sources"):
        remember_collection(row["nft_key"], _load(row["source_json"]).get("collection_address"))

    for observed in store.observations("listing"):
        nft = _key(observed["identity"])
        if nft is None:
            rejected["invalid_nft_identity"] += 1
            continue
        when = _instant(observed["observed_at"])
        remember_collection(nft, observed.get("collection_address"))
        for values in observed.get("collection_evidence", {}).values():
            for value in values if isinstance(values, list) else [values]:
                remember_collection(nft, value)
        if observed.get("collection_conflict"):
            collection_conflicts.add(nft)
        try:
            source = _load(observed["source_json"])
            Listing.model_validate(source)
            if _key(source["nft_address"]) != nft or _key(source["owner"]) is None:
                raise ValueError("Invalid listing identity")
            digits = tuple(int(char) for char in source["price_per_day"])
            price = Decimal((0, digits, -9))
            if when:
                _remember_traits(traits, nft, source["attributes"], "Marketapp listing", when)
            valid = True
        except (ValueError, TypeError, KeyError):
            source, price, valid = {}, None, False
        listing_groups[nft].append({"when": when, "source": source, "price": price, "valid": valid,
                                    "params": observed.get("params", {})})

    for row in store.connection.execute("""SELECT body,observed_at FROM discovery_responses
            WHERE provider='toncenter' AND path='/api/v3/nft/items' AND status_code=200
            AND purpose IN ('enumeration','verification') ORDER BY id"""):
        when = _instant(row["observed_at"])
        if when is None:
            continue
        try:
            items = parse_ton(row["body"], "nft_items")
            body = _load(row["body"])
        except (ValueError, TypeError):
            continue
        known = set()
        for item in items:
            nft = _key(item["address"])
            known.add(nft)
            collection, issue = item_collection(item)
            remember_collection(nft, collection)
            if issue:
                collection_conflicts.add(nft)
            _remember_traits(traits, nft, (item.get("content") or {}).get("attributes"), "TON content", when)
        metadata = body.get("metadata")
        if not isinstance(metadata, dict):
            continue
        for address, details in metadata.items():
            nft = _key(address)
            # Collection metadata or an unrelated map entry cannot describe the
            # candidate NFT. Require its validated item in this same response.
            if nft not in known or not isinstance(details, dict) or not isinstance(details.get("token_info"), list):
                continue
            for token in details["token_info"]:
                if not isinstance(token, dict) or token.get("type") != "nft_items" or token.get("valid") is False:
                    continue
                extra = token.get("extra")
                if isinstance(extra, dict):
                    _remember_traits(traits, nft, extra.get("attributes"), "TON metadata", when)

    resolved = {nft: _traits(evidence, cutoff, instant) for nft, evidence in traits.items()}
    peers = []
    for nft, observations in listing_groups.items():
        dated = [observation for observation in observations if observation["when"] is not None
                 and (not as_of or observation["when"] <= instant)]
        if not dated:
            rejected["invalid_observation_time"] += 1
            continue
        latest = max(observation["when"] for observation in dated)
        group = [observation for observation in dated if observation["when"] == latest]
        if latest > instant or latest < cutoff:
            rejected["future_listing" if latest > instant else "stale_listing"] += 1
            continue
        if any(not observation["valid"] for observation in group):
            rejected["malformed_listing"] += 1
            continue
        signatures = {(_key(observation["source"]["owner"]), observation["price"]) for observation in group}
        if len(signatures) > 1:
            rejected["conflicting_latest_listing"] += 1
            continue
        listing = group[-1]
        if nft in collection_conflicts or len(collections[nft]) > 1:
            rejected["collection_conflict"] += 1
            continue
        if not collections[nft]:
            rejected["missing_collection"] += 1
            continue
        metadata = resolved.get(nft) or _traits({}, cutoff, instant)
        if metadata["invalid"]:
            rejected["invalid_or_conflicting_traits"] += 1
            continue
        if backdrop and (not metadata["backdrop_fresh"] or _trait_key(metadata["backdrop"]) != "black"):
            rejected["outside_backdrop_scope"] += 1
            continue
        eligible = _eligible_sources(dated, metadata, cutoff, instant)
        if not any(eligible.values()):
            rejected["ineligible_comparison_source"] += 1
            continue
        peers.append({"nft": nft, "collection": next(iter(collections[nft])),
                      "price": listing["price"], "when": latest,
                      "eligible": eligible,
                      "model": _trait_key(metadata["model"]) if metadata["model_fresh"] else None,
                      "backdrop": _trait_key(metadata["backdrop"]) if metadata["backdrop_fresh"] else None})

    recommended = 0
    for gift in gifts:
        nft = _key(gift.get("nft_address"))
        metadata = resolved.get(nft) or _traits({}, cutoff, instant)
        gift.update(model=metadata["model"], backdrop=metadata["backdrop"],
                    traits_source=metadata["source"], traits_observed_at=metadata["observed_at"],
                    trait_uncertainties=list(metadata["warnings"]))
        conflict = nft in collection_conflicts or len(collections[nft]) > 1
        collection = None if conflict else next(iter(collections[nft]), None)
        comparable = [peer for peer in peers if peer["collection"] == collection] if collection else []
        model_key = _trait_key(metadata["model"])
        matching_model = [peer for peer in comparable if model_key is not None and peer["model"] == model_key]
        collection_peers = [peer for peer in comparable if peer["eligible"]["collection_black" if backdrop else "collection"]]
        model_peers = [peer for peer in matching_model if peer["eligible"]["model_black" if backdrop else "model"]]
        black_peers = [peer for peer in matching_model if peer["backdrop"] == "black" and peer["eligible"]["model_black"]]
        pricing = {"collection": _stats(collection_peers), "model": _stats(model_peers), "model_black": _stats(black_peers),
                   "recommended_price_per_day": None, "basis": None, "confidence": "none",
                   "reason": f"At least {min_samples} distinct fresh peer NFTs are required.",
                   "warnings": list(metadata["warnings"])}
        if not gift.get("is_portfolio"):
            pricing["reason"] = "Portfolio membership is unresolved; comparisons are shown without a recommendation."
        elif collection is None:
            pricing["reason"] = "Collection evidence conflicts." if conflict else "Collection identity is unknown."
        elif backdrop and (not metadata["backdrop_fresh"] or _trait_key(metadata["backdrop"]) != "black"):
            pricing["reason"] = "This gift has no current evidence for the selected exact Black backdrop."
        else:
            choices = []
            expected_basis = ("model_black" if model_key and _trait_key(metadata["backdrop"]) == "black"
                              else "model" if model_key else "collection")
            if metadata["model_fresh"]:
                if metadata["backdrop_fresh"] and _trait_key(metadata["backdrop"]) == "black":
                    choices.append("model_black")
                if not backdrop:
                    choices.append("model")
            choices.append("collection")
            for basis in choices:
                cohort = pricing[basis]
                if cohort["sample_count"] >= min_samples:
                    fallback = basis != expected_basis
                    pricing.update(recommended_price_per_day=cohort["mean"], basis=basis,
                                   confidence="medium" if cohort["sample_count"] >= 10 and not fallback else "low",
                                   reason={"model_black": "Mean asking price for the same model and exact Black backdrop.",
                                           "model": "Mean asking price for the same model.",
                                           "collection": "Collection mean; a more specific eligible group has insufficient evidence."}[basis])
                    if fallback:
                        label = "same-model and exact Black" if expected_basis == "model_black" else "same-model"
                        pricing["reason"] = (f"The {label} comparison is stale or has fewer than {min_samples} eligible peers; "
                                             f"using the {'same-model' if basis == 'model' else 'collection'} mean.")
                        pricing["warnings"].append("Broader averages may not capture this model or backdrop's price premium.")
                    if backdrop and basis == "collection":
                        pricing["reason"] = f"The same-model + Black group has fewer than {min_samples} eligible gifts or insufficient model evidence; using the collection + Black mean."
                    recommended += 1
                    break
        pricing["warnings"].append("Observed asking-price sample; availability, rental income and full-market coverage are not established.")
        gift["pricing"] = pricing
    summary = {"generated_at": instant.isoformat(), "max_age_hours": _text_decimal(age), "min_samples": min_samples,
            "fresh_peer_count": len(peers), "excluded_counts": dict(sorted(rejected.items())),
            "recommended_count": recommended, "coverage": "observed_sample",
            "methodology": "Latest fresh base daily asking price per distinct NFT; arithmetic means rounded to one nanoGRAM (half up). Collection averages require unfiltered occurrences; model averages exclude backdrop and symbol filters; Black averages exclude symbol filters. Exact Black only. Eligible portfolio and wallet-owned listings, including the gift being compared, are included on the same terms as other listings.",
            "warnings": ["No outliers removed; median and range show sample spread. No sale prices, historical payments or discount calculations used."]}

    if return_context:
        return summary, {"traits": resolved, "collections": collections, "conflicts": collection_conflicts}
    return summary


def enrich_pricing(store, gifts, wallet=None, *, now=None, max_age_hours=24, min_samples=3,
                   source="listings", timeframe=None, date_from=None, date_to=None, backdrop=None):
    """Use the same explicit source/window for API views, details and CSVs."""
    from .pricing_window import pricing_window, window_metadata
    if source not in {"listings", "rentals"}:
        raise ValueError("Unknown pricing source")
    if backdrop not in (None, "Black"):
        raise ValueError("Pricing backdrop must be Black or omitted")
    instant = datetime.now(timezone.utc) if now is None else _instant(now)
    if instant is None:
        raise ValueError("Pricing now must have a timezone")
    window = pricing_window(timeframe or "24h", date_from, date_to, now=instant)
    if source == "rentals":
        from .rental_pricing import enrich_rental_pricing
        # Current structured traits describe the NFT; the rental event's own
        # timestamp selects its window. Never date events by collection time.
        _, context = _enrich_listings(store, gifts, wallet, now=instant, return_context=True)
        return enrich_rental_pricing(store, gifts, wallet, window=window, context=context, min_samples=min_samples, backdrop=backdrop)
    span = window["to"] - window["from"]
    microseconds = (span.days * 86400 + span.seconds) * 1000000 + span.microseconds
    hours = max_age_hours if timeframe is None else Decimal(max(microseconds, 1)) / Decimal(3_600_000_000)
    summary = _enrich_listings(store, gifts, wallet, now=window["to"], max_age_hours=hours,
                               min_samples=min_samples, as_of=timeframe == "custom", backdrop=backdrop)
    metadata = {"source": source, "unit": "GRAM/day", "sample_unit": "peer NFTs", "daily_comparable": True,
                "time_basis": "listing_observation", "backdrop": backdrop, **window_metadata(window)}
    if backdrop:
        summary["warnings"].append("All comparison groups use only verified exact Black backdrops. Collection + Black spans all models; no all-backdrop fallback is used.")
    summary.update(metadata)
    for gift in gifts:
        gift["pricing"].update(metadata)
    return summary
