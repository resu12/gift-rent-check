"""Dashboard and CSV use the same optional exact-Black comparison scope."""

import csv
from datetime import datetime, timezone
import io

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.storage import Store
from test_pricing import addr, listing, listings, COLLECTION, WALLET
from test_rental_pricing import event, history


@pytest.fixture
def black_app(tmp_path):
    database = tmp_path / "black.sqlite3"
    portfolio = tmp_path / "members.csv"
    portfolio.write_text("nft_address,collection_address\n" + "".join(
        f"{addr(nft)},{COLLECTION}\n" for nft in (2, 10, 11, 12)))
    now = datetime.now(timezone.utc)
    with Store(database) as store:
        store.import_portfolio(portfolio)
        listings(store, [listing(2, "100000000"), listing(10, "300000000"),
                        listing(11, "900000000", backdrop="Onyx Black"),
                        listing(12, "700000000", backdrop=None),
                        listing(13, "500000000", model="Other")], when=now.isoformat())
        history(store, [event(nft, price=amount, duration=86400, ts=int(now.timestamp()) - 60)
                        for nft, amount in ((2, "0.1"), (10, "0.3"), (11, "0.9"), (12, "0.7"), (13, "0.5"))],
                when=now.isoformat())
    return create_app(Settings(db_path=database, owner_address=WALLET), start_worker=False)


@pytest.mark.parametrize("source", ["listings", "rentals"])
def test_dashboard_keeps_gift_inventory_but_scopes_all_comparison_values(black_app, source):
    with TestClient(black_app) as client:
        params = {"pricing_source": source, "timeframe": "30d"}
        unrestricted = client.get("/api/dashboard", params=params)
        assert unrestricted.status_code == 200
        original = {item["nft_address"]: item for item in unrestricted.json()["gifts"]}
        assert original[addr(2)]["pricing"]["collection"]["mean"] == "0.5"

        selected = client.get("/api/dashboard", params={**params, "pricing_backdrop": "Black"})
        assert selected.status_code == 200
        payload = selected.json()
        rows = {item["nft_address"]: item for item in payload["gifts"]}
        assert rows.keys() == original.keys()
        assert payload["pricing"]["backdrop"] == "Black"
        for nft in (2, 10):
            pricing = rows[addr(nft)]["pricing"]
            assert pricing["collection"]["mean"] == "0.3"
            assert pricing["collection"]["sample_count"] == 3
            assert pricing["model"]["mean"] == pricing["model_black"]["mean"] == "0.2"
            assert pricing["recommended_price_per_day"] == "0.3"
        for nft in (11, 12):
            assert rows[addr(nft)]["pricing"]["recommended_price_per_day"] is None


@pytest.mark.parametrize("source", ["listings", "rentals"])
def test_export_only_black_gifts_and_explicit_comparison_scope(black_app, source):
    with TestClient(black_app) as client:
        params = {"pricing_source": source, "timeframe": "30d", "pricing_backdrop": "Black"}
        response = client.get("/api/export.csv", params=params)
        assert response.status_code == 200
        rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
        assert {item["nft_address"] for item in rows} == {addr(2), addr(10)}
        for item in rows:
            assert item["pricing_backdrop"] == item["backdrop"] == "Black"
            assert item["pricing_source"] == source
            assert item["collection_mean"] == "0.3"
            assert item["model_mean"] == item["model_black_mean"] == "0.2"
        unrestricted = client.get("/api/export.csv", params={"pricing_source": source, "timeframe": "30d"})
        rows = list(csv.DictReader(io.StringIO(unrestricted.content.decode("utf-8-sig"))))
        assert len(rows) == 4
        assert all(item["pricing_backdrop"] == "" for item in rows)


@pytest.mark.parametrize("endpoint", ["/api/dashboard", "/api/export.csv"])
@pytest.mark.parametrize("backdrop", ["Onyx Black", "Blue", "", "black"])
def test_invalid_api_backdrop_scope_is_rejected(black_app, endpoint, backdrop):
    with TestClient(black_app) as client:
        assert client.get(endpoint, params={"pricing_backdrop": backdrop}).status_code == 422
