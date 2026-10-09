"""Mocked discovery through real clients, persistence, enrollment and reports."""
import json
from pathlib import Path

import httpx
import pytest

from marketapp_rent.addresses import canonical_address, preferred_address
from marketapp_rent.api import ApiClient, COLLECTIONS_PATH
from marketapp_rent.collector import collect
from marketapp_rent.config import Settings
from marketapp_rent.discovery import discover
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ValidationError
from marketapp_rent.reports import export_reports, status
from marketapp_rent.storage import Store
from marketapp_rent.ton_api import TonClient, NFT_ITEMS_PATH, NFT_TRANSFERS_PATH, ACCOUNT_STATES_PATH


def addr(n):
    return f"0:{n:064x}"


WALLET, NFT, COLLECTION, HOLDER = map(addr, (1, 2, 3, 4))
FIXTURES = Path(__file__).parent / "fixtures" / "ton"


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def item(nft=NFT, owner=WALLET, collection_address=COLLECTION, lt="10", **extra):
    return {"address": nft, "owner_address": owner, "collection_address": collection_address,
            "init": True, "last_transaction_lt": lt, "content": {"name": "Example gift"}, **extra}


def transfer(nft=NFT, lt=20, **extra):
    return {"nft_address": nft, "old_owner": WALLET, "new_owner": HOLDER,
            "nft_collection": COLLECTION, "transaction_lt": str(lt), "transaction_aborted": False, **extra}


class MockProviders:
    def __init__(self, items=None, transfers=None, accounts=None, collections=None):
        self.items = items if items is not None else [item()]
        self.transfers = transfers or []
        self.accounts = accounts or []
        self.collections = collections if collections is not None else [COLLECTION]
        self.now = 0.0
        self.requests = []
        self.hook = None

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET"
        if request.url.host == "api.marketapp.org":
            assert request.headers["Authorization"] == "market-secret"
            assert "X-API-Key" not in request.headers
        else:
            assert request.url.host == "toncenter.com"
            assert "Authorization" not in request.headers
        if self.hook:
            response = self.hook(request)
            if response is not None:
                return response
        path, query = request.url.path, request.url.params
        if path == COLLECTIONS_PATH:
            result = [{"address": collection, "name": "Supported", "extra_data": {}} for collection in self.collections]
        elif path == NFT_ITEMS_PATH:
            if "address" in query:
                requested = set(query.get_list("address"))
                entries = [i for i in self.items if canonical_address(i["address"]) in requested]
            else:
                assert query["include_on_sale"] == "false"
                owners = set(query.get_list("owner_address"))
                entries = [i for i in self.items if canonical_address(i["owner_address"]) in owners]
            offset, limit = int(query.get("offset", 0)), int(query.get("limit", 100))
            result = {"nft_items": entries[offset:offset + limit]}
        elif path == NFT_TRANSFERS_PATH:
            entries = [t for t in self.transfers if int(t["transaction_lt"]) <= int(query.get("end_lt", 2 ** 64 - 1))]
            entries.sort(key=lambda x: int(x["transaction_lt"]), reverse=True)
            offset, limit = int(query.get("offset", 0)), int(query.get("limit", 100))
            result = {"nft_transfers": entries[offset:offset + limit]}
        elif path == ACCOUNT_STATES_PATH:
            requested = set(query.get_list("address"))
            result = {"accounts": [a for a in self.accounts if canonical_address(a["address"]) in requested]}
        elif path == "/v1/rent/gifts/":
            result = {"cursor": None, "items": [{"nft_address": preferred_address(NFT), "nft_name": "Example",
                "owner": preferred_address(WALLET), "attributes": [], "min_duration": 1, "max_duration": 2,
                "price_per_day": "123", "discount_per_day": 0, "listed_at": None}]}
        elif path == "/v1/rent/gifts/history/":
            result = {"cursor": None, "items": []}
        elif path.endswith("/attributes/"):
            result = {"attributes": []}
        else:
            raise AssertionError(f"Unexpected route {path}")
        return httpx.Response(200, json=result)

    def market(self, token, **kwargs):
        return ApiClient(token, **kwargs, transport=httpx.MockTransport(self.respond), sleep=self.sleep, random=lambda: 0)

    def ton(self, token, **kwargs):
        return TonClient(token, **kwargs, transport=httpx.MockTransport(self.respond), sleep=self.sleep, random=lambda: 0)

    def run(self, store, settings=None, token="market-secret", **kwargs):
        return discover(store, settings or DiscoverySettings(), token, ton_client_factory=self.ton,
                        marketapp_client_factory=self.market, monotonic=self.clock, **kwargs)


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "test.db") as result:
        yield result


