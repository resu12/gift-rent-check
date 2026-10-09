"""Progress denominators describe fixed work rather than unknown page counts."""
import json

import pytest

from marketapp_rent.addresses import preferred_address
from marketapp_rent.dashboard_jobs import progress_for
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse
from marketapp_rent.models import parse_page
from marketapp_rent.storage import Store


COLLECTION = "0:" + "33" * 32
OTHER = "0:" + "44" * 32
WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
NFT2 = "0:" + "55" * 32
WHEN = "2026-10-09T12:00:00Z"


def catalog():
    return {"kind": "collection", "path": "/v1/collections/gifts/", "params": {}}


def stream(kind, scope, **params):
    return {"kind": kind, "path": "/v1/rent/gifts/" + ("history/" if kind == "history" else ""),
            "params": {"collection_address": scope, **params} if scope else params}


def commit(store, stream_id, kind, body, cursor=None):
    raw = json.dumps(body).encode()
    store.commit_page(stream_id, cursor, ApiResponse(raw, 200, WHEN), parse_page(kind, raw))


def job(run_id, kind="collect"):
    return {"kind": kind, "run_id": run_id}


def sync(database, current):
    return progress_for(database, current)["sync"]


def test_frozen_manifest_supplies_total_before_stream_initialization(tmp_path):
    database = tmp_path / "progress.sqlite3"
    with Store(database) as store:
        run = store.create_run({"streams": [catalog(), stream("listing", COLLECTION), stream("listing", OTHER)]}, [COLLECTION, OTHER], [])
    assert sync(database, job(run)) == {"phase": "preparing", "completed": 0, "total": 2,
                                       "unit": "collections", "current_collection": None, "processed_items": 0}


def test_collection_progress_waits_for_all_required_streams_and_uses_saved_friendly_names(tmp_path):
    database = tmp_path / "progress.sqlite3"
    manifest = [catalog(), stream("listing", COLLECTION), stream("history", preferred_address(COLLECTION)),
                stream("listing", OTHER), stream("history", OTHER)]
    with Store(database) as store:
        run = store.create_run({"streams": manifest}, [COLLECTION, OTHER], [])
        ids = [store.add_stream(run, **spec) for spec in manifest]
        commit(store, ids[0], "collection", [{"address": preferred_address(COLLECTION), "name": "Low Riders", "extra_data": {}},
                                           {"address": OTHER, "name": "Timeless Books", "extra_data": {}}])
        assert sync(database, job(run)) == {"phase": "listings", "completed": 0, "total": 2,
                                           "unit": "collections", "current_collection": "Low Riders", "processed_items": 0}
        store.set_stream_state(ids[1], "complete")
        assert sync(database, job(run))["phase"] == "rentals"
        assert sync(database, job(run))["completed"] == 0
        store.set_stream_state(ids[2], "complete", "shared_market_cache")
        current = sync(database, job(run))
        assert (current["phase"], current["completed"], current["total"], current["current_collection"]) == ("listings", 1, 2, "Timeless Books")
        store.set_stream_state(ids[3], "complete")
        store.set_stream_state(ids[4], "complete")
        assert sync(database, job(run)) == {"phase": "complete", "completed": 2, "total": 2,
                                           "unit": "collections", "current_collection": None, "processed_items": 0}


def test_listing_comparison_progress_counts_finished_models_before_whole_collections(tmp_path):
    database = tmp_path / "progress.sqlite3"
    manifest = [catalog(), stream("listing", COLLECTION), stream("listing", COLLECTION, model="A"),
                stream("listing", COLLECTION, model="B"), stream("listing", OTHER),
                stream("listing", OTHER, model="C")]
    with Store(database) as store:
        run = store.create_run({"streams": manifest}, [COLLECTION, OTHER], [])
        ids = [store.add_stream(run, **spec) for spec in manifest]
        commit(store, ids[0], "collection", [])
        for index in (1, 2, 4):
            store.set_stream_state(ids[index], "complete")
        # Neither collection is complete, but four of six fixed checks are.
        current = sync(database, job(run, "prices"))
        assert (current["completed"], current["total"], current["unit"]) == (4, 6, "checks")
        assert current["phase"] == "listings"
        # Other collection jobs keep their collection coverage denominator.
        assert sync(database, job(run))["completed"] == 0
        for stream_id in ids:
            store.set_stream_state(stream_id, "complete")
        assert sync(database, job(run, "prices"))["completed"] == 6


