import type { Dashboard, Job, MarketappLoginAccount, MarketappLoginProof } from '../data/types.ts';
import { canonicalMainnetAddress } from './walletIdentity.ts';

export interface PublicAccountStatus {
  public_mode: true;
  account_generation?: number;
  wallet: { address: string; verified_at: string } | null;
  marketapp_key: { configured: boolean; updated_at: string | null };
  onboarding_complete: boolean;
  deleted?: boolean;
  pending_cleanup?: boolean;
  privacy_policy_url?: string;
  terms_url?: string;
}
export interface PublicWalletChallenge {
  attempt_id: string;
  challenge: string;
  manifest_url: string;
  domain: string;
  expires_at: string;
}
export type PublicWalletAccount = MarketappLoginAccount & { walletStateInit: string };
export interface PublicApiKeyCheck {
  account: PublicAccountStatus;
  status: 'valid' | 'invalid' | 'unavailable';
  checked_at: string;
}
export interface PublicAccountAdapter {
  get(signal?: AbortSignal): Promise<PublicAccountStatus>;
  saveKey(apiKey: string, signal?: AbortSignal): Promise<PublicAccountStatus>;
  removeKey(signal?: AbortSignal): Promise<PublicAccountStatus>;
  testKey(signal?: AbortSignal): Promise<PublicApiKeyCheck>;
  startWallet(signal?: AbortSignal): Promise<PublicWalletChallenge>;
  finishWallet(attemptId: string, account: PublicWalletAccount, proof: MarketappLoginProof, signal?: AbortSignal): Promise<PublicAccountStatus>;
  disconnectWallet(signal?: AbortSignal): Promise<PublicAccountStatus>;
  deleteAccount(signal?: AbortSignal): Promise<PublicAccountStatus>;
  reactivate(signal?: AbortSignal): Promise<PublicAccountStatus>;
  startDiscovery(): Promise<Job>;
  resumeDiscovery(id: number, accountGeneration?: number): Promise<Job>;
}

/** Only account changes trigger a settings read; ordinary dashboard polls do not. */
export function publicAccountSettingsScope(dashboard: Pick<Dashboard, 'wallet' | 'capabilities'> | null | undefined): string | undefined {
  if (!dashboard?.capabilities.public_account) return undefined;
  const capabilities = dashboard.capabilities;
  return JSON.stringify([capabilities.account_generation ?? null, canonicalMainnetAddress(dashboard.wallet),
    capabilities.wallet_configured === true, capabilities.marketapp_configured === true]);
}

/** Discard superseded reads even if the transport ignores AbortSignal. */
export function createPublicAccountReader(adapter: Pick<PublicAccountAdapter, 'get'>,
  accept: (account: PublicAccountStatus) => void, failed: (problem: unknown) => void) {
  let revision = 0;
  let active: AbortController | null = null;
  const invalidate = () => { revision++; active?.abort(); active = null; };
  return {
    invalidate,
    async reload() {
      invalidate();
      const requestRevision = revision, abort = new AbortController(); active = abort;
      const current = () => requestRevision === revision && !abort.signal.aborted;
      try { const account = await adapter.get(abort.signal); if (current()) accept(account); }
      catch (problem) { if (current()) failed(problem); }
      finally { if (active === abort) active = null; }
    },
  };
}

export function readPublicApiKeyCheck(value: unknown): PublicApiKeyCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API key check could not be read.');
  const result = value as Record<string, unknown>;
  if (!['valid', 'invalid', 'unavailable'].includes(String(result.status)) || !timestamp(result.checked_at))
    throw new Error('API key check could not be read.');
  return { account: readPublicAccount(result), status: result.status as PublicApiKeyCheck['status'], checked_at: result.checked_at };
}

const timestamp = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));

function policyUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) || /[\s\\]/.test(value))
    throw new Error('Account settings could not be read. Retry loading saved data.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Account settings could not be read. Retry loading saved data.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
    throw new Error('Account settings could not be read. Retry loading saved data.');
  return url.href;
}

