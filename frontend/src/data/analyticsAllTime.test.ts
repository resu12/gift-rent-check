import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime } from './types.ts';
import { analyticsRefreshPeriod, analyticsReportDays, analyticsReportOptions, analyticsReportSelection, selectAnalyticsReport } from './analyticsReports.ts';
import { analyticsBarHeights, analyticsHistoryGrouping, analyticsReportingPeriod, groupPersonalAnalytics, personalAnalyticsUrl } from './personalAnalytics.ts';
import { analyticsChartPoint } from './analyticsChartInteraction.ts';
import { analyticsFreshnessPresentation } from './analyticsFreshness.ts';

const captured = '2026-01-03T12:00:00Z', now = Date.parse(captured);
const point = (date: string, rent_volume = '0.1', partial = false) => ({ date, rent_volume, new_rentals: 1, extensions: 1, rentals: 2, captured_at: captured, partial });
const history = (changes: Partial<PersonalRentalAnalyticsAllTime> = {}): PersonalRentalAnalyticsAllTime => ({
  version: 1, report_kind: 'all_time', source: 'marketapp_personal_rent_page', source_url: null,
  wallet: `0:${'12'.repeat(32)}`, captured_at: captured, period_start: '2026-01-01', period_end: '2026-01-03',
  timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees', fingerprint: 'aggregate-history',
  summary: { rent_volume: '0.3', rentals: 4, new_rentals: 2, extensions: 2, items: null, price_per_day: null,
    average_duration: null, extension_percent: null, spent_on_rent: null, spending_rentals: null },
  daily: [point('2026-01-01'), point('2026-01-03', '0.2', true)],
  coverage: { observed_days: 2, missing_days: 1, partial_days: 1 }, ...changes,
});
const annual = { daily: Array.from({ length: 365 }, () => ({})), fingerprint: 'annual', captured_at: captured } as PersonalRentalAnalytics;

test('All time is a separate saved-history selection and never aliases an equally long captured report', () => {
  const saved = history(), options = analyticsReportOptions([annual], true, saved);
  assert.deepEqual(options.at(-1), { days: 'all_time', label: 'All time · saved history', saved: true });
  assert.equal(selectAnalyticsReport([annual], 'all_time', saved), saved);
  assert.equal(selectAnalyticsReport([annual], 365, saved), annual);
  assert.equal(selectAnalyticsReport([annual], 'all_time', null), null);
  assert.equal(analyticsReportingPeriod(saved), 'All time · saved history');
  assert.equal(analyticsReportDays([annual], 'wallet-a', { wallet: 'wallet-a', days: 'all_time' }), 'all_time');
  assert.equal(analyticsReportDays([annual], 'wallet-b', { wallet: 'wallet-a', days: 'all_time' }), 'all_time');
});

test('All time refresh targets the annual provider period and is selectable before history is saved', () => {
  assert.equal(analyticsRefreshPeriod('all_time'), 365); assert.equal(analyticsRefreshPeriod(365), 365);
  assert.equal(analyticsRefreshPeriod(30), 30); assert.equal(analyticsRefreshPeriod(366), null);
  assert.equal(analyticsReportSelection('all_time'), 'all_time'); assert.equal(analyticsReportSelection('365'), 365);
  for (const invalid of ['NaN', '', '0', '367', 'Infinity', '365.0', '-30', 'private-cookie']) assert.equal(analyticsReportSelection(invalid), null);
  assert.deepEqual(analyticsReportOptions([], false), [{ days: 'all_time', label: 'All time · saved history', saved: false }]);
  assert.deepEqual(analyticsReportOptions([], true).at(-1), { days: 'all_time', label: 'All time · saved history', saved: false });
});

test('All time browser refresh link remains the annual report and never invents an undocumented all-time endpoint', () => {
  const saved = history(), url = new URL(personalAnalyticsUrl(saved.wallet, saved));
  assert.equal(url.origin, 'https://marketapp.org'); assert.equal(url.searchParams.get('period_by'), 'last365days');
  assert.equal(url.searchParams.get('group_by'), 'day'); assert.equal(url.searchParams.get('tab'), 'analytics_rent');
});

