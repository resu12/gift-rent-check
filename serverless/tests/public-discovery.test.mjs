import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDiscoveryEngine} from '../tgcloud/lib/public-discovery.js';
import {DECODER_VERSION, MARKETAPP_OPERATOR, SUPPORTED_CODE_HASH} from '../tgcloud/lib/ton-price-decoder.js';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {discoveryJson, parseDiscoveryTon} from '../tgcloud/lib/public-discovery-models.js';
import {streamedBody} from './fixtures/http-response.mjs';
import {portableModules} from './fixtures/portable-modules.mjs';

const copy = value => JSON.parse(JSON.stringify(value)), address = n => `0:${n.toString(16).padStart(64, '0')}`;
const wallet = address(1), collection = address(2), nft = address(3), holder = address(4), ctx = {initData: {user: {id: 12345}}};
const catalog = [{address: collection, name: 'Test gifts', extra_data: {}}];
const item = (extra = {}) => ({address: nft, owner_address: wallet, collection_address: collection, init: true, last_transaction_lt: '100', content: {name: 'Gift', image: 'https://images.example/gift.png', attributes: [{trait_type: 'Model', value: 'Model A'}, {trait_type: 'Backdrop', value: 'Black'}]}, ...extra});
const decoded = (extra = {}) => ({verified: true, reason: 'verified_rental_owner', owner: wallet, nft, holding_contract: holder, marketplace: MARKETAPP_OPERATOR, code_hash: SUPPORTED_CODE_HASH, data_hash: 'ab'.repeat(32), code_hash_verified: true, data_hash_verified: true, decoder_version: DECODER_VERSION, account_last_transaction_lt: '99', rental_state: 'idle_rental_contract', role: 0, status: 0, renter: null, counterpart: null, rental_until: 0, rental_duration: 0, configured_price_per_day_raw: '170000000', ...extra});
const response = (document, status = 200, retryAfter = null) => ({status, headers: {get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null}, body: streamedBody(typeof document === 'string' ? document : JSON.stringify(document))});
const nfts = rows => response({nft_items: rows}), transfers = rows => response({nft_transfers: rows}), accounts = rows => response({accounts: rows});

function setup(responses = [], options = {}) {
  let time = Date.parse('2026-10-10T12:00:00Z'), revision = 0, state = {version: 2, next_job_id: 1, job: null, attempts: [], next_allowed_at: 0}, conflict = false;
  const events = [], requests = [], jobs = new Map();
  const settings = {kind: 'settings', key: 'verified-wallet', observed_at: new Date(time).toISOString(), record: {wallet, wallet_verification: 'ton_proof', wallet_verified_at: new Date(time).toISOString()}};
  const seed = [settings, ...(options.seed || [])];
  const repository = {
    clock: async () => time,
    async read() {return {revision, state: copy(state)};},
    async append(expected, event) {if (conflict) {conflict = false; return false;} if (expected !== revision) return false; state = copy(event.state); events.push(copy(event)); revision++; if (event.job) jobs.set(event.job.id, copy(event.job)); return true;},
    async records() {return copy([...seed, ...events.flatMap(event => event.records)]);},
    async analyticsWalletRecords() {return (await repository.records()).filter(row => row.kind === 'settings');},
    async jobs() {return copy([...jobs.values()]);},
  };
  const deps = {repository, enabled: true, ownerTelegramId: 12345, marketappToken: 'synthetic-user-api-key', decodeContract: () => decoded(), fetch: async (url, opts) => {
    requests.push({url, opts}); const next = responses.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return await next(url, opts); if (!next) throw new Error('Missing synthetic response'); return next;
  }, ...options};
  return {engine: (options.engineFactory || createPublicDiscoveryEngine)(deps), repository, requests, events, settings: settings.record, now: () => time, advance: ms => time += ms,
    state: () => copy(state), conflict: () => conflict = true, alter: change => {change(state);}, deps};
}
const start = async t => (await t.engine.startJob(ctx, {kind: 'discover'})).job;
const step = async t => {t.advance(1000); return (await t.engine.stepJob(ctx, {job_id: t.state().job.id})).job;};
async function complete(t, limit = 30) {for (let i = 0; i < limit && t.state().job.state === 'running'; i++) await step(t); return t.state().job;}

