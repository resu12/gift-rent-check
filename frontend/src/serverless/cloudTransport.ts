import type { TelegramServerless } from './transport.ts';

export type CloudEndpoint = 'getDashboard' | 'getDashboardRevision' | 'getJobs' | 'startJob' | 'stepJob' | 'stopJob' | 'resumeJob' | 'refreshStartupComparisons'
  | 'getStorageStatus' | 'stepStorageMaintenance'
  | 'getOwnedPriceRefresh' | 'startOwnedPriceRefresh' | 'stepOwnedPriceRefresh' | 'stopOwnedPriceRefresh' | 'importPersonalAnalytics'
  | 'getGiftRefresh' | 'startGiftRefresh' | 'stepGiftRefresh' | 'stopGiftRefresh'
  | 'startMarketappLoginTest' | 'finishMarketappLoginTest' | 'cancelMarketappLoginTest'
  | 'startMarketappAnalyticsRefresh' | 'finishMarketappAnalyticsRefresh' | 'cancelMarketappAnalyticsRefresh' | 'getMarketappAnalyticsRefreshStatus'
  | 'refreshSavedMarketappAnalytics' | 'refreshStartupMarketappAnalytics' | 'disconnectMarketappAnalyticsSession'
  | 'getPublicAccount' | 'getMarketappSettings' | 'saveMarketappApiKey' | 'removeMarketappApiKey' | 'testMarketappApiKey'
  | 'startWalletVerification' | 'finishWalletVerification' | 'disconnectPublicWallet' | 'deletePublicAccount' | 'reactivatePublicAccount';
