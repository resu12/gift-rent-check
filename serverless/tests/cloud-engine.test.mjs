import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudEngine, parseCloudPage, CLOUD_LIMITS} from '../tgcloud/lib/cloud-engine.js';
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
  assert.equal(url.searchParams.get('collection_address'), scope); assert.equal(url.searchParams.get('sort_by'), 'recently_touch'); assert.equal(url.searchParams.get('limit'), '100');
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
  const after = Date.now();
  // SQLite and V8 quantize separate OS clock reads to milliseconds. Their
  // rounding boundaries can differ by one tick, including on Windows.
  assert.ok(Number.isSafeInteger(current));
  assert.ok(current >= before - 1 && current <= after + 1,
    `SQLite clock ${current} was outside the JavaScript interval [${before}, ${after}] by more than 1 ms`);
  await assert.rejects(createCloudRepository({get: async () => ({server_time: null})}).clock(), /Server clock unavailable/);
});

test('SQL clock preserves the millisecond part instead of rounding to whole seconds', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    const fixed = '2026-10-09T12:00:00.789Z';
    const repository = createCloudRepository({get: async sql => database.prepare(sql.replaceAll("'now'", `'${fixed}'`)).get()});
    assert.equal(await repository.clock(), Date.parse(fixed));
  } finally {
    database.close();
  }
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

const daySeconds = 86400;
const historyResponse = (cursor, timestamps) => response({cursor, items: timestamps.map(value => typeof value === 'number' ? history(value) : value)});
const advanceStep = async (t, id) => {t.advance(1000); return step(t, id);};
const editState = async (t, edit) => {
  const {revision, state} = await t.repository.read(); edit(state);
  assert.equal(await t.repository.append(revision, {key: `edit:${revision}`, state, job: state.job, records: [], observed_at: new Date(t.now()).toISOString()}), true);
};

test('100-record listing and history pages preserve exact payloads and unchanged request budgets', async () => {
  const rows = Array.from({length: 100}, (_, i) => listing({nft_address: `0:${i.toString(16).padStart(64, '0')}`, nft_name: `Low Rider #${i}`, photo_url: `https://example.invalid/gift-${i}.webp`}));
  const ts = Math.floor(Date.parse('2026-10-09T12:00:00Z') / 1000);
  const rentals = Array.from({length: 100}, (_, i) => history(ts - i * 60, {address: rows[i].nft_address, tx_hash: `hash-${i}`}));
  const t = setup([response(catalog), page(null, rows), historyResponse(null, rentals)]); await seed(t);
  const id = await start(t, 'collect'); await step(t, id); await advanceStep(t, id); assert.equal((await advanceStep(t, id)).state, 'complete');
  const records = await t.repository.records();
  assert.deepEqual(records.filter(r => r.kind === 'listing').map(r => r.record.source_json), rows);
  assert.deepEqual(records.filter(r => r.kind === 'history').map(r => r.record.source_json), rentals);
  assert.equal(t.requests.length, 3);
  for (const request of t.requests.slice(1)) {assert.equal(new URL(request.url).searchParams.get('limit'), '100'); assert.equal(request.options.headers.Authorization, token);}
  assert.equal(CLOUD_LIMITS.invocation_attempts, 100); assert.equal(CLOUD_LIMITS.daily_attempts, 500); assert.equal(CLOUD_LIMITS.interval_ms, 1000); assert.equal(CLOUD_LIMITS.response_bytes, 1048576);
});

test('oversized raw and normalized page bodies fail without records, cursor or coverage advancing', async () => {
  for (const normalized of [false, true]) {
    const body = JSON.stringify({cursor: 'unsafe', items: [listing({nft_name: 'x'.repeat(normalized ? 400 : CLOUD_LIMITS.response_bytes)})]});
    const cap = normalized ? Buffer.byteLength(body) + 1 : CLOUD_LIMITS.response_bytes;
    if (normalized) assert.ok(Buffer.byteLength(JSON.stringify(parseCloudPage('listing', body, scope, 'time', 'test').records)) > cap);
    const t = setup([response(catalog), response(body)], {limits: {response_bytes: cap}}); await seed(t); const id = await start(t);
    await step(t, id); assert.equal((await advanceStep(t, id)).state, 'failed');
    const {state} = await t.repository.read();
    assert.equal(state.job.reason, 'response_too_large'); assert.equal(state.job.streams[1].cursor, null); assert.equal(state.job.streams[1].started, false); assert.equal(state.job.pages, 1); assert.equal(state.history_coverage, undefined);
    assert.equal((await t.repository.records()).filter(r => r.kind === 'listing').length, 0);
    assert.equal(state.attempts.length, 2);
  }
});

