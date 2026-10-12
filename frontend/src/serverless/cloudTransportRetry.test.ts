import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudError, createCloudTransport } from './cloudTransport.ts';
import type { CloudEndpoint, CloudTransportEnvironment } from './cloudTransport.ts';
import type { TelegramServerless } from './transport.ts';

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const environment: CloudTransportEnvironment = {
    now: () => now,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return () => { timers.delete(id); };
    },
  };
  return {
    environment,
    get timerCount() { return timers.size; },
    elapseWithoutTimers(milliseconds: number) { now += milliseconds; },
    async advance(milliseconds: number) {
      const until = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at; timers.delete(id); timer.callback();
        await Promise.resolve();
      }
      now = until;
      await Promise.resolve();
    },
  };
}
type Callback = Parameters<TelegramServerless['call']>[2];
const internal = { type: 'INTERNAL', message: 'private raw server details', parameters: { token: 'secret' } };
function setup(deadline = 45000) {
  const timer = clock();
  const calls: { name: string; input: Record<string, unknown>; callback: Callback }[] = [];
  const transport = createCloudTransport({ call(name, input, callback) { calls.push({ name, input, callback }); } }, deadline, 120000, timer.environment);
  return { timer, calls, transport };
}
function errorCode(value: unknown) { assert.ok(value instanceof CloudError); return value.code; }
function errorName(value: unknown) { assert.ok(value instanceof Error); return value.name; }

for (const endpoint of ['getDashboard', 'getDashboardRevision', 'getJobs'] as const) {
  test(`${endpoint} retries only twice with backoff and returns the first successful saved-data response`, async () => {
    const run = setup(), input = { source: 'rentals', timeframe: '30d' };
    const pending = run.transport.call(endpoint, input);
    run.calls[0].callback(internal);
    await run.timer.advance(799); assert.equal(run.calls.length, 1);
    await run.timer.advance(1); assert.equal(run.calls.length, 2);
    run.calls[1].callback(internal);
    await run.timer.advance(1599); assert.equal(run.calls.length, 2);
    await run.timer.advance(1); assert.equal(run.calls.length, 3);
    run.calls[2].callback(null, { saved: true });
    assert.deepEqual(await pending, { saved: true });
    assert.ok(run.calls.every(call => call.name === endpoint && call.input === input));
    assert.equal(run.timer.timerCount, 0);
  });
}

test('persistent INTERNAL reads exhaust three attempts and retain only the recognized diagnostic code', async () => {
  const run = setup(), outcome = run.transport.call('getDashboard').catch(error => error);
  run.calls[0].callback(internal);
  await run.timer.advance(800); run.calls[1].callback(internal);
  await run.timer.advance(1600); run.calls[2].callback(internal);
  const error = await outcome;
  assert.ok(error instanceof CloudError); assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /\(INTERNAL\)/);
  assert.doesNotMatch(error.message + JSON.stringify(error), /private|secret|token/);
  await run.timer.advance(90000);
  assert.equal(run.calls.length, 3); assert.equal(run.timer.timerCount, 0);
});

test('auth, account, endpoint and unknown SDK errors fail immediately without guessing that they are transient', async () => {
  for (const type of ['UNAUTHORIZED', 'PUBLIC_ACCESS_DENIED', 'PUBLIC_ACCOUNT_DELETED', 'PRIVATE_ACCESS_DENIED',
    'ENDPOINT_ERROR', 'INVALID_INPUT', 'NETWORK', 'NETWORK_ERROR', 'TIMEOUT', 'UNKNOWN', 'constructor', undefined]) {
    const run = setup(), outcome = run.transport.call('getDashboard').catch(error => error);
    run.calls[0].callback({ type, message: 'private secret', parameters: { token: 'private' } });
    const error = await outcome;
    assert.ok(error instanceof CloudError); assert.doesNotMatch(error.message + JSON.stringify(error), /private secret|token/);
    await run.timer.advance(90000);
    assert.equal(run.calls.length, 1, String(type)); assert.equal(run.timer.timerCount, 0);
  }
});

test('an explicit auth refusal on a recovery attempt stops immediately', async () => {
  const run = setup(), outcome = run.transport.call('getDashboard').catch(error => error);
  run.calls[0].callback(internal);
  await run.timer.advance(800);
  run.calls[1].callback({ type: 'UNAUTHORIZED', message: 'private details' });
  assert.equal(errorCode(await outcome), 'UNAUTHORIZED');
  await run.timer.advance(90000); assert.equal(run.calls.length, 2);
});

