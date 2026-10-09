import csv
import json
from pathlib import Path

import pytest

from marketapp_rent.addresses import canonical_address, preferred_address
from marketapp_rent.dashboard_view import build_dashboard
from marketapp_rent.discovery_store import DiscoveryStore
from marketapp_rent.domain import ApiResponse, NormalizedRecord, ParsedPage
from marketapp_rent.storage import Store

WALLET = "0:" + "11" * 32
NFT = "0:" + "22" * 32
NFT2 = "0:" + "33" * 32
COLLECTION = "0:" + "44" * 32
BEFORE = "2026-10-08T10:00:00+00:00"
NOW = "2026-10-08T11:00:00+00:00"
AFTER = "2026-10-08T12:00:00+00:00"


def seed(store, nft=NFT, when=NOW, verified=True, state="idle_rental_contract", reason=None, metadata=None, mode=None):
    ds = DiscoveryStore(store)
    run = ds.create_run(WALLET, {"mode": mode} if mode else {})
    ds.save_catalog(run, ApiResponse(b"[]", 200, when), [COLLECTION])
    ds.add_candidates(run, [{"nft_address": nft, "source": "holdings", "collection_address": COLLECTION}])
    evidence = {"wallet_address": WALLET, "nft_address": nft, "collection_address": COLLECTION,
                "verified": verified, "observed_at": when, "rental_state": state,
                "reason": reason or ("verified_rental_owner" if verified else "unsupported_code_hash"),
                "configured_price_per_day_raw": "123456789012345678901234567890", "rental_until": 1792078891}
    responses = []
    if metadata:
        responses = [{"path": "/api/v3/nft/items", "body": json.dumps({"metadata": {preferred_address(nft): {"token_info": [metadata]}}}).encode(),
                      "status_code": 200, "observed_at": when, "provider": "toncenter"}]
    ds.commit_verification(run, nft, evidence, responses)
    ds.finish_run(run, "complete")
    return ds, run


def review_row(nft=NFT, **changes):
    return {"nft_address": nft, "wallet_address": WALLET, "collection_address": COLLECTION,
            "name": "Example Gift #7", "collection_name": "Example Gifts", "category": "wallet_linked",
            "state": "idle_rental_contract", "observed_at": NOW, "reviewed_at": AFTER,
            "recorded_owner_or_seller": WALLET, "verification_method": "supplemental_contract_review",
            "automatic_portfolio_member": "true", **changes}


def write_review(directory, rows, filename="updated_inventory.csv"):
    directory.mkdir(parents=True, exist_ok=True)
    fields = sorted({key for row in rows for key in row})
    with (directory / filename).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def test_empty_dashboard_and_opaque_declarations_are_offline_and_do_not_write(tmp_path):
    with Store(":memory:") as store:
        baseline = store.connection.total_changes
        result = build_dashboard(store)
        assert store.connection.total_changes == baseline
        assert result["gifts"] == [] and result["wallet"] is None
        assert result["summary"]["portfolio_count"] == 0
        path = tmp_path / "portfolio.csv"
        path.write_text("nft_address,label\nlegacy-identifier,Gift from CSV\n")
        store.import_portfolio(path)
        gift = build_dashboard(store)["gifts"][0]
        assert gift["name"] == "Gift from CSV"
        assert gift["automatic_membership"] is False
        assert gift["explorer_url"] is None
        assert gift["state"] == "uncertain"


def test_metadata_prices_and_idle_state_do_not_invent_for_rent_visibility():
    with Store(":memory:") as store:
        seed(store, metadata={"type": "nft_items", "name": "Gift #7", "image": "https://nft.fragment.com/gift/example.webp", "secret": "never exposed"})
        result = build_dashboard(store, preferred_address(WALLET))
        gift = result["gifts"][0]
        assert gift["name"] == "Gift #7"
        assert gift["image_url"] == "https://nft.fragment.com/gift/example.webp"
        assert gift["price_per_day"] == "123456789012345678901.23456789"
        assert gift["ui_state"] is None
        assert gift["display_state"] == "Idle rental contract"
        assert result["summary"]["for_rent_count"] == 0
        assert result["summary"]["automatic_count"] == 1
        assert "never exposed" not in json.dumps(result)


