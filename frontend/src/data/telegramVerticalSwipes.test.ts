import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramBridge } from './telegram.ts';

type WebApp = NonNullable<NonNullable<Window['Telegram']>['WebApp']>;
function withBridge(app: WebApp | undefined, check: () => void) {
  const previous = globalThis.window;
  try {
    globalThis.window = { Telegram: { WebApp: app } } as unknown as Window & typeof globalThis;
    check();
  } finally { globalThis.window = previous; }
}
function fixture(enabled = true) {
  const calls: string[] = [];
  const app: WebApp = {
    isVerticalSwipesEnabled: enabled,
    isVersionAtLeast(version) { calls.push(`version:${version}`); return version === '7.7'; },
    disableVerticalSwipes() { assert.equal(this, app); calls.push('disable'); this.isVerticalSwipesEnabled = false; },
    enableVerticalSwipes() { assert.equal(this, app); calls.push('enable'); this.isVerticalSwipesEnabled = true; },
  };
  return { app, calls };
}

test('native Telegram minimization swipes are restored after the app gesture is removed', () => {
  const { app, calls } = fixture();
  withBridge(app, () => {
    const release = telegramBridge.reserveVerticalSwipes();
    assert.equal(app.isVerticalSwipesEnabled, false);
    assert.deepEqual(calls, ['version:7.7', 'disable']);
    release(); release();
    assert.equal(app.isVerticalSwipesEnabled, true);
    assert.deepEqual(calls, ['version:7.7', 'disable', 'enable']);
  });
});

test('a pre-existing disabled-swipe preference is never enabled by gesture cleanup', () => {
  const { app, calls } = fixture(false);
  withBridge(app, () => {
    const first = telegramBridge.reserveVerticalSwipes(), second = telegramBridge.reserveVerticalSwipes();
    first(); second();
    assert.equal(app.isVerticalSwipesEnabled, false);
    assert.equal(calls.includes('disable'), false); assert.equal(calls.includes('enable'), false);
  });
});

test('overlapping gesture owners restore native swipes only after the final release', () => {
  const { app, calls } = fixture();
  withBridge(app, () => {
    const first = telegramBridge.reserveVerticalSwipes(), second = telegramBridge.reserveVerticalSwipes();
    first(); first();
    assert.equal(app.isVerticalSwipesEnabled, false); assert.deepEqual(calls, ['version:7.7', 'disable']);
    second(); second();
    assert.equal(app.isVerticalSwipesEnabled, true); assert.deepEqual(calls, ['version:7.7', 'disable', 'enable']);
  });
});

test('StrictMode cleanup and immediate remount acquire a fresh native swipe lease', () => {
  const { app, calls } = fixture();
  withBridge(app, () => {
    const first = telegramBridge.reserveVerticalSwipes(); first();
    const second = telegramBridge.reserveVerticalSwipes();
    assert.equal(app.isVerticalSwipesEnabled, false);
    first(); assert.equal(app.isVerticalSwipesEnabled, false);
    second(); assert.equal(app.isVerticalSwipesEnabled, true);
    assert.deepEqual(calls, ['version:7.7', 'disable', 'enable', 'version:7.7', 'disable', 'enable']);
  });
});

test('unavailable, unsupported and incomplete Telegram bridges do not change swipe behavior', () => {
  for (const change of [
    { isVersionAtLeast: () => false }, { isVersionAtLeast: undefined }, { isVerticalSwipesEnabled: undefined },
    { disableVerticalSwipes: undefined }, { enableVerticalSwipes: undefined },
  ]) {
    const { app, calls } = fixture(); Object.assign(app, change);
    withBridge(app, () => { const release = telegramBridge.reserveVerticalSwipes(); release(); release(); });
    assert.equal(calls.includes('disable'), false); assert.equal(calls.includes('enable'), false);
  }
  withBridge(undefined, () => { telegramBridge.reserveVerticalSwipes()(); });
});

test('SDK failures do not escape gesture setup or cleanup and permit a later successful lease', () => {
  const { app, calls } = fixture();
  withBridge(app, () => {
    const supported = app.isVersionAtLeast!, disable = app.disableVerticalSwipes!, enable = app.enableVerticalSwipes!;
    app.isVersionAtLeast = () => { throw new Error('Unsupported'); };
    telegramBridge.reserveVerticalSwipes()(); assert.equal(app.isVerticalSwipesEnabled, true);
    app.isVersionAtLeast = supported;
    app.disableVerticalSwipes = () => { throw new Error('Unavailable'); };
    telegramBridge.reserveVerticalSwipes()(); assert.equal(app.isVerticalSwipesEnabled, true);
    app.disableVerticalSwipes = disable;
    app.enableVerticalSwipes = () => { throw new Error('Detached'); };
    const release = telegramBridge.reserveVerticalSwipes(); release(); release();
    app.enableVerticalSwipes = enable; app.isVerticalSwipesEnabled = true;
    telegramBridge.reserveVerticalSwipes()(); assert.equal(app.isVerticalSwipesEnabled, true);
    assert.equal(calls.filter(call => call === 'disable').length, 2);
    assert.equal(calls.filter(call => call === 'enable').length, 1);
  });
});

test('replacing a Telegram bridge restores each original bridge independently', () => {
  const first = fixture(), second = fixture();
  withBridge(first.app, () => {
    const releaseFirst = telegramBridge.reserveVerticalSwipes();
    globalThis.window.Telegram!.WebApp = second.app;
    const releaseSecond = telegramBridge.reserveVerticalSwipes();
    releaseFirst();
    assert.equal(first.app.isVerticalSwipesEnabled, true); assert.equal(second.app.isVerticalSwipesEnabled, false);
    releaseSecond(); assert.equal(second.app.isVerticalSwipesEnabled, true);
  });
});
