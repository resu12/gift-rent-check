import json
import sqlite3
from decimal import Decimal

import pytest

from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.storage import Store
from marketapp_rent.util import canonical_json


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "test.sqlite3") as result:
        yield result


def record(kind="listing", nft="NFT1", **data):
    payload = {"nft_address": nft, **data}
    return NormalizedRecord(kind, nft, canonical_json(payload), payload)


def stream(store, kind="listing", scope=None):
    run = store.create_run({"page_size": 10}, [scope], [])
    return run, store.add_stream(run, kind, "/v1/rent/gifts/", {"collection_address": scope} if scope else {})


def page(store, stream_id, records, cursor=None, next_cursor=None, body=b"{}"):
    return store.commit_page(stream_id, cursor, ApiResponse(body, 200, "2026-10-08T12:00:00Z"), ParsedPage(records, next_cursor))


def test_import_atomic_idempotent_and_non_deleting(store, tmp_path):
    path = tmp_path / "portfolio.csv"
    path.write_text("nft_address,collection_address,label\n NFT1 , C1 , Present \nNFT2,C2,Second\n", encoding="utf-8-sig")
    assert store.import_portfolio(path) == {"inserted": 2, "updated": 0, "unchanged": 0, "total": 2}
    assert store.import_portfolio(path)["unchanged"] == 2
    assert store.connection.execute("SELECT COUNT(*) FROM portfolio_evidence").fetchone()[0] == 2
    path.write_text("nft_address,label\nNFT1,Renamed\n", encoding="utf-8")
    assert store.import_portfolio(path)["updated"] == 1
    assert len(store.portfolio()) == 2
    assert store.portfolio()[0]["collection_address"] == "C1"
    path.write_text("nft_address,collection_address\nNFT3,C3\nNFT4,C4\nNFT4,C5\n", encoding="utf-8")
    with pytest.raises(ValueError, match="conflicts"):
        store.import_portfolio(path)
    assert len(store.portfolio()) == 2
    path.write_text("nft_address,label\n ,Blank\n", encoding="utf-8")
    with pytest.raises(ValueError, match="blank"):
        store.import_portfolio(path)
    assert len(store.portfolio()) == 2


@pytest.mark.parametrize("contents", ["collection_address\nC1\n", "nft_address,nft_address\nA,A\n", "nft_address,label\nA\n"])
def test_invalid_csv_schema(store, tmp_path, contents):
    path = tmp_path / "bad.csv"
    path.write_text(contents, encoding="utf-8")
    with pytest.raises(ValueError):
        store.import_portfolio(path)
    assert store.portfolio() == []


def test_commits_checkpoint_and_replays_idempotently(store):
    run_id, stream_id = stream(store)
    item = record(price_per_day_gram=Decimal("0.000000001"))
    assert page(store, stream_id, [item], next_cursor="opaque+/==")
    assert not page(store, stream_id, [item], next_cursor="opaque+/==")
    state = store.streams(run_id)[0]
    assert (state["pages"], state["state"], state["next_cursor"]) == (1, "pending", "opaque+/==")
    assert not store.has_cursor(stream_id, "opaque+/==")
    assert page(store, stream_id, [], cursor="opaque+/==", next_cursor="end")
    assert store.has_cursor(stream_id, "opaque+/==")
    assert page(store, stream_id, [item], cursor="end")
    assert store.streams(run_id)[0]["state"] == "complete"
    assert len(store.records()) == 1
    assert len(store.observations()) == 2
    assert store.records()[0]["data"]["price_per_day_gram"] == "1E-9"


def test_page_transaction_rolls_back_everything_on_record_failure(store):
    run_id, stream_id = stream(store)
    broken = NormalizedRecord("listing", [], "{}", {})
    with pytest.raises(sqlite3.ProgrammingError):
        page(store, stream_id, [record(), broken], next_cursor="next")
    assert store.streams(run_id)[0]["pages"] == 0
    for table in ("pages", "records", "observations"):
        assert store.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_history_representation_dedup_retains_multiplicity_and_variants(store):
    _, stream_id = stream(store, "history")
    identical = record("history", "NFT1", tx_hash="same", price=Decimal("1.23"))
    changed = record("history", "NFT1", tx_hash="same", price=Decimal("1.24"))
    second_gift = record("history", "NFT2", tx_hash="same", price=Decimal("1.23"))
    absent_hash = record("history", "NFT1", price=Decimal("1.23"))
    null_hash = record("history", "NFT1", tx_hash=None, price=Decimal("1.23"))
    page(store, stream_id, [identical, identical, changed, second_gift, absent_hash, null_hash])
    assert len(store.records("history")) == 5
    assert len(store.observations("history")) == 6
    payloads = [json.loads(row["source_json"]) for row in store.records("history")]
    assert any("tx_hash" not in item for item in payloads)
    assert any(item.get("tx_hash", "missing") is None for item in payloads)