export interface CloudTransport {
  call<T>(endpoint: CloudEndpoint, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

const MESSAGES: Record<string, string> = {
  PUBLIC_ACCESS_DENIED: 'This Telegram account is not invited to Gift Rent Check yet. Ask the app owner for access.',
  PUBLIC_ACCOUNT_LIMIT: 'Registration is full for this beta. Please try again later.',
  PUBLIC_KEY_INVALID: 'The API key format could not be accepted. Paste your Marketapp API key again.',
  PUBLIC_KEY_REQUIRED: 'Add your own Marketapp API key first.',
  PUBLIC_ACCOUNT_BUSY: 'Stop the active update before changing account settings.',
  PRIVATE_ACCOUNT_BUSY: 'Finish or stop the comparison update before changing your API key.',
  PRIVATE_KEY_CHANGED: 'Your API key changed in another session. Reload saved data before continuing.',
  PRIVATE_KEY_INVALID: 'Paste a valid Marketapp API key without spaces.',
  PRIVATE_ACCESS_DENIED: 'Open this Mini App with the approved Telegram account.',
  PRIVATE_INVALID_INPUT: 'Check your API key settings and try again.',
  PRIVATE_CONFLICT: 'Settings changed in another session. Reload them before trying again.',
  PRIVATE_SETTINGS_FAILED: 'API key settings could not be confirmed. Reload settings before trying again.',
  PUBLIC_WALLET_REQUIRED: 'Connect and verify your TON mainnet wallet first.',
  PUBLIC_WALLET_INVALID: 'The wallet approval could not be verified. Connect again.',
  PUBLIC_WALLET_MISMATCH: 'Use the wallet previously verified for this account. To switch wallets, delete your saved account data and start again.',
  PUBLIC_WALLET_CHANGED: 'Wallet connection changed. Start a new gift refresh.',
  PUBLIC_WALLET_UNSUPPORTED: 'This wallet’s proof is not supported yet. Try a supported TON mainnet wallet.',
  PUBLIC_WALLET_EXPIRED: 'The wallet approval expired or was already used. Connect again.',
  PUBLIC_WALLET_RATE_LIMIT: 'Please wait before requesting another wallet approval.',
  PUBLIC_PROVIDER_WAIT: 'Provider requests are temporarily limited. Try again later.',
  PUBLIC_ACCOUNT_DELETED: 'This account’s data was deleted. Choose Start again to create a new empty account.',
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
  STORAGE_FULL: 'Private storage is full. Saved data and progress are retained; storage maintenance is needed before updating.',
  STORAGE_PRESSURE: 'New updates are paused while storage is cleaned up. Saved data and progress are retained.',
  STORAGE_CAPACITY_PAUSED: 'Updates are paused to protect saved data. Clean up storage from Status, then try again.',
  STORAGE_MAINTENANCE_BUSY: 'Storage maintenance is already finishing. Check storage again shortly.',
  STORAGE_MAINTENANCE_FAILED: 'Storage maintenance could not finish. Saved data is retained. Try again later.',
  ACCOUNT_INVALID_INPUT: 'Check your account settings and try again.',
  API_KEY_INVALID: 'The API key format could not be accepted. Paste your Marketapp API key again.',
  API_KEY_REJECTED: 'Marketapp did not accept this API key. Check it in your Marketapp account.',
  API_KEY_REQUIRED: 'Add your own Marketapp API key first.',
  ACCOUNT_ACTIVE_JOB: 'Stop the active update before changing account settings.',
  ACCOUNT_RATE_LIMIT: 'Please wait before changing account settings again.',
  WALLET_REQUIRED: 'Connect and verify your TON mainnet wallet first.',
  WALLET_PROOF_INVALID: 'The wallet approval could not be verified. Connect again.',
  WALLET_PROOF_EXPIRED: 'The wallet approval expired or was already used. Connect again.',
  WALLET_PROOF_RATE_LIMIT: 'Please wait before requesting another wallet approval.',
  PUBLIC_MODE_DISABLED: 'Public accounts are not enabled in this app.',
  MARKETAPP_REFRESH_FAILED: 'Marketapp analytics could not be refreshed. Previous analytics stay visible.',
  MARKETAPP_REFRESH_RATE_LIMIT: 'Please wait before requesting another analytics refresh.',
  MARKETAPP_REFRESH_EXPIRED: 'This wallet approval expired or was already used. Start a new refresh.',
  MARKETAPP_REFRESH_INVALID_INPUT: 'The analytics refresh request could not be accepted. Start a new refresh.',
  MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED: 'Open this private Mini App with the approved Telegram account.',
  MARKETAPP_REFRESH_WALLET_REQUIRED: 'Save a valid TON mainnet wallet address before refreshing analytics.',
  MARKETAPP_REFRESH_AUTH_REJECTED: 'Marketapp did not accept the wallet login. Previous analytics stay visible.',
  MARKETAPP_REFRESH_PAGE_CHANGED: 'Marketapp’s analytics page could not be read safely. Previous analytics stay visible.',
  MARKETAPP_REFRESH_RECONNECT_REQUIRED: 'Marketapp login expired. Refresh again to approve a new wallet login.',
  MARKETAPP_LOGIN_RATE_LIMIT: 'Wait at least one minute between connection tests. At most five tests are allowed per hour.',
  MARKETAPP_LOGIN_EXPIRED: 'This connection test expired or was already used. Start a new test.',
  MARKETAPP_LOGIN_INVALID_INPUT: 'The connection test request could not be accepted. Start a new test.',
  MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED: 'Open this private Mini App with the approved Telegram account.',
  MARKETAPP_LOGIN_WALLET_REQUIRED: 'Save a valid TON mainnet wallet address before testing the connection.',
  MARKETAPP_LOGIN_FAILED: 'The server could not complete this connection test. Try again later.',
  UNAUTHORIZED: 'Open this Mini App inside Telegram with the approved account.',
  INTERNAL: 'Telegram could not complete this request. Reload saved data before continuing. (INTERNAL)',
  READ_BUSY: 'Saved data is temporarily busy. Try again shortly. (READ_BUSY)',
  READ_TIMEOUT: 'Loading saved data took too long. Try again. (READ_TIMEOUT)',
  READ_LIMIT: 'Loading saved data reached a service limit. Please report this error. (READ_LIMIT)',
  READ_FAILED: 'Saved data could not be loaded. Try again. (READ_FAILED)',
  ENDPOINT_ERROR: 'Private access was denied or the server could not complete this request. Reopen the Mini App and try again.',
  CONFIGURATION: 'The Marketapp token has not been configured on the server.',
  ACTIVE_RUN: 'A collection is already saved as active. Continue it or stop it first.',
  ACTIVE_JOB: 'A collection is already saved as active. Continue it or stop it first.',
  INVALID_INPUT: 'Check the selected timeframe. New rental scans must stay within the last 90 days.',
  NOT_RESUMABLE: 'This collection cannot continue. Start a fresh bounded collection.',
  CONFLICT: 'Another request updated this collection. Reload saved data before continuing.',
  LEASE_ACTIVE: 'A request is still finishing. Wait briefly, then continue the saved collection.',
  OWNED_PRICE_BUSY: 'Another gift check is still finishing. Wait for it or stop it in Status, then try again.',
  OWNED_PRICE_INVALID_TARGET: 'This gift is not eligible for a price check. Reload your gifts before trying again.',
  OWNED_PRICE_SCOPE_CHANGED: 'This gift check no longer matches your saved wallet or gift. Reload your gifts before trying again.',
};

export interface CloudRetryMetadata {
  retryAt: string;
  retryAfterSeconds: number;
  limitReason: 'cooldown' | 'hourly';
}
/** Only a server duration controls the local wait; phone/server clock offsets are irrelevant. */
export function cloudRefreshRetryMetadata(value: unknown): CloudRetryMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (fields.code !== 'MARKETAPP_REFRESH_RATE_LIMIT' || typeof fields.retryAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(fields.retryAt) ||
      !Number.isFinite(Date.parse(fields.retryAt)) || new Date(fields.retryAt).toISOString().slice(0, 10) !== fields.retryAt.slice(0, 10) ||
      typeof fields.retryAfterSeconds !== 'number' || !Number.isInteger(fields.retryAfterSeconds) || fields.retryAfterSeconds < 1 || fields.retryAfterSeconds > 86400 ||
      (fields.limitReason !== 'cooldown' && fields.limitReason !== 'hourly')) return null;
  return { retryAt: fields.retryAt, retryAfterSeconds: fields.retryAfterSeconds, limitReason: fields.limitReason as CloudRetryMetadata['limitReason'] };
}
export class CloudError extends Error {
  readonly code: string;
  readonly retryAt?: string;
  readonly retryAfterSeconds?: number;
  readonly limitReason?: 'cooldown' | 'hourly';
  constructor(code: string, message: string, metadata?: unknown) {
    super(message); this.name = 'CloudError'; this.code = code;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const fields = metadata as Record<string, unknown>;
      const valid = cloudRefreshRetryMetadata({ code, retryAt: fields.retry_at, retryAfterSeconds: fields.retry_after_seconds, limitReason: fields.reason });
      if (valid) { this.retryAt = valid.retryAt; this.retryAfterSeconds = valid.retryAfterSeconds; this.limitReason = valid.limitReason; }
    }
  }
}

