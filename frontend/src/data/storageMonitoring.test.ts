import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageMaintenanceController, presentStorage, readStorageStatus, storageNeedsStep } from './storageMonitoring.ts';
import type { StorageMaintenanceAdapter, StorageStatus } from './storageMonitoring.ts';

const start = Date.parse('2026-10-11T15:00:00.000Z'), at = (delta = 0) => new Date(start + delta).toISOString();
function status(change: Partial<StorageStatus> = {}): StorageStatus {
  return { version: 1, scope: 'app', status: 'healthy', estimated_bytes: 1000000, budget_bytes: 5000000,
    checked_at: at(), inventory_complete: true, cleanup: { state: 'idle', last_completed_at: null,
      reclaimed_bytes: 0, estimated_reclaimable_bytes: null }, can_cleanup: true, next_step_at: at(6 * 3600000), ...change };
}
const pending = () => status({ status: 'unknown', inventory_complete: false, estimated_bytes: null, checked_at: null, next_step_at: at(5000) });
async function settle() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
function clock() {
  let now = start, next = 0;
  const timers = new Map<number, { callback: () => void; due: number }>();
  return { now: () => now, timer(callback: () => void, ms: number) {
    const id = ++next; timers.set(id, { callback, due: now + ms }); return id as unknown as ReturnType<typeof setTimeout>;
  }, clear(handle: ReturnType<typeof setTimeout>) { timers.delete(handle as unknown as number); },
  async advance(ms: number) {
    now += ms;
    for (const [id, entry] of [...timers]) if (entry.due <= now && timers.has(id)) {
      timers.delete(id); entry.callback(); await settle();
    }
  }, count: () => timers.size };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

test('storage metadata rejects unsafe or incomplete shapes and cannot claim healthy on a partial inventory', () => {
  assert.equal(readStorageStatus(status()).status, 'healthy');
  assert.equal(readStorageStatus(status({ scope: 'account', budget_bytes: null })).scope, 'account');
  for (const invalid of [null, [], {}, status({ inventory_complete: false }), status({ checked_at: null }),
    { ...status(), unexpected: 'private data' }, status({ estimated_bytes: -1 }), status({ budget_bytes: 0 }),
    status({ checked_at: '2026-02-30T12:00:00.000Z' }), status({ next_step_at: 'private cookie' }),
    { ...status(), cleanup: { ...status().cleanup, reclaimed_bytes: 0.5 } },
    { ...status(), cleanup: { ...status().cleanup, provider_token: 'private token' } }])
    assert.throws(() => readStorageStatus(invalid), /^Error: Storage status could not be confirmed\.$/);
});

test('private account pressure remains actionable without an app budget or shared usage', () => {
  const own = readStorageStatus(status({scope:'account',status:'warning',estimated_bytes:7500000,budget_bytes:null,
    cleanup:{state:'needed',last_completed_at:null,reclaimed_bytes:0,estimated_reclaimable_bytes:null},next_step_at:at(2500)}));
  assert.equal(storageNeedsStep(own),true);
  const view=presentStorage({status:own,phase:'settled',busy:false,error:null,bounded:false},start);
  assert.equal(view.label,'Storage nearly full');assert.equal(view.progressPercent,null);assert.equal(view.tone,'warning');
});

test('healthy status is one lightweight startup read with no maintenance mutation or future cooldown polling', async () => {
  const fake = clock(), calls: string[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); return status(); }, async step() { calls.push('step'); return status(); },
  } });
  controller.context('owner'); assert.deepEqual(calls, []);
  await fake.advance(1500); assert.deepEqual(calls, ['get']);
  await fake.advance(12 * 3600000); assert.deepEqual(calls, ['get']);
  assert.equal(controller.getSnapshot().busy, false); assert.equal(fake.count(), 0);
  assert.equal(storageNeedsStep(status()), false);
  controller.dispose();
});

