import type { Gift } from './types.ts';
import { ownedPriceStatusText, type OwnedPriceSnapshot } from './ownedPriceRefresh.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';
import { formatAmount } from './helpers.ts';

export function quickGiftCheckBlocker(gift: Gift): string | null {
  if (!gift.is_portfolio || gift.category === 'unresolved') return 'Verify this gift before checking its price.';
  if (gift.collection_conflict) return 'Resolve the collection conflict before checking this gift.';
  if (!canonicalMainnetAddress(gift.nft_address) || !canonicalMainnetAddress(gift.collection_address)) return 'A valid NFT and collection address are needed.';
  return null;
}

/** Completion counts mean verified observations, never an executed price change. */
export function quickGiftCheckFeedback(gift: Gift, snapshot: OwnedPriceSnapshot): string | null {
  if (snapshot.error) return snapshot.error;
  if (snapshot.phase === 'waiting' && snapshot.scope === 'gift') return ownedPriceStatusText(snapshot);
  const run = snapshot.run;
  if (run?.scope !== 'gift' || canonicalMainnetAddress(run.nft_address) !== canonicalMainnetAddress(gift.nft_address)) return null;
  if (snapshot.phase === 'checking') return 'Checking this gift…';
  if (snapshot.phase === 'unavailable' || snapshot.phase === 'partial') return 'Check incomplete. Your saved observations are kept; try again.';
  if (snapshot.phase !== 'complete') return null;
  if (!run.updated) return 'Current contract price could not be verified. Saved observations are kept.';
  const observed = Date.parse(gift.price_observed_at || ''), started = Date.parse(run.started_at);
  if (gift.price_is_historical === true || !Number.isFinite(observed) || !Number.isFinite(started) || observed < started || gift.price_per_day == null) return 'Loading the checked price…';
  return `Saved price: ${formatAmount(gift.price_per_day)} GRAM/day.`;
}