/** Normalize the public response; accidental server fields never become UI state. */
export function readPublicAccount(value: unknown): PublicAccountStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Account settings could not be read. Retry loading saved data.');
  const wrapped = value as Record<string, unknown>;
  const input = Object.hasOwn(wrapped, 'account') ? wrapped.account : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Account settings could not be read. Retry loading saved data.');
  const status = input as Record<string, unknown>;
  const key = status.marketapp_key as Record<string, unknown> | null;
  const wallet = status.wallet as Record<string, unknown> | null;
  if (status.public_mode !== true || typeof status.onboarding_complete !== 'boolean' ||
      (status.account_generation !== undefined && (!Number.isSafeInteger(status.account_generation) || Number(status.account_generation) < 0)) ||
      (status.deleted !== undefined && typeof status.deleted !== 'boolean') ||
      (status.pending_cleanup !== undefined && typeof status.pending_cleanup !== 'boolean') ||
      !key || typeof key !== 'object' || Array.isArray(key) || typeof key.configured !== 'boolean' ||
      !(key.updated_at === null || timestamp(key.updated_at)) ||
      !(wallet === null || (wallet && typeof wallet === 'object' && !Array.isArray(wallet) &&
        canonicalMainnetAddress(wallet.address) && timestamp(wallet.verified_at))))
    throw new Error('Account settings could not be read. Retry loading saved data.');
  if (status.onboarding_complete && (!wallet || !key.configured))
    throw new Error('Account settings could not be read. Retry loading saved data.');
  if (status.deleted === true && (wallet || key.configured || status.onboarding_complete))
    throw new Error('Account settings could not be read. Retry loading saved data.');
  const privacyPolicy = policyUrl(status.privacy_policy_url), terms = policyUrl(status.terms_url);
  return { public_mode: true, onboarding_complete: status.onboarding_complete,
    ...(status.account_generation !== undefined ? { account_generation: status.account_generation as number } : {}),
    wallet: wallet ? { address: canonicalMainnetAddress(wallet.address)!, verified_at: wallet.verified_at as string } : null,
    marketapp_key: { configured: key.configured, updated_at: key.updated_at as string | null },
    ...(typeof status.deleted === 'boolean' ? { deleted: status.deleted } : {}),
    ...(typeof status.pending_cleanup === 'boolean' ? { pending_cleanup: status.pending_cleanup } : {}),
    ...(privacyPolicy ? { privacy_policy_url: privacyPolicy } : {}),
    ...(terms ? { terms_url: terms } : {}) };
}

export function publicAccountStep(account: PublicAccountStatus | null): 'loading' | 'deleted' | 'wallet' | 'key' | 'ready' {
  return !account ? 'loading' : account.deleted ? 'deleted' : !account.wallet ? 'wallet' : !account.marketapp_key.configured ? 'key' : 'ready';
}
/** Job IDs may repeat after deletion; discovery selection stays within one account incarnation. */
export function selectPublicDiscovery(account: PublicAccountStatus | null, jobs: Job[], current: Job | null): Job | null {
  if (!account || account.deleted || account.account_generation === undefined) return null;
  const latest = jobs.filter(job => job.kind === 'discover' && job.account_generation === account.account_generation)
    .sort((a, b) => b.id - a.id)[0];
  const saved = current?.account_generation === account.account_generation ? current : null;
  return latest && (!saved || latest.id >= saved.id) ? latest : saved;
}
export function validPublicApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{12,512}$/.test(value);
}

