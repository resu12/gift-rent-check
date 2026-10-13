import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedPriceReloadScheduler, createOwnedPriceStartupGate, OwnedPriceRefreshDriver } from './ownedPriceRefresh.ts';
import type { OwnedPriceResponse, OwnedPriceEndpoint, OwnedPriceSavedUpdate } from './ownedPriceRefresh.ts';
import { createDashboardPoller } from './dashboardPolling.ts';
import type { Dashboard, Job } from './types.ts';

async function settle() { for (let index = 0; index < 14; index++) await Promise.resolve(); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function setup(reload?: () => Promise<void>) {
  let calls = 0, hidden = false, clock = 0, nextTimer = 0;
  const timers = new Map<number, { callback: () => void; due: number }>();
  const scheduler = createOwnedPriceReloadScheduler({ reload: async () => { calls++; await reload?.(); }, isHidden: () => hidden,
    timer(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: clock + delay }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear(id) { timers.delete(id as unknown as number); },
  });
  return { scheduler, timers, get calls() { return calls; }, hide(value: boolean) { hidden = value; if (value) scheduler.pause(); },
    async advance(ms: number) { clock += ms; for (const [id, entry] of [...timers]) if (entry.due <= clock && timers.has(id)) { timers.delete(id); entry.callback(); await settle(); } } };
}
const response = (state: 'running' | 'complete', cache_hit = false): OwnedPriceResponse => ({
  run: { id: 1, state, total: 3, checked: 3, updated: 3, unresolved: 0, status_updated: 3, reason: null,
    started_at: '2026-10-13T12:00:00Z', completed_at: state === 'complete' ? '2026-10-13T12:01:00Z' : null },
  server_time: 1000, next_allowed_at: 0, cache_hit,
});

test('multiple intermediate commits share one deferred reload instead of rebuilding the dashboard per page', async () => {
  const h = setup(); for (let index = 0; index < 20; index++) h.scheduler.notify({ terminal: false });
  assert.equal(h.calls, 0); assert.equal(h.timers.size, 1); await h.advance(3999); assert.equal(h.calls, 0);
  await h.advance(1); assert.equal(h.calls, 1); assert.equal(h.timers.size, 0); await h.advance(100000); assert.equal(h.calls, 1);
});

test('terminal evidence cancels deferred work and manual flush awaits the confirming read', async () => {
  const pending = deferred(), h = setup(() => pending.promise);
  h.scheduler.notify({ terminal: false }); h.scheduler.notify({ terminal: true }); await settle();
  assert.equal(h.calls, 1); assert.equal(h.timers.size, 0);
  let finished = false; const confirmation = h.scheduler.flush().then(() => { finished = true; });
  await settle(); assert.equal(finished, false); pending.resolve(); await confirmation; assert.equal(finished, true);
  await h.advance(100000); assert.equal(h.calls, 1);
});

test('commits arriving during a slow read create one serialized trailing read, including terminal confirmation', async () => {
  const first = deferred(), second = deferred(); let reads = 0, active = 0, maximum = 0;
  const h = setup(async () => { active++; maximum = Math.max(maximum, active); await (++reads === 1 ? first.promise : second.promise); active--; });
  h.scheduler.notify({ terminal: true }); await settle();
  for (let index = 0; index < 10; index++) h.scheduler.notify({ terminal: false }); h.scheduler.notify({ terminal: true });
  let confirmed = false; const confirmation = h.scheduler.flush().then(() => { confirmed = true; });
  assert.equal(h.calls, 1); first.resolve(); await settle(); assert.equal(h.calls, 2); assert.equal(confirmed, false);
  second.resolve(); await confirmation; assert.equal(confirmed, true); assert.equal(h.calls, 2); assert.equal(maximum, 1); assert.equal(h.timers.size, 0);
});

test('terminal gift evidence reloads promptly while the independent jobs read is still pending', async () => {
  let resolveJobs!: (jobs: Job[]) => void;
  const pendingJobs = new Promise<Job[]>(resolve => { resolveJobs = resolve; });
  let dashboardReads = 0, jobReads = 0, tokenReads = 0;
  let revision = 'initial', displayed = '';
  const poller = createDashboardPoller({
    async getDashboard() { dashboardReads++; return { generated_at: revision, update_token: 'unchanged' } as Dashboard; },
    async getUpdateToken() { tokenReads++; return 'unchanged'; },
    getJobs() { jobReads++; return pendingJobs; },
    async startJob() { throw new Error('not used'); },
    async resumeJob() { throw new Error('not used'); },
    async stopJob() { throw new Error('not used'); },
    exportUrl() { return ''; },
  }, { source: 'rentals', timeframe: '30d' }, {
    dashboard(data) { displayed = data.generated_at; }, jobs() {}, loading() {}, error() {},
  }, { setTimer: () => () => {}, isVisible: () => true });
  const initial = poller.reload(); await settle();
  const h = setup(() => poller.reloadDashboard());
  try {
    revision = 'intermediate gift commit'; h.scheduler.notify({ terminal: false }); await h.advance(4000);
    assert.equal(displayed, revision); assert.equal(dashboardReads, 2);
    revision = 'final gift commit'; h.scheduler.notify({ terminal: true }); await h.scheduler.flush();
    assert.equal(displayed, revision); assert.equal(dashboardReads, 3);
    assert.equal(jobReads, 1, 'gift commits do not queue extra collection-progress requests');
    assert.equal(tokenReads, 0, 'every committed gift update forces a full dashboard read');
  } finally {
    h.scheduler.dispose(); resolveJobs([]); await initial; poller.dispose();
  }
});

test('scope change cancels deferred updates and a queued terminal follow-up from the old scope', async () => {
  const pending = deferred(), h = setup(() => pending.promise);
  h.scheduler.notify({ terminal: false }); h.scheduler.cancel(); await h.advance(100000); assert.equal(h.calls, 0);
  h.scheduler.notify({ terminal: true }); await settle(); h.scheduler.notify({ terminal: true }); h.scheduler.cancel();
  pending.resolve(); await settle(); assert.equal(h.calls, 1); assert.equal(h.timers.size, 0);
  h.scheduler.notify({ terminal: false }); await h.advance(4000); assert.equal(h.calls, 2);
});

test('hiding cancels the timer and defers committed evidence until a visible saved-data flush', async () => {
  const h = setup(); h.scheduler.notify({ terminal: false }); h.hide(true); h.scheduler.notify({ terminal: true });
  await h.advance(100000); await h.scheduler.flush(); assert.equal(h.calls, 0); assert.equal(h.timers.size, 0);
  h.hide(false); await h.scheduler.flush(); assert.equal(h.calls, 1);
});

test('disposing a page drops pending and late notifications without another read', async () => {
  const h = setup(); h.scheduler.notify({ terminal: false }); h.scheduler.dispose(); h.scheduler.notify({ terminal: true });
  await h.advance(100000); await h.scheduler.flush(); assert.equal(h.calls, 0); assert.equal(h.timers.size, 0);
});

test('a failed saved-data read is not automatically retried by the scheduler', async () => {
  const h = setup(async () => { throw new Error('synthetic read failure'); });
  h.scheduler.notify({ terminal: true }); await settle(); await h.advance(100000); assert.equal(h.calls, 1);
  await h.scheduler.flush(); assert.equal(h.calls, 1);
});

test('server cache reuse updates the gift check view without a data reload notification', async () => {
  let signals = 0; const calls: OwnedPriceEndpoint[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', onSavedDataChanged() { signals++; },
    transport: { async call<T>(endpoint: OwnedPriceEndpoint) { calls.push(endpoint); return response('complete', true) as T; } } });
  await driver.start(); await driver.start(); assert.equal(signals, 0); assert.equal(driver.getSnapshot().phase, 'complete');
  assert.equal(driver.getSnapshot().cacheHit, true); assert.deepEqual(calls, ['startOwnedPriceRefresh']);
});