test('incomplete inventory continues in paced serialized steps and preserves a backend cooldown', async () => {
  const fake = clock(), calls: { name: string; time: number }[] = [];
  let first = true;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push({ name: 'get', time: fake.now() }); return pending(); },
    async step() {
      calls.push({ name: 'step', time: fake.now() });
      if (first) { first = false; return { ...pending(), next_step_at: new Date(fake.now() + 10000).toISOString() }; }
      return status();
    },
  } });
  controller.context('owner'); await fake.advance(1500);
  await fake.advance(2499); assert.equal(calls.length, 1);
  await fake.advance(1001); assert.equal(calls.length, 2);
  await fake.advance(9999); assert.equal(calls.length, 2);
  await fake.advance(1); assert.equal(calls.length, 3);
  assert.equal(controller.getSnapshot().status!.inventory_complete, true); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('hide and provider activity stop scheduled mutations; returning visible resumes the saved maintenance cursor', async () => {
  const fake = clock(), calls: string[] = []; let hidden = false;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => hidden, adapter: {
    async get() { calls.push('get'); return pending(); }, async step() { calls.push('step'); return status(); },
  } });
  controller.context('owner'); controller.providerBusy(true); await fake.advance(1500);
  assert.deepEqual(calls, []); await fake.advance(10000); assert.deepEqual(calls, []);
  controller.providerBusy(false); hidden = true; controller.visibilityChanged();
  assert.equal(fake.count(), 0); await fake.advance(10000); assert.deepEqual(calls, []);
  hidden = false; controller.visibilityChanged(); await fake.advance(2500);
  assert.deepEqual(calls, ['get']); await fake.advance(2500);
  assert.deepEqual(calls, ['get', 'step']); controller.dispose();
});

test('initial automatic storage status waits for provider idle, even across repeated busy pulses', async () => {
  const fake = clock(), calls: string[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); return status(); }, async step() { calls.push('step'); return status(); },
  } });
  controller.providerBusy(true); controller.context('owner'); await fake.advance(60000);
  controller.visibilityChanged(); controller.providerBusy(true); await fake.advance(60000);
  assert.deepEqual(calls, []); assert.equal(fake.count(), 0);
  controller.providerBusy(false); await fake.advance(1499); assert.deepEqual(calls, []);
  await fake.advance(1); assert.deepEqual(calls, ['get']); assert.equal(controller.getSnapshot().status?.status, 'healthy');
  controller.dispose();
});

test('explicit saved-status check remains available during provider work without starting cleanup', async () => {
  const fake = clock(), calls: string[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); return pending(); }, async step() { calls.push('step'); return status(); },
  } });
  controller.context('owner'); controller.providerBusy(true); await controller.checkNow();
  assert.deepEqual(calls, ['get']); assert.equal(controller.getSnapshot().status?.inventory_complete, false);
  await fake.advance(60000); await controller.cleanNow(); assert.deepEqual(calls, ['get']);
  controller.providerBusy(false); await fake.advance(1500); assert.deepEqual(calls, ['get', 'get']);
  await fake.advance(2500); assert.deepEqual(calls, ['get', 'get', 'step']); controller.dispose();
});

test('a scheduled pressure-status read pauses if provider work starts again before its deadline', async () => {
  const fake = clock(); let reads = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { reads++; return status(); }, async step() { return status(); },
  } });
  controller.context('owner'); await fake.advance(1500); assert.equal(reads, 1);
  controller.providerBusy(true); controller.providerBusy(false); await fake.advance(1000); controller.providerBusy(true);
  await fake.advance(10000); assert.equal(reads, 1);
  controller.providerBusy(false); await fake.advance(1500); assert.equal(reads, 2); controller.dispose();
});

test('a settled provider action refreshes cheap counters once so new pressure cannot leave the card green', async () => {
  const fake = clock(), calls: string[] = []; let pressured = false;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); return status({ status: pressured ? 'paused' : 'healthy', next_step_at: at(6 * 3600000) }); },
    async step() { calls.push('step'); return status(); },
  } });
  controller.context('owner'); await fake.advance(1500);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).tone, 'fresh');
  controller.providerBusy(true); pressured = true; controller.providerBusy(false); controller.providerBusy(false);
  await fake.advance(1500); assert.deepEqual(calls, ['get', 'get']);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).tone, 'critical');
  await fake.advance(300000); assert.deepEqual(calls, ['get', 'get'], 'future maintenance cooldown does not trigger rapid calls');
  controller.dispose();
});

