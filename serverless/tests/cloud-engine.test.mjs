import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudEngine, parseCloudPage} from '../tgcloud/lib/cloud-engine.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';

const ctx = {initData: {user: {id: 12345}}};
const scope = `0:${'ab'.repeat(32)}`;
const token = 'private-fixture-token';
const listing = (overrides = {}) => ({nft_address: 'nft-a', nft_name: 'Gift #1', owner: 'owner', attributes: [{trait_type: 'Model', value: 'Red'}, {trait_type: 'Backdrop', value: 'Black'}], min_duration: 3600, max_duration: 86400, price_per_day: '170000000', discount_per_day: 0, listed_at: null, ...overrides});
const history = (ts, overrides = {}) => ({address: 'nft-a', name: 'Gift #1', collection_address: scope, ts, src: 'from', dst: 'to', price: '0.17', price_nano: '170000000', currency: 'GRAM', duration: 86400, ...overrides});
const catalog = [{address: scope, name: 'Gifts', extra_data: {}}];
const response = (body, status = 200, retryAfter = null) => ({status, headers: {get: () => retryAfter}, text: async () => typeof body === 'string' ? body : JSON.stringify(body)});
const page = (cursor = null, items = [listing()]) => response({cursor, items});
function setup(responses = [], options = {}) {
  let clock = Date.parse('2026-10-09T12:00:00Z'); const requests = [];
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL)');
  database.exec('CREATE TABLE collector_state(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)');
  const db = {async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};}, async get(sql, params = {}) {return database.prepare(sql).get(params) || null;}, async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db);
  const deps = {repository, ownerTelegramId: 12345, marketappToken: token, now: () => clock, random: () => 0, fetch: async (url, options) => {requests.push({url, options}); const next = responses.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(); if (!next) throw new Error('Missing mock response'); return next;}, ...options};
  return {engine: createCloudEngine(deps), deps, repository, database, requests, advance: ms => clock += ms, now: () => clock};
}
const seed = async (t, records = []) => t.engine.importChunk(ctx, {import_id: 'seed', chunk_id: '0', records: [
  {kind: 'portfolio', key: 'gift-a', observed_at: new Date(t.now()).toISOString(), record: {id: 'nft-a', nft_address: 'nft-a', collection_address: scope, is_portfolio: true, membership_sources: ['verified_ton'], uncertainties: []}},
  {kind: 'settings', key: 'wallet', observed_at: new Date(t.now()).toISOString(), record: {wallet: 'owner'}}, ...records]});
const start = async (t, kind = 'prices', extra = {}) => (await t.engine.startJob(ctx, {kind, ...extra})).job.id;
const step = async (t, id) => (await t.engine.stepJob(ctx, {job_id: id})).job;

test('all cloud endpoints authorize before any storage or provider access', async () => {
  let reads = 0;
  const t = setup([], {repository: {read: async () => {reads++;}}});
  for (const method of ['getDashboard', 'getJobs', 'startJob', 'stepJob', 'stopJob', 'resumeJob', 'importChunk']) await assert.rejects(t.engine[method]({}, {}), /Private access denied/);
  assert.equal(reads, 0); assert.equal(t.requests.length, 0);
});

test('imports are bounded, atomic, idempotent, and reject changed replays', async () => {
  const t = setup(); const result = await seed(t); assert.equal(result.imported, 2);
  assert.equal((await seed(t)).already_committed, true);
  assert.equal((await t.repository.records()).length, 2);
  await assert.rejects(seed(t, [{kind: 'metadata', key: 'extra', observed_at: new Date(t.now()).toISOString(), record: {}}]), /different content/);
  await assert.rejects(t.engine.importChunk(ctx, {import_id: 'bad', chunk_index: 0, records: Array.from({length: 251}, () => ({}))}), /Invalid import/);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n, 1);
});

