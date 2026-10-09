"""Private browser snapshots are imported without provider access."""
import json
import sqlite3
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from marketapp_rent.addresses import preferred_address
from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.dashboard_credentials import SessionOnlyCredentialStore


WALLET = "0:" + "11" * 32


def capture(wallet=WALLET, captured_at="2026-10-08T18:00:00Z"):
    return json.dumps({
        "version": 1, "source": "marketapp_personal_rent_page",
        "source_url": f"https://marketapp.org/user/{preferred_address(wallet)}/?tab=analytics_rent",
        "wallet": preferred_address(wallet), "captured_at": captured_at,
        "summary": [{"label": "Rent volume", "value": "0.3", "foot": "", "definition": "Before fees"},
                    {"label": "Rentals", "value": "3", "foot": "2 items", "definition": "Includes extensions"}],
        "charts": [
            {"key": "profile.rent.income", "spec_raw": json.dumps({"gran": "day", "unit": "GRAM",
                "x": ["2026-10-07", "2026-10-08"], "series": [{"name": "Rent volume", "data": [0.1, 0.2]}]})},
            {"key": "profile.rent.rentals", "spec_raw": json.dumps({"gran": "day", "unit": "",
                "x": ["2026-10-07", "2026-10-08"], "series": [{"name": "New rentals", "data": [1, 1]},
                    {"name": "Extensions", "data": [0, 1]}]})},
        ],
    })


@pytest.fixture
def app(tmp_path):
    return create_app(Settings(db_path=tmp_path / "main.sqlite3", owner_address=WALLET),
                      start_worker=False, credential_store=SessionOnlyCredentialStore())


def post(client, app, raw, **options):
    return client.post("/api/personal-analytics", content=raw,
                       headers={"Content-Type": "application/json", "X-Dashboard-CSRF": app.state.csrf_token,
                                **options.pop("headers", {})}, **options)


def test_import_is_offline_wallet_scoped_and_survives_app_restart(app, tmp_path, monkeypatch):
    def no_provider(*args, **kwargs):
        pytest.fail("Analytics import must not make provider requests")
    monkeypatch.setattr("marketapp_rent.api.ApiClient.get", no_provider)
    monkeypatch.setattr("marketapp_rent.ton_api.TonClient.get", no_provider)
    with TestClient(app) as client:
        assert client.get("/api/dashboard").json()["personal_analytics"] is None
        assert client.get("/api/dashboard").json()["personal_analytics_snapshots"] == []
        response = post(client, app, capture())
        assert response.status_code == 200
        saved = client.get("/api/dashboard").json()
        assert saved["personal_analytics"]["summary"]["rent_volume"] == "0.3"
        assert saved["personal_analytics"]["summary"]["rentals"] == 3
        assert saved["personal_analytics_snapshots"] == [saved["personal_analytics"]]
        assert saved["summary"]["portfolio_count"] == 0
        assert saved["capabilities"]["marketapp_limits"]["used_24h"] == 0
        assert saved["capabilities"]["network_enabled"] is False
    restarted = create_app(Settings(db_path=tmp_path / "main.sqlite3", owner_address=WALLET),
                           start_worker=False, credential_store=SessionOnlyCredentialStore())
    with TestClient(restarted) as client:
        assert client.get("/api/dashboard").json()["personal_analytics"]["fingerprint"] == response.json()["fingerprint"]


def test_mutation_requires_same_origin_and_csrf(app):
    with TestClient(app) as client:
        assert client.post("/api/personal-analytics", content=capture()).status_code == 403
        assert post(client, app, capture(), headers={"Origin": "https://foreign.invalid"}).status_code == 403
        assert post(client, app, capture(), headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert client.get("/api/dashboard").json()["personal_analytics"] is None


def test_failed_import_preserves_previous_snapshot(app):
    with TestClient(app) as client:
        saved = post(client, app, capture()).json()
        assert post(client, app, capture("0:" + "22" * 32)).status_code == 422
        assert post(client, app, '{"api_key":"private-do-not-reflect"}').status_code == 422
        assert "private-do-not-reflect" not in post(client, app, "private-do-not-reflect").text
        assert client.get("/api/dashboard").json()["personal_analytics"]["fingerprint"] == saved["fingerprint"]


def test_import_requires_json_and_enforces_streamed_size(app):
    with TestClient(app) as client:
        assert post(client, app, capture(), headers={"Content-Type": "text/plain"}).status_code == 415
        assert post(client, app, "x" * 262145).status_code == 413
        chunks = (b"x" * 131072 for _ in range(3))
        assert post(client, app, chunks, headers={"Content-Length": "0"}).status_code == 413
        assert post(client, app, b"\xff").status_code == 422
        assert client.get("/api/dashboard").json()["personal_analytics"] is None


def test_large_valid_capture_is_not_subject_to_credential_body_limit(app):
    raw = json.loads(capture())
    # A bounded raw DOM definition is retained for provenance, not executed.
    raw["summary"][0]["definition"] = "Source metric definition. " * 220
    raw = json.dumps(raw)
    assert len(raw) > 4096
    with TestClient(app) as client:
        assert post(client, app, raw).status_code == 200
        assert client.post("/api/settings/marketapp", content=raw,
                           headers={"X-Dashboard-CSRF": app.state.csrf_token}).status_code == 413


def test_no_wallet_cannot_import(tmp_path):
    app = create_app(Settings(db_path=tmp_path / "empty.sqlite3"), start_worker=False,
                     credential_store=SessionOnlyCredentialStore())
    with TestClient(app) as client:
        assert post(client, app, capture()).status_code == 409
        assert client.get("/api/dashboard").json()["personal_analytics"] is None


def test_importing_older_capture_does_not_replace_latest(app):
    with TestClient(app) as client:
        latest = post(client, app, capture()).json()
        assert post(client, app, capture(captured_at="2026-10-08T17:00:00Z")).status_code == 200
        assert post(client, app, capture()).json()["fingerprint"] == latest["fingerprint"]
        assert client.get("/api/dashboard").json()["personal_analytics"]["fingerprint"] == latest["fingerprint"]
        assert [item["fingerprint"] for item in client.get("/api/dashboard").json()["personal_analytics_snapshots"]] == [latest["fingerprint"]]
    with sqlite3.connect(app.state.jobs.path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM personal_analytics_snapshots").fetchone()[0] == 2


def test_dashboard_offers_latest_saved_month_and_annual_periods(app):
    def period_capture(days, captured_at):
        source = json.loads(capture(captured_at=captured_at))
        source["summary"] = [{"label": "Rent volume", "value": "0"}, {"label": "Rentals", "value": "0"}]
        dates = [(date(2025, 1, 1) + timedelta(days=index)).isoformat() for index in range(days)]
        for entry in source["charts"]:
            spec = json.loads(entry["spec_raw"])
            spec["x"] = dates
            for series in spec["series"]:
                series["data"] = [0] * days
            entry["spec_raw"] = json.dumps(spec)
        return json.dumps(source)

    with TestClient(app) as client:
        old_month = post(client, app, period_capture(30, "2026-10-07T00:00:00Z")).json()
        year = post(client, app, period_capture(365, "2026-10-08T00:00:00Z")).json()
        month = post(client, app, period_capture(30, "2026-10-09T00:00:00Z")).json()
        saved = client.get("/api/dashboard").json()
        assert saved["personal_analytics_snapshots"] == [month, year]
        assert saved["personal_analytics"] == month
        assert old_month not in saved["personal_analytics_snapshots"]
