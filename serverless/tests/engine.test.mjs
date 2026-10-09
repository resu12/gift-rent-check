import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine, nanoAmounts, validatePage} from '../tgcloud/lib/engine.js';

const ctx = {initData: {user: {id: 12345}}};
const scope = `0:${'ab'.repeat(32)}`;
const token = 'private-fixture-token';
const copy = data => JSON.parse(JSON.stringify(data));
const item = (overrides = {}) => ({nft_address: 'public-nft', nft_name: 'Low Rider #1', owner: 'public-owner', attributes: [{trait_type: 'Model', value: 'Let Me Ride'}, {trait_type: 'Backdrop', value: 'Black'}], min_duration: 3600, max_duration: 86400, price_per_day: '170000000', discount_per_day: 0, listed_at: null, ...overrides});
const response = (cursor = null, items = [item()], options = {}) => ({status: options.status || 200, url: options.url, headers: {get: name => name.toLowerCase() === 'retry-after' ? options.retryAfter ?? null : null}, text: async () => options.raw ?? JSON.stringify({cursor, items})});
function setup(responses = [], options = {}) {
  let clock = 1000000, state = null, revision = 0, failCas = 0;
  const requests = [], commits = [];
  const repository = {
    async read() {return state === null ? null : {revision, document: copy(state)};},
    async compareAndSet(expected, document) {
      if (failCas > 0) {failCas--; return false;}
      if (expected !== revision) return false;
      state = copy(document); revision++; commits.push(copy(state)); return true;
    },
  };
  const deps = {repository, ownerTelegramId: '12345', marketappToken: token, now: () => clock, random: () => 0, fetch: async (url, init) => {requests.push({url, init}); const next = responses.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(url, init); if (!next) throw new Error('No mock response'); return next;}, ...options};
  return {engine: createEngine(deps), repository, deps, requests, commits, advance: ms => clock += ms, setClock: time => clock = time, forceCasFailures: count => failCas = count, stored: () => copy(state)};
}
const start = async (t, input = {}) => (await t.engine.startRun(ctx, input)).run.id;
const step = (t, id) => t.engine.stepRun(ctx, {run_id: id});

test('every endpoint fails closed before storage or HTTP access', async () => {
  for (const ownerTelegramId of [null, '', '0', 'bad', '54321']) {
    const t = setup([], {ownerTelegramId});
    for (const method of ['getState', 'startRun', 'stepRun', 'stopRun', 'resumeRun']) await assert.rejects(t.engine[method](ctx, {}), /Private access denied/);
    assert.equal(t.stored(), null); assert.equal(t.requests.length, 0);
  }
  const t = setup();
  for (const invalid of [{}, {initData: {user: {id: 999}}}, {initData: {user: {id: '0012345'}}}]) await assert.rejects(t.engine.getState(invalid), /Private access denied/);
});

test('configuration and scope validation are safe and local', async () => {
  const t = setup([], {marketappToken: ''});
  assert.equal((await t.engine.getState(ctx)).configured, false);
  assert.equal((await t.engine.startRun(ctx, {})).error.code, 'CONFIGURATION');
  for (const input of [{collection_address: 3}, {collection_address: 'https://attacker.invalid'}, {page_size: 0}, {page_size: 101}, {page_size: 1.5}, {collection_address: 'UQ' + 'a'.repeat(46)}]) {
    const s = setup(); assert.equal((await s.engine.startRun(ctx, input)).error.code, 'INVALID_INPUT'); assert.equal(s.stored(), null);
  }
});

