import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedPriceStartupGate, OwnedPriceRefreshDriver, ownedPriceStatusText, readOwnedPriceResponse } from './ownedPriceRefresh.ts';
import type { OwnedPriceResponse, OwnedPriceRun, OwnedPriceEndpoint, OwnedPriceTransport } from './ownedPriceRefresh.ts';

test('combined status counters remain optional and reject invalid or contradictory results', () => {
  assert.equal(readOwnedPriceResponse(saved()).run?.status_updated, undefined);
  assert.equal(readOwnedPriceResponse(saved({ checked: 4, status_updated: 3, status_unresolved: 1 })).run?.status_updated, 3);
  for (const counters of [{ status_updated: -1 }, { status_updated: 1.5 }, { status_unresolved: 5 }, { status_updated: 3, status_unresolved: 2 }]) {
    assert.throws(() => readOwnedPriceResponse(saved({ checked: 4, ...counters })), /unexpected/);
  }
});

test('portfolio scope signatures stay optional for legacy responses and reject malformed proof markers', () => {
  assert.equal(readOwnedPriceResponse(saved()).run?.scope_signature, undefined);
  assert.equal(readOwnedPriceResponse(saved({ scope_signature: null })).run?.scope_signature, null);
  const signature = 'a'.repeat(64);
  assert.equal(readOwnedPriceResponse(saved({ scope_signature: signature })).run?.scope_signature, signature);
  for (const value of [0, [], 'a'.repeat(63), 'A'.repeat(64), 'x'.repeat(64)]) {
    assert.throws(() => readOwnedPriceResponse(saved({ scope_signature: value } as Partial<OwnedPriceRun>)), /unexpected/);
  }
});

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

function mockTransport(call: (name: OwnedPriceEndpoint, input: Record<string, unknown>) => unknown | Promise<unknown>): OwnedPriceTransport {
  return { call: async <T>(name: OwnedPriceEndpoint, input: Record<string, unknown> = {}) => await call(name, input) as T };
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

test('direct interruption before start suppresses automatic work for that driver', async () => {
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
  await driver.start(); assert.equal(updates, 3);
  unsubscribe(); driver.interrupt(); assert.equal(updates, 3);
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

test('Telegram retained pages recheck once after a long absence, not on short switches or polling', () => {
  let hidden = false, now = 1000, starts = 0, reopens = 0;
  const gate = createOwnedPriceStartupGate({ start: async () => { starts++; }, interrupt() {},
    reopen: async () => { reopens++; } }, () => hidden, { reopenAfterMs: 300000, now: () => now });
  gate.dashboardLoaded(true);
  hidden = true; gate.visibilityChanged(); now += 60000;
  hidden = false; gate.visibilityChanged();
  assert.equal(starts, 1); assert.equal(reopens, 0);
  hidden = true; gate.visibilityChanged(); now += 9 * 3600000;
  gate.visibilityChanged(); // repeated hidden notifications retain the first hide time
  hidden = false; gate.visibilityChanged(); gate.visibilityChanged(); gate.dashboardLoaded(true);
  assert.equal(starts, 1); assert.equal(reopens, 1);
  gate.dispose(); hidden = true; gate.visibilityChanged(); now += 3600000;
  hidden = false; gate.visibilityChanged();
  assert.equal(reopens, 1);
});

test('pagehide restoration waits for capability and manual refresh consumes the reopen event', async () => {
  let now = 1000, reopens = 0, manual = 0;
  const gate = createOwnedPriceStartupGate({ start: async () => {}, interrupt() {},
    reopen: async () => { reopens++; } }, () => false, { reopenAfterMs: 300000, now: () => now });
  gate.dashboardLoaded(true); gate.interrupt(); now += 3600000;
  gate.dashboardLoaded(false); gate.visibilityChanged(); assert.equal(reopens, 0);
  gate.dashboardLoaded(true); assert.equal(reopens, 1);
  gate.interrupt(); now += 3600000;
  await gate.manualRefresh(async () => { manual++; }); gate.visibilityChanged();
  assert.equal(manual, 1); assert.equal(reopens, 1);
});

test('reopening a completed personal refresh uses a new automatic session and retains source dates', async () => {
  const calls: Record<string, unknown>[] = [];
  const transport = { ...mockTransport((name, input) => {
    assert.equal(name, 'startGiftRefresh'); calls.push(input);
    return saved({ id: calls.length, state: 'complete', scope: 'portfolio', session_id: String(input.session_id),
      completed_at: '2026-10-09T00:01:00Z', check_started_at: '2026-10-09T00:00:00Z' }, { provider: 'marketapp_website', cache_hit: true });
  }), portfolioRefresh: true as const };
  const driver = new OwnedPriceRefreshDriver({ transport, sessionId: 'first-opening', createSessionId: () => 'reopened-session', onSavedDataChanged() {} });
  await driver.start(); driver.interrupt(); await driver.reopen(); await driver.start();
  assert.deepEqual(calls, [{ session_id: 'first-opening', automatic: true }, { session_id: 'reopened-session', automatic: true }]);
  assert.equal(driver.getSnapshot().run?.check_started_at, '2026-10-09T00:00:00Z');
});

test('foreground rechecks do not restart partial, failed, stopped or identity-changed work', async () => {
  for (const scenario of ['partial', 'failed', 'stopped', 'changed', 'uncertain'] as const) {
    let starts = 0, ids = 0;
    const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
      if (name === 'startOwnedPriceRefresh') {
        starts++;
        if (scenario === 'uncertain') throw new Error('connection lost');
      }
      return saved({ state: scenario === 'partial' || scenario === 'failed' ? scenario : 'complete' });
    }), sessionId: 'first', createSessionId: () => `reopened-${++ids}`, wallet: '0:' + '1'.repeat(64), onSavedDataChanged() {} });
    await driver.start();
    if (scenario === 'stopped') await driver.stop();
    if (scenario === 'changed') driver.setContext('0:' + '2'.repeat(64));
    driver.interrupt(); await driver.reopen();
    assert.equal(starts, 1, scenario); assert.equal(ids, 0, scenario);
  }
});

