import json
from datetime import timedelta

import pytest

from marketapp_rent.serverless_export import main, prepare_records, readonly_store, write_export
from marketapp_rent.storage import Store
from test_pricing import store, addr, COLLECTION, NOW, RECENT, listings, listing, ton_traits
from test_rental_pricing import history, event


def member(store, tmp_path):
    path = tmp_path / "portfolio.csv"
    path.write_text(f"nft_address,collection_address,label\n{addr(10)},{COLLECTION},Keep my label\n")
    store.import_portfolio(path)


def test_export_preserves_membership_and_filters_comparison_history(store, tmp_path):
    member(store, tmp_path)
    listings(store, [listing(10), listing(11)])
    history(store, [event(10, ts=int((NOW - timedelta(days=120)).timestamp())), event(11),
                    event(12, ts=int((NOW - timedelta(days=120)).timestamp()))])
    records, preview = prepare_records(store, now=NOW)
    gifts = [r["record"] for r in records if r["kind"] == "portfolio"]
    assert preview["portfolio_gifts"] == 1
    assert gifts[0]["label"] == "Keep my label"
    assert gifts[0]["membership_sources"] == ["user_declared"]
    assert "pricing" not in gifts[0] and "rental_history" not in gifts[0]
    events = [json.loads(r["record"]["source_json"]) for r in records if r["kind"] == "history"]
    assert {r["address"] for r in events} == {addr(10), addr(11)}
    assert len([r for r in records if r["kind"] == "listing"]) == 2


def test_structured_traits_keep_original_timestamp_and_conflicts(store, tmp_path):
    member(store, tmp_path)
    ton_traits(store, nft=addr(10))
    records, _ = prepare_records(store, now=NOW)
    attrs = [r["record"] for r in records if r["kind"] == "metadata" and r["record"].get("attributes")]
    assert attrs and attrs[0]["source"] == "TON metadata"
    assert attrs[0]["observed_at"] == RECENT
    assert "source_path" not in json.dumps(records)


def test_future_listing_is_retained_as_exclusion_evidence(store, tmp_path):
    member(store, tmp_path)
    future = (NOW + timedelta(days=1)).isoformat()
    listings(store, [listing(10)], when=RECENT)
    listings(store, [listing(10, "2000000000")], when=future)
    records, _ = prepare_records(store, now=NOW)
    listing_rows = [row for row in records if row["kind"] == "listing"]
    assert {row["observed_at"] for row in listing_rows} == {RECENT, future}


def test_readonly_export_cannot_migrate_or_mutate(tmp_path):
    path = tmp_path / "data.sqlite3"
    with Store(path):
        pass
    original = path.read_bytes()
    with readonly_store(path) as store:
        with pytest.raises(Exception, match="readonly"):
            store.connection.execute("DELETE FROM portfolio")
        records, preview = prepare_records(store, now=NOW)
    assert path.read_bytes() == original
    assert preview["portfolio_gifts"] == 0
    assert [r["kind"] for r in records] == ["settings"]
    with pytest.raises(FileNotFoundError):
        with readonly_store(tmp_path / "missing.sqlite3"):
            pass


def test_chunked_preview_has_digests_and_does_not_upload(store, tmp_path):
    member(store, tmp_path)
    records, preview = prepare_records(store, now=NOW)
    output = tmp_path / "export"
    first = write_export(records, preview, output, app_id="54321")
    second = write_export(records, preview, output, app_id="54321")
    assert first == second
    assert first["uploaded"] is False
    assert first["destination_app_id"] == "54321"
    assert first["destination"] == "Telegram Serverless app 54321"
    assert len(first["dataset_sha256"]) == 64
    loaded = [row for chunk in first["chunks"] for row in json.loads((output / chunk["file"]).read_text())["records"]]
    assert records == loaded


@pytest.mark.parametrize("days", [0, 91, True])
def test_export_rejects_unbounded_windows(store, days):
    with pytest.raises(ValueError):
        prepare_records(store, now=NOW, days=days)


@pytest.mark.parametrize("app_id", [None, "", "0", "-1", "01", "54321 ", "1.5", "app54321:secret", "9007199254740992", 54321])
def test_export_rejects_invalid_destinations_before_writing(tmp_path, app_id):
    output = tmp_path / "export"
    with pytest.raises(ValueError, match="--app-id"):
        write_export([], {}, output, app_id=app_id)
    assert not output.exists()


def test_export_cli_requires_destination_before_reading_database(tmp_path):
    with pytest.raises(SystemExit) as error:
        main(["--db", str(tmp_path / "missing.sqlite3"), "--out", str(tmp_path / "export")])
    assert error.value.code == 2
    assert not (tmp_path / "export").exists()


def test_export_cli_records_explicit_destination(tmp_path, capsys):
    path = tmp_path / "data.sqlite3"
    with Store(path):
        pass
    output = tmp_path / "export"
    main(["--db", str(path), "--out", str(output), "--app-id", "65432"])
    assert json.loads(capsys.readouterr().out)["destination_app_id"] == "65432"
    assert json.loads((output / "manifest.json").read_text())["destination_app_id"] == "65432"
