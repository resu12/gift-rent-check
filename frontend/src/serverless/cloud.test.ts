import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudTransport, CloudError } from './cloudTransport.ts';
import type { CloudTransport, CloudEndpoint } from './cloudTransport.ts';
import { CloudCollectionDriver } from './cloudDriver.ts';
import { createCloudDashboardAdapter, dashboardCsv } from './cloudAdapter.ts';
import type { Dashboard, Job, Gift } from '../data/types.ts';

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

test('invalid SDK response and expected backend errors fail without reflecting messages', async () => {
  for (const value of [null, [], 'unsafe', { error: { code: 'CONFIGURATION', message: 'secret' } }]) {
    const transport = createCloudTransport({ call(_n, _i, cb) { cb(null, value); } });
    await assert.rejects(transport.call('getJobs'), (error: CloudError) => !error.message.includes('secret'));
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