def test_conflicting_csv_and_ton_collections_remain_unresolved_in_dashboard(tmp_path):
    with Store(":memory:") as store:
        seed(store)
        path = tmp_path / "portfolio.csv"
        path.write_text(f"nft_address,collection_address\n{NFT},{NFT2}\n")
        store.import_portfolio(path)
        gift = build_dashboard(store, WALLET)["gifts"][0]
        assert gift["collection_conflict"] is True
        assert gift["collection_address"] is None
        assert {canonical_address(value) for value in gift["collection_addresses"]} == {COLLECTION, NFT2}
        assert gift["is_portfolio"] and gift["automatic_membership"]
        assert gift["state"] == "uncertain" and gift["ui_state"] is None
        assert "Conflicting collection evidence" in gift["uncertainties"]


@pytest.mark.parametrize("url", ["http://example.com/a.png", "https://localhost/a.png", "https://127.0.0.1/x", "https://[::1]/x",
                                   "https://10.0.0.1/x", "https://192.168.1.1/x", "https://100.64.0.1/x", "https://2130706433/x",
                                   "https://0177.0.0.1/x", "https://metadata.internal/x", "https://user:password@example.com/x", "data:image/png,hello"])
def test_untrusted_image_urls_are_rejected_without_fetching(url):
    with Store(":memory:") as store:
        seed(store, metadata={"type": "nft_items", "image": url})
        assert build_dashboard(store)["gifts"][0]["image_url"] is None


def test_explicit_review_bundle_adds_annotated_gifts_without_automatic_membership(tmp_path):
    review = tmp_path / "review"
    write_review(review, [review_row(marketapp_ui_state="for_rent", marketapp_ui_price_per_day="0.07",
                                   marketapp_ui_reviewed_at=AFTER, marketapp_ui_source="for_rent.mp4"),
                          review_row(NFT2, state="fixed_price_sale_contract", name="Gift #8")])
    with Store(":memory:") as store:
        assert build_dashboard(store, WALLET)["gifts"] == []
        changes = store.connection.total_changes
        result = build_dashboard(store, WALLET, review)
        assert store.connection.total_changes == changes
        assert store.portfolio() == []
        assert result["summary"] == {"portfolio_count": 2, "automatic_count": 0, "review_count": 2, "for_rent_count": 1,
                                     "idle_count": 1, "rented_count": 0, "direct_count": 0, "sale_count": 1,
                                     "unresolved_count": 0, "uncertain_count": 0}
        gift = next(row for row in result["gifts"] if row["id"] == NFT)
        assert gift["display_state"] == "For rent"
        assert gift["price_per_day"] == "0.07"
        assert gift["verification_method"] == "local_review_annotation"
        assert gift["review_source_filename"] == "updated_inventory.csv"
        assert "Validated supplemental evidence" not in gift["proof_badges"]


def test_later_failed_database_observation_supersedes_review_and_retains_member(tmp_path):
    review = tmp_path / "review"
    write_review(review, [review_row(marketapp_ui_state="for_rent", marketapp_ui_price_per_day="0.07",
                                   marketapp_ui_reviewed_at=NOW, marketapp_ui_source="for_rent.mp4")])
    with Store(":memory:") as store:
        seed(store, when=BEFORE)
        seed(store, when=AFTER, verified=False, reason="owner_mismatch", state="unknown")
        result = build_dashboard(store, WALLET, review)
        gift = result["gifts"][0]
        assert gift["automatic_membership"] and gift["is_portfolio"]
        assert gift["state"] == "uncertain"
        assert gift["review_stale"] is True
        assert gift["observed_at"] == AFTER
        assert gift["ui_state"] is None
        assert "Historical review" in gift["proof_badges"]


def test_review_excludes_history_only_wallets_and_separates_unresolved(tmp_path):
    review = tmp_path / "review"
    write_review(review, [review_row(category="different_holder_or_beneficiary", recorded_owner_or_seller=NFT2),
                          review_row(NFT2, category="unresolved", state="unknown", recorded_owner_or_seller="")], "holder_review.csv")
    with Store(":memory:") as store:
        seed(store, verified=False)
        seed(store, NFT2, verified=False, reason="missing_collection")
        result = build_dashboard(store, WALLET, review)
        assert [gift["id"] for gift in result["gifts"]] == [NFT2]
        assert result["summary"]["portfolio_count"] == 0
        assert result["summary"]["unresolved_count"] == 1
        seed(store, NFT, when=AFTER, verified=False, reason="unsupported_code_hash")
        assert len(build_dashboard(store, WALLET, review)["gifts"]) == 2