test('exact route, GET, raw authentication, frozen query, and opaque cursors', async () => {
  const t = setup([response('opaque /+=?&', []), response(null)]), id = await start(t, {collection_address: scope, page_size: 10});
  let s = await step(t, id); assert.equal(s.run.status, 'ready'); assert.equal(s.run.pages_committed, 1);
  await step(t, id); assert.equal(t.requests.length, 1, 'pacing rejects early calls without HTTP');
  t.advance(1000); s = await step(t, id); assert.equal(s.run.status, 'complete');
  for (const r of t.requests) {const url = new URL(r.url); assert.equal(url.origin + url.pathname, 'https://api.marketapp.org/v1/rent/gifts/'); assert.equal(r.init.method, 'GET'); assert.equal(r.init.headers.Authorization, token); assert.equal(url.searchParams.get('collection_address'), scope); assert.equal(url.searchParams.get('sort_by'), 'recently_touch'); assert.equal(url.searchParams.get('limit'), '10'); assert.equal(r.init.redirect, 'error');}
  assert.deepEqual([...new URL(t.requests[0].url).searchParams.keys()], ['limit', 'sort_by', 'collection_address']);
  assert.equal(new URL(t.requests[1].url).searchParams.get('cursor'), 'opaque /+=?&');
  assert.equal(s.listings[0].collection_source, 'collection_filtered_request');
  assert.equal(s.listings[0].ownership_verified, false);
  assert.equal(s.run.items_seen, 1);
  assert.equal(JSON.stringify(s).includes(token), false);
  assert.equal(Object.hasOwn(s.run, 'cursor'), false);
});

test('empty string cursors and short/empty nonterminal pages keep traversing', async () => {
  const t = setup([response('', []), response('second', [item()]), response(null, [])]), id = await start(t);
  await step(t, id); t.advance(1000); await step(t, id); t.advance(1000);
  const s = await step(t, id);
  assert.equal(new URL(t.requests[1].url).searchParams.get('cursor'), '');
  assert.equal(new URL(t.requests[1].url).searchParams.has('cursor'), true);
  assert.equal(s.run.pages_committed, 3); assert.equal(s.run.status, 'complete'); assert.equal(s.listings[0].collection_address, null);
});

test('overlapping page occurrences remain evidence and cursor cycles never advance', async () => {
  const t = setup([response('A'), response('B'), response('A')]), id = await start(t);
  await step(t, id); t.advance(1000); await step(t, id); t.advance(1000);
  const s = await step(t, id), stored = t.stored().runs[0];
  assert.equal(s.run.status, 'failed'); assert.equal(s.run.reason, 'cursor_cycle_start_fresh'); assert.equal(s.run.pages_committed, 2); assert.equal(s.run.items_seen, 2); assert.equal(stored.cursor, 'B'); assert.equal(stored.invalid_responses[0].reason, 'cursor_cycle');
});

test('valid page raw body, observations and checkpoint publish in one CAS', async () => {
  const t = setup([response('A')]), id = await start(t);
  t.forceCasFailures(1); await step(t, id);
  for (const doc of t.commits) {const r = doc.runs[0]; if (r.cursor === 'A') {assert.equal(r.pages.length, 1); assert.equal(JSON.parse(r.pages[0].raw_body).cursor, 'A'); assert.equal(r.pages[0].listings[0].price_display, '0.170');}}
  assert.equal(t.requests.length, 1); assert.equal(t.stored().runs[0].pages.length, 1);
});

test('malformed JSON, missing required nullables and schema errors retain evidence without cursor advance', async () => {
  const missing = item(); delete missing.listed_at;
  for (const bad of [response(null, [], {raw: '{no'}), response(null, [missing]), response(null, [item({price_per_day: 170000000})]), response(null, [item({discount_per_day: null})]), response(null, [], {raw: JSON.stringify({items: []})})]) {
    const t = setup([bad]), id = await start(t), s = await step(t, id);
    assert.equal(s.run.status, 'failed'); assert.equal(s.run.reason, 'invalid_response'); assert.equal(s.run.pages_committed, 0); assert.equal(t.stored().runs[0].cursor, null); assert.equal(t.stored().runs[0].invalid_responses.length, 1);
  }
  assert.equal(validatePage(JSON.stringify({cursor: null, items: [item()]}), null, 'time').listings.length, 1);
});

