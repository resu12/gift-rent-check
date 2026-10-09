"""No live providers: targeted price refresh, durable pacing and evidence."""
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from marketapp_rent.addresses import canonical_address, preferred_address
from marketapp_rent.owned_prices import OwnedPriceService
from marketapp_rent.ton_decoder import MARKETAPP_OPERATOR


def address(number):
    return f"0:{number:064x}"


WALLET, NFT, COLLECTION, HOLDER = map(address, (1, 2, 3, 4))
FIXTURES = Path(__file__).parent / "fixtures" / "ton"
START = int(datetime(2026, 10, 8, 16, tzinfo=timezone.utc).timestamp() * 1000)


def item(nft=NFT, owner=HOLDER, collection=COLLECTION, **overrides):
    return {"address": nft, "owner_address": owner, "collection_address": collection,
            "init": True, "last_transaction_lt": "10", **overrides}


def decoded(account, nft, wallet, observed_at):
    return {"verified": True, "reason": "verified_rental_owner", "owner": wallet, "nft": nft,
            "holding_contract": canonical_address(account["address"]), "marketplace": MARKETAPP_OPERATOR,
            "configured_price_per_day_raw": "123456789123456789", "rental_state": "rented",
            "code_hash_verified": True, "data_hash_verified": True, "account_last_transaction_lt": "9"}


class Clock:
    def __init__(self):
        self.value = START

    def __call__(self):
        return self.value

    def advance(self, ms=1000):
        self.value += ms


class Harness:
    def __init__(self, path, *, targets=None, wallet=WALLET, limits=None, decoder=decoded, api_key=None):
        self.clock, self.calls = Clock(), []
        self.targets = targets if targets is not None else [{"nft_address": NFT, "collection_address": COLLECTION}]
        self.items, self.accounts = [item()], [{"address": HOLDER, "status": "active", "last_transaction_lt": "9"}]
        self.hook = None
        self.args = dict(wallet=wallet, targets=lambda: self.targets, now=self.clock, limits=limits,
                         decoder=decoder, api_key=api_key, transport=httpx.MockTransport(self.respond))
        self.path = path
        self.service = OwnedPriceService(path, **self.args)

    def respond(self, request):
        self.calls.append(request)
        assert request.method == "GET"
        assert request.url.host == "toncenter.com"
        assert "authorization" not in request.headers
        assert request.url.path in {"/api/v3/nft/items", "/api/v3/accountStates"}
        if self.hook:
            result = self.hook(request)
            if result is not None:
                return result
        key, rows = ("accounts", self.accounts) if request.url.path.endswith("accountStates") else ("nft_items", self.items)
        selected = set(request.url.params.get_list("address"))
        return httpx.Response(200, json={key: [row for row in rows if canonical_address(row["address"]) in selected]})

    def step(self, run_id=1):
        result = self.service.step(run_id)
        self.clock.advance()
        return result

    def finish(self, session="session:abcdefghij"):
        state = self.service.start(session)
        for _ in range(30):
            if state["run"]["state"] != "running":
                return state
            self.clock.value = max(self.clock.value, state["next_allowed_at"])
            state = self.step(state["run"]["id"])
        raise AssertionError("Did not finish bounded run")


def rows(path, table):
    with sqlite3.connect(path) as db:
        return db.execute(f"SELECT * FROM {table}").fetchall()


