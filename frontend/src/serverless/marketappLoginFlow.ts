import type { IStorage } from '@tonconnect/sdk';
import { decodeTelegramUrlParameters, encodeTelegramUrlParameters } from '@tonconnect/sdk';
import type { MarketappLoginAccount, MarketappLoginChallenge, MarketappLoginProof, MarketappLoginTestAdapter, MarketappLoginTestResult, MarketappWalletDevice } from '../data/types.ts';
import { canonicalMainnetAddress } from './walletIdentity.ts';

export const MARKETAPP_MANIFEST = 'https://marketapp.org/static/tonconnect-manifest.org.json';
const failureDetails = {
  wallet_mismatch: { code: 'MC-WALLET', message: 'The approved account address does not match your saved dashboard address. Check the selected wallet account.' },
  mainnet_required: { code: 'MC-NETWORK', message: 'The approval must come from a TON mainnet wallet.' },
  domain_mismatch: { code: 'MC-DOMAIN', message: 'The wallet proof does not match the expected Marketapp domain.' },
  challenge_mismatch: { code: 'MC-CHALLENGE', message: 'The wallet proof does not match this connection test. Start a new test.' },
  timestamp_invalid: { code: 'MC-TIME', message: 'The wallet proof is expired or its time is outside the allowed range.' },
  signature_missing: { code: 'MC-SIGNATURE', message: 'The wallet did not return a signature in the expected format.' },
  invalid_response: { code: 'MC-RESPONSE', message: 'The server returned an unexpected test result.' },
  invalid_challenge: { code: 'MC-INIT', message: 'A valid Marketapp test challenge could not be prepared.' },
  proof_missing: { code: 'MC-PROOF', message: 'The wallet connected without the requested login proof.' },
  wallet_error: { code: 'MC-WALLET-ERROR', message: 'The wallet could not complete the proof request.' },
  preparing_timeout: { code: 'MC-PREP-TIMEOUT', message: 'Preparing wallet approval took too long. Start a new test.' },
  start_transport: { code: 'MC-START', message: 'Telegram could not prepare this connection test.' },
  finish_transport: { code: 'MC-CHECK', message: 'Telegram could not check the wallet approval.' },
  check_timeout: { code: 'MC-CHECK-TIMEOUT', message: 'Checking the wallet approval timed out. Start a new test.' },
  chooser_unavailable: { code: 'MC-CHOOSER', message: 'The wallet list could not be loaded.' },
  launch_invalid: { code: 'MC-LINK', message: 'A safe wallet approval link could not be opened.' },
  rate_limited: { code: 'MC-LIMIT', message: 'Another connection test is limited. Wait at least one minute between tests; at most five tests are allowed per hour.' },
  expired_test: { code: 'MC-EXPIRED', message: 'This connection test expired or was already used. Start a new test.' },
  invalid_input: { code: 'MC-REQUEST', message: 'The connection test request could not be accepted. Start a new test.' },
  access_denied: { code: 'MC-ACCESS', message: 'Open this private Mini App with the approved Telegram account.' },
  wallet_required: { code: 'MC-ADDRESS', message: 'Save a valid TON mainnet wallet address before testing the connection.' },
  server_failed: { code: 'MC-SERVER', message: 'The server could not complete this connection test. Try again later.' },
} as const;
export type MarketappLoginFailureReason = keyof typeof failureDetails;
/** Diagnostics contain fixed copy only, never a provider message or proof value. */
export function marketappLoginFailureDetails(reason?: MarketappLoginFailureReason) {
  return reason && Object.hasOwn(failureDetails, reason) ? failureDetails[reason] : failureDetails.invalid_response;
}
export class MarketappWalletFailure extends Error {
  readonly reason: MarketappLoginFailureReason;
  constructor(reason: MarketappLoginFailureReason) { super(marketappLoginFailureDetails(reason).message); this.reason = reason; }
}
function transportFailure(error: unknown, stage: 'start' | 'finish'): MarketappLoginFailureReason {
  // Only the fixed transport code is examined; provider error messages remain private.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'MARKETAPP_LOGIN_RATE_LIMIT') return 'rate_limited';
  if (code === 'MARKETAPP_LOGIN_EXPIRED') return 'expired_test';
  if (code === 'MARKETAPP_LOGIN_INVALID_INPUT') return 'invalid_input';
  if (code === 'MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED') return 'access_denied';
  if (code === 'MARKETAPP_LOGIN_WALLET_REQUIRED') return 'wallet_required';
  if (code === 'MARKETAPP_LOGIN_FAILED') return 'server_failed';
  if (code === 'INVALID_RESPONSE') return 'invalid_response';
  if (code === 'TIMEOUT') return stage === 'start' ? 'preparing_timeout' : 'check_timeout';
  return stage === 'start' ? 'start_transport' : 'finish_transport';
}
export interface MarketappLoginWalletOption { id: string; name: string; installed: boolean }
export interface MarketappLoginWallet {
  options: MarketappLoginWalletOption[];
  connect(id: string): string | null;
  close(): Promise<void>;
}
export interface MarketappLoginView {
  phase: 'idle' | 'preparing' | 'choosing' | 'awaiting_approval' | 'checking' | 'passed' | 'failed' | 'cancelled' | 'expired';
  options?: MarketappLoginWalletOption[];
  launchUrl?: string | null;
  failure?: MarketappLoginFailureReason;
}
export type MarketappWalletFactory = (challenge: MarketappLoginChallenge, signal: AbortSignal, approved: (account: MarketappLoginAccount, proof: MarketappLoginProof, device?: MarketappWalletDevice) => void, ended: (phase: 'cancelled' | 'failed', reason?: MarketappLoginFailureReason) => void) => Promise<MarketappLoginWallet>;

