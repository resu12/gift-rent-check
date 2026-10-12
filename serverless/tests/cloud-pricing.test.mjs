import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildCloudDashboard, createCloudDashboardBuilder, resolveCloudWindow, validateSavedCloudWindow, canonicalAddress, addressKey} from '../tgcloud/lib/cloud-pricing.js';
import {decimal, decimalText, multiply, plus, rational, sumRationals} from '../tgcloud/lib/cloud-pricing-core.js';

const NOW = Date.parse('2026-10-09T12:00:00Z'), RECENT = '2026-10-09T11:00:00Z';
const address = n => `0:${n.toString(16).padStart(64, '0')}`;
const WALLET = address(1), COLLECTION = address(3), SUBJECT = address(2);
const attributes = (model = 'Ruby', backdrop = 'Black') => [{trait_type: 'Model', value: model}, {trait_type: 'Backdrop', value: backdrop}];
function listing(n, price = '1000000000', extra = {}) {return {nft_address: address(n), nft_name: `Gift #${n}`, owner: WALLET, attributes: attributes(), min_duration: 1, max_duration: 30, price_per_day: price, discount_per_day: 0, listed_at: null, ...extra};}
function listed(item, {when = RECENT, params = {}, collection = COLLECTION, ...extra} = {}) {return {kind: 'listing', observed_at: when, record: {identity: item.nft_address, source_json: JSON.stringify(item), collection_address: collection, params: {collection_address: collection, ...params}, ...extra}};}
function event(n, extra = {}) {return {address: address(n), name: 'Display name is not metadata', collection_address: COLLECTION, src: address(900), dst: address(901), ts: NOW / 1000 - 3600, price: '0.6', price_nano: '600000000', currency: 'GRAM', duration: 259200, is_extend: false, tx_hash: `hash-${n}`, ...extra};}
const historical = (item, when = RECENT) => ({kind: 'history', observed_at: when, record: {identity: item.address, source_json: JSON.stringify(item)}});
function gift(n = 2, extra = {}) {return {kind: 'portfolio', observed_at: RECENT, record: {id: address(n), nft_address: address(n), name: `Gift #${n}`, collection_address: COLLECTION, is_portfolio: true, ...extra}};}
function traits(n = 2, values = attributes(), when = RECENT, extra = {}) {return {kind: 'metadata', observed_at: when, record: {nft_address: address(n), collection_address: COLLECTION, attributes: values, source: 'TON metadata', ...extra}};}
const dashboard = (rows, selection = {}) => buildCloudDashboard([gift(), traits(), ...rows], selection, {now: NOW});
const subject = (rows, selection) => dashboard(rows, selection).gifts.find(g => g.id === SUBJECT);
function friendly(n, tag = 0x11) {
  const bytes = [tag, 0, ...Buffer.from(address(n).slice(2), 'hex')]; let crc = 0;
  for (const byte of bytes) {crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  return Buffer.from([...bytes, crc >> 8, crc & 255]).toString('base64url');
}

test('bounded windows default 30 days, include60, reject unbounded and oversized custom windows', () => {
  assert.equal(resolveCloudWindow({}, NOW).timeframe, '30d');
  assert.equal(Date.parse(resolveCloudWindow({timeframe: '60d'}, NOW).window_from), NOW - 60 * 86400000);
  assert.throws(() => resolveCloudWindow({timeframe: 'all'}, NOW), /90 days/);
  assert.throws(() => resolveCloudWindow({timeframe: 'custom', date_from: '2026-07-01', date_to: '2026-09-29'}, NOW), /90 inclusive/);
  assert.throws(() => resolveCloudWindow({timeframe: 'custom', date_from: '2026-02-30', date_to: '2026-03-01'}, NOW), /valid/);
  assert.throws(() => resolveCloudWindow({timeframe: '30d', dateFrom: '2026-10-01'}, NOW), /only supported/);
  const historicalWindow = resolveCloudWindow({timeframe: 'custom', date_from: '2025-01-01', date_to: '2025-01-07'}, NOW);
  assert.equal(validateSavedCloudWindow(historicalWindow), historicalWindow);
  assert.throws(() => resolveCloudWindow({timeframe: 'custom', date_from: '2025-01-01', date_to: '2025-01-07'}, NOW, {collectHistory: true}), /last 90 UTC/);
  assert.throws(() => validateSavedCloudWindow({...historicalWindow, window_from: '2024-12-31T00:00:00Z'}), /fresh 30-day/);
});

test('canonical TON identities validate checksum/mainnet while legacy identifiers retain exact matching', () => {
  assert.equal(canonicalAddress(friendly(2)), SUBJECT);
  assert.equal(canonicalAddress(friendly(2, 0x51)), SUBJECT);
  assert.equal(canonicalAddress(friendly(2).replace(/-/g, '+').replace(/_/g, '/')), SUBJECT);
  assert.throws(() => canonicalAddress(friendly(2).slice(0, -1) + '!'));
  assert.throws(() => canonicalAddress(friendly(2, 0x91)), /mainnet/);
  assert.equal(addressKey('old-nft'), 'old-nft'); assert.equal(addressKey(' Old NFT '), ' Old NFT ');
});

test('exact decimal arithmetic handles huge values, fractions and half-up nano rounding without binary money', () => {
  assert.equal(decimalText(decimal('9007199254740993123456789.000000001')), '9007199254740993123456789.000000001');
  assert.equal(decimalText(multiply(decimal('1'), 1n, 7n)), '0.142857143');
  assert.equal(decimalText(plus(decimal('0.0000000005'), decimal('0'))), '0.000000001');
  assert.equal(decimalText(decimal('-0.0000000005')), '-0.000000001');
  assert.equal(decimalText(decimal('1e-9')), '0.000000001');
  assert.throws(() => decimal('NaN')); assert.throws(() => decimal('1e90000'));
});

test('balanced rational sums preserve exact values and half-up rounding across varied durations', () => {
  const examples = [[], [decimal('0.0000000005')],
    [decimal('9007199254740993123456789.000000001'), decimal('-9007199254740993123456789'), rational(1n, 7n)],
    Array.from({length: 157}, (_, i) => rational(BigInt(i % 3 ? i + 1 : -i), BigInt(86401 + i * 7))),
    [rational(1n, 3n), rational(1n, 6n), decimal('0.0000000005'), decimal('-0.5')],
    [decimal('1e-1000'), decimal('1e1000'), decimal('-1e1000')],
  ];
  for (const values of examples) {
    const expected = values.reduce(plus, rational(0n)), actual = sumRationals(values);
    assert.deepEqual(actual, expected);
    assert.equal(decimalText(actual), decimalText(expected));
    if (values.length) assert.equal(decimalText(multiply(actual, 1n, BigInt(values.length))), decimalText(multiply(expected, 1n, BigInt(values.length))));
  }
  assert.equal(decimalText(sumRationals(examples[4])), '0.000000001');
});

test('thousands of distinct rental durations retain exact collection, model and Black statistics', () => {
  // The sequential sum previously repeatedly reduced a denominator with over
  // 6,000 digits and exhausted the hosted CPU limit on this sized sample.
  const samples = 5900, amount = decimal('0.123456789'), rows = [];
  const rate = index => multiply(amount, 86400n, BigInt(86401 + index * 7));
  for (let index = 0; index < samples; index++) {
    const nft = index + 10;
    rows.push(historical(event(nft, {price: '0.123456789', price_nano: '123456789', duration: 86401 + index * 7})), traits(nft));
  }
  const result = dashboard(rows, {source: 'rentals'}), pricing = result.gifts.find(g => g.id === SUBJECT).pricing;
  const median = decimalText(multiply(plus(rate(2949), rate(2950)), 1n, 2n));
  for (const key of ['collection', 'model', 'model_black']) {
    assert.equal(pricing[key].sample_count, samples);
    assert.equal(pricing[key].distinct_nft_count, samples);
    assert.equal(pricing[key].mean, '0.100908589');
    assert.equal(pricing[key].median, median);
    assert.equal(pricing[key].minimum, decimalText(rate(samples - 1)));
    assert.equal(pricing[key].maximum, decimalText(rate(0)));
  }
  assert.equal(pricing.basis, 'model_black');
  assert.equal(pricing.recommended_price_per_day, '0.100908589');
  assert.equal(result.pricing.rental_record_count, samples);
});

test('compact rental groups preserve aliases, unknown-field variants, replays and malformed rejection counts', () => {
  const base = event(2, {extra: {z: [1, {b: 2, a: 1}], a: true}});
  const reordered = {...Object.fromEntries(Object.entries(base).reverse()), extra: {a: true, z: [1, {a: 1, b: 2}]}};
  const alias = {...base, address: friendly(2), collection_address: friendly(3), src: friendly(900), dst: friendly(901)};
  const changed = {...base, extra: {z: [1, {b: 3, a: 1}], a: true}};
  const malformed = {...event(20), duration: 'invalid'};
  const rows = [base, reordered, alias, changed, changed, malformed, malformed, event(11), event(12), event(13)].map(item => historical(item));
  const result = dashboard(rows, {source: 'rentals'});
  assert.equal(result.pricing.rental_record_count, 3);
  assert.deepEqual(result.pricing.excluded_counts, {ambiguous_history_variants: 2, malformed_history: 1});
  assert.equal(result.gifts[0].pricing.collection.mean, '0.2');
  assert.deepEqual(result.gifts[0].rental_history.excluded_counts, {ambiguous_history_variants: 2});
  assert.equal(result.gifts[0].rental_history.recorded_count, null);
});

test('rental-only listing pruning retains peer traits, collection conflicts and displayed asking prices', () => {
  const records = [gift(), gift(4, {is_portfolio: false}), traits(),
    listed(listing(2, '390000000')), listed(listing(4, '410000000')),
    ...[10, 11, 12, 13].flatMap(nft => [listed(listing(nft)), historical(event(nft))]),
    listed(listing(13), {collection: address(999)})];
  const result = buildCloudDashboard(records, {source: 'rentals', backdrop: 'Black'}, {now: NOW});
  const owned = result.gifts.find(g => g.id === SUBJECT), candidate = result.gifts.find(g => g.id === address(4));
  assert.equal(owned.price_per_day, '0.39'); assert.equal(candidate.price_per_day, '0.41');
  assert.equal(owned.pricing.collection.sample_count, 3); assert.equal(owned.pricing.model.sample_count, 3);
  assert.equal(owned.pricing.model_black.sample_count, 3); assert.equal(owned.pricing.basis, 'model_black');
  assert.equal(owned.pricing.recommended_price_per_day, '0.2');
  assert.deepEqual(result.pricing.excluded_counts, {collection_conflict: 1});
});

test('streamed projections preserve late membership, settings order and arbitrary page boundaries', () => {
  const records = [listed(listing(2, '350000000'), {when: '2026-10-08T11:00:00Z'}),
    ...[2, 10, 11, 12].flatMap(nft => [historical(event(nft)), listed(listing(nft, '390000000'))]),
    traits(), {kind: 'settings', record: {wallet: address(999)}},
    gift(4, {is_portfolio: false}), listed(listing(4, '410000000')), gift(),
    {kind: 'settings', record: {wallet: WALLET}}];
  const seed = records.filter(row => ['portfolio', 'gift', 'settings'].includes(row.kind));
  for (const source of ['rentals', 'listings']) for (const size of [1, 2, 7, 50]) {
    const builder = createCloudDashboardBuilder(seed, {source, backdrop: 'Black'}, {now: NOW});
    builder.add([]);
    for (let from = 0; from < records.length; from += size) builder.add(records.slice(from, from + size));
    const result = builder.finish();
    assert.deepEqual(result, buildCloudDashboard(records, {source, backdrop: 'Black'}, {now: NOW}));
    assert.equal(result.wallet, WALLET);
    assert.equal(result.gifts.find(row => row.id === SUBJECT).price_per_day, '0.39');
    assert.equal(result.gifts.find(row => row.id === address(4)).price_per_day, '0.41');
    assert.throws(() => builder.add([]), /already finished/);
    assert.throws(() => builder.finish(), /already finished/);
  }
});

test('bounded trait evidence keeps precise latest ties, future exclusions and invalid newest observations', () => {
  const latest = '2026-10-09T11:00:00.123002Z';
  const rows = [traits(2, attributes(), latest, {source: 'Fresh B'}),
    traits(2, {}, '2026-10-09T10:00:00Z', {source: 'Old malformed'}),
    traits(2, attributes('Older'), '2026-10-09T11:00:00.123001Z'),
    traits(2, attributes(), latest, {source: 'Fresh A'}),
    traits(2, attributes('Future'), '2026-10-09T12:00:01Z'),
    traits(2, null, RECENT, {trait_evidence: {model: [
      {value: 'Ruby', error: null, source: 'Imported', when: latest},
      {value: 'Invalid time', error: null, source: 'Invalid', when: 'not-a-date'},
    ]}})];
  for (const source of ['rentals', 'listings']) {
    const result = subject(rows, {source});
    assert.equal(result.model, 'Ruby'); assert.equal(result.backdrop, 'Black');
    assert.equal(result.traits_source, 'Fresh A+Fresh B+Imported');
    assert.equal(result.traits_observed_at, latest);
    assert.deepEqual(result.trait_uncertainties, []);
    const invalid = subject([...rows, traits(2, [...attributes(), {trait_type: 'Model', value: 'Other'}],
      '2026-10-09T11:00:00.123003Z')], {source});
    assert.equal(invalid.model, null);
    assert.ok(invalid.trait_uncertainties.some(value => /conflicting/.test(value)));
  }
  const historic = subject([traits(2, attributes('Historic'), '2026-10-08T11:00:00Z'), ...rows],
    {source: 'listings', timeframe: 'custom', date_from: '2026-10-08', date_to: '2026-10-08'});
  assert.equal(historic.model, 'Historic');
});

test('a streamed large rental sample keeps every eligible event without retaining source pages', () => {
  const samples = 70000, seed = [gift()], builder = createCloudDashboardBuilder(seed, {source: 'rentals'}, {now: NOW});
  builder.add(seed);
  for (let from = 0; from < samples; from += 100) {
    const page = Array.from({length: Math.min(100, samples - from)}, (_, offset) => {
      const index = from + offset, days = index % 30 + 1, amount = 120000000n * BigInt(days);
      return historical(event(10 + index % 1000, {ts: NOW / 1000 - index - 1,
        price: decimalText(rational(amount, 1000000000n)), price_nano: String(amount), duration: days * 86400}));
    });
    builder.add(page);
  }
  const result = builder.finish(), collection = result.gifts[0].pricing.collection;
  assert.equal(result.pricing.rental_record_count, samples);
  assert.equal(collection.sample_count, samples); assert.equal(collection.distinct_nft_count, 1000);
  assert.equal(collection.mean, '0.12'); assert.equal(collection.median, '0.12');
  assert.equal(collection.minimum, '0.12'); assert.equal(collection.maximum, '0.12');
  assert.equal(result.gifts[0].pricing.recommended_price_per_day, '0.12');
});

test('collection, exact model and Black groups include the owned subject and exclude merely dark backdrops', () => {
  const rows = [listed(listing(2, '1000000000')), ...Array.from({length: 8}, (_, i) => listed(listing(10 + i, String((i + 2) * 1e9), {attributes: attributes(i < 5 ? 'Ruby' : 'Other', i < 2 || i >= 5 ? 'Black' : 'Onyx Black')})))];
  const normal = subject(rows).pricing;
  assert.deepEqual(['collection', 'model', 'model_black'].map(k => normal[k].sample_count), [9, 6, 3]);
  assert.deepEqual(['collection', 'model', 'model_black'].map(k => normal[k].mean), ['5', '3.5', '2']);
  assert.equal(normal.recommended_price_per_day, '2'); assert.equal(normal.basis, 'model_black');
  const black = subject(rows, {backdrop: 'Black'}).pricing;
  assert.equal(black.collection.mean, '5'); assert.equal(black.collection.sample_count, 6);
  assert.equal(black.model.mean, '2'); assert.equal(black.model.sample_count, 3);
});

test('latest listing per canonical NFT counts once and current asking updates independently of selected history', () => {
  const rows = [listed(listing(2, '350000000'), {when: '2026-10-08T11:00:00Z'}), listed(listing(2, '390000000', {nft_address: friendly(2)})), listed(listing(2, '390000000')), historical(event(2))];
  const result = subject(rows, {source: 'rentals'});
  assert.equal(result.price_per_day, '0.39'); assert.equal(result.price_source, 'Marketapp listing');
  assert.equal(result.pricing.collection.mean, '0.2'); assert.equal(result.pricing.collection.sample_count, 1);
  assert.equal(subject(rows).pricing.collection.sample_count, 1);
});

test('targeted listing samples cannot inflate broader collection/model averages', () => {
  const rows = [10, 11, 12].map(n => listed(listing(n), {params: {model: 'Ruby', backdrop: 'Black'}}));
  const result = subject(rows).pricing;
  assert.equal(result.collection.sample_count, 0); assert.equal(result.model.sample_count, 0); assert.equal(result.model_black.sample_count, 3);
  assert.equal(result.basis, 'model_black');
  const black = subject(rows, {backdrop: 'Black'}).pricing;
  assert.equal(black.collection.sample_count, 0); assert.equal(black.model.sample_count, 3);
  assert.equal(subject(rows.map(r => ({...r, record: {...r.record, params: {symbol: 'Star'}}}))).pricing.model_black.sample_count, 0);
});

test('trait conflicts and collection conflicts fail closed while missing metadata retains collection comparisons', () => {
  const base = [10, 11, 12].map(n => listed(listing(n)));
  const conflicting = subject([...base, traits(2, attributes('Other'), RECENT)]);
  assert.equal(conflicting.model, null); assert.equal(conflicting.pricing.basis, 'collection');
  assert.ok(conflicting.trait_uncertainties.some(w => /conflicting/.test(w)));
  const collectionConflict = subject([...base, {kind: 'metadata', record: {nft_address: SUBJECT, collection_address: address(999)}}]);
  assert.equal(collectionConflict.pricing.recommended_price_per_day, null); assert.match(collectionConflict.pricing.reason, /conflicts/);
  const missing = buildCloudDashboard([gift(), ...base], {}, {now: NOW}).gifts[0];
  assert.equal(missing.model, null); assert.equal(missing.pricing.basis, 'collection');
});

test('same-time contradictory listing prices excluded; observations with distinct microseconds preserve order', () => {
  const conflicting = dashboard([listed(listing(10)), listed(listing(10, '2000000000'))]);
  assert.equal(conflicting.pricing.excluded_counts.conflicting_latest_listing, 1);
  const ordered = dashboard([listed(listing(10), {when: '2026-10-09T11:00:00.000001Z'}), listed(listing(10, '2000000000'), {when: '2026-10-09T11:00:00.000002Z'})]);
  assert.equal(ordered.gifts[0].pricing.collection.mean, '2');
});

test('listing custom windows and compact repeated occurrences preserve historical observations', () => {
  const row = listed(listing(10, '1000000000'), {occurrence_times: ['2026-10-06T09:00:00Z', RECENT]});
  const later = listed(listing(10, '9000000000'));
  const old = subject([row, later], {timeframe: 'custom', date_from: '2026-10-06', date_to: '2026-10-06'}).pricing;
  assert.equal(old.collection.mean, '1'); assert.equal(old.collection.sample_count, 1);
  assert.equal(subject([row, later]).pricing.collection.mean, null); // same-time contradictory latest prices
});

test('rental arithmetic weights unambiguous records, minimum three distinct gifts, aliases and repeated hashes', () => {
  const values = [10, 11, 12].map(n => event(n, {tx_hash: 'same-hash', price: String((n - 9) / 10), price_nano: String((n - 9) * 100000000), duration: 86400}));
  const rows = [...[10, 11, 12].map(n => traits(n)), ...values.map(v => historical(v)), ...values.map(v => historical(v)), historical({...values[0], address: friendly(10), collection_address: friendly(3)})];
  const result = subject(rows, {source: 'rentals'}).pricing;
  assert.equal(result.collection.mean, '0.2'); assert.equal(result.collection.sample_count, 3); assert.equal(result.collection.distinct_nft_count, 3); assert.equal(result.basis, 'model_black');
  const repeats = [1, 2, 3].map(n => historical(event(10, {ts: NOW / 1000 - n * 3600})));
  const oneGift = subject(repeats, {source: 'rentals'}).pricing;
  assert.equal(oneGift.collection.sample_count, 3); assert.equal(oneGift.collection.distinct_nft_count, 1); assert.equal(oneGift.recommended_price_per_day, null);
});

test('rental variants, non-GRAM, extensions, inconsistent amounts and missing duration excluded', () => {
  const rows = [historical(event(10)), historical(event(10, {price: '0.9', price_nano: '900000000'})), historical(event(11, {currency: 'TON'})), historical(event(12, {is_extend: true})), historical(event(13, {price_nano: '1'})), historical(event(14, {duration: 0})), historical(event(15, {price: '-1', price_nano: '-1000000000'}))];
  const unknown = event(16); delete unknown.is_extend; rows.push(historical(unknown));
  const result = dashboard(rows, {source: 'rentals'});
  assert.equal(result.pricing.rental_record_count, 0);
  assert.deepEqual(result.pricing.excluded_counts, {ambiguous_history_variants: 2, non_gram_currency: 1, unverified_extension_semantics: 2, inconsistent_gram_amounts: 1, missing_or_nonpositive_duration: 1, invalid_amount: 1});
});

test('rental counts ignore timeframe and currencies/amounts, but unknown stays unknown and variants remain ambiguous', () => {
  const old = event(2, {ts: NOW / 1000 - 120 * 86400, currency: 'TON'});
  const accepted = event(2, {tx_hash: null});
  const rows = [historical(old), historical(accepted), historical(accepted), historical(event(2, {ts: NOW / 1000 - 7200, is_extend: true}))];
  const result = subject(rows, {source: 'rentals', timeframe: '24h'});
  assert.equal(result.rental_history.recorded_count, 2); assert.equal(result.rental_history.coverage, 'partial'); assert.equal(result.rental_history.excluded_counts.extensions, 1);
  assert.equal(subject([]).rental_history.recorded_count, null);
  const changed = subject([historical(accepted), historical({...accepted, tx_hash: 'late-hash'})]);
  assert.equal(changed.rental_history.recorded_count, null); assert.equal(changed.rental_history.excluded_counts.ambiguous_history_variants, 2);
  const unresolved = buildCloudDashboard([gift(2, {is_portfolio: false}), historical(accepted)], {}, {now: NOW}).gifts[0];
  assert.equal(unresolved.rental_history.coverage, 'not_applicable'); assert.equal(unresolved.pricing.recommended_price_per_day, null);
});

test('rental Black collection baseline accepts older valid metadata and never falls back to all backdrops', () => {
  const rows = [10, 11, 12].flatMap(n => [traits(n, attributes('Ruby', n === 12 ? 'Blue' : 'Black')), historical(event(n))]);
  assert.equal(subject(rows, {source: 'rentals'}).pricing.collection.sample_count, 3);
  const black = subject(rows, {source: 'rentals', backdrop: 'Black'}).pricing;
  assert.equal(black.collection.sample_count, 2); assert.equal(black.recommended_price_per_day, null);
  const stale = rows.map(r => r.kind === 'metadata' ? {...r, observed_at: '2026-10-07T11:00:00Z'} : r);
  assert.equal(subject(stale, {source: 'rentals', backdrop: 'Black'}).pricing.collection.sample_count, 2);
});

test('old saved target and peer traits retain matching recommendations across price sources and scopes', () => {
  const old = '2026-01-01T12:00:00Z';
  for (const source of ['rentals', 'listings']) for (const backdrop of [null, 'Black']) for (const peersModel of ['Ruby', 'Other']) {
    const rows = [gift(2, {state: 'rented'}), gift(4), traits(2, attributes(), old), traits(4),
      ...[10, 11, 12].flatMap(n => [traits(n, attributes(peersModel), old), source === 'rentals'
        ? historical(event(n)) : listed(listing(n, '200000000', {attributes: []}))])];
    const selection = {source, backdrop, timeframe: '30d'};
    const result = buildCloudDashboard(rows, selection, {now: NOW});
    const [older, recent] = result.gifts;
    assert.equal(older.traits_observed_at, old);
    assert.ok(older.trait_uncertainties.some(value => /older/.test(value)));
    assert.equal(older.pricing.recommended_price_per_day, '0.2');
    assert.equal(older.pricing.recommended_price_per_day, recent.pricing.recommended_price_per_day);
    assert.equal(older.pricing.basis, peersModel === 'Ruby' ? 'model_black' : 'collection');
    assert.deepEqual(older.pricing.collection, recent.pricing.collection);
    assert.equal(older.pricing.collection.sample_count, 3);
    // Crossing the metadata age cutoff changes its age warning, not the cohort.
    const aged = buildCloudDashboard(rows, selection, {now: NOW + 2 * 86400000}).gifts[1];
    assert.equal(aged.pricing.recommended_price_per_day, recent.pricing.recommended_price_per_day);
    assert.equal(aged.pricing.basis, recent.pricing.basis);
    // Saved traits never keep expired price observations or rentals eligible.
    const expired = buildCloudDashboard(rows, selection, {now: NOW + 31 * 86400000}).gifts[0];
    assert.equal(expired.pricing.recommended_price_per_day, null);
    assert.equal(expired.pricing.collection.sample_count, 0);
  }
});

test('saved traits do not bypass missing, malformed, conflicting, future or newer non-Black evidence', () => {
  const old = '2026-01-01T12:00:00Z', newer = '2026-10-07T12:00:00Z';
  const rejected = [[], [traits(2, {}, old)],
    [traits(2, attributes(), old), traits(2, attributes('Ruby', 'Blue'), old)],
    [traits(2, attributes(), '2026-10-10T12:00:00Z')],
    [traits(2, attributes(), old), traits(2, {}, newer)],
    [traits(2, attributes(), old), traits(2, attributes('Ruby', 'Blue'), newer)],
    [traits(2, attributes(), old), traits(2, attributes('Ruby', 'Blue'), newer), traits(2, attributes(), newer)]];
  for (const source of ['rentals', 'listings']) {
    const peers = [10, 11, 12].flatMap(n => [traits(n, attributes(), old), source === 'rentals'
      ? historical(event(n)) : listed(listing(n, '200000000', {attributes: []}))]);
    for (const metadata of rejected) {
      const result = buildCloudDashboard([gift(), ...metadata, ...peers], {source, backdrop: 'Black'}, {now: NOW}).gifts[0];
      assert.equal(result.pricing.recommended_price_per_day, null);
      assert.match(result.pricing.reason, /no valid saved evidence/);
    }
    for (const values of [{}, [...attributes(), {trait_type: 'Backdrop', value: 'Blue'}], attributes('Ruby', 'Onyx Black')]) {
      const result = buildCloudDashboard([gift(), traits(2, attributes(), old), ...peers, traits(12, values, newer)],
        {source, backdrop: 'Black'}, {now: NOW}).gifts[0];
      assert.equal(result.pricing.collection.sample_count, 2);
      assert.equal(result.pricing.recommended_price_per_day, null);
    }
    const changed = buildCloudDashboard([gift(), traits(2, attributes('Old model'), old), traits(2, attributes(), newer), ...peers],
      {source, backdrop: 'Black'}, {now: NOW}).gifts[0];
    assert.equal(changed.model, 'Ruby');
    assert.equal(changed.pricing.basis, 'model_black');
  }
});

test('saved portfolio labels, provenance and newer contract asking survive a price refresh', () => {
  const seed = gift(2, {automatic_membership: true, membership_sources: ['ton_verified', 'user_declared'], verification_method: 'automatic', price_per_day: '0.39', price_source: 'Observed contract terms', price_observed_at: '2026-10-09T11:30:00Z', label: 'Mine', observed_at: RECENT, state: 'rented', display_state: 'Rented'});
  const result = buildCloudDashboard([seed, listed(listing(2, '350000000')), ...[10, 11].map(n => listed(listing(n)))], {}, {now: NOW});
  assert.equal(result.gifts.length, 1); assert.equal(result.gifts[0].price_per_day, '0.39'); assert.equal(result.gifts[0].label, 'Mine');
  assert.equal(result.gifts[0].state, 'rented'); assert.equal(result.summary.automatic_count, 1); assert.deepEqual(result.gifts[0].membership_sources, ['ton_verified', 'user_declared']);
  assert.equal(result.gifts[0].pricing.collection.sample_count, 3);
});

test('projection is side-effect-free and listing visibility never creates or deletes membership', () => {
  const rows = [gift(), traits(), listed(listing(10))], before = JSON.stringify(rows);
  const result = buildCloudDashboard(rows, {}, {now: NOW});
  assert.equal(result.summary.portfolio_count, 1); assert.equal(result.gifts[0].price_per_day, null); assert.equal(JSON.stringify(rows), before);
  assert.equal(buildCloudDashboard([listed(listing(10))], {}, {now: NOW}).gifts.length, 0);
});

test('ten Python-generated fixture cases match JS pricing, traits, recommendations and rental counts', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cloud-pricing-parity.json', import.meta.url), 'utf8'));
  const normalize = value => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
    return value;
  };
  for (const sample of fixture.cases) {
    const actual = buildCloudDashboard(fixture.records, sample.selection, {now: fixture.now});
    for (const key of ['fresh_peer_count', 'rental_record_count', 'recommended_count', 'excluded_counts']) assert.deepEqual(actual.pricing[key], sample.pricing[key], JSON.stringify(sample.selection) + ' summary ' + key);
    for (const expected of sample.gifts) {
      const observed = actual.gifts.find(g => g.nft_address === expected.nft_address);
      for (const key of ['pricing', 'rental_history', 'model', 'backdrop', 'traits_source', 'traits_observed_at', 'trait_uncertainties']) assert.deepEqual(normalize(observed[key]), normalize(expected[key]), JSON.stringify(sample.selection) + ' gift ' + key);
    }
  }
});

