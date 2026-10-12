"""Current-rental starts come from pinned verified storage, never check timestamps."""

from datetime import datetime, timezone
import json
from pathlib import Path

import pytest

from marketapp_rent.addresses import canonical_address
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse
from marketapp_rent.storage import Store
from marketapp_rent.ton_decoder import (
    CONTRACT_VARIANTS, DECODER_VERSION, MARKETAPP_OPERATOR, STORAGE_LAYOUT_VERSION, decode_contract,
)

WALLET, NFT, COLLECTION = ("0:" + byte * 64 for byte in ("1", "2", "3"))
HOLDER, RENTER, COUNTERPART = ("0:" + byte * 64 for byte in ("4", "5", "6"))
OBSERVED = "2026-10-08T11:00:00+00:00"
CHECKED = "2026-10-08T11:00:01+00:00"
LATER = "2026-10-08T12:00:00+00:00"
START = int(datetime.fromisoformat(OBSERVED).timestamp()) - 3600


def evidence(**changes):
    code_hash = next(iter(CONTRACT_VARIANTS))
    return {
        "wallet_address": WALLET, "nft_address": NFT, "collection_address": COLLECTION,
        "verified": True, "rental_state": "rented", "observed_at": CHECKED,
        "contract_observed_at": OBSERVED, "nft_rechecked_at": CHECKED,
        "owner": WALLET, "nft": NFT, "marketplace": MARKETAPP_OPERATOR,
        "holding_contract": HOLDER, "renter": RENTER, "counterpart": COUNTERPART,
        "nft_last_transaction_lt": "100", "account_last_transaction_lt": "101",
        "code_hash": code_hash, "contract_variant": CONTRACT_VARIANTS[code_hash],
        "storage_layout_version": STORAGE_LAYOUT_VERSION, "decoder_version": DECODER_VERSION,
        "code_hash_verified": True, "data_hash_verified": True, "data_hash": "a" * 64,
        "role": 1, "status": 1, "rental_duration": 7200, "rental_until": START + 7200,
        "rental_duration_unit": "seconds", "rental_until_unit": "Unix seconds", "created_at": START,
        "reason": "verified_rental_owner", **changes,
    }


def commit(store, row):
    ds = DiscoveryStore(store)
    run = ds.create_run(row["wallet_address"], {})
    ds.save_catalog(run, ApiResponse(b"[]", 200, row["observed_at"]), [row["collection_address"]])
    ds.add_candidates(run, [{"nft_address": row["nft_address"], "source": "holdings", "collection_address": row["collection_address"]}])
    ds.commit_verification(run, row["nft_address"], row, [])
    ds.finish_run(run, "complete")


def projected(store, wallet=WALLET, **kwargs):
    return build_dashboard(store, wallet, **kwargs)["gifts"][0]


@pytest.mark.parametrize("code_hash", list(CONTRACT_VARIANTS))
def test_pinned_contract_start_is_exact_and_extensions_preserve_it_without_writes(code_hash):
    with Store(":memory:") as store:
        original = evidence(code_hash=code_hash, contract_variant=CONTRACT_VARIANTS[code_hash])
        commit(store, original)
        baseline = store.connection.total_changes
        gift = projected(store)
        assert gift["current_rental_started_at"] == datetime.fromtimestamp(START, timezone.utc).isoformat()
        assert gift["current_rental_start_source"] == "verified_contract"
        assert gift["status_is_historical"] is False
        assert store.connection.total_changes == baseline
        commit(store, {**original, "observed_at": LATER, "nft_rechecked_at": LATER,
                       "rental_duration": 7200 + 86400, "rental_until": START + 7200 + 86400})
        assert projected(store)["current_rental_started_at"] == gift["current_rental_started_at"]


def test_expired_pending_return_keeps_original_start_without_claiming_return_or_income():
    with Store(":memory:") as store:
        commit(store, evidence(rental_state="expired_pending_return", rental_duration=1800, rental_until=START + 1800))
        gift = projected(store)
        assert gift["current_rental_started_at"] == datetime.fromtimestamp(START, timezone.utc).isoformat()
        assert gift["state"] == "expired_pending_return"
        assert gift["current_rental_start_source"] == "verified_contract"


