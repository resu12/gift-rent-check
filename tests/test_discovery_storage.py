import json
import sqlite3

import pytest
from pytoniq_core import Address

from marketapp_rent.addresses import address_key, preferred_address
from marketapp_rent.collector import select_scopes
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage, ValidationError
from marketapp_rent.storage import Store, _SCHEMA
from marketapp_rent.util import canonical_json

WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
NFT2 = "0:" + "33" * 32
COLLECTION = "0:" + "44" * 32
OTHER_COLLECTION = "0:" + "55" * 32
OBSERVED = "2026-10-08T12:00:00+00:00"


def response(body=b"{}", **extra):
    return {"body": body, "status_code": 200, "observed_at": OBSERVED, **extra}


def ready(store, nft=NFT):
    discovery = DiscoveryStore(store)
    run = discovery.create_run(WALLET, {"page_size": 100, "decoder_version": "test"})
    discovery.save_catalog(run, response(b"catalog"), [COLLECTION])
    discovery.add_candidates(run, [{"nft_address": nft, "source": "holdings", "collection_address": COLLECTION}])
    return discovery, run


def verified(nft=NFT, **changes):
    return {"nft_address": nft, "wallet_address": WALLET, "collection_address": COLLECTION,
            "verified": True, "reason": "direct_owner", "rental_state": "held_directly",
            "observed_at": OBSERVED, **changes}


def test_populated_v1_migration_preserves_market_bytes_and_opaque_membership(tmp_path):
    path = tmp_path / "v1.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript(_SCHEMA)
    connection.execute("INSERT INTO portfolio VALUES ('opaque-NFT','opaque-collection','old label','then','then')")
    connection.execute("INSERT INTO records VALUES (1,'history','opaque-NFT','fingerprint','{\"price\":1.00}','{\"price\":\"1.00\"}')")
    connection.execute("INSERT INTO runs VALUES (1,'{}','[]','[]','partial','then',NULL,NULL)")
    connection.execute("INSERT INTO streams VALUES (1,1,'history','/v1/rent/gifts/history/','{}','pending',1,'opaque-cursor',NULL,'then')")
    connection.execute("INSERT INTO pages VALUES (1,1,NULL,'head','opaque-cursor','then',200,?, 'raw-digest')", (b"  raw body \x00",))
    before = {table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in ("portfolio", "records", "runs", "streams", "pages")}
    connection.commit()
    connection.close()
    with Store(path) as store:
        assert store.connection.execute("PRAGMA user_version").fetchone()[0] == 2
        for table, rows in before.items():
            assert [tuple(row) for row in store.connection.execute(f"SELECT * FROM {table}")] == rows
        assert store.portfolio()[0]["nft_address"] == "opaque-NFT"
        assert store.streams(1)[0]["next_cursor"] == "opaque-cursor"
        discovery, run = ready(store)
        discovery.finish_run(run, "complete")
        assert store.runs()[-1]["state"] == "partial"


def test_migration_failure_rolls_back_all_schema_changes(tmp_path, monkeypatch):
    import marketapp_rent.discovery_store as module
    path = tmp_path / "v1.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript(_SCHEMA)
    connection.close()
    monkeypatch.setattr(module, "SCHEMA_V2", module.SCHEMA_V2 + "\nINVALID SQL;")
    with pytest.raises(sqlite3.OperationalError):
        Store(path)
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
        assert "source_nft_address" not in [row[1] for row in connection.execute("PRAGMA table_info(portfolio_evidence)")]
        assert not connection.execute("SELECT 1 FROM sqlite_master WHERE name='discovery_runs'").fetchone()


