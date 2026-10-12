import assert from 'node:assert/strict';
import test from 'node:test';
import { createComparisonStartupGate, readComparisonStartupResult } from './comparisonsStartup.ts';
import type { ComparisonStartupContext } from './comparisonsStartup.ts';
import type { ComparisonStartupResult, Dashboard, Job, PricingSelection } from '../data/types.ts';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { CloudCollectionDriver } from './cloudDriver.ts';
import { createCloudTransport } from './cloudTransport.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';
import { createLocalDashboardAdapter } from '../data/local.ts';

const selection: PricingSelection = { source: 'rentals', timeframe: '30d' };
const context = (changes: Partial<ComparisonStartupContext> = {}): ComparisonStartupContext => ({ identity: 'wallet:0:false', enabled: true, selection, ...changes });
const job = (changes: Partial<Job> = {}): Job => ({
  id: 10, kind: 'rental_prices', state: 'running', created_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:00:00Z',
  reason: null, run_id: 10, stop_requested: false, progress: { requires_resume: false }, ...changes,
});
const tick = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject };
}
function setup(response?: () => Promise<ComparisonStartupResult>) {
  let hidden = false, nextTimer = 0;
  const calls: { selection: PricingSelection; signal: AbortSignal }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const gate = createComparisonStartupGate({
    refresh: async (chosen, signal) => { calls.push({ selection: chosen, signal }); return response ? response() : { state: 'fresh' }; },
    isHidden: () => hidden,
    timer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear: id => { timers.delete(id as unknown as number); },
  });
  return { gate, calls, timers,
    hide(value: boolean) { hidden = value; gate.visibilityChanged(); },
    ready() { gate.dashboardLoaded(context()); gate.giftsChanged(true); gate.analyticsChanged(true); },
    start() { const entry = [...timers.entries()].find(([, value]) => value.delay === 1100); if (entry) { timers.delete(entry[0]); entry[1].callback(); } },
  };
}
function mockTransport(call: (endpoint: CloudEndpoint, input: Record<string, unknown>) => unknown | Promise<unknown>): CloudTransport {
  return { call: async <T>(endpoint: CloudEndpoint, input: Record<string, unknown> = {}) => await call(endpoint, input) as T };
}
const wallet = '0:' + 'a'.repeat(64);
const dashboard = (changes: Partial<Dashboard> = {}): Dashboard => ({
  wallet, gifts: [], summary: {}, capabilities: { public_account: false }, ...changes,
} as Dashboard);

test('startup comparison waits for gift and analytics completion and a pacing grace', async () => {
  const h = setup(); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true);
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  h.gate.analyticsChanged(true); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 1);
  h.start(); await tick(); assert.equal(h.calls.length, 1); assert.equal(h.gate.getSnapshot().phase, 'fresh'); assert.equal(h.timers.size, 0);
  h.ready(); h.hide(false); h.start(); await tick(); assert.equal(h.calls.length, 1);
});

test('comparison freezes initial source and timeframe across filters, tabs and dashboard reloads', async () => {
  const h = setup(); const first = { source: 'listings', timeframe: 'custom', dateFrom: '2026-10-10', dateTo: '2026-10-11' } as PricingSelection;
  h.gate.dashboardLoaded(context({ selection: first })); h.gate.dashboardLoaded(null);
  h.gate.dashboardLoaded(context({ selection: { source: 'rentals', timeframe: '90d', backdrop: 'Black' } }));
  h.gate.giftsChanged(true); h.gate.analyticsChanged(true); h.start(); await tick();
  assert.deepEqual(h.calls[0].selection, first);
  first.timeframe = '7d'; assert.equal(h.calls[0].selection.timeframe, 'custom');
});

test('hidden initial opening waits until visible and never refreshes merely from showing again', async () => {
  const h = setup(); h.hide(true); h.ready(); h.start(); assert.equal(h.calls.length, 0);
  h.hide(false); h.start(); await tick(); assert.equal(h.calls.length, 1);
  h.hide(true); h.hide(false); h.start(); await tick(); assert.equal(h.calls.length, 1);
});

