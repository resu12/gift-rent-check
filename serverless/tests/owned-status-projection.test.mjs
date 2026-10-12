import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {SUPPORTED_CODE_HASH, OBSERVED_7F44_CODE_HASH, MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';

const address = n => `0:${n.toString(16).padStart(64, '0')}`;
const wallet = address(1), nft = address(2), collection = address(3), holder = address(4);
const old = '2026-10-09T10:00:00Z', recent = '2026-10-09T11:00:00Z', later = '2026-10-09T11:30:00Z', now = Date.parse('2026-10-09T12:00:00Z');
const expiry = Math.floor(now / 1000) + 1000;
const seed = [
  {kind: 'settings', record: {wallet}},
  {kind: 'portfolio', observed_at: old, record: {nft_address: nft, collection_address: collection, is_portfolio: true, state: 'rented', display_state: 'Rented', ui_state: 'for_rent', observed_at: old, market_observed_at: old, rental_until: '2026-10-09T13:00:00Z', rental_until_unix_seconds: expiry, price_per_day: '0.35', price_source: 'Marketapp user view', price_unit: 'GRAM', membership_sources: ['ton_verified']}},
];
const status = (extra = {}, observed_at = recent) => ({kind: 'owned_status', observed_at, record: {
  semantics_version: 'ton-owned-rental-status-v1', provider: 'toncenter', nft_address: nft, nft,
  collection_address: collection, wallet, owner: wallet, observed_owner: holder, holding_contract: holder,
  verified: true, reason: 'verified_rental_status', rental_state: 'rented',
  role: 1, status: 1, renter: address(5), counterpart: address(6), rental_until: expiry, rental_until_unit: 'Unix seconds',
  code_hash: SUPPORTED_CODE_HASH, data_hash: 'b'.repeat(64), code_hash_verified: true, data_hash_verified: true,
  decoder_version: 'fixture-v1', marketplace: MARKETAPP_OPERATOR, nft_last_transaction_lt: '100', account_last_transaction_lt: '99',
  checked_at: later, rechecked_at: later, ...extra,
}});
const project = (rows, time = now) => buildCloudDashboard(rows, {}, {now: time});
const gift = rows => project(rows).gifts[0];
const listed = (observed_at = later) => ({kind: 'listing', observed_at, record: {identity: nft, collection_address: collection, source_json: {nft_address: nft, nft_name: 'Known gift', owner: wallet, price_per_day: '390000000', attributes: [], min_duration: 1, max_duration: 30, discount_per_day: 0, listed_at: null}}});

test('latest verified status refreshes dated ownership and UI without changing asking price, membership or metadata observation', () => {
  const before = gift(seed), after = gift([...seed, status()]);
  assert.equal(after.state, 'rented'); assert.equal(after.ui_state, 'rented'); assert.equal(after.display_state, 'Rented');
  assert.equal(after.status_is_historical, false); assert.equal(after.status_observed_at, recent); assert.equal(after.ownership_observed_at, recent);
  assert.equal(after.status_checked_at, later); assert.equal(after.rental_until, new Date(expiry * 1000).toISOString());
  assert.equal(after.status_provenance.role, 1); assert.equal(after.status_provenance.status, 1); assert.equal(after.status_provenance.wallet, wallet);
  for (const key of ['price_per_day', 'price_source', 'price_unit', 'observed_at', 'membership_sources', 'automatic_membership', 'verification_method']) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.pricing, before.pricing);
});

test('direct/idle/expired evidence clears contradictory saved Marketapp labels without proving For rent', () => {
  for (const [state, extra] of [
    ['held_directly', {observed_owner: wallet, holding_contract: null, rental_until: null}],
    ['idle_rental_contract', {role: 0, status: 0, renter: null, counterpart: null, rental_until: 0}],
    ['expired_pending_return', {rental_until: Math.floor(now / 1000) - 100}],
  ]) {
    const actual = gift([...seed, status({rental_state: state, ...extra})]);
    assert.equal(actual.state, state); assert.equal(actual.ui_state, null); assert.equal(actual.status_is_historical, false);
    assert.notEqual(actual.display_state, 'For rent'); assert.equal(actual.previous_rental_state, 'rented');
  }
});

test('an idle status permits a later real listing; a rented status never borrows For rent visibility', () => {
  const idle = status({rental_state: 'idle_rental_contract', role: 0, status: 0, renter: null, counterpart: null, rental_until: 0});
  // Use an imported idle state so a later listing is eligible for the existing
  // Marketapp visibility path before the independent TON status is projected.
  const idleSeed = seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record, state: 'idle_rental_contract'}} : row);
  const newer = gift([...idleSeed, idle, listed()]);
  assert.equal(newer.ui_state, 'for_rent'); assert.equal(newer.display_state, 'For rent'); assert.equal(newer.state, 'idle_rental_contract');
  assert.equal(gift([...idleSeed, idle, listed(old)]).ui_state, null);
  assert.equal(gift([...idleSeed, status(), listed()]).ui_state, 'rented');
});

