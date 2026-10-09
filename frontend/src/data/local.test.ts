import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDashboardAdapter } from './local.ts';
import type { Job, PricingSelection } from './types.ts';
import { createOwnedPriceStartupGate, OwnedPriceRefreshDriver } from './ownedPriceRefresh.ts';
import type { OwnedPriceEndpoint } from './ownedPriceRefresh.ts';

const localAdapter = createLocalDashboardAdapter();

test('Telegram cache bypass cannot be submitted to the local dashboard', context => {
  const calls = mockRequests(context);
  assert.throws(() => localAdapter.startJob('prices', 'csrf', {source: 'listings', timeframe: '30d'}, {forceRefresh: true}), /Telegram only/);
  assert.equal(calls.length, 0);
});

const fixture = { id: 7, kind: 'rental_prices', state: 'queued' } as Job;

function mockRequests(context: TestContext) {
  const calls: { path: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ job: fixture }), { status: 200 });
  });
  return calls;
}

test('rental collection sends the chosen timeframe and retains local request authentication', async context => {
  const calls = mockRequests(context);
  const result = await localAdapter.startJob('rental_prices', 'local-csrf', { source: 'rentals', timeframe: '7d' });
  assert.deepEqual(result, fixture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/jobs');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(new Headers(calls[0].init.headers).get('X-Dashboard-CSRF'), 'local-csrf');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { kind: 'rental_prices', timeframe: '7d' });
});

test('custom listing and rental collection preserve the date window without forwarding display filters', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T12:00:00Z') });
  const calls = mockRequests(context);
  const selection: PricingSelection = { source: 'rentals', timeframe: 'custom', dateFrom: '2026-09-01', dateTo: '2026-09-30', backdrop: 'Black' };
  for (const kind of ['prices', 'rental_prices'] as const) {
    await localAdapter.startJob(kind, 'csrf', selection);
  }
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
    { kind: 'prices', timeframe: 'custom', date_from: '2026-09-01', date_to: '2026-09-30' },
    { kind: 'rental_prices', timeframe: 'custom', date_from: '2026-09-01', date_to: '2026-09-30' },
  ]);
});

test('resume preserves the saved window, generic collection has a window, and ownership refresh is unrelated', async context => {
  const calls = mockRequests(context);
  await localAdapter.resumeJob(7, 'csrf');
  await localAdapter.startJob('collect', 'csrf', { source: 'rentals', timeframe: '90d' });
  await localAdapter.startJob('refresh', 'csrf', { source: 'rentals', timeframe: 'custom', dateFrom: 'invalid' });
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
    { resume_job_id: 7 }, { kind: 'collect', timeframe: '90d' }, { kind: 'refresh' },
  ]);
});

test('invalid custom collection dates cannot start a network job', async context => {
  const calls = mockRequests(context);
  assert.throws(() => localAdapter.startJob('rental_prices', 'csrf', {
    source: 'rentals', timeframe: 'custom', dateFrom: '2026-02-30', dateTo: '2026-03-01',
  }), /valid start and end date/);
  assert.equal(calls.length, 0);
});

test('relative collection windows drop stale custom dates and unbounded windows cannot start', async context => {
  const calls = mockRequests(context);
  await localAdapter.startJob('rental_prices', 'csrf', { source: 'rentals', timeframe: '60d', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { kind: 'rental_prices', timeframe: '60d' });
  assert.throws(() => localAdapter.startJob('rental_prices', 'csrf', { source: 'rentals', timeframe: 'all' }), /at most 90 days/);
  assert.equal(calls.length, 1);
});

test('overlong custom ranges and historical scans older than 90 days are blocked before any request', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T12:00:00Z') });
  const calls = mockRequests(context);
  const selection: PricingSelection = { source: 'rentals', timeframe: 'custom', dateFrom: '2026-07-11', dateTo: '2026-10-09' };
  for (const kind of ['prices', 'rental_prices', 'collect'] as const) {
    assert.throws(() => localAdapter.startJob(kind, 'csrf', selection), /at most 90 days/);
  }
  const older = { ...selection, dateTo: '2026-10-08' };
  for (const kind of ['rental_prices', 'collect'] as const) {
    assert.throws(() => localAdapter.startJob(kind, 'csrf', older), /no earlier than 2026-07-12/);
  }
  assert.equal(calls.length, 0);
  await localAdapter.startJob('prices', 'csrf', older);
  assert.equal(calls.length, 1); // Current listing snapshots do not scan rental history.
  for (const kind of ['rental_prices', 'collect'] as const) {
    await localAdapter.startJob(kind, 'csrf', { ...selection, dateFrom: '2026-07-12' });
  }
  assert.equal(calls.length, 3);
});

const selection: PricingSelection = { source: 'rentals', timeframe: '30d' };
const completedRefresh = { run: { id: 1, state: 'complete', total: 1, checked: 1, updated: 1, unresolved: 0,
  reason: null, started_at: '2026-10-09T00:00:00Z', completed_at: '2026-10-09T00:00:01Z' }, server_time: 1000, next_allowed_at: 0 };

