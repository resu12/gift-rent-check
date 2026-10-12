"""Dashboard freshness probes stay cheap, private and safe during commits."""
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.dashboard_credentials import SessionOnlyCredentialStore
from marketapp_rent.storage import Store


WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
COLLECTION = "0:" + "33" * 32


@pytest.fixture
def prepared(tmp_path):
    database = tmp_path / "main.sqlite3"
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address,label\n{NFT},{COLLECTION},Owned gift\n")
    with Store(database) as store:
        store.import_portfolio(portfolio)
    return Settings(db_path=database, owner_address=WALLET)


def make_app(settings, **options):
    return create_app(settings, start_worker=False, credential_store=SessionOnlyCredentialStore(), **options)


def token(client):
    response = client.get("/api/dashboard-revision")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    value = response.json()
    assert set(value) == {"token"}
    assert value["token"].startswith("desktop-v1:") and len(value["token"]) == 75
    return value["token"]


def test_unchanged_revision_matches_full_snapshot_without_loading_projection(prepared, monkeypatch):
    import marketapp_rent.dashboard_view as dashboard_view

    now = [120.0]
    app = make_app(prepared, revision_clock=lambda: now[0])
    with TestClient(app) as client:
        before = token(client)
        assert client.get("/api/dashboard").json()["update_token"] == before
        assert token(client) == before

    def forbidden(*args, **kwargs):
        raise AssertionError("A lightweight freshness probe must not load rows or provider evidence")

    monkeypatch.setattr(dashboard_view, "build_dashboard", forbidden)
    app = make_app(prepared, revision_clock=lambda: now[0])
    monkeypatch.setattr(app.state.owned_prices, "observations", forbidden)
    monkeypatch.setattr(app.state.jobs, "marketapp_usage", forbidden)
    with TestClient(app) as client:
        first = token(client)
        monkeypatch.setattr(sqlite3, "connect", forbidden)
        assert token(client) == first
        now[0] = 179.9
        assert token(client) == first
        now[0] = 180.0
        assert token(client) != first, "expiry and relative windows invalidate once per minute"


def test_commits_in_main_jobs_and_independent_owned_database_change_revision(prepared, tmp_path):
    owned_path = tmp_path / "independent-owned.sqlite3"
    with sqlite3.connect(owned_path) as connection:
        connection.execute("CREATE TABLE owned_price_observations (id INTEGER PRIMARY KEY, document TEXT)")

    class InjectedOwnedPrices:
        path = owned_path

    app = make_app(prepared, owned_price_service=InjectedOwnedPrices(), revision_clock=lambda: 120)
    with TestClient(app) as client:
        first = token(client)
        # Keep this connection open to retain a committed WAL before checkpoint.
        with sqlite3.connect(prepared.db_path) as connection:
            connection.execute("UPDATE portfolio SET label='Changed gift'")
            connection.commit()
            assert Path(str(prepared.db_path) + "-wal").exists()
            after_main = token(client)
            assert after_main != first
        after_main = token(client)
        job, _ = app.state.jobs.enqueue("prices", WALLET)
        assert token(client) == after_main, "job status is polled separately from comparison data"
        app.state.jobs.reserve_marketapp_attempt(job["id"], "fixture", 100, 500)
        after_job = token(client)
        assert after_job != after_main
        with sqlite3.connect(owned_path) as connection:
            connection.execute("INSERT INTO owned_price_observations(document) VALUES ('new evidence')")
        assert token(client) != after_job


def test_worker_lease_and_progress_heartbeats_do_not_invalidate_comparisons(prepared):
    app = make_app(prepared, revision_clock=lambda: 120)
    job, _ = app.state.jobs.enqueue("prices", WALLET)
    with TestClient(app) as client:
        initial = token(client)
        for tick in range(5):
            assert app.state.jobs.lease("fixture-worker", now=100 + tick)
            with app.state.jobs.connect() as connection:
                connection.execute("UPDATE dashboard_jobs SET updated_at=?, progress_json=? WHERE id=?",
                                   (f"heartbeat-{tick}", json.dumps({"heartbeat": tick}), job["id"]))
            assert token(client) == initial
        app.state.jobs.release("fixture-worker")
        assert token(client) == initial


