"""Private, offline dashboard projections. Review annotations never enroll NFTs."""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
import ipaddress
import json
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlsplit

from .addresses import address_key, canonical_address, preferred_address
from .discovery_store import DiscoveryStore
from .storage import Store
from .pricing import enrich_pricing
from .rental_counts import enrich_rental_counts
from .ton_decoder import decode_contract
from .util import utc_now

_STATES = {"held_directly", "idle_rental_contract", "rented", "expired_pending_return", "unknown", "uncertain"}
_EXCLUDED = {"different_holder_or_beneficiary", "outside_supported_catalog"}
_REVIEW_FILES = ("holder_review.csv", "unresolved.csv", "updated_inventory.csv")
_REQUIRED_REVIEW = {"nft_address", "wallet_address", "category", "state", "observed_at", "reviewed_at", "verification_method"}


def _text(value: Any, limit: int = 240) -> str | None:
    return value[:limit] if isinstance(value, str) and value.strip() else None


def _instant(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def _newer(left: Any, right: Any) -> bool:
    a, b = _instant(left), _instant(right)
    return a is not None and (b is None or a > b)


def _decimal(value: Any, *, nanos: bool = False) -> str | None:
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number < 0:
            return None
        with localcontext() as context:
            context.prec = max(40, len(number.as_tuple().digits) + 12)
            if nanos:
                number /= Decimal(1_000_000_000)
            return format(number, "f")
    except (InvalidOperation, ValueError):
        return None


def _price_observation(listings: list[dict], annotation: dict, ownership: list[dict], supplement: dict) -> dict:
    """Choose a price by its own evidence date, independently of ownership state."""
    candidates = []

    def remember(value, observed_at, source, priority, *, nanos=False):
        price = _decimal(value, nanos=nanos)
        instant = _instant(observed_at)
        if price is not None and instant is not None:
            candidates.append({"price_per_day": price, "price_source": source,
                               "price_observed_at": observed_at, "instant": instant, "priority": priority})

    for row in listings:
        remember(row.get("data", {}).get("price_per_day_gram"), row.get("observed_at"), "Marketapp listing", 3)
    if annotation.get("marketapp_ui_state") in {"for_rent", "rented"} and _text(annotation.get("marketapp_ui_source")):
        remember(annotation.get("marketapp_ui_price_per_day"), annotation.get("marketapp_ui_reviewed_at"),
                 "Marketapp user view", 2)
    for row in [*ownership, supplement]:
        if row.get("verified") is not True:
            continue
        # Configured asking terms can differ from an ongoing rental's rate.
        # A missing configured amount stays unknown; explicit zero is valid.
        remember(row.get("configured_price_per_day_raw"), row.get("observed_at"), "Observed contract terms", 1, nanos=True)
    if not candidates:
        return {"price_per_day": None, "price_source": None, "price_observed_at": None, "price_is_historical": False}
    chosen = max(candidates, key=lambda row: (row["instant"], row["priority"]))
    evidence_times = [row.get("observed_at") for row in [*listings, *ownership, annotation, supplement]]
    if annotation.get("marketapp_ui_state") in {"for_rent", "rented"} and _text(annotation.get("marketapp_ui_source")):
        evidence_times.append(annotation.get("marketapp_ui_reviewed_at"))
    historical = chosen["price_source"] == "Marketapp user view" or any(
        _newer(observed_at, chosen["price_observed_at"]) for observed_at in evidence_times)
    source = chosen["price_source"]
    if historical and source == "Marketapp listing":
        source = "Historical Marketapp listing"
    return {"price_per_day": chosen["price_per_day"], "price_source": source,
            "price_observed_at": chosen["price_observed_at"], "price_is_historical": historical}


def _https(value: Any) -> str | None:
    """Vet URL syntax without fetching or resolving remote metadata."""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 33 for char in value) or "\\" in value:
        return None
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").rstrip(".").lower()
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if not host or "%" in host or host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local", ".internal", ".lan", ".test", ".invalid")):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            if "." not in host or re.fullmatch(r"[\d.]+", host) or not re.fullmatch(r"[a-z0-9.-]+", host):
                return None
        return value
    except (ValueError, TypeError):
        return None


