"""Observed asking-price cohorts: provenance, freshness, identity and arithmetic."""

from datetime import datetime, timezone
from decimal import Decimal, localcontext
import json

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.models import parse_page
from marketapp_rent.pricing import enrich_pricing
from marketapp_rent.storage import Store


def addr(number):
    return f"0:{number:064x}"


WALLET, SUBJECT, COLLECTION, OTHER_OWNER = map(addr, (1, 2, 3, 4))
NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
RECENT = "2026-10-08T11:00:00+00:00"
OLD = "2026-10-06T11:00:00+00:00"


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "prices.sqlite3") as instance:
        yield instance


def attributes(model="Ruby", backdrop="Black"):
    return [{"trait_type": trait, "value": value}
            for trait, value in (("Model", model), ("Backdrop", backdrop)) if value is not None]


def listing(number, nano="1000000000", *, model="Ruby", backdrop="Black", owner=OTHER_OWNER):
    return {"nft_address": addr(number), "nft_name": "Name must not determine model or collection",
            "owner": owner, "attributes": attributes(model, backdrop), "min_duration": 1, "max_duration": 30,
            "price_per_day": str(nano), "discount_per_day": 0, "listed_at": None}


def listings(store, values, *, scope=COLLECTION, when=RECENT, validate=True, filters=None):
    run = store.create_run({}, [scope], [])
    params = {"collection_address": scope} if scope else {}
    stream = store.add_stream(run, "listing", "/v1/rent/gifts/", {**params, **(filters or {})})
    body = json.dumps({"cursor": None, "items": values}).encode()
    parsed = parse_page("listing", body) if validate else ParsedPage([
        NormalizedRecord("listing", value["nft_address"], json.dumps(value), value) for value in values
    ], None)
    store.commit_page(stream, None, ApiResponse(body, 200, when), parsed)
    return run


def ton_traits(store, nft=SUBJECT, *, model="Ruby", backdrop="Black", when=RECENT,
               content=False, values=None, token_changes=None, metadata_address=None, item_changes=None):
    attrs = attributes(model, backdrop) if values is None else values
    item = {"address": nft, "owner_address": WALLET, "collection_address": COLLECTION,
            "last_transaction_lt": "10", "init": True, "content": {"uri": "https://metadata.invalid/no-fetch"}}
    item.update(item_changes or {})
    token = {"type": "nft_items", "valid": True, "extra": {"attributes": attrs}}
    token.update(token_changes or {})
    if content:
        item["content"] = {"attributes": attrs}
        body = {"nft_items": [item]}
    else:
        body = {"nft_items": [item], "metadata": {metadata_address or preferred_address(nft): {"token_info": [token]}}}
    ds = DiscoveryStore(store)
    run = ds.create_run(WALLET, {})
    ds.add_candidates(run, [{"nft_address": nft, "collection_address": COLLECTION, "source": "test_metadata"}])
    ds.commit_verification(run, nft, {"verified": False, "reason": "metadata_only", "collection_address": COLLECTION,
                                    "observed_at": when}, [{"provider": "toncenter", "path": "/api/v3/nft/items",
                                                            "observed_at": when, "status_code": 200, "body": json.dumps(body).encode()}])


def gift(nft=SUBJECT, **extra):
    return {"nft_address": nft, "collection_address": COLLECTION, "is_portfolio": True, **extra}


def price(store, subject=None, **options):
    subject = subject if subject is not None else gift()
    summary = enrich_pricing(store, [subject], WALLET, now=NOW, **options)
    return subject, summary


def test_collection_model_and_exact_black_cohorts_with_range_and_no_outlier_removal(store):
    ton_traits(store)
    values = [listing(10 + i, str((i + 1) * 10**9), model="Ruby" if i < 6 else "Emerald",
                      backdrop="Black" if i < 3 or i >= 6 else "Onyx Black") for i in range(9)]
    listings(store, values)
    subject, summary = price(store)
    pricing = subject["pricing"]
    assert (subject["model"], subject["backdrop"], subject["traits_source"]) == ("Ruby", "Black", "TON metadata")
    assert pricing["collection"]["mean"] == "5"
    assert pricing["model"]["mean"] == "3.5"
    assert pricing["model_black"]["mean"] == "2"
    assert [pricing[key]["sample_count"] for key in ("collection", "model", "model_black")] == [9, 6, 3]
    assert pricing["collection"]["median"] == "5" and pricing["collection"]["minimum"] == "1"
    assert pricing["collection"]["maximum"] == "9"
    assert pricing["recommended_price_per_day"] == "2" and pricing["basis"] == "model_black"
    assert pricing["confidence"] == "low"
    assert all(pricing[key]["coverage"] == "observed_sample" for key in ("collection", "model", "model_black"))
    assert summary["fresh_peer_count"] == 9 and summary["recommended_count"] == 1