test('manual clicks share one pending mutation and hiding never cancels an in-flight maintenance write', async () => {
  const fake = clock(), waiting = deferred<StorageStatus>(), calls: boolean[] = []; let hidden = false;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => hidden, adapter: {
    async get() { return status(); }, async step(manual) { calls.push(manual === true); return waiting.promise; },
  } });
  controller.context('owner'); await fake.advance(1500);
  const action = controller.cleanNow(); await controller.cleanNow();
  assert.deepEqual(calls, [true]); assert.equal(controller.getSnapshot().busy, true);
  hidden = true; controller.visibilityChanged(); waiting.resolve(status()); await action;
  assert.equal(controller.getSnapshot().status!.status, 'healthy'); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('uncertain mutation is reconciled once with a read and is never repeated automatically', async () => {
  const fake = clock(), calls: string[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); return pending(); }, async step() { calls.push('step'); throw new Error('private SQL cookie'); },
  } });
  controller.context('owner'); await fake.advance(1500); await fake.advance(3500);
  assert.deepEqual(calls, ['get', 'step', 'get']); assert.equal(controller.getSnapshot().phase, 'error');
  assert.equal(controller.getSnapshot().error!.includes('private'), false);
  await fake.advance(100000); controller.visibilityChanged(); await fake.advance(100000);
  assert.deepEqual(calls, ['get', 'step', 'get']); controller.dispose();
});

test('late results cannot restore a previous account or publish after disposal', async () => {
  const fake = clock(), old = deferred<StorageStatus>(); let reads = 0;
  const adapter: StorageMaintenanceAdapter = { async get() { return ++reads === 1 ? old.promise : status({ scope: 'account', budget_bytes: null }); }, async step() { return status(); } };
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter });
  controller.context('owner'); await fake.advance(1500); controller.context('invited');
  old.resolve(status()); await settle(); assert.equal(controller.getSnapshot().status, null);
  await fake.advance(1500); assert.equal(controller.getSnapshot().status!.scope, 'account');
  const after = controller.getSnapshot(); controller.dispose(); await controller.cleanNow();
  assert.equal(controller.getSnapshot(), after); assert.equal(fake.count(), 0);
});

test('automatic maintenance has a fixed opening budget and a manual action starts foreground continuation', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, maxAutomaticSteps: 2, isHidden: () => false, adapter: {
    async get() { return pending(); }, async step() { steps += 1; return { ...pending(), next_step_at: new Date(fake.now()).toISOString() }; },
  } });
  controller.context('owner'); await fake.advance(1500); await fake.advance(3500); await fake.advance(2500);
  assert.equal(steps, 2); assert.equal(controller.getSnapshot().bounded, true); assert.equal(fake.count(), 0);
  await fake.advance(100000); assert.equal(steps, 2);
  await controller.cleanNow(); assert.equal(steps, 3); assert.equal(controller.getSnapshot().bounded, false);
  controller.dispose();
});

test('long server waits do not generate repeated endpoint calls before they become due', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return { ...pending(), next_step_at: at(6 * 3600000) }; }, async step() { steps++; return status(); },
  } });
  controller.context('owner'); await fake.advance(1500); await fake.advance(300000); await fake.advance(300000);
  assert.equal(steps, 0); await fake.advance(6 * 3600000); assert.equal(steps, 1);
  controller.dispose();
});

test('presentation distinguishes capacity pressure from unknown, stale and incomplete measurements', () => {
  const snapshot = { status: status(), phase: 'settled' as const, busy: false, error: null, bounded: false };
  assert.equal(presentStorage(snapshot, start).tone, 'fresh'); assert.equal(presentStorage(snapshot, start).progressPercent, 20);
  assert.equal(presentStorage(snapshot, start + 6 * 3600000).tone, 'warning');
  assert.equal(presentStorage({ ...snapshot, status: pending() }, start).progressPercent, null);
  assert.equal(presentStorage({ ...snapshot, status: pending() }, start).tone, 'warning');
  assert.equal(presentStorage({ ...snapshot, status: status({ status: 'paused', inventory_complete: false }) }, start).tone, 'critical');
  assert.equal(presentStorage({ ...snapshot, phase: 'cleaning', busy: true, status: status({ status: 'paused' }) }, start).tone, 'critical');
  assert.equal(presentStorage({ ...snapshot, status: status({ status: 'warning' }) }, start).label, 'Storage nearly full');
  assert.equal(presentStorage({ ...snapshot, status: status({ scope: 'account', budget_bytes: null }) }, start).progressPercent, null);
  assert.equal(presentStorage({ ...snapshot, status: status({ checked_at: at(60000) }) }, start).tone, 'warning');
  assert.equal(presentStorage({ ...snapshot, error: 'safe error' }, start).label, 'Check unavailable');
  assert.equal(presentStorage({ ...snapshot, status: status({ cleanup: { ...status().cleanup, state: 'blocked' } }) }, start).label, 'Cleanup paused');
});

const runningCleanup = (nextStep = at(5000), change: Partial<StorageStatus> = {}) => status({
  status: 'cleaning', cleanup: { ...status().cleanup, state: 'running' }, next_step_at: nextStep, ...change,
});