def test_bounded_resume_enrollment_collection_and_offline_reports(store, tmp_path):
    api = MockProviders(transfers=[transfer()])
    result = api.run(store, DiscoverySettings(max_pages=1), wallet=preferred_address(WALLET))
    assert result.state == "partial"
    ds = DiscoveryStore(store)
    assert len(ds.memberships(WALLET)) == 1
    assert store.portfolio()[0]["membership_sources"] == ["ton_verified"]
    # Resume freezes catalog and page size; changed defaults are ignored.
    result = api.run(store, DiscoverySettings(page_size=400), token="", resume_id=result.discovery_run_id)
    assert result.state == "complete"
    assert sum(r.url.path == COLLECTIONS_PATH for r in api.requests) == 1
    assert len(ds.ownership_observations()) == 1
    market_result = collect(store, Settings(token="market-secret", max_collections=3), client_factory=api.market)
    assert market_result.state == "complete"
    def offline(*args, **kwargs):
        raise AssertionError("Reports and status must remain offline")
    api.hook = offline
    files = export_reports(store, tmp_path / "reports", preferred_address(WALLET))
    assert len(files) == 12
    assert status(store)["portfolio_count"] == 1
    import csv
    coverage = list(csv.DictReader((tmp_path / "reports/portfolio_coverage.csv").open(encoding="utf-8-sig")))[0]
    assert coverage["last_observed_owner_comparison"] == "match"
    listings = list(csv.DictReader((tmp_path / "reports/listing_observations.csv").open(encoding="utf-8-sig")))
    assert listings[0]["portfolio_member"] == "true"


def test_equal_lt_boundaries_overlap_and_empty_page_completion(store):
    transfers = [transfer(addr(10 + i), lt=90 if i < 4 else 80) for i in range(7)]
    api = MockProviders(items=[], transfers=transfers)
    result = api.run(store, DiscoverySettings(page_size=2), wallet=WALLET)
    assert result.state == "complete"
    queries = [dict(r.url.params) for r in api.requests if r.url.path == NFT_TRANSFERS_PATH]
    assert [(q.get("end_lt"), q["offset"]) for q in queries] == [(None, "0"), ("90", "2"), ("90", "4"), ("80", "2"), ("80", "3")]
    ds = DiscoveryStore(store)
    assert len(ds.candidates()) == 7
    assert next(c for c in ds.checkpoints(result.discovery_run_id) if c["kind"] == "transfers")["upper_lt"] == "90"


def test_crash_after_enumeration_preserves_verification_queue(store, monkeypatch):
    api = MockProviders()
    original = DiscoveryStore.commit_verification
    def crash(*args, **kwargs):
        raise RuntimeError("Simulated process crash")
    monkeypatch.setattr(DiscoveryStore, "commit_verification", crash)
    with pytest.raises(RuntimeError):
        api.run(store, wallet=WALLET)
    ds = DiscoveryStore(store)
    assert len(ds.pending(1, 100)) == 1
    assert ds.memberships() == []
    monkeypatch.setattr(DiscoveryStore, "commit_verification", original)
    assert api.run(store, token="", resume_id=1).state == "complete"
    assert len(ds.memberships()) == 1


def test_verified_examples_via_history_and_current_contracts(store):
    samples = load("sample-nfts.json")["body"]["nft_items"]
    accounts = load("holder-states.json")["body"]["accounts"]
    wallet = canonical_address(load("verified-samples.json")["wallet_address"])
    moves = [transfer(s["address"], lt=90 - i, old_owner=wallet, nft_collection=s["collection_address"]) for i, s in enumerate(samples)]
    api = MockProviders(samples, moves, accounts, [s["collection_address"] for s in samples])
    result = api.run(store, wallet=wallet)
    assert result.state == "complete"
    observations = DiscoveryStore(store).ownership_observations()
    assert len(observations) == 2 and all(o["verified"] for o in observations)
    assert {o["role"] for o in observations} == {0, 1}
    assert len(store.portfolio()) == 2
    assert all(o["wallet_address"] == wallet for o in observations)


@pytest.mark.parametrize("changes,reason", [
    ({"collection_address": None}, "missing_collection"),
    ({"collection_address": addr(999)}, "unsupported_collection"),
    ({"collection": {"address": addr(999)}}, "collection_conflict"),
    ({"init": None}, "uninitialized_or_unknown_item"),
    ({"last_transaction_lt": None}, "missing_nft_logical_time"),
])
def test_uncertain_or_unrelated_gifts_are_not_enrolled(store, changes, reason):
    api = MockProviders(items=[item(**changes)])
    assert api.run(store, wallet=WALLET).state == "complete"
    assert store.portfolio() == []
    assert DiscoveryStore(store).ownership_observations()[0]["reason"] == reason


