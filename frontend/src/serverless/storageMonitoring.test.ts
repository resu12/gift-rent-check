import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { CloudError, createCloudTransport } from './cloudTransport.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';
import type { StorageStatus } from '../data/storageMonitoring.ts';

const time = '2026-10-11T15:00:00.000Z';
const status = (scope: StorageStatus['scope'] = 'app'): StorageStatus => ({ version: 1, scope, status: 'healthy',
  estimated_bytes: 2000000, budget_bytes: scope === 'app' ? 5000000 : null, inventory_complete: true, checked_at: time,
  cleanup: { state: 'complete', last_completed_at: time, reclaimed_bytes: 1000000, estimated_reclaimable_bytes: 0 },
  can_cleanup: true, next_step_at: null });
function transport(handler: (name: CloudEndpoint, input: Record<string, unknown>) => unknown | Promise<unknown>): CloudTransport {
  return { async call<T>(name: CloudEndpoint, input: Record<string, unknown> = {}) { return await handler(name, input) as T; } };
}

test('storage adapter calls only authenticated maintenance endpoints with a fixed manual flag', async () => {
  const calls: unknown[] = [], events: unknown[] = [];
  const adapter = createCloudDashboardAdapter(transport((name, input) => { calls.push({ name, input }); return status(); }));
  adapter.subscribe!(event => events.push(event)); assert.equal(calls.length, 0);
  assert.equal((await adapter.storageMaintenance!.get()).scope, 'app');
  await adapter.storageMaintenance!.step(); await adapter.storageMaintenance!.step(true);
  assert.deepEqual(calls, [{ name: 'getStorageStatus', input: { progress: true, growth: true } }, { name: 'stepStorageMaintenance', input: { manual: false, progress: true, growth: true } },
    { name: 'stepStorageMaintenance', input: { manual: true, progress: true, growth: true } }]);
  assert.equal(events.length, 0, 'maintenance does not create sync jobs or reload financial data');
});

test('invited accounts reject an app-wide storage response', async () => {
  let scope: StorageStatus['scope'] = 'app';
  const adapter = createCloudDashboardAdapter(transport(name => name === 'getPublicAccount'
    ? { account: { public_mode: true, account_generation: 0, wallet: null, marketapp_key: { configured: false, updated_at: null }, onboarding_complete: false } }
    : status(scope)));
  await adapter.publicAccount!.get();
  await assert.rejects(adapter.storageMaintenance!.get(), /Storage status could not be confirmed/);
  await assert.rejects(adapter.storageMaintenance!.step(), /Storage status could not be confirmed/);
  scope = 'account'; assert.equal((await adapter.storageMaintenance!.get()).budget_bytes, null);
});

test('maintenance metadata is fenced across public account deletion/reactivation', async () => {
  let resolve!: (value: StorageStatus) => void;
  const account = (generation: number) => ({ account: { public_mode: true, account_generation: generation, wallet: null,
    marketapp_key: { configured: false, updated_at: null }, onboarding_complete: false } });
  const adapter = createCloudDashboardAdapter(transport(name => {
    if (name === 'getPublicAccount') return account(0);
    if (name === 'reactivatePublicAccount') return account(2);
    return new Promise<StorageStatus>(done => { resolve = done; });
  }));
  await adapter.publicAccount!.get(); const pending = adapter.storageMaintenance!.step(true);
  await adapter.publicAccount!.reactivate(); const rejected = assert.rejects(pending, /account changed/);
  resolve(status('account')); await rejected;
});

test('storage errors never display upstream secrets or retry a maintenance mutation', async () => {
  for (const code of ['STORAGE_CAPACITY_PAUSED', 'STORAGE_PRESSURE', 'STORAGE_MAINTENANCE_BUSY', 'STORAGE_MAINTENANCE_FAILED']) {
    let calls = 0;
    const transport = createCloudTransport({ call(_name, _input, cb) { calls++; cb(null, { error: { code, message: 'Private SQL cookie token' } }); } });
    await assert.rejects(transport.call('stepStorageMaintenance', { manual: true }), (error: CloudError) =>
      error.code === code && !error.message.includes('Private SQL') && (code !== 'STORAGE_CAPACITY_PAUSED' || /Clean up storage from Status/.test(error.message)));
    assert.equal(calls, 1);
  }
});
