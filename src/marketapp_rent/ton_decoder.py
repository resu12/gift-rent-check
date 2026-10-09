"""Decode the pinned, observed Marketapp rental contract storage variants.

This is local parsing, not a VM invocation or transaction. A hash allowlist is
mandatory: explorer interface labels and similar-looking layouts are not proof.
"""

from __future__ import annotations

import base64
import re
from datetime import datetime
from types import MappingProxyType

from pytoniq_core import Address, Cell

from .addresses import canonical_address

DECODER_VERSION = "marketapp-rental-registry-v2"
# Retain the original constant for integrations that pin the first fixture.
SUPPORTED_CODE_HASH = "f3b93b1d262f709aff1ec25ae39141a7ecdd8c8a29b87a2b6bb1cdab4aec714a"
OBSERVED_7F44_CODE_HASH = "7f44beadf4911724268d7008c490be627f203047fea4d3276b51bdfd55bf23fc"
CONTRACT_VARIANTS = MappingProxyType({
    SUPPORTED_CODE_HASH: "marketapp-observed-f3b93b1d-v1",
    OBSERVED_7F44_CODE_HASH: "marketapp-observed-7f44bead-v1",
})
SUPPORTED_CODE_HASHES = frozenset(CONTRACT_VARIANTS)
STORAGE_LAYOUT_VERSION = "marketapp-four-refs-two-fees-v1"
MARKETAPP_OPERATOR = "0:9a9cb80adfbd1662f5108766d73355ac2c03304fda1d25a479670e34efcd72b3"


def hash_hex(value: str) -> str:
    """TON Center hashes are normally base64, but hex forms are equivalent."""
    if not isinstance(value, str):
        raise ValueError("Missing hash")
    if re.fullmatch(r"[0-9a-fA-F]{64}", value):
        return value.lower()
    decoded = base64.b64decode(value, altchars=b"-_", validate=True)
    if len(decoded) != 32:
        raise ValueError("Invalid hash size")
    return decoded.hex()


def _address(source, *, nullable: bool = False) -> str | None:
    address = source.load_address()
    if address is None and nullable:
        return None
    if not isinstance(address, Address) or address.anycast is not None:
        raise ValueError("Expected ordinary internal address")
    return canonical_address(address.to_str(is_user_friendly=False))


def _finished(source) -> None:
    if source.remaining_bits or source.remaining_refs:
        raise ValueError("Unexpected trailing storage")


