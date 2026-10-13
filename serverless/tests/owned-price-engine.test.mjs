import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createOwnedPriceEngine, OWNED_PRICE_LIMITS, ownedPriceErrorResponse} from '../tgcloud/lib/owned-price-engine.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {SUPPORTED_CODE_HASH, MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';
import {streamedBody} from './fixtures/http-response.mjs';

const ctx = {initData: {user: {id: 12345}}};
const address = n => `0:${n.toString(16).padStart(64, '0')}`;
const wallet = address(1), nft = address(2), collection = address(3), holder = address(4);
const row = (n = nft, extra = {}) => ({kind: 'portfolio', key: n, observed_at: '2026-10-09T12:00:00Z', record: {nft_address: n, collection_address: collection, is_portfolio: true, ...extra}});
const response = (body, status = 200, retryAfter = null, extra = {}) => ({status, headers: {get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null}, body: streamedBody(typeof body === 'string' ? body : JSON.stringify(body)), ...extra});
const nftItem = (extra = {}) => ({address: nft, collection_address: collection, owner_address: holder, init: true, last_transaction_lt: '100', ...extra});
const accountItem = (extra = {}) => ({address: holder, status: 'active', last_transaction_lt: '99', code_boc: 'BOC-not-carried', data_boc: 'DATA-not-carried', ...extra});
const nftPage = (items = [nftItem()]) => response({nft_items: items});
const accountPage = (items = [accountItem()]) => response({accounts: items});
const decoded = (extra = {}) => ({verified: true, reason: 'verified_rental_owner', owner: wallet, nft, holding_contract: holder, marketplace: MARKETAPP_OPERATOR, code_hash: SUPPORTED_CODE_HASH, data_hash: 'b'.repeat(64), code_hash_verified: true, data_hash_verified: true, decoder_version: 'fixture-v1', account_last_transaction_lt: '99', configured_price_per_day_raw: '170000000', price_per_day_raw: '900000000', rental_state: 'idle_rental_contract', role: 0, status: 0, renter: null, counterpart: null, rental_until: 0, rental_duration: 0, ...extra});

function setup(responses = [], options = {}) {
  let time = Date.parse('2026-10-09T12:00:00Z'); const requests = [];
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL); CREATE TABLE collector_state(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)');
  database.exec('CREATE TABLE owned_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT NOT NULL,source_sequence INTEGER NOT NULL); CREATE TABLE owned_refresh_sessions(session_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,source_sequence INTEGER NOT NULL); CREATE TABLE owned_refresh_index(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL)');
  const db = {async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};}, async get(sql, params = {}) {return database.prepare(sql).get(params) || null;}, async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db);
  const deps = {repository, ownerTelegramId: 12345, now: () => time, decodeContract: () => decoded(), fetch: async (url, options) => {requests.push({url, options}); const next = responses.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(); if (!next) throw new Error('Missing mock response'); return next;}, ...options};
  const env = {engine: createOwnedPriceEngine(deps), deps, repository, database, db, requests, advance: ms => time += ms, now: () => time};
  env.seed = async (records = [row()], state = {}) => {
    const previous = await repository.read();
    await repository.append(previous.revision, {key: `seed:${previous.revision}`, state: {...previous.state, ...state}, job: null, records: [{kind: 'settings', record: {wallet}}, ...records], observed_at: new Date(time).toISOString()});
  };
  env.prices = async () => (await repository.records()).filter(record => record.kind === 'owned_price');
  env.statuses = async () => (await repository.records()).filter(record => record.kind === 'owned_status');
  return env;
}
const start = async (t, id = 'page-session-0001') => t.engine.start(ctx, {session_id: id});
const startGift = async (t, target = nft, id = 'single-gift-session-0001') => t.engine.start(ctx, {session_id: id, nft_address: target});
const step = async (t, id = 1) => t.engine.step(ctx, {run_id: id});
async function complete(t, count = 3) {let status; for (let i = 0; i < count; i++) {status = await step(t); t.advance(1000);} return status;}

