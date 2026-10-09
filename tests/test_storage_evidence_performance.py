"""Page-local provenance work scales with history once, without stale evidence."""
from collections import Counter
import sqlite3

import pytest
from pytoniq_core import Address

import marketapp_rent.storage as storage_module
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.storage import Store
from marketapp_rent.util import canonical_json


OBSERVED = "2026-10-09T14:00:00Z"


def address(number):
    return "0:" + f"{number:064x}"


def friendly(value, bounceable=True):
    return Address(value).to_str(is_bounceable=bounceable)


def record(kind, nft, **data):
    payload = {"nft_address": nft, **data}
    return NormalizedRecord(kind, nft, canonical_json(payload), payload)


def stream(store, kind="listing", scope=None):
    run = store.create_run({}, [], [])
    return store.add_stream(run, kind, "/v1/rent/gifts/", {"collection_address": scope} if scope else {})


def page(store, stream_id, records, cursor=None, next_cursor=None, body=b"page"):
    return store.commit_page(stream_id, cursor, ApiResponse(body, 200, OBSERVED), ParsedPage(records, next_cursor))


def portfolio_row(store, nft, collection):
    store.connection.execute("INSERT INTO portfolio VALUES (?,?,?,?,?)", (nft, collection, None, OBSERVED, OBSERVED))


def ton_evidence(store, nft, *, member, observed, candidate):
    wallet = address(9999)
    run = DiscoveryStore(store).create_run(wallet, {})
    with store.connection:
        store.connection.execute(
            "INSERT INTO discovery_candidates(run_id,nft_key,nft_address,priority,created_at,updated_at) VALUES (?,?,?,?,?,?)",
            (run, nft, friendly(nft), 0, OBSERVED, OBSERVED),
        )
        store.connection.execute(
            "INSERT INTO discovery_candidate_sources VALUES (?,?,?,?)",
            (run, nft, "fixture", canonical_json({"collection_address": candidate})),
        )
        observation = store.connection.execute(
            "INSERT INTO ownership_observations(run_id,nft_key,wallet_address,verified,observed_at,evidence_json) VALUES (?,?,?,?,?,?)",
            (run, nft, wallet, 1, OBSERVED, canonical_json({"collection_address": observed})),
        ).lastrowid
        store.connection.execute(
            "INSERT INTO ton_memberships VALUES (?,?,?,?,?,?,?,?)",
            (nft, wallet, nft, member, None, OBSERVED, OBSERVED, observation),
        )


def test_one_history_and_portfolio_scan_per_hundred_listing_page(tmp_path, monkeypatch):
    with Store(tmp_path / "performance.sqlite3") as store:
        unrelated = [f"unrelated-history-only-{i}" for i in range(300)]
        targets = [address(i + 1) for i in range(100)]
        page(store, stream(store, "history"),
             [record("history", nft, collection_address="OTHER") for nft in unrelated]
             + [record("history", friendly(nft, False), collection_address="COLLECTION") for nft in targets])
        with store.connection:
            for nft in targets:
                portfolio_row(store, nft, "COLLECTION")
        sql = []
        calls = Counter()
        original = storage_module.address_key
        def counting_key(value):
            calls[value] += 1
            return original(value)
        monkeypatch.setattr(storage_module, "address_key", counting_key)
        store.connection.set_trace_callback(sql.append)
        page(store, stream(store), [record("listing", friendly(nft), price="0.170") for nft in targets])
        store.connection.set_trace_callback(None)
        selects = [statement.lower() for statement in sql if statement.lower().startswith("select")]
        assert sum("select identity,data_json from records where kind='history'" in statement for statement in selects) == 1
        assert sum(" from portfolio" in statement for statement in selects) == 1
        for table in ("ton_memberships", "ownership_observations", "discovery_candidate_sources"):
            assert sum(f" from {table} " in statement for statement in selects) == 1
        assert all(calls[nft] == 1 for nft in unrelated)
        assert sum(calls.values()) < 400 + 100 * 8
        assert len(store.observations("listing")) == 100
        assert all(row["collection_address"] == "COLLECTION" for row in store.observations("listing"))


