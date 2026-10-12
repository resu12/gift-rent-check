import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnedPriceRefreshDriver } from './ownedPriceRefresh.ts';
import type { OwnedPriceEndpoint, OwnedPriceTransport } from './ownedPriceRefresh.ts';

test('the driver retains targeted scope when Start fails before any run is returned', async () => {
  const calls: OwnedPriceEndpoint[] = [];
  const transport: OwnedPriceTransport = { async call<T>(endpoint: OwnedPriceEndpoint) {
    calls.push(endpoint);
    if (endpoint === 'startOwnedPriceRefresh') throw { code: 'STORAGE_FULL' };
    return { run: null, server_time: 0, next_allowed_at: 0 } as T;
  } };
  const driver = new OwnedPriceRefreshDriver({ transport, sessionId: 'opening', createSessionId: () => 'one-gift',
    wallet: `0:${'f'.repeat(64)}`, onSavedDataChanged() {} });
  await driver.refreshGift(`0:${'1'.repeat(64)}`);
  assert.equal(driver.getSnapshot().scope, 'gift');
  assert.equal(driver.getSnapshot().run, null); assert.equal(driver.getSnapshot().phase, 'unavailable');
  assert.deepEqual(calls, ['startOwnedPriceRefresh', 'getOwnedPriceRefresh']);
});

test('the driver identifies a failed automatic portfolio Start even without a run', async () => {
  const transport: OwnedPriceTransport = { async call<T>(endpoint: OwnedPriceEndpoint) {
    if (endpoint === 'startOwnedPriceRefresh') throw { code: 'STORAGE_FULL' };
    return { run: null, server_time: 0, next_allowed_at: 0 } as T;
  } };
  const driver = new OwnedPriceRefreshDriver({ transport, sessionId: 'opening', onSavedDataChanged() {} });
  await driver.start();
  assert.equal(driver.getSnapshot().scope, 'portfolio'); assert.equal(driver.getSnapshot().run, null);
  assert.equal(driver.getSnapshot().phase, 'unavailable');
});