test('cleanup action stays cleaning and disabled across chunk requests and cooldown gaps until completion', async () => {
  const fake = clock(), first = deferred<StorageStatus>(), second = deferred<StorageStatus>();
  const calls: boolean[] = [], views: { actionLabel: string; actionDisabled: boolean }[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return status(); }, async step(manual) {
      calls.push(manual === true); return calls.length === 1 ? first.promise : second.promise;
    },
  } });
  controller.context('owner'); await fake.advance(1500);
  const unsubscribe = controller.subscribe(() => views.push(presentStorage(controller.getSnapshot(), fake.now())));
  const manual = controller.cleanNow();
  first.resolve(runningCleanup()); await manual;
  assert.equal(controller.getSnapshot().busy, false, 'the HTTP request ended, but the cleanup run has not');
  assert.equal(controller.getSnapshot().continuation, 'scheduled');
  await controller.cleanNow(); assert.deepEqual(calls, [true], 'a repeated tap between chunks must not create another request');
  await fake.advance(3499); assert.deepEqual(calls, [true]);
  await fake.advance(1); assert.deepEqual(calls, [true, false]);
  assert.equal(controller.getSnapshot().busy, true);
  for (const view of views) {
    assert.equal(view.actionLabel, 'Cleaning…'); assert.equal(view.actionDisabled, true);
  }
  second.resolve(status({ cleanup: { ...status().cleanup, state: 'complete', last_completed_at: at(5000) } }));
  await settle();
  const finished = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(finished.actionLabel, 'Clean up now'); assert.equal(finished.actionDisabled, false);
  assert.equal(finished.label, 'Healthy'); assert.equal(finished.active, false); assert.equal(fake.count(), 0);
  unsubscribe(); controller.dispose();
});

test('a startup cleanup remains continuous but exposes Continue cleanup at the bounded limit', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, maxAutomaticSteps: 2, isHidden: () => false, adapter: {
    async get() { return runningCleanup(); }, async step() {
      steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString());
    },
  } });
  controller.context('owner'); await fake.advance(1500);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Cleaning…');
  await controller.cleanNow(); assert.equal(steps, 0, 'an active cooldown is not a new manual batch');
  await fake.advance(3500); assert.equal(steps, 1);
  await controller.cleanNow(); assert.equal(steps, 1, 'repeated taps cannot reset the automatic step limit');
  await fake.advance(2500); assert.equal(steps, 2);
  assert.equal(controller.getSnapshot().bounded, true); assert.equal(fake.count(), 0);
  const bounded = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(bounded.label, 'Cleanup paused'); assert.equal(bounded.actionLabel, 'Continue cleanup');
  assert.equal(bounded.active, false); assert.equal(bounded.actionDisabled, false);
  await controller.cleanNow(); assert.equal(steps, 3);
  assert.equal(controller.getSnapshot().bounded, false);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Cleaning…');
  controller.dispose();
});

test('uncertain cleanup with a saved running cursor offers retry without an automatic mutation', async () => {
  const fake = clock(), calls: string[] = []; let initial = true;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); if (initial) { initial = false; return status(); } return runningCleanup(); },
    async step() { calls.push('step'); throw new Error('uncertain write'); },
  } });
  controller.context('owner'); await fake.advance(1500); await controller.cleanNow();
  assert.equal(controller.getSnapshot().status!.cleanup.state, 'running');
  const failed = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(failed.label, 'Check unavailable'); assert.equal(failed.actionLabel, 'Try again');
  assert.equal(failed.active, false); assert.equal(failed.actionDisabled, false);
  controller.providerBusy(true); controller.providerBusy(false); controller.visibilityChanged();
  await fake.advance(100000);
  assert.deepEqual(calls, ['get', 'step', 'get']); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('provider and hidden-page pauses expose saved cleanup without claiming active work, then resume', async () => {
  const fake = clock(), calls: string[] = []; let hidden = false;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => hidden, adapter: {
    async get() { calls.push('get'); return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
    async step() { calls.push('step'); return status(); },
  } });
  controller.context('owner'); await fake.advance(1500);
  controller.providerBusy(true);
  let view = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(controller.getSnapshot().continuation, 'waiting'); assert.equal(view.label, 'Cleanup paused');
  assert.equal(view.actionLabel, 'Waiting…'); assert.equal(view.active, false);
  assert.equal(view.actionDisabled, true); assert.equal(controller.getSnapshot().pauseReason, 'provider');
  await controller.cleanNow(); assert.deepEqual(calls, ['get'], 'manual cleanup also waits for active provider work');
  await fake.advance(10000); assert.deepEqual(calls, ['get']);
  controller.providerBusy(false); hidden = true; controller.visibilityChanged();
  assert.equal(controller.getSnapshot().continuation, 'waiting'); assert.equal(fake.count(), 0);
  assert.equal(controller.getSnapshot().pauseReason, 'hidden');
  await fake.advance(10000); assert.deepEqual(calls, ['get']);
  hidden = false; controller.visibilityChanged();
  view = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(view.actionLabel, 'Cleaning…'); assert.equal(view.actionDisabled, true);
  await fake.advance(0); assert.deepEqual(calls, ['get', 'step'], 'a due running cursor resumes without another sliding status read');
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Clean up now');
  controller.dispose();
});

