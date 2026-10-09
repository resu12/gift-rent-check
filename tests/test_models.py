import json
from decimal import Decimal

import pytest

from marketapp_rent.domain import ValidationError
from marketapp_rent.models import parse_page
from marketapp_rent.util import canonical_json


def listing(**updates):
    return dict({
        "nft_address": "nft-1", "nft_name": "Gift #1", "owner": "owner-1",
        "attributes": [{"trait_type": "Model", "value": "Gold"}],
        "min_duration": 86400, "max_duration": 259200, "price_per_day": "1000000001",
        "discount_per_day": Decimal("0.12345678901234567890123456789"), "listed_at": None,
    }, **updates)


def history(**updates):
    return dict({
        "address": "nft-1", "name": "Gift #1", "collection_address": "collection-1",
        "ts": 987654, "src": "src-1", "dst": "dst-1", "price": "1.000000001",
        "price_nano": "1000000001", "currency": "GRAM",
    }, **updates)


def page(kind, items, cursor=None):
    body = items if kind == "collection" else {"cursor": cursor, "items": items}
    return parse_page(kind, canonical_json(body).encode())


def test_listing_exact_decimal_and_source_precision():
    source = listing()
    record = page("listing", [source], cursor="next?x=1").records[0]
    assert record.identity == "nft-1"
    assert record.data["price_per_day_nano"] == "1000000001"
    assert record.data["price_per_day_gram"] == "1.000000001"
    assert record.data["discount_per_day"] == "0.12345678901234567890123456789"
    assert record.data["min_duration_seconds"] == 86400
    assert record.data["max_duration_seconds"] == 259200
    assert record.data["listed_at"] is None
    assert json.loads(record.source_json, parse_float=Decimal) == source


def test_large_decimal_conversion_does_not_round():
    record = page("listing", [listing(price_per_day="123456789012345678901234567890123456789")]).records[0]
    assert record.data["price_per_day_gram"] == "123456789012345678901234567890.123456789"


@pytest.mark.parametrize("key", list(listing()))
def test_listing_requires_every_documented_field(key):
    source = listing()
    del source[key]
    with pytest.raises(ValidationError):
        page("listing", [source])


@pytest.mark.parametrize("updates", [
    {"price_per_day": 1000}, {"price_per_day": "1.1"}, {"price_per_day": "-1"},
    {"min_duration": "86400"}, {"listed_at": False}, {"owner": None},
    {"discount_per_day": "1.2"}, {"discount_per_day": True},
    {"attributes": [{"trait_type": "X", "value": None}]},
])
def test_listing_rejects_wrong_types(updates):
    with pytest.raises(ValidationError):
        page("listing", [listing(**updates)])


def test_history_optional_presence_null_and_explicit_defaults_distinct():
    absent = page("history", [history()]).records[0]
    explicit = page("history", [history(tx_hash=None, is_extend=False, duration=0)]).records[0]
    for field in ("tx_hash", "is_extend", "duration"):
        assert field not in absent.data
        assert field not in absent.data["source_fields"]
        assert field in explicit.data
        assert field in explicit.data["source_fields"]
    assert explicit.data["tx_hash"] is None
    assert explicit.data["duration"] == 0
    assert explicit.data["is_extend"] is False
    assert absent.source_json != explicit.source_json
    assert absent.data["ts"] == 987654
    assert absent.data["src"] == "src-1"
    assert absent.data["dst"] == "dst-1"


def test_history_gram_consistency_and_currency_separation():
    consistent = page("history", [history()]).records[0]
    inconsistent = page("history", [history(price="2")]).records[0]
    assert consistent.data["amounts_consistent"] is True
    assert inconsistent.data["amounts_consistent"] is False
    assert inconsistent.data["price"] == "2"
    assert inconsistent.data["price_nano"] == "1000000001"
    assert "inconsistent_gram_amounts" in inconsistent.data["uncertainties"]
    for currency in ("TON", "USDT"):
        record = page("history", [history(currency=currency)]).records[0]
        assert record.data["currency"] == currency
        assert record.data["amounts_consistent"] is None
        assert "price_gram" not in record.data


@pytest.mark.parametrize("updates", [
    {"currency": "USD"}, {"price": "NaN"}, {"price_nano": "Infinity"},
    {"price": "unknown"}, {"price_nano": 1}, {"ts": "987654"},
    {"duration": None}, {"is_extend": None},
])
def test_history_rejects_invalid_types_and_nonfinite_prices(updates):
    with pytest.raises(ValidationError):
        page("history", [history(**updates)])


def test_history_preserves_unknown_fields_and_changed_variants():
    original = page("history", [history(tx_hash="same-tx", extra="original")]).records[0]
    changed = page("history", [history(tx_hash="same-tx", extra="changed")]).records[0]
    assert original.identity == changed.identity
    assert original.source_json != changed.source_json
    assert original.data["extra"] == "original"


def test_collection_empty_and_nullable_stats_preserved_without_defaults():
    records = page("collection", [
        {"address": "c1", "name": "One", "extra_data": {}},
        {"address": "c2", "name": "Two", "extra_data": {"floor": None, "rent_floor": "0.5", "items": 0}},
    ]).records
    assert "items" not in records[0].data
    assert records[0].data["extra_data_fields"] == []
    assert records[1].data["floor"] is None
    assert records[1].data["items"] == 0
    assert records[1].data["rent_floor"] == "0.5"
    assert records[1].data["collection_address"] == "c2"
    assert "rent_floor_gram" not in records[1].data


def test_attribute_values_flattened_without_inserting_defaults():
    result = parse_page("attribute", b'{"attributes":[{"trait_type":"Model","values":[{"value":"A"},{"value":"B","count":0,"perc":0.1234567890123456789,"rent_floor":""}]}]}')
    first, second = result.records
    assert first.identity == "Model\0A"
    assert "count" not in first.data
    assert "perc" not in first.data
    assert "floor" not in first.data
    assert second.data["count"] == 0
    assert second.data["perc"] == "0.1234567890123456789"
    assert second.data["rent_floor"] == ""
    assert result.next_cursor is None


@pytest.mark.parametrize("body", [
    b'{"attributes":[{"trait_type":"Model","values":[{"value":"A","count":null}]}]}',
    b'{"attributes":[{"trait_type":"Model","values":[{"value":"A","floor":null}]}]}',
    b'{"attributes":[{"trait_type":"Model","values":[{"value":"A","perc":"0.1"}]}]}',
])
def test_attribute_optional_fields_nonnullable_and_strict_when_supplied(body):
    with pytest.raises(ValidationError):
        parse_page("attribute", body)


@pytest.mark.parametrize("body", [
    b"not json secret-token", b'{"items":[]}', b'{"cursor":0,"items":[]}',
    b'{"cursor":null,"items":{}}', b'{"cursor":null,"items":[],"bad":NaN}',
    b'{"cursor":null,"cursor":"duplicate","items":[]}',
])
def test_malformed_pages_fail_with_safe_message(body):
    with pytest.raises(ValidationError) as caught:
        parse_page("listing", body)
    assert "secret-token" not in str(caught.value)


def test_empty_page_with_cursor_retains_continuation():
    result = page("listing", [], cursor="")
    assert result.next_cursor == ""
    assert result.records == []
    assert page("history", [], cursor="next").next_cursor == "next"


def test_normalization_is_canonical_across_json_key_order():
    first = page("history", [history()]).records[0]
    reverse = dict(reversed(list(history().items())))
    second = page("history", [reverse]).records[0]
    assert first.source_json == second.source_json