test('a completed full history scan enables fewer requests with strict 48-hour overlap and changed variants retained', async () => {
  const responses = []; const t = setup(responses); await seed(t); const firstAt = Math.floor(t.now() / 1000);
  responses.push(response(catalog), ...[1, 7, 14, 21, 29, 31].map((days, i) => historyResponse(`full-${i}`, [history(firstAt - days * daySeconds, {tx_hash: 'repeated-link'})])));
  const first = await start(t, 'rental_prices');
  for (let i = 0; i < 7; i++) await advanceStep(t, first);
  const baseline = (await t.repository.read()).state.history_coverage[scope];
  assert.equal(baseline.checked_through, firstAt); assert.equal(baseline.full_scan_at, firstAt); assert.equal(baseline.source.job_id, first);
  t.advance(3600000); const secondAt = Math.floor(t.now() / 1000), edge = firstAt - 2 * daySeconds;
  const changed = history(firstAt - daySeconds, {tx_hash: 'repeated-link', price: '0.25', price_nano: '250000000'});
  responses.push(response(catalog), historyResponse('overlap-a', [changed, history(edge)]), historyResponse('overlap-b', [edge]), historyResponse('overlap-c', [edge - 1]));
  const second = await start(t, 'rental_prices');
  assert.deepEqual((await t.engine.getJobs(ctx)).jobs[0].progress.history_refresh, {full_streams: 0, incremental_streams: 1, overlap_seconds: 172800, full_scan_interval_seconds: 604800});
  await advanceStep(t, second); assert.equal((await advanceStep(t, second)).state, 'running'); assert.equal((await advanceStep(t, second)).state, 'running'); assert.equal((await advanceStep(t, second)).state, 'complete');
  const state = (await t.repository.read()).state;
  assert.equal(state.job.streams[1].completion_reason, 'incremental_history_covered');
  assert.equal(state.history_coverage[scope].checked_through, secondAt); assert.equal(state.history_coverage[scope].full_scan_at, firstAt);
  assert.equal(state.job.invocation_used, 4); assert.equal((await t.repository.job(first)).invocation_used, 7);
  const saved = (await t.repository.records()).filter(r => r.kind === 'history').map(r => r.record.source_json);
  assert.ok(saved.some(item => item.price === '0.17' && item.ts === changed.ts)); assert.ok(saved.some(item => item.price === '0.25' && item.ts === changed.ts));
  assert.equal(saved.filter(item => item.ts === edge).length, 2, 'equal-boundary occurrences are retained across pages');
  assert.equal(t.requests.slice(8).every(r => !new URL(r.url).searchParams.has('date_from')), true);
});

test('seven-day reconciliation uses the last full pass even after daily incremental advances', async () => {
  const responses = [], t = setup(responses); await seed(t); const firstAt = Math.floor(t.now() / 1000);
  responses.push(response(catalog), historyResponse(null, [])); let id = await start(t, 'rental_prices'); await step(t, id); await advanceStep(t, id);
  for (let d = 1; d < 7; d++) {
    t.advance(firstAt * 1000 + d * 86400000 - t.now()); responses.push(response(catalog), historyResponse(null, []));
    id = await start(t, 'rental_prices'); assert.equal((await t.repository.job(id)).streams[1].history_plan.mode, 'incremental');
    await step(t, id); await advanceStep(t, id); assert.equal((await t.repository.read()).state.history_coverage[scope].full_scan_at, firstAt);
  }
  t.advance(firstAt * 1000 + 7 * 86400000 - t.now()); id = await start(t, 'rental_prices');
  assert.equal((await t.repository.job(id)).streams[1].history_plan.mode, 'full');
  assert.equal((await t.repository.read()).state.history_coverage[scope].full_scan_at, firstAt, 'planning cannot promote an incomplete full pass');
});