@pytest.mark.parametrize("backdrop,expected_basis", [("Black", "model_black"), ("  bLaCk  ", "model_black"),
                                                     ("Onyx Black", "model"), ("Dark", "model"), (None, "model")])
def test_black_is_an_exact_trait_not_a_dark_color_category(store, backdrop, expected_basis):
    ton_traits(store, backdrop=backdrop)
    listings(store, [listing(i, "1000000000", backdrop="Black") for i in range(10, 13)] +
                    [listing(i, "3000000000", backdrop="Onyx Black") for i in range(13, 16)])
    subject, _ = price(store)
    assert subject["pricing"]["basis"] == expected_basis
    assert subject["pricing"]["model_black"]["mean"] == "1"  # Displayed even for non-Black subjects.
    assert subject["pricing"]["recommended_price_per_day"] == ("1" if expected_basis == "model_black" else "2")


def test_low_sample_cohorts_are_visible_but_recommendation_falls_back_conservatively(store):
    ton_traits(store)
    listings(store, [listing(10, "1000000000"), listing(11, "3000000000")] +
                    [listing(i, "5000000000", backdrop="Blue") for i in range(12, 22)])
    subject, _ = price(store)
    pricing = subject["pricing"]
    assert pricing["model_black"]["sample_count"] == 2 and pricing["model_black"]["mean"] == "2"
    assert pricing["basis"] == "model" and pricing["model"]["sample_count"] == 12
    assert pricing["confidence"] == "low"  # Broad fallback stays low even with many peers.
    assert "fewer than 3" in pricing["reason"]
    assert any("premium" in warning for warning in pricing["warnings"])


def test_collection_fallback_does_not_claim_model_specific_confidence(store):
    ton_traits(store, model="Unobserved model", backdrop="Black")
    listings(store, [listing(i, "2000000000") for i in range(10, 25)])
    subject, _ = price(store)
    assert subject["pricing"]["model"]["sample_count"] == 0
    assert subject["pricing"]["basis"] == "collection"
    assert subject["pricing"]["confidence"] == "low"
    assert "same-model and exact Black" in subject["pricing"]["reason"]


def test_matching_cohort_with_ten_peers_has_medium_sample_confidence(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 20)])
    subject, _ = price(store)
    assert subject["pricing"]["basis"] == "model_black"
    assert subject["pricing"]["confidence"] == "medium"
    assert subject["pricing"]["model_black"]["coverage"] == "observed_sample"


def test_latest_peer_observation_and_canonical_aliases_are_counted_once(store):
    ton_traits(store)
    first = listing(10, "1000000000")
    listings(store, [first, listing(11, "4000000000")], when="2026-10-08T09:00:00Z")
    updated = listing(10, "3000000000")
    updated["nft_address"] = preferred_address(addr(10))
    listings(store, [updated, listing(11, "4000000000"), listing(12, "5000000000")], scope=preferred_address(COLLECTION))
    listings(store, [updated, listing(11, "4000000000"), listing(12, "5000000000")])
    subject, summary = price(store)
    assert subject["pricing"]["model_black"]["sample_count"] == summary["fresh_peer_count"] == 3
    assert subject["pricing"]["recommended_price_per_day"] == "4"


def test_owned_membership_aliases_wallet_owners_and_subject_are_included_once(store, tmp_path):
    path = tmp_path / "portfolio.csv"
    path.write_text(f"nft_address,collection_address\n{preferred_address(addr(10))},{COLLECTION}\n")
    store.import_portfolio(path)
    ton_traits(store)
    values = ([listing(2, "999000000000"), listing(10, "999000000000"),
                    listing(11, "999000000000", owner=preferred_address(WALLET))] +
                    [listing(i, "1000000000") for i in range(12, 15)])
    listings(store, values)
    listings(store, [{**value, "nft_address": preferred_address(value["nft_address"])} for value in values])
    subject, summary = price(store)
    assert subject["pricing"]["recommended_price_per_day"] == "500"
    assert subject["pricing"]["collection"]["sample_count"] == 6
    assert subject["pricing"]["model_black"]["sample_count"] == 6
    assert "own_portfolio" not in summary["excluded_counts"]
    assert "wallet_owner" not in summary["excluded_counts"]


