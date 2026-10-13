import type { Gift, MarketappTopItem, MarketappTopItems, PersonalRentalAnalyticsReport } from './types.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';
import { validAnalyticsCapture } from './analyticsClock.ts';

export type TopItemSort = 'volume' | 'rentals' | 'days' | 'name';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const decimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && /^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value);
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function marketappItemUrl(item: MarketappTopItem): string | null {
  const address = /^https:\/\/marketapp\.org\/nft\/([A-Za-z0-9_-]{48})\/$/.exec(item.item_url || '')?.[1];
  const key = canonicalMainnetAddress(item.item_key);
  return address && key && key === canonicalMainnetAddress(address) ? item.item_url : null;
}

/** A personal report is never filled with public collection-history figures. */
export function marketappTopItems(report: PersonalRentalAnalyticsReport | null | undefined, wallet: string | null, now = Date.now()): MarketappTopItems | null {
  const identity = canonicalMainnetAddress(wallet), top = report?.top_items;
  if (!report || !identity || canonicalMainnetAddress(report.wallet) !== identity || !top || top.status !== 'available' || !Array.isArray(top.items)) return null;
  const allTime = 'report_kind' in report && report.report_kind === 'all_time';
  if (top.scope !== (allTime ? 'saved_non_overlapping_reports' : 'marketapp_top_items') || (allTime && top.incomplete !== true) ||
    !date(report.period_start) || !date(report.period_end) || report.period_start > report.period_end ||
    !validAnalyticsCapture(report.captured_at, now)) return null;
  const seen = new Set<string>();
  for (const item of top.items) {
    if (!item || !marketappItemUrl(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 ||
      !number(item.rentals) || !decimal(item.rented_days) || !decimal(item.volume) || (item.price_per_day !== null && !decimal(item.price_per_day))) return null;
    const key = canonicalMainnetAddress(item.item_key)!;
    if (seen.has(key)) return null; seen.add(key);
    if (allTime) {
      const coverage = item.coverage;
      if (!coverage || !number(coverage.observed_days) || !number(coverage.missing_days) || !number(coverage.partial_days) ||
        !coverage.observed_days || !Array.isArray(coverage.periods) || !coverage.periods.length || !item.captured_at ||
        !validAnalyticsCapture(item.captured_at, now)) return null;
      let last = '';
      for (const period of coverage.periods) {
        if (!date(period.period_start) || !date(period.period_end) || period.period_start > period.period_end || period.period_start <= last ||
          !validAnalyticsCapture(period.captured_at, now)) return null;
        last = period.period_end;
      }
    }
  }
  return top;
}

/** Gift details always use the retained All time report, independently of the Overview selection. */
export function giftAllTimeAnalytics(gift: Pick<Gift, 'nft_address'>, report: PersonalRentalAnalyticsReport | null | undefined, wallet: string | null, now = Date.now()): MarketappTopItem | null {
  const address = canonicalMainnetAddress(gift.nft_address);
  if (!address || !report || !('report_kind' in report) || report.report_kind !== 'all_time') return null;
  return marketappTopItems(report, wallet, now)?.items.find(item => canonicalMainnetAddress(item.item_key) === address) ?? null;
}

function scaled(value: string) { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')); }
function compare(left: string, right: string) { const a = scaled(left), b = scaled(right); return a < b ? 1 : a > b ? -1 : 0; }
export function sortTopItems(items: MarketappTopItem[], query = '', sort: TopItemSort = 'volume'): MarketappTopItem[] {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => !search || item.name.toLocaleLowerCase().includes(search)).sort((a, b) => {
    const value = sort === 'volume' ? compare(a.volume, b.volume) : sort === 'days' ? compare(a.rented_days, b.rented_days) : sort === 'rentals' ? b.rentals - a.rentals : 0;
    return value || names.compare(a.name, b.name) || a.item_key.localeCompare(b.item_key);
  });
}
