import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createOwnedPriceEngine, OWNED_PRICE_LIMITS} from '../tgcloud/lib/owned-price-engine.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';

const ctx = {initData: {user: {id: 12345}}};
const address = n => `0:${n.toString(16).padStart(64, '0')}`;
const wallet = address(1), nft = address(2), collection = address(3), holder = address(4);
const row = (n = nft, extra = {}) => ({kind: 'portfolio', key: n, observed_at: '2026-10-09T12:00:00Z', record: {nft_address: n, collection_address: collection, is_portfolio: true, ...extra}});
const response = (body, status = 200, retryAfter = null, extra = {}) => ({status, headers: {get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null}, text: async () => typeof body === 'string' ? body : JSON.stringify(body), ...extra});
const nftItem = (extra = {}) => ({address: nft, collection_address: collection, owner_address: holder, init: true, last_transaction_lt: '100', ...extra});
const accountItem = (extra = {}) => ({address: holder, status: 'active', last_transaction_lt: '99', code_boc: 'BOC-not-carried', data_boc: 'DATA-not-carried', ...extra});
const nftPage = (items = [nftItem()]) => response({nft_items: items});
const accountPage = (items = [accountItem()]) => response({accounts: items});
const decoded = (extra = {}) => ({verified: true, reason: 'verified_rental_owner', owner: wallet, nft, holding_contract: holder, code_hash: 'a'.repeat(64), data_hash: 'b'.repeat(64), code_hash_verified: true, data_hash_verified: true, decoder_version: 'fixture-v1', configured_price_per_day_raw: '170000000', price_per_day_raw: '900000000', rental_state: 'idle_rental_contract', ...extra});

function setup(responses = [], options = {}) {
  let time = Date.parse('2026-10-09T12:00:00Z'); const requests = [];
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL); CREATE TABLE collector_state(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)');
  const db = {async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};}, async get(sql, params = {}) {return database.prepare(sql).get(params) || null;}, async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db);
  const deps = {repository, ownerTelegramId: 12345, now: () => time, decodeContract: () => decoded(), fetch: async (url, options) => {requests.push({url, options}); const next = responses.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(); if (!next) throw new Error('Missing mock response'); return next;}, ...options};
  const env = {engine: createOwnedPriceEngine(deps), deps, repository, database, requests, advance: ms => time += ms, now: () => time};
  env.seed = async (records = [row()], state = {}) => {
    const previous = await repository.read();
    await repository.append(previous.revision, {key: `seed:${previous.revision}`, state: {...previous.state, ...state}, job: null, records: [{kind: 'settings', record: {wallet}}, ...records], observed_at: new Date(time).toISOString()});
  };
  env.prices = async () => (await repository.records()).filter(record => record.kind === 'owned_price');
  return env;
}
const start = async (t, id = 'page-session-0001') => t.engine.start(ctx, {session_id: id});
const step = async (t, id = 1) => t.engine.step(ctx, {run_id: id});
async function complete(t, count = 3) {let status; for (let i = 0; i < count; i++) {status = await step(t); t.advance(1000);} return status;}

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
  const raw1 = t.database.prepare('SELECT raw_body,state_json,job_id,job_json FROM cloud_events WHERE raw_body IS NOT NULL').get();
  assert.equal(JSON.parse(raw1.state_json).owned_prices.run.stage, 'accounts'); assert.equal(JSON.parse(raw1.raw_body).body, JSON.stringify({nft_items: [nftItem()]}));
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
  const final = t.database.prepare('SELECT records_json,state_json,raw_body FROM cloud_events WHERE raw_body IS NOT NULL ORDER BY sequence DESC LIMIT 1').get();
  assert.equal(JSON.parse(final.records_json)[0].record.verified, true); assert.equal(JSON.parse(final.state_json).owned_prices.run.state, 'complete');
});

test('session start replay and parallel starts join one run, including completed session replay', async () => {
  const t = setup([nftPage([nftItem({owner_address: wallet})])]); await t.seed();
  const results = await Promise.all([start(t), start(t), start(t, 'other-page-session')]);
  assert.deepEqual(results.map(result => result.run.id), [1, 1, 1]);
  assert.equal((await t.repository.read()).state.owned_prices.sessions.length, 2);
  await step(t); const original = await start(t); assert.equal(original.run.state, 'complete'); assert.equal(original.run.id, 1);
  const fresh = await start(t, 'fresh-page-session'); assert.equal(fresh.run.id, 2);
  assert.equal((await start(t)).run.id, 1); assert.equal((await start(t)).run.state, 'complete');
  assert.equal((await step(t, 1)).run.state, 'complete'); assert.equal(t.requests.length, 1);
});