test('catalog and scoped listing traversal use exact GET routes, parameters and raw token', async () => {
  const t = setup([response(catalog), page('opaque /+=?&', []), page('', [listing()]), page(null, [])]); await seed(t); const id = await start(t);
  await step(t, id); assert.equal(t.requests[0].url, 'https://api.marketapp.org/v1/collections/gifts/');
  await step(t, id); assert.equal(t.requests.length, 1);
  for (let i = 0; i < 3; i++) {t.advance(1000); await step(t, id);}
  const jobs = await t.engine.getJobs(ctx); assert.equal(jobs.jobs[0].state, 'complete');
  assert.equal(jobs.jobs[0].progress.pages, 4);
  for (const request of t.requests) {assert.equal(request.options.method, 'GET'); assert.equal(request.options.headers.Authorization, token); assert.equal(request.options.redirect, 'error');}
  const url = new URL(t.requests[2].url); assert.equal(url.pathname, '/v1/rent/gifts/'); assert.equal(url.searchParams.get('cursor'), 'opaque /+=?&');
  assert.equal(url.searchParams.get('collection_address'), scope); assert.equal(url.searchParams.get('sort_by'), 'recently_touch'); assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(new URL(t.requests[3].url).searchParams.get('cursor'), '');
  const records = await t.repository.records(); assert.equal(records.filter(r => r.kind === 'listing').length, 1);
});

test('valid page evidence and next checkpoint are one append; crash recovery reuses committed cursor', async () => {
  const t = setup([response(catalog), page('A'), page(null)]); await seed(t); const id = await start(t);
  await step(t, id); t.advance(1000); await step(t, id);
  const row = t.database.prepare("SELECT * FROM cloud_events WHERE raw_body IS NOT NULL ORDER BY sequence DESC LIMIT 1").get();
  assert.equal(JSON.parse(row.job_json).streams[1].cursor, 'A'); assert.equal(JSON.parse(row.records_json)[0].record.identity, 'nft-a'); assert.equal(JSON.parse(JSON.parse(row.raw_body).body).cursor, 'A');
  t.engine = createCloudEngine(t.deps); t.advance(1000); await t.engine.resumeJob(ctx, {job_id: id}); assert.equal((await step(t, id)).state, 'complete');
  assert.equal(new URL(t.requests.at(-1).url).searchParams.get('cursor'), 'A');
});

test('malformed responses retain raw evidence without advancing progress and redact secrets', async () => {
  const t = setup([response(catalog), response(`not json ${token}`)]); await seed(t); const id = await start(t); await step(t, id); t.advance(1000);
  const failed = await step(t, id); assert.equal(failed.state, 'failed');
  const {state} = await t.repository.read(); assert.equal(state.job.streams[1].started, false); assert.equal(state.job.pages, 1);
  const raw = t.database.prepare('SELECT raw_body FROM cloud_events WHERE raw_body IS NOT NULL ORDER BY sequence DESC LIMIT 1').get().raw_body;
  assert.equal(raw.includes(token), false); assert.ok(raw.includes('[REDACTED]'));
});

test('cursor cycles fail while keeping committed history and overlapping occurrences', async () => {
  const t = setup([response(catalog), page('A'), page('B'), page('A')]); await seed(t); const id = await start(t);
  for (let i = 0; i < 4; i++) {await step(t, id); t.advance(1000);}
  const {state} = await t.repository.read(); assert.equal(state.job.reason, 'cursor_cycle'); assert.equal(state.job.streams[1].cursor, 'B');
  assert.equal((await t.repository.records()).filter(r => r.kind === 'listing').length, 2);
});

test('history uses documented parameters and crosses a strict lower boundary preserving equal ties', async () => {
  const t = setup(); const since = Math.floor(t.now() / 1000) - 30 * 86400;
  const responses = [response(catalog), response({cursor: 'A', items: [history(since)]}), response({cursor: 'B', items: [history(since)]}), response({cursor: 'C', items: [history(since - 1)]})];
  t.deps.fetch = async (url, options) => {t.requests.push({url, options}); return responses.shift();}; t.engine = createCloudEngine(t.deps);
  await seed(t); const id = await start(t, 'rental_prices');
  for (let i = 0; i < 4; i++) {await step(t, id); t.advance(1000);}
  const {state} = await t.repository.read(); assert.equal(state.job.state, 'complete'); assert.equal(state.job.streams[1].completion_reason, 'timeframe_covered'); assert.equal(state.job.streams[1].cursor, 'C');
  const url = new URL(t.requests[1].url); assert.equal(url.pathname, '/v1/rent/gifts/history/'); assert.equal(url.searchParams.get('order_by'), 'new_to_old'); assert.equal(url.searchParams.has('date_from'), false);
});