def test_cached_collection_work_is_not_100_percent_before_catalog_finishes(tmp_path):
    database = tmp_path / "progress.sqlite3"
    manifest = [catalog(), stream("listing", COLLECTION), stream("listing", COLLECTION, model="A")]
    with Store(database) as store:
        run = store.create_run({"streams": manifest}, [COLLECTION], [])
        ids = [store.add_stream(run, **spec) for spec in manifest]
        store.set_stream_state(ids[1], "complete", "shared_market_cache")
        store.set_stream_state(ids[2], "complete", f"covered_by_listing_stream:{ids[1]}")
        assert sync(database, job(run))["completed"] == 0
        assert sync(database, job(run))["phase"] == "preparing"
        commit(store, ids[0], "collection", [])
        assert sync(database, job(run))["completed"] == 1
        assert sync(database, job(run))["phase"] == "complete"


@pytest.mark.parametrize("earlier_state", ["partial", "failed"])
def test_current_collection_prefers_running_later_stream_over_earlier_incomplete_work(tmp_path, earlier_state):
    database = tmp_path / "progress.sqlite3"
    manifest = [catalog(), stream("listing", COLLECTION), stream("history", OTHER)]
    with Store(database) as store:
        run = store.create_run({"streams": manifest}, [COLLECTION, OTHER], [])
        ids = [store.add_stream(run, **spec) for spec in manifest]
        commit(store, ids[0], "collection", [{"address": COLLECTION, "name": "Low Riders", "extra_data": {}},
                                           {"address": OTHER, "name": "Timeless Books", "extra_data": {}}])
        store.set_stream_state(ids[1], earlier_state)
        store.set_stream_state(ids[2], "running")
        assert sync(database, job(run)) == {"phase": "rentals", "completed": 0, "total": 2,
                                           "unit": "collections", "current_collection": "Timeless Books", "processed_items": 0}


def test_failed_catalog_does_not_hide_a_running_market_stream(tmp_path):
    database = tmp_path / "progress.sqlite3"
    manifest = [catalog(), stream("history", COLLECTION)]
    with Store(database) as store:
        run = store.create_run({"streams": manifest}, [COLLECTION], [])
        ids = [store.add_stream(run, **spec) for spec in manifest]
        store.set_stream_state(ids[0], "failed")
        store.set_stream_state(ids[1], "running")
        assert sync(database, job(run)) == {"phase": "rentals", "completed": 0, "total": 1,
                                           "unit": "collections", "current_collection": None, "processed_items": 0}


def test_partial_pages_do_not_increment_collection_count_and_catalog_items_are_not_processed_market_items(tmp_path):
    database = tmp_path / "progress.sqlite3"
    manifest = [catalog(), stream("history", COLLECTION)]
    with Store(database) as store:
        run = store.create_run({"streams": manifest}, [COLLECTION], [])
        ids = [store.add_stream(run, **spec) for spec in manifest]
        commit(store, ids[0], "collection", [{"address": COLLECTION, "name": "Low Riders", "extra_data": {}}])
        record = {"address": NFT, "name": "Gift", "collection_address": COLLECTION, "ts": 100,
                  "src": "a", "dst": "b", "price": "1", "price_nano": "1000000000", "currency": "GRAM"}
        commit(store, ids[1], "history", {"cursor": "next", "items": [record, record]})
        current = sync(database, job(run, "rental_prices"))
        assert current["completed"] == 0 and current["total"] == 1
        assert current["processed_items"] == 2 and current["current_collection"] == "Low Riders"


