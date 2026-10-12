"""Observed changes and comparable rental samples remain exact and offline."""

from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.models import parse_page
from marketapp_rent.price_tracking import enrich_price_tracking
from marketapp_rent.storage import Store
from marketapp_rent.ton_decoder import MARKETAPP_OPERATOR


def addr(number):
    return f"0:{number:064x}"


WALLET, NFT, COLLECTION, HOLDER = addr(900), addr(1), addr(100), addr(500)
NOW = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
EARLY = "2026-10-01T12:00:00Z"
OLD = "2026-10-09T12:00:00Z"
CHANGED = "2026-10-10T12:00:00Z"


@pytest.fixture
def store():
    with Store(":memory:") as database:
        yield database


def gift(**changes):
    return {"nft_address": NFT, "is_portfolio": True, "collection_address": COLLECTION, **changes}


def ton(price="100000000", when=EARLY, **changes):
    return {"wallet_address": WALLET, "nft_address": NFT, "collection_address": COLLECTION,
            "holding_contract": HOLDER, "owner": WALLET, "marketplace": MARKETAPP_OPERATOR,
            "code_hash_verified": True, "data_hash_verified": True, "verified": True,
            "rental_state": "idle_rental_contract", "configured_price_per_day_raw": price,
            "observed_at": when, "reason": "verified_contract_price", **changes}


def listing(price="100000000", **changes):
    return {"nft_address": NFT, "nft_name": "Example #1", "owner": WALLET, "attributes": [],
            "min_duration": 86400, "max_duration": 2592000, "price_per_day": price,
            "discount_per_day": 0, "listed_at": None, **changes}


def event(when, price="0.3", duration=86400, **changes):
    stamp = int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp())
    return {"address": NFT, "collection_address": COLLECTION, "name": "Example #1",
            "src": addr(901), "dst": addr(902), "ts": stamp, "price": price,
            "price_nano": format(Decimal(price) * 10**9, "f"), "currency": "GRAM",
            "is_extend": False, "duration": duration, "tx_hash": None, **changes}


def save(store, kind, items, *, when="2026-10-20T11:00:00Z", valid=True):
    run = store.create_run({}, [COLLECTION], [])
    path = "/v1/rent/gifts/" if kind == "listing" else "/v1/rent/gifts/history/"
    stream = store.add_stream(run, kind, path, {"collection_address": COLLECTION})
    body = json.dumps({"cursor": None, "items": items}).encode()
    if valid:
        parsed = parse_page(kind, body)
    else:
        parsed = ParsedPage([NormalizedRecord(kind, item.get("address", item.get("nft_address", NFT)),
                                               json.dumps(item), item) for item in items], None)
    store.commit_page(stream, None, ApiResponse(body, 200, when), parsed)


def track(store, rows=(), subject=None, now=NOW):
    subject = subject or gift()
    changes = store.connection.total_changes
    enrich_price_tracking(store, [subject], WALLET, owned_price_observations=rows, now=now)
    assert store.connection.total_changes == changes
    return subject["price_tracking"]


def base_rows():
    return [ton(), ton(when=OLD), ton("170000001", CHANGED)]


def test_first_observation_is_a_baseline_and_never_a_change(store):
    empty = track(store)
    assert empty["coverage"] == "no_observations"
    assert empty["source"] is None and empty["baseline_price_per_day"] is None
    result = track(store, [ton()])
    assert result["baseline_price_per_day"] == "0.1"
    assert result["change_count"] == 0 and result["changes"] == []
    assert result["source"] == "TON contract"


def test_same_price_refresh_extends_old_observation_and_alias_replay_is_idempotent(store):
    rows = base_rows()
    alias = {**rows[-1], **{field: preferred_address(rows[-1][field]) for field in
                          ("wallet_address", "nft_address", "collection_address", "holding_contract", "owner", "marketplace")}}
    result = track(store, [*rows, alias, rows[-1]])
    assert result["observation_count"] == 3 and result["change_count"] == 1
    change = result["changes"][0]
    assert change["previous_observed_at"] == "2026-10-09T12:00:00.000000Z"
    assert change["from_price_per_day"] == "0.1" and change["to_price_per_day"] == "0.170000001"
    assert change["delta_per_day"] == "0.070000001" and change["percent_change"] == "70.000001"
    assert change["id"] == track(store, rows)["changes"][0]["id"]