test('history ordering anomalies disable early cutoff, and empty continuation pages progress', async () => {
  const t = setup(); const since = Math.floor(t.now() / 1000) - 30 * 86400;
  const responses = [response(catalog), response({cursor: 'A', items: [history(since - 2), history(since - 1)]}), response({cursor: 'B', items: []}), response({cursor: null, items: []})];
  t.deps.fetch = async () => responses.shift(); t.engine = createCloudEngine(t.deps); await seed(t); const id = await start(t, 'rental_prices');
  await step(t, id); t.advance(1000); assert.equal((await step(t, id)).state, 'running'); t.advance(1000); assert.equal((await step(t, id)).state, 'running');
  t.advance(1000); assert.equal((await step(t, id)).state, 'complete'); assert.equal((await t.repository.read()).state.job.streams[1].ordered, false);
});

test('request caps count catalog/retries and rolling budget survives Resume and new engines', async () => {
  const t = setup([response(catalog), page('A'), page('B'), page(null)], {limits: {invocation_attempts: 2, daily_attempts: 3}}); await seed(t); const id = await start(t);
  await step(t, id); t.advance(1000); const paused = await step(t, id); assert.equal(paused.state, 'partial'); assert.equal(paused.progress.marketapp_budget.invocation_used, 2);
  assert.equal((await t.repository.read()).state.job.streams[1].cursor, 'A', 'final permitted page commits');
  t.engine = createCloudEngine(t.deps); await t.engine.resumeJob(ctx, {job_id: id}); t.advance(1000); const daily = await step(t, id); assert.equal(daily.state, 'partial'); assert.equal(daily.progress.marketapp_budget.rolling_24h_used, 3);
  await t.engine.resumeJob(ctx, {job_id: id}); await step(t, id); assert.equal(t.requests.length, 3);
  t.advance(86400000); await t.engine.resumeJob(ctx, {job_id: id}); assert.equal((await step(t, id)).state, 'complete');
});

test('Retry-After beyond duration pauses with provider-wide deadline preserved on Resume', async () => {
  const t = setup([response({}, 429, '600'), response(catalog)]); await seed(t); const id = await start(t);
  const paused = await step(t, id); assert.equal(paused.state, 'partial'); assert.equal(paused.progress.next_allowed_at, t.now() + 600000);
  const resumed = await t.engine.resumeJob(ctx, {job_id: id}); assert.equal(resumed.job.state, 'partial'); await step(t, id); assert.equal(t.requests.length, 1);
  t.advance(600000); await t.engine.resumeJob(ctx, {job_id: id}); await step(t, id); assert.equal(t.requests.length, 2);
});

test('duration cap stops prompt browser continuation without a provider call', async () => {
  const t = setup([response(catalog)]); await seed(t); const id = await start(t); t.advance(300000);
  assert.equal((await step(t, id)).state, 'partial'); assert.equal(t.requests.length, 0);
});

test('retries exhaust at four attempts and auth failures stop immediately', async () => {
  const t = setup([new Error(token), response({}, 503), response({}, 429), new Error(token)]); await seed(t); const id = await start(t);
  for (let i = 0; i < 4; i++) {await step(t, id); t.advance(30000);}
  assert.equal((await t.repository.read()).state.job.reason, 'retry_exhausted'); assert.equal(t.requests.length, 4);
  const a = setup([response({}, 401)]); await seed(a); const aid = await start(a); assert.equal((await step(a, aid)).state, 'failed'); await step(a, aid); assert.equal(a.requests.length, 1);
});