test('cleanup permission loss does not display a perpetual active spinner', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return runningCleanup(at(5000), { can_cleanup: false }); },
    async step() { steps++; return status(); },
  } });
  controller.context('owner'); await fake.advance(1500);
  const view = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(view.active, false); assert.equal(view.actionDisabled, true);
  assert.equal(view.label, 'Cleanup paused'); assert.notEqual(view.actionLabel, 'Cleaning…');
  await fake.advance(100000); assert.equal(steps, 0); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('context changes clear a cleanup lifecycle and discard an old account continuation', async () => {
  const fake = clock(), first = deferred<StorageStatus>(); let reads = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { reads++; return reads === 1 ? status() : status({ scope: 'account', budget_bytes: null }); },
    async step() { return first.promise; },
  } });
  controller.context('owner'); await fake.advance(1500); const manual = controller.cleanNow();
  controller.context('invited');
  assert.equal(controller.getSnapshot().status, null); assert.equal(controller.getSnapshot().continuation, null);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).active, false);
  first.resolve(runningCleanup()); await manual;
  assert.equal(controller.getSnapshot().status, null, 'late owner status cannot revive a cleanup in the new account');
  await fake.advance(1500);
  assert.equal(controller.getSnapshot().status!.scope, 'account');
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Clean up now');
  controller.dispose();
});

test('completed cleanup waiting for a future pressure recheck does not lock the manual cleanup action', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return status({ status: 'warning', cleanup: { ...status().cleanup, state: 'complete', last_completed_at: at() } }); },
    async step() { steps++; return status(); },
  } });
  controller.context('owner'); await fake.advance(1500);
  const view = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(view.label, 'Storage nearly full'); assert.equal(view.active, false);
  assert.equal(view.actionLabel, 'Clean up now'); assert.equal(view.actionDisabled, false);
  await controller.cleanNow(); assert.equal(steps, 1);
  controller.dispose();
});

test('a blocked cleanup offers explicit continuation and sends no automatic retry under pressure', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return status({ status: 'warning', next_step_at: at(5000),
      cleanup: { ...status().cleanup, state: 'blocked' } }); },
    async step() { steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
  } });
  controller.context('owner'); await fake.advance(1500);
  const view = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(view.label, 'Cleanup paused'); assert.equal(view.actionLabel, 'Continue cleanup');
  assert.equal(view.active, false); assert.equal(view.actionDisabled, false); assert.equal(fake.count(), 0);
  await fake.advance(100000); assert.equal(steps, 0);
  await controller.cleanNow(); assert.equal(steps, 1);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Cleaning…');
  controller.dispose();
});

test('frequent provider pulses cannot starve known cleanup or bypass its automatic step budget', async () => {
  const fake = clock(); let reads = 0, steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { reads++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
    async step() { steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
  } });
  controller.context('owner'); await fake.advance(1500);
  for (let index = 0; index < 100; index++) {
    controller.providerBusy(true);
    const before = steps; await fake.advance(750); assert.equal(steps, before, 'cleanup never runs while provider work is active');
    controller.providerBusy(false); await fake.advance(750);
  }
  assert.equal(reads, 1, 'the next cleanup step already reconciles the running cursor');
  assert.equal(steps, 24, 'cleanup advances despite short idle windows and retains its opening limit');
  assert.equal(controller.getSnapshot().bounded, true); assert.equal(fake.count(), 0);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Continue cleanup');
  controller.dispose();
});

