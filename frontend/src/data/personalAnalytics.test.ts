import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsBarHeights, analyticsPeriod, analyticsReportingPeriod, canImportPersonalAnalytics, groupPersonalAnalytics, personalAnalyticsPeriodOptions, personalAnalyticsSnapshots, personalAnalyticsUrl, selectPersonalAnalyticsSnapshot } from './personalAnalytics.ts';
import type { PersonalRentalAnalytics } from './types.ts';

const snapshot = (daily: PersonalRentalAnalytics['daily']): PersonalRentalAnalytics => ({
  version: 1, source: 'marketapp_personal_rent_page', source_url: 'https://marketapp.org/', wallet: 'synthetic',
  captured_at: '2026-02-03T12:00:00Z', period_start: daily[0].date, period_end: daily[daily.length - 1].date,
  timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees', fingerprint: 'synthetic',
  summary: { rent_volume: '0', rentals: 0, new_rentals: 0, extensions: 0, items: null, price_per_day: null,
    average_duration: null, extension_percent: null, spent_on_rent: null, spending_rentals: null }, daily,
});
const point = (date: string, rent_volume: string, new_rentals = 1, extensions = 0) => ({ date, rent_volume, new_rentals, extensions, rentals: new_rentals + extensions });

const report = (days: number, fingerprint: string, captured_at = '2026-02-03T12:00:00Z') => ({
  ...snapshot(Array.from({ length: days }, (_, index) => point(new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10), '0.01'))), fingerprint, captured_at,
});

test('reporting selector retains only captured periods and their provider summary values', () => {
  const month = report(30, 'month'), annual = report(365, 'year', '2026-02-04T12:00:00Z');
  month.summary = { ...month.summary, rent_volume: '3.1', rentals: 7, items: 4 };
  annual.summary = { ...annual.summary, rent_volume: '41.9', rentals: 103, items: 17 };
  const before = JSON.stringify([month, annual]);
  const available = personalAnalyticsSnapshots(annual, [month, annual]);
  assert.deepEqual(personalAnalyticsPeriodOptions(available), [{ fingerprint: 'year', label: 'Last 1 year' }, { fingerprint: 'month', label: 'Last 30 days' }]);
  assert.equal(selectPersonalAnalyticsSnapshot(annual, available), annual);
  assert.equal(selectPersonalAnalyticsSnapshot(annual, available, 'month'), month);
  assert.equal(selectPersonalAnalyticsSnapshot(annual, available, 'month')?.summary.items, 4);
  assert.equal(selectPersonalAnalyticsSnapshot(annual, available, 'year')?.summary.items, 17);
  assert.equal(JSON.stringify([month, annual]), before);
});

test('snapshot-only compatibility, absent selections and repeated imports select an available saved report', () => {
  const old = report(30, 'old'), latest = report(30, 'new', '2026-02-04T12:00:00Z');
  assert.deepEqual(personalAnalyticsSnapshots(latest), [latest]);
  const available = personalAnalyticsSnapshots(latest, [old, latest, latest]);
  assert.deepEqual(available, [latest]);
  assert.equal(selectPersonalAnalyticsSnapshot(latest, available, 'old'), latest);
  assert.equal(selectPersonalAnalyticsSnapshot(null, available, 'not-present'), latest);
  assert.equal(selectPersonalAnalyticsSnapshot(null, []), null);
  assert.deepEqual(personalAnalyticsSnapshots(null), []);
});

test('reporting labels support annual/leap captures and distinguish duplicate display periods by dates', () => {
  const annual = report(365, 'year'), leap = report(366, 'leap');
  assert.equal(analyticsReportingPeriod(leap), 'Last 1 year');
  assert.equal(analyticsReportingPeriod(report(42, 'custom')), '42-day snapshot');
  assert.equal(analyticsReportingPeriod(report(1, 'single')), '1-day snapshot');
  const options = personalAnalyticsPeriodOptions([annual, leap]);
  assert.ok(options.every(option => option.label.startsWith('Last 1 year · ')));
  assert.notEqual(options[0].label, options[1].label);
});

