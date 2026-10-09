import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedPriceStartupGate, OwnedPriceRefreshDriver, ownedPriceStatusText, readOwnedPriceResponse } from './ownedPriceRefresh.ts';
import type { OwnedPriceResponse, OwnedPriceRun } from './ownedPriceRefresh.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';

function saved(overrides: Partial<OwnedPriceRun> = {}, timing: Partial<OwnedPriceResponse> = {}): OwnedPriceResponse {
  return {
    run: { id: 17, state: 'running', total: 161, checked: 0, updated: 0, unresolved: 0, reason: null,
      started_at: '2026-10-09T00:00:00Z', completed_at: null, ...overrides },
    server_time: 500000, next_allowed_at: 0, ...timing,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mockTransport(call: (name: CloudEndpoint, input: Record<string, unknown>) => unknown | Promise<unknown>): CloudTransport {
  return { call: async <T>(name: CloudEndpoint, input: Record<string, unknown> = {}) => await call(name, input) as T };
}

test('one page session starts once and sequential TON steps never call Marketapp endpoints', async () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let active = 0; let steps = 0; let reloads = 0;
  const transport = mockTransport(async (name, input) => {
    calls.push({ name, input });
    assert.equal(active++, 0); await Promise.resolve(); active--;
    if (name === 'startOwnedPriceRefresh') return saved();
    assert.equal(name, 'stepOwnedPriceRefresh');
    return ++steps === 1 ? saved({ checked: 50, updated: 40 }) : saved({ state: 'complete', checked: 161, updated: 150 });
  });
  const driver = new OwnedPriceRefreshDriver({ transport, sessionId: 'page-session', onSavedDataChanged: () => { reloads++; } });
  const first = driver.start();
  assert.equal(driver.start(), first);
  await first; await driver.start();
  assert.deepEqual(calls, [
    { name: 'startOwnedPriceRefresh', input: { session_id: 'page-session' } },
    { name: 'stepOwnedPriceRefresh', input: { run_id: 17 } },
    { name: 'stepOwnedPriceRefresh', input: { run_id: 17 } },
  ]);
  assert.equal(reloads, 2);
  assert.equal(driver.getSnapshot().phase, 'complete');
});

test('a fresh page session can join an existing run using its returned ID', async () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const transport = mockTransport((name, input) => {
    calls.push({ name, input });
    return saved({ id: 99, checked: 100, updated: 95, state: name === 'stepOwnedPriceRefresh' ? 'complete' : 'running' });
  });
  await new OwnedPriceRefreshDriver({ transport, sessionId: 'new-opening', onSavedDataChanged() {} }).start();
  assert.deepEqual(calls, [
    { name: 'startOwnedPriceRefresh', input: { session_id: 'new-opening' } },
    { name: 'stepOwnedPriceRefresh', input: { run_id: 99 } },
  ]);
});

test('server-relative pacing tolerates a wildly incorrect device clock', async () => {
  let now = 1000; let steps = 0;
  const waits: number[] = [];
  const driver = new OwnedPriceRefreshDriver({
    transport: mockTransport(name => {
      if (name === 'startOwnedPriceRefresh') return saved({}, { server_time: 9000000, next_allowed_at: 9002500 });
      steps++;
      return saved({ state: 'complete' });
    }), sessionId: 'page', onSavedDataChanged() {}, now: () => now,
    wait: async ms => { waits.push(ms); now += ms; },
  });
  await driver.start();
  assert.deepEqual(waits, [1000, 1000, 500]);
  assert.equal(steps, 1);
});

test('each response refreshes pacing; joining and every newly checked batch reload the dashboard', async () => {
  let now = 100; let steps = 0; let reloads = 0;
  const waits: number[] = [];
  const driver = new OwnedPriceRefreshDriver({
    transport: mockTransport(name => {
      if (name === 'startOwnedPriceRefresh') return saved({ checked: 5, updated: 4 });
      steps++;
      return steps === 1 ? saved({ checked: 6, updated: 4, unresolved: 2 }, { server_time: 999000, next_allowed_at: 999100 })
        : saved({ state: 'complete', checked: 7, updated: 5, unresolved: 2 });
    }), sessionId: 'page', onSavedDataChanged: () => { reloads++; }, now: () => now,
    wait: async ms => { waits.push(ms); now += ms; },
  });
  await driver.start();
  assert.deepEqual(waits, [100]); assert.equal(reloads, 3);
});

