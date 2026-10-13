import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';
import type { Dashboard, MarketappAnalyticsRefreshChallenge, PersonalRentalAnalytics } from '../data/types.ts';

const wallet = `0:${'12'.repeat(32)}`;
const selection = { source: 'rentals' as const, timeframe: '30d' as const };
const status = { attempt: null, session: { remembered: true, expires_at: '2026-10-19T12:00:00Z' } };
const challenge: MarketappAnalyticsRefreshChallenge = { attempt_id: 'a'.repeat(64), wallet, domain: 'marketapp.org',
  manifest_url: 'https://marketapp.org/tonconnect-manifest.json', challenge: 'synthetic', expires_at: '2026-10-12T12:05:00Z',
  period_days: 30, session_envelope: 'ab'.repeat(16) };
const walletAccount = { address: wallet, chain: '-239', walletStateInit: 'synthetic-init', publicKey: 'synthetic-public-key' };
const proof = { timestamp: 1, domain: { value: 'marketapp.org', lengthBytes: 13 }, payload: 'synthetic', signature: 'synthetic' };
const device = { platform: 'browser', appName: 'synthetic', appVersion: '1', maxProtocolVersion: 2, features: [] };
const snapshot = { version: 1, wallet, daily: [] } as unknown as PersonalRentalAnalytics;
const account = (generation = 2, connected = true) => ({ public_mode: true, account_generation: generation,
  wallet: connected ? { address: wallet, verified_at: '2026-10-12T12:00:00Z' } : null,
  marketapp_key: { configured: true, updated_at: '2026-10-12T12:00:00Z' }, onboarding_complete: connected });
const dashboard = (generation = 2, connected = true) => ({ wallet, gifts: [], summary: {},
  capabilities: { public_account: true, account_generation: generation, wallet_configured: connected } }) as unknown as Dashboard;
function transport(call: (name: CloudEndpoint, input: Record<string, unknown>) => unknown): CloudTransport {
  return { async call<T>(name: CloudEndpoint, input: Record<string, unknown> = {}) { return await call(name, input) as T; } };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}
const scopeChanged = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'PUBLIC_WALLET_CHANGED');

test('public personal analytics and remembered-login requests carry the captured account generation', async () => {
  const calls: { name: CloudEndpoint; input: Record<string, unknown> }[] = [];
  const adapter = createCloudDashboardAdapter(transport((name, input) => {
    calls.push({ name, input });
    if (name === 'getDashboard') return dashboard();
    if (name === 'startMarketappAnalyticsRefresh') return challenge;
    if (name === 'getMarketappAnalyticsRefreshStatus') return status;
    if (name === 'importPersonalAnalytics') return { personal_analytics: snapshot };
    if (name === 'disconnectMarketappAnalyticsSession') return { disconnected: true };
    return {};
  }));
  await adapter.getDashboard(selection);
  const analytics = adapter.marketappAnalyticsRefresh!;
  await analytics.getStatus!();
  await analytics.refreshStartup!(30);
  await analytics.start(30, undefined, true);
  await analytics.finish(challenge, walletAccount, proof, device);
  await analytics.cancel(challenge.attempt_id);
  await analytics.refreshSaved!(365);
  await adapter.personalAnalytics!.importSnapshot('{}', '');
  await analytics.disconnectSession!();
  for (const call of calls.filter(value => value.name !== 'getDashboard')) assert.equal(call.input.account_generation, 2, call.name);
  assert.equal(calls.find(value => value.name === 'startMarketappAnalyticsRefresh')!.input.remember_login, true);
  assert.equal(calls.some(value => JSON.stringify(value.input).includes('user_id')), false, 'Telegram supplies identity, never the browser');
});

test('late session, analytics and import replies are rejected after deletion/recreation, even with the same wallet', async () => {
  for (const endpoint of ['getMarketappAnalyticsRefreshStatus', 'refreshSavedMarketappAnalytics', 'refreshStartupMarketappAnalytics', 'importPersonalAnalytics'] as const) {
    const pending = deferred(); let generation = 2, changed = 0;
    const adapter = createCloudDashboardAdapter(transport(name => name === 'getDashboard' ? dashboard(generation)
      : name === 'getPublicAccount' ? account(generation) : pending.promise));
    adapter.subscribe!(() => { changed++; });
    await adapter.getDashboard(selection);
    const analytics = adapter.marketappAnalyticsRefresh!;
    const result = endpoint === 'getMarketappAnalyticsRefreshStatus' ? analytics.getStatus!()
      : endpoint === 'refreshSavedMarketappAnalytics' ? analytics.refreshSaved!(30)
        : endpoint === 'refreshStartupMarketappAnalytics' ? analytics.refreshStartup!(30) : adapter.personalAnalytics!.importSnapshot('{}', '');
    const rejected = assert.rejects(result, scopeChanged);
    generation = 4; await adapter.publicAccount!.get();
    pending.resolve(endpoint === 'getMarketappAnalyticsRefreshStatus' ? status : { personal_analytics: snapshot });
    await rejected; assert.equal(changed, 0, 'stale imports never announce saved data');
  }
});

