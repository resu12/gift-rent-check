"""Strict TON identities, with a compatibility key for older opaque CSV IDs."""

from __future__ import annotations

import base64
import binascii
import re

from pytoniq_core import Address

_RAW = re.compile(r"(-?\d+):([0-9a-fA-F]{64})\Z")
_FRIENDLY = re.compile(r"[A-Za-z0-9_+/-]{48}\Z")


def canonical_address(value: str, mainnet: bool = True) -> str:
    """Return workchain:hex; reject malformed, test-only and unknown addresses.

    Raw addresses have no network flag. The caller's mainnet context applies to
    those addresses. ``mainnet=False`` also accepts test-only friendly forms.
    """
    if not isinstance(value, str):
        raise ValueError("TON address must be a string")
    raw = _RAW.fullmatch(value)
    if raw:
        workchain = int(raw[1])
        if workchain not in {-1, 0}:
            raise ValueError("Unsupported TON workchain")
    else:
        if not _FRIENDLY.fullmatch(value):
            raise ValueError("Invalid TON address encoding")
        try:
            decoded = base64.b64decode(value, altchars=b"-_", validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("Invalid TON address encoding") from None
        if len(decoded) != 36 or decoded[0] not in {0x11, 0x51, 0x91, 0xD1}:
            raise ValueError("Invalid TON address flags")
        if decoded[34:] != binascii.crc_hqx(decoded[:34], 0).to_bytes(2, "big"):
            raise ValueError("Invalid TON address checksum")
        if mainnet and decoded[0] & 0x80:
            raise ValueError("A mainnet TON address is required")
        if int.from_bytes(decoded[1:2], "big", signed=True) not in {-1, 0}:
            raise ValueError("Unsupported TON workchain")
    try:
        return Address(value).to_str(is_user_friendly=False)
    except Exception:
        raise ValueError("Invalid TON address") from None


def address_key(value: str | None) -> str | None:
    """Canonical mainnet identity, or the exact legacy identifier supplied."""
    if value is None:
        return None
    try:
        return canonical_address(value)
    except ValueError:
        return value


def preferred_address(value: str | None) -> str | None:
    """Bounceable URL-safe mainnet form for requests; retain opaque legacy IDs."""
    if value is None:
        return None
    try:
        return Address(canonical_address(value)).to_str()
    except ValueError:
        return value