test('an unresolved-only batch reloads saved freshness and warnings without an amount update', async () => {
  let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => name === 'startOwnedPriceRefresh'
    ? saved() : saved({ state: 'partial', checked: 3, updated: 0, unresolved: 3, reason: 'No current contract price available' })),
  sessionId: 'page', onSavedDataChanged: () => { reloads++; } });
  await driver.start();
  assert.equal(reloads, 1);
  assert.equal(driver.getSnapshot().run?.updated, 0);
  assert.equal(driver.getSnapshot().run?.unresolved, 3);
  assert.match(ownedPriceStatusText(driver.getSnapshot()), /3 unresolved/);
});

test('joining previously checked unresolved observations reloads them once', async () => {
  let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(() => saved({ state: 'partial', checked: 3, updated: 0, unresolved: 3 })),
    sessionId: 'page', onSavedDataChanged: () => { reloads++; } });
  await driver.start(); await driver.start();
  assert.equal(reloads, 1);
});

test('hidden page interrupts waits and showing the same page cannot restart it', async () => {
  const calls: string[] = [];
  let driver!: OwnedPriceRefreshDriver;
  driver = new OwnedPriceRefreshDriver({
    transport: mockTransport(name => { calls.push(name); return saved({}, { server_time: 1000, next_allowed_at: 2000 }); }),
    sessionId: 'page', onSavedDataChanged() {}, now: () => 1000,
    wait: async (_ms, signal) => { driver.interrupt(); assert.equal(signal.aborted, true); },
  });
  await driver.start(); await driver.start();
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().phase, 'partial');
});

test('direct interruption before start permanently suppresses that driver', async () => {
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(assert.fail), sessionId: 'page', onSavedDataChanged() {} });
  driver.interrupt(); await driver.start();
  assert.equal(driver.getSnapshot().phase, 'idle');
});

test('hide during Start preserves its result but sends no step or global Stop', async () => {
  const pending = deferred<OwnedPriceResponse>(); const calls: string[] = [];
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name); return name === 'startOwnedPriceRefresh' ? pending.promise : saved();
  }), sessionId: 'page', onSavedDataChanged() {} });
  const running = driver.start(); driver.interrupt(); pending.resolve(saved()); await running;
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().phase, 'partial');
});

test('hide during a pending step still reveals committed prices and performs one read', async () => {
  const pending = deferred<OwnedPriceResponse>(); const stepping = deferred<void>(); const calls: string[] = [];
  let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name);
    if (name === 'startOwnedPriceRefresh') return saved();
    if (name === 'stepOwnedPriceRefresh') { stepping.resolve(); return pending.promise; }
    return saved({ checked: 50, updated: 49, unresolved: 1 });
  }), sessionId: 'page', onSavedDataChanged: () => { reloads++; } });
  const running = driver.start(); await stepping.promise; driver.interrupt();
  pending.resolve(saved({ checked: 50, updated: 49, unresolved: 1 })); await running;
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(reloads, 1); assert.equal(driver.getSnapshot().run?.updated, 49);
});

test('ambiguous Start or Step only reads status once and never retries a mutation', async () => {
  for (const failed of ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh']) {
    const calls: string[] = [];
    const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
      calls.push(name); if (name === failed) throw new Error('sensitive upstream details'); return saved();
    }), sessionId: 'page', onSavedDataChanged() {} });
    await driver.start(); await driver.start();
    assert.deepEqual(calls, failed === 'startOwnedPriceRefresh'
      ? ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']
      : ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'getOwnedPriceRefresh']);
    assert.equal(driver.getSnapshot().phase, 'unavailable');
    assert.ok(!ownedPriceStatusText(driver.getSnapshot()).includes('sensitive'));
  }
});

