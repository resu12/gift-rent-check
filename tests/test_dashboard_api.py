"""Local transport isolation and real read-model integration."""
import csv
import io
import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.storage import Store
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.util import utc_now


WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
COLLECTION = "0:" + "33" * 32


@pytest.fixture
def setup(tmp_path):
    database = tmp_path / "data.sqlite3"
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f'nft_address,collection_address,label\n{NFT},{COLLECTION},"=untrusted name"\n')
    with Store(database) as store:
        store.import_portfolio(portfolio)
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>Dashboard</title>")
    (tmp_path / "private.txt").write_text("private data must not be served")
    return Settings(token="mock-market-secret", db_path=database, owner_address=WALLET), static


def app_for(setup, **options):
    settings, static = setup
    return create_app(settings, DiscoverySettings(api_key="mock-ton-secret"), static_dir=static,
                      start_worker=False, **options)


def test_saved_portfolio_and_export_are_available_without_network(setup):
    with TestClient(app_for(setup)) as client:
        response = client.get("/api/dashboard")
        assert response.status_code == 200
        body = response.json()
        assert body["wallet"] == WALLET
        assert body["gifts"][0]["nft_address"] == NFT
        assert body["gifts"][0]["rental_history"]["recorded_count"] is None
        assert body["gifts"][0]["rental_history"]["coverage"] == "no_history"
        assert body["capabilities"]["network_enabled"] is False
        assert "mock-market-secret" not in response.text
        assert "mock-ton-secret" not in response.text
        assert response.headers["cache-control"] == "no-store"
        exported = client.get("/api/export.csv")
        assert exported.status_code == 200
        rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
        assert rows[0]["name"].startswith("'=")
        assert rows[0]["price_per_day"] == ""
        assert "user_declared" in rows[0]["membership_sources"]
        assert rows[0]["automatic_membership"] == "false"
        assert rows[0]["price_source"] == ""
        assert rows[0]["price_observed_at"] == ""
        assert rows[0]["price_is_historical"] == "false"
        assert rows[0]["recorded_rental_count"] == ""
        assert rows[0]["rental_history_coverage"] == "no_history"
        token = body["capabilities"]["csrf_token"]
        assert client.post("/api/jobs", json={"kind": "refresh"}, headers={"x-dashboard-csrf": token}).status_code == 409
        assert client.get("/api/jobs").json() == {"jobs": []}


def test_recorded_rental_counts_are_all_history_and_exported_offline(setup):
    from marketapp_rent.models import parse_page

    settings, _ = setup
    base = {"address": NFT, "name": "Owned gift", "collection_address": COLLECTION,
            "src": WALLET, "dst": "0:" + "55" * 32, "ts": 1577836800,
            "price": "0.3", "price_nano": "300000000", "currency": "GRAM",
            "is_extend": False, "duration": 86400, "tx_hash": None}
    values = [base, {**base, "ts": 1577923200, "currency": "TON"},
              {**base, "ts": 1578009600, "is_extend": True}]
    body = json.dumps({"items": values, "cursor": None}).encode()
    with Store(settings.db_path) as store:
        for _ in range(2):
            run = store.create_run({}, [COLLECTION], [])
            stream = store.add_stream(run, "history", "/v1/rent/gifts/history/", {"collection_address": COLLECTION})
            store.commit_page(stream, None, ApiResponse(body, 200, "2020-01-05T12:00:00Z"), parse_page("history", body))

    with TestClient(app_for(setup)) as client:
        listing_view = client.get("/api/dashboard?pricing_source=listings&timeframe=24h").json()
        rental_view = client.get("/api/dashboard?pricing_source=rentals&timeframe=7d").json()
        history = listing_view["gifts"][0]["rental_history"]
        assert history["recorded_count"] == 2
        assert history["coverage"] == "partial"
        assert history == rental_view["gifts"][0]["rental_history"]
        assert history["first_rental_at"].startswith("2020-01-01")
        assert history["last_rental_at"].startswith("2020-01-02")
        exported = client.get("/api/export.csv?pricing_source=rentals&timeframe=7d")
        row = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))[0]
        assert row["recorded_rental_count"] == "2"
        assert row["rental_history_coverage"] == "partial"
        assert row["first_recorded_rental_at"] == history["first_rental_at"]
        assert row["last_recorded_rental_at"] == history["last_rental_at"]
        assert row["rental_history_note"] == history["note"]


