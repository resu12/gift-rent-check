import test from 'node:test';
import assert from 'node:assert/strict';
import type { Gift, GiftRentalStatistics } from './types.ts';
import { giftRentalAmount, giftRentalStatistics, rentalStatisticsRows } from './giftRentalStatistics.ts';

const now = Date.parse('2026-10-14T00:00:00Z');
const stats: GiftRentalStatistics = {
  version: 1, semantics_version: 'saved-gift-rental-statistics-v1', coverage: 'partial',
  observed_at: '2026-10-13T08:00:00Z', first_rental_at: '2026-10-01T00:00:00Z', last_rental_at: '2026-10-12T00:00:00Z',
  observed_rentals: 2, recorded_rentals: 2, verified_rentals_without_history: 0,
  recorded_volume: '1.234', average_daily_rate: '0.1234', rental_days: '10', excluded_counts: {},
};
const base: Gift = {
  id: 'gift', nft_address: 'nft-gift', name: 'Heart Locket #1767', collection_name: 'Heart Lockets', collection_address: 'collection', image_url: null,
  state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio', is_portfolio: true, automatic_membership: true,
  membership_sources: ['ton_verified'], verification_method: 'rental_contract', proof_badges: [], price_per_day: '0.37', price_unit: 'GRAM',
  price_source: 'TON contract', rental_until: null, observed_at: null, market_observed_at: null, explorer_url: null, uncertainties: [], rental_statistics: stats,
};
const gift = (id: string, overrides: Partial<GiftRentalStatistics> = {}): Gift => ({ ...base, id, nft_address: `nft-${id}`, name: `Gift #${id}`, rental_statistics: { ...stats, ...overrides } });

test('saved gift statistics do not require price changes or a current rental', () => {
  assert.equal(giftRentalStatistics(base, now), stats);
  assert.equal(giftRentalStatistics({ ...base, state: 'available', ui_state: 'available', price_tracking: undefined, price_per_day: null }, now), stats);
});

test('legacy, unknown and conflicted data never become zero rentals or invented income', () => {
  for (const entry of [
    { ...base, rental_statistics: undefined }, { ...base, is_portfolio: false }, { ...base, collection_conflict: true },
    gift('unknown', { coverage: 'no_history', observed_rentals: null }), gift('not-applicable', { coverage: 'not_applicable' }),
    gift('version', { semantics_version: 'unsupported' as GiftRentalStatistics['semantics_version'] }),
  ]) assert.equal(giftRentalStatistics(entry, now), null);
});

test('verified rental starts can be shown while their payments remain unknown', () => {
  const entry = gift('verified', { observed_rentals: 1, recorded_rentals: null, verified_rentals_without_history: 1, recorded_volume: null, average_daily_rate: null, rental_days: null });
  assert.equal(giftRentalStatistics(entry, now)?.observed_rentals, 1);
  assert.equal(giftRentalAmount(giftRentalStatistics(entry, now)?.recorded_volume), '—');
  assert.equal(giftRentalStatistics({ ...entry, rental_statistics: { ...entry.rental_statistics!, recorded_volume: '0' } }, now), null);
  assert.equal(giftRentalStatistics(gift('mixed', { observed_rentals: 3, verified_rentals_without_history: 1 }), now)?.recorded_volume, '1.234');
});

test('invalid totals, durations, counts and timestamps are rejected', () => {
  for (const override of [
    { observed_rentals: 0 }, { observed_rentals: 2.5 }, { observed_rentals: Number.MAX_SAFE_INTEGER + 1 }, { observed_rentals: 5 },
    { recorded_rentals: -1 }, { verified_rentals_without_history: 3 }, { recorded_volume: '-1' }, { average_daily_rate: 'NaN' }, { rental_days: '0.000' },
    { first_rental_at: '2026-02-30T00:00:00Z' }, { observed_at: '2027-10-14T00:00:00Z' },
    { first_rental_at: '2026-10-13T00:00:00Z' }, { observed_at: '2026-10-11T00:00:00Z' },
  ]) assert.equal(giftRentalStatistics(gift('bad', override), now), null, JSON.stringify(override));
});

test('distinct starts may have multiple payment records without inflating the start count', () => {
  assert.equal(giftRentalStatistics(gift('shared', { observed_rentals: 1, recorded_rentals: 2 }), now)?.observed_rentals, 1);
});

test('volume sorting uses exact decimals before rounding and keeps missing payments last', () => {
  const rows = [gift('1', { recorded_volume: '9007199254740992.000001' }), gift('2', { recorded_volume: '9007199254740992.000002' }),
    gift('3', { recorded_volume: '0' }), { ...gift('0'), rental_statistics: undefined }];
  const original = structuredClone(rows);
  assert.deepEqual(rentalStatisticsRows(rows, '', 'volume', now).map(row => row.gift.id), ['2', '1', '3', '0']);
  assert.deepEqual(rows, original);
});

test('count, date and natural name sorts are stable, with unknowns last', () => {
  const entries = [gift('10', { observed_rentals: 1, last_rental_at: '2026-10-10T00:00:00Z' }), gift('2'), { ...gift('1'), rental_statistics: undefined }];
  for (const sort of ['rentals', 'recent'] as const) assert.deepEqual(rentalStatisticsRows(entries, '', sort, now).map(row => row.gift.id), ['2', '10', '1']);
  assert.deepEqual(rentalStatisticsRows(entries, '', 'name', now).map(row => row.gift.id), ['1', '2', '10']);
});

test('only portfolio gifts are searchable and duplicate observations use the latest valid projection', () => {
  const newer = { ...base, id: 'newer', rental_statistics: { ...stats, observed_at: '2026-10-13T09:00:00Z' } };
  const entries = [base, newer, { ...gift('candidate'), is_portfolio: false }];
  assert.deepEqual(rentalStatisticsRows(entries, ' heart lockets ', 'volume', now).map(row => row.gift.id), ['newer']);
  assert.equal(rentalStatisticsRows(entries, '1767', 'volume', now).length, 1);
  assert.equal(rentalStatisticsRows(entries, 'candidate', 'volume', now).length, 0);
  assert.equal(rentalStatisticsRows([{ ...gift('1'), nft_address: '' }, { ...gift('2'), nft_address: '' }], '', 'volume', now).length, 2);
});

test('one decimal volume and three decimal daily rates preserve exact rounding and reject unsafe text', () => {
  assert.equal(giftRentalAmount('1.25'), '1.3');
  assert.equal(giftRentalAmount('0.1455', 3), '0.146');
  assert.equal(giftRentalAmount('99999999999999999.95'), '100,000,000,000,000,000.0');
  for (const value of [null, undefined, '', '-1', 'NaN', 'Infinity', '1e99999', '9'.repeat(2001)]) assert.equal(giftRentalAmount(value), '—');
});
