import type { MarketappCollection, MarketappCollections, PersonalRentalAnalyticsReport } from './types.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';
import { validAnalyticsCapture } from './analyticsClock.ts';

export type CollectionAnalyticsSort = 'volume' | 'rentals' | 'name';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const decimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && /^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value);
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Collection totals come from the provider's complete table, never a sum of its Top items. */
export function marketappCollections(report: PersonalRentalAnalyticsReport | null | undefined, wallet: string | null, now = Date.now()): MarketappCollections | null {
  const identity = canonicalMainnetAddress(wallet), collections = report?.by_collection;
  if (!report || !identity || canonicalMainnetAddress(report.wallet) !== identity || !collections || collections.status !== 'available' || !Array.isArray(collections.items)) return null;
  const allTime = 'report_kind' in report && report.report_kind === 'all_time';
  if ((!allTime && collections.items.length > 200) || collections.scope !== (allTime ? 'saved_non_overlapping_reports' : 'marketapp_by_collection') || (allTime && collections.incomplete !== true) ||
    !date(report.period_start) || !date(report.period_end) || report.period_start > report.period_end || !validAnalyticsCapture(report.captured_at, now)) return null;
  const seen = new Set<string>();
  for (const item of collections.items) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || /[\u0000-\u001f\u007f]/.test(item.name) ||
      item.collection_key !== `name:${item.name.trim().replace(/\s+/g, ' ').toLowerCase()}` || seen.has(item.collection_key) ||
      !number(item.rentals) || !decimal(item.volume) || (item.price_per_day !== null && !decimal(item.price_per_day))) return null;
    seen.add(item.collection_key);
    if (allTime) {
      const coverage = item.coverage;
      if (!coverage || !number(coverage.observed_days) || !number(coverage.missing_days) || !number(coverage.partial_days) ||
        !coverage.observed_days || coverage.partial_days > coverage.observed_days || !Array.isArray(coverage.periods) || !coverage.periods.length ||
        !validAnalyticsCapture(item.captured_at, now)) return null;
      let last = '';
      for (const period of coverage.periods) {
        if (!date(period.period_start) || !date(period.period_end) || period.period_start > period.period_end || period.period_start <= last ||
          !validAnalyticsCapture(period.captured_at, now)) return null;
        last = period.period_end;
      }
    }
  }
  return collections;
}

function scaled(value: string) { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')); }
export function sortCollectionAnalytics(items: MarketappCollection[], query = '', sort: CollectionAnalyticsSort = 'volume'): MarketappCollection[] {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => !search || item.name.toLocaleLowerCase().includes(search)).sort((a, b) => {
    const left = sort === 'volume' ? scaled(a.volume) : BigInt(a.rentals), right = sort === 'volume' ? scaled(b.volume) : BigInt(b.rentals);
    const value = sort === 'name' ? 0 : left > right ? -1 : left < right ? 1 : 0;
    return value || names.compare(a.name, b.name) || a.collection_key.localeCompare(b.collection_key);
  });
}
