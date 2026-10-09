"""A selected Black scope applies to every cohort, not only visible subjects."""

import pytest

from marketapp_rent.pricing import enrich_pricing
from test_pricing import (
    store, addr, gift, listing, listings, ton_traits, NOW, OLD, COLLECTION, WALLET,
)
from test_rental_pricing import event, history


def scoped_price(store, subject=None, **options):
    subject = subject if subject is not None else gift()
    summary = enrich_pricing(store, [subject], WALLET, now=NOW, backdrop="Black", **options)
    return subject["pricing"], summary


def test_black_listing_scope_filters_collection_and_model_averages(store):
    ton_traits(store)
    listings(store, [listing(10, "1000000000"), listing(11, "2000000000"), listing(12, "3000000000"),
                    listing(13, "8000000000", model="Emerald"), listing(14, "10000000000", model="Emerald"),
                    listing(15, "20000000000", backdrop="Onyx Black"),
                    listing(16, "100000000000", backdrop=None)])
    pricing, summary = scoped_price(store)
    assert pricing["collection"]["mean"] == "4.8"
    assert pricing["collection"]["sample_count"] == 5
    assert pricing["model"]["mean"] == pricing["model_black"]["mean"] == "2"
    assert pricing["model"]["sample_count"] == pricing["model_black"]["sample_count"] == 3
    assert pricing["recommended_price_per_day"] == "2"
    assert summary["backdrop"] == pricing["backdrop"] == "Black"


def test_black_listing_collection_uses_all_models_without_targeted_model_bias(store):
    ton_traits(store)
    listings(store, [listing(10, "1000000000"), listing(11, "3000000000", model="Emerald")])
    listings(store, [listing(12, "8000000000", model="Sapphire")], filters={"backdrop": "Black"})
    listings(store, [listing(13, "100000000000")], filters={"model": "Ruby", "backdrop": "Black"})
    listings(store, [listing(14, "900000000000")], filters={"model": "Ruby"})
    pricing, _ = scoped_price(store)
    assert pricing["collection"]["sample_count"] == 3
    assert pricing["collection"]["mean"] == "4"
    assert pricing["model"]["sample_count"] == 3
    assert pricing["model"]["mean"] == pricing["model_black"]["mean"] == "333.666666667"


@pytest.mark.parametrize("source", ["listings", "rentals"])
def test_black_scope_never_falls_back_to_unrestricted_collection(store, source):
    ton_traits(store)
    values = [listing(10), listing(11), *[listing(i, "9000000000", backdrop="Onyx Black") for i in range(12, 22)]]
    listings(store, values)
    history(store, [event(i) for i in range(10, 22)])
    pricing, _ = scoped_price(store, source=source, timeframe="30d")
    assert pricing["collection"]["sample_count"] == 2
    assert pricing["recommended_price_per_day"] is None
    assert pricing["basis"] is None


@pytest.mark.parametrize("source", ["listings", "rentals"])
@pytest.mark.parametrize("backdrop", ["Onyx Black", None])
def test_nonblack_and_unknown_subjects_cannot_receive_black_scoped_recommendations(store, source, backdrop):
    listings(store, [listing(i) for i in range(10, 13)])
    history(store, [event(i) for i in range(10, 13)])
    ton_traits(store, backdrop=backdrop)
    pricing, _ = scoped_price(store, source=source, timeframe="30d")
    assert pricing["collection"]["sample_count"] == 3
    assert pricing["recommended_price_per_day"] is None


def test_black_rental_collection_includes_own_gifts_and_other_models_only_with_fresh_black_traits(store):
    ton_traits(store)
    ton_traits(store, nft=addr(10), model="Emerald")
    ton_traits(store, nft=addr(11), backdrop="Onyx Black")
    ton_traits(store, nft=addr(12), when=OLD)
    history(store, [event(2, price="0.3"), event(10, price="0.9"), event(11, price="30"),
                    event(12, price="30"), event(13, price="30")])
    pricing, summary = scoped_price(store, source="rentals", timeframe="30d")
    assert pricing["collection"]["mean"] == "0.2"
    assert pricing["collection"]["sample_count"] == pricing["collection"]["distinct_nft_count"] == 2
    assert pricing["model"]["mean"] == pricing["model_black"]["mean"] == "0.1"
    assert summary["rental_record_count"] == 2
    assert pricing["recommended_price_per_day"] is None


def test_black_rental_record_counts_do_not_replace_distinct_gift_threshold(store):
    ton_traits(store)
    ton_traits(store, nft=addr(10))
    values = [event(nft, price="0.51", ts=int(NOW.timestamp()) - offset * 3600,
                    tx_hash=f"repeat-{offset}") for nft, offset in ((2, 1), (2, 2), (10, 3), (10, 4))]
    history(store, values)
    history(store, values)
    pricing, _ = scoped_price(store, source="rentals", timeframe="30d")
    assert pricing["collection"]["mean"] == "0.17"
    assert pricing["collection"]["sample_count"] == 4
    assert pricing["collection"]["distinct_nft_count"] == 2
    assert pricing["recommended_price_per_day"] is None


def test_black_scope_retains_rental_event_timeframe(store):
    ton_traits(store)
    history(store, [event(2, price="0.3"), event(2, price="0.9", ts=int(NOW.timestamp()) - 2 * 86400, tx_hash="older")])
    recent, _ = scoped_price(store, source="rentals", timeframe="24h")
    older, _ = scoped_price(store, source="rentals", timeframe="7d")
    assert recent["collection"]["mean"] == "0.1"
    assert older["collection"]["mean"] == "0.2"


@pytest.mark.parametrize("backdrop", ["Onyx Black", "Blue", "", "black"])
def test_unsupported_pricing_backdrop_is_rejected(store, backdrop):
    with pytest.raises(ValueError):
        enrich_pricing(store, [gift()], now=NOW, backdrop=backdrop)