def decode_contract(account: dict, nft: str, wallet: str, observed_at: str) -> dict:
    """Return evidence; unsupported or invalid records remain unverified.

    The caller must also prove this account is the NFT's current holder, and
    recheck NFT owner/lt after the account read. This function proves only the
    identity and state encoded in this account snapshot.
    """
    result = {
        "verified": False, "reason": "invalid_account", "rental_state": "unknown",
        "decoder_version": DECODER_VERSION, "observed_at": observed_at,
        "contract_variant": None, "storage_layout_version": None,
        "holding_contract": None, "code_hash": None, "data_hash": None,
        "code_hash_verified": False, "data_hash_verified": False,
        "account_last_transaction_lt": None, "owner": None, "nft": None,
        "marketplace": None, "created_at": None, "role": None, "status": None,
        "rental_duration": None, "rental_until": None, "price_per_day_raw": None,
        "renter": None, "counterpart": None,
    }
    if not isinstance(account, dict):
        return result
    try:
        expected_nft = canonical_address(nft)
        expected_owner = canonical_address(wallet)
        result["holding_contract"] = canonical_address(account["address"])
        result["account_last_transaction_lt"] = account.get("last_transaction_lt")
        instant = datetime.fromisoformat(observed_at)
        if instant.tzinfo is None:
            raise ValueError("Observation must include timezone")
    except (ValueError, KeyError, TypeError):
        return result
    if account.get("status") != "active" or account.get("suspended") is True:
        result["reason"] = "inactive_contract"
        return result
    try:
        result["code_hash"] = hash_hex(account.get("code_hash"))
        result["data_hash"] = hash_hex(account.get("data_hash"))
    except (ValueError, TypeError):
        result["reason"] = "invalid_hash"
        return result
    variant = CONTRACT_VARIANTS.get(result["code_hash"])
    if variant is None:
        result["reason"] = "unsupported_code_hash"
        return result
    try:
        # A single ordinary root is required; pytoniq validates BOC CRC and
        # structure. Recompute both roots rather than trusting indexer hashes.
        code = Cell.one_from_boc(account["code_boc"])
        data = Cell.one_from_boc(account["data_boc"])
        result["code_hash_verified"] = code.hash.hex() == result["code_hash"]
        result["data_hash_verified"] = data.hash.hex() == result["data_hash"]
        if not result["code_hash_verified"] or not result["data_hash_verified"]:
            result["reason"] = "boc_hash_mismatch"
            return result
        # Both independently reviewed variants have this storage layout and
        # these getter bodies. Their fee/external handlers differ, so preserve
        # the exact variant identity instead of treating their code as equal.
        result["contract_variant"] = variant
        result["storage_layout_version"] = STORAGE_LAYOUT_VERSION
        if data.type_ != -1 or len(data.bits) != 256 or len(data.refs) != 4:
            raise ValueError("Unexpected root layout")
        if any(cell.type_ != -1 or cell.refs for cell in data.refs):
            raise ValueError("Unexpected child layout")

        identity = data.refs[0].begin_parse()
        result.update(owner=_address(identity), nft=_address(identity), marketplace=_address(identity))
        result["created_at"] = identity.load_uint(64)
        result["role"] = identity.load_uint(2)
        _finished(identity)
        if result["role"] not in {0, 1}:
            raise ValueError("Unsupported contract role")

        state = data.refs[1].begin_parse()
        result["status"] = state.load_uint(3)
        result["rental_duration"] = state.load_uint(32)
        result["rental_until"] = state.load_uint(64)
        # Integers representing contract coins stay decimal strings. Units
        # and payment semantics are not generalized to Marketapp history.
        result["price_per_day_raw"] = str(state.load_coins())
        result["renter"] = _address(state, nullable=True)
        result["counterpart"] = _address(state, nullable=True)
        _finished(state)

        settings = data.refs[2].begin_parse()
        result["auto_relist"] = bool(settings.load_uint(1))
        result["min_duration_raw"] = settings.load_uint(32)
        result["max_duration_raw"] = settings.load_uint(32)
        result["configured_price_per_day_raw"] = str(settings.load_coins())
        result["discount_per_day_raw"] = settings.load_uint(32)
        result["discount_denominator_raw"] = settings.load_uint(32)
        result["max_discount_raw"] = settings.load_uint(32)
        result["sale_price_raw"] = str(settings.load_coins())
        _finished(settings)

        fees = data.refs[3].begin_parse()
        result["fee_recipient"] = _address(fees)
        result["fee_numerator_raw"] = fees.load_uint(32)
        result["fee_denominator_raw"] = fees.load_uint(32)
        result["extra_fee_recipient"] = _address(fees)
        result["extra_fee_numerator_raw"] = fees.load_uint(32)
        result["extra_fee_denominator_raw"] = fees.load_uint(32)
        _finished(fees)
    except Exception:
        # Third-party BOC parsers use several exception families for malformed
        # cells. Those are untrusted provider data, not a reason to stop a run.
        result["reason"] = "invalid_contract_data"
        return result
    for key, expected, reason in (
        ("owner", expected_owner, "owner_mismatch"),
        ("nft", expected_nft, "nft_mismatch"),
        ("marketplace", MARKETAPP_OPERATOR, "operator_mismatch"),
    ):
        if result[key] != expected:
            result["reason"] = reason
            return result
    result.update(verified=True, reason="verified_rental_owner")
    if (result["role"], result["status"]) == (0, 0) and result["renter"] is None and result["rental_until"] == 0:
        result["rental_state"] = "idle_rental_contract"
    elif (result["role"], result["status"]) == (1, 1) and result["renter"] is not None and result["counterpart"] is not None and result["rental_until"] > 0:
        result["rental_state"] = "rented" if result["rental_until"] > instant.timestamp() else "expired_pending_return"
    return result