test('unknown/failing/movement status supersedes stale rented evidence while preserving prior dated state', () => {
  for (const reason of ['unsupported_code_hash', 'nft_changed_during_refresh', 'owner_mismatch', 'invalid_contract_data', 'retry_exhausted']) {
    const actual = gift([...seed, status({verified: false, reason, rental_state: 'unknown'}, later)]);
    assert.equal(actual.state, 'unknown'); assert.equal(actual.ui_state, null); assert.equal(actual.status_is_historical, true);
    assert.equal(actual.status_check_reason, reason); assert.equal(actual.previous_rental_state, 'rented'); assert.equal(actual.previous_status_observed_at, old);
    assert.equal(actual.rental_until, null); assert.equal(actual.rental_until_unix_seconds, null); assert.equal(actual.is_portfolio, true);
    assert.match(actual.uncertainties.join(' '), /could not verify/);
  }
});

test('expiry is recomputed at dashboard read, and expired custody does not establish return', () => {
  const rows = [...seed, status()];
  assert.equal(project(rows, expiry * 1000 - 1).gifts[0].state, 'rented');
  const expired = project(rows, expiry * 1000).gifts[0];
  assert.equal(expired.state, 'expired_pending_return'); assert.equal(expired.ui_state, null); assert.equal(expired.holding_contract, holder);
  assert.equal(project(rows, expiry * 1000).summary.rented_count, 0);
});

test('legacy price records, unversioned status, future status and wrong-wallet evidence cannot refresh status', () => {
  for (const record of [
    {kind: 'owned_price', observed_at: recent, record: {...status().record, configured_price_per_day_raw: '390000000'}},
    status({semantics_version: undefined}), status({}, '2026-10-10T12:00:00Z'), status({wallet: address(99)}),
  ]) {
    const actual = gift([...seed, record]); assert.equal(actual.state, 'rented'); assert.equal(actual.ui_state, 'for_rent');
    assert.equal(actual.status_observed_at, undefined);
  }
});

test('newer imported status dates are respected, but invalid future seed dates do not block a current check', () => {
  const newerSeed = seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record, state: 'held_directly', status_observed_at: later}} : row);
  assert.equal(gift([...newerSeed, status()]).state, 'held_directly');
  const futureSeed = seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record, status_observed_at: '2030-01-01T00:00:00Z'}} : row);
  assert.equal(gift([...futureSeed, status()]).status_observed_at, recent);
});

test('simultaneous conflicting statuses remain uncertain and identical replay does not conflict', () => {
  const actual = gift([...seed, status(), status({rental_state: 'idle_rental_contract', role: 0, status: 0, renter: null, rental_until: 0})]);
  assert.equal(actual.state, 'unknown'); assert.equal(actual.status_check_reason, 'conflicting_status_observations');
  assert.equal(gift([...seed, status(), status()]).state, 'rented');
});

test('wrong identities, hashes, operator, roles, units, LTs and absent stability evidence cannot assert current rental state', () => {
  for (const change of [
    {owner: address(99)}, {nft: address(99)}, {collection_address: address(99)}, {observed_owner: address(99)},
    {holding_contract: 'opaque-contract'}, {marketplace: address(99)}, {code_hash: 'a'.repeat(64)}, {data_hash_verified: false},
    {role: 0}, {status: 7}, {renter: null}, {counterpart: 'bad'}, {rental_until_unit: undefined}, {rental_until: -1},
    {nft_last_transaction_lt: 100}, {account_last_transaction_lt: '18446744073709551616'},
    {rechecked_at: undefined}, {rechecked_at: old}, {rechecked_at: '2030-01-01T00:00:00Z'},
  ]) assert.equal(gift([...seed, status(change)]).state, 'unknown', JSON.stringify(change));
});

test('invalid checksums and opaque legacy identifiers retain exact reading without becoming TON ownership proof', () => {
  for (const value of ['old-wallet', 'UQC3PX8rXmcy22kJazMuSSXTzeIISgB4fXBo-_6GH60EObwA']) {
    const rows = seed.map(row => row.kind === 'settings' ? {...row, record: {wallet: value}} : row);
    const actual = gift([...rows, status({wallet: value, owner: value, observed_owner: value, rental_state: 'held_directly'})]);
    assert.equal(actual.status_observed_at, undefined);
  }
  const legacy = seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record, nft_address: 'old-nft', collection_address: 'old-collection'}} : row);
  const actual = gift([...legacy, status({nft_address: 'old-nft', nft: 'old-nft', collection_address: 'old-collection'})]);
  assert.equal(actual.nft_address, 'old-nft'); assert.equal(actual.status_observed_at, undefined); assert.equal(actual.status_is_historical, true);
});

