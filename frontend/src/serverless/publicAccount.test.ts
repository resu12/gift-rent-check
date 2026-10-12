import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAccountStep, publicAccountError, readPublicAccount, readPublicApiKeyCheck, validPublicApiKey } from './publicAccount.ts';
import type { PublicAccountStatus } from './publicAccount.ts';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { createCloudTransport } from './cloudTransport.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';
import type { Dashboard, Job } from '../data/types.ts';

const address = `0:${'12'.repeat(32)}`, time = '2026-10-10T12:00:00.000Z';
function account(ready = true): PublicAccountStatus {
  return { public_mode: true, account_generation: 1, wallet: ready ? { address, verified_at: time } : null,
    marketapp_key: { configured: ready, updated_at: ready ? time : null }, onboarding_complete: ready };
}
const job: Job = { id: 1, account_generation: 1, kind: 'discover', state: 'complete', created_at: time, updated_at: time, reason: null, run_id: 1, stop_requested: false, progress: {} };
function transport(handler: (name: CloudEndpoint, input: Record<string, unknown>) => unknown): CloudTransport {
  return { async call<T>(name: CloudEndpoint, input: Record<string, unknown> = {}) { return handler(name, input) as T; } };
}

test('public account status is normalized and never retains extra credential or caller fields', () => {
  const value = { ...account(), secret: 'private key', user_id: 1, marketapp_key: { ...account().marketapp_key, api_key: 'never keep this' }, wallet: { ...account().wallet, proof: 'private proof' } };
  assert.deepEqual(readPublicAccount({ account: value }), account());
  assert.deepEqual(readPublicAccount(value), account());
  assert.equal(JSON.stringify(readPublicAccount(value)).includes('private'), false);
  for (const malformed of [null, [], {}, { ...account(), public_mode: false }, { ...account(), wallet: { address: 'invalid', verified_at: time } },
    { ...account(), wallet: { address, verified_at: null } }, { ...account(), marketapp_key: { configured: 'yes', updated_at: null } },
    { ...account(), marketapp_key: { configured: true, updated_at: 'invalid time' } }, { ...account(), wallet: null },
    { ...account(), marketapp_key: { configured: false, updated_at: null } }]) assert.throws(() => readPublicAccount(malformed), /could not be read/);
});

test('onboarding requires both server-verified wallet and a saved key; empty public accounts remain usable', () => {
  assert.deepEqual(readPublicAccount(account(false)), account(false));
  assert.equal(publicAccountStep(null), 'loading');
  assert.equal(publicAccountStep(account(false)), 'wallet');
  assert.equal(publicAccountStep({ ...account(), marketapp_key: { configured: false, updated_at: null }, onboarding_complete: false }), 'key');
  assert.equal(publicAccountStep(account()), 'ready');
  const deleted = { ...account(false), deleted: true, pending_cleanup: true };
  assert.equal(publicAccountStep(readPublicAccount(deleted)), 'deleted');
  assert.throws(() => readPublicAccount({ ...account(), deleted: true }));
  assert.throws(() => readPublicAccount({ ...account(false), deleted: 'yes' }));
});

test('policy links are optional HTTPS URLs without credentials and unsafe links cannot enter UI state', () => {
  const policies = { privacy_policy_url: 'https://EXAMPLE.test/privacy', terms_url: 'https://example.test/terms?version=1' };
  assert.deepEqual(readPublicAccount({ ...account(false), ...policies }), {
    ...account(false), privacy_policy_url: 'https://example.test/privacy', terms_url: policies.terms_url,
  });
  assert.deepEqual(readPublicAccount(account(false)), account(false));
  for (const field of ['privacy_policy_url', 'terms_url']) for (const value of [null, 1, '', '/privacy',
    'http://example.test/privacy', 'https:example.test/privacy', 'https:/example.test/privacy', 'javascript:alert(1)', 'data:text/html,unsafe', 'https://user:password@example.test/privacy',
    'https://user@example.test/privacy', 'https://example.test/pri\nvacy', 'https://example.test/pri vacy',
    'https:\\example.test\\privacy', 'https://example.test/' + 'x'.repeat(2048)])
    assert.throws(() => readPublicAccount({ ...account(false), [field]: value }), /could not be read/);
});

test('public API key checks preserve only safe metadata and reject malformed statuses', () => {
  for (const status of ['valid', 'invalid', 'unavailable'] as const) {
    assert.deepEqual(readPublicApiKeyCheck({ account: account(), status, checked_at: time, provider_response: 'private' }), { account: account(), status, checked_at: time });
  }
  for (const value of [null, { account: account(), status: 'yes', checked_at: time }, { account: account(), status: 'valid', checked_at: null }, { account: {}, status: 'valid', checked_at: time }])
    assert.throws(() => readPublicApiKeyCheck(value));
});

test('key validation rejects whitespace, controls and oversize values before transport', async () => {
  assert.equal(validPublicApiKey('synthetic-api-key'), true);
  for (const value of ['', 'two', ' two', 'two ', 'two\n', 'a b', '\u0000', 'ü', 'a'.repeat(513), 'x'.repeat(12) + '/', null]) assert.equal(validPublicApiKey(value), false);
  let calls = 0;
  const api = createCloudDashboardAdapter(transport(() => { calls++; return { account: account() }; })).publicAccount!;
  await assert.rejects(api.saveKey(' spaced key ')); assert.equal(calls, 0);
});