test('foreground rechecks never queue behind an unresolved Start', async () => {
  const pending = deferred<OwnedPriceResponse>(); let starts = 0, ids = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(() => { starts++; return pending.promise; }),
    sessionId: 'first', createSessionId: () => `later-${++ids}`, onSavedDataChanged() {} });
  const active = driver.start(); await driver.reopen();
  assert.equal(starts, 1); assert.equal(ids, 0);
  pending.resolve(saved({ state: 'complete' })); await active;
  assert.equal(starts, 1); assert.equal(ids, 0);
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

test('explicit refresh after complete, partial or failure uses a fresh key without another automatic start', async () => {
  for (const state of ['complete', 'partial', 'failed'] as const) {
    const keys: unknown[] = []; let starts = 0; let reloads = 0;
    const driver = new OwnedPriceRefreshDriver({ transport: mockTransport((name, input) => {
      assert.equal(name, 'startOwnedPriceRefresh'); keys.push(input.session_id);
      return ++starts === 1 ? saved({ state, checked: 10, updated: 9 })
        : saved({ id: 18, state: 'complete', checked: 2, updated: 1, unresolved: 1 });
    }), sessionId: 'opening', createSessionId: () => 'manual-1', onSavedDataChanged: () => { reloads++; } });
    await driver.start(); assert.equal(driver.getSnapshot().canRefresh, true);
    await driver.refresh(); await driver.start(); await driver.start();
    assert.deepEqual(keys, ['opening', 'manual-1']); assert.equal(driver.getSnapshot().run?.id, 18);
    assert.equal(driver.getSnapshot().phase, 'complete'); assert.equal(reloads, 2);
    assert.equal(driver.getSnapshot().canRefresh, true);
  }
});

test('double clicks do not generate or queue session IDs while an old or new Start is pending', async () => {
  const pending = [deferred<OwnedPriceResponse>(), deferred<OwnedPriceResponse>()];
  const keys: unknown[] = []; let ids = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport((name, input) => {
    assert.equal(name, 'startOwnedPriceRefresh'); keys.push(input.session_id);
    return pending[keys.length - 1].promise;
  }), sessionId: 'opening', createSessionId: () => `manual-${++ids}`, onSavedDataChanged() {} });
  const automatic = driver.start(); assert.equal(driver.getSnapshot().canRefresh, false);
  assert.equal(driver.refresh(), automatic); assert.equal(driver.refresh(), automatic); assert.equal(ids, 0);
  pending[0].resolve(saved({ state: 'complete' })); await automatic;
  const manual = driver.refresh(); assert.equal(driver.getSnapshot().canRefresh, false);
  assert.equal(driver.refresh(), manual); assert.equal(driver.refresh(), manual); assert.equal(ids, 1);
  pending[1].resolve(saved({ id: 18, state: 'complete' })); await manual; await driver.start();
  assert.deepEqual(keys, ['opening', 'manual-1']); assert.equal(driver.getSnapshot().canRefresh, true);
});

