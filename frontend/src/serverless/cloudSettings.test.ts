import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { createCloudTransport } from './cloudTransport.ts';

const secret = 'synthetic-marketapp-private-key';
const status = { configured: true, source: 'encrypted_backend', persistent_storage_available: true,
  network_enabled: true, can_manage: true, restart_required: false };

test('private Telegram key settings expose status only and never start collection', async () => {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const adapter = createCloudDashboardAdapter(createCloudTransport({ call(endpoint, input, callback) {
    calls.push({ endpoint, input }); callback(null, { ...status, api_key: secret, ciphertext: secret, debug: { token: secret } });
  } }));
  assert.deepEqual(await adapter.marketappSettings!.get(), status);
  assert.deepEqual(calls, [{ endpoint: 'getMarketappSettings', input: {} }]);
  assert.equal(JSON.stringify(await adapter.marketappSettings!.get()).includes(secret), false);
});

test('save and clear use authenticated fixed endpoints without browser persistence or automatic sync', async () => {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [], changes: unknown[] = [];
  const adapter = createCloudDashboardAdapter(createCloudTransport({ call(endpoint, input, callback) {
    calls.push({ endpoint, input }); callback(null, endpoint === 'removeMarketappApiKey' ? { ...status, configured: false, source: 'none' } : status);
  } }));
  adapter.subscribe!(event => changes.push(event));
  assert.deepEqual(await adapter.marketappSettings!.save(secret, false, ''), status);
  assert.equal((await adapter.marketappSettings!.remove('')).configured, false);
  assert.deepEqual(calls, [{ endpoint: 'saveMarketappApiKey', input: { api_key: secret } }, { endpoint: 'removeMarketappApiKey', input: {} }]);
  assert.deepEqual(changes, [{ savedDataChanged: true }, { savedDataChanged: true }]);
});

test('malformed input and unsafe backend failures do not echo credentials or repeat a mutation', async () => {
  let calls = 0;
  const adapter = createCloudDashboardAdapter(createCloudTransport({ call(_endpoint, _input, callback) {
    calls++; callback(null, { error: { code: 'PRIVATE_SETTINGS_FAILED', message: secret } });
  } }));
  await assert.rejects(adapter.marketappSettings!.save('bad\nkey', false, ''));
  assert.equal(calls, 0);
  await assert.rejects(adapter.marketappSettings!.save(secret, false, ''), error => error instanceof Error && !error.message.includes(secret));
  assert.equal(calls, 1);
  await assert.rejects(adapter.marketappSettings!.remove(''), error => error instanceof Error && !error.message.includes(secret));
  assert.equal(calls, 2);
});
