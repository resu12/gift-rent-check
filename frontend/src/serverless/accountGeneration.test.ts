import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudCollectionDriver } from './cloudDriver.ts';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { selectPublicDiscovery } from './publicAccount.ts';
import { OwnedPriceRefreshDriver, readOwnedPriceResponse } from '../data/ownedPriceRefresh.ts';
import type { Dashboard, Job } from '../data/types.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';
import type { OwnedPriceResponse, OwnedPriceEndpoint } from '../data/ownedPriceRefresh.ts';

const time = '2026-10-10T12:00:00.000Z';
const account = (generation = 0) => ({ public_mode: true as const, account_generation: generation, wallet: null,
  marketapp_key: { configured: false, updated_at: null }, onboarding_complete: false });
const job = (generation = 0, state: Job['state'] = 'running', id = 1): Job => ({ id, account_generation: generation, kind: 'discover', state,
  created_at: time, updated_at: time, reason: null, run_id: id, stop_requested: false, progress: {} });
const dashboard = (generation: number): Dashboard => ({ gifts: [], summary: {}, capabilities: { public_account: true, account_generation: generation } } as unknown as Dashboard);
const response = (generation = 0, state: 'running' | 'partial' = 'running', checked = 0): OwnedPriceResponse => ({ run: {
  id: 1, account_generation: generation, state, total: 1, checked, updated: checked, unresolved: 0,
  reason: null, started_at: time, completed_at: null,
}, server_time: 0, next_allowed_at: 0 });
function transport(handler: (name: CloudEndpoint, input: Record<string, unknown>) => unknown | Promise<unknown>): CloudTransport {
  return { async call<T>(name: CloudEndpoint, input: Record<string, unknown> = {}) { return await handler(name, input) as T; } };
}

test('collection driver freezes generation zero for Step and Stop and ignores another incarnation in reconciliation', async () => {
  const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [], changes: Job[] = [], errors: string[] = [];
  const driver = new CloudCollectionDriver(job(), { transport: transport((name, input) => {
    calls.push({ name, input });
    if (name === 'stepJob') return { job: job(2, 'partial') };
    if (name === 'getJobs') return { jobs: [job(2, 'partial')] };
    return { job: job(0, 'partial') };
  }), onJob: next => changes.push(next), onError: error => errors.push(error) });
  await driver.run(); assert.equal(errors.length, 1); assert.equal(changes.length, 0);
  await driver.stop(); assert.equal(changes[0].account_generation, 0);
  assert.deepEqual(calls, [{ name: 'stepJob', input: { job_id: 1, account_generation: 0 } },
    { name: 'getJobs', input: {} }, { name: 'stopJob', input: { job_id: 1, account_generation: 0 } }]);
});

test('public adapters preserve explicit old generations and never infer an epoch for existing-job commands', async () => {
  const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [];
  let generation = 0;
  const adapter = createCloudDashboardAdapter(transport((name, input) => {
    calls.push({ name, input });
    if (name === 'getPublicAccount') return { account: account(generation) };
    if (name === 'getJobs') return { jobs: [job(generation, 'partial')] };
    if (name === 'startJob') return { job: job(generation, 'complete') };
    if (name === 'startOwnedPriceRefresh') return response(generation, 'partial');
    throw new Error('PUBLIC_ACCOUNT_CHANGED');
  }));
  await adapter.publicAccount!.get(); generation = 2; await adapter.publicAccount!.get(); await adapter.getJobs();
  const before = calls.length;
  await assert.rejects(async () => adapter.resumeJob(1, ''), /Reload account settings/);
  await assert.rejects(async () => adapter.stopJob(1, ''), /Reload account settings/);
  await assert.rejects(async () => adapter.ownedPriceTransport!.call('stepOwnedPriceRefresh', { run_id: 1 }), /Reload account settings/);
  assert.equal(calls.length, before, 'missing epochs fail locally without sending a mutation');
  await assert.rejects(adapter.stopJob(1, '', 0));
  await assert.rejects(adapter.resumeJob(1, '', 0));
  await assert.rejects(adapter.ownedPriceTransport!.call('stepOwnedPriceRefresh', { run_id: 1, account_generation: 0 }));
  const mutations = calls.filter(call => ['stopJob', 'resumeJob', 'stepOwnedPriceRefresh'].includes(call.name));
  assert.ok(mutations.every(call => call.input.account_generation === 0));
  await adapter.publicAccount!.startDiscovery();
  await adapter.ownedPriceTransport!.call('startOwnedPriceRefresh', { session_id: 'new-session' });
  assert.equal(calls.find(call => call.name === 'startJob')!.input.account_generation, 2);
  assert.equal(calls.find(call => call.name === 'startOwnedPriceRefresh')!.input.account_generation, 2);
});

