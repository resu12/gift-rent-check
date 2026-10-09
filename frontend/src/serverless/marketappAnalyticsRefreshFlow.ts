import type { MarketappAnalyticsPeriod, MarketappAnalyticsRefreshAdapter, MarketappAnalyticsRefreshChallenge, MarketappAnalyticsRefreshResult, MarketappAnalyticsRefreshStatus, MarketappLoginAccount, MarketappLoginProof, MarketappWalletDevice, PersonalRentalAnalytics } from '../data/types.ts';
import { isSafeMarketappChallenge, MarketappWalletFailure, safeWalletLaunchUrl } from './marketappLoginFlow.ts';
import type { MarketappLoginFailureReason, MarketappLoginWallet, MarketappLoginWalletOption, MarketappWalletFactory } from './marketappLoginFlow.ts';
import { canonicalMainnetAddress } from './walletIdentity.ts';
import { cloudRefreshRetryMetadata } from './cloudTransport.ts';
import type { CloudRetryMetadata } from './cloudTransport.ts';

const failures = {
  rate_limited: { code: 'MA-LIMIT', message: 'Wait at least one minute between wallet requests; at most five are allowed per hour.' },
  expired: { code: 'MA-EXPIRED', message: 'This wallet approval expired or was already used. Start a new refresh.' },
  access_denied: { code: 'MA-ACCESS', message: 'Open this private Mini App with the approved Telegram account.' },
  wallet_required: { code: 'MA-ADDRESS', message: 'Save a valid TON mainnet wallet address before refreshing analytics.' },
  invalid_input: { code: 'MA-REQUEST', message: 'The refresh request could not be accepted. Start a new refresh.' },
  auth_rejected: { code: 'MA-LOGIN', message: 'Marketapp did not accept the wallet login. Start a new refresh and check the selected account.' },
  page_changed: { code: 'MA-PAGE', message: 'Marketapp’s analytics page could not be read safely. You can still import a browser snapshot.' },
  preparing_timeout: { code: 'MA-PREP-TIMEOUT', message: 'Preparing wallet approval took too long. Start a new refresh.' },
  updating_timeout: { code: 'MA-UPDATE-TIMEOUT', message: 'The refresh timed out. Reload saved data before starting a new refresh.' },
  start_failed: { code: 'MA-START', message: 'The analytics refresh could not be prepared. Try again later.' },
  update_failed: { code: 'MA-UPDATE', message: 'Marketapp analytics could not be refreshed. Try again later.' },
  invalid_challenge: { code: 'MA-INIT', message: 'A valid Marketapp login request could not be prepared.' },
  invalid_response: { code: 'MA-RESPONSE', message: 'The server returned an unexpected analytics result. Reload saved data.' },
  proof_missing: { code: 'MA-PROOF', message: 'The wallet connected without the requested login proof.' },
  wallet_error: { code: 'MA-WALLET', message: 'The wallet could not complete the login proof request.' },
  wrong_network: { code: 'MA-NETWORK', message: 'Approve the login with a TON mainnet wallet.' },
  account_mismatch: { code: 'MA-ACCOUNT', message: 'The approved account address does not match your saved dashboard address.' },
  account_data_missing: { code: 'MA-ACCOUNT-DATA', message: 'The wallet did not return the account data needed for login. Try a supported wallet.' },
  chooser_unavailable: { code: 'MA-CHOOSER', message: 'The wallet list could not be loaded.' },
  launch_invalid: { code: 'MA-LINK', message: 'A safe wallet approval link could not be opened.' },
  reload_failed: { code: 'MA-RELOAD', message: 'Analytics were saved, but the dashboard could not reload them. Check saved status.' },
  result_unconfirmed: { code: 'MA-STATUS', message: 'The last refresh result is not available yet. Check saved status before trying again.' },
  status_unavailable: { code: 'MA-STATUS', message: 'The last refresh status could not be checked. Try Check status again.' },
} as const;
export type MarketappAnalyticsRefreshFailure = keyof typeof failures;
export function marketappAnalyticsRefreshFailure(reason?: MarketappAnalyticsRefreshFailure) {
  return reason && Object.hasOwn(failures, reason) ? failures[reason] : failures.update_failed;
}
const refreshFailureCodes: Record<string, MarketappAnalyticsRefreshFailure> = {
    MARKETAPP_REFRESH_RATE_LIMIT: 'rate_limited', MARKETAPP_REFRESH_EXPIRED: 'expired',
    MARKETAPP_REFRESH_INVALID_INPUT: 'invalid_input', MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED: 'access_denied',
    MARKETAPP_REFRESH_WALLET_REQUIRED: 'wallet_required', MARKETAPP_REFRESH_AUTH_REJECTED: 'auth_rejected',
    MARKETAPP_REFRESH_PAGE_CHANGED: 'page_changed', MARKETAPP_REFRESH_FAILED: 'update_failed',
};
function transportFailure(error: unknown, stage: 'start' | 'update'): MarketappAnalyticsRefreshFailure {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (typeof code === 'string' && Object.hasOwn(refreshFailureCodes, code)) return refreshFailureCodes[code];
  if (code === 'INVALID_RESPONSE') return 'invalid_response';
  if (code === 'TIMEOUT') return stage === 'start' ? 'preparing_timeout' : 'updating_timeout';
  return stage === 'start' ? 'start_failed' : 'update_failed';
}
function walletFailure(reason?: MarketappLoginFailureReason): MarketappAnalyticsRefreshFailure {
  if (reason === 'proof_missing') return 'proof_missing';
  if (reason === 'mainnet_required') return 'wrong_network';
  if (reason === 'launch_invalid') return 'launch_invalid';
  return 'wallet_error';
}
export interface MarketappAnalyticsRefreshView {
  phase: 'idle' | 'ready' | 'reconciling' | 'confirming' | 'interrupted' | 'preparing' | 'choosing' | 'awaiting_approval' | 'updating' | 'saved' | 'failed' | 'cancelled' | 'expired';
  periodDays?: MarketappAnalyticsPeriod;
  options?: MarketappLoginWalletOption[];
  launchUrl?: string | null;
  failure?: MarketappAnalyticsRefreshFailure;
  rateLimit?: { deadline: number; remainingSeconds: number; reason: 'cooldown' | 'hourly' };
  statusChecking?: boolean;
}
export function marketappRefreshRetryText(seconds: number): string {
  const remaining = Math.max(0, Math.ceil(seconds));
  return remaining < 60 ? `Try again in ${remaining}s` : `Try again in ~${Math.ceil(remaining / 60)}m`;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,26})(?:\.\d{1,4})?$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isoTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && date(value.slice(0, 10));

