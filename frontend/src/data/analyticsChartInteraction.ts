import { formatAmount } from './helpers.ts';
import { analyticsPeriod } from './personalAnalytics.ts';
import type { AnalyticsBucket } from './personalAnalytics.ts';

/** Resolve equal-width chart columns, including a pointer captured outside the chart. */
export function analyticsBarIndex(clientX: number, left: number, width: number, count: number): number | null {
  if (![clientX, left, width].every(Number.isFinite) || width <= 0 || !Number.isSafeInteger(count) || count <= 0) return null;
  return Math.max(0, Math.min(count - 1, Math.floor((clientX - left) / width * count)));
}

export interface AnalyticsChartPoint {
  period: string;
  volume: string;
  rentals: string;
  partial: boolean;
  gap?: boolean;
  coverage?: string;
}

/** Display saved grouped evidence; rental totals already include extensions. */
export function analyticsChartPoint(bucket: AnalyticsBucket): AnalyticsChartPoint {
  const rentals = bucket.rentals === null ? 'Rental count unknown' : `${bucket.rentals.toLocaleString()} ${bucket.rentals === 1 ? 'rental' : 'rentals'}`;
  const extensions = bucket.extensions ? ` (incl. ${bucket.extensions.toLocaleString()} ${bucket.extensions === 1 ? 'extension' : 'extensions'})` : '';
  return {
    period: `${analyticsPeriod(bucket.start, bucket.end)} UTC`,
    volume: bucket.volume === null ? 'No saved data' : `${formatAmount(bucket.volume, 1)} GRAM`,
    rentals: rentals + extensions,
    partial: bucket.partial,
    ...(bucket.gap ? { gap: true } : {}),
    ...(bucket.coverage ? { coverage: `${bucket.coverage.observedDays} days saved${bucket.coverage.missingDays ? ` · ${bucket.coverage.missingDays} missing` : ''}${bucket.coverage.partialDays ? ` · ${bucket.coverage.partialDays} partial` : ''}` } : {}),
  };
}
