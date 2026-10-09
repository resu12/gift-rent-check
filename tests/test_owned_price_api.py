"""Price-only local transport uses the existing loopback/CSRF boundary."""
import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.storage import Store

WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
COLLECTION = "0:" + "33" * 32


class Prices:
    def __init__(self):
        self.calls = []
        self.status = {"run": None, "server_time": 1000, "next_allowed_at": 1000}

    def observations(self, wallet):
        assert wallet == WALLET
        return []

    def get_status(self):
        return self.status

    def start(self, session):
        self.calls.append(("start", session))
        return self.status

    def step(self, run_id):
        self.calls.append(("step", run_id))
        if run_id == 999:
            raise ValueError("private provider details must not escape")
        return self.status

    def stop(self, run_id):
        self.calls.append(("stop", run_id))
        return self.status


@pytest.fixture
def setup(tmp_path):
    database = tmp_path / "market.sqlite3"
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address\n{NFT},{COLLECTION}\n")
    with Store(database) as store:
        store.import_portfolio(portfolio)
    return Settings(token="", db_path=database, owner_address=WALLET), Prices()


def app_for(setup, **options):
    settings, prices = setup
    return create_app(settings, DiscoverySettings(), start_worker=False,
                      owned_price_service=prices, **options)


def test_price_only_capability_does_not_enable_marketapp_or_start_work_on_get(setup):
    with TestClient(app_for(setup, allow_price_refresh=True)) as client:
        dashboard = client.get("/api/dashboard").json()
        capabilities = dashboard["capabilities"]
        assert capabilities["owned_price_refresh"] is True
        assert capabilities["network_enabled"] is False
        assert capabilities["marketapp_configured"] is False
        assert setup[1].calls == []
        assert client.get("/api/owned-prices").json() == setup[1].status
        headers = {"X-Dashboard-CSRF": capabilities["csrf_token"]}
        assert client.post("/api/jobs", json={"kind": "prices"}, headers=headers).status_code == 409
        for operation, body in [("start", {"session_id": "page-session-123456"}), ("step", {"run_id": 1}), ("stop", {"run_id": 1})]:
            assert client.post(f"/api/owned-prices/{operation}", json=body, headers=headers).status_code == 200
        assert setup[1].calls == [("start", "page-session-123456"), ("step", 1), ("stop", 1)]
        assert client.get("/api/jobs").json() == {"jobs": []}


def test_offline_dashboard_cannot_start_or_step_but_can_read_and_stop(setup):
    with TestClient(app_for(setup)) as client:
        capabilities = client.get("/api/dashboard").json()["capabilities"]
        assert capabilities["owned_price_refresh"] is False
        headers = {"X-Dashboard-CSRF": capabilities["csrf_token"]}
        assert client.get("/api/owned-prices").status_code == 200
        assert client.post("/api/owned-prices/start", json={"session_id": "page-session-123456"}, headers=headers).status_code == 409
        assert client.post("/api/owned-prices/step", json={"run_id": 1}, headers=headers).status_code == 409
        assert client.post("/api/owned-prices/stop", json={"run_id": 1}, headers=headers).status_code == 200
        assert setup[1].calls == [("stop", 1)]


@pytest.mark.parametrize("operation,body", [("start", {"session_id": "page-session-123456"}), ("step", {"run_id": 1}), ("stop", {"run_id": 1})])
def test_price_mutations_require_csrf_same_origin_and_strict_inputs(setup, operation, body):
    app = app_for(setup, allow_price_refresh=True)
    with TestClient(app) as client:
        route = f"/api/owned-prices/{operation}"
        headers = {"X-Dashboard-CSRF": app.state.csrf_token}
        assert client.post(route, json=body).status_code == 403
        assert client.post(route, json=body, headers={**headers, "Origin": "https://foreign.invalid"}).status_code == 403
        assert client.post(route, json={**body, "wallet": WALLET}, headers=headers).status_code == 422
        assert client.get(route).status_code in {404, 405}
        assert setup[1].calls == []


def test_safe_errors_and_invalid_run_or_session_parameters(setup):
    app = app_for(setup, allow_price_refresh=True)
    with TestClient(app) as client:
        headers = {"X-Dashboard-CSRF": app.state.csrf_token}
        for session in ["short", "x" * 161, "not/allowed/session", 42]:
            assert client.post("/api/owned-prices/start", json={"session_id": session}, headers=headers).status_code == 422
        for run_id in [0, -1, "1", True]:
            assert client.post("/api/owned-prices/step", json={"run_id": run_id}, headers=headers).status_code == 422
        response = client.post("/api/owned-prices/step", json={"run_id": 999}, headers=headers)
        assert response.status_code == 409
        assert "private provider" not in response.text
