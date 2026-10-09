import type { Capabilities, MarketappSettingsStatus } from './types.ts';

const SOURCES = ['environment', 'secure_store', 'session', 'none'] as const;
const REASONS = ['external_configuration', 'active_job', 'secure_store_unavailable'] as const;

/** Copy only public status fields; never retain an echoed credential or raw error. */
export function publicMarketappSettings(value: unknown): MarketappSettingsStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API key settings returned an invalid response.');
  const row = value as Record<string, unknown>;
  if (!['configured', 'persistent_storage_available', 'network_enabled', 'can_manage', 'restart_required'].every(key => typeof row[key] === 'boolean') ||
      !SOURCES.includes(row.source as typeof SOURCES[number])) throw new Error('API key settings returned an invalid response.');
  return {
    configured: row.configured as boolean, source: row.source as MarketappSettingsStatus['source'],
    persistent_storage_available: row.persistent_storage_available as boolean,
    network_enabled: row.network_enabled as boolean, can_manage: row.can_manage as boolean,
    restart_required: row.restart_required as boolean,
    ...(REASONS.includes(row.reason as typeof REASONS[number]) ? { reason: row.reason as MarketappSettingsStatus['reason'] } : {}),
  };
}

export function marketappSettingsError(status?: number): string {
  if (status === 400 || status === 422) return 'The API key format or save option was not accepted. Re-enter the key and try again.';
  if (status === 401 || status === 403) return 'Reload the dashboard before changing API key settings.';
  if (status === 409) return 'API key settings cannot change right now. Check the current settings and any active sync.';
  return 'Could not confirm the API key settings. Check the current status before trying again.';
}

export interface CollectionBlocker { message: string; setup: boolean }

export function localCollectionBlocker(capabilities: Capabilities | undefined): CollectionBlocker | null {
  if (!capabilities) return null;
  if (!capabilities.marketapp_configured) return {
    message: capabilities.network_enabled ? 'Add your Marketapp API key to continue from saved progress.'
      : 'Add your Marketapp API key, then restart the desktop service with --allow-network to collect.',
    setup: true,
  };
  if (!capabilities.network_enabled) return { message: 'Marketapp collection is off. Restart the desktop service with --allow-network to continue.', setup: false };
  if (!capabilities.wallet_configured) return { message: 'Set your wallet address in the local configuration and restart the desktop service to continue.', setup: false };
  return null;
}
