"""Targeted TON asking prices stay separate from portfolio and market evidence."""

import json

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.storage import Store


WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
OTHER = "0:" + "33" * 32
COLLECTION = "0:" + "44" * 32
EARLY = "2026-10-08T10:00:00+00:00"
MIDDLE = "2026-10-08T11:00:00+00:00"
LATE = "2026-10-08T12:00:00+00:00"
CHECKED = "2026-10-08T12:00:01+00:00"


def check(**changes):
    return {"wallet_address": WALLET, "nft_address": NFT, "collection_address": COLLECTION,
            "verified": True, "configured_price_per_day_raw": "390000000",
            "price_per_day_raw": "990000000", "observed_at": LATE, "checked_at": CHECKED,
            "reason": "verified_rental_owner", **changes}


def seed_owner(store, *, verified=True):
    discovery = DiscoveryStore(store)
    run = discovery.create_run(WALLET, {})
    discovery.save_catalog(run, ApiResponse(b"[]", 200, EARLY), [COLLECTION])
    discovery.add_candidates(run, [{"nft_address": NFT, "source": "holdings", "collection_address": COLLECTION}])
    discovery.commit_verification(run, NFT, {
        "wallet_address": WALLET, "nft_address": NFT, "collection_address": COLLECTION,
        "verified": verified, "observed_at": EARLY, "rental_state": "idle_rental_contract",
        "configured_price_per_day_raw": "350000000", "holding_contract": OTHER,
        "reason": "verified_rental_owner" if verified else "unsupported_code_hash",
    }, [])
    discovery.finish_run(run, "complete")


def seed_market(store, kind="listing", when=MIDDLE, amount="0.37"):
    run = store.create_run({}, [COLLECTION], [])
    path = "/v1/rent/gifts/" if kind == "listing" else "/v1/rent/gifts/history/"
    stream = store.add_stream(run, kind, path, {"collection_address": COLLECTION})
    data = {"nft_address": NFT, "nft_name": "Example Gift #7", "price_per_day_gram": amount} if kind == "listing" else {
        "nft_address": NFT, "price": "0.2", "currency": "GRAM", "price_nano": "200000000",
        "timestamp": "1791453000", "duration": 86400, "is_extend": False,
    }
    store.commit_page(stream, None, ApiResponse(b"{}", 200, when),
                      ParsedPage([NormalizedRecord(kind, NFT, json.dumps(data), data)], None))


def project(store, rows=(), **options):
    return build_dashboard(store, WALLET, owned_price_observations=rows,
                           timeframe="custom", date_from="2026-10-08", date_to="2026-10-08", **options)


def test_price_refresh_updates_only_price_evidence_and_never_ownership_or_marketplace_visibility():
    with Store(":memory:") as store:
        seed_owner(store)
        seed_market(store)
        before = project(store)
        changes = store.connection.total_changes
        after = project(store, [check(rental_state="rented", holding_contract="untrusted", name="ignored")])
        assert store.connection.total_changes == changes
        original, updated = before["gifts"][0], after["gifts"][0]
        assert updated["price_per_day"] == "0.39"
        assert updated["price_source"] == "Observed contract terms"
        assert updated["price_observed_at"] == LATE
        assert updated["price_checked_at"] == CHECKED
        assert updated["price_is_historical"] is False
        for field in ("state", "display_state", "ui_state", "is_portfolio", "automatic_membership",
                      "membership_sources", "proof_badges", "verification_method", "name", "holding_contract",
                      "observed_at", "market_observed_at", "last_listing_observed_at", "collection_address",
                      "traits", "pricing", "rental_history"):
            assert updated.get(field) == original.get(field), field
        for field in ("summary", "coverage", "runs", "activity", "pricing"):
            assert after[field] == before[field], field


def test_failed_price_check_retains_last_success_without_invalidating_saved_ownership():
    with Store(":memory:") as store:
        seed_owner(store)
        earlier = check(observed_at=MIDDLE, checked_at=MIDDLE)
        failed = check(verified=False, reason="owner_mismatch", configured_price_per_day_raw="770000000")
        result = project(store, [earlier, failed])
        gift = result["gifts"][0]
        assert gift["is_portfolio"] and gift["automatic_membership"]
        assert gift["state"] == "idle_rental_contract"
        assert gift["observed_at"] == EARLY
        assert gift["price_per_day"] == "0.39"
        assert gift["price_observed_at"] == MIDDLE
        assert gift["price_checked_at"] == CHECKED
        assert gift["price_check_reason"] == "owner_mismatch"
        assert gift["price_is_historical"] is True
        assert "could not verify current configured terms" in " ".join(gift["uncertainties"])


@pytest.mark.parametrize("changes", [
    {"wallet_address": OTHER}, {"nft_address": OTHER}, {"collection_address": OTHER},
    {"wallet_address": None}, {"nft_address": "bad-address"}, {"collection_address": None},
])
def test_price_checks_cannot_cross_wallet_nft_or_collection_boundaries(changes):
    with Store(":memory:") as store:
        seed_owner(store)
        before, after = project(store), project(store, [check(**changes)])
        assert after["gifts"] == before["gifts"]


