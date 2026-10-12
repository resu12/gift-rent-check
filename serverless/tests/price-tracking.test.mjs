import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {buildGiftPriceTracking, observedPriceChanges} from '../tgcloud/lib/price-tracking.js';
import {rational} from '../tgcloud/lib/cloud-pricing-core.js';
import {SUPPORTED_CODE_HASH, MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';

const address = n => `0:${n.toString(16).padStart(64, '0')}`;
const wallet = address(1), nft = address(2), collection = address(3), contract = address(4);
const NOW = Date.parse('2026-10-10T12:00:00Z');
const first = '2026-09-01T12:00:00Z', old = '2026-09-20T12:00:00Z', changed = '2026-09-21T12:00:00Z';
const gift = {nft_address: nft, collection_address: collection, is_portfolio: true};
const ton = (price, observed_at, extra = {}) => ({observed_at, when: Date.parse(observed_at), row: {nft_address: nft, collection_address: collection, holding_contract: contract, owner: wallet, verified: true, configured_price_per_day_raw: price, code_hash: SUPPORTED_CODE_HASH, code_hash_verified: true, data_hash_verified: true, marketplace: MARKETAPP_OPERATOR, rental_state: 'idle_rental_contract', ...extra}});
const listing = (price, observed_at, owner = wallet, extra = {}) => ({observed_at, when: Date.parse(observed_at), valid: true, price: rational(BigInt(price), 1000000000n), source: {owner}, ...extra});
const personal=(price,observed_at,extra={})=>({observed_at,when:Date.parse(observed_at),row:{nft_address:nft,collection_address:collection,wallet,
  provider:'marketapp_website',semantics_version:'marketapp-my-nfts-v1',scope:'my_nfts',authenticated:true,ownership_verified:false,visible:true,
  price_per_day:price,currency:'GRAM',rental_state:'for_rent',rental_until:null,...extra}});
const history = (when, amount = '1', duration = 86400, extra = {}, observed_at = '2026-10-10T11:00:00Z') => ({nft, observed_at, item: {address: nft, name: 'Gift #2', collection_address: collection, src: address(90), dst: address(91), ts: Date.parse(when) / 1000, price: amount, price_nano: String(BigInt(amount.replace('.', '')) * 10n ** BigInt(9 - (amount.split('.')[1]?.length || 0))), currency: 'GRAM', duration, is_extend: false, ...extra}});
const tracked = (ownedPrices = [ton('100000000', first), ton('100000000', old), ton('200000000', changed)], rows = [], extra = {}) => buildGiftPriceTracking({gift, wallet, ownedPrices, history: rows, now: NOW, ...extra});
const micros = text => new Date(text).toISOString().replace('.000Z', '.000000Z');
function friendly(n, tag = 0x51) {
  const bytes = [tag, 0, ...Buffer.from(address(n).slice(2), 'hex')]; let crc = 0;
  for (const byte of bytes) {crc ^= byte << 8; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  return Buffer.from([...bytes, crc >> 8, crc & 255]).toString('base64url');
}

test('first observation is baseline and repeated equal prices update last-old time without a change', () => {
  const result = tracked();
  assert.equal(result.source, 'TON contract');
  assert.equal(result.baseline_price_per_day, '0.1');
  assert.equal(result.baseline_observed_at, micros(first));
  assert.equal(result.observation_count, 3); assert.equal(result.change_count, 1);
  assert.equal(result.changes[0].previous_observed_at, micros(old));
  assert.equal(result.changes[0].observed_at, micros(changed));
  assert.equal(result.changes[0].delta_per_day, '0.1');
  assert.equal(result.changes[0].percent_change, '100');
  assert.match(result.changes[0].id, /TON contract/);
  assert.equal(tracked([ton('100000000', first)]).changes.length, 0);
});

test('any eligible TON baseline takes precedence without manufacturing a change from listing prices', () => {
  const result = tracked([ton('200000000', changed)], [], {listings: [listing('100000000', old), listing('300000000', changed)]});
  assert.equal(result.source, 'TON contract'); assert.equal(result.change_count, 0);
  const fallback = tracked([ton('200000000', changed, {verified: false})], [], {listings: [listing('100000000', old), listing('300000000', changed)]});
  assert.equal(fallback.source, 'Marketapp listing'); assert.equal(fallback.change_count, 1);
  assert.ok(fallback.warnings.some(value => value.includes('No verified TON')));
});

test('authenticated account prices get a separate preferred timeline without cross-source changes',()=>{
  const result=tracked(undefined,[],{personalGifts:[personal('0.25',old),personal('0.39',changed)],listings:[listing('100000000',first),listing('500000000',changed)]});
  assert.equal(result.source,'Marketapp account');assert.equal(result.observation_count,2);assert.equal(result.change_count,1);
  assert.equal(result.baseline_price_per_day,'0.25');assert.equal(result.changes[0].from_price_per_day,'0.25');assert.equal(result.changes[0].to_price_per_day,'0.39');
  assert.equal(result.changes[0].delta_per_day,'0.14');assert.match(result.changes[0].id,/Marketapp account/);
  const one=tracked(undefined,[],{personalGifts:[personal('0.39',changed)]});assert.equal(one.source,'Marketapp account');assert.equal(one.change_count,0);
  assert.match(one.warnings.join(' '),/do not establish on-chain ownership/);
});
test('ineligible account sources fall back without changing TON or listing series',()=>{
  for(const change of [{provider:'marketapp_api'},{scope:'my_rented'},{authenticated:false},{ownership_verified:true},{visible:false},
    {semantics_version:'unknown'},{wallet:address(99)},{collection_address:address(99)},{nft_address:address(99)},{rental_until:2000000000},
    {rental_state:'listed_for_sale'},{currency:'TON'},{price_per_day:null},{price_per_day:'NaN'},{price_per_day:'1e-9'}]) {
    const result=tracked(undefined,[],{personalGifts:[personal('0.39',changed,change)]});assert.equal(result.source,'TON contract',JSON.stringify(change));
    assert.equal(result.change_count,1);
  }
  const listingFallback=tracked([],[],{personalGifts:[personal(null,changed)],listings:[listing('100000000',old),listing('200000000',changed)]});
  assert.equal(listingFallback.source,'Marketapp listing');assert.equal(listingFallback.change_count,1);
});
test('missing account prices, unsupported currencies and simultaneous variants interrupt account continuity',()=>{
  for(const middle of [personal(null,old),personal('0.2',old,{currency:'TON'}),personal('NaN',old)]) {
    const result=tracked([],[],{personalGifts:[personal('0.1',first),middle,personal('0.3',changed)]});
    assert.equal(result.source,'Marketapp account');assert.equal(result.change_count,0);assert.match(result.warnings.join(' '),/interrupts/);
  }
  const conflicting=tracked([],[],{personalGifts:[personal('0.1',first),personal('0.2',old),personal('0.25',old),personal('0.3',changed)]});
  assert.equal(conflicting.change_count,0);
  const replay=tracked([],[],{personalGifts:[personal('0.100000000',old),personal('0.1',old),personal('0.200000001',changed)]});
  assert.equal(replay.observation_count,2);assert.equal(replay.change_count,1);assert.equal(replay.changes[0].delta_per_day,'0.100000001');
});
test('account address aliases match current wallet and gift; future, malformed and legacy identities are excluded',()=>{
  const aliased=tracked([],[],{personalGifts:[personal('0',old,{wallet:friendly(1),nft_address:friendly(2),collection_address:friendly(3)}),personal('0.000000001',changed)]});
  assert.equal(aliased.source,'Marketapp account');assert.equal(aliased.change_count,1);assert.equal(aliased.changes[0].percent_change,null);
  const excluded=tracked([],[],{personalGifts:[personal('0.1','2030-01-01T00:00:00Z'),personal('0.2','undated'),personal('0.3',old,{wallet:friendly(1).slice(0,-1)+'!'}),personal('0.4',old,{nft_address:'legacy-nft'})]});
  assert.equal(excluded.source,null);
});
test('cloud personal observations feed account tracking with existing historical rental performance and no mutation',()=>{
  const accountRows=[personal('0.1',first),personal('0.1',old),personal('0.2',changed)].map(point=>({kind:'personal_gift',observed_at:point.observed_at,record:point.row}));
  const rows=[{kind:'settings',record:{wallet}},{kind:'portfolio',record:gift},...accountRows,
    {kind:'history',observed_at:'2026-10-10T11:00:00Z',record:{source_json:history('2026-09-22T12:00:00Z','0.7').item}}];
  const saved=JSON.stringify(rows),result=buildCloudDashboard(rows,{source:'rentals',timeframe:'30d'},{now:NOW});
  assert.equal(result.gifts[0].price_tracking.source,'Marketapp account');assert.equal(result.gifts[0].price_tracking.change_count,1);
  assert.equal(result.gifts[0].price_tracking.changes[0].comparisons[0].after.recorded_rentals,1);
  assert.equal(result.gifts[0].price_tracking.changes[0].comparisons[0].after.recorded_volume,'0.7');
  assert.deepEqual(result.pricing,buildCloudDashboard(rows.filter(row=>row.kind!=='personal_gift'),{source:'rentals',timeframe:'30d'},{now:NOW}).pricing,'personal observations never change the comparison sample');
  assert.equal(JSON.stringify(rows),saved);
});

test('failed checks, conflicting simultaneous amounts and owner/contract changes interrupt continuity', () => {
  for (const rows of [
    [ton('100000000', first), ton('200000000', old, {verified: false}), ton('300000000', changed)],
    [ton('100000000', first), ton('200000000', old), ton('250000000', old), ton('300000000', changed)],
    [ton('100000000', first), ton('200000000', changed, {holding_contract: address(5)})],
  ]) {
    const result = tracked(rows);
    assert.equal(result.change_count, 0); assert.ok(result.warnings.some(value => value.includes('interrupts')));
  }
  const market = tracked([], [], {listings: [listing('100000000', first), listing('300000000', changed, address(6))]});
  assert.equal(market.change_count, 0);
});

test('conflicting provenance cannot qualify and observations from a different frozen wallet are ignored', () => {
  for (const extra of [{code_hash_verified: false}, {data_hash_verified: false}, {marketplace: address(99)}, {rental_state: 'unknown'}, {code_hash: '0'.repeat(64)}, {data_hash: 'bad'}, {nft: address(99)}, {observed_owner: address(99)}, {currency: 'TON'}, {price_unit: 'GRAM/day'}]) {
    assert.equal(tracked([ton('100000000', first), ton('200000000', changed, extra)]).change_count, 0);
  }
  assert.equal(tracked([ton('100000000', first), ton('300000000', old, {wallet_address: address(99)}), ton('200000000', changed)]).change_count, 1);
  assert.equal(tracked(undefined, [], {gift: {...gift, collection_conflict: true}}).coverage, 'no_observations');
  assert.equal(tracked(undefined, [], {gift: {...gift, is_portfolio: false}}).changes.length, 0);
});

test('TON aliases compare canonically while malformed or legacy identities cannot become contract proof', () => {
  const result = tracked([ton('100000000', first, {nft_address: friendly(2), collection_address: friendly(3), owner: friendly(1), holding_contract: friendly(4), price_unit: 'nanoGRAM/day'}), ton('200000000', changed)], [], {wallet: friendly(1), gift: {...gift, nft_address: friendly(2), collection_address: friendly(3)}});
  assert.equal(result.change_count, 1); assert.equal(JSON.parse(result.changes[0].id)[0], nft);
  assert.equal(tracked([ton('100000000', first, {holding_contract: 'legacy-contract'})]).source, null);
  assert.equal(tracked([ton('100000000', first, {owner: friendly(1).slice(0, -1) + '!'})]).source, null);
  const legacy = buildGiftPriceTracking({gift: {nft_address: 'legacy-nft', collection_address: 'legacy-collection', is_portfolio: true}, wallet, listings: [listing('100000000', first, 'legacy-owner'), listing('200000000', changed, 'legacy-owner')], now: NOW});
  assert.equal(legacy.source, 'Marketapp listing'); assert.equal(legacy.change_count, 1);
});

test('future and invalid-dated prices are ignored, exact amounts retain nano precision, and zero has no percentage', () => {
  const result = tracked([ton('0', first), ton('100000001', changed), ton('200000000', '2026-10-11T12:00:00Z'), ton('300000000', 'undated')]);
  assert.equal(result.observation_count, 2); assert.equal(result.change_count, 1);
  assert.equal(result.changes[0].to_price_per_day, '0.100000001');
  assert.equal(result.changes[0].percent_change, null);
  const huge = tracked([ton('900719925474099312345678900000001', first), ton('900719925474099312345678900000002', changed)]);
  assert.equal(huge.changes[0].delta_per_day, '0.000000001');
});

test('equal periods exclude the unknown change gap and use duration-weighted recorded rates', () => {
  const rows = [history('2026-09-15T12:00:00Z', '2'), history('2026-09-17T12:00:00Z', '3', 259200), history('2026-09-20T15:00:00Z', '99'), history('2026-09-21T12:00:00Z', '0.7', 172800), history('2026-09-28T12:00:00Z', '8')];
  const [week, fortnight, month] = tracked(undefined, rows).changes[0].comparisons;
  assert.equal(week.status, 'ready'); assert.equal(week.comparable_days, '7');
  assert.deepEqual([week.before.recorded_rentals, week.before.recorded_volume, week.before.rental_days, week.before.average_daily_rate], [2, '5', '4', '1.25']);
  assert.deepEqual([week.after.recorded_rentals, week.after.recorded_volume, week.after.average_daily_rate], [1, '0.7', '0.35']);
  assert.equal(fortnight.status, 'ready'); assert.equal(month.status, 'pending'); assert.equal(month.comparable_days, '19');
  assert.equal(week.before.window_to, micros(old)); assert.equal(week.after.window_from, micros(changed));
});

test('recorded monetary sums retain consistent sub-nano source precision while derived rates stay at nine decimals', () => {
  const tiny = history('2026-09-22T12:00:00Z', '1', 86400, {price: '0.0000000001', price_nano: '0.1'});
  const after = tracked(undefined, [tiny]).changes[0].comparisons[0].after;
  assert.equal(after.recorded_rentals, 1); assert.equal(after.recorded_volume, '0.0000000001');
  assert.equal(after.average_daily_rate, '0');
  const mixed = tracked(undefined, [tiny, history('2026-09-23T12:00:00Z', '0.2'), history('2026-09-24T12:00:00Z', '1', 86400, {price: '0.0000000002', price_nano: '0.2'})]).changes[0].comparisons[0].after;
  assert.equal(mixed.recorded_rentals, 3); assert.equal(mixed.recorded_volume, '0.2000000003');
  assert.equal(mixed.average_daily_rate, '0.066666667');
});

test('exact recorded volume preserves the parser maximum terminating scale without truncation', () => {
  const tiny = history('2026-09-22T12:00:00Z', '1', 86400, {price: '1e-1000', price_nano: '1e-991'});
  const after = tracked(undefined, [tiny]).changes[0].comparisons[0].after;
  assert.equal(after.recorded_volume, '0.' + '0'.repeat(999) + '1');
  assert.equal(after.average_daily_rate, '0');
});

test('prior and next observed changes cap equal windows without attributing later prices to earlier ones', () => {
  const result = tracked([ton('100000000', first), ton('100000000', old), ton('200000000', changed), ton('200000000', '2026-09-24T12:00:00Z'), ton('300000000', '2026-09-25T12:00:00Z')]);
  for (const change of result.changes) for (const period of change.comparisons) {
    assert.equal(period.status, 'partial'); assert.equal(period.comparable_days, '3');
    assert.equal(Date.parse(period.before.window_to) - Date.parse(period.before.window_from), Date.parse(period.after.window_to) - Date.parse(period.after.window_from));
  }
});

test('failed-check gaps cap old performance at the last valid read and resumed segments start a new floor', () => {
  const result = tracked([ton('100000000', first), ton('100000000', old), ton('200000000', changed), ton('200000000', '2026-09-23T12:00:00Z'), ton('300000000', '2026-09-24T12:00:00Z', {verified: false}), ton('300000000', '2026-09-25T12:00:00Z'), ton('300000000', '2026-09-27T12:00:00Z'), ton('400000000', '2026-09-28T12:00:00Z')]);
  assert.equal(result.change_count, 2);
  const [resumed, previous] = result.changes;
  for (const change of [resumed, previous]) for (const period of change.comparisons) {
    assert.equal(period.status, 'partial'); assert.equal(period.comparable_days, '2');
  }
  assert.equal(previous.comparisons[0].after.window_to, micros('2026-09-23T12:00:00Z'));
  assert.equal(resumed.comparisons[0].before.window_from, micros('2026-09-25T12:00:00Z'));
});

test('a scope transition immediately after a change cannot create elapsed associated performance', () => {
  const result = tracked([ton('100000000', old), ton('200000000', changed), ton('300000000', '2026-09-25T12:00:00Z', {holding_contract: address(5)})]);
  assert.equal(result.change_count, 1);
  for (const period of result.changes[0].comparisons) {
    assert.equal(period.status, 'partial'); assert.equal(period.comparable_days, '0');
    assert.equal(period.after.recorded_rentals, null);
  }
});

test('zero elapsed periods stay unknown while elapsed saved samples may contain zero recorded starts', () => {
  const result = tracked([ton('100000000', first), ton('200000000', new Date(NOW).toISOString())]);
  assert.equal(result.changes[0].comparisons[0].status, 'pending');
  assert.equal(result.changes[0].comparisons[0].after.recorded_rentals, null);
  const empty = tracked().changes[0].comparisons[0];
  assert.equal(empty.before.recorded_rentals, 0); assert.equal(empty.before.recorded_volume, '0');
  assert.equal(empty.after.rental_days, '0'); assert.equal(empty.after.average_daily_rate, null);
});

test('page replays and missing/repeated hashes count once per representation; changed variants are excluded', () => {
  const row = history('2026-09-22T12:00:00Z', '0.7', 86400, {tx_hash: null});
  const repeated = history('2026-09-23T12:00:00Z', '0.9', 86400, {tx_hash: 'same'});
  const other = history('2026-09-24T12:00:00Z', '1.1', 86400, {tx_hash: 'same'});
  const varied = history('2026-09-25T12:00:00Z', '0.8');
  const changedRow = {...varied, item: {...varied.item, price: '0.81', price_nano: '810000000'}};
  const after = tracked(undefined, [row, structuredClone(row), repeated, other, varied, changedRow]).changes[0].comparisons[0].after;
  assert.equal(after.recorded_rentals, 3); assert.equal(after.recorded_volume, '2.7');
  assert.equal(after.excluded_counts.ambiguous_history_variants, 2);
});

test('supplied fingerprints cannot hide changed raw representations or multiply identical page overlaps', () => {
  const row = {...history('2026-09-22T12:00:00Z', '0.7'), fingerprint: 'shared-imported-fingerprint'};
  const identical = {...structuredClone(row), fingerprint: 'different-imported-fingerprint'};
  const repeated = tracked(undefined, [row, identical]).changes[0].comparisons[0].after;
  assert.equal(repeated.recorded_rentals, 1); assert.equal(repeated.recorded_volume, '0.7');
  const changedRow = {...row, item: {...row.item, price: '0.8', price_nano: '800000000'}};
  const ambiguous = tracked(undefined, [row, identical, changedRow]).changes[0].comparisons[0].after;
  assert.equal(ambiguous.recorded_rentals, 0); assert.equal(ambiguous.recorded_volume, '0');
  assert.equal(ambiguous.excluded_counts.ambiguous_history_variants, 2);
});

test('extensions, bad amounts, other currencies and unsupported durations never enter performance and exclusions belong to their period', () => {
  const at = '2026-09-22T12:00:00Z';
  const rows = [history(at, '1', 86400, {is_extend: true}), history('2026-09-23T12:00:00Z', '1', 86400, {price_nano: '2'}), history('2026-09-24T12:00:00Z', '1', 86400, {currency: 'TON'}), history('2026-09-25T12:00:00Z', '1', 0), history('2026-09-26T12:00:00Z', '1', 86400, {action: 'return'}), history('2026-08-01T12:00:00Z', '1', 86400, {is_extend: true})];
  const {before, after} = tracked(undefined, rows).changes[0].comparisons[0];
  assert.deepEqual(before.excluded_counts, {}); assert.equal(after.recorded_rentals, 0);
  assert.deepEqual(after.excluded_counts, {extensions: 1, inconsistent_gram_amounts: 1, non_gram_currency: 1, missing_or_nonpositive_duration: 1, non_rental_action: 1});
});

test('all changes are counted, only five most recent are emitted, and microsecond ordering stays distinct', () => {
  const points = Array.from({length: 12}, (_, index) => ton(String((index + 1) * 100000000), `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00Z`));
  const result = tracked(points);
  assert.equal(result.change_count, 11); assert.equal(result.changes.length, 5);
  assert.equal(result.changes[0].to_price_per_day, '1.2'); assert.equal(result.changes[4].to_price_per_day, '0.8');
  const fine = tracked([ton('100000000', '2026-09-21T12:00:00.000001Z'), ton('200000000', '2026-09-21T12:00:00.000002Z')]);
  assert.equal(fine.change_count, 1); assert.equal(fine.changes[0].observed_at, '2026-09-21T12:00:00.000002Z');
});

test('exact duplicate price observations do not inflate point counts', () => {
  const p = {observed_at: first, scope: contract, price: rational(1n)};
  const series = observedPriceChanges([p, structuredClone(p), {...p, observed_at: changed, price: rational(2n)}]);
  assert.equal(series.observation_count, 2); assert.equal(series.changes.length, 1);
});

test('cloud hook preserves complete A/B/A occurrence history independent of pricing selection, without mutating saved records', () => {
  const item = (nano, extra = {}) => ({nft_address: nft, nft_name: 'Gift #2', owner: wallet, price_per_day: nano, attributes: [], min_duration: 1, max_duration: 30, discount_per_day: 0, listed_at: null, ...extra});
  const listed = (nano, occurrence_times) => ({kind: 'listing', observed_at: occurrence_times.at(-1), record: {identity: nft, collection_address: collection, occurrence_times, source_json: JSON.stringify(item(nano))}});
  const rows = [{kind: 'settings', record: {wallet}}, {kind: 'portfolio', record: gift}, listed('100000000', [first, '2026-10-01T12:00:00Z']), listed('200000000', [changed]), {kind: 'history', observed_at: '2026-10-10T11:00:00Z', record: {source_json: JSON.stringify(history('2026-09-22T12:00:00Z').item)}}];
  const saved = JSON.stringify(rows);
  const a = buildCloudDashboard(rows, {source: 'listings', timeframe: '24h'}, {now: NOW}).gifts[0].price_tracking;
  const b = buildCloudDashboard(rows, {source: 'rentals', timeframe: 'custom', date_from: '2026-10-05', date_to: '2026-10-06', backdrop: 'Black'}, {now: NOW}).gifts[0].price_tracking;
  assert.equal(a.change_count, 2); assert.deepEqual(a, b); assert.equal(JSON.stringify(rows), saved);
});

test('four public Python-generated cases reproduce exact sums, microseconds, source continuity and window caps', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/price-tracking-parity.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures.cases) {
    const rows = [{kind: 'settings', record: {wallet: fixture.wallet}}, {kind: 'portfolio', record: fixture.gift},
      ...fixture.owned_prices.map(row => ({kind: 'owned_price', observed_at: row.observed_at, record: row})),
      ...fixture.listings.map(row => ({kind: 'listing', observed_at: row.observed_at, record: {identity: row.item.nft_address, collection_address: fixture.gift.collection_address, source_json: JSON.stringify(row.item)}})),
      ...fixture.history.flatMap(page => page.items.map(item => ({kind: 'history', observed_at: page.observed_at, record: {identity: item.address, source_json: JSON.stringify(item)}}))),
    ];
    const result = buildCloudDashboard(rows, {source: 'rentals', timeframe: '30d'}, {now: Date.parse(fixture.now)}).gifts[0].price_tracking;
    const {warnings: _warnings, ...value} = result;
    assert.deepEqual(value, fixture.expected, fixture.name);
  }
});
