"""Per-gift rental starts use all saved evidence, not the pricing sample."""

from datetime import datetime, timezone
import json

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.models import parse_page
from marketapp_rent.rental_counts import enrich_rental_counts
from marketapp_rent.storage import Store


NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
RECENT = "2026-10-08T11:00:00+00:00"


def addr(number):
    return f"0:{number:064x}"


def event(number=1, **changes):
    return {"address": addr(number), "collection_address": addr(100), "name": "Shared gift name",
            "src": addr(900), "dst": addr(901), "ts": int(NOW.timestamp()) - 3600,
            "price": "0.6", "price_nano": "600000000", "currency": "GRAM",
            "duration": 259200, "is_extend": False, "tx_hash": f"hash-{number}", **changes}


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "rental-counts.sqlite3") as database:
        yield database


def save(store, values, *, when=RECENT, valid=True, cursor=None):
    run = store.create_run({}, [addr(100)], [])
    stream = store.add_stream(run, "history", "/v1/rent/gifts/history/", {"collection_address": addr(100)})
    body = json.dumps({"cursor": cursor, "items": values}).encode()
    parsed = parse_page("history", body) if valid else ParsedPage([
        NormalizedRecord("history", item["address"], json.dumps(item), item) for item in values
    ], cursor)
    store.commit_page(stream, None, ApiResponse(body, 200, when), parsed)
    return stream


def count(store, nft=None, **gift_fields):
    gift = {"nft_address": nft or addr(1), "is_portfolio": True, **gift_fields}
    enrich_rental_counts(store, [gift], now=NOW)
    return gift["rental_history"]


def test_repeated_rentals_count_across_all_saved_dates_and_partial_streams(store):
    old = int(NOW.timestamp()) - 900 * 86400
    save(store, [event(ts=old), event(tx_hash="new-tx")], cursor="more-history")
    result = count(store)
    assert result["recorded_count"] == 2
    assert result["coverage"] == "partial"
    assert result["first_rental_at"] == datetime.fromtimestamp(old, timezone.utc).isoformat()
    assert result["last_rental_at"] == RECENT
    assert "independent of the pricing timeframe" in result["note"]
    assert "during your ownership" in result["note"]


def test_page_replays_and_address_aliases_add_no_extra_count(store):
    value = event()
    save(store, [value, value])
    save(store, [value], when="2026-10-08T11:30:00+00:00")
    alias = {**value, **{field: preferred_address(value[field]) for field in
                        ("address", "collection_address", "src", "dst")}}
    save(store, [alias])
    result = count(store, preferred_address(addr(1)))
    assert result["recorded_count"] == 1
    assert result["observed_at"] == "2026-10-08T11:30:00+00:00"
    assert result["excluded_counts"] == {}
    assert len(store.observations("history")) == 4


def test_hashes_link_records_without_being_unique_event_identifiers(store):
    save(store, [event(tx_hash="shared"), event(2, tx_hash="shared"),
                 event(ts=int(NOW.timestamp()) - 7200, tx_hash="shared")])
    assert count(store)["recorded_count"] == 2
    assert count(store, addr(2))["recorded_count"] == 1


def test_missing_transaction_hash_is_not_required_for_an_observed_start(store):
    missing = event(ts=int(NOW.timestamp()) - 7200)
    del missing["tx_hash"]
    save(store, [event(tx_hash=None), missing])
    assert count(store)["recorded_count"] == 2


@pytest.mark.parametrize("change", [
    {"price": "0.9", "price_nano": "900000000"},
    {"tx_hash": "changed-hash"},
    {"is_extend": True},
    {"collection_address": addr(101)},
])
def test_ambiguous_changed_representations_do_not_claim_extra_rentals(store, change):
    save(store, [event(), event(**change)])
    result = count(store)
    assert result["recorded_count"] is None
    assert result["coverage"] == "partial"
    assert result["excluded_counts"] == {"ambiguous_history_variants": 2}
    assert len(store.records("history")) == 2


def test_confirmed_count_survives_other_ambiguous_events_as_a_partial_count(store):
    save(store, [event(), event(price="0.7", price_nano="700000000"),
                 event(ts=int(NOW.timestamp()) - 7200, tx_hash="older")])
    result = count(store)
    assert result["recorded_count"] == 1
    assert result["excluded_counts"] == {"ambiguous_history_variants": 2}
    assert "excluded" in result["note"]


def test_extensions_and_unknown_extension_status_are_not_new_rentals(store):
    missing = event(ts=int(NOW.timestamp()) - 7200)
    del missing["is_extend"]
    save(store, [event(is_extend=True), missing])
    result = count(store)
    assert result["recorded_count"] is None
    assert result["excluded_counts"] == {"extensions": 1, "unknown_extension_status": 1}


@pytest.mark.parametrize("changes", [
    {"price": "0", "price_nano": "0", "duration": 0},
    {"price_nano": "1", "duration": -1},
    {"currency": "TON"},
    {"currency": "USDT"},
])
def test_count_is_independent_of_amount_currency_and_duration_rate_eligibility(store, changes):
    save(store, [event(**changes)])
    assert count(store)["recorded_count"] == 1


def test_missing_duration_still_counts_an_explicit_rental_start(store):
    value = event()
    del value["duration"]
    save(store, [value])
    assert count(store)["recorded_count"] == 1


def test_clear_return_actions_are_not_counted_as_rental_starts(store):
    save(store, [event(action="return"), event(ts=int(NOW.timestamp()) - 7200, event_type="cancelled")])
    result = count(store)
    assert result["recorded_count"] is None
    assert result["excluded_counts"] == {"non_rental_action": 2}


@pytest.mark.parametrize("changes", [
    {"is_extend": None}, {"ts": 0}, {"ts": int(NOW.timestamp()) + 1},
    {"ts": int(NOW.timestamp()) * 1000}, {"src": ""},
])
def test_malformed_or_future_evidence_is_not_a_confirmed_rental(store, changes):
    save(store, [event(**changes)], valid=False)
    result = count(store)
    assert result["recorded_count"] is None
    assert result["excluded_counts"] == {"malformed_history": 1}


def test_no_records_and_empty_completed_history_do_not_infer_zero_rentals(store):
    assert count(store)["recorded_count"] is None
    save(store, [])
    result = count(store)
    assert result["recorded_count"] is None
    assert result["coverage"] == "no_history"
    assert result["observed_at"] is None
    assert "never been rented" in result["note"]


def test_same_name_other_gifts_and_nonportfolio_candidates_do_not_gain_owned_count(store):
    save(store, [event(2)])
    assert count(store)["recorded_count"] is None
    result = count(store, addr(2), is_portfolio=False)
    assert result["recorded_count"] is None
    assert result["coverage"] == "not_applicable"
    assert result["observed_at"] is None


def test_legacy_identifiers_keep_exact_identity_matching(store):
    save(store, [event(address="opaque-gift")])
    assert count(store, "opaque-gift")["recorded_count"] == 1
    assert count(store, "OPAQUE-GIFT")["recorded_count"] is None


def test_future_observation_is_not_current_evidence(store):
    save(store, [event()], when="2027-10-08T11:00:00+00:00")
    assert count(store)["recorded_count"] is None


def test_now_must_be_timezone_aware(store):
    with pytest.raises(ValueError, match="timezone-aware"):
        enrich_rental_counts(store, [], now=datetime(2026, 10, 8))