def test_freshness_boundary_future_and_naive_timestamps(store):
    ton_traits(store)
    listings(store, [listing(10)], when="2026-10-07T12:00:00Z")  # Inclusive 24-hour edge.
    listings(store, [listing(11)], when="2026-10-07T11:59:59Z")
    listings(store, [listing(12)], when="2026-10-08T12:00:01Z")
    listings(store, [listing(13)], when="2026-10-08T11:00:00")
    listings(store, [listing(14)], when=RECENT)
    subject, summary = price(store)
    assert subject["pricing"]["collection"]["sample_count"] == 2
    assert subject["pricing"]["recommended_price_per_day"] is None
    assert summary["excluded_counts"] == {"future_listing": 1, "invalid_observation_time": 1, "stale_listing": 1}


def test_stale_subject_traits_remain_visible_for_refresh_but_suppress_specific_recommendation(store):
    ton_traits(store, when=OLD)
    listings(store, [listing(i) for i in range(10, 22)])
    subject, _ = price(store)
    assert (subject["model"], subject["backdrop"]) == ("Ruby", "Black")
    assert subject["traits_observed_at"] == OLD
    assert any("older" in warning for warning in subject["trait_uncertainties"])
    assert subject["pricing"]["model_black"]["mean"] == "1"
    assert subject["pricing"]["basis"] == "collection" and subject["pricing"]["confidence"] == "low"
    assert "stale" in subject["pricing"]["reason"]


def test_newer_ton_traits_are_not_hidden_by_older_listing_traits(store):
    ton_traits(store, model="Newer indexer model", when=RECENT)
    listings(store, [listing(2, model="Ruby")] + [listing(i) for i in range(10, 13)], when="2026-10-08T10:00:00Z")
    subject, _ = price(store)
    assert subject["model"] == "Newer indexer model" and subject["traits_source"] == "TON metadata"
    assert subject["pricing"]["model_black"]["sample_count"] == 1  # The subject now counts too.
    assert subject["pricing"]["basis"] == "collection"


def test_newer_listing_can_refresh_stale_ton_traits(store):
    ton_traits(store, model="Old model", when=OLD)
    listings(store, [listing(2, model="Ruby")] + [listing(i) for i in range(10, 13)])
    subject, _ = price(store)
    assert subject["model"] == "Ruby" and subject["traits_source"] == "Marketapp listing"
    assert subject["pricing"]["basis"] == "model_black"


def test_same_time_listing_and_ton_trait_conflicts_remain_unresolved(store):
    ton_traits(store, model="New model")
    listings(store, [listing(2, model="Old model")] + [listing(i) for i in range(10, 13)])
    subject, _ = price(store)
    assert subject["model"] is None
    assert any("conflicting" in warning for warning in subject["trait_uncertainties"])
    assert subject["pricing"]["model"]["sample_count"] == 0


def test_missing_peer_traits_can_contribute_only_to_collection(store):
    ton_traits(store)
    listings(store, [listing(i, model=None, backdrop=None) for i in range(10, 13)])
    subject, _ = price(store)
    assert subject["pricing"]["collection"]["sample_count"] == 3
    assert subject["pricing"]["model"]["sample_count"] == subject["pricing"]["model_black"]["sample_count"] == 0
    assert subject["pricing"]["basis"] == "collection"


def test_stale_peer_metadata_does_not_create_model_or_black_membership(store):
    ton_traits(store)
    for number in range(10, 13):
        ton_traits(store, addr(number), when=OLD)
    listings(store, [listing(i, model=None, backdrop=None) for i in range(10, 13)])
    subject, _ = price(store)
    assert subject["pricing"]["collection"]["sample_count"] == 3
    assert subject["pricing"]["model_black"]["sample_count"] == 0


def test_exact_decimal_rounding_and_even_median_do_not_use_float(store):
    ton_traits(store)
    listings(store, [listing(10, "1"), listing(11, "2")])
    subject, _ = price(store, min_samples=2)
    cohort = subject["pricing"]["model_black"]
    assert cohort["mean"] == "0.000000002"  # Half-up to one nanoGRAM.
    assert cohort["median"] == "0.0000000015"  # Preserve the exact median.
    assert cohort["minimum"] == "0.000000001" and cohort["maximum"] == "0.000000002"