export function isSafeMarketappRefreshStatus(value: unknown): value is MarketappAnalyticsRefreshStatus {
  if (!object(value) || Object.keys(value).join(',') !== 'attempt') return false;
  if (value.attempt === null) return true;
  const attempt = value.attempt;
  if (!object(attempt) || Object.keys(attempt).some(key => !['attempt_id', 'state', 'period_days', 'updated_at', 'error_code'].includes(key)) ||
      typeof attempt.attempt_id !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.attempt_id) || typeof attempt.period_days !== 'number' || ![30, 365].includes(attempt.period_days) ||
      !isoTime(attempt.updated_at) || typeof attempt.state !== 'string' ||
      !['awaiting_approval', 'updating', 'saved', 'failed', 'expired', 'cancelled'].includes(attempt.state)) return false;
  return attempt.state === 'failed' ? typeof attempt.error_code === 'string' && Object.hasOwn(refreshFailureCodes, attempt.error_code) : attempt.error_code === undefined;
}

export function isSafeMarketappRefreshChallenge(value: unknown, wallet: string | null, periodDays: MarketappAnalyticsPeriod, now: number): value is MarketappAnalyticsRefreshChallenge {
  return object(value) && isSafeMarketappChallenge(value as unknown as MarketappAnalyticsRefreshChallenge, wallet, now) &&
    value.period_days === periodDays && typeof value.session_envelope === 'string' && value.session_envelope.length > 0 &&
    value.session_envelope.length <= 16500 && value.session_envelope.length % 2 === 0 && /^[a-f0-9]+$/.test(value.session_envelope);
}

