"""Validated, wallet-scoped snapshots of Marketapp's personal rent page.

This module never contacts Marketapp and never accepts a website session. The
daily figures are provider-rounded gross volumes, not payments received after
fees. Saving a newer snapshot does not discard its predecessors.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .addresses import canonical_address

MAX_SNAPSHOT_BYTES = 256 * 1024
SOURCE = "marketapp_personal_rent_page"
_MAX_COUNT = 9_007_199_254_740_991
_TABLE = "personal_analytics_snapshots"
_UNKNOWN = {"", "—", "–", "-"}
_DECIMAL_TEXT = re.compile(r"(?:0|[1-9]\d*)(?:\.\d{1,4})?\Z")
_DATE_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
_SUMMARY_LABELS = {
    "Rent volume", "Rentals", "Price per day", "Average duration", "Extensions", "Spent on rent"
}
_PERIODS = {f"last{days}days" for days in (7, 14, 30, 60, 90, 180, 365)}
_GROUPS = {"auto", "day", "week", "month"}


class PersonalAnalyticsError(ValueError):
    """The browser snapshot cannot safely represent personal analytics."""


def _error(message: str) -> PersonalAnalyticsError:
    return PersonalAnalyticsError(message)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _error("Snapshot JSON contains a duplicate field")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise _error("Snapshot JSON contains a non-finite number")


def _json(raw: str) -> Any:
    try:
        return json.loads(raw, parse_float=Decimal, parse_int=Decimal,
                          parse_constant=_invalid_constant, object_pairs_hook=_unique_pairs)
    except PersonalAnalyticsError:
        raise
    except (ValueError, TypeError, RecursionError, InvalidOperation):
        raise _error("Snapshot contains invalid JSON") from None


def _object(value: Any, description: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _error(f"{description} must be an object")
    return value


def _decimal(value: Any, description: str, *, nullable: bool = False, max_adjusted: int = 23) -> Decimal | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (Decimal, int)):
        raise _error(f"{description} must be a nonnegative decimal")
    result = Decimal(value)
    # Bound exponents as well as input size before fixed-point formatting.
    if (not result.is_finite() or result < 0 or result.as_tuple().exponent < -4
            or result.adjusted() > max_adjusted):
        raise _error(f"{description} must be finite, nonnegative and have at most four decimals")
    return result


def _money(value: Decimal | None) -> str | None:
    if value is None:
        return None
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return "0" if value == 0 else result


def _count(value: Any, description: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (Decimal, int)):
        raise _error(f"{description} must be a nonnegative integer")
    result = Decimal(value)
    if not result.is_finite() or result < 0 or result > _MAX_COUNT or result != result.to_integral_value():
        raise _error(f"{description} must be a nonnegative integer")
    return int(result)


def _summary_decimal(value: Any, description: str, suffix: str = "", *, nullable: bool = True) -> Decimal | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise _error(f"{description} summary must be text")
    text = value.strip()
    if nullable and text in _UNKNOWN:
        return None
    if suffix and text.endswith(suffix):
        text = text[:-len(suffix)].strip()
    # Commas may only be conventional thousands separators.
    if "," in text:
        if not re.fullmatch(r"[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,4})?", text):
            raise _error(f"Invalid {description} summary")
        text = text.replace(",", "")
    if not _DECIMAL_TEXT.fullmatch(text):
        raise _error(f"Invalid {description} summary")
    # A total over at most 366 bounded daily amounts can gain three digits.
    return _decimal(Decimal(text), description, max_adjusted=26)


def _summary_count(value: Any, description: str) -> int:
    amount = _summary_decimal(value, description, nullable=False)
    return _count(amount, description)


def _foot_count(value: Any, noun: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _error("Summary footnotes must be text")
    matches = re.findall(rf"(?<![\d.,])(\d+(?:,\d{{3}})*)\s+{noun}\b", value)
    if len(matches) > 1:
        raise _error(f"Ambiguous {noun} summary")
    return _summary_count(matches[0], noun) if matches else None


def _canonical_wallet(value: Any) -> str:
    try:
        return canonical_address(value, mainnet=True)
    except ValueError:
        raise _error("A valid mainnet wallet address is required") from None


def _source_url(value: Any, wallet: str) -> str:
    if not isinstance(value, str):
        raise _error("Snapshot source URL is missing")
    try:
        url = urlsplit(value)
        valid_origin = (url.scheme == "https" and url.hostname == "marketapp.org"
                        and url.port is None and url.username is None and url.password is None)
        path = re.fullmatch(r"/user/([A-Za-z0-9_+/-]{48})/?", url.path)
        query = parse_qs(url.query, keep_blank_values=True)
    except ValueError:
        raise _error("Invalid Marketapp analytics source URL") from None
    if (not valid_origin or not path or url.fragment or query.get("tab") != ["analytics_rent"]
            or any(key not in {"tab", "period_by", "group_by"} for key in query)
            or any(len(values) != 1 for values in query.values())
            or ("period_by" in query and query["period_by"][0] not in _PERIODS)
            or ("group_by" in query and query["group_by"][0] not in _GROUPS)):
        raise _error("Source must be the Marketapp personal rental analytics page")
    if _canonical_wallet(path[1]) != wallet:
        raise _error("Analytics page wallet differs from the configured wallet")
    return value


def _captured_at(value: Any) -> datetime:
    if not isinstance(value, str):
        raise _error("Snapshot capture timestamp is missing")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError
        return result.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise _error("Capture timestamp must include a timezone") from None


def _dates(value: Any) -> list[date]:
    if not isinstance(value, list) or not 1 <= len(value) <= 366:
        raise _error("Analytics must contain between 1 and 366 daily dates")
    result: list[date] = []
    for item in value:
        if not isinstance(item, str) or not _DATE_TEXT.fullmatch(item):
            raise _error("Analytics dates must use YYYY-MM-DD")
        try:
            result.append(date.fromisoformat(item))
        except ValueError:
            raise _error("Analytics contains an invalid calendar date") from None
    if any(right - left != timedelta(days=1) for left, right in zip(result, result[1:])):
        raise _error("Analytics daily dates must be consecutive and ascending")
    return result


def _chart(value: Any, description: str, unit: str, names: set[str]) -> tuple[list[date], dict[str, list[Any]]]:
    chart = _object(value, description)
    if chart.get("gran") != "day":
        raise _error("Choose By day on Marketapp before saving the analytics snapshot")
    if chart.get("unit") != unit or chart.get("categories") is not None:
        raise _error(f"Unexpected units or categories in {description}")
    dates = _dates(chart.get("x"))
    series = chart.get("series")
    if not isinstance(series, list) or len(series) != len(names):
        raise _error(f"Unexpected series in {description}")
    values: dict[str, list[Any]] = {}
    for item in series:
        item = _object(item, f"{description} series")
        name, data = item.get("name"), item.get("data")
        if not isinstance(name, str) or name not in names or name in values or not isinstance(data, list) or len(data) != len(dates):
            raise _error(f"Unexpected or misaligned series in {description}")
        if "unit" in item and item["unit"] != unit:
            raise _error(f"Unexpected series units in {description}")
        values[name] = data
    return dates, values


def normalize_snapshot(raw: str, wallet: str) -> dict[str, Any]:
    """Validate a browser capture and return a JSON-safe, Decimal-exact view.

    Monetary values are text. Optional summary values remain ``None`` if absent
    or blank, including rates for periods containing no rentals.
    """
    if not isinstance(raw, str):
        raise _error("Analytics snapshot must be JSON text")
    try:
        size = len(raw.encode("utf-8"))
    except UnicodeEncodeError:
        raise _error("Analytics snapshot must be valid UTF-8") from None
    if size > MAX_SNAPSHOT_BYTES:
        raise _error("Analytics snapshot exceeds the 256 KiB size limit")
    snapshot = _object(_json(raw), "Snapshot")
    if (snapshot.get("version") != 1 or isinstance(snapshot.get("version"), bool)
            or snapshot.get("source") != SOURCE):
        raise _error("Unsupported analytics snapshot version or source")
    allowed_fields = {"version", "source", "source_url", "wallet", "captured_at", "summary", "charts", "tables"}
    if snapshot.keys() - allowed_fields:
        raise _error("Snapshot contains unsupported fields; export only analytics data")
    identity = _canonical_wallet(wallet)
    if _canonical_wallet(snapshot.get("wallet")) != identity:
        raise _error("Snapshot wallet differs from the configured wallet")
    source_url = _source_url(snapshot.get("source_url"), identity)
    captured = _captured_at(snapshot.get("captured_at"))
    chart_list = snapshot.get("charts")
    if not isinstance(chart_list, list) or len(chart_list) > 20:
        raise _error("Snapshot charts must be a bounded list")
    charts: dict[str, dict[str, Any]] = {}
    for item in chart_list:
        item = _object(item, "Chart")
        key, spec = item.get("key"), item.get("spec_raw")
        if not isinstance(key, str) or key in charts or not isinstance(spec, str):
            raise _error("Snapshot contains an invalid or duplicate chart")
        charts[key] = _object(_json(spec), "Chart specification")
    required = {"profile.rent.income", "profile.rent.rentals"}
    if not required <= charts.keys():
        raise _error("Snapshot must include rent volume and rental count charts")
    dates, income = _chart(charts["profile.rent.income"], "Rent volume chart", "GRAM", {"Rent volume"})
    rental_dates, rentals = _chart(charts["profile.rent.rentals"], "Rental count chart", "", {"New rentals", "Extensions"})
    if rental_dates != dates:
        raise _error("Rental count and volume dates must match")
    if dates[-1] > captured.date():
        raise _error("Analytics dates extend beyond the capture date")
    for key, unit, name in (("profile.rent.day_price", "GRAM", "Price per day"),
                            ("profile.rent.duration", "days", "Average duration")):
        if key in charts:
            optional_dates, values = _chart(charts[key], name, unit, {name})
            if optional_dates != dates:
                raise _error("Optional analytics chart dates must match")
            for amount in values[name]:
                _decimal(amount, name, nullable=True)
    daily: list[dict[str, Any]] = []
    total_volume = Decimal(0)
    total_new = total_extensions = 0
    for index, day in enumerate(dates):
        volume = _decimal(income["Rent volume"][index], "Daily rent volume")
        new = _count(rentals["New rentals"][index], "Daily new rentals")
        extensions = _count(rentals["Extensions"][index], "Daily extensions")
        with localcontext() as context:
            context.prec = 40
            total_volume += volume
        total_new += new
        total_extensions += extensions
        daily.append({"date": day.isoformat(), "rent_volume": _money(volume),
                      "new_rentals": new, "extensions": extensions, "rentals": new + extensions})
    total_count = _count(total_new + total_extensions, "Total rentals")
    summaries = snapshot.get("summary")
    if not isinstance(summaries, list) or len(summaries) > 30:
        raise _error("Snapshot summary must be a bounded list")
    summary_rows: dict[str, dict[str, Any]] = {}
    for row in summaries:
        row = _object(row, "Summary row")
        label = row.get("label")
        if not isinstance(label, str):
            raise _error("Summary labels must be text")
        if label in _SUMMARY_LABELS:
            if label in summary_rows:
                raise _error("Snapshot contains a duplicate summary metric")
            summary_rows[label] = row
    if not {"Rent volume", "Rentals"} <= summary_rows.keys():
        raise _error("Snapshot must include rent volume and rental count summaries")
    summary_volume = _summary_decimal(summary_rows["Rent volume"].get("value"), "Rent volume", nullable=False)
    summary_rentals = _summary_count(summary_rows["Rentals"].get("value"), "Rentals")
    # Daily charts expose up to four decimals, while the source tile is rounded
    # (usually to two). Reconcile at its reported precision, with a two-decimal
    # minimum so an integer-looking zero cannot conceal a substantial mismatch.
    summary_places = max(2, -summary_volume.as_tuple().exponent)
    with localcontext() as context:
        context.prec = 40
        rounded_volume = total_volume.quantize(Decimal(1).scaleb(-summary_places), rounding=ROUND_HALF_UP)
    if summary_volume != rounded_volume or summary_rentals != total_count:
        raise _error("Summary totals do not match the daily analytics; save a fresh snapshot")

    def optional_decimal(label: str, suffix: str = "") -> str | None:
        if label not in summary_rows:
            return None
        return _money(_summary_decimal(summary_rows[label].get("value"), label, suffix))

    extension_percent = optional_decimal("Extensions", "%")
    if extension_percent is not None and Decimal(extension_percent) > 100:
        raise _error("Extension percentage cannot exceed 100")
    normalized: dict[str, Any] = {
        "version": 1, "source": SOURCE, "source_url": source_url, "wallet": identity,
        "captured_at": captured.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "period_start": dates[0].isoformat(), "period_end": dates[-1].isoformat(),
        "timezone": "UTC", "currency": "GRAM", "volume_basis": "gross_before_fees",
        "summary": {"rent_volume": _money(summary_volume), "rentals": total_count,
                    "new_rentals": total_new, "extensions": total_extensions,
                    "items": _foot_count(summary_rows["Rentals"].get("foot", ""), "items"),
                    "price_per_day": optional_decimal("Price per day"),
                    "average_duration": optional_decimal("Average duration", "days"),
                    "extension_percent": extension_percent,
                    "spent_on_rent": optional_decimal("Spent on rent"),
                    "spending_rentals": _foot_count(summary_rows["Spent on rent"].get("foot", ""), "rentals")
                    if "Spent on rent" in summary_rows else None},
        "daily": daily,
    }
    content = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    normalized["fingerprint"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return normalized


def import_snapshot(database: str | Path, raw: str, wallet: str) -> dict[str, Any]:
    """Atomically retain raw and normalized evidence; replaying it is harmless."""
    normalized = normalize_snapshot(raw, wallet)
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {_TABLE} (
            id INTEGER PRIMARY KEY,
            wallet TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            raw_snapshot TEXT NOT NULL,
            normalized_json TEXT NOT NULL,
            imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE(wallet, fingerprint)
        )""")
        connection.execute(f"CREATE INDEX IF NOT EXISTS personal_analytics_latest ON {_TABLE}(wallet, captured_at DESC, id DESC)")
        connection.execute(f"INSERT OR IGNORE INTO {_TABLE} (wallet, fingerprint, captured_at, raw_snapshot, normalized_json) VALUES (?, ?, ?, ?, ?)",
                           (normalized["wallet"], normalized["fingerprint"], normalized["captured_at"], raw,
                            json.dumps(normalized, separators=(",", ":"), ensure_ascii=False)))
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
    return normalized