def test_amounts_beyond_ambient_decimal_precision_remain_exact(store):
    ton_traits(store)
    base = 123456789012345678901234567890123456789
    listings(store, [listing(10 + i, str(base + i)) for i in range(3)])
    with localcontext() as context:
        context.prec = 6
        subject, summary = price(store)
    assert subject["pricing"]["recommended_price_per_day"] == "123456789012345678901234567890.12345679"
    json.dumps(summary)
    json.dumps(subject)  # All monetary API fields are text, never Decimal/float objects.


def test_explicit_zero_is_a_price_but_empty_cohort_is_unknown(store):
    ton_traits(store)
    listings(store, [listing(i, "0") for i in range(10, 13)])
    subject, _ = price(store)
    assert subject["pricing"]["recommended_price_per_day"] == "0"
    unknown, _ = price(store, gift(addr(200), collection_address=addr(201)))
    assert unknown["pricing"]["collection"]["sample_count"] == 0
    assert all(unknown["pricing"]["collection"][key] is None for key in ("mean", "median", "minimum", "maximum", "observed_from", "observed_to"))
    assert unknown["pricing"]["recommended_price_per_day"] is None


def test_outliers_are_visible_and_not_silently_removed(store):
    ton_traits(store)
    listings(store, [listing(10), listing(11), listing(12, "100000000000")])
    subject, _ = price(store)
    cohort = subject["pricing"]["collection"]
    assert (cohort["mean"], cohort["median"], cohort["minimum"], cohort["maximum"]) == ("34", "1", "1", "100")


def test_collection_conflicts_block_subject_recommendations_and_exclude_peers(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 14)])
    listings(store, [listing(10)], scope=addr(99), when="2026-10-08T11:30:00Z")
    subject, summary = price(store)
    assert subject["pricing"]["collection"]["sample_count"] == 3
    assert summary["excluded_counts"]["collection_conflict"] == 1
    subject, _ = price(store, gift(collection_conflict=True))
    assert subject["pricing"]["recommended_price_per_day"] is None
    assert subject["pricing"]["reason"] == "Collection evidence conflicts."


def test_conflicting_same_observation_traits_are_not_chosen_arbitrarily(store):
    ton_traits(store, values=attributes() + [{"trait_type": "Model", "value": "Emerald"}])
    malformed = listing(10)
    malformed["attributes"] += [{"trait_type": "Backdrop", "value": "Onyx Black"}]
    numeric = listing(11)
    numeric["attributes"][0]["value"] = 42
    listings(store, [malformed, numeric, listing(12)])
    subject, summary = price(store)
    assert subject["model"] is None and any("conflicting" in warning for warning in subject["trait_uncertainties"])
    assert summary["excluded_counts"]["invalid_or_conflicting_traits"] == 2
    assert subject["pricing"]["collection"]["sample_count"] == 1
    assert subject["pricing"]["recommended_price_per_day"] is None


def test_latest_malformed_price_and_simultaneous_price_conflicts_do_not_fall_back(store):
    ton_traits(store)
    listings(store, [listing(10)], when="2026-10-08T09:00:00Z")
    bad = listing(10)
    bad["price_per_day"] = "NaN"
    listings(store, [bad], validate=False)
    listings(store, [listing(11, "1000000000"), listing(11, "2000000000"), listing(12)])
    subject, summary = price(store)
    assert subject["pricing"]["collection"]["sample_count"] == 1
    assert summary["excluded_counts"] == {"conflicting_latest_listing": 1, "malformed_listing": 1}


@pytest.mark.parametrize("options", [{"content": True}, {}, {"token_changes": {"valid": False}},
                                     {"token_changes": {"type": "nft_collections"}}, {"metadata_address": addr(99)}])
def test_ton_traits_require_valid_item_metadata_link_and_never_infer_names(store, options):
    ton_traits(store, **options)
    subject, _ = price(store, gift(name="Ruby Black #123", image_url="https://example.com/black-ruby.png"))
    expected = not any(key in options for key in ("token_changes", "metadata_address"))
    assert subject["model"] == ("Ruby" if expected else None)
    assert subject["backdrop"] == ("Black" if expected else None)


def test_newer_ton_trait_snapshot_replaces_older_values_but_ties_are_unresolved(store):
    ton_traits(store, model="Earlier", when="2026-10-08T09:00:00Z")
    ton_traits(store, model="Current", when=RECENT)
    subject, _ = price(store)
    assert subject["model"] == "Current"
    ton_traits(store, model="Conflicting", when=RECENT)
    subject, _ = price(store)
    assert subject["model"] is None and any("conflicting" in warning for warning in subject["trait_uncertainties"])


