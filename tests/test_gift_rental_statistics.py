"""Gift statistics reuse the saved history sample without claiming wallet income."""

from datetime import datetime

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.price_tracking import enrich_price_tracking
from test_price_tracking import COLLECTION, NFT, NOW, WALLET, addr, event, gift, save, store, ton


def statistics(store, subject=None):
    subject = subject if subject is not None else gift()
    changes = store.connection.total_changes
    enrich_price_tracking(store, [subject], WALLET, now=NOW)
    assert store.connection.total_changes == changes
    return subject["rental_statistics"]


def test_saved_rental_statistics_need_no_price_baseline_and_use_weighted_rates(store):
    save(store, "history", [event("2026-10-11T12:00:00Z", "0.1", 86400),
                            event("2026-10-12T12:00:00Z", "0.9", 259200)])
    subject = gift()
    result = statistics(store, subject)
    assert subject["price_tracking"]["change_count"] == 0
    assert result == {
        "version": 1, "semantics_version": "saved-gift-rental-statistics-v1", "coverage": "partial",
        "observed_at": "2026-10-20T11:00:00.000000Z", "first_rental_at": "2026-10-11T12:00:00.000000Z",
        "last_rental_at": "2026-10-12T12:00:00.000000Z", "observed_rentals": 2, "recorded_rentals": 2,
        "verified_rentals_without_history": 0, "recorded_volume": "1", "average_daily_rate": "0.25",
        "rental_days": "4", "excluded_counts": {},
    }


def test_replays_and_address_aliases_deduplicate_but_keep_latest_eligible_observation(store):
    value = event("2026-10-11T12:00:00Z")
    alias = {**value, **{key: preferred_address(value[key]) for key in ("address", "collection_address", "src", "dst")}}
    save(store, "history", [value, alias, value], when="2026-10-12T11:00:00Z")
    save(store, "history", [alias], when="2026-10-15T11:00:00Z")
    save(store, "history", [value], when="2026-10-13T11:00:00Z")
    save(store, "history", [event("2026-10-16T12:00:00Z", is_extend=True)])
    result = statistics(store)
    assert result["recorded_rentals"] == result["observed_rentals"] == 1
    assert result["recorded_volume"] == "0.3"
    assert result["observed_at"] == "2026-10-15T11:00:00.000000Z"
    assert result["excluded_counts"] == {"extensions": 1}


def test_observed_rental_starts_and_recorded_payments_are_counted_separately(store):
    value = event("2026-10-11T12:00:00Z")
    save(store, "history", [value, {**value, "dst": addr(999)}])
    result = statistics(store)
    assert result["observed_rentals"] == 1 and result["recorded_rentals"] == 2
    assert result["recorded_volume"] == "0.6"


def test_empty_history_does_not_claim_no_rentals_or_trust_current_rental_seed_fields(store):
    result = statistics(store, gift(current_rental_started_at="2026-10-11T12:00:00Z",
                                    current_rental_start_source="verified_contract", state="rented"))
    assert result["coverage"] == "no_history"
    for key in ("observed_at", "first_rental_at", "last_rental_at", "observed_rentals", "recorded_rentals",
                "verified_rentals_without_history", "recorded_volume", "average_daily_rate", "rental_days"):
        assert result[key] is None


def test_ineligible_ambiguous_future_and_mismatched_records_never_contribute(store):
    disputed = event("2026-10-01T12:00:00Z")
    save(store, "history", [disputed, {**disputed, "price": "0.9", "price_nano": "900000000"},
        event("2026-10-02T12:00:00Z", is_extend=True), event("2026-10-03T12:00:00Z", currency="TON"),
        event("2026-10-04T12:00:00Z", duration=0), event("2026-10-05T12:00:00Z", src=""),
        event("2026-10-06T12:00:00Z", collection_address=addr(999)),
        event("2026-10-07T12:00:00Z", price_nano="1"), event("2026-10-21T12:00:00Z")], valid=False)
    result = statistics(store)
    assert result["coverage"] == "no_history" and result["recorded_volume"] is None
    assert result["observed_rentals"] is None and result["observed_at"] is None
    assert result["excluded_counts"] == {
        "ambiguous_history_variants": 2, "extensions": 1, "non_gram_currency": 1,
        "missing_or_nonpositive_duration": 1, "malformed_history": 2,
        "collection_mismatch": 1, "inconsistent_gram_amounts": 1,
    }


def test_future_observation_cannot_make_a_valid_old_rental_available(store):
    save(store, "history", [event("2026-10-11T12:00:00Z")], when="2026-10-21T11:00:00Z")
    result = statistics(store)
    assert result["coverage"] == "no_history" and result["observed_at"] is None
    assert result["excluded_counts"] == {"invalid_observation_time": 1}


@pytest.mark.parametrize("changes", [{"is_portfolio": False}, {"collection_conflict": True}, {"collection_address": None}])
def test_nonportfolio_and_conflicted_gifts_do_not_receive_shared_history_statistics(store, changes):
    save(store, "history", [event("2026-10-11T12:00:00Z")])
    subjects = [gift(), gift(**changes)]
    enrich_price_tracking(store, subjects, WALLET, now=NOW)
    assert subjects[0]["rental_statistics"]["recorded_rentals"] == 1
    denied = subjects[1]["rental_statistics"]
    assert denied["coverage"] == "not_applicable" and denied["recorded_rentals"] is None
    assert denied["observed_at"] is None and denied["excluded_counts"] == {}


def test_zero_payment_is_distinct_from_unknown_and_extreme_scales_keep_exact_volume(store):
    save(store, "history", [event("2026-10-11T12:00:00Z", "0")])
    assert statistics(store)["recorded_volume"] == "0"
    tiny = event("2026-10-13T12:00:00Z")
    tiny.update(price="1e-1000", price_nano="1e-991")
    save(store, "history", [event("2026-10-12T12:00:00Z", "1"), tiny])
    result = statistics(store)
    assert result["recorded_rentals"] == 3
    assert result["recorded_volume"] == "1." + "0" * 999 + "1"
    assert result["average_daily_rate"] == "0.333333333"


def test_statistics_share_the_price_tracking_history_read(store, monkeypatch):
    save(store, "history", [event("2026-10-11T12:00:00Z")])
    original, reads = store.observations, []
    def observed(kind, **options):
        reads.append(kind)
        return original(kind, **options)
    monkeypatch.setattr(store, "observations", observed)
    subject = gift()
    enrich_price_tracking(store, [subject], WALLET, owned_price_observations=[ton()], now=NOW)
    assert subject["price_tracking"]["observation_count"] == 1
    assert subject["rental_statistics"]["recorded_rentals"] == 1
    assert reads.count("history") == 1


def test_dashboard_statistics_are_independent_of_comparison_timeframe_and_source(store, tmp_path, monkeypatch):
    class FrozenTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW
    monkeypatch.setattr("marketapp_rent.price_tracking.datetime", FrozenTime)
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address\n{NFT},{COLLECTION}\n")
    store.import_portfolio(portfolio)
    save(store, "history", [event("2025-01-01T12:00:00Z")])
    first = build_dashboard(store, WALLET, pricing_source="listings", timeframe="24h")
    second = build_dashboard(store, WALLET, pricing_source="rentals", timeframe="90d", pricing_backdrop="Black")
    assert first["gifts"][0]["rental_statistics"] == second["gifts"][0]["rental_statistics"]
    assert first["gifts"][0]["rental_statistics"]["recorded_rentals"] == 1
