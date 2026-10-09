"""Seed compaction keeps evidence identity and historical contradictions."""
import json
from datetime import timedelta

from marketapp_rent.serverless_export import prepare_records
from test_pricing import store, addr, COLLECTION, NOW, RECENT, listings, listing, ton_traits
from test_rental_pricing import history, event


def member(store, tmp_path):
    path = tmp_path / "seed-member.csv"
    path.write_text(f"nft_address,collection_address,label\n{addr(10)},{COLLECTION},Preserved label\n")
    store.import_portfolio(path)


def test_compaction_preserves_distinct_observation_times_and_parameter_provenance(store, tmp_path):
    member(store, tmp_path)
    earlier = (NOW - timedelta(days=2)).isoformat()
    listings(store, [listing(10)], when=earlier)
    listings(store, [listing(10)], when=RECENT)
    listings(store, [listing(10)], when=RECENT)
    listings(store, [listing(10)], when=RECENT, filters={"model": "Ruby"})
    records, _ = prepare_records(store, now=NOW)
    rows = [row["record"] for row in records if row["kind"] == "listing"]
    assert len(rows) == 2
    broad = next(row for row in rows if "model" not in row["params"])
    assert broad["occurrence_count"] == 3
    assert broad["occurrence_times"] == [earlier, RECENT]
    assert broad["observed_at"] == RECENT
    assert json.loads(broad["source_json"])["price_per_day"] == "1000000000"


def test_history_changed_variants_survive_compaction_and_old_owned_rentals_survive_window(store, tmp_path):
    member(store, tmp_path)
    old = int((NOW - timedelta(days=150)).timestamp())
    original, changed = event(10, ts=old, tx_hash=None), event(10, ts=old, tx_hash="later-representation")
    history(store, [original, changed])
    history(store, [original])
    records, _ = prepare_records(store, now=NOW)
    rows = [row["record"] for row in records if row["kind"] == "history"]
    assert len(rows) == 2
    assert {json.loads(row["source_json"])["tx_hash"] for row in rows} == {None, "later-representation"}
    assert sorted(row["occurrence_count"] for row in rows) == [1, 2]
    assert all(json.loads(row["source_json"])["ts"] == old for row in rows)


def test_collection_conflict_from_omitted_old_listing_is_retained_as_metadata(store, tmp_path):
    member(store, tmp_path)
    listings(store, [listing(10)], when=RECENT)
    listings(store, [listing(10)], scope=addr(333), when=(NOW - timedelta(days=120)).isoformat())
    records, _ = prepare_records(store, now=NOW)
    evidence = [row["record"] for row in records if row["kind"] == "metadata" and row["record"].get("nft_address") == addr(10)]
    assert any(set(row.get("collections", [])) == {COLLECTION, addr(333)} for row in evidence)


def test_ton_export_contains_structured_traits_without_whole_provider_body_or_remote_metadata_url(store, tmp_path):
    member(store, tmp_path)
    ton_traits(store, nft=addr(10))
    records, _ = prepare_records(store, now=NOW)
    encoded = json.dumps(records)
    assert "https://metadata.invalid/no-fetch" not in encoded
    assert '"last_transaction_lt"' not in encoded
    assert '"token_info"' not in encoded
    metadata = [row["record"] for row in records if row["kind"] == "metadata" and row["record"].get("attributes")]
    assert metadata[0]["source"] == "TON metadata"
    assert metadata[0]["observed_at"] == RECENT
