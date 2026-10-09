"""A portfolio refresh verifies its frozen manifest without wallet enumeration."""

import base64
import csv
import json
from pathlib import Path

import httpx
import pytest
from pytoniq_core import Builder, Cell

from marketapp_rent.addresses import canonical_address, preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.discovery import discover
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.reports import export_reports, status
from marketapp_rent.storage import Store
from marketapp_rent.ton_api import ACCOUNT_STATES_PATH, NFT_ITEMS_PATH, NFT_TRANSFERS_PATH, TonClient


def addr(number):
    return f"0:{number:064x}"


WALLET, NFT, COLLECTION = map(addr, (1, 2, 3))
FIXTURES = Path(__file__).parent / "fixtures" / "ton"


def item(nft=NFT, owner=WALLET, collection=COLLECTION):
    return {"address": nft, "owner_address": owner, "collection_address": collection,
            "init": True, "last_transaction_lt": "10", "content": {"name": "Refresh gift"}}


def seed(nft=NFT, collection=COLLECTION):
    return {"nft_address": nft, "collection_address": collection, "source": "dashboard_refresh_candidate", "priority": 1}


class RefreshProviders:
    def __init__(self, items=None, accounts=None, collections=None):
        self.items = items if items is not None else [item()]
        self.accounts = accounts or []
        self.collections = collections if collections is not None else [COLLECTION]
        self.requests = []
        self.now = 0.0
        self.hook = None

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET"
        path = request.url.path
        if self.hook:
            result = self.hook(request)
            if result is not None:
                return result
        if path == COLLECTIONS_PATH:
            assert request.headers["Authorization"] == "fake-market-secret"
            assert "X-API-Key" not in request.headers
            body = [{"address": value, "name": "Supported", "extra_data": {}} for value in self.collections]
        else:
            assert "Authorization" not in request.headers
            assert path != NFT_TRANSFERS_PATH, "Portfolio refresh must not enumerate transfers"
            addresses = set(request.url.params.get_list("address"))
            assert addresses, "Portfolio refresh must not enumerate wallet holdings"
            source = self.items if path == NFT_ITEMS_PATH else self.accounts
            assert path in {NFT_ITEMS_PATH, ACCOUNT_STATES_PATH}
            body = {"nft_items" if path == NFT_ITEMS_PATH else "accounts": [
                row for row in source if canonical_address(row["address"]) in addresses
            ]}
        return httpx.Response(200, json=body)

    def market(self, token, **kwargs):
        return ApiClient(token, **kwargs, transport=httpx.MockTransport(self.respond), sleep=self.sleep, random=lambda: 0)

    def ton(self, token, **kwargs):
        return TonClient(token, **kwargs, transport=httpx.MockTransport(self.respond), sleep=self.sleep, random=lambda: 0)

    def run(self, store, settings=None, token="fake-market-secret", **kwargs):
        return discover(store, settings or DiscoverySettings(), token, mode="portfolio_refresh",
                        ton_client_factory=self.ton, marketapp_client_factory=self.market,
                        monotonic=self.clock, **kwargs)


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "portfolio.sqlite3") as instance:
        yield instance


def test_complete_refresh_checks_manifest_without_claiming_enumeration(store, tmp_path):
    providers = RefreshProviders()
    result = providers.run(store, wallet=WALLET, seed_candidates=[seed(), seed(preferred_address(NFT)), seed(addr(9))])
    assert result.state == "complete" and result.pages_committed == 0
    ds = DiscoveryStore(store)
    assert len(ds.candidates(result.discovery_run_id)) == 2
    assert len(ds.memberships(WALLET)) == 1
    missing = next(row for row in ds.candidates(result.discovery_run_id) if row["nft_address"] == addr(9))
    assert missing["reason"] == "item_not_found" and not missing["verified"]
    checkpoints = ds.checkpoints(result.discovery_run_id)
    assert all(row["state"] == "not_requested" and row["pages"] == 0 for row in checkpoints)
    assert store.connection.execute("SELECT COUNT(*) FROM discovery_pages").fetchone()[0] == 0
    run = status(store)["latest_discovery_run"]
    assert run["operation"] == "portfolio_refresh" and not run["enumeration_complete"]
    view = build_dashboard(store, WALLET)
    assert not view["coverage"]["enumeration_complete"]
    assert "not a full wallet enumeration" in view["coverage"]["note"]
    # Report generation has no provider parameter and remains entirely offline.
    providers.hook = lambda _: pytest.fail("Offline report unexpectedly accessed a provider")
    export_reports(store, tmp_path / "exports", WALLET)
    with (tmp_path / "exports" / "discovery_runs.csv").open(encoding="utf-8-sig", newline="") as handle:
        exported = next(csv.DictReader(handle))
    assert exported["enumeration_complete"] == "false"


