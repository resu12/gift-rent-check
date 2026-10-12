import test from 'node:test';
import assert from 'node:assert/strict';
import type { Dashboard, Gift } from './types.ts';
import { giftSelectionContext, selectedDashboardGift } from './giftSelection.ts';

const wallet = `0:${'a'.repeat(64)}`;
function dashboard(price = '0.170', generation = 0, owner = wallet): Dashboard {
  return { wallet: owner, gifts: [{ id: 'gift-a', price_per_day: price } as Gift], capabilities: { public_account: true, account_generation: generation } } as Dashboard;
}
test('open details resolve the latest observation rather than the selected object', () => {
  const initial = dashboard(), selected = { id: 'gift-a', context: giftSelectionContext(initial) };
  const fresh = dashboard('0.190');
  assert.equal(selectedDashboardGift(fresh, selected), fresh.gifts[0]);
  assert.equal(selectedDashboardGift(fresh, selected)?.price_per_day, '0.190');
});
test('reused gift IDs cannot carry a drawer across wallet or account changes', () => {
  const selected = { id: 'gift-a', context: giftSelectionContext(dashboard()) };
  assert.equal(selectedDashboardGift(dashboard('0.190', 2), selected), null);
  assert.equal(selectedDashboardGift(dashboard('0.190', 0, `0:${'b'.repeat(64)}`), selected), null);
  assert.equal(selectedDashboardGift(null, selected), null);
  assert.equal(selectedDashboardGift({ ...dashboard(), gifts: [] }, selected), null);
});