test('visibility pulses preserve cleanup pacing instead of restarting a fresh local cooldown', async () => {
  const fake = clock(); let hidden = false, reads = 0, steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => hidden, adapter: {
    async get() { reads++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
    async step() { steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
  } });
  controller.context('owner'); await fake.advance(1500);
  for (let index = 0; index < 12; index++) {
    hidden = true; controller.visibilityChanged();
    const before = steps; await fake.advance(750); assert.equal(steps, before, 'hidden pages do not advance cleanup');
    hidden = false; controller.visibilityChanged(); await fake.advance(750);
  }
  assert.equal(reads, 1); assert.equal(steps, 6);
  controller.dispose();
});

test('provider pauses preserve future server lease deadlines and honor a later deadline from the next response', async () => {
  const fake = clock(), mutations: number[] = []; let reads = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { reads++; return runningCleanup(at(12000)); },
    async step() { mutations.push(fake.now()); return mutations.length === 1 ? runningCleanup(at(40000)) : status(); },
  } });
  controller.context('owner'); await fake.advance(1500);
  for (let index = 0; index < 10; index++) {
    controller.providerBusy(true); controller.providerBusy(false); await fake.advance(1000);
  }
  assert.deepEqual(mutations, []); await fake.advance(499); assert.deepEqual(mutations, []);
  await fake.advance(1); assert.deepEqual(mutations, [start + 12000]);
  controller.providerBusy(true); await fake.advance(20000); assert.equal(mutations.length, 1);
  controller.providerBusy(false); await fake.advance(7999); assert.equal(mutations.length, 1);
  await fake.advance(1); assert.deepEqual(mutations, [start + 12000, start + 40000]);
  assert.equal(reads, 1); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('an immediately due server cursor still respects the original local pacing floor across pauses', async () => {
  const fake = clock(), mutations: number[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return runningCleanup(at()); },
    async step() { mutations.push(fake.now()); return status(); },
  } });
  controller.context('owner'); await fake.advance(1500); await fake.advance(2499);
  controller.providerBusy(true); controller.providerBusy(false);
  assert.deepEqual(mutations, []); await fake.advance(1);
  assert.deepEqual(mutations, [start + 4000], 'a pause neither skips nor restarts the 2.5-second minimum');
  controller.dispose();
});

test('manual cleanup continues beyond 24 requests and ends its cycle even when storage pressure remains', async () => {
  const fake = clock(), calls: boolean[] = [];
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return status(); }, async step(manual) {
      calls.push(manual === true);
      return calls.length === 40
        ? status({ status: 'warning', cleanup: { ...status().cleanup, state: 'complete', last_completed_at: new Date(fake.now()).toISOString() } })
        : runningCleanup(new Date(fake.now() + 2500).toISOString());
    },
  } });
  controller.context('owner'); await fake.advance(1500); await controller.cleanNow();
  for (let index = 1; index < 40; index++) {
    assert.equal(controller.getSnapshot().bounded, false);
    await fake.advance(2500);
  }
  assert.equal(calls.length, 40); assert.equal(calls[0], true); assert.equal(calls.slice(1).every(manual => !manual), true);
  const view = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(view.label, 'Storage nearly full'); assert.equal(view.actionLabel, 'Clean up now');
  assert.equal(view.actionDisabled, false); assert.equal(fake.count(), 0);
  await fake.advance(7 * 3600000); assert.equal(calls.length, 40, 'the foreground action must not start a second cleanup cycle');
  controller.dispose();
});

test('manual cleanup retains a generous request safeguard and requires another explicit action at that bound', async () => {
  const fake = clock(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, maxAutomaticSteps: 2, maxManualSteps: 4, isHidden: () => false, adapter: {
    async get() { return runningCleanup(); }, async step() { steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
  } });
  controller.context('owner'); await fake.advance(1500); await fake.advance(3500); await fake.advance(2500);
  assert.equal(steps, 2); assert.equal(controller.getSnapshot().pauseReason, 'automatic_limit');
  await controller.cleanNow();
  for (let index = 0; index < 3; index++) await fake.advance(2500);
  assert.equal(steps, 6); assert.equal(controller.getSnapshot().bounded, true);
  assert.equal(controller.getSnapshot().pauseReason, 'manual_limit'); assert.equal(fake.count(), 0);
  await fake.advance(100000); assert.equal(steps, 6);
  await controller.cleanNow(); assert.equal(steps, 7); assert.equal(controller.getSnapshot().bounded, false);
  controller.dispose();
});