test('Telegram import uses owner SDK authentication while local import requires CSRF', () => {
  assert.equal(canImportPersonalAnalytics(true, '', true), true);
  assert.equal(canImportPersonalAnalytics(false, '', true), false);
  assert.equal(canImportPersonalAnalytics(false, 'current-csrf', true), true);
  assert.equal(canImportPersonalAnalytics(true, '', false), false);
  assert.equal(canImportPersonalAnalytics(false, 'current-csrf', false), false);
});

test('monthly totals add exact decimal text and counts without averaging rates', () => {
  const saved = snapshot([point('2026-01-30', '0.1'), point('2026-01-31', '0.2', 2, 1), point('2026-02-01', '9007199254740993.0001'), point('2026-02-02', '0.0002')]);
  saved.summary.price_per_day = '0.93'; saved.summary.average_duration = '3.7';
  const before = JSON.stringify(saved);
  const monthly = groupPersonalAnalytics(saved, 'month');
  assert.deepEqual(monthly.map(bucket => [bucket.volume, bucket.newRentals, bucket.extensions, bucket.rentals, bucket.partial]), [['0.3', 3, 1, 4, true], ['9007199254740993.0003', 2, 0, 2, true]]);
  assert.equal(JSON.stringify(saved), before);
});

test('yearly totals split at calendar New Year with exact amounts and extension counts', () => {
  const saved = snapshot([
    point('2025-01-02', '0.0002', 3, 1), point('2024-12-31', '0.2', 2, 0),
    point('2025-01-01', '0.0001', 0, 2), point('2024-12-30', '0.1', 1, 1),
  ]);
  saved.period_start = '2024-12-30'; saved.period_end = '2025-01-02'; saved.captured_at = '2025-01-02T12:00:00Z';
  const before = JSON.stringify(saved);
  const yearly = groupPersonalAnalytics(saved, 'year');
  assert.deepEqual(yearly.map(bucket => [bucket.key, bucket.start, bucket.end, bucket.volume, bucket.newRentals, bucket.extensions, bucket.rentals, bucket.partial]), [
    ['2024-01-01', '2024-12-30', '2024-12-31', '0.3', 3, 1, 4, true],
    ['2025-01-01', '2025-01-01', '2025-01-02', '0.0003', 3, 3, 6, true],
  ]);
  assert.equal(JSON.stringify(saved), before, 'grouping must not reorder or alter saved daily evidence');
});

test('a complete leap calendar year has 366 days and is complete when captured the next day', () => {
  const saved = snapshot(Array.from({ length: 366 }, (_, index) => point(
    new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10), '0.0001', 1, index % 10 === 0 ? 1 : 0,
  )));
  saved.captured_at = '2025-01-01T00:01:00Z';
  assert.equal(saved.daily[59].date, '2024-02-29');
  const yearly = groupPersonalAnalytics(saved, 'year');
  assert.equal(yearly.length, 1);
  assert.deepEqual(yearly, [{ key: '2024-01-01', start: '2024-01-01', end: '2024-12-31', volume: '0.0366', newRentals: 366, extensions: 37, rentals: 403, partial: false }]);
});

test('a current year remains partial when the final calendar day is the capture day', () => {
  const saved = snapshot(Array.from({ length: 365 }, (_, index) => point(
    new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10), '0', 0,
  )));
  saved.captured_at = '2025-12-31T12:00:00Z';
  const yearly = groupPersonalAnalytics(saved, 'year');
  assert.equal(yearly.length, 1);
  assert.equal(yearly[0].start, '2025-01-01'); assert.equal(yearly[0].end, '2025-12-31');
  assert.equal(yearly[0].volume, '0'); assert.equal(yearly[0].rentals, 0); assert.equal(yearly[0].partial, true);
  saved.captured_at = '2026-01-01T00:01:00Z';
  assert.equal(groupPersonalAnalytics(saved, 'year')[0].partial, false);
});

