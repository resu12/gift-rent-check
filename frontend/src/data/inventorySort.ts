import type { Gift } from './types.ts';
import { rentedImageMark } from './rentedImageMark.ts';

export type InventorySort = 'default' | 'name_asc' | 'price_desc' | 'price_asc' | 'last_rented' | 'rental_ending';

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
interface Decimal { coefficient: bigint; scale: number }

function currentPrice(gift: Gift): Decimal | null {
  if (!['GRAM', 'GRAM/day'].includes(gift.price_unit ?? '') || gift.price_is_historical === true || gift.collection_conflict === true ||
      typeof gift.price_source !== 'string' || !gift.price_source.trim() || typeof gift.price_per_day !== 'string' || gift.price_per_day.length > 2000) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(gift.price_per_day);
  if (!match) return null;
  const exponent = Number(match[4] || '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const fraction = match[3] || '';
  let coefficient = BigInt(`${match[1]}${match[2]}${fraction}`), scale = fraction.length - exponent;
  if (coefficient < 0n) return null;
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

function compareDecimal(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const first = left.coefficient * 10n ** BigInt(scale - left.scale), second = right.coefficient * 10n ** BigInt(scale - right.scale);
  return first < second ? -1 : first > second ? 1 : 0;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return null;
  const calendar = Date.parse(`${match[1]}T00:00:00Z`), parsed = Date.parse(value);
  return Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0, 10) === match[1] && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function lastRental(gift: Gift, now: number): number | null {
  const history = gift.rental_history;
  const recorded = history?.coverage === 'partial' && Number.isSafeInteger(history.recorded_count) && (history.recorded_count ?? 0) > 0
    ? instant(history.last_rental_at) : null;
  // The server validates contract identity and accumulated duration before
  // exposing this timestamp. Expiry alone and refresh time are not starts.
  const current = gift.current_rental_start_source === 'verified_contract' && gift.is_portfolio && gift.category === 'portfolio'
    && gift.status_is_historical === false && gift.collection_conflict !== true && ['rented', 'expired_pending_return'].includes(gift.state)
    && (!gift.ui_state || gift.ui_state === 'rented') ? instant(gift.current_rental_started_at) : null;
  // A later status refresh can leave the current term uncertain without
  // invalidating a rental start that the server previously verified.
  const previous = gift.last_verified_rental_start_source === 'verified_contract' && gift.is_portfolio && gift.category === 'portfolio'
    && gift.collection_conflict !== true ? instant(gift.last_verified_rental_started_at) : null;
  const known = [recorded, current, previous].filter((value): value is number => value !== null && value <= now);
  return known.length ? Math.max(...known) : null;
}

function rentalEnd(gift: Gift, now: number): number | null {
  const mark = rentedImageMark(gift, now);
  if (mark?.expiresAt === null || mark?.expiresAt === undefined) return null;
  // The display helper already gates ownership/state and explicit seconds. Its
  // ISO fallback additionally needs strict calendar validation before sorting.
  if (gift.rental_until_unix_seconds == null && instant(gift.rental_until) !== mark.expiresAt) return null;
  return mark.expiresAt;
}

function compareKnown<T>(left: T | null, right: T | null, compare: (left: T, right: T) => number): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  return compare(left, right);
}
const name = (gift: Gift) => typeof gift.name === 'string' && gift.name.trim() ? gift.name.trim() : null;

/** Sort saved inventory evidence only; unknown values stay last in either direction. */
export function sortInventoryGifts(gifts: Gift[], sort: InventorySort, now = Date.now()): Gift[] {
  if (sort === 'default') return [...gifts];
  const timed = Number.isSafeInteger(now) && now >= 0;
  return gifts.map((gift, index) => ({ gift, index, name: name(gift),
    price: sort === 'price_desc' || sort === 'price_asc' ? currentPrice(gift) : null,
    date: timed ? sort === 'last_rented' ? lastRental(gift, now) : sort === 'rental_ending' ? rentalEnd(gift, now) : null : null,
  })).sort((left, right) => {
    const byName = () => compareKnown(left.name, right.name, (first, second) => names.compare(first, second)) || left.index - right.index;
    if (sort === 'name_asc') return byName();
    if (sort === 'price_asc' || sort === 'price_desc') return compareKnown(left.price, right.price,
      (first, second) => (sort === 'price_desc' ? -1 : 1) * compareDecimal(first, second)) || byName();
    if (sort === 'last_rented' || sort === 'rental_ending') return compareKnown(left.date, right.date,
      (first, second) => sort === 'last_rented' ? second - first : first - second) || byName();
    return left.index - right.index;
  }).map(item => item.gift);
}
