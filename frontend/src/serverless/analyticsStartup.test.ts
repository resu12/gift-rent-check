import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsStartupStatus, createAnalyticsStartupGate, readAnalyticsStartupResult } from './analyticsStartup.ts';
import type { AnalyticsStartupContext } from './analyticsStartup.ts';
import type { MarketappAnalyticsPeriod, MarketappAnalyticsStartupResult } from '../data/types.ts';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { createCloudTransport, CloudError } from './cloudTransport.ts';
import type { CloudEndpoint } from './cloudTransport.ts';
import { createLocalDashboardAdapter } from '../data/local.ts';

const time = Date.parse('2026-10-11T12:00:00Z');
const captured = new Date(time).toISOString();
const startedAt = new Date(time + 1100).toISOString();
const context = (changes: Partial<AnalyticsStartupContext> = {}): AnalyticsStartupContext => ({
  identity: 'wallet:0:false', enabled: true, periodDays: 365, capturedAt: null, ...changes,
});
const result = (changes: Partial<MarketappAnalyticsStartupResult> = {}): MarketappAnalyticsStartupResult => ({
  state: 'saved', period_days: 365, captured_at: captured, ...changes,
});
const tick = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
function setup(refresh?: (period: MarketappAnalyticsPeriod, signal: AbortSignal) => Promise<MarketappAnalyticsStartupResult>, reload?: () => Promise<void>) {
  let hidden = false, now = time, reloads = 0, nextTimer = 0;
  const calls: { period: MarketappAnalyticsPeriod; signal: AbortSignal }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const gate = createAnalyticsStartupGate({
    refresh: async (period, signal) => { calls.push({ period, signal }); return refresh ? refresh(period, signal) : result({ period_days: period }); },
    onSavedDataChanged: async () => { reloads++; await reload?.(); }, isHidden: () => hidden, now: () => now,
    timer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear: id => { timers.delete(id as unknown as number); },
  });
  return { gate, calls, timers, get reloads() { return reloads; }, hide(value: boolean) { hidden = value; gate.visibilityChanged(); }, advance(ms: number) { now += ms; },
    start() { const entry = [...timers.entries()].find(([, value]) => value.delay === 1100); if (entry) { timers.delete(entry[0]); now += 1100; entry[1].callback(); } } };
}

test('startup waits for gift checks then refreshes once despite repeated dashboard, period and visibility updates', async () => {
  const h = setup(); h.gate.dashboardLoaded(context());
  assert.equal(h.gate.getSnapshot().phase, 'waiting'); assert.equal(h.calls.length, 0);
  h.gate.giftsChanged(false); assert.equal(h.calls.length, 0);
  h.gate.giftsChanged(true); assert.equal(h.calls.length, 0); assert.equal([...h.timers.values()][0].delay, 1100);
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); assert.equal(h.timers.size, 1);
  h.start(); assert.equal(h.calls.length, 1); assert.equal(h.gate.getSnapshot().busy, true);
  await tick(); assert.equal(h.reloads, 1); assert.equal(h.gate.getSnapshot().phase, 'saved'); assert.equal(h.gate.getSnapshot().busy, false);
  h.gate.dashboardLoaded(context({ periodDays: 30 })); h.gate.giftsChanged(true); h.hide(false); h.gate.dashboardLoaded(context());
  await tick(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].period, 365); assert.equal(h.timers.size, 0);
});

test('hidden preload defers its only attempt until visible', async () => {
  const h = setup(); h.hide(true); h.gate.dashboardLoaded(context({ periodDays: 30 })); h.gate.giftsChanged(true);
  assert.equal(h.calls.length, 0); h.hide(false); h.start(); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].period, 30); assert.equal(h.reloads, 1);
});

test('manual refresh fences startup until all manual work settles', async () => {
  const h = setup(); h.gate.manualChanged(true); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true);
  assert.equal(h.calls.length, 0); h.gate.manualChanged(false); h.start(); await tick(); assert.equal(h.calls.length, 1);
});

