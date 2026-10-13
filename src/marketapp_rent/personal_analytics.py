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
from bisect import bisect_left
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
_TOP_ITEMS_HEADERS = ["Item", "Rentals", "Rented days", "Volume", "Price per day"]
_TOP_ITEMS_LIMIT = 100
_COLLECTION_HEADERS = ["Collection", "Rentals", "Volume", "Price per day"]
_COLLECTION_WIDE_HEADERS = ["", "Collection", "Rentals", "Volume", "Price per day", "Average duration", "Share of volume"]
_COLLECTION_LIMIT = 200
_COLLECTION_SPACE = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


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


def _activity_charts(value: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Project the observed combined chart without rounding numeric lexemes."""
    chart = _object(value, "Rental activity chart")
    fields = {"categories", "combo", "gran", "kind", "series", "stacking", "unit", "x"}
    if (chart.keys() - fields or "categories" not in chart or chart["categories"] is not None
            or chart.get("combo") is not True or chart.get("gran") != "day" or chart.get("kind") != "column"
            or chart.get("stacking") != "normal" or chart.get("unit") != "" or not isinstance(chart.get("x"), list)
            or not isinstance(chart.get("series"), list) or len(chart["series"]) != 3):
        raise _error("Unexpected rental activity chart layout")
    expected = {"New rentals": ("column", 0, ""), "Extensions": ("column", 0, ""), "Rent volume": ("line", 1, "GRAM")}
    series: dict[str, dict[str, Any]] = {}
    for row in chart["series"]:
        row = _object(row, "Rental activity series")
        name = row.get("name")
        if (not isinstance(name, str) or name not in expected or name in series
                or row.keys() - {"name", "data", "type", "axis", "unit", "color", "opacity"}
                or (row.get("type"), _count(row.get("axis"), "Rental activity axis"), row.get("unit")) != expected[name]
                or not isinstance(row.get("data"), list) or len(row["data"]) != len(chart["x"])):
            raise _error("Unexpected rental activity series identity or units")
        if "color" in row and _count(row["color"], "Rental activity color") > 255:
            raise _error("Unexpected rental activity color")
        if "opacity" in row and _decimal(row["opacity"], "Rental activity opacity") > 1:
            raise _error("Unexpected rental activity opacity")
        series[name] = {"name": name, "data": row["data"]}
    return ({"gran": "day", "unit": "GRAM", "x": chart["x"], "series": [series["Rent volume"]]},
            {"gran": "day", "unit": "", "x": chart["x"], "series": [series["New rentals"], series["Extensions"]]})


def _item_identity(value: Any) -> tuple[str, str]:
    if not isinstance(value, str) or len(value) > 200:
        raise _error("Top items must link to a Marketapp gift")
    if value.startswith("/nft/"):
        value = "https://marketapp.org" + value
    try:
        url = urlsplit(value)
        match = re.fullmatch(r"/nft/([A-Za-z0-9_+-]{48})/?", url.path)
        if (url.scheme != "https" or url.hostname != "marketapp.org" or url.port is not None
                or url.username is not None or url.password is not None or url.query or url.fragment or not match):
            raise ValueError
        identity = canonical_address(match[1], mainnet=True)
    except ValueError:
        raise _error("Top items must link to a mainnet Marketapp gift") from None
    return identity, f"https://marketapp.org/nft/{match[1].replace('+', '-').replace('/', '_')}/"


def _top_items(value: Any, *, saved: bool = False) -> dict[str, Any]:
    """Validate provider rows independently of public gift rental history."""
    if value is None:
        return {"status": "missing", "scope": "marketapp_top_items", "items": []}
    table = _object(value, "Top items")
    if not isinstance(table.get("status"), str) or table["status"] not in {"available", "missing"}:
        raise _error("Top items status is invalid")
    if saved and table.get("scope") != "marketapp_top_items":
        raise _error("Top items scope is invalid")
    rows = table.get("items")
    if not isinstance(rows, list) or len(rows) > _TOP_ITEMS_LIMIT or (table["status"] == "missing" and rows):
        raise _error("Top items must be a bounded list")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in rows:
        item = _object(item, "Top items row")
        name = item.get("name")
        if (not isinstance(name, str) or not name.strip() or len(name) > 200
                or any(ord(char) < 32 or ord(char) == 127 for char in name)):
            raise _error("Top item names must be bounded text")
        key, url = _item_identity(item.get("item_url"))
        if key in seen or (saved and item.get("item_key") != key):
            raise _error("Top items contains an ambiguous gift")
        seen.add(key)
        rentals = _count(item.get("rentals"), "Top item rentals") if saved else _summary_count(item.get("rentals"), "Top item rentals")
        result.append({"item_key": key, "item_url": url, "name": name.strip(), "rentals": rentals,
                       "rented_days": _money(_summary_decimal(item.get("rented_days"), "Top item rented days", nullable=False)),
                       "volume": _money(_summary_decimal(item.get("volume"), "Top item volume", nullable=False)),
                       "price_per_day": _money(_summary_decimal(item.get("price_per_day"), "Top item price per day"))})
    return {"status": table["status"], "scope": "marketapp_top_items", "items": result}


def _snapshot_top_items(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Also support the table evidence exported by older browser snapshots."""
    tables = snapshot.get("tables", [])
    if not isinstance(tables, list) or len(tables) > 20:
        raise _error("Analytics tables must be a bounded list")
    matches = [table for table in tables if isinstance(table, dict) and table.get("headers") == _TOP_ITEMS_HEADERS]
    if len(matches) > 1:
        raise _error("Snapshot contains duplicate Top items tables")
    legacy = None
    if matches:
        rows = matches[0].get("rows")
        if not isinstance(rows, list) or len(rows) > _TOP_ITEMS_LIMIT:
            raise _error("Top items must be a bounded list")
        items = []
        for row in rows:
            row = _object(row, "Top items row")
            cells, links = row.get("cells"), row.get("links")
            if (not isinstance(cells, list) or len(cells) != 5 or not isinstance(links, list) or len(links) != 1
                    or not isinstance(links[0], dict) or links[0].get("label") != cells[0]):
                raise _error("Top items table contains an ambiguous row")
            items.append(dict(zip(("name", "rentals", "rented_days", "volume", "price_per_day"), cells)) | {"item_url": links[0].get("url")})
        legacy = _top_items({"status": "available", "items": items})
    direct = _top_items(snapshot["top_items"]) if "top_items" in snapshot else None
    if direct is not None and legacy is not None and direct != legacy:
        raise _error("Snapshot Top items sources disagree")
    return direct or legacy or _top_items(None)


def _by_collection(value: Any, *, saved: bool = False) -> dict[str, Any]:
    """Keep the provider's collection totals separate from its ranked gifts."""
    if value is None:
        return {"status": "missing", "scope": "marketapp_by_collection", "items": []}
    table = _object(value, "By collection")
    if not isinstance(table.get("status"), str) or table["status"] not in {"available", "missing"}:
        raise _error("By collection status is invalid")
    if saved and table.get("scope") != "marketapp_by_collection":
        raise _error("By collection scope is invalid")
    rows = table.get("items")
    if not isinstance(rows, list) or len(rows) > _COLLECTION_LIMIT or (table["status"] == "missing" and rows):
        raise _error("By collection must be a bounded list")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in rows:
        item = _object(item, "By collection row")
        name = item.get("name")
        if (not isinstance(name, str) or len(name.encode("utf-16-le", errors="surrogatepass")) > 400
                or any(ord(char) < 32 or ord(char) == 127 for char in name)):
            raise _error("Collection names must be bounded text")
        name = _COLLECTION_SPACE.sub(" ", name).strip(" ")
        if not name:
            raise _error("Collection names must be bounded text")
        key = "name:" + name.lower()
        if key in seen or (saved and item.get("collection_key") != key):
            raise _error("By collection contains an ambiguous collection")
        seen.add(key)
        if "price_per_day" not in item:
            raise _error("Collection price per day is missing")
        rentals = _count(item.get("rentals"), "Collection rentals") if saved else _summary_count(item.get("rentals"), "Collection rentals")
        result.append({"collection_key": key, "name": name, "rentals": rentals,
                       "volume": _money(_summary_decimal(item.get("volume"), "Collection volume", nullable=False)),
                       "price_per_day": _money(_summary_decimal(item.get("price_per_day"), "Collection price per day"))})
    return {"status": table["status"], "scope": "marketapp_by_collection", "items": result}


def _snapshot_by_collection(snapshot: dict[str, Any]) -> dict[str, Any]:
    tables = snapshot.get("tables", [])
    if not isinstance(tables, list) or len(tables) > 20:
        raise _error("Analytics tables must be a bounded list")
    matches = [table for table in tables if isinstance(table, dict) and isinstance(table.get("headers"), list)
               and "Collection" in table["headers"]]
    if len(matches) > 1:
        raise _error("Snapshot contains duplicate By collection tables")
    legacy = None
    if matches:
        headers = matches[0]["headers"]
        if headers not in (_COLLECTION_HEADERS, _COLLECTION_WIDE_HEADERS):
            raise _error("By collection table has unsupported columns")
        wide = headers == _COLLECTION_WIDE_HEADERS
        rows = matches[0].get("rows")
        if not isinstance(rows, list) or len(rows) > _COLLECTION_LIMIT:
            raise _error("By collection must be a bounded list")
        items = []
        for row in rows:
            row = _object(row, "By collection row")
            cells, links = row.get("cells"), row.get("links")
            if (not isinstance(cells, list) or len(cells) != len(headers) or any(not isinstance(cell, str) for cell in cells)
                    or not isinstance(links, list) or (len(links) != 2 if wide else len(links) > 1)):
                raise _error("By collection table contains an ambiguous row")
            if wide and (cells[0] != "" or any(len(value.encode("utf-16-le", errors="surrogatepass")) > 400
                        or any(ord(char) < 32 or ord(char) == 127 for char in value) for value in cells[5:])):
                raise _error("By collection table contains an ambiguous row")
            urls = []
            for index, raw_link in enumerate(links):
                link = _object(raw_link, "Collection link")
                url = link.get("url")
                expected_label = cells[index] if wide else cells[0]
                if (link.get("label") != expected_label or not isinstance(url, str) or len(url) > 2048
                        or re.search(r"[\\\x00-\x20\x7f]", url)
                        or not re.match(r"(?:https://marketapp\.org)?/(?!/)", url)):
                    raise _error("By collection table contains an invalid link")
                urls.append("https://marketapp.org" + url if url.startswith("/") else url)
            if wide and urls[0] != urls[1]:
                raise _error("By collection thumbnail and name links disagree")
            values = cells[1:5] if wide else cells
            items.append(dict(zip(("name", "rentals", "volume", "price_per_day"), values)))
        legacy = _by_collection({"status": "available", "items": items})
    direct = _by_collection(snapshot["by_collection"]) if "by_collection" in snapshot else None
    if direct is not None and legacy is not None and direct != legacy:
        raise _error("Snapshot By collection sources disagree")
    return direct or legacy or _by_collection(None)


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
    allowed_fields = {"version", "source", "source_url", "wallet", "captured_at", "summary", "charts", "tables", "top_items", "by_collection"}
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
    combined = "profile.rent.activity" in charts
    if combined and required & charts.keys():
        raise _error("Snapshot contains ambiguous rental analytics charts")
    if not combined and not required <= charts.keys():
        raise _error("Snapshot must include rent volume and rental count charts")
    income_chart, rental_chart = (_activity_charts(charts["profile.rent.activity"]) if combined else
                                  (charts["profile.rent.income"], charts["profile.rent.rentals"]))
    dates, income = _chart(income_chart, "Rent volume chart", "GRAM", {"Rent volume"})
    rental_dates, rentals = _chart(rental_chart, "Rental count chart", "", {"New rentals", "Extensions"})
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
    # minimum for the legacy separate layout. The observed combined chart uses
    # whole-GRAM annual tiles, so reconcile that layout at its displayed scale.
    summary_places = max(0 if combined else 2, -summary_volume.as_tuple().exponent)
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
        "top_items": _snapshot_top_items(snapshot),
        "by_collection": _snapshot_by_collection(snapshot),
    }
    content = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    normalized["fingerprint"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return normalized


def import_snapshot(database: str | Path, raw: str, wallet: str) -> dict[str, Any]:
    """Atomically retain raw and normalized evidence; replaying it is harmless."""
    normalized = normalize_snapshot(raw, wallet)
    if _captured_at(normalized["captured_at"]) > datetime.now(timezone.utc):
        raise _error("Snapshot capture timestamp is in the future; save a fresh snapshot")
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
        row = connection.execute(f"SELECT normalized_json, raw_snapshot FROM {_TABLE} WHERE wallet=? ORDER BY captured_at DESC, id DESC LIMIT 1", (identity,)).fetchone()
        return _with_saved_top_items(json.loads(row[0]), row[1], identity) if row else None
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
            SELECT normalized_json, raw_snapshot, captured_at, id,
                ROW_NUMBER() OVER (
                    PARTITION BY json_array_length(normalized_json, '$.daily')
                    ORDER BY captured_at DESC, id DESC
                ) AS period_rank
            FROM {_TABLE} WHERE wallet=?
        ) SELECT normalized_json, raw_snapshot FROM ranked WHERE period_rank=1
          ORDER BY captured_at DESC, id DESC LIMIT 8""", (identity,)).fetchall()
        return [_with_saved_top_items(json.loads(row[0]), row[1], identity) for row in rows]
    finally:
        connection.close()


def _with_saved_top_items(snapshot: dict[str, Any], raw: str, wallet: str) -> dict[str, Any]:
    """Recover saved breakdown tables without rewriting old evidence."""
    result = dict(snapshot)
    missing = []
    for field, validate in (("top_items", _top_items), ("by_collection", _by_collection)):
        if field not in snapshot:
            missing.append(field)
            continue
        try:
            result[field] = validate(snapshot[field], saved=True)
            if result[field]["status"] == "missing":
                missing.append(field)
        except PersonalAnalyticsError:
            result[field] = validate(None)
    if missing:
        try:
            restored = normalize_snapshot(raw, wallet)
            excluded = {"fingerprint", "top_items", "by_collection"}
            if ({key: value for key, value in restored.items() if key not in excluded}
                    == {key: value for key, value in snapshot.items() if key not in excluded}):
                result.update({field: restored[field] for field in missing})
        except (PersonalAnalyticsError, TypeError, ValueError):
            pass
    return result


def _retained_item_reports(snapshot: dict[str, Any]) -> list[dict[str, Any]] | None:
    try:
        table = _top_items(snapshot.get("top_items"), saved="top_items" in snapshot)
    except PersonalAnalyticsError:
        return None
    if table["status"] != "available":
        return None
    return [{**item, "period_start": snapshot["period_start"], "period_end": snapshot["period_end"],
             "captured_at": snapshot["captured_at"], "fingerprint": snapshot["fingerprint"]}
            for item in table["items"]]


def _retained_collection_reports(snapshot: dict[str, Any]) -> list[dict[str, Any]] | None:
    try:
        table = _by_collection(snapshot.get("by_collection"), saved="by_collection" in snapshot)
    except PersonalAnalyticsError:
        return None
    if table["status"] != "available":
        return None
    return [{**item, "period_start": snapshot["period_start"], "period_end": snapshot["period_end"],
             "captured_at": snapshot["captured_at"], "fingerprint": snapshot["fingerprint"]}
            for item in table["items"]]


def _non_overlapping_reports(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Maximize evidenced days, then freshness, without splitting any total."""
    ordered = sorted(reports, key=lambda row: (row["period_end"], row["period_start"], row["fingerprint"]))
    ends = [date.fromisoformat(row["period_end"]).toordinal() for row in ordered]
    # A linked choice keeps memory linear even for years of retained captures.
    # Each state is (covered days, timestamp-weighted freshness, choice node).
    states: list[tuple[int, int, Any]] = [(0, 0, None)]

    def fingerprints(node: Any) -> tuple[str, ...]:
        values = []
        while node is not None:
            index, node = node
            values.append(ordered[index]["fingerprint"])
        return tuple(reversed(values))

    for index, row in enumerate(ordered):
        start = date.fromisoformat(row["period_start"]).toordinal()
        days = ends[index] - start + 1
        prior = states[bisect_left(ends, start, 0, index)]
        captured = _captured_at(row["captured_at"])
        # Integer milliseconds avoid floating-point timestamp tie differences.
        stamp = ((captured.toordinal() * 86400 + captured.hour * 3600 + captured.minute * 60
                  + captured.second) * 1000 + captured.microsecond // 1000)
        candidate = (prior[0] + days, prior[1] + stamp * days, (index, prior[2]))
        current = states[-1]
        if candidate[:2] > current[:2] or (candidate[:2] == current[:2]
                and fingerprints(candidate[2]) > fingerprints(current[2])):
            current = candidate
        states.append(current)
    selected = []
    node = states[-1][2]
    while node is not None:
        index, node = node
        selected.append(ordered[index])
    return list(reversed(selected))


def _all_time_top_items(reports: dict[tuple[str, str, str], dict[str, Any]], *, available: bool,
                        period_start: str, period_end: str) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in reports.values():
        groups.setdefault(row["item_key"], []).append(row)
    span = (date.fromisoformat(period_end) - date.fromisoformat(period_start)).days + 1
    items = []
    for key, candidates in groups.items():
        selected = _non_overlapping_reports(candidates)
        latest = max(selected, key=lambda row: (row["captured_at"], row["fingerprint"]))
        rentals = sum(row["rentals"] for row in selected)
        if rentals > _MAX_COUNT:
            continue
        with localcontext() as context:
            context.prec = 40
            volume = sum((Decimal(row["volume"]) for row in selected), Decimal(0))
            days = sum((Decimal(row["rented_days"]) for row in selected), Decimal(0))
            rate = (latest["price_per_day"] if len(selected) == 1 else
                    _money((volume / days).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)) if days else None)
        periods = [{field: row[field] for field in ("period_start", "period_end", "captured_at")} for row in selected]
        observed_days = sum((date.fromisoformat(row["period_end"]) - date.fromisoformat(row["period_start"])).days + 1 for row in selected)
        partial_days = sum(row["period_end"] == row["captured_at"][:10] for row in selected)
        items.append({"item_key": key, "name": latest["name"], "item_url": latest["item_url"],
                      "rentals": rentals, "rented_days": _money(days), "volume": _money(volume),
                      "price_per_day": rate, "captured_at": latest["captured_at"],
                      "coverage": {"observed_days": observed_days, "missing_days": max(0, span - observed_days),
                                   "partial_days": partial_days, "periods": periods}})
    items.sort(key=lambda row: (Decimal(row["volume"]).copy_negate(), row["item_key"]))
    return {"status": "available" if available else "missing", "scope": "saved_non_overlapping_reports",
            "incomplete": True, "items": items}


