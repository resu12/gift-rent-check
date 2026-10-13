import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTrackingWindow, latestPriceChanges, trackingAmount, trackingComparison, trackingCount, trackingDateRange, trackingEvidence, trackingObservedRentals, trackingPaymentAmount, trackingPaymentHistoryPending, trackingWindowStatus } from './priceTracking.ts';
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

test('a new preferred-source baseline does not hide retained independently observed changes', () => {
  const contract = { ...change, source: 'TON contract' as const, source_last_observed_at: '2026-10-11T00:00:00Z' };
  const listing = { ...change, id: 'listing-older', source: 'Marketapp listing' as const, observed_at: '2026-10-08T00:00:00Z' };
  const tracking = { ...base.price_tracking!, source: 'Marketapp account' as const, observation_count: 1,
    baseline_observed_at: '2026-10-12T00:00:00Z', baseline_price_per_day: '0.15', last_observed_at: '2026-10-12T01:00:00Z',
    changes: [listing, contract], change_count: 2 };
  const gift = { ...base, price_tracking: tracking };
  assert.equal(latestPriceChanges([gift])[0].change, contract);
  assert.deepEqual(trackingEvidence(tracking, contract), { source: 'TON contract', lastObservedAt: contract.source_last_observed_at });
  assert.deepEqual(trackingEvidence(tracking), { source: 'Marketapp account', lastObservedAt: tracking.last_observed_at });
  assert.equal(trackingComparison(contract, 7), beforeAfter, 'the source-specific comparison remains attached to its change');
});

test('legacy single-source price changes retain their source and check date', () => {
  assert.deepEqual(trackingEvidence(base.price_tracking!, change), {
    source: 'TON contract', lastObservedAt: base.price_tracking!.last_observed_at,
  });
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

test('verified starts missing payment history count once without implying a zero payment', () => {
  const before = { ...period, observed_rentals: 0, recorded_rentals: 0, verified_rentals_without_history: 0, recorded_volume: '0', average_daily_rate: null };
  const after = { ...before, observed_rentals: 1, verified_rentals_without_history: 1 };
  const original = structuredClone(after);
  assert.equal(trackingObservedRentals(before), '0');
  assert.equal(trackingObservedRentals(after), '1', 'the server has already included the verified start');
  assert.equal(trackingPaymentHistoryPending(before), false);
  assert.equal(trackingPaymentHistoryPending(after), true);
  assert.equal(trackingPaymentAmount(before, before.recorded_volume, 1), '0.0');
  assert.equal(trackingPaymentAmount(after, after.recorded_volume, 1), '—');
  assert.equal(trackingPaymentAmount(after, after.average_daily_rate), '—');
  assert.deepEqual(after, original, 'rendering must not replace the saved history values');
});

test('history arriving for the verified start makes payment available without increasing its rental count', () => {
  const pending = { ...period, recorded_rentals: 0, observed_rentals: 1, verified_rentals_without_history: 1, recorded_volume: '0', average_daily_rate: null };
  const received = { ...pending, recorded_rentals: 1, verified_rentals_without_history: 0, recorded_volume: '11.1', average_daily_rate: '0.37' };
  assert.equal(trackingObservedRentals(pending), trackingObservedRentals(received));
  assert.equal(trackingPaymentHistoryPending(received), false);
  assert.equal(trackingPaymentAmount(received, received.recorded_volume, 1), '11.1');
  assert.equal(trackingPaymentAmount(received, received.average_daily_rate), '0.370');
});

test('a mixed sample keeps its recorded payments separate from its additional verified start', () => {
  const mixed = { ...period, observed_rentals: 3, verified_rentals_without_history: 1 };
  assert.equal(trackingObservedRentals(mixed), '3');
  assert.equal(mixed.recorded_rentals, 2);
  assert.equal(trackingPaymentHistoryPending(mixed), true);
  assert.equal(trackingPaymentAmount(mixed, mixed.recorded_volume, 1), '1.2');
  assert.equal(trackingPaymentAmount(mixed, mixed.average_daily_rate), '0.120');
});

test('deduplicated rental starts remain authoritative when multiple payment records share a start', () => {
  const sharedStart = { ...period, observed_rentals: 1, verified_rentals_without_history: 0 };
  assert.equal(trackingObservedRentals(sharedStart), '1');
  assert.equal(sharedStart.recorded_rentals, 2, 'accepted payment records remain independent of the distinct start count');
  assert.equal(trackingPaymentHistoryPending(sharedStart), false);
  assert.equal(trackingPaymentAmount(sharedStart, sharedStart.recorded_volume, 1), '1.2');
});

test('legacy comparisons retain their history counts and monetary labels', () => {
  assert.equal(trackingObservedRentals(period), '2');
  assert.equal(trackingPaymentHistoryPending(period), false);
  assert.equal(trackingPaymentAmount(period, period.recorded_volume, 1), '1.2');
  assert.equal(trackingObservedRentals({ ...period, recorded_rentals: null }), '—');
  assert.equal(trackingObservedRentals({ ...period, recorded_rentals: 0 }), '0');
  assert.equal(trackingPaymentAmount({ ...period, recorded_rentals: 0 }, '0', 1), '0.0');
});

test('explicit unknown or invalid observed counts never fall back to a misleading recorded count', () => {
  for (const observed_rentals of [null, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(trackingObservedRentals({ ...period, observed_rentals }), '—');
  }
  for (const verified_rentals_without_history of [undefined, null, 0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(trackingPaymentHistoryPending({ ...period, verified_rentals_without_history }), false);
  }
  assert.equal(trackingObservedRentals({ ...period, observed_rentals: 0 }), '0');
});

test('comparison date labels use UTC boundaries and malformed dates stay unavailable', () => {
  const expected = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date('2026-10-10T00:00:00Z'));
  assert.equal(trackingDateRange('2026-10-09T23:00:00-01:00', '2026-10-10T23:59:00Z'), expected);
  assert.equal(trackingDateRange('bad-date', null), 'Dates unavailable');
});
