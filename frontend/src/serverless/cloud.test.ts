import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudTransport, CloudError } from './cloudTransport.ts';
import type { CloudTransport, CloudEndpoint } from './cloudTransport.ts';
import { CloudCollectionDriver } from './cloudDriver.ts';
import { createCloudDashboardAdapter, dashboardCsv } from './cloudAdapter.ts';
import type { Dashboard, Job, Gift, PersonalRentalAnalytics } from '../data/types.ts';

const saved = (state: Job['state'] = 'running', progress: Record<string, unknown> = {}): Job => ({
  id: 1, kind: 'prices', state, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z',
  reason: null, run_id: 1, stop_requested: false, progress: { server_time: 1000, next_allowed_at: 0, lease_until: 0, ...progress },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function mockTransport(call: (name: CloudEndpoint, input: Record<string, unknown>) => unknown | Promise<unknown>): CloudTransport {
  return { call: async <T>(name: CloudEndpoint, input: Record<string, unknown> = {}) => await call(name, input) as T };
}

test('cloud dashboard revision is a lightweight read and rejects malformed tokens', async () => {
  const calls: unknown[] = [];
  let payload: unknown = { token: 'records-12-minute-3' };
  const adapter = createCloudDashboardAdapter(mockTransport((name, input) => {
    calls.push({ name, input });
    return payload;
  }));
  assert.equal(await adapter.getUpdateToken!(), 'records-12-minute-3');
  for (payload of [{}, { token: null }, { token: '' }, { token: 3 }, { token: 'x'.repeat(1025) }])
    await assert.rejects(adapter.getUpdateToken!(), /unexpected dashboard revision/);
  assert.ok(calls.every(call => JSON.stringify(call) === JSON.stringify({ name: 'getDashboardRevision', input: {} })));
});

test('cloud SDK transport sends only endpoint input and hides raw failures', async () => {
  const calls: unknown[] = [];
  const transport = createCloudTransport({ call(name, input, callback) { calls.push({ name, input }); callback(null, { jobs: [] }); } });
  assert.deepEqual(await transport.call('getJobs'), { jobs: [] });
  assert.deepEqual(calls, [{ name: 'getJobs', input: {} }]);
  for (const error of [{ type: 'UNAUTHORIZED', message: 'private secret' }, { type: 'UNKNOWN', message: 'private secret' }]) {
    const denied = createCloudTransport({ call(_name, _input, cb) { cb(error); } });
    await assert.rejects(denied.call('getDashboard'), (problem: CloudError) => !problem.message.includes('private secret'));
  }
  await assert.rejects(createCloudTransport().call('getJobs'), /private Mini App/);
});

test('timeout ignores late callback without repeating mutation and cancelled reads do not send', async () => {
  let callback!: (error: null, result: unknown) => void;
  let calls = 0;
  const transport = createCloudTransport({ call(_name, _input, cb) { calls += 1; callback = cb; } }, 5);
  await assert.rejects(transport.call('stepJob', { job_id: 1 }), (error: CloudError) => error.code === 'TIMEOUT');
  callback(null, { job: saved('complete') });
  assert.equal(calls, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(transport.call('getJobs', {}, abort.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('invitation denial gives the access action without provider or SDK details', async () => {
  const transport = createCloudTransport({call(_name, _input, cb) {cb(null, {error: {code: 'PUBLIC_ACCESS_DENIED', message: 'sensitive internal state'}});}});
  await assert.rejects(transport.call('getDashboard'), (error: CloudError) => error.code === 'PUBLIC_ACCESS_DENIED' && /not invited/.test(error.message) && /app owner/.test(error.message) && !error.message.includes('sensitive'));
});

test('invalid SDK response and expected backend errors fail without reflecting messages', async () => {
  for (const value of [null, [], 'unsafe', { error: { code: 'CONFIGURATION', message: 'secret' } }]) {
    const transport = createCloudTransport({ call(_n, _i, cb) { cb(null, value); } });
    await assert.rejects(transport.call('getJobs'), (error: CloudError) => !error.message.includes('secret'));
  }
});

test('full storage explains the failure safely without retrying either refresh', async () => {
  for (const endpoint of ['stepJob', 'startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'startGiftRefresh', 'stepGiftRefresh'] as const) {
    let calls = 0;
    const transport = createCloudTransport({ call(_name, _input, cb) {
      calls++; cb(null, { error: { code: 'STORAGE_FULL', message: 'Private SQL token wallet raw body' } });
    } });
    await assert.rejects(transport.call(endpoint), (error: CloudError) => {
      assert.equal(error.code, 'STORAGE_FULL'); assert.match(error.message, /storage is full.*progress.*maintenance/i);
      assert.equal(error.message.includes('Private SQL'), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test('Marketapp connection limits and expiry use safe fixed messages for SDK and backend errors', async () => {
  for (const code of ['MARKETAPP_LOGIN_RATE_LIMIT', 'MARKETAPP_LOGIN_EXPIRED']) {
    for (const envelope of [true, false]) {
      const transport = createCloudTransport({ call(_name, _input, cb) {
        const privateError = { code, type: code, message: 'Private provider nonce signature address' };
        if (envelope) cb(null, { error: privateError }); else cb(privateError);
      } });
      await assert.rejects(transport.call('startMarketappLoginTest'), (error: CloudError) => {
        assert.equal(error.code, code);
        assert.equal(error.message.includes('Private provider'), false);
        assert.match(error.message, code === 'MARKETAPP_LOGIN_RATE_LIMIT' ? /one minute.*five tests.*hour/ : /expired or was already used/);
        return true;
      });
    }
  }
});

test('analytics refresh error envelopes use fixed copy and never echo private session details', async () => {
  for (const suffix of ['FAILED', 'RATE_LIMIT', 'EXPIRED', 'INVALID_INPUT', 'PRIVATE_ACCESS_DENIED', 'WALLET_REQUIRED', 'AUTH_REJECTED', 'PAGE_CHANGED']) {
    const code = `MARKETAPP_REFRESH_${suffix}`;
    const transport = createCloudTransport({ call(_name, _input, cb) { cb(null, { error: { code, message: 'Private cookie proof encrypted-envelope' } }); } });
    await assert.rejects(transport.call('finishMarketappAnalyticsRefresh'), (error: CloudError) => {
      assert.equal(error.code, code); assert.equal(error.message.includes('Private cookie'), false); return true;
    });
  }
});

test('refresh rate errors project only validated deadline, duration and static reason metadata', async () => {
  const metadata = { retry_at: '2026-01-01T12:01:00.000Z', retry_after_seconds: 60, reason: 'hourly', message: 'Private cookie proof', unexpected: 'Private envelope' };
  const read = async (change: Record<string, unknown> = {}, code = 'MARKETAPP_REFRESH_RATE_LIMIT') => {
    const transport = createCloudTransport({ call(_name, _input, cb) { cb(null, { error: { code, ...metadata, ...change } }); } });
    try { await transport.call('startMarketappAnalyticsRefresh'); assert.fail('Expected a rate error'); } catch (error) { return error as CloudError; }
  };
  const valid = await read(); assert.equal(valid.retryAt, metadata.retry_at); assert.equal(valid.retryAfterSeconds, 60); assert.equal(valid.limitReason, 'hourly');
  assert.equal(JSON.stringify(valid).includes('Private'), false); assert.equal((valid as unknown as Record<string, unknown>).unexpected, undefined);
  for (const change of [{ retry_at: 'private token' }, { retry_at: '2026-02-30T12:01:00Z' }, { retry_at: '2026-01-01T12:01:00+00:00' },
    { retry_after_seconds: '60' }, { retry_after_seconds: 0 }, { retry_after_seconds: -1 }, { retry_after_seconds: 1.5 }, { retry_after_seconds: 86401 },
    { reason: 'private cookie' }, { reason: { toString: () => 'hourly' } }, { retry_at: undefined }, { reason: undefined }]) {
    const invalid = await read(change); assert.equal(invalid.retryAt, undefined); assert.equal(invalid.retryAfterSeconds, undefined); assert.equal(invalid.limitReason, undefined);
  }
  const other = await read({}, 'MARKETAPP_REFRESH_FAILED'); assert.equal(other.retryAfterSeconds, undefined);
  const unsafeCode = await read({}, 'Private cookie proof'); assert.equal(unsafeCode.code, 'SERVER'); assert.equal(JSON.stringify(unsafeCode).includes('Private'), false);
});

test('analytics finish has a separate deadline and never retries a timed-out login', async () => {
  let calls = 0;
  const transport = createCloudTransport({ call(_name, _input, cb) { calls++; setTimeout(() => cb(null, { synthetic: true }), 10); } }, 1, 100);
  assert.deepEqual(await transport.call('finishMarketappAnalyticsRefresh'), { synthetic: true });
  await assert.rejects(transport.call('startMarketappAnalyticsRefresh'), (error: CloudError) => error.code === 'TIMEOUT');
  assert.equal(calls, 2);
  let finishes = 0;
  const timeout = createCloudTransport({ call() { finishes++; } }, 100, 1);
  await assert.rejects(timeout.call('finishMarketappAnalyticsRefresh'), (error: CloudError) => error.code === 'TIMEOUT');
  assert.equal(finishes, 1);
});

test('personal analytics imports only the chosen snapshot and announces saved-data change', async () => {
  const snapshot = {version: 1, daily: []} as unknown as PersonalRentalAnalytics;
  const calls: unknown[] = []; const changed: unknown[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport((name, input) => {calls.push({name, input}); return {personal_analytics: snapshot};}));
  adapter.subscribe!(event => changed.push(event));
  assert.deepEqual(calls, [], 'creating the adapter never uploads analytics');
  assert.equal(await adapter.personalAnalytics!.importSnapshot('{"synthetic":true}', 'local-csrf'), snapshot);
  assert.deepEqual(calls, [{name: 'importPersonalAnalytics', input: {snapshot: '{"synthetic":true}'}}]);
  assert.deepEqual(changed, [{savedDataChanged: true}]);
  await assert.rejects(adapter.personalAnalytics!.importSnapshot('🦋'.repeat(70000), ''), /256 KiB/);
  assert.equal(calls.length, 1, 'oversized data does not reach Telegram');
});

test('personal analytics imports reject malformed server output without a saved-data notification', async () => {
  for (const response of [{}, {personal_analytics: {version: 2, daily: []}}, {personal_analytics: {version: 1}}]) {
    const adapter = createCloudDashboardAdapter(mockTransport(() => response)); let changed = false;
    adapter.subscribe!(() => {changed = true;});
    await assert.rejects(adapter.personalAnalytics!.importSnapshot('{}', ''), /unexpected analytics snapshot/);
    assert.equal(changed, false);
  }
});

test('driver performs sequential steps, waits for server pacing and ends on complete', async () => {
  let now = 1000; let steps = 0; let inFlight = 0;
  const waits: number[] = []; const states: string[] = [];
  const transport = mockTransport(async (name, input) => {
    assert.equal(name, 'stepJob'); assert.equal(input.job_id, 1);
    assert.equal(inFlight++, 0); await Promise.resolve(); inFlight--;
    return { job: ++steps === 1 ? saved('running', { server_time: now, next_allowed_at: now + 1000 }) : saved('complete') };
  });
  await new CloudCollectionDriver(saved(), { transport, now: () => now,
    wait: async ms => { waits.push(ms); now += ms; }, onJob: job => states.push(job.state), onError: assert.fail,
  }).run();
  assert.equal(steps, 2); assert.deepEqual(waits, [1000]); assert.deepEqual(states, ['running', 'complete']);
});

test('Stop during a pending step fences future steps and reconciles its commit with a read', async () => {
  const pending = deferred<{ job: Job }>(); const calls: string[] = []; let read = false;
  const transport = mockTransport(name => {
    calls.push(name);
    if (name === 'stepJob') return pending.promise;
    if (name === 'stopJob') return { job: saved('partial') };
    if (name === 'getJobs') { read = true; return { jobs: [saved('partial', { pages_committed: 1 })] }; }
    assert.fail(name);
  });
  const updates: Job[] = [];
  const driver = new CloudCollectionDriver(saved(), { transport, now: () => 1000, onJob: job => updates.push(job), onError: assert.fail });
  const running = driver.run();
  await driver.stop(); pending.resolve({ job: saved('running') }); await running;
  assert.deepEqual(calls, ['stepJob', 'stopJob', 'getJobs']); assert.equal(read, true);
  assert.equal(updates.at(-1)?.progress.pages_committed, 1);
});

test('interruption and ambiguous failure only read progress, never retry a mutation', async () => {
  const calls: string[] = []; const errors: string[] = [];
  const transport = mockTransport(name => { calls.push(name); if (name === 'stepJob') throw new CloudError('TIMEOUT', 'Timed out'); return { jobs: [saved('running', { requires_resume: true })] }; });
  await new CloudCollectionDriver(saved(), { transport, now: () => 1000, onJob() {}, onError: message => errors.push(message) }).run();
  assert.deepEqual(calls, ['stepJob', 'getJobs']); assert.deepEqual(errors, ['Timed out']);
});

test('an uncertain step confirms the saved pause once after its live lease ends', async () => {
  let now = 1000, reads = 0;
  const calls: CloudEndpoint[] = [], states: string[] = [], waits: number[] = [], interrupted: Job[] = [];
  const transport = mockTransport(name => {
    calls.push(name);
    if (name === 'stepJob') throw new CloudError('TIMEOUT', 'Timed out');
    assert.equal(name, 'getJobs');
    return { jobs: [++reads === 1 ? saved('running', { server_time: 900000, lease_until: 903000, requires_resume: false })
      : saved('partial', { server_time: 903001, lease_until: 0, requires_resume: false })] };
  });
  await new CloudCollectionDriver(saved(), { transport, now: () => now,
    wait: async ms => { waits.push(ms); now -= ms; }, onJob: job => states.push(job.state), onError() {},
    onInterrupted: job => interrupted.push(job),
  }).run();
  assert.deepEqual(calls, ['stepJob', 'getJobs', 'getJobs']);
  assert.deepEqual(states, ['running', 'partial']); assert.equal(interrupted.length, 1);
  assert.equal(waits.reduce((total, ms) => total + ms, 0), 3001, 'lease delay uses server-clock duration despite a device clock correction');
});

test('lease reconciliation never waits beyond 120 seconds or follows malformed clocks', async () => {
  for (const progress of [{server_time: 1000, lease_until: 121000}, {server_time: 1000, lease_until: 121001},
    {server_time: 1000, lease_until: Infinity}, {server_time: NaN, lease_until: 3000}, {server_time: 1000, lease_until: '3000'}]) {
    let now = 1000, reads = 0, waited = 0;
    await new CloudCollectionDriver(saved(), { transport: mockTransport(name => {
      if (name === 'stepJob') throw new CloudError('TIMEOUT', 'Timed out');
      assert.equal(name, 'getJobs'); reads++; return {jobs: [saved('running', progress)]};
    }), now: () => now, wait: async ms => { now += ms; waited += ms; }, onJob() {}, onError() {} }).run();
    assert.ok(waited <= 120000);
    assert.equal(reads, progress.lease_until === 121000 ? 2 : 1);
  }
});

test('hidden or changed views cancel lease reconciliation without another request', async () => {
  let allowed = true, reads = 0;
  const states: Job[] = [];
  await new CloudCollectionDriver(saved(), { transport: mockTransport(name => {
    if (name === 'stepJob') throw new CloudError('TIMEOUT', 'Timed out');
    assert.equal(name, 'getJobs'); reads++; return {jobs: [saved('running', {server_time: 1000, lease_until: 100000})]};
  }), canReconcile: () => allowed, now: () => 1000, wait: async () => { allowed = false; }, onJob: job => states.push(job), onError() {} }).run();
  assert.equal(reads, 1); assert.equal(states.length, 1);
});

test('another local driver or explicit interruption cancels the delayed status read', async () => {
  const waiting = deferred<void>(); let reads = 0, resolveWait!: () => void;
  const driver = new CloudCollectionDriver(saved(), { transport: mockTransport(name => {
    if (name === 'stepJob') throw new CloudError('TIMEOUT', 'Timed out');
    assert.equal(name, 'getJobs'); reads++; return {jobs: [saved('running', {server_time: 1000, lease_until: 100000})]};
  }), now: () => 1000, wait: async (_ms, signal) => {
    waiting.resolve(); return new Promise<void>(resolve => { resolveWait = resolve; signal.addEventListener('abort', () => resolve(), {once: true}); });
  }, onJob() {}, onError() {} });
  const run = driver.run(); await waiting.promise; driver.interrupt(); resolveWait(); await run;
  assert.equal(reads, 1);
});

test('automatic driver failure remains Waiting while a backend lease finishes, without step retry', async () => {
  let reads = 0;
  const calls: CloudEndpoint[] = [], updates: Job[] = [];
  const finishing = saved('running', {server_time: 1000, lease_until: 121001, requires_resume: false});
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name);
    if (name === 'refreshStartupComparisons') return {state: 'started', job: saved()};
    if (name === 'stepJob') throw new CloudError('TIMEOUT', 'Timed out');
    assert.equal(name, 'getJobs'); reads++; return {jobs: [finishing]};
  }));
  adapter.subscribe!(event => { if (event.job) updates.push(event.job); });
  await adapter.startupComparisonRefresh!({source: 'listings', timeframe: '30d'});
  for (let index = 0; index < 10; index++) await Promise.resolve();
  const latest = updates.at(-1)!;
  assert.equal(latest.state, 'running'); assert.equal(latest.progress.requires_resume, false);
  assert.equal(latest.progress.client_interrupted, true);
  assert.equal((await adapter.getJobs())[0].progress.client_interrupted, true, 'polling preserves the local interrupted marker');
  assert.equal(calls.filter(name => name === 'stepJob').length, 1); assert.equal(calls.includes('stopJob'), false); assert.equal(reads, 2);
});

test('hiding a view retains its interrupted marker but fences delayed saved-status reads', async () => {
  const pending = deferred<{job: Job}>();
  const calls: CloudEndpoint[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name);
    if (name === 'startJob') return {job: saved()};
    if (name === 'stepJob') return pending.promise;
    assert.equal(name, 'getJobs'); return {jobs: [saved('running', {server_time: 1000, lease_until: 3000, requires_resume: false})]};
  }));
  await adapter.startJob('prices', ''); adapter.interrupt(); pending.resolve({job: saved()});
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(calls, ['startJob', 'stepJob'], 'hidden generation does not schedule another status read');
  const [job] = await adapter.getJobs();
  assert.equal(job.progress.client_interrupted, true); assert.equal(job.progress.requires_resume, false);
});

test('interruption preserves a newer commit already observed by status polling', async () => {
  let rejectStep!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { rejectStep = reject; });
  const seen = {...saved('running', {server_time: 1000, lease_until: 121001, requires_resume: false, pages: 1, observations: 100}), updated_at: '2026-10-09T00:01:00Z'};
  const updates: Job[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    if (name === 'startJob') return {job: saved('running', {pages: 0, observations: 0})};
    if (name === 'stepJob') return pending;
    assert.equal(name, 'getJobs'); return {jobs: [seen]};
  }));
  adapter.subscribe!(event => { if (event.job) updates.push(event.job); });
  await adapter.startJob('prices', ''); await adapter.getJobs(); rejectStep(new CloudError('TIMEOUT', 'Timed out'));
  for (let index = 0; index < 10; index++) await Promise.resolve();
  const interrupted = updates.filter(job => job.progress.client_interrupted);
  assert.ok(interrupted.length > 0); assert.ok(interrupted.every(job => job.progress.pages === 1 && job.progress.observations === 100));
});

test('a delayed saved status read cannot undo a completed step or reintroduce its active lease', async () => {
  const step = deferred<{ job: Job }>(), polling = deferred<{ jobs: Job[] }>();
  const complete = { ...saved('complete', { pages: 2, observations: 200, server_time: 3000 }), updated_at: '2026-10-09T00:00:02Z' };
  const updates: Job[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    if (name === 'startJob') return { job: saved() };
    if (name === 'stepJob') return step.promise;
    assert.equal(name, 'getJobs'); return polling.promise;
  }));
  adapter.subscribe!(event => { if (event.job) updates.push(event.job); });
  await adapter.startJob('prices', '');
  const pendingRead = adapter.getJobs();
  step.resolve({ job: complete });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(updates.at(-1)?.state, 'complete');
  polling.resolve({ jobs: [saved('running', { pages: 1, observations: 100, server_time: 2000, lease_until: 122000 })] });
  assert.deepEqual((await pendingRead)[0], { ...complete, progress: { ...complete.progress, requires_resume: false } },
    'late polling keeps the completed state, records and cleared lease');
});

test('saved replies with the same commit time use server observation order without freezing later progress', async () => {
  const values = [
    saved('running', { pages: 1, server_time: 3000, lease_until: 0 }),
    saved('running', { pages: 1, server_time: 2000, lease_until: 122000 }),
    saved('running', { pages: 1, server_time: 4000, lease_until: 124000 }),
    { ...saved('complete', { pages: 2, server_time: 4000, lease_until: 0 }), updated_at: '2026-10-09T00:00:02Z' },
    { ...saved('running', { pages: 1, server_time: 5000, lease_until: 125000 }), updated_at: '2026-10-09T00:00:02Z' },
    { ...saved('partial', { pages: 1, server_time: 6000, lease_until: 0 }), updated_at: '2026-10-09T00:00:02Z' },
  ];
  const adapter = createCloudDashboardAdapter(mockTransport(name => { assert.equal(name, 'getJobs'); return { jobs: [values.shift()] }; }));
  const first = (await adapter.getJobs())[0];
  assert.deepEqual((await adapter.getJobs())[0], first);
  assert.equal((await adapter.getJobs())[0].progress.lease_until, 124000, 'a later provider request remains visible');
  assert.equal((await adapter.getJobs())[0].state, 'complete');
  assert.equal((await adapter.getJobs())[0].state, 'complete', 'terminal jobs cannot resume even when an older read was projected later');
  assert.equal((await adapter.getJobs())[0].state, 'complete', 'an earlier pause cannot restore Continue for a finished traversal');
});

test('long Retry-After and maximum step budget pause before another provider step', async () => {
  for (const options of [{ next_allowed_at: 400000 }, {}]) {
    let steps = 0; let stops = 0;
    const transport = mockTransport(name => {
      if (name === 'stepJob') { steps++; return { job: saved() }; }
      if (name === 'stopJob') { stops++; return { job: saved('partial') }; }
      return { jobs: [saved('partial')] };
    });
    await new CloudCollectionDriver(saved('running', options), { transport, now: () => 1000, maxCalls: 2, onJob() {}, onError() {} }).run();
    assert.equal(steps, options.next_allowed_at ? 0 : 2); assert.equal(stops, 1);
  }
});

test('cold reads do not resume and adapter rejects unsupported jobs before network', async () => {
  const calls: string[] = [];
  const transport = mockTransport(name => { calls.push(name); return { jobs: [saved('running', { requires_resume: true })] }; });
  const adapter = createCloudDashboardAdapter(transport);
  assert.equal((await adapter.getJobs())[0].progress.requires_resume, true);
  await assert.rejects(adapter.startJob('discover', ''), /not available/);
  await assert.rejects(adapter.startJob('refresh', ''), /not available/);
  assert.deepEqual(calls, ['getJobs']);
});

test('new cloud job freezes selected window and driver starts only on explicit action', async () => {
  const calls: { name: string; input: unknown }[] = [];
  const stepped = deferred<void>();
  const transport = mockTransport((name, input) => {
    calls.push({ name, input });
    if (name === 'startJob') return { job: saved() };
    if (name === 'stepJob') { stepped.resolve(); return { job: saved('complete') }; }
    return { jobs: [] };
  });
  const adapter = createCloudDashboardAdapter(transport);
  assert.equal(calls.length, 0);
  await adapter.startJob('prices', 'ignored-local-csrf', { source: 'listings', timeframe: '60d' });
  await stepped.promise;
  assert.deepEqual(calls[0], { name: 'startJob', input: { kind: 'prices', timeframe: '60d' } });
  assert.equal(calls[1].name, 'stepJob');
});

test('manual comparison completion announces its final saved evidence without another provider step', async () => {
  const pending = deferred<{ job: Job }>();
  const calls: CloudEndpoint[] = [], events: { job?: Job; error?: string; savedDataChanged?: boolean }[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name);
    if (name === 'startJob') return { job: saved() };
    assert.equal(name, 'stepJob'); return pending.promise;
  }));
  adapter.subscribe!(event => events.push(event));
  await adapter.startJob('prices', '');
  assert.equal(events.some(event => event.savedDataChanged), false);
  pending.resolve({ job: saved('complete', { pages: 2, streams_complete: 1 }) });
  for (let index = 0; index < 16; index++) await Promise.resolve();
  assert.equal(events.filter(event => event.savedDataChanged).length, 1);
  assert.equal(events.filter(event => event.job).at(-1)?.job?.state, 'complete');
  assert.deepEqual(calls, ['startJob', 'stepJob']);
});