test('empty scope and missing wallet use no network and do not enroll candidates', async () => {
  const t = setup(); await t.seed([row(nft, {is_portfolio: false})]);
  assert.equal((await start(t)).run.state, 'complete'); assert.equal((await start(t)).run.total, 0);
  const s = setup(); await s.seed([row(), {kind: 'settings', record: {wallet: null}}]);
  assert.equal((await start(s)).run.reason, 'wallet_not_configured');
  assert.equal((await step(s)).run.state, 'partial'); assert.equal(s.requests.length, 0);
});

test('direct holdings, missing NFT, malformed NFT and wrong collection remain unresolved with no account fetch', async () => {
  for (const [items, reason] of [[[nftItem({owner_address: wallet})], 'held_directly'], [[], 'nft_missing'], [[nftItem({init: false})], 'invalid_nft_state'], [[nftItem({last_transaction_lt: 100})], 'invalid_nft_state'], [[nftItem({collection_address: address(999)})], 'collection_mismatch']]) {
    const t = setup([nftPage(items)]); await t.seed(); await start(t); const done = await step(t);
    assert.equal(done.run.state, 'complete'); assert.equal(done.run.unresolved, 1); assert.equal(done.run.updated, 0); assert.equal(t.requests.length, 1);
    const record = (await t.prices())[0].record; assert.equal(record.reason, reason); assert.equal(Object.hasOwn(record, 'configured_price_per_day_raw'), false);
    assert.deepEqual((await t.repository.records()).map(row => row.kind), ['settings', 'portfolio', 'owned_price']);
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
  const t = setup([nftPage(batch), accountPage(), nftPage(batch), nftPage([nftItem({address: address(60), owner_address: wallet})])], {decodeContract: (_account, n) => decoded({nft: n})});
  await t.seed(gifts); await start(t); let status = await complete(t, 4);
  assert.equal(status.run.state, 'complete'); assert.equal(status.run.total, 51); assert.equal(status.run.updated, 50); assert.equal(status.run.unresolved, 1);
  assert.equal(new URL(t.requests[0].url).searchParams.getAll('address').length, 50); assert.equal(new URL(t.requests[1].url).searchParams.getAll('address').length, 1);
  assert.equal(new Set((await t.prices()).map(row => row.key)).size, 51);
});

test('provider pacing and Retry-After survive new instances and repeated steps without implicit requests', async () => {
  const t = setup([response({}, 429, '10'), nftPage([nftItem({owner_address: wallet})])]); await t.seed(); await start(t);
  const first = await step(t); assert.equal(first.run.reason, 'retry_wait'); assert.equal(first.next_allowed_at, t.now() + 10000);
  t.engine = createOwnedPriceEngine(t.deps); await step(t); t.advance(9999); await step(t); assert.equal(t.requests.length, 1);
  t.advance(1); assert.equal((await step(t)).run.state, 'complete'); assert.equal(t.requests.length, 2);
  const ledger = (await t.repository.read()).state.owned_prices; assert.equal(ledger.attempts.length, 2);
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
  const t = setup([() => pending]); await t.seed(); await start(t);
  const first = step(t); while (t.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  const parallel = await step(t); assert.equal(parallel.run.checked, 0); assert.equal(t.requests.length, 1);
  release(nftPage([nftItem({owner_address: wallet})])); assert.equal((await first).run.checked, 1);
  await step(t); assert.equal(t.requests.length, 1); assert.equal((await t.prices()).length, 1);
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
  const t = setup([() => pending, nftPage([nftItem({owner_address: wallet})])], {limits: {lease_ms: 30000}}); await t.seed(); await start(t);
  const first = step(t); while (t.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
  t.advance(30001); const recovered = await step(t); assert.equal(recovered.run.state, 'complete'); assert.equal(recovered.run.checked, 1);
  release(nftPage()); await first; assert.equal((await t.prices()).length, 1); assert.equal((await t.repository.read()).state.owned_prices.attempts.length, 2);
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
