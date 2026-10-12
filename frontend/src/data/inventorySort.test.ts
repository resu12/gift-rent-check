import assert from 'node:assert/strict';
import test from 'node:test';
import { sortInventoryGifts } from './inventorySort.ts';
import type { Gift, GiftRentalHistory } from './types.ts';

const now = Date.parse('2026-10-12T12:00:00Z');
const stamp = (difference: number) => new Date(now + difference).toISOString();
function gift(id: string, changes: Partial<Gift> = {}): Gift {
  return { id, nft_address: id, name: `Gift #${id}`, collection_name: 'Gifts', collection_address: 'gifts',
    image_url: null, state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio',
    is_portfolio: true, automatic_membership: true, membership_sources: ['ton_discovery'], verification_method: 'rental_contract',
    proof_badges: [], price_per_day: '0.1', price_unit: 'GRAM', price_source: 'TON contract', price_is_historical: false,
    rental_until: null, status_is_historical: false, observed_at: stamp(-60000), market_observed_at: null,
    explorer_url: null, uncertainties: [], ...changes };
}
const history = (last: string | null, changes: Partial<GiftRentalHistory> = {}): GiftRentalHistory => ({
  recorded_count: 2, coverage: 'partial', note: 'Saved confirmed rental starts.', observed_at: stamp(-60000),
  last_rental_at: last, excluded_counts: {}, ...changes,
});
const ids = (gifts: Gift[]) => gifts.map(item => item.id);

test('default inventory order is preserved in a new array without changing gifts or membership', () => {
  const input = [gift('10'), gift('2'), gift('1')], before = JSON.stringify(input);
  const sorted = sortInventoryGifts(input, 'default', now);
  assert.deepEqual(ids(sorted), ['10', '2', '1']); assert.notEqual(sorted, input);
  assert.equal(sorted[0], input[0]); assert.equal(JSON.stringify(input), before);
});

test('name order is natural and case-insensitive with unknown names last and stable equal names', () => {
  const input = [gift('unknown', { name: null }), gift('10'), gift('two-upper', { name: 'GIFT #2' }),
    gift('two-lower', { name: 'gift #2' }), gift('1'), gift('blank', { name: '  ' })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'name_asc', now)), ['1', 'two-upper', 'two-lower', '10', 'unknown', 'blank']);
});

test('price sorts use exact decimals beyond floating-point precision and preserve zero as a valid amount', () => {
  const input = [gift('low', { price_per_day: '0.100000000000000000001' }), gift('high', { price_per_day: '0.100000000000000000002' }),
    gift('zero', { price_per_day: '0' }), gift('large', { price_per_day: '9007199254740993.001' }),
    gift('less-large', { price_per_day: '9007199254740993.000' })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'price_asc', now)), ['zero', 'low', 'high', 'less-large', 'large']);
  assert.deepEqual(ids(sortInventoryGifts(input, 'price_desc', now)), ['large', 'less-large', 'high', 'low', 'zero']);
});

test('equivalent price representations tie by natural name without rounding their saved values', () => {
  const input = [gift('10', { price_per_day: '0.1000' }), gift('2', { price_per_day: '1e-1', price_unit: 'GRAM/day' }),
    gift('1', { price_per_day: '00.1' }), gift('small', { price_per_day: '1e-9' })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'price_desc', now)), ['1', '2', '10', 'small']);
  assert.deepEqual(input.map(item => item.price_per_day), ['0.1000', '1e-1', '00.1', '1e-9']);
});

test('foreign currency, historical values, conflicting evidence and absent source sort last in both price directions', () => {
  const unknown = [gift('1', { price_unit: 'TON' }), gift('2', { price_unit: 'USD' }), gift('3', { price_is_historical: true }),
    gift('4', { collection_conflict: true }), gift('5', { price_source: null }), gift('6', { price_unit: null })];
  const input = [...unknown, gift('valid', { price_per_day: '0.001' })];
  for (const order of ['price_asc', 'price_desc'] as const) assert.deepEqual(ids(sortInventoryGifts(input, order, now)), ['valid', '1', '2', '3', '4', '5', '6']);
});

test('missing, malformed, negative and unbounded price strings remain unknown rather than zero', () => {
  const invalid = [null, '', ' ', 'NaN', 'Infinity', '-0.1', '1,000', '1.2.3', '0x1', '1e1001', '1e-1001', '1e99999999999999999999', '1'.repeat(2001)];
  const input = invalid.map((price_per_day, index) => gift(String(index), { price_per_day }));
  input.push(gift('known-zero', { price_per_day: '0' }));
  assert.equal(sortInventoryGifts(input, 'price_asc', now)[0].id, 'known-zero');
  assert.equal(sortInventoryGifts(input, 'price_desc', now)[0].id, 'known-zero');
});

