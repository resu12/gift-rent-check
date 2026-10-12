import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsFreshnessPresentation } from './analyticsFreshness.ts';
import type { AnalyticsFreshnessOptions } from './analyticsFreshness.ts';
import type { PersonalRentalAnalytics } from './types.ts';
import type { AnalyticsStartupSnapshot } from '../serverless/analyticsStartup.ts';
import type { MarketappAnalyticsRefreshView } from '../serverless/marketappAnalyticsRefreshFlow.ts';

const now = Date.parse('2026-10-11T12:00:00Z');
function report(days = 30, captured = now, end = '2026-10-11'): PersonalRentalAnalytics {
  const start = Date.parse(end) - (days - 1) * 86400000;
  return { version: 1, source: 'marketapp_personal_rent_page', source_url: 'https://marketapp.org/', wallet: `0:${'12'.repeat(32)}`,
    captured_at: new Date(captured).toISOString(), period_start: new Date(start).toISOString().slice(0, 10), period_end: end,
    timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees', fingerprint: 'a'.repeat(64),
    daily: Array.from({ length: days }, (_, index) => ({ date: new Date(start + index * 86400000).toISOString().slice(0, 10), rent_volume: '0', new_rentals: 0, extensions: 0, rentals: 0 })),
    summary: { rent_volume: '1', rentals: 1, new_rentals: 1, extensions: 0, items: 1, price_per_day: null,
      average_duration: null, extension_percent: null, spent_on_rent: null, spending_rentals: null } };
}
const present = (snapshot: PersonalRentalAnalytics | null = report(), changes: {
  selected?: number; now?: number; refreshable?: boolean; startup?: AnalyticsStartupSnapshot; manual?: MarketappAnalyticsRefreshView;
  imported?: AnalyticsFreshnessOptions['imported'];
} = {}) => analyticsFreshnessPresentation(snapshot, changes.selected ?? 30, { now: changes.now ?? now,
  refreshable: changes.refreshable ?? true, startup: changes.startup, manual: changes.manual, imported: changes.imported });

test('freshness describes the selected capture rather than promising that the market is up to date', () => {
  for (const days of [30, 365]) assert.deepEqual(present(report(days), { selected: days }), { tone: 'recent', label: 'Recently refreshed' });
  assert.equal(present().label.includes('Up to date'), false);
});

test('capacity pauses direct both manual and automatic analytics to Status while retaining saved figures', () => {
  const outcomeAt = new Date(now).toISOString();
  const manual = present(report(), { manual: { phase: 'failed', periodDays: 30, failure: 'storage_capacity', outcomeAt } });
  assert.equal(manual.tone, 'warning'); assert.match(manual.message ?? '', /Clean up storage from Status/);
  const startup = present(report(), { startup: { phase: 'unavailable', periodDays: 30, busy: false, reason: 'refresh_failed', storagePaused: true, outcomeAt } });
  assert.equal(startup.tone, 'warning'); assert.match(startup.message ?? '', /Clean up storage from Status/);
});

test('the fifteen-minute boundary is strict and a report from yesterday is not recent after UTC midnight', () => {
  assert.equal(present(report(30, now - 15 * 60000 + 1)).tone, 'recent');
  assert.deepEqual(present(report(30, now - 15 * 60000)), { tone: 'saved', label: 'Update available' });
  const midnight = Date.parse('2026-10-12T00:00:01Z');
  assert.deepEqual(present(report(30, midnight - 2000), { now: midnight }), { tone: 'saved', label: 'Update available' });
});

test('desktop, custom and unrefreshable reports remain saved even with a recent capture', () => {
  assert.deepEqual(present(report(), { refreshable: false }), { tone: 'saved', label: 'Saved report' });
  assert.deepEqual(present(report(7), { selected: 7 }), { tone: 'saved', label: 'Saved report' });
  assert.deepEqual(present(report(90), { selected: 90 }), { tone: 'saved', label: 'Saved report' });
});