/** The test cannot use or restore the dashboard wallet's persistent SDK session. */
export function createMarketappMemoryStorage(): IStorage & { clear(): void } {
  const values = new Map<string, string>();
  const prefix = 'gift-rent-check.marketapp-login-test.';
  let closed = false;
  return {
    async getItem(key) { return closed ? null : values.get(prefix + key) ?? null; },
    async setItem(key, value) { if (!closed) values.set(prefix + key, value); },
    async removeItem(key) { values.delete(prefix + key); },
    clear() { closed = true; values.clear(); },
  };
}

export function isSafeMarketappChallenge(value: MarketappLoginChallenge, savedWallet: string | null, now: number): boolean {
  if (!value || value.manifest_url !== MARKETAPP_MANIFEST || value.domain !== 'marketapp.org' ||
      !/^[a-f0-9]{64}$/.test(value.attempt_id) || typeof value.challenge !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value.challenge)) return false;
  const wallet = canonicalMainnetAddress(value.wallet), expected = canonicalMainnetAddress(savedWallet);
  const expiry = Date.parse(value.expires_at);
  return Boolean(wallet && expected && wallet === expected && Number.isFinite(expiry) && expiry > now && expiry - now <= 300_000);
}

const resultChecks = [
  ['wallet_matches', 'wallet_mismatch'], ['mainnet', 'mainnet_required'], ['domain_matches', 'domain_mismatch'],
  ['challenge_matches', 'challenge_mismatch'], ['timestamp_fresh', 'timestamp_invalid'], ['signature_present', 'signature_missing'],
] as const;
/** A mismatch is diagnostic only when the whole response satisfies the test contract. */
export function classifyMarketappResult(value: unknown, attemptId: string): MarketappLoginFailureReason | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid_response';
  const result = value as Record<string, unknown>;
  const checks = result.checks;
  if (result.attempt_id !== attemptId || typeof result.compatible !== 'boolean' || result.signature_verified !== false ||
      result.authenticated !== false || result.analytics_refreshed !== false || !checks || typeof checks !== 'object' || Array.isArray(checks)) return 'invalid_response';
  const fields = checks as Record<string, unknown>;
  if (resultChecks.some(([key]) => typeof fields[key] !== 'boolean')) return 'invalid_response';
  const failed = resultChecks.find(([key]) => fields[key] === false);
  if (result.compatible !== !failed) return 'invalid_response';
  return failed?.[1] ?? null;
}
export function isCompatibleMarketappResult(value: MarketappLoginTestResult, attemptId: string): boolean {
  return classifyMarketappResult(value, attemptId) === null;
}