test('manual retry waits for uncertain mutation reconciliation then joins the server run without repeating the mutation', async () => {
  const read = deferred<OwnedPriceResponse>(), reading = deferred<void>();
  const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = []; let starts = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport((name, input) => {
    calls.push({ name, input });
    if (name === 'startOwnedPriceRefresh') {
      if (++starts === 1) throw new Error('ambiguous connection loss');
      return saved({ id: 77, checked: 3, updated: 2 });
    }
    if (name === 'getOwnedPriceRefresh') { reading.resolve(); return read.promise; }
    assert.deepEqual(input, { run_id: 77 }); return saved({ id: 77, state: 'complete', checked: 4, updated: 3 });
  }), sessionId: 'opening', createSessionId: () => 'manual-after-reconcile', onSavedDataChanged() {} });
  const automatic = driver.start(); await reading.promise;
  assert.equal(driver.getSnapshot().canRefresh, false); assert.equal(driver.refresh(), automatic);
  assert.equal(starts, 1);
  read.resolve(saved({ id: 77, checked: 3, updated: 2 })); await automatic;
  assert.equal(driver.getSnapshot().phase, 'unavailable'); assert.equal(driver.getSnapshot().canRefresh, true);
  await driver.refresh(); await driver.start();
  assert.deepEqual(calls, [
    { name: 'startOwnedPriceRefresh', input: { session_id: 'opening' } },
    { name: 'getOwnedPriceRefresh', input: {} },
    { name: 'startOwnedPriceRefresh', input: { session_id: 'manual-after-reconcile' } },
    { name: 'stepOwnedPriceRefresh', input: { run_id: 77 } },
  ]);
  assert.equal(driver.getSnapshot().phase, 'complete');
});

test('an interrupted Step and its delayed status read must settle before old counters are reset', async () => {
  const step = deferred<OwnedPriceResponse>(), stepping = deferred<void>();
  const read = deferred<OwnedPriceResponse>(), reading = deferred<void>();
  const keys: unknown[] = []; let starts = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport((name, input) => {
    if (name === 'startOwnedPriceRefresh') { keys.push(input.session_id); return ++starts === 1 ? saved() : saved({ id: 99, state: 'complete', checked: 5, updated: 4 }); }
    if (name === 'stepOwnedPriceRefresh') { stepping.resolve(); return step.promise; }
    assert.equal(name, 'getOwnedPriceRefresh'); reading.resolve(); return read.promise;
  }), sessionId: 'opening', createSessionId: () => 'manual-after-step', onSavedDataChanged() {} });
  const automatic = driver.start(); await stepping.promise; driver.interrupt();
  assert.equal(driver.getSnapshot().canRefresh, false); assert.equal(driver.refresh(), automatic);
  step.resolve(saved({ checked: 50, updated: 49 })); await reading.promise;
  assert.equal(driver.getSnapshot().run?.checked, 50); assert.equal(driver.refresh(), automatic); assert.equal(starts, 1);
  read.resolve(saved({ state: 'partial', checked: 50, updated: 49 })); await automatic;
  await driver.refresh();
  assert.deepEqual(keys, ['opening', 'manual-after-step']); assert.equal(driver.getSnapshot().run?.id, 99);
  assert.equal(driver.getSnapshot().run?.checked, 5); assert.equal(driver.getSnapshot().phase, 'complete');
});