test('widened windows, unknown collections and imported history require a full baseline', async () => {
  const responses = [], t = setup(responses); await seed(t, [{kind: 'history', key: 'import-history', observed_at: new Date(t.now()).toISOString(), record: {source_json: history(Math.floor(t.now() / 1000))}}]);
  let id = await start(t, 'rental_prices'); assert.equal((await t.repository.job(id)).streams[1].history_plan.mode, 'full');
  responses.push(response(catalog), historyResponse(null, [])); await step(t, id); await advanceStep(t, id);
  id = await start(t, 'rental_prices', {timeframe: '60d'}); assert.equal((await t.repository.job(id)).streams[1].history_plan.mode, 'full'); await t.engine.stopJob(ctx, {job_id: id});
  await t.engine.importChunk(ctx, {import_id: 'another-collection', chunk_index: 0, records: [{kind: 'portfolio', key: 'other-gift', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'other-gift', is_portfolio: true, collection_address: 'other-collection'}}]});
  id = await start(t, 'rental_prices'); const job = await t.repository.job(id);
  assert.equal(job.streams.find(s => s.scope === scope).history_plan.mode, 'incremental'); assert.equal(job.streams.find(s => s.scope === 'other-collection').history_plan.mode, 'full');
});

test('partial and unordered streams do not establish coverage, while independent completed scopes do', async () => {
  const responses = [], t = setup(responses); await seed(t, [{kind: 'portfolio', key: 'other', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'other', is_portfolio: true, collection_address: 'zz-other'}}]);
  const id = await start(t, 'rental_prices'), since = (await t.repository.job(id)).streams[1].history_plan.scan_since;
  responses.push(response(catalog), historyResponse(null, []), historyResponse('next', [since - 2, since - 1]), historyResponse(null, []));
  await step(t, id); await advanceStep(t, id);
  let state = (await t.repository.read()).state;
  assert.equal(state.job.state, 'running'); assert.equal(state.history_coverage[scope].source.job_id, id); assert.equal(state.history_coverage['zz-other'], undefined);
  assert.equal((await advanceStep(t, id)).state, 'running'); state = (await t.repository.read()).state;
  assert.equal(state.job.streams[2].ordered, false); assert.equal(state.history_coverage['zz-other'], undefined);
  assert.equal((await advanceStep(t, id)).state, 'complete'); assert.equal((await t.repository.read()).state.history_coverage['zz-other'], undefined);
});

test('crash/resume freezes history plan and promotes only with the final atomic page', async () => {
  const responses = [], t = setup(responses); await seed(t); const id = await start(t, 'rental_prices'), plan = (await t.repository.job(id)).streams[1].history_plan;
  responses.push(response(catalog), historyResponse('saved', [plan.checked_through]), historyResponse('past', [plan.scan_since - 1]));
  await step(t, id); await advanceStep(t, id); assert.equal((await t.repository.read()).state.history_coverage, undefined);
  await t.engine.stopJob(ctx, {job_id: id}); t.advance(86400000); t.engine = createCloudEngine(t.deps); await t.engine.resumeJob(ctx, {job_id: id});
  assert.deepEqual((await t.repository.job(id)).streams[1].history_plan, plan);
  assert.equal((await step(t, id)).state, 'complete'); assert.equal(new URL(t.requests.at(-1).url).searchParams.get('cursor'), 'saved');
  const row = t.database.prepare('SELECT * FROM cloud_events WHERE raw_body IS NOT NULL ORDER BY sequence DESC LIMIT 1').get();
  assert.equal(JSON.parse(row.state_json).history_coverage[scope].checked_through, plan.checked_through);
  assert.equal(JSON.parse(row.job_json).streams[1].complete, true); assert.equal(JSON.parse(row.records_json).length, 1);
});

