"""Write private parity expectations from the source SQLite database, offline."""
import argparse
import json
from pathlib import Path
from datetime import datetime

from marketapp_rent.serverless_export import readonly_store
from marketapp_rent.pricing import enrich_pricing
from marketapp_rent.rental_counts import enrich_rental_counts

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--db', required=True, type=Path)
parser.add_argument('--manifest', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
manifest = json.loads(args.manifest.read_text())
rows = [r for part in manifest['chunks'] for r in json.loads((args.manifest.parent / part['file']).read_text(encoding='utf8'))['records']]
gifts = [r['record'] for r in rows if r['kind'] == 'portfolio']
wallet = next(r['record']['wallet'] for r in rows if r['kind'] == 'settings')
now = datetime.fromisoformat(manifest['comparison_to'])
cases = []
with readonly_store(args.db) as store:
    for source in ('listings', 'rentals'):
        for backdrop in (None, 'Black'):
            copied = json.loads(json.dumps(gifts))
            summary = enrich_pricing(store, copied, wallet, now=now, source=source, timeframe='30d', backdrop=backdrop)
            enrich_rental_counts(store, copied)
            cases.append({'selection': {'source': source, 'timeframe': '30d', 'backdrop': backdrop},
                          'pricing': summary, 'gifts': copied})
args.out.write_text(json.dumps({'now': now.isoformat(), 'cases': cases}), encoding='utf8')
print(f'Wrote {len(cases)} offline pricing comparisons for {len(gifts)} gifts.')