test('missing data is distinct from invalid or implausible saved dates', () => {
  assert.deepEqual(present(null), { tone: 'empty', label: 'No saved report' });
  for (const changed of [
    { captured_at: 'private diagnostics' }, { captured_at: '2026-02-30T12:00:00Z' }, { captured_at: '2026-10-11T12:00:00+00:00' },
    { captured_at: new Date(now + 30001).toISOString() }, { period_start: '2026-02-30' }, { period_end: '2026-10-12' },
    { period_start: '2026-10-12' }, { period_start: '2026-10-11' },
  ]) assert.deepEqual(present({ ...report(), ...changed }), { tone: 'warning', label: 'Date unavailable', message: 'This report’s saved dates could not be confirmed.' });
  assert.equal(present(report(30, now + 30000)).tone, 'recent');
  assert.equal(present(report(), { now: Number.NaN }).label, 'Date unavailable');
});

test('a displayed report with a different reporting length is never marked recent', () => {
  assert.equal(present(report(365), { selected: 30 }).label, 'Date unavailable');
  assert.equal(present(report(30), { selected: 365 }).label, 'Date unavailable');
  assert.equal(present({ ...report(), daily: report().daily.slice(1) }).label, 'Date unavailable');
});

test('other-period startup and manual outcomes cannot promote or relabel the selected report', () => {
  const old = report(30, now - 3600000), base = present(old);
  for (const phase of ['saved', 'fresh', 'updating', 'unavailable', 'limited', 'busy'] as const) {
    assert.deepEqual(present(old, { startup: { phase, periodDays: 365, busy: phase === 'updating', capturedAt: new Date(now).toISOString(), reason: 'refresh_failed' } }),
      phase === 'updating' ? { ...base, message: 'Updating the 1-year report. Your saved 30-day figures are shown.' } : base);
  }
  for (const phase of ['saved', 'updating', 'failed', 'preparing', 'awaiting_approval'] as const) {
    assert.deepEqual(present(old, { manual: { phase, periodDays: 365, capturedAt: new Date(now).toISOString(), loadingSaved: true, failure: 'reload_failed' } }), base);
  }
});

test('a confirmed startup result waits for this period’s saved view to load', () => {
  const old = report(30, now - 3600000);
  const startup: AnalyticsStartupSnapshot = { phase: 'saved', periodDays: 30, busy: true, capturedAt: new Date(now).toISOString() };
  assert.deepEqual(present(old, { startup }), { tone: 'working', label: 'Loading refreshed report…', message: 'Previous figures remain visible.' });
  assert.equal(present(report(), { startup }).tone, 'recent');
  assert.equal(present(report(30, now + 1000), { startup }).tone, 'recent');
  assert.equal(present(null, { startup }).tone, 'working');
});

test('a failed startup reload retains the confirmed result and exposes one reload action for older figures', () => {
  const startup: AnalyticsStartupSnapshot = { phase: 'saved', periodDays: 30, busy: false, capturedAt: new Date(now).toISOString(), reloadFailed: true };
  assert.deepEqual(present(report(30, now - 3600000), { startup }), { tone: 'warning', label: 'Older data shown',
    message: 'The refresh finished, but this view still shows the previous report.', needsReload: true });
  assert.equal(present(report(), { startup }).tone, 'recent', 'a later successful view reload removes the stale warning');
});

test('a fresh startup response cannot turn a loaded old report green before its reload', () => {
  const old = report(30, now - 3600000);
  const startup: AnalyticsStartupSnapshot = { phase: 'fresh', periodDays: 30, busy: true, capturedAt: new Date(now).toISOString() };
  assert.equal(present(old, { startup }).tone, 'working');
  assert.equal(present(old, { startup: { ...startup, busy: false } }).needsReload, true);
});

test('manual success carries verified capture metadata through loading and reload failure', () => {
  const old = report(30, now - 3600000), manual: MarketappAnalyticsRefreshView = { phase: 'saved', periodDays: 30,
    capturedAt: new Date(now).toISOString(), fingerprint: 'a'.repeat(64), loadingSaved: true };
  assert.equal(present(old, { manual }).label, 'Loading refreshed report…');
  assert.equal(present(old, { manual: { ...manual, loadingSaved: false, failure: 'reload_failed' } }).label, 'Older data shown');
  assert.equal(present(report(), { manual }).tone, 'recent');
});