test('unclassified backend errors and malformed responses never enter SDK recovery', async () => {
  for (const response of [null, [], 'bad', { error: { code: 'INTERNAL', message: 'private details' } },
    { error: { code: 'PUBLIC_ACCESS_DENIED', message: 'private details' } },
    { error: { code: 'READ_LIMIT', message: 'private details' } }, { error: { code: 'READ_FAILED', message: 'private details' } }]) {
    const run = setup(), outcome = run.transport.call('getDashboard').catch(error => error);
    run.calls[0].callback(null, response);
    assert.ok(await outcome instanceof CloudError);
    await run.timer.advance(90000); assert.equal(run.calls.length, 1); assert.equal(run.timer.timerCount, 0);
  }
});

test('mutations and reads outside the explicit saved-dashboard allowlist never retry INTERNAL', async () => {
  const endpoints: CloudEndpoint[] = ['startJob', 'resumeJob', 'stepJob', 'stopJob', 'refreshStartupComparisons',
    'startGiftRefresh', 'stepGiftRefresh', 'startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'stepStorageMaintenance',
    'refreshStartupMarketappAnalytics', 'finishMarketappAnalyticsRefresh', 'saveMarketappApiKey', 'removeMarketappApiKey',
    'finishWalletVerification', 'disconnectPublicWallet', 'deletePublicAccount', 'getPublicAccount', 'getStorageStatus', 'getGiftRefresh'];
  for (const endpoint of endpoints) {
    const run = setup(), outcome = run.transport.call(endpoint).catch(error => error);
    run.calls[0].callback(internal);
    assert.equal(errorCode(await outcome), 'INTERNAL');
    await run.timer.advance(180000); assert.equal(run.calls.length, 1, endpoint); assert.equal(run.timer.timerCount, 0);
  }
});

test('one overall deadline bounds both retry waits and in-flight attempts', async () => {
  const run = setup(2000), outcome = run.transport.call('getDashboard').catch(error => error);
  await run.timer.advance(100); run.calls[0].callback(internal);
  await run.timer.advance(800); assert.equal(run.calls.length, 2);
  await run.timer.advance(400); run.calls[1].callback(internal);
  await run.timer.advance(700);
  assert.equal(errorCode(await outcome), 'TIMEOUT');
  run.calls[1].callback(null, { stale: true });
  await run.timer.advance(10000); assert.equal(run.calls.length, 2); assert.equal(run.timer.timerCount, 0);
});

test('a callback delivered after a suspended WebView exceeded the deadline cannot publish or retry', async () => {
  for (const error of [null, internal]) {
    const run = setup(2000), outcome = run.transport.call('getDashboard').catch(problem => problem);
    run.timer.elapseWithoutTimers(2001);
    run.calls[0].callback(error, { late: true });
    assert.equal(errorCode(await outcome), 'TIMEOUT');
    assert.equal(run.calls.length, 1); assert.equal(run.timer.timerCount, 0);
  }
});

test('aborting a retry wait prevents further calls and clears all timers', async () => {
  const run = setup(), controller = new AbortController();
  const outcome = run.transport.call('getDashboard', {}, controller.signal).catch(error => error);
  run.calls[0].callback(internal);
  controller.abort();
  assert.equal(errorName(await outcome), 'AbortError');
  run.calls[0].callback(null, { stale: true });
  await run.timer.advance(90000); assert.equal(run.calls.length, 1); assert.equal(run.timer.timerCount, 0);
});

test('aborting a recovery attempt ignores its late callback and does not retry it', async () => {
  const run = setup(), controller = new AbortController();
  const outcome = run.transport.call('getDashboard', {}, controller.signal).catch(error => error);
  run.calls[0].callback(internal); await run.timer.advance(800);
  controller.abort(); assert.equal(errorName(await outcome), 'AbortError');
  run.calls[1].callback(internal); run.calls[1].callback(null, { stale: true });
  await run.timer.advance(90000); assert.equal(run.calls.length, 2); assert.equal(run.timer.timerCount, 0);
});