@pytest.mark.parametrize("change", [
    {"verified": False}, {"rental_state": "idle_rental_contract"}, {"rental_state": "held_directly"},
    {"code_hash": "0" * 64}, {"code_hash_verified": False}, {"data_hash_verified": False},
    {"data_hash": "bad"}, {"storage_layout_version": "unknown"}, {"contract_variant": "unknown"},
    {"owner": HOLDER}, {"nft": HOLDER}, {"marketplace": HOLDER}, {"holding_contract": "bad"},
    {"renter": None}, {"counterpart": None}, {"role": 0}, {"role": True}, {"status": 0},
    {"rental_duration": 0}, {"rental_duration": -1}, {"rental_duration": "7200"}, {"rental_duration": 4294967296},
    {"rental_until": "1791476400"}, {"rental_until": 0}, {"rental_until": 253402300800},
    {"rental_until": START + 7201}, {"rental_duration_unit": "days"}, {"rental_until_unit": "nanoseconds"},
    {"created_at": None}, {"created_at": True}, {"created_at": START - 1}, {"created_at_unit": "milliseconds"},
    {"contract_observed_at": None}, {"nft_rechecked_at": OBSERVED, "contract_observed_at": CHECKED},
    {"nft_last_transaction_lt": None}, {"account_last_transaction_lt": "bad"},
])
def test_invalid_or_incompatible_evidence_leaves_start_unknown(change):
    with Store(":memory:") as store:
        commit(store, evidence(**change))
        gift = projected(store)
        assert gift["current_rental_started_at"] is None
        assert gift["current_rental_start_source"] is None


def test_absent_creation_field_is_supported_but_observation_dates_are_never_substituted():
    with Store(":memory:") as store:
        row = evidence()
        row.pop("created_at")
        commit(store, row)
        assert projected(store)["current_rental_started_at"] == datetime.fromtimestamp(START, timezone.utc).isoformat()
        later = {**row, "observed_at": LATER, "nft_rechecked_at": LATER, "rental_duration": None,
                 "current_rental_started_at": LATER, "current_rental_start_source": "verified_contract"}
        commit(store, later)
        assert projected(store)["current_rental_started_at"] is None


def test_later_failed_check_or_conflicting_collection_clears_start_without_deleting_membership(tmp_path):
    with Store(":memory:") as store:
        commit(store, evidence())
        commit(store, evidence(verified=False, rental_state="unknown", observed_at=LATER, nft_rechecked_at=LATER))
        gift = projected(store)
        assert gift["is_portfolio"] and gift["automatic_membership"]
        assert gift["current_rental_started_at"] is None
    with Store(":memory:") as store:
        commit(store, evidence())
        csv = tmp_path / "portfolio.csv"
        csv.write_text(f"nft_address,collection_address\n{NFT},{HOLDER}\n")
        store.import_portfolio(csv)
        gift = projected(store)
        assert gift["collection_conflict"] is True and gift["is_portfolio"]
        assert gift["current_rental_started_at"] is None


def test_later_personal_review_cannot_reuse_a_contract_start_from_an_incompatible_state(tmp_path):
    folder = tmp_path / "review"
    folder.mkdir()
    (folder / "updated_inventory.csv").write_text(
        "nft_address,wallet_address,collection_address,category,state,observed_at,reviewed_at,verification_method,recorded_owner_or_seller\n"
        f"{NFT},{WALLET},{COLLECTION},wallet_linked,idle_rental_contract,{LATER},{LATER},local_review,{WALLET}\n")
    with Store(":memory:") as store:
        commit(store, evidence())
        gift = projected(store, review_path=folder)
        assert gift["state"] == "idle_rental_contract"
        assert gift["current_rental_started_at"] is None
        assert gift["current_rental_start_source"] is None


def test_saved_public_rented_contract_fixture_projects_its_verified_creation_start():
    fixtures = Path(__file__).parent / "fixtures" / "ton"
    saved = json.loads((fixtures / "7f44-rented.json").read_text())
    account = {**saved["account"], "code_boc": (fixtures / saved["code_fixture"]).read_text().strip()}
    nft = saved["nft_after"]
    wallet = canonical_address(saved["wallet_address"])
    row = decode_contract(account, nft["address"], wallet, saved["account_observed_at"])
    assert row["verified"] is True
    row.update(wallet_address=wallet, nft_address=canonical_address(nft["address"]),
               collection_address=canonical_address(nft["collection_address"]),
               contract_observed_at=saved["account_observed_at"], nft_rechecked_at=saved["nft_after_observed_at"],
               observed_at=saved["nft_after_observed_at"], nft_last_transaction_lt=str(nft["last_transaction_lt"]),
               rental_duration_unit="seconds", rental_until_unit="Unix seconds")
    with Store(":memory:") as store:
        commit(store, row)
        gift = projected(store, wallet)
        assert gift["current_rental_started_at"] == datetime.fromtimestamp(saved["expected"]["created_at"], timezone.utc).isoformat()
        assert gift["current_rental_start_source"] == "verified_contract"