def test_new_run_preserves_observations_and_exact_money(store):
    item = record(price_per_day_gram=Decimal("123456789012345678901234567890.123456789"))
    for _ in range(2):
        _, stream_id = stream(store)
        page(store, stream_id, [item])
    assert len(store.records()) == 1
    assert len(store.observations()) == 2
    assert store.records()[0]["data"]["price_per_day_gram"] == "123456789012345678901234567890.123456789"
    assert store.connection.execute("SELECT typeof(data_json) FROM records").fetchone()[0] == "text"


def test_conflicting_provenance_never_guesses(store, tmp_path):
    path = tmp_path / "portfolio.csv"
    path.write_text("nft_address,collection_address\nNFT1,C1\n", encoding="utf-8")
    store.import_portfolio(path)
    _, history_stream = stream(store, "history")
    page(store, history_stream, [record("history", collection_address="C2")])
    _, listing_stream = stream(store, scope="C3")
    page(store, listing_stream, [record()])
    listing = store.observations("listing")[0]
    assert listing["collection_address"] is None
    assert listing["collection_conflict"] == 1
    assert listing["collection_evidence"] == {"filtered_request": "C3", "portfolio_import": "C1", "observed_history": ["C2"]}


def test_raw_invalid_attempt_retained_without_checkpoint(store):
    run_id, stream_id = stream(store)
    store.record_attempt(run_id, {"path": "/v1/rent/gifts/", "params": {}, "body": b"not json", "status_code": 200})
    store.record_issue(run_id, stream_id, "invalid_response", "Malformed response")
    assert store.connection.execute("SELECT body FROM attempts").fetchone()[0] == b"not json"
    assert store.streams(run_id)[0]["pages"] == 0
    assert store.issues()[0]["reason"] == "invalid_response"


def test_database_reopen_restores_checkpoint_and_rejects_future_schema(tmp_path):
    path = tmp_path / "test.sqlite3"
    with Store(path) as store:
        run_id, stream_id = stream(store)
        page(store, stream_id, [record()], next_cursor="resume")
    with Store(path) as reopened:
        assert reopened.streams(run_id)[0]["next_cursor"] == "resume"
        assert reopened.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        reopened.connection.execute("PRAGMA user_version = 999")
    with pytest.raises(ValueError, match="newer"):
        Store(path)


def test_wrong_checkpoint_and_changed_replay_cannot_overwrite(store):
    _, stream_id = stream(store)
    page(store, stream_id, [record()], next_cursor="next")
    with pytest.raises(ValueError, match="different content"):
        page(store, stream_id, [record()], next_cursor="next", body=b"different")
    with pytest.raises(ValueError, match="checkpoint"):
        page(store, stream_id, [], cursor="wrong")


def test_stream_initialization_idempotent_and_attribute_path_provenance(store):
    run_id = store.create_run({}, ["C+1"], [])
    stream_id = store.add_stream(run_id, "attribute", "/v1/collections/C%2B1/attributes/", {})
    assert store.add_stream(run_id, "attribute", "/v1/collections/C%2B1/attributes/", {}) == stream_id
    attribute = NormalizedRecord("attribute", "model:Blue", '{"trait_type":"model","value":"Blue"}', {"trait_type": "model", "value": "Blue"})
    page(store, stream_id, [attribute])
    assert len(store.streams(run_id)) == 1
    observation = store.observations("attribute")[0]
    assert observation["collection_address"] == "C+1"
    assert observation["collection_source"] == "request_path"


def test_retry_after_deadline_survives_reopen_and_new_runs(tmp_path):
    path = tmp_path / "throttled.sqlite3"
    deadline = "2026-10-09T13:00:00.000000+00:00"
    with Store(path) as store:
        assert store.retry_not_before() is None
        run_id = store.create_run({}, [None], [])
        store.record_attempt(run_id, {"path": "/v1/rent/gifts/", "status_code": 429, "retry_after_at": deadline})
        store.finish_run(run_id, "partial", "retry_after")
    with Store(path) as reopened:
        assert reopened.retry_not_before() == deadline
        next_run = reopened.create_run({}, [None], [])
        reopened.record_attempt(next_run, {"path": "/v1/rent/gifts/", "status_code": 200})
        reopened.record_attempt(next_run, {"path": "/v1/rent/gifts/", "status_code": 503, "retry_after_at": "2026-10-09T12:00:00.000000+00:00"})
        assert reopened.retry_not_before() == deadline