test('settling grace is cancelled by new gift work, manual work, hidden pages or absent dashboard data', async () => {
  for (const pause of ['gifts', 'manual', 'hidden', 'data']) {
    const h = setup(); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); assert.equal(h.timers.size, 1);
    if (pause === 'gifts') h.gate.giftsChanged(false);
    if (pause === 'manual') h.gate.manualChanged(true);
    if (pause === 'hidden') h.hide(true);
    if (pause === 'data') h.gate.dashboardLoaded(null);
    assert.equal(h.timers.size, 0); h.start(); assert.equal(h.calls.length, 0);
    if (pause === 'gifts') h.gate.giftsChanged(true);
    if (pause === 'manual') h.gate.manualChanged(false);
    if (pause === 'hidden') h.hide(false);
    if (pause === 'data') h.gate.dashboardLoaded(context());
    assert.equal(h.timers.size, 1); assert.equal(h.calls.length, 0); h.start(); await tick(); assert.equal(h.calls.length, 1);
  }
});

test('transient empty dashboard cannot start a refresh while gifts are still running and does not revoke its identity', async () => {
  const h = setup(); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(false);
  h.gate.giftsChanged(false); h.gate.dashboardLoaded(null); h.hide(false); assert.equal(h.calls.length, 0);
  h.gate.dashboardLoaded(context({ periodDays: 30 })); assert.equal(h.calls.length, 0);
  h.gate.giftsChanged(true); h.start(); await tick(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].period, 365);
});

test('disabled analytics cannot make a startup request', async () => {
  const h = setup(); h.gate.dashboardLoaded(context({ enabled: false })); h.gate.giftsChanged(true); h.hide(false);
  await tick(); assert.equal(h.calls.length, 0); assert.equal(h.gate.getSnapshot().phase, 'idle');
});

test('capacity protection directs automatic analytics to Status cleanup without retrying or claiming a saved report', async () => {
  const h = setup(async () => { throw new CloudError('STORAGE_CAPACITY_PAUSED', 'private SQL token'); });
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); await tick();
  assert.equal(h.gate.getSnapshot().storagePaused, true);
  assert.equal(h.gate.getSnapshot().phase, 'unavailable'); assert.equal(h.reloads, 0);
  assert.match(analyticsStartupStatus(h.gate.getSnapshot())!.title, /Clean up storage from Status/);
  h.hide(false); h.gate.dashboardLoaded(context()); h.start(); await tick();
  assert.equal(h.calls.length, 1); assert.equal(JSON.stringify(h.gate.getSnapshot()).includes('private SQL'), false);
});

test('changed wallet or account incarnation inhibits startup for the rest of this page', async () => {
  for (const identity of ['different-wallet:0:false', 'wallet:1:false', 'wallet:0:true']) {
    const h = setup(); h.gate.dashboardLoaded(context()); h.gate.dashboardLoaded(context({ identity })); h.gate.giftsChanged(true);
    h.gate.dashboardLoaded(context()); h.hide(false); await tick(); assert.equal(h.calls.length, 0);
  }
});

test('wallet change fences late committed replies and reload callbacks', async () => {
  const pending = deferred<MarketappAnalyticsStartupResult>(), h = setup(() => pending.promise);
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start();
  h.gate.dashboardLoaded(context({ identity: 'other-wallet:0:false' }));
  assert.equal(h.calls[0].signal.aborted, true); pending.resolve(result()); await tick();
  assert.equal(h.reloads, 0); assert.equal(h.gate.getSnapshot().phase, 'idle'); assert.equal(h.timers.size, 0);
});

test('hiding an active refresh aborts local work and never retries after returning', async () => {
  const pending = deferred<MarketappAnalyticsStartupResult>(), h = setup(() => pending.promise);
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); h.hide(true);
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.gate.getSnapshot().busy, false);
  pending.resolve(result()); await tick(); h.hide(false); h.gate.giftsChanged(true); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.reloads, 0); assert.equal(h.timers.size, 0);
});

