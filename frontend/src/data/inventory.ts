import { filterGifts } from './helpers.ts';
import type { GiftFilter } from './helpers.ts';
import type { Gift } from './types.ts';

export type InventoryScope = 'portfolio' | 'candidates' | 'all';

export function filterInventoryGifts(
  gifts: Gift[], search: string, state: GiftFilter, collection: string, scope: InventoryScope,
): Gift[] {
  return filterGifts(gifts, search, state, collection).filter(gift =>
    scope === 'all' || (scope === 'portfolio' ? gift.is_portfolio : !gift.is_portfolio));
}

export function latestEvidenceAt(gifts: Gift[]): string | null {
  let latest: string | null = null;
  let latestTime = -Infinity;
  for (const gift of gifts) {
    for (const value of [gift.observed_at, gift.market_observed_at, gift.price_observed_at]) {
      if (!value) continue;
      const time = Date.parse(value);
      if (Number.isFinite(time) && time > latestTime) {
        latest = value;
        latestTime = time;
      }
    }
  }
  return latest;
}
