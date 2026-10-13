import type { Gift, GiftRentalStatistics } from './types.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';
import { formatAmount } from './helpers.ts';

export type GiftRentalSort = 'volume' | 'rentals' | 'recent' | 'name';
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000 && /^\d+(?:\.\d+)?$/.test(value);
const date = (value: unknown, now: number): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 && time <= now && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10) ? time : null;
};

/** Only the dedicated, source-validated projection can supply these statistics. */
export function giftRentalStatistics(gift: Gift, now = Date.now()): GiftRentalStatistics | null {
  const stats = gift.rental_statistics;
  if (!gift.is_portfolio || gift.collection_conflict || !stats || stats.version !== 1 ||
    stats.semantics_version !== 'saved-gift-rental-statistics-v1' || stats.coverage !== 'partial' ||
    !count(stats.observed_rentals) || stats.observed_rentals === 0 || !count(stats.verified_rentals_without_history) ||
    stats.verified_rentals_without_history > stats.observed_rentals ||
    date(stats.observed_at, now) === null || date(stats.first_rental_at, now) === null || date(stats.last_rental_at, now) === null ||
    Date.parse(stats.first_rental_at!) > Date.parse(stats.last_rental_at!) || Date.parse(stats.last_rental_at!) > Date.parse(stats.observed_at!)) return null;
  if (stats.recorded_rentals === null || stats.recorded_rentals === 0) {
    if (stats.verified_rentals_without_history !== stats.observed_rentals || stats.recorded_volume !== null || stats.average_daily_rate !== null || stats.rental_days !== null) return null;
  } else if (!count(stats.recorded_rentals) || !amount(stats.recorded_volume) || !amount(stats.average_daily_rate) || !amount(stats.rental_days) ||
    !/[1-9]/.test(stats.rental_days) || stats.observed_rentals > stats.recorded_rentals + stats.verified_rentals_without_history) return null;
  return stats;
}

export const giftRentalAmount = (value: string | null | undefined, places: 1 | 3 = 1): string => amount(value) ? formatAmount(value, places) : '—';

function compareAmount(left: string, right: string): number {
  const [li, lf = ''] = left.split('.'), [ri, rf = ''] = right.split('.');
  const digits = Math.max(lf.length, rf.length);
  const a = BigInt(li + lf.padEnd(digits, '0')), b = BigInt(ri + rf.padEnd(digits, '0'));
  return a < b ? -1 : a > b ? 1 : 0;
}
function knownFirst<T>(left: T | null, right: T | null, compare: (a: T, b: T) => number) {
  return left === null || right === null ? left === right ? 0 : left === null ? 1 : -1 : compare(left, right);
}

/** Sort exact saved figures, never rounded labels; unknown history stays last. */
export function rentalStatisticsRows(gifts: Gift[], query = '', sort: GiftRentalSort = 'volume', now = Date.now()) {
  const unique = new Map<string, { gift: Gift; stats: GiftRentalStatistics | null }>();
  for (const gift of gifts) {
    if (!gift.is_portfolio) continue;
    const key = canonicalMainnetAddress(gift.nft_address) || gift.nft_address || gift.id;
    const stats = giftRentalStatistics(gift, now), previous = unique.get(key);
    if (!previous || (date(stats?.observed_at, now) ?? -1) > (date(previous.stats?.observed_at, now) ?? -1)) unique.set(key, { gift, stats });
  }
  const search = query.trim().toLocaleLowerCase();
  return [...unique.values()].filter(({ gift }) => !search || [gift.name, gift.collection_name, gift.nft_address].some(value => value?.toLocaleLowerCase().includes(search)))
    .sort((left, right) => {
      const compared = sort === 'volume' ? knownFirst(left.stats?.recorded_volume ?? null, right.stats?.recorded_volume ?? null, (a, b) => -compareAmount(a, b))
        : sort === 'rentals' ? knownFirst(left.stats?.observed_rentals ?? null, right.stats?.observed_rentals ?? null, (a, b) => b - a)
          : sort === 'recent' ? knownFirst(date(left.stats?.last_rental_at, now), date(right.stats?.last_rental_at, now), (a, b) => b - a) : 0;
      return compared || names.compare(left.gift.name || '', right.gift.name || '') || left.gift.id.localeCompare(right.gift.id);
    });
}