test('CAS conflict retries final page commit without a second provider request or partial baseline', async () => {
  const t = setup([response(catalog), historyResponse(null, [])]); await seed(t); const id = await start(t, 'rental_prices'); await step(t, id);
  const append = t.repository.append; let conflicted = false;
  t.repository.append = async (revision, event) => {
    if (!conflicted && event.state.history_coverage) {
      conflicted = true; const current = await t.repository.read(); assert.equal(current.state.history_coverage, undefined);
      await append(revision, {key: 'concurrent-event', state: current.state, job: current.state.job, records: [], observed_at: new Date(t.now()).toISOString()}); return false;
    }
    return append(revision, event);
  };
  assert.equal((await advanceStep(t, id)).state, 'complete'); assert.equal(t.requests.length, 2);
  const rows = t.database.prepare('SELECT state_json,raw_body FROM cloud_events').all();
  assert.equal(rows.filter(row => JSON.parse(row.state_json).history_coverage).length, 1);
  assert.equal(rows.filter(row => row.raw_body && JSON.parse(row.raw_body).endpoint === '/v1/rent/gifts/history/').length, 1);
});

test('legacy resume retains ten-item pages and original window without creating a trusted baseline', async () => {
  const responses = [], t = setup(responses); await seed(t); const id = await start(t, 'rental_prices');
  await editState(t, state => {state.job.page_size = 10; for (const stream of state.job.streams) delete stream.history_plan;});
  await t.engine.stopJob(ctx, {job_id: id}); t.advance(1000); await t.engine.resumeJob(ctx, {job_id: id});
  responses.push(response(catalog), historyResponse(null, [])); await step(t, id); await advanceStep(t, id);
  assert.equal(new URL(t.requests[1].url).searchParams.get('limit'), '10'); assert.equal((await t.repository.read()).state.history_coverage, undefined);
  const next = await start(t, 'rental_prices'); assert.equal((await t.repository.job(next)).page_size, 100); assert.equal((await t.repository.job(next)).streams[1].history_plan.mode, 'full');
});

test('wrong-collection history disables cutoff and coverage promotion across resume', async () => {
  const responses = [], t = setup(responses); await seed(t); const id = await start(t, 'rental_prices');
  const since = (await t.repository.job(id)).streams[1].history_plan.scan_since;
  responses.push(response(catalog), historyResponse('next', [history(since - 1, {collection_address: 'wrong-scope'})]), historyResponse(null, [since - 2]));
  await step(t, id); assert.equal((await advanceStep(t, id)).state, 'running');
  let state = (await t.repository.read()).state; assert.equal(state.job.streams[1].scope_verified, false); assert.equal(state.history_coverage, undefined);
  await t.engine.stopJob(ctx, {job_id: id}); await t.engine.resumeJob(ctx, {job_id: id}); assert.equal((await advanceStep(t, id)).state, 'complete');
  state = (await t.repository.read()).state; assert.equal(state.history_coverage, undefined); assert.equal(state.job.streams[1].scope_verified, false);
  assert.equal((await t.repository.records()).filter(r => r.kind === 'history').length, 2);
});

test('canonical collection aliases establish shared coverage', async () => {
  const raw = `0:${'00'.repeat(32)}`, friendly = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
  const responses = [], t = setup(responses);
  await t.engine.importChunk(ctx, {import_id: 'alias', chunk_index: 0, records: [{kind: 'portfolio', key: 'alias', observed_at: new Date(t.now()).toISOString(), record: {nft_address: 'alias-gift', collection_address: friendly, is_portfolio: true}}]});
  const id = await start(t, 'rental_prices'), since = (await t.repository.job(id)).streams[1].history_plan.scan_since;
  responses.push(response(catalog), historyResponse('past', [history(since - 1, {collection_address: raw})]));
  await step(t, id); assert.equal((await advanceStep(t, id)).state, 'complete');
  assert.equal((await t.repository.read()).state.history_coverage[raw].scope_verified, true);
  const next = await start(t, 'rental_prices'); assert.equal((await t.repository.job(next)).streams[1].history_plan.mode, 'incremental');
});