test('single-gift check scopes every TON stage and preserves all other gift observations', async () => {
  const other = address(5), previous = {kind: 'owned_price', key: 'saved-other-price', observed_at: '2026-10-08T12:00:00Z', record: {nft_address: other, verified: true, configured_price_per_day_raw: '99000000'}};
  const t = setup([nftPage(), accountPage(), nftPage()]); await t.seed([row(), row(other), previous]);
  const started = await startGift(t, 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAu8e');
  assert.deepEqual({scope: started.run.scope, nft_address: started.run.nft_address, wallet: started.run.wallet, session_id: started.run.session_id, total: started.run.total}, {scope: 'gift', nft_address: nft, wallet, session_id: 'single-gift-session-0001', total: 1});
  const done = await complete(t); assert.equal(done.run.state, 'complete'); assert.equal(done.run.updated, 1); assert.equal(done.run.status_updated, 1);
  assert.deepEqual(t.requests.map(({url}) => new URL(url).searchParams.getAll('address')), [[nft], [holder], [nft]]);
  const prices = await t.prices(); assert.equal(prices.length, 2); assert.deepEqual(prices.find(saved => saved.key === previous.key).record, previous.record);
  assert.deepEqual((await t.statuses()).map(saved => saved.record.nft_address), [nft]);
  await t.repository.syncOwnedRefreshArchive(); assert.deepEqual(await t.repository.ownedRefreshRun(1), done.run);
  assert.deepEqual((await t.engine.getStatus(ctx, {session_id: started.run.session_id})).run, done.run);
});

test('trusted website fallback scopes only intersect existing eligible portfolio membership',async()=>{
  const other=address(5),foreign=address(99),previous={kind:'owned_price',key:'saved-other-price',observed_at:'2026-10-08T12:00:00Z',record:{nft_address:other,verified:true,configured_price_per_day_raw:'99000000'}};
  const t=setup([nftPage(),accountPage(),nftPage()],{targetAddresses:['EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAu8e',nft,foreign]});
  await t.seed([row(),row(other),row(address(7),{collection_conflict:true}),previous]);
  const started=await start(t,'website-fallback-subset');assert.equal(started.run.scope,'portfolio');assert.equal(started.run.total,1);
  assert.deepEqual((await t.repository.read()).state.owned_prices.run.targets.map(value=>value.nft_address),[nft]);
  const done=await complete(t);assert.equal(done.run.state,'complete');assert.equal(done.run.updated,1);assert.equal(done.run.status_updated,1);
  assert.deepEqual(t.requests.map(({url})=>new URL(url).searchParams.getAll('address')),[[nft],[holder],[nft]]);
  assert.deepEqual((await t.prices()).find(value=>value.key===previous.key).record,previous.record);
  assert.deepEqual((await t.statuses()).map(value=>value.record.nft_address),[nft]);t.database.close();
});

test('empty fallback scopes and unknown NFT targets cannot create membership or send TON requests',async()=>{
  for(const targets of [[],[address(99)]]){
    const t=setup([],{targetAddresses:targets});await t.seed([row(),row(address(5))]);
    const started=await start(t,'website-empty-subset');assert.equal(started.run.total,0);assert.equal(started.run.state,'complete');assert.equal(t.requests.length,0);
    assert.deepEqual((await t.repository.records()).filter(value=>value.kind==='portfolio').map(value=>value.record.nft_address),[nft,address(5)]);t.database.close();
  }
});

test('an explicit gift check cannot expand the trusted internal fallback scope',async()=>{
  const t=setup([],{targetAddresses:[nft]});await t.seed([row(),row(address(5))]);const previous=await t.repository.read();
  await assert.rejects(startGift(t,address(5),'outside-fallback-subset'),error=>error.code==='OWNED_PRICE_INVALID_TARGET');
  assert.deepEqual(await t.repository.read(),previous);assert.equal(t.requests.length,0);t.database.close();
});

test('a narrowed fallback cannot join an active portfolio check that includes other gifts',async()=>{
  const t=setup();await t.seed([row(),row(address(5))]);const original=await start(t,'original-full-portfolio');assert.equal(original.run.total,2);
  const selected=createOwnedPriceEngine({...t.deps,targetAddresses:[nft]}),saved=await t.repository.read();
  await assert.rejects(selected.start(ctx,{session_id:'website-fallback-subset'}),error=>error.code==='OWNED_PRICE_BUSY');
  assert.deepEqual(await t.repository.read(),saved);assert.equal(t.requests.length,0);t.database.close();
});

test('permanent session replay cannot expand a narrowed fallback to an older full-portfolio check',async()=>{
  const t=setup();await t.seed([row(),row(address(5))]);await start(t,'older-full-portfolio');
  const selected=createOwnedPriceEngine({...t.deps,targetAddresses:[nft]}),saved=await t.repository.read();
  await assert.rejects(selected.start(ctx,{session_id:'older-full-portfolio'}),error=>error.code==='OWNED_PRICE_SCOPE_CHANGED');
  assert.deepEqual(await t.repository.read(),saved);assert.equal(t.requests.length,0);t.database.close();
});

test('an active website gift refresh excludes both targeted and portfolio TON refresh starts',async()=>{
  const t=setup();await t.seed([row()],{gift_refresh:{run:{id:1,state:'running',stage:'website',provider:'marketapp_website',deadline:t.now()+120000}}});const saved=await t.repository.read();
  await assert.rejects(start(t,'ton-during-website'),error=>error.code==='OWNED_PRICE_BUSY');
  await assert.rejects(startGift(t,nft,'gift-during-website'),error=>error.code==='OWNED_PRICE_BUSY');
  assert.deepEqual(await t.repository.read(),saved);assert.equal(t.requests.length,0);
  t.advance(120000);const started=await start(t,'ton-after-website-deadline');assert.equal(started.run.state,'running');assert.equal(started.run.total,1);t.database.close();
});

test('an active TON-stage gift wrapper accepts only its exact trusted fallback scope and session',async()=>{
  const t=setup(),session='wrapper-internal-ton-session';await t.seed([row(),row(address(5))],{gift_refresh:{run:{id:1,state:'running',stage:'ton',
    deadline:t.now()+120000,ton_session_id:session,ton_targets:[nft]}}});
  const saved=await t.repository.read(),exact=createOwnedPriceEngine({...t.deps,targetAddresses:[nft]}),wrong=createOwnedPriceEngine({...t.deps,targetAddresses:[address(5)]});
  await assert.rejects(start(t,session),error=>error.code==='OWNED_PRICE_BUSY');
  await assert.rejects(exact.start(ctx,{session_id:'wrong-internal-ton-session'}),error=>error.code==='OWNED_PRICE_BUSY');
  await assert.rejects(wrong.start(ctx,{session_id:session}),error=>error.code==='OWNED_PRICE_BUSY');
  assert.deepEqual(await t.repository.read(),saved);assert.equal(t.requests.length,0);
  const started=await exact.start(ctx,{session_id:session});assert.equal(started.run.state,'running');assert.equal(started.run.total,1);t.database.close();
});

test('a completed website refresh does not block later targeted TON checks',async()=>{
  const t=setup();await t.seed([row()],{gift_refresh:{run:{id:1,state:'complete',stage:'website',provider:'marketapp_website',deadline:t.now()+120000}}});
  const started=await startGift(t,nft,'gift-after-website');assert.equal(started.run.state,'running');assert.equal(started.run.total,1);assert.equal(t.requests.length,0);t.database.close();
});

test('single-gift targets must be current eligible portfolio identities; browser wallet and collection inputs are rejected', async () => {
  const t = setup(); await t.seed([row(), row(address(5), {is_portfolio: false}), row(address(6), {collection_conflict: true}), row(address(7), {collection_address: 'unknown'})]);
  const saved = await t.repository.read();
  for (const target of [null, '', {}, ['invalid'], 'opaque-gift', 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAu8f', address(5), address(6), address(7), address(8)]) {
    await assert.rejects(startGift(t, target), error => error.code === 'OWNED_PRICE_INVALID_TARGET');
    assert.deepEqual(await t.repository.read(), saved);
  }
  for (const extra of [{wallet}, {collection_address: collection}, {scope: 'gift'}]) await assert.rejects(t.engine.start(ctx, {session_id: 'single-gift-extra-input', nft_address: nft, ...extra}), /Unsupported/);
  assert.equal(t.requests.length, 0);
});

test('gift sessions permanently bind scope, target and wallet after archive and replacement', async () => {
  const t = setup([nftPage(), accountPage(), nftPage()]); await t.seed([row(), row(address(5))]);
  const started = await startGift(t); await complete(t);
  const replacement = await startGift(t, nft, 'single-gift-second-session'); assert.equal(replacement.run.id, 2);
  const replay = await startGift(t); assert.equal(replay.run.id, 1); assert.equal(replay.run.state, 'complete');
  assert.equal((await t.engine.getStatus(ctx, {session_id: started.run.session_id})).run.id, 1);
  assert.equal((await t.engine.getStatus(ctx, {session_id: 'unknown-single-gift-session'})).run, null);
  for (const input of [{session_id: started.run.session_id}, {session_id: started.run.session_id, nft_address: address(5)}]) await assert.rejects(t.engine.start(ctx, input), error => error.code === 'OWNED_PRICE_SCOPE_CHANGED');
  await t.seed([{kind: 'settings', record: {wallet: address(99)}}]);
  await assert.rejects(startGift(t), error => error.code === 'OWNED_PRICE_SCOPE_CHANGED');
  assert.equal(t.requests.length, 3);
});

test('single-gift steps retain frozen wallet provenance without replaying account records at each stage', async () => {
  const t = setup([nftPage(), accountPage(), nftPage()]); await t.seed(); const initial = await startGift(t);
  await t.seed([{kind: 'settings', record: {wallet: address(99)}}]);
  const read = t.repository.records; let calls = 0; t.repository.records = async () => {calls++; return read();};
  const done = await complete(t); assert.equal(done.run.state, 'complete'); assert.equal(done.run.wallet, wallet); assert.equal(done.run.nft_address, initial.run.nft_address);
  assert.equal(calls, 0, 'verification uses the immutable scoped checkpoint, not thousands of history records');
  assert.equal((await t.prices())[0].record.owner, wallet); assert.equal((await t.statuses())[0].record.wallet, wallet);
  const projected = buildCloudDashboard(await t.repository.records(), {}, {now: t.now()});
  assert.equal(projected.gifts[0].price_per_day, null); assert.notEqual(projected.gifts[0].state, 'idle_rental_contract');
  await assert.rejects(startGift(t), error => error.code === 'OWNED_PRICE_SCOPE_CHANGED');
});

test('new targeted sessions never join active checks, and portfolio starts never join targeted checks', async () => {
  for (const firstTargeted of [false, true]) {
    const t = setup(); await t.seed([row(), row(address(5))]);
    const initial = await (firstTargeted ? startGift(t) : start(t));
    const saved = await t.repository.read();
    for (const target of [nft, address(5)]) await assert.rejects(startGift(t, target, `new-target-session-${target.slice(-2)}`), error => {
      assert.deepEqual(ownedPriceErrorResponse(error), {error: {code: 'OWNED_PRICE_BUSY'}}); return true;
    });
    if (firstTargeted) await assert.rejects(start(t, 'new-portfolio-session'), error => error.code === 'OWNED_PRICE_BUSY');
    else assert.equal((await start(t, 'new-portfolio-session')).run.id, initial.run.id);
    assert.equal(t.requests.length, 0);
    if (firstTargeted) assert.deepEqual(await t.repository.read(), saved);
  }
  const t = setup(); await t.seed();
  const results = await Promise.allSettled([startGift(t), startGift(t, nft, 'parallel-target-session')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'OWNED_PRICE_BUSY');
  assert.equal((await t.repository.read()).state.owned_prices.next_run_id, 2);
});

test('stopped in-flight targeted check keeps its lease and rejects replacement until the request settles', async () => {
  let release; const waiting = new Promise(resolve => release = resolve);
  const t = setup([() => waiting]); await t.seed(); const initial = await startGift(t);
  const inflight = step(t); await new Promise(resolve => setImmediate(resolve));
  await t.engine.stop(ctx, {run_id: initial.run.id});
  await assert.rejects(startGift(t, nft, 'target-after-stop-session'), error => error.code === 'OWNED_PRICE_BUSY');
  release(nftPage()); await inflight;
  assert.equal((await t.prices()).length, 0);
  assert.equal((await startGift(t, nft, 'target-after-stop-session')).run.id, 2);
  assert.equal(t.requests.length, 1);
});

test('targeted post-commit crash replays the original scope without creating another run or provider request', async () => {
  const t = setup(); await t.seed(); const append = t.repository.append; let crashed = false;
  t.repository.append = async (revision, event) => {
    const committed = await append(revision, event);
    if (!crashed && committed && event.key.startsWith('owned-price:')) {crashed = true; throw new Error('Single-gift commit crash');}
    return committed;
  };
  await assert.rejects(startGift(t), /commit crash/);
  const committed = await t.repository.read(); t.repository.append = append;
  const replay = await startGift(t); assert.equal(replay.run.id, 1); assert.equal(replay.run.scope, 'gift'); assert.equal(replay.run.nft_address, nft);
  assert.deepEqual(await t.repository.read(), committed); assert.equal(t.requests.length, 0);
  assert.equal((await t.engine.getStatus(ctx, {session_id: 'single-gift-session-0001'})).run.session_id, 'single-gift-session-0001');
});

test('every method authenticates before storage or provider access; inputs reject unknown mutations', async () => {
  const t = setup([], {repository: {read() {throw new Error('Must not read');}}});
  for (const method of ['getStatus', 'start', 'step', 'stop']) await assert.rejects(t.engine[method]({}, {}), /Private access denied/);
  assert.equal(t.requests.length, 0);
  const s = setup();
  for (const input of [{session_id: 'page-session-0001', wallet}, {session_id: 'short'}, {session_id: '../secret'}]) await assert.rejects(s.engine.start(ctx, input), /input|identifier/);
  await assert.rejects(s.engine.step(ctx, {run_id: 1, resume: true}), /input/);
  await assert.rejects(s.engine.step(ctx, {run_id: 500}), /Unknown/);
  await assert.rejects(s.engine.stop(ctx, {run_id: '1'}), /identifier/);
});

test('start freezes only latest valid known portfolio and wallet with no provider request', async () => {
  const t = setup();
  await t.seed([row(), row(address(5), {is_portfolio: false}), row(address(6), {collection_address: 'bad'}), row(address(7), {collection_conflict: true}), row('nft-invalid'), row(address(8)), row(address(8), {is_portfolio: false}), {kind: 'ownership', record: {nft_address: address(9), verified: true}}, {kind: 'settings', record: {wallet: wallet.toUpperCase()}}]);
  const status = await start(t);
  assert.equal(status.run.total, 1); assert.equal(status.run.state, 'running'); assert.equal(t.requests.length, 0);
  const own = (await t.repository.read()).state.owned_prices;
  assert.deepEqual(own.run.targets, [{nft_address: nft, collection_address: collection}]); assert.equal(own.run.wallet, wallet);
  await t.seed([row(address(10)), {kind: 'settings', record: {wallet: address(11)}}]);
  assert.equal((await start(t, 'second-page-session')).run.id, 1);
  assert.equal((await t.repository.read()).state.owned_prices.run.wallet, wallet);
  assert.equal((await t.repository.read()).state.owned_prices.run.targets.length, 1);
});

test('targeted three-stage GET verification atomically commits configured daily price without changing Marketapp', async () => {
  const market = {job: {id: 33, state: 'running', lease: 'market-lease', streams: [{cursor: 'opaque'}]}, attempts: [1760000000000], next_allowed_at: 1900000000000, next_job_id: 34};
  const t = setup([nftPage(), accountPage(), nftPage()]); await t.seed(undefined, market); await start(t);
  const before = (await t.repository.read()).state;
  await step(t); assert.equal((await t.prices()).length, 0);
  let saved = (await t.repository.read()).state;
  assert.equal(saved.owned_prices.run.stage, 'accounts');
  const raw1 = t.database.prepare('SELECT raw_body,state_json,job_id,job_json FROM cloud_events ORDER BY sequence DESC LIMIT 1').get();
  assert.equal(JSON.parse(raw1.state_json).owned_prices.run.stage, 'accounts'); assert.equal(raw1.raw_body, null);
  assert.equal(raw1.job_id, null); assert.equal(raw1.job_json, null);
  t.advance(1000); await step(t);
  saved = (await t.repository.read()).state;
  assert.equal(JSON.stringify(saved).includes('BOC-not-carried'), false); assert.equal(JSON.stringify(saved).includes('DATA-not-carried'), false);
  t.advance(1000); const done = await step(t); assert.deepEqual([done.run.state, done.run.checked, done.run.updated, done.run.unresolved], ['complete', 1, 1, 0]);
  const records = await t.prices(); assert.equal(records.length, 1); assert.equal(records[0].record.configured_price_per_day_raw, '170000000'); assert.equal(Object.hasOwn(records[0].record, 'price_per_day_raw'), false);
  assert.equal(records[0].record.owner, wallet); assert.equal(records[0].record.verified, true); assert.equal(records[0].record.nft_last_transaction_lt, '100');
  for (const key of Object.keys(market)) assert.deepEqual((await t.repository.read()).state[key], before[key]);
  const paths = t.requests.map(req => new URL(req.url).pathname); assert.deepEqual(paths, ['/api/v3/nft/items', '/api/v3/accountStates', '/api/v3/nft/items']);
  for (const req of t.requests) {assert.equal(new URL(req.url).origin, 'https://toncenter.com'); assert.equal(req.options.method, 'GET'); assert.deepEqual(req.options.headers, {Accept: 'application/json'}); assert.equal(req.options.redirect, 'error'); assert.equal(req.options.timeout, 20000);}
  assert.deepEqual([...new URL(t.requests[0].url).searchParams], [['address', nft], ['limit', '50']]);
  assert.deepEqual([...new URL(t.requests[1].url).searchParams], [['address', holder], ['include_boc', 'true']]);
  const final = t.database.prepare("SELECT records_json,state_json,raw_body FROM cloud_events WHERE records_json<>'[]' ORDER BY sequence DESC LIMIT 1").get();
  assert.equal(JSON.parse(final.records_json)[0].record.verified, true); assert.equal(JSON.parse(final.state_json).owned_prices.run.state, 'complete');
});

test('session start replay and parallel starts join one run, including completed session replay', async () => {
  const t = setup([nftPage([nftItem({owner_address: wallet})]), nftPage([nftItem({owner_address: wallet})])]); await t.seed();
  const results = await Promise.all([start(t), start(t), start(t, 'other-page-session')]);
  assert.deepEqual(results.map(result => result.run.id), [1, 1, 1]);
  await t.repository.syncOwnedRefreshArchive();
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 2);
  assert.equal(Object.hasOwn((await t.repository.read()).state.owned_prices, 'sessions'), false);
  await complete(t, 2); const original = await start(t); assert.equal(original.run.state, 'complete'); assert.equal(original.run.id, 1);
  const fresh = await start(t, 'fresh-page-session'); assert.equal(fresh.run.id, 2);
  assert.equal((await start(t)).run.id, 1); assert.equal((await start(t)).run.state, 'complete');
  assert.equal((await step(t, 1)).run.state, 'complete'); assert.equal(t.requests.length, 2);
});

test('empty scope and missing wallet use no network and do not enroll candidates', async () => {
  const t = setup(); await t.seed([row(nft, {is_portfolio: false})]);
  assert.equal((await start(t)).run.state, 'complete'); assert.equal((await start(t)).run.total, 0);
  const s = setup(); await s.seed([row(), {kind: 'settings', record: {wallet: null}}]);
  assert.equal((await start(s)).run.reason, 'wallet_not_configured');
  assert.equal((await step(s)).run.state, 'partial'); assert.equal(s.requests.length, 0);
});

test('missing NFT, malformed NFT and wrong collection remain unresolved with no account fetch', async () => {
  for (const [items, reason] of [[[], 'nft_missing'], [[nftItem({init: false})], 'invalid_nft_state'], [[nftItem({last_transaction_lt: 100})], 'invalid_nft_state'], [[nftItem({collection_address: address(999)})], 'collection_mismatch']]) {
    const t = setup([nftPage(items)]); await t.seed(); await start(t); const done = await step(t);
    assert.equal(done.run.state, 'complete'); assert.equal(done.run.unresolved, 1); assert.equal(done.run.updated, 0); assert.equal(t.requests.length, 1);
    const record = (await t.prices())[0].record; assert.equal(record.reason, reason); assert.equal(Object.hasOwn(record, 'configured_price_per_day_raw'), false);
    assert.deepEqual((await t.repository.records()).map(row => row.kind), ['settings', 'portfolio', 'owned_price', 'owned_status']);
  }
});

test('owner and NFT logical-time rechecks prevent accepting a changed snapshot', async () => {
  for (const change of [{owner_address: address(7)}, {last_transaction_lt: '101'}, {collection_address: address(8)}, {owner_address: wallet}]) {
    const t = setup([nftPage(), accountPage(), nftPage([nftItem(change)])]); await t.seed(); await start(t); const done = await complete(t);
    assert.equal(done.run.updated, 0); assert.equal(done.run.unresolved, 1); const record = (await t.prices())[0].record;
    assert.equal(record.verified, false); assert.equal(Object.hasOwn(record, 'configured_price_per_day_raw'), false);
  }
});

test('only validated owner, NFT, holder, hashes, recognized states and integer configured daily amounts are accepted', async () => {
  for (const change of [{verified: false, reason: 'unsupported_code_hash'}, {rental_state: 'unknown'}, {owner: address(99)}, {nft: address(99)}, {holding_contract: address(99)}, {code_hash_verified: false}, {data_hash_verified: false}, {configured_price_per_day_raw: '-1'}, {configured_price_per_day_raw: '1.25'}, {configured_price_per_day_raw: 17}, {configured_price_per_day_raw: null}]) {
    const t = setup([nftPage(), accountPage(), nftPage()], {decodeContract: () => decoded(change)}); await t.seed(); await start(t); const done = await complete(t);
    assert.equal(done.run.updated, 0); assert.equal((await t.prices())[0].record.verified, false); assert.equal(Object.hasOwn((await t.prices())[0].record, 'configured_price_per_day_raw'), false);
    if (change.rental_state) assert.equal((await t.prices())[0].record.reason, 'unsupported_rental_state');
  }
  for (const rental_state of ['rented', 'expired_pending_return']) {
    const t = setup([nftPage(), accountPage(), nftPage()], {decodeContract: () => decoded({rental_state, configured_price_per_day_raw: '0'})}); await t.seed(); await start(t); assert.equal((await complete(t)).run.updated, 1);
  }
});

test('50-address batching bounds account holders, rechecks, and advances exactly once', async () => {
  const gifts = Array.from({length: 51}, (_, i) => row(address(i + 10)));
  const batch = gifts.slice(0, 50).map(gift => nftItem({address: gift.record.nft_address}));
  const last = [nftItem({address: address(60), owner_address: wallet})];
  const t = setup([nftPage(batch), accountPage(), nftPage(batch), nftPage(last), nftPage(last)], {decodeContract: (_account, n) => decoded({nft: n})});
  await t.seed(gifts); await start(t); let status = await complete(t, 5);
  assert.equal(status.run.state, 'complete'); assert.equal(status.run.total, 51); assert.equal(status.run.updated, 50); assert.equal(status.run.unresolved, 1);
  assert.equal(new URL(t.requests[0].url).searchParams.getAll('address').length, 50); assert.equal(new URL(t.requests[1].url).searchParams.getAll('address').length, 1);
  assert.equal(new Set((await t.prices()).map(row => row.key)).size, 51);
});

test('provider pacing and Retry-After survive new instances and repeated steps without implicit requests', async () => {
  const direct = nftPage([nftItem({owner_address: wallet})]);
  const t = setup([response({}, 429, '10'), direct, direct]); await t.seed(); await start(t);
  const first = await step(t); assert.equal(first.run.reason, 'retry_wait'); assert.equal(first.next_allowed_at, t.now() + 10000);
  t.engine = createOwnedPriceEngine(t.deps); await step(t); t.advance(9999); await step(t); assert.equal(t.requests.length, 1);
  t.advance(1); assert.equal((await step(t)).run.state, 'running'); assert.equal(t.requests.length, 2);
  t.advance(1000); assert.equal((await step(t)).run.state, 'complete');
  const ledger = (await t.repository.read()).state.owned_prices; assert.equal(ledger.attempts.length, 3);
});

test('three exhausted attempts and nonretryable malformed pages persist no successful price', async () => {
  const t = setup([new Error('offline'), response({}, 503), new Error('offline')]); await t.seed(); await start(t);
  await step(t); t.advance(1000); await step(t); t.advance(2000); assert.equal((await step(t)).run.reason, 'retry_exhausted'); assert.equal(t.requests.length, 3);
  assert.equal((await t.prices())[0].record.verified, false);
  for (const page of [response('invalid json'), response({nft_items: [nftItem(), nftItem()]}), response({nft_items: [nftItem({address: address(99)})]}), response({items: []}), response('x'.repeat(1048577)), response({}, 429, 'nonsense'), response({}, 403), response({}, 200, null, {url: 'https://elsewhere.invalid'})]) {
    const s = setup([page]); await s.seed(); await start(s); const result = await step(s); assert.equal(result.run.state, 'failed'); assert.equal(result.run.updated, 0); assert.equal(s.requests.length, 1); assert.equal((await s.prices())[0].record.verified, false);
  }
});

test('CAS lease prevents overlapping calls and only commits the active request once', async () => {
  let release; const pending = new Promise(resolve => {release = resolve;});
  const t = setup([() => pending, nftPage([nftItem({owner_address: wallet})])]); await t.seed(); await start(t);
  const first = step(t); while (t.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  const parallel = await step(t); assert.equal(parallel.run.checked, 0); assert.equal(t.requests.length, 1);
  release(nftPage([nftItem({owner_address: wallet})])); assert.equal((await first).run.checked, 0);
  t.advance(1000); await step(t); assert.equal(t.requests.length, 2); assert.equal((await t.prices()).length, 1);
  await step(t); assert.equal((await t.statuses()).length, 1);
});

test('stop preserves in-flight lease and commits no late price, while retaining provider cooldown', async () => {
  let release; const pending = new Promise(resolve => {release = resolve;}); const t = setup([() => pending]); await t.seed(); await start(t);
  const first = step(t); while (t.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  const stopped = await t.engine.stop(ctx, {run_id: 1}); assert.equal(stopped.run.state, 'partial'); assert.ok(stopped.next_allowed_at > t.now());
  assert.equal((await start(t, 'new-page-during-stop')).run.id, 1);
  release(response({}, 429, '60')); const final = await first; assert.equal(final.run.reason, 'stopped_by_you'); assert.equal(final.next_allowed_at, t.now() + 60000); assert.equal((await t.prices()).length, 0);
});

test('expired crash lease replays same stage within attempt budget and stale worker cannot commit', async () => {
  let release; const pending = new Promise(resolve => {release = resolve;});
  const direct = nftPage([nftItem({owner_address: wallet})]);
  const t = setup([() => pending, direct, direct], {limits: {lease_ms: 30000}}); await t.seed(); await start(t);
  const first = step(t); while (t.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  t.advance(30001); const recovered = await step(t); assert.equal(recovered.run.state, 'running'); assert.equal(recovered.run.checked, 0);
  t.advance(1000); await step(t);
  release(nftPage()); await first; assert.equal((await t.prices()).length, 1); assert.equal((await t.repository.read()).state.owned_prices.attempts.length, 3);
});

test('run attempts, duration, global daily ledger and a new page cannot bypass caps', async () => {
  const t = setup([nftPage()], {limits: {invocation_attempts: 1}}); await t.seed(); await start(t); assert.equal((await step(t)).run.reason, 'invocation_limit'); assert.equal(t.requests.length, 1); assert.equal((await t.prices()).length, 0);
  const s = setup([nftPage([nftItem({owner_address: wallet})])], {limits: {daily_attempts: 1}}); await s.seed(); await start(s); await step(s); assert.equal((await start(s, 'fresh-page-daily-limit')).run.reason, 'daily_limit'); await step(s, 2); assert.equal(s.requests.length, 1);
  s.advance(86400000); assert.equal((await start(s, 'page-after-daily-reset')).run.state, 'running');
  const d = setup(); await d.seed(); await start(d); d.advance(120000); assert.equal((await d.engine.getStatus(ctx)).run.reason, 'duration_limit'); assert.equal((await step(d)).run.reason, 'duration_limit'); assert.equal(d.requests.length, 0);
  assert.equal(OWNED_PRICE_LIMITS.invocation_attempts, 60); assert.equal(OWNED_PRICE_LIMITS.daily_attempts, 1000); assert.equal(OWNED_PRICE_LIMITS.duration_ms, 120000);
});

test('trusted clock after response controls backoff, timeout and fail-closed late results', async () => {
  let trusted = Date.parse('2026-10-09T12:00:00Z');
  const t = setup([() => {trusted += 5000; return response({}, 429, '10');}], {clock: async () => trusted}); await t.seed(); await start(t); const result = await step(t);
  assert.equal(result.next_allowed_at, trusted + 10000);
  const s = setup([() => {trusted += 20001; return nftPage([nftItem({owner_address: wallet})]);}], {clock: async () => trusted}); await s.seed(); await start(s); assert.equal((await step(s)).run.reason, 'retry_wait'); assert.equal((await s.prices()).length, 0);
  let available = true; const f = setup([], {clock: async () => {if (!available) throw new Error('clock down'); return trusted;}}); await f.seed(); await start(f); available = false;
  await assert.rejects(step(f), /trusted server clock/); assert.equal(f.requests.length, 0);
});

test('a stalled TON body times out without advancing the verification stage or losing attempt accounting', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let began; const started = new Promise(done => {began = done;});
  const body = {[Symbol.asyncIterator]() {return {next() {began(); return new Promise(() => {});}, return() {return new Promise(() => {});}};}};
  const env = setup([response('', 200, null, {body})], {limits: {timeout_ms: 30}}); await env.seed(); await start(env);
  const pending = step(env); await started; t.mock.timers.tick(30);
  const status = await pending; assert.equal(status.run.reason, 'retry_wait'); assert.equal(status.run.checked, 0);
  const own = (await env.repository.read()).state.owned_prices;
  assert.equal(own.run.stage, 'before'); assert.equal(own.attempts.length, 1); assert.equal(own.run.stage_attempts, 1);
  assert.equal(env.database.prepare('SELECT count(*) AS n FROM cloud_events WHERE raw_body IS NOT NULL').get().n, 0);
  assert.equal((await env.prices()).length, 0);
});

test('discarded TON evidence escaping does not reject bounded before/account/after verification', async () => {
  const payload = {nft_items: [nftItem({unknown_metadata: '\\'.repeat(500)})]};
  const accounts={accounts:[accountItem({unknown_metadata:'\\'.repeat(500)})]};
  const env = setup([response(payload),response(accounts),response(payload)], {limits: {response_bytes: 1700}}); await env.seed(); await start(env);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1700);
  assert.ok(Buffer.byteLength(JSON.stringify(accounts)) < 1700);
  assert.ok(Buffer.byteLength(JSON.stringify({body:JSON.stringify(payload)})) > 1700);
  const append=env.repository.append.bind(env.repository),markers=[];
  env.repository.append=async(revision,event)=>{if(event.raw_body)markers.push(event.raw_body);return await append(revision,event);};
  const running = await step(env); assert.equal(running.run.state,'running'); assert.equal(running.run.reason,null);
  assert.equal((await env.repository.read()).state.owned_prices.run.stage, 'accounts');
  assert.equal(Object.hasOwn((await env.repository.read()).state.owned_prices.run.pending[0],'unknown_metadata'),false);
  env.advance(1000); await step(env); env.advance(1000);
  const done=await step(env); assert.equal(done.run.state,'complete'); assert.equal(done.run.updated,1);
  assert.equal((await env.prices())[0].record.verified,true); assert.equal((await env.prices())[0].record.configured_price_per_day_raw,'170000000');
  assert.equal(markers.length,3); assert.ok(markers.every(value=>Buffer.byteLength(value)<=1700));
  assert.ok(markers.every(value=>JSON.parse(value).truncated===true&&JSON.parse(value).failure===null));
  assert.equal((await step(env)).run.state,'complete'); assert.equal(env.requests.length,3);
  assert.equal(env.database.prepare('SELECT count(*) AS n FROM cloud_events WHERE raw_body IS NOT NULL').get().n, 0);
  assert.equal((await env.prices()).length,1);
});

test('TON wire response limits still reject oversized before/account/after pages without a verified price', async () => {
  for(const stage of ['before','accounts','after']) {
    const oversized=stage==='accounts'?{accounts:[accountItem({unknown_metadata:'x'.repeat(1700)})]}
      :{nft_items:[nftItem({unknown_metadata:'x'.repeat(1700)})]},responses=stage==='before'?[response(oversized)]
        :stage==='accounts'?[nftPage(),response(oversized)]:[nftPage(),accountPage(),response(oversized)];
    assert.ok(Buffer.byteLength(JSON.stringify(oversized))>1700);
    const requestCount=responses.length,env=setup(responses,{limits:{response_bytes:1700}}); await env.seed(); await start(env);
    const status=await complete(env,requestCount);
    assert.equal(status.run.state,'failed'); assert.equal(status.run.reason,'response_too_large'); assert.equal(status.run.updated,0);
    assert.equal((await env.prices()).filter(value=>value.record.verified===true).length,0);
    assert.equal(env.requests.length,requestCount);
    assert.equal(env.database.prepare('SELECT count(*) AS n FROM cloud_events WHERE raw_body IS NOT NULL').get().n,0);
  }
});

test('real pinned idle fixture passes targeted before/account/after workflow', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/ton/7f44-idle.json', import.meta.url), 'utf8'));
  const code = readFileSync(new URL('../../tests/fixtures/ton/observed-7f44-code.boc.base64', import.meta.url), 'utf8').trim();
  const t = setup([nftPage([fixture.nft_before]), accountPage([{...fixture.account, code_boc: code}]), nftPage([fixture.nft_after])], {decodeContract: undefined});
  await t.seed([row(fixture.nft_before.address, {collection_address: fixture.nft_before.collection_address}), {kind: 'settings', record: {wallet: fixture.wallet_address}}]); await start(t);
  const result = await complete(t); assert.equal(result.run.updated, 1); const record = (await t.prices())[0].record;
  assert.equal(record.configured_price_per_day_raw, '70000000'); assert.equal(record.code_hash_verified, true); assert.equal(record.data_hash_verified, true);
  assert.equal(record.marketplace, fixture.expected.marketplace); assert.equal(record.role, fixture.expected.role); assert.equal(record.status, fixture.expected.status); assert.equal(record.counterpart, null); assert.equal(record.reason, 'verified_contract_price'); assert.ok(record.contract_observed_at);
});

test('scope uses newest observed portfolio timestamp, canonical aliases and all saved collection conflicts', async () => {
  const t = setup();
  const recent = item => ({...item, observed_at: '2026-10-09T12:00:00.001Z'});
  await t.seed([
    recent(row(nft, {is_portfolio: false})), row(nft),
    recent(row(address(10))), row(address(10), {is_portfolio: false}),
    row(address(11), {collection_addresses: [collection, address(99)]}),
    row(address(12)), {kind: 'metadata', record: {nft_address: address(12).toUpperCase(), collections: [address(99)]}},
    row(address(13)), {kind: 'listing', record: {identity: address(13), collection_evidence: {observed: [address(99)]}}},
    row(address(14)), {kind: 'history', record: {identity: address(14), source_json: JSON.stringify({collection_address: address(99)})}},
    row(address(15)), {kind: 'ownership', record: {nft_address: address(15), collection_conflict: true}},
    row(address(16)), {kind: 'metadata', record: {nft_address: address(16), collections: [collection.toUpperCase()]}}
  ]);
  assert.equal((await start(t)).run.total, 2);
  assert.deepEqual((await t.repository.read()).state.owned_prices.run.targets.map(row => row.nft_address), [address(10), address(16)]);
});

test('default request lease spans the whole run so unknown host calls cannot overlap on a new opening', async () => {
  let release; const pending = new Promise(resolve => {release = resolve;}); const t = setup([() => pending]); await t.seed(); await start(t);
  const first = step(t); while (t.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  t.advance(30001); assert.equal((await start(t, 'new-page-after-thirty')).run.id, 1); await step(t); assert.equal(t.requests.length, 1);
  t.advance(90000); const next = await start(t, 'new-page-after-expiry'); assert.equal(next.run.id, 2);
  release(nftPage()); await first; assert.equal((await t.prices()).length, 0); assert.equal((await t.repository.read()).state.owned_prices.run.id, 2);
});

test('verified price keeps account observation time when a newer listing arrives before final NFT recheck', async () => {
  const t = setup([nftPage(), accountPage(), nftPage()]); await t.seed(); await start(t);
  await step(t); t.advance(1000); await step(t); const accountTime = new Date(t.now()).toISOString();
  t.advance(1000); const listingTime = new Date(t.now()).toISOString();
  await t.seed([{kind: 'listing', key: 'newer-listing', observed_at: listingTime, record: {identity: nft, collection_address: collection, source_json: {nft_address: nft, price_per_day: '250000000'}}}]);
  t.advance(1000); await step(t); const record = (await t.prices())[0];
  assert.equal(record.observed_at, accountTime); assert.equal(record.record.contract_observed_at, accountTime);
  assert.ok(record.observed_at < listingTime); assert.equal(record.record.checked_at, new Date(t.now()).toISOString()); assert.equal(record.record.rechecked_at, new Date(t.now()).toISOString());
});

test('startup endpoint workflow refreshes rented/idle/expired/direct status with the same TON requests and no enrollment', async () => {
  const expires = Math.floor(Date.parse('2026-10-09T12:01:00Z') / 1000);
  for (const [rental_state, terms] of [['idle_rental_contract', {}], ['rented', {role: 1, status: 1, renter: address(50), counterpart: address(51), rental_until: expires, rental_duration: 86400, created_at: expires - 86400}], ['expired_pending_return', {role: 1, status: 1, renter: address(50), counterpart: address(51), rental_until: expires - 120, rental_duration: 86400, created_at: expires - 120 - 86400}]]) {
    const t = setup([nftPage(), accountPage(), nftPage()], {decodeContract: () => decoded({rental_state, ...terms})});
    await t.seed([row(nft, {state: 'rented', ui_state: 'for_rent', display_state: 'For rent', observed_at: '2026-10-09T10:00:00Z', market_observed_at: '2026-10-09T10:00:00Z', name: 'Known gift', membership_sources: ['ton_verified']})]);
    await start(t); const done = await complete(t);
    assert.equal(done.run.status_updated, 1); assert.equal(done.run.status_unresolved, 0); assert.equal(done.run.updated, 1);
    const statuses = await t.statuses(); assert.equal(statuses.length, 1);
    assert.equal(statuses[0].record.rental_state, rental_state); assert.equal(statuses[0].record.wallet, wallet);
    assert.equal(statuses[0].record.role, terms.role ?? 0); assert.equal(statuses[0].record.status, terms.status ?? 0);
    assert.equal(statuses[0].record.rental_until_unit, 'Unix seconds');
    const view = buildCloudDashboard(await t.repository.records(), {}, {now: t.now()});
    assert.equal(view.gifts[0].state, rental_state); assert.equal(view.gifts[0].ui_state, rental_state === 'rented' ? 'rented' : null);
    assert.equal(view.gifts[0].observed_at, '2026-10-09T10:00:00Z'); assert.deepEqual(view.gifts[0].membership_sources, ['ton_verified']);
    assert.equal(view.gifts[0].status_provenance.code_hash, SUPPORTED_CODE_HASH);
    if (terms.created_at) {
      assert.equal(statuses[0].record.created_at, terms.created_at);
      assert.equal(statuses[0].record.created_at_unit, 'Unix seconds');
      assert.equal(view.gifts[0].current_rental_started_at, new Date(terms.created_at * 1000).toISOString());
      assert.equal(view.gifts[0].current_rental_start_source, 'verified_contract');
    } else assert.equal(view.gifts[0].current_rental_started_at, null);
    assert.equal(t.requests.length, 3); assert.ok(t.requests.every(({url}) => url.startsWith('https://toncenter.com/')));
    const final = JSON.parse(t.database.prepare('SELECT records_json FROM cloud_events ORDER BY sequence DESC LIMIT 1').get().records_json);
    assert.deepEqual(final.map(row => row.kind), ['owned_price', 'owned_status']);
  }
  const direct = nftPage([nftItem({owner_address: wallet})]);
  const d = setup([direct, direct]); await d.seed([row(nft, {state: 'rented', observed_at: '2026-10-09T10:00:00Z'})]); await start(d);
  const result = await complete(d, 2); assert.equal(result.run.updated, 0); assert.equal(result.run.unresolved, 1);
  assert.equal(result.run.status_updated, 1); assert.equal(result.run.status_unresolved, 0);
  assert.equal((await d.prices())[0].record.reason, 'held_directly'); assert.equal((await d.statuses())[0].record.verified, true);
  assert.equal(buildCloudDashboard(await d.repository.records(), {}, {now: d.now()}).gifts[0].state, 'held_directly');
  assert.deepEqual(d.requests.map(({url}) => new URL(url).pathname), ['/api/v3/nft/items', '/api/v3/nft/items']);
});

test('status verification is independent from configured price validity and rejects raw status/identity mismatches', async () => {
  const t = setup([nftPage(), accountPage(), nftPage()], {decodeContract: () => decoded({configured_price_per_day_raw: null})});
  await t.seed(); await start(t); const result = await complete(t);
  assert.equal(result.run.updated, 0); assert.equal(result.run.status_updated, 1);
  assert.equal((await t.statuses())[0].record.rental_state, 'idle_rental_contract');
  for (const change of [{marketplace: address(99)}, {code_hash: 'a'.repeat(64)}, {role: 1}, {rental_state: 'unknown', status: 7}, {rental_until: -1}, {rental_state: 'rented', role: 1, status: 1, rental_until: Math.floor(t.now() / 1000) + 100, renter: null, counterpart: address(50)}]) {
    const s = setup([nftPage(), accountPage(), nftPage()], {decodeContract: () => decoded(change)}); await s.seed(); await start(s); await complete(s);
    const status = (await s.statuses())[0].record;
    assert.equal(status.verified, false); assert.equal(status.rental_state, 'unknown');
    assert.equal(buildCloudDashboard(await s.repository.records(), {}, {now: s.now()}).gifts[0].state, 'unknown');
  }
});

test('moving direct and contract holders retain historical membership and become unresolved status', async () => {
  for (const direct of [false, true]) {
    const before = nftPage([nftItem(direct ? {owner_address: wallet} : {})]);
    const after = nftPage([nftItem({owner_address: address(99), last_transaction_lt: '101'})]);
    const t = setup(direct ? [before, after] : [before, accountPage(), after]); await t.seed([row(nft, {state: 'rented', ui_state: 'for_rent', observed_at: '2026-10-09T10:00:00Z'})]);
    await start(t); const result = await complete(t, direct ? 2 : 3);
    assert.equal(result.run.status_updated, 0); assert.equal((await t.statuses())[0].record.reason, 'nft_changed_during_refresh');
    const gift = buildCloudDashboard(await t.repository.records(), {}, {now: t.now()}).gifts[0];
    assert.equal(gift.is_portfolio, true); assert.equal(gift.state, 'unknown'); assert.equal(gift.ui_state, null); assert.equal(gift.previous_rental_state, 'rented');
  }
});

test('old price-only in-flight checkpoints cannot acquire current rental-status semantics during deployment', async () => {
  const t = setup([nftPage(), accountPage(), nftPage()]); await t.seed(); await start(t); await step(t);
  const saved = await t.repository.read(); delete saved.state.owned_prices.run.status_refresh_version;
  await t.repository.append(saved.revision, {key: 'legacy-checkpoint', state: saved.state, job: null, records: [], observed_at: new Date(t.now()).toISOString()});
  t.advance(1000); await step(t); t.advance(1000); await step(t);
  assert.equal((await t.prices()).length, 1); assert.equal((await t.statuses()).length, 0);
});

test('real rented fixture projects current state and expiry from validated account evidence', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/ton/7f44-rented.json', import.meta.url), 'utf8'));
  const code = readFileSync(new URL('../../tests/fixtures/ton/observed-7f44-code.boc.base64', import.meta.url), 'utf8').trim();
  const t = setup([nftPage([fixture.nft_before]), accountPage([{...fixture.account, code_boc: code}]), nftPage([fixture.nft_after])], {decodeContract: undefined});
  t.advance(Date.parse(fixture.account_observed_at) - t.now());
  await t.seed([row(fixture.nft_before.address, {collection_address: fixture.nft_before.collection_address}), {kind: 'settings', record: {wallet: fixture.wallet_address}}]); await start(t); await complete(t);
  const status = (await t.statuses())[0]; assert.equal(status.record.verified, true); assert.equal(status.record.rental_state, 'rented');
  const gift = buildCloudDashboard(await t.repository.records(), {}, {now: t.now()}).gifts[0];
  assert.equal(gift.state, 'rented'); assert.equal(gift.status_provenance.role, 1); assert.equal(gift.rental_until, new Date(status.record.rental_until * 1000).toISOString());
});

function legacyOwned(t) {
  const at = new Date(t.now()).toISOString();
  const complete = {id: 1, state: 'complete', total: 1, checked: 1, updated: 1, unresolved: 0, reason: null, started_at: at, completed_at: at};
  const partial = {...complete, id: 2, state: 'partial', checked: 0, updated: 0, reason: 'stopped_by_you'};
  return {version: 1, next_run_id: 4, history: [complete, partial], sessions: [
    {id: 'legacy-first-session', run_id: 1}, {id: 'legacy-second-session', run_id: 2}, {id: 'legacy-active-session', run_id: 3},
  ], attempts: [t.now() - 1000], next_allowed_at: t.now() + 2000,
  run: {...complete, id: 3, state: 'running', checked: 0, updated: 0, completed_at: null, wallet,
    targets: [{nft_address: nft, collection_address: collection}], offset: 0, stage: 'accounts', stage_attempts: 1,
    pending: [{nft_address: nft, collection_address: collection, holding_contract: holder, nft_last_transaction_lt: '100'}],
    attempts: 1, deadline: t.now() + 100000, lease: 'legacy-request-lease', lease_until: t.now() + 3000}};
}

test('populated legacy state is indexed before compaction and preserves old outcomes, leases and every checkpoint', async () => {
  const t = setup(), own = legacyOwned(t), market = {attempts: [t.now()], next_allowed_at: t.now() + 4000, job: {id: 9, state: 'running', streams: [{cursor: 'original'}]}};
  await t.seed(undefined, {...market, owned_prices: own});
  const original = t.database.prepare('SELECT * FROM cloud_events WHERE sequence=1').get();
  const joined = await start(t, 'new-migrating-session');
  assert.equal(joined.run.id, 3); assert.equal(joined.run.state, 'running'); assert.equal(t.requests.length, 0);
  const saved = (await t.repository.read()).state;
  assert.equal(saved.owned_prices.version, 2);
  assert.equal(Object.hasOwn(saved.owned_prices, 'history'), false); assert.equal(Object.hasOwn(saved.owned_prices, 'sessions'), false);
  assert.deepEqual(saved.owned_prices.run, own.run); assert.deepEqual(saved.owned_prices.attempts, own.attempts);
  assert.equal(saved.owned_prices.next_allowed_at, own.next_allowed_at);
  for (const key of Object.keys(market)) assert.deepEqual(saved[key], market[key]);
  for (const [session, expected] of own.sessions.slice(0, 2).map(session => [session.id, own.history.find(run => run.id === session.run_id)])) {
    assert.deepEqual((await start(t, session)).run, expected);
    assert.deepEqual((await step(t, expected.id)).run, expected);
    assert.deepEqual((await t.engine.stop(ctx, {run_id: expected.id})).run, expected);
  }
  assert.deepEqual(t.database.prepare('SELECT * FROM cloud_events WHERE sequence=1').get(), original);
  await t.repository.syncOwnedRefreshArchive();
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 4);
});

test('a crash during legacy indexing leaves original state intact and safely replays partially indexed rows', async () => {
  const t = setup(); await t.seed(undefined, {owned_prices: legacyOwned(t)});
  const original = await t.repository.read(), run = t.db.run;
  let failed = false;
  t.db.run = async (sql, params) => {
    if (!failed && sql.startsWith('UPDATE owned_refresh_index')) {failed = true; throw new Error('Simulated indexing crash');}
    return run(sql, params);
  };
  await assert.rejects(start(t, 'new-after-crash-session'), /Simulated indexing crash/);
  assert.deepEqual(await t.repository.read(), original);
  assert.equal(t.database.prepare('SELECT sequence FROM owned_refresh_index').get().sequence, 0);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 3);
  t.db.run = run;
  assert.equal((await start(t, 'new-after-crash-session')).run.id, 3);
  assert.equal((await start(t, 'legacy-first-session')).run.id, 1);
  assert.equal(t.requests.length, 0);
});