test('daily gaps remain null and differ from known zero-rental days', () => {
  const saved = history({ daily: [point('2026-01-01'), { ...point('2026-01-03', '0', true), new_rentals: 0, extensions: 0, rentals: 0 }] });
  const before = JSON.stringify(saved), grouped = groupPersonalAnalytics(saved, 'day');
  assert.equal(grouped.length, 3); assert.equal(grouped[1].start, '2026-01-02'); assert.equal(grouped[1].volume, null);
  assert.equal(grouped[1].rentals, null); assert.equal(grouped[1].gap, true); assert.equal(grouped[1].partial, true);
  assert.equal(grouped[2].volume, '0'); assert.equal(grouped[2].rentals, 0); assert.equal(grouped[2].gap, false);
  assert.equal(analyticsChartPoint(grouped[1]).volume, 'No saved data'); assert.equal(analyticsChartPoint(grouped[1]).rentals, 'Rental count unknown');
  assert.equal(analyticsChartPoint(grouped[2]).volume, '0.0 GRAM'); assert.equal(analyticsChartPoint(grouped[2]).rentals, '0 rentals');
  assert.deepEqual(analyticsBarHeights(grouped), [100, 0, 0]); assert.equal(JSON.stringify(saved), before);
});

test('grouped saved history adds exact known amounts and exposes missing and partial days', () => {
  const saved = history({ daily: [point('2026-01-01', '9007199254740993.0001'), point('2026-01-03', '0.0002', true)] });
  const monthly = groupPersonalAnalytics(saved, 'month')[0];
  assert.equal(monthly.volume, '9007199254740993.0003'); assert.equal(monthly.rentals, 4); assert.equal(monthly.partial, true);
  assert.deepEqual(monthly.coverage, { observedDays: 2, missingDays: 1, partialDays: 1 });
  assert.equal(analyticsChartPoint(monthly).coverage, '2 days saved · 1 missing · 1 partial');
  assert.equal(analyticsChartPoint(monthly).volume, '9,007,199,254,740,993.0 GRAM');
});

test('whole missing calendar buckets stay unknown rather than becoming zero revenue', () => {
  const saved = history({ period_start: '2025-10-31', period_end: '2026-02-01', captured_at: '2026-02-01T12:00:00Z',
    daily: [point('2025-10-31'), point('2026-02-01', '0.2', true)] });
  const grouped = groupPersonalAnalytics(saved, 'month');
  assert.deepEqual(grouped.map(item => item.key), ['2025-10-01', 'gap:2025-11-01', '2026-02-01']);
  assert.equal(grouped[1].volume, null); assert.equal(grouped[1].rentals, null); assert.equal(grouped[1].partial, true);
  assert.equal(grouped[1].start, '2025-11-01'); assert.equal(grouped[1].end, '2026-01-31');
  assert.equal(grouped[1].coverage?.missingDays, 92);
});

test('far-apart saved dates create one unknown interval without enumerating centuries of days', () => {
  const saved = history({ period_start: '0001-01-01', daily: [point('0001-01-01'), point('2026-01-03', '0.2', true)] });
  for (const group of ['day', 'week', 'month', 'year'] as const) {
    const grouped = groupPersonalAnalytics(saved, group);
    assert.equal(grouped.length, 3); assert.equal(grouped[1].volume, null); assert.equal(grouped[1].gap, true);
    assert.ok(grouped[1].coverage!.missingDays > 700000);
    assert.equal(grouped.filter(item => !item.gap).reduce((sum, item) => sum + (item.rentals ?? 0), 0), 4);
  }
});