def test_unknown_contract_and_aborted_transfer(store):
    api = MockProviders(items=[item(owner=HOLDER)], transfers=[transfer(), transfer(addr(9), transaction_aborted=True)],
                        accounts=[{"address": HOLDER, "status": "active", "code_hash": "aa" * 32, "data_hash": "bb" * 32}])
    assert api.run(store, wallet=WALLET).state == "complete"
    ds = DiscoveryStore(store)
    assert len(ds.candidates()) == 1
    assert ds.ownership_observations()[0]["reason"] == "unsupported_code_hash"
    assert store.portfolio() == []


def test_holder_moving_retries_once_and_remains_unresolved(store):
    api = MockProviders(items=[item(owner=HOLDER)], transfers=[transfer()])
    def move(request):
        if request.url.path == ACCOUNT_STATES_PATH:
            api.items[0]["last_transaction_lt"] = str(int(api.items[0]["last_transaction_lt"]) + 1)
    api.hook = move
    assert api.run(store, wallet=WALLET).state == "complete"
    assert sum(r.url.path == ACCOUNT_STATES_PATH for r in api.requests) == 2
    assert DiscoveryStore(store).ownership_observations()[0]["reason"] == "changed_during_verification"
    assert store.portfolio() == []


def test_contract_return_to_wallet_gets_one_stable_recheck(store):
    api = MockProviders(items=[item(owner=HOLDER)], transfers=[transfer()])
    def returned(request):
        if request.url.path == ACCOUNT_STATES_PATH:
            api.items[0]["owner_address"] = WALLET
            api.items[0]["last_transaction_lt"] = "11"
    api.hook = returned
    assert api.run(store, wallet=WALLET).state == "complete"
    observation = DiscoveryStore(store).ownership_observations()[0]
    assert observation["verified"] and observation["rental_state"] == "held_directly"
    assert sum(r.url.path == ACCOUNT_STATES_PATH for r in api.requests) == 1


def test_independent_direct_result_commits_before_rental_budget_stop(store):
    api = MockProviders(items=[item(), item(nft=addr(5), owner=HOLDER)], transfers=[transfer(addr(5))])
    # Catalog, holdings, transfers, batch item lookup; no budget left for accounts.
    result = api.run(store, DiscoverySettings(max_attempts=4), wallet=WALLET)
    assert result.state == "partial"
    ds = DiscoveryStore(store)
    assert len(ds.memberships()) == 1
    assert ds.pending(result.discovery_run_id, 100)[0]["nft_address"] == addr(5)


def test_catalog_failure_and_resume_requires_token_until_committed(store):
    api = MockProviders()
    api.hook = lambda r: httpx.Response(401, json={"message": "no"}) if r.url.path == COLLECTIONS_PATH else None
    result = api.run(store, wallet=WALLET)
    assert result.state == "failed" and result.reason == "authentication"
    assert len(api.requests) == 1
    with pytest.raises(ValueError, match="TOKEN"):
        api.run(store, token="", resume_id=result.discovery_run_id)
    api.hook = None
    assert api.run(store, resume_id=result.discovery_run_id).state == "complete"


@pytest.mark.parametrize("body", [b"not-json", b'{"nft_items":null}', b'{"nft_items":[],"nft_items":[]}'])
def test_invalid_response_keeps_raw_body_without_checkpoint(store, body):
    api = MockProviders()
    api.hook = lambda r: httpx.Response(200, content=body) if r.url.path == NFT_ITEMS_PATH else None
    result = api.run(store, wallet=WALLET)
    assert result.state == "failed"
    assert DiscoveryStore(store).checkpoints(result.discovery_run_id)[0]["pages"] == 0
    assert store.connection.execute("SELECT body FROM discovery_responses WHERE purpose='attempt' ORDER BY id DESC").fetchone()[0] == body


def test_attempt_limit_includes_catalog_and_resume_keeps_catalog(store):
    api = MockProviders()
    result = api.run(store, DiscoverySettings(max_attempts=1), wallet=WALLET)
    assert result.state == "partial" and len(api.requests) == 1
    assert DiscoveryStore(store).get_run(result.discovery_run_id)["catalog_committed"]
    assert api.run(store, token="", resume_id=result.discovery_run_id).state == "complete"