test('a losing CAS start cannot create a session mapping or another run, and archive indexing is concurrent-idempotent', async () => {
  const t = setup(); await t.seed([]);
  const append = t.repository.append; let conflicted = false;
  t.repository.append = async (revision, event) => {
    if (!conflicted && event.key.startsWith('owned-price:')) {
      conflicted = true;
      const old = await t.repository.read();
      await append(old.revision, {key: 'concurrent-unrelated-event', state: old.state, job: null, records: [], observed_at: new Date(t.now()).toISOString()});
      return false;
    }
    return append(revision, event);
  };
  const result = await start(t, 'cas-conflict-session');
  assert.equal(result.run.id, 1); assert.equal(result.run.state, 'complete');
  await Promise.all(Array.from({length: 8}, () => t.repository.syncOwnedRefreshArchive()));
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 1);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_runs').get().n, 1);
  assert.equal(t.database.prepare('SELECT sequence FROM owned_refresh_index').get().sequence, (await t.repository.read()).revision);
  assert.equal((await start(t, 'cas-conflict-session')).run.id, 1);
  assert.equal(t.requests.length, 0);
});

test('a crash immediately after the authoritative event commit still replays the original session result', async () => {
  const t = setup(); await t.seed([]);
  const append = t.repository.append; let crashed = false;
  t.repository.append = async (revision, event) => {
    const committed = await append(revision, event);
    if (!crashed && committed && event.key.startsWith('owned-price:')) {crashed = true; throw new Error('Simulated post-commit crash');}
    return committed;
  };
  await assert.rejects(start(t, 'post-commit-crash-session'), /post-commit crash/);
  const committed = await t.repository.read(); assert.equal(committed.state.owned_prices.run.id, 1);
  t.repository.append = append; t.engine = createOwnedPriceEngine(t.deps);
  const replay = await start(t, 'post-commit-crash-session');
  assert.equal(replay.run.id, 1); assert.equal(replay.run.state, 'complete');
  assert.equal((await t.repository.read()).revision, committed.revision);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 1);
  assert.equal(t.requests.length, 0);
});

