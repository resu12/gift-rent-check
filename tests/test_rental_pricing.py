"""Recorded rental rates and event-time windows never borrow asking prices."""
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.domain import ApiResponse
from marketapp_rent.models import parse_page
from marketapp_rent.pricing import enrich_pricing
from marketapp_rent.pricing_window import pricing_window
from test_pricing import (store, addr, gift, listing, listings, ton_traits, NOW,
                          RECENT, COLLECTION, WALLET)


def event(nft=10, price="0.6", duration=259200, **changes):
    from decimal import Decimal
    return {"address": addr(nft), "name": "Display name is not metadata", "collection_address": COLLECTION,
            "src": addr(900), "dst": addr(901), "ts": int(NOW.timestamp()) - 3600,
            "price": price, "price_nano": str(int(Decimal(price) * 10**9)), "currency": "GRAM",
            "duration": duration, "is_extend": False, "tx_hash": f"hash-{nft}", **changes}


def history(store, events, when=RECENT):
    run = store.create_run({}, [COLLECTION], [])
    stream = store.add_stream(run, "history", "/v1/rent/gifts/history/", {"collection_address": COLLECTION})
    body = json.dumps({"cursor": None, "items": events}).encode()
    store.commit_page(stream, None, ApiResponse(body, 200, when), parse_page("history", body))


def rates(store, *, subject=None, **options):
    subject = subject or gift()
    summary = enrich_pricing(store, [subject], WALLET, now=NOW, source="rentals", timeframe="30d", **options)
    return subject["pricing"], summary


def test_daily_rates_use_total_and_duration_not_current_asking_price(store):
    ton_traits(store)
    listings(store, [listing(i, "900000000000") for i in range(10, 13)])
    history(store, [event(i, price=p) for i, p in zip(range(10, 13), ("0.3", "0.6", "0.9"))])
    pricing, summary = rates(store)
    assert pricing["model_black"]["mean"] == "0.2"
    assert pricing["recommended_price_per_day"] == "0.2"
    assert pricing["basis"] == "model_black"
    assert pricing["collection"]["distinct_nft_count"] == 3
    assert summary["source"] == "rentals" and summary["time_basis"] == "rental_event"
    assert summary["unit"] == "GRAM/day" and summary["rental_record_count"] == 3


def test_identical_occurrences_aliases_and_hash_reuse_do_not_inflate_samples(store):
    values = [event(i, tx_hash="same-transaction") for i in range(10, 13)]
    history(store, values)
    history(store, values)
    alias = {**values[0], "address": preferred_address(addr(10)), "collection_address": preferred_address(COLLECTION)}
    history(store, [alias])
    pricing, summary = rates(store)
    assert pricing["collection"]["sample_count"] == 3
    assert summary["rental_record_count"] == 3


def test_changed_representations_are_excluded_without_deleting_stored_evidence(store):
    history(store, [event(), event(price="0.9"), event(11, tx_hash=None), event(12, tx_hash=None)])
    pricing, summary = rates(store)
    assert pricing["collection"]["sample_count"] == 2
    assert pricing["collection"]["missing_hash_count"] == 2
    assert summary["excluded_counts"]["ambiguous_history_variants"] == 2
    assert len(store.records("history")) == 4


@pytest.mark.parametrize("changes,reason", [
    ({"duration": 0}, "missing_or_nonpositive_duration"),
    ({"duration": -10}, "missing_or_nonpositive_duration"),
    ({"currency": "TON"}, "non_gram_currency"),
    ({"currency": "USDT"}, "non_gram_currency"),
    ({"price_nano": "1"}, "inconsistent_gram_amounts"),
    ({"price": "-1", "price_nano": "-1000000000"}, "invalid_amount"),
    ({"is_extend": True}, "unverified_extension_semantics"),
    ({"ts": int(NOW.timestamp()) * 1000}, "malformed_history"),
    ({"ts": int(NOW.timestamp()) + 1}, "outside_timeframe"),
])
def test_invalid_or_unverified_rates_are_excluded(store, changes, reason):
    history(store, [event(**changes)])
    pricing, summary = rates(store)
    assert pricing["collection"]["mean"] is None
    assert summary["excluded_counts"][reason] == 1


def test_missing_duration_and_extension_fields_stay_unknown(store):
    value = event()
    del value["duration"]
    history(store, [value])
    second = event(11)
    del second["is_extend"]
    history(store, [second])
    _, summary = rates(store)
    assert summary["excluded_counts"]["missing_or_nonpositive_duration"] == 1
    assert summary["excluded_counts"]["unverified_extension_semantics"] == 1


def test_rental_history_uses_event_time_not_observation_time(store):
    history(store, [event(ts=int(NOW.timestamp()) - 2 * 86400)])
    subject = gift()
    enrich_pricing(store, [subject], WALLET, now=NOW, source="rentals", timeframe="24h")
    assert subject["pricing"]["collection"]["mean"] is None
    enrich_pricing(store, [subject], WALLET, now=NOW, source="rentals", timeframe="7d")
    assert subject["pricing"]["collection"]["mean"] == "0.2"


def test_custom_dates_include_whole_utc_day_and_exclude_next_day(store):
    midnight = int(datetime(2026, 10, 7, tzinfo=timezone.utc).timestamp())
    history(store, [event(10, ts=midnight), event(11, ts=midnight + 86399), event(12, ts=midnight + 86400)])
    subject = gift()
    enrich_pricing(store, [subject], now=NOW, source="rentals", timeframe="custom", date_from="2026-10-07", date_to="2026-10-07")
    assert subject["pricing"]["collection"]["sample_count"] == 2