def _all_time_collections(reports: dict[tuple[str, str, str], dict[str, Any]], *, available: bool,
                          period_start: str, period_end: str) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in reports.values():
        groups.setdefault(row["collection_key"], []).append(row)
    span = (date.fromisoformat(period_end) - date.fromisoformat(period_start)).days + 1
    items = []
    for key, candidates in groups.items():
        selected = _non_overlapping_reports(candidates)
        latest = max(selected, key=lambda row: (row["captured_at"], row["fingerprint"]))
        rentals = sum(row["rentals"] for row in selected)
        if rentals > _MAX_COUNT:
            continue
        with localcontext() as context:
            context.prec = 40
            volume = sum((Decimal(row["volume"]) for row in selected), Decimal(0))
        periods = [{field: row[field] for field in ("period_start", "period_end", "captured_at")} for row in selected]
        observed_days = sum((date.fromisoformat(row["period_end"]) - date.fromisoformat(row["period_start"])).days + 1 for row in selected)
        partial_days = sum(row["period_end"] == row["captured_at"][:10] for row in selected)
        # The source has no rented-day denominator. Never derive it from an
        # already-rounded price or average separate provider prices together.
        items.append({"collection_key": key, "name": latest["name"], "rentals": rentals,
                      "volume": _money(volume), "price_per_day": latest["price_per_day"] if len(selected) == 1 else None,
                      "captured_at": latest["captured_at"],
                      "coverage": {"observed_days": observed_days, "missing_days": max(0, span - observed_days),
                                   "partial_days": partial_days, "periods": periods}})
    items.sort(key=lambda row: (Decimal(row["volume"]).copy_negate(), row["collection_key"]))
    return {"status": "available" if available else "missing", "scope": "saved_non_overlapping_reports",
            "incomplete": True, "items": items}


