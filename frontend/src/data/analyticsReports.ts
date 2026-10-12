import type { PersonalRentalAnalytics } from './types.ts';
import { analyticsReportingPeriod } from './personalAnalytics.ts';

export interface AnalyticsReportOption { days: number; label: string; saved: boolean }

/** An unsaved supported period is an explicit empty view, never another period's figures. */
export function analyticsReportOptions(snapshots: PersonalRentalAnalytics[], refreshEnabled: boolean): AnalyticsReportOption[] {
  const days = new Set(snapshots.map(snapshot => snapshot.daily.length));
  if (refreshEnabled) { days.add(30); days.add(365); }
  return [...days].sort((a, b) => a - b).map(length => {
    const snapshot = snapshots.find(item => item.daily.length === length);
    const label = length === 30 ? 'Last 30 days' : length === 365 ? 'Last 1 year'
      : length === 366 ? '366-day saved report' : snapshot ? analyticsReportingPeriod(snapshot) : `${length}-day report`;
    return { days: length, label, saved: Boolean(snapshot) };
  });
}

/** Stay with the selected duration when new captures replace the stored fingerprint. */
export function selectAnalyticsReport(snapshots: PersonalRentalAnalytics[], days: number): PersonalRentalAnalytics | null {
  return snapshots.find(snapshot => snapshot.daily.length === days) || null;
}

export function analyticsReportDays(snapshots: PersonalRentalAnalytics[], wallet: string | null,
  selection: { wallet: string | null; days: number } | null): number {
  return selection?.wallet === wallet ? selection.days : snapshots[0]?.daily.length || 30;
}