test('conflicting collections are flagged without deleting membership or disguising saved rented evidence as current', () => {
  const rows = [...seed, {kind: 'metadata', observed_at: recent, record: {nft_address: nft, collection_address: address(99)}}, status()];
  const actual = gift(rows); assert.equal(actual.is_portfolio, true); assert.equal(actual.status_is_historical, true);
  assert.equal(actual.status_check_reason, 'collection_conflict'); assert.equal(actual.status_observed_at, undefined);
});

test('verified current rental start needs no recorded history and stays invariant through extensions for both code pins', () => {
  const duration = 86400, start = expiry - duration;
  for (const code_hash of [SUPPORTED_CODE_HASH, OBSERVED_7F44_CODE_HASH]) {
    const terms = {code_hash, rental_duration: duration, rental_duration_unit: 'seconds'};
    const original = gift([...seed, status(terms)]);
    const extended = gift([...seed, status({...terms, rental_duration: duration + 172800, rental_until: expiry + 172800})]);
    for (const actual of [original, extended]) {
      assert.equal(actual.current_rental_started_at, new Date(start * 1000).toISOString());
      assert.equal(actual.current_rental_start_source, 'verified_contract');
      assert.equal(actual.rental_history.last_rental_at, null);
      assert.equal(actual.rental_history.recorded_count, null);
    }
    const expired = project([...seed, status(terms)], expiry * 1000 + 1).gifts[0];
    assert.equal(expired.state, 'expired_pending_return');
    assert.equal(expired.current_rental_started_at, original.current_rental_started_at);
  }
});

test('newly retained creation timestamp must corroborate the verified accumulated-duration start', () => {
  const terms = {rental_duration: 86400, rental_duration_unit: 'seconds', created_at: expiry - 86400, created_at_unit: 'Unix seconds'};
  const original = gift([...seed, status(terms)]);
  assert.equal(original.current_rental_start_source, 'verified_contract');
  assert.equal(original.status_provenance.created_at, terms.created_at);
  assert.equal(original.status_provenance.created_at_unit, 'Unix seconds');
  // Existing discovery snapshots already contain the decoded identity field,
  // but predate the explicit unit retained by the targeted refresh collector.
  assert.equal(gift([...seed, status({...terms, created_at_unit: undefined})]).current_rental_started_at, original.current_rental_started_at);
  for (const changes of [{created_at: terms.created_at - 1}, {created_at: null}, {created_at_unit: 'milliseconds'}]) {
    const actual = gift([...seed, status({...terms, ...changes})]);
    assert.equal(actual.current_rental_started_at, null);
    assert.equal(actual.current_rental_start_source, null);
    assert.equal(actual.state, 'rented');
    assert.equal(actual.rental_until_unix_seconds, expiry);
  }
});

test('invalid durations, future starts, conflicting starts and arbitrary seed fields cannot establish rental start', () => {
  const terms = {rental_duration: 86400, rental_duration_unit: 'seconds'};
  for (const changes of [{rental_duration: 0}, {rental_duration: -1}, {rental_duration: 0.5},
    {rental_duration: '86400'}, {rental_duration: 0x100000000}, {rental_duration: expiry},
    {rental_duration: 1}, {rental_duration_unit: 'days'}, {rental_duration_unit: undefined},
    {code_hash: 'a'.repeat(64)}, {data_hash_verified: false}, {owner: address(99)}, {verified: false},
    {rental_state: 'idle_rental_contract', role: 0, status: 0, renter: null, rental_until: 0}]) {
    const actual = gift([...seed, status({...terms, ...changes})]);
    assert.equal(actual.current_rental_started_at, null, JSON.stringify(changes));
    assert.equal(actual.current_rental_start_source, null, JSON.stringify(changes));
  }
  const conflicting = gift([...seed, status(terms), status({...terms, rental_duration: 172800})]);
  assert.equal(conflicting.current_rental_started_at, null);
  assert.equal(conflicting.state, 'rented');
  const injected = seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record,
    current_rental_started_at: recent, current_rental_start_source: 'verified_contract'}} : row);
  assert.equal(gift(injected).current_rental_started_at, null);
  assert.equal(gift(injected).current_rental_start_source, null);
});