def test_resume_rejects_changed_wallet_page_size_or_decoder(store):
    api = MockProviders()
    result = api.run(store, DiscoverySettings(max_attempts=1), wallet=WALLET)
    with pytest.raises(ValueError, match="wallet"):
        api.run(store, resume_id=result.discovery_run_id, wallet=addr(99))
    with pytest.raises(ValueError, match="page_size"):
        api.run(store, resume_id=result.discovery_run_id, explicit_options={"page_size": 99})
    with store.connection:
        store.connection.execute("UPDATE discovery_runs SET settings_json=?", (json.dumps({"decoder_version": "future", "page_size": 100, "batch_size": 100}),))
    with pytest.raises(ValueError, match="Decoder"):
        api.run(store, resume_id=result.discovery_run_id)


def test_fresh_runs_keep_snapshots_and_reverify_previously_enrolled_gifts(store):
    api = MockProviders()
    first = api.run(store, wallet=WALLET)
    assert first.state == "complete"
    api.items = []
    second = api.run(store, wallet=WALLET)
    ds = DiscoveryStore(store)
    assert second.state == "complete"
    assert len(ds.ownership_observations()) == 2
    assert ds.ownership_observations()[-1]["reason"] == "item_not_found"
    assert len(store.portfolio()) == 1
    assert sum(r.url.path == COLLECTIONS_PATH for r in api.requests) == 2


def test_repeated_nonempty_page_is_a_failure_not_infinite_scan(store):
    api = MockProviders()
    api.hook = lambda r: httpx.Response(200, json={"nft_items": [item()]}) if r.url.path == NFT_ITEMS_PATH else None
    result = api.run(store, wallet=WALLET)
    assert result.state == "failed"
    assert "start a fresh" in result.reason.lower()
    assert DiscoveryStore(store).checkpoints(result.discovery_run_id)[0]["pages"] == 1


def test_history_collection_conflict_blocks_new_enrollment(store):
    api = MockProviders(transfers=[transfer(nft_collection=addr(99))], collections=[COLLECTION, addr(99)])
    assert api.run(store, wallet=WALLET).state == "complete"
    assert DiscoveryStore(store).ownership_observations()[0]["reason"] == "collection_conflict"
    assert store.portfolio() == []


def test_resume_seeds_prior_members_if_crashed_after_run_creation(store):
    from marketapp_rent.ton_decoder import DECODER_VERSION
    api = MockProviders()
    assert api.run(store, wallet=WALLET).state == "complete"
    ds = DiscoveryStore(store)
    run = ds.create_run(WALLET, {"page_size": 100, "batch_size": 100, "decoder_version": DECODER_VERSION})
    api.items = []
    assert api.run(store, resume_id=run).state == "complete"
    assert ds.candidates(run)[0]["sources"] == ["previously_verified"]
    assert ds.ownership_observations()[-1]["reason"] == "item_not_found"


def test_suspended_wrong_type_is_invalid_response_not_ownership(store):
    api = MockProviders(items=[item(owner=HOLDER)], transfers=[transfer()],
        accounts=[{"address": HOLDER, "status": "active", "suspended": "false"}])
    assert api.run(store, wallet=WALLET).state == "failed"
    assert store.portfolio() == []


def test_aborted_transfer_with_empty_collection_does_not_block_traversal(store):
    api = MockProviders(items=[], transfers=[transfer(nft_collection="", transaction_aborted=True)])
    result = api.run(store, wallet=WALLET)
    assert result.state == "complete"
    assert DiscoveryStore(store).candidates(result.discovery_run_id) == []
    occurrence = store.connection.execute("SELECT source_json FROM discovery_occurrences").fetchone()[0]
    assert json.loads(occurrence)["nft_collection"] == ""


def test_empty_optional_addresses_preserve_distinct_source_values():
    from marketapp_rent.discovery_models import parse_ton, item_collection
    values = [item(), item(nft=addr(22), collection_address=None), item(nft=addr(23), collection_address="", collection={"address": ""})]
    del values[0]["collection_address"]
    parsed = parse_ton(json.dumps({"nft_items": values}).encode(), "nft_items")
    assert "collection_address" not in parsed[0]
    assert parsed[1]["collection_address"] is None
    assert parsed[2]["collection_address"] == ""
    assert all(item_collection(value) == (None, None) for value in parsed)
    for malformed in (" ", "not-an-address"):
        with pytest.raises(ValidationError):
            parse_ton(json.dumps({"nft_items": [item(collection_address=malformed)]}).encode(), "nft_items")
    with pytest.raises(ValidationError):
        parse_ton(json.dumps({"nft_items": [item(nft="")]}).encode(), "nft_items")
