import type { PricingSelection, PricingSource, PricingTimeframe } from './types';

export const MAX_PRICING_DAYS = 90;
const DAY_MS = 86_400_000;
export const TIMEFRAME_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' }, { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' }, { value: '60d', label: 'Last 60 days' },
  { value: '90d', label: 'Last 90 days' }, { value: 'custom', label: 'Custom dates' },
] as const;
export const DEFAULT_PRICING: PricingSelection = { source: 'rentals', timeframe: '30d' };

export function sourceDefaults(source: PricingSource, backdrop?: 'Black'): PricingSelection {
  return { source, timeframe: '30d', ...(backdrop ? { backdrop } : {}) };
}

export function selectTimeframe(selection: PricingSelection, timeframe: PricingTimeframe, today: string): PricingSelection {
  return { source: selection.source, timeframe, ...(selection.backdrop ? { backdrop: selection.backdrop } : {}),
    ...(timeframe === 'custom' ? { dateFrom: today, dateTo: today } : {}) };
}

export function dateRangeError(from: string, to: string): string | null {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to) return 'Choose a valid start and end date, with the end on or after the start.';
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1 > MAX_PRICING_DAYS) {
    return 'Choose a range of at most 90 days, including both UTC dates.';
  }
  return null;
}

export function validDateRange(from: string, to: string): boolean {
  return dateRangeError(from, to) === null;
}

export function historyCollectionError(selection: PricingSelection, now = new Date()): string | null {
  if (selection.timeframe === 'all') return 'Choose a timeframe of at most 90 days before collecting.';
  if (selection.timeframe !== 'custom') return null;
  const error = dateRangeError(selection.dateFrom || '', selection.dateTo || '');
  if (error) return error;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const oldest = new Date(today - (MAX_PRICING_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  return selection.dateFrom! < oldest
    ? `New rental collection can start no earlier than ${oldest} (UTC), within the last 90 calendar days. This older window can still display saved data.`
    : null;
}

// The same canonical query drives loading, stale-response protection and export.
export function pricingQuery(selection: PricingSelection): string {
  if (selection.timeframe === 'all') throw new Error('Choose a timeframe of at most 90 days.');
  const query = new URLSearchParams({ pricing_source: selection.source, timeframe: selection.timeframe });
  if (selection.backdrop) query.set('pricing_backdrop', selection.backdrop);
  if (selection.timeframe === 'custom') {
    const error = dateRangeError(selection.dateFrom || '', selection.dateTo || '');
    if (error) throw new Error(error);
    query.set('date_from', selection.dateFrom!);
    query.set('date_to', selection.dateTo!);
  }
  return query.toString();
}

export function timeframeLabel(selection: PricingSelection): string {
  const labels = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '60d': 'Last 60 days', '90d': 'Last 90 days', all: 'All saved history (legacy)' };
  return selection.timeframe === 'custom' ? `${selection.dateFrom} to ${selection.dateTo} (UTC, inclusive)` : labels[selection.timeframe];
}