def test_batch_and_standalone_preserve_all_aliases_sources_and_conflicts(tmp_path):
    nft, collection, conflicting = address(1), address(2), address(3)
    with Store(tmp_path / "aliases.sqlite3") as store:
        with store.connection:
            portfolio_row(store, nft, collection)
            portfolio_row(store, friendly(nft, False), friendly(collection))
        ton_evidence(store, nft, member=collection, observed=friendly(collection), candidate=conflicting)
        page(store, stream(store, "history"), [
            record("history", nft, collection_address=collection),
            record("history", friendly(nft), collection_address=friendly(conflicting)),
        ])
        historical = store.records("history")
        scope = friendly(collection, False)
        expected = store.collection_evidence(friendly(nft, False), scope)
        assert expected["collection_evidence"] == {
            "filtered_request": scope,
            "portfolio_import": sorted([collection, friendly(collection)]),
            "ton_verified": [collection], "ton_observed": [friendly(collection)],
            "ton_candidate_sources": [conflicting],
            "observed_history": sorted([collection, friendly(conflicting)]),
        }
        assert expected["collection_address"] is None
        assert expected["collection_conflict"] is True
        assert expected["collection_source"] == "filtered_request+portfolio_import+ton_verified+ton_observed+ton_candidate_sources+observed_history"
        page(store, stream(store, scope=scope), [record("listing", nft), record("listing", friendly(nft, False))])
        for observation in store.observations("listing"):
            for field in expected:
                assert observation[field] == expected[field]
        assert store.records("history") == historical


def test_aliases_of_one_collection_are_not_conflicts_and_opaque_identifiers_remain_exact(tmp_path):
    nft, collection = address(10), address(20)
    with Store(tmp_path / "exact.sqlite3") as store:
        page(store, stream(store, "history"), [
            record("history", friendly(nft), collection_address=collection),
            record("history", nft, collection_address=friendly(collection)),
            record("history", "Opaque Gift", collection_address="Opaque Collection"),
        ])
        page(store, stream(store, scope=friendly(collection, False)), [record("listing", friendly(nft, False))])
        observation = store.observations("listing")[0]
        assert observation["collection_conflict"] == 0
        assert observation["collection_address"] == friendly(collection, False)
        assert observation["collection_evidence"]["observed_history"] == sorted([collection, friendly(collection)])
        page(store, stream(store), [record("listing", "Opaque Gift"), record("listing", "opaque gift")])
        rows = store.observations("listing")[-2:]
        assert rows[0]["collection_address"] == "Opaque Collection"
        assert rows[1]["collection_address"] is None
        assert rows[1]["collection_source"] == "unknown"


def test_later_pages_and_external_commits_refresh_evidence_without_rewriting_old_snapshots(tmp_path):
    database = tmp_path / "fresh.sqlite3"
    nft = address(1)
    with Store(database) as store:
        listing = stream(store)
        page(store, listing, [record("listing", nft)], next_cursor="next", body=b"first listing")
        old = store.observations("listing")[0]
        assert old["collection_source"] == "unknown"
        with Store(database) as external:
            page(external, stream(external, "history"), [record("history", friendly(nft), collection_address="HISTORY")])
            with external.connection:
                portfolio_row(external, friendly(nft, False), "IMPORTED")
        assert store.collection_evidence(nft)["collection_conflict"] is True
        page(store, listing, [record("listing", nft, version=2)], cursor="next", next_cursor="last", body=b"second listing")
        middle = store.observations("listing")[1]
        assert middle["collection_evidence"] == {"portfolio_import": "IMPORTED", "observed_history": ["HISTORY"]}
        assert middle["collection_conflict"] == 1
        page(store, stream(store, "history"), [record("history", nft, collection_address="LATER")])
        page(store, listing, [record("listing", nft, version=3)], cursor="last", body=b"last listing")
        assert store.observations("listing")[2]["collection_evidence"]["observed_history"] == ["HISTORY", "LATER"]
        assert store.observations("listing")[0] == old
        with Store(database) as external:
            ton_evidence(external, nft, member="TON_MEMBER", observed="TON_OBSERVED", candidate="TON_CANDIDATE")
        page(store, stream(store), [record("listing", nft, version=4)])
        latest = store.observations("listing")[3]["collection_evidence"]
        assert latest["ton_verified"] == ["TON_MEMBER"]
        assert latest["ton_observed"] == ["TON_OBSERVED"]
        assert latest["ton_candidate_sources"] == ["TON_CANDIDATE"]
        assert store.collection_evidence(nft)["collection_evidence"] == latest


