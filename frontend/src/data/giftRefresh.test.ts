import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnedPriceRefreshDriver, createOwnedPriceStartupGate, giftRefreshSourceText, ownedPriceStatusText, readOwnedPriceResponse, savedGiftRefreshEnabled } from './ownedPriceRefresh.ts';
import type { OwnedPriceEndpoint, OwnedPriceResponse, OwnedPriceRun, OwnedPriceTransport } from './ownedPriceRefresh.ts';
import { presentOwnedPriceSync } from './syncPresentation.ts';

const wallet = `0:${'1'.repeat(64)}`, nft = `0:${'2'.repeat(64)}`;
function response(fields: Partial<OwnedPriceRun> = {}, metadata: Partial<OwnedPriceResponse> = {}): OwnedPriceResponse {
  return { run: { id: 1, scope: 'portfolio', wallet, session_id: 'opening', state: 'running', total: 3, checked: 0, updated: 0, unresolved: 0,
    started_at: '2026-10-11T10:00:00Z', completed_at: null, reason: null, ...fields },
    server_time: 1000, next_allowed_at: 0, provider: 'marketapp_website', cache_hit: false, fallback_reason: null, ...metadata };
}
function transport(handler: (endpoint: OwnedPriceEndpoint, input: Record<string, unknown>) => OwnedPriceResponse | Promise<OwnedPriceResponse>): OwnedPriceTransport {
  return { portfolioRefresh: true, async call<T>(endpoint: OwnedPriceEndpoint, input: Record<string, unknown> = {}) { return await handler(endpoint, input) as T; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

test('Telegram opening selects personal gifts once and manual refresh is explicitly uncached', async () => {
  const calls: { endpoint: OwnedPriceEndpoint; input: Record<string, unknown> }[] = []; let session = 'opening';
  const driver = new OwnedPriceRefreshDriver({ sessionId: session, wallet, createSessionId: () => 'manual', onSavedDataChanged() {},
    transport: transport((endpoint, input) => {
      calls.push({ endpoint, input }); if (endpoint === 'startGiftRefresh') { session = String(input.session_id); return response({ session_id: session }); }
      assert.equal(endpoint, 'stepGiftRefresh'); return response({ session_id: session, state: 'complete', checked: 3, updated: 3, status_updated: 3 });
    }),
  });
  const gate = createOwnedPriceStartupGate(driver, () => false);
  gate.dashboardLoaded(true); gate.dashboardLoaded(true); await driver.start(); gate.visibilityChanged();
  await gate.manualRefresh(() => driver.refresh());
  assert.deepEqual(calls, [
    { endpoint: 'startGiftRefresh', input: { session_id: 'opening', automatic: true } },
    { endpoint: 'stepGiftRefresh', input: { run_id: 1, session_id: 'opening' } },
    { endpoint: 'startGiftRefresh', input: { session_id: 'manual', automatic: false } },
    { endpoint: 'stepGiftRefresh', input: { run_id: 1, session_id: 'manual' } },
  ]);
});

test('server-authorized cache finishes without steps or client-only freshness decisions', async () => {
  let reloads = 0; const calls: unknown[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() { reloads++; },
    transport: transport((endpoint, input) => {
      calls.push({ endpoint, input }); return response({ state: 'complete', checked: 3, updated: 3 }, { cache_hit: true });
    }),
  });
  await driver.start(); await driver.start();
  assert.deepEqual(calls, [{ endpoint: 'startGiftRefresh', input: { session_id: 'opening', automatic: true } }]);
  assert.equal(reloads, 0); assert.equal(driver.getSnapshot().cacheHit, true);
  assert.equal(ownedPriceStatusText(driver.getSnapshot()), 'Your gifts were checked recently.');
});

test('provider fallback changes source inside the original run without starting another refresh', async () => {
  const calls: OwnedPriceEndpoint[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() {}, transport: transport(endpoint => {
    calls.push(endpoint); return endpoint === 'startGiftRefresh' ? response()
      : response({ state: 'complete', checked: 3, updated: 2, unresolved: 1 }, { provider: 'toncenter', fallback_reason: 'login_expired' });
  }) });
  await driver.start();
  assert.deepEqual(calls, ['startGiftRefresh', 'stepGiftRefresh']);
  assert.equal(driver.getSnapshot().run?.id, 1); assert.equal(driver.getSnapshot().provider, 'toncenter');
  assert.equal(driver.getSnapshot().fallbackReason, 'login_expired');
  assert.match(giftRefreshSourceText(driver.getSnapshot())!, /login expired.*TON checks/);
});

test('a selected gift stays on the targeted TON route even when portfolio refresh uses Marketapp', async () => {
  const calls: { endpoint: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, createSessionId: () => 'gift', onSavedDataChanged() {},
    transport: transport((endpoint, input) => {
      calls.push({ endpoint, input }); return response({ scope: 'gift', nft_address: nft, session_id: 'gift', total: 1,
        ...(endpoint === 'stepOwnedPriceRefresh' ? { state: 'complete', checked: 1, updated: 1 } : {}) }, { provider: 'toncenter' });
    }),
  });
  await driver.refreshGift(nft);
  assert.deepEqual(calls, [
    { endpoint: 'startOwnedPriceRefresh', input: { session_id: 'gift', nft_address: nft } },
    { endpoint: 'stepOwnedPriceRefresh', input: { run_id: 1 } },
  ]);
});