test('equal-time changed manual and import variants must match the confirmed fingerprint before showing the saved result', () => {
  const sameTimeVariant = { ...report(), fingerprint: 'b'.repeat(64) };
  const manual: MarketappAnalyticsRefreshView = { phase: 'saved', periodDays: 30, capturedAt: report().captured_at, fingerprint: report().fingerprint };
  assert.equal(present(sameTimeVariant, { manual: { ...manual, loadingSaved: true } }).label, 'Loading refreshed report…');
  assert.equal(present(sameTimeVariant, { manual }).label, 'Older data shown');
  assert.equal(present(report(30, now + 1000), { manual }).tone, 'recent', 'a newer committed capture can supersede the saved result');
  const imported: NonNullable<AnalyticsFreshnessOptions['imported']> = { days: 30, capturedAt: report().captured_at, fingerprint: report().fingerprint, loading: false };
  assert.equal(present(sameTimeVariant, { imported }).needsReload, true);
  assert.equal(present(report(), { imported }).tone, 'recent');
});

test('an older manual success cannot override a newer displayed capture', () => {
  const manual: MarketappAnalyticsRefreshView = { phase: 'saved', periodDays: 30, capturedAt: new Date(now - 3600000).toISOString(), failure: 'reload_failed' };
  assert.equal(present(report(), { manual }).tone, 'recent');
});

test('recovered saved markers without exact capture metadata do not claim freshness', () => {
  const old = report(30, now - 3600000), manual: MarketappAnalyticsRefreshView = { phase: 'saved', periodDays: 30 };
  assert.deepEqual(present(old, { manual }), present(old));
  assert.equal(present(old, { manual: { ...manual, loadingSaved: true } }).label, 'Loading saved report…');
  assert.deepEqual(present(old, { manual: { ...manual, failure: 'reload_failed' } }), { tone: 'warning', label: 'Saved data shown',
    message: 'The saved report could not be loaded.', needsReload: true, manualNotice: true });
});

test('unconfirmed or future success metadata cannot promote stale data', () => {
  const old = report(30, now - 3600000);
  for (const capturedAt of [undefined, 'bad date', new Date(now + 30001).toISOString()]) {
    assert.deepEqual(present(old, { startup: { phase: 'saved', periodDays: 30, busy: false, capturedAt } }), present(old));
    assert.deepEqual(present(old, { manual: { phase: 'saved', periodDays: 30, capturedAt } }), present(old));
  }
  assert.equal(present(old, { manual: { phase: 'failed', periodDays: 30, failure: 'result_unconfirmed' } }).tone, 'warning');
});

test('active refresh messages describe the selected figures and never erase their capture history', () => {
  const old = report(30, now - 3600000);
  assert.deepEqual(present(old, { startup: { phase: 'updating', periodDays: 30, busy: true } }), { tone: 'working',
    label: 'Refreshing report…', message: 'Saved figures remain visible until the new report loads.' });
  assert.equal(present(old, { manual: { phase: 'awaiting_approval', periodDays: 30 } }).label, 'Wallet approval needed');
  assert.equal(present(null, { manual: { phase: 'updating', periodDays: 30 } }).message, 'Fetching this report from Marketapp.');
});

test('limited, busy and missing-login outcomes retain capture-based freshness', () => {
  const old = report(30, now - 3600000);
  for (const startup of [{ phase: 'limited', reason: 'cooldown' }, { phase: 'busy', reason: 'website_busy' },
    { phase: 'unavailable', reason: 'no_login' }] as const) {
    const shown = present(old, { startup: { ...startup, busy: false, periodDays: 30 } });
    assert.equal(shown.tone, 'saved'); assert.equal(shown.label, 'Update available'); assert.ok(shown.message);
  }
  assert.equal(present(old, { startup: { phase: 'unavailable', busy: false, periodDays: 30, reason: 'refresh_failed' } }).tone, 'warning');
});