test('missing eligibility cannot make a startup API request', async () => {
  const h = setup(); h.gate.dashboardLoaded(context({ enabled: false })); h.gate.giftsChanged(true); h.gate.analyticsChanged(true);
  h.start(); await tick(); assert.equal(h.calls.length, 0); assert.equal(h.gate.getSnapshot().phase, 'idle');
});

test('grace is cancelled by new gifts, analytics, manual jobs, active jobs, hidden state or absent data', async () => {
  for (const blocker of ['gifts', 'analytics', 'manual', 'jobs', 'hidden', 'data']) {
    const h = setup(); h.ready(); assert.equal(h.timers.size, 1);
    if (blocker === 'gifts') h.gate.giftsChanged(false);
    if (blocker === 'analytics') h.gate.analyticsChanged(false);
    if (blocker === 'manual') h.gate.manualChanged(true);
    if (blocker === 'jobs') h.gate.jobsChanged(true);
    if (blocker === 'hidden') h.hide(true);
    if (blocker === 'data') h.gate.dashboardLoaded(null);
    h.start(); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
    if (blocker === 'gifts') h.gate.giftsChanged(true);
    if (blocker === 'analytics') h.gate.analyticsChanged(true);
    if (blocker === 'manual') h.gate.manualChanged(false);
    if (blocker === 'jobs') h.gate.jobsChanged(false);
    if (blocker === 'hidden') h.hide(false);
    if (blocker === 'data') h.gate.dashboardLoaded(context());
    h.start(); await tick(); assert.equal(h.calls.length, 1);
  }
});

test('explicit comparison action before startup suppresses automatic work for this page', async () => {
  const h = setup(); h.ready(); h.gate.manualAction(); h.gate.jobsChanged(true); h.gate.jobsChanged(false);
  h.ready(); h.start(); await tick(); assert.equal(h.calls.length, 0); assert.equal(h.gate.getSnapshot().phase, 'skipped');
});

test('account, wallet and public identity changes inhibit startup for this page', async () => {
  for (const identity of ['other:0:false', 'wallet:1:false', 'wallet:0:true']) {
    const h = setup(); h.ready(); h.gate.dashboardLoaded(context({ identity })); h.gate.dashboardLoaded(context());
    h.start(); await tick(); assert.equal(h.calls.length, 0); assert.equal(h.gate.getSnapshot().phase, 'idle');
  }
});

test('account changes fence late startup replies', async () => {
  const pending = deferred<ComparisonStartupResult>(), h = setup(() => pending.promise);
  h.ready(); h.start(); h.gate.dashboardLoaded(context({ identity: 'other:0:false' }));
  assert.equal(h.calls[0].signal.aborted, true); pending.resolve({ state: 'started', job: job() }); await tick();
  assert.equal(h.gate.getSnapshot().phase, 'idle'); assert.equal(h.gate.getSnapshot().busy, false);
});

test('hide aborts future work including a started driver and does not relaunch', async () => {
  const h = setup(async () => ({ state: 'started', job: job() })); h.ready(); h.start(); await tick();
  assert.equal(h.calls[0].signal.aborted, false); assert.equal(h.gate.getSnapshot().busy, false);
  h.hide(true); assert.equal(h.calls[0].signal.aborted, true); h.hide(false); h.start(); await tick(); assert.equal(h.calls.length, 1);
});

test('limited, unavailable, busy and failed transport outcomes silently preserve saved data without retries', async () => {
  for (const response of [{ state: 'limited', reason: 'daily_limit' }, { state: 'busy', reason: 'active_job' },
    { state: 'unavailable', reason: 'key_missing' }, null] as (ComparisonStartupResult | null)[]) {
    const h = setup(async () => { if (!response) throw new Error('Private provider secret'); return response; });
    h.ready(); h.start(); await tick(); assert.equal(h.gate.getSnapshot().phase, response?.state ?? 'unavailable');
    h.ready(); h.hide(false); h.start(); await tick(); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
    assert.equal(JSON.stringify(h.gate.getSnapshot()).includes('Private'), false);
  }
});

