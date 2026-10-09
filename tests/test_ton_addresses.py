import base64
import binascii

import pytest
from pytoniq_core import Address

from marketapp_rent.addresses import address_key, canonical_address, preferred_address

WALLET = "UQC3PX8rXmcy22kJazMuSSXTzeIISgB4fXBo-_6GH60EObwF"
RAW = "0:b73d7f2b5e6732db69096b332e4925d3cde2084a00787d7068fbfe861fad0439"


def test_equivalent_addresses_share_identity_and_preferred_form():
    bounceable = Address(RAW).to_str()
    standard_base64 = Address(RAW).to_str(is_url_safe=False)
    for value in (WALLET, bounceable, RAW, RAW.upper(), standard_base64):
        assert canonical_address(value) == RAW
        assert address_key(value) == RAW
        assert preferred_address(value) == bounceable
    master = "-1:" + "ab" * 32
    assert canonical_address(Address(master).to_str()) == master


@pytest.mark.parametrize("value", [None, 4, "", "0:abc", "0:" + "aa" * 31,
                                      "1:" + "aa" * 32, " " + WALLET, WALLET + " ", WALLET[:-1] + "x"])
def test_invalid_addresses_rejected(value):
    with pytest.raises(ValueError):
        canonical_address(value)


def test_mainnet_and_friendly_flag_validation():
    test_only = Address(RAW).to_str(is_test_only=True)
    with pytest.raises(ValueError, match="mainnet"):
        canonical_address(test_only)
    assert canonical_address(test_only, mainnet=False) == RAW
    data = bytearray(base64.urlsafe_b64decode(WALLET))
    data[0] = 0x12
    data[34:] = binascii.crc_hqx(data[:34], 0).to_bytes(2, "big")
    with pytest.raises(ValueError, match="flags"):
        canonical_address(base64.urlsafe_b64encode(data).decode())


def test_opaque_legacy_identifiers_are_preserved_exactly():
    for value in (None, "nft-one", "OLD arbitrary identifier", "0:abc"):
        assert address_key(value) == value
        assert preferred_address(value) == value
