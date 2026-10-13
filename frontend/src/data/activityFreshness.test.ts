import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ACTIVITY_FRESHNESS_MINUTES, ACTIVITY_GIFT_CHECK_MINUTES, activityFreshnessRows } from './activityFreshness.ts';
import type { ActivityComparisonEvidence, ActivityComparisonSourceEvidence } from './activityFreshness.ts';
import type { Dashboard, Gift, Job, PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime } from './types.ts';
import { canonicalMainnetAddress, friendlyMainnetAddress } from '../serverless/walletIdentity.ts';
import type { OwnedPriceSnapshot } from './ownedPriceRefresh.ts';

const now = Date.parse('2026-10-11T12:00:00Z'), when = (age = 0) => new Date(now - age).toISOString();
const address = (byte: string) => `0:${byte.repeat(64)}`;
function gift(index = '1', changes: Partial<Gift> = {}): Gift {
  return { id: address(index), nft_address: address(index), name: 'Gift', collection_name: 'Collection',
    collection_address: address('a'), image_url: null, state: 'rented', display_state: 'Rented', ui_state: 'rented',
    category: 'portfolio', is_portfolio: true, automatic_membership: true, membership_sources: ['ton_discovery'],
    verification_method: 'supported_rental_contract', proof_badges: [], price_per_day: '0.1', price_unit: 'GRAM',
    price_source: 'Marketapp account', price_observed_at: when(), price_is_historical: false, rental_until: null,
    status_is_historical: false, status_observed_at: when(), status_checked_at: when(), observed_at: when(),
    market_observed_at: when(), explorer_url: null, uncertainties: [], ...changes };
}
function dashboard(gifts = [gift()], changes: Partial<Dashboard> = {}): Dashboard {
  return { wallet: address('f'), generated_at: when(), gifts, activity: [], coverage: {}, runs: [], review: [],
    summary: { portfolio_count: gifts.length, automatic_count: gifts.length, review_count: 0, for_rent_count: 0,
      idle_count: 0, rented_count: gifts.length, direct_count: 0, sale_count: 0, unresolved_count: 0 },
    capabilities: { network_enabled: true, marketapp_configured: true, ton_configured: true,
      wallet_configured: true, csrf_token: '', marketapp_analytics_refresh: true }, ...changes };
}
function source(changes: Partial<ActivityComparisonSourceEvidence> = {}): ActivityComparisonSourceEvidence {
  return { total_collections: 3, checked_collections: 3, fresh_collections: 3, complete: true,
    freshest_checked_at: when(), oldest_checked_at: when(10 * 60000), timeframe: '30d',
    window_from: when(30 * 86400000), window_to: when(), ...changes };
}
function comparison(changes: Partial<ActivityComparisonEvidence> = {}): ActivityComparisonEvidence {
  return { version: 1, listings: source(), rentals: source(), ...changes };
}
function report(days = 30, age = 0, end = '2026-10-11'): PersonalRentalAnalytics {
  const start = Date.parse(end) - (days - 1) * 86400000;
  return { version: 1, source: 'marketapp_personal_rent_page', source_url: 'https://marketapp.org/', wallet: address('f'),
    captured_at: when(age), period_start: new Date(start).toISOString().slice(0, 10), period_end: end,
    timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees', fingerprint: 'a'.repeat(64),
    daily: Array.from({ length: days }, (_, index) => ({ date: new Date(start + index * 86400000).toISOString().slice(0, 10),
      rent_volume: '0', new_rentals: 0, extensions: 0, rentals: 0 })),
    summary: { rent_volume: '0', rentals: 0, new_rentals: 0, extensions: 0, items: 0, price_per_day: null,
      average_duration: null, extension_percent: null, spent_on_rent: null, spending_rentals: null } };
}

test('custom rental checks ending today retain dated coverage and expose their original history watermark', () => {
  const rentalEvidence = source({ timeframe: 'custom', window_from: '2026-10-01T00:00:00Z', window_to: when(),
    oldest_checked_through: when(20 * 60000), freshest_checked_through: when(15 * 60000) });
  const data = dashboard(undefined, { pricing: { timeframe: 'custom', window_from: rentalEvidence.window_from, window_to: rentalEvidence.window_to } });
  const result = get(present(data, comparison({ rentals: rentalEvidence })), 'rentals');
  assert.equal(result.state, 'fresh');
  assert.equal(result.updatedAt, when(), 'the last provider page keeps its own actual time');
  assert.match(result.coverage, /3 of 3 collections checked/);
  assert.match(result.detail, /Rental history checked through /);
  assert.notEqual(result.updatedAt, rentalEvidence.oldest_checked_through);
});

test('visible-page clock ages history watermark even when final provider page is newer', () => {
  const rentalEvidence = source({ timeframe: 'custom', window_from: '2026-10-01T00:00:00Z', window_to: when(),
    oldest_checked_through: when(60 * 60000 - 1), freshest_checked_through: when(20 * 60000) });
  const data = dashboard(undefined, { pricing: { timeframe: 'custom', window_from: rentalEvidence.window_from, window_to: rentalEvidence.window_to } });
  const evidence = comparison({ rentals: rentalEvidence });
  assert.equal(get(present(data, evidence), 'rentals').state, 'fresh');
  const aged = get(present(data, evidence, [], now + 1), 'rentals');
  assert.equal(aged.state, 'older');
  assert.equal(aged.updatedAt, when());
  assert.match(aged.coverage, /3 of 3 collections checked/);
  assert.match(aged.detail, /Comparison data is more than an hour old/);
});

test('fixed historical rental windows can be recently checked without a recent history endpoint', () => {
  const rentalEvidence = source({ timeframe: 'custom', window_from: '2026-10-01T00:00:00Z', window_to: '2026-10-10T23:59:59.999Z',
    oldest_checked_through: '2026-10-10T23:59:59.000Z', freshest_checked_through: '2026-10-10T23:59:59.000Z' });
  const result = get(present(dashboard(), comparison({ rentals: rentalEvidence })), 'rentals');
  assert.equal(result.state, 'fresh');
  assert.match(result.detail, /Rental history checked through /);
});

test('malformed or conflicting history watermarks cannot show green coverage', () => {
  for (const watermarks of [
    { oldest_checked_through: 'invalid', freshest_checked_through: when() },
    { oldest_checked_through: when(60000) },
    { oldest_checked_through: when(), freshest_checked_through: when(60000) },
    { oldest_checked_through: when(-1), freshest_checked_through: when(-1) },
  ]) {
    const result = get(present(dashboard(), comparison({ rentals: source(watermarks) })), 'rentals');
    assert.equal(result.state, 'missing');
    assert.equal(result.updatedAt, null);
    assert.doesNotMatch(result.detail, /Rental history checked through /);
  }
});
const present = (data = dashboard(), evidence?: ActivityComparisonEvidence | null, jobs: Job[] = [], clock = now) =>
  activityFreshnessRows(data, jobs, { now: clock, comparisonEvidence: evidence });