def test_new_personal_analytics_snapshot_invalidates_semantic_revision(prepared):
    app = make_app(prepared, revision_clock=lambda: 120)
    with TestClient(app) as client:
        initial = token(client)
        with app.state.jobs.connect() as connection:
            connection.execute("CREATE TABLE personal_analytics_snapshots (id INTEGER PRIMARY KEY, normalized_json TEXT)")
            connection.execute("INSERT INTO personal_analytics_snapshots VALUES(1, '{}')")
        first = token(client)
        assert first != initial
        with app.state.jobs.connect() as connection:
            connection.execute("INSERT INTO personal_analytics_snapshots VALUES(2, '{}')")
        assert token(client) != first


def test_review_evidence_creation_replacement_and_removal_change_revision(prepared, tmp_path):
    review = tmp_path / "review"
    review.mkdir()
    app = make_app(prepared, review_path=review, revision_clock=lambda: 120)
    with TestClient(app) as client:
        previous = token(client)
        annotation = review / "holder_review.csv"
        annotation.write_text("first review")
        changed = token(client)
        assert changed != previous
        annotation.write_text("replacement review data")
        replaced = token(client)
        assert replaced != changed
        annotation.unlink()
        removed = token(client)
        assert removed != replaced
        folder = review / "evidence" / "live-recheck"
        folder.mkdir(parents=True)
        evidence = folder / "nft-after.json"
        evidence.write_text(json.dumps({"fixture": "changed"}))
        assert token(client) != removed


def test_session_key_changes_invalidate_without_exposing_keys_and_restart_invalidates(prepared):
    app = make_app(prepared, revision_clock=lambda: 120)
    with TestClient(app) as client:
        initial = token(client)
        headers = {"x-dashboard-csrf": app.state.csrf_token}
        for key in ("private-fixture-one", "private-fixture-two"):
            response = client.post("/api/settings/marketapp", json={"api_key": key, "persist": False}, headers=headers)
            assert response.status_code == 200
            current = token(client)
            assert current != initial
            assert key not in current
            initial = current
        assert client.delete("/api/settings/marketapp", headers=headers).status_code == 200
        assert token(client) != initial
        prior_service = token(client)
    with TestClient(make_app(prepared, revision_clock=lambda: 120)) as client:
        assert token(client) != prior_service


def test_full_view_token_does_not_consume_a_commit_during_projection(prepared, monkeypatch):
    import marketapp_rent.dashboard_view as dashboard_view

    original = dashboard_view.build_dashboard

    def build_then_commit(*args, **kwargs):
        result = original(*args, **kwargs)
        with Store(prepared.db_path) as store:
            store.connection.execute("UPDATE portfolio SET label='Newer commit'")
            store.connection.commit()
        return result

    monkeypatch.setattr(dashboard_view, "build_dashboard", build_then_commit)
    app = make_app(prepared, revision_clock=lambda: 120)
    with TestClient(app) as client:
        before = token(client)
        response = client.get("/api/dashboard")
        assert response.status_code == 200
        assert response.json()["update_token"] == before
        assert token(client) != before


@pytest.mark.parametrize("headers", [
    {"Host": "foreign.example"}, {"Origin": "https://foreign.example"},
    {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"},
])
def test_revision_route_preserves_loopback_and_cross_origin_controls(prepared, headers):
    with TestClient(make_app(prepared, revision_clock=lambda: 120)) as client:
        response = client.get("/api/dashboard-revision", headers=headers)
        assert response.status_code == 403 and "token" not in response.json()


def test_revision_route_rejects_mutations_before_dispatch(prepared):
    app = make_app(prepared, revision_clock=lambda: 120)
    with TestClient(app) as client:
        assert client.post("/api/dashboard-revision").status_code == 403
        assert client.post("/api/dashboard-revision", headers={"x-dashboard-csrf": app.state.csrf_token}).status_code == 405