test('millisecond timestamps are malformed history rather than valid distant-future rentals', () => {
  const result = dashboard([historical(event(10, {ts: NOW}))], {source: 'rentals'});
  assert.equal(result.pricing.excluded_counts.malformed_history, 1);
});

test('request-scoped caches never retain changed evidence or a previous timeframe', () => {
  const rows = [gift(), traits(), ...[10, 11, 12].map(n => listed(listing(n, '1000000000', {nft_address: friendly(n)})))];
  const first = buildCloudDashboard(rows, {}, {now: NOW});
  assert.equal(first.gifts[0].pricing.collection.mean, '1');
  for (const envelope of rows.filter(r => r.kind === 'listing')) {
    const item = JSON.parse(envelope.record.source_json);
    item.price_per_day = '3000000000';
    envelope.record.source_json = JSON.stringify(item);
  }
  const second = buildCloudDashboard(rows, {}, {now: NOW});
  assert.equal(second.gifts[0].pricing.collection.mean, '3');
  assert.equal(first.gifts[0].pricing.collection.mean, '1');
  const later = buildCloudDashboard(rows, {timeframe: '24h'}, {now: NOW + 2 * 86400000});
  assert.equal(later.gifts[0].pricing.collection.mean, null);
  assert.equal(buildCloudDashboard([], {}, {now: NOW}).gifts.length, 0);
});