test('foreground cleanup budget excludes time hidden or waiting for other updates', async () => {
  const fake = clock(); let hidden = false, steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, maxManualActiveMs: 8000, isHidden: () => hidden, adapter: {
    async get() { return status(); }, async step() { steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString()); },
  } });
  controller.context('owner'); await fake.advance(1500); await controller.cleanNow(); await fake.advance(2500);
  hidden = true; controller.visibilityChanged(); await fake.advance(3600000);
  assert.equal(steps, 2); assert.equal(controller.getSnapshot().pauseReason, 'hidden');
  hidden = false; controller.visibilityChanged(); await fake.advance(0); assert.equal(steps, 3);
  controller.providerBusy(true); await fake.advance(3600000);
  assert.equal(steps, 3); assert.equal(controller.getSnapshot().pauseReason, 'provider');
  controller.providerBusy(false); await fake.advance(0); assert.equal(steps, 4);
  await fake.advance(2500); assert.equal(steps, 5);
  await fake.advance(2500); assert.equal(steps, 6);
  await fake.advance(2500); assert.equal(steps, 6, 'a delayed callback checks active time before sending another request');
  assert.equal(controller.getSnapshot().pauseReason, 'manual_limit'); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('switching accounts clears foreground authorization and restores the smaller automatic budget', async () => {
  const fake = clock(); let firstAccount = true, steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, maxAutomaticSteps: 2, isHidden: () => false, adapter: {
    async get() { return firstAccount ? status() : runningCleanup(new Date(fake.now() + 2500).toISOString(), { scope: 'account', budget_bytes: null }); },
    async step() { steps++; return runningCleanup(new Date(fake.now() + 2500).toISOString(), firstAccount ? {} : { scope: 'account', budget_bytes: null }); },
  } });
  controller.context('owner'); await fake.advance(1500); await controller.cleanNow();
  firstAccount = false; controller.context('invited'); await fake.advance(1500);
  await fake.advance(2500); await fake.advance(2500);
  assert.equal(steps, 3); assert.equal(controller.getSnapshot().pauseReason, 'automatic_limit');
  assert.equal(controller.getSnapshot().status!.scope, 'account'); assert.equal(fake.count(), 0);
  controller.dispose();
});

test('provider activity consistently disables cleanup for healthy, needed, blocked and completed storage', async t => {
  for (const state of ['idle', 'needed', 'blocked', 'complete'] as const) await t.test(state, async () => {
    const fake = clock(), calls: string[] = [];
    const saved = status({ cleanup: { ...status().cleanup, state,
      last_completed_at: state === 'complete' ? at() : null } });
    const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
      async get() { calls.push('get'); return saved; },
      async step() { calls.push('step'); return status({ cleanup: { ...status().cleanup, state: 'complete', last_completed_at: at() } }); },
    } });
    controller.context('owner'); await fake.advance(1500);
    controller.providerBusy(true);
    const waiting = controller.getSnapshot(), view = presentStorage(waiting, fake.now());
    assert.equal(waiting.providerBusy, true);
    assert.equal(view.actionLabel, 'Waiting…'); assert.equal(view.actionDisabled, true);
    assert.equal(view.waitingForProvider, true); assert.equal(view.active, false);
    assert.equal(waiting.status!.cleanup.state, state, 'provider activity must not replace saved cleanup state');
    await controller.cleanNow(); await fake.advance(10000);
    assert.deepEqual(calls, ['get'], 'waiting must not start or queue a cleanup request');
    controller.providerBusy(false); await fake.advance(1500);
    assert.deepEqual(calls, ['get', 'get'], 'a settled provider refreshes storage counters without starting a new cleanup');
    assert.equal(Boolean(controller.getSnapshot().providerBusy), false);
    assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionDisabled, false);
    await controller.cleanNow(); assert.deepEqual(calls, ['get', 'get', 'step']);
    controller.dispose();
  });
});

test('provider waiting preserves an uncertain-request error and requires an explicit retry after settling', async () => {
  const fake = clock(), calls: string[] = []; let fail = true, initial = true;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { calls.push('get'); if (initial) { initial = false; return status(); } return runningCleanup(); },
    async step() {
      calls.push('step'); if (fail) throw new Error('uncertain response');
      return status({ cleanup: { ...status().cleanup, state: 'complete', last_completed_at: at() } });
    },
  } });
  controller.context('owner'); await fake.advance(1500); await controller.cleanNow();
  const error = controller.getSnapshot().error; assert.ok(error);
  controller.providerBusy(true);
  const waiting = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(waiting.actionLabel, 'Waiting…'); assert.equal(waiting.actionDisabled, true);
  assert.equal(waiting.waitingForProvider, true); assert.equal(controller.getSnapshot().pauseReason, 'request_error');
  assert.equal(controller.getSnapshot().error, error);
  await controller.cleanNow(); await fake.advance(10000);
  controller.providerBusy(false); await fake.advance(100000);
  assert.deepEqual(calls, ['get', 'step', 'get'], 'provider completion cannot retry an uncertain cleanup mutation');
  assert.equal(controller.getSnapshot().error, error); assert.equal(controller.getSnapshot().pauseReason, 'request_error');
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Try again');
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionDisabled, false);
  fail = false; await controller.cleanNow(); assert.deepEqual(calls, ['get', 'step', 'get', 'step']);
  assert.equal(controller.getSnapshot().error, null); controller.dispose();
});

