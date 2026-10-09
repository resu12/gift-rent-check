"""Validate the pinned API contract and retain observed field presence.

Schema defaults are deliberately not copied to the normalized data: absent,
explicitly null, and supplied zero values represent different evidence.
"""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, TypeAdapter
from pydantic import ValidationError as PydanticValidationError

from .domain import NormalizedRecord, ParsedPage, ValidationError
from .util import canonical_json


def _number(value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise ValueError("expected a JSON number")
    number = Decimal(value)
    if not number.is_finite():
        raise ValueError("expected a finite JSON number")
    return number


Number = Annotated[Decimal, BeforeValidator(_number)]


class ApiModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="allow")


class NFTAttribute(ApiModel):
    trait_type: str
    value: str | int | Number


class Listing(ApiModel):
    nft_address: str
    nft_name: str
    owner: str
    attributes: list[NFTAttribute]
    min_duration: int
    max_duration: int
    price_per_day: Annotated[str, Field(pattern=r"^\d+$")]
    discount_per_day: Number
    listed_at: int | None


class ListingPage(ApiModel):
    cursor: str | None
    items: list[Listing]


class History(ApiModel):
    address: str
    name: str
    collection_address: str
    ts: int
    src: str
    dst: str
    price: str
    price_nano: str
    currency: Literal["GRAM", "TON", "USDT"]
    tx_hash: str | None = None
    is_extend: bool = False
    duration: int = 0


class HistoryPage(ApiModel):
    cursor: str | None
    items: list[History]


class CollectionStats(ApiModel):
    items: int | None = None
    floor: str | None = None
    rent_floor: str | None = None
    volume7d: str | None = None
    volume30d: str | None = None
    owners: int | None = None
    on_sale_all: int | None = None
    on_sale_onchain: int | None = None


class Collection(ApiModel):
    name: str
    address: str
    extra_data: CollectionStats


class AttributeValue(ApiModel):
    value: str
    count: int = 0
    perc: Number = Decimal(0)
    floor: str = ""
    rent_floor: str = ""


class CollectionAttribute(ApiModel):
    trait_type: str
    values: list[AttributeValue]


class AttributePage(ApiModel):
    attributes: list[CollectionAttribute]


def _reject_constant(value: str) -> None:
    raise ValueError("non-finite JSON constant")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _decimal_string(value: str) -> Decimal:
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("invalid monetary decimal") from exc
    if not result.is_finite():
        raise ValueError("non-finite monetary decimal")
    return result


def _nano_to_gram(value: Decimal) -> Decimal:
    # Changing the exponent is exact even for values exceeding Decimal's
    # default 28-digit arithmetic precision.
    parts = value.as_tuple()
    return Decimal((parts.sign, parts.digits, parts.exponent - 9))


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    return value


def _record(kind: str, identity: str, source: dict, data: dict) -> NormalizedRecord:
    data["source_fields"] = sorted(source)
    return NormalizedRecord(
        kind=kind, identity=identity, source_json=canonical_json(source), data=_json_safe(data)
    )


def _listing(source: dict) -> NormalizedRecord:
    data = dict(source)
    data["price_per_day_nano"] = data.pop("price_per_day")
    data["price_per_day_gram"] = format(
        _nano_to_gram(_decimal_string(source["price_per_day"])), "f"
    )
    data["min_duration_seconds"] = data.pop("min_duration")
    data["max_duration_seconds"] = data.pop("max_duration")
    data["discount_per_day"] = format(Decimal(source["discount_per_day"]), "f")
    data["uncertainties"] = ["discount_calculation_unspecified"]
    return _record("listing", source["nft_address"], source, data)


def _history(source: dict) -> NormalizedRecord:
    data = dict(source)
    data["nft_address"] = data.pop("address")
    # Validate the supplied amounts without imposing undocumented scale or
    # assuming that non-GRAM currencies use nine fractional places.
    price = _decimal_string(source["price"])
    nano = _decimal_string(source["price_nano"])
    data["amounts_consistent"] = None
    data["uncertainties"] = [
        "timestamp_unit_unspecified", "duration_unit_unspecified",
        "src_dst_roles_unspecified", "gross_net_payment_unspecified",
    ]
    if source["currency"] == "GRAM":
        data["price_gram"] = source["price"]
        data["amounts_consistent"] = price == _nano_to_gram(nano)
        if not data["amounts_consistent"]:
            data["uncertainties"].append("inconsistent_gram_amounts")
    else:
        data["uncertainties"].append("non_gram_price_scale_unspecified")
    return _record("history", source["address"], source, data)


def _collection(source: dict) -> NormalizedRecord:
    data = {key: value for key, value in source.items() if key not in {"address", "extra_data"}}
    data["collection_address"] = source["address"]
    # Known statistics have no overlapping collection properties. Preserve any
    # future overlapping extension under extra_data rather than losing it.
    for key, value in source["extra_data"].items():
        if key in data:
            data.setdefault("extra_data", {})[key] = value
        else:
            data[key] = value
    data["extra_data_fields"] = sorted(source["extra_data"])
    data["uncertainties"] = ["collection_monetary_units_unspecified"]
    return _record("collection", source["address"], source, data)


def parse_page(kind: str, body: bytes) -> ParsedPage:
    """Validate an entire page before producing any normalized records.

    Error messages intentionally exclude response input, which can contain
    credentials or arbitrarily large untrusted data.
    """
    if kind not in {"listing", "history", "collection", "attribute"}:
        raise ValidationError("Unsupported response kind")
    try:
        raw = json.loads(
            body, parse_float=Decimal, parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
        if kind == "listing":
            ListingPage.model_validate(raw)
            return ParsedPage(records=[_listing(item) for item in raw["items"]], next_cursor=raw["cursor"])
        if kind == "history":
            HistoryPage.model_validate(raw)
            return ParsedPage(records=[_history(item) for item in raw["items"]], next_cursor=raw["cursor"])
        if kind == "collection":
            TypeAdapter(list[Collection]).validate_python(raw, strict=True)
            return ParsedPage(records=[_collection(item) for item in raw], next_cursor=None)
        AttributePage.model_validate(raw)
        records = []
        for attribute in raw["attributes"]:
            for value in attribute["values"]:
                source = {"trait_type": attribute["trait_type"], **value}
                data = dict(source)
                data["uncertainties"] = ["attribute_floor_units_unspecified"]
                records.append(_record("attribute", attribute["trait_type"] + "\0" + value["value"], source, data))
        return ParsedPage(records=records, next_cursor=None)
    except (ValueError, TypeError, UnicodeError, PydanticValidationError) as exc:
        raise ValidationError(f"Invalid {kind} response: does not match the pinned API contract") from None
