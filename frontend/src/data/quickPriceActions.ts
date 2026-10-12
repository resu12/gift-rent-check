import { formatAmount } from './helpers.ts';
import type { Gift } from './types.ts';
import { friendlyMainnetAddress } from '../serverless/walletIdentity.ts';

/** Copy exactly the displayed half-up price, without grouping or a currency suffix. */
export function recommendedPriceText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const text = formatAmount(value).replace(/,/g, '');
  return /^\d+\.\d{3}$/.test(text) && BigInt(text.replace('.', '')) > 0n ? text : null;
}

export function marketappGiftUrl(address: unknown): string | null {
  const friendly = friendlyMainnetAddress(address);
  return friendly ? `https://marketapp.org/nft/${friendly}/?to=rent` : null;
}

export async function copyRecommendedPrice(value: unknown, clipboard: Pick<Clipboard, 'writeText'> | null | undefined): Promise<boolean> {
  const text = recommendedPriceText(value);
  if (!text || !clipboard?.writeText) return false;
  try { await clipboard.writeText(text); return true; }
  catch { return false; }
}

export function quickPriceState(gift: Gift) {
  const eligible = gift.is_portfolio && gift.category === 'portfolio';
  const daily = gift.pricing?.daily_comparable !== false && gift.pricing?.unit === 'GRAM/day';
  const price = eligible && daily ? recommendedPriceText(gift.pricing?.recommended_price_per_day) : null;
  const copyReason = !eligible ? 'Ownership unverified' : !daily ? 'Daily GRAM recommendation unavailable' : !price ? 'No positive daily recommendation' : null;
  const url = eligible ? marketappGiftUrl(gift.nft_address) : null;
  // The range is advisory: the estimate is never clamped or recorded as an edit.
  const units = price == null ? null : BigInt(price.replace('.', ''));
  const rangeWarning = units != null && (units < 10n || units > 1_000_000_000n)
    ? 'Outside Marketapp’s documented price range (0.010–1,000,000 GRAM/day). Confirm the allowed price there.' : null;
  return { eligible, price, copyReason, url, openReason: url ? null : 'Valid mainnet NFT address required', rangeWarning };
}