test('dense histories coarsen the displayed grouping while retaining all recorded totals', () => {
  const daily = Array.from({ length: 2500 }, (_, index) => point(new Date(Date.UTC(2019, 0, 1 + index)).toISOString().slice(0, 10)));
  const saved = history({ period_start: daily[0].date, period_end: daily.at(-1)!.date, daily });
  const grouping = analyticsHistoryGrouping(saved, 'day'); assert.equal(grouping, 'week');
  const grouped = groupPersonalAnalytics(saved, grouping); assert.ok(grouped.length <= 736);
  assert.equal(grouped.reduce((sum, item) => sum + (item.rentals ?? 0), 0), 5000);
  const smaller = history({ ...saved, daily: daily.slice(0, 600), period_end: daily[599].date });
  assert.equal(analyticsHistoryGrouping(smaller, 'day'), 'day');
});

test('full observed calendar buckets are complete only when no saved day is partial or missing', () => {
  const daily = Array.from({ length: 31 }, (_, index) => point(new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)));
  const saved = history({ period_end: '2026-01-31', captured_at: '2026-02-01T12:00:00Z', daily,
    coverage: { observed_days: 31, missing_days: 0, partial_days: 0 } });
  assert.equal(groupPersonalAnalytics(saved, 'month')[0].partial, false);
  saved.daily[10].partial = true; assert.equal(groupPersonalAnalytics(saved, 'month')[0].partial, true);
  saved.daily.splice(10, 1); const incomplete = groupPersonalAnalytics(saved, 'month')[0];
  assert.equal(incomplete.partial, true); assert.equal(incomplete.coverage?.missingDays, 1); assert.equal(incomplete.volume, '3');
});

test('all-time freshness uses observed coverage rather than daily-count window length or lifetime claims', () => {
  const view = analyticsFreshnessPresentation(history(), 'all_time', { now, refreshable: true });
  assert.equal(view.label, 'Saved history'); assert.equal(view.tone, 'saved'); assert.equal(view.needsReload, undefined);
  const missing = analyticsFreshnessPresentation(null, 'all_time', { now, refreshable: true });
  assert.equal(missing.label, 'No saved history');
  for (const invalid of [history({ coverage: { observed_days: 2, missing_days: 0, partial_days: 1 } }),
    history({ coverage: { observed_days: 2, missing_days: 1, partial_days: 0 } }), history({ daily: [point('2026-01-01'), point('2026-01-01', '0.2', true)] }),
    history({ captured_at: '2026-02-30T12:00:00Z' }), history({ captured_at: '2026-01-04T12:00:00Z' })]) {
    assert.equal(analyticsFreshnessPresentation(invalid, 'all_time', { now, refreshable: true }).label, 'Coverage unavailable');
  }
});

test('annual manual refresh and monthly startup refresh both update saved history without changing provider scope', () => {
  const saved = history();
  for (const metadata of [{ manual: { phase: 'updating' as const, periodDays: 365 as const } },
    { startup: { phase: 'updating' as const, busy: true, periodDays: 30 as const } }]) {
    const view = analyticsFreshnessPresentation(saved, 'all_time', { now, refreshable: true, ...metadata });
    assert.equal(view.tone, 'working'); assert.equal(view.label, 'Updating saved history…');
    assert.match(view.message || '', metadata.manual ? /supported annual report/ : /supported 30-day report/);
  }
  const view = analyticsFreshnessPresentation(saved, 'all_time', { now, refreshable: true,
    manual: { phase: 'saved', periodDays: 365, capturedAt: captured, fingerprint: 'different-normal-snapshot' } });
  assert.equal(view.needsReload, undefined); assert.equal(view.label, 'Saved history');
});

