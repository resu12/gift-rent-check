import type { PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime, PersonalRentalAnalyticsReport } from './types.ts';
import { analyticsReportingPeriod } from './personalAnalytics.ts';

export type AnalyticsReportSelection = number | 'all_time';
export interface AnalyticsReportOption { days: AnalyticsReportSelection; label: string; saved: boolean }

/** An unsaved supported period is an explicit empty view, never another period's figures. */
export function analyticsReportOptions(snapshots: PersonalRentalAnalytics[], refreshEnabled: boolean, allTime?: PersonalRentalAnalyticsAllTime | null): AnalyticsReportOption[] {
  const days = new Set(snapshots.map(snapshot => snapshot.daily.length));
  if (refreshEnabled) { days.add(30); days.add(365); }
  const options: AnalyticsReportOption[] = [...days].sort((a, b) => a - b).map(length => {
    const snapshot = snapshots.find(item => item.daily.length === length);
    const label = length === 30 ? 'Last 30 days' : length === 365 ? 'Last 1 year'
      : length === 366 ? '366-day saved report' : snapshot ? analyticsReportingPeriod(snapshot) : `${length}-day report`;
    return { days: length, label, saved: Boolean(snapshot) };
  });
  // Keep the default selectable before history is saved; never display another
  // option's label for an empty All time view.
  options.push({ days: 'all_time', label: 'All time · saved history', saved: Boolean(allTime) });
  return options;
}

/** Stay with the selected duration when new captures replace the stored fingerprint. */
export function selectAnalyticsReport(snapshots: PersonalRentalAnalytics[], days: AnalyticsReportSelection, allTime?: PersonalRentalAnalyticsAllTime | null): PersonalRentalAnalyticsReport | null {
  if (days === 'all_time') return allTime || null;
  return snapshots.find(snapshot => snapshot.daily.length === days) || null;
}

/** All time is the initial view; report refresh/order must not override a user's choice. */
export function analyticsReportDays(_snapshots: PersonalRentalAnalytics[], wallet: string | null,
  selection: { wallet: string | null; days: AnalyticsReportSelection } | null): AnalyticsReportSelection {
  return selection?.wallet === wallet ? selection.days : 'all_time';
}

/** All-time refresh extends saved evidence through the supported annual provider report. */
export function analyticsRefreshPeriod(selection: AnalyticsReportSelection): 30 | 365 | null {
  return selection === 'all_time' || selection === 365 ? 365 : selection === 30 ? 30 : null;
}

export function analyticsReportSelection(value: string): AnalyticsReportSelection | null {
  if (value === 'all_time') return value;
  const days = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(days) && days > 0 && days <= 366 ? days : null;
}
