"""Regenerate the public synthetic JS parity fixture with the Python engine.

Run from the project root using the Python 3.12 virtual environment. No private
database, credentials, provider requests, or wallet data are read.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]
from marketapp_rent.pricing import enrich_pricing
from marketapp_rent.rental_counts import enrich_rental_counts
from marketapp_rent.storage import Store
from test_pricing import addr, attributes, gift, listing, listings, ton_traits, COLLECTION
from test_rental_pricing import event, history

NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
RECENT = "2026-10-08T11:00:00+00:00"


def main():
    temporary_root = ROOT / ".tmp"
    temporary_root.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="cloud-pricing-parity-", dir=temporary_root) as directory, Store(Path(directory) / "fixture.sqlite3") as store:
        gifts = [gift(), gift(addr(10)), gift(addr(99), is_portfolio=False)]
        ton_traits(store)
        rows = [{"kind": "portfolio", "observed_at": RECENT, "record": item} for item in gifts]
        rows.append({"kind": "metadata", "observed_at": RECENT, "record": {
            "nft_address": addr(2), "collection_address": COLLECTION,
            "attributes": attributes(), "source": "TON metadata",
        }})
        values = [listing(n, str((n - 9) * 100000000), model="Ruby" if n < 16 else "Other",
                          backdrop="Black" if n < 13 or n >= 16 else "Onyx Black") for n in range(10, 19)]
        listings(store, values)
        listings(store, [listing(10, "900000000")], when="2026-10-06T09:00:00+00:00")
        listings(store, [listing(22, "500000000")], filters={"model": "Ruby", "backdrop": "Black"})
        rentals = [event(n, price=str((n - 9) / 10), duration=86400, tx_hash="shared-hash") for n in range(10, 19)]
        history(store, rentals)
        history(store, rentals)
        history(store, [event(10, ts=int(NOW.timestamp()) - 2 * 86400, duration=7 * 86400, price="1")])
        history(store, [event(10, ts=int(NOW.timestamp()) - 4 * 86400, is_extend=True)])
        history(store, [event(23, price="1", price_nano="1"), event(24, currency="TON"), event(25, duration=0)])
        history(store, [event(26), event(26, price="0.9")])
        for kind in ("listing", "history"):
            rows.extend({"kind": kind, "observed_at": observation["observed_at"], "record": observation}
                        for observation in store.observations(kind))
        cases = []
        selections = [{"source": source, "timeframe": frame, "backdrop": backdrop}
                      for source in ("listings", "rentals") for frame in ("24h", "30d") for backdrop in (None, "Black")]
        selections += [{"source": source, "timeframe": "custom", "date_from": "2026-10-06", "date_to": "2026-10-06"}
                       for source in ("listings", "rentals")]
        for selection in selections:
            subjects = deepcopy(gifts)
            summary = enrich_pricing(store, subjects, now=NOW, **selection)
            enrich_rental_counts(store, subjects, now=NOW)
            cases.append({"selection": selection, "pricing": summary, "gifts": subjects})
        destination = Path(__file__).parent / "fixtures" / "cloud-pricing-parity.json"
        destination.parent.mkdir(exist_ok=True)
        destination.write_text(json.dumps({"now": NOW.isoformat(), "records": rows, "cases": cases}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {len(cases)} synthetic parity cases with {len(rows)} records.")


if __name__ == "__main__":
    main()