test('unknown Start outcome reconciles only its own personal-gift session and never repeats the mutation', async () => {
  const calls: { endpoint: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() {}, transport: transport((endpoint, input) => {
    calls.push({ endpoint, input }); if (endpoint === 'startGiftRefresh') throw new Error('private provider payload');
    assert.equal(endpoint, 'getGiftRefresh'); return response({ state: 'partial', checked: 2, updated: 2 });
  }) });
  await driver.start();
  assert.deepEqual(calls, [
    { endpoint: 'startGiftRefresh', input: { session_id: 'opening', automatic: true } },
    { endpoint: 'getGiftRefresh', input: { session_id: 'opening' } },
  ]);
  assert.equal(driver.getSnapshot().run?.checked, 2);
  assert.ok(!ownedPriceStatusText(driver.getSnapshot()).includes('private'));
});

test('a different portfolio session cannot be adopted during reconciliation', async () => {
  const calls: OwnedPriceEndpoint[] = []; let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() { reloads++; }, transport: transport(endpoint => {
    calls.push(endpoint); return response({ session_id: 'another-opening', state: 'complete', checked: 3, updated: 3 });
  }) });
  await driver.start();
  assert.deepEqual(calls, ['startGiftRefresh', 'getGiftRefresh']);
  assert.equal(driver.getSnapshot().run, null); assert.equal(reloads, 0);
});

test('hidden opening and late fallback remain fenced until reconciliation settles', async () => {
  const start = deferred<OwnedPriceResponse>(), read = deferred<OwnedPriceResponse>(), reading = deferred<void>();
  const calls: OwnedPriceEndpoint[] = []; let hidden = false;
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() {}, transport: transport(endpoint => {
    calls.push(endpoint); if (endpoint === 'startGiftRefresh') return start.promise;
    assert.equal(endpoint, 'getGiftRefresh'); reading.resolve(); return read.promise;
  }) });
  const gate = createOwnedPriceStartupGate(driver, () => hidden);
  gate.dashboardLoaded(true); hidden = true; gate.visibilityChanged();
  start.resolve(response({}, { provider: 'toncenter', fallback_reason: 'website_unavailable' }));
  await reading.promise; hidden = false; gate.visibilityChanged();
  assert.equal(driver.getSnapshot().canRefresh, false); const manual = gate.manualRefresh(() => driver.refresh());
  // Manual refresh joined the uncertain request and cannot queue a new start.
  read.resolve(response({ state: 'partial' }, { provider: 'toncenter', fallback_reason: 'website_unavailable' }));
  await manual; await driver.start();
  assert.deepEqual(calls, ['startGiftRefresh', 'getGiftRefresh']);
});

