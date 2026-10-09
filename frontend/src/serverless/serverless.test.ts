import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerlessAdapter, PrototypeError, safeError } from './transport.ts';
import type { Endpoint, ServerlessAdapter, ServerlessState, TelegramServerless } from './transport.ts';
import { BoundedCollectionDriver } from './driver.ts';

function saved(pages = 0, overrides: Partial<NonNullable<ServerlessState['run']>> = {}): ServerlessState {
  return {
    authorized: true, user: { id: '123' }, configured: true, server_time: 1000,
    limits: { page_size: 10, max_pages: 100, max_attempts: 4, request_interval_ms: 1000 }, listings: [],
    run: { id: 'run1', status: 'ready', pages_committed: pages, items_seen: pages * 10, next_allowed_at: 0,
      lease_until: 0, reason: null, has_more: true, page_size: 10, collection_address: null, attempts: pages, ...overrides },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('Serverless adapter sends only documented endpoint arguments and uses callback results', async () => {
  const calls: unknown[] = [];
  const api: TelegramServerless = { call(endpoint, input, callback) { calls.push({ endpoint, input }); callback(null, saved()); } };
  const adapter = createServerlessAdapter(api);
  assert.equal((await adapter.call('startRun', { collection_address: 'collection1' })).authorized, true);
  await adapter.call('getState');
  assert.deepEqual(calls, [{ endpoint: 'startRun', input: { collection_address: 'collection1' } }, { endpoint: 'getState', input: {} }]);
});

test('missing Telegram platform, callback authorization error, and synchronous SDK exceptions are safe', async () => {
  await assert.rejects(createServerlessAdapter().call('getState'), (error: PrototypeError) => error.code === 'UNAVAILABLE');
  const auth = createServerlessAdapter({ call(_endpoint, _input, callback) { callback({ type: 'UNAUTHORIZED', message: 'secret token must never render' }); } });
  await assert.rejects(auth.call('getState'), (error: PrototypeError) => error.code === 'UNAUTHORIZED' && !error.message.includes('secret'));
  const sync = createServerlessAdapter({ call() { throw new Error('secret token must never render'); } });
  await assert.rejects(sync.call('getState'), (error: PrototypeError) => error.code === 'TRANSPORT' && !error.message.includes('secret'));
  assert.equal(safeError(new Error('secret token')), 'The request did not finish. Reload saved data before continuing.');
});

test('adapter rejects missing authorization and preserves safe state from expected action errors', async () => {
  const invalid = createServerlessAdapter({ call(_e, _i, cb) { cb(null, { ...saved(), authorized: false }); } });
  await assert.rejects(invalid.call('getState'), (error: PrototypeError) => error.code === 'INVALID_RESPONSE');
  const state = { ...saved(), error: { code: 'CONFIGURATION', message: 'unsafe raw details' } };
  const configured = createServerlessAdapter({ call(_e, _i, cb) { cb(null, state); } });
  await assert.rejects(configured.call('startRun'), (error: PrototypeError) => error.state === state && !error.message.includes('unsafe'));
});

test('malformed listing rows and unknown run states do not reach the dashboard renderer', async () => {
  for (const result of [{ ...saved(), listings: [null] }, { ...saved(), run: { ...saved().run, status: 'surprise' } }, { ...saved(), limits: {} }]) {
    const adapter = createServerlessAdapter({ call(_endpoint, _input, callback) { callback(null, result); } });
    await assert.rejects(adapter.call('getState'), (error: PrototypeError) => error.code === 'INVALID_RESPONSE');
  }
});

test('timeout ignores late callbacks and never retries a possibly committed mutation', async () => {
  let callback!: Parameters<TelegramServerless['call']>[2];
  let calls = 0;
  const adapter = createServerlessAdapter({ call(_e, _i, cb) { calls += 1; callback = cb; } }, 5);
  await assert.rejects(adapter.call('stepRun', { run_id: 'run1' }), (error: PrototypeError) => error.code === 'TIMEOUT');
  callback(null, saved(1));
  assert.equal(calls, 1);
});

test('driver commits only two pages per user action then persists paused state using same run', async () => {
  const calls: { endpoint: Endpoint; input?: Record<string, unknown> }[] = [];
  const observed: ServerlessState[] = [];
  let pages = 0;
  const adapter: ServerlessAdapter = { async call(endpoint, input) {
    calls.push({ endpoint, input });
    if (endpoint === 'stepRun') return saved(++pages);
    assert.equal(endpoint, 'stopRun');
    return saved(pages, { status: 'paused' });
  } };
  const driver = new BoundedCollectionDriver({ adapter, onState: state => observed.push(state), now: () => 1000 });
  assert.equal(await driver.run(async () => saved()), 'batch_limit');
  assert.deepEqual(calls.map(call => call.endpoint), ['stepRun', 'stepRun', 'stopRun']);
  assert.ok(calls.every(call => call.input?.run_id === 'run1'));
  assert.equal(observed.at(-1)?.run?.pages_committed, 2);
  assert.equal(observed.at(-1)?.run?.status, 'paused');
});

test('completed first page ends without unnecessary Stop or extra page call', async () => {
  const calls: Endpoint[] = [];
  const adapter: ServerlessAdapter = { async call(endpoint) { calls.push(endpoint); return saved(1, { status: 'complete', has_more: false }); } };
  assert.equal(await new BoundedCollectionDriver({ adapter, onState() {}, now: () => 1000 }).run(async () => saved()), 'complete');
  assert.deepEqual(calls, ['stepRun']);
});

test('Stop is sent immediately during an in-flight step and late responses cannot overwrite paused evidence', async () => {
  const page = deferred<ServerlessState>();
  const started = deferred<void>();
  const calls: Endpoint[] = [];
  const observed: ServerlessState[] = [];
  const adapter: ServerlessAdapter = { async call(endpoint) {
    calls.push(endpoint);
    if (endpoint === 'stepRun') { started.resolve(); return page.promise; }
    return saved(0, { status: 'paused' });
  } };
  const driver = new BoundedCollectionDriver({ adapter, onState: state => observed.push(state), now: () => 1000 });
  const result = driver.run(async () => saved());
  await started.promise;
  await driver.stop();
  assert.deepEqual(calls, ['stepRun', 'stopRun']);
  page.resolve(saved(1));
  assert.equal(await result, 'stopped');
  assert.deepEqual(calls, ['stepRun', 'stopRun', 'getState']);
  assert.equal(observed.at(-1)?.run?.status, 'paused');
  assert.equal(observed.at(-1)?.run?.pages_committed, 0);
});

test('Stop refreshes committed state after an in-flight request clears its retained lease', async () => {
  const page = deferred<ServerlessState>();
  const started = deferred<void>();
  const calls: Endpoint[] = [];
  const observed: ServerlessState[] = [];
  const driver = new BoundedCollectionDriver({
    adapter: { async call(endpoint) {
      calls.push(endpoint);
      if (endpoint === 'stepRun') { started.resolve(); return page.promise; }
      if (endpoint === 'stopRun') return saved(0, { status: 'paused', lease_until: 121000, next_allowed_at: 121000 });
      assert.equal(endpoint, 'getState');
      return saved(0, { status: 'paused', lease_until: 0, next_allowed_at: 0 });
    } },
    onState: state => observed.push(state), now: () => 1000,
  });
  const result = driver.run(async () => saved());
  await started.promise;
  await driver.stop();
  assert.equal(observed.at(-1)?.run?.lease_until, 121000);
  page.resolve(saved(0, { status: 'paused', lease_until: 0 }));
  assert.equal(await result, 'stopped');
  assert.deepEqual(calls, ['stepRun', 'stopRun', 'getState']);
  assert.equal(observed.at(-1)?.run?.lease_until, 0);
  assert.equal(observed.at(-1)?.run?.next_allowed_at, 0);
});

test('a failed post-Stop state refresh surfaces uncertainty without retrying collection', async () => {
  const page = deferred<ServerlessState>();
  const started = deferred<void>();
  const calls: Endpoint[] = [];
  const driver = new BoundedCollectionDriver({ adapter: { async call(endpoint) {
    calls.push(endpoint);
    if (endpoint === 'stepRun') { started.resolve(); return page.promise; }
    if (endpoint === 'stopRun') return saved(0, { status: 'paused', lease_until: 121000 });
    throw new PrototypeError('TIMEOUT', 'Reload saved data');
  } }, onState() {}, now: () => 1000 });
  const result = driver.run(async () => saved());
  await started.promise;
  await driver.stop();
  page.resolve(saved());
  await assert.rejects(result, /Reload saved data/);
  assert.deepEqual(calls, ['stepRun', 'stopRun', 'getState']);
});

test('Stop before start resolves pauses newly created run without making provider calls', async () => {
  const initial = deferred<ServerlessState>();
  const calls: Endpoint[] = [];
  const driver = new BoundedCollectionDriver({ adapter: { async call(endpoint) { calls.push(endpoint); return saved(0, { status: 'paused' }); } }, onState() {} });
  const running = driver.run(() => initial.promise);
  await driver.stop();
  initial.resolve(saved());
  assert.equal(await running, 'stopped');
  assert.deepEqual(calls, ['stopRun']);
});

test('future Retry-After pauses instead of spinning or waiting past the prototype budget', async () => {
  let waits = 0;
  const calls: Endpoint[] = [];
  const driver = new BoundedCollectionDriver({
    adapter: { async call(endpoint) { calls.push(endpoint); return saved(0, { status: 'paused', next_allowed_at: 121000 }); } },
    onState() {}, now: () => 1000, wait: async () => { waits += 1; },
  });
  assert.equal(await driver.run(async () => saved(0, { next_allowed_at: 121000 })), 'cooldown');
  assert.deepEqual(calls, ['stopRun']);
  assert.equal(waits, 0);
});

test('normal pacing waits with a fake clock and allows Stop to interrupt', async () => {
  let clock = 1000;
  let driver!: BoundedCollectionDriver;
  const calls: Endpoint[] = [];
  const waited: number[] = [];
  driver = new BoundedCollectionDriver({
    adapter: { async call(endpoint) { calls.push(endpoint); return saved(0, { status: 'paused' }); } }, onState() {}, now: () => clock,
    wait: async (ms, signal) => { waited.push(ms); clock += ms; await driver.stop(); assert.equal(signal.aborted, true); },
  });
  assert.equal(await driver.run(async () => saved(0, { next_allowed_at: 2000 })), 'stopped');
  assert.deepEqual(waited, [1000]);
  assert.deepEqual(calls, ['stopRun']);
});

test('a ready run retains its in-flight lease after Resume without rapid duplicate steps', async () => {
  const calls: Endpoint[] = [];
  const driver = new BoundedCollectionDriver({
    adapter: { async call(endpoint) { calls.push(endpoint); return saved(0, { status: 'paused', lease_until: 121000 }); } },
    onState() {}, now: () => 1000,
  });
  assert.equal(await driver.run(async () => saved(0, { status: 'ready', lease_until: 121000 })), 'cooldown');
  assert.deepEqual(calls, ['stopRun']);
});

test('network failures do not retry unknown mutations and overlapping drivers are rejected', async () => {
  const page = deferred<ServerlessState>();
  const started = deferred<void>();
  let calls = 0;
  const driver = new BoundedCollectionDriver({ adapter: { async call() { calls += 1; started.resolve(); return page.promise; } }, onState() {}, now: () => 1000 });
  const running = driver.run(async () => saved());
  await started.promise;
  await assert.rejects(driver.run(async () => saved()), /already active/);
  page.reject(new PrototypeError('TIMEOUT', 'Reload saved data'));
  await assert.rejects(running, /Reload saved data/);
  assert.equal(calls, 1);
});

test('repeated retry responses are bounded even when no pages commit', async () => {
  const calls: Endpoint[] = [];
  const driver = new BoundedCollectionDriver({
    adapter: { async call(endpoint) { calls.push(endpoint); return saved(0, endpoint === 'stopRun' ? { status: 'paused' } : {}); } },
    onState() {}, now: () => 1000, maxCalls: 4,
  });
  assert.equal(await driver.run(async () => saved()), 'attention');
  assert.deepEqual(calls, ['stepRun', 'stepRun', 'stepRun', 'stepRun', 'stopRun']);
});

test('a resumed batch counts new pages and retains the original traversal', async () => {
  let pages = 40;
  const driver = new BoundedCollectionDriver({ adapter: { async call(endpoint) {
    return endpoint === 'stepRun' ? saved(++pages) : saved(pages, { status: 'paused' });
  } }, onState() {}, now: () => 1000 });
  assert.equal(await driver.run(async () => saved(40)), 'batch_limit');
  assert.equal(pages, 42);
});