test('prices use exact integer arithmetic and half-up three decimal display', () => {
  assert.deepEqual(nanoAmounts('390000000'), {price_nano: '390000000', price_gram: '0.390000000', price_display: '0.390'});
  assert.equal(nanoAmounts('1234500000').price_display, '1.235');
  assert.equal(nanoAmounts('999500000').price_display, '1.000');
  assert.equal(nanoAmounts('9007199254740993000000000').price_gram, '9007199254740993.000000000');
  assert.equal(nanoAmounts('1').price_gram, '0.000000001');
  for (const value of ['1e9', '-1', '1.1', '', 1]) assert.throws(() => nanoAmounts(value));
});

test('Stop during HTTP blocks page commit and Resume waits for the in-flight lease', async () => {
  let deliver; const pending = new Promise(resolve => {deliver = resolve;});
  const t = setup([() => pending, response(null)]), id = await start(t);
  const work = step(t, id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await t.engine.stopRun(ctx, {run_id: id})).run.status, 'paused');
  assert.equal((await t.engine.startRun(ctx, {})).error.code, 'ACTIVE_RUN');
  await t.engine.resumeRun(ctx, {run_id: id}); t.advance(2000); await step(t, id);
  assert.equal(t.requests.length, 1);
  deliver(response('discarded')); const ignored = await work;
  assert.equal(ignored.run.pages_committed, 0); assert.equal(ignored.run.status, 'ready'); assert.equal(ignored.run.lease_until, 0);
  const finished = await step(t, id); assert.equal(finished.run.status, 'complete'); assert.equal(t.requests.length, 2);
});

test('Stop plus Retry-After preserves provider cooldown across new runs', async () => {
  let deliver; const pending = new Promise(resolve => {deliver = resolve;});
  const t = setup([() => pending, response(null)]), id = await start(t);
  const work = step(t, id); await new Promise(resolve => setImmediate(resolve));
  await t.engine.stopRun(ctx, {run_id: id});
  deliver(response(null, [], {status: 429, retryAfter: '120'}));
  const s = await work; assert.equal(s.run.status, 'paused'); assert.equal(s.run.next_allowed_at, 1120000);
  const next = await start(t); await step(t, next); assert.equal(t.requests.length, 1);
  t.advance(120000); assert.equal((await step(t, next)).run.status, 'complete');
});

test('persisted retry count and exponential backoff survive independent engine invocations', async () => {
  const t = setup([new Error(token), response(null, [], {status: 503}), response(null, [], {status: 429}), new Error(token)]), id = await start(t);
  for (const [i, delay] of [1000, 2000, 4000, 8000].entries()) {
    t.engine = createEngine(t.deps); const s = await step(t, id);
    assert.equal(s.run.attempts, i + 1); assert.equal(s.run.next_allowed_at, t.deps.now() + delay); assert.equal(s.run.status, i === 3 ? 'failed' : 'ready'); t.advance(delay);
  }
  assert.equal((await step(t, id)).run.reason, 'retry_exhausted'); assert.equal(t.requests.length, 4); assert.equal(JSON.stringify(t.stored()).includes(token), false);
});

test('HTTP date Retry-After is honored and successful page resets retry count', async () => {
  const t = setup([response(null, [], {status: 429, retryAfter: new Date(1060000).toUTCString()}), response('A'), response(null)]), id = await start(t);
  const retry = await step(t, id); assert.equal(retry.run.next_allowed_at, 1060000);
  t.advance(60000); await step(t, id); assert.equal(t.stored().runs[0].retry_attempt, 0); t.advance(1000);
  assert.equal((await step(t, id)).run.status, 'complete');
});

test('authentication failure stops promptly and redacts echoed secrets in retained raw evidence', async () => {
  const t = setup([response(null, [], {status: 401, raw: token + ' refused ' + token})]), id = await start(t);
  const s = await step(t, id); assert.equal(s.run.reason, 'authentication_failed'); await step(t, id); assert.equal(t.requests.length, 1); assert.equal(JSON.stringify(t.stored()).includes(token), false); assert.equal(JSON.stringify(s).includes(token), false);
});

