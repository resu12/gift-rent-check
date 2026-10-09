import type { Gift, Job, PricingBasis } from './types.ts';

export type GiftFilter = 'all' | 'for_rent' | 'rented' | 'direct' | 'idle' | 'sale' | 'review';

export function giftGroup(gift: Gift): Exclude<GiftFilter, 'all'> {
  const state = `${gift.ui_state} ${gift.state}`.toLowerCase();
  if (gift.category === 'unresolved' || /unresolved|conflict|expired/.test(state)) return 'review';
  if (/sale|auction/.test(state)) return 'sale';
  if (gift.ui_state === 'for_rent') return 'for_rent';
  if (/unknown|uncertain|review/.test(state)) return 'review';
  if (/for_rent|available/.test(state)) return 'for_rent';
  if (/rented|active_rental/.test(state)) return 'rented';
  if (/idle/.test(state)) return 'idle';
  if (/direct|wallet/.test(state)) return 'direct';
  return 'review';
}

export function filterGifts(gifts: Gift[], search: string, state: GiftFilter, collection: string): Gift[] {
  const needle = search.trim().toLocaleLowerCase();
  return gifts.filter(gift => {
    const matchesSearch = !needle || [gift.name, gift.nft_address, gift.collection_name, gift.collection_address, gift.model, gift.backdrop]
      .some(value => value?.toLocaleLowerCase().includes(needle));
    return matchesSearch && (state === 'all' || giftGroup(gift) === state) &&
      (!collection || gift.collection_address === collection || (!gift.collection_address && gift.collection_name === collection));
  });
}

export type PricingFilter = 'all' | 'ready' | 'missing' | 'black';
export type PricingSort = 'default' | 'gap' | 'increase' | 'decrease';
export interface PricingFilters { search: string; collection: string; filter: PricingFilter; sort: PricingSort }

export function isExactBlack(gift: Gift): boolean { return gift.backdrop === 'Black'; }

export function hasRecommendation(gift: Gift): boolean {
  return gift.pricing?.daily_comparable !== false && gift.pricing?.recommended_price_per_day != null;
}

export function pricingBasisLabel(basis: PricingBasis | null | undefined, backdrop?: 'Black'): string {
  if (backdrop === 'Black') return basis === 'collection' ? 'Collection + Black' : basis ? 'Exact model + Black' : 'Not enough samples';
  return basis === 'model_black' ? 'Same model + Black' : basis === 'model' ? 'Exact model' : basis === 'collection' ? 'Collection' : 'Not enough samples';
}

export function filterPricingGifts(gifts: Gift[], search: string, collection: string, filter: PricingFilter): Gift[] {
  return filterGifts(gifts, search, 'all', collection).filter(gift => gift.is_portfolio &&
    (filter === 'all' || (filter === 'ready' && hasRecommendation(gift)) ||
      (filter === 'missing' && !hasRecommendation(gift)) || (filter === 'black' && isExactBlack(gift))));
}

interface ExactDecimal { coefficient: bigint; scale: number }

function exactDecimal(value: string | null | undefined): ExactDecimal | null {
  if (value == null || value.length > 2000) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  const exponent = Number(match[4] || '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const fraction = match[3] || '';
  let coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

function decimalText({ coefficient, scale }: ExactDecimal): string {
  if (coefficient === 0n) return '0';
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const amount = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return `${negative ? '-' : ''}${amount}`;
}

// The current price field is already per day; its unit records the currency.
export function priceDifference(gift: Gift): string | null {
  if (!hasRecommendation(gift) || !['GRAM', 'GRAM/day'].includes(gift.price_unit || '') ||
      (gift.pricing?.unit != null && gift.pricing.unit !== 'GRAM/day')) return null;
  const asking = exactDecimal(gift.price_per_day);
  const suggested = exactDecimal(gift.pricing?.recommended_price_per_day);
  if (!asking || !suggested || asking.coefficient < 0n || suggested.coefficient < 0n) return null;
  const scale = Math.max(asking.scale, suggested.scale);
  return decimalText({ scale, coefficient:
    suggested.coefficient * 10n ** BigInt(scale - suggested.scale) -
    asking.coefficient * 10n ** BigInt(scale - asking.scale) });
}

export function formatPriceDifference(value: string | null): string {
  const decimal = exactDecimal(value);
  if (!decimal) return '—';
  const formatted = formatAmount(decimalText(decimal));
  return decimal.coefficient > 0n && formatted !== '0.000' ? `+${formatted}` : formatted;
}

export function sortPricingGifts(gifts: Gift[], sort: PricingSort): Gift[] {
  if (sort === 'default') return [...gifts];
  return gifts.map((gift, index) => ({ gift, index, difference: exactDecimal(priceDifference(gift)) }))
    .sort((a, b) => {
      if (!a.difference || !b.difference) return a.difference ? -1 : b.difference ? 1 : a.index - b.index;
      const scale = Math.max(a.difference.scale, b.difference.scale);
      let left = a.difference.coefficient * 10n ** BigInt(scale - a.difference.scale);
      let right = b.difference.coefficient * 10n ** BigInt(scale - b.difference.scale);
      if (sort === 'gap') { left = left < 0n ? -left : left; right = right < 0n ? -right : right; }
      const comparison = left < right ? -1 : left > right ? 1 : 0;
      return (sort === 'decrease' ? comparison : -comparison) || a.index - b.index;
    }).map(item => item.gift);
}

export function shorten(value: string | null | undefined, width = 6): string {
  if (!value) return 'Not available';
  return value.length > width * 2 + 3 ? `${value.slice(0, width)}…${value.slice(-width)}` : value;
}

export function formatAmount(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  // Round the display half up to three places without a lossy Number conversion.
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  let thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  if (fraction.length > 3 && fraction[3] >= '5') thousandths += 1n;
  const integer = (thousandths / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimal = (thousandths % 1000n).toString().padStart(3, '0');
  return `${negative && thousandths !== 0n ? '-' : ''}${integer}.${decimal}`;
}

export function dateTime(value: string | number | null | undefined, compact = false): string {
  if (value == null || value === '') return 'Not observed';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return 'Not observed';
  return new Intl.DateTimeFormat(undefined, compact
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'No observation yet';
  const age = now - new Date(value).getTime();
  if (!Number.isFinite(age)) return 'No observation yet';
  if (age < 60_000) return 'Just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

export function isActiveJob(job: Job): boolean { return job.state === 'queued' || job.state === 'running'; }

export function humanize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/^\w/, character => character.toUpperCase());
}

export function safeExternalUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; }
  catch { return undefined; }
}