def test_collection_identity_and_history_prices_cannot_be_inferred_or_used(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 13)], scope=addr(99))
    run = store.create_run({}, [COLLECTION], [])
    stream = store.add_stream(run, "history", "/v1/rent/gifts/history/", {"collection_address": COLLECTION})
    body = json.dumps({"cursor": None, "items": [{"address": addr(90), "name": "Ruby", "collection_address": COLLECTION,
                       "ts": 1, "src": WALLET, "dst": OTHER_OWNER, "price": "1000", "price_nano": "1000000000000", "currency": "GRAM"}]}).encode()
    store.commit_page(stream, None, ApiResponse(body, 200, RECENT), parse_page("history", body))
    subject, _ = price(store)
    assert subject["pricing"]["collection"]["mean"] is None
    assert subject["pricing"]["recommended_price_per_day"] is None


def test_unknown_traits_empty_database_and_offline_read_only_behavior(store, monkeypatch):
    import httpx
    monkeypatch.setattr(httpx.Client, "request", lambda *args, **kwargs: pytest.fail("Pricing fetched remote data"))
    changes = store.connection.total_changes
    subject, summary = price(store)
    assert subject["model"] is None and subject["backdrop"] is None
    assert subject["pricing"]["confidence"] == "none" and subject["pricing"]["basis"] is None
    assert summary["fresh_peer_count"] == 0
    assert store.connection.total_changes == changes


def test_black_targeted_samples_cannot_inflate_broader_model_or_collection_means(store):
    ton_traits(store)
    listings(store, [listing(i, "9000000000") for i in range(10, 13)], filters={"model": "Ruby", "backdrop": "Black"})
    subject, summary = price(store)
    assert subject["pricing"]["collection"]["mean"] is None
    assert subject["pricing"]["model"]["mean"] is None
    assert subject["pricing"]["model_black"]["mean"] == "9"
    assert subject["pricing"]["basis"] == "model_black" and summary["fresh_peer_count"] == 3


def test_model_only_targeted_samples_cannot_inflate_collection_mean(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 13)], filters={"model": "Ruby"})
    subject, _ = price(store)
    assert subject["pricing"]["collection"]["mean"] is None
    assert subject["pricing"]["model"]["mean"] == subject["pricing"]["model_black"]["mean"] == "1"


def test_fresh_baseline_eligibility_survives_later_targeted_price_update(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 13)], when="2026-10-08T10:00:00Z")
    listings(store, [listing(i, "3000000000") for i in range(10, 13)], filters={"model": "Ruby", "backdrop": "Black"})
    subject, _ = price(store)
    assert all(subject["pricing"][cohort]["mean"] == "3" for cohort in ("collection", "model", "model_black"))
    assert all(subject["pricing"][cohort]["sample_count"] == 3 for cohort in ("collection", "model", "model_black"))


def test_stale_baseline_does_not_establish_broader_sample_eligibility(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 13)], when=OLD)
    listings(store, [listing(i, "3000000000") for i in range(10, 13)], filters={"model": "Ruby", "backdrop": "Black"})
    subject, _ = price(store)
    assert subject["pricing"]["collection"]["sample_count"] == subject["pricing"]["model"]["sample_count"] == 0
    assert subject["pricing"]["model_black"]["sample_count"] == 3


@pytest.mark.parametrize("filters", [{"symbol": "Star"}, {"model": "Emerald"}, {"backdrop": "Onyx Black"}])
def test_symbol_restricted_or_contradictory_filter_results_never_seed_cohorts(store, filters):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 13)], filters=filters)
    subject, summary = price(store)
    assert all(subject["pricing"][cohort]["sample_count"] == 0 for cohort in ("collection", "model", "model_black"))
    assert summary["excluded_counts"]["ineligible_comparison_source"] == 3


def test_unresolved_subjects_receive_statistics_but_no_recommendation_or_count(store):
    ton_traits(store)
    listings(store, [listing(i) for i in range(10, 13)])
    subject, summary = price(store, gift(is_portfolio=False))
    assert subject["pricing"]["model_black"]["mean"] == "1"
    assert subject["pricing"]["recommended_price_per_day"] is None
    assert "membership is unresolved" in subject["pricing"]["reason"]
    assert summary["recommended_count"] == 0


@pytest.mark.parametrize("options", [{"max_age_hours": 0}, {"max_age_hours": "NaN"}, {"max_age_hours": True},
                                     {"min_samples": 0}, {"min_samples": True}])
def test_invalid_comparison_configuration_is_rejected(store, options):
    with pytest.raises(ValueError):
        price(store, **options)