test('provider metadata rejects unsupported source, cache shape and untrusted fallback reasons', () => {
  for (const metadata of [{ provider: 'evil_url' }, { provider: null }, { cache_hit: 'true' }, { cache_hit: null }, { fallback_reason: 'secret cookie' }, { fallback_reason: {} }])
    assert.throws(() => readOwnedPriceResponse(response({}, metadata as Partial<OwnedPriceResponse>)), /unexpected/);
  for (const reason of ['no_login', 'login_expired', 'website_unavailable', 'unsupported_response', 'request_limit', 'website_disabled'] as const)
    assert.equal(readOwnedPriceResponse(response({}, { provider: 'toncenter', fallback_reason: reason })).fallback_reason, reason);
  assert.match(giftRefreshSourceText({ phase: 'checking', run: null, canStop: true, provider: 'marketapp_website' })!, /signed-in Marketapp/);
  assert.equal(presentOwnedPriceSync({ phase: 'checking', run: response().run, canStop: true, provider: 'marketapp_website' }, { rentalStatus: true }).message,
    'Refreshing your saved gifts from Marketapp.');
});

test('saved-wallet capability permits a disconnected Telegram refresh and cannot enable desktop requests', () => {
  assert.equal(savedGiftRefreshEnabled('serverless', { personal_gift_refresh: true, owned_price_refresh: false }), true);
  assert.equal(savedGiftRefreshEnabled('serverless', { owned_price_refresh: true }), true);
  assert.equal(savedGiftRefreshEnabled('local', { personal_gift_refresh: true, owned_price_refresh: false }), false);
  assert.equal(savedGiftRefreshEnabled('local', { owned_price_refresh: true }), true);
  assert.equal(savedGiftRefreshEnabled('serverless'), false);
});

test('disconnecting the saved wallet approval discards a late website response and does not auto-restart', async () => {
  const start = deferred<OwnedPriceResponse>(); const calls: OwnedPriceEndpoint[] = []; let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, walletVerified: true, onSavedDataChanged() { reloads++; },
    transport: transport(endpoint => { calls.push(endpoint); return start.promise; }),
  });
  const active = driver.start(); driver.setContext(wallet, undefined, false);
  start.resolve(response({ state: 'complete', checked: 3, updated: 3 })); await active; await driver.start();
  assert.deepEqual(calls, ['startGiftRefresh']); assert.equal(driver.getSnapshot().phase, 'idle'); assert.equal(reloads, 0);
});

test('Stop of an uncertain portfolio Start reconciles and stops with its immutable caller session', async () => {
  const start = deferred<OwnedPriceResponse>(), stopping = deferred<void>();
  const calls: { endpoint: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() {}, transport: transport((endpoint, input) => {
    calls.push({ endpoint, input }); if (endpoint === 'startGiftRefresh') return start.promise;
    if (endpoint === 'getGiftRefresh') return response({ account_generation: 0 });
    assert.equal(endpoint, 'stopGiftRefresh'); stopping.resolve(); return response({ account_generation: 0, state: 'partial' });
  }) });
  const active = driver.start(), stopped = driver.stop();
  start.resolve(Object.assign(response(), { run: null })); await stopping.promise; await active; await stopped;
  assert.deepEqual(calls, [
    { endpoint: 'startGiftRefresh', input: { session_id: 'opening', automatic: true } },
    { endpoint: 'getGiftRefresh', input: { session_id: 'opening' } },
    { endpoint: 'stopGiftRefresh', input: { run_id: 1, session_id: 'opening', account_generation: 0 } },
  ]);
});

test('website coverage then expiry-only TON completion reloads final evidence with unchanged counters', async () => {
  let reloads = 0, steps = 0;
  const coverage = { total: 161, checked: 161, updated: 88, unresolved: 73, status_updated: 88, status_unresolved: 73 };
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() { reloads++; },
    transport: transport(endpoint => {
      if (endpoint === 'startGiftRefresh') return response({ ...coverage });
      assert.equal(endpoint, 'stepGiftRefresh'); steps++;
      return response({ ...coverage, state: 'complete' });
    }),
  });
  await driver.start();
  assert.equal(steps, 1); assert.equal(reloads, 2, 'website observations and final TON expiry each reload saved gifts');
  assert.equal(driver.getSnapshot().run?.checked, 161); assert.equal(driver.getSnapshot().phase, 'complete');
});

