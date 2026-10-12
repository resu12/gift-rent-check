import type { Capabilities, Dashboard } from './types.ts';
import type { CollectionBlocker } from './marketappSettings.ts';

export interface ComparisonCollectionBlocker extends CollectionBlocker {
  actionLabel?: string;
}

/** Public saved membership remains readable after disconnect, but is not approval to sync. */
export function publicComparisonBlocker(capabilities: Capabilities | undefined): ComparisonCollectionBlocker | null {
  if (!capabilities?.public_account) return null;
  if (!capabilities.wallet_configured) return {
    message: 'Reconnect your wallet in account settings to update comparisons.', setup: true, actionLabel: 'Reconnect wallet',
  };
  if (!capabilities.marketapp_configured) return {
    message: 'Add your Marketapp API key in account settings to update comparisons.', setup: true, actionLabel: 'Open account settings',
  };
  if (!capabilities.network_enabled) return { message: 'Comparison updates are unavailable. Your saved data remains available.', setup: false };
  return null;
}

export function canCollectComparisons(data: Pick<Dashboard, 'capabilities' | 'gifts'> | null | undefined, cloud: boolean, loadError = false): boolean {
  if (!data || loadError || !data.capabilities.network_enabled || !data.capabilities.marketapp_configured) return false;
  if (data.capabilities.public_account && !data.capabilities.wallet_configured) return false;
  return cloud ? data.gifts.some(gift => gift.is_portfolio && gift.collection_address) : data.capabilities.wallet_configured;
}