test('Stop fences an in-flight response and preserves its provider cooldown', async () => {
  let deliver; const pending = new Promise(resolve => {deliver = resolve;});
  const t = setup([() => pending]); await seed(t); const id = await start(t); const work = step(t, id); await new Promise(resolve => setImmediate(resolve));
  await t.engine.stopJob(ctx, {job_id: id}); await assert.rejects(t.engine.resumeJob(ctx, {job_id: id}), /still in flight/);
  deliver(response({}, 429, '60')); const result = await work; assert.equal(result.state, 'partial'); assert.equal(result.progress.pages, 0); assert.equal(result.progress.next_allowed_at, t.now() + 60000);
  assert.equal((await t.repository.records()).length, 2);
});

test('read-only reopen reports explicit continuation without provider access', async () => {
  const t = setup([response(catalog)]); await seed(t); const id = await start(t); await step(t, id);
  const read = await t.engine.getJobs(ctx); assert.equal(read.jobs[0].state, 'running'); assert.equal(read.jobs[0].progress.requires_resume, true); assert.equal(t.requests.length, 1);
  t.advance(400000); await t.engine.getJobs(ctx); assert.equal(t.requests.length, 1);
});

test('timeframe validation and frozen Resume reject incompatible inputs', async () => {
  const t = setup(); await seed(t);
  for (const timeframe of ['all', '365d']) await assert.rejects(start(t, 'rental_prices', {timeframe}));
  await assert.rejects(start(t, 'rental_prices', {timeframe: 'custom', date_from: '2020-01-01', date_to: '2020-01-03'}));
  const id = await start(t, 'rental_prices', {timeframe: '60d'}); await t.engine.stopJob(ctx, {job_id: id});
  await assert.rejects(t.engine.resumeJob(ctx, {job_id: id, timeframe: '30d'}), /saved collection parameters/);
  t.advance(100 * 86400000); const resumed = await t.engine.resumeJob(ctx, {job_id: id}); assert.equal(resumed.job.collection_window.timeframe, '60d'); assert.equal(resumed.job.state, 'running');
});

test('schema retains empty statistics, required nullable fields, and absent history fields exactly', () => {
  assert.equal(parseCloudPage('collection', JSON.stringify(catalog), null, 'time', 'test').records[0].record.source_json.extra_data.floor, undefined);
  const result = parseCloudPage('history', JSON.stringify({cursor: null, items: [history(1)]}), scope, 'time', 'test'); assert.equal(Object.hasOwn(result.records[0].record.source_json, 'tx_hash'), false);
  const missing = listing(); delete missing.listed_at; assert.throws(() => parseCloudPage('listing', JSON.stringify({cursor: null, items: [missing]}), scope, 'time', 'test'));
});

test('prototype records remain untouched and recent attempts/cooldown are inherited conservatively', async () => {
  const t = setup([response(catalog)], {limits: {daily_attempts: 3}});
  const legacy = {version: 1, provider_next_allowed_at: t.now() + 60000, runs: [{attempts: 2, updated_at: t.now() - 1000, pages: [{raw_body: 'preserved'}]}]};
  t.database.prepare('INSERT INTO collector_state VALUES(1,7,?)').run(JSON.stringify(legacy));
  await seed(t); const id = await start(t); await step(t, id); assert.equal(t.requests.length, 0);
  t.advance(60000); const result = await step(t, id); assert.equal(result.state, 'partial'); assert.equal(result.progress.marketapp_budget.rolling_24h_used, 3);
  assert.deepEqual(JSON.parse(t.database.prepare('SELECT document FROM collector_state').get().document), legacy);
});

test('simultaneous steps reserve one durable attempt and one request', async () => {
  let deliver; const pending = new Promise(resolve => {deliver = resolve;});
  const t = setup([() => pending]); await seed(t); const id = await start(t);
  const a = step(t, id), b = step(t, id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.requests.length, 1); deliver(response(catalog)); await Promise.all([a, b]);
  assert.equal((await t.repository.read()).state.attempts.length, 1);
});