export interface CloudTransportEnvironment {
  now(): number;
  setTimer(callback: () => void, delay: number): () => void;
}
const browserEnvironment: CloudTransportEnvironment = {
  now: () => performance.now(),
  setTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};
const RETRYABLE_READS = new Set<CloudEndpoint>(['getDashboard', 'getDashboardRevision', 'getJobs']);
const READ_RETRY_DELAYS = [800, 1600];

/** Caller identity is platform supplied. Keys enter only the explicit secure setup route; mutations never retry here. */
export function createCloudTransport(api?: TelegramServerless, timeoutMs = 45000, analyticsRefreshTimeoutMs = 120000,
  environment: CloudTransportEnvironment = browserEnvironment): CloudTransport {
  return {
    call<T>(endpoint: CloudEndpoint, input: Record<string, unknown> = {}, signal?: AbortSignal) {
      if (!api?.call) return Promise.reject(new CloudError('UNAVAILABLE', 'Open this private Mini App from your Telegram bot.'));
      if (signal?.aborted) return Promise.reject(new DOMException('Read cancelled', 'AbortError'));
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        let retryCount = 0;
        let attempt = 0;
        let cancelRetry: (() => void) | undefined;
        let cancelDeadline: (() => void) | undefined;
        const deadline = ['finishMarketappAnalyticsRefresh', 'refreshSavedMarketappAnalytics', 'refreshStartupMarketappAnalytics'].includes(endpoint) ? analyticsRefreshTimeoutMs : timeoutMs;
        const expiresAt = environment.now() + deadline;
        const timeout = () => new CloudError('TIMEOUT', 'The request timed out. Saved progress will be checked; collection will not restart automatically.');
        const finish = (error?: Error, value?: T) => {
          if (settled) return;
          settled = true; cancelDeadline?.(); cancelRetry?.(); signal?.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value!);
        };
        const cancel = () => finish(new DOMException('Read cancelled', 'AbortError'));
        const expired = () => {
          if (environment.now() < expiresAt) return false;
          finish(timeout()); return true;
        };
        // All attempts and their waits share one deadline, including when a
        // backgrounded WebView delivers a callback before its delayed timer.
        cancelDeadline = environment.setTimer(() => finish(timeout()), deadline);
        signal?.addEventListener('abort', cancel, { once: true });
        const retryRead = () => {
          if (!RETRYABLE_READS.has(endpoint) || retryCount >= READ_RETRY_DELAYS.length) return false;
          cancelRetry = environment.setTimer(() => { cancelRetry = undefined; send(); }, READ_RETRY_DELAYS[retryCount++]);
          return true;
        };
        const send = () => {
          if (settled || expired()) return;
          const currentAttempt = ++attempt;
          let callbackUsed = false;
          try {
            api.call(endpoint, input, (error, result) => {
              if (settled || callbackUsed || currentAttempt !== attempt) return;
              callbackUsed = true;
              if (expired()) return;
              if (error) {
                const code = typeof error.type === 'string' && Object.hasOwn(MESSAGES, error.type) ? error.type : 'TRANSPORT';
                // The pinned Telegram SDK documents INTERNAL as a platform 500.
                // Unknown types, endpoint refusals and auth errors are not
                // assumed transient. A timed-out mutation is never repeated.
                if (code === 'INTERNAL' && retryRead()) return;
                finish(new CloudError(code, MESSAGES[code] || 'Telegram could not complete this request. Reload saved data before continuing.', error));
                return;
              }
              if (!result || typeof result !== 'object' || Array.isArray(result)) {
                finish(new CloudError('INVALID_RESPONSE', 'The server returned an unexpected response. Collection has stopped.'));
                return;
              }
              const problem = (result as { error?: { code?: string } }).error;
              if (problem) {
                const code = typeof problem.code === 'string' && Object.hasOwn(MESSAGES, problem.code) ? problem.code : 'SERVER';
                if ((code === 'READ_BUSY' || code === 'READ_TIMEOUT') && retryRead()) return;
                finish(new CloudError(code, MESSAGES[code] || 'The server could not complete this action. Check saved progress before continuing.', problem));
                return;
              }
              finish(undefined, result as T);
            });
          } catch {
            // Ignore a throw after a synchronously delivered callback: that
            // callback already settled this attempt or scheduled its retry.
            if (!callbackUsed && currentAttempt === attempt)
              finish(new CloudError('TRANSPORT', 'Telegram could not send this request. Reopen the Mini App to reconnect.'));
          }
        };
        send();
      });
    },
  };
}