def test_legacy_unfiltered_work_is_indeterminate_and_does_not_display_addresses(tmp_path):
    database = tmp_path / "progress.sqlite3"
    with Store(database) as store:
        run = store.create_run({}, [None], [])
        store.add_stream(run, **stream("listing", None))
    current = sync(database, job(run))
    assert current["total"] is None and current["current_collection"] is None and current["phase"] == "listings"


@pytest.mark.parametrize("kind,unit", [("prices", "collections"), ("rental_prices", "collections"), ("refresh", "gifts"), ("discover", "gifts")])
def test_queued_work_without_run_has_indeterminate_preparation(tmp_path, kind, unit):
    database = tmp_path / "absent.sqlite3"
    assert sync(database, {"kind": kind}) == {"phase": "preparing", "completed": 0, "total": None,
                                             "unit": unit, "current_collection": None, "processed_items": 0}
    assert not database.exists()


def save_discovery_catalog(ds, run):
    ds.save_catalog(run, ApiResponse(b"[]", 200, WHEN), [COLLECTION])


def test_discovery_remains_indeterminate_until_both_enumeration_streams_finish(tmp_path, monkeypatch):
    database = tmp_path / "discovery.sqlite3"
    with Store(database) as store:
        ds = DiscoveryStore(store)
        run = ds.create_run(WALLET, {"mode": "full"})
        ds.add_candidates(run, [{"nft_address": NFT}, {"nft_address": NFT2}])
        with store.connection:
            store.connection.execute("UPDATE discovery_candidates SET state='done',verified=0 WHERE nft_key=?", (NFT,))
        assert sync(database, job(run, "discover"))["phase"] == "preparing"
        save_discovery_catalog(ds, run)
        # The projection must not load full per-candidate evidence on each poll.
        monkeypatch.setattr(DiscoveryStore, "candidates", lambda *_: pytest.fail("Expensive candidate projection"))
        current = sync(database, job(run, "discover"))
        assert current == {"phase": "discovering", "completed": 1, "total": None, "unit": "gifts",
                           "current_collection": None, "processed_items": 1}
        with store.connection:
            store.connection.execute("UPDATE discovery_checkpoints SET state='complete' WHERE kind='holdings'")
        assert sync(database, job(run, "discover"))["total"] is None
        with store.connection:
            store.connection.execute("UPDATE discovery_checkpoints SET state='complete' WHERE kind='transfers'")
        current = sync(database, job(run, "discover"))
        assert (current["phase"], current["completed"], current["total"]) == ("verifying", 1, 2)


def test_fixed_wallet_refresh_uses_frozen_seed_count_and_checked_includes_unresolved(tmp_path):
    database = tmp_path / "refresh.sqlite3"
    seeds = [{"nft_address": NFT}, {"nft_address": preferred_address(NFT)}, {"nft_address": NFT2}]
    with Store(database) as store:
        ds = DiscoveryStore(store)
        run = ds.create_run(WALLET, {"mode": "portfolio_refresh", "seed_candidates": seeds})
        assert sync(database, job(run, "refresh"))["total"] == 2
        save_discovery_catalog(ds, run)
        assert sync(database, job(run, "refresh"))["phase"] == "verifying"
        ds.add_candidates(run, seeds)
        with store.connection:
            store.connection.execute("UPDATE discovery_candidates SET state='done',verified=0 WHERE nft_key=?", (NFT,))
        current = sync(database, job(run, "refresh"))
        assert (current["completed"], current["total"]) == (1, 2)
        with store.connection:
            store.connection.execute("UPDATE discovery_candidates SET state='done',verified=0")
        result = progress_for(database, job(run, "refresh"))
        assert result["verified"] == 0 and result["sync"]["phase"] == "complete"
        assert result["sync"]["completed"] == result["sync"]["total"] == 2