const get = (rows: ReturnType<typeof present>, id: string) => rows.find(item => item.id === id)!;
const job = (kind: Job['kind'], changes: Partial<Job> = {}): Job => ({ id: 1, kind, state: 'complete',
  created_at: when(), updated_at: when(), reason: null, run_id: 1, progress: {}, stop_requested: false, ...changes });
function scopeSignature(data = dashboard()): string {
  const targets = [...new Map(data.gifts.filter(gift => gift.is_portfolio).map(gift => {
    const nft = canonicalMainnetAddress(gift.nft_address)!;
    return [nft, { nft_address: nft, collection_address: canonicalMainnetAddress(gift.collection_address)! }] as const;
  })).values()].sort((a, b) => a.nft_address.localeCompare(b.nft_address));
  return createHash('sha256').update(JSON.stringify({ wallet: canonicalMainnetAddress(data.wallet), targets })).digest('hex');
}
function refresh(changes: Partial<NonNullable<OwnedPriceSnapshot['run']>> = {}, snapshot: Partial<OwnedPriceSnapshot> = {}): OwnedPriceSnapshot {
  return { phase: 'complete', canStop: false, run: { id: 1, scope: 'portfolio', wallet: address('f'), state: 'complete',
    total: 1, checked: 1, updated: 1, unresolved: 0, status_updated: 1, status_unresolved: 0,
    scope_signature: scopeSignature(),
    started_at: when(60000), completed_at: when(), reason: null, ...changes }, ...snapshot };
}
const checkedRows = (data: Dashboard, giftRefresh: OwnedPriceSnapshot) => activityFreshnessRows(data, [], { now, giftRefresh });

test('the rows are independent and a loaded dashboard or successful unrelated job is not source evidence', () => {
  const rows = present(dashboard([gift('1', { status_observed_at: null, price_observed_at: null })], {
    activity: [{ observed_at: when() }], coverage: { last_observed_at: when() },
    pricing: { generated_at: when(), observed_to: when(), fresh_peer_count: 100 },
    runs: [{ finished_at: when(), state: 'complete' }],
  }), null, [job('collect'), job('refresh')]);
  assert.deepEqual(rows.map(row => row.id), ['gifts', 'prices', 'listings', 'rentals', 'analytics-30', 'analytics-all_time']);
  assert.ok(rows.every(row => row.tone === 'older' && row.updatedAt === null));
  assert.equal(get(rows, 'listings').coverage, 'Coverage not confirmed');
});

test('fresh gift and price coverage requires every saved gift and changes at the exact five-minute boundary', () => {
  assert.equal(ACTIVITY_FRESHNESS_MINUTES.gifts, 5);
  const data = dashboard([gift(), gift('2', { status_observed_at: when(5 * 60000 - 1), price_observed_at: when(5 * 60000 - 1) })]);
  for (const id of ['gifts', 'prices']) {
    const fresh = get(present(data), id);
    assert.equal(fresh.tone, 'fresh');
    assert.equal(fresh.coverage, id === 'gifts' ? '2 statuses confirmed' : '2 prices available');
    assert.equal(fresh.updatedAt, when());
    assert.equal(fresh.oldestUpdatedAt, when(5 * 60000 - 1));
    const aged = get(present(data, null, [], now + 1), id);
    assert.equal(aged.tone, 'older');
    assert.equal(aged.state, 'older');
    assert.equal(aged.coverage, id === 'gifts' ? '2 statuses confirmed' : '2 prices available');
    assert.match(aged.detail, /1 of 2 gifts have current/);
  }
});

test('a newer single-gift update cannot make the older remainder of the portfolio green', () => {
  const rows = present(dashboard([gift(), gift('2', { status_observed_at: when(3600000), price_observed_at: when(3600000) })]));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).tone, 'older');
    assert.equal(get(rows, id).coverage, id === 'gifts' ? '2 statuses confirmed' : '2 prices available');
    assert.match(get(rows, id).detail, /1 of 2 gifts have current/);
    assert.equal(get(rows, id).updatedAt, when());
    assert.equal(get(rows, id).oldestUpdatedAt, when(3600000));
  }
});

test('failed status checks, historical prices, unknown state and collection conflict stay orange', () => {
  const rows = present(dashboard([gift(), gift('2', { status_is_historical: true, price_is_historical: true })]));
  assert.equal(get(rows, 'gifts').state, 'incomplete');
  assert.equal(get(rows, 'prices').state, 'incomplete');
  const failed = present(dashboard([gift('1', { status_is_historical: true, price_is_historical: true,
    status_observed_at: when(), price_observed_at: when(3600000), status_checked_at: when() })]));
  assert.equal(get(failed, 'gifts').updatedAt, null, 'failed check time is not a successful update');
  assert.equal(get(failed, 'prices').updatedAt, when(3600000), 'retained old price keeps its original date');
  for (const changes of [{ state: 'unknown' }, { collection_conflict: true }] as Partial<Gift>[]) {
    assert.equal(get(present(dashboard([gift('1', changes)])), 'gifts').tone, 'older');
  }
});

test('retained portfolio membership needing review stays in the denominator instead of disappearing', () => {
  const rows = present(dashboard([gift(), gift('2', { category: 'unresolved', state: 'unknown', ui_state: null,
    status_is_historical: true, price_is_historical: true })]));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).coverage, id === 'gifts' ? '1 status confirmed · 1 unverified' : '1 price available · 1 unavailable');
    assert.equal(get(rows, id).state, 'incomplete');
    assert.equal(get(rows, id).tone, 'older');
  }
});

test('a failed current status check can show its actual prior successful date without becoming fresh', () => {
  const prior = { ...gift('1', { status_is_historical: true, status_observed_at: when() }),
    ownership_observed_at: when(3600000), previous_status_observed_at: when(7200000) };
  const status = get(present(dashboard([prior])), 'gifts');
  assert.equal(status.updatedAt, when(3600000));
  assert.equal(status.tone, 'older');
  assert.equal(status.coverage, '0 statuses confirmed · 1 unverified');
});