def test_enumeration_commit_replay_resume_and_empty_page(tmp_path):
    path = tmp_path / "discovery.sqlite3"
    with Store(path) as store:
        discovery, run = ready(store)
        page = [{"nft_address": NFT, "transaction_lt": "9999999999999999999"},
                {"nft_address": NFT2, "transaction_lt": "9999999999999999998"}]
        candidates = [{"nft_address": row["nft_address"], "source": "transfers"} for row in page]
        params, next_params = {"offset": 0}, {"offset": 1, "end_lt": "9999999999999999998"}
        assert discovery.commit_enumeration(run, "transfers", params, response(b"first"), page, candidates, next_params)
        assert not discovery.commit_enumeration(run, "transfers", params, response(b"first"), page, candidates, next_params)
        with pytest.raises(ValidationError, match="different content"):
            discovery.commit_enumeration(run, "transfers", params, response(b"changed"), page, candidates, next_params)
        assert store.connection.execute("SELECT COUNT(*) FROM discovery_occurrences").fetchone()[0] == 2
    with Store(path) as store:
        discovery = DiscoveryStore(store)
        checkpoint = discovery.checkpoints(run)[1]
        assert checkpoint["params"] == next_params
        assert checkpoint["upper_lt"] == "9999999999999999999"
        assert discovery.commit_enumeration(run, "transfers", next_params, response(b"empty"), [], [], None)
        assert discovery.checkpoints(run)[1]["state"] == "complete"
        assert len(discovery.pending(run, 100)) == 2


def test_stalled_page_detection_ignores_outer_metadata_and_preserves_checkpoint():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        items = [{"address": NFT}, {"address": NFT2}]
        discovery.commit_enumeration(run, "holdings", {"offset": 0}, response(b"first metadata"), items, [], {"offset": 2})
        with pytest.raises(ValidationError, match="without progress"):
            discovery.commit_enumeration(run, "holdings", {"offset": 2}, response(b"new metadata"), items, [], {"offset": 4})
        assert discovery.checkpoints(run)[0]["pages"] == 1
        assert discovery.checkpoints(run)[0]["params"] == {"offset": 2}
        # Overlapping pages with a new item are valid and preserve all occurrences.
        discovery.commit_enumeration(run, "holdings", {"offset": 2}, response(b"overlap"), items[1:], [], {"offset": 3})
        assert store.connection.execute("SELECT COUNT(*) FROM discovery_occurrences").fetchone()[0] == 3


def test_invalid_candidate_rolls_back_page_raw_and_checkpoint():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        before = store.connection.execute("SELECT COUNT(*) FROM discovery_responses").fetchone()[0]
        with pytest.raises(ValueError):
            discovery.commit_enumeration(run, "holdings", {}, response(b"invalid"), [{}],
                                        [{"nft_address": "bad", "source": "holdings"}], {"offset": 1})
        assert store.connection.execute("SELECT COUNT(*) FROM discovery_responses").fetchone()[0] == before
        assert store.connection.execute("SELECT COUNT(*) FROM discovery_pages").fetchone()[0] == 0
        assert discovery.checkpoints(run)[0]["pages"] == 0


def test_catalog_is_canonical_fixed_and_raw_body_retained():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        discovery.save_catalog(run, response(b"catalog"), [preferred_address(COLLECTION)])
        assert discovery.get_run(run)["catalog"] == [COLLECTION]
        with pytest.raises(ValueError, match="already committed"):
            discovery.save_catalog(run, response(b"replacement"), [OTHER_COLLECTION])
        assert store.connection.execute("SELECT body FROM discovery_responses WHERE purpose='catalog'").fetchone()[0] == b"catalog"


def test_failed_attempts_retained_and_throttles_are_provider_specific():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        market_run = store.create_run({}, [], [])
        ton_deadline, market_deadline = "2026-10-10T00:00:00+00:00", "2026-10-09T00:00:00+00:00"
        discovery.record_attempt(run, "toncenter", response(b"not JSON", retry_after_at=ton_deadline))
        assert store.retry_not_before() is None
        discovery.record_attempt(run, "marketapp", response(b"limited", retry_after_at=market_deadline))
        assert store.retry_not_before() == market_deadline
        assert discovery.retry_not_before("toncenter") == ton_deadline
        store.record_attempt(market_run, response(retry_after_at=ton_deadline, path="/v1/collections/gifts/"))
        assert discovery.retry_not_before("marketapp") == ton_deadline
        assert discovery.checkpoints(run)[0]["pages"] == 0


