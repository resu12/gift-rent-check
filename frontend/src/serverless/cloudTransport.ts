import type { TelegramServerless } from './transport.ts';

export type CloudEndpoint = 'getDashboard' | 'getJobs' | 'startJob' | 'stepJob' | 'stopJob' | 'resumeJob'
  | 'getOwnedPriceRefresh' | 'startOwnedPriceRefresh' | 'stepOwnedPriceRefresh' | 'stopOwnedPriceRefresh' | 'importPersonalAnalytics'
  | 'startMarketappLoginTest' | 'finishMarketappLoginTest' | 'cancelMarketappLoginTest'
  | 'startMarketappAnalyticsRefresh' | 'finishMarketappAnalyticsRefresh' | 'cancelMarketappAnalyticsRefresh' | 'getMarketappAnalyticsRefreshStatus';
export interface CloudTransport {
  call<T>(endpoint: CloudEndpoint, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

const MESSAGES: Record<string, string> = {
  MARKETAPP_REFRESH_FAILED: 'Marketapp analytics could not be refreshed. Previous analytics stay visible.',
  MARKETAPP_REFRESH_RATE_LIMIT: 'Please wait before requesting another analytics refresh.',
  MARKETAPP_REFRESH_EXPIRED: 'This wallet approval expired or was already used. Start a new refresh.',
  MARKETAPP_REFRESH_INVALID_INPUT: 'The analytics refresh request could not be accepted. Start a new refresh.',
  MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED: 'Open this private Mini App with the approved Telegram account.',
  MARKETAPP_REFRESH_WALLET_REQUIRED: 'Save a valid TON mainnet wallet address before refreshing analytics.',
  MARKETAPP_REFRESH_AUTH_REJECTED: 'Marketapp did not accept the wallet login. Previous analytics stay visible.',
  MARKETAPP_REFRESH_PAGE_CHANGED: 'Marketapp’s analytics page could not be read safely. Previous analytics stay visible.',
  MARKETAPP_LOGIN_RATE_LIMIT: 'Wait at least one minute between connection tests. At most five tests are allowed per hour.',
  MARKETAPP_LOGIN_EXPIRED: 'This connection test expired or was already used. Start a new test.',
  MARKETAPP_LOGIN_INVALID_INPUT: 'The connection test request could not be accepted. Start a new test.',
  MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED: 'Open this private Mini App with the approved Telegram account.',
  MARKETAPP_LOGIN_WALLET_REQUIRED: 'Save a valid TON mainnet wallet address before testing the connection.',
  MARKETAPP_LOGIN_FAILED: 'The server could not complete this connection test. Try again later.',
  UNAUTHORIZED: 'Open this Mini App inside Telegram with the approved account.',
  ENDPOINT_ERROR: 'Private access was denied or the server could not complete this request. Reopen the Mini App and try again.',
  CONFIGURATION: 'The Marketapp token has not been configured on the server.',
  ACTIVE_RUN: 'A collection is already saved as active. Continue it or stop it first.',
  ACTIVE_JOB: 'A collection is already saved as active. Continue it or stop it first.',
  INVALID_INPUT: 'Check the selected timeframe. New rental scans must stay within the last 90 days.',
  NOT_RESUMABLE: 'This collection cannot continue. Start a fresh bounded collection.',
  CONFLICT: 'Another request updated this collection. Reload saved data before continuing.',
  LEASE_ACTIVE: 'A request is still finishing. Wait briefly, then continue the saved collection.',
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

/** Identity and provider secrets never enter endpoint input. Mutations never retry here. */
export function createCloudTransport(api?: TelegramServerless, timeoutMs = 45000, analyticsRefreshTimeoutMs = 120000): CloudTransport {
  return {
    call<T>(endpoint: CloudEndpoint, input: Record<string, unknown> = {}, signal?: AbortSignal) {
      if (!api?.call) return Promise.reject(new CloudError('UNAVAILABLE', 'Open this private Mini App from your Telegram bot.'));
      if (signal?.aborted) return Promise.reject(new DOMException('Read cancelled', 'AbortError'));
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: T) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value!);
        };
        const cancel = () => finish(new DOMException('Read cancelled', 'AbortError'));
        const deadline = endpoint === 'finishMarketappAnalyticsRefresh' ? analyticsRefreshTimeoutMs : timeoutMs;
        const timer = setTimeout(() => finish(new CloudError('TIMEOUT', 'The request timed out. Saved progress will be checked; collection will not restart automatically.')), deadline);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          api.call(endpoint, input, (error, result) => {
            if (error) {
              const code = error.type && Object.hasOwn(MESSAGES, error.type) ? error.type : 'TRANSPORT';
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
              finish(new CloudError(code, MESSAGES[code] || 'The server could not complete this action. Check saved progress before continuing.', problem));
              return;
            }
            finish(undefined, result as T);
          });
        } catch { finish(new CloudError('TRANSPORT', 'Telegram could not send this request. Reopen the Mini App to reconnect.')); }
      });
    },
  };
}