export function safeWalletLaunchUrl(value: string): string | null {
  if (value !== value.trim() || value.includes('\\')) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

/** Use the SDK's public Telegram codec to preserve its embedded connect request. */
export function marketappWalletLaunchUrl(value: string, returnUrl?: string): string | null {
  const safe = safeWalletLaunchUrl(value);
  if (!safe) return null;
  if (!returnUrl) return safe;
  const destination = safeWalletLaunchUrl(returnUrl);
  if (!destination) return null;
  const target = new URL(destination);
  const parameters = [...target.searchParams.entries()];
  if (target.hostname !== 't.me' || target.port || target.hash || !/^\/[a-z][a-z0-9_]{1,28}bot$/i.test(target.pathname) ||
      parameters.length !== 1 || parameters[0][0] !== 'startapp' || !/^[a-z0-9_-]{0,512}$/i.test(parameters[0][1])) return null;
  const launch = new URL(safe);
  if (launch.hostname === 't.me') {
    const embedded = launch.searchParams.get('startapp');
    if (!embedded?.startsWith('tonconnect-')) return null;
    const params = new URLSearchParams(decodeTelegramUrlParameters(embedded.slice('tonconnect-'.length)));
    params.set('ret', destination);
    launch.searchParams.set('startapp', `tonconnect-${encodeTelegramUrlParameters(params.toString())}`);
  } else launch.searchParams.set('ret', destination);
  return launch.href;
}

interface Attempt {
  active: boolean;
  approvalPending: boolean;
  abort: AbortController;
  challenge: MarketappLoginChallenge | null;
  wallet: MarketappLoginWallet | null;
  timer?: ReturnType<typeof setTimeout>;
}

/** A disposable, explicit proof compatibility check. It performs no provider login. */
export function createMarketappLoginTestController(transport: MarketappLoginTestAdapter, walletFactory: MarketappWalletFactory,
  savedWallet: string | null, update: (view: MarketappLoginView) => void,
  clock: { now(): number; timer(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clear(handle: ReturnType<typeof setTimeout>): void } = {
    now: () => Date.now(), timer: (callback, ms) => globalThis.setTimeout(callback, ms), clear: handle => globalThis.clearTimeout(handle),
  }) {
  let current: Attempt | null = null, disposed = false, previouslyPassed = false;
  let view: MarketappLoginView = { phase: 'idle' };
  const emit = (next: MarketappLoginView) => { view = next; if (!disposed) update(next); };
  const isCurrent = (attempt: Attempt) => !disposed && current === attempt && attempt.active;
  const cancelRemote = async (id: string) => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { timer = clock.timer(() => abort.abort(), 10_000); await transport.cancel(id, abort.signal); }
    catch { /* The server attempt also expires within five minutes. */ }
    finally { if (timer !== undefined) clock.clear(timer); }
  };
  const closeAttempt = (attempt: Attempt, cancel: boolean) => {
    attempt.active = false; attempt.abort.abort();
    if (attempt.timer !== undefined) clock.clear(attempt.timer);
    const wallet = attempt.wallet, challenge = attempt.challenge;
    attempt.wallet = null; attempt.challenge = null;
    if (current === attempt) current = null;
    if (wallet) void wallet.close().catch(() => undefined);
    if (cancel && challenge) void cancelRemote(challenge.attempt_id);
  };
  const end = (attempt: Attempt, phase: 'failed' | 'cancelled' | 'expired', reason: MarketappLoginFailureReason = 'wallet_error') => {
    if (!isCurrent(attempt)) return;
    closeAttempt(attempt, true);
    if (phase === 'failed' && reason === 'rate_limited' && previouslyPassed) emit({ phase: 'passed', failure: 'rate_limited' });
    else emit(phase === 'failed' ? { phase, failure: Object.hasOwn(failureDetails, reason) ? reason : 'wallet_error' } : { phase });
  };
  async function approved(attempt: Attempt, account: MarketappLoginAccount, proof: MarketappLoginProof) {
    if (!isCurrent(attempt) || !attempt.challenge || attempt.approvalPending) return;
    attempt.approvalPending = true; emit({ phase: 'checking' });
    const id = attempt.challenge.attempt_id;
    try {
      const result = await transport.finish(id, account, proof, attempt.abort.signal);
      if (!isCurrent(attempt)) return;
      const failure = classifyMarketappResult(result, id);
      if (!failure) previouslyPassed = true;
      closeAttempt(attempt, false); emit(failure ? { phase: 'failed', failure } : { phase: 'passed' });
    } catch (error) { end(attempt, 'failed', transportFailure(error, 'finish')); }
  }
  return {
    get view() { return view; },
    async start(): Promise<boolean> {
      if (disposed || current) return false;
      const attempt: Attempt = { active: true, approvalPending: false, abort: new AbortController(), challenge: null, wallet: null };
      current = attempt; emit({ phase: 'preparing' });
      let stage: 'start' | 'chooser' = 'start';
      try {
        attempt.timer = clock.timer(() => end(attempt, 'failed', 'preparing_timeout'), 45_000);
        const challenge = await transport.start(attempt.abort.signal);
        if (!isCurrent(attempt)) { if (challenge && /^[a-f0-9]{64}$/.test(challenge.attempt_id)) void cancelRemote(challenge.attempt_id); return false; }
        attempt.challenge = challenge;
        if (!isSafeMarketappChallenge(challenge, savedWallet, clock.now())) { end(attempt, 'failed', 'invalid_challenge'); return false; }
        if (attempt.timer !== undefined) clock.clear(attempt.timer);
        attempt.timer = clock.timer(() => end(attempt, 'expired'), Date.parse(challenge.expires_at) - clock.now());
        stage = 'chooser';
        const wallet = await walletFactory(challenge, attempt.abort.signal, (account, proof) => { void approved(attempt, account, proof); }, (phase, reason) => end(attempt, phase, reason));
        if (!isCurrent(attempt)) { void wallet.close().catch(() => undefined); return false; }
        attempt.wallet = wallet;
        if (!wallet.options.length) { end(attempt, 'failed', 'chooser_unavailable'); return false; }
        emit({ phase: 'choosing', options: wallet.options }); return true;
      } catch (error) { end(attempt, 'failed', stage === 'chooser' ? 'chooser_unavailable' : transportFailure(error, 'start')); return false; }
    },
    choose(id: string): string | null {
      const attempt = current;
      if (!attempt || !isCurrent(attempt) || !attempt.wallet || view.phase !== 'choosing') return null;
      try {
        emit({ phase: 'awaiting_approval' });
        const link = attempt.wallet.connect(id);
        if (!isCurrent(attempt)) return null;
        const url = link === null ? null : safeWalletLaunchUrl(link);
        if (link !== null && !url) { end(attempt, 'failed', 'launch_invalid'); return null; }
        if (!attempt.approvalPending) emit({ phase: 'awaiting_approval', launchUrl: url }); return url;
      } catch (error) { end(attempt, 'failed', error instanceof MarketappWalletFailure ? error.reason : 'wallet_error'); return null; }
    },
    cancel() { if (current) end(current, 'cancelled'); },
    dispose() { disposed = true; if (current) closeAttempt(current, true); },
  };
}