test('weeks use Monday UTC even across month/year boundaries, and distinguish partial edges', () => {
  const saved = snapshot(Array.from({ length: 9 }, (_, index) => point(new Date(Date.UTC(2025, 11, 28 + index)).toISOString().slice(0, 10), '0.01')));
  saved.captured_at = '2026-01-05T20:00:00Z';
  const weekly = groupPersonalAnalytics(saved, 'week');
  assert.deepEqual(weekly.map(bucket => [bucket.key, bucket.start, bucket.end, bucket.volume, bucket.partial]), [
    ['2025-12-22', '2025-12-28', '2025-12-28', '0.01', true],
    ['2025-12-29', '2025-12-29', '2026-01-04', '0.07', false],
    ['2026-01-05', '2026-01-05', '2026-01-05', '0.01', true],
  ]);
});

test('explicit zero remains a zero bucket; capture day remains partial', () => {
  const saved = snapshot([point('2026-02-02', '0', 0), point('2026-02-03', '0.01')]);
  const daily = groupPersonalAnalytics(saved, 'day');
  assert.deepEqual(daily.map(bucket => [bucket.volume, bucket.rentals, bucket.partial]), [['0', 0, false], ['0.01', 1, true]]);
  assert.deepEqual(analyticsBarHeights(daily), [0, 100]);
  assert.deepEqual(analyticsBarHeights(groupPersonalAnalytics(snapshot([point('2026-02-02', '0', 0)]), 'day')), [0]);
});

test('invalid dates and monetary floats/scales are rejected instead of rounded or omitted', () => {
  for (const date of ['2026-02-30', 'not a date', '2026-2-01']) assert.throws(() => groupPersonalAnalytics(snapshot([point(date, '1')]), 'day'), /date/);
  for (const value of ['1e-3', '0.00001', '-1', 'NaN']) assert.throws(() => groupPersonalAnalytics(snapshot([point('2026-02-01', value)]), 'day'), /amount/);
});

test('source links never trust credentials, other origins or arbitrary paths', () => {
  const wallet = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c', saved = snapshot([point('2026-02-01', '1')]);
  assert.equal(personalAnalyticsUrl(wallet), `https://marketapp.org/user/${wallet}/?tab=analytics_rent&group_by=day`);
  for (const source_url of ['javascript:alert(1)', `https://marketapp.org.evil.test/user/${wallet}/`, `https://user:secret@marketapp.org/user/${wallet}/`, 'https://marketapp.org/admin/']) {
    saved.source_url = source_url;
    assert.equal(personalAnalyticsUrl(null, saved), 'https://marketapp.org/');
  }
  saved.source_url = `https://marketapp.org/user/${wallet}/?tab=analytics_rent&group_by=week`;
  assert.equal(personalAnalyticsUrl(null, saved), `https://marketapp.org/user/${wallet}/?tab=analytics_rent&group_by=day`);
  assert.equal(personalAnalyticsUrl(`0:${'0'.repeat(64)}`), `https://marketapp.org/user/${wallet}/?tab=analytics_rent&group_by=day`);
  assert.equal(personalAnalyticsUrl('A'.repeat(48)), 'https://marketapp.org/');
  assert.equal(personalAnalyticsUrl('gift-1'), 'https://marketapp.org/');
  assert.match(analyticsPeriod('2025-12-30', '2026-01-03'), /2025.*2026/);
  assert.match(analyticsPeriod('2026-01-01', '2026-01-03'), /2026/);
});

test('capture links retain only supported saved reporting periods and always use daily grouping', () => {
  const wallet = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c', saved = snapshot([point('2026-02-01', '1')]);
  for (const period of ['last7days', 'last14days', 'last30days', 'last60days', 'last90days', 'last180days', 'last365days']) {
    saved.source_url = `https://marketapp.org/user/${wallet}/?period_by=${period}&tab=analytics_rent&group_by=week&collection_ids[]=untrusted&query=untrusted`;
    const url = new URL(personalAnalyticsUrl(null, saved));
    assert.equal(url.searchParams.get('period_by'), period); assert.equal(url.searchParams.get('group_by'), 'day');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['group_by', 'period_by', 'tab']);
  }
  for (const period of ['all', 'last999days', 'last365days&admin=1']) {
    saved.source_url = `https://marketapp.org/user/${wallet}/?period_by=${encodeURIComponent(period)}&group_by=month`;
    const url = new URL(personalAnalyticsUrl(null, saved));
    assert.equal(url.searchParams.has('period_by'), false); assert.equal(url.searchParams.get('group_by'), 'day');
  }
});