test('authenticated Marketapp availability is fresh rental status without asserting on-chain custody', () => {
  const available = gift('1', { state: 'unknown', ui_state: 'for_rent', status_is_historical: false });
  assert.equal(get(present(dashboard([available])), 'gifts').tone, 'fresh');
  assert.equal(get(present(dashboard([{ ...available, ui_state: null }])), 'gifts').tone, 'older');
});

test('rental status and asking prices can have different freshness and missing amounts are not zero prices', () => {
  const rows = present(dashboard([gift('1', { price_observed_at: when(3600000) }), gift('2', { price_per_day: null })]));
  assert.equal(get(rows, 'gifts').tone, 'fresh');
  assert.equal(get(rows, 'prices').state, 'incomplete');
  assert.equal(get(rows, 'prices').updatedAt, when(3600000));
  for (const changes of [{ price_per_day: 'private upstream error' }, { price_unit: 'TON' }, { price_source: null }] as Partial<Gift>[]) {
    assert.equal(get(present(dashboard([gift('1', changes)])), 'prices').updatedAt, null);
  }
  assert.equal(get(present(dashboard([gift('1', { price_per_day: '0' })])), 'prices').tone, 'fresh');
});

test('canonical address aliases count once, opaque identities stay distinct and conflicting duplicates are unresolved', () => {
  const original = gift(), alias = gift('1', { nft_address: friendlyMainnetAddress(original.nft_address)!, price_per_day: '0.100' });
  const rows = present(dashboard([original, alias, gift('2', { is_portfolio: false, category: 'unresolved' })]));
  assert.equal(get(rows, 'gifts').coverage, '1 status confirmed');
  assert.equal(get(rows, 'prices').tone, 'fresh');
  assert.equal(get(present(dashboard([original, { ...alias, price_per_day: '0.2' }])), 'prices').state, 'incomplete');
  assert.equal(get(present(dashboard([original, { ...alias, state: 'idle_rental_contract', ui_state: 'for_rent' }])), 'gifts').tone, 'older');
  const legacy = present(dashboard([gift('1', { nft_address: 'A' }), gift('2', { nft_address: 'a' })]));
  assert.equal(get(legacy, 'gifts').coverage, '2 statuses confirmed');
});

test('only complete source-specific collection evidence can turn comparison averages green', () => {
  const rows = present(dashboard(), comparison({ rentals: source({ checked_collections: 1, fresh_collections: 1, complete: false }) }));
  assert.equal(get(rows, 'listings').tone, 'fresh');
  assert.equal(get(rows, 'rentals').state, 'incomplete');
  assert.equal(get(rows, 'rentals').coverage, '1 of 3 collections checked · last 30 days');
  const old = present(dashboard(), comparison({ listings: source({ oldest_checked_at: when(3600000), fresh_collections: 3 }) }));
  assert.equal(get(old, 'listings').tone, 'older', 'cached original timestamps age, regardless of a new complete job');
  assert.equal(get(old, 'rentals').tone, 'fresh');
});

test('comparison count and timestamp validation refuses malformed, contradictory or empty green coverage', () => {
  for (const changes of [
    { checked_collections: 4 }, { checked_collections: -1 }, { fresh_collections: 4 }, { fresh_collections: Number.NaN },
    { freshest_checked_at: when(-1) }, { oldest_checked_at: when(-1) }, { oldest_checked_at: null },
    { freshest_checked_at: when(3600000), oldest_checked_at: when() }, { freshest_checked_at: '2026-02-30T12:00:00Z' },
    { total_collections: 0, checked_collections: 0, fresh_collections: 0, freshest_checked_at: null, oldest_checked_at: null },
  ]) {
    const listed = get(present(dashboard(), comparison({ listings: source(changes) })), 'listings');
    assert.equal(listed.tone, 'older');
    assert.equal(listed.state, 'missing');
  }
  const missing = get(present(dashboard(), { ...comparison(), version: 2 } as unknown as ActivityComparisonEvidence), 'rentals');
  assert.equal(missing.updatedAt, null);
});

test('running comparisons annotate their own rows without promoting previous saved figures', () => {
  const rows = present(dashboard(), null, [job('rental_prices', { state: 'running' })]);
  assert.equal(get(rows, 'rentals').updating, true);
  assert.equal(get(rows, 'rentals').tone, 'older');
  assert.equal(get(rows, 'listings').updating, false);
  const ownership = present(dashboard(), null, [job('discover', { state: 'running' })]);
  assert.equal(get(ownership, 'gifts').updating, true);
  assert.equal(get(ownership, 'prices').updating, false);
  const interrupted = present(dashboard(), null, [job('rental_prices', { state: 'running', progress: { requires_resume: true } })]);
  assert.equal(get(interrupted, 'rentals').updating, false);
  const closed = present(dashboard(), null, [job('prices', { state: 'running', progress: { client_interrupted: true } })]);
  assert.equal(get(closed, 'listings').updating, false);
});

test('comparison proof must fit the displayed timeframe and exact report window', () => {
  const pricing = { timeframe: '30d', window_from: when(30 * 86400000), window_to: when() };
  assert.equal(get(present(dashboard([], { pricing }), comparison()), 'rentals').tone, 'fresh');
  for (const proof of [
    { timeframe: '7d' }, { timeframe: 'all' }, { timeframe: undefined },
    { window_from: undefined }, { window_to: undefined }, { window_from: when(29 * 86400000) },
    { window_from: when(), window_to: when(1000) }, { window_from: '2026-02-30T12:00:00Z' },
    { window_to: when(-1) }, { window_from: when(91 * 86400000) },
  ]) {
    const rows = present(dashboard([], { pricing }), comparison({ rentals: source(proof) }));
    assert.equal(get(rows, 'rentals').tone, 'older');
    assert.equal(get(rows, 'rentals').updatedAt, null);
    assert.equal(get(rows, 'rentals').coverage, 'Coverage not confirmed');
    assert.equal(get(rows, 'listings').tone, 'fresh', 'the other independent source is unchanged');
  }
  const custom = { timeframe: 'custom', window_from: when(10 * 86400000), window_to: when(86400000) };
  const exact = comparison({ rentals: source(custom) });
  assert.equal(get(present(dashboard([], { pricing: custom }), exact), 'rentals').tone, 'fresh');
  assert.equal(get(present(dashboard([], { pricing: { ...custom, window_to: when(2 * 86400000) } }), exact), 'rentals').tone, 'older');
});

test('unresolved collection identities prevent a full green comparison even if every known collection is checked', () => {
  const rows = present(dashboard(), comparison({ listings: source({ unresolved_collections: 1, complete: true }) }));
  assert.equal(get(rows, 'listings').state, 'incomplete');
  assert.equal(get(rows, 'listings').tone, 'older');
  assert.match(get(rows, 'listings').coverage, /1 unresolved/);
});