test('supplementary terminal evidence flushes even when website check counts have not changed', async () => {
  const signals: OwnedPriceSavedUpdate[] = [];
  const driver = new OwnedPriceRefreshDriver({ sessionId: 'opening', onSavedDataChanged(update) { signals.push(update!); },
    transport: { async call<T>(endpoint: OwnedPriceEndpoint) { return response(endpoint === 'startOwnedPriceRefresh' ? 'running' : 'complete') as T; } } });
  await driver.start(); assert.deepEqual(signals, [{ terminal: false }, { terminal: true }]);
});

test('manual actions can use authorized preview data without automatically refreshing that preview', async () => {
  let automatic = 0, manual = 0, hidden = false;
  const gate = createOwnedPriceStartupGate({ start: async () => { automatic++; }, interrupt() {} }, () => hidden);
  gate.dashboardLoaded(false); assert.equal(automatic, 0);
  await gate.manualRefresh(async () => { manual++; }); assert.equal(manual, 0);
  await gate.manualRefresh(async () => { manual++; }, true); assert.equal(manual, 1);
  gate.dashboardLoaded(true); assert.equal(automatic, 0, 'an explicit action consumes this opening’s automatic start');
  hidden = true; await gate.manualRefresh(async () => { manual++; }, true); assert.equal(manual, 1);
  hidden = false; gate.dispose(); await gate.manualRefresh(async () => { manual++; }, true); assert.equal(manual, 1);
});