def test_three_stage_flow_uses_only_known_nfts_and_preserves_exact_prices(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", api_key="private-ton-key")
    state = h.finish()
    assert state["run"]["state"] == "complete"
    assert (state["run"]["checked"], state["run"]["updated"], state["run"]["unresolved"]) == (1, 1, 0)
    assert [dict(call.url.params) for call in h.calls] == [
        {"address": NFT, "limit": "50"}, {"address": HOLDER, "include_boc": "true"}, {"address": NFT, "limit": "50"},
    ]
    assert all(call.headers["X-API-Key"] == "private-ton-key" for call in h.calls)
    observation, = h.service.observations(WALLET)
    assert observation["configured_price_per_day_raw"] == "123456789123456789"
    assert observation["wallet_address"] == WALLET and observation["verified"]
    assert observation["reason"] == "verified_contract_price"
    assert observation["observed_at"] == observation["contract_observed_at"]
    assert observation["observed_at"] < observation["rechecked_at"] == observation["checked_at"]
    assert len(rows(h.path, "owned_price_responses")) == 3
    assert len(rows(h.path, "owned_price_attempts")) == 3


@pytest.mark.parametrize("name", ["7f44-idle", "7f44-rented", "original"])
def test_actual_saved_public_boc_fixtures(tmp_path, name):
    from marketapp_rent.ton_decoder import decode_contract
    if name == "original":
        sample = json.loads((FIXTURES / "verified-samples.json").read_text())["samples"][0]
        wallet = sample["recorded_owner_raw"]
        nft = next(row for row in json.loads((FIXTURES / "sample-nfts.json").read_text())["body"]["nft_items"] if canonical_address(row["address"]) == canonical_address(sample["nft_address"]))
        account = next(row for row in json.loads((FIXTURES / "holder-states.json").read_text())["body"]["accounts"] if canonical_address(row["address"]) == canonical_address(sample["holding_contract"]))
    else:
        sample = json.loads((FIXTURES / f"{name}.json").read_text())
        wallet, nft, account = sample["wallet_address"], sample["nft_before"], sample["account"]
        account["code_boc"] = (FIXTURES / sample["code_fixture"]).read_text().strip()
    h = Harness(tmp_path / "jobs.sqlite", wallet=wallet, decoder=decode_contract,
                targets=[{"nft_address": nft["address"], "collection_address": nft["collection_address"]}])
    h.items, h.accounts = [nft], [account]
    assert h.finish()["run"]["updated"] == 1
    observation, = h.service.observations(wallet)
    assert observation["code_hash_verified"] and observation["data_hash_verified"]
    assert observation["configured_price_per_day_raw"] == decode_contract(account, nft["address"], wallet, observation["observed_at"])["configured_price_per_day_raw"]


def test_scope_aliases_conflicts_no_network_for_invalid_targets(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", targets=[
        {"nft_address": NFT, "collection_address": COLLECTION},
        {"nft_address": preferred_address(NFT), "collection_address": preferred_address(COLLECTION)},
        {"nft_address": address(20), "collection_address": COLLECTION, "is_portfolio": False},
        {"nft_address": address(21), "collection_address": COLLECTION, "collection_conflict": True},
        {"nft_address": address(22), "collection_address": COLLECTION},
        {"nft_address": address(22), "collection_address": address(99)},
        {"nft_address": "legacy-nft", "collection_address": COLLECTION},
        {"nft_address": address(23), "collection_address": None},
    ])
    assert h.finish()["run"]["total"] == 1
    assert all(call.url.params.get_list("address") in ([NFT], [HOLDER]) for call in h.calls)
    empty = Harness(tmp_path / "empty.sqlite", targets=[])
    assert empty.finish()["run"]["reason"] == "no_known_portfolio"
    assert not empty.calls