test('monthly and annual personal analytics show separate capture dates and independently age', () => {
  const rows = present(dashboard([], { personal_analytics: report(365, 3600000),
    personal_analytics_snapshots: [report(), report(365, 3600000)] }));
  assert.equal(get(rows, 'analytics-30').tone, 'fresh');
  assert.equal(get(rows, 'analytics-365').tone, 'older');
  assert.equal(get(rows, 'analytics-365').updatedAt, when(3600000));
  const aged = present(dashboard([], { personal_analytics: report(30, 15 * 60000) }));
  assert.equal(get(aged, 'analytics-30').tone, 'older');
});

test('analytics captures from yesterday, malformed dates or another wallet cannot show green', () => {
  const midnight = Date.parse('2026-10-12T00:00:01Z');
  const previousDay = report(); previousDay.captured_at = new Date(midnight - 2000).toISOString();
  assert.equal(get(present(dashboard([], { personal_analytics: previousDay }), null, [], midnight), 'analytics-30').tone, 'older');
  const badReport = { ...report(), captured_at: '2026-02-30T12:00:00Z' };
  assert.equal(get(present(dashboard([], { personal_analytics: badReport })), 'analytics-30').updatedAt, null);
  const otherWallet = { ...report(), wallet: address('a') };
  assert.equal(get(present(dashboard([], { personal_analytics: otherWallet })), 'analytics-30').state, 'missing');
});

test('future dates and a broken clock do not show any information as fresh', () => {
  const future = present(dashboard([gift('1', { status_observed_at: when(-1), price_observed_at: when(-1) })]));
  assert.equal(get(future, 'gifts').tone, 'older');
  assert.equal(get(future, 'prices').tone, 'older');
  const invalidClock = present(dashboard([], { personal_analytics: report() }), comparison(), [], Number.NaN);
  assert.ok(invalidClock.every(row => row.tone === 'older' && row.updatedAt === null));
});

test('microsecond desktop observations and explicit timezone offsets preserve their actual update date', () => {
  const saved = gift('1', { status_observed_at: '2026-10-11T11:59:00.123456+00:00',
    price_observed_at: '2026-10-11T13:59:00.123456+02:00' });
  const rows = present(dashboard([saved]));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).updatedAt, '2026-10-11T11:59:00.123Z');
    assert.equal(get(rows, id).tone, 'fresh');
  }
  const invalid = gift('1', { status_observed_at: '2026-02-30T11:59:00.123456+02:00' });
  assert.equal(get(present(dashboard([invalid])), 'gifts').updatedAt, null);
});

test('the additive dashboard evidence field is read directly without a separate adapter or refresh request', () => {
  const data = { ...dashboard(), data_freshness: comparison() };
  assert.equal(get(activityFreshnessRows(data, [], { now }), 'listings').tone, 'fresh');
  assert.equal(get(activityFreshnessRows(data, [], { now }), 'rentals').tone, 'fresh');
});

test('a completed portfolio check is separate from its unavailable statuses and prices', () => {
  const gifts = Array.from({ length: 161 }, (_, index) => gift('1', {
    id: `gift-${index}`, nft_address: `0:${index.toString(16).padStart(64, '0')}`,
    ...(index < 88 ? {} : { state: 'unknown', ui_state: null, category: 'unresolved', status_is_historical: true,
      price_is_historical: true, price_observed_at: when(3600000), price_checked_at: when() }),
  }));
  const rows = checkedRows(dashboard(gifts), refresh({ total: 161, checked: 161, updated: 88, unresolved: 73,
    status_updated: 88, status_unresolved: 73, scope_signature: scopeSignature(dashboard(gifts)) }));
  assert.equal(get(rows, 'gifts').coverage, '88 statuses confirmed · 73 unverified');
  assert.equal(get(rows, 'prices').coverage, '88 prices available · 73 unavailable');
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).checkStatus, 'Check complete · 161/161 checked');
    assert.equal(get(rows, id).checkedAt, when());
    assert.equal(get(rows, id).state, 'incomplete');
    assert.equal(get(rows, id).tone, 'older', 'check completion cannot promote unavailable values');
    assert.equal(get(rows, id).checkPresentation?.status, 'Checked');
    assert.equal(get(rows, id).checkPresentation?.tone, 'fresh', 'the check has independent presentation');
    assert.equal(get(rows, id).availabilityWarning, true);
  }
});

test('screenshot coverage uses a green dated Checked label while unknown statuses and prices stay warnings', () => {
  const age = 15 * 60000;
  const gifts = Array.from({ length: 161 }, (_, index) => gift('1', {
    id: `gift-${index}`, nft_address: `0:${index.toString(16).padStart(64, '0')}`,
    status_observed_at: when(age), status_checked_at: when(age),
    price_observed_at: when(age), price_checked_at: when(age),
    ...(index < 112 ? {} : { state: 'unknown', ui_state: null, status_is_historical: true }),
    ...(index < 88 ? {} : { price_per_day: null, price_observed_at: when(3600000), price_is_historical: true }),
  }));
  const rows = checkedRows(dashboard(gifts), refresh({ total: 161, checked: 161, updated: 88, unresolved: 73,
    status_updated: 112, status_unresolved: 49, started_at: when(age + 60000), completed_at: when(age),
    scope_signature: scopeSignature(dashboard(gifts)) }));
  assert.equal(get(rows, 'gifts').coverage, '112 statuses confirmed · 49 unverified');
  assert.equal(get(rows, 'prices').coverage, '88 prices available · 73 unavailable');
  for (const id of ['gifts', 'prices']) {
    const item = get(rows, id);
    assert.deepEqual(item.checkPresentation, { tone: 'fresh', status: 'Checked', checkedAt: when(age + 60000) });
    assert.equal(item.availabilityWarning, true);
    assert.equal(item.state, 'incomplete', 'underlying source coverage stays incomplete');
    assert.equal(item.tone, 'older', 'the values themselves are not promoted');
    assert.match(item.detail, /does not confirm every value/);
  }
  assert.equal(gifts[160].status_is_historical, true);
  assert.equal(gifts[160].price_per_day, null);
  assert.equal(gifts[160].price_is_historical, true);
});

