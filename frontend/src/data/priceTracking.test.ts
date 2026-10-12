import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTrackingWindow, latestPriceChanges, trackingAmount, trackingComparison, trackingCount, trackingDateRange, trackingWindowStatus } from './priceTracking.ts';
import type { Gift, ObservedPriceChange, PriceTrackingComparison } from './types.ts';

const period = { window_from: '2026-10-03T00:00:00Z', window_to: '2026-10-10T00:00:00Z', recorded_rentals: 2,
  recorded_volume: '1.234', average_daily_rate: '0.12', rental_days: '10', excluded_counts: {}, coverage: 'observed_sample' as const };
const beforeAfter: PriceTrackingComparison = { days: 7, status: 'ready', comparable_days: '7', before: period, after: { ...period, recorded_rentals: 3 } };
const change: ObservedPriceChange = { id: 'change-1', observed_at: '2026-10-10T00:00:00Z', previous_observed_at: '2026-10-09T00:00:00Z',
  from_price_per_day: '0.1', to_price_per_day: '0.15', delta_per_day: '0.05', percent_change: '50', comparisons: [beforeAfter] };
const base: Gift = {
  id: 'owned', nft_address: 'nft-owned', name: 'Electric Skull #6175',
  collection_name: 'Electric Skulls', collection_address: 'skulls', image_url: null,
  state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio',
  is_portfolio: true, automatic_membership: true, membership_sources: ['ton_verified'],
  verification_method: 'rental_contract', proof_badges: [], price_per_day: '0.15',
  price_unit: 'GRAM', price_source: 'TON contract', rental_until: null, observed_at: null,
  market_observed_at: null, explorer_url: null, uncertainties: [],
  price_tracking: { version: 1, semantics_version: 'observed-price-performance-v1', source: 'TON contract', unit: 'GRAM/day',
    observation_count: 2, change_count: 1, last_observed_at: change.observed_at, baseline_price_per_day: '0.1', baseline_observed_at: change.previous_observed_at,
    coverage: 'observed_sample', changes: [change], warnings: [] },
};

test('recent price changes are globally sorted, bounded, and exclude unresolved candidates without mutation', () => {
  const gifts = Array.from({ length: 8 }, (_, index) => ({ ...base, id: `gift-${index}`, price_tracking: {
    ...base.price_tracking!, changes: [{ ...change, id: `change-${index}`, observed_at: `2026-10-${String(10 + index).padStart(2, '0')}T00:00:00Z` }],
  } }));
  gifts.push({ ...base, id: 'candidate', is_portfolio: false, price_tracking: {
    ...base.price_tracking!, changes: [{ ...change, observed_at: '2026-12-01T00:00:00Z' }],
  } });
  const original = structuredClone(gifts);
  assert.deepEqual(latestPriceChanges(gifts).map(item => item.gift.id), ['gift-7', 'gift-6', 'gift-5', 'gift-4', 'gift-3']);
  assert.equal(latestPriceChanges(gifts, 50).length, 5);
  assert.equal(latestPriceChanges(gifts, 0).length, 0);
  assert.deepEqual(gifts, original);
});

test('only the latest change per gift appears so opening a row matches the details, and invalid timestamps cannot hide valid history', () => {
  const older = { ...change, id: 'older', observed_at: '2026-10-08T00:00:00Z' };
  const invalid = { ...change, id: 'invalid', observed_at: 'not-a-date' };
  const gift = { ...base, price_tracking: { ...base.price_tracking!, changes: [invalid, older, change] } };
  assert.deepEqual(latestPriceChanges([gift]).map(item => item.change.id), ['change-1']);
  assert.deepEqual(gift.price_tracking.changes.map(item => item.id), ['invalid', 'older', 'change-1']);
  assert.deepEqual(latestPriceChanges([{ ...base, price_tracking: undefined }]), []);
});

test('a selected comparison never silently falls back to a different period', () => {
  assert.equal(trackingComparison(change, 7), beforeAfter);
  assert.equal(trackingComparison(change, 30), null);
  assert.equal(trackingWindowStatus(null), 'Comparison unavailable');
});

test('elapsed-period labels do not claim exhaustive history coverage', () => {
  assert.equal(trackingWindowStatus(beforeAfter), '7-day sample');
  assert.equal(trackingWindowStatus({ ...beforeAfter, status: 'partial', comparable_days: '2.34' }), '2.3 of 7 days observed');
  assert.equal(trackingWindowStatus({ ...beforeAfter, status: 'pending', comparable_days: '0' }), 'Waiting for after period');
  assert.equal(beforeAfter.before.coverage, 'observed_sample');
});

test('pending full windows retain positive shorter samples, while zero elapsed time and malformed evidence do not qualify', () => {
  const pending = { ...beforeAfter, status: 'pending' as const, comparable_days: '2.34' };
  assert.equal(hasTrackingWindow(pending), true);
  assert.equal(trackingWindowStatus(pending), '2.3 of 7 days observed');
  assert.equal(hasTrackingWindow({ ...pending, comparable_days: '0.000' }), false);
  assert.equal(trackingWindowStatus({ ...pending, status: 'partial', comparable_days: '0.000' }), 'No verified comparison window');
  assert.equal(hasTrackingWindow({ ...pending, comparable_days: '0.001' }), true);
  assert.equal(trackingWindowStatus({ ...pending, comparable_days: '0.001' }), '<0.1 of 7 days observed');
  assert.equal(trackingWindowStatus({ ...pending, comparable_days: '6.999' }), '6.9 of 7 days observed');
  assert.equal(hasTrackingWindow({ ...pending, comparable_days: '-2' }), false);
  assert.equal(hasTrackingWindow(null), false);
});

test('monetary labels preserve exact decimal precision with distinct volume and daily-price rounding', () => {
  assert.equal(trackingAmount('0.1455'), '0.146');
  assert.equal(trackingAmount('1.234', 1), '1.2');
  assert.equal(trackingAmount('99999999999999999.9995'), '100,000,000,000,000,000.000');
  assert.equal(trackingAmount('0'), '0.000');
  assert.equal(trackingAmount(null), '—');
  for (const value of ['', 'NaN', 'Infinity', '-1', '0<script>', '1e999999', '9'.repeat(2001)]) assert.equal(trackingAmount(value), '—');
});

test('unavailable saved records remain unknown while an observed zero remains zero', () => {
  assert.equal(trackingCount(null), '—');
  assert.equal(trackingCount(undefined), '—');
  assert.equal(trackingCount(0), '0');
  for (const value of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(trackingCount(value), '—');
});

test('comparison date labels use UTC boundaries and malformed dates stay unavailable', () => {
  const expected = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date('2026-10-10T00:00:00Z'));
  assert.equal(trackingDateRange('2026-10-09T23:00:00-01:00', '2026-10-10T23:59:00Z'), expected);
  assert.equal(trackingDateRange('bad-date', null), 'Dates unavailable');
});