test('verified rental-start history survives newer idle, direct and failed status without asserting a current rental', () => {
  const terms = {rental_duration: 86400, rental_duration_unit: 'seconds'}, expected = new Date((expiry - 86400) * 1000).toISOString();
  for (const change of [
    {rental_state: 'idle_rental_contract', role: 0, status: 0, renter: null, counterpart: null, rental_until: 0},
    {rental_state: 'held_directly', observed_owner: wallet, holding_contract: null, rental_until: null},
    {rental_state: 'unknown', verified: false, reason: 'retry_exhausted'},
  ]) {
    const actual = gift([...seed, status(terms), status(change, later)]);
    assert.equal(actual.last_verified_rental_started_at, expected);
    assert.equal(actual.last_verified_rental_start_source, 'verified_contract');
    assert.equal(actual.current_rental_started_at, null);
    assert.equal(actual.rental_until, null);
    assert.equal(actual.rental_history.last_rental_at, null);
    assert.equal(actual.rental_history.recorded_count, null);
  }
});

test('historical rental-start proof is independent of newer imported status and chooses the greatest verified start', () => {
  const terms = {rental_duration: 86400, rental_duration_unit: 'seconds'};
  const newerSeed = seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record, state: 'held_directly', status_observed_at: later}} : row);
  assert.equal(gift([...newerSeed, status(terms)]).last_verified_rental_started_at, new Date((expiry - 86400) * 1000).toISOString());
  const earlierTerm = status({...terms, rental_until: expiry - 86400}, later);
  const actual = gift([...seed, status(terms), earlierTerm]);
  assert.equal(actual.last_verified_rental_started_at, new Date((expiry - 86400) * 1000).toISOString());
  assert.equal(actual.current_rental_started_at, new Date((expiry - 172800) * 1000).toISOString());
});

test('historical rental start requires every simultaneous proof and rejects invalid groups without erasing older accepted history', () => {
  const terms = {rental_duration: 86400, rental_duration_unit: 'seconds'};
  for (const change of [
    {owner: address(99)}, {nft: address(99)}, {collection_address: address(99)}, {observed_owner: address(99)},
    {holding_contract: 'opaque-contract'}, {marketplace: address(99)}, {code_hash: 'a'.repeat(64)}, {data_hash_verified: false},
    {role: 0}, {status: 7}, {renter: null}, {counterpart: 'bad'}, {rental_until_unit: undefined}, {rental_until: -1},
    {nft_last_transaction_lt: 100}, {account_last_transaction_lt: '18446744073709551616'},
    {rechecked_at: undefined}, {rechecked_at: old}, {rechecked_at: '2030-01-01T00:00:00Z'},
    {rental_duration: 172800}, {rental_duration_unit: 'days'}, {created_at: expiry - 86400 - 1},
    {verified: false}, {rental_state: 'held_directly', observed_owner: wallet, holding_contract: null},
  ]) {
    const tie = [status(terms), status({...terms, ...change})];
    for (const rows of [tie, [...tie].reverse()]) {
      const result = gift([...seed, ...rows]);
      assert.equal(result.last_verified_rental_started_at, null, JSON.stringify(change));
      assert.equal(result.last_verified_rental_start_source, null, JSON.stringify(change));
    }
    const prior = status({...terms, rental_until: expiry - 86400, rechecked_at: old}, old);
    assert.equal(gift([...seed, prior, ...tie]).last_verified_rental_started_at, new Date((expiry - 172800) * 1000).toISOString(), JSON.stringify(change));
  }
});

test('historical rental starts are revalidated for membership, canonical identity, collection and the configured wallet', () => {
  const terms = {rental_duration: 86400, rental_duration_unit: 'seconds'};
  const valid = status(terms);
  for (const rows of [
    [...seed, status({...terms, wallet: address(99)})],
    [...seed, status(terms, '2030-01-01T00:00:00Z')],
    [...seed, valid, {kind: 'metadata', observed_at: recent, record: {nft_address: nft, collection_address: address(99)}}],
    ...[{is_portfolio: false}, {nft_address: 'old-nft'}, {collection_address: 'old-collection'}]
      .map(change => [...seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record, ...change}} : row), valid]),
    seed.map(row => row.kind === 'portfolio' ? {...row, record: {...row.record,
      last_verified_rental_started_at: old, last_verified_rental_start_source: 'verified_contract'}} : row),
    [...seed.map(row => row.kind === 'settings' ? {...row, record: {wallet: address(99)}} : row), valid],
  ]) {
    const actual = gift(rows);
    assert.equal(actual.last_verified_rental_started_at, null);
    assert.equal(actual.last_verified_rental_start_source, null);
  }
});