test('manual driver callbacks and final reload cannot cross an interrupted account context', async () => {
  const pending = deferred<{ job: Job }>();
  const events: { job?: Job; error?: string; savedDataChanged?: boolean }[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    if (name === 'startJob') return { job: saved() };
    assert.equal(name, 'stepJob'); return pending.promise;
  }));
  adapter.subscribe!(event => events.push(event));
  await adapter.startJob('prices', '');
  adapter.interrupt();
  const count = events.length;
  pending.resolve({ job: saved('complete') });
  for (let index = 0; index < 16; index++) await Promise.resolve();
  assert.equal(events.length, count, 'late mutation outcome belongs only to the previous view');
  assert.equal(events.some(event => event.savedDataChanged), false);
});

test('forced comparison refresh is explicit on new cloud jobs and never carried into Resume', async () => {
  const calls: {name: string; input: unknown}[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport((name, input) => {calls.push({name, input}); return {job: saved('complete')};}));
  await adapter.startJob('rental_prices', '', {source: 'rentals', timeframe: '60d'}, {forceRefresh: true});
  await adapter.startJob('prices', '', {source: 'listings', timeframe: '30d'});
  await adapter.resumeJob(7, '');
  assert.deepEqual(calls, [
    {name: 'startJob', input: {kind: 'rental_prices', timeframe: '60d', force_refresh: true}},
    {name: 'startJob', input: {kind: 'prices', timeframe: '30d'}},
    {name: 'resumeJob', input: {job_id: 7}},
  ]);
});