test('account routes send the key only on save; reads and checks contain no provider secrets or claimed identity', async () => {
  const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [];
  const api = createCloudDashboardAdapter(transport((name, input) => {
    calls.push({ name, input });
    return name === 'testMarketappApiKey' ? { account: account(), status: 'valid', checked_at: time } : { account: account() };
  })).publicAccount!;
  await api.get(); await api.saveKey('synthetic-api-key'); await api.testKey(); await api.removeKey(); await api.disconnectWallet(); await api.deleteAccount();
  assert.deepEqual(calls, [
    { name: 'getPublicAccount', input: {} }, { name: 'saveMarketappApiKey', input: { api_key: 'synthetic-api-key' } },
    { name: 'testMarketappApiKey', input: {} }, { name: 'removeMarketappApiKey', input: {} },
    { name: 'disconnectPublicWallet', input: {} }, { name: 'deletePublicAccount', input: { confirm: true } },
  ]);
});

test('proof input is explicitly whitelisted and key/proof errors never echo private data or repeat mutations', async () => {
  let finishInput: unknown;
  const api = createCloudDashboardAdapter(transport((name, input) => { assert.equal(name, 'finishWalletVerification'); finishInput = input; return { account: account() }; })).publicAccount!;
  await api.finishWallet('a'.repeat(64), { address, chain: '-239', walletStateInit: 'base64state', publicKey: '12'.repeat(32), api_key: 'do-not-forward' } as never,
    { timestamp: 123, domain: { lengthBytes: 11, value: 'app.example' }, payload: 'challenge', signature: 'signature', api_key: 'do-not-forward' } as never);
  assert.equal(JSON.stringify(finishInput).includes('do-not-forward'), false);
  for (const endpoint of ['saveMarketappApiKey', 'finishWalletVerification', 'deletePublicAccount'] as const) {
    let calls = 0;
    const denied = createCloudTransport({ call(_name, _input, cb) { calls++; cb(null, { error: { code: 'API_KEY_REJECTED', message: 'private key signature wallet' } }); } });
    await assert.rejects(denied.call(endpoint, {}), error => {
      assert.equal(publicAccountError(error).includes('private'), false); return true;
    }); assert.equal(calls, 1);
  }
  assert.equal(publicAccountError(new Error('private secret')).includes('private'), false);
});

test('discovery becomes available only in public account mode and uses saved platform account routes', async () => {
  const calls: unknown[] = [];
  const adapter = createCloudDashboardAdapter(transport((name, input) => {
    calls.push({ name, input }); return name === 'getPublicAccount' ? { account: account() } : { job };
  }));
  await assert.rejects(adapter.publicAccount!.startDiscovery(), /not enabled/);
  await adapter.publicAccount!.get(); await adapter.publicAccount!.startDiscovery(); await adapter.publicAccount!.resumeDiscovery(1, job.account_generation);
  assert.deepEqual(calls, [{ name: 'getPublicAccount', input: {} }, { name: 'startJob', input: { kind: 'discover', account_generation: 1 } }, { name: 'resumeJob', input: { job_id: 1, account_generation: 1 } }]);
});

test('reactivation is an explicit confirmed mutation; reads never recreate a deleted account', async () => {
  const calls: unknown[] = [];
  const adapter = createCloudDashboardAdapter(transport((name, input) => {
    calls.push({ name, input }); return { account: name === 'getPublicAccount' ? { ...account(false), deleted: true } : account(false) };
  }));
  const deleted = await adapter.publicAccount!.get(); assert.equal(deleted.deleted, true);
  assert.deepEqual(calls, [{ name: 'getPublicAccount', input: {} }]);
  assert.deepEqual(await adapter.publicAccount!.reactivate(), account(false));
  assert.deepEqual(calls[1], { name: 'reactivatePublicAccount', input: { confirm: true } });
});

test('all public account failures display fixed instructions instead of returned credentials', async () => {
  for (const code of ['PUBLIC_ACCESS_DENIED', 'PUBLIC_ACCOUNT_LIMIT', 'PUBLIC_KEY_INVALID', 'PUBLIC_KEY_REQUIRED', 'PUBLIC_ACCOUNT_BUSY',
    'PUBLIC_WALLET_REQUIRED', 'PUBLIC_WALLET_INVALID', 'PUBLIC_WALLET_MISMATCH', 'PUBLIC_WALLET_UNSUPPORTED', 'PUBLIC_WALLET_EXPIRED',
    'PUBLIC_WALLET_RATE_LIMIT', 'PUBLIC_PROVIDER_WAIT', 'PUBLIC_ACCOUNT_DELETED', 'PUBLIC_CONFLICT', 'PUBLIC_KEY_CHANGED',
    'PUBLIC_REQUEST_FAILED', 'PUBLIC_STORAGE_LIMIT', 'PUBLIC_ANALYTICS_DISABLED', 'PUBLIC_CONFIGURATION']) {
    const api = createCloudTransport({ call(_name, _input, cb) { cb(null, { error: { code, message: 'private-key or proof nonce' } }); } });
    await assert.rejects(api.call('getPublicAccount'), error => {
      assert.equal((error as { code: string }).code, code); assert.equal(publicAccountError(error).includes('private-key'), false); return true;
    });
  }
});

test('private dashboards retain existing job capabilities; public dashboards add discovery', async () => {
  const dashboard = { gifts: [], summary: {}, capabilities: {} } as unknown as Dashboard;
  for (const publicMode of [false, true]) {
    const adapter = createCloudDashboardAdapter(transport(name => name === 'getDashboard' ? { ...dashboard, capabilities: { public_account: publicMode, account_generation: publicMode ? 1 : undefined } } : { job }));
    const result = await adapter.getDashboard({ source: 'rentals', timeframe: '30d' });
    assert.equal(result.capabilities.supported_jobs?.includes('discover'), publicMode);
    if (publicMode) assert.equal((await adapter.startJob('discover', '')).kind, 'discover');
    else await assert.rejects(adapter.startJob('discover', ''), /not available/);
  }
});