test('successful provider refresh does not claim loaded history when its new capture has not arrived', () => {
  const older = history({ captured_at: '2026-01-02T12:00:00Z', period_end: '2026-01-02', daily: [point('2026-01-01'), point('2026-01-02')],
    coverage: { observed_days: 2, missing_days: 0, partial_days: 0 } });
  const view = analyticsFreshnessPresentation(older, 'all_time', { now, refreshable: true,
    startup: { phase: 'saved', busy: false, periodDays: 365, capturedAt: captured } });
  assert.equal(view.needsReload, true); assert.equal(view.tone, 'warning');
  const loading = analyticsFreshnessPresentation(older, 'all_time', { now, refreshable: true,
    manual: { phase: 'saved', periodDays: 365, capturedAt: captured, loadingSaved: true } });
  assert.equal(loading.tone, 'working'); assert.equal(loading.needsReload, undefined);
});

test('newer startup/import confirmations outrank old recovered markers and do not erase the selected history', () => {
  const saved = history({ captured_at: '2026-01-02T12:00:00Z', period_end: '2026-01-02', daily: [point('2026-01-01'), point('2026-01-02')],
    coverage: { observed_days: 2, missing_days: 0, partial_days: 0 } });
  const view = analyticsFreshnessPresentation(saved, 'all_time', { now, refreshable: true,
    manual: { phase: 'saved', periodDays: 365, capturedAt: saved.captured_at },
    startup: { phase: 'saved', busy: false, periodDays: 30, capturedAt: captured } });
  assert.equal(view.needsReload, true);
  const imported = analyticsFreshnessPresentation(saved, 'all_time', { now, refreshable: true,
    imported: { days: 30, capturedAt: captured, fingerprint: 'month', loading: false, reloadFailed: true } });
  assert.equal(imported.needsReload, true);
});

test('older and equal-time imports require a successful reload even when aggregate capture time is already newer', () => {
  const saved = history(), outcomeAt = '2026-01-03T12:01:00Z', checkAt = Date.parse('2026-01-03T12:02:00Z');
  for (const capturedAt of ['2025-01-01T12:00:00Z', saved.captured_at]) {
    const imported = { days: 30, capturedAt, fingerprint: 'changed-source', loading: false, reloadFailed: true, outcomeAt };
    const options = { now: checkAt, refreshable: true, imported,
      startup: { phase: 'saved' as const, busy: false, periodDays: 365 as const, capturedAt: saved.captured_at } };
    const failed = analyticsFreshnessPresentation(saved, 'all_time', options);
    assert.equal(failed.needsReload, true); assert.equal(failed.tone, 'warning');
    const oldRead = analyticsFreshnessPresentation(saved, 'all_time', { ...options, historyReloadedAt: saved.captured_at });
    assert.equal(oldRead.needsReload, true);
    const loading = analyticsFreshnessPresentation(saved, 'all_time', { ...options, imported: { ...imported, loading: true, reloadFailed: false } });
    assert.equal(loading.label, 'Loading saved history…');
    const recovered = analyticsFreshnessPresentation(saved, 'all_time', { ...options, historyReloadedAt: '2026-01-03T12:01:30Z' });
    assert.equal(recovered.needsReload, undefined); assert.equal(recovered.label, 'Saved history');
  }
});

test('recovery cannot confirm an unloaded report or a future reload receipt', () => {
  const imported = { days: 30, capturedAt: captured, fingerprint: 'saved', loading: false, reloadFailed: true, outcomeAt: captured };
  const options = { now, refreshable: true, imported, historyReloadedAt: captured };
  assert.equal(analyticsFreshnessPresentation(null, 'all_time', options).needsReload, true);
  assert.equal(analyticsFreshnessPresentation(history(), 'all_time', { ...options, historyReloadedAt: '2027-01-01T00:00:00Z' }).needsReload, true);
  const manual = { phase: 'saved' as const, periodDays: 365 as const, capturedAt: captured, outcomeAt: captured, failure: 'reload_failed' as const };
  assert.equal(analyticsFreshnessPresentation(history(), 'all_time', { now, refreshable: true, manual }).needsReload, true);
  assert.equal(analyticsFreshnessPresentation(history(), 'all_time', { now, refreshable: true, manual, historyReloadedAt: captured }).needsReload, undefined);
});

