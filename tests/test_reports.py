import csv
from decimal import Decimal

from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.reports import export_reports, status
from marketapp_rent.storage import Store
from marketapp_rent.util import canonical_json


def read_report(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def add_page(store, run_id, kind, data, scope=None, observed_at="2026-10-08T12:00:00Z"):
    stream_id = store.add_stream(run_id, kind, "/test/", {"collection_address": scope} if scope else {})
    records = [NormalizedRecord(kind, item.get("nft_address", "collection"), canonical_json(item), item) for item in data]
    store.commit_page(stream_id, None, ApiResponse(b"{}", 200, observed_at), ParsedPage(records, None))


def test_reports_are_offline_complete_and_empty_values_stay_unknown(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        assert status(store)["run_count"] == 0
        paths = export_reports(store, tmp_path / "exports")
        assert len(paths) == 12
        assert all(path.read_bytes().startswith(b"\xef\xbb\xbf") for path in paths)
        assert all(read_report(path) == [] for path in paths)
        portfolio = tmp_path / "portfolio.csv"
        portfolio.write_text("nft_address,collection_address,label\nMISSING,C1,Missing\n", encoding="utf-8")
        store.import_portfolio(portfolio)
        export_reports(store, tmp_path / "exports")
        row = read_report(tmp_path / "exports/portfolio_coverage.csv")[0]
        assert row["current_visibility"] == "unknown"
        assert row["price_per_day_gram"] == ""
        assert row["last_observed_at"] == ""
        assert row["membership"] == "user_declared"
        assert status(store)["unresolved_gifts"] == ["MISSING"]


def test_portfolio_coverage_retains_last_observation_owner_and_new_import(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        run_id = store.create_run({}, [None], [])
        add_page(store, run_id, "listing", [{"nft_address": "N1", "owner": "W1", "price_per_day_gram": Decimal("0.000000001")}])
        portfolio = tmp_path / "portfolio.csv"
        portfolio.write_text("nft_address,collection_address,label\nN1,C1,=DANGEROUS()\nN2,C1,Two\n", encoding="utf-8")
        store.import_portfolio(portfolio)
        export_reports(store, tmp_path / "exports", "W1")
        coverage = read_report(tmp_path / "exports/portfolio_coverage.csv")
        assert coverage[0]["last_observed_owner_comparison"] == "match"
        assert coverage[0]["current_visibility"] == "observed_in_latest_run"
        assert coverage[0]["label"] == "'=DANGEROUS()"
        assert coverage[0]["price_per_day_gram"] == "0.000000001"
        assert coverage[0]["collection_source"] == "portfolio_import"
        assert coverage[1]["current_visibility"] == "unknown"
        store.finish_run(run_id, "complete")
        next_run = store.create_run({}, ["C1"], [])
        add_page(store, next_run, "listing", [], scope="C1")
        export_reports(store, tmp_path / "exports", "DIFFERENT")
        coverage = read_report(tmp_path / "exports/portfolio_coverage.csv")
        assert coverage[0]["last_observed_at"] == "2026-10-08T12:00:00Z"
        assert coverage[0]["last_observed_owner_comparison"] == "conflict"
        assert coverage[0]["current_visibility"] == "unknown"
        assert len(store.observations("listing")) == 1


def test_history_fingerprints_occurrences_currencies_and_semantics(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        path = tmp_path / "portfolio.csv"
        path.write_text("nft_address\nN1\n", encoding="utf-8")
        store.import_portfolio(path)
        run_id = store.create_run({}, [None], ["SKIPPED"])
        first = {"nft_address": "N1", "collection_address": "C1", "tx_hash": "shared", "currency": "GRAM", "price": Decimal("1.000000001"), "price_nano": 1000000001, "price_gram": Decimal("1.000000001"), "amounts_consistent": True}
        other = {"nft_address": "N2", "tx_hash": "shared", "currency": "USDT", "price": Decimal("1.25"), "price_nano": 1250000}
        add_page(store, run_id, "history", [first, first, other])
        export_reports(store, tmp_path / "exports")
        history = read_report(tmp_path / "exports/history_records.csv")
        occurrences = read_report(tmp_path / "exports/history_occurrences.csv")
        assert len(history) == 2
        assert len(occurrences) == 3
        assert history[0]["history_classification"] == "portfolio gift history"
        assert history[0]["occurrence_count"] == "2"
        assert history[0]["price"] == "1.000000001"
        assert history[0]["gross_net_semantics"] == "unspecified"
        assert history[0]["timestamp_unit"] == "unspecified"
        assert history[1]["currency"] == "USDT"
        assert history[1]["price_gram"] == ""
        assert history[1]["history_classification"] == "market gift history"
        assert read_report(tmp_path / "exports/run_status.csv")[0]["skipped_scopes"] == '["SKIPPED"]'


def test_provenance_updates_from_later_history_and_conflicts_are_visible(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        path = tmp_path / "portfolio.csv"
        path.write_text("nft_address\nN1\n", encoding="utf-8")
        store.import_portfolio(path)
        run_id = store.create_run({}, [None], [])
        add_page(store, run_id, "listing", [{"nft_address": "N1"}])
        add_page(store, run_id, "history", [{"nft_address": "N1", "collection_address": "C1"}])
        export_reports(store, tmp_path / "exports")
        listing = read_report(tmp_path / "exports/listing_observations.csv")[0]
        assert listing["collection_address"] == "C1"
        assert listing["collection_source"] == "observed_history"
        new_run_id = store.create_run({}, [None], [])
        add_page(store, new_run_id, "history", [{"nft_address": "N1", "collection_address": "C2"}])
        export_reports(store, tmp_path / "exports")
        listing = read_report(tmp_path / "exports/listing_observations.csv")[0]
        assert listing["collection_address"] == ""
        assert listing["collection_conflict"] == "true"
        assert status(store)["collection_conflicts"] == ["N1"]


def test_snapshots_and_error_status_remain_visible(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        for index in range(2):
            run_id = store.create_run({}, ["C1"], [])
            add_page(store, run_id, "collection", [{"collection_address": "C1", "name": "Collection", "rent_floor": Decimal("1.25")}])
            add_page(store, run_id, "attribute", [{"trait_type": "model", "value": "@remote", "rent_floor": None}], scope="C1")
        stream_id = store.add_stream(run_id, "listing", "/v1/rent/gifts/", {})
        store.set_stream_state(stream_id, "failed", "Malformed response")
        store.record_issue(run_id, stream_id, "invalid_response", "Malformed response")
        store.finish_run(run_id, "failed", "Malformed response")
        export_reports(store, tmp_path / "exports")
        assert len(read_report(tmp_path / "exports/collections.csv")) == 2
        attributes = read_report(tmp_path / "exports/attributes.csv")
        assert len(attributes) == 2
        assert attributes[0]["value"] == "'@remote"
        assert attributes[0]["rent_floor"] == ""
        assert attributes[0]["rental_floor_unit"] == "unspecified"
        assert status(store)["resumable_runs"] == [run_id]
        assert status(store)["errors"][0]["reason"] == "invalid_response"