@pytest.mark.parametrize("headers", [
    {"Host": "evil.example"}, {"Origin": "https://evil.example"},
    {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"},
])
def test_local_data_rejects_foreign_browser_origins(setup, headers):
    with TestClient(app_for(setup)) as client:
        response = client.get("/api/dashboard", headers=headers)
        assert response.status_code == 403
        assert "gifts" not in response.text


def test_jobs_require_csrf_and_duplicate_clicks_share_one_job(setup):
    app = app_for(setup, allow_network=True)
    with TestClient(app) as client:
        assert client.post("/api/jobs", json={"kind": "refresh"}).status_code == 403
        token = client.get("/api/dashboard").json()["capabilities"]["csrf_token"]
        headers = {"x-dashboard-csrf": token, "Origin": "http://testserver"}
        first = client.post("/api/jobs", json={"kind": "refresh"}, headers=headers)
        assert first.status_code == 202
        assert first.json()["job"]["state"] == "queued"
        assert first.json()["deduplicated"] is False
        second = client.post("/api/jobs", json={"kind": "discover"}, headers=headers)
        assert second.status_code == 202
        assert second.json()["job"]["id"] == first.json()["job"]["id"]
        assert second.json()["deduplicated"] is True
        assert client.get("/api/jobs/9999").status_code == 404
        assert client.post("/api/jobs", json={"kind": "submit_transaction"}, headers=headers).status_code == 422
        assert client.post("/api/jobs", json={"kind": "collect", "token": "not-allowed"}, headers=headers).status_code == 422
        assert client.post("/api/jobs", json={"kind": "collect"}, headers={**headers, "Origin": "https://evil.example"}).status_code == 403


def test_stop_is_authenticated_idempotent_and_available_without_network(setup):
    app = app_for(setup)
    queued, _ = app.state.jobs.enqueue("rental_prices", WALLET)
    app.state.jobs.link_run(queued["id"], 42)
    with TestClient(app) as client:
        url = f"/api/jobs/{queued['id']}/stop"
        assert client.post(url).status_code == 403
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        assert client.post(url, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
        assert app.state.jobs.get(queued["id"])["state"] == "queued"
        stopped = client.post(url, headers=headers)
        assert stopped.status_code == 202
        job = stopped.json()["job"]
        assert job["state"] == "partial" and job["stop_requested"] is True
        assert job["run_id"] == 42
        assert client.post(url, headers=headers).json()["job"] == job
        assert client.post("/api/jobs/99999/stop", headers=headers).status_code == 404


def test_running_stop_preserves_single_active_job_until_worker_acknowledges(setup):
    app = app_for(setup, allow_network=True)
    queued, _ = app.state.jobs.enqueue("prices", WALLET)
    assert app.state.jobs.lease("test-worker")
    app.state.jobs.claim("test-worker")
    with TestClient(app) as client:
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        response = client.post(f"/api/jobs/{queued['id']}/stop", headers=headers)
        assert response.status_code == 202
        job = response.json()["job"]
        assert job["state"] == "running" and job["stop_requested"] is True
        duplicate = client.post("/api/jobs", json={"kind": "collect"}, headers=headers).json()
        assert duplicate["deduplicated"] is True and duplicate["job"]["id"] == job["id"]
        assert app.state.jobs.finish(job["id"], "partial", "Stopped by user", worker="test-worker")
        resumed = client.post("/api/jobs", json={"resume_job_id": job["id"]}, headers=headers).json()["job"]
        assert resumed["state"] == "queued" and resumed["stop_requested"] is False


def test_stop_does_not_change_completed_work(setup):
    app = app_for(setup)
    job, _ = app.state.jobs.enqueue("prices", WALLET)
    app.state.jobs.finish(job["id"], "complete", result={"pages_committed": 10})
    before = app.state.jobs.get(job["id"])
    with TestClient(app) as client:
        response = client.post(f"/api/jobs/{job['id']}/stop", headers={"x-dashboard-csrf": app.state.csrf_token})
        assert response.status_code == 202
        assert response.json()["job"] == before


def test_partial_job_resume_keeps_run_link(setup):
    app = app_for(setup, allow_network=True)
    with TestClient(app) as client:
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        created = client.post("/api/jobs", json={"kind": "discover"}, headers=headers).json()["job"]
        app.state.jobs.link_run(created["id"], 42)
        app.state.jobs.finish(created["id"], "partial", "page_limit")
        resumed = client.post("/api/jobs", json={"resume_job_id": created["id"]}, headers=headers)
        assert resumed.status_code == 202
        assert resumed.json()["job"]["run_id"] == 42
        assert resumed.json()["job"]["id"] == created["id"]


def test_comparison_price_job_uses_existing_authenticated_queue(setup):
    app = app_for(setup, allow_network=True)
    with TestClient(app) as client:
        created = client.post("/api/jobs", json={"kind": "prices"},
                              headers={"x-dashboard-csrf": app.state.csrf_token})
        assert created.status_code == 202
        assert created.json()["job"]["kind"] == "prices"
        assert created.json()["job"]["state"] == "queued"


def test_recommendations_and_three_peer_averages_are_exported_offline(setup):
    settings, _ = setup
    with Store(settings.db_path) as store:
        run = store.create_run({}, [COLLECTION], [])
        stream = store.add_stream(run, "listing", "/v1/rent/gifts/", {"collection_address": COLLECTION})
        records = []
        for index, price in enumerate(("0.1", "0.2", "0.3")):
            nft = "0:" + f"{70 + index:02x}" * 32
            data = {"nft_address": nft, "owner": "0:" + "99" * 32,
                    "price_per_day_gram": price, "attributes": []}
            source = {"nft_address": nft, "nft_name": "Peer gift", "owner": data["owner"],
                      "attributes": [], "min_duration": 86400, "max_duration": 2592000,
                      "price_per_day": str((index + 1) * 100_000_000), "discount_per_day": 0,
                      "listed_at": None}
            records.append(NormalizedRecord("listing", nft, json.dumps(source), data))
        store.commit_page(stream, None, ApiResponse(b"{}", 200, utc_now()), ParsedPage(records, None))
    with TestClient(app_for(setup)) as client:
        row = client.get("/api/dashboard").json()["gifts"][0]
        assert row["pricing"]["collection"]["sample_count"] == 3
        assert row["pricing"]["recommended_price_per_day"] == "0.2"
        exported = client.get("/api/export.csv")
        values = next(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
        assert values["collection_mean"] == "0.2" and values["collection_samples"] == "3"
        assert values["recommended_price_per_day"] == "0.2"
        assert values["recommendation_basis"] == "collection"
        assert values["model_mean"] == "" and values["model_black_mean"] == ""
        assert values["recommendation_unit"] == "GRAM/day"


def test_static_files_cannot_escape_dist_or_expose_database(setup):
    with TestClient(app_for(setup)) as client:
        assert client.get("/").status_code == 200
        assert client.get("/gifts").status_code == 200
        for path in ("/%2e%2e/private.txt", "/..%5cprivate.txt", "/.env", "/api/not-a-route", "/data.sqlite3"):
            response = client.get(path)
            assert response.status_code == 404
            assert "private data" not in response.text
        assert "frame-ancestors 'none'" in client.get("/").headers["content-security-policy"]


def test_bad_port_rejected_before_dashboard_start(tmp_path, capsys):
    from marketapp_rent.cli import main
    assert main(["--env-file", str(tmp_path / "missing.env"), "--db", str(tmp_path / "unused.db"), "dashboard", "--port", "80"]) == 2
    assert not (tmp_path / "unused.db").exists()