test('late account metadata and dashboard reads cannot restore an older generation', async () => {
  let resolveAccount!: (value: unknown) => void, resolveDashboard!: (value: unknown) => void;
  let accountReads = 0;
  const sent: Record<string, unknown>[] = [];
  const adapter = createCloudDashboardAdapter(transport((name, input) => {
    if (name === 'getPublicAccount') return accountReads++ === 0 ? { account: account(0) } : new Promise(resolve => { resolveAccount = resolve; });
    if (name === 'getDashboard') return new Promise(resolve => { resolveDashboard = resolve; });
    if (name === 'reactivatePublicAccount') return { account: account(2) };
    if (name === 'startOwnedPriceRefresh') { sent.push(input); return response(2, 'partial'); }
    throw new Error('Unexpected endpoint');
  }));
  await adapter.publicAccount!.get();
  const staleAccount = adapter.publicAccount!.get(), staleDashboard = adapter.getDashboard({ source: 'rentals', timeframe: '30d' });
  await adapter.publicAccount!.reactivate();
  const accountRejected = assert.rejects(staleAccount, /account changed/), dashboardRejected = assert.rejects(staleDashboard, /account changed/);
  resolveAccount({ account: account(0) }); resolveDashboard(dashboard(0));
  await Promise.all([accountRejected, dashboardRejected]);
  await adapter.ownedPriceTransport!.call('startOwnedPriceRefresh', { session_id: 'new-session' });
  assert.equal(sent[0].account_generation, 2);
});

test('a delayed Start result from a deleted account cannot emit an old paused job', async () => {
  let resolveStart!: (value: unknown) => void;
  const changes: Job[] = [];
  const adapter = createCloudDashboardAdapter(transport(name => {
    if (name === 'getPublicAccount') return { account: account(0) };
    if (name === 'startJob') return new Promise(resolve => { resolveStart = resolve; });
    if (name === 'reactivatePublicAccount') return { account: account(2) };
    if (name === 'getJobs') return { jobs: [job(2, 'partial')] };
    throw new Error('Unexpected endpoint');
  }));
  adapter.subscribe!(event => { if (event.job) changes.push(event.job); });
  await adapter.publicAccount!.get(); const pending = adapter.publicAccount!.startDiscovery();
  await adapter.publicAccount!.reactivate(); const rejected = assert.rejects(pending, /account changed/);
  resolveStart({ job: job(0) }); await rejected;
  assert.ok(changes.every(value => value.account_generation === 2));
});

test('a delayed Stop or owned refresh response cannot restore a deleted account\'s progress', async () => {
  for (const endpoint of ['stopJob', 'startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'getOwnedPriceRefresh', 'startGiftRefresh', 'stepGiftRefresh', 'getGiftRefresh', 'stopGiftRefresh'] as const) {
    let resolveReply!: (value: unknown) => void;
    const changes: Job[] = [];
    const adapter = createCloudDashboardAdapter(transport(name => {
      if (name === 'getPublicAccount') return { account: account(0) };
      if (name === 'reactivatePublicAccount') return { account: account(2) };
      if (name === endpoint) return new Promise(resolve => { resolveReply = resolve; });
      throw new Error('Unexpected endpoint');
    }));
    adapter.subscribe!(event => { if (event.job) changes.push(event.job); });
    await adapter.publicAccount!.get();
    const pending = endpoint === 'stopJob' ? adapter.stopJob(1, '', 0)
      : adapter.ownedPriceTransport!.call(endpoint, { run_id: 1, session_id: 'old-session', account_generation: 0 });
    await adapter.publicAccount!.reactivate(); const rejected = assert.rejects(pending, /account changed/);
    resolveReply(endpoint === 'stopJob' ? { job: job(0, 'partial') } : response(0, 'partial'));
    await rejected; assert.equal(changes.length, 0);
  }
});

test('late empty and error-shaped owned responses remain bound to the requesting account generation', async () => {
  for (const endpoint of ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'getOwnedPriceRefresh', 'stopOwnedPriceRefresh', 'startGiftRefresh', 'stepGiftRefresh', 'getGiftRefresh', 'stopGiftRefresh'] as const) {
    for (const result of [{ run: null, server_time: 0, next_allowed_at: 0 }, { error: { code: 'OWNED_PRICE_BUSY' } }]) {
      let resolveReply!: (value: unknown) => void;
      const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [];
      const adapter = createCloudDashboardAdapter(transport((name, input) => {
        calls.push({ name, input });
        if (name === 'getPublicAccount') return { account: account(0) };
        if (name === 'reactivatePublicAccount') return { account: account(2) };
        if (name === endpoint) return new Promise(resolve => { resolveReply = resolve; });
        assert.fail(`Unexpected endpoint ${name}`);
      }));
      await adapter.publicAccount!.get();
      const pending = adapter.ownedPriceTransport!.call(endpoint, { run_id: 1, session_id: 'targeted-gift-session', account_generation: 0 });
      await adapter.publicAccount!.reactivate();
      const rejected = assert.rejects(pending, /account changed/);
      resolveReply(result); await rejected;
      assert.equal(calls.filter(call => call.name === endpoint).length, 1, 'fenced response never retries the old mutation');
    }
  }
});