test('busy, limited and missing-login outcomes keep saved data and never automatically retry', async () => {
  for (const response of [result({ state: 'busy', reason: 'website_busy', captured_at: undefined }),
    result({ state: 'limited', reason: 'cooldown', captured_at: undefined, retry_at: captured }),
    result({ state: 'unavailable', reason: 'no_login', captured_at: undefined })]) {
    const h = setup(async () => response); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); await tick();
    assert.equal(h.gate.getSnapshot().phase, response.state); assert.equal(h.reloads, 0);
    assert.equal(h.gate.getSnapshot().retryAt, response.retry_at);
    h.advance(86400000); h.hide(false); h.gate.dashboardLoaded(context()); h.gate.manualChanged(false); await tick();
    assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  }
});

test('fresh analytics skip reload unless another page saved a different snapshot', async () => {
  for (const previous of [captured, '2026-10-10T12:00:00Z', null]) {
    const h = setup(async () => result({ state: 'fresh' })); h.gate.dashboardLoaded(context({ capturedAt: previous })); h.gate.giftsChanged(true); h.start(); await tick();
    assert.equal(h.reloads, previous === captured ? 0 : 1); assert.equal(h.gate.getSnapshot().phase, 'fresh');
    assert.equal(h.gate.getSnapshot().outcomeAt, startedAt, 'attempt order uses this response time, not the older saved capture');
    assert.equal(h.gate.getSnapshot().reloadedAt, previous === captured ? undefined : startedAt,
      'a fresh response alone does not prove imported history was reloaded');
  }
});

test('timeout is bounded, fences ignored-abort responses and does not queue another attempt', async () => {
  const pending = deferred<MarketappAnalyticsStartupResult>(), h = setup(() => pending.promise);
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start();
  const timeout = [...h.timers.values()][0]; assert.equal(timeout.delay, 120000); timeout.callback();
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.gate.getSnapshot().phase, 'unavailable');
  pending.resolve(result()); await tick(); h.hide(false); assert.equal(h.reloads, 0); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('disposing an active page suppresses late responses and notifications', async () => {
  const pending = deferred<MarketappAnalyticsStartupResult>(), h = setup(() => pending.promise); let notifications = 0;
  h.gate.subscribe(() => notifications++); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); h.gate.dispose();
  const previous = notifications; pending.resolve(result()); await tick(); h.gate.dashboardLoaded(context()); h.hide(false);
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.reloads, 0); assert.equal(notifications, previous); assert.equal(h.timers.size, 0);
});

test('provider failures and invalid replies never expose private diagnostics', async () => {
  for (const refresh of [async () => { throw new Error('Private cookie secret'); }, async () => ({ ...result(), cookie: 'Private cookie secret' })]) {
    const h = setup(refresh); h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); await tick();
    assert.equal(h.gate.getSnapshot().reason, 'refresh_failed'); assert.equal(h.reloads, 0);
    assert.equal(JSON.stringify(h.gate.getSnapshot()).includes('Private'), false); assert.equal(h.calls.length, 1);
  }
});

test('automatic status validation rejects malformed dates, changed periods and unrecognized status material', () => {
  assert.deepEqual(readAnalyticsStartupResult(result(), 365, time), result());
  for (const invalid of [null, [], {}, result({ period_days: 30 }), result({ captured_at: '2026-02-30T12:00:00Z' }),
    result({ captured_at: new Date(time + 60000).toISOString() }), result({ state: 'fresh', captured_at: undefined }),
    result({ state: 'busy', reason: 'no_login' }), result({ state: 'limited', reason: undefined }),
    result({ reason: 'refresh_failed' }), result({ retry_at: 'Private cookie secret' }), { ...result(), cookie: 'Private cookie secret' }]) {
    assert.throws(() => readAnalyticsStartupResult(invalid, 365, time), /Unexpected analytics refresh status/);
  }
});

test('overview status remains compact and conveys the safe fallback', () => {
  assert.equal(analyticsStartupStatus({ phase: 'waiting', busy: false }), null);
  assert.equal(analyticsStartupStatus({ phase: 'updating', busy: true })?.label, 'Updating…');
  assert.equal(analyticsStartupStatus({ phase: 'saved', busy: false })?.label, 'Recently refreshed');
  assert.equal(analyticsStartupStatus({ phase: 'fresh', busy: false })?.label, 'Recently refreshed');
  assert.equal(analyticsStartupStatus({ phase: 'unavailable', busy: false, reason: 'no_login' })?.label, 'Login required');
  assert.equal(analyticsStartupStatus({ phase: 'unavailable', busy: false, reason: 'refresh_failed' })?.label, 'Saved data');
});