test('a pending explicit Stop remains bound to its old run and prevents a manual restart', async () => {
  const stopped = deferred<OwnedPriceResponse>(); let starts = 0; const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport((name, input) => {
    calls.push({ name, input });
    if (name === 'startOwnedPriceRefresh') return ++starts === 1 ? saved() : saved({ id: 18, state: 'complete' });
    if (name === 'stopOwnedPriceRefresh') return stopped.promise;
    return saved();
  }), sessionId: 'opening', createSessionId: () => 'manual-after-stop', maxCalls: 0, onSavedDataChanged() {} });
  await driver.start(); const stopping = driver.stop();
  assert.equal(driver.getSnapshot().canRefresh, false); assert.equal(driver.refresh(), stopping); assert.equal(driver.stop(), stopping);
  assert.equal(starts, 1);
  stopped.resolve(saved({ state: 'partial', checked: 4, updated: 3 })); await stopping;
  assert.equal(driver.getSnapshot().canRefresh, true); await driver.refresh();
  assert.deepEqual(calls.filter(row => row.name === 'stopOwnedPriceRefresh'), [{ name: 'stopOwnedPriceRefresh', input: { run_id: 17 } }]);
  assert.equal(driver.getSnapshot().run?.id, 18); assert.equal(driver.getSnapshot().phase, 'complete');
});

test('manual checks remain individually bounded and never trigger another automatic continuation', async () => {
  const calls: OwnedPriceEndpoint[] = []; const keys: unknown[] = []; let ids = 0;
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport((name, input) => {
    calls.push(name); if (name === 'startOwnedPriceRefresh') keys.push(input.session_id); return saved();
  }), sessionId: 'opening', createSessionId: () => `manual-${++ids}`, maxCalls: 2, now: () => 1000, onSavedDataChanged() {} });
  await driver.start(); await driver.refresh(); await driver.refresh(); await driver.start();
  assert.deepEqual(keys, ['opening', 'manual-1', 'manual-2']);
  assert.equal(calls.filter(name => name === 'stepOwnedPriceRefresh').length, 6);
  assert.equal(calls.filter(name => name === 'getOwnedPriceRefresh').length, 3);
  assert.equal(driver.getSnapshot().phase, 'partial'); assert.equal(driver.getSnapshot().canRefresh, true);
});

test('manual lifecycle permits visible restoration without automatic restart and blocks refresh after real disposal', async () => {
  let hidden = true; let starts = 0; let ids = 0; const pending = deferred<OwnedPriceResponse>(); const calls: OwnedPriceEndpoint[] = [];
  const driver = new OwnedPriceRefreshDriver({ transport: mockTransport(name => {
    calls.push(name); if (name === 'startOwnedPriceRefresh') return ++starts === 1 ? pending.promise : saved({ state: 'complete' }); return saved();
  }), sessionId: 'opening', createSessionId: () => `manual-visible-${++ids}`, onSavedDataChanged() {} });
  const gate = createOwnedPriceStartupGate(driver, () => hidden);
  await gate.manualRefresh(() => driver.refresh()); gate.dashboardLoaded(false);
  hidden = false; await gate.manualRefresh(() => driver.refresh()); assert.equal(starts, 0);
  hidden = true; gate.dashboardLoaded(true); await gate.manualRefresh(() => driver.refresh()); assert.equal(starts, 0);
  hidden = false; const manual = gate.manualRefresh(() => driver.refresh());
  gate.dashboardLoaded(true); gate.visibilityChanged(); assert.equal(starts, 1);
  hidden = true; gate.visibilityChanged(); assert.equal(driver.getSnapshot().canRefresh, false);
  await gate.manualRefresh(() => driver.refresh()); assert.equal(starts, 1);
  pending.resolve(saved()); await manual;
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().phase, 'partial');
  hidden = false; gate.visibilityChanged(); gate.dashboardLoaded(true); assert.equal(starts, 1);
  await gate.manualRefresh(() => driver.refresh()); assert.equal(starts, 2);
  // The hook's pagehide path interrupts instead of disposing: BFCache can
  // restore the same mounted state, and only a deliberate click restarts it.
  gate.interrupt(); gate.visibilityChanged(); gate.dashboardLoaded(true); assert.equal(starts, 2);
  await gate.manualRefresh(() => driver.refresh()); assert.equal(starts, 3);
  gate.dispose(); await gate.manualRefresh(() => driver.refresh()); gate.dashboardLoaded(true); gate.visibilityChanged();
  assert.equal(starts, 3);
});