def test_listing_window_uses_latest_per_nft_within_custom_range(store):
    listings(store, [listing(10, "1000000000")], when="2026-10-06T23:59:59+00:00")
    listings(store, [listing(10, "9000000000")])
    subject = gift()
    enrich_pricing(store, [subject], now=NOW, timeframe="custom", date_from="2026-10-06", date_to="2026-10-06")
    assert subject["pricing"]["collection"]["mean"] == "1"
    enrich_pricing(store, [subject], now=NOW, timeframe="7d")
    assert subject["pricing"]["collection"]["mean"] == "9"


def test_exact_black_includes_own_portfolio_and_subject(store):
    ton_traits(store)
    listings(store, [listing(10), listing(11, backdrop="Onyx Black"), listing(12, model="Other")])
    history(store, [event(2), event(10), event(11), event(12)])
    pricing, summary = rates(store)
    assert [pricing[key]["sample_count"] for key in ("collection", "model", "model_black")] == [4, 3, 2]
    assert pricing["basis"] == "model"
    assert "own_portfolio" not in summary["excluded_counts"]


def test_own_black_rentals_count_once_for_both_subjects_without_inflating_gift_count(store):
    ton_traits(store, nft=addr(2))
    ton_traits(store, nft=addr(10))
    values = [event(nft, price=price, duration=days * 86400, ts=int(NOW.timestamp()) - offset * 3600,
                    tx_hash=f"tx-{offset}")
              for nft, price, days, offset in ((2, '0.17', 1, 1), (2, '1.19', 7, 2),
                                               (10, '0.17', 1, 3), (10, '0.51', 3, 4))]
    history(store, values)
    history(store, [{**value, "address": preferred_address(value["address"])} for value in values])
    gifts = [gift(addr(2)), gift(addr(10))]
    summary = enrich_pricing(store, gifts, WALLET, now=NOW, source='rentals', timeframe='30d')
    assert summary['rental_record_count'] == 4
    for subject in gifts:
        cohort = subject['pricing']['model_black']
        assert cohort['mean'] == '0.17'
        assert cohort['sample_count'] == 4 and cohort['distinct_nft_count'] == 2
        assert subject['pricing']['recommended_price_per_day'] is None


def test_repeated_rentals_from_one_gift_cannot_establish_three_peer_recommendation(store):
    history(store, [event(ts=int(NOW.timestamp()) - i * 3600, tx_hash=f"tx-{i}") for i in range(1, 5)])
    pricing, _ = rates(store)
    assert pricing["collection"]["sample_count"] == 4
    assert pricing["collection"]["distinct_nft_count"] == 1
    assert pricing["recommended_price_per_day"] is None


def test_missing_metadata_still_supports_collection_and_exact_decimal_conversion(store):
    history(store, [event(i, price="1", duration=7 * 86400) for i in range(10, 13)])
    pricing, _ = rates(store)
    assert pricing["recommended_price_per_day"] == "0.142857143"
    assert pricing["model"]["mean"] is None


@pytest.mark.parametrize("options", [
    {"timeframe": "bad"}, {"timeframe": "custom"},
    {"timeframe": "custom", "date_from": "2026-10-08", "date_to": "2026-10-07"},
    {"timeframe": "custom", "date_from": "2026-02-30", "date_to": "2026-10-07"},
    {"timeframe": "custom", "date_from": "2027-01-01", "date_to": "2027-01-02"},
    {"timeframe": "7d", "date_from": "2026-01-01"},
    {"timeframe": "custom", "date_from": "20261001", "date_to": "2026-10-07"},
    {"timeframe": "custom", "date_from": "2026-W40-1", "date_to": "2026-10-07"},
])
def test_invalid_windows_are_rejected(options):
    with pytest.raises(ValueError):
        pricing_window(now=NOW, **options)


def test_all_history_and_no_saved_history_are_safe(store):
    subject = gift()
    for source in ("listings", "rentals"):
        summary = enrich_pricing(store, [subject], now=NOW, source=source, timeframe="all")
        assert summary["window_from"] is None
        assert subject["pricing"]["collection"]["mean"] is None


def test_exponent_notation_preserves_large_exact_amounts(store):
    history(store, [event(i, price="1e100", price_nano="1e109", duration=86400) for i in range(10, 13)])
    pricing, _ = rates(store)
    assert pricing["collection"]["mean"] == "1" + "0" * 100


def test_exponent_notation_division_retains_nano_precision(store):
    from decimal import Decimal, localcontext, ROUND_HALF_UP
    history(store, [event(i, price="1e100", price_nano="1e109", duration=7 * 86400) for i in range(10, 13)])
    pricing, _ = rates(store)
    with localcontext() as ctx:
        ctx.prec = 150
        expected = (Decimal('1e100') / Decimal(7)).quantize(Decimal('0.000000001'), rounding=ROUND_HALF_UP)
    assert Decimal(pricing["collection"]["mean"]) == expected


def test_pinned_marketapp_ui_examples_reproduce_displayed_daily_rates(store):
    evidence = json.loads((Path(__file__).parent / 'fixtures/marketapp/rental-history-evidence.json').read_text(encoding='utf-8'))
    history(store, [s['api_event'] for s in evidence['samples']])
    for sample in evidence['samples']:
        subject = gift(collection_address=sample['api_event']['collection_address'])
        enrich_pricing(store, [subject], source='rentals', timeframe='7d', now=datetime(2026, 10, 9, tzinfo=timezone.utc))
        assert subject['pricing']['collection']['mean'] == sample['derived_price_per_day']
        assert subject['pricing']['semantics_version'] == evidence['evidence_version']