test('a complete check ages at one hour based on its original run start, not retained fields or a new finish time', () => {
  assert.equal(ACTIVITY_GIFT_CHECK_MINUTES, 60);
  const recentData = dashboard([gift('1', { status_checked_at: when(3600000 - 1), price_checked_at: when(3600000 - 1) }), gift('2')]);
  const complete = refresh({ total: 2, checked: 2, updated: 2, status_updated: 2, started_at: when(3600000 - 1),
    scope_signature: scopeSignature(recentData) });
  const before = checkedRows(recentData, complete);
  const atBoundary = activityFreshnessRows(recentData, [], { now: now + 1, giftRefresh: complete });
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(before, id).checkPresentation?.tone, 'fresh');
    assert.equal(get(before, id).checkPresentation?.checkedAt, when(3600000 - 1));
    assert.equal(get(atBoundary, id).checkPresentation?.tone, 'older');
    assert.equal(get(atBoundary, id).checkPresentation?.status, 'Checked earlier');
    assert.equal(get(atBoundary, id).updatedAt, when(), 'source observations keep their actual date');
  }
});

test('cache reuse cannot make old or incomplete original check dates green', () => {
  const old = dashboard([gift('1', { status_checked_at: when(3600000), price_checked_at: when(3600000) }), gift('2')]);
  const cached = refresh({ total: 2, checked: 2, updated: 2, status_updated: 2,
    check_started_at: when(3600000), scope_signature: scopeSignature(old) }, { cacheHit: true });
  for (const id of ['gifts', 'prices']) {
    const item = get(checkedRows(old, cached), id);
    assert.equal(item.checkPresentation?.tone, 'older');
    assert.equal(item.checkPresentation?.checkedAt, when(3600000));
    assert.equal(item.checkedAt, when(), 'latest target date remains separate from the oldest target date');
  }
  const missing = dashboard([gift('1', { status_observed_at: null, status_checked_at: null,
    price_per_day: null, price_checked_at: null, price_observed_at: null })]);
  for (const id of ['gifts', 'prices']) {
    const item = get(checkedRows(missing, refresh({}, { cacheHit: true })), id);
    assert.equal(item.checkPresentation?.tone, 'older');
    assert.equal(item.checkPresentation?.status, 'Check not confirmed');
    assert.equal(item.checkPresentation?.checkedAt, null);
  }
});

test('a validated recent full check dates attempts independently of retained older or missing value evidence', () => {
  const oldFields = dashboard(Array.from({ length: 161 }, (_, index) => gift('1', {
    id: `gift-${index}`, nft_address: `0:${index.toString(16).padStart(64, '0')}`,
    status_observed_at: when(86400000), status_checked_at: when(86400000),
    price_observed_at: when(86400000), price_checked_at: when(86400000),
    ...(index < 112 ? {} : { state: 'unknown', ui_state: null, status_is_historical: true }),
    ...(index < 88 ? {} : { price_per_day: null, price_is_historical: true }),
  })));
  const fullCheck = refresh({ total: 161, checked: 161, updated: 88, unresolved: 73,
    status_updated: 112, status_unresolved: 49, started_at: when(15 * 60000), completed_at: when(14 * 60000),
    scope_signature: scopeSignature(oldFields) });
  const rows = checkedRows(oldFields, fullCheck);
  for (const id of ['gifts', 'prices']) {
    const item = get(rows, id);
    assert.deepEqual(item.checkPresentation, { tone: 'fresh', status: 'Checked', checkedAt: when(15 * 60000) });
    assert.equal(item.updatedAt, when(86400000), 'the dated values are never renewed by completion');
    assert.equal(item.availabilityWarning, true);
    assert.equal(item.state, 'incomplete');
  }
  const cached = refresh({ total: 161, checked: 161, updated: 88, unresolved: 73,
    status_updated: 112, status_unresolved: 49, check_started_at: fullCheck.run!.started_at,
    scope_signature: scopeSignature(oldFields) }, { cacheHit: true });
  for (const id of ['gifts', 'prices']) {
    const item = get(checkedRows(oldFields, cached), id);
    assert.equal(item.checkPresentation?.tone, 'fresh');
    assert.equal(item.checkPresentation?.checkedAt, when(15 * 60000));
    assert.equal(item.updatedAt, when(86400000));
  }
  const absentFields = dashboard([gift('1', { status_observed_at: null, status_checked_at: null,
    price_per_day: null, price_observed_at: null, price_checked_at: null })]);
  const actual = refresh({ updated: 0, unresolved: 1, status_updated: 0, status_unresolved: 1 });
  for (const id of ['gifts', 'prices']) {
    const item = get(checkedRows(absentFields, actual), id);
    assert.equal(item.checkPresentation?.tone, 'fresh');
    assert.equal(item.state, 'missing');
    assert.equal(item.updatedAt, null);
    assert.equal(item.availabilityWarning, true);
  }
});

test('a completed check is fenced to the exact NFT and collection identities, including same-count replacements', () => {
  const original = dashboard(), completed = refresh();
  assert.equal(get(checkedRows(original, completed), 'gifts').checkPresentation?.tone, 'fresh');
  for (const changed of [dashboard([gift('2')]), dashboard([gift('1', { collection_address: address('b') })]),
    dashboard([gift('1', { collection_conflict: true })]),
    dashboard([gift(), gift('1', { collection_address: address('b') })])]) {
    for (const id of ['gifts', 'prices']) {
      const item = get(checkedRows(changed, completed), id);
      assert.equal(item.checkPresentation?.tone, 'older');
      assert.equal(item.checkPresentation?.status, 'Check not confirmed');
    }
  }
  for (const signature of [undefined, null, 'b'.repeat(64)]) {
    for (const id of ['gifts', 'prices']) assert.equal(get(checkedRows(original, refresh({ scope_signature: signature })), id).checkPresentation?.tone, 'older');
  }
  const alias = dashboard([gift('1', { nft_address: friendlyMainnetAddress(address('1'))!,
    collection_address: friendlyMainnetAddress(address('a'))! }), gift()]);
  alias.wallet = friendlyMainnetAddress(address('f'))!;
  for (const id of ['gifts', 'prices']) assert.equal(get(checkedRows(alias, completed), id).checkPresentation?.tone, 'fresh');
  const cached = refresh({ check_started_at: completed.run!.started_at }, { cacheHit: true });
  assert.equal(get(checkedRows(dashboard([gift('2')]), cached), 'gifts').checkPresentation?.tone, 'older');
});

