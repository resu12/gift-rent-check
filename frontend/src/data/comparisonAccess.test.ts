import test from 'node:test';
import assert from 'node:assert/strict';
import { canCollectComparisons, publicComparisonBlocker } from './comparisonAccess.ts';
import type { Capabilities, Dashboard, Gift } from './types.ts';

const capabilities: Capabilities = { public_account: true, network_enabled: true, marketapp_configured: true,
  wallet_configured: true, ton_configured: false, csrf_token: '' };
const gift = { is_portfolio: true, collection_address: 'collection' } as Gift;
const data = (changes: Partial<Capabilities> = {}, gifts = [gift]): Pick<Dashboard, 'capabilities' | 'gifts'> => ({ capabilities: { ...capabilities, ...changes }, gifts });

test('public wallet disconnect disables comparison starts and resumes despite retained gifts and API key', () => {
  assert.equal(canCollectComparisons(data(), true), true);
  const disconnected = data({ wallet_configured: false });
  assert.equal(disconnected.gifts.length, 1);
  assert.equal(disconnected.capabilities.marketapp_configured, true);
  assert.equal(canCollectComparisons(disconnected, true), false);
  const blocker = publicComparisonBlocker(disconnected.capabilities);
  assert.deepEqual(blocker, { message: 'Reconnect your wallet in account settings to update comparisons.', setup: true, actionLabel: 'Reconnect wallet' });
  assert.equal(canCollectComparisons(data(), true), true, 'server-confirmed reconnection permits comparisons again');
  assert.equal(publicComparisonBlocker(data().capabilities), null);
});

test('public comparison setup explains missing key without asking users to configure a private backend', () => {
  const noKey = data({ marketapp_configured: false });
  assert.equal(canCollectComparisons(noKey, true), false);
  assert.deepEqual(publicComparisonBlocker(noKey.capabilities), {
    message: 'Add your Marketapp API key in account settings to update comparisons.', setup: true, actionLabel: 'Open account settings',
  });
  assert.equal(publicComparisonBlocker(data({ network_enabled: false }).capabilities)?.setup, false);
});

test('private Telegram membership and desktop wallet configuration retain their existing access rules', () => {
  const privateDashboard = data({ public_account: false, wallet_configured: false });
  assert.equal(canCollectComparisons(privateDashboard, true), true);
  assert.equal(publicComparisonBlocker(privateDashboard.capabilities), null);
  assert.equal(canCollectComparisons(privateDashboard, false), false);
  assert.equal(canCollectComparisons(data({ public_account: false }, []), false), true);
  assert.equal(canCollectComparisons(data(), true, true), false);
  assert.equal(canCollectComparisons(data({ network_enabled: false }), true), false);
  assert.equal(canCollectComparisons(data({}, []), true), false);
  assert.equal(canCollectComparisons(data({}, [{ ...gift, is_portfolio: false }]), true), false);
  assert.equal(canCollectComparisons(data({}, [{ ...gift, collection_address: null }]), true), false);
  assert.equal(canCollectComparisons(undefined, true), false);
});