def test_offline_and_missing_wallet_never_request(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", wallet=None)
    assert h.service.observations(None) == []
    assert h.service.get_status()["run"] is None
    assert h.finish()["run"]["reason"] == "wallet_not_configured"
    assert not h.calls


def test_start_idempotent_other_tabs_join_then_fresh_session_preserves_history(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    first = h.service.start("session:abcdefghij")
    other = OwnedPriceService(h.path, **h.args)
    assert other.start("different:abcdefghij")["run"]["id"] == first["run"]["id"]
    h.finish()
    assert other.start("session:abcdefghij")["run"]["state"] == "complete"
    h.items[0]["owner_address"] = WALLET
    fresh = h.finish("new-session:abcdefghij")
    assert fresh["run"]["id"] == 2
    assert fresh["run"]["unresolved"] == 1
    observations = other.observations(preferred_address(WALLET))
    assert len(observations) == 2
    assert observations[0]["configured_price_per_day_raw"]
    assert observations[1]["reason"] == "held_directly"
    assert "configured_price_per_day_raw" not in observations[1]
    assert other.observations(address(99)) == []


@pytest.mark.parametrize("mutation,reason", [
    ({"last_transaction_lt": "11"}, "nft_changed_during_refresh"),
    ({"owner_address": address(50)}, "nft_changed_during_refresh"),
    ({"owner_address": WALLET}, "held_directly"),
    ({"collection_address": address(99)}, "collection_mismatch"),
    ({"init": False}, "invalid_nft_state"),
])
def test_holder_lt_and_collection_recheck_reject_stale_prices(tmp_path, mutation, reason):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    h.step()
    h.step()
    h.items[0].update(mutation)
    assert h.step()["run"]["unresolved"] == 1
    observation, = h.service.observations(WALLET)
    assert observation["reason"] == reason
    assert "configured_price_per_day_raw" not in observation


@pytest.mark.parametrize("mutation,reason", [
    ({"verified": False, "reason": "unsupported_code_hash"}, "unsupported_code_hash"),
    ({"owner": address(9)}, "owner_mismatch"),
    ({"nft": address(9)}, "nft_mismatch"),
    ({"marketplace": address(9)}, "operator_mismatch"),
    ({"holding_contract": address(9)}, "holder_mismatch"),
    ({"data_hash_verified": False}, "unverified_contract_hashes"),
    ({"configured_price_per_day_raw": "0.1"}, "invalid_configured_price"),
    ({"configured_price_per_day_raw": 100}, "invalid_configured_price"),
    ({"rental_state": "unknown"}, "unsupported_rental_state"),
])
def test_decoder_evidence_requirements(tmp_path, mutation, reason):
    def decoder(*args):
        return {**decoded(*args), **mutation}
    h = Harness(tmp_path / "jobs.sqlite", decoder=decoder)
    assert h.finish()["run"]["unresolved"] == 1
    assert h.service.observations(WALLET)[0]["reason"] == reason


@pytest.mark.parametrize("reply", [
    b"not json", b'{"nft_items":[],"nft_items":[]}', b'{"nft_items":NaN}',
    json.dumps({"nft_items": [item(), item()]}).encode(),
    json.dumps({"nft_items": [item(nft=address(99))]}).encode(),
])
def test_invalid_response_keeps_failed_evidence_and_never_moves_to_accounts(tmp_path, reply):
    h = Harness(tmp_path / "jobs.sqlite")
    h.hook = lambda request: httpx.Response(200, content=reply)
    state = h.finish()
    assert state["run"]["state"] == "failed" and state["run"]["reason"] == "invalid_response"
    assert len(h.calls) == 1
    assert h.service.observations(WALLET)[0]["verified"] is False


def test_missing_nft_and_direct_owner_complete_without_accounts(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", targets=[{"nft_address": NFT, "collection_address": COLLECTION}, {"nft_address": address(5), "collection_address": COLLECTION}])
    h.items = [item(owner=WALLET)]
    assert h.finish()["run"]["unresolved"] == 2
    assert {row["reason"] for row in h.service.observations(WALLET)} == {"held_directly", "nft_missing"}
    assert len(h.calls) == 1


def test_account_missing_still_rechecks_nft_and_does_not_update_price(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.accounts = []
    assert h.finish()["run"]["unresolved"] == 1
    assert h.service.observations(WALLET)[0]["reason"] == "account_missing"
    assert len(h.calls) == 3


def test_pacing_retry_after_persists_across_service_instances(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.hook = lambda request: httpx.Response(429, headers={"Retry-After": "4"}) if len(h.calls) == 1 else None
    h.service.start("session:abcdefghij")
    state = h.service.step(1)
    assert state["run"]["reason"] == "retry_wait"
    assert state["next_allowed_at"] == START + 4000
    other = OwnedPriceService(h.path, **h.args)
    other.step(1)
    assert len(h.calls) == 1
    h.clock.advance(4000)
    other.step(1)
    assert len(h.calls) == 2
    assert len(rows(h.path, "owned_price_attempts")) == 2


@pytest.mark.parametrize("failure", ["network", "429", "503"])
def test_retry_exhaustion_is_bounded_and_redacts_secret(tmp_path, failure):
    h = Harness(tmp_path / "jobs.sqlite", api_key="test-ton-secret")
    def fail(request):
        if failure == "network":
            raise httpx.ConnectError("test-ton-secret", request=request)
        return httpx.Response(int(failure), content=b"test-ton-secret")
    h.hook = fail
    assert h.finish()["run"]["reason"] == "retry_exhausted"
    assert len(h.calls) == 3
    assert b"test-ton-secret" not in Path(h.path).read_bytes()


@pytest.mark.parametrize("header,reason", [("300", "duration_limit"), ("nonsense", "invalid_retry_after")])
def test_retry_after_beyond_budget_or_invalid(tmp_path, header, reason):
    h = Harness(tmp_path / "jobs.sqlite")
    h.hook = lambda request: httpx.Response(429, headers={"Retry-After": header})
    assert h.finish()["run"]["reason"] == reason
    assert len(h.calls) == 1


@pytest.mark.parametrize("limits,reason", [({"invocation_attempts": 1}, "invocation_limit"), ({"daily_attempts": 1}, "daily_limit"), ({"duration_ms": 1000}, "duration_limit")])
def test_independent_attempt_and_time_caps(tmp_path, limits, reason):
    h = Harness(tmp_path / "jobs.sqlite", limits=limits)
    assert h.finish()["run"]["reason"] == reason
    assert len(h.calls) == 1
    assert not h.service.observations(WALLET)
    if reason == "daily_limit":
        assert h.finish("fresh:abcdefghijk")["run"]["reason"] == "daily_limit"
        assert len(h.calls) == 1
        h.clock.advance(86400001)
        h.items[0]["owner_address"] = WALLET
        assert h.finish("after-day:abcdefg")["run"]["state"] == "complete"


def test_stop_fences_inflight_response_and_other_tabs_cannot_duplicate_request(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    entered, release = threading.Event(), threading.Event()
    def wait(request):
        entered.set()
        assert release.wait(10)
        return None
    h.hook = wait
    other = OwnedPriceService(h.path, **h.args)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(h.service.step, 1)
        assert entered.wait(10)
        assert other.step(1)["run"]["checked"] == 0
        assert other.stop(1)["run"]["reason"] == "stopped_by_you"
        # A fresh page joins the stopped run while its provider lease is live.
        assert other.start("another:abcdefgh")["run"]["id"] == 1
        release.set()
        assert future.result()["run"]["reason"] == "stopped_by_you"
    assert len(h.calls) == 1
    assert not h.service.observations(WALLET)
    assert len(rows(h.path, "owned_price_responses")) == 1
    h.clock.advance()
    assert other.start("after-stop:abcdef")["run"]["id"] == 2


def test_expired_request_lease_cannot_commit(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", limits={"timeout_ms": 1000, "lease_ms": 2000})
    h.hook = lambda request: h.clock.advance(2001)
    assert h.finish()["run"]["reason"] == "request_lease_expired"
    assert not h.service.observations(WALLET)


def test_no_http_after_reservation_deadline_passes(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    calls = 0
    def late_clock():
        nonlocal calls
        calls += 1
        return START if calls <= 2 else START + 120001
    h.service.clock = late_clock
    assert h.service.step(1)["run"]["reason"] == "request_lease_expired"
    assert not h.calls
    assert len(rows(h.path, "owned_price_attempts")) == 1


def test_drip_response_stops_on_elapsed_timeout_and_closes_stream(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", limits={"retry_attempts": 1})
    class Drip(httpx.SyncByteStream):
        chunks = 0
        closed = False
        def __iter__(self):
            for _ in range(100):
                self.chunks += 1
                h.clock.advance(5000)
                yield b" "
        def close(self):
            self.closed = True
    drip = Drip()
    h.hook = lambda request: httpx.Response(200, stream=drip)
    assert h.finish()["run"]["reason"] == "retry_exhausted"
    assert drip.chunks == 4 and drip.closed
    assert not h.service.observations(WALLET)[0]["verified"]


def test_crash_after_reservation_consumes_attempt_and_lease_survives_restart(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    def crash(request):
        raise KeyboardInterrupt()
    h.hook = crash
    with pytest.raises(KeyboardInterrupt):
        h.service.step(1)
    other = OwnedPriceService(h.path, **h.args)
    assert other.start("new-tab:abcdefgh")["run"]["id"] == 1
    other.step(1)
    assert len(h.calls) == 1
    assert len(rows(h.path, "owned_price_attempts")) == 1
    h.clock.advance(120001)
    assert other.get_status()["run"]["reason"] == "duration_limit"


def test_does_not_touch_other_tables_or_allow_wallet_switch(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    with sqlite3.connect(h.path) as db:
        db.execute("CREATE TABLE portfolio(sentinel TEXT)")
        db.execute("INSERT INTO portfolio VALUES('untouched')")
    h.service.start("session:abcdefghij")
    other = OwnedPriceService(h.path, **{**h.args, "wallet": address(99)})
    with pytest.raises(ValueError, match="different wallet"):
        other.start("other-wallet:abcdef")
    with pytest.raises(ValueError, match="Unknown"):
        other.step(1)
    h.finish()
    assert rows(h.path, "portfolio") == [("untouched",)]


@pytest.mark.parametrize("kwargs", [{"wallet": "invalid"}, {"api_key": "x\ny"}, {"limits": {"interval_ms": 1}}, {"limits": {"retry_attempts": 99}}, {"limits": {"invocation_attempts": True}}])
def test_invalid_configuration_rejected(tmp_path, kwargs):
    with pytest.raises(ValueError):
        OwnedPriceService(tmp_path / "jobs.sqlite", **{"wallet": WALLET, "targets": lambda: [], **kwargs})


@pytest.mark.parametrize("status,reason", [(301, "unexpected_redirect"), (401, "http_error"), (403, "http_error")])
def test_auth_and_redirect_failures_never_retried(tmp_path, status, reason):
    h = Harness(tmp_path / "jobs.sqlite")
    h.hook = lambda request: httpx.Response(status, headers={"Location": "https://example.com/"})
    assert h.finish()["run"]["reason"] == reason
    assert len(h.calls) == 1


def test_batch_limit_and_overlapping_holders(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", limits={"batch_size": 2}, targets=[{"nft_address": address(n), "collection_address": COLLECTION} for n in (2, 5, 6)])
    h.items = [item(nft=address(n)) for n in (2, 5, 6)]
    assert h.finish()["run"]["updated"] == 3
    assert len(h.calls) == 6
    assert h.calls[0].url.params.get_list("address") == [NFT, address(5)]
    assert h.calls[1].url.params.get_list("address") == [HOLDER]
    assert h.calls[3].url.params.get_list("address") == [address(6)]


@pytest.mark.parametrize("kind,state,blocked", [("discover", "queued", True), ("refresh", "running", True), ("prices", "running", False), ("discover", "partial", False)])
def test_manual_ton_jobs_share_atomic_provider_exclusion(tmp_path, kind, state, blocked):
    h = Harness(tmp_path / "jobs.sqlite")
    with sqlite3.connect(h.path) as db:
        db.execute("CREATE TABLE dashboard_jobs(kind TEXT,state TEXT)")
        db.execute("INSERT INTO dashboard_jobs VALUES(?,?)", (kind, state))
    result = h.finish()
    if blocked:
        assert result["run"]["reason"] == "ownership_refresh_active"
        assert not h.calls and not rows(h.path, "owned_price_attempts")
    else:
        assert result["run"]["state"] == "complete"


def test_failed_atomic_observation_commit_retains_previous_checkpoint(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    h.step()
    h.step()
    with sqlite3.connect(h.path) as db:
        db.execute("CREATE TRIGGER fail_observation BEFORE INSERT ON owned_price_observations BEGIN SELECT RAISE(ABORT,'test crash'); END")
    with pytest.raises(sqlite3.IntegrityError, match="test crash"):
        h.service.step(1)
    assert len(rows(h.path, "owned_price_responses")) == 2
    assert not h.service.observations(WALLET)
    saved = json.loads(rows(h.path, "owned_price_runs")[0][2])
    assert saved["stage"] == "after" and saved["lease"] is not None and saved["checked"] == 0


def test_completed_stage_can_continue_in_new_process_service(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    h.step()
    h.service = OwnedPriceService(h.path, **h.args)
    assert h.finish()["run"]["updated"] == 1
    assert len(h.calls) == 3


def test_oversized_response_is_retained_without_body_and_rejected(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite", limits={"response_bytes": 8})
    assert h.finish()["run"]["reason"] == "response_too_large"
    raw = json.loads(rows(h.path, "owned_price_responses")[0][4])
    assert raw["truncated"] and raw["body"] is None


def test_shared_provider_cooldown_persisted_and_never_shortened(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    floor = START + 5000
    h.service.cooldown = lambda: floor
    state = h.service.start("session:abcdefghij")
    assert state["next_allowed_at"] == floor
    h.service.step(1)
    assert not h.calls
    # A new process still honors the old deadline even when its callback has
    # no newer discovery response to contribute.
    other = OwnedPriceService(h.path, **h.args, cooldown=lambda: START + 1000)
    other.step(1)
    assert other.get_status()["next_allowed_at"] == floor
    assert not h.calls
    h.clock.advance(5000)
    other.step(1)
    assert len(h.calls) == 1


def test_shared_cooldown_beyond_run_budget_stops_without_request(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.cooldown = lambda: START + 300000
    state = h.service.start("session:abcdefghij")
    assert state["run"]["reason"] == "duration_limit"
    assert state["next_allowed_at"] == START + 300000
    assert not h.calls and not rows(h.path, "owned_price_attempts")


def test_new_shared_cooldown_after_start_is_checked_before_reservation(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.cooldown = lambda: 0
    h.service.start("session:abcdefghij")
    h.service.cooldown = lambda: START + 4000
    assert h.service.step(1)["next_allowed_at"] == START + 4000
    assert not h.calls and not rows(h.path, "owned_price_attempts")


def test_slow_cooldown_read_reserves_pacing_from_actual_send_time(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.start("session:abcdefghij")
    def cooldown():
        h.clock.advance(5000)
        return 0
    h.service.cooldown = cooldown
    h.service.step(1)
    assert rows(h.path, "owned_price_attempts")[0][2] == START + 5000


def test_dashboard_cooldown_missing_database_is_not_created(tmp_path):
    from marketapp_rent.dashboard import _ton_price_cooldown
    path = tmp_path / "does-not-exist.sqlite"
    with pytest.raises(sqlite3.OperationalError):
        _ton_price_cooldown(path)
    assert not path.exists()


@pytest.mark.parametrize("value", [None, "bad", -1, True, 2 ** 63])
def test_invalid_shared_cooldown_fails_closed(tmp_path, value):
    h = Harness(tmp_path / "jobs.sqlite")
    h.service.cooldown = lambda: value
    assert h.service.start("session:abcdefghij")["run"]["reason"] == "provider_cooldown_unavailable"
    assert not h.calls


def test_failed_shared_cooldown_read_fails_closed(tmp_path):
    h = Harness(tmp_path / "jobs.sqlite")
    def unavailable():
        raise sqlite3.OperationalError("private path details")
    h.service.cooldown = unavailable
    state = h.service.start("session:abcdefghij")
    assert state["run"]["reason"] == "provider_cooldown_unavailable"
    assert "private path" not in json.dumps(state)
    assert not h.calls


def test_dashboard_cooldown_reads_ton_only_and_preserves_main_db(tmp_path):
    from marketapp_rent.dashboard import _ton_price_cooldown
    from marketapp_rent.storage import Store
    path = tmp_path / "main.sqlite"
    with Store(path) as store:
        db = store.connection
        db.execute("INSERT INTO discovery_runs(id,wallet_address,settings_json,created_at) VALUES(1,?,'{}',?)", (WALLET, "2026-10-08T16:00:00+00:00"))
        db.executemany("INSERT INTO discovery_responses(run_id,provider,purpose,path,params_json,observed_at,retry_after_at) VALUES(1,?,'attempt','/api/v3/nft/items','{}',?,?)", [
            ("toncenter", "2026-10-08T16:00:00.000000+00:00", "2026-10-08T16:00:03.000000+00:00"),
            ("marketapp", "2026-10-08T20:00:00.000000+00:00", "2026-10-08T20:00:03.000000+00:00"),
        ])
        db.commit()
    before = path.read_bytes()
    assert _ton_price_cooldown(path) == START + 3000
    assert path.read_bytes() == before
    with Store(path) as store:
        store.connection.execute("UPDATE discovery_responses SET retry_after_at=NULL WHERE provider='toncenter'")
        store.connection.commit()
    assert _ton_price_cooldown(path) == START + 1000


@pytest.mark.parametrize("timestamp", ["not a date", "2026-10-08T16:00:00", ""])
def test_dashboard_malformed_saved_cooldown_is_rejected(tmp_path, timestamp):
    from marketapp_rent.dashboard import _ton_price_cooldown
    from marketapp_rent.storage import Store
    path = tmp_path / "main.sqlite"
    with Store(path) as store:
        db = store.connection
        db.execute("INSERT INTO discovery_runs(id,wallet_address,settings_json,created_at) VALUES(1,?,'{}',?)", (WALLET, "2026-10-08T16:00:00+00:00"))
        db.execute("INSERT INTO discovery_responses(run_id,provider,purpose,path,params_json,observed_at,retry_after_at) VALUES(1,'toncenter','attempt','/api/v3/nft/items','{}',?,?)", ("2026-10-08T16:00:00+00:00", timestamp))
        db.commit()
    with pytest.raises(ValueError):
        _ton_price_cooldown(path)