test('replacing an expired run archives its final partial outcome instead of its older running checkpoint', async () => {
  const t = setup(); await t.seed(); await start(t, 'will-expire-session');
  t.advance(OWNED_PRICE_LIMITS.duration_ms + 1);
  const fresh = await start(t, 'after-expiry-session'); assert.equal(fresh.run.id, 2);
  const original = await start(t, 'will-expire-session');
  assert.equal(original.run.id, 1); assert.equal(original.run.state, 'partial'); assert.equal(original.run.reason, 'duration_limit');
  assert.equal((await step(t, 1)).run.state, 'partial');
  assert.equal(t.requests.length, 0);
});

test('one thousand page openings keep constant-size hot state, linear storage and permanent session replay', async () => {
  const t = setup(); await t.seed([]);
  let firstBytes = 0;
  for (let i = 1; i <= 1000; i++) {
    const result = await start(t, `empty-page-session-${String(i).padStart(4, '0')}`);
    assert.equal(result.run.id, i); assert.equal(result.run.state, 'complete');
    if (i === 2) firstBytes = JSON.stringify((await t.repository.read()).state).length;
    t.advance(1000);
  }
  await t.repository.syncOwnedRefreshArchive();
  const latest = (await t.repository.read()).state;
  assert.ok(JSON.stringify(latest).length < firstBytes + 100, 'hot state contains only the current and previous run plus one session');
  const saved = t.database.prepare('SELECT SUM(length(CAST(state_json AS BLOB))) AS bytes FROM cloud_events').get().bytes;
  const indexed = t.database.prepare('SELECT SUM(length(CAST(summary_json AS BLOB))) AS bytes FROM owned_refresh_runs').get().bytes;
  assert.ok(saved + indexed < 1600000, `linear checkpoint and archive storage: ${saved + indexed} bytes`);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 1000);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_runs').get().n, 1000);
  assert.equal((await start(t, 'empty-page-session-0001')).run.id, 1);
  assert.equal((await start(t, 'empty-page-session-0500')).run.id, 500);
  assert.equal((await step(t, 1)).run.state, 'complete');
  assert.equal(t.requests.length, 0);
});