def _state(value: Any) -> str:
    if value in {"fixed_price_sale_contract", "listed_for_sale", "sale"}:
        return "listed_for_sale"
    return value if value in _STATES else "unknown"


def _expiry(value: Any) -> tuple[str | None, str | None]:
    try:
        if isinstance(value, bool) or int(value) <= 0:
            return None, None
        return datetime.fromtimestamp(int(value), timezone.utc).isoformat(), str(int(value))
    except (ValueError, TypeError, OverflowError, OSError):
        return None, None


def _metadata(store: Store) -> dict[str, dict]:
    result: dict[str, dict] = {}

    def remember(address, details, observed_at):
        if not isinstance(details, dict) or not address:
            return
        key = address_key(address)
        current = result.setdefault(key, {})
        if _newer(current.get("observed_at"), observed_at):
            return
        name, image = _text(details.get("name")), _https(details.get("image"))
        if name:
            current["name"] = name
        if image:
            current["image_url"] = image
        current["observed_at"] = observed_at

    for row in store.connection.execute("""SELECT body,observed_at FROM discovery_responses
        WHERE provider='toncenter' AND path='/api/v3/nft/items' AND status_code=200
        AND purpose IN ('enumeration','verification') ORDER BY id"""):
        try:
            body = json.loads(row["body"])
            if not isinstance(body, dict):
                continue
            for item in body.get("nft_items", []):
                if isinstance(item, dict):
                    remember(item.get("address"), item.get("content"), row["observed_at"])
            for address, details in (body.get("metadata") or {}).items():
                for item in details.get("token_info", []) if isinstance(details, dict) else []:
                    if isinstance(item, dict) and item.get("type") in {"nft_items", "nft_collections"} and item.get("valid") is not False:
                        remember(address, item, row["observed_at"])
        except (ValueError, TypeError, AttributeError):
            continue
    return result