test('last rented uses only confirmed rental starts, never check times, observation times or expiry', () => {
  const input = [gift('old', { rental_history: history(stamp(-86400000)), observed_at: stamp(0) }),
    gift('checked-now', { status_checked_at: stamp(0), status_observed_at: stamp(0), rental_until_unix_seconds: (now + 3600000) / 1000 }),
    gift('new', { rental_history: history(stamp(-60000)), observed_at: stamp(-86400000) }),
    gift('missing-start', { rental_history: history(null, { observed_at: stamp(0) }) })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'last_rented', now)), ['new', 'old', 'checked-now', 'missing-start']);
});

test('invalid, future and contradictory history summaries cannot establish a last rental', () => {
  const invalid = [history('2026-02-30T12:00:00Z'), history(stamp(1)), history('2026-10-12'),
    history(stamp(-60000), { recorded_count: 0 }), history(stamp(-60000), { recorded_count: null }),
    history(stamp(-60000), { recorded_count: -1 }), history(stamp(-60000), { coverage: 'no_history' }),
    history(stamp(-60000), { coverage: 'not_applicable' })];
  const input = invalid.map((rental_history, index) => gift(String(index), { rental_history }));
  input.push(gift('known', { rental_history: history(stamp(-86400000)) }));
  assert.equal(sortInventoryGifts(input, 'last_rented', now)[0].id, 'known');
});

test('a newly rented gift without saved history sorts ahead of older recorded rentals', () => {
  const input = [gift('older', { rental_history: history(stamp(-86400000)) }),
    gift('new-current', { rental_history: history(null, { recorded_count: null, coverage: 'no_history' }),
      current_rental_started_at: stamp(-60000), current_rental_start_source: 'verified_contract' }),
    gift('unknown')];
  assert.deepEqual(ids(sortInventoryGifts(input, 'last_rented', now)), ['new-current', 'older', 'unknown']);
});

test('last rented combines verified current starts and recorded history without letting expiry or extensions move the start', () => {
  const input = [gift('extended', { current_rental_started_at: stamp(-86400000), current_rental_start_source: 'verified_contract',
      rental_until: stamp(86400000 * 90), rental_history: history(stamp(-86400000 * 2)) }),
    gift('new', { current_rental_started_at: stamp(-3600000), current_rental_start_source: 'verified_contract', rental_until: stamp(60000) }),
    gift('newer-history', { current_rental_started_at: stamp(-86400000), current_rental_start_source: 'verified_contract',
      rental_history: history(stamp(-60000)) })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'last_rented', now)), ['newer-history', 'new', 'extended']);
});

test('unverified, historical, conflicting, invalid and future current starts cannot override valid history', () => {
  const invalid: Partial<Gift>[] = [{ current_rental_start_source: null }, { status_is_historical: true },
    { status_is_historical: undefined }, { collection_conflict: true }, { category: 'unresolved' }, { is_portfolio: false },
    { state: 'idle_rental_contract' }, { state: 'held_directly' }, { ui_state: 'for_rent' },
    { current_rental_started_at: stamp(1) }, { current_rental_started_at: '2026-02-30T12:00:00Z' },
    { current_rental_started_at: '2026-10-12' }];
  const input = invalid.map((change, index) => gift(String(index), { current_rental_started_at: stamp(-1000),
    current_rental_start_source: 'verified_contract', rental_history: history(stamp(-86400000)), ...change }));
  input.push(gift('known', { rental_history: history(stamp(-3600000)) }));
  assert.equal(sortInventoryGifts(input, 'last_rented', now)[0].id, 'known');
});

test('a verified completed term still establishes the last start while return is pending', () => {
  const input = [gift('older', { rental_history: history(stamp(-86400000 * 7)) }),
    gift('pending', { state: 'expired_pending_return', ui_state: null, rental_until: stamp(-1000),
      current_rental_started_at: stamp(-86400000), current_rental_start_source: 'verified_contract' })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'last_rented', now)), ['pending', 'older']);
});

test('last-rented order stays stable through website refresh, pending TON check, failure and completion', () => {
  const older = gift('older', { rental_history: history(stamp(-86400000)) });
  const base = gift('latest', { rental_history: history(null, { recorded_count: null, coverage: 'no_history' }),
    last_verified_rental_started_at: stamp(-60000), last_verified_rental_start_source: 'verified_contract' });
  const phases: Partial<Gift>[] = [
    { current_rental_started_at: stamp(-60000), current_rental_start_source: 'verified_contract', rental_until: stamp(86400000) },
    { current_rental_started_at: null, current_rental_start_source: null, rental_until: null, rental_remaining_display: '1d' },
    { current_rental_started_at: null, status_is_historical: true, state: 'unknown', ui_state: null },
    { current_rental_started_at: stamp(-60000), current_rental_start_source: 'verified_contract', rental_until: stamp(86400000) },
  ];
  for (const phase of phases) assert.deepEqual(ids(sortInventoryGifts([older, { ...base, ...phase }], 'last_rented', now)), ['latest', 'older']);
  assert.equal(base.rental_history?.recorded_count, null);
});