test('reconciliation may reveal a completed mutation, but a different run never replaces known progress', async () => {
  for (const id of [17, 18]) {
    const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
      if (name === 'startOwnedPriceRefresh') return saved({ checked: 10, updated: 9 });
      if (name === 'stepOwnedPriceRefresh') throw new Error('timeout');
      return saved({ id, state: 'complete', checked: 161, updated: 160 });
    }), sessionId: 'page', onSavedDataChanged() {} });
    await driver.start();
    assert.equal(driver.getSnapshot().run?.id, 17);
    assert.equal(driver.getSnapshot().phase, id === 17 ? 'complete' : 'unavailable');
  }
});

test('session guard caps steps at 60 without a global Stop or an automatic next batch', async () => {
  let steps = 0; const calls: string[] = [];
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name); if (name === 'stepOwnedPriceRefresh') steps++; return saved();
  }), sessionId: 'page', onSavedDataChanged() {}, now: () => 1000, maxCalls: 999 });
  await driver.start(); await driver.start();
  assert.equal(steps, 60);
  assert.equal(calls.filter(name => name === 'getOwnedPriceRefresh').length, 1);
  assert.ok(!calls.includes('stopOwnedPriceRefresh'));
  assert.equal(driver.getSnapshot().phase, 'partial');
});

test('two-minute guard includes Start latency and does not wait beyond its deadline', async () => {
  for (const startLatency of [120000, 0]) {
    let now = 1000; const calls: string[] = [];
    const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
      calls.push(name);
      if (name === 'startOwnedPriceRefresh') now += startLatency;
      return saved({}, { server_time: 500000, next_allowed_at: startLatency ? 0 : 620000 });
    }), sessionId: 'page', onSavedDataChanged() {}, now: () => now, wait: async () => { assert.fail('No wait expected'); }, maxDurationMs: 999999 });
    await driver.start();
    assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  }
});

test('explicit Stop during a step is deduplicated and reconciles after the pending commit', async () => {
  const pending = deferred<OwnedPriceResponse>(); const stepping = deferred<void>(); const calls: string[] = [];
  let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name);
    if (name === 'startOwnedPriceRefresh') return saved();
    if (name === 'stepOwnedPriceRefresh') { stepping.resolve(); return pending.promise; }
    if (name === 'stopOwnedPriceRefresh') return saved({ state: 'partial' });
    return saved({ state: 'partial', checked: 50, updated: 48, unresolved: 2 });
  }), sessionId: 'page', onSavedDataChanged: () => { reloads++; } });
  const running = driver.start(); await stepping.promise;
  await Promise.all([driver.stop(), driver.stop()]);
  pending.resolve(saved({ checked: 50, updated: 48, unresolved: 2 })); await running;
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'stopOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().run?.state, 'partial');
  assert.equal(driver.getSnapshot().run?.updated, 48); assert.equal(reloads, 1);
});

test('explicit Stop while Start is pending waits for its run ID and never steps', async () => {
  const pending = deferred<OwnedPriceResponse>(); const calls: string[] = [];
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name); return name === 'startOwnedPriceRefresh' ? pending.promise : saved({ state: 'partial' });
  }), sessionId: 'page', onSavedDataChanged() {} });
  const running = driver.start(); await driver.stop(); pending.resolve(saved()); await running;
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'stopOwnedPriceRefresh', 'getOwnedPriceRefresh']);
});

test('ambiguous Stop is not retried and a failed reconciliation retains saved counters', async () => {
  const stepping = deferred<void>(); const pending = deferred<OwnedPriceResponse>(); const calls: string[] = [];
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name);
    if (name === 'startOwnedPriceRefresh') return saved({ checked: 40, updated: 35 });
    if (name === 'stepOwnedPriceRefresh') { stepping.resolve(); return pending.promise; }
    throw new Error('timeout');
  }), sessionId: 'page', onSavedDataChanged() {} });
  const running = driver.start(); await stepping.promise; await driver.stop();
  pending.resolve(saved({ checked: 50, updated: 45 })); await running; await driver.stop();
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'stopOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().phase, 'unavailable');
  assert.equal(driver.getSnapshot().run?.checked, 50);
});