test('duplicate or late callbacks from an earlier attempt cannot settle or enqueue another retry', async () => {
  const run = setup(), pending = run.transport.call('getDashboard');
  let resolved = false; void pending.then(() => { resolved = true; });
  run.calls[0].callback(internal);
  run.calls[0].callback(internal); run.calls[0].callback(null, { stale: true });
  await run.timer.advance(800); assert.equal(run.calls.length, 2); assert.equal(resolved, false);
  run.calls[0].callback(null, { stale: true });
  run.calls[1].callback(null, { fresh: true });
  assert.deepEqual(await pending, { fresh: true });
  assert.equal(run.timer.timerCount, 0);
});

test('synchronous SDK callbacks and a later SDK throw keep one retry and its successful result', async () => {
  const timer = clock(); let calls = 0;
  const transport = createCloudTransport({ call(_name, _input, callback) {
    calls++;
    if (calls === 1) { callback(internal); callback(null, { stale: true }); throw new Error('private SDK failure'); }
    callback(null, { fresh: true }); throw new Error('private SDK failure');
  } }, 45000, 120000, timer.environment);
  const pending = transport.call('getDashboard');
  await timer.advance(800);
  assert.deepEqual(await pending, { fresh: true }); assert.equal(calls, 2); assert.equal(timer.timerCount, 0);
});

test('a synchronous SDK throw before any callback is not blindly retried', async () => {
  const timer = clock(); let calls = 0;
  const transport = createCloudTransport({ call() { calls++; throw new Error('private SDK failure'); } }, 45000, 120000, timer.environment);
  await assert.rejects(transport.call('getDashboard'), (error: CloudError) => error.code === 'TRANSPORT' && !error.message.includes('private SDK'));
  await timer.advance(90000); assert.equal(calls, 1); assert.equal(timer.timerCount, 0);
});

test('concurrent read recovery and cancellation remain independent', async () => {
  const run = setup(), controller = new AbortController();
  const dashboard = run.transport.call('getDashboard', {}, controller.signal).catch(error => error);
  const jobs = run.transport.call('getJobs');
  run.calls[0].callback(internal); run.calls[1].callback(internal);
  controller.abort(); assert.equal(errorName(await dashboard), 'AbortError');
  await run.timer.advance(800);
  assert.equal(run.calls.length, 3); assert.equal(run.calls[2].name, 'getJobs');
  run.calls[2].callback(null, { jobs: [] });
  assert.deepEqual(await jobs, { jobs: [] }); assert.equal(run.timer.timerCount, 0);
});

test('explicit backend busy and timeout read envelopes share the same bounded retry allowance', async () => {
  for (const endpoint of ['getDashboard', 'getDashboardRevision', 'getJobs'] as const) {
    const run = setup(), outcome = run.transport.call(endpoint).catch(error => error);
    run.calls[0].callback(null, { error: { code: 'READ_BUSY', message: 'private SQL details' } });
    await run.timer.advance(800);
    run.calls[1].callback(internal);
    await run.timer.advance(1600);
    run.calls[2].callback(null, { error: { code: 'READ_TIMEOUT', message: 'private SQL details' } });
    const error = await outcome;
    assert.ok(error instanceof CloudError); assert.equal(error.code, 'READ_TIMEOUT');
    assert.match(error.message, /\(READ_TIMEOUT\)/); assert.doesNotMatch(error.message + JSON.stringify(error), /private SQL/);
    await run.timer.advance(90000); assert.equal(run.calls.length, 3); assert.equal(run.timer.timerCount, 0);
  }
});

test('explicit backend transient read failures recover without repeating mutations', async () => {
  for (const code of ['READ_BUSY', 'READ_TIMEOUT']) {
    const run = setup(), pending = run.transport.call('getDashboard');
    run.calls[0].callback(null, { error: { code, message: 'private details' } });
    await run.timer.advance(800);
    run.calls[1].callback(null, { saved: true });
    assert.deepEqual(await pending, { saved: true }); assert.equal(run.timer.timerCount, 0);
    for (const endpoint of ['startJob', 'stepJob', 'startGiftRefresh', 'stepGiftRefresh', 'stepStorageMaintenance'] as const) {
      const mutation = setup(), outcome = mutation.transport.call(endpoint).catch(error => error);
      mutation.calls[0].callback(null, { error: { code, message: 'private details' } });
      assert.equal(errorCode(await outcome), code);
      await mutation.timer.advance(90000); assert.equal(mutation.calls.length, 1); assert.equal(mutation.timer.timerCount, 0);
    }
  }
});
