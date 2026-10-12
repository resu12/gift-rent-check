import test from 'node:test';
import assert from 'node:assert/strict';
import { rentedImageMark } from './rentedImageMark.ts';
import type { Gift } from './types.ts';

const now = Date.parse('2026-10-10T12:00:00Z');
const rented: Gift = {
  id: 'rented', nft_address: 'nft-rented', name: 'Low Rider #10610',
  collection_name: 'Low Riders', collection_address: 'low-riders', image_url: null,
  state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio',
  is_portfolio: true, automatic_membership: true, membership_sources: ['ton_verified'],
  verification_method: 'rental_contract', proof_badges: [], price_per_day: '0.170',
  price_unit: 'GRAM', price_source: 'ton_contract', rental_until: null,
  rental_until_unix_seconds: now / 1000 + 3600, observed_at: '2026-10-10T11:59:00Z',
  market_observed_at: null, explorer_url: null, uncertainties: [],
};

test('current supported rental evidence produces a compact mark with a known expiry', () => {
  assert.deepEqual(rentedImageMark(rented, now), { expiresAt: now + 3_600_000 });
  assert.deepEqual(rentedImageMark({ ...rented, rental_until_unix_seconds: String(now / 1000 + 3600) }, now), { expiresAt: now + 3_600_000 });
  assert.deepEqual(rentedImageMark({ ...rented, ui_state: null }, now), { expiresAt: now + 3_600_000 });
});

test('idle, direct, expired and uncertain gifts never receive a rented image mark', () => {
  for (const state of ['idle_rental_contract', 'held_directly', 'expired_pending_return', 'unknown', 'uncertain', 'active_rental', 'listed_for_sale']) {
    assert.equal(rentedImageMark({ ...rented, state }, now), null, state);
  }
  for (const ui_state of ['for_rent', 'unknown', 'review', 'expired', 'listed_for_sale']) {
    assert.equal(rentedImageMark({ ...rented, ui_state }, now), null, ui_state);
  }
});

test('unverified candidates and membership conflicts cannot display the rented mark', () => {
  assert.equal(rentedImageMark({ ...rented, is_portfolio: false }, now), null);
  assert.equal(rentedImageMark({ ...rented, category: 'unresolved' }, now), null);
  assert.equal(rentedImageMark({ ...rented, state: 'ownership_conflict' }, now), null);
  assert.equal(rentedImageMark({ ...rented, collection_conflict: true }, now), null);
});

test('unsuccessfully rechecked rental evidence cannot appear as a current rental', () => {
  assert.equal(rentedImageMark({ ...rented, status_is_historical: true }, now), null);
  assert.deepEqual(rentedImageMark({ ...rented, status_is_historical: false }, now), { expiresAt: now + 3_600_000 });
  // Old desktop records lack this flag; their existing supported state is still
  // readable while a known expiry prevents an expired current mark.
  assert.deepEqual(rentedImageMark({ ...rented, status_is_historical: undefined }, now), { expiresAt: now + 3_600_000 });
});

test('known expired or malformed expiry suppresses a rented mark without claiming a return', () => {
  for (const rental_until_unix_seconds of [now / 1000, now / 1000 - 1, 0, -1, NaN, Infinity, 1.5, '', ' ', 'bad', '178.1', '9007199254740993']) {
    assert.equal(rentedImageMark({ ...rented, rental_until_unix_seconds }, now), null, String(rental_until_unix_seconds));
  }
  assert.equal(rentedImageMark(rented, now + 3_600_000), null);
  assert.equal(rented.state, 'rented');
});

test('legacy ISO expiry is comparable while opaque numeric timestamp units remain unresolved', () => {
  const legacy = { ...rented, rental_until_unix_seconds: undefined };
  assert.deepEqual(rentedImageMark({ ...legacy, rental_until: '2026-10-10T15:00:00+02:00' }, now), { expiresAt: now + 3_600_000 });
  assert.equal(rentedImageMark({ ...legacy, rental_until: '2026-10-10T14:00:00+02:00' }, now), null);
  assert.equal(rentedImageMark({ ...legacy, rental_until: '2026-99-99T00:00:00Z' }, now), null);
  for (const rental_until of [null, 12, '12']) assert.deepEqual(rentedImageMark({ ...legacy, rental_until }, now), { expiresAt: null });
});

test('explicit seconds evidence takes precedence over stale legacy ISO expiry', () => {
  assert.deepEqual(rentedImageMark({ ...rented, rental_until: '2026-10-09T12:00:00Z' }, now), { expiresAt: now + 3_600_000 });
  assert.equal(rentedImageMark({ ...rented, rental_until: '2026-10-11T12:00:00Z', rental_until_unix_seconds: now / 1000 - 1 }, now), null);
});