def test_zero_baseline_has_unknown_percentage_and_exact_large_decimal_change(store):
    result = track(store, [ton("0"), ton("1", CHANGED)])
    assert result["changes"][0]["delta_per_day"] == "0.000000001"
    assert result["changes"][0]["percent_change"] is None
    large = "123456789012345678901234567890123456789"
    result = track(store, [ton(large), ton(str(int(large) + 1), CHANGED)])
    assert result["changes"][0]["delta_per_day"] == "0.000000001"


def test_sources_are_never_mixed_and_valid_ton_baseline_takes_precedence(store):
    save(store, "listing", [listing()], when=EARLY)
    save(store, "listing", [listing("350000000")], when=CHANGED)
    result = track(store, [ton("170000000", OLD)])
    assert result["source"] == "TON contract" and result["change_count"] == 0
    listing_only = track(store)
    assert listing_only["source"] == "Marketapp listing" and listing_only["change_count"] == 1
    failed = track(store, [ton(verified=False)])
    assert failed["source"] == "Marketapp listing" and "could not be verified" in " ".join(failed["warnings"])


@pytest.mark.parametrize("changes", [
    {"verified": False}, {"configured_price_per_day_raw": "0.1"}, {"configured_price_per_day_raw": True},
    {"holding_contract": None}, {"owner": addr(333)}, {"marketplace": addr(444)},
    {"code_hash_verified": False}, {"data_hash_verified": False}, {"rental_state": "held_directly"},
    {"currency": "TON"}, {"price_unit": "GRAM/day"},
    {"owner": None}, {"configured_price_per_day_raw": 100},
    {"code_hash": "unknown"}, {"data_hash": "invalid"}, {"nft": addr(11)}, {"observed_owner": addr(12)},
])
def test_unverified_scoped_price_evidence_breaks_continuity(store, changes):
    result = track(store, [ton(), ton(when=OLD, **changes), ton("170000000", CHANGED)])
    assert result["change_count"] == 0
    assert "interrupts the timeline" in " ".join(result["warnings"])


def test_wrong_wallet_and_nft_rows_never_cross_scope(store):
    for changes in ({"wallet_address": addr(55)}, {"nft_address": addr(55)}):
        result = track(store, [ton(), ton("999000000", OLD, **changes), ton("170000000", CHANGED)])
        assert result["change_count"] == 1 and result["changes"][0]["from_price_per_day"] == "0.1"
    assert track(store, base_rows(), gift(is_portfolio=False))["change_count"] == 0
    assert track(store, base_rows(), gift(collection_conflict=True))["change_count"] == 0


def test_conflicting_collection_for_same_scoped_nft_breaks_continuity(store):
    result = track(store, [ton(), ton("999000000", OLD, collection_address=addr(55)), ton("170000000", CHANGED)])
    assert result["change_count"] == 0


def test_holder_changes_owner_changes_and_simultaneous_conflicts_do_not_infer_changes(store):
    result = track(store, [ton(), ton("170000000", CHANGED, holding_contract=addr(77))])
    assert result["change_count"] == 0
    save(store, "listing", [listing()], when=EARLY)
    save(store, "listing", [listing("170000000", owner=addr(77))], when=CHANGED)
    assert track(store)["change_count"] == 0
    rows = [ton(), ton("120000000", OLD), ton("140000000", OLD), ton("170000000", CHANGED)]
    result = track(store, rows)
    assert result["change_count"] == 0 and result["observation_count"] == 2
    assert "conflicting" in " ".join(result["warnings"])


def test_equal_windows_exclude_uncertain_gap_and_are_half_open(store):
    save(store, "history", [event("2026-10-02T12:00:00Z"), event("2026-10-09T12:00:00Z"),
                            event("2026-10-09T18:00:00Z"), event("2026-10-10T12:00:00Z"),
                            event("2026-10-17T12:00:00Z")])
    comparison = track(store, base_rows())["changes"][0]["comparisons"][0]
    assert comparison["days"] == 7 and comparison["status"] == "ready" and comparison["comparable_days"] == "7"
    assert comparison["before"]["window_from"] == "2026-10-02T12:00:00.000000Z"
    assert comparison["before"]["recorded_rentals"] == comparison["after"]["recorded_rentals"] == 1
    assert comparison["after"]["window_to"] == "2026-10-17T12:00:00.000000Z"


def test_daily_rate_is_duration_weighted_and_amounts_are_whole_start_amounts(store):
    save(store, "history", [event("2026-10-11T12:00:00Z", "0.1", 86400),
                            event("2026-10-12T12:00:00Z", "0.9", 259200)])
    after = track(store, base_rows())["changes"][0]["comparisons"][0]["after"]
    assert after["recorded_rentals"] == 2
    assert after["recorded_volume"] == "1" and after["rental_days"] == "4"
    assert after["average_daily_rate"] == "0.25"
    assert "not accrued revenue or occupancy" in " ".join(track(store, base_rows())["warnings"])