test('discovery is opt-in and authorizes before any clock, storage or provider access', async () => {
  let touches = 0;
  const repository = new Proxy({}, {get() {touches++; return async () => {};}});
  for (const enabled of [false, true]) {
    const engine = createPublicDiscoveryEngine({repository, ownerTelegramId: 12345, enabled, fetch: async () => {touches++;}});
    for (const method of ['startJob', 'stepJob', 'resumeJob', 'stopJob', 'getJobs']) for (const context of [{}, {initData: {user: {id: 987}}}, ...(!enabled ? [ctx] : [])]) await assert.rejects(engine[method](context, {}), /PUBLIC_ACCESS_DENIED/);
  }
  assert.equal(touches, 0);
});

test('start requires verified mainnet wallet and user API key, freezes bounded settings without HTTP', async () => {
  const t = setup(); const first = await start(t);
  assert.equal(first.kind, 'discover'); assert.equal(t.requests.length, 0); assert.equal(t.state().job.wallet, wallet); assert.equal(t.state().job.decoder_version, DECODER_VERSION);
  assert.equal((await start(t)).id, first.id);
  for (const verification of [null, 'address_only']) {const bad = setup(); bad.settings.wallet_verification = verification; await assert.rejects(start(bad), /PUBLIC_WALLET_REQUIRED/); assert.equal(bad.requests.length, 0);}
  await assert.rejects(start(setup([], {marketappToken: ''})), /PUBLIC_KEY_REQUIRED/);
  t.alter(state => {state.job.kind = 'prices';}); await assert.rejects(start(t), /ACTIVE_JOB/);
});

test('direct holdings require exact collection, owner and stable logical time before atomic enrollment', async () => {
  const t = setup([response(catalog), nfts([item()]), nfts([item()]), nfts([item()]), transfers([]), nfts([])]);
  await start(t); await step(t); await step(t); await step(t);
  assert.equal((await t.repository.records()).filter(row => row.kind === 'portfolio').length, 0);
  const done = await complete(t); assert.equal(done.state, 'complete'); assert.equal(done.enumeration_complete, true);
  const rows = await t.repository.records(), gift = rows.find(row => row.kind === 'portfolio').record;
  assert.equal(gift.is_portfolio, true); assert.equal(gift.state, 'held_directly'); assert.deepEqual(gift.membership_sources, ['verified_ton']);
  const dashboard = buildCloudDashboard(rows, {}, {now: t.now()});
  assert.equal(dashboard.summary.portfolio_count, 1); assert.equal(dashboard.summary.direct_count, 1); assert.equal(dashboard.gifts[0].status_is_historical, false);
  assert.equal(dashboard.gifts[0].model, 'Model A'); assert.equal(dashboard.gifts[0].backdrop, 'Black');
  assert.equal(t.requests.length, 6);
  for (const request of t.requests) {assert.equal(request.opts.method, 'GET'); assert.equal(request.opts.redirect, 'error'); assert.equal(request.opts.timeout, 20000);
    const url = new URL(request.url); assert.ok(['https://toncenter.com', 'https://api.marketapp.org'].includes(url.origin));
    if (url.origin.includes('marketapp')) assert.equal(request.opts.headers.Authorization, 'synthetic-user-api-key'); else assert.equal(request.opts.headers.Authorization, undefined);}
});

test('supported rental contracts enroll only after holder/LT recheck and retain exact configured price', async () => {
  const held = item({owner_address: holder});
  const t = setup([response(catalog), nfts([held]), nfts([held]), accounts([{address: holder, status: 'active', code_boc: 'not-in-checkpoint', data_boc: 'not-in-checkpoint'}]), nfts([held]), transfers([]), nfts([])]);
  await start(t); await complete(t);
  assert.equal(t.state().job.state, 'complete'); assert.equal(JSON.stringify(t.state()).includes('not-in-checkpoint'), false);
  const rows = await t.repository.records(), price = rows.find(row => row.kind === 'owned_price');
  assert.equal(price.record.configured_price_per_day_raw, '170000000'); assert.equal(price.observed_at, price.record.contract_observed_at);
  assert.ok(Date.parse(price.observed_at) < Date.parse(price.record.rechecked_at));
  const dashboard = buildCloudDashboard(rows, {}, {now: t.now()});
  assert.equal(dashboard.summary.portfolio_count, 1); assert.equal(dashboard.summary.idle_count, 1); assert.equal(dashboard.summary.for_rent_count, 0);
  assert.equal(dashboard.gifts[0].price_per_day, '0.17'); assert.equal(dashboard.gifts[0].status_is_historical, false);
});

