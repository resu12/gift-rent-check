import type { Gift } from './types.ts';
import { safeExternalUrl } from './helpers.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';

type ImageGift = Pick<Gift, 'nft_address' | 'image_url' | 'collection_name' | 'collection_conflict'>;
export interface AnalyticsImages { gifts: ReadonlyMap<string, string>; collections: ReadonlyMap<string, string> }

/** Reuse saved HTTPS artwork only; never derive provider URLs from gift names. */
export function analyticsImageUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  const url = safeExternalUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  return parsed.username || parsed.password ? undefined : url;
}

/** The stable address order keeps representative collection artwork unchanged when rows are sorted. */
export function analyticsImages(gifts: readonly ImageGift[]): AnalyticsImages {
  const images = gifts.flatMap(gift => {
    const address = canonicalMainnetAddress(gift.nft_address), url = analyticsImageUrl(gift.image_url);
    return address && url ? [{ gift, address, url }] : [];
  }).sort((a, b) => a.address.localeCompare(b.address) || a.url.localeCompare(b.url));
  const byGift = new Map<string, string>(), byCollection = new Map<string, string>();
  for (const { gift, address, url } of images) {
    if (!byGift.has(address)) byGift.set(address, url);
    const name = gift.collection_name?.trim().replace(/\s+/g, ' ');
    if (!gift.collection_conflict && name) {
      const key = `name:${name.toLowerCase()}`;
      if (!byCollection.has(key)) byCollection.set(key, url);
    }
  }
  return { gifts: byGift, collections: byCollection };
}