def _read_reviews(directory: Path | None, wallet: str | None) -> tuple[dict[str, dict], list[str], list[str]]:
    reviews, warnings, files = {}, [], []
    if directory is None:
        return reviews, warnings, files
    directory = Path(directory)
    if not directory.is_dir():
        return reviews, ["Configured review directory does not exist"], files
    for filename in _REVIEW_FILES:
        path = directory / filename
        if not path.is_file():
            continue
        try:
            if path.resolve().parent != directory.resolve() or path.stat().st_size > 20_000_000:
                raise ValueError("Review file is outside the configured directory or too large")
            with path.open(encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if not _REQUIRED_REVIEW.issubset(reader.fieldnames or []):
                    raise ValueError("Review CSV lacks required provenance columns")
                seen = set()
                for row in reader:
                    nft = canonical_address(row["nft_address"])
                    owner = canonical_address(row["wallet_address"])
                    if owner != wallet:
                        continue
                    if nft in seen:
                        raise ValueError("Review CSV repeats an NFT address")
                    seen.add(nft)
                    if not _instant(row["observed_at"]) or not _instant(row["reviewed_at"]) or not _text(row["verification_method"]):
                        raise ValueError("Review CSV has invalid dates or verification provenance")
                    if row["category"] not in {"wallet_linked", "unresolved", *_EXCLUDED}:
                        raise ValueError("Review CSV has an unknown category")
                    if row["category"] == "wallet_linked" and address_key(row.get("recorded_owner_or_seller")) != wallet:
                        raise ValueError("Reviewed wallet link does not match the selected wallet")
                    row["source_filename"] = filename
                    previous = reviews.get(nft)
                    if previous is None or not _newer(previous["observed_at"], row["observed_at"]):
                        reviews[nft] = row
            files.append(filename)
        except (OSError, ValueError, KeyError, csv.Error) as exc:
            # Never promote partly parsed annotations from a malformed file.
            reviews = {key: value for key, value in reviews.items() if value.get("source_filename") != filename}
            warnings.append(f"Ignored {filename}: {str(exc)[:160]}")
    return reviews, warnings, files


def _supplement(directory: Path | None, wallet: str | None) -> tuple[dict[str, dict], list[str]]:
    """Recompute saved targeted evidence instead of trusting result.json booleans."""
    if directory is None:
        return {}, []
    root = Path(directory).resolve()
    folder = root / "evidence" / "live-recheck"
    if not (folder / "result.json").is_file():
        return {}, []
    try:
        documents = {}
        for filename in ("result.json", "nft-before.json", "holding-account.json", "nft-after.json"):
            path = folder / filename
            if not path.resolve().is_relative_to(root) or path.stat().st_size > 5_000_000:
                raise ValueError("Supplemental file is outside the review directory or too large")
            documents[filename] = json.loads(path.read_text(encoding="utf-8"))
        expected = documents["result.json"]
        nft = canonical_address(expected["nft_address"])
        if canonical_address(expected["wallet_address"]) != wallet:
            return {}, []
        wrappers = [documents[name] for name in ("nft-before.json", "holding-account.json", "nft-after.json")]
        for index, document in enumerate(wrappers):
            expected_path = "/api/v3/accountStates" if index == 1 else "/api/v3/nft/items"
            if document.get("provider") != "toncenter" or document.get("method") != "GET" or document.get("path") != expected_path or document.get("status_code") != 200 or not _instant(document.get("observed_at")):
                raise ValueError("Invalid supplemental provider provenance")
        before, account, after = wrappers
        if not (_instant(before["observed_at"]) <= _instant(account["observed_at"]) <= _instant(after["observed_at"])):
            raise ValueError("Supplemental observation order is invalid")
        first = next(item for item in before["body"]["nft_items"] if canonical_address(item["address"]) == nft)
        last = next(item for item in after["body"]["nft_items"] if canonical_address(item["address"]) == nft)
        holder = canonical_address(first["owner_address"])
        if holder != canonical_address(last["owner_address"]) or first["last_transaction_lt"] != last["last_transaction_lt"] or first.get("init") is not True or last.get("init") is not True:
            raise ValueError("NFT holder or logical time changed during supplemental verification")
        if canonical_address(first["collection_address"]) != canonical_address(last["collection_address"]) or canonical_address(last["collection_address"]) != canonical_address(expected["collection_address"]):
            raise ValueError("Supplemental NFT collection disagrees")
        state = next(item for item in account["body"]["accounts"] if canonical_address(item["address"]) == holder)
        decoded = decode_contract(state, nft, wallet, account["observed_at"])
        if decoded.get("verified") is not True:
            raise ValueError("Supplemental contract data did not verify")
        return {nft: {**decoded, "observed_at": after["observed_at"], "wallet_address": wallet,
                      "collection_address": canonical_address(last["collection_address"]),
                      "nft_address": nft, "supplemental_source": "evidence/live-recheck"}}, []
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as exc:
        return {}, [f"Supplemental evidence was not verified: {str(exc)[:160]}"]


def _run_summary(run: dict, kind: str, checkpoints: list[dict] | None = None) -> dict:
    mode = run.get("settings", {}).get("mode", "full_discovery") if kind == "discovery" else "market_collection"
    rows = checkpoints or []
    full = kind == "discovery" and mode != "portfolio_refresh" and {row["kind"] for row in rows} >= {"holdings", "transfers"}
    return {"id": run["id"], "kind": kind, "mode": mode, "state": run["state"],
            "reason": _text(run.get("reason")), "created_at": run.get("created_at"), "finished_at": run.get("finished_at"),
            "wallet_address": run.get("wallet_address"),
            "enumeration_complete": full and all(row["state"] == "complete" for row in rows),
            "checkpoints": [{key: row.get(key) for key in ("kind", "state", "pages", "upper_lt")} for row in rows]}


def build_dashboard(store: Store, wallet: str | None = None, review_path: Path | None = None, *, pricing_source="listings", timeframe="30d", date_from=None, date_to=None, pricing_backdrop=None) -> dict:
    """Build a JSON-safe projection without network access, DB writes, or enrollment."""
    discovery = DiscoveryStore(store)
    discovery_runs = discovery.runs()
    wallet = canonical_address(wallet) if wallet else (discovery_runs[-1]["wallet_address"] if discovery_runs else None)
    discovery_runs = [run for run in discovery_runs if run["wallet_address"] == wallet]
    latest_run = discovery_runs[-1] if discovery_runs else None
    reviews, warnings, review_files = _read_reviews(review_path, wallet)
    supplemental, supplemental_warnings = _supplement(review_path, wallet)
    warnings.extend(supplemental_warnings)
    metadata = _metadata(store)
    ownership = {}
    ownership_prices = {}
    for row in discovery.ownership_observations():
        if address_key(row.get("wallet_address")) != wallet:
            continue
        key = address_key(row["nft_address"])
        ownership_prices.setdefault(key, []).append(row)
        if key not in ownership or not _newer(ownership[key].get("observed_at"), row.get("observed_at")):
            ownership[key] = row
    candidates = {address_key(row["nft_address"]): row for row in discovery.candidates(latest_run["id"])} if latest_run else {}
    automatic = {row["nft_key"] for row in discovery.memberships(wallet)} if wallet else set()
    members = {address_key(row["nft_address"]): row for row in store.portfolio()
               if "user_declared" in row["membership_sources"] or address_key(row["nft_address"]) in automatic}
    listings = {}
    listing_prices = {}
    for observation in store.observations("listing"):
        key = address_key(observation["data"].get("nft_address"))
        listing_prices.setdefault(key, []).append(observation)
        if key not in listings or not _newer(listings[key]["observed_at"], observation["observed_at"]):
            listings[key] = observation
    collection_names = {address_key(row["data"].get("collection_address")): _text(row["data"].get("name")) for row in store.records("collection")}
    all_keys = set(members) | set(ownership) | set(candidates) | set(reviews) | set(supplemental)
    gifts = []
    for key in all_keys:
        member, db, annotation, supplement, candidate = members.get(key, {}), ownership.get(key, {}), reviews.get(key, {}), supplemental.get(key, {}), candidates.get(key, {})
        is_member = bool(member)
        review_current = bool(annotation and not _newer(db.get("observed_at"), annotation.get("observed_at")))
        review_linked = annotation.get("category") == "wallet_linked"
        is_portfolio = is_member or review_linked or bool(supplement.get("verified"))
        if not is_portfolio:
            if review_current and annotation.get("category") in _EXCLUDED:
                continue
            if not annotation and candidate.get("reason") in {"unsupported_collection", "owner_mismatch", "different_holder_or_beneficiary", "other_wallet_holder"}:
                continue
            if not candidate and not annotation and not db:
                continue
        chosen = db
        method = "automatic" if db else "user_declared" if is_member else "unresolved"
        proof = []
        uncertainties = []
        state = _state(db.get("rental_state")) if db.get("verified") is True else ("uncertain" if is_portfolio else "unknown")
        if review_current:
            chosen = {**db, **annotation}
            state = _state(annotation.get("state")) if review_linked else "unknown"
            method = "local_review_annotation"
            proof.append("Dated local review")
            uncertainties.append("Local review annotations do not create automatic portfolio membership")
        if supplement and not _newer(chosen.get("observed_at"), supplement.get("observed_at")):
            chosen = {**chosen, **supplement}
            state = _state(supplement.get("rental_state"))
            method = "validated_supplemental_evidence"
            proof.append("Validated supplemental evidence")
        elif supplement:
            proof.append("Historical supplemental evidence")
            uncertainties.append("A later ownership observation supersedes the saved supplemental verification")
        collection_conflict = bool(member.get("collection_conflict") or
                                   (candidate.get("reason") == "collection_conflict" and candidate.get("verified") is False))
        if collection_conflict:
            state = "uncertain" if is_portfolio else "unknown"
            uncertainties.append("Conflicting collection evidence")
        if annotation and not review_current:
            proof.append("Historical review")
            uncertainties.append("A later database observation supersedes the local review")
        if key in automatic:
            proof.append("Automatic portfolio member")
        if db.get("verified") and method == "automatic":
            proof.append("Verified TON observation")
        if latest_run and db and db.get("run_id") != latest_run["id"]:
            uncertainties.append("Not yet reverified in the latest discovery or refresh run")
        if db and db.get("verified") is not True and not review_current and method != "validated_supplemental_evidence":
            uncertainties.append("Latest ownership verification did not succeed")
        nft = member.get("nft_address") or chosen.get("nft_address") or key
        collection = None if collection_conflict else (chosen.get("collection_address") or member.get("collection_address"))
        info = metadata.get(key, {})
        listing = listings.get(key, {})
        listing_data = listing.get("data", {})
        name = _text(annotation.get("name")) or _text(listing_data.get("nft_name")) or info.get("name") or _text(member.get("label")) or _text(chosen.get("label")) or "Unresolved gift"
        ui_state = None
        market_observed_at = None
        if review_current and annotation.get("marketapp_ui_state") in {"for_rent", "rented"} and _instant(annotation.get("marketapp_ui_reviewed_at")) and _text(annotation.get("marketapp_ui_source")):
            ui_state = annotation["marketapp_ui_state"]
            market_observed_at = annotation["marketapp_ui_reviewed_at"]
            proof.append("User-supplied Marketapp view")
        if listing and not _newer(chosen.get("observed_at"), listing["observed_at"]):
            if not market_observed_at or _newer(listing["observed_at"], market_observed_at):
                ui_state, market_observed_at = "for_rent", listing["observed_at"]
                proof.append("Marketapp listing observation")
        if state not in {"idle_rental_contract", "unknown", "held_directly"} and ui_state == "for_rent":
            ui_state = None
        if state not in {"rented", "expired_pending_return"} and ui_state == "rented":
            ui_state = None
        if collection_conflict:
            ui_state = None
        price_evidence = _price_observation(listing_prices.get(key, []), annotation, ownership_prices.get(key, []), supplement)
        if price_evidence["price_is_historical"]:
            if price_evidence["price_source"] == "Marketapp user view":
                uncertainties.append("The asking price comes from a dated user-supplied Marketapp view")
            else:
                uncertainties.append("The displayed price predates newer evidence and is retained as a historical observation")
        expiry, expiry_raw = _expiry(chosen.get("rental_until") or chosen.get("rental_until_unix_seconds"))
        sources = list(member.get("membership_sources", []))
        if review_linked:
            sources.append("local_review")
        if supplement:
            sources.append("supplemental_evidence")
        display = {"held_directly": "Held directly", "idle_rental_contract": "Idle rental contract", "rented": "Rented",
                   "expired_pending_return": "Expired; return unconfirmed", "listed_for_sale": "For sale",
                   "unknown": "Unknown", "uncertain": "Needs verification"}[state]
        if ui_state == "for_rent":
            display = "For rent"
        try:
            explorer = "https://tonviewer.com/" + preferred_address(canonical_address(nft))
        except ValueError:
            explorer = None
        gifts.append({
            "id": key, "nft_address": nft, "name": name, "label": member.get("label"),
            "collection_name": _text(annotation.get("collection_name")) or collection_names.get(address_key(collection)) or metadata.get(address_key(collection), {}).get("name"),
            "collection_address": collection, "image_url": info.get("image_url"),
            "collection_conflict": collection_conflict,
            "collection_addresses": member.get("collection_addresses", [collection] if collection else []),
            "state": state, "display_state": display, "ui_state": ui_state,
            "category": "portfolio" if is_portfolio else "unresolved", "is_portfolio": is_portfolio,
            "automatic_membership": key in automatic, "membership_sources": sorted(set(sources)),
            "verification_method": method, "proof_badges": list(dict.fromkeys(proof)),
            **price_evidence, "price_unit": "GRAM" if price_evidence["price_per_day"] is not None else None,
            "rental_until": expiry, "rental_until_unix_seconds": expiry_raw,
            "observed_at": chosen.get("observed_at"), "market_observed_at": market_observed_at,
            "last_listing_observed_at": listing.get("observed_at"), "explorer_url": explorer,
            "review_stale": bool(annotation and not review_current),
            "review_source_filename": annotation.get("source_filename"), "review_method": _text(annotation.get("verification_method")),
            "reviewed_at": annotation.get("reviewed_at"), "review_as_of": annotation.get("observed_at"),
            "holding_contract": chosen.get("holding_contract") or chosen.get("holder_address"),
            "reason": _text(chosen.get("reason") or chosen.get("review_reason") or candidate.get("reason")),
            "code_hash": chosen.get("code_hash"), "decoder_version": chosen.get("decoder_version"),
            "uncertainties": uncertainties,
        })
    gifts.sort(key=lambda row: (not row["is_portfolio"], row["name"].casefold(), row["id"]))
    enrich_rental_counts(store, gifts)
    pricing_summary = enrich_pricing(store, gifts, wallet, source=pricing_source, timeframe=timeframe, date_from=date_from, date_to=date_to, backdrop=pricing_backdrop)
    portfolio = [gift for gift in gifts if gift["is_portfolio"]]
    summary = {"portfolio_count": len(portfolio), "automatic_count": sum(gift["automatic_membership"] for gift in portfolio),
               "review_count": sum("local_review" in gift["membership_sources"] and not gift["automatic_membership"] for gift in portfolio),
               "for_rent_count": sum(gift["ui_state"] == "for_rent" for gift in portfolio),
               "idle_count": sum(gift["state"] == "idle_rental_contract" for gift in portfolio),
               "rented_count": sum(gift["state"] == "rented" for gift in portfolio),
               "direct_count": sum(gift["state"] == "held_directly" for gift in portfolio),
               "sale_count": sum(gift["state"] == "listed_for_sale" for gift in portfolio),
               "unresolved_count": sum(not gift["is_portfolio"] for gift in gifts),
               "uncertain_count": sum(gift["state"] in {"unknown", "uncertain", "expired_pending_return"} for gift in portfolio)}
    market_runs = store.runs()
    runs = {"discovery": [_run_summary(run, "discovery", discovery.checkpoints(run["id"])) for run in discovery_runs],
            "market": [_run_summary(run, "market") for run in market_runs]}
    activity = []
    named = {gift["id"]: gift for gift in gifts}
    for key, observation in ownership.items():
        if key in named:
            activity.append({"id": f"ownership-{observation['id']}", "type": "ownership", "title": "Ownership observation",
                             "name": named[key]["name"], "nft_address": key, "state": observation.get("rental_state"),
                             "observed_at": observation.get("observed_at"), "source": "TON Center",
                             "verified": observation.get("verified"), "reason": _text(observation.get("reason"))})
    for observation in store.observations("history"):
        data = observation["data"]
        key = address_key(data.get("nft_address"))
        if key in named and named[key]["is_portfolio"]:
            activity.append({"id": f"history-{observation['id']}", "type": "portfolio_gift_history", "title": "Portfolio gift history",
                             "name": named[key]["name"], "nft_address": key, "observed_at": observation["observed_at"],
                             "source": "Marketapp", "price": _decimal(data.get("price")), "currency": _text(data.get("currency")),
                             "note": "Gift history does not establish proceeds received by this wallet"})
    activity.sort(key=lambda row: _instant(row.get("observed_at")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    latest_discovery = runs["discovery"][-1] if runs["discovery"] else None
    return {"wallet": wallet, "generated_at": utc_now(), "summary": summary, "gifts": gifts, "pricing": pricing_summary, "activity": activity[:100], "runs": runs,
            "coverage": {"latest_discovery": latest_discovery, "latest_market": runs["market"][-1] if runs["market"] else None,
                         "enumeration_complete": bool(latest_discovery and latest_discovery["enumeration_complete"]),
                         "note": "Observations have individual timestamps. Portfolio refresh is not a full wallet enumeration.",
                         "pending_verification_count": sum(row["state"] == "pending" for row in candidates.values())},
            "review": {"enabled": review_path is not None, "files": review_files, "warnings": warnings,
                       "note": "Explicit local review annotations are separate from automatic database membership"}}