test('changed holder or logical time, unsupported contracts and conflicting collections stay unresolved', async () => {
  for (const variant of ['holder', 'lt', 'contract', 'collection']) {
    const held = item({owner_address: holder}), after = variant === 'holder' ? {...held, owner_address: address(7)} : variant === 'lt' ? {...held, last_transaction_lt: '101'} : held;
    const initial = variant === 'collection' ? {...held, collection: {address: address(8)}} : held;
    const responses = variant === 'collection' ? [response(catalog), nfts([initial]), nfts([held]), transfers([]), nfts([])] : [response(catalog), nfts([held]), nfts([held]), accounts([{address: holder, status: 'active'}]), nfts([after]), transfers([]), nfts([])];
    const t = setup(responses, {decodeContract: () => decoded(variant === 'contract' ? {code_hash: '00'.repeat(32)} : {})});
    await start(t); await complete(t); const gifts = (await t.repository.records()).filter(row => row.kind === 'portfolio');
    assert.equal(t.state().job.state, 'complete', variant); assert.equal(gifts.length, 1); assert.equal(gifts[0].record.is_portfolio, false, variant);
    assert.equal(gifts[0].record.status_is_historical, true, variant); assert.equal((await t.repository.records()).some(row => row.kind === 'owned_price'), false);
  }
});

test('inbound/outbound transfer ties preserve uint64 boundaries and do not treat historical transfer as ownership', async () => {
  const lt = '18446744073709551614';
  const transfer = (id, extra = {}) => ({nft_address: id, old_owner: wallet, new_owner: address(8), nft_collection: collection, transaction_lt: lt, transaction_aborted: false, ...extra});
  const t = setup([response(catalog), nfts([]), transfers([transfer(nft), transfer(address(5), {old_owner: address(8), new_owner: wallet})]), nfts([]), transfers([transfer(address(6)), transfer(address(9), {transaction_aborted: true})]), nfts([]), transfers([])]);
  await start(t); await complete(t); assert.equal(t.state().job.state, 'complete');
  const requests = t.requests.filter(row => new URL(row.url).pathname === '/api/v3/nft/transfers').map(row => new URL(row.url));
  assert.equal(requests[0].searchParams.get('offset'), '0'); assert.equal(requests[1].searchParams.get('end_lt'), lt); assert.equal(requests[1].searchParams.get('offset'), '2');
  assert.equal(requests[2].searchParams.get('offset'), '4'); assert.equal(t.state().job.enumeration.transfers.upper_lt, lt);
  assert.equal(Object.keys(t.state().job.candidates).length, 3);
  assert.equal((await t.repository.records()).filter(row => row.kind === 'portfolio' && row.record.is_portfolio).length, 0);
});

test('malformed/duplicate/out-of-order responses preserve cursor and retain bounded raw evidence', async () => {
  for (const bad of ['{"nft_items":[],"nft_items":[]}', {nft_items: [item(), item()]}, {nft_items: [item({address: 'invalid'})]}]) {
    const t = setup([response(catalog), response(bad)]); await start(t); await step(t); const cursor = t.state().job.enumeration.holdings.offset;
    assert.equal((await step(t)).state, 'failed'); assert.equal(t.state().job.reason, 'invalid_response'); assert.equal(t.state().job.enumeration.holdings.offset, cursor);
    assert.equal(Object.keys(t.state().job.candidates).length, 0); assert.ok(t.events.at(-1).raw_body);
  }
  const transfer = time => ({nft_address: nft, old_owner: wallet, new_owner: address(8), nft_collection: collection, transaction_lt: time, transaction_aborted: false});
  const t = setup([response(catalog), nfts([]), transfers([transfer('10'), transfer('11')])]); await start(t); await step(t); await step(t); await step(t);
  assert.equal(t.state().job.reason, 'invalid_response'); assert.equal(t.state().job.enumeration.transfers.end_lt, null);
  assert.throws(() => discoveryJson('{"a":1,"a":2}'));
  assert.equal(parseDiscoveryTon('{"nft_transfers":[{"nft_address":"'+nft+'","transaction_lt":18446744073709551614,"transaction_aborted":false}]}', 'nft_transfers', 1)[0].transaction_lt, '18446744073709551614');
});

