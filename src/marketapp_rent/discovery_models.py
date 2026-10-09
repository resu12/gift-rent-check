"""Validate TON envelopes without inventing absent metadata or ownership."""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, BeforeValidator, TypeAdapter
from pydantic import ValidationError as PydanticValidationError

from .addresses import canonical_address
from .domain import ValidationError
from .models import _reject_constant, _unique_object


def _address(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Expected TON address")
    canonical_address(value)
    return value


def logical_time(value: Any) -> int:
    if isinstance(value, bool) or not (isinstance(value, int) or isinstance(value, str) and value.isascii() and value.isdigit()):
        raise ValueError("Expected unsigned logical time")
    result = int(value)
    if not 0 <= result < 2 ** 64:
        raise ValueError("Logical time outside uint64")
    return result


Address = Annotated[str, BeforeValidator(_address)]
# TON Center can use "" for absent optional metadata, including aborted
# transfers. Validation accepts that sentinel; parse_ton still returns the
# untouched original object so missing, null and empty remain distinguishable.
OptionalAddress = Annotated[Address | None, BeforeValidator(lambda value: None if value == "" else value)]
LogicalTime = Annotated[int, BeforeValidator(logical_time)]


class TonModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="allow")


class Item(TonModel):
    address: Address
    owner_address: OptionalAddress = None
    collection_address: OptionalAddress = None
    collection: dict | None = None
    init: bool | None = None
    last_transaction_lt: LogicalTime | None = None
    content: dict | None = None


class Transfer(TonModel):
    nft_address: Address
    old_owner: OptionalAddress = None
    new_owner: OptionalAddress = None
    nft_collection: OptionalAddress = None
    transaction_lt: LogicalTime
    transaction_aborted: bool


class Account(TonModel):
    address: Address
    status: str
    suspended: bool | None = None
    code_hash: str | None = None
    data_hash: str | None = None
    code_boc: str | None = None
    data_boc: str | None = None
    last_transaction_lt: LogicalTime | None = None


_ADAPTERS = {"nft_items": TypeAdapter(list[Item]), "nft_transfers": TypeAdapter(list[Transfer]), "accounts": TypeAdapter(list[Account])}


def parse_ton(body: bytes, key: str) -> list[dict]:
    """Return original objects after strict structural and address validation."""
    try:
        document = json.loads(body, parse_float=Decimal, parse_constant=_reject_constant, object_pairs_hook=_unique_object)
        if not isinstance(document, dict) or key not in document:
            raise ValueError("Missing response envelope")
        _ADAPTERS[key].validate_python(document[key])
        return document[key]
    except (ValueError, TypeError, KeyError, UnicodeError, PydanticValidationError) as exc:
        raise ValidationError(f"Invalid TON {key} response; checkpoint unchanged") from exc


def item_collection(item: dict) -> tuple[str | None, str | None]:
    """Compare independent fields on the current item, not its display name."""
    collection = item.get("collection_address") or None
    nested = (item.get("collection") or {}).get("address") or None
    if nested is not None:
        try:
            nested = canonical_address(nested)
        except (ValueError, TypeError):
            return None, "invalid_collection_metadata"
    collection = canonical_address(collection) if collection is not None else None
    if nested and collection and nested != collection:
        return None, "collection_conflict"
    return collection or nested, None