def test_bounded_refresh_reuses_catalog_saved_manifest_and_batch_size(store):
    providers = RefreshProviders(items=[item(), item(addr(4)), item(addr(5))])
    first = providers.run(store, DiscoverySettings(max_attempts=1, page_size=17, batch_size=1),
                          wallet=WALLET, seed_candidates=[seed(), seed(addr(4))])
    assert first.state == "partial" and len(providers.requests) == 1
    providers.collections = []  # A resume must not replace the committed catalog.
    resumed = providers.run(store, DiscoverySettings(page_size=900, batch_size=100), token="",
                            resume_id=first.discovery_run_id, seed_candidates=[seed(addr(5))])
    assert resumed.state == "complete"
    assert sum(request.url.path == COLLECTIONS_PATH for request in providers.requests) == 1
    lookups = [request for request in providers.requests if request.url.path == NFT_ITEMS_PATH]
    assert len(lookups) == 2 and all(len(request.url.params.get_list("address")) == 1 for request in lookups)
    ds = DiscoveryStore(store)
    assert {row["nft_address"] for row in ds.candidates(first.discovery_run_id)} == {NFT, addr(4)}
    assert ds.get_run(first.discovery_run_id)["catalog"] == [COLLECTION]


def test_refresh_resume_does_not_adopt_memberships_created_after_its_manifest(store):
    providers = RefreshProviders(items=[item(), item(addr(4))])
    first = providers.run(store, DiscoverySettings(max_attempts=1), wallet=WALLET, seed_candidates=[seed()])
    other = providers.run(store, wallet=WALLET, seed_candidates=[seed(addr(4))])
    assert other.state == "complete"
    assert {row["nft_address"] for row in DiscoveryStore(store).memberships(WALLET)} == {addr(4)}
    resumed = providers.run(store, token="", resume_id=first.discovery_run_id)
    assert resumed.state == "complete"
    assert {row["nft_address"] for row in DiscoveryStore(store).candidates(first.discovery_run_id)} == {NFT}


def test_refresh_snapshots_previously_verified_members_at_creation(store):
    providers = RefreshProviders(items=[item(), item(addr(4))])
    assert providers.run(store, wallet=WALLET, seed_candidates=[seed()]).state == "complete"
    result = providers.run(store, DiscoverySettings(max_attempts=1), wallet=WALLET, seed_candidates=[seed(addr(4))])
    ds = DiscoveryStore(store)
    assert {row["nft_address"] for row in ds.candidates(result.discovery_run_id)} == {NFT, addr(4)}
    member = next(row for row in ds.candidates(result.discovery_run_id) if row["nft_address"] == NFT)
    assert "previously_verified" in member["sources"]


def test_crash_after_run_creation_recovers_manifest_without_new_input(store):
    providers = RefreshProviders()
    saved = []

    def crash(run_id):
        saved.append(run_id)
        raise RuntimeError("simulated process interruption after durable run link")

    with pytest.raises(RuntimeError, match="durable run link"):
        providers.run(store, wallet=WALLET, seed_candidates=[seed()], on_run_created=crash)
    assert providers.requests == []
    result = providers.run(store, resume_id=saved[0], seed_candidates=[seed(addr(9))])
    assert result.state == "complete"
    assert {row["nft_address"] for row in DiscoveryStore(store).candidates(result.discovery_run_id)} == {NFT}


def test_crash_before_verification_commit_leaves_queue_pending_and_catalog_reusable(store, monkeypatch):
    providers = RefreshProviders()
    original = DiscoveryStore.commit_verification

    def crash(*args, **kwargs):
        raise RuntimeError("crash before evidence transaction")

    monkeypatch.setattr(DiscoveryStore, "commit_verification", crash)
    with pytest.raises(RuntimeError, match="evidence transaction"):
        providers.run(store, wallet=WALLET, seed_candidates=[seed()])
    ds = DiscoveryStore(store)
    assert ds.candidates(1)[0]["state"] == "pending"
    assert ds.ownership_observations() == [] and ds.memberships() == []
    monkeypatch.setattr(DiscoveryStore, "commit_verification", original)
    assert providers.run(store, token="", resume_id=1).state == "complete"
    assert len(ds.ownership_observations()) == len(ds.memberships()) == 1
    assert sum(request.url.path == COLLECTIONS_PATH for request in providers.requests) == 1