test('legacy arrays larger than the host response bound are indexed in small pages without returning the document', async () => {
  const t = setup(), own = legacyOwned(t), template = own.history[0];
  own.history = Array.from({length: 5000}, (_, i) => ({...template, id: i + 1}));
  own.sessions = own.history.map(run => ({id: `legacy-many-${String(run.id).padStart(4, '0')}-${'x'.repeat(120)}`, run_id: run.id}));
  own.run.id = 5001; own.next_run_id = 5002;
  await t.seed(undefined, {owned_prices: own});
  assert.ok(JSON.stringify(own).length > 1048576);
  const get = t.db.get, all = t.db.all, write = t.db.run; let largest = 0, calls = 0;
  const measure = value => {largest = Math.max(largest, JSON.stringify(value).length); return value;};
  t.db.get = async (sql, params) => {calls++; return measure(await get(sql, params));};
  t.db.all = async (sql, params) => {calls++; return measure(await all(sql, params));};
  t.db.run = async (sql, params) => {calls++; return write(sql, params);};
  await t.repository.syncOwnedRefreshArchive();
  assert.ok(largest < 65536, `largest archive host result: ${largest} bytes`);
  assert.ok(calls < 300, `legacy migration batches its ${calls} database calls`);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_sessions').get().n, 5000);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM owned_refresh_runs').get().n, 5001);
  assert.equal(await t.repository.ownedRefreshSession(own.sessions[0].id), 1);
  assert.equal(await t.repository.ownedRefreshSession(own.sessions[4999].id), 5000);
  assert.equal((await t.repository.ownedRefreshRun(1)).state, 'complete');
  assert.equal(t.requests.length, 0);
});