const giftAddress = `0:${'1'.repeat(64)}`;
const otherGiftAddress = `0:${'2'.repeat(64)}`;
const walletAddress = `0:${'3'.repeat(64)}`;
const otherWalletAddress = `0:${'4'.repeat(64)}`;
function giftSaved(overrides: Partial<OwnedPriceRun> = {}, timing: Partial<OwnedPriceResponse> = {}): OwnedPriceResponse {
  return saved({ scope: 'gift', nft_address: giftAddress, wallet: walletAddress, session_id: 'gift-session', total: 1, ...overrides }, timing);
}

test('scope validation permits legacy portfolio runs and rejects malformed targeted identities', () => {
  assert.equal(readOwnedPriceResponse(saved()).run?.scope, undefined);
  assert.equal(readOwnedPriceResponse(saved({ scope: 'portfolio', nft_address: null, wallet: walletAddress })).run?.scope, 'portfolio');
  assert.equal(readOwnedPriceResponse(giftSaved()).run?.nft_address, giftAddress);
  assert.equal(readOwnedPriceResponse(giftSaved({ session_id: 'x'.repeat(160) })).run?.session_id?.length, 160);
  for (const fields of [
    { scope: 'another' }, { scope: 'portfolio', nft_address: giftAddress }, { scope: undefined, nft_address: giftAddress },
    { nft_address: 'opaque-id' }, { wallet: null }, { wallet: 'invalid-wallet' }, { session_id: undefined }, { session_id: '' },
    { session_id: 'x'.repeat(161) }, { total: 2 },
  ]) assert.throws(() => readOwnedPriceResponse(giftSaved(fields as Partial<OwnedPriceRun>)), /unexpected/);
});

test('single gift refresh sends only its canonical target and uses the existing sequential step lifecycle', async () => {
  const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = []; let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport((name, input) => {
      calls.push({ name, input });
      return name === 'startOwnedPriceRefresh' ? giftSaved() : giftSaved({ state: 'complete', checked: 1, updated: 1, status_updated: 1 });
    }), onSavedDataChanged: () => { reloads++; } });
  await driver.refreshGift(giftAddress.toUpperCase().replace('0:', '0:'));
  assert.deepEqual(calls, [
    { name: 'startOwnedPriceRefresh', input: { session_id: 'gift-session', nft_address: giftAddress } },
    { name: 'stepOwnedPriceRefresh', input: { run_id: 17 } },
  ]);
  assert.equal(reloads, 1); assert.equal(driver.getSnapshot().phase, 'complete');
  assert.equal(ownedPriceStatusText(driver.getSnapshot()), 'Gift price and rental status checked.');
});

test('duplicate targeted clicks share pending work while another target or portfolio request gets a busy result', async () => {
  const reply = deferred<OwnedPriceResponse>(); const calls: OwnedPriceEndpoint[] = []; let sessionIds = 0;
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => { sessionIds++; return 'gift-session'; },
    transport: mockTransport(name => { calls.push(name); return reply.promise; }), onSavedDataChanged() {} });
  const pending = driver.refreshGift(giftAddress);
  assert.equal(driver.refreshGift(giftAddress), pending);
  await assert.rejects(driver.refreshGift(otherGiftAddress), /still finishing/);
  await assert.rejects(driver.refresh(), /still finishing/);
  assert.equal(sessionIds, 1); assert.equal(driver.getSnapshot().canRefresh, false);
  reply.resolve(giftSaved({ state: 'complete', checked: 1, updated: 1 })); await pending;
  assert.deepEqual(calls, ['startOwnedPriceRefresh']);
});

test('targeted request cannot join a locally pending full-portfolio check', async () => {
  const reply = deferred<OwnedPriceResponse>(); let starts = 0;
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', transport: mockTransport(() => { starts++; return reply.promise; }), onSavedDataChanged() {} });
  const pending = driver.start();
  await assert.rejects(driver.refreshGift(giftAddress), /still finishing/);
  assert.equal(starts, 1); reply.resolve(saved({ state: 'complete' })); await pending;
});