test('final URL redirect is rejected and has no committed checkpoint', async () => {
  const t = setup([response(null, [], {url: 'https://unexpected.invalid'})]), id = await start(t);
  const s = await step(t, id); assert.equal(s.run.reason, 'unexpected_redirect'); assert.equal(s.run.pages_committed, 0);
});

test('invalid cursor Unicode and unrepresentable Retry-After fail without losing a checkpoint', async () => {
  for (const [res, reason] of [[response('\ud800'), 'invalid_response'], [response(null, [], {status: 429, retryAfter: '9'.repeat(400)}), 'invalid_retry_after']]) {
    const t = setup([res]), id = await start(t), s = await step(t, id);
    assert.equal(s.run.status, 'failed'); assert.equal(s.run.reason, reason); assert.equal(s.run.pages_committed, 0); assert.equal(t.stored().runs[0].cursor, null); assert.equal(Number.isFinite(s.run.next_allowed_at), true);
  }
});

test('crashed request lease can resume after expiry and stale worker cannot commit', async () => {
  let deliver; const t = setup([() => new Promise(resolve => {deliver = resolve;}), response(null)]), id = await start(t);
  const old = step(t, id); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await t.engine.resumeRun(ctx, {run_id: id})).error.code, 'NOT_RESUMABLE');
  t.advance(120001); const revived = await t.engine.resumeRun(ctx, {run_id: id}); assert.equal(revived.run.status, 'ready');
  const complete = await step(t, id); assert.equal(complete.run.status, 'complete');
  deliver(response('stale')); await old;
  assert.equal(t.stored().runs[0].pages.length, 1); assert.equal(t.stored().runs[0].cursor, null);
});

test('simultaneous step requests serialize through the conditional lease reservation', async () => {
  let deliver; const t = setup([() => new Promise(resolve => {deliver = resolve;})]), id = await start(t);
  const first = step(t, id), second = step(t, id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.requests.length, 1); deliver(response(null)); await Promise.all([first, second]);
  assert.equal(t.stored().runs[0].pages.length, 1);
});

test('prototype page bound differs from traversal completion and cannot be resumed', async () => {
  const t = setup([response('A')], {limits: {max_pages: 1}}), id = await start(t);
  const s = await step(t, id); assert.equal(s.run.status, 'prototype_limit'); assert.equal(s.run.has_more, true); assert.equal(s.run.reason, 'page_limit');
  assert.equal((await t.engine.resumeRun(ctx, {run_id: id})).error.code, 'NOT_RESUMABLE');
  const next = await start(t); assert.notEqual(next, id); assert.equal(t.stored().runs.length, 2);
});

test('storage cap rejects a page atomically and keeps its previous cursor', async () => {
  const t = setup([response('A', [item({nft_name: 'x'.repeat(1000)})])], {limits: {max_document_bytes: 34000}}), id = await start(t);
  const s = await step(t, id); assert.equal(s.run.status, 'prototype_limit'); assert.equal(s.run.reason, 'storage_limit'); assert.equal(s.run.pages_committed, 0); assert.equal(t.stored().runs[0].cursor, null);
});

test('same-run Stop and Resume are idempotent; frozen parameters cannot change', async () => {
  const t = setup([response(null)]), id = await start(t, {collection_address: scope, page_size: 17});
  assert.equal((await t.engine.startRun(ctx, {})).error.code, 'ACTIVE_RUN');
  await t.engine.stopRun(ctx, {run_id: id}); await t.engine.stopRun(ctx, {run_id: id});
  assert.equal((await t.engine.resumeRun(ctx, {run_id: id, collection_address: `0:${'cd'.repeat(32)}`, page_size: 100})).error.code, 'INVALID_INPUT'); await t.engine.resumeRun(ctx, {run_id: id});
  const s = await step(t, id); assert.equal(s.run.page_size, 17); assert.equal(s.run.collection_address, scope); assert.equal((await t.engine.stopRun(ctx, {run_id: id})).run.status, 'complete');
});