def test_mixed_page_history_only_affects_later_listing_occurrences_and_dedup_uses_saved_data(tmp_path):
    with Store(tmp_path / "mixed.sqlite3") as store:
        known = record("history", "gift", collection_address="ORIGINAL")
        page(store, stream(store, "history"), [known])
        misleading_duplicate = NormalizedRecord("history", "gift", known.source_json,
                                                 {"nft_address": "gift", "collection_address": "NOT_SAVED"})
        page(store, stream(store), [record("listing", "gift", sequence=1),
                                   record("history", "gift", collection_address="ADDED"),
                                   misleading_duplicate, record("listing", "gift", sequence=2)])
        rows = store.observations("listing")
        assert rows[0]["collection_evidence"]["observed_history"] == ["ORIGINAL"]
        assert rows[1]["collection_evidence"]["observed_history"] == ["ADDED", "ORIGINAL"]
        assert len(store.records("history")) == 2


def test_replay_does_not_rescan_and_failures_rollback_page_records_and_checkpoint(tmp_path):
    with Store(tmp_path / "atomic.sqlite3") as store:
        listing = stream(store)
        entries = [record("listing", "gift")]
        assert page(store, listing, entries, next_cursor="next")
        sql = []
        store.connection.set_trace_callback(sql.append)
        assert not page(store, listing, entries, next_cursor="next")
        store.connection.set_trace_callback(None)
        assert not any("SELECT identity,data_json FROM records" in statement for statement in sql)
        with pytest.raises(ValueError, match="different content"):
            page(store, listing, entries, next_cursor="next", body=b"changed replay")
        broken = NormalizedRecord("listing", [], "{}", {})
        with pytest.raises(sqlite3.ProgrammingError):
            page(store, listing, [record("history", "gift", collection_address="ROLLBACK"),
                                  record("listing", "gift", price="new"), broken],
                 cursor="next", next_cursor="never", body=b"invalid mixed page")
        assert store.connection.execute("SELECT COUNT(*) FROM pages").fetchone()[0] == 1
        assert len(store.observations()) == 1
        assert store.records("history") == []
        assert store.collection_evidence("gift")["collection_source"] == "unknown"
        assert store.connection.execute("SELECT next_cursor FROM streams WHERE id=?", (listing,)).fetchone()[0] == "next"


def test_history_only_and_empty_pages_do_not_read_collection_evidence(tmp_path):
    with Store(tmp_path / "history.sqlite3") as store:
        sql = []
        store.connection.set_trace_callback(sql.append)
        page(store, stream(store, "history"), [record("history", "gift", collection_address="COLLECTION")])
        page(store, stream(store), [])
        store.connection.set_trace_callback(None)
        assert not any("SELECT identity,data_json FROM records" in statement for statement in sql)
        assert not any("SELECT nft_address,collection_address FROM portfolio" in statement for statement in sql)


def test_page_evidence_is_read_after_write_transaction_begins(tmp_path, monkeypatch):
    with Store(tmp_path / "snapshot.sqlite3") as store:
        original = store._collection_evidence_index
        checked = []
        def check_snapshot(addresses):
            checked.append(store.connection.in_transaction)
            return original(addresses)
        monkeypatch.setattr(store, "_collection_evidence_index", check_snapshot)
        page(store, stream(store), [record("listing", "gift")])
        assert checked == [True]
        assert store.connection.in_transaction is False