test('candidate and portfolio caps pause visibly without advancing or claiming complete coverage', async () => {
  const candidates = setup([response(catalog), nfts([item(), item({address: address(5)})])], {limits: {max_candidates: 1}});
  await start(candidates); await step(candidates); const paused = await step(candidates);
  assert.equal(paused.reason, 'candidate_limit'); assert.equal(paused.resume_supported, false); assert.equal(candidates.state().job.enumeration.holdings.offset, 0); assert.equal(Object.keys(candidates.state().job.candidates).length, 0);
  await assert.rejects(candidates.engine.resumeJob(ctx, {job_id: paused.id}), /PUBLIC_DISCOVERY_NOT_RESUMABLE/);
  const items = [item(), item({address: address(5)})], gifts = setup([response(catalog), nfts(items), nfts(items), nfts(items)], {limits: {max_wallet_gifts: 1}});
  await start(gifts); await complete(gifts); assert.equal(gifts.state().job.reason, 'gift_limit'); assert.equal(gifts.state().job.portfolio_count, 0);
  assert.equal((await gifts.repository.records()).some(row => row.kind === 'portfolio'), false); assert.equal(gifts.state().job.enumeration_complete, false);
});

test('a repeated nonempty enumeration page cannot loop, duplicate enrollment or advance its cursor', async () => {
  const t = setup([response(catalog), nfts([item()]), nfts([item()]), nfts([item()]), transfers([]), nfts([item()])]);
  await start(t); await complete(t);
  assert.equal(t.state().job.state, 'failed'); assert.equal(t.state().job.reason, 'invalid_response');
  assert.equal(t.state().job.enumeration.holdings.offset, 1); assert.equal(t.state().job.enumeration.holdings.seen_pages.length, 1);
  assert.equal((await t.repository.records()).filter(row => row.kind === 'portfolio' && row.record.is_portfolio).length, 1);
  assert.ok(t.events.at(-1).raw_body); assert.equal(t.requests.length, 6);
});

test('the entire-run enumeration cap survives resume and stops before another provider request', async () => {
  const t = setup([response(catalog), nfts([item()]), nfts([item()]), nfts([item()]), transfers([]), nfts([])], {limits: {max_enumeration_pages: 2, invocation_attempts: 3}});
  await start(t); await complete(t); assert.equal(t.state().job.reason, 'invocation_limit');
  await t.engine.resumeJob(ctx, {job_id: t.state().job.id}); const result = await complete(t);
  assert.equal(result.state, 'partial'); assert.equal(result.reason, 'enumeration_page_limit'); assert.equal(result.enumeration_complete, false);
  assert.equal(result.pages, 2); assert.equal(result.max_enumeration_pages, 2); assert.equal(t.requests.length, 5);
  const projected = (await t.engine.getJobs(ctx)).jobs[0];
  assert.equal(projected.resume_supported, false); assert.equal(projected.progress.discovery_limits.max_enumeration_pages, 2);
  await assert.rejects(t.engine.resumeJob(ctx, {job_id: result.id}), /PUBLIC_DISCOVERY_NOT_RESUMABLE/);
});