test('startup preserves confirmed capture while the dashboard reload is pending and after it finishes', async () => {
  const reloading = deferred<void>(), h = setup(undefined, () => reloading.promise);
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); await tick();
  assert.deepEqual(h.gate.getSnapshot(), { phase: 'saved', busy: true, periodDays: 365, capturedAt: captured, outcomeAt: startedAt });
  assert.equal(analyticsStartupStatus(h.gate.getSnapshot())?.label, 'Loading report…');
  h.advance(2000); reloading.resolve(); await tick();
  assert.deepEqual(h.gate.getSnapshot(), { phase: 'saved', busy: false, periodDays: 365, capturedAt: captured,
    outcomeAt: startedAt, reloadedAt: new Date(time + 3100).toISOString() });
  assert.equal(h.calls.length, 1);
});

test('startup reload failure preserves a confirmed saved or fresh result instead of labelling the provider refresh failed', async () => {
  for (const state of ['saved', 'fresh'] as const) {
    const h = setup(async () => result({ state }), async () => { throw new Error('Private reload error'); });
    h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); await tick();
    assert.deepEqual(h.gate.getSnapshot(), { phase: state, busy: false, periodDays: 365, capturedAt: captured, reloadFailed: true, outcomeAt: startedAt });
    assert.equal(analyticsStartupStatus(h.gate.getSnapshot())?.label, 'Reload needed');
    assert.equal(h.reloads, 1); assert.equal(h.calls.length, 1); assert.equal(JSON.stringify(h.gate.getSnapshot()).includes('Private'), false);
  }
});

test('hiding after a confirmed save retains the saved report metadata without retrying the mutation', async () => {
  const reloading = deferred<void>(), h = setup(undefined, () => reloading.promise);
  h.gate.dashboardLoaded(context()); h.gate.giftsChanged(true); h.start(); await tick(); h.hide(true);
  assert.deepEqual(h.gate.getSnapshot(), { phase: 'saved', busy: false, periodDays: 365, capturedAt: captured, reloadFailed: true, outcomeAt: startedAt });
  reloading.resolve(); await tick(); h.hide(false); assert.equal(h.calls.length, 1);
  assert.equal(h.gate.getSnapshot().reloadedAt, undefined, 'an interrupted read cannot confirm saved history');
});

test('Telegram startup adapter sends only the reporting period; desktop has no automatic endpoint', async () => {
  const calls: unknown[] = [], abort = new AbortController();
  const adapter = createCloudDashboardAdapter({ async call<T>(endpoint: CloudEndpoint, input?: Record<string, unknown>, signal?: AbortSignal) { calls.push({ endpoint, input, signal }); return result() as T; } });
  assert.deepEqual(await adapter.marketappAnalyticsRefresh!.refreshStartup!(365, abort.signal), result());
  assert.deepEqual(calls, [{ endpoint: 'refreshStartupMarketappAnalytics', input: { period_days: 365 }, signal: abort.signal }]);
  assert.equal(createLocalDashboardAdapter().marketappAnalyticsRefresh, undefined);
});

test('automatic analytics uses the bounded analytics deadline and never retries transport failures', async () => {
  let calls = 0;
  const transport = createCloudTransport({ call(_name, _input, callback) { calls++; setTimeout(() => callback(null, result()), 10); } }, 1, 100);
  assert.deepEqual(await transport.call('refreshStartupMarketappAnalytics'), result()); assert.equal(calls, 1);
  const timeout = createCloudTransport({ call() { calls++; } }, 100, 1);
  await assert.rejects(timeout.call('refreshStartupMarketappAnalytics'), (error: CloudError) => error.code === 'TIMEOUT'); assert.equal(calls, 2);
});
