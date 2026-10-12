import type { Dashboard, Gift } from './types.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';

export interface GiftSelection { id: string; context: string }
export function giftSelectionContext(data: Dashboard | null): string {
  return JSON.stringify([canonicalMainnetAddress(data?.wallet) ?? data?.wallet ?? null,
    data?.capabilities.public_account === true, data?.capabilities.account_generation ?? null]);
}
export function selectedDashboardGift(data: Dashboard | null, selection: GiftSelection | null): Gift | null {
  if (!data || !selection || selection.context !== giftSelectionContext(data)) return null;
  return data.gifts.find(gift => gift.id === selection.id) ?? null;
}
