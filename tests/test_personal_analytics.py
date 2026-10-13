"""Synthetic personal analytics evidence; no user data or login credentials."""

from __future__ import annotations

import copy
import json
import sqlite3
from datetime import date, timedelta
from decimal import Decimal, localcontext

import pytest
from pytoniq_core import Address

from marketapp_rent.personal_analytics import (
    MAX_SNAPSHOT_BYTES,
    PersonalAnalyticsError,
    all_time_snapshot,
    import_snapshot,
    latest_snapshot,
    normalize_snapshot,
    snapshot_options,
)

WALLET = "0:" + "11" * 32
OTHER = "0:" + "22" * 32
FRIENDLY = Address(WALLET).to_str()
NONBOUNCEABLE = Address(WALLET).to_str(is_bounceable=False)
TESTNET = Address(WALLET).to_str(is_test_only=True)


def snapshot():
    dates = ["2026-01-30", "2026-01-31", "2026-02-01"]

    def chart(key, names, data, unit):
        return {"key": key, "spec_raw": json.dumps({"categories": None, "gran": "day", "kind": "column",
                "series": [{"name": name, "data": values} for name, values in zip(names, data)],
                "unit": unit, "x": dates, "stacking": None})}

    return {
        "version": 1,
        "source": "marketapp_personal_rent_page",
        "source_url": f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent",
        "wallet": FRIENDLY,
        "captured_at": "2026-02-01T12:30:00.123Z",
        "summary": [{"label": "Rent volume", "value": "0.3", "foot": "", "definition": "Before fees"},
                    {"label": "Rentals", "value": "4", "foot": "-10%2 items", "definition": "Includes extensions"},
                    {"label": "Price per day", "value": "0.025", "foot": ""},
                    {"label": "Average duration", "value": "3.5days", "foot": ""},
                    {"label": "Extensions", "value": "25%", "foot": ""},
                    {"label": "Spent on rent", "value": "0", "foot": "0 rentals"}],
        "charts": [chart("profile.rent.income", ["Rent volume"], [[0.1, 0.2, 0]], "GRAM"),
                   chart("profile.rent.rentals", ["New rentals", "Extensions"], [[1.0, 2.0, 0.0], [0.0, 1.0, 0.0]], ""),
                   chart("profile.rent.day_price", ["Price per day"], [[0.025, 0.05, None]], "GRAM"),
                   chart("profile.rent.duration", ["Average duration"], [[2.0, 5.0, None]], "days")],
    }


def raw(data=None):
    return json.dumps(snapshot() if data is None else data)


def edit_chart(data, index, key, value):
    spec = json.loads(data["charts"][index]["spec_raw"])
    spec[key] = value
    data["charts"][index]["spec_raw"] = json.dumps(spec)


def edit_value(data, chart, series, index, value):
    spec = json.loads(data["charts"][chart]["spec_raw"])
    spec["series"][series]["data"][index] = value
    data["charts"][chart]["spec_raw"] = json.dumps(spec)


def test_decimal_exact_normalization_and_gross_basis():
    result = normalize_snapshot(raw(), WALLET)
    assert result["wallet"] == WALLET
    assert result["summary"] == {"rent_volume": "0.3", "rentals": 4, "new_rentals": 3, "extensions": 1,
                                  "items": 2, "price_per_day": "0.025", "average_duration": "3.5",
                                  "extension_percent": "25", "spent_on_rent": "0", "spending_rentals": 0}
    assert result["daily"][-1] == {"date": "2026-02-01", "rent_volume": "0", "new_rentals": 0, "extensions": 0, "rentals": 0}
    assert result["volume_basis"] == "gross_before_fees"
    assert result["period_start"] == "2026-01-30"
    assert result["period_end"] == "2026-02-01"
    assert result["currency"] == "GRAM"
    assert result["timezone"] == "UTC"
    assert len(result["fingerprint"]) == 64
    assert "net_revenue" not in result


def test_address_aliases_and_fingerprint_are_stable():
    data = snapshot()
    data["wallet"] = NONBOUNCEABLE
    expected = normalize_snapshot(raw(), WALLET)
    assert normalize_snapshot(raw(data), NONBOUNCEABLE) == expected
    pretty = json.dumps(snapshot(), indent=3)
    assert normalize_snapshot(pretty, FRIENDLY)["fingerprint"] == expected["fingerprint"]


def test_capture_timestamp_normalizes_to_utc_milliseconds():
    data = snapshot()
    data["captured_at"] = "2026-02-01T13:30:00.123+01:00"
    assert normalize_snapshot(raw(data), WALLET)["captured_at"] == "2026-02-01T12:30:00.123Z"
    assert normalize_snapshot(raw(data), WALLET)["fingerprint"] == normalize_snapshot(raw(), WALLET)["fingerprint"]


def test_unknown_optional_values_are_not_zero_or_daily_averages():
    data = snapshot()
    data["summary"] = data["summary"][:2] + [{"label": "Price per day", "value": "—", "foot": ""}]
    result = normalize_snapshot(raw(data), WALLET)
    for key in ["price_per_day", "average_duration", "extension_percent", "spent_on_rent", "spending_rentals"]:
        assert result["summary"][key] is None
    # The rate is deliberately not reconstructed from daily rates.
    assert result["summary"]["rent_volume"] == "0.3"


def test_optional_null_metrics_and_footnotes_remain_unknown():
    data = snapshot()
    data["summary"][1]["foot"] = None
    for row in data["summary"][2:]:
        row["value"] = None
        row["foot"] = None
    summary = normalize_snapshot(raw(data), WALLET)["summary"]
    for key in ["items", "price_per_day", "average_duration", "extension_percent", "spent_on_rent", "spending_rentals"]:
        assert summary[key] is None


def test_large_decimal_accumulation_keeps_all_provider_digits():
    data = snapshot()
    data["charts"][0]["spec_raw"] = data["charts"][0]["spec_raw"].replace("[0.1, 0.2, 0]", "[999999999999999999999999.9999, 0.0001, 0]")
    data["summary"][0]["value"] = "1000000000000000000000000"
    # The daily amounts each meet the input bound; the exact sum may add a digit.
    result = normalize_snapshot(raw(data), WALLET)
    assert result["summary"]["rent_volume"] == "1000000000000000000000000"


def test_provider_tile_rounding_reconciles_without_changing_daily_values():
    data = snapshot()
    for index in range(3):
        edit_value(data, 0, 0, index, 0.3333)
    data["summary"][0]["value"] = "1.00"
    result = normalize_snapshot(raw(data), WALLET)
    assert result["summary"]["rent_volume"] == "1"
    assert [day["rent_volume"] for day in result["daily"]] == ["0.3333"] * 3


@pytest.mark.parametrize("tile,amount,accepted", [("0", 0.0049, True), ("0", 0.005, False),
                                                  ("0", 0.49, False), ("0.333", 0.3334, True),
                                                  ("0.333", 0.3335, False), ("0.34", 0.335, True)])
def test_source_rounding_has_a_two_decimal_minimum_and_half_up_rule(tile, amount, accepted):
    data = snapshot()
    for index in range(3):
        edit_value(data, 0, 0, index, amount if index == 0 else 0)
    data["summary"][0]["value"] = tile
    if accepted:
        assert normalize_snapshot(raw(data), WALLET)["summary"]["rent_volume"] == tile
    else:
        with pytest.raises(PersonalAnalyticsError, match="totals do not match"):
            normalize_snapshot(raw(data), WALLET)


