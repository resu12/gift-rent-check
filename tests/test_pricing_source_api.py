"""Source and timeframe selection share one read-only view with CSV exports."""
import csv
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import io
import json

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from marketapp_rent.api import ApiClient
from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.domain import ApiResponse
from marketapp_rent.models import parse_page
from marketapp_rent.storage import Store
from marketapp_rent.ton_api import TonClient


WALLET, NFT, COLLECTION, OWNER = ("0:" + value * 32 for value in ("11", "22", "33", "44"))
NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(NOW.timestamp(), tz)


def listing(nft, price):
    return {"nft_address": nft, "nft_name": "Gift", "owner": OWNER,
            "attributes": [{"trait_type": "Model", "value": "Ruby"}, {"trait_type": "Backdrop", "value": "Black"}],
            "min_duration": 86400, "max_duration": 2592000,
            "price_per_day": str(int(Decimal(price) * 1_000_000_000)), "discount_per_day": 0, "listed_at": None}


def save_page(store, kind, items, when):
    run = store.create_run({}, [COLLECTION], [])
    stream = store.add_stream(run, kind, "/v1/rent/gifts/" + ("history/" if kind == "history" else ""),
                              {"collection_address": COLLECTION})
    body = json.dumps({"cursor": None, "items": items}).encode()
    store.commit_page(stream, None, ApiResponse(body, 200, when), parse_page(kind, body))


@pytest.fixture
def api_setup(tmp_path, monkeypatch):
    import marketapp_rent.pricing as pricing
    import marketapp_rent.pricing_window as windows
    monkeypatch.setattr(pricing, "datetime", FixedDatetime)
    monkeypatch.setattr(windows, "datetime", FixedDatetime)
    monkeypatch.setattr(ApiClient, "get", lambda *args, **kwargs: pytest.fail("Offline pricing made a Marketapp request"))
    monkeypatch.setattr(TonClient, "get", lambda *args, **kwargs: pytest.fail("Offline pricing made a TON request"))
    database = tmp_path / "prices.sqlite3"
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address,label\n{NFT},{COLLECTION},Owned gift\n")
    peers = ["0:" + f"{value:02x}" * 32 for value in range(70, 73)]
    with Store(database) as store:
        store.import_portfolio(portfolio)
        save_page(store, "listing", [listing(address, "0.8") for address in [NFT, *peers]], "2026-10-06T12:00:00Z")
        save_page(store, "listing", [listing(NFT, "9")] + [listing(address, str((index + 1) / 10)) for index, address in enumerate(peers)],
                  "2026-10-08T11:00:00Z")
        rentals = []
        for day, base in ((6, 1), (8, 4)):
            for index, address in enumerate(peers):
                amount = Decimal(base + index) / 100
                rentals.append({"address": address, "name": "Gift", "collection_address": COLLECTION,
                                "ts": int(datetime(2026, 10, day, 10, tzinfo=timezone.utc).timestamp()),
                                "src": OWNER, "dst": "renter", "price": str(amount),
                                "price_nano": str(int(amount * 1_000_000_000)), "currency": "GRAM",
                                "duration": 86400, "is_extend": False})
        rentals.append({**rentals[0], "ts": int(datetime(2026, 9, 1, 10, tzinfo=timezone.utc).timestamp()),
                        "price": "0.9", "price_nano": "900000000"})
        save_page(store, "history", rentals, "2026-10-08T11:05:00Z")
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>Pricing</title>")
    return Settings(token="fake-private-market-token", db_path=database, owner_address=WALLET), static


def app_for(api_setup, **kwargs):
    settings, static = api_setup
    return create_app(settings, DiscoverySettings(api_key="fake-private-ton-key"), static_dir=static,
                      start_worker=False, **kwargs)


def subject(body):
    return next(gift for gift in body["gifts"] if gift["nft_address"] == NFT)