test('fixed response validation rejects malformed jobs, private metadata and unknown reasons', () => {
  for (const value of [null, [], {}, { state: 'fresh', reason: 'private' }, { state: 'fresh', job: job() },
    { state: 'started', job: job({ state: 'complete' }) }, { state: 'started', job: job({ kind: 'discover' }) },
    { state: 'started', job: job(), cookie: 'private' }, { state: 'limited', reason: 'arbitrary' },
    { state: 'limited', reason: 'daily_limit', retry_at: '2026-02-30T00:00:00Z' }])
    assert.throws(() => readComparisonStartupResult(value), /unexpected/i);
  assert.deepEqual(readComparisonStartupResult({ state: 'started', job: job() }), { state: 'started', job: job() });
  assert.deepEqual(readComparisonStartupResult({ state: 'fresh' }), { state: 'fresh' });
});

test('automatic request timeout aborts the local gate once, without mutation retries', async () => {
  const pending = deferred<ComparisonStartupResult>(), h = setup(() => pending.promise); h.ready(); h.start();
  const deadline = [...h.timers.entries()].find(([, entry]) => entry.delay === 60000)!;
  h.timers.delete(deadline[0]); deadline[1].callback(); assert.equal(h.calls[0].signal.aborted, true);
  pending.resolve({ state: 'fresh' }); await tick(); h.ready(); h.start(); assert.equal(h.calls.length, 1);
  assert.equal(h.gate.getSnapshot().busy, false); h.gate.dispose(); assert.equal(h.timers.size, 0);
});

test('local adapter has no automatic comparison mutation', () => {
  assert.equal(createLocalDashboardAdapter().startupComparisonRefresh, undefined);
});

test('cloud startup route sends only frozen source/window and starts a bounded normal job driver', async () => {
  const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [], events: unknown[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport((name, input) => {
    calls.push({ name, input });
    if (name === 'refreshStartupComparisons') return { state: 'started', job: job() };
    if (name === 'stepJob') return { job: job({ state: 'complete' }) };
    if (name === 'getJobs') return { jobs: [job({ state: 'complete' })] };
    throw new Error('Unexpected route');
  }));
  adapter.subscribe!(event => events.push(event));
  const result = await adapter.startupComparisonRefresh!({ source: 'rentals', timeframe: '7d', backdrop: 'Black' }); await tick();
  assert.equal(result.state, 'started');
  assert.deepEqual(calls[0], { name: 'refreshStartupComparisons', input: { kind: 'rental_prices', timeframe: '7d' } });
  assert.equal(calls.filter(call => call.name === 'refreshStartupComparisons').length, 1);
  assert.ok(events.some(event => (event as { savedDataChanged?: boolean }).savedDataChanged));
  assert.equal(events.some(event => (event as { error?: string }).error), false);
});

test('cloud fresh and expected skip outcomes never create a driver, wallet approval or provider step', async () => {
  for (const response of [{ state: 'fresh' }, { state: 'limited', reason: 'daily_limit' }, { state: 'unavailable', reason: 'key_missing' }] as ComparisonStartupResult[]) {
    const calls: CloudEndpoint[] = [], adapter = createCloudDashboardAdapter(mockTransport(name => { calls.push(name); return response; }));
    assert.deepEqual(await adapter.startupComparisonRefresh!(selection), response); await tick();
    assert.deepEqual(calls, ['refreshStartupComparisons']);
  }
});

test('public startup sends and validates the account incarnation', async () => {
  const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport((name, input) => {
    calls.push({ name, input });
    if (name === 'getDashboard') return dashboard({ capabilities: { public_account: true, account_generation: 4 } as Dashboard['capabilities'] });
    if (name === 'refreshStartupComparisons') return { state: 'started', job: job({ account_generation: 4 }) };
    if (name === 'stepJob') return { job: job({ state: 'complete', account_generation: 4 }) };
    return { jobs: [] };
  }));
  await adapter.getDashboard(selection); await adapter.startupComparisonRefresh!(selection); await tick();
  assert.deepEqual(calls.find(call => call.name === 'refreshStartupComparisons')!.input, { kind: 'rental_prices', timeframe: '30d', account_generation: 4 });
  assert.ok(calls.filter(call => call.name === 'stepJob').every(call => call.input.account_generation === 4));
});