test('wallet disconnect immediately fences pending session reads and previously approved challenges', async () => {
  const pending = deferred(), calls: CloudEndpoint[] = [];
  const adapter = createCloudDashboardAdapter(transport(name => {
    calls.push(name);
    return name === 'getDashboard' ? dashboard() : name === 'startMarketappAnalyticsRefresh' ? challenge
      : name === 'disconnectPublicWallet' ? account(2, false) : pending.promise;
  }));
  await adapter.getDashboard(selection);
  const analytics = adapter.marketappAnalyticsRefresh!;
  await analytics.start(30);
  const result = analytics.getStatus!(), rejected = assert.rejects(result, scopeChanged);
  await adapter.publicAccount!.disconnectWallet();
  pending.resolve(status); await rejected;
  await assert.rejects(analytics.finish(challenge, walletAccount, proof, device), scopeChanged);
  await assert.rejects(analytics.cancel(challenge.attempt_id), scopeChanged);
  assert.equal(calls.includes('finishMarketappAnalyticsRefresh'), false);
  assert.equal(calls.includes('cancelMarketappAnalyticsRefresh'), false);
});

test('disconnecting Marketapp rejects older remembered-session reads without changing the verified wallet', async () => {
  const pending = deferred();
  const adapter = createCloudDashboardAdapter(transport(name => name === 'getDashboard' ? dashboard()
    : name === 'disconnectMarketappAnalyticsSession' ? { disconnected: true } : pending.promise));
  await adapter.getDashboard(selection);
  const analytics = adapter.marketappAnalyticsRefresh!;
  const result = analytics.getStatus!(), rejected = assert.rejects(result, scopeChanged);
  assert.deepEqual(await analytics.disconnectSession!(), { disconnected: true });
  pending.resolve(status); await rejected;
});

test('a dashboard requested before wallet disconnection cannot restore old analytics context', async () => {
  const pending = deferred(); let reads = 0, loaded = 0;
  const adapter = createCloudDashboardAdapter(transport(name => name === 'getDashboard' ? ++reads === 1 ? dashboard() : pending.promise : account(2, false)),
    { onDashboardLoaded() { loaded++; } });
  await adapter.getDashboard(selection);
  const result = adapter.getDashboard(selection), rejected = assert.rejects(result, scopeChanged);
  await adapter.publicAccount!.disconnectWallet(); pending.resolve(dashboard());
  await rejected; assert.equal(loaded, 1);
});

test('settings and key-check replies cannot restore a disconnected wallet within the same account generation', async () => {
  for (const endpoint of ['getPublicAccount', 'testMarketappApiKey'] as const) {
    const pending = deferred();
    const adapter = createCloudDashboardAdapter(transport(name => name === 'getDashboard' ? dashboard()
      : name === 'disconnectPublicWallet' ? account(2, false) : pending.promise));
    await adapter.getDashboard(selection);
    const result = endpoint === 'getPublicAccount' ? adapter.publicAccount!.get() : adapter.publicAccount!.testKey();
    const rejected = assert.rejects(result, scopeChanged);
    await adapter.publicAccount!.disconnectWallet();
    pending.resolve(endpoint === 'getPublicAccount' ? account() : { status: 'valid', checked_at: '2026-10-12T12:00:00Z', account: account() });
    await rejected;
  }
});

test('private personal analytics keeps its existing request shape and separate source', async () => {
  const calls: Record<string, unknown>[] = [];
  const adapter = createCloudDashboardAdapter(transport((name, input) => {
    calls.push(input); return name === 'startMarketappAnalyticsRefresh' ? challenge : status;
  }));
  await adapter.marketappAnalyticsRefresh!.getStatus!();
  await adapter.marketappAnalyticsRefresh!.start(30, undefined, true);
  assert.deepEqual(calls, [{}, { period_days: 30, remember_login: true }]);
});
