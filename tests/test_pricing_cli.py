"""A mocked CLI price scan stops, resumes, and feeds offline recommendations."""
import json

import httpx

from marketapp_rent import cli
from marketapp_rent.addresses import preferred_address
from marketapp_rent.api import ApiClient
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.price_collection import collect_prices
from marketapp_rent.storage import Store


def test_price_cli_bounded_resume_to_offline_recommendation(tmp_path, monkeypatch, capsys):
    wallet, nft, collection = ("0:" + value * 32 for value in ("11", "22", "33"))
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "mock-prices-token")
    monkeypatch.delenv("MARKETAPP_OWNER_ADDRESS", raising=False)
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text(f"nft_address,collection_address,label\n{nft},{collection},Owned gift\n")
    database = tmp_path / "prices.sqlite3"
    args = ["--env-file", str(tmp_path / "absent.env"), "--db", str(database)]
    requests = []

    def response(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.headers["Authorization"] == "mock-prices-token"
        if request.url.path == "/v1/collections/gifts/":
            return httpx.Response(200, json=[{"name": "Example", "address": collection, "extra_data": {}}])
        assert request.url.path == "/v1/rent/gifts/"
        assert request.url.params["collection_address"] == preferred_address(collection)
        assert request.url.params["limit"] == "100"
        if "cursor" in request.url.params:
            assert request.url.params["cursor"] == "opaque-next"
            return httpx.Response(200, json={"cursor": None, "items": []})
        items = []
        for index in range(3):
            items.append({"nft_address": "0:" + f"{70 + index:02x}" * 32,
                          "nft_name": "Competitor", "owner": "0:" + "99" * 32, "attributes": [],
                          "min_duration": 86400, "max_duration": 2592000, "listed_at": None,
                          "price_per_day": str((index + 1) * 100_000_000), "discount_per_day": 0})
        return httpx.Response(200, json={"cursor": "opaque-next", "items": items})

    def factory(*args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(response), sleep=lambda _: None)

    monkeypatch.setattr(cli, "collect_prices", lambda store, settings, **kwargs:
                        collect_prices(store, settings, client_factory=factory, **kwargs))
    assert cli.main(args + ["import-portfolio", str(portfolio)]) == 0
    capsys.readouterr()
    assert cli.main(args + ["collect-prices", "--wallet", wallet, "--max-pages", "1"]) == 3
    first = json.loads(capsys.readouterr().out)
    assert first["state"] == "partial"
    assert cli.main(args + ["collect-prices", "--resume", str(first["run_id"])]) == 0
    assert json.loads(capsys.readouterr().out)["run_id"] == first["run_id"]
    assert len(requests) == 3
    monkeypatch.delenv("MARKETAPP_API_TOKEN")
    with Store(database) as store:
        gift = build_dashboard(store, wallet)["gifts"][0]
        assert gift["pricing"]["recommended_price_per_day"] == "0.2"
        assert gift["pricing"]["basis"] == "collection"
        assert gift["pricing"]["collection"]["sample_count"] == 3
        assert gift["pricing"]["model"]["mean"] is None
        assert len(store.observations("listing")) == 3
    assert len(requests) == 3


def test_price_cli_missing_token_fails_before_creating_database(tmp_path, monkeypatch):
    monkeypatch.delenv("MARKETAPP_API_TOKEN", raising=False)
    path = tmp_path / "not-created.sqlite3"
    assert cli.main(["--env-file", str(tmp_path / "none.env"), "--db", str(path), "collect-prices"]) == 2
    assert not path.exists()
