"""Asking prices retain their own source date and never borrow active rental rates."""

import csv
import json

import pytest

from marketapp_rent.dashboard_view import _price_observation, build_dashboard
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.storage import Store

WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
COLLECTION = "0:" + "44" * 32
EARLY = "2026-10-08T10:00:00+00:00"
MIDDLE = "2026-10-08T11:00:00+00:00"
LATE = "2026-10-08T12:00:00+00:00"


def contract(when=MIDDLE, amount="390000000", verified=True, **extra):
    return {"nft_address": NFT, "wallet_address": WALLET, "collection_address": COLLECTION,
            "verified": verified, "observed_at": when, "rental_state": "rented",
            "configured_price_per_day_raw": amount, "price_per_day_raw": "350000000", **extra}


def review(ownership_at=EARLY, price_at=MIDDLE, amount="0.35"):
    return {"nft_address": NFT, "wallet_address": WALLET, "collection_address": COLLECTION,
            "category": "wallet_linked", "state": "rented", "observed_at": ownership_at,
            "reviewed_at": LATE, "recorded_owner_or_seller": WALLET,
            "verification_method": "supplemental_contract_review", "marketapp_ui_state": "rented",
            "marketapp_ui_reviewed_at": price_at, "marketapp_ui_source": "rented.png",
            "marketapp_ui_price_per_day": amount}


def listing(when=LATE, amount="0.39"):
    return {"observed_at": when, "data": {"nft_address": NFT, "price_per_day_gram": amount}}


def seed_ownership(store, row):
    ds = DiscoveryStore(store)
    run = ds.create_run(WALLET, {})
    ds.save_catalog(run, ApiResponse(b"[]", 200, row["observed_at"]), [COLLECTION])
    ds.add_candidates(run, [{"nft_address": NFT, "source": "holdings", "collection_address": COLLECTION}])
    ds.commit_verification(run, NFT, row, [])
    ds.finish_run(run, "complete")


def write_review(tmp_path, row):
    folder = tmp_path / "review"
    folder.mkdir()
    with (folder / "updated_inventory.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)
    return folder


def test_new_listing_wins_dated_screenshot_and_retains_price_timestamp(tmp_path):
    with Store(":memory:") as store:
        seed_ownership(store, contract(EARLY, "350000000"))
        folder = write_review(tmp_path, review())
        run = store.create_run({}, [COLLECTION], [])
        stream = store.add_stream(run, "listing", "/v1/rent/gifts/", {})
        data = listing()["data"]
        store.commit_page(stream, None, ApiResponse(b"{}", 200, LATE),
                          ParsedPage([NormalizedRecord("listing", NFT, json.dumps(data), data)], None))
        gift = build_dashboard(store, WALLET, folder)["gifts"][0]
        assert gift["price_per_day"] == "0.39"
        assert gift["price_source"] == "Marketapp listing"
        assert gift["price_observed_at"] == LATE
        assert gift["price_is_historical"] is False


def test_ownership_annotation_does_not_redate_or_override_newer_contract_asking_price(tmp_path):
    with Store(":memory:") as store:
        seed_ownership(store, contract(MIDDLE))
        folder = write_review(tmp_path, review(ownership_at=LATE, price_at=EARLY))
        gift = build_dashboard(store, WALLET, folder)["gifts"][0]
        assert gift["verification_method"] == "local_review_annotation"
        assert gift["price_per_day"] == "0.39"
        assert gift["price_source"] == "Observed contract terms"
        assert gift["price_observed_at"] == MIDDLE
        assert gift["price_is_historical"] is True


def test_newer_supplemental_contract_price_supersedes_screenshot_without_changing_review_state(tmp_path, monkeypatch):
    with Store(":memory:") as store:
        seed_ownership(store, contract(EARLY, "350000000"))
        folder = write_review(tmp_path, review())
        monkeypatch.setattr("marketapp_rent.dashboard_view._supplement", lambda *_: ({NFT: contract(LATE)}, []))
        gift = build_dashboard(store, WALLET, folder)["gifts"][0]
        assert gift["verification_method"] == "validated_supplemental_evidence"
        assert gift["price_per_day"] == "0.39"
        assert gift["price_observed_at"] == LATE
        assert gift["price_is_historical"] is False


def test_dated_ui_price_uses_its_own_timestamp_even_when_ownership_review_is_older(tmp_path):
    with Store(":memory:") as store:
        seed_ownership(store, contract(MIDDLE))
        folder = write_review(tmp_path, review(ownership_at=EARLY, price_at=LATE, amount="0.41"))
        gift = build_dashboard(store, WALLET, folder)["gifts"][0]
        assert gift["verification_method"] == "automatic"
        assert gift["price_per_day"] == "0.41"
        assert gift["price_observed_at"] == LATE
        assert gift["price_is_historical"] is True
        assert "dated user-supplied" in " ".join(gift["uncertainties"])


def test_failed_refresh_retains_earlier_verified_asking_price_as_historical():
    with Store(":memory:") as store:
        seed_ownership(store, contract(EARLY))
        seed_ownership(store, contract(LATE, "770000000", verified=False, reason="owner_mismatch"))
        gift = build_dashboard(store, WALLET)["gifts"][0]
        assert gift["price_per_day"] == "0.39"
        assert gift["price_observed_at"] == EARLY
        assert gift["price_is_historical"] is True
        assert gift["state"] == "uncertain"
        assert "historical observation" in " ".join(gift["uncertainties"])


@pytest.mark.parametrize("amount", [None, "", "NaN", "Infinity", "-1", True])
def test_missing_or_invalid_configured_asking_price_never_uses_ongoing_rental_rate(amount):
    result = _price_observation([], {}, [contract(amount=amount)], {})
    assert result["price_per_day"] is None
    assert result["price_observed_at"] is None


def test_absent_configured_asking_field_does_not_use_ongoing_rental_rate():
    row = contract()
    del row["configured_price_per_day_raw"]
    assert _price_observation([], {}, [row], {})["price_per_day"] is None


@pytest.mark.parametrize("amount", [0, "0"])
def test_explicit_zero_configured_asking_price_does_not_fall_back_to_active_rate(amount):
    assert _price_observation([], {}, [contract(amount=amount)], {})["price_per_day"] == "0"


def test_failed_contract_verification_cannot_supply_price_even_if_it_decoded_terms():
    assert _price_observation([], {}, [contract(verified=False)], {})["price_per_day"] is None


def test_same_timestamp_prefers_market_listing_then_ui_then_contract():
    direct = contract(MIDDLE)
    user_view = review(price_at=MIDDLE, amount="0.41")
    market = listing(MIDDLE, "0.42")
    assert _price_observation([market], user_view, [direct], {})["price_per_day"] == "0.42"
    assert _price_observation([], user_view, [direct], {})["price_per_day"] == "0.41"
    assert _price_observation([], {}, [direct], {})["price_per_day"] == "0.39"


def test_later_missing_price_keeps_previous_listing_value_and_original_date():
    result = _price_observation([listing(EARLY), listing(LATE, None)], {}, [], {})
    assert result["price_per_day"] == "0.39"
    assert result["price_observed_at"] == EARLY
    assert result["price_source"] == "Historical Marketapp listing"
    assert result["price_is_historical"] is True