test('status-only evidence advances reloads independently of unchanged asking prices and gift coverage', async () => {
  let reloads = 0, steps = 0;
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() { reloads++; },
    transport: transport(endpoint => {
      if (endpoint === 'startGiftRefresh') return response({ checked: 3, updated: 1, status_updated: 1, status_unresolved: 0 });
      assert.equal(endpoint, 'stepGiftRefresh'); steps++;
      return response({ checked: 3, updated: 1, status_updated: 2, status_unresolved: 1,
        state: steps === 1 ? 'running' : 'complete' });
    }),
  });
  await driver.start();
  assert.equal(reloads, 3, 'initial evidence, status-only progress and terminal expiry commit each reload once');
});

test('active verification metadata is optional but rejects malformed or impossible work counters', () => {
  const verification = { stage: 'ton' as const, checked: 1, total: 2, waiting: false };
  assert.equal(readOwnedPriceResponse(response()).verification, undefined);
  assert.deepEqual(readOwnedPriceResponse(response({}, { verification })).verification, verification);
  for (const invalid of [null, [], {}, { ...verification, stage: 'private payload' }, { ...verification, checked: -1 },
    { ...verification, checked: 1.5 }, { ...verification, checked: 3 }, { ...verification, total: 4 },
    { ...verification, total: NaN }, { ...verification, waiting: 1 }, { ...verification, waiting: undefined },
    { ...verification, unexpected: true }]) {
    assert.throws(() => readOwnedPriceResponse(response({}, { verification: invalid } as Partial<OwnedPriceResponse>)), /unexpected/);
  }
  for (const state of ['complete', 'partial', 'failed'] as const)
    assert.throws(() => readOwnedPriceResponse(response({ state }, { verification })), /unexpected/);
  assert.throws(() => readOwnedPriceResponse({ ...response({}, { verification }), run: null }), /unexpected/);
});

test('website coverage keeps supplemental TON progress visible until its terminal result arrives', async () => {
  const finish = deferred<OwnedPriceResponse>(), stepping = deferred<void>();
  let steps = 0;
  const coverage = { total: 161, checked: 161, updated: 88, unresolved: 73, status_updated: 88, status_unresolved: 73 };
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', wallet, onSavedDataChanged() {},
    transport: transport(endpoint => {
      if (endpoint === 'startGiftRefresh') return response({ ...coverage }, {
        verification: { stage: 'ton', checked: 50, total: 93, waiting: false },
      });
      assert.equal(endpoint, 'stepGiftRefresh'); steps++; stepping.resolve(); return finish.promise;
    }),
  });
  const active = driver.start(); await stepping.promise;
  assert.equal(driver.getSnapshot().run?.checked, 161);
  assert.deepEqual(driver.getSnapshot().verification, { stage: 'ton', checked: 50, total: 93, waiting: false });
  const view = presentOwnedPriceSync(driver.getSnapshot(), { rentalStatus: true });
  assert.equal(view.progress.percent, 53);
  assert.equal(view.progress.label, '50 of 93 additional TON checks finished');
  assert.match(ownedPriceStatusText(driver.getSnapshot()), /additional gift details · 50\/93/);
  assert.match(giftRefreshSourceText(driver.getSnapshot())!, /additional TON checks/);
  finish.resolve(response({ ...coverage, state: 'partial', reason: 'provider_wait' })); await active;
  assert.equal(steps, 1); assert.equal(driver.getSnapshot().verification, undefined);
  assert.equal(driver.getSnapshot().phase, 'partial');
  assert.match(ownedPriceStatusText(driver.getSnapshot()), /TON requested a pause/);
  assert.match(presentOwnedPriceSync(driver.getSnapshot(), { rentalStatus: true }).message, /TON requested a pause.*saved/);
});