test('invalid NFT or missing wallet rejects locally without provider calls', async () => {
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', transport: mockTransport(assert.fail), onSavedDataChanged() {} });
  await assert.rejects(driver.refreshGift('opaque-id'), /verified TON mainnet/);
  const disconnected = new OwnedPriceRefreshDriver({ sessionId: 'opening', transport: mockTransport(assert.fail), onSavedDataChanged() {} });
  await assert.rejects(disconnected.refreshGift(giftAddress), /verified TON mainnet/);
});

test('backend busy response remains actionable and never starts or steps an unrelated saved run', async () => {
  const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport((name, input) => {
      calls.push({ name, input });
      if (name === 'startOwnedPriceRefresh') throw Object.assign(new Error('secret provider body'), { code: 'OWNED_PRICE_BUSY' });
      return { run: null, server_time: 0, next_allowed_at: 0 };
    }), onSavedDataChanged: assert.fail });
  await driver.refreshGift(giftAddress);
  assert.deepEqual(calls, [{ name: 'startOwnedPriceRefresh', input: { session_id: 'gift-session', nft_address: giftAddress } },
    { name: 'getOwnedPriceRefresh', input: { session_id: 'gift-session' } }]);
  assert.equal(driver.getSnapshot().run, null); assert.equal(driver.getSnapshot().phase, 'unavailable');
  assert.match(driver.getSnapshot().error ?? '', /still finishing/);
  assert.ok(!ownedPriceStatusText(driver.getSnapshot()).includes('secret'));
});

test('storage-full gift refresh names the recovery problem without leaking backend details or retrying', async () => {
  const calls: OwnedPriceEndpoint[] = [];
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening',
    transport: mockTransport(name => {
      calls.push(name);
      if (name === 'startOwnedPriceRefresh') throw Object.assign(new Error('private database SQL and credentials'), { code: 'STORAGE_FULL' });
      return { run: null, server_time: 0, next_allowed_at: 0 };
    }), onSavedDataChanged: assert.fail });
  await driver.start();
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.match(driver.getSnapshot().error ?? '', /app storage is full/);
  assert.ok(!ownedPriceStatusText(driver.getSnapshot()).includes('private database'));
  assert.equal(driver.getSnapshot().phase, 'unavailable');
});

test('capacity protection directs gift refresh to Status cleanup without repeating a mutation', async () => {
  const calls: OwnedPriceEndpoint[] = [];
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening',
    transport: mockTransport(name => {
      calls.push(name);
      if (name === 'startOwnedPriceRefresh') throw Object.assign(new Error('private database SQL and credentials'), { code: 'STORAGE_CAPACITY_PAUSED' });
      return { run: null, server_time: 0, next_allowed_at: 0 };
    }), onSavedDataChanged: assert.fail });
  await driver.start();
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.match(driver.getSnapshot().error ?? '', /Clean up storage from Status/);
  assert.equal((driver.getSnapshot().error ?? '').includes('private database'), false);
  assert.equal(driver.getSnapshot().phase, 'unavailable');
});

test('targeted Start rejects another scope, target, wallet or same-gift session before issuing a Step', async () => {
  for (const response of [saved(), giftSaved({ nft_address: otherGiftAddress }), giftSaved({ wallet: otherWalletAddress }), giftSaved({ session_id: 'another-session' })]) {
    const calls: OwnedPriceEndpoint[] = [];
    const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
      transport: mockTransport(name => { calls.push(name); return response; }), onSavedDataChanged: assert.fail });
    await driver.refreshGift(giftAddress);
    assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
    assert.equal(driver.getSnapshot().run, null); assert.equal(driver.getSnapshot().phase, 'unavailable');
    assert.match(driver.getSnapshot().error ?? '', /no longer matches/);
  }
});

test('full-portfolio Start never adopts a targeted run', async () => {
  const calls: OwnedPriceEndpoint[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', transport: mockTransport(name => { calls.push(name); return giftSaved(); }), onSavedDataChanged: assert.fail });
  await driver.start(); assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.equal(driver.getSnapshot().run, null); assert.equal(driver.getSnapshot().phase, 'unavailable');
});

test('every targeted Step validates scope and immutable session before accepting saved observations', async () => {
  for (const fields of [{ scope: 'portfolio', nft_address: null }, { nft_address: otherGiftAddress }, { wallet: otherWalletAddress }, { session_id: 'another-session' }, { id: 18 }]) {
    const calls: OwnedPriceEndpoint[] = [];
    const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
      transport: mockTransport(name => {
        calls.push(name); return name === 'stepOwnedPriceRefresh' ? giftSaved({ ...fields, state: 'complete', checked: 1, updated: 1 } as Partial<OwnedPriceRun>) : giftSaved();
      }), onSavedDataChanged: assert.fail });
    await driver.refreshGift(giftAddress);
    assert.deepEqual(calls, ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'getOwnedPriceRefresh']);
    assert.equal(driver.getSnapshot().run?.checked, 0); assert.equal(driver.getSnapshot().phase, 'unavailable');
    assert.match(driver.getSnapshot().error ?? '', /no longer matches/);
  }
});