def test_empty_period_preserves_explicit_zeros_and_unknown_rates():
    data = snapshot()
    for index in [0, 1]:
        spec = json.loads(data["charts"][index]["spec_raw"])
        for series in spec["series"]:
            series["data"] = [0] * 3
        data["charts"][index]["spec_raw"] = json.dumps(spec)
    data["summary"] = [{"label": "Rent volume", "value": "0"}, {"label": "Rentals", "value": "0", "foot": "0 items"},
                       {"label": "Price per day", "value": ""}, {"label": "Average duration", "value": "—"}]
    result = normalize_snapshot(raw(data), WALLET)
    assert result["summary"]["rent_volume"] == "0"
    assert result["summary"]["rentals"] == 0
    assert result["summary"]["items"] == 0
    assert result["summary"]["price_per_day"] is None
    assert result["summary"]["average_duration"] is None


@pytest.mark.parametrize("wallet", [OTHER, TESTNET, "opaque-gift", FRIENDLY[:-1] + ("a" if FRIENDLY[-1] != "a" else "b")])
def test_wrong_wallet_invalid_checksum_and_testnet_are_rejected(wallet):
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(), wallet)


@pytest.mark.parametrize("url", [
    f"http://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent",
    f"https://marketapp.org.evil.test/user/{FRIENDLY}/?tab=analytics_rent",
    f"https://marketapp.org:443/user/{FRIENDLY}/?tab=analytics_rent",
    f"https://name:secret@marketapp.org/user/{FRIENDLY}/?tab=analytics_rent",
    f"https://marketapp.org/user/{Address(OTHER).to_str()}/?tab=analytics_rent",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_sale",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent&tab=analytics_rent",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent#session",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent&collection=abc",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent&token=secret",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent&period_by=last1day",
    f"https://marketapp.org/user/{FRIENDLY}/?tab=analytics_rent&group_by=secret",
])
def test_source_url_is_strict(url):
    data = snapshot()
    data["source_url"] = url
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


def test_documented_period_and_group_urls_are_accepted():
    data = snapshot()
    data["source_url"] += "&period_by=last90days&group_by=day"
    assert normalize_snapshot(raw(data), WALLET)["summary"]["rent_volume"] == "0.3"


@pytest.mark.parametrize("capture", ["2026-02-01", "2026-02-01T12:00:00", "wrong", None, "2026-01-31T23:00:00Z"])
def test_capture_timezone_required_and_future_days_rejected(capture):
    data = snapshot()
    data["captured_at"] = capture
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("gran", ["week", "month", "auto", None])
def test_aggregated_charts_have_clear_recovery_instruction(gran):
    data = snapshot()
    edit_chart(data, 0, "gran", gran)
    with pytest.raises(PersonalAnalyticsError, match="Choose By day"):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("dates", [[], ["2026-02-01", "2026-01-31", "2026-01-30"],
                                   ["2026-01-30", "2026-01-30", "2026-02-01"],
                                   ["2026-01-30", "2026-02-01", "2026-02-02"],
                                   ["2026-01-30", "2026-01-31", "2026-02-30"],
                                   ["2026-1-30", "2026-01-31", "2026-02-01"],
                                   ["9999-12-31", "9999-12-31", "9999-12-31"]])
def test_invalid_dates_rejected(dates):
    data = snapshot()
    edit_chart(data, 0, "x", dates)
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


def test_maximum366_daily_dates_supported_but367_rejected():
    for count in [366, 367]:
        data = snapshot()
        dates = [(date(2025, 1, 1) + timedelta(days=i)).isoformat() for i in range(count)]
        data["captured_at"] = "2026-01-02T00:00:00Z"
        data["summary"] = [{"label": "Rent volume", "value": "0"}, {"label": "Rentals", "value": "0"}]
        data["charts"] = data["charts"][:2]
        for chart in data["charts"]:
            spec = json.loads(chart["spec_raw"])
            spec["x"] = dates
            for series in spec["series"]:
                series["data"] = [0] * count
            chart["spec_raw"] = json.dumps(spec)
        if count == 366:
            assert len(normalize_snapshot(raw(data), WALLET)["daily"]) == 366
        else:
            with pytest.raises(PersonalAnalyticsError):
                normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("value", [None, -0.1, 0.12345, "0.1", True, float("inf"), float("nan"), 1e30])
def test_invalid_daily_money_rejected(value):
    data = snapshot()
    edit_value(data, 0, 0, 0, value)
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("value", [None, -1, 1.5, "1", True, 9_007_199_254_740_992])
def test_invalid_counts_rejected(value):
    data = snapshot()
    edit_value(data, 1, 0, 0, value)
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("index,value", [(0, "0.31"), (1, "5")])
def test_totals_must_reconcile(index, value):
    data = snapshot()
    data["summary"][index]["value"] = value
    with pytest.raises(PersonalAnalyticsError, match="totals do not match"):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("change", ["wrong_unit", "wrong_series", "duplicate_series", "misaligned", "optional_misaligned", "optional_bad_value", "missing_chart", "bad_name"])
def test_chart_schema_is_strict(change):
    data = snapshot()
    if change == "wrong_unit":
        edit_chart(data, 0, "unit", "TON")
    elif change == "wrong_series":
        edit_chart(data, 0, "series", [{"name": "Net income", "data": [0.1, 0.2, 0]}])
    elif change == "duplicate_series":
        spec = json.loads(data["charts"][1]["spec_raw"])
        spec["series"][1]["name"] = "New rentals"
        data["charts"][1]["spec_raw"] = json.dumps(spec)
    elif change == "misaligned":
        edit_chart(data, 1, "x", ["2026-01-29", "2026-01-30", "2026-01-31"])
    elif change == "optional_misaligned":
        edit_chart(data, 2, "x", ["2026-01-29", "2026-01-30", "2026-01-31"])
    elif change == "optional_bad_value":
        edit_value(data, 2, 0, 0, -1)
    elif change == "missing_chart":
        data["charts"].pop(0)
    else:
        edit_chart(data, 0, "series", [{"name": {}, "data": [0.1, 0.2, 0]}])
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("mutate", ["version", "source", "secret", "duplicate_summary", "missing_summary", "duplicate_chart", "unknown_extension"])
def test_metadata_and_summary_schema(mutate):
    data = snapshot()
    if mutate == "version":
        data["version"] = True
    elif mutate == "source":
        data["source"] = "portfolio_history"
    elif mutate == "secret":
        data["session"] = "Do not accept website credentials"
    elif mutate == "duplicate_summary":
        data["summary"].append(copy.deepcopy(data["summary"][0]))
    elif mutate == "missing_summary":
        data["summary"].pop(0)
    elif mutate == "duplicate_chart":
        data["charts"].append(copy.deepcopy(data["charts"][0]))
    else:
        data["summary"][4]["value"] = "101%"
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


def test_duplicate_json_keys_rejected_in_outer_and_chart_json():
    text = raw().replace('"version": 1', '"version": 1, "version": 1', 1)
    with pytest.raises(PersonalAnalyticsError, match="duplicate field"):
        normalize_snapshot(text, WALLET)
    data = snapshot()
    data["charts"][0]["spec_raw"] = data["charts"][0]["spec_raw"].replace('"unit": "GRAM"', '"unit": "GRAM", "unit": "GRAM"')
    with pytest.raises(PersonalAnalyticsError, match="duplicate field"):
        normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("text", ["{broken", "[]", "null", '{"value": NaN}'])
