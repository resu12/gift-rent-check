"""Small serialization utilities shared by persistence and logging."""

import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def canonical_json(value: Any) -> str:
    """Stable JSON preserving Decimal as a JSON number, not a string/float."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Non-finite JSON number")
        # Avoid Decimal.normalize(): the ambient decimal context can round it.
        result = format(value, "f")
        if "." in result:
            result = result.rstrip("0").rstrip(".")
        return "0" if value.is_zero() else result
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(key), ensure_ascii=False) + ":" + canonical_json(value[key])
            for key in sorted(value)
        ) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