test('hiding while Start is pending prevents the first step and allows manual recovery', async () => {
  const pending = deferred<{ job: Job }>(); const calls: string[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => { calls.push(name); return pending.promise; }));
  const starting = adapter.startJob('prices', ''); adapter.interrupt(); pending.resolve({ job: saved() });
  const job = await starting;
  assert.equal(job.progress.requires_resume, true); assert.deepEqual(calls, ['startJob']);
});

test('ambiguous Start checks state once, never starts a second run or sends a step', async () => {
  const calls: string[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => { calls.push(name); if (name === 'startJob') throw new Error('Timed out'); return { jobs: [saved('running', { requires_resume: true })] }; }));
  await assert.rejects(adapter.startJob('prices', ''), /Timed out/);
  assert.deepEqual(calls, ['startJob', 'getJobs']);
});

test('CSV export retains unknowns and provenance, escapes formulas and uses exact Black selection', () => {
  const gift = { id: '1', nft_address: 'address', name: '=test()', is_portfolio: true, backdrop: 'Black', price_per_day: '0.17', membership_sources: ['ton_verified'], observed_at: '2026-10-09', uncertainties: ['Imported ownership evidence'], rental_history: { recorded_count: null, coverage: 'no_history' } } as Gift;
  const data = { gifts: [gift, { ...gift, id: '2', backdrop: 'Onyx' }] } as Dashboard;
  const csv = dashboardCsv(data, { source: 'rentals', timeframe: '30d', backdrop: 'Black' });
  assert.equal(csv.split('\r\n').length, 3); assert.ok(csv.includes("'\u003dtest()"));
  assert.ok(csv.includes('"ton_verified"')); assert.ok(csv.includes('"","no_history"'));
  assert.ok(csv.includes('"0.170"'));
  assert.ok(!csv.includes('Onyx'));
});