def latest_snapshot(database: str | Path, wallet: str) -> dict[str, Any] | None:
    """Read the newest wallet capture without creating or updating the database."""
    identity = _canonical_wallet(wallet)
    path = Path(database)
    if not path.is_file():
        return None
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (_TABLE,)).fetchone():
            return None
        row = connection.execute(f"SELECT normalized_json FROM {_TABLE} WHERE wallet=? ORDER BY captured_at DESC, id DESC LIMIT 1", (identity,)).fetchone()
        return json.loads(row[0]) if row else None
    finally:
        connection.close()


def snapshot_options(database: str | Path, wallet: str) -> list[dict[str, Any]]:
    """Return up to eight newest captures with distinct daily coverage lengths.

    Rank within SQLite so an older annual capture remains selectable even after
    many monthly refreshes. Only the selected, bounded snapshots are decoded in
    Python. Like ``latest_snapshot``, this lookup performs no schema writes.
    """
    identity = _canonical_wallet(wallet)
    path = Path(database)
    if not path.is_file():
        return []
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (_TABLE,)).fetchone():
            return []
        rows = connection.execute(f"""WITH ranked AS (
            SELECT normalized_json, captured_at, id,
                ROW_NUMBER() OVER (
                    PARTITION BY json_array_length(normalized_json, '$.daily')
                    ORDER BY captured_at DESC, id DESC
                ) AS period_rank
            FROM {_TABLE} WHERE wallet=?
        ) SELECT normalized_json FROM ranked WHERE period_rank=1
          ORDER BY captured_at DESC, id DESC LIMIT 8""", (identity,)).fetchall()
        return [json.loads(row[0]) for row in rows]
    finally:
        connection.close()