test('failed, paused, malformed and future checks stay orange independently of fresh saved values', () => {
  for (const snapshot of [refresh({ state: 'failed', reason: 'retry_exhausted' }, { phase: 'unavailable' }),
    refresh({ state: 'partial', reason: 'duration_limit' }, { phase: 'partial' }),
    refresh({ completed_at: when(-1) }), refresh({ started_at: when(-1) }),
    refresh({ started_at: '2026-02-30T12:00:00Z' }), refresh({ wallet: address('a') }),
    refresh({ checked: 2 }), refresh({}, { phase: 'unavailable', error: 'Gift check unavailable.' })]) {
    for (const id of ['gifts', 'prices']) {
      const item = get(checkedRows(dashboard(), snapshot), id);
      assert.equal(item.checkPresentation?.tone, 'older');
      assert.notEqual(item.checkPresentation?.status, 'Checked');
      assert.equal(item.state, 'fresh', 'failure cannot rewrite saved successful values');
    }
  }
  for (const timestamp of [when(-1), 'invalid', '2026-02-30T12:00:00Z']) {
    const future = dashboard([gift('1', { status_checked_at: timestamp, price_checked_at: timestamp })]);
    for (const id of ['gifts', 'prices']) {
      const item = get(checkedRows(future, refresh({}, { cacheHit: true })), id);
      assert.equal(item.checkPresentation?.tone, 'older');
      assert.equal(item.checkPresentation?.checkedAt, null);
    }
  }
  for (const timestamp of [when(-1), 'invalid', '2026-02-30T12:00:00Z', when(30000), null]) {
    for (const id of ['gifts', 'prices']) {
      const item = get(checkedRows(dashboard(), refresh({ check_started_at: timestamp }, { cacheHit: true })), id);
      assert.equal(item.checkPresentation?.tone, 'older', 'an invalid or newer-than-lifecycle cache source clock fails closed');
      assert.equal(item.checkPresentation?.checkedAt, null);
    }
  }
});

test('verified expired status and current source evidence are fresh despite a retained review category', () => {
  const data = dashboard([gift('1', { state: 'expired_pending_return', ui_state: null, category: 'unresolved' })]);
  const rows = present(data);
  assert.equal(get(rows, 'gifts').tone, 'fresh', 'a verified expired state is known current status');
  assert.equal(get(rows, 'prices').tone, 'fresh', 'a review label is separate from an observed current price');
  assert.equal(data.gifts[0].category, 'unresolved', 'no enrollment or action eligibility changes');
});

test('failed price and status checks show their attempted check dates without fresh successful values', () => {
  const unknown = gift('1', { state: 'unknown', ui_state: null, status_is_historical: true,
    status_observed_at: when(), status_checked_at: when(), price_per_day: null,
    price_is_historical: true, price_observed_at: when(3600000), price_checked_at: when() });
  const rows = present(dashboard([unknown]));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).checkStatus, 'Check complete · 1/1 checked');
    assert.equal(get(rows, id).checkedAt, when());
    assert.equal(get(rows, id).updatedAt, null);
    assert.equal(get(rows, id).tone, 'older');
  }
});

test('a directly held gift can finish checking while having no rental price to display', () => {
  const rows = checkedRows(dashboard([gift('1', { state: 'held_directly', ui_state: null,
    price_per_day: null, price_source: null, price_observed_at: null, price_checked_at: when() })]),
    refresh({ updated: 0, unresolved: 1 }));
  assert.equal(get(rows, 'gifts').tone, 'fresh');
  assert.equal(get(rows, 'prices').checkStatus, 'Check complete · 1/1 checked');
  assert.equal(get(rows, 'prices').coverage, '0 prices available · 1 unavailable');
  assert.equal(get(rows, 'prices').tone, 'older');
});

test('check summaries require matching wallet, complete portfolio scope and bounded validated counts', () => {
  const data = dashboard([gift('1', { status_checked_at: null, status_observed_at: null, price_checked_at: null, price_observed_at: null })]);
  for (const changes of [{ wallet: address('a') }, { scope: 'gift' as const }, { total: 2 }, { checked: 2 },
    { updated: 2 }, { unresolved: 1 }, { status_unresolved: 1 }, { completed_at: when(-1) },
    { started_at: when(-1) }, { completed_at: when(120000) }]) {
    const rows = checkedRows(data, refresh(changes));
    assert.equal(get(rows, 'prices').checkStatus, null);
    assert.equal(get(rows, 'prices').checkedAt, null);
  }
  const aliases = checkedRows(data, refresh({ wallet: friendlyMainnetAddress(address('f')) }));
  assert.equal(get(aliases, 'prices').checkStatus, 'Check complete · 1/1 checked');
  const tonSubset = checkedRows(dashboard([gift(), gift('2')]), refresh({ total: 1 }));
  assert.equal(get(tonSubset, 'gifts').checkStatus, 'Check complete · 2/2 checked', 'a subset cannot replace per-gift portfolio coverage');
});

test('an unfinished or paused run with every target seen is not a completed check', () => {
  const running = refresh({ state: 'running', completed_at: null }, { phase: 'checking', canStop: true });
  assert.equal(get(checkedRows(dashboard(), running), 'gifts').checkStatus, 'Checking · 1/1 checked');
  assert.equal(get(checkedRows(dashboard(), { ...running, phase: 'partial' }), 'gifts').checkStatus, 'Check paused · 1/1 checked');
  const stopped = refresh({ state: 'partial', checked: 0, updated: 0, status_updated: 0, reason: 'stopped_by_you' }, { phase: 'partial' });
  assert.equal(get(checkedRows(dashboard(), stopped), 'prices').checkStatus, 'Check paused · 0/1 checked');
});

test('cache reuse retains original per-gift check dates instead of its new completion timestamp', () => {
  const data = dashboard([gift('1', { status_observed_at: when(3600000), status_checked_at: when(3590000),
    price_observed_at: when(3600000), price_checked_at: when(3590000) })]);
  const rows = checkedRows(data, refresh({}, { cacheHit: true }));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).checkStatus, 'Check complete · 1/1 checked');
    assert.equal(get(rows, id).checkedAt, when(3590000));
    assert.equal(get(rows, id).updatedAt, when(3600000));
    assert.equal(get(rows, id).tone, 'older');
  }
  const missing = checkedRows(dashboard([gift('1', { status_checked_at: null, status_observed_at: null,
    price_checked_at: null, price_observed_at: null })]), refresh({}, { cacheHit: true }));
  assert.equal(get(missing, 'prices').checkedAt, null, 'no fake original check time');
});