test('uncertain targeted Start reconciles only its exact session and rejects another session for the same gift', async () => {
  for (const session of ['gift-session', 'another-session']) {
    const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = []; let reloads = 0;
    const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
      transport: mockTransport((name, input) => {
        calls.push({ name, input }); if (name === 'startOwnedPriceRefresh') throw new Error('untrusted sensitive detail');
        return giftSaved({ session_id: session, state: 'complete', checked: 1, updated: 1 });
      }), onSavedDataChanged: () => { reloads++; } });
    await driver.refreshGift(giftAddress);
    assert.deepEqual(calls.map(row => row.name), ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
    assert.deepEqual(calls[1].input, { session_id: 'gift-session' });
    assert.equal(driver.getSnapshot().phase, session === 'gift-session' ? 'complete' : 'unavailable');
    assert.equal(reloads, session === 'gift-session' ? 1 : 0);
  }
});

test('hiding a targeted pending step preserves committed observations and reconciles only its original session', async () => {
  const reply = deferred<OwnedPriceResponse>(), stepping = deferred<void>(); const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport((name, input) => {
      calls.push({ name, input }); if (name === 'startOwnedPriceRefresh') return giftSaved();
      if (name === 'stepOwnedPriceRefresh') { stepping.resolve(); return reply.promise; }
      return giftSaved({ state: 'complete', checked: 1, updated: 1 });
    }), onSavedDataChanged: () => { reloads++; } });
  const pending = driver.refreshGift(giftAddress); await stepping.promise; driver.interrupt();
  assert.equal(driver.getSnapshot().canRefresh, false);
  reply.resolve(giftSaved({ state: 'complete', checked: 1, updated: 1 })); await pending; await driver.start();
  assert.deepEqual(calls.map(row => row.name), ['startOwnedPriceRefresh', 'stepOwnedPriceRefresh', 'getOwnedPriceRefresh']);
  assert.deepEqual(calls[2].input, { session_id: 'gift-session' });
  assert.equal(driver.getSnapshot().phase, 'complete'); assert.equal(reloads, 1);
});

test('explicit Stop recovers an ambiguously committed targeted Start and stops its exact saved run once', async () => {
  const start = deferred<OwnedPriceResponse>(), stop = deferred<OwnedPriceResponse>(), stopping = deferred<void>();
  const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, accountGeneration: 0, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport((name, input) => {
      calls.push({ name, input });
      if (name === 'startOwnedPriceRefresh') return start.promise;
      if (name === 'getOwnedPriceRefresh') return giftSaved({ account_generation: 0 });
      assert.equal(name, 'stopOwnedPriceRefresh'); stopping.resolve(); return stop.promise;
    }), onSavedDataChanged: assert.fail });
  const running = driver.refreshGift(giftAddress); await driver.stop();
  start.reject(new Error('Start may have committed')); await stopping.promise;
  assert.equal(driver.getSnapshot().canRefresh, false);
  const repeatedStop = driver.stop();
  stop.resolve(giftSaved({ account_generation: 0, state: 'partial', reason: 'stopped_by_you' })); await Promise.all([running, repeatedStop]);
  assert.deepEqual(calls, [
    { name: 'startOwnedPriceRefresh', input: { session_id: 'gift-session', nft_address: giftAddress } },
    { name: 'getOwnedPriceRefresh', input: { session_id: 'gift-session' } },
    { name: 'stopOwnedPriceRefresh', input: { run_id: 17, account_generation: 0 } },
  ]);
  assert.equal(driver.getSnapshot().phase, 'partial'); assert.equal(driver.getSnapshot().error, null);
  assert.equal(driver.getSnapshot().run?.state, 'partial'); assert.equal(driver.getSnapshot().canRefresh, true);
});