@pytest.mark.parametrize("change", [{"reviewed_at": "yesterday"}, {"recorded_owner_or_seller": NFT2}, {"nft_address": "not-a-TON-address"}])
def test_invalid_review_provenance_is_not_promoted(tmp_path, change):
    review = tmp_path / "review"
    write_review(review, [review_row(**change)])
    with Store(":memory:") as store:
        result = build_dashboard(store, WALLET, review)
        assert result["gifts"] == []
        assert result["review"]["warnings"]


def test_review_for_another_wallet_is_not_shown(tmp_path):
    review = tmp_path / "review"
    write_review(review, [review_row(wallet_address=NFT2, recorded_owner_or_seller=NFT2)])
    with Store(":memory:") as store:
        assert build_dashboard(store, WALLET, review)["gifts"] == []


def test_refresh_coverage_is_not_full_enumeration_and_settings_secrets_are_not_exposed():
    with Store(":memory:") as store:
        ds, run = seed(store, mode="portfolio_refresh")
        store.connection.execute("UPDATE discovery_checkpoints SET state='complete' WHERE run_id=?", (run,))
        result = build_dashboard(store)
        assert result["runs"]["discovery"][-1]["mode"] == "portfolio_refresh"
        assert result["coverage"]["enumeration_complete"] is False
        assert "settings" not in result["runs"]["discovery"][-1]


def test_listing_proves_market_visibility_and_activity_keeps_currency_separate():
    with Store(":memory:") as store:
        seed(store, when=BEFORE)
        run = store.create_run({}, [COLLECTION], [])
        for kind, data in [("listing", {"nft_address": NFT, "nft_name": "Gift #7", "price_per_day_gram": "0.000000001"}),
                           ("history", {"nft_address": NFT, "price": "123.456", "currency": "OTHER"})]:
            stream = store.add_stream(run, kind, "/v1/rent/gifts/", {})
            record = NormalizedRecord(kind, NFT, json.dumps(data), data)
            store.commit_page(stream, None, ApiResponse(b"{}", 200, NOW), ParsedPage([record], None))
        result = build_dashboard(store)
        gift = result["gifts"][0]
        assert gift["ui_state"] == "for_rent"
        assert gift["price_per_day"] == "0.000000001"
        history = next(row for row in result["activity"] if row["type"] == "portfolio_gift_history")
        assert history["currency"] == "OTHER" and history["price"] == "123.456"
        assert "proceeds" in history["note"]


def test_saved_supplement_is_redecoded_and_tampered_hash_cannot_override(tmp_path):
    fixtures = Path(__file__).parent / "fixtures" / "ton"
    sample = json.loads((fixtures / "verified-samples.json").read_text())["samples"][0]
    account = next(row for row in json.loads((fixtures / "holder-states.json").read_text())["body"]["accounts"]
                   if canonical_address(row["address"]) == canonical_address(sample["holding_contract"]))
    item = next(row for row in json.loads((fixtures / "sample-nfts.json").read_text())["body"]["nft_items"]
                if canonical_address(row["address"]) == canonical_address(sample["nft_address"]))
    wallet = canonical_address(json.loads((fixtures / "verified-samples.json").read_text())["wallet_address"])
    folder = tmp_path / "review" / "evidence" / "live-recheck"
    folder.mkdir(parents=True)
    expected = {"wallet_address": wallet, "nft_address": item["address"], "collection_address": item["collection_address"]}
    (folder / "result.json").write_text(json.dumps(expected))
    for filename, path, body, observed in (("nft-before.json", "/api/v3/nft/items", {"nft_items": [item]}, BEFORE),
                                         ("holding-account.json", "/api/v3/accountStates", {"accounts": [account]}, NOW),
                                         ("nft-after.json", "/api/v3/nft/items", {"nft_items": [item]}, AFTER)):
        (folder / filename).write_text(json.dumps({"provider": "toncenter", "method": "GET", "path": path,
                                                   "status_code": 200, "observed_at": observed, "body": body}))
    with Store(":memory:") as store:
        result = build_dashboard(store, wallet, tmp_path / "review")
        assert result["gifts"][0]["verification_method"] == "validated_supplemental_evidence"
        assert result["gifts"][0]["automatic_membership"] is False
        assert store.portfolio() == []
        account["data_hash"] = "0" * 64
        document = json.loads((folder / "holding-account.json").read_text())
        document["body"]["accounts"] = [account]
        (folder / "holding-account.json").write_text(json.dumps(document))
        result = build_dashboard(store, wallet, tmp_path / "review")
        assert result["gifts"] == []
        assert result["review"]["warnings"]
