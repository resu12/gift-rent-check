import test from 'node:test';
import assert from 'node:assert/strict';
import type { Gift } from './types.ts';
import type { OwnedPriceSnapshot } from './ownedPriceRefresh.ts';
import { quickGiftCheckBlocker, quickGiftCheckFeedback } from './quickGiftCheck.ts';

const nft = `0:${'1'.repeat(64)}`, collection = `0:${'2'.repeat(64)}`;
const gift = { id: nft, nft_address: nft, collection_address: collection, is_portfolio: true, category: 'portfolio', price_per_day: '0.190', price_observed_at: '2026-10-10T10:00:02Z', price_is_historical: false } as Gift;
const complete: OwnedPriceSnapshot = { phase: 'complete', canStop: false, run: { id: 1, scope: 'gift', nft_address: nft, state: 'complete', total: 1, checked: 1, updated: 1, unresolved: 0, reason: null, started_at: '2026-10-10T10:00:00Z', completed_at: '2026-10-10T10:00:03Z' } };
test('a single verified observation reports a saved price, not an executed change', () => {
  assert.equal(quickGiftCheckFeedback(gift, complete), 'Saved price: 0.190 GRAM/day.');
  assert.equal(quickGiftCheckFeedback({ ...gift, price_observed_at: '2026-10-09T10:00:00Z' }, complete), 'Loading the checked price…');
  assert.equal(quickGiftCheckFeedback(gift, { ...complete, run: { ...complete.run!, updated: 0 } }), 'Current contract price could not be verified. Saved observations are kept.');
});
test('another gift or full run cannot present targeted success', () => {
  assert.equal(quickGiftCheckFeedback(gift, { ...complete, run: { ...complete.run!, scope: 'portfolio' } }), null);
  assert.equal(quickGiftCheckFeedback(gift, { ...complete, run: { ...complete.run!, nft_address: `0:${'3'.repeat(64)}` } }), null);
  assert.equal(quickGiftCheckFeedback(gift, { ...complete, error: 'Another gift check is still finishing.' }), 'Another gift check is still finishing.');
});
test('candidate, conflicted and legacy identities are not eligible for a targeted check', () => {
  assert.equal(quickGiftCheckBlocker(gift), null);
  for (const change of [{ is_portfolio: false }, { category: 'unresolved' as const }, { collection_conflict: true }, { nft_address: 'legacy-nft' }, { collection_address: null }]) assert.ok(quickGiftCheckBlocker({ ...gift, ...change }));
});