def _saved_daily_snapshot(raw: str, wallet: str, captured_at: str, fingerprint: str,
                          imported_at: str, now: datetime) -> dict[str, Any] | None:
    """Check retained normalized evidence before it can enter the daily union."""
    try:
        if not isinstance(raw, str) or len(raw) > MAX_SNAPSHOT_BYTES or len(raw.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
            return None
        snapshot = _object(json.loads(raw), "Saved snapshot")
        if (snapshot.get("version") != 1 or isinstance(snapshot.get("version"), bool)
                or snapshot.get("source") != SOURCE or snapshot.get("wallet") != wallet
                or snapshot.get("currency") != "GRAM" or snapshot.get("timezone") != "UTC"
                or snapshot.get("volume_basis") != "gross_before_fees"
                or snapshot.get("captured_at") != captured_at or snapshot.get("fingerprint") != fingerprint
                or not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", fingerprint)):
            return None
        captured = _captured_at(captured_at)
        if (captured.isoformat(timespec="milliseconds").replace("+00:00", "Z") != captured_at
                or captured > _captured_at(imported_at) or captured > now):
            return None
        daily = snapshot.get("daily")
        if not isinstance(daily, list) or any(not isinstance(day, dict) for day in daily):
            return None
        dates = _dates([day.get("date") for day in daily])
        if (dates[-1] > captured.date() or snapshot.get("period_start") != dates[0].isoformat()
                or snapshot.get("period_end") != dates[-1].isoformat()):
            return None
        for day in daily:
            volume = day.get("rent_volume")
            if not isinstance(volume, str) or not _DECIMAL_TEXT.fullmatch(volume):
                return None
            _decimal(Decimal(volume), "Saved daily rent volume")
            starts = _count(day.get("new_rentals"), "Saved daily new rentals")
            extensions = _count(day.get("extensions"), "Saved daily extensions")
            if _count(day.get("rentals"), "Saved daily rentals") != starts + extensions:
                return None
        return snapshot
    except (ValueError, TypeError, UnicodeError, RecursionError, InvalidOperation):
        return None


def all_time_snapshot(database: str | Path, wallet: str) -> dict[str, Any] | None:
    """Merge all saved daily captures for one wallet, without writes or requests.

    A later capture replaces an overlapping date; equal capture times use the
    greatest fingerprint so replay/import order cannot change the result. The
    cursor reads one bounded snapshot at a time, keeping only distinct dates in
    memory. Gaps stay absent, and a capture-day value stays marked partial until
    a later capture supplies that date. This is saved coverage, not a claim of
    complete lifetime earnings.
    """
    identity = _canonical_wallet(wallet)
    path = Path(database)
    if not path.is_file():
        return None
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    by_date: dict[str, dict[str, Any]] = {}
    item_reports: dict[tuple[str, str, str], dict[str, Any]] = {}
    collection_reports: dict[tuple[str, str, str], dict[str, Any]] = {}
    items_available = False
    collections_available = False
    now = datetime.now(timezone.utc)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (_TABLE,)).fetchone():
            return None
        rows = connection.execute(f"""SELECT normalized_json, captured_at, fingerprint, imported_at, raw_snapshot
            FROM {_TABLE} WHERE wallet=? AND length(normalized_json)<=?
            ORDER BY captured_at DESC, fingerprint DESC""", (identity, MAX_SNAPSHOT_BYTES))
        for raw, captured_at, fingerprint, imported_at, raw_snapshot in rows:
            snapshot = _saved_daily_snapshot(raw, identity, captured_at, fingerprint, imported_at, now)
            if snapshot is None:
                continue
            snapshot = _with_saved_top_items(snapshot, raw_snapshot, identity)
            retained = _retained_item_reports(snapshot)
            if retained is not None:
                items_available = True
                for item in retained:
                    # Rows are newest-first. A later report where a gift falls
                    # outside Top items cannot erase its previous observation.
                    key = (item["item_key"], item["period_start"], item["period_end"])
                    if key not in item_reports:
                        item_reports[key] = item
            retained_collections = _retained_collection_reports(snapshot)
            if retained_collections is not None:
                collections_available = True
                for item in retained_collections:
                    key = (item["collection_key"], item["period_start"], item["period_end"])
                    if key not in collection_reports:
                        collection_reports[key] = item
            for day in snapshot["daily"]:
                if day["date"] not in by_date:
                    by_date[day["date"]] = {
                        "date": day["date"], "rent_volume": day["rent_volume"],
                        "new_rentals": day["new_rentals"], "extensions": day["extensions"],
                        "rentals": day["rentals"], "captured_at": captured_at,
                        "partial": day["date"] == captured_at[:10],
                    }
    finally:
        connection.close()
    if not by_date:
        return None
    daily = [by_date[day] for day in sorted(by_date)]
    # Four decimal places and at most all representable calendar days fit well
    # inside this precision even when every daily value reaches its input cap.
    with localcontext() as context:
        context.prec = 40
        volume = sum((Decimal(day["rent_volume"]) for day in daily), Decimal(0))
    starts = sum(day["new_rentals"] for day in daily)
    extensions = sum(day["extensions"] for day in daily)
    if starts + extensions > _MAX_COUNT:
        # JSON clients cannot represent a larger integer exactly.
        return None
    span = (date.fromisoformat(daily[-1]["date"]) - date.fromisoformat(daily[0]["date"])).days + 1
    result = {
        "version": 1, "report_kind": "all_time", "source": SOURCE, "source_url": None,
        "wallet": identity, "captured_at": max(day["captured_at"] for day in daily),
        "period_start": daily[0]["date"], "period_end": daily[-1]["date"],
        "timezone": "UTC", "currency": "GRAM", "volume_basis": "gross_before_fees",
        "summary": {"rent_volume": _money(volume), "rentals": starts + extensions,
                    "new_rentals": starts, "extensions": extensions, "items": None,
                    "price_per_day": None, "average_duration": None, "extension_percent": None,
                    "spent_on_rent": None, "spending_rentals": None},
        "daily": daily,
        "coverage": {"observed_days": len(daily), "missing_days": span - len(daily),
                     "partial_days": sum(day["partial"] for day in daily)},
        "top_items": _all_time_top_items(item_reports, available=items_available,
                                         period_start=daily[0]["date"], period_end=daily[-1]["date"]),
        "by_collection": _all_time_collections(collection_reports, available=collections_available,
                                               period_start=daily[0]["date"], period_end=daily[-1]["date"]),
    }
    content = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    result["fingerprint"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return result
