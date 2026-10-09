import type { TelegramServerless } from './transport.ts';

export type CloudEndpoint = 'getDashboard' | 'getJobs' | 'startJob' | 'stepJob' | 'stopJob' | 'resumeJob'
  | 'getOwnedPriceRefresh' | 'startOwnedPriceRefresh' | 'stepOwnedPriceRefresh' | 'stopOwnedPriceRefresh';
export interface CloudTransport {
  call<T>(endpoint: CloudEndpoint, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

const MESSAGES: Record<string, string> = {
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

export class CloudError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'CloudError'; this.code = code; }
}

/** Identity and provider secrets never enter endpoint input. Mutations never retry here. */
export function createCloudTransport(api?: TelegramServerless, timeoutMs = 45000): CloudTransport {
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
        const timer = setTimeout(() => finish(new CloudError('TIMEOUT', 'The request timed out. Saved progress will be checked; collection will not restart automatically.')), timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          api.call(endpoint, input, (error, result) => {
            if (error) {
              const code = error.type || 'TRANSPORT';
              finish(new CloudError(code, MESSAGES[code] || 'Telegram could not complete this request. Reload saved data before continuing.'));
              return;
            }
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
              finish(new CloudError('INVALID_RESPONSE', 'The server returned an unexpected response. Collection has stopped.'));
              return;
            }
            const problem = (result as { error?: { code?: string } }).error;
            if (problem) {
              const code = typeof problem.code === 'string' ? problem.code : 'SERVER';
              finish(new CloudError(code, MESSAGES[code] || 'The server could not complete this action. Check saved progress before continuing.'));
              return;
            }
            finish(undefined, result as T);
          });
        } catch { finish(new CloudError('TRANSPORT', 'Telegram could not send this request. Reopen the Mini App to reconnect.')); }
      });
    },
  };
}