test('a fresh startup marker cannot acknowledge a historical import until it actually reloads saved data', () => {
  const imported = { days: 30, capturedAt: '2025-01-01T00:00:00Z', fingerprint: 'historical', loading: false,
    reloadFailed: true, outcomeAt: '2026-01-03T12:01:00Z' };
  const startup = { phase: 'fresh' as const, periodDays: 365 as const, capturedAt: captured,
    busy: false, outcomeAt: '2026-01-03T12:02:00Z' };
  const options = { now: Date.parse('2026-01-03T12:03:00Z'), refreshable: true, imported, startup };
  assert.equal(analyticsFreshnessPresentation(history(), 'all_time', options).needsReload, true);
  assert.equal(analyticsFreshnessPresentation(history(), 'all_time', { ...options,
    startup: { ...startup, reloadedAt: '2026-01-03T12:00:00Z' } }).needsReload, true);
  assert.equal(analyticsFreshnessPresentation(history(), 'all_time', { ...options,
    startup: { ...startup, reloadedAt: '2026-01-03T12:02:01Z' } }).needsReload, undefined);
});

test('All time explains automatic refresh failures and capacity pauses without hiding saved totals', () => {
  const saved = history(), outcomeAt = '2026-01-03T12:01:00Z', checkAt = Date.parse('2026-01-03T12:02:00Z');
  const startup = { phase: 'unavailable' as const, busy: false, periodDays: 30 as const, reason: 'refresh_failed' as const, outcomeAt };
  const options = { now: checkAt, refreshable: true, startup,
    manual: { phase: 'saved' as const, periodDays: 365 as const, capturedAt: captured, outcomeAt: captured } };
  const failed = analyticsFreshnessPresentation(saved, 'all_time', options);
  assert.equal(failed.tone, 'warning'); assert.match(failed.message || '', /Automatic refresh did not finish/);
  const paused = analyticsFreshnessPresentation(saved, 'all_time', { ...options, startup: { ...startup, storagePaused: true } });
  assert.equal(paused.tone, 'warning'); assert.match(paused.message || '', /Clean up storage from Status/);
  const afterRecovery = analyticsFreshnessPresentation(saved, 'all_time', { ...options,
    manual: { phase: 'saved', periodDays: 365, capturedAt: captured, outcomeAt: '2026-01-03T12:01:30Z' } });
  assert.equal(afterRecovery.tone, 'saved'); assert.equal(afterRecovery.message, undefined);
});

test('All time shows automatic waiting, limits and connection requirements for both provider periods', () => {
  const options = { now, refreshable: true };
  for (const periodDays of [30, 365] as const) {
    const limited = analyticsFreshnessPresentation(history(), 'all_time', { ...options, startup: { phase: 'limited', busy: false, periodDays, reason: 'cooldown' } });
    assert.match(limited.message || '', /Automatic refresh is paused/);
    const busy = analyticsFreshnessPresentation(history(), 'all_time', { ...options, startup: { phase: 'busy', busy: false, periodDays, reason: 'website_busy' } });
    assert.match(busy.message || '', /Another refresh is running/);
    const disconnected = analyticsFreshnessPresentation(history(), 'all_time', { ...options, startup: { phase: 'unavailable', busy: false, periodDays, reason: 'no_login' } });
    assert.match(disconnected.message || '', /Connect Marketapp/);
    const noWallet = analyticsFreshnessPresentation(null, 'all_time', { ...options, startup: { phase: 'unavailable', busy: false, periodDays, reason: 'wallet_missing' } });
    assert.match(noWallet.message || '', /Save your wallet/);
  }
  const superseded = analyticsFreshnessPresentation(history(), 'all_time', { ...options,
    startup: { phase: 'unavailable', busy: false, periodDays: 30, reason: 'refresh_failed', outcomeAt: '2026-01-02T00:00:00Z' } });
  assert.equal(superseded.tone, 'saved'); assert.equal(superseded.message, undefined);
});