def test_invalid_json_is_a_validation_error(text):
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(text, WALLET)


def test_utf8_size_limit_and_optional_tables():
    data = snapshot()
    data["tables"] = [{"headers": ["Unrelated table"], "rows": []}]
    assert normalize_snapshot(raw(data), WALLET)["summary"]["rentals"] == 4
    with pytest.raises(PersonalAnalyticsError, match="256 KiB"):
        normalize_snapshot(" " * (MAX_SNAPSHOT_BYTES + 1), WALLET)
    with pytest.raises(PersonalAnalyticsError, match="UTF-8"):
        normalize_snapshot("\ud800", WALLET)


def test_additive_storage_preserves_existing_schema_and_raw_evidence(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA user_version=3")
        connection.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO jobs VALUES (7, 'old data')")
    original = raw()
    imported = import_snapshot(database, original, WALLET)
    assert latest_snapshot(database, NONBOUNCEABLE) == imported
    assert import_snapshot(database, original, FRIENDLY) == imported
    with sqlite3.connect(database) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 3
        assert connection.execute("SELECT * FROM jobs").fetchall() == [(7, "old data")]
        assert connection.execute("SELECT raw_snapshot FROM personal_analytics_snapshots").fetchall() == [(original,)]
        assert connection.execute("SELECT COUNT(*) FROM personal_analytics_snapshots").fetchone()[0] == 1


def test_later_import_of_older_capture_does_not_replace_latest(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    newer = snapshot()
    newer["captured_at"] = "2026-02-02T12:00:00Z"
    expected = import_snapshot(database, raw(newer), WALLET)
    older = import_snapshot(database, raw(), WALLET)
    assert older != expected
    assert latest_snapshot(database, WALLET) == expected
    assert latest_snapshot(database, OTHER) is None
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM personal_analytics_snapshots").fetchone()[0] == 2


def test_invalid_import_leaves_database_unchanged(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE existing (value TEXT)")
    with pytest.raises(PersonalAnalyticsError):
        import_snapshot(database, "{}", WALLET)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [("existing",)]


def test_latest_lookup_is_read_only_and_missing_table_does_not_create_it(tmp_path):
    database = tmp_path / "not-created.sqlite3"
    assert latest_snapshot(database, WALLET) is None
    assert not database.exists()
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE existing (value TEXT)")
    before = database.read_bytes()
    assert latest_snapshot(database, WALLET) is None
    assert database.read_bytes() == before


def test_import_is_atomic_when_storage_constraint_fails(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    import_snapshot(database, raw(), WALLET)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TRIGGER reject_snapshot BEFORE INSERT ON personal_analytics_snapshots BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    data = snapshot()
    data["captured_at"] = "2026-02-02T12:00:00Z"
    with pytest.raises(sqlite3.IntegrityError):
        import_snapshot(database, raw(data), WALLET)
    assert latest_snapshot(database, WALLET)["captured_at"] == "2026-02-01T12:30:00.123Z"


def period_snapshot(days, captured_at, wallet=WALLET):
    data = snapshot()
    data["wallet"] = wallet
    data["source_url"] = f"https://marketapp.org/user/{Address(wallet).to_str()}/?tab=analytics_rent"
    data["captured_at"] = captured_at
    data["summary"] = [{"label": "Rent volume", "value": "0"}, {"label": "Rentals", "value": "0"}]
    data["charts"] = data["charts"][:2]
    dates = [(date(2025, 1, 1) + timedelta(days=index)).isoformat() for index in range(days)]
    for entry in data["charts"]:
        spec = json.loads(entry["spec_raw"])
        spec["x"] = dates
        for series in spec["series"]:
            series["data"] = [0] * days
        entry["spec_raw"] = json.dumps(spec)
    return raw(data)


def test_snapshot_options_retain_latest_month_and_year_and_match_latest(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    older_month = import_snapshot(database, period_snapshot(30, "2026-01-02T00:00:00Z"), WALLET)
    year = import_snapshot(database, period_snapshot(365, "2026-01-03T00:00:00Z"), WALLET)
    month = import_snapshot(database, period_snapshot(30, "2026-01-04T00:00:00Z"), WALLET)
    import_snapshot(database, period_snapshot(365, "2026-01-05T00:00:00Z", OTHER), OTHER)
    assert snapshot_options(database, NONBOUNCEABLE) == [month, year]
    assert snapshot_options(database, WALLET)[0] == latest_snapshot(database, WALLET)
    assert older_month not in snapshot_options(database, WALLET)
    assert [len(item["daily"]) for item in snapshot_options(database, OTHER)] == [365]


def test_snapshot_options_are_bounded_to_eight_distinct_periods(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    for length in range(1, 11):
        import_snapshot(database, period_snapshot(length, f"2026-01-{length + 1:02}T00:00:00Z"), WALLET)
    options = snapshot_options(database, WALLET)
    assert len(options) == 8
    assert [len(item["daily"]) for item in options] == list(range(10, 2, -1))


def test_snapshot_options_find_older_year_beyond_many_newer_months(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    year = import_snapshot(database, period_snapshot(365, "2026-01-01T00:00:00Z"), WALLET)
    month = import_snapshot(database, period_snapshot(30, "2026-01-02T00:00:00Z"), WALLET)
    # Stored captures are already normalized. Seed a long refresh history to
    # verify the SQL query does not limit source rows before grouping periods.
    with sqlite3.connect(database) as connection:
        for index in range(100):
            newer = copy.deepcopy(month)
            newer["captured_at"] = f"2026-01-03T00:00:{index // 100:02}.{index:03}Z"
            newer["fingerprint"] = f"synthetic-month-{index}"
            connection.execute("INSERT INTO personal_analytics_snapshots(wallet,fingerprint,captured_at,raw_snapshot,normalized_json) VALUES(?,?,?,?,?)",
                               (WALLET, newer["fingerprint"], newer["captured_at"], "{}", json.dumps(newer)))
    options = snapshot_options(database, WALLET)
    assert options[0]["fingerprint"] == "synthetic-month-99"
    assert options[1] == year


def test_snapshot_options_empty_lookup_is_read_only(tmp_path):
    database = tmp_path / "not-created.sqlite3"
    assert snapshot_options(database, WALLET) == []
    assert not database.exists()
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE existing(value TEXT)")
    before = database.read_bytes()
    assert snapshot_options(database, WALLET) == []
    assert database.read_bytes() == before


def test_snapshot_options_nonempty_lookup_is_read_only(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    imported = import_snapshot(database, raw(), WALLET)
    before = database.read_bytes()
    assert snapshot_options(database, WALLET) == [imported]
    assert database.read_bytes() == before


def daily_capture(start, volumes, captured_at, *, starts=None, extensions=None, wallet=WALLET):
    """Build provider data while retaining exact numeric decimal lexemes."""
    starts = [1] * len(volumes) if starts is None else starts
    extensions = [0] * len(volumes) if extensions is None else extensions
    dates = [(date.fromisoformat(start) + timedelta(days=index)).isoformat() for index in range(len(volumes))]
    with localcontext() as context:
        context.prec = 40
        total = format(sum(map(Decimal, volumes), Decimal(0)), "f")
    data = snapshot()
    data.update(wallet=wallet, captured_at=captured_at,
                source_url=f"https://marketapp.org/user/{Address(wallet).to_str()}/?tab=analytics_rent")
    data["summary"] = [{"label": "Rent volume", "value": total},
                       {"label": "Rentals", "value": str(sum(starts) + sum(extensions)), "foot": "1 items"}]
    income = {"gran": "day", "unit": "GRAM", "x": dates,
              "series": [{"name": "Rent volume", "data": "__EXACT_DECIMALS__"}]}
    rentals = {"gran": "day", "unit": "", "x": dates,
               "series": [{"name": "New rentals", "data": starts}, {"name": "Extensions", "data": extensions}]}
    data["charts"] = [{"key": "profile.rent.income", "spec_raw": json.dumps(income).replace('"__EXACT_DECIMALS__"', "[" + ",".join(volumes) + "]")},
                      {"key": "profile.rent.rentals", "spec_raw": json.dumps(rentals)}]
    return raw(data)


def test_all_time_replaces_overlaps_and_capture_day_completes_on_later_capture(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    first = daily_capture("2026-01-01", ["0.1", "0.2", "0.3"], "2026-01-03T12:00:00Z", starts=[1, 2, 3], extensions=[0, 1, 0])
    import_snapshot(database, first, WALLET)
    second = daily_capture("2026-01-03", ["0.35", "0.4"], "2026-01-04T12:00:00Z", starts=[3, 4], extensions=[1, 0])
    import_snapshot(database, second, WALLET)
    result = all_time_snapshot(database, NONBOUNCEABLE)
    assert result["report_kind"] == "all_time"
    assert result["source_url"] is None
    assert result["wallet"] == WALLET
    assert [day["rent_volume"] for day in result["daily"]] == ["0.1", "0.2", "0.35", "0.4"]
    assert result["summary"]["rent_volume"] == "1.05"
    assert result["summary"]["rentals"] == 12
    assert result["summary"]["new_rentals"] == 10
    assert result["summary"]["extensions"] == 2
    assert result["coverage"] == {"observed_days": 4, "missing_days": 0, "partial_days": 1}
    assert [day["partial"] for day in result["daily"]] == [False, False, False, True]
    assert result["daily"][2]["captured_at"] == "2026-01-04T12:00:00.000Z"
    for key in ("items", "price_per_day", "average_duration", "extension_percent", "spent_on_rent", "spending_rentals"):
        assert result["summary"][key] is None
    # A late import and exact replay cannot displace newer daily observations.
    import_snapshot(database, first, WALLET)
    assert all_time_snapshot(database, WALLET) == result
    complete = json.loads(second)
    complete["captured_at"] = "2026-01-05T12:00:00Z"
    import_snapshot(database, raw(complete), WALLET)
    assert all_time_snapshot(database, WALLET)["coverage"]["partial_days"] == 0
    assert latest_snapshot(database, WALLET)["daily"][-1].get("partial") is None, "saved evidence is not rewritten"


def test_all_time_keeps_missing_dates_distinct_from_observed_zero(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    import_snapshot(database, daily_capture("2026-01-01", ["0"], "2026-01-01T18:00:00Z", starts=[0]), WALLET)
    import_snapshot(database, daily_capture("2026-01-03", ["0.1"], "2026-01-03T18:00:00Z"), WALLET)
    result = all_time_snapshot(database, WALLET)
    assert [day["date"] for day in result["daily"]] == ["2026-01-01", "2026-01-03"]
    assert result["daily"][0]["rent_volume"] == "0"
    assert result["coverage"] == {"observed_days": 2, "missing_days": 1, "partial_days": 2}
    assert result["period_start"] == "2026-01-01"
    assert result["period_end"] == "2026-01-03"


def test_all_time_capture_ties_are_fingerprint_ordered_not_import_order(tmp_path):
    raws = [daily_capture("2026-01-01", [value], "2026-01-02T00:00:00Z") for value in ("0.1", "0.2")]
    expected = max((normalize_snapshot(text, WALLET) for text in raws), key=lambda item: item["fingerprint"])
    results = []
    for index, captures in enumerate((raws, list(reversed(raws)))):
        database = tmp_path / f"order-{index}.sqlite3"
        for text in captures:
            import_snapshot(database, text, WALLET)
        results.append(all_time_snapshot(database, WALLET))
    assert results[0] == results[1]
    assert results[0]["daily"][0]["rent_volume"] == expected["daily"][0]["rent_volume"]


def test_all_time_sums_daily_precision_instead_of_rounded_summary_tiles(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    data = json.loads(daily_capture("2026-01-01", ["0.3333"] * 3, "2026-01-04T00:00:00Z"))
    data["summary"][0]["value"] = "1.00"
    import_snapshot(database, raw(data), WALLET)
    assert latest_snapshot(database, WALLET)["summary"]["rent_volume"] == "1"
    assert all_time_snapshot(database, WALLET)["summary"]["rent_volume"] == "0.9999"
    import_snapshot(database, daily_capture("2026-01-04", ["999999999999999999999999.9999"], "2026-01-05T00:00:00Z"), WALLET)
    assert all_time_snapshot(database, WALLET)["summary"]["rent_volume"] == "1000000000000000000000000.9998"


def test_all_time_keeps_days_beyond_fixed_options_and_annual_window(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    import_snapshot(database, daily_capture("2024-01-01", ["0.0001"] * 366, "2025-01-01T00:00:00Z"), WALLET)
    import_snapshot(database, daily_capture("2025-01-01", ["0.0001"] * 365, "2026-01-01T00:00:00Z"), WALLET)
    for day in range(1, 11):
        import_snapshot(database, daily_capture(f"2026-01-{day:02}", ["0.0001"], f"2026-01-{day + 1:02}T00:00:00Z"), WALLET)
    result = all_time_snapshot(database, WALLET)
    assert len(snapshot_options(database, WALLET)) == 3
    assert len(result["daily"]) == 741
    assert result["coverage"] == {"observed_days": 741, "missing_days": 0, "partial_days": 0}
    assert result["summary"]["rent_volume"] == "0.0741"
    assert result["summary"]["rentals"] == 741


def test_all_time_is_read_only_wallet_scoped_and_skips_malformed_normalized_evidence(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    assert all_time_snapshot(database, WALLET) is None
    assert not database.exists()
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE existing(value TEXT)")
    before = database.read_bytes()
    assert all_time_snapshot(database, WALLET) is None
    assert database.read_bytes() == before
    saved = import_snapshot(database, raw(), WALLET)
    import_snapshot(database, daily_capture("2026-01-01", ["99"], "2026-02-02T00:00:00Z", wallet=OTHER), OTHER)
    newer = snapshot()
    newer["captured_at"] = "2026-02-02T00:00:00Z"
    wrong = import_snapshot(database, raw(newer), WALLET)
    with sqlite3.connect(database) as connection:
        changed = {**wrong, "wallet": OTHER}
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=? WHERE fingerprint=?",
                           (json.dumps(changed), wrong["fingerprint"]))
    before = database.read_bytes()
    result = all_time_snapshot(database, WALLET)
    assert result["captured_at"] == saved["captured_at"]
    assert result["summary"]["rent_volume"] == "0.3"
    assert all_time_snapshot(database, OTHER)["summary"]["rent_volume"] == "99"
    assert database.read_bytes() == before


def test_all_time_does_not_round_counts_outside_json_safe_integer_range(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    for day in (1, 2):
        import_snapshot(database, daily_capture(f"2026-01-{day:02}", ["0"], "2026-01-03T00:00:00Z",
                                               starts=[9_007_199_254_740_991]), WALLET)
    assert all_time_snapshot(database, WALLET) is None


def test_all_time_future_captures_cannot_replace_valid_daily_evidence(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    original = import_snapshot(database, raw(), WALLET)
    future = snapshot()
    future["captured_at"] = "9999-12-31T23:59:59Z"
    with pytest.raises(PersonalAnalyticsError, match="future"):
        import_snapshot(database, raw(future), WALLET)
    # Previously accepted evidence remains stored, but cannot poison the daily
    # latest-capture winner even if its imported timestamp was also malformed.
    for captured_at, imported_at in (("2026-02-03T00:00:00Z", "2026-02-02T00:00:00.000Z"),
                                    ("9999-12-31T00:00:00Z", "9999-12-31T01:00:00.000Z")):
        future["captured_at"] = captured_at
        normalized = normalize_snapshot(raw(future), WALLET)
        with sqlite3.connect(database) as connection:
            connection.execute("INSERT INTO personal_analytics_snapshots(wallet,fingerprint,captured_at,raw_snapshot,normalized_json,imported_at) VALUES(?,?,?,?,?,?)",
                               (WALLET, normalized["fingerprint"], normalized["captured_at"], raw(future), json.dumps(normalized), imported_at))
    result = all_time_snapshot(database, WALLET)
    assert result["captured_at"] == original["captured_at"]
    assert result["summary"]["rent_volume"] == "0.3"


ITEM = "0:" + "33" * 32
ITEM_FRIENDLY = Address(ITEM).to_str()
OTHER_ITEM = "0:" + "44" * 32


def top_item(*, item=ITEM, name="Heart Locket #1767", rentals="5", days="53", volume="19.15", rate="0.36"):
    return {"name": name, "item_url": f"/nft/{Address(item).to_str()}/", "rentals": rentals,
            "rented_days": days, "volume": volume, "price_per_day": rate}


def with_top_items(text, items=None, *, status="available", legacy=False):
    data = json.loads(text)
    items = [top_item()] if items is None else items
    if legacy:
        data["tables"] = [{"headers": ["Item", "Rentals", "Rented days", "Volume", "Price per day"],
                           "rows": [{"cells": [item[key] for key in ("name", "rentals", "rented_days", "volume", "price_per_day")],
                                     "links": [{"label": item["name"], "url": item["item_url"]}]} for item in items]}]
    else:
        data["top_items"] = {"status": status, "items": items}
    return raw(data)


def test_top_items_preserve_provider_figures_and_gift_identity_without_public_history():
    result = normalize_snapshot(with_top_items(raw()), WALLET)
    table = result["top_items"]
    assert table == {"status": "available", "scope": "marketapp_top_items", "items": [{
        "item_key": ITEM, "item_url": f"https://marketapp.org/nft/{ITEM_FRIENDLY}/", "name": "Heart Locket #1767",
        "rentals": 5, "rented_days": "53", "volume": "19.15", "price_per_day": "0.36"}]}
    assert normalize_snapshot(with_top_items(raw(), legacy=True), WALLET) == result
    assert result["period_start"] == "2026-01-30"
    assert result["period_end"] == "2026-02-01"


def test_top_items_unknown_and_provider_empty_are_distinct():
    assert normalize_snapshot(raw(), WALLET)["top_items"] == {"status": "missing", "scope": "marketapp_top_items", "items": []}
    assert normalize_snapshot(with_top_items(raw(), []), WALLET)["top_items"]["status"] == "available"
    for value in (None, "", "—"):
        result = normalize_snapshot(with_top_items(raw(), [top_item(rate=value)]), WALLET)
        assert result["top_items"]["items"][0]["price_per_day"] is None


@pytest.mark.parametrize("field,value", [
    ("rentals", "1.5"), ("rentals", True), ("rentals", "9007199254740992"), ("rentals", "-1"),
    ("rented_days", None), ("rented_days", "1e2"), ("volume", "0.12345"), ("volume", "NaN"),
    ("price_per_day", "Infinity"), ("name", ""), ("name", "Secret\nname"), ("name", "x" * 201),
])
def test_top_items_reject_invalid_values(field, value):
    item = top_item()
    item[field] = value
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(with_top_items(raw(), [item]), WALLET)


@pytest.mark.parametrize("url", [
    "javascript:alert(1)", f"//evil.test/nft/{ITEM_FRIENDLY}/", f"https://marketapp.org.evil.test/nft/{ITEM_FRIENDLY}/",
    f"http://marketapp.org/nft/{ITEM_FRIENDLY}/", f"https://secret@marketapp.org/nft/{ITEM_FRIENDLY}/",
    f"https://marketapp.org:443/nft/{ITEM_FRIENDLY}/", f"/nft/{ITEM_FRIENDLY}/?token=secret",
    f"/nft/{ITEM_FRIENDLY}/#secret", f"/nft/{Address(ITEM).to_str(is_test_only=True)}/", "/nft/unknown-gift/",
])
def test_top_items_reject_unsafe_or_unverified_gift_links(url):
    item = top_item()
    item["item_url"] = url
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(with_top_items(raw(), [item]), WALLET)


def test_top_items_duplicate_aliases_and_disagreeing_sources_are_rejected():
    alias = top_item()
    alias["item_url"] = f"/nft/{Address(ITEM).to_str(is_bounceable=False)}/"
    with pytest.raises(PersonalAnalyticsError, match="ambiguous"):
        normalize_snapshot(with_top_items(raw(), [top_item(), alias]), WALLET)
    data = json.loads(with_top_items(with_top_items(raw()), legacy=True))
    assert len(normalize_snapshot(raw(data), WALLET)["top_items"]["items"]) == 1
    data["tables"][0]["rows"][0]["cells"][3] = "9"
    with pytest.raises(PersonalAnalyticsError, match="disagree"):
        normalize_snapshot(raw(data), WALLET)


def test_top_items_large_amounts_preserve_decimal_digits():
    value = "999999999999999999999999.9999"
    result = normalize_snapshot(with_top_items(raw(), [top_item(volume=value)]), WALLET)
    assert result["top_items"]["items"][0]["volume"] == value


def collection_item(*, name="Heart Locket", rentals="17", volume="35.27", rate="0.31"):
    return {"name": name, "rentals": rentals, "volume": volume, "price_per_day": rate}


def with_collections(text, items=None, *, status="available", legacy=False):
    data = json.loads(text)
    items = [collection_item()] if items is None else items
    if legacy:
        data.setdefault("tables", []).append({"headers": ["Collection", "Rentals", "Volume", "Price per day"],
            "rows": [{"cells": [item[key] for key in ("name", "rentals", "volume", "price_per_day")], "links": []}
                     for item in items]})
    else:
        data["by_collection"] = {"status": status, "items": items}
    return raw(data)


def with_wide_collections(text, items=None):
    data = json.loads(text)
    items = [collection_item()] if items is None else items
    data.setdefault("tables", []).append({
        "headers": ["", "Collection", "Rentals", "Volume", "Price per day", "Average duration", "Share of volume"],
        "rows": [{"cells": ["", item["name"], item["rentals"], item["volume"], item["price_per_day"], "3.5 days", "2.5%"],
                  "links": [{"label": "", "url": "/collection/example/"},
                            {"label": item["name"], "url": "https://marketapp.org/collection/example/"}]}
                 for item in items]})
    return raw(data)


def test_collection_full_provider_table_maps_financial_columns_and_drops_extra_data():
    wide = normalize_snapshot(with_wide_collections(with_top_items(raw())), WALLET)
    compact = normalize_snapshot(with_collections(with_top_items(raw())), WALLET)
    assert wide == compact
    assert set(wide["by_collection"]["items"][0]) == {"collection_key", "name", "rentals", "volume", "price_per_day"}
    assert normalize_snapshot(with_wide_collections(raw(), []), WALLET)["by_collection"]["items"] == []


@pytest.mark.parametrize("change", [
    "extra_header", "reordered_header", "thumbnail_text", "missing_thumbnail_link", "duplicate_name_link",
    "mismatched_thumbnail_url", "external_thumbnail_url", "extra_link", "extra_cell", "wrong_name_link",
    "long_unused_metric", "control_unused_metric",
])
def test_collection_full_provider_table_rejects_ambiguous_layout_or_links(change):
    data = json.loads(with_wide_collections(raw()))
    table = data["tables"][0]
    row = table["rows"][0]
    if change == "extra_header": table["headers"].append("Other")
    elif change == "reordered_header": table["headers"][2:4] = ["Volume", "Rentals"]
    elif change == "thumbnail_text": row["cells"][0] = "Another collection"
    elif change == "missing_thumbnail_link": row["links"].pop(0)
    elif change == "duplicate_name_link": row["links"][0]["label"] = row["cells"][1]
    elif change == "mismatched_thumbnail_url": row["links"][0]["url"] = "/collection/another/"
    elif change == "external_thumbnail_url": row["links"][0]["url"] = "https://evil.test/collection/example/"
    elif change == "extra_link": row["links"].append(copy.deepcopy(row["links"][1]))
    elif change == "extra_cell": row["cells"].append("Other")
    elif change == "wrong_name_link": row["links"][1]["label"] = "Another collection"
    elif change == "long_unused_metric": row["cells"][5] = "x" * 201
    elif change == "control_unused_metric": row["cells"][6] = "2\n5%"
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)


def test_collection_full_and_compact_table_duplicates_are_rejected():
    with pytest.raises(PersonalAnalyticsError, match="duplicate"):
        normalize_snapshot(with_wide_collections(with_collections(raw(), legacy=True)), WALLET)


def test_collection_full_provider_table_recovers_old_missing_projection_read_only(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    saved = import_snapshot(database, with_wide_collections(with_top_items(raw())), WALLET)
    expected = saved["by_collection"]
    saved["by_collection"] = {"status": "missing", "scope": "marketapp_by_collection", "items": []}
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=?", (json.dumps(saved),))
    before = database.read_bytes()
    assert latest_snapshot(database, WALLET)["by_collection"] == expected
    assert snapshot_options(database, WALLET)[0]["by_collection"] == expected
    assert all_time_snapshot(database, WALLET)["by_collection"]["items"][0]["volume"] == "35.27"
    assert database.read_bytes() == before


def test_collection_totals_are_provider_figures_not_a_sum_of_top_items():
    result = normalize_snapshot(with_collections(with_top_items(raw())), WALLET)
    assert result["by_collection"] == {"status": "available", "scope": "marketapp_by_collection", "items": [{
        "collection_key": "name:heart locket", "name": "Heart Locket", "rentals": 17,
        "volume": "35.27", "price_per_day": "0.31"}]}
    assert result["top_items"]["items"][0]["volume"] == "19.15"
    assert "rented_days" not in result["by_collection"]["items"][0]
    assert normalize_snapshot(with_collections(with_top_items(raw(), legacy=True), legacy=True), WALLET) == result
    assert normalize_snapshot(with_top_items(raw()), WALLET)["by_collection"] == {
        "status": "missing", "scope": "marketapp_by_collection", "items": []}


def test_collection_identity_normalizes_whitespace_without_colliding_names():
    result = normalize_snapshot(with_collections(raw(), [collection_item(name="\ufeff Heart\u00a0  Locket \u3000")]), WALLET)
    assert result["by_collection"]["items"][0]["name"] == "Heart Locket"
    assert result["by_collection"]["items"][0]["collection_key"] == "name:heart locket"
    with pytest.raises(PersonalAnalyticsError, match="ambiguous"):
        normalize_snapshot(with_collections(raw(), [collection_item(), collection_item(name="heart  LOCKET")]), WALLET)


def test_collection_missing_empty_and_unknown_rate_are_distinct():
    assert normalize_snapshot(with_collections(raw(), []), WALLET)["by_collection"]["status"] == "available"
    for rate in (None, "", "—", "–", "-"):
        value = normalize_snapshot(with_collections(raw(), [collection_item(rate=rate)]), WALLET)
        assert value["by_collection"]["items"][0]["price_per_day"] is None
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(with_collections(raw(), status="missing"), WALLET)


@pytest.mark.parametrize("field,value", [
    ("rentals", "1.5"), ("rentals", True), ("rentals", "9007199254740992"), ("rentals", "-1"),
    ("volume", None), ("volume", "1e2"), ("volume", "0.12345"), ("volume", "NaN"),
    ("price_per_day", "Infinity"), ("name", ""), ("name", "Heart\tLocket"), ("name", "x" * 201),
    ("name", "🧡" * 101),
])
def test_collection_rows_reject_invalid_source_values(field, value):
    item = collection_item()
    item[field] = value
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(with_collections(raw(), [item]), WALLET)


def test_collection_table_and_sources_must_be_unambiguous_and_bounded():
    data = json.loads(with_collections(with_collections(raw()), legacy=True))
    assert len(normalize_snapshot(raw(data), WALLET)["by_collection"]["items"]) == 1
    data["tables"][0]["rows"][0]["cells"][2] = "99"
    with pytest.raises(PersonalAnalyticsError, match="disagree"):
        normalize_snapshot(raw(data), WALLET)
    data = json.loads(with_collections(raw(), legacy=True))
    data["tables"].append(copy.deepcopy(data["tables"][0]))
    with pytest.raises(PersonalAnalyticsError, match="duplicate"):
        normalize_snapshot(raw(data), WALLET)
    rows = [collection_item(name=f"Collection {index}") for index in range(201)]
    with pytest.raises(PersonalAnalyticsError, match="bounded"):
        normalize_snapshot(with_collections(raw(), rows), WALLET)
    assert len(normalize_snapshot(with_collections(raw(), rows[:200]), WALLET)["by_collection"]["items"]) == 200


@pytest.mark.parametrize("url,valid", [
    ("/collection/heart-locket/", True), ("https://marketapp.org/collection/heart-locket/", True),
    ("//evil.test/", False), ("https://marketapp.org.evil.test/", False), ("javascript:alert(1)", False),
    ("https://secret@marketapp.org/", False), ("https://marketapp.org:443/", False),
    ("/\\evil.test/", False), ("/collection/ bad/", False),
])
def test_collection_legacy_links_are_optional_and_bounded_to_marketapp(url, valid):
    data = json.loads(with_collections(raw(), legacy=True))
    data["tables"][0]["rows"][0]["links"] = [{"label": "Heart Locket", "url": url}]
    if valid:
        item = normalize_snapshot(raw(data), WALLET)["by_collection"]["items"][0]
        assert "url" not in item and "collection_url" not in item
    else:
        with pytest.raises(PersonalAnalyticsError):
            normalize_snapshot(raw(data), WALLET)


def test_collection_amounts_preserve_exact_decimal_digits():
    amount = "99999999999999999999999999.0002"
    result = normalize_snapshot(with_collections(raw(), [collection_item(volume=amount)]), WALLET)
    assert result["by_collection"]["items"][0]["volume"] == amount


def test_collection_legacy_recovery_is_read_only_and_checks_immutable_report_fields(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    text = with_collections(with_top_items(raw(), legacy=True), legacy=True)
    saved = import_snapshot(database, text, WALLET)
    old = {key: value for key, value in saved.items() if key not in {"top_items", "by_collection"}}
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=?", (json.dumps(old),))
    before = database.read_bytes()
    assert latest_snapshot(database, WALLET)["by_collection"] == saved["by_collection"]
    assert snapshot_options(database, WALLET)[0]["by_collection"] == saved["by_collection"]
    assert all_time_snapshot(database, WALLET)["by_collection"]["items"][0]["volume"] == "35.27"
    assert database.read_bytes() == before
    old["volume_basis"] = "incorrect_basis"
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=?", (json.dumps(old),))
    assert "by_collection" not in latest_snapshot(database, WALLET)


def test_all_time_collection_totals_skip_overlapping_reports_and_unknown_average_denominator(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    windows = [
        ("2026-01-01", 30, "2026-01-31T00:00:00Z", collection_item(rentals="2", volume="1.2", rate="0.2")),
        ("2026-01-15", 30, "2026-02-15T00:00:00Z", collection_item(rentals="4", volume="2.1", rate="0.3")),
        ("2026-01-31", 30, "2026-03-02T00:00:00Z", collection_item(rentals="6", volume="2.8", rate="0.4")),
    ]
    for start, length, capture, item in windows:
        import_snapshot(database, with_collections(daily_capture(start, ["0"] * length, capture), [item]), WALLET)
    report = all_time_snapshot(database, WALLET)["by_collection"]
    assert report["scope"] == "saved_non_overlapping_reports" and report["incomplete"] is True
    item = report["items"][0]
    assert (item["rentals"], item["volume"], item["price_per_day"]) == (8, "4", None)
    assert "rented_days" not in item
    assert item["coverage"]["observed_days"] == 60 and item["coverage"]["missing_days"] == 0
    assert [period["period_start"] for period in item["coverage"]["periods"]] == ["2026-01-01", "2026-01-31"]


def test_all_time_collection_history_keeps_missing_rows_and_scopes_wallets(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    text = daily_capture("2026-01-01", ["0"] * 30, "2026-01-31T00:00:00Z")
    import_snapshot(database, with_collections(text), WALLET)
    later = json.loads(text)
    later["captured_at"] = "2026-02-01T00:00:00Z"
    import_snapshot(database, with_collections(raw(later), [collection_item(rentals="18", volume="37")]), WALLET)
    later["captured_at"] = "2026-02-02T00:00:00Z"
    import_snapshot(database, with_collections(raw(later), []), WALLET)
    other = daily_capture("2026-01-01", ["0"] * 30, "2026-02-02T00:00:00Z", wallet=OTHER)
    import_snapshot(database, with_collections(other, [collection_item(rentals="99", volume="99")]), OTHER)
    item = all_time_snapshot(database, WALLET)["by_collection"]["items"][0]
    assert (item["rentals"], item["volume"], item["price_per_day"]) == (18, "37", "0.31")
    assert item["captured_at"] == "2026-02-01T00:00:00.000Z"
    assert latest_snapshot(database, WALLET)["by_collection"]["items"] == []


def test_invalid_saved_collections_do_not_poison_daily_or_gift_analytics(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    saved = import_snapshot(database, with_collections(with_top_items(raw())), WALLET)
    saved["by_collection"]["items"][0]["collection_key"] = "name:wrong collection"
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=?", (json.dumps(saved),))
    result = all_time_snapshot(database, WALLET)
    assert result["summary"]["rent_volume"] == "0.3"
    assert result["top_items"]["items"][0]["volume"] == "19.15"
    assert result["by_collection"]["status"] == "missing"
    assert latest_snapshot(database, WALLET)["by_collection"]["status"] == "missing"


def test_top_items_legacy_evidence_is_backfilled_on_read_without_rewriting(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    text = with_top_items(raw(), legacy=True)
    saved = import_snapshot(database, text, WALLET)
    with sqlite3.connect(database) as connection:
        old = {key: value for key, value in saved.items() if key != "top_items"}
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=?", (json.dumps(old),))
    before = database.read_bytes()
    assert latest_snapshot(database, WALLET)["top_items"] == saved["top_items"]
    assert snapshot_options(database, WALLET)[0]["top_items"] == saved["top_items"]
    assert all_time_snapshot(database, WALLET)["top_items"]["items"][0]["volume"] == "19.15"
    assert database.read_bytes() == before


def test_all_time_top_items_keep_nonoverlapping_reports_and_do_not_sum_sliding_windows(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    windows = [
        ("2026-01-01", 30, "2026-01-31T00:00:00Z", top_item(rentals="2", volume="1.2", days="6", rate="0.2")),
        ("2026-01-15", 30, "2026-02-15T00:00:00Z", top_item(rentals="4", volume="2.1", days="7", rate="0.3")),
        ("2026-01-31", 30, "2026-03-02T00:00:00Z", top_item(rentals="6", volume="2.8", days="7", rate="0.4")),
    ]
    for start, length, capture, item in windows:
        import_snapshot(database, with_top_items(daily_capture(start, ["0"] * length, capture), [item]), WALLET)
    result = all_time_snapshot(database, WALLET)["top_items"]
    assert result["scope"] == "saved_non_overlapping_reports"
    assert result["incomplete"] is True
    item = result["items"][0]
    assert (item["rentals"], item["volume"], item["rented_days"], item["price_per_day"]) == (8, "4", "13", "0.3077")
    assert item["coverage"] == {"observed_days": 60, "missing_days": 0, "partial_days": 0, "periods": [
        {"period_start": "2026-01-01", "period_end": "2026-01-30", "captured_at": "2026-01-31T00:00:00.000Z"},
        {"period_start": "2026-01-31", "period_end": "2026-03-01", "captured_at": "2026-03-02T00:00:00.000Z"}]}


def test_all_time_top_items_prefer_larger_coverage_and_newer_same_window_without_erasing_missing_gifts(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    year = daily_capture("2025-01-01", ["0"] * 365, "2026-01-01T00:00:00Z")
    import_snapshot(database, with_top_items(year, [top_item(rentals="8", volume="12", days="33", rate="0.3636")]), WALLET)
    month = daily_capture("2025-12-01", ["0"] * 30, "2026-01-02T00:00:00Z")
    import_snapshot(database, with_top_items(month, [top_item(rentals="2", volume="2", days="5", rate="0.4")]), WALLET)
    result = all_time_snapshot(database, WALLET)["top_items"]["items"][0]
    assert result["rentals"] == 8 and result["volume"] == "12"
    assert result["price_per_day"] == "0.3636", "one provider report keeps its displayed rate"
    assert result["coverage"]["observed_days"] == 365
    newer_year = json.loads(year)
    newer_year["captured_at"] = "2026-01-03T00:00:00Z"
    import_snapshot(database, with_top_items(raw(newer_year), [top_item(rentals="9", volume="13", days="35")]), WALLET)
    newer_year["captured_at"] = "2026-01-04T00:00:00Z"
    import_snapshot(database, with_top_items(raw(newer_year), []), WALLET)
    result = all_time_snapshot(database, WALLET)["top_items"]["items"][0]
    assert result["rentals"] == 9 and result["volume"] == "13"
    assert latest_snapshot(database, WALLET)["top_items"]["items"] == []


def test_all_time_top_items_missing_coverage_and_wallet_scope_are_honest(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    import_snapshot(database, with_top_items(daily_capture("2026-01-01", ["0"], "2026-01-01T12:00:00Z")), WALLET)
    import_snapshot(database, daily_capture("2026-01-03", ["0"], "2026-01-04T12:00:00Z"), WALLET)
    import_snapshot(database, with_top_items(daily_capture("2026-01-01", ["0"], "2026-01-01T18:00:00Z", wallet=OTHER),
                                            [top_item(rentals="99", volume="100")]), OTHER)
    item = all_time_snapshot(database, WALLET)["top_items"]["items"][0]
    assert item["rentals"] == 5
    assert item["coverage"]["observed_days"] == 1
    assert item["coverage"]["missing_days"] == 2
    assert item["coverage"]["partial_days"] == 1
    assert latest_snapshot(database, WALLET)["top_items"]["status"] == "missing"


def test_all_time_top_items_invalid_saved_rows_do_not_poison_daily_analytics(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    saved = import_snapshot(database, with_top_items(raw()), WALLET)
    saved["top_items"]["items"][0]["item_key"] = OTHER_ITEM
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE personal_analytics_snapshots SET normalized_json=?", (json.dumps(saved),))
    result = all_time_snapshot(database, WALLET)
    assert result["summary"]["rent_volume"] == "0.3"
    assert result["top_items"]["status"] == "missing"
    assert latest_snapshot(database, WALLET)["top_items"]["status"] == "missing"


def test_all_time_top_items_do_not_inherit_future_or_wrong_period_evidence(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    valid = import_snapshot(database, with_top_items(raw()), WALLET)
    future = snapshot()
    future["captured_at"] = "9999-12-31T00:00:00Z"
    normalized = normalize_snapshot(with_top_items(raw(future), [top_item(volume="9999")]), WALLET)
    with sqlite3.connect(database) as connection:
        connection.execute("INSERT INTO personal_analytics_snapshots(wallet,fingerprint,captured_at,raw_snapshot,normalized_json,imported_at) VALUES(?,?,?,?,?,?)",
                           (WALLET, normalized["fingerprint"], normalized["captured_at"], "{}", json.dumps(normalized), "9999-12-31T01:00:00Z"))
        wrong_period = copy.deepcopy(valid)
        wrong_period["period_start"] = "2020-01-01"
        wrong_period["fingerprint"] = "f" * 64
        connection.execute("INSERT INTO personal_analytics_snapshots(wallet,fingerprint,captured_at,raw_snapshot,normalized_json) VALUES(?,?,?,?,?)",
                           (WALLET, wrong_period["fingerprint"], wrong_period["captured_at"], "{}", json.dumps(wrong_period)))
    result = all_time_snapshot(database, WALLET)["top_items"]["items"][0]
    assert result["volume"] == "19.15"
    assert result["coverage"]["observed_days"] == 3


def test_all_time_top_items_equal_coverage_prefers_freshness_not_larger_money(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    older = with_top_items(daily_capture("2026-01-01", ["0"] * 3, "2026-01-04T00:00:00Z"), [top_item(volume="99")])
    newer = with_top_items(daily_capture("2026-01-02", ["0"] * 3, "2026-01-05T00:00:00Z"), [top_item(volume="1")])
    for text in (newer, older):
        import_snapshot(database, text, WALLET)
    item = all_time_snapshot(database, WALLET)["top_items"]["items"][0]
    assert item["volume"] == "1"
    assert item["coverage"]["missing_days"] == 1


def test_all_time_top_items_decimal_sort_keeps_precision_beyond_default_decimal_context(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    import_snapshot(database, with_top_items(raw(), [
        top_item(item=ITEM, volume="99999999999999999999999999.0001"),
        top_item(item=OTHER_ITEM, volume="99999999999999999999999999.0002"),
    ]), WALLET)
    items = all_time_snapshot(database, WALLET)["top_items"]["items"]
    assert [row["item_key"] for row in items] == [OTHER_ITEM, ITEM]
    assert items[0]["volume"] == "99999999999999999999999999.0002"


def combined_capture():
    data = json.loads(with_top_items(raw()))
    income = json.loads(data["charts"][0]["spec_raw"])
    rentals = json.loads(data["charts"][1]["spec_raw"])
    spec = {"categories": None, "combo": True, "gran": "day", "kind": "column", "stacking": "normal", "unit": "", "x": income["x"],
            "series": [{**row, "type": "column", "axis": 0, "unit": "", "color": index, "opacity": 1} for index, row in enumerate(rentals["series"])]
                      + [{**income["series"][0], "type": "line", "axis": 1, "unit": "GRAM", "color": 2}]}
    data["charts"] = [{"key": "profile.rent.activity", "spec_raw": json.dumps(spec)}] + data["charts"][2:]
    return data


def test_combined_activity_chart_matches_separate_financial_evidence_and_top_items():
    combined = normalize_snapshot(raw(combined_capture()), WALLET)
    separate = normalize_snapshot(with_top_items(raw()), WALLET)
    assert combined == separate


def test_combined_activity_numeric_lexemes_and_displayed_integer_rounding_are_exact():
    data = combined_capture()
    data["charts"][0]["spec_raw"] = data["charts"][0]["spec_raw"].replace("[0.1, 0.2, 0]", "[9007199254740993.0001, 0, 0]")
    data["summary"][0]["value"] = "9007199254740993.0001"
    normalized = normalize_snapshot(raw(data), WALLET)
    assert normalized["daily"][0]["rent_volume"] == "9007199254740993.0001"
    assert normalized["summary"]["rent_volume"] == "9007199254740993.0001"
    for shown, accepted in [("3", True), ("3.49", True), ("3.5", True), ("3.4", False), ("4", False)]:
        data = combined_capture()
        data["charts"][0]["spec_raw"] = data["charts"][0]["spec_raw"].replace("[0.1, 0.2, 0]", "[3.49, 0, 0]")
        data["summary"][0]["value"] = shown
        if accepted:
            assert normalize_snapshot(raw(data), WALLET)["daily"][0]["rent_volume"] == "3.49"
        else:
            with pytest.raises(PersonalAnalyticsError, match="totals do not match"):
                normalize_snapshot(raw(data), WALLET)


@pytest.mark.parametrize("change", ["axis", "unit", "series_type", "duplicate_series", "missing_series", "unknown_field",
                                   "combo", "gran", "categories", "color", "opacity", "ambiguous_legacy"])
def test_combined_activity_rejects_unknown_layout_or_ambiguous_interpretations(change):
    data = combined_capture()
    spec = json.loads(data["charts"][0]["spec_raw"])
    if change == "axis":
        spec["series"][2]["axis"] = 0
    elif change == "unit":
        spec["series"][2]["unit"] = "TON"
    elif change == "series_type":
        spec["series"][2]["type"] = "column"
    elif change == "duplicate_series":
        spec["series"][1]["name"] = "New rentals"
    elif change == "missing_series":
        spec["series"].pop()
    elif change == "unknown_field":
        spec["normalize"] = True
    elif change == "combo":
        spec["combo"] = 1
    elif change == "gran":
        spec["gran"] = "month"
    elif change == "categories":
        del spec["categories"]
    elif change == "color":
        spec["series"][0]["color"] = 256
    elif change == "opacity":
        spec["series"][0]["opacity"] = 1.001
    elif change == "ambiguous_legacy":
        data["charts"].append(snapshot()["charts"][0])
    data["charts"][0]["spec_raw"] = json.dumps(spec)
    with pytest.raises(PersonalAnalyticsError):
        normalize_snapshot(raw(data), WALLET)
