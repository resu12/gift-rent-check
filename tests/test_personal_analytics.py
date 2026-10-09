"""Synthetic personal analytics evidence; no user data or login credentials."""

from __future__ import annotations

import copy
import json
import sqlite3
from datetime import date, timedelta

import pytest
from pytoniq_core import Address

from marketapp_rent.personal_analytics import (
    MAX_SNAPSHOT_BYTES,
    PersonalAnalyticsError,
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
    data["tables"] = [{"headers": ["Collection"], "rows": []}]
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