/** Check identity and normalized data before reporting a completed refresh. */
export function isSafeMarketappRefreshResult(value: unknown, challenge: MarketappAnalyticsRefreshChallenge, now = Date.now()): value is MarketappAnalyticsRefreshResult {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'analytics_refreshed,attempt_id,authenticated,snapshot' ||
      value.attempt_id !== challenge.attempt_id || value.authenticated !== true || value.analytics_refreshed !== true || !object(value.snapshot)) return false;
  const snapshot = value.snapshot;
  if (snapshot.version !== 1 || snapshot.source !== 'marketapp_personal_rent_page' || snapshot.timezone !== 'UTC' || snapshot.currency !== 'GRAM' ||
      snapshot.volume_basis !== 'gross_before_fees' || typeof snapshot.source_url !== 'string' || snapshot.source_url.includes('#') || canonicalMainnetAddress(snapshot.wallet) !== canonicalMainnetAddress(challenge.wallet) ||
      typeof snapshot.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint) || typeof snapshot.captured_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(snapshot.captured_at) ||
      !date(snapshot.captured_at.slice(0, 10)) || !Number.isFinite(Date.parse(snapshot.captured_at)) || !date(snapshot.period_start) || !date(snapshot.period_end) ||
      !Array.isArray(snapshot.daily) || snapshot.daily.length !== challenge.period_days || !object(snapshot.summary)) return false;
  const captured = Date.parse(snapshot.captured_at), started = Date.parse(challenge.expires_at) - 300000;
  if (!Number.isFinite(started) || captured < started || captured > now + 30000 || snapshot.period_end !== snapshot.captured_at.slice(0, 10)) return false;
  const start = Date.parse(snapshot.period_start), end = Date.parse(snapshot.period_end);
  if (end - start !== (challenge.period_days - 1) * 86400000) return false;
  try {
    const source = new URL(String(snapshot.source_url)), address = /^\/user\/([^/]+)\/$/.exec(source.pathname)?.[1];
    const parameters = [...source.searchParams.entries()];
    if (source.origin !== 'https://marketapp.org' || source.username || source.password || source.hash || !address ||
        canonicalMainnetAddress(decodeURIComponent(address)) !== canonicalMainnetAddress(challenge.wallet) || parameters.length !== 3 ||
        source.searchParams.getAll('tab').length !== 1 || source.searchParams.get('tab') !== 'analytics_rent' ||
        source.searchParams.getAll('period_by').length !== 1 || source.searchParams.get('period_by') !== `last${challenge.period_days}days` ||
        source.searchParams.getAll('group_by').length !== 1 || source.searchParams.get('group_by') !== 'day') return false;
  } catch { return false; }
  const summary = snapshot.summary;
  if (!decimal(summary.rent_volume) || !count(summary.rentals) || !count(summary.new_rentals) || !count(summary.extensions) || summary.rentals !== summary.new_rentals + summary.extensions ||
      (summary.items !== null && !count(summary.items)) || (summary.spending_rentals !== null && !count(summary.spending_rentals)) ||
      ['price_per_day', 'average_duration', 'extension_percent', 'spent_on_rent'].some(key => summary[key] !== null && !decimal(summary[key]))) return false;
  let rentals = 0, newRentals = 0, extensions = 0;
  for (let index = 0; index < snapshot.daily.length; index++) {
    const day = snapshot.daily[index];
    if (!object(day) || day.date !== new Date(start + index * 86400000).toISOString().slice(0, 10) || !decimal(day.rent_volume) ||
        !count(day.rentals) || !count(day.new_rentals) || !count(day.extensions) || day.rentals !== day.new_rentals + day.extensions) return false;
    rentals += day.rentals; newRentals += day.new_rentals; extensions += day.extensions;
  }
  return rentals === summary.rentals && newRentals === summary.new_rentals && extensions === summary.extensions;
}