def test_canonical_address_aliases_match_the_existing_member():
    with Store(":memory:") as store:
        seed_owner(store)
        gift = project(store, [check(wallet_address=preferred_address(WALLET),
                                     nft_address=preferred_address(NFT),
                                     collection_address=preferred_address(COLLECTION))])["gifts"][0]
        assert gift["price_per_day"] == "0.39"


def test_unresolved_candidate_never_becomes_portfolio_member_through_price_check():
    with Store(":memory:") as store:
        seed_owner(store, verified=False)
        before, after = project(store), project(store, [check()])
        assert after["gifts"] == before["gifts"]
        assert after["summary"]["portfolio_count"] == 0


def test_price_refresh_does_not_add_a_new_gift_or_resolve_collection_conflicts(tmp_path):
    with Store(":memory:") as store:
        assert project(store, [check()])["gifts"] == []
        seed_owner(store)
        csv = tmp_path / "portfolio.csv"
        csv.write_text(f"nft_address,collection_address\n{NFT},{OTHER}\n")
        store.import_portfolio(csv)
        before, after = project(store), project(store, [check()])
        assert after["gifts"] == before["gifts"]
        assert after["gifts"][0]["collection_conflict"] is True


@pytest.mark.parametrize("when,expected,source", [
    (EARLY, "0.37", "Marketapp listing"),
    (MIDDLE, "0.37", "Marketapp listing"),
    (LATE, "0.39", "Observed contract terms"),
])
def test_asking_price_uses_own_timestamp_and_marketapp_wins_ties(when, expected, source):
    with Store(":memory:") as store:
        seed_owner(store)
        seed_market(store)
        gift = project(store, [check(observed_at=when)])["gifts"][0]
        assert gift["price_per_day"] == expected
        assert gift["price_source"] == source
        assert gift["price_is_historical"] is False


def test_later_market_listing_supersedes_failed_ton_check():
    with Store(":memory:") as store:
        seed_owner(store)
        seed_market(store, when=LATE)
        gift = project(store, [check(verified=False, observed_at=MIDDLE, checked_at=MIDDLE)])["gifts"][0]
        assert gift["price_per_day"] == "0.37"
        assert gift["price_is_historical"] is False
        assert "could not verify current configured terms" not in " ".join(gift["uncertainties"])


@pytest.mark.parametrize("amount,expected", [
    ("1", "0.000000001"), ("0", "0"),
    ("123456789012345678901234567890", "123456789012345678901.23456789"),
])
def test_exact_integer_nanogram_conversion(amount, expected):
    with Store(":memory:") as store:
        seed_owner(store)
        assert project(store, [check(configured_price_per_day_raw=amount)])["gifts"][0]["price_per_day"] == expected


@pytest.mark.parametrize("amount", [None, "", "-1", "NaN", "Infinity", True, "1.2", 1.2, "1e9"])
def test_invalid_configured_price_never_falls_back_to_active_rental_price(amount):
    with Store(":memory:") as store:
        seed_owner(store)
        gift = project(store, [check(configured_price_per_day_raw=amount)])["gifts"][0]
        assert gift["price_per_day"] == "0.35"
        assert gift["price_observed_at"] == EARLY
        assert gift["price_is_historical"] is True


def test_missing_configured_price_does_not_borrow_active_rental_price():
    with Store(":memory:") as store:
        seed_owner(store)
        row = check()
        del row["configured_price_per_day_raw"]
        gift = project(store, [row])["gifts"][0]
        assert gift["price_per_day"] == "0.35"
        assert gift["price_is_historical"] is True


def test_conflicting_simultaneous_configured_prices_remain_uncertain():
    with Store(":memory:") as store:
        seed_owner(store)
        gift = project(store, [check(), check(configured_price_per_day_raw="410000000")])["gifts"][0]
        assert gift["price_per_day"] == "0.35"
        assert gift["price_is_historical"] is True
        assert "Conflicting simultaneous TON" in " ".join(gift["uncertainties"])


@pytest.mark.parametrize("source", ["listings", "rentals"])
def test_refresh_never_redates_history_or_enters_market_comparison_samples(source):
    with Store(":memory:") as store:
        seed_owner(store)
        seed_market(store)
        seed_market(store, kind="history")
        history_before = store.observations("history")
        before = project(store, pricing_source=source)
        after = project(store, [check()], pricing_source=source)
        assert after["gifts"][0]["price_per_day"] == "0.39"
        assert after["gifts"][0]["pricing"] == before["gifts"][0]["pricing"]
        assert after["gifts"][0]["rental_history"] == before["gifts"][0]["rental_history"]
        assert {key: value for key, value in after["pricing"].items() if key != "generated_at"} == {
            key: value for key, value in before["pricing"].items() if key != "generated_at"}
        assert after["activity"] == before["activity"]
        assert after["coverage"]["latest_market"] == before["coverage"]["latest_market"]
        assert store.observations("history") == history_before