def test_verification_commit_atomic_idempotent_and_new_runs_keep_snapshots():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        store.connection.execute("CREATE TRIGGER reject_enrollment BEFORE INSERT ON ton_memberships BEGIN SELECT RAISE(ABORT,'simulated crash'); END")
        with pytest.raises(sqlite3.IntegrityError, match="simulated crash"):
            discovery.commit_verification(run, NFT, verified(), [response(path="/api/v3/nft/items")])
        assert discovery.ownership_observations() == []
        assert discovery.pending(run, 100)
        assert not store.connection.execute("SELECT 1 FROM discovery_responses WHERE purpose='verification'").fetchone()
        store.connection.execute("DROP TRIGGER reject_enrollment")
        discovery.commit_verification(run, NFT, verified(), [response(path="/api/v3/nft/items")])
        discovery.commit_verification(run, preferred_address(NFT), verified(), [response(path="/api/v3/nft/items")])
        assert len(discovery.ownership_observations()) == 1
        assert not discovery.pending(run, 100)
        discovery2, run2 = ready(store)
        discovery2.commit_verification(run2, NFT, verified(verified=False, reason="owner_mismatch"), [])
        assert len(discovery.ownership_observations()) == 2
        assert len(discovery.memberships(WALLET)) == 1
        assert len(store.portfolio()) == 1
        assert store.portfolio()[0]["declared_at"] is None
        assert store.portfolio()[0]["membership_sources"] == ["ton_verified"]
        assert store.connection.execute("SELECT COUNT(*) FROM portfolio").fetchone()[0] == 0


def test_shared_batch_verification_response_is_stored_once_and_linked_twice():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        discovery.add_candidates(run, [{"nft_address": NFT2, "source": "holdings"}])
        batch = response(body=b"large batched body", path="/api/v3/nft/items", params={"address": [NFT, NFT2]})
        discovery.commit_verification(run, NFT, verified(), [batch])
        discovery.commit_verification(run, NFT2, verified(NFT2), [batch])
        assert store.connection.execute("SELECT COUNT(*) FROM discovery_responses WHERE purpose='verification'").fetchone()[0] == 1
        assert store.connection.execute("SELECT COUNT(*) FROM ownership_response_links").fetchone()[0] == 2


@pytest.mark.parametrize("change", [{"wallet_address": NFT2}, {"nft_address": NFT2}, {"collection_address": OTHER_COLLECTION}])
def test_wrong_wallet_nft_or_ineligible_collection_cannot_enroll(change):
    with Store(":memory:") as store:
        discovery, run = ready(store)
        with pytest.raises(ValueError):
            discovery.commit_verification(run, NFT, verified(**change), [])
        assert not discovery.memberships()
        assert discovery.pending(run, 10)


def test_alias_imports_canonical_membership_preserve_label_and_conflicting_ton_evidence(tmp_path):
    with Store(":memory:") as store:
        path = tmp_path / "portfolio.csv"
        friendly = Address(NFT).to_str(is_bounceable=False)
        path.write_text(f"nft_address,collection_address,label\n{NFT},{COLLECTION},My label\n{friendly},{preferred_address(COLLECTION)},My label\n")
        assert store.import_portfolio(path)["inserted"] == 1
        assert store.import_portfolio(path)["unchanged"] == 1
        evidence = store.connection.execute("SELECT source_nft_address FROM portfolio_evidence").fetchall()
        assert {row[0] for row in evidence} == {NFT, friendly}
        discovery = DiscoveryStore(store)
        run = discovery.create_run(WALLET, {})
        discovery.save_catalog(run, response(), [OTHER_COLLECTION])
        discovery.add_candidates(run, [{"nft_address": friendly, "source": "holdings"}])
        discovery.commit_verification(run, NFT, verified(collection_address=OTHER_COLLECTION, label="Remote label"), [])
        member = store.portfolio()[0]
        assert member["label"] == "My label"
        assert set(member["address_aliases"]) == {NFT, friendly}
        assert member["collection_address"] is None
        assert member["collection_conflict"] is True
        assert set(member["membership_sources"]) == {"user_declared", "ton_verified"}
        evidence = store.collection_evidence(friendly)
        assert evidence["collection_conflict"] is True
        assert evidence["collection_evidence"]["ton_verified"] == [OTHER_COLLECTION]


def test_canonical_history_and_scope_matching_preserve_raw_record_fingerprint(tmp_path):
    with Store(":memory:") as store:
        path = tmp_path / "portfolio.csv"
        path.write_text(f"nft_address,collection_address\n{NFT},{COLLECTION}\n")
        store.import_portfolio(path)
        market_run = store.create_run({}, [], [])
        stream = store.add_stream(market_run, "history", "/v1/rent/gifts/history/", {})
        data = {"nft_address": preferred_address(NFT), "collection_address": preferred_address(COLLECTION)}
        item = NormalizedRecord("history", data["nft_address"], canonical_json(data), data)
        store.commit_page(stream, None, ApiResponse(b"original bytes", 200, OBSERVED), ParsedPage([item], None))
        record = store.records()[0]
        evidence = store.collection_evidence(NFT, preferred_address(COLLECTION))
        assert not evidence["collection_conflict"]
        assert evidence["collection_evidence"]["observed_history"] == [preferred_address(COLLECTION)]
        assert store.records()[0] == record
        assert select_scopes(store, 3, [COLLECTION, preferred_address(COLLECTION)])[0] == [preferred_address(COLLECTION)]