test('local price transport uses only the four exact routes with current dashboard CSRF and same-origin credentials', async context => {
  const adapter = createLocalDashboardAdapter();
  const calls: { path: string; init: RequestInit }[] = [];
  let token = 'first-dashboard-token';
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(path.startsWith('/api/dashboard')
      ? { capabilities: { csrf_token: token, network_enabled: false, owned_price_refresh: true } } : completedRefresh));
  });
  await assert.rejects(adapter.ownedPriceTransport.call('startOwnedPriceRefresh', { session_id: 'page' }), /Reload saved data/);
  assert.equal(calls.length, 0);
  await adapter.getDashboard(selection);
  await adapter.ownedPriceTransport.call('getOwnedPriceRefresh');
  await adapter.ownedPriceTransport.call('startOwnedPriceRefresh', { session_id: 'page' });
  token = 'next-dashboard-token';
  await adapter.getDashboard(selection);
  await adapter.ownedPriceTransport.call('stepOwnedPriceRefresh', { run_id: 1 });
  await adapter.ownedPriceTransport.call('stopOwnedPriceRefresh', { run_id: 1 });
  const prices = calls.filter(call => call.path.startsWith('/api/owned-prices'));
  assert.deepEqual(prices.map(({ path, init }) => [path, init.method, init.credentials, init.cache]), [
    ['/api/owned-prices', 'GET', 'same-origin', 'no-store'],
    ['/api/owned-prices/start', 'POST', 'same-origin', 'no-store'],
    ['/api/owned-prices/step', 'POST', 'same-origin', 'no-store'],
    ['/api/owned-prices/stop', 'POST', 'same-origin', 'no-store'],
  ]);
  assert.equal(prices[0].init.body, undefined);
  assert.equal(new Headers(prices[0].init.headers).get('X-Dashboard-CSRF'), null);
  assert.deepEqual(prices.slice(1).map(call => new Headers(call.init.headers).get('X-Dashboard-CSRF')),
    ['first-dashboard-token', 'next-dashboard-token', 'next-dashboard-token']);
  assert.deepEqual(prices.slice(1).map(call => JSON.parse(String(call.init.body))), [{ session_id: 'page' }, { run_id: 1 }, { run_id: 1 }]);
  assert.ok(prices.every(call => !new Headers(call.init.headers).has('Authorization')));
  await assert.rejects(adapter.ownedPriceTransport.call('startJob' as OwnedPriceEndpoint), /Unsupported/);
  assert.equal(calls.length, 6);
});

test('local adapters isolate their CSRF state and cancelled dashboard reads cannot replace it', async context => {
  const first = createLocalDashboardAdapter(); const second = createLocalDashboardAdapter();
  const tokens: (string | null)[] = [];
  let token = 'first';
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    if (path.startsWith('/api/dashboard')) return new Response(JSON.stringify({ capabilities: { csrf_token: token } }));
    tokens.push(new Headers(init.headers).get('X-Dashboard-CSRF'));
    return new Response(JSON.stringify(completedRefresh));
  });
  await first.getDashboard(selection);
  await assert.rejects(second.ownedPriceTransport.call('startOwnedPriceRefresh'), /Reload saved data/);
  token = 'second'; await second.getDashboard(selection);
  const aborted = new AbortController(); aborted.abort();
  token = 'discard'; await first.getDashboard(selection, aborted.signal);
  await first.ownedPriceTransport.call('startOwnedPriceRefresh', { session_id: 'first-page' });
  await second.ownedPriceTransport.call('startOwnedPriceRefresh', { session_id: 'second-page' });
  assert.deepEqual(tokens, ['first', 'second']);
});

test('local price-only capability starts the same bounded driver once without enabling Marketapp jobs', async context => {
  let enabled = false; let hidden = true; let reloads = 0;
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string) => {
    requests.push(path);
    return new Response(JSON.stringify(path.startsWith('/api/dashboard')
      ? { capabilities: { csrf_token: 'csrf', network_enabled: false, owned_price_refresh: enabled } } : completedRefresh));
  });
  const adapter = createLocalDashboardAdapter();
  const driver = new OwnedPriceRefreshDriver({ transport: adapter.ownedPriceTransport, sessionId: 'local-opening', onSavedDataChanged: () => { reloads++; } });
  const startup = createOwnedPriceStartupGate(driver, () => hidden);
  startup.dashboardLoaded((await adapter.getDashboard(selection)).capabilities.owned_price_refresh === true);
  hidden = false; startup.visibilityChanged();
  assert.equal(requests.length, 1);
  enabled = true;
  const data = await adapter.getDashboard(selection);
  assert.equal(data.capabilities.network_enabled, false);
  startup.dashboardLoaded(data.capabilities.owned_price_refresh === true);
  await driver.start();
  startup.dashboardLoaded(true); startup.visibilityChanged();
  await driver.start();
  assert.deepEqual(requests.filter(path => !path.startsWith('/api/dashboard')), ['/api/owned-prices/start']);
  assert.equal(reloads, 1);
  assert.equal(driver.getSnapshot().phase, 'complete');
});

test('an ambiguous local price mutation is read back once and never resubmitted', async context => {
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string) => {
    requests.push(path);
    if (path.endsWith('/start')) throw new TypeError('connection closed');
    return new Response(JSON.stringify(path.startsWith('/api/dashboard')
      ? { capabilities: { csrf_token: 'csrf', owned_price_refresh: true } } : completedRefresh));
  });
  const adapter = createLocalDashboardAdapter(); await adapter.getDashboard(selection);
  const driver = new OwnedPriceRefreshDriver({ transport: adapter.ownedPriceTransport, sessionId: 'local-opening', onSavedDataChanged() {} });
  await driver.start(); await driver.start();
  assert.deepEqual(requests.slice(1), ['/api/owned-prices/start', '/api/owned-prices']);
  assert.equal(driver.getSnapshot().phase, 'complete');
});