test('a previously verified rental start remains a date fact after return without claiming a current rental', () => {
  const returned = gift('returned', { state: 'held_directly', ui_state: null, current_rental_started_at: null,
    last_verified_rental_started_at: stamp(-60000), last_verified_rental_start_source: 'verified_contract' });
  assert.deepEqual(ids(sortInventoryGifts([gift('older', { rental_history: history(stamp(-86400000)) }), returned], 'last_rented', now)), ['returned', 'older']);
  assert.equal(sortInventoryGifts([returned], 'last_rented', now)[0].state, 'held_directly');
});

test('invalid historical contract starts cannot rank unverified, conflicting or non-portfolio evidence', () => {
  const changes: Partial<Gift>[] = [{ last_verified_rental_start_source: null }, { collection_conflict: true },
    { is_portfolio: false }, { category: 'unresolved' }, { last_verified_rental_started_at: stamp(1) },
    { last_verified_rental_started_at: '2026-02-30T12:00:00Z' }, { last_verified_rental_started_at: '2026-10-12' }];
  const unknown = changes.map((change, index) => gift(String(index), { last_verified_rental_started_at: stamp(-1000),
    last_verified_rental_start_source: 'verified_contract', ...change }));
  assert.equal(sortInventoryGifts([...unknown, gift('known', { rental_history: history(stamp(-86400000)) })], 'last_rented', now)[0].id, 'known');
});

test('equal history instants with different offsets tie naturally and retain original input for equal names', () => {
  const input = [gift('10', { rental_history: history('2026-10-12T11:00:00Z') }),
    gift('2', { rental_history: history('2026-10-12T13:00:00+02:00') })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'last_rented', now)), ['2', '10']);
});

test('rental ending orders only saved exact future expiries, with explicit seconds and ISO aliases equivalent', () => {
  const input = [gift('late', { rental_until_unix_seconds: String((now + 7200000) / 1000) }),
    gift('soon', { rental_until: stamp(60000) }), gift('middle', { rental_until_unix_seconds: (now + 3600000) / 1000 }),
    gift('approximate', { rental_remaining_display: '1m', rental_remaining_observed_at: stamp(0) })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'rental_ending', now)), ['soon', 'middle', 'late', 'approximate']);
});

test('expired, malformed, historical, non-rented and conflicting expiry evidence sorts last', () => {
  const invalid: Partial<Gift>[] = [{ rental_until_unix_seconds: now / 1000 }, { rental_until_unix_seconds: -1 },
    { rental_until_unix_seconds: 'bad', rental_until: stamp(60000) }, { rental_until: '2027-02-30T12:00:00Z' },
    { rental_until: '2026-10-13T24:00:00Z' }, { rental_until: (now + 60000) / 1000 },
    { state: 'idle_rental_contract', rental_until: stamp(60000) }, { status_is_historical: true, rental_until: stamp(60000) },
    { collection_conflict: true, rental_until: stamp(60000) }, { category: 'unresolved', rental_until: stamp(60000) },
    { is_portfolio: false, rental_until: stamp(60000) }, { ui_state: 'for_rent', rental_until: stamp(60000) }];
  const input = invalid.map((change, index) => gift(String(index), change));
  input.push(gift('known', { rental_until: stamp(86400000) }));
  assert.equal(sortInventoryGifts(input, 'rental_ending', now)[0].id, 'known');
});

test('equal expiries tie by natural name and a malformed preferred exact field never falls back to another field', () => {
  const input = [gift('10', { rental_until: stamp(60000) }), gift('2', { rental_until_unix_seconds: (now + 60000) / 1000 }),
    gift('1', { rental_until_unix_seconds: 'broken', rental_until: stamp(1000) })];
  assert.deepEqual(ids(sortInventoryGifts(input, 'rental_ending', now)), ['2', '10', '1']);
});

test('time sorts fail closed with an invalid clock while preserving deterministic name ties', () => {
  const input = [gift('10', { rental_until: stamp(60000), rental_history: history(stamp(-60000)) }),
    gift('2', { rental_until: stamp(7200000), rental_history: history(stamp(-7200000)) })];
  for (const order of ['rental_ending', 'last_rented'] as const) for (const clock of [Number.NaN, Infinity, -1, 1.5])
    assert.deepEqual(ids(sortInventoryGifts(input, order, clock)), ['2', '10']);
});