test('wallet change while startup mutation is pending prevents the driver and job publication', async () => {
  const pending = deferred<ComparisonStartupResult>(); let savedWallet = wallet;
  const calls: CloudEndpoint[] = [], events: unknown[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name); if (name === 'getDashboard') return dashboard({ wallet: savedWallet });
    if (name === 'refreshStartupComparisons') return pending.promise;
    return { jobs: [] };
  }));
  adapter.subscribe!(event => events.push(event)); await adapter.getDashboard(selection);
  const request = adapter.startupComparisonRefresh!(selection); savedWallet = '0:' + 'b'.repeat(64); await adapter.getDashboard(selection);
  pending.resolve({ state: 'started', job: job() }); await assert.rejects(request, /account changed/i); await tick();
  assert.equal(calls.includes('stepJob'), false); assert.deepEqual(events, []);
});

test('hidden startup mutation finishes visibly in saved progress without attaching another driver', async () => {
  const pending = deferred<ComparisonStartupResult>(), abort = new AbortController();
  const calls: CloudEndpoint[] = [], adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name); return name === 'refreshStartupComparisons' ? pending.promise : { jobs: [job({ progress: { requires_resume: true } })] };
  }));
  const request = adapter.startupComparisonRefresh!(selection, abort.signal); abort.abort(); pending.resolve({ state: 'started', job: job() });
  await request; await tick(); assert.deepEqual(calls, ['refreshStartupComparisons', 'getJobs']);
});

test('automatic driver client bound silently interrupts and reads progress without recording user Stop', async () => {
  const calls: CloudEndpoint[] = [], errors: string[] = [];
  const driver = new CloudCollectionDriver(job(), {
    transport: mockTransport(name => { calls.push(name); return { jobs: [job()] }; }),
    onJob: () => {}, onError: message => errors.push(message), maxCalls: 0, boundAction: 'interrupt',
  });
  await driver.run(); assert.deepEqual(calls, ['getJobs']); assert.deepEqual(errors, []); assert.equal(driver.interrupted, true);
});

test('startup driver never exceeds its smaller client call budget or emits a generic error', async () => {
  const calls: CloudEndpoint[] = [], errors: unknown[] = [];
  const adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name); if (name === 'refreshStartupComparisons') return { state: 'started', job: job() };
    if (name === 'stepJob') return { job: job() };
    return { jobs: [job({ progress: { requires_resume: true } })] };
  }));
  adapter.subscribe!(event => { if (event.error) errors.push(event.error); });
  await adapter.startupComparisonRefresh!(selection); for (let index = 0; index < 50; index++) await tick();
  assert.equal(calls.filter(name => name === 'stepJob').length, 25); assert.equal(calls.includes('stopJob'), false); assert.deepEqual(errors, []);
});

test('automatic driver pauses future steps on hide and reconciles an in-flight mutation once', async () => {
  const pending = deferred<{ job: Job }>(), abort = new AbortController();
  const calls: CloudEndpoint[] = [], adapter = createCloudDashboardAdapter(mockTransport(name => {
    calls.push(name); if (name === 'refreshStartupComparisons') return { state: 'started', job: job() };
    if (name === 'stepJob') return pending.promise;
    return { jobs: [job({ state: 'partial' })] };
  }));
  await adapter.startupComparisonRefresh!(selection, abort.signal); assert.equal(calls.filter(name => name === 'stepJob').length, 1);
  abort.abort(); pending.resolve({ job: job() }); await tick();
  assert.deepEqual(calls, ['refreshStartupComparisons', 'stepJob', 'getJobs']);
});

test('startup transport does not repeat a timed-out mutation or reflect server secrets', async () => {
  let calls = 0;
  const timeout = createCloudTransport({ call() { calls++; } }, 1);
  await assert.rejects(timeout.call('refreshStartupComparisons', { kind: 'prices', timeframe: '30d' }), /timed out/i); assert.equal(calls, 1);
  const failed = createCloudTransport({ call(_name, _input, callback) { callback(null, { error: { code: 'INVALID_INPUT', message: 'Private API token' } }); } });
  await assert.rejects(failed.call('refreshStartupComparisons'), (problem: Error) => !problem.message.includes('Private API token'));
});