test('provider waiting keeps automatic and manual limits intact until the user explicitly continues', async t => {
  for (const mode of ['automatic', 'manual'] as const) await t.test(mode, async () => {
    const fake = clock(), calls: string[] = []; let steps = 0;
    const controller = createStorageMaintenanceController({ ...fake, maxAutomaticSteps: 1, maxManualSteps: 1,
      isHidden: () => false, adapter: {
        async get() { calls.push('get'); return mode === 'manual' ? status() : runningCleanup(); },
        async step() {
          calls.push('step'); steps++;
          return steps === 1 ? runningCleanup(new Date(fake.now() + 2500).toISOString())
            : status({ cleanup: { ...status().cleanup, state: 'complete', last_completed_at: at() } });
        },
      } });
    controller.context('owner'); await fake.advance(1500);
    if (mode === 'manual') await controller.cleanNow(); else await fake.advance(3500);
    const reason = `${mode}_limit`; assert.equal(controller.getSnapshot().pauseReason, reason);
    controller.providerBusy(true);
    assert.equal(controller.getSnapshot().providerBusy, true); assert.equal(controller.getSnapshot().bounded, true);
    assert.equal(controller.getSnapshot().pauseReason, reason, 'temporary provider activity must retain the exhausted limit');
    const waiting = presentStorage(controller.getSnapshot(), fake.now());
    assert.equal(waiting.actionLabel, 'Waiting…'); assert.equal(waiting.actionDisabled, true);
    assert.equal(waiting.waitingForProvider, true);
    await controller.cleanNow(); await fake.advance(10000); assert.equal(steps, 1);
    controller.providerBusy(false); await fake.advance(100000);
    assert.deepEqual(calls, ['get', 'step']); assert.equal(controller.getSnapshot().bounded, true);
    assert.equal(controller.getSnapshot().pauseReason, reason);
    const ready = presentStorage(controller.getSnapshot(), fake.now());
    assert.equal(ready.actionLabel, 'Continue cleanup'); assert.equal(ready.actionDisabled, false);
    await controller.cleanNow(); assert.equal(steps, 2); assert.equal(controller.getSnapshot().bounded, false);
    assert.equal(controller.getSnapshot().status!.cleanup.state, 'complete'); controller.dispose();
  });
});

test('provider activity does not relabel an already pending cleanup request as waiting', async () => {
  const fake = clock(), write = deferred<StorageStatus>(); let steps = 0;
  const controller = createStorageMaintenanceController({ ...fake, isHidden: () => false, adapter: {
    async get() { return status(); }, async step() { steps++; return write.promise; },
  } });
  controller.context('owner'); await fake.advance(1500);
  const action = controller.cleanNow(); controller.providerBusy(true);
  const active = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(controller.getSnapshot().providerBusy, true); assert.equal(active.active, true);
  assert.equal(active.actionLabel, 'Cleaning…'); assert.equal(active.actionDisabled, true);
  assert.equal(active.waitingForProvider, false);
  await controller.cleanNow(); assert.equal(steps, 1);
  write.resolve(status({ cleanup: { ...status().cleanup, state: 'complete', last_completed_at: at() } }));
  await action;
  const completed = presentStorage(controller.getSnapshot(), fake.now());
  assert.equal(completed.actionLabel, 'Waiting…'); assert.equal(completed.actionDisabled, true);
  assert.equal(controller.getSnapshot().status!.cleanup.state, 'complete');
  controller.providerBusy(false); await fake.advance(1500);
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionLabel, 'Clean up now');
  assert.equal(presentStorage(controller.getSnapshot(), fake.now()).actionDisabled, false);
  assert.equal(steps, 1, 'a manual click ignored during provider activity is not replayed later'); controller.dispose();
});