test('current manual work takes priority over a startup result for the same period', () => {
  const startup: AnalyticsStartupSnapshot = { phase: 'fresh', periodDays: 30, busy: false, capturedAt: report().captured_at };
  assert.equal(present(report(), { startup, manual: { phase: 'updating', periodDays: 30 } }).tone, 'working');
});

test('old recovered manual saved markers cannot hide current startup work', () => {
  const old = report(30, now - 3600000), manual: MarketappAnalyticsRefreshView = { phase: 'saved', periodDays: 30,
    capturedAt: old.captured_at, outcomeAt: old.captured_at };
  assert.equal(present(old, { manual, startup: { phase: 'updating', periodDays: 30, busy: true } }).tone, 'working');
  assert.equal(present(old, { manual: { phase: 'saved', periodDays: 30 }, startup: { phase: 'updating', periodDays: 30, busy: true } }).tone, 'working');
});

test('newer startup saves replace old recovered manual failures while a newer manual reload failure stays visible', () => {
  const startup: AnalyticsStartupSnapshot = { phase: 'saved', periodDays: 30, busy: false, capturedAt: report().captured_at };
  const manual: MarketappAnalyticsRefreshView = { phase: 'failed', periodDays: 30, failure: 'page_changed', outcomeAt: new Date(now - 3600000).toISOString() };
  assert.equal(present(report(), { manual, startup }).tone, 'recent');
  assert.notEqual(present(report(), { manual, startup }).manualNotice, true);
  assert.equal(present(report(), { manual }).tone, 'recent');
  assert.notEqual(present(report(), { manual }).manualNotice, true);
  assert.equal(present(report(), { manual: { ...manual, outcomeAt: undefined }, startup }).tone, 'recent');
  const old = report(30, now - 7200000);
  assert.equal(present(old, { manual: { phase: 'saved', periodDays: 30, capturedAt: new Date(now).toISOString(), failure: 'reload_failed' },
    startup: { ...startup, capturedAt: new Date(now - 3600000).toISOString() } }).label, 'Older data shown');
  assert.equal(present(old, { manual: { phase: 'failed', periodDays: 30, failure: 'page_changed', outcomeAt: report().captured_at } }).manualNotice, true);
  assert.equal(present(old, { manual: { phase: 'saved', periodDays: 30, capturedAt: report().captured_at, failure: 'reload_failed' } }).manualNotice, true);
  assert.notEqual(present(report(), { manual: { phase: 'saved', periodDays: 30, capturedAt: new Date(now - 3600000).toISOString(), failure: 'reload_failed' } }).manualNotice, true);
});

test('custom imported reports track their exact selected duration and remain saved rather than automatically current', () => {
  const latest = report(366), old = report(366, now - 3600000);
  const imported: NonNullable<AnalyticsFreshnessOptions['imported']> = { days: 366, capturedAt: latest.captured_at, fingerprint: latest.fingerprint, loading: true };
  assert.equal(present(old, { selected: 366, imported }).label, 'Loading refreshed report…');
  assert.equal(present(latest, { selected: 366, imported }).label, 'Saved report');
  assert.equal(present(null, { selected: 366, imported: { ...imported, loading: false, reloadFailed: true } }).label, 'Report not loaded');
  assert.equal(present(old, { selected: 366, imported: { ...imported, loading: false } }).needsReload, true);
  assert.deepEqual(present(report(), { imported }), present(report()));
});

test('active refreshes take priority over import notices, while newer import results clear older recovered errors', () => {
  const imported: NonNullable<AnalyticsFreshnessOptions['imported']> = { days: 30, capturedAt: report().captured_at, fingerprint: report().fingerprint, loading: false };
  assert.equal(present(report(), { imported, startup: { phase: 'updating', periodDays: 30, busy: true } }).tone, 'working');
  assert.equal(present(report(), { imported, manual: { phase: 'failed', periodDays: 30, failure: 'page_changed', outcomeAt: new Date(now - 3600000).toISOString() } }).tone, 'recent');
});
