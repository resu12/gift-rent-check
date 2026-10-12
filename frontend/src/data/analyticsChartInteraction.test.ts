import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsBarIndex, analyticsChartPoint } from './analyticsChartInteraction.ts';
import { groupPersonalAnalytics } from './personalAnalytics.ts';
import type { AnalyticsBucket } from './personalAnalytics.ts';
import type { PersonalRentalAnalytics } from './types.ts';

const bucket = (overrides: Partial<AnalyticsBucket> = {}): AnalyticsBucket => ({
  key: '2026-01-01', start: '2026-01-01', end: '2026-01-31', volume: '65.85',
  newRentals: 3, extensions: 1, rentals: 4, partial: false, ...overrides,
});

test('touch columns use left-inclusive boundaries and clamp captured drags at either edge', () => {
  assert.equal(analyticsBarIndex(20, 20, 400, 4), 0);
  assert.equal(analyticsBarIndex(119.999, 20, 400, 4), 0);
  assert.equal(analyticsBarIndex(120, 20, 400, 4), 1);
  assert.equal(analyticsBarIndex(320, 20, 400, 4), 3);
  assert.equal(analyticsBarIndex(420, 20, 400, 4), 3);
  assert.equal(analyticsBarIndex(-1000, 20, 400, 4), 0);
  assert.equal(analyticsBarIndex(1000, 20, 400, 4), 3);
  assert.equal(analyticsBarIndex(-20, -20, 10, 1), 0);
  assert.equal(analyticsBarIndex(500, -20, 10, 1), 0);
});

test('dense daily annual charts resolve every column rather than needing tiny individual touch targets', () => {
  const left = 18, width = 354, count = 365;
  for (let index = 0; index < count; index++) {
    assert.equal(analyticsBarIndex(left + (index + 0.5) / count * width, left, width, count), index);
  }
  assert.equal(analyticsBarIndex(left + width, left, width, count), 364);
});

test('missing, nonfinite or unusable geometry cannot select a bar', () => {
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number];
  for (const value of invalid) {
    assert.equal(analyticsBarIndex(value, 0, 100, 10), null);
    assert.equal(analyticsBarIndex(0, value, 100, 10), null);
    assert.equal(analyticsBarIndex(0, 0, value, 10), null);
    assert.equal(analyticsBarIndex(0, 0, 100, value), null);
  }
  for (const width of [0, -1]) assert.equal(analyticsBarIndex(0, 0, width, 10), null);
  for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(analyticsBarIndex(0, 0, 100, count), null);
  assert.equal(analyticsBarIndex(Number.MAX_VALUE, -Number.MAX_VALUE, 1, 10), 9);
  assert.equal(analyticsBarIndex(-Number.MAX_VALUE, Number.MAX_VALUE, 1, 10), 0);
});

test('chart values retain provider currency and show one-decimal volume with extension-inclusive totals', () => {
  const source = Object.freeze(bucket());
  const displayed = analyticsChartPoint(source);
  assert.equal(displayed.volume, '65.9 GRAM');
  assert.equal(displayed.rentals, '4 rentals (incl. 1 extension)');
  assert.equal(displayed.partial, false);
  assert.match(displayed.period, /2026.* UTC$/);
  assert.equal(source.volume, '65.85');
  assert.equal(analyticsChartPoint(bucket({ volume: '9007199254740993.0501' })).volume, '9,007,199,254,740,993.1 GRAM');
});

test('zero and single-rental periods, repeated extensions and partial date ranges remain explicit', () => {
  const empty = analyticsChartPoint(bucket({ start: '2026-01-01', end: '2026-01-01', volume: '0', newRentals: 0, extensions: 0, rentals: 0 }));
  assert.equal(empty.volume, '0.0 GRAM'); assert.equal(empty.rentals, '0 rentals');
  const single = analyticsChartPoint(bucket({ newRentals: 1, extensions: 0, rentals: 1 }));
  assert.equal(single.rentals, '1 rental');
  const extended = analyticsChartPoint(bucket({ newRentals: 1, extensions: 2, rentals: 3, start: '2025-12-31', end: '2026-01-02', partial: true }));
  assert.equal(extended.rentals, '3 rentals (incl. 2 extensions)');
  assert.equal(extended.partial, true);
  assert.match(extended.period, /2025.*2026.* UTC$/);
});

test('hovered grouped totals include extensions once and do not mutate the saved snapshot', () => {
  const saved: PersonalRentalAnalytics = {
    version: 1, source: 'marketapp_personal_rent_page', source_url: 'https://marketapp.org/', wallet: 'synthetic',
    captured_at: '2026-02-01T12:00:00Z', period_start: '2026-01-30', period_end: '2026-01-31',
    timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees', fingerprint: 'synthetic',
    summary: { rent_volume: '3.35', rentals: 5, new_rentals: 3, extensions: 2, items: 2, price_per_day: null,
      average_duration: null, extension_percent: null, spent_on_rent: null, spending_rentals: null },
    daily: [
      { date: '2026-01-30', rent_volume: '1.1', new_rentals: 2, extensions: 1, rentals: 3 },
      { date: '2026-01-31', rent_volume: '2.25', new_rentals: 1, extensions: 1, rentals: 2 },
    ],
  };
  const before = JSON.stringify(saved);
  const grouped = groupPersonalAnalytics(saved, 'month');
  const displayed = analyticsChartPoint(grouped[0]);
  assert.equal(displayed.volume, '3.4 GRAM');
  assert.equal(displayed.rentals, '5 rentals (incl. 2 extensions)');
  assert.equal(grouped[0].rentals, 5);
  assert.equal(grouped[0].volume, '3.35');
  assert.equal(JSON.stringify(saved), before);
});
