export interface ServerlessListing {
  nft_address: string;
  name: string | null;
  collection_address: string | null;
  price_nano: string | null;
  price_gram: string | null;
  price_display: string | null;
  observed_at: string;
  model: string | null;
  backdrop: string | null;
}

export interface ServerlessRun {
  id: string;
  status: 'ready' | 'running' | 'paused' | 'complete' | 'failed' | 'prototype_limit';
  pages_committed: number;
  items_seen: number;
  next_allowed_at: number;
  lease_until: number;
  reason: string | null;
  has_more: boolean;
  page_size: number;
  collection_address: string | null;
  attempts: number;
}

export interface ServerlessState {
  authorized: true;
  user: { id: string };
  configured: boolean;
  server_time: number;
  run: ServerlessRun | null;
  listings: ServerlessListing[];
  limits: { max_pages: number; page_size: number; max_attempts: number; request_interval_ms: number };
  error?: { code: string; message: string };
}

export type Endpoint = 'getState' | 'startRun' | 'stepRun' | 'stopRun' | 'resumeRun';
export interface ServerlessAdapter {
  call(endpoint: Endpoint, input?: Record<string, unknown>): Promise<ServerlessState>;
}

export interface TelegramCallError { type?: string; message?: string; parameters?: unknown }
export interface TelegramServerless {
  call(endpoint: string, input: Record<string, unknown>, callback: (error: TelegramCallError | null, result?: unknown) => void): void;
}

export class PrototypeError extends Error {
  readonly code: string;
  readonly state?: ServerlessState;
  constructor(code: string, message: string, state?: ServerlessState) {
    super(message);
    this.name = 'PrototypeError';
    this.code = code;
    this.state = state;
  }
}

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: 'Open this Mini App inside Telegram with the approved account.',
  ENDPOINT_ERROR: 'Private access was denied or the server could not complete this request. Check the private bot setup.',
  CONFIGURATION: 'The Marketapp token has not been configured on the server.',
  ACTIVE_RUN: 'A saved collection is already active. Continue it or stop it first.',
  RUN_NOT_FOUND: 'This collection is no longer available. Reload saved data.',
  INVALID_INPUT: 'Check the collection address and try again.',
  NOT_RESUMABLE: 'This collection cannot continue. Reload saved data and start a fresh collection if needed.',
  STORAGE_LIMIT: 'The prototype storage limit was reached. Preserve the test database before starting over.',
  CONFLICT: 'Another request updated this collection. Reload saved data before continuing.',
};

export function safeError(error: unknown): string {
  return error instanceof PrototypeError ? error.message : 'The request did not finish. Reload saved data before continuing.';
}

function validState(value: unknown): value is ServerlessState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ServerlessState>;
  const nonnegativeInteger = (number: unknown) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  const nullableText = (text: unknown) => text === null || typeof text === 'string';
  return state.authorized === true && typeof state.user?.id === 'string' && /^[1-9]\d*$/.test(state.user.id)
    && typeof state.configured === 'boolean' && Number.isFinite(state.server_time)
    && [state.limits?.max_pages, state.limits?.page_size, state.limits?.max_attempts, state.limits?.request_interval_ms].every(nonnegativeInteger)
    && Array.isArray(state.listings) && state.listings.every(item => item && typeof item === 'object'
      && typeof item.nft_address === 'string' && typeof item.observed_at === 'string'
      && [item.name, item.collection_address, item.price_nano, item.price_gram, item.price_display, item.model, item.backdrop].every(nullableText))
    && (state.run === null || (typeof state.run?.id === 'string'
      && ['ready', 'running', 'paused', 'complete', 'failed', 'prototype_limit'].includes(state.run.status)
      && [state.run.pages_committed, state.run.items_seen, state.run.attempts, state.run.page_size].every(nonnegativeInteger)
      && Number.isFinite(state.run.next_allowed_at) && Number.isFinite(state.run.lease_until)
      && nullableText(state.run.collection_address) && nullableText(state.run.reason) && typeof state.run.has_more === 'boolean'))
    && (state.error === undefined || (typeof state.error?.code === 'string' && typeof state.error.message === 'string'));
}

// Only platform-authenticated Serverless endpoints are used. No browser-supplied
// identity, initDataUnsafe, provider token, or arbitrary URL enters this adapter.
export function createServerlessAdapter(serverless?: TelegramServerless, timeoutMs = 45000): ServerlessAdapter {
  return {
    call(endpoint, input = {}) {
      if (!serverless?.call) return Promise.reject(new PrototypeError('UNAVAILABLE',
        'Open this private Mini App from your Telegram bot. Telegram Serverless is unavailable in this browser.'));
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new PrototypeError('TIMEOUT',
          'The request timed out. Its page may still be saved on the server. Reload saved data before continuing.')), timeoutMs);
        const finish = (error?: Error, state?: ServerlessState) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(state!);
        };
        try {
          serverless.call(endpoint, input, (error, result) => {
            if (error) {
              const code = error.type || 'TRANSPORT';
              finish(new PrototypeError(code, MESSAGES[code] || 'Telegram could not complete this request. Reload saved data before continuing.'));
            } else if (!validState(result)) {
              finish(new PrototypeError('INVALID_RESPONSE', 'The server returned an unexpected response. Collection has stopped.'));
            } else if (result.error) {
              const code = result.error.code;
              finish(new PrototypeError(code, MESSAGES[code] || 'The server could not complete this action. Reload saved data and check the saved collection status.', result));
            } else finish(undefined, result);
          });
        } catch {
          finish(new PrototypeError('TRANSPORT', 'Telegram could not send this request. Reopen the Mini App to reconnect.'));
        }
      });
    },
  };
}
