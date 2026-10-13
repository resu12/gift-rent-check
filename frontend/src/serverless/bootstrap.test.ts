import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForTelegramSdk, waitForTelegramSdkScript, type TelegramSdkReadiness } from '../bootstrap.ts';

function readiness({ available = false, finished = false } = {}) {
  let loaded: (() => void) | undefined, failed: (() => void) | undefined, timeout: (() => void) | undefined;
  let listening = false, timed = false;
  const environment: TelegramSdkReadiness = {
    available: () => available,
    pageFinished: () => finished,
    listen(onLoad, onError) {
      loaded = onLoad; failed = onError; listening = true;
      return () => { listening = false; };
    },
    timeout(onTimeout) { timed = true; timeout = onTimeout; return () => { timed = false; }; },
  };
  return { environment, setAvailable() { available = true; }, load: () => loaded?.(), fail: () => failed?.(),
    documentReady() { finished = true; loaded?.(); }, timeout: () => timeout?.(),
    active: () => ({ listening, timed }) };
}

test('an SDK loaded before the entry module needs no listeners or timeout', async () => {
  const state = readiness({ available: true });
  await waitForTelegramSdk(state.environment);
  assert.deepEqual(state.active(), { listening: false, timed: false });
});

test('the async SDK must load before app transport initialization may continue', async () => {
  const state = readiness();
  let continued = false;
  const result = waitForTelegramSdk(state.environment).then(() => { continued = true; });
  await Promise.resolve();
  assert.equal(continued, false);
  state.setAvailable(); state.load();
  await result;
  assert.equal(continued, true);
  assert.deepEqual(state.active(), { listening: false, timed: false });
});

test('page completion reconciles a cached load event missed by the entry module', async () => {
  const state = readiness();
  const result = waitForTelegramSdk(state.environment);
  state.setAvailable(); state.documentReady();
  await result;
  assert.deepEqual(state.active(), { listening: false, timed: false });
});

function browserReadiness({ available = false, finished = false, scriptPresent = true } = {}) {
  const page = new EventTarget(), script = scriptPresent ? new EventTarget() : null;
  let timer: (() => void) | undefined;
  return {
    page, script,
    wait: () => waitForTelegramSdkScript({
      page, script, available: () => available, pageFinished: () => finished,
      timeout(callback) { timer = callback; return () => { timer = undefined; }; },
    }),
    parsed() { page.dispatchEvent(new Event('DOMContentLoaded')); },
    sdkLoaded() { available = true; script?.dispatchEvent(new Event('load')); },
    sdkFailed() { script?.dispatchEvent(new Event('error')); },
    pageLoaded() { finished = true; page.dispatchEvent(new Event('load')); },
    timeout() { timer?.(); },
    timerPending: () => timer !== undefined,
  };
}

test('DOMContentLoaded cannot fail or finish startup while the async SDK is still downloading', async () => {
  const browser = browserReadiness();
  let settled = false;
  const pending = browser.wait().finally(() => { settled = true; });
  browser.parsed();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(browser.timerPending(), true);
  browser.sdkLoaded();
  await pending;
  assert.equal(settled, true);
  assert.equal(browser.timerPending(), false);
});

test('the browser gate handles cached SDK success, cached failure, and a missing script', async () => {
  const success = browserReadiness({ available: true });
  await success.wait();
  assert.equal(success.timerPending(), false);
  for (const options of [{ finished: true }, { scriptPresent: false }]) {
    const failure = browserReadiness(options);
    await assert.rejects(failure.wait(), /Telegram could not load/);
    assert.equal(failure.timerPending(), false);
  }
  // The script error happened before the module listened. window.load is the
  // reliable completion signal when document.readyState is not complete yet.
  const missedError = browserReadiness();
  missedError.sdkFailed();
  const pending = assert.rejects(missedError.wait(), /Telegram could not load/);
  missedError.parsed();
  assert.equal(missedError.timerPending(), true);
  missedError.pageLoaded();
  await pending;
  assert.equal(missedError.timerPending(), false);
});

test('async script errors and downloads that never finish release the readiness timer', async () => {
  for (const fail of ['sdkFailed', 'timeout'] as const) {
    const browser = browserReadiness();
    const pending = assert.rejects(browser.wait(), /Telegram could not load/);
    browser.parsed(); browser[fail]();
    await pending;
    assert.equal(browser.timerPending(), false);
    browser.sdkLoaded(); browser.pageLoaded(); // Cannot revive the failed startup.
  }
});

test('script errors, missing SDK after page load, and stalled download fail instead of mounting without a bridge', async () => {
  for (const trigger of ['fail', 'documentReady', 'timeout'] as const) {
    const state = readiness();
    const failure = assert.rejects(waitForTelegramSdk(state.environment), /Telegram could not load/);
    state[trigger](); await failure;
    state.setAvailable(); state.load(); // A late success cannot mount after failure.
    assert.deepEqual(state.active(), { listening: false, timed: false });
  }
  const completed = readiness({ finished: true });
  await assert.rejects(waitForTelegramSdk(completed.environment), /Telegram could not load/);
  assert.deepEqual(completed.active(), { listening: false, timed: false });
});

test('an event delivered while subscribing releases the newly returned listener', async () => {
  let available = false, removed = false, timed = false;
  await waitForTelegramSdk({
    available: () => available, pageFinished: () => false,
    listen(loaded) { available = true; loaded(); return () => { removed = true; }; },
    timeout() { timed = true; return () => undefined; },
  });
  assert.equal(removed, true);
  assert.equal(timed, false);
});