test('incompatible saved history plans are rejected on resume and before direct step requests', async () => {
  const t = setup(); await seed(t); const id = await start(t, 'rental_prices');
  await editState(t, state => {state.job.streams[1].history_plan.scan_since++; state.job.streams[0].complete = true;});
  await t.engine.stopJob(ctx, {job_id: id}); await assert.rejects(t.engine.resumeJob(ctx, {job_id: id}), /incompatible/);
  await editState(t, state => {state.job.state = 'running';}); assert.equal((await step(t, id)).state, 'failed');
  assert.equal((await t.repository.read()).state.job.reason, 'incompatible_history_plan'); assert.equal(t.requests.length, 0);
});

test('new-policy future seconds and millisecond timestamps never establish coverage at EOF', async () => {
  for (const timestamp of ['future', 'milliseconds']) {
    const responses = [], t = setup(responses); await seed(t); const id = await start(t, 'rental_prices');
    const ts = timestamp === 'milliseconds' ? t.now() : Math.floor(t.now() / 1000) + 302;
    responses.push(response(catalog), historyResponse(null, [ts])); await step(t, id); assert.equal((await advanceStep(t, id)).state, 'complete');
    const state = (await t.repository.read()).state;
    assert.equal(state.job.streams[1].ordered, false); assert.equal(state.history_coverage, undefined);
    assert.equal((await t.repository.records()).filter(r => r.kind === 'history').length, 1, 'raw event remains available for inspection');
  }
});

test('ordinary in-flight timestamps newer than scan start are accepted without advancing its frozen watermark', async () => {
  const responses = [], t = setup(responses); await seed(t); const id = await start(t, 'rental_prices');
  const started = Math.floor(t.now() / 1000); responses.push(response(catalog), historyResponse(null, [started + 30]));
  await step(t, id); t.advance(30000); assert.equal((await step(t, id)).state, 'complete');
  const state = (await t.repository.read()).state; assert.equal(state.job.streams[1].ordered, true); assert.equal(state.history_coverage[scope].checked_through, started);
});

test('fresh completed listing and history traversals are reused without records, timestamps or coverage promotion', async () => {
  const responses = [response(catalog), page(null), historyResponse(null, [Math.floor(Date.parse('2026-10-09T12:00:00Z') / 1000) - 1])], t = setup(responses); await seed(t);
  const first = await start(t, 'collect'); await step(t, first); await advanceStep(t, first); await advanceStep(t, first);
  const before = (await t.repository.read()).state, records = (await t.repository.records()).filter(row => ['listing', 'history'].includes(row.kind));
  const originalCache = JSON.stringify(before.market_cache), originalCoverage = JSON.stringify(before.history_coverage);
  const observed = records.map(row => row.observed_at);
  for (let i = 0; i < 2; i++) {
    t.advance(1000); responses.push(response(catalog)); const next = await start(t, 'collect');
    const planned = await t.repository.job(next);
    assert.equal(planned.streams[0].complete, false, 'catalog is always refreshed');
    for (const stream of planned.streams.slice(1)) {assert.equal(stream.complete, true); assert.equal(stream.pages, 0); assert.equal(stream.started, false); assert.equal(stream.completion_reason, 'shared_market_cache'); assert.equal(stream.cache_source.job_id, first);}
    const result = await step(t, next); assert.equal(result.state, 'complete'); assert.equal(result.progress.pages, 1); assert.equal(result.progress.marketapp_budget.invocation_used, 1);
    assert.deepEqual(result.progress.market_cache, {reused_streams: 2, total_streams: 2, ttl_seconds: 300, oldest_observed_at: observed[0]});
    const state = (await t.repository.read()).state; assert.equal(JSON.stringify(state.market_cache), originalCache); assert.equal(JSON.stringify(state.history_coverage), originalCoverage);
    assert.deepEqual((await t.repository.records()).filter(row => ['listing', 'history'].includes(row.kind)), records);
  }
  assert.equal(t.requests.length, 5, 'three original calls plus two catalog refreshes, with no duplicate comparison calls');
  const indexText = JSON.stringify(before.market_cache); assert.equal(indexText.includes('nft-a'), false); assert.equal(indexText.includes('owner'), false);
});