test('hundreds of Marketapp events with unchanged owned state need only bounded archive reads and no repeated projection writes', async () => {
  const t = setup(); await t.seed([]); await start(t, 'original-long-lived-session'); await t.repository.syncOwnedRefreshArchive();
  for (let i = 0; i < 500; i++) {
    const previous = await t.repository.read(); previous.state.next_allowed_at = t.now() + i;
    await t.repository.append(previous.revision, {key: `market-page:${i}`, state: previous.state,
      job: {id: 1, state: 'running', pages: i}, records: [], observed_at: new Date(t.now()).toISOString()});
  }
  const read = t.db.get, all = t.db.all, write = t.db.run; let calls = 0, indexed = 0;
  t.db.get = async (sql, params) => {calls++; return read(sql, params);};
  t.db.all = async (sql, params) => {calls++; return all(sql, params);};
  t.db.run = async (sql, params) => {calls++; if (/INSERT(?: OR IGNORE)? INTO owned_refresh_(runs|sessions)/.test(sql)) indexed++; return write(sql, params);};
  await t.repository.syncOwnedRefreshArchive();
  assert.ok(calls <= 6, `500 unrelated events used ${calls} archive database calls`);
  assert.equal(indexed, 0);
  assert.equal(t.database.prepare('SELECT sequence FROM owned_refresh_index').get().sequence, (await t.repository.read()).revision);
  assert.equal(await t.repository.ownedRefreshSession('original-long-lived-session'), 1);
  assert.equal((await t.repository.ownedRefreshRun(1)).state, 'complete');
  assert.equal(t.requests.length, 0);
});

test('archive filtering still detects meaningful owned checkpoint changes under non-owned event keys', async () => {
  const t = setup(); await t.seed([]); await start(t, 'original-key-session'); await t.repository.syncOwnedRefreshArchive();
  const previous = await t.repository.read();
  previous.state.owned_prices.run.reason = 'recovered_checkpoint';
  previous.state.owned_prices.last_session = {id: 'recovered-key-session', run_id: 1};
  await t.repository.append(previous.revision, {key: 'checkpoint-maintenance', state: previous.state,
    job: null, records: [], observed_at: new Date(t.now()).toISOString()});
  assert.equal(await t.repository.ownedRefreshSession('recovered-key-session'), 1);
  assert.equal(await t.repository.ownedRefreshSession('original-key-session'), 1);
  assert.equal((await t.repository.ownedRefreshRun(1)).reason, 'recovered_checkpoint');
  assert.equal(t.requests.length, 0);
});