test('a failed startup without a run is visible beside nine-hour-old screenshot coverage', () => {
  const age = 9 * 3600000;
  const gifts = Array.from({ length: 161 }, (_, index) => gift('1', {
    id: `gift-${index}`, nft_address: `0:${index.toString(16).padStart(64, '0')}`,
    status_observed_at: when(age), status_checked_at: when(age),
    price_observed_at: when(age), price_checked_at: when(age),
    ...(index < 112 ? {} : { state: 'unknown', ui_state: null, status_is_historical: true }),
    ...(index < 88 ? {} : { price_per_day: null, price_is_historical: true }),
  }));
  const rows = checkedRows(dashboard(gifts), { phase: 'unavailable', run: null, canStop: false, canRefresh: true,
    error: 'Rent prices could not be checked. Saved prices kept.' });
  assert.equal(get(rows, 'gifts').coverage, '112 statuses confirmed · 49 unverified');
  assert.equal(get(rows, 'prices').coverage, '88 prices available · 73 unavailable');
  for (const id of ['gifts', 'prices']) {
    const item = get(rows, id);
    assert.deepEqual(item.checkPresentation, { tone: 'older', status: 'Check failed', checkedAt: null });
    assert.equal(item.updatedAt, when(age), 'a failed new attempt never advances successful observations');
    assert.equal(item.checkedAt, when(age), 'prior attempts remain dated independently');
    assert.equal(item.checkStatus, 'Saved check coverage · 161/161 checked');
    assert.match(item.refreshFailure!, /latest gift refresh could not finish/);
    assert.equal(item.state, 'incomplete');
  }
});

test('a busy refresh keeps saved data freshness and never marks either gift row as failed', () => {
  for (const age of [0, 9 * 3600000]) {
    const data = dashboard([gift('1', { status_observed_at: when(age), status_checked_at: when(age),
      price_observed_at: when(age), price_checked_at: when(age) })]);
    const baseline = activityFreshnessRows(data, [], { now });
    for (const snapshot of [{ phase: 'waiting' as const, run: null, canStop: false, canRefresh: true },
      refresh({ state: 'running', checked: 1, updated: 1, total: 1 }, { phase: 'waiting', error: null })]) {
      const rows = checkedRows(data, snapshot);
      for (const id of ['gifts', 'prices']) {
        assert.deepEqual(get(rows, id), get(baseline, id));
        assert.equal(get(rows, id).updatedAt, when(age));
        assert.equal(get(rows, id).refreshFailure, undefined);
      }
    }
  }
  const empty = dashboard([gift('1', { status_observed_at: null, status_checked_at: null,
    price_per_day: null, price_observed_at: null, price_checked_at: null })]);
  for (const row of checkedRows(empty, { phase: 'waiting', run: null, canStop: false, canRefresh: true })) {
    if (!['gifts', 'prices'].includes(row.id)) continue;
    assert.equal(row.state, 'missing'); assert.equal(row.updatedAt, null); assert.equal(row.refreshFailure, undefined);
  }
});

test('a failed startup with no saved values cannot invent an earlier successful check or update', () => {
  const empty = dashboard([gift('1', { status_observed_at: null, status_checked_at: null,
    price_per_day: null, price_observed_at: null, price_checked_at: null })]);
  const rows = checkedRows(empty, { phase: 'unavailable', run: null, canStop: false, canRefresh: true });
  for (const id of ['gifts', 'prices']) {
    const item = get(rows, id);
    assert.equal(item.checkPresentation?.status, 'Check failed');
    assert.equal(item.updatedAt, null); assert.equal(item.checkedAt, null); assert.equal(item.checkStatus, null);
    assert.ok(item.refreshFailure); assert.equal(item.state, 'missing');
  }
});

test('failed and legacy portfolio runs expose fixed actionable diagnostics without provider text', () => {
  const diagnostics = ['Updates paused because app storage is full. Saved prices are kept.',
    'Another gift check is still finishing. Wait for it or stop it in Status, then try again.'];
  for (const error of diagnostics) {
    for (const scope of ['portfolio', undefined] as const) {
      const snapshot = refresh({ scope, state: 'failed', reason: 'Private cookie provider body' }, { phase: 'unavailable', error });
      for (const id of ['gifts', 'prices']) {
        const item = get(checkedRows(dashboard(), snapshot), id);
        assert.equal(item.refreshFailure, error); assert.equal(item.checkPresentation?.tone, 'older');
        assert.equal(item.updatedAt, when(), 'existing successful source dates survive the failure');
        assert.equal(JSON.stringify(item).includes('Private cookie'), false);
      }
    }
  }
  const unknown = refresh({ state: 'failed', reason: 'Private cookie provider body' }, { phase: 'unavailable', error: 'Private cookie provider body' });
  for (const item of checkedRows(dashboard(), unknown)) assert.equal(JSON.stringify(item).includes('Private cookie'), false);
});

test('an individual gift failure does not label the entire portfolio refresh as failed', () => {
  const rows = checkedRows(dashboard([gift(), gift('2')]), refresh({ scope: 'gift', state: 'failed', reason: 'retry_exhausted' },
    { phase: 'unavailable', error: 'This gift could not be checked.' }));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(rows, id).refreshFailure, undefined);
    assert.equal(get(rows, id).checkPresentation, undefined);
  }
  const noRun = checkedRows(dashboard([gift(), gift('2')]), { scope: 'gift', phase: 'unavailable', run: null,
    canStop: false, canRefresh: true, error: 'Updates paused because app storage is full. Saved prices are kept.' });
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(noRun, id).refreshFailure, undefined);
    assert.equal(get(noRun, id).checkPresentation, undefined);
  }
});

test('a later successful scoped refresh clears the transient failure without changing retained value dates', () => {
  const old = dashboard([gift('1', { status_observed_at: when(9 * 3600000), status_checked_at: when(9 * 3600000),
    price_observed_at: when(9 * 3600000), price_checked_at: when(9 * 3600000) })]);
  const failed = checkedRows(old, { phase: 'unavailable', run: null, canStop: false, canRefresh: true });
  const successful = checkedRows(old, refresh({ scope_signature: scopeSignature(old) }));
  for (const id of ['gifts', 'prices']) {
    assert.equal(get(failed, id).checkPresentation?.status, 'Check failed');
    assert.equal(get(successful, id).refreshFailure, undefined);
    assert.equal(get(successful, id).checkPresentation?.tone, 'fresh');
    assert.equal(get(successful, id).checkPresentation?.status, 'Checked');
    assert.equal(get(successful, id).updatedAt, when(9 * 3600000));
    assert.equal(get(successful, id).state, 'older', 'successful checks do not renew retained numeric/status evidence');
  }
});

function savedHistory(changes: Partial<PersonalRentalAnalyticsAllTime> = {}): PersonalRentalAnalyticsAllTime {
  const source = report();
  return { ...source, source_url: null, report_kind: 'all_time', fingerprint: 'saved-history',
    daily: source.daily.map(point => ({ ...point, captured_at: source.captured_at, partial: point.date === source.period_end })),
    coverage: { observed_days: 30, missing_days: 0, partial_days: 1 }, ...changes };
}