test('market cache TTL begins at its first actual provider page and expires at exactly five minutes', async () => {
  const responses = [response(catalog), page('next'), page(null)], t = setup(responses); await seed(t); const first = await start(t);
  await step(t, first); await advanceStep(t, first); const firstObserved = t.now(); t.advance(30000); await step(t, first);
  t.advance(firstObserved + 300000 - 1 - t.now()); const cached = await start(t); assert.equal((await t.repository.job(cached)).streams[1].cache_source.job_id, first);
  await t.engine.stopJob(ctx, {job_id: cached}); t.advance(1); const expired = await start(t);
  assert.equal((await t.repository.job(expired)).streams[1].cache_source, undefined); assert.deepEqual((await t.repository.read()).state.market_cache, {});
});

test('slow resumed traversals and partially collected streams never publish a completed market cache', async () => {
  const responses = [response(catalog), page('next'), page(null)], t = setup(responses); await seed(t); const first = await start(t);
  await step(t, first); await advanceStep(t, first); assert.deepEqual((await t.repository.read()).state.market_cache, {});
  await t.engine.stopJob(ctx, {job_id: first}); t.advance(300000); await t.engine.resumeJob(ctx, {job_id: first}); await step(t, first);
  assert.deepEqual((await t.repository.read()).state.market_cache, {});
  const next = await start(t); assert.equal((await t.repository.job(next)).streams[1].cache_source, undefined);
});

test('market cache publication and the final source page share one atomic event', async () => {
  const t = setup([response(catalog), page(null)]); await seed(t); const id = await start(t); await step(t, id); await advanceStep(t, id);
  const event = t.database.prepare('SELECT * FROM cloud_events ORDER BY sequence DESC LIMIT 1').get();
  const state = JSON.parse(event.state_json), cached = Object.values(state.market_cache)[0];
  assert.equal(cached.job_id, id); assert.equal(cached.stream_index, 1); assert.equal(JSON.parse(event.job_json).streams[1].complete, true);
  assert.equal(JSON.parse(event.records_json).filter(row => row.kind === 'listing').length, 1); assert.equal(JSON.parse(event.raw_body).endpoint, '/v1/rent/gifts/');
});

test('cached history cannot substitute for the full reconciliation due after seven days', async () => {
  const responses = [response(catalog), historyResponse(null, [])], t = setup(responses); await seed(t); const firstAt = Math.floor(t.now() / 1000);
  const full = await start(t, 'rental_prices'); await step(t, full); await advanceStep(t, full);
  t.advance((firstAt + 7 * daySeconds - 60) * 1000 - t.now()); responses.push(response(catalog), historyResponse(null, []));
  const increment = await start(t, 'rental_prices'); assert.equal((await t.repository.job(increment)).streams[1].history_plan.mode, 'incremental'); await step(t, increment); await advanceStep(t, increment);
  assert.equal(Object.values((await t.repository.read()).state.market_cache).length, 1);
  t.advance((firstAt + 7 * daySeconds) * 1000 - t.now()); const due = await start(t, 'rental_prices');
  const stream = (await t.repository.job(due)).streams[1]; assert.equal(stream.history_plan.mode, 'full'); assert.equal(stream.cache_source, undefined); assert.equal(stream.complete, false);
});

test('market cache keys freeze page size and cache reuse survives saved-job resume without renewal', async () => {
  const responses = [response(catalog), page(null)], t = setup(responses); await seed(t); const first = await start(t); await step(t, first); await advanceStep(t, first);
  const cached = await start(t); const source = (await t.repository.job(cached)).streams[1].cache_source; await t.engine.stopJob(ctx, {job_id: cached});
  t.advance(400000); await t.engine.resumeJob(ctx, {job_id: cached}); assert.deepEqual((await t.repository.job(cached)).streams[1].cache_source, source);
  responses.push(response(catalog)); assert.equal((await step(t, cached)).state, 'complete');
  t.engine = createCloudEngine({...t.deps, limits: {page_size: 10}}); const different = await start(t); assert.equal((await t.repository.job(different)).streams[1].cache_source, undefined);
});
