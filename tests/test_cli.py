import csv
import json
import httpx

from marketapp_rent import cli
from marketapp_rent.api import ApiClient
from marketapp_rent.collector import collect as real_collect
from marketapp_rent.storage import Store


def test_cli_import_collect_resume_status_and_report(tmp_path, monkeypatch, capsys):
    token = "only-a-mocked-test-token"
    monkeypatch.setenv("MARKETAPP_API_TOKEN", token)
    portfolio = tmp_path / "portfolio.csv"
    portfolio.write_text("nft_address,collection_address,label\nowned,C,Gift\nmissing,C,Absent\n")
    database = tmp_path / "collector.sqlite3"
    global_args = ["--env-file", str(tmp_path / "no-env"), "--db", str(database)]
    calls = []

    def handler(request):
        assert request.method == "GET"
        assert request.headers["Authorization"] == token
        calls.append(request)
        if request.url.path == "/v1/collections/gifts/":
            return httpx.Response(200, json=[{"name": "Collection", "address": "C", "extra_data": {}}])
        if request.url.path.endswith("/attributes/"):
            return httpx.Response(200, json={"attributes": [{"trait_type": "Model", "values": [{"value": "Gold"}]}]})
        if request.url.path.endswith("/history/"):
            return httpx.Response(200, json={"cursor": None, "items": [{
                "address": "owned", "name": "Gift", "collection_address": "C", "ts": 123,
                "src": "unknown-source", "dst": "unknown-destination", "price": "0.01",
                "price_nano": "10000000", "currency": "GRAM",
            }]})
        assert request.url.path == "/v1/rent/gifts/"
        if "cursor" in request.url.params:
            assert request.url.params["cursor"] == "next-page"
            return httpx.Response(200, json={"cursor": None, "items": []})
        return httpx.Response(200, json={"cursor": "next-page", "items": [{
            "nft_address": "owned", "nft_name": "Gift", "owner": "WALLET",
            "attributes": [], "min_duration": 86400, "max_duration": 15552000,
            "price_per_day": "10000000", "discount_per_day": 0.1, "listed_at": None,
        }]})

    def client_factory(*args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(handler), sleep=lambda _: None)

    def mocked_collect(store, settings, **kwargs):
        return real_collect(store, settings, client_factory=client_factory, **kwargs)

    monkeypatch.setattr(cli, "collect", mocked_collect)
    assert cli.main(global_args + ["import-portfolio", str(portfolio)]) == 0
    capsys.readouterr()
    assert cli.main(global_args + ["collect", "--max-pages", "1"]) == 3
    captured = capsys.readouterr()
    first = json.loads(captured.out)
    assert token not in captured.err
    run_id = first["run_id"]
    assert first["state"] == "partial"
    count = len(calls)
    assert cli.main(global_args + ["collect", "--resume", str(run_id)]) == 0
    assert len(calls) == count + 1
    capsys.readouterr()
    monkeypatch.delenv("MARKETAPP_API_TOKEN")
    assert cli.main(global_args + ["status"]) == 0
    overview = json.loads(capsys.readouterr().out)
    assert overview["portfolio_count"] == 2
    assert overview["latest_run"]["state"] == "complete"
    out = tmp_path / "reports"
    assert cli.main(global_args + ["report", "--out", str(out), "--owner-address", "WALLET"]) == 0
    assert len(calls) == count + 1  # offline commands cannot make requests
    capsys.readouterr()
    with (out / "portfolio_coverage.csv").open(encoding="utf-8-sig", newline="") as handle:
        coverage = {row["nft_address"]: row for row in csv.DictReader(handle)}
    assert coverage["owned"]["last_observed_owner_comparison"] == "match"
    assert coverage["missing"]["current_visibility"] == "unknown"
    assert coverage["missing"]["price_per_day_gram"] == ""
    with Store(database) as store:
        assert len(store.records("history")) == 1
        assert len(store.observations("listing")) == 1
        assert store.observations("attribute")[0]["collection_address"] == "C"
        for row in store.connection.execute("SELECT body FROM attempts WHERE body IS NOT NULL"):
            assert token.encode() not in row[0]


def test_no_token_needed_for_offline_commands(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("MARKETAPP_API_TOKEN", raising=False)
    args = ["--env-file", str(tmp_path / "missing"), "--db", str(tmp_path / "empty.sqlite3")]
    assert cli.main(args + ["status"]) == 0
    assert json.loads(capsys.readouterr().out)["portfolio_count"] == 0
    assert cli.main(args + ["report", "--out", str(tmp_path / "out")]) == 0
    capsys.readouterr()


def test_missing_token_collect_is_config_error_and_creates_no_db(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("MARKETAPP_API_TOKEN", raising=False)
    db = tmp_path / "absent.sqlite3"
    assert cli.main(["--env-file", str(tmp_path / "missing"), "--db", str(db), "collect"]) == 2
    assert not db.exists()
    assert "MARKETAPP_API_TOKEN" in capsys.readouterr().err


def test_cli_rejects_bad_run_without_traceback(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "mock-token")
    assert cli.main(["--env-file", str(tmp_path / "missing"), "--db", str(tmp_path / "empty.sqlite3"), "collect", "--resume", "42"]) == 2
    assert "does not exist" in capsys.readouterr().err