test('empty and completed runs stop immediately; terminal messages preserve uncertainty', async () => {
  for (const run of [saved({ state: 'complete', total: 0 }), saved({ state: 'complete', checked: 161, updated: 159, unresolved: 2 }), saved({ state: 'partial', checked: 50, unresolved: 3 }), saved({ state: 'failed' })]) {
    const calls: string[] = [];
    const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => { calls.push(name); return run; }), sessionId: 'page', onSavedDataChanged() {} });
    await driver.start();
    assert.deepEqual(calls, ['startOwnedPriceRefresh']);
    const message = ownedPriceStatusText(driver.getSnapshot());
    if (run.run?.total === 0) assert.match(message, /No saved gifts/);
    else if (run.run?.unresolved) assert.match(message, /unresolved/);
    else assert.match(message, /unavailable/);
  }
});

test('malformed refresh states and counters cannot enter the status renderer', () => {
  for (const value of [null, {}, saved({}, { server_time: NaN }), saved({}, { next_allowed_at: -1 }),
    saved({ id: 0 }), saved({ total: -1 }), saved({ checked: 162 }), saved({ updated: 1 }),
    saved({ unresolved: 1 }), saved({ state: 'surprise' as OwnedPriceRun['state'] }), saved({ reason: {} as string })]) {
    assert.throws(() => readOwnedPriceResponse(value), /unexpected/);
  }
  assert.equal(readOwnedPriceResponse(saved({}, { run: null })).run, null);
});

test('status subscriptions expose cached snapshots and cleanly unsubscribe', async () => {
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(() => saved({ state: 'complete' })), sessionId: 'page', onSavedDataChanged() {} });
  assert.equal(driver.getSnapshot(), driver.getSnapshot());
  let updates = 0;
  const unsubscribe = driver.subscribe(() => { updates++; });
  await driver.start(); assert.equal(updates, 2);
  unsubscribe(); driver.interrupt(); assert.equal(updates, 2);
});

test('a hidden preload starts once on first visibility after a capable dashboard loads', () => {
  let hidden = true; let starts = 0; let interrupts = 0;
  const gate = createOwnedPriceStartupGate({ start: async () => { starts++; }, interrupt() { interrupts++; } }, () => hidden);
  gate.visibilityChanged(); gate.dashboardLoaded(true); gate.dashboardLoaded(true); gate.interrupt();
  assert.equal(starts, 0); assert.equal(interrupts, 0);
  hidden = false; gate.visibilityChanged(); gate.visibilityChanged(); gate.dashboardLoaded(true);
  assert.equal(starts, 1); assert.equal(interrupts, 0);
  hidden = true; gate.visibilityChanged(); assert.equal(interrupts, 1);
  hidden = false; gate.visibilityChanged(); gate.dashboardLoaded(true);
  assert.equal(starts, 1);
});

test('startup needs both first visibility and dashboard capability, regardless of order', () => {
  let hidden = true; let starts = 0;
  const gate = createOwnedPriceStartupGate({ start: async () => { starts++; }, interrupt() {} }, () => hidden);
  gate.dashboardLoaded(false); hidden = false; gate.visibilityChanged();
  assert.equal(starts, 0);
  gate.dashboardLoaded(true); assert.equal(starts, 1);
  gate.dashboardLoaded(false); gate.dashboardLoaded(true); gate.visibilityChanged(); assert.equal(starts, 1);
});

test('hide interrupts an already-started pending refresh and showing it never resumes', async () => {
  let hidden = false; const calls: string[] = []; const pending = deferred<OwnedPriceResponse>();
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name); return name === 'startOwnedPriceRefresh' ? pending.promise : saved();
  }), sessionId: 'page', onSavedDataChanged() {} });
  const gate = createOwnedPriceStartupGate(driver, () => hidden);
  gate.dashboardLoaded(true); hidden = true; gate.visibilityChanged();
  pending.resolve(saved()); await driver.start();
  hidden = false; gate.visibilityChanged(); gate.dashboardLoaded(true);
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().phase, 'partial');
});
