import csv
import json
import logging
from dataclasses import replace

import httpx
import pytest

from marketapp_rent import cli
from marketapp_rent.addresses import address_key, preferred_address
from marketapp_rent.api import ApiClient
from marketapp_rent.collector import collect
from marketapp_rent.discovery import DiscoveryResult, discover
from marketapp_rent.discovery_config import DiscoverySettings, load_discovery_settings
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse
from marketapp_rent.logging_setup import JsonFormatter
from marketapp_rent.reports import export_reports, status
from marketapp_rent.storage import Store
from marketapp_rent.ton_api import TonClient


WALLET = "0:" + "01" * 32
NFT = "0:" + "02" * 32
COLLECTION = "0:" + "03" * 32
OTHER_WALLET = "0:" + "04" * 32


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def test_discovery_configuration_is_independent_and_environment_wins(tmp_path):
    path = tmp_path / ".env"
    path.write_text("TONCENTER_API_KEY=file-secret\nTON_DISCOVERY_PAGE_SIZE=50\nTON_DISCOVERY_MAX_PAGES=7\n")
    settings = load_discovery_settings(path, {"TONCENTER_API_KEY": "env-secret", "TON_DISCOVERY_PAGE_SIZE": "500"})
    assert settings.api_key == "env-secret"
    assert settings.page_size == 500
    assert settings.max_pages == 7
    assert settings.batch_size == 100
    assert settings.max_attempts == 100
    assert settings.run_seconds == 300
    assert settings.requests_per_second == 1
    assert settings.timeout == 30
    assert settings.retry_attempts == 4
    assert "secret" not in repr(settings)


@pytest.mark.parametrize("overrides", [
    {"page_size": 0}, {"page_size": 1001}, {"batch_size": 101},
    {"max_pages": False}, {"max_attempts": 0}, {"retry_attempts": 0},
    {"run_seconds": float("nan")}, {"requests_per_second": float("inf")},
    {"timeout": -1}, {"api_key": "bad\nkey"},
])
def test_invalid_discovery_configuration(overrides):
    with pytest.raises(ValueError):
        replace(DiscoverySettings(), **overrides)


def test_bad_discovery_environment_is_configuration_error(tmp_path):
    with pytest.raises(ValueError, match="TON_DISCOVERY_PAGE_SIZE"):
        load_discovery_settings(tmp_path / "absent", {"TON_DISCOVERY_PAGE_SIZE": "invalid"})


def test_cli_discovery_options_fallback_and_resume_wallet(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "market-secret")
    monkeypatch.setenv("TONCENTER_API_KEY", "ton-secret")
    monkeypatch.setenv("MARKETAPP_OWNER_ADDRESS", WALLET)
    seen = []

    def fake_discover(store, settings, token, **kwargs):
        seen.append((store.path, settings, token, kwargs))
        return DiscoveryResult(5, "partial", "page_limit", 2)

    monkeypatch.setattr(cli, "discover", fake_discover)
    args = ["--env-file", str(tmp_path / "missing"), "--db", str(tmp_path / "test.sqlite3")]
    assert cli.main(args + ["discover-wallet", "--page-size", "500", "--batch-size", "25", "--max-pages", "2"]) == 3
    assert json.loads(capsys.readouterr().out)["discovery_run_id"] == 5
    _, settings, token, kwargs = seen[-1]
    assert token == "market-secret"
    assert settings.page_size == 500
    assert settings.batch_size == 25
    assert settings.max_pages == 2
    assert kwargs["wallet"] == WALLET
    assert kwargs["explicit_options"] == {"page_size": 500, "batch_size": 25}
    monkeypatch.delenv("MARKETAPP_API_TOKEN")
    monkeypatch.setenv("MARKETAPP_OWNER_ADDRESS", OTHER_WALLET)
    assert cli.main(args + ["discover-wallet", "--resume", "5"]) == 3
    assert seen[-1][3]["wallet"] is None
    assert seen[-1][2] == ""
    assert cli.main(args + ["discover-wallet", "--resume", "5", "--wallet", WALLET]) == 3
    assert seen[-1][3]["wallet"] == WALLET