def test_switching_source_and_window_changes_real_averages_without_network_or_writes(api_setup):
    settings, _ = api_setup
    with Store(settings.db_path) as store:
        before = (len(store.runs()), len(store.observations("listing")), len(store.observations("history")))
    with TestClient(app_for(api_setup)) as client:
        listings = client.get("/api/dashboard").json()
        assert listings["pricing"]["source"] == "listings"
        assert subject(listings)["pricing"]["recommended_price_per_day"] == "2.4"
        rentals = client.get("/api/dashboard", params={"pricing_source": "rentals", "timeframe": "24h"}).json()
        assert rentals["pricing"]["source"] == "rentals"
        assert rentals["pricing"]["time_basis"] == "rental_event"
        assert subject(rentals)["pricing"]["recommended_price_per_day"] == "0.05"
        assert subject(rentals)["pricing"]["collection"]["sample_count"] == 3
        week = client.get("/api/dashboard", params={"pricing_source": "rentals", "timeframe": "7d"}).json()
        assert subject(week)["pricing"]["recommended_price_per_day"] == "0.035"
        assert subject(week)["pricing"]["model_black"]["sample_count"] == 6
        assert subject(week)["pricing"]["model_black"]["distinct_nft_count"] == 3
        assert "fake-private-market-token" not in json.dumps(week)
        assert "fake-private-ton-key" not in json.dumps(week)
        assert client.get("/api/jobs").json() == {"jobs": []}
    with Store(settings.db_path) as store:
        assert (len(store.runs()), len(store.observations("listing")), len(store.observations("history"))) == before