test('a rejected old owned request cannot report another account incarnation\'s action error', async () => {
  let rejectReply!: (error: unknown) => void;
  const adapter = createCloudDashboardAdapter(transport(name => {
    if (name === 'getPublicAccount') return { account: account(0) };
    if (name === 'reactivatePublicAccount') return { account: account(2) };
    if (name === 'startOwnedPriceRefresh') return new Promise((_resolve, reject) => { rejectReply = reject; });
    assert.fail(`Unexpected endpoint ${name}`);
  }));
  await adapter.publicAccount!.get();
  const pending = adapter.ownedPriceTransport!.call('startOwnedPriceRefresh', { session_id: 'targeted-gift-session' });
  await adapter.publicAccount!.reactivate();
  const rejected = assert.rejects(pending, /account changed/);
  rejectReply(Object.assign(new Error('A previous account gift was busy.'), { code: 'OWNED_PRICE_BUSY' }));
  await rejected;
});

test('owned transport keeps actionable scope errors when its account identity did not change', async () => {
  const busy = Object.assign(new Error('Another gift check is still finishing.'), { code: 'OWNED_PRICE_BUSY' });
  const adapter = createCloudDashboardAdapter(transport(name => {
    if (name === 'getPublicAccount') return { account: account(0) };
    if (name === 'startOwnedPriceRefresh') throw busy;
    assert.fail(`Unexpected endpoint ${name}`);
  }));
  await adapter.publicAccount!.get();
  await assert.rejects(adapter.ownedPriceTransport!.call('startOwnedPriceRefresh', { session_id: 'targeted-gift-session' }), error => error === busy);
});

test('private owned requests also reject empty responses after their adapter context was interrupted', async () => {
  let resolveReply!: (value: unknown) => void;
  const adapter = createCloudDashboardAdapter(transport(name => {
    assert.equal(name, 'getOwnedPriceRefresh');
    return new Promise(resolve => { resolveReply = resolve; });
  }));
  const pending = adapter.ownedPriceTransport!.call('getOwnedPriceRefresh', { session_id: 'targeted-gift-session' });
  adapter.interrupt(); const rejected = assert.rejects(pending, /account changed/);
  resolveReply({ run: null, server_time: 0, next_allowed_at: 0 }); await rejected;
});

test('owned-gift driver keeps its epoch through Step, Stop and a read of a reused run ID', async () => {
  const sent: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'old-session', transport: { async call<T>(name: OwnedPriceEndpoint, input: Record<string, unknown> = {}) {
    sent.push({ name, input });
    if (name === 'startOwnedPriceRefresh') return response(0) as T;
    if (name === 'stepOwnedPriceRefresh') throw new Error('PUBLIC_ACCOUNT_CHANGED');
    if (name === 'getOwnedPriceRefresh') return response(2, 'partial', 1) as T;
    return response(0, 'partial') as T;
  } }, onSavedDataChanged() {} });
  await driver.start(); assert.equal(driver.getSnapshot().run?.account_generation, 0); assert.equal(driver.getSnapshot().run?.checked, 0);
  await driver.stop();
  assert.equal(sent.find(value => value.name === 'stepOwnedPriceRefresh')?.input.account_generation, 0);
  assert.equal(sent.find(value => value.name === 'stopOwnedPriceRefresh')?.input.account_generation, 0);
  for (const generation of [-1, 1.5, '0']) assert.throws(() => readOwnedPriceResponse({ ...response(), run: { ...response().run, account_generation: generation } }));
});

test('account setup chooses discovery by epoch before comparing reused numeric IDs', () => {
  assert.equal(selectPublicDiscovery(account(2), [], job(0, 'partial', 99)), null);
  assert.equal(selectPublicDiscovery(account(2), [job(0, 'partial', 99), job(2, 'partial', 1)], job(0, 'partial', 99))?.id, 1);
  assert.equal(selectPublicDiscovery(account(2), [], job(2, 'partial', 1))?.id, 1);
  assert.equal(selectPublicDiscovery({ ...account(2), deleted: true }, [job(2)], null), null);
});
