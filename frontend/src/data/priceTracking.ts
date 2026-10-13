import { formatAmount } from './helpers.ts';
import type { Gift, GiftPriceTrackingData, ObservedPriceChange, PriceTrackingComparison, PriceTrackingPeriod } from './types.ts';

export type TrackingPeriod = 7 | 14 | 30;
export const TRACKING_PERIODS: readonly TrackingPeriod[] = [7, 14, 30];

/** The dashboard's monetary evidence stays decimal text; round only its label. */
export function trackingAmount(value: string | null | undefined, places: 1 | 3 = 3): string {
  if (typeof value !== 'string' || value.length > 2000 || !/^\d+(?:\.\d+)?$/.test(value)) return '—';
  return formatAmount(value, places);
}

export function trackingCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
}

/** The server deduplicates verified starts against history. Never add the counts again in the view. */
export function trackingObservedRentals(period: PriceTrackingPeriod): string {
  return trackingCount(period.observed_rentals === undefined ? period.recorded_rentals : period.observed_rentals);
}

export function trackingPaymentHistoryPending(period: PriceTrackingPeriod): boolean {
  const count = period.verified_rentals_without_history;
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
}

/** An observed start with no payment record cannot be presented as a zero payment. */
export function trackingPaymentAmount(period: PriceTrackingPeriod, value: string | null, places: 1 | 3 = 3): string {
  return trackingPaymentHistoryPending(period) && period.recorded_rentals === 0 ? '—' : trackingAmount(value, places);
}

/** Comparison boundaries are UTC even when an observation is shown in local time. */
export function trackingDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

export function trackingDateRange(from: string | null | undefined, to: string | null | undefined): string {
  const start = trackingDate(from), end = trackingDate(to);
  return start === '—' || end === '—' ? 'Dates unavailable' : start === end ? start : `${start} – ${end}`;
}

export interface GiftPriceChange { gift: Gift; change: ObservedPriceChange }

/** Older responses used one source for every change. New responses retain each independent timeline. */
export function trackingEvidence(tracking: GiftPriceTrackingData, change?: ObservedPriceChange) {
  return {
    source: change?.source ?? tracking.source,
    lastObservedAt: change?.source_last_observed_at ?? tracking.last_observed_at,
  };
}

/** Five recently changed gifts; opening a row then matches its latest change. */
export function latestPriceChanges(gifts: Gift[], limit = 5): GiftPriceChange[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 5)) : 5;
  return gifts.filter(gift => gift.is_portfolio).flatMap(gift => {
    const change = (gift.price_tracking?.changes || []).filter(item => Number.isFinite(Date.parse(item.observed_at)))
      .reduce<ObservedPriceChange | null>((latest, item) => !latest || Date.parse(item.observed_at) > Date.parse(latest.observed_at) ? item : latest, null);
    return change ? [{ gift, change }] : [];
  })
    .sort((a, b) => Date.parse(b.change.observed_at) - Date.parse(a.change.observed_at) || a.gift.id.localeCompare(b.gift.id) || a.change.id.localeCompare(b.change.id))
    .slice(0, boundedLimit);
}

export function trackingComparison(change: ObservedPriceChange, days: TrackingPeriod): PriceTrackingComparison | null {
  return change.comparisons.find(comparison => comparison.days === days) || null;
}

export function hasTrackingWindow(comparison: PriceTrackingComparison | null): boolean {
  const days = comparison?.comparable_days;
  return Boolean(comparison?.before && comparison.after && typeof days === 'string' && days.length <= 2000 && /^\d+(?:\.\d+)?$/.test(days) && /[1-9]/.test(days));
}

export function trackingWindowStatus(comparison: PriceTrackingComparison | null): string {
  if (!comparison) return 'Comparison unavailable';
  if (!hasTrackingWindow(comparison)) return comparison.status === 'partial' ? 'No verified comparison window' : 'Waiting for after period';
  if (comparison.status === 'partial' || comparison.status === 'pending') {
    // Do not round an unfinished 6.99-day period up to a full 7-day label.
    const [whole, fraction = ''] = comparison.comparable_days.split('.');
    const elapsed = BigInt(whole) === 0n && (!fraction[0] || fraction[0] === '0') ? '<0.1' : `${BigInt(whole)}.${fraction[0] || '0'}`;
    return `${elapsed} of ${comparison.days} days observed`;
  }
  return `${comparison.days}-day sample`;
}