test('expired request cannot publish after a replacement lease; attempt remains counted', async () => {
  let deliver; const pending = new Promise(resolve => {deliver = resolve;});
  const t = setup([() => pending, response(catalog)]); await seed(t); const id = await start(t);
  const stale = step(t, id); await new Promise(resolve => setImmediate(resolve));
  t.advance(121000); await t.engine.resumeJob(ctx, {job_id: id}); await step(t, id);
  deliver(response([{address: 'wrong', name: 'late', extra_data: {}}])); await stale;
  const {state} = await t.repository.read(); assert.equal(state.job.pages, 1); assert.equal(state.attempts.length, 2);
  assert.equal((await t.repository.records()).filter(r => r.kind === 'collection')[0].record.identity, scope);
});

test('fresh jobs start at the head, preserve page evidence, and share cross-job pacing', async () => {
  const t = setup([response(catalog), page(null), response(catalog)]); await seed(t); const first = await start(t);
  await step(t, first); t.advance(1000); await step(t, first);
  const second = await start(t); await step(t, second); assert.equal(t.requests.length, 2);
  t.advance(1000); await step(t, second); assert.equal(t.requests.length, 3); assert.equal((await t.engine.getJobs(ctx)).jobs.length, 2);
  assert.equal((await t.repository.records()).filter(r => r.kind === 'listing').length, 1);
});

test('collection scopes deduplicate TON aliases and exclude unresolved candidates', async () => {
  const t = setup();
  // Zero raw TON account and its public bounceable mainnet spelling.
  const raw = `0:${'00'.repeat(32)}`, friendly = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
  await seed(t, [
    {kind: 'portfolio', key: 'b', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'b', collection_address: raw, is_portfolio: true}},
    {kind: 'portfolio', key: 'c', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'c', collection_address: friendly, is_portfolio: true}},
    {kind: 'portfolio', key: 'd', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'd', collection_address: 'unverified', is_portfolio: false}},
    {kind: 'portfolio', key: 'e', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'e', collection_address: null, is_portfolio: true}},
  ]);
  const id = await start(t); const job = await t.repository.job(id); assert.equal(job.scopes.length, 2); assert.equal(job.unresolved_collections, 1);
});

test('catalog refresh failures stop new runs and never silently reuse old catalog', async () => {
  const t = setup([response(catalog), page(null), response({}, 401)]); await seed(t); const first = await start(t);
  await step(t, first); t.advance(1000); await step(t, first); const second = await start(t);
  t.advance(1000); assert.equal((await step(t, second)).state, 'failed');
  assert.equal((await t.repository.job(second)).pages, 0); assert.equal((await t.repository.records()).filter(r => r.kind === 'collection').length, 1);
});