def test_candidate_aliases_priority_and_source_variants_are_preserved():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        discovery.add_candidates(run, [{"nft_address": preferred_address(NFT), "source": "previously_verified", "priority": 0},
                                       {"nft_address": NFT2, "source": "transfers", "priority": 10}])
        candidates = discovery.pending(run, 10)
        assert len(candidates) == 2
        assert candidates[0]["nft_address"] == NFT
        assert candidates[0]["priority"] == 0
        assert candidates[0]["sources"] == ["holdings", "previously_verified"]


def test_initial_collection_conflicts_are_unresolved_and_aliases_are_not_conflicts():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        discovery.add_candidates(run, [{"nft_address": preferred_address(NFT), "source": "transfer",
                                        "collection_address": preferred_address(COLLECTION)}])
        assert discovery.pending(run, 1)[0]["collection_conflict"] is False
        discovery.add_candidates(run, [{"nft_address": NFT, "source": "transfer",
                                        "collection_address": OTHER_COLLECTION}])
        candidate = discovery.pending(run, 1)[0]
        assert candidate["collection_conflict"] is True
        assert candidate["collection_addresses"] == [COLLECTION, OTHER_COLLECTION]
        with pytest.raises(ValidationError, match="Conflicting collection"):
            discovery.commit_verification(run, NFT, verified(), [])
        discovery.commit_verification(run, NFT, verified(verified=False, reason="collection_conflict"), [])
        assert discovery.memberships() == []
        assert discovery.candidates(run)[0]["verified"] is False


def test_late_collection_conflict_retains_observation_and_membership_but_removes_scope():
    with Store(":memory:") as store:
        discovery, run = ready(store)
        discovery.commit_verification(run, NFT, verified(), [])
        observation = discovery.ownership_observations()[0]
        membership = discovery.memberships()[0]
        discovery.add_candidates(run, [{"nft_address": NFT, "source": "transfer",
                                        "collection_address": preferred_address(COLLECTION)}])
        assert discovery.candidates(run)[0]["verified"] is True
        discovery.commit_enumeration(run, "transfers", {}, response(b"late page"), [{"nft_address": NFT}],
                                     [{"nft_address": NFT, "source": "transfer", "collection_address": OTHER_COLLECTION}], None)
        candidate = discovery.candidates(run)[0]
        assert candidate["state"] == "done"
        assert candidate["verified"] is False
        assert candidate["reason"] == "collection_conflict"
        assert candidate["collection_conflict"] is True
        assert discovery.ownership_observations()[0] == observation
        assert discovery.memberships()[0] == membership
        # Replaying the original verification must not erase subsequently learned conflict.
        discovery.commit_verification(run, NFT, verified(), [])
        assert discovery.candidates(run)[0]["verified"] is False
        member = store.portfolio()[0]
        assert member["collection_address"] is None
        assert member["collection_conflict"] is True
        assert select_scopes(store, 3, None) == ([None], [])
        evidence = store.collection_evidence(preferred_address(NFT))
        assert evidence["collection_address"] is None
        assert evidence["collection_evidence"]["ton_observed"] == [COLLECTION]
        assert OTHER_COLLECTION in evidence["collection_evidence"]["ton_candidate_sources"]


def test_new_run_candidate_compares_source_collection_to_latest_ownership():
    with Store(":memory:") as store:
        discovery, first = ready(store)
        discovery.commit_verification(first, NFT, verified(), [])
        second = discovery.create_run(WALLET, {})
        discovery.add_candidates(second, [{"nft_address": NFT, "source": "holdings", "collection_address": OTHER_COLLECTION}])
        assert discovery.pending(second, 1)[0]["collection_conflict"] is True
        assert discovery.pending(second, 1)[0]["collection_addresses"] == [COLLECTION, OTHER_COLLECTION]