test('Status exposes a failed automatic analytics refresh without changing the saved capture date', () => {
  const data = dashboard([], { personal_analytics: report(30, 60000), personal_analytics_snapshots: [report(365, 60000)],
    personal_analytics_all_time: savedHistory({ captured_at: when(60000) }) });
  const rows = activityFreshnessRows(data, [], { now, analyticsStartup: {
    phase: 'unavailable', periodDays: 30, busy: false, reason: 'refresh_failed', outcomeAt: when(),
  } });
  for (const id of ['analytics-30', 'analytics-all_time']) {
    const item = get(rows, id);
    assert.equal(item.status, 'Refresh failed'); assert.equal(item.tone, 'older'); assert.equal(item.updating, false);
    assert.equal(item.updatedAt, when(60000)); assert.match(item.refreshNotice!.message, /Automatic refresh did not finish/);
    assert.equal(item.refreshNotice?.tone, 'error');
  }
  assert.equal(get(rows, 'analytics-365').status, 'Fresh');
  assert.equal(get(rows, 'analytics-365').refreshNotice, undefined);
  const recovered = activityFreshnessRows({ ...data, personal_analytics: report() }, [], { now, analyticsStartup: {
    phase: 'unavailable', periodDays: 30, busy: false, reason: 'refresh_failed', outcomeAt: when(30000),
  } });
  assert.equal(get(recovered, 'analytics-30').status, 'Fresh');
  assert.equal(get(recovered, 'analytics-30').refreshNotice, undefined);
});

test('analytics pauses, connection requirements and storage failures have explicit Status messages', () => {
  const data = dashboard([], { personal_analytics: report(30, 60000) });
  for (const [snapshot, label, message] of [
    [{ phase: 'limited', reason: 'request_limit' }, 'Paused', /paused/],
    [{ phase: 'busy', reason: 'active_refresh' }, 'Waiting', /Another refresh/],
    [{ phase: 'unavailable', reason: 'no_login' }, 'Login required', /Connect Marketapp/],
    [{ phase: 'unavailable', reason: 'wallet_missing' }, 'Wallet required', /wallet/],
    [{ phase: 'unavailable', reason: 'refresh_failed', storagePaused: true }, 'Refresh failed', /Clean up storage/],
  ] as const) {
    const rows = activityFreshnessRows(data, [], { now, analyticsStartup: { ...snapshot, periodDays: 30, busy: false, outcomeAt: when() } });
    for (const id of ['analytics-30', 'analytics-all_time']) {
      const item = get(rows, id);
      assert.equal(item.status, label); assert.equal(item.tone, 'older'); assert.equal(item.updating, false);
      assert.match(item.refreshNotice!.message, message);
    }
  }
});

test('All time appears with archive-only data, explicit gaps and a typed View selection', () => {
  const full = savedHistory(), history = savedHistory({ daily: full.daily.filter((_, i) => i !== 10),
    coverage: { observed_days: 29, missing_days: 1, partial_days: 1 } });
  const item = get(activityFreshnessRows(dashboard([], { personal_analytics_all_time: history }), [], { now }), 'analytics-all_time');
  assert.equal(item.analyticsSelection, 'all_time'); assert.equal(item.status, 'Gaps in history');
  assert.equal(item.state, 'incomplete'); assert.equal(item.updatedAt, when());
  assert.equal(item.coverage, '29 days saved · 1 day missing · 1 partial day');
  assert.match(item.detail, /Missing days are unknown, not zero/);
  assert.match(item.detail, /keeps earlier saved days/);
  const malformed = savedHistory({ coverage: { observed_days: 31, missing_days: 0, partial_days: 1 } });
  const invalid = get(activityFreshnessRows(dashboard([], { personal_analytics_all_time: malformed }), [], { now }), 'analytics-all_time');
  assert.equal(invalid.status, 'Coverage unavailable'); assert.equal(invalid.updatedAt, null);
  const foreign = get(activityFreshnessRows(dashboard([], { personal_analytics_all_time: savedHistory({ wallet: address('e') }) }), [], { now }), 'analytics-all_time');
  assert.equal(foreign.coverage, 'No saved history'); assert.equal(foreign.updatedAt, null);
});

test('active analytics without a saved report appears in Status and updates All time too', () => {
  const rows = activityFreshnessRows(dashboard(), [], { now, analyticsStartup: { phase: 'updating', periodDays: 365, busy: true } });
  assert.equal(get(rows, 'analytics-365').updating, true); assert.equal(get(rows, 'analytics-365').analyticsSelection, 365);
  assert.equal(get(rows, 'analytics-all_time').updating, true);
  assert.equal(get(rows, 'analytics-30').updating, false);
});

test('All time reload failure clears only after a successful full read following that refresh', () => {
  const data = dashboard([], { personal_analytics_all_time: savedHistory() });
  const analyticsStartup = { phase: 'saved' as const, periodDays: 30 as const, busy: false,
    capturedAt: when(60000), outcomeAt: when(30000), reloadFailed: true };
  const before = get(activityFreshnessRows(data, [], { now, analyticsStartup, analyticsReloadedAt: when(60000) }), 'analytics-all_time');
  assert.equal(before.status, 'Reload needed'); assert.match(before.refreshNotice!.message, /Reload saved data/);
  const after = get(activityFreshnessRows(data, [], { now, analyticsStartup, analyticsReloadedAt: when() }), 'analytics-all_time');
  assert.equal(after.status, 'Saved history'); assert.equal(after.refreshNotice, undefined);
  assert.equal(after.updatedAt, before.updatedAt);
});

test('a newer successful analytics capture clears obsolete startup connection and pause notices', () => {
  const older = dashboard([], { personal_analytics: report(30, 60000), personal_analytics_all_time: savedHistory({ captured_at: when(60000) }) });
  const newer = dashboard([], { personal_analytics: report(), personal_analytics_all_time: savedHistory() });
  for (const result of [{ phase: 'unavailable', reason: 'no_login' }, { phase: 'limited', reason: 'request_limit' },
    { phase: 'busy', reason: 'active_refresh' }] as const) {
    const options = { now, analyticsStartup: { ...result, periodDays: 30 as const, busy: false, outcomeAt: when(30000) } };
    for (const id of ['analytics-30', 'analytics-all_time']) {
      assert.ok(get(activityFreshnessRows(older, [], options), id).refreshNotice);
      const after = get(activityFreshnessRows(newer, [], options), id);
      assert.equal(after.refreshNotice, undefined);
      assert.equal(after.status, id === 'analytics-30' ? 'Fresh' : 'Saved history');
    }
  }
});
