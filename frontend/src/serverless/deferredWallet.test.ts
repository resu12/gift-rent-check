import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleWalletWarmup, type WalletWarmupEnvironment } from './deferredWallet.ts';

function warmup(hidden = false) {
  let timer: (() => void) | undefined, idle: (() => void) | undefined, visibility: (() => void) | undefined;
  let calls = 0;
  const environment: WalletWarmupEnvironment = {
    hidden: () => hidden,
    visibilityChanged(callback) { visibility = callback; return () => { visibility = undefined; }; },
    timer(callback, delay) { assert.equal(delay, 2000); timer = callback; return () => { timer = undefined; }; },
    idle(callback) { idle = callback; return () => { idle = undefined; }; },
  };
  const cancel = scheduleWalletWarmup(() => { calls++; }, environment);
  return { cancel, count: () => calls, active: () => ({ timer: Boolean(timer), idle: Boolean(idle), visibility: Boolean(visibility) }),
    wait() { const callback = timer; timer = undefined; callback?.(); },
    idle() { const callback = idle; idle = undefined; callback?.(); },
    visible(value: boolean) { hidden = !value; visibility?.(); } };
}

test('wallet SDK warms only after the first-view grace and an idle opportunity', () => {
  const state = warmup();
  assert.equal(state.count(), 0);
  state.wait();
  assert.equal(state.count(), 0);
  assert.equal(state.active().idle, true);
  state.idle();
  assert.equal(state.count(), 1);
  state.visible(true); state.wait(); state.idle();
  assert.equal(state.count(), 1);
  assert.deepEqual(state.active(), { timer: false, idle: false, visibility: false });
});

test('explicit wallet interaction or unmount cancels pending optional work', () => {
  for (const afterDelay of [false, true]) {
    const state = warmup();
    if (afterDelay) state.wait();
    state.cancel(); state.wait(); state.idle();
    assert.equal(state.count(), 0);
    assert.deepEqual(state.active(), { timer: false, idle: false, visibility: false });
  }
});

test('a hidden preload waits for visibility and hiding cancels an idle download', () => {
  const state = warmup(true);
  assert.deepEqual(state.active(), { timer: false, idle: false, visibility: true });
  state.visible(true); state.wait();
  assert.equal(state.active().idle, true);
  state.visible(false); state.idle();
  assert.equal(state.count(), 0);
  state.visible(true); state.wait(); state.idle();
  assert.equal(state.count(), 1);
});