test('discovery runs through the real module graph in bare V8 with SDK byte streams and no browser globals', async () => {
  const portable = portableModules(), module = portable.load('public-discovery.js'), bytes = portable.load('personal-analytics.js').utf8Bytes;
  assert.equal(portable.evaluate('[typeof URL,typeof URLSearchParams,typeof Buffer,typeof process,typeof require,typeof crypto,typeof setTimeout,typeof AbortController].join(",")'), Array(8).fill('undefined').join(','));
  const sdkResponse = document => ({status: 200, headers: {get: () => null}, body: {async *[Symbol.asyncIterator]() {yield bytes(JSON.stringify(document));}}});
  const t = setup([catalog, {nft_items: [item()]}, {nft_items: [item()]}, {nft_items: [item()]}, {nft_transfers: []}, {nft_items: []}].map(sdkResponse), {engineFactory: module.createPublicDiscoveryEngine});
  await start(t); await complete(t); assert.equal(t.state().job.state, 'complete'); assert.equal(t.state().job.verified, 1); assert.equal(t.requests.length, 6);
  assert.equal(new URL(t.requests[1].url).searchParams.get('owner_address'), wallet);
  const dashboard = portable.load('cloud-pricing.js').buildCloudDashboard(await t.repository.records(), {}, {now: t.now()});
  assert.equal(dashboard.summary.portfolio_count, 1); assert.equal(dashboard.summary.direct_count, 1);
});

test('resuming an invocation preserves frozen batch and traversal boundaries', async () => {
  const t = setup([response(catalog), nfts([item()]), nfts([item()]), nfts([item()]), transfers([]), nfts([])], {limits: {invocation_attempts: 3}});
  await start(t); await complete(t); assert.equal(t.state().job.reason, 'invocation_limit'); const frozen = copy(t.state().job);
  await t.engine.resumeJob(ctx, {job_id: frozen.id});
  assert.deepEqual(t.state().job.pending, frozen.pending); assert.deepEqual(t.state().job.enumeration, frozen.enumeration); assert.deepEqual(t.state().job.catalog, frozen.catalog);
  await complete(t); assert.equal(t.state().job.state, 'complete');
  t.alter(state => {state.job.state = 'partial'; state.job.decoder_version = 'different-decoder';});
  await assert.rejects(t.engine.resumeJob(ctx, {job_id: frozen.id}), /PUBLIC_DISCOVERY_DECODER_CHANGED/);
});

test('shared gate denial consumes no HTTP retry/attempt and leaves catalog/cursor unchanged', async () => {
  for (const reason of ['provider_wait', 'user_limit']) {
    const error = Object.assign(new Error('fixed'), {code: 'PUBLIC_PROVIDER_WAIT', reason, readyAt: Date.parse('2026-10-10T12:00:03Z')});
    const t = setup([error, response(catalog)]); await start(t); const job = await step(t);
    assert.equal(job.state, reason === 'provider_wait' ? 'running' : 'partial'); assert.equal(t.state().job.retry, 0); assert.equal(t.state().job.invocation_used, 0);
    assert.deepEqual(t.state().discovery_attempts, []); assert.deepEqual(t.state().job.catalog, []); assert.equal(t.state().job.stage, 'catalog');
    if (reason !== 'provider_wait') await t.engine.resumeJob(ctx, {job_id: job.id});
    t.advance(2000); await step(t); assert.equal(t.state().job.stage, 'holdings');
  }
});

test('one lease fences concurrent steps, stop fences late responses and CAS retry never refetches', async () => {
  let release; const pending = new Promise(resolve => release = resolve);
  const t = setup([() => pending]); await start(t); t.advance(1000); const first = t.engine.stepJob(ctx, {job_id: 1});
  while (!t.requests.length) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(t.engine.stepJob(ctx, {job_id: 1}), /LEASE_ACTIVE/); await t.engine.stopJob(ctx, {job_id: 1}); release(response(catalog)); await first;
  assert.equal(t.state().job.state, 'partial'); assert.equal(t.state().job.reason, 'stopped_by_you'); assert.deepEqual(t.state().job.catalog, []); assert.equal(t.requests.length, 1);
  const safe = setup([response(catalog)]); await start(safe); safe.conflict(); await step(safe); assert.equal(safe.requests.length, 1); assert.equal(safe.state().job.stage, 'holdings');
});

test('response bodies cannot persist the user API key and changing a wallet cannot relabel a run', async () => {
  const t = setup([response('synthetic-user-api-key', 401)]); await start(t); await step(t);
  assert.equal(JSON.stringify(t.events).includes('synthetic-user-api-key'), false); assert.equal(t.state().job.reason, 'authentication_failed');
  const changed = setup(); await start(changed); changed.settings.wallet = address(77);
  assert.equal((await step(changed)).reason, 'wallet_changed'); assert.equal(changed.requests.length, 0);
});
