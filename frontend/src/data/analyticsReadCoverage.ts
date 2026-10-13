import type { PersonalRentalAnalyticsReport } from './types.ts';

type HistorySection = 'daily' | 'items' | 'collections';

/** Read limits describe this preview, independently of gaps in the saved evidence. */
export function analyticsReadLimitMessage(report: PersonalRentalAnalyticsReport | null | undefined, section: HistorySection): string | null {
  if (!report || !('report_kind' in report) || report.report_kind !== 'all_time' || report.read_coverage?.[`${section}_limited`] !== true) return null;
  const figures = section === 'daily' ? 'Totals and chart cover loaded days only'
    : section === 'items' ? 'Gift totals cover loaded reports only' : 'Collection totals cover loaded reports only';
  return `Limited history preview. ${figures}; all saved data is retained.`;
}