def test_history_replays_aliases_missing_hash_and_reused_hash_do_not_add_weight(store):
    value = event("2026-10-11T12:00:00Z", tx_hash="same")
    alias = {**value, **{field: preferred_address(value[field]) for field in ("address", "collection_address", "src", "dst")}}
    save(store, "history", [value, value, alias,
                            event("2026-10-12T12:00:00Z", tx_hash="same"),
                            event("2026-10-13T12:00:00Z")])
    save(store, "history", [value])
    after = track(store, base_rows())["changes"][0]["comparisons"][0]["after"]
    assert after["recorded_rentals"] == 3 and after["recorded_volume"] == "0.9"


def test_changed_possible_events_and_ineligible_records_are_excluded_per_window(store):
    first = event("2026-10-11T12:00:00Z")
    save(store, "history", [first, {**first, "price": "0.9", "price_nano": "900000000"},
                            event("2026-10-12T12:00:00Z", currency="TON"),
                            event("2026-10-13T12:00:00Z", is_extend=True),
                            event("2026-10-14T12:00:00Z", price_nano="1"),
                            event("2026-10-15T12:00:00Z", duration=0),
                            event("2026-10-16T12:00:00Z", price="0", duration=86400),
                            event("2026-09-01T12:00:00Z", currency="USDT")])
    comparison = track(store, base_rows())["changes"][0]["comparisons"][0]
    after = comparison["after"]
    assert after["recorded_rentals"] == 1 and after["recorded_volume"] == "0"
    assert after["excluded_counts"] == {"ambiguous_history_variants": 2, "non_gram_currency": 1,
                                         "extensions": 1, "inconsistent_gram_amounts": 1,
                                         "missing_or_nonpositive_duration": 1}
    assert comparison["before"]["excluded_counts"] == {}


def test_missing_or_malformed_history_preserves_uncertainty_and_dated_exclusions(store):
    result = track(store, base_rows())
    assert "No saved rental history" in " ".join(result["warnings"])
    after = result["changes"][0]["comparisons"][0]["after"]
    assert after["recorded_rentals"] == 0 and after["average_daily_rate"] is None
    malformed = event("2026-10-11T12:00:00Z", src="")
    save(store, "history", [malformed, malformed], valid=False)
    after = track(store, base_rows())["changes"][0]["comparisons"][0]["after"]
    assert after["excluded_counts"] == {"malformed_history": 1}


def test_elapsed_and_structural_caps_produce_equal_pending_or_partial_windows(store):
    pending_now = datetime(2026, 10, 11, 12, tzinfo=timezone.utc)
    comparisons = track(store, base_rows(), now=pending_now)["changes"][0]["comparisons"]
    assert all(value["status"] == "pending" and value["comparable_days"] == "1" for value in comparisons)
    rows = [ton(), ton("120000000", "2026-10-08T12:00:00Z"), ton("120000000", OLD),
            ton("170000000", CHANGED), ton("170000000", "2026-10-12T12:00:00Z"),
            ton("190000000", "2026-10-13T12:00:00Z")]
    result = track(store, rows)
    middle = result["changes"][1]
    assert all(value["status"] == "partial" and value["comparable_days"] == "1" for value in middle["comparisons"])


@pytest.mark.parametrize("failed", [
    {"verified": False}, {"holding_contract": addr(77)},
])
def test_performance_stops_at_last_valid_point_before_failure_or_holder_movement(store, failed):
    rows = [*base_rows(), ton("170000001", "2026-10-12T12:00:00Z"),
            ton("170000001", "2026-10-14T12:00:00Z", **failed)]
    save(store, "history", [event("2026-10-11T12:00:00Z"), event("2026-10-13T12:00:00Z")])
    comparison = track(store, rows)["changes"][0]["comparisons"][0]
    assert comparison["status"] == "partial" and comparison["comparable_days"] == "2"
    assert comparison["after"]["window_to"] == "2026-10-12T12:00:00.000000Z"
    assert comparison["after"]["recorded_rentals"] == 1


def test_resumed_baseline_caps_before_window_after_uncertain_segment(store):
    rows = [ton(), ton(when="2026-10-04T12:00:00Z", verified=False),
            ton("170000000", "2026-10-06T12:00:00Z"), ton("170000000", OLD),
            ton("190000000", CHANGED)]
    comparison = track(store, rows)["changes"][0]["comparisons"][0]
    assert comparison["status"] == "partial" and comparison["comparable_days"] == "3"
    assert comparison["before"]["window_from"] == "2026-10-06T12:00:00.000000Z"