@pytest.mark.parametrize("token,wallet,error", [(None, WALLET, "MARKETAPP_API_TOKEN"), ("token", None, "--wallet")])
def test_new_discovery_missing_configuration_does_not_create_db(tmp_path, monkeypatch, capsys, token, wallet, error):
    for name, value in (("MARKETAPP_API_TOKEN", token), ("MARKETAPP_OWNER_ADDRESS", wallet)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    db = tmp_path / "absent.sqlite3"
    assert cli.main(["--env-file", str(tmp_path / "missing"), "--db", str(db), "discover-wallet"]) == 2
    assert not db.exists()
    assert error in capsys.readouterr().err


def test_logging_redacts_both_provider_credentials_in_context():
    formatter = JsonFormatter("market-secret", "ton-secret")
    record = logging.LogRecord("marketapp_rent", logging.ERROR, "", 0, "market-secret ton-secret", (), None)
    record.context = {"nested": {"credentials": "ton-secret market-secret"}}
    result = formatter.format(record)
    assert "market-secret" not in result
    assert "ton-secret" not in result
    assert json.loads(result)["nested"]["credentials"] == "[REDACTED] [REDACTED]"


def test_mocked_discovery_resume_collect_and_offline_exports(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "market-secret")
    monkeypatch.setenv("TONCENTER_API_KEY", "ton-secret")
    monkeypatch.setenv("MARKETAPP_OWNER_ADDRESS", preferred_address(WALLET))
    calls = []
    item = {"address": NFT, "owner_address": WALLET, "collection_address": COLLECTION,
            "init": True, "last_transaction_lt": "10", "content": {"name": "Gift"}}

    def ton_handler(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.headers["X-API-Key"] == "ton-secret"
        assert "Authorization" not in request.headers
        if request.url.path.endswith("/nft/transfers"):
            return httpx.Response(200, json={"nft_transfers": []})
        assert request.url.path.endswith("/nft/items")
        if "address" in request.url.params:
            return httpx.Response(200, json={"nft_items": [item]})
        assert request.url.params["include_on_sale"] == "false"
        return httpx.Response(200, json={"nft_items": [item] if request.url.params["offset"] == "0" else []})

    def market_handler(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.headers["Authorization"] == "market-secret"
        assert "X-API-Key" not in request.headers
        if request.url.path == "/v1/collections/gifts/":
            return httpx.Response(200, json=[{"name": "Collection", "address": COLLECTION, "extra_data": {}}])
        if request.url.path.endswith("/attributes/"):
            return httpx.Response(200, json={"attributes": []})
        if request.url.path.endswith("/history/"):
            return httpx.Response(200, json={"cursor": None, "items": [{
                "address": preferred_address(NFT), "name": "Gift", "collection_address": preferred_address(COLLECTION),
                "ts": 123, "src": "unknown", "dst": "unknown", "price": "1", "price_nano": "1000000000", "currency": "GRAM",
            }]})
        return httpx.Response(200, json={"cursor": None, "items": [{
            "nft_address": preferred_address(NFT), "nft_name": "Gift", "owner": preferred_address(WALLET),
            "attributes": [], "min_duration": 86400, "max_duration": 15552000,
            "price_per_day": "10000000", "discount_per_day": 0.1, "listed_at": None,
        }]})

    def ton_factory(*args, **kwargs):
        return TonClient(*args, **kwargs, transport=httpx.MockTransport(ton_handler), sleep=lambda _: None)

    def market_factory(*args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(market_handler), sleep=lambda _: None)

    monkeypatch.setattr(cli, "discover", lambda *args, **kwargs: discover(*args, **kwargs, ton_client_factory=ton_factory, marketapp_client_factory=market_factory))
    monkeypatch.setattr(cli, "collect", lambda *args, **kwargs: collect(*args, **kwargs, client_factory=market_factory))
    db = tmp_path / "workflow.sqlite3"
    args = ["--env-file", str(tmp_path / "missing"), "--db", str(db)]
    assert cli.main(args + ["discover-wallet", "--max-pages", "1"]) == 3
    run_id = json.loads(capsys.readouterr().out)["discovery_run_id"]
    with Store(db) as store:
        assert len(store.portfolio()) == 1
        assert store.portfolio()[0]["membership_sources"] == ["ton_verified"]
        assert store.portfolio()[0]["declared_at"] is None
    monkeypatch.delenv("MARKETAPP_API_TOKEN")
    count = len(calls)
    assert cli.main(args + ["discover-wallet", "--resume", str(run_id)]) == 0
    assert len(calls) == count + 1
    capsys.readouterr()
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "market-secret")
    assert cli.main(args + ["collect"]) == 0
    capsys.readouterr()
    monkeypatch.delenv("MARKETAPP_API_TOKEN")
    count = len(calls)
    assert cli.main(args + ["status"]) == 0
    overview = json.loads(capsys.readouterr().out)
    assert overview["run_count"] == 1
    assert overview["discovery_run_count"] == 1
    assert overview["resumable_discovery_runs"] == []
    assert overview["latest_discovery_run"]["enumeration_complete"] is True
    assert overview["latest_discovery_run"]["http_attempts_by_provider"] == {"marketapp": 1, "toncenter": 4}
    out = tmp_path / "exports"
    assert cli.main(args + ["report", "--out", str(out)]) == 0
    assert len(calls) == count
    coverage = read_csv(out / "portfolio_coverage.csv")[0]
    assert coverage["membership"] == "ton_verified"
    assert coverage["declared_at"] == ""
    assert coverage["ton_ownership_state"] == "held_directly"
    assert coverage["last_observed_owner_comparison"] == "match"
    assert coverage["has_portfolio_gift_history"] == "true"
    assert read_csv(out / "history_records.csv")[0]["history_classification"] == "portfolio gift history"
    assert len(read_csv(out / "ownership_observations.csv")) == 1


def test_reports_select_wallet_and_keep_previous_evidence_when_refresh_pending(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        ds = DiscoveryStore(store)
        run = ds.create_run(WALLET, {})
        ds.save_catalog(run, ApiResponse(b"[]", 200, "2026-10-08T10:00:00Z"), [COLLECTION])
        ds.add_candidates(run, [{"nft_address": NFT, "source": "holdings"}])
        ds.commit_verification(run, NFT, {
            "verified": True, "collection_address": COLLECTION, "rental_state": "held_directly",
            "reason": "direct_owner_match", "observed_at": "2026-10-08T10:00:00Z",
        }, [])
        ds.finish_run(run, "complete")
        other_run = ds.create_run(OTHER_WALLET, {})
        ds.add_candidates(other_run, [{"nft_address": NFT, "source": "transfer"}])
        ds.commit_verification(other_run, NFT, {"verified": False, "rental_state": "unknown", "reason": "owner_mismatch", "observed_at": "2026-10-08T11:00:00Z"}, [])
        out = tmp_path / "out"
        export_reports(store, out, preferred_address(WALLET))
        row = read_csv(out / "portfolio_coverage.csv")[0]
        assert row["ton_verified"] == "true"
        assert address_key(row["ton_wallet_address"]) == WALLET
        refresh = ds.create_run(WALLET, {})
        ds.add_candidates(refresh, [{"nft_address": NFT, "source": "previously_verified"}])
        export_reports(store, out, WALLET)
        row = read_csv(out / "portfolio_coverage.csv")[0]
        assert row["ton_ownership_state"] == "unknown"
        assert row["ton_verified"] == ""
        assert row["ton_last_observation_verified"] == "true"
        assert row["ton_last_observed_ownership_state"] == "held_directly"
        assert row["ton_observation_run_id"] == str(run)
        overview = status(store)
        assert overview["latest_run"] is None
        assert overview["latest_discovery_run"]["id"] == refresh
        assert overview["pending_discovery_verifications"]


def test_late_collection_conflict_overrides_current_ownership_without_rewriting_evidence(tmp_path):
    with Store(tmp_path / "test.sqlite3") as store:
        ds = DiscoveryStore(store)
        run = ds.create_run(WALLET, {})
        ds.save_catalog(run, ApiResponse(b"[]", 200, "2026-10-08T10:00:00Z"), [COLLECTION])
        ds.add_candidates(run, [{"nft_address": NFT, "source": "holdings", "collection_address": COLLECTION}])
        ds.commit_verification(run, NFT, {
            "verified": True, "collection_address": COLLECTION, "rental_state": "held_directly",
            "reason": "direct_owner_match", "observed_at": "2026-10-08T10:00:00Z",
        }, [])
        ds.add_candidates(run, [{"nft_address": NFT, "source": "transfer", "collection_address": OTHER_WALLET}])
        out = tmp_path / "out"
        export_reports(store, out, WALLET)
        row = read_csv(out / "portfolio_coverage.csv")[0]
        assert row["ton_ownership_state"] == "unknown"
        assert row["ton_verified"] == "false"
        assert row["ton_ownership_reason"] == "collection_conflict"
        assert row["ton_last_observation_verified"] == "true"
        assert row["ton_last_observed_ownership_state"] == "held_directly"
        observation = read_csv(out / "ownership_observations.csv")[0]
        assert observation["verified"] == "true"
        assert observation["reason"] == "direct_owner_match"
        candidate = read_csv(out / "discovery_candidates.csv")[0]
        assert candidate["verified"] == "false"
        assert candidate["reason"] == "collection_conflict"
        assert status(store)["latest_discovery_run"]["unresolved_candidate_count"] == 1