const SAFE_ERRORS: Record<string, string> = {
  PUBLIC_ACCESS_DENIED: 'Open this app from Telegram to access your own account.',
  PUBLIC_ACCOUNT_LIMIT: 'Registration is full for this beta. Please try again later.',
  PUBLIC_KEY_INVALID: 'The API key format could not be accepted. Paste your Marketapp API key again.',
  PUBLIC_KEY_REQUIRED: 'Add your own Marketapp API key first.',
  PUBLIC_ACCOUNT_BUSY: 'Stop the active update before changing account settings.',
  PUBLIC_WALLET_REQUIRED: 'Connect and verify your TON mainnet wallet first.',
  PUBLIC_WALLET_INVALID: 'The wallet approval could not be verified. Connect again.',
  PUBLIC_WALLET_MISMATCH: 'Use the wallet previously verified for this account. To switch wallets, delete your saved account data and start again.',
  PUBLIC_WALLET_UNSUPPORTED: 'This wallet’s proof is not supported yet. Try a supported TON mainnet wallet.',
  PUBLIC_WALLET_EXPIRED: 'The wallet approval expired or was already used. Connect again.',
  PUBLIC_WALLET_RATE_LIMIT: 'Please wait before requesting another wallet approval.',
  PUBLIC_PROVIDER_WAIT: 'Provider requests are temporarily limited. Try again later.',
  PUBLIC_ACCOUNT_DELETED: 'This account’s data was deleted. Choose Start again to create a new empty account.',
  PUBLIC_ACCOUNT_CHANGED: 'This account changed in another session. Reload saved data before continuing.',
  PUBLIC_CONFLICT: 'Another request updated this account. Reload settings before continuing.',
  PUBLIC_KEY_CHANGED: 'Your API key changed in another session. Reload saved data before continuing.',
  PUBLIC_REQUEST_FAILED: 'This action could not be confirmed. Reload account settings before trying again.',
  PUBLIC_STORAGE_LIMIT: 'Your saved data reached this account’s storage allowance. Saved results are retained; reduce retained data before another update.',
  PUBLIC_ANALYTICS_DISABLED: 'Personal analytics is not enabled for this release.',
  PUBLIC_CONFIGURATION: 'Public account setup is not configured for this app yet.',
  PUBLIC_INVALID_INPUT: 'Check the information and try again.',
  PUBLIC_WALLET_INVALID_PROOF: 'The wallet approval could not be verified. Connect again.',
  PUBLIC_WALLET_INVALID_INPUT: 'The wallet approval could not be accepted. Connect again.',
  PUBLIC_WALLET_BINDING_REJECTED: 'Use the wallet previously verified for this account. To switch wallets, delete your saved account data and start again.',
  PUBLIC_WALLET_CONFIGURATION: 'Wallet verification is not configured for this app yet.',
  ACCOUNT_INVALID_INPUT: 'Check the information and try again.',
  API_KEY_INVALID: 'The API key format could not be accepted. Paste your Marketapp API key again.',
  API_KEY_REJECTED: 'Marketapp did not accept this API key. Check it in your Marketapp account.',
  API_KEY_REQUIRED: 'Add your own Marketapp API key first.',
  ACCOUNT_ACTIVE_JOB: 'Stop the active update before changing account settings.',
  ACTIVE_JOB: 'Stop the active update before changing account settings.',
  ACTIVE_RUN: 'Stop the active update before changing account settings.',
  WALLET_REQUIRED: 'Connect and verify your TON mainnet wallet first.',
  WALLET_PROOF_INVALID: 'The wallet approval could not be verified. Connect again.',
  WALLET_PROOF_EXPIRED: 'The wallet approval expired or was already used. Connect again.',
  WALLET_PROOF_RATE_LIMIT: 'Please wait before requesting another wallet approval.',
  ACCOUNT_RATE_LIMIT: 'Please wait before changing account settings again.',
  STORAGE_FULL: 'Saved storage is full. Try again after maintenance.',
  TIMEOUT: 'This request timed out. Reload account settings before trying again.',
  UNAUTHORIZED: 'Open this app from Telegram to access your account.',
  PUBLIC_MODE_DISABLED: 'Public accounts are not enabled in this app.',
};
/** Never reflect an error message, API key, proof, or provider response. */
export function publicAccountError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && Object.hasOwn(SAFE_ERRORS, code)
    ? SAFE_ERRORS[code] : 'This action could not be confirmed. Reload account settings before trying again.';
}