def test_zero_elapsed_comparison_is_pending_with_unknown_stats(store):
    result = track(store, base_rows(), now=datetime(2026, 10, 10, 12, tzinfo=timezone.utc))
    comparison = result["changes"][0]["comparisons"][0]
    assert comparison["status"] == "pending" and comparison["comparable_days"] == "0"
    assert comparison["after"]["recorded_rentals"] is None and comparison["before"]["recorded_volume"] is None


def test_history_is_independent_of_current_pricing_timeframe_and_backdrop(store, tmp_path, monkeypatch):
    class FrozenTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW
    monkeypatch.setattr("marketapp_rent.price_tracking.datetime", FrozenTime)
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address\n{NFT},{COLLECTION}\n")
    store.import_portfolio(portfolio)
    save(store, "listing", [listing()], when=EARLY)
    save(store, "listing", [listing("170000000")], when=CHANGED)
    save(store, "history", [event("2026-10-11T12:00:00Z")])
    first = build_dashboard(store, WALLET, pricing_source="listings", timeframe="24h")
    second = build_dashboard(store, WALLET, pricing_source="rentals", timeframe="90d", pricing_backdrop="Black")
    assert first["gifts"][0]["price_tracking"] == second["gifts"][0]["price_tracking"]


def test_payload_has_five_latest_changes_but_all_change_count_and_no_raw_sensitive_data(store):
    rows = [ton(str(index * 100000000), f"2026-10-{index + 1:02d}T12:00:00Z", secret="do-not-expose-private-field") for index in range(12)]
    result = track(store, rows)
    assert result["change_count"] == 11 and len(result["changes"]) == 5
    assert result["changes"][0]["to_price_per_day"] == "1.1"
    assert "secret" not in json.dumps(result) and "do-not-expose-private-field" not in json.dumps(result)


def test_future_observations_and_invalid_clock_are_not_current_tracking_evidence(store):
    assert track(store, [ton(when="2027-10-01T12:00:00Z")])["coverage"] == "no_observations"
    with pytest.raises(ValueError, match="timezone-aware"):
        track(store, now=datetime(2026, 10, 20))


def test_extreme_decimal_exponents_remain_unresolved_without_expanding_payloads(store):
    # Simulate legacy saved evidence; new ingestion rejects this magnitude.
    save(store, "history", [event("2026-10-11T12:00:00Z", price="0.3", price_nano="3e10000000")], valid=False)
    after = track(store, base_rows())["changes"][0]["comparisons"][0]["after"]
    assert after["recorded_rentals"] == 0 and after["excluded_counts"] == {"invalid_amount": 1}


def test_distant_decimal_scales_keep_the_exact_terminating_volume(store):
    tiny = event("2026-10-12T12:00:00Z")
    tiny.update(price="1e-1000", price_nano="1e-991")
    save(store, "history", [event("2026-10-11T12:00:00Z", price="1"), tiny])
    after = track(store, base_rows())["changes"][0]["comparisons"][0]["after"]
    assert after["recorded_rentals"] == 2
    assert after["recorded_volume"] == "1." + "0" * 999 + "1"
    assert after["average_daily_rate"] == "0.5"


def test_extreme_price_scale_and_unsupported_numeric_syntax_stay_bounded(store):
    values = [event("2026-10-11T12:00:00Z"), event("2026-10-12T12:00:00Z")]
    values[0].update(price="1e99999999", price_nano="1e100000008")
    values[1].update(price="1_000", price_nano="1000000000000")
    # Simulate legacy saved evidence; new ingestion rejects this magnitude.
    save(store, "history", values, valid=False)
    after = track(store, base_rows())["changes"][0]["comparisons"][0]["after"]
    assert after["recorded_rentals"] == 0 and after["excluded_counts"] == {"invalid_amount": 2}
    assert len(json.dumps(after)) < 500


@pytest.mark.parametrize("case", json.loads((Path(__file__).parent / "fixtures" / "price-tracking-parity.json").read_text())["cases"], ids=lambda case: case["name"])
def test_public_synthetic_desktop_and_telegram_parity_fixture(store, case):
    for row in case["listings"]:
        save(store, "listing", [row["item"]], when=row["observed_at"])
    for row in case["history"]:
        save(store, "history", row["items"], when=row["observed_at"])
    result = track(store, case["owned_prices"], subject=dict(case["gift"]), now=datetime.fromisoformat(case["now"]))
    result.pop("warnings")
    assert result == case["expected"]