test('dashboard read projects committed records without any HTTP request', async () => {
  const t = setup(); await seed(t);
  const result = await t.engine.getDashboard(ctx, {source: 'listings', timeframe: '30d'});
  assert.equal(result.summary.portfolio_count, 1); assert.equal(result.capabilities.marketapp_limits.used_24h, 0); assert.equal(t.requests.length, 0);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('SQL chunk reads traverse more than one batch without dropping records', async () => {
  const t = setup();
  for (let i = 0; i < 23; i++) await t.engine.importChunk(ctx, {import_id: 'chunks', chunk_id: String(i), records: [{kind: 'settings', key: `row-${i}`, observed_at: new Date(t.now()).toISOString(), record: {test: i}}]});
  assert.equal((await t.repository.records()).length, 23);
});

test('CAS retry reloads a non-current saved job instead of rewinding its cursor', async () => {
  const t = setup([response(catalog), page('A')]); await seed(t); const old = await start(t);
  await step(t, old); t.advance(1000); await step(t, old); await t.engine.stopJob(ctx, {job_id: old});
  const other = await start(t); await t.engine.stopJob(ctx, {job_id: other});
  const append = t.repository.append; let interfered = false;
  t.repository.append = async (expected, event) => {
    if (!interfered && event.job?.id === old) {
      interfered = true;
      const current = await t.repository.read(), advanced = await t.repository.job(old);
      advanced.streams[1].cursor = 'B'; advanced.streams[1].cursors.push('B');
      await append(expected, {key: 'simulated-concurrent-old-job', state: current.state, job: advanced, records: [], observed_at: new Date(t.now()).toISOString()});
      return false;
    }
    return append(expected, event);
  };
  await t.engine.resumeJob(ctx, {job_id: old});
  assert.equal((await t.repository.read()).state.job.streams[1].cursor, 'B');
});

test('catalog known statistics enforce documented types while preserving null and empty objects', () => {
  for (const extra_data of [{items: 'bad'}, {owners: false}, {rent_floor: []}, {volume7d: 3}]) assert.throws(() => parseCloudPage('collection', JSON.stringify([{...catalog[0], extra_data}]), null, 'time', 'test'));
  for (const extra_data of [{}, {items: null, rent_floor: null}, {items: 0, rent_floor: '0.1'}]) assert.deepEqual(parseCloudPage('collection', JSON.stringify([{...catalog[0], extra_data}]), null, 'time', 'test').records[0].record.source_json.extra_data, extra_data);
});

test('frozen JavaScript time cannot shorten Retry-After measured at response completion', async () => {
  const frozen = Date.parse('2026-10-09T12:00:00Z'); let wall = frozen;
  const t = setup([() => {wall += 30000; return response({}, 429, '60');}, response(catalog)], {now: () => frozen, clock: async () => wall});
  await seed(t); const id = await start(t);
  const waiting = await step(t, id);
  assert.equal(waiting.progress.next_allowed_at, frozen + 90000);
  assert.equal(waiting.progress.server_time, frozen + 30000);
  wall = frozen + 89000; await step(t, id); assert.equal(t.requests.length, 1);
  wall = frozen + 90000; await step(t, id); assert.equal(t.requests.length, 2);
});

test('trusted clock fences a late response even when V8 Date.now is frozen', async () => {
  const frozen = Date.parse('2026-10-09T12:00:00Z'); let wall = frozen;
  const t = setup([() => {wall += 121000; return response(catalog);}], {now: () => frozen, clock: async () => wall});
  await seed(t); const id = await start(t); await step(t, id);
  const {state} = await t.repository.read();
  assert.equal(state.job.pages, 0); assert.equal(state.job.lease_until, 0); assert.equal(state.attempts.length, 1);
  assert.equal((await t.repository.records()).filter(row => row.kind === 'collection').length, 0);
});

test('trusted clock is monotonic and failure does not fall back to a stale JavaScript timestamp', async () => {
  const frozen = Date.parse('2026-10-09T12:00:00Z'); let wall = frozen;
  const t = setup([response(catalog)], {now: () => frozen, clock: async () => wall});
  await seed(t); const id = await start(t); await step(t, id);
  wall -= 5000; const backward = await step(t, id); assert.equal(backward.progress.server_time, frozen); assert.equal(t.requests.length, 1);
  wall = null; await assert.rejects(step(t, id), /trusted server clock/); assert.equal(t.requests.length, 1);
});

test('SQL clock returns millisecond wall time and rejects unavailable values', async () => {
  const t = setup(), before = Date.now();
  const current = await t.repository.clock();
  assert.ok(current >= before && current <= Date.now());
  await assert.rejects(createCloudRepository({get: async () => ({server_time: null})}).clock(), /Server clock unavailable/);
});

test('reservation latency cannot launch a provider request past the trusted invocation deadline', async () => {
  const frozen = Date.parse('2026-10-09T12:00:00Z'); let wall = frozen;
  const t = setup([], {now: () => frozen, clock: async () => wall});
  await seed(t); const id = await start(t);
  const append = t.repository.append;
  t.repository.append = async (revision, event) => {
    const result = await append(revision, event);
    if (event.state.job?.lease) wall += 301000;
    return result;
  };
  assert.equal((await step(t, id)).state, 'partial'); assert.equal(t.requests.length, 0);
});