function hasAccountData(account: MarketappLoginAccount, device?: MarketappWalletDevice): account is MarketappLoginAccount & { walletStateInit: string; publicKey: string } {
  return typeof account.walletStateInit === 'string' && account.walletStateInit.length > 0 && account.walletStateInit.length <= 16384 &&
    typeof account.publicKey === 'string' && /^[a-f0-9]{64}$/i.test(account.publicKey) && Boolean(device &&
      ['platform', 'appName', 'appVersion'].every(key => typeof device[key as 'platform'] === 'string' && device[key as 'platform'].length > 0 && device[key as 'platform'].length <= 128) &&
      Number.isSafeInteger(device.maxProtocolVersion) && device.maxProtocolVersion > 0 && Array.isArray(device.features) && device.features.length <= 32);
}
interface Attempt {
  active: boolean; approvalPending: boolean; periodDays: MarketappAnalyticsPeriod; abort: AbortController;
  challenge: MarketappAnalyticsRefreshChallenge | null; wallet: MarketappLoginWallet | null; timer?: ReturnType<typeof setTimeout>;
}
export function createMarketappAnalyticsRefreshController(transport: MarketappAnalyticsRefreshAdapter, walletFactory: MarketappWalletFactory,
  savedWallet: string | null, update: (view: MarketappAnalyticsRefreshView) => void, onSaved: (snapshot: PersonalRentalAnalytics) => Promise<void>,
  clock: { now(): number; timer(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clear(handle: ReturnType<typeof setTimeout>): void } = {
    now: () => Date.now(), timer: (callback, ms) => globalThis.setTimeout(callback, ms), clear: handle => globalThis.clearTimeout(handle),
  }, onRecoveredSaved?: () => Promise<void>) {
  let current: Attempt | null = null, disposed = false;
  let limitDeadline: number | null = null, limitTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, statusGeneration = 0, statusAbort: AbortController | null = null;
  let statusDeadline: ReturnType<typeof setTimeout> | undefined, statusPoll: ReturnType<typeof setTimeout> | undefined;
  let recoveryStarted: number | null = null, recoveryPolls = 0, serverPending = false, recoveredSavedId: string | null = null;
  let view: MarketappAnalyticsRefreshView = { phase: 'idle' };
  const emit = (next: MarketappAnalyticsRefreshView) => { view = next; if (!disposed) update(next); };
  const clearStatus = () => {
    statusGeneration++; statusAbort?.abort(); statusAbort = null;
    if (statusDeadline !== undefined) clock.clear(statusDeadline);
    if (statusPoll !== undefined) clock.clear(statusPoll);
    statusDeadline = undefined; statusPoll = undefined;
  };
  const clearLimit = () => {
    if (limitTimer !== undefined) clock.clear(limitTimer);
    limitTimer = undefined; limitDeadline = null;
  };
  const showLimit = (periodDays: MarketappAnalyticsPeriod, metadata: CloudRetryMetadata) => {
    clearLimit(); const deadline = clock.now() + metadata.retryAfterSeconds * 1000; limitDeadline = deadline;
    const tick = () => {
      if (disposed || limitDeadline !== deadline) return;
      const remainingSeconds = Math.max(0, Math.ceil((deadline - clock.now()) / 1000));
      if (!remainingSeconds) { clearLimit(); emit({ phase: 'ready', periodDays }); return; }
      emit({ phase: 'failed', periodDays, failure: 'rate_limited', rateLimit: { deadline, remainingSeconds, reason: metadata.limitReason } });
      try { limitTimer = clock.timer(tick, Math.min(1000, deadline - clock.now())); }
      catch { /* The next explicit action still checks the saved deadline. */ }
    };
    tick();
  };
  const isCurrent = (attempt: Attempt) => !disposed && current === attempt && attempt.active;
  const cancelRemote = async (id: string) => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { timer = clock.timer(() => abort.abort(), 10000); await transport.cancel(id, abort.signal); } catch { /* The attempt expires independently. */ }
    finally { if (timer !== undefined) clock.clear(timer); }
  };
  const close = (attempt: Attempt, cancel: boolean) => {
    attempt.active = false; attempt.abort.abort(); if (attempt.timer !== undefined) clock.clear(attempt.timer);
    const wallet = attempt.wallet, challenge = attempt.challenge; attempt.wallet = null; attempt.challenge = null;
    if (current === attempt) current = null;
    if (wallet) void wallet.close().catch(() => undefined);
    if (cancel && challenge) void cancelRemote(challenge.attempt_id);
  };
  const end = (attempt: Attempt, phase: 'failed' | 'cancelled' | 'expired', failure: MarketappAnalyticsRefreshFailure = 'wallet_error', retry?: CloudRetryMetadata | null) => {
    if (!isCurrent(attempt)) return; close(attempt, true);
    serverPending = false;
    if (phase === 'failed' && failure === 'rate_limited' && retry) { showLimit(attempt.periodDays, retry); return; }
    emit(phase === 'failed' ? { phase, periodDays: attempt.periodDays, failure } : { phase, periodDays: attempt.periodDays });
  };
  const reloadSaved = async (periodDays: MarketappAnalyticsPeriod, id: string, reload: () => Promise<void>) => {
    const token = generation; emit({ phase: 'saved', periodDays });
    try { await reload(); if (!disposed && generation === token) recoveredSavedId = id; }
    catch { if (!disposed && generation === token) emit({ phase: 'saved', periodDays, failure: 'reload_failed' }); }
  };
  async function reconcile(): Promise<boolean> {
    if (disposed || !transport.getStatus || statusAbort || (limitDeadline !== null && limitDeadline > clock.now())) return false;
    if (statusPoll !== undefined) clock.clear(statusPoll); statusPoll = undefined;
    const abort = new AbortController(), token = ++statusGeneration, ownerGeneration = generation, owner = current;
    statusAbort = abort;
    if (!owner && view.phase === 'idle') emit({ phase: 'reconciling' });
    else emit({ ...view, statusChecking: true });
    const activeRead = () => !disposed && token === statusGeneration && ownerGeneration === generation && current === owner;
    const statusError = () => {
      if (!activeRead()) return;
      if (owner) { const { statusChecking: _checking, ...previous } = view; emit(previous); }
      else { serverPending = false; emit({ phase: 'failed', periodDays: view.periodDays, failure: 'status_unavailable' }); }
    };
    try {
      statusDeadline = clock.timer(() => { statusError(); statusGeneration++; statusAbort = null; abort.abort(); }, 15000);
      const result = await transport.getStatus(abort.signal);
      if (!activeRead()) return false;
      if (!isSafeMarketappRefreshStatus(result)) { statusError(); return false; }
      const attempt = result.attempt;
      if (!attempt) {
        serverPending = false;
        if (view.phase === 'reconciling') emit({ phase: 'idle' }); else { const { statusChecking: _checking, ...previous } = view; emit(previous); }
        return true;
      }
      if (owner && (!owner.challenge || owner.challenge.attempt_id !== attempt.attempt_id)) { const { statusChecking: _checking, ...previous } = view; emit(previous); return true; }
      if (attempt.state === 'awaiting_approval') {
        serverPending = false;
        if (!owner) emit({ phase: 'interrupted', periodDays: attempt.period_days });
        else { const { statusChecking: _checking, ...previous } = view; emit(previous); }
      } else if (attempt.state === 'updating') {
        serverPending = true; recoveryStarted ??= clock.now(); recoveryPolls++;
        if (!owner) emit({ phase: 'confirming', periodDays: attempt.period_days });
        else { const { statusChecking: _checking, ...previous } = view; emit(previous); }
        if (clock.now() - recoveryStarted < 120000 && recoveryPolls < 24) statusPoll = clock.timer(() => { statusPoll = undefined; void reconcile(); }, 5000);
        else if (!owner) { serverPending = false; emit({ phase: 'failed', periodDays: attempt.period_days, failure: 'result_unconfirmed' }); }
      } else {
        serverPending = false; recoveryStarted = null; recoveryPolls = 0;
        if (owner) close(owner, false);
        if (attempt.state === 'saved') {
          if (recoveredSavedId === attempt.attempt_id) emit({ phase: 'saved', periodDays: attempt.period_days });
          else await reloadSaved(attempt.period_days, attempt.attempt_id, onRecoveredSaved ?? (() => Promise.resolve()));
        } else if (attempt.state === 'failed') emit({ phase: 'failed', periodDays: attempt.period_days, failure: refreshFailureCodes[attempt.error_code!] });
        else emit({ phase: attempt.state, periodDays: attempt.period_days });
      }
      return true;
    } catch { statusError(); return false; }
    finally {
      if (token === statusGeneration) {
        statusAbort = null; if (statusDeadline !== undefined) clock.clear(statusDeadline); statusDeadline = undefined;
      }
    }
  }
  async function approved(attempt: Attempt, account: MarketappLoginAccount, proof: MarketappLoginProof, device?: MarketappWalletDevice) {
    if (!isCurrent(attempt) || !attempt.challenge || attempt.approvalPending) return;
    if (account.chain !== '-239') { end(attempt, 'failed', 'wrong_network'); return; }
    if (canonicalMainnetAddress(account.address) !== canonicalMainnetAddress(savedWallet)) { end(attempt, 'failed', 'account_mismatch'); return; }
    if (!hasAccountData(account, device)) { end(attempt, 'failed', 'account_data_missing'); return; }
    attempt.approvalPending = true; emit({ phase: 'updating', periodDays: attempt.periodDays });
    try {
      if (attempt.timer !== undefined) clock.clear(attempt.timer);
      attempt.timer = clock.timer(() => end(attempt, 'failed', 'updating_timeout'), 120000);
      const challenge = attempt.challenge;
      const result = await transport.finish(challenge, account, proof, device!, attempt.abort.signal);
      if (!isCurrent(attempt)) return;
      if (!isSafeMarketappRefreshResult(result, challenge, clock.now())) { end(attempt, 'failed', 'invalid_response'); return; }
      // The login session and proof are released before the dashboard is reloaded.
      const periodDays = attempt.periodDays; clearStatus(); serverPending = false; recoveryStarted = null; recoveryPolls = 0; close(attempt, false);
      await reloadSaved(periodDays, result.attempt_id, () => onSaved(result.snapshot));
    } catch (error) { end(attempt, 'failed', transportFailure(error, 'update'), cloudRefreshRetryMetadata(error)); }
  }
  return {
    get view() { return view; },
    reconcile,
    async start(periodDays: MarketappAnalyticsPeriod): Promise<boolean> {
      if (disposed || current || serverPending || ![30, 365].includes(periodDays)) return false;
      if (limitDeadline !== null && limitDeadline > clock.now()) return false;
      clearLimit(); clearStatus(); generation++; recoveryStarted = null; recoveryPolls = 0;
      const attempt: Attempt = { active: true, approvalPending: false, periodDays, abort: new AbortController(), challenge: null, wallet: null };
      current = attempt; emit({ phase: 'preparing', periodDays }); let stage: 'start' | 'chooser' = 'start';
      try {
        attempt.timer = clock.timer(() => end(attempt, 'failed', 'preparing_timeout'), 45000);
        const challenge = await transport.start(periodDays, attempt.abort.signal);
        if (!isCurrent(attempt)) { if (challenge && /^[a-f0-9]{64}$/.test(challenge.attempt_id)) void cancelRemote(challenge.attempt_id); return false; }
        attempt.challenge = challenge;
        if (!isSafeMarketappRefreshChallenge(challenge, savedWallet, periodDays, clock.now())) { end(attempt, 'failed', 'invalid_challenge'); return false; }
        if (attempt.timer !== undefined) clock.clear(attempt.timer);
        attempt.timer = clock.timer(() => end(attempt, 'expired'), Date.parse(challenge.expires_at) - clock.now()); stage = 'chooser';
        const wallet = await walletFactory(challenge, attempt.abort.signal, (account, proof, device) => { void approved(attempt, account, proof, device); },
          (phase, reason) => end(attempt, phase, walletFailure(reason)));
        if (!isCurrent(attempt)) { void wallet.close().catch(() => undefined); return false; }
        attempt.wallet = wallet;
        if (!wallet.options.length) { end(attempt, 'failed', 'chooser_unavailable'); return false; }
        emit({ phase: 'choosing', periodDays, options: wallet.options }); return true;
      } catch (error) { end(attempt, 'failed', stage === 'chooser' ? 'chooser_unavailable' : transportFailure(error, 'start'), cloudRefreshRetryMetadata(error)); return false; }
    },
    choose(id: string): string | null {
      const attempt = current;
      if (!attempt || !isCurrent(attempt) || !attempt.wallet || view.phase !== 'choosing') return null;
      try {
        emit({ phase: 'awaiting_approval', periodDays: attempt.periodDays }); const link = attempt.wallet.connect(id);
        if (!isCurrent(attempt)) return null;
        const url = link === null ? null : safeWalletLaunchUrl(link);
        if (link !== null && !url) { end(attempt, 'failed', 'launch_invalid'); return null; }
        if (!attempt.approvalPending) emit({ phase: 'awaiting_approval', periodDays: attempt.periodDays, launchUrl: url }); return url;
      } catch (error) { end(attempt, 'failed', error instanceof MarketappWalletFailure ? walletFailure(error.reason) : 'wallet_error'); return null; }
    },
    cancel() { if (current) end(current, 'cancelled'); },
    dispose() { disposed = true; generation++; clearStatus(); clearLimit(); if (current) close(current, true); },
  };
}
