"""Untrusted decimal evidence cannot expand without bound during read/export."""

from decimal import Decimal
import json

import pytest

from marketapp_rent.dashboard_view import _decimal
from marketapp_rent.domain import ValidationError
from marketapp_rent.models import parse_page
from marketapp_rent.monetary import bounded_decimal, decimal_text
from marketapp_rent.reports import _cell
from marketapp_rent.util import canonical_json
from test_models import history, listing


UNSAFE = ("1e1000000000", "1e-1000000000", "0e1000000000", "9" * 1101, " " * 2200 + "1")


@pytest.mark.parametrize("value", UNSAFE)
def test_saved_amounts_are_excluded_without_expanding(value):
    assert _decimal(value) is None
    assert _decimal(value, nanos=True) is None
    with pytest.raises(ValueError):
        bounded_decimal(value)


@pytest.mark.parametrize("field", ["price", "price_nano"])
@pytest.mark.parametrize("value", UNSAFE)
def test_history_ingest_rejects_out_of_bounds_amounts_with_safe_error(field, value):
    body = json.dumps({"cursor": None, "items": [history(**{field: value})]}).encode()
    with pytest.raises(ValidationError) as error:
        parse_page("history", body)
    assert str(error.value) == "Invalid history response: does not match the pinned API contract"


@pytest.mark.parametrize("value", ["1e1000000000", "1e-1000000000", "0e1000000000"])
def test_unknown_json_numeric_fields_are_bounded_before_serialization(value):
    body = json.dumps({"cursor": None, "items": [history()]}).encode()
    body = body[:-1] + b',"future_metric":' + value.encode() + b'}'
    with pytest.raises(ValidationError):
        parse_page("history", body)
    with pytest.raises(ValueError):
        canonical_json({"future_metric": Decimal(value)})


def test_large_listing_integer_is_rejected_before_nano_conversion():
    item = listing(price_per_day="9" * 1101, discount_per_day=0)
    with pytest.raises(ValidationError):
        parse_page("listing", json.dumps({"cursor": None, "items": [item]}).encode())


def test_supported_large_and_tiny_amounts_stay_exact():
    large = "123456789012345678901234567890123456789"
    assert _decimal(large, nanos=True) == "123456789012345678901234567890.123456789"
    assert decimal_text("1e-1000") == "0." + "0" * 999 + "1"
    assert canonical_json(Decimal("1e-1000")) == "0." + "0" * 999 + "1"
    assert decimal_text("1e1000") == "1" + "0" * 1000
    assert _decimal("NaN") is None
    assert _decimal("-1") is None


@pytest.mark.parametrize("value", ["1e1000000000", "1e-1000000000", Decimal("1e1000000000")])
def test_export_keeps_unsafe_saved_amount_as_small_original_text(value):
    assert _cell("price", value) == str(value)
    assert _cell("floor", value) == str(value)
    assert len(_cell("price", value)) < 30


def test_export_still_escapes_formulas_and_formats_ordinary_amounts():
    assert _cell("price", "=1+1") == "'=1+1"
    assert _cell("price", "+1e1000000000") == "'+1e1000000000"
    assert _cell("price", "1.250e-2") == "0.01250"
