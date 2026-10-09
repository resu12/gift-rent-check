"""Shared, explicit time windows for local pricing views and exports."""
from datetime import date, datetime, time, timedelta, timezone


PRESETS = {"24h": 1, "7d": 7, "30d": 30, "60d": 60, "90d": 90}


def pricing_window(timeframe="24h", date_from=None, date_to=None, *, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Pricing time must have a timezone")
    now = now.astimezone(timezone.utc)
    if timeframe not in {*PRESETS, "all", "custom"}:
        raise ValueError("Unknown pricing timeframe")
    if timeframe == "custom":
        try:
            if not date_from or not date_to or date.fromisoformat(date_from).isoformat() != date_from or date.fromisoformat(date_to).isoformat() != date_to:
                raise ValueError
            start = datetime.combine(date.fromisoformat(date_from), time.min, timezone.utc)
            end = datetime.combine(date.fromisoformat(date_to), time.min, timezone.utc) + timedelta(days=1)
        except (TypeError, ValueError, OverflowError):
            raise ValueError("Custom dates must be valid YYYY-MM-DD dates") from None
        if start >= end:
            raise ValueError("Start date must not follow end date")
        if start > now:
            raise ValueError("Start date must not be in the future")
        end = min(end - timedelta(microseconds=1), now)
    else:
        if date_from is not None or date_to is not None:
            raise ValueError("Dates are only supported with the custom timeframe")
        start = now - timedelta(days=PRESETS[timeframe]) if timeframe in PRESETS else datetime.min.replace(tzinfo=timezone.utc)
        end = now
    return {"timeframe": timeframe, "date_from": date_from, "date_to": date_to,
            "from": start, "to": end, "now": now}


def window_metadata(window):
    return {"timeframe": window["timeframe"], "date_from": window["date_from"], "date_to": window["date_to"],
            "window_from": None if window["timeframe"] == "all" else window["from"].isoformat(),
            "window_to": window["to"].isoformat(), "timezone": "UTC"}


def dashboard_window(timeframe="30d", date_from=None, date_to=None, *, now=None, collect_history=False):
    """Bound dashboard comparisons without restricting offline legacy analytics.

    Older saved data can still be inspected in a custom range of at most 90
    inclusive UTC dates. A new history scan must not use such an old range to
    traverse years of API pages before reaching it.
    """
    if timeframe == "all":
        raise ValueError("Dashboard timeframes are limited to 90 days; choose 30, 60, or 90 days")
    window = pricing_window(timeframe, date_from, date_to, now=now)
    if timeframe == "custom":
        if (date.fromisoformat(date_to) - date.fromisoformat(date_from)).days >= 90:
            raise ValueError("Custom timeframes support at most 90 inclusive UTC dates")
        if collect_history and window["from"].date() < window["now"].date() - timedelta(days=89):
            raise ValueError("New rental-history collection must start within the last 90 UTC dates; choose a recent timeframe. Older saved data remains available to view.")
    return window


def validate_saved_dashboard_window(window):
    """Validate a frozen bounded window without moving its original dates.

    Resuming after a pause is allowed even when the original window is now
    older than 90 days. Missing or unbounded legacy windows require a new job.
    """
    error = "This saved history job has no supported bounded timeframe; start a fresh 30-day collection. Saved records are retained."
    try:
        if not isinstance(window, dict) or window.get("timeframe") not in {*PRESETS, "custom"} or window.get("timezone") != "UTC":
            raise ValueError
        start = datetime.fromisoformat(window["window_from"])
        end = datetime.fromisoformat(window["window_to"])
        if start.tzinfo is None or end.tzinfo is None or start <= datetime(1970, 1, 1, tzinfo=timezone.utc) or start > end or end - start > timedelta(days=90):
            raise ValueError
        if window["timeframe"] == "custom":
            expected = dashboard_window("custom", window.get("date_from"), window.get("date_to"), now=end)
            if expected["from"] != start or expected["to"] != end:
                raise ValueError
        elif window.get("date_from") is not None or window.get("date_to") is not None or end - start != timedelta(days=PRESETS[window["timeframe"]]):
            raise ValueError
    except (KeyError, TypeError, ValueError, OverflowError):
        raise ValueError(error) from None
    return window


def validate_new_history_window(window, *, now=None):
    """Guard direct queue callers as well as HTTP selection validation."""
    validate_saved_dashboard_window(window)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if window["timeframe"] == "custom":
        dashboard_window("custom", window.get("date_from"), window.get("date_to"),
                         now=now, collect_history=True)
    elif datetime.fromisoformat(window["window_from"]).date() < now.date() - timedelta(days=90):
        raise ValueError("New rental-history collection must start within the last 90 days; choose a recent timeframe")
    return window