def test_bounded_batch_commits_independent_items_and_resume_only_checks_pending(store):
    providers = RefreshProviders(items=[item(), item(addr(4))])
    result = providers.run(store, DiscoverySettings(max_attempts=2, batch_size=1), wallet=WALLET,
                           seed_candidates=[seed(), seed(addr(4))])
    assert result.state == "partial"
    ds = DiscoveryStore(store)
    assert len(ds.ownership_observations()) == 1 and len(ds.pending(result.discovery_run_id, 100)) == 1
    first_nft = ds.ownership_observations()[0]["nft_address"]
    count = len(providers.requests)
    assert providers.run(store, token="", resume_id=result.discovery_run_id).state == "complete"
    later_lookups = [request for request in providers.requests[count:] if request.url.path == NFT_ITEMS_PATH]
    assert len(later_lookups) == 1 and first_nft not in later_lookups[0].url.params.get_list("address")
    assert len(ds.ownership_observations()) == len(ds.memberships()) == 2


def test_refresh_mode_and_resume_configuration_are_frozen(store):
    providers = RefreshProviders()
    result = providers.run(store, DiscoverySettings(max_attempts=1), wallet=WALLET, seed_candidates=[seed()])
    with pytest.raises(ValueError, match="mode"):
        discover(store, DiscoverySettings(), "", resume_id=result.discovery_run_id)
    with pytest.raises(ValueError, match="wallet"):
        providers.run(store, token="", resume_id=result.discovery_run_id, wallet=addr(99))
    with pytest.raises(ValueError, match="page_size"):
        providers.run(store, token="", resume_id=result.discovery_run_id, explicit_options={"page_size": 2})


def test_fresh_refresh_rechecks_members_without_deleting_historical_evidence(store):
    providers = RefreshProviders()
    first = providers.run(store, wallet=WALLET, seed_candidates=[seed()])
    providers.items = []
    second = providers.run(store, wallet=WALLET)
    assert first.state == second.state == "complete"
    ds = DiscoveryStore(store)
    assert len(ds.ownership_observations()) == 2 and len(ds.memberships()) == 1
    assert ds.ownership_observations()[-1]["reason"] == "item_not_found"
    assert build_dashboard(store, WALLET)["gifts"][0]["state"] in {"unknown", "uncertain"}
    assert sum(request.url.path == COLLECTIONS_PATH for request in providers.requests) == 2


def test_new_variant_refresh_preserves_exact_contract_coins_and_provider_evidence(store):
    saved = json.loads((FIXTURES / "7f44-rented.json").read_text(encoding="utf-8"))
    account = saved["account"]
    account["code_boc"] = (FIXTURES / saved["code_fixture"]).read_text().strip()
    # A valid Coins amount beyond binary float precision catches accidental rounding.
    raw_amount = "100000000000000000000000123"
    data = Cell.one_from_boc(account["data_boc"])
    parser = data.refs[2].begin_parse()
    auto_relist, min_duration, max_duration = parser.load_uint(1), parser.load_uint(32), parser.load_uint(32)
    parser.load_coins()
    discounts = [parser.load_uint(32) for _ in range(3)]
    sale_price = parser.load_coins()
    builder = Builder().store_uint(auto_relist, 1).store_uint(min_duration, 32).store_uint(max_duration, 32).store_coins(int(raw_amount))
    for number in discounts:
        builder.store_uint(number, 32)
    refs = list(data.refs)
    refs[2] = builder.store_coins(sale_price).end_cell()
    updated = Cell(data.bits, refs)
    account["data_boc"] = base64.b64encode(updated.to_boc()).decode()
    account["data_hash"] = updated.hash.hex()
    nft = saved["nft_before"]
    providers = RefreshProviders(items=[nft], accounts=[account], collections=[nft["collection_address"]])
    result = providers.run(store, wallet=saved["wallet_address"], seed_candidates=[seed(nft["address"], nft["collection_address"])])
    assert result.state == "complete"
    observation = DiscoveryStore(store).ownership_observations()[0]
    assert observation["verified"] and observation["contract_variant"] == "marketapp-observed-7f44bead-v1"
    assert observation["code_hash_verified"] and observation["data_hash_verified"]
    assert observation["configured_price_per_day_raw"] == raw_amount
    view = build_dashboard(store, saved["wallet_address"])
    assert view["gifts"][0]["price_per_day"] == "100000000000000000.000000123"
    assert view["gifts"][0]["price_source"] == "Observed contract terms"
    assert [request.url.path for request in providers.requests] == [
        COLLECTIONS_PATH, NFT_ITEMS_PATH, ACCOUNT_STATES_PATH, NFT_ITEMS_PATH]
    assert store.connection.execute("SELECT COUNT(*) FROM ownership_response_links").fetchone()[0] == 3