@pytest.mark.parametrize("source,mean,time_basis", [("listings", "0.8", "listing_observation"), ("rentals", "0.02", "rental_event")])
def test_custom_window_csv_matches_displayed_source_units_and_cohorts(api_setup, source, mean, time_basis):
    params = {"pricing_source": source, "timeframe": "custom", "date_from": "2026-10-06", "date_to": "2026-10-06"}
    with TestClient(app_for(api_setup)) as client:
        displayed = client.get("/api/dashboard", params=params)
        assert displayed.status_code == 200
        pricing = subject(displayed.json())["pricing"]
        assert pricing["recommended_price_per_day"] == mean
        exported = client.get("/api/export.csv", params=params)
        assert exported.status_code == 200
        row = next(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
        expected_count = "4" if source == "listings" else "3"
        for cohort in ("collection", "model", "model_black"):
            assert row[cohort + "_mean"] == pricing[cohort]["mean"] == mean
            assert row[cohort + "_samples"] == str(pricing[cohort]["sample_count"]) == expected_count
            assert row[cohort + "_distinct_nfts"] == expected_count
        assert row["recommended_price_per_day"] == mean
        assert row["pricing_source"] == source
        assert row["pricing_timeframe"] == "custom"
        assert row["pricing_window_from"] == "2026-10-06T00:00:00+00:00"
        assert row["pricing_window_to"] == "2026-10-06T23:59:59.999999+00:00"
        assert row["pricing_timezone"] == "UTC"
        assert row["pricing_time_basis"] == time_basis
        assert row["recommendation_unit"] == "GRAM/day"
        assert row["pricing_semantics_version"] == ("marketapp-rent-history-ui-v1" if source == "rentals" else "")


def test_sixty_day_timeframe_includes_older_rentals_but_deduplicates_listing_snapshots(api_setup):
    with TestClient(app_for(api_setup)) as client:
        rental = client.get("/api/dashboard", params={"pricing_source": "rentals", "timeframe": "60d"}).json()
        assert rental["pricing"]["window_from"] == "2026-08-09T12:00:00+00:00"
        assert subject(rental)["pricing"]["collection"]["sample_count"] == 7
        assert subject(rental)["pricing"]["collection"]["mean"] == "0.158571429"
        listing_view = client.get("/api/dashboard", params={"pricing_source": "listings", "timeframe": "60d"}).json()
        assert subject(listing_view)["pricing"]["collection"]["sample_count"] == 4
        assert subject(listing_view)["pricing"]["collection"]["mean"] == "2.4"


@pytest.mark.parametrize("path", ["/api/dashboard", "/api/export.csv"])
@pytest.mark.parametrize("params", [
    {"pricing_source": "completed_sales"}, {"timeframe": "1year"},
    {"timeframe": "all"},
    {"timeframe": "custom"},
    {"timeframe": "custom", "date_from": "2026-10-08", "date_to": "2026-10-06"},
    {"timeframe": "custom", "date_from": "2026-02-30", "date_to": "2026-10-06"},
    {"timeframe": "custom", "date_from": "2026-10-09", "date_to": "2026-10-09"},
    {"timeframe": "7d", "date_from": "2026-10-06"},
])
def test_invalid_pricing_query_has_clear_client_error(api_setup, path, params):
    with TestClient(app_for(api_setup)) as client:
        response = client.get(path, params=params)
        assert response.status_code == 422
        assert response.json()["detail"]


def test_rental_collection_job_requires_manual_authenticated_enqueue_and_resumes(api_setup):
    app = app_for(api_setup, allow_network=True)
    with TestClient(app) as client:
        assert client.post("/api/jobs", json={"kind": "rental_prices"}).status_code == 403
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        created = client.post("/api/jobs", json={"kind": "rental_prices"}, headers=headers)
        assert created.status_code == 202
        job = created.json()["job"]
        assert job["kind"] == "rental_prices" and job["state"] == "queued"
        assert client.post("/api/jobs", json={"kind": "rental_prices"}, headers=headers).json()["deduplicated"]
        app.state.jobs.link_run(job["id"], 91)
        app.state.jobs.finish(job["id"], "partial", "page_limit")
        resumed = client.post("/api/jobs", json={"resume_job_id": job["id"]}, headers=headers)
        assert resumed.status_code == 202
        assert resumed.json()["job"]["run_id"] == 91
        assert resumed.json()["job"]["kind"] == "rental_prices"


@pytest.mark.parametrize("selection,expected_from", [
    ({"timeframe": "7d"}, "2026-10-01T12:00:00+00:00"),
    ({"timeframe": "custom", "date_from": "2026-10-06", "date_to": "2026-10-07"}, "2026-10-06T00:00:00+00:00"),
    ({"timeframe": "60d"}, "2026-08-09T12:00:00+00:00"),
    ({}, "2026-09-08T12:00:00+00:00"),
])
def test_collection_freezes_selected_window_and_resume_preserves_it(api_setup, selection, expected_from):
    app = app_for(api_setup, allow_network=True)
    with TestClient(app) as client:
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        created = client.post("/api/jobs", json={"kind": "rental_prices", **selection}, headers=headers)
        assert created.status_code == 202
        job = created.json()["job"]
        window = job["collection_window"]
        assert window["window_from"] == expected_from
        assert window["timezone"] == "UTC"
        assert window["timeframe"] == selection.get("timeframe", "30d")
        assert window["window_to"] == ("2026-10-07T23:59:59.999999+00:00" if selection.get("timeframe") == "custom" else NOW.isoformat())
        app.state.jobs.finish(job["id"], "partial", "dashboard_attempt_budget")
        rejected = client.post("/api/jobs", json={"resume_job_id": job["id"], "timeframe": "24h"}, headers=headers)
        assert rejected.status_code == 422
        resumed = client.post("/api/jobs", json={"resume_job_id": job["id"]}, headers=headers)
        assert resumed.status_code == 202
        assert resumed.json()["job"]["collection_window"] == window


@pytest.mark.parametrize("body", [
    {"kind": "rental_prices", "timeframe": "1year"},
    {"kind": "prices", "timeframe": "custom"},
    {"kind": "rental_prices", "timeframe": "7d", "date_from": "2026-10-01"},
    {"kind": "rental_prices", "timeframe": "custom", "date_from": "2026-10-09", "date_to": "2026-10-09"},
    {"kind": "collect", "timeframe": "all"},
    {"kind": "prices", "timeframe": "all"},
    {"kind": "rental_prices", "timeframe": "all"},
])
def test_collection_rejects_invalid_windows_without_enqueuing(api_setup, body):
    app = app_for(api_setup, allow_network=True)
    with TestClient(app) as client:
        response = client.post("/api/jobs", json=body, headers={"x-dashboard-csrf": app.state.csrf_token})
        assert response.status_code == 422
        assert app.state.jobs.list() == []


def test_dashboard_reports_local_safety_limits_without_provider_requests(api_setup):
    with TestClient(app_for(api_setup)) as client:
        limits = client.get("/api/dashboard").json()["capabilities"]["marketapp_limits"]
        assert limits["max_attempts"] == 100
        assert limits["rolling_24h_attempts"] == 500
        assert limits["run_seconds"] == 300
        assert limits["requests_per_second"] == 1
        assert limits["used_24h"] == 0
        assert limits["remaining_24h"] == 500


@pytest.mark.parametrize("source", ["listings", "rentals"])
def test_default_view_and_export_use_thirty_days(api_setup, source):
    with TestClient(app_for(api_setup)) as client:
        query = {"pricing_source": source}
        body = client.get("/api/dashboard", params=query).json()
        assert body["pricing"]["timeframe"] == "30d"
        assert body["pricing"]["window_from"] == "2026-09-08T12:00:00+00:00"
        exported = client.get("/api/export.csv", params=query)
        row = next(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
        assert row["pricing_timeframe"] == "30d"
        if source == "rentals":
            assert subject(body)["pricing"]["collection"]["sample_count"] == 6


@pytest.mark.parametrize("kind", ["prices", "rental_prices", "collect"])
def test_new_collection_defaults_thirty_days_for_all_marketapp_jobs(api_setup, kind):
    app = app_for(api_setup, allow_network=True)
    with TestClient(app) as client:
        response = client.post("/api/jobs", json={"kind": kind}, headers={"x-dashboard-csrf": app.state.csrf_token})
        assert response.status_code == 202
        assert response.json()["job"]["collection_window"]["timeframe"] == "30d"


@pytest.mark.parametrize("days,status", [(90, 200), (91, 422)])
@pytest.mark.parametrize("path", ["/api/dashboard", "/api/export.csv"])
def test_custom_view_maximum_counts_inclusive_dates(api_setup, days, status, path):
    # Historical saved data remains inspectable; only the range size is bounded.
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    selection = {"timeframe": "custom", "date_from": start.date().isoformat(),
                 "date_to": (start + timedelta(days=days - 1)).date().isoformat()}
    with TestClient(app_for(api_setup)) as client:
        assert client.get(path, params=selection).status_code == status


@pytest.mark.parametrize("kind", ["rental_prices", "collect"])
@pytest.mark.parametrize("days_back,status", [(89, 202), (90, 422)])
def test_new_history_jobs_restrict_oldest_date_without_silently_expanding(api_setup, kind, days_back, status):
    app = app_for(api_setup, allow_network=True)
    chosen = (NOW - timedelta(days=days_back)).date().isoformat()
    with TestClient(app) as client:
        response = client.post("/api/jobs", json={"kind": kind, "timeframe": "custom", "date_from": chosen, "date_to": chosen},
                               headers={"x-dashboard-csrf": app.state.csrf_token})
        assert response.status_code == status
        if status == 422:
            assert "last 90 UTC dates" in response.text
            assert app.state.jobs.list() == []


def test_old_custom_listing_view_can_refresh_current_listings(api_setup):
    app = app_for(api_setup, allow_network=True)
    with TestClient(app) as client:
        response = client.post("/api/jobs", json={"kind": "prices", "timeframe": "custom", "date_from": "2025-01-01", "date_to": "2025-01-30"},
                               headers={"x-dashboard-csrf": app.state.csrf_token})
        assert response.status_code == 202


@pytest.mark.parametrize("kind", ["rental_prices", "collect"])
@pytest.mark.parametrize("old_window", [None, {"timeframe": "all", "window_from": None, "window_to": NOW.isoformat(), "timezone": "UTC"}])
def test_legacy_unbounded_history_resume_requires_fresh_job(api_setup, kind, old_window):
    app = app_for(api_setup, allow_network=True)
    job, _ = app.state.jobs.enqueue(kind, WALLET)
    with app.state.jobs.connect() as connection:
        connection.execute("UPDATE dashboard_jobs SET collection_window_json=?,state='partial' WHERE id=?", (json.dumps(old_window) if old_window else None, job["id"]))
    with TestClient(app) as client:
        response = client.post("/api/jobs", json={"resume_job_id": job["id"]}, headers={"x-dashboard-csrf": app.state.csrf_token})
        assert response.status_code == 409
        assert "fresh 30-day" in response.json()["detail"]
        assert app.state.jobs.get(job["id"])["state"] == "partial"


@pytest.mark.parametrize("kind", ["rental_prices", "collect"])
def test_bounded_resume_keeps_original_dates_after_long_pause(api_setup, monkeypatch, kind):
    import marketapp_rent.pricing_window as windows
    app = app_for(api_setup, allow_network=True)
    with TestClient(app) as client:
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        response = client.post("/api/jobs", json={"kind": kind, "timeframe": "90d"}, headers=headers)
        assert response.status_code == 202
        job = response.json()["job"]
        app.state.jobs.finish(job["id"], "partial", "dashboard_attempt_budget")

        class LaterDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls.fromtimestamp((NOW + timedelta(days=400)).timestamp(), tz)

        monkeypatch.setattr(windows, "datetime", LaterDatetime)
        resumed = client.post("/api/jobs", json={"resume_job_id": job["id"]}, headers=headers)
        assert resumed.status_code == 202
        assert resumed.json()["job"]["collection_window"] == job["collection_window"]
