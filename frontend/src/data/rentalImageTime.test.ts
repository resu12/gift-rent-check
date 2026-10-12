import test from 'node:test';
import assert from 'node:assert/strict';
import type { Gift } from './types.ts';
import { approximateRentalRemainingTime, rentalImageTime } from './rentalImageTime.ts';
import { rentedImageMark } from './rentedImageMark.ts';

const now = Date.parse('2026-10-11T12:00:00Z');
const observed = new Date(now).toISOString();
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const rented: Gift = {
  id: 'rented', nft_address: 'nft-rented', name: 'Gift #1', collection_name: 'Gifts', collection_address: 'gifts', image_url: null,
  state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio', is_portfolio: true,
  automatic_membership: true, membership_sources: ['ton_verified'], verification_method: 'rental_contract', proof_badges: [],
  price_per_day: null, price_unit: null, price_source: null, rental_until: null, rental_until_unix_seconds: null,
  rental_remaining_display: '1d 2h', rental_remaining_observed_at: observed, status_is_historical: false,
  observed_at: observed, market_observed_at: null, explorer_url: null, uncertainties: [],
};

test('observed Marketapp compact labels have an explicitly approximate display', () => {
  for (const [source, label] of [
    ['10d 6h', '≈10d6h'], ['9d2h', '≈9d2h'], ['7h 37m', '≈7h37m'], ['13h53m', '≈13h53m'],
    ['29d 18h', '≈29d18h'], ['1d 2h 3m', '≈1d2h3m'], ['1 d 2 h', '≈1d2h'], ['3m', '≈3m'], ['2d', '≈2d'],
  ]) {
    const result = approximateRentalRemainingTime(source, observed, now)!;
    assert.equal(result.label, label, source);
    assert.equal(result.kind, 'approximate'); assert.equal(result.checkRequired, false);
    assert.equal('expiresAt' in result, false);
  }
});

test('local estimates deduct elapsed time while retaining supplied display precision', () => {
  assert.equal(approximateRentalRemainingTime('10d6h', observed, now + 2 * hour)?.label, '≈10d4h');
  assert.equal(approximateRentalRemainingTime('10d6h', observed, now + 2 * hour + 20 * minute)?.label, '≈10d3h');
  assert.equal(approximateRentalRemainingTime('1h', observed, now + minute)?.label, '≈<1h');
  assert.equal(approximateRentalRemainingTime('2d', observed, now + hour)?.label, '≈1d');
  assert.equal(approximateRentalRemainingTime('1d', observed, now + hour)?.label, '≈<1d');
  assert.equal(approximateRentalRemainingTime('7h37m', observed, now + 2 * hour + 20 * minute)?.label, '≈5h17m');
  assert.equal(approximateRentalRemainingTime('1m', observed, now + 30_000)?.label, '≈<1m');
});

test('minute and hour estimates schedule only the next visible change and catch up after a hidden period', () => {
  for (const [source, time] of [['10d6h', now + 12_345], ['7h37m', now + 12_345], ['2d', now + hour]] as const) {
    const result = approximateRentalRemainingTime(source, observed, time)!;
    assert.ok(result.nextUpdateAt! > time);
    assert.equal(approximateRentalRemainingTime(source, observed, result.nextUpdateAt! - 1)?.label, result.label);
    assert.notEqual(approximateRentalRemainingTime(source, observed, result.nextUpdateAt!)?.label, result.label);
  }
  assert.equal(approximateRentalRemainingTime('10d6h', observed, now + 2 * day + hour)?.label, '≈8d5h');
});

test('elapsed estimates request a recheck without inventing an expired rental', () => {
  for (const source of ['1h', '0m', '0d0h']) {
    const elapsed = approximateRentalRemainingTime(source, observed, now + 2 * hour)!;
    assert.deepEqual(elapsed, { label: 'Check time', nextUpdateAt: null, kind: 'approximate', checkRequired: true });
  }
  const gift = { ...rented, rental_remaining_display: '1h' };
  assert.equal(rentalImageTime(gift, now + hour)?.label, 'Check time');
  assert.deepEqual(rentedImageMark(gift, now + hour), { expiresAt: null });
  assert.equal(gift.state, 'rented'); assert.equal(gift.ui_state, 'rented'); assert.equal(gift.rental_until, null);
});

test('malformed, unknown, unordered or unbounded labels never create a countdown', () => {
  for (const display of [null, undefined, 123, '', ' ', '123', 'Unknown', 'Ended', '12:30', '1D', '1 hour', '1.5h', '-1h',
    '1m2h', '1h2d', '1d1d', '1h1h', '1m1m', '1h60m', '1d24h', '1d60m', '366d', '999d', '1000h',
    '1h<script>', '1h\n2m', '1h\t2m', '9'.repeat(65)]) {
    assert.equal(approximateRentalRemainingTime(display, observed, now), null, String(display));
  }
});

test('invalid and future observations cannot anchor a website duration', () => {
  for (const value of [null, undefined, 123, '2026-10-11', '2026-10-11T12:00:00', '2026-02-30T12:00:00Z',
    '2026-13-01T00:00:00Z', '2026-10-11T24:00:00Z', '2026-10-11T12:00:00+99:00', new Date(now + 1).toISOString()]) {
    assert.equal(approximateRentalRemainingTime('1h', value, now), null, String(value));
  }
  for (const invalidNow of [NaN, Infinity, -1, 1.5]) assert.equal(approximateRentalRemainingTime('1h', observed, invalidNow), null);
  assert.equal(approximateRentalRemainingTime('1h', '2026-10-11T14:00:00+02:00', now)?.label, '≈1h');
});

test('exact future TON expiry takes precedence over the rounded website label', () => {
  const gift = { ...rented, rental_until_unix_seconds: (now + 2 * hour + 30 * minute) / 1000 };
  const result = rentalImageTime(gift, now)!;
  assert.equal(result.kind, 'exact'); assert.equal(result.label, '2h30m'); assert.equal(result.checkRequired, false);
  assert.equal(rentalImageTime({ ...gift, rental_until_unix_seconds: undefined, rental_until: new Date(now + hour).toISOString() }, now)?.kind, 'exact');
});

test('expired or malformed exact evidence cannot be replaced by a website estimate', () => {
  for (const expiry of [now / 1000, now / 1000 - 1, 0, -1, 'bad', '1.5', NaN]) {
    assert.equal(rentalImageTime({ ...rented, rental_until_unix_seconds: expiry }, now), null, String(expiry));
  }
});

test('the same rented-mark eligibility gates approximate times and leaves unavailable time unknown', () => {
  for (const change of [{state: 'idle_rental_contract'}, {state: 'unknown'}, {state: 'expired_pending_return'},
    {ui_state: 'for_rent'}, {is_portfolio: false}, {category: 'unresolved' as const}, {collection_conflict: true}, {status_is_historical: true}]) {
    assert.equal(rentalImageTime({ ...rented, ...change }, now), null, JSON.stringify(change));
  }
  for (const change of [{rental_remaining_display: null}, {rental_remaining_observed_at: null}, {rental_remaining_display: 'Unknown'}]) {
    const gift = { ...rented, ...change };
    assert.equal(rentalImageTime(gift, now), null); assert.deepEqual(rentedImageMark(gift, now), { expiresAt: null });
  }
});
