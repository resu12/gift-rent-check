import base64
import json
from pathlib import Path

import pytest
from pytoniq_core import Address, Builder, Cell

from marketapp_rent.addresses import canonical_address
from marketapp_rent.ton_decoder import (
    CONTRACT_VARIANTS, DECODER_VERSION, MARKETAPP_OPERATOR, OBSERVED_7F44_CODE_HASH,
    STORAGE_LAYOUT_VERSION, SUPPORTED_CODE_HASH, SUPPORTED_CODE_HASHES, decode_contract,
)

FIXTURES = Path(__file__).parent / "fixtures" / "ton"
WALLET = "UQC3PX8rXmcy22kJazMuSSXTzeIISgB4fXBo-_6GH60EObwF"
WHEN = "2026-10-08T14:40:00+00:00"


def fixture(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def sample(which):
    if isinstance(which, str):
        saved = fixture(which)
        account = saved["account"]
        account["code_boc"] = (FIXTURES / saved["code_fixture"]).read_text().strip()
        nft = saved["nft_before"]
        return {
            "nft_address": nft["address"], "holding_contract": nft["owner_address"],
            "collection_address": nft["collection_address"],
        }, account
    item = fixture("verified-samples")["samples"][which]
    account = next(account for account in fixture("holder-states")["body"]["accounts"]
                   if canonical_address(account["address"]) == canonical_address(item["holding_contract"]))
    return item, account


def decode(which=0, mutate=None, when=WHEN):
    item, account = sample(which)
    if mutate:
        mutate(account)
    return decode_contract(account, item["nft_address"], WALLET, when)


def replace_ref(account, index, new_ref):
    data = Cell.one_from_boc(account["data_boc"])
    refs = list(data.refs)
    refs[index] = new_ref
    updated = Cell(data.bits, refs)
    account["data_boc"] = base64.b64encode(updated.to_boc()).decode()
    account["data_hash"] = updated.hash.hex()


def change_identity(account, **overrides):
    data = Cell.one_from_boc(account["data_boc"])
    source = data.refs[0].begin_parse()
    fields = {"owner": source.load_address(), "nft": source.load_address(), "marketplace": source.load_address(),
              "created_at": source.load_uint(64), "role": source.load_uint(2)}
    fields.update(overrides)
    builder = Builder().store_address(fields["owner"]).store_address(fields["nft"]).store_address(fields["marketplace"])
    replace_ref(account, 0, builder.store_uint(fields["created_at"], 64).store_uint(fields["role"], 2).end_cell())


def getter_value(record):
    kind, value = record
    if kind == "num":
        return int(value, 16)
    address = Cell.one_from_boc(value["bytes"]).begin_parse().load_address()
    return None if address is None else address.to_str(is_user_friendly=False)


@pytest.mark.parametrize("index,prefix,state", [(0, "for-rent", "idle_rental_contract"), (1, "rented", "rented")])
def test_saved_samples_cross_checked_against_independent_getter_results(index, prefix, state):
    item, account = sample(index)
    result = decode(index)
    assert result["verified"] and result["rental_state"] == state
    assert result["decoder_version"] == DECODER_VERSION
    assert result["contract_variant"] == "marketapp-observed-f3b93b1d-v1"
    assert result["storage_layout_version"] == STORAGE_LAYOUT_VERSION
    assert result["code_hash_verified"] and result["data_hash_verified"]
    assert result["owner"] == canonical_address(WALLET)
    assert result["nft"] == canonical_address(item["nft_address"])
    assert result["marketplace"] == MARKETAPP_OPERATOR
    identity = fixture(f"{prefix}-identity")["body"]["result"]
    state_result = fixture(f"{prefix}-state")["body"]["result"]
    assert identity["exit_code"] == state_result["exit_code"] == 0
    assert [result[field] for field in ("owner", "nft", "marketplace", "created_at", "role")] == list(map(getter_value, identity["stack"]))
    expected_state = list(map(getter_value, state_result["stack"]))
    expected_state[3] = str(expected_state[3])
    assert [result[field] for field in ("status", "rental_duration", "rental_until", "price_per_day_raw", "renter", "counterpart")] == expected_state
    nft = next(n for n in fixture("sample-nfts")["body"]["nft_items"]
               if canonical_address(n["address"]) == result["nft"])
    assert canonical_address(nft["owner_address"]) == result["holding_contract"]
    assert canonical_address(nft["collection_address"]) == canonical_address(item["collection_address"])


def test_pinned_code_fixture_hash():
    code = Cell.one_from_boc((FIXTURES / "observed-code.boc.base64").read_text().strip())
    assert code.hash.hex() == SUPPORTED_CODE_HASH


def test_expired_rental_not_claimed_returned_or_available():
    result = decode(1, when="2026-10-10T00:00:00+00:00")
    assert result["verified"]
    assert result["rental_state"] == "expired_pending_return"


@pytest.mark.parametrize("which", [0, "7f44-idle", "7f44-rented"])
@pytest.mark.parametrize("field,reason", [("owner", "owner_mismatch"), ("nft", "nft_mismatch"), ("marketplace", "operator_mismatch")])
def test_identity_mismatch_is_never_enrolled(which, field, reason):
    result = decode(which, mutate=lambda a: change_identity(a, **{field: Address("0:" + "11" * 32)}))
    assert not result["verified"] and result["reason"] == reason


@pytest.mark.parametrize("which", [0, "7f44-idle", "7f44-rented"])
@pytest.mark.parametrize("change,reason", [
    ({"status": "frozen"}, "inactive_contract"),
    ({"suspended": True}, "inactive_contract"),
    ({"code_hash": "00" * 32}, "unsupported_code_hash"),
    ({"code_hash": "invalid"}, "invalid_hash"),
    ({"data_hash": "00" * 32}, "boc_hash_mismatch"),
    ({"code_boc": "broken"}, "invalid_contract_data"),
    ({"data_boc": "broken"}, "invalid_contract_data"),
    ({"data_boc": None}, "invalid_contract_data"),
])
def test_invalid_or_unsupported_contracts_remain_unverified(which, change, reason):
    result = decode(which, mutate=lambda a: a.update(change))
    assert not result["verified"] and result["reason"] == reason


def test_spoofed_supported_hash_rejected_by_computed_code_root():
    alternate = base64.b64encode(Builder().end_cell().to_boc()).decode()
    result = decode(mutate=lambda a: a.update(code_boc=alternate))
    assert result["reason"] == "boc_hash_mismatch" and not result["verified"]


@pytest.mark.parametrize("which", [0, "7f44-idle", "7f44-rented"])
def test_strict_layout_rejects_extra_bits_refs_and_unknown_role(which):
    def extra_bits(account):
        data = Cell.one_from_boc(account["data_boc"])
        extra = Builder().store_slice(data.refs[0].begin_parse()).store_uint(0, 1).end_cell()
        replace_ref(account, 0, extra)
    def extra_ref(account):
        data = Cell.one_from_boc(account["data_boc"])
        extra = Builder().store_slice(data.refs[1].begin_parse()).store_ref(Builder().end_cell()).end_cell()
        replace_ref(account, 1, extra)
    for mutate in (extra_bits, extra_ref, lambda a: change_identity(a, role=2)):
        result = decode(which, mutate=mutate)
        assert not result["verified"] and result["reason"] == "invalid_contract_data"


def test_missing_account_data_does_not_raise():
    for account in (None, {}, {"address": "bogus"}):
        assert not decode_contract(account, "nft", WALLET, WHEN)["verified"]
    assert decode(when="not-a-date")["reason"] == "invalid_account"


def test_malformed_boc_crc_is_rejected():
    def mutate(account):
        raw = bytearray(base64.b64decode(account["data_boc"]))
        raw[-1] ^= 1
        account["data_boc"] = base64.b64encode(raw).decode()
    assert not decode(mutate=mutate)["verified"]


@pytest.mark.parametrize("which", ["7f44-idle", "7f44-rented"])
def test_second_variant_public_samples_match_independent_review(which):
    saved = fixture(which)
    item, account = sample(which)
    result = decode(which, when=saved["account_observed_at"])
    assert result["verified"] and result["reason"] == "verified_rental_owner"
    assert result["decoder_version"] == "marketapp-rental-registry-v2"
    assert result["contract_variant"] == "marketapp-observed-7f44bead-v1"
    assert result["storage_layout_version"] == STORAGE_LAYOUT_VERSION
    assert result["code_hash"] == OBSERVED_7F44_CODE_HASH
    assert result["code_hash_verified"] and result["data_hash_verified"]
    expected = dict(saved["expected"])
    expected["owner"] = expected.pop("recorded_owner")
    expected["nft"] = expected.pop("decoded_nft")
    assert {key: result[key] for key in expected} == expected
    assert result["owner"] == canonical_address(saved["wallet_address"])
    assert result["nft"] == canonical_address(item["nft_address"])
    assert result["marketplace"] == MARKETAPP_OPERATOR
    before, after = saved["nft_before"], saved["nft_after"]
    assert canonical_address(before["owner_address"]) == result["holding_contract"]
    assert canonical_address(before["address"]) == result["nft"]
    assert canonical_address(before["owner_address"]) == canonical_address(after["owner_address"])
    assert before["last_transaction_lt"] == after["last_transaction_lt"]


def test_exact_immutable_two_hash_registry_and_shared_boc_pin():
    assert set(CONTRACT_VARIANTS) == SUPPORTED_CODE_HASHES == {SUPPORTED_CODE_HASH, OBSERVED_7F44_CODE_HASH}
    with pytest.raises(TypeError):
        CONTRACT_VARIANTS["00" * 32] = "unreviewed"
    code = Cell.one_from_boc((FIXTURES / "observed-7f44-code.boc.base64").read_text().strip())
    assert code.hash.hex() == OBSERVED_7F44_CODE_HASH
    assert CONTRACT_VARIANTS[SUPPORTED_CODE_HASH] != CONTRACT_VARIANTS[OBSERVED_7F44_CODE_HASH]


def test_claiming_one_accepted_variant_with_other_variants_boc_still_fails():
    result = decode("7f44-idle", mutate=lambda a: a.update(code_hash=SUPPORTED_CODE_HASH))
    assert not result["verified"] and result["reason"] == "boc_hash_mismatch"
    assert not result["code_hash_verified"] and result["data_hash_verified"]
    assert result["contract_variant"] is None


def test_unregistered_legacy_variant_is_not_enabled_by_layout_similarity():
    legacy_hash = "42c6cb85fc037291674a2c61a0dae6756df24f39b6ec8bca463b79fb7564d141"
    result = decode("7f44-idle", mutate=lambda a: a.update(code_hash=legacy_hash))
    assert not result["verified"] and result["reason"] == "unsupported_code_hash"
    assert result["contract_variant"] is None


def test_second_variant_expiration_retains_ownership_without_claiming_return():
    result = decode("7f44-rented", when="2030-01-01T00:00:00+00:00")
    assert result["verified"] and result["rental_state"] == "expired_pending_return"
    assert result["contract_variant"] == "marketapp-observed-7f44bead-v1"


def test_new_registry_version_rejects_previous_discovery_resume(tmp_path):
    from marketapp_rent.discovery import discover
    from marketapp_rent.discovery_config import DiscoverySettings
    from marketapp_rent.discovery_store import DiscoveryStore
    from marketapp_rent.storage import Store

    old_version = "marketapp-observed-f3b93b1d-v1"
    assert DECODER_VERSION != old_version
    with Store(tmp_path / "old-discovery.sqlite3") as store:
        run_id = DiscoveryStore(store).create_run(WALLET, {
            "page_size": 100, "batch_size": 100, "decoder_version": old_version,
        })
        with pytest.raises(ValueError, match="Decoder version changed; start a fresh discovery run"):
            discover(store, DiscoverySettings(), "", resume_id=run_id)