test('hiding an ambiguous targeted Start reconciles its commit without sending an explicit Stop', async () => {
  const start = deferred<OwnedPriceResponse>(); const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport((name, input) => {
      calls.push({ name, input });
      if (name === 'startOwnedPriceRefresh') return start.promise;
      assert.equal(name, 'getOwnedPriceRefresh'); return giftSaved();
    }), onSavedDataChanged: assert.fail });
  const running = driver.refreshGift(giftAddress); driver.interrupt();
  start.reject(new Error('Start may have committed')); await running; await driver.start();
  assert.deepEqual(calls, [
    { name: 'startOwnedPriceRefresh', input: { session_id: 'gift-session', nft_address: giftAddress } },
    { name: 'getOwnedPriceRefresh', input: { session_id: 'gift-session' } },
  ]);
  assert.equal(driver.getSnapshot().run?.state, 'running');
});

test('wallet changes discard a pending targeted Start without adopting, stepping or reconciling the old identity', async () => {
  const reply = deferred<OwnedPriceResponse>(); const calls: OwnedPriceEndpoint[] = []; let reloads = 0;
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport(name => { calls.push(name); return reply.promise; }), onSavedDataChanged: () => { reloads++; } });
  const pending = driver.refreshGift(giftAddress); driver.setContext(otherWalletAddress);
  assert.equal(driver.getSnapshot().phase, 'idle'); assert.equal(driver.getSnapshot().canRefresh, false);
  await assert.rejects(driver.refreshGift(giftAddress), /still finishing/);
  reply.resolve(giftSaved({ state: 'complete', checked: 1, updated: 1 })); await pending;
  assert.deepEqual(calls, ['startOwnedPriceRefresh']); assert.equal(reloads, 0);
  assert.equal(driver.getSnapshot().run, null); assert.equal(driver.getSnapshot().canRefresh, true);
});

test('same-wallet account incarnation changes discard late Step and block replay from the old generation', async () => {
  const reply = deferred<OwnedPriceResponse>(), stepping = deferred<void>(); const calls: { name: OwnedPriceEndpoint; input: Record<string, unknown> }[] = [];
  const driver = new OwnedPriceRefreshDriver({ wallet: walletAddress, accountGeneration: 0, sessionId: 'opening', createSessionId: () => 'gift-session',
    transport: mockTransport((name, input) => {
      calls.push({ name, input }); if (name === 'startOwnedPriceRefresh') return giftSaved({ account_generation: 0 });
      stepping.resolve(); return reply.promise;
    }), onSavedDataChanged: assert.fail });
  const pending = driver.refreshGift(giftAddress); await stepping.promise; driver.setContext(walletAddress, 2);
  reply.resolve(giftSaved({ account_generation: 0, state: 'complete', checked: 1, updated: 1 })); await pending;
  assert.deepEqual(calls, [{ name: 'startOwnedPriceRefresh', input: { session_id: 'gift-session', nft_address: giftAddress } },
    { name: 'stepOwnedPriceRefresh', input: { run_id: 17, account_generation: 0 } }]);
  assert.equal(driver.getSnapshot().phase, 'idle'); assert.equal(driver.getSnapshot().run, null);
});

test('wallet checksum aliases keep the same ownership fence while an actual context change requires explicit refresh', async () => {
  const calls: OwnedPriceEndpoint[] = [];
  const friendlyWallet = 'UQAREREREREREREREREREREREREREREREREREREREREREbvW';
  const rawWallet = `0:${'11'.repeat(32)}`;
  const driver = new OwnedPriceRefreshDriver({ wallet: rawWallet, sessionId: 'opening', transport: mockTransport(name => { calls.push(name); return saved({ wallet: rawWallet, state: 'complete' }); }), onSavedDataChanged() {} });
  await driver.start(); driver.setContext(friendlyWallet); assert.equal(driver.getSnapshot().phase, 'complete');
  driver.setContext(otherWalletAddress); await driver.start();
  assert.deepEqual(calls, ['startOwnedPriceRefresh']); assert.equal(driver.getSnapshot().phase, 'idle');
});
