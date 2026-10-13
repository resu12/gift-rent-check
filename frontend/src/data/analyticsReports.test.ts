import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsReportDays, analyticsReportOptions, selectAnalyticsReport } from './analyticsReports.ts';
import { personalAnalyticsSnapshots } from './personalAnalytics.ts';
import type { PersonalRentalAnalytics } from './types.ts';

const report = (days: number, fingerprint: string, captured_at = '2026-10-11T12:00:00Z') => ({
  daily: Array.from({ length: days }, () => ({})), fingerprint, captured_at,
} as PersonalRentalAnalytics);

test('first-time Telegram reports offer monthly and annual refresh targets without inventing figures', () => {
  assert.deepEqual(analyticsReportOptions([], true), [
    { days: 30, label: 'Last 30 days', saved: false }, { days: 365, label: 'Last 1 year', saved: false },
    { days: 'all_time', label: 'All time · saved history', saved: false },
  ]);
  assert.equal(selectAnalyticsReport([report(30, 'month')], 365), null);
});

test('selected monthly duration survives a newer annual capture and monthly fingerprint replacement', () => {
  const month = report(30, 'old', '2026-10-10T12:00:00Z'), annual = report(365, 'year');
  const selection = { wallet: 'wallet-a', days: 30 };
  const available = personalAnalyticsSnapshots(annual, [month]);
  assert.equal(analyticsReportDays(available, 'wallet-a', selection), 30);
  assert.equal(selectAnalyticsReport(available, 30)?.fingerprint, 'old');
  const refreshed = personalAnalyticsSnapshots(report(30, 'new'), available);
  assert.equal(selectAnalyticsReport(refreshed, analyticsReportDays(refreshed, 'wallet-a', selection))?.fingerprint, 'new');
});

test('changing wallet resets the period choice instead of carrying another wallet selection', () => {
  const available = [report(365, 'year'), report(30, 'month')];
  assert.equal(analyticsReportDays(available, 'wallet-b', { wallet: 'wallet-a', days: 30 }), 'all_time');
  assert.equal(analyticsReportDays([], 'wallet-b', null), 'all_time');
});

test('desktop offers its All time default even before import and keeps saved durations distinct', () => {
  const snapshots = [report(366, 'leap'), report(7, 'week'), report(365, 'year')];
  assert.deepEqual(analyticsReportOptions([], false), [{days:'all_time',label:'All time · saved history',saved:false}]);
  const options = analyticsReportOptions(snapshots, false);
  assert.deepEqual(options.map(item => item.days), [7, 365, 366, 'all_time']);
  assert.ok(options.slice(0,3).every(item => item.saved));
  assert.equal(options.at(-1)?.saved, false);
  assert.notEqual(options[1].label, options[2].label);
  assert.equal(selectAnalyticsReport(snapshots, 30), null);
});

test('Overview defaults to All time regardless of the newest captured period or missing history', () => {
  const month=report(30,'month'),year=report(365,'year');
  for (const reports of [[],[month],[year],[month,year],[year,month]]) {
    assert.equal(analyticsReportDays(reports,'wallet-a',null),'all_time');
    assert.equal(selectAnalyticsReport(reports,analyticsReportDays(reports,'wallet-a',null),null),null,'unsaved history never substitutes another report');
  }
});

test('explicit Status View and manual period choices override the default and survive refresh', () => {
  for (const days of [30,365,'all_time'] as const) {
    const target={wallet:'wallet-a',days};
    assert.equal(analyticsReportDays([], 'wallet-a',target),days);
    assert.equal(analyticsReportDays([report(365,'latest'),report(30,'month')],'wallet-a',target),days);
  }
});
