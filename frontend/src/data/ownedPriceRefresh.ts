import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';

export type OwnedPriceEndpoint = 'getOwnedPriceRefresh' | 'startOwnedPriceRefresh' | 'stepOwnedPriceRefresh' | 'stopOwnedPriceRefresh'
  | 'getGiftRefresh' | 'startGiftRefresh' | 'stepGiftRefresh' | 'stopGiftRefresh';

/** Hosts supply authentication and routing; the price-check lifecycle is shared. */
export interface OwnedPriceTransport {
  /** Telegram chooses a server-authorized personal-gifts source; individual checks stay on TON. */
  portfolioRefresh?: true;
  call<T>(endpoint: OwnedPriceEndpoint, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export type GiftRefreshProvider = 'marketapp_website' | 'toncenter';
export const GIFT_REFRESH_FALLBACK_REASONS = ['no_login', 'login_expired', 'website_unavailable', 'unsupported_response', 'request_limit', 'website_disabled'] as const;
export type GiftRefreshFallbackReason = typeof GIFT_REFRESH_FALLBACK_REASONS[number];
export interface GiftRefreshVerification {
  stage: 'website' | 'ton';
  checked: number;
  total: number;
  waiting: boolean;
}

export interface OwnedPriceRun {
  id: number;
  account_generation?: number;
  /** Missing scope is a saved legacy full-portfolio check. */
  scope?: 'portfolio' | 'gift';
  nft_address?: string | null;
  wallet?: string | null;
  session_id?: string;
  state: 'running' | 'complete' | 'partial' | 'failed';
  total: number;
  checked: number;
  updated: number;
  unresolved: number;
  /** Telegram checks rental state independently of configured-price validity. */
  status_updated?: number;
  status_unresolved?: number;
  reason: string | null;
  started_at: string;
  /** Original full-portfolio check start; cache copies keep this source clock. */
  check_started_at?: string | null;
  /** Frozen wallet and NFT/collection pairs for a full portfolio check. */
  scope_signature?: string | null;
  completed_at: string | null;
}

export interface OwnedPriceResponse {
  run: OwnedPriceRun | null;
  server_time: number;
  next_allowed_at: number;
  provider?: GiftRefreshProvider;
  cache_hit?: boolean;
  fallback_reason?: GiftRefreshFallbackReason | null;
  /** Work still in progress, separate from gifts already observed on Marketapp. */
  verification?: GiftRefreshVerification;
}

export interface OwnedPriceSnapshot {
  phase: 'idle' | 'checking' | 'waiting' | 'complete' | 'partial' | 'unavailable';
  run: OwnedPriceRun | null;
  /** The requested scope remains known even when Start fails before returning a run. */
  scope?: 'portfolio' | 'gift';
  canStop: boolean;
  /** A manual restart is allowed only after every pending mutation/read settles. */
  canRefresh?: boolean;
  /** Safe actionable feedback, never an upstream exception or credential. */
  error?: string | null;
  provider?: GiftRefreshProvider;
  cacheHit?: boolean;
  fallbackReason?: GiftRefreshFallbackReason | null;
  verification?: GiftRefreshVerification;
}

export interface OwnedPriceSavedUpdate { terminal: boolean }

interface RefreshOptions {
  transport: OwnedPriceTransport;
  sessionId: string;
  onSavedDataChanged(update?: OwnedPriceSavedUpdate): void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxCalls?: number;
  maxDurationMs?: number;
  createSessionId?: () => string;
  wallet?: string | null;
  accountGeneration?: number;
  walletVerified?: boolean;
}

export function readOwnedPriceResponse(value: unknown): OwnedPriceResponse {
  const response = value as OwnedPriceResponse | null;
  const run = response?.run;
  const verification = response?.verification;
  const validTime = (time: unknown) => typeof time === 'number' && Number.isFinite(time) && time >= 0;
  const validCount = (count: unknown) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  if (!response || !validTime(response.server_time) || !validTime(response.next_allowed_at)
    || (response.provider !== undefined && !['marketapp_website', 'toncenter'].includes(response.provider))
    || (response.cache_hit !== undefined && typeof response.cache_hit !== 'boolean')
    || (response.fallback_reason !== undefined && response.fallback_reason !== null && !GIFT_REFRESH_FALLBACK_REASONS.includes(response.fallback_reason))
    || (verification !== undefined && (!verification || typeof verification !== 'object' || Array.isArray(verification)
      || Object.keys(verification).some(key => !['stage', 'checked', 'total', 'waiting'].includes(key))
      || !['website', 'ton'].includes(verification.stage) || ![verification.checked, verification.total].every(validCount)
      || verification.checked > verification.total || typeof verification.waiting !== 'boolean'
      || run?.state !== 'running' || verification.total > run.total))
    || (run !== null && (!run || !Number.isSafeInteger(run.id) || run.id <= 0
      || (run.account_generation !== undefined && (!Number.isSafeInteger(run.account_generation) || run.account_generation < 0))
      || (run.scope !== undefined && !['portfolio', 'gift'].includes(run.scope))
      || (run.wallet !== undefined && run.wallet !== null && !canonicalMainnetAddress(run.wallet))
      || (run.session_id !== undefined && (typeof run.session_id !== 'string' || !run.session_id || run.session_id.length > 160))
      || (run.scope === 'gift' && (!canonicalMainnetAddress(run.nft_address) || !canonicalMainnetAddress(run.wallet) || !run.session_id || run.total !== 1))
      || (run.scope !== 'gift' && run.nft_address !== undefined && run.nft_address !== null)
      || (run.check_started_at !== undefined && run.check_started_at !== null && typeof run.check_started_at !== 'string')
      || (run.scope_signature !== undefined && run.scope_signature !== null && (typeof run.scope_signature !== 'string' || !/^[0-9a-f]{64}$/.test(run.scope_signature)))
      || !['running', 'complete', 'partial', 'failed'].includes(run.state)
      || ![run.total, run.checked, run.updated, run.unresolved].every(validCount)
      || run.checked > run.total || run.updated > run.checked || run.unresolved > run.checked
      || [run.status_updated, run.status_unresolved].some(value => value !== undefined && (!validCount(value) || value > run.checked))
      || (run.status_updated !== undefined && run.status_unresolved !== undefined && run.status_updated + run.status_unresolved > run.checked)
      || !(run.reason === null || typeof run.reason === 'string')))) {
    throw new Error('The server returned an unexpected rent price status.');
  }
  return response;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Batch intermediate evidence reads; a final commit still requests immediate confirmation. */
export function createOwnedPriceReloadScheduler(options: {
  reload(): Promise<void>;
  isHidden(): boolean;
  delayMs?: number;
  timer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear?(handle: ReturnType<typeof setTimeout>): void;
}) {
  const timer = options.timer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clear = options.clear ?? (handle => globalThis.clearTimeout(handle));
  let scheduled: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | null = null;
  let dirty = false, disposed = false, epoch = 0;
  const unschedule = () => { if (scheduled !== undefined) clear(scheduled); scheduled = undefined; };
  const flush = (): Promise<void> => {
    unschedule();
    if (disposed || options.isHidden()) return Promise.resolve();
    if (active) {
      const owner = epoch;
      return active.then(() => owner === epoch ? flush() : undefined);
    }
    if (!dirty) return Promise.resolve();
    dirty = false;
    const owner = epoch;
    const operation = Promise.resolve().then(() => {
      if (!disposed && owner === epoch && !options.isHidden()) return options.reload();
      if (!disposed && owner === epoch) dirty = true;
    }).finally(() => { if (active === operation) active = null; });
    active = operation;
    return operation;
  };
  return {
    notify(update?: OwnedPriceSavedUpdate) {
      if (disposed) return;
      dirty = true;
      if (options.isHidden()) return;
      if (update?.terminal !== false) { void flush().catch(() => undefined); return; }
      if (scheduled === undefined) scheduled = timer(() => {
        scheduled = undefined; void flush().catch(() => undefined);
      }, options.delayMs ?? 4000);
    },
    flush,
    pause() { unschedule(); },
    cancel() { epoch++; dirty = false; unschedule(); },
    dispose() { disposed = true; epoch++; dirty = false; unschedule(); },
  };
}

const OWNED_PRICE_BUSY_MESSAGE = 'Another gift check is still finishing. Wait for it or stop it in Status, then try again.';
class OwnedPriceScopeError extends Error { readonly code = 'OWNED_PRICE_SCOPE_CHANGED'; }
function ownedPriceErrorMessage(error: unknown, targeted: boolean): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'OWNED_PRICE_BUSY') return OWNED_PRICE_BUSY_MESSAGE;
  if (code === 'OWNED_PRICE_INVALID_TARGET') return 'This gift is not eligible for a price check. Reload your gifts before trying again.';
  if (code === 'OWNED_PRICE_SCOPE_CHANGED') return 'This gift check no longer matches your saved wallet or gift. Reload your gifts before trying again.';
  if (code === 'PUBLIC_WALLET_CHANGED') return 'Wallet connection changed. Start a new gift refresh.';
  if (code === 'STORAGE_FULL') return 'Updates paused because app storage is full. Saved prices are kept.';
  if (code === 'STORAGE_CAPACITY_PAUSED') return 'Updates paused to protect saved data. Clean up storage from Status, then try again.';
  return targeted ? 'This gift could not be checked. Saved prices kept. Try again.' : 'Rent prices could not be checked. Saved prices kept.';
}

/** Bounded personal-gift checks; foreground reopen checks use a fresh automatic session. */
export class OwnedPriceRefreshDriver {
  private readonly options: RefreshOptions;
  private controller = new AbortController();
  private sessionId: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: OwnedPriceSnapshot = { phase: 'idle', run: null, canStop: false, canRefresh: true };
  private current: OwnedPriceResponse | null = null;
  private observedAt = 0;
  private started = false;
  private active: Promise<void> | null = null;
  private pending = false;
  private stopActive: Promise<void> | null = null;
  private stopRequested = false;
  private stopRequest: Promise<void> | null = null;
  private stopConfirmed = false;
  private reconciliation: Promise<void> | null = null;
  private unavailable = false;
  private waitingForCheck = false;
  private notifiedChecked = 0;
  private notifiedUpdates = 0;
  private notifiedStatuses = 0;
  private notifiedStatusUnresolved = 0;
  private target: string | null = null;
  private wallet: string | null | undefined;
  private accountGeneration: number | undefined;
  private walletVerified: boolean | undefined;
  private contextInitialized = false;
  private contextChanged = false;
  private epoch = 0;
  private error: string | null = null;
  private automatic = true;

  constructor(options: RefreshOptions) {
    this.options = options; this.sessionId = options.sessionId;
    this.wallet = options.wallet === undefined ? undefined : canonicalMainnetAddress(options.wallet) ?? options.wallet;
    this.accountGeneration = options.accountGeneration;
    this.walletVerified = options.walletVerified;
    this.contextInitialized = options.wallet !== undefined || options.accountGeneration !== undefined;
  }

  getSnapshot = (): OwnedPriceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish() {
    const run = this.current?.run ?? null;
    const phase = this.contextChanged ? 'idle' : run?.state === 'complete' ? 'complete'
      : this.unavailable || run?.state === 'failed' ? 'unavailable'
        : this.waitingForCheck ? 'waiting'
        : run?.state === 'partial' || this.controller.signal.aborted ? 'partial' : 'checking';
    this.snapshot = { phase, run, scope: this.target ? 'gift' : 'portfolio', canStop: (phase === 'checking' || phase === 'waiting' && run?.state === 'running') && !this.stopRequested, canRefresh: !this.pending && !this.stopActive,
      error: phase === 'unavailable' ? this.error : null,
      ...(this.current?.provider ? { provider: this.current.provider } : {}),
      ...(this.current?.cache_hit !== undefined ? { cacheHit: this.current.cache_hit } : {}),
      ...(this.current?.fallback_reason !== undefined ? { fallbackReason: this.current.fallback_reason } : {}),
      ...(this.current?.verification ? { verification: this.current.verification } : {}) };
    for (const listener of this.listeners) listener();
  }

  /** Identity changes discard late responses without releasing the pending-request fence. */
  setContext(wallet: string | null, accountGeneration?: number, walletVerified?: boolean): void {
    const nextWallet = canonicalMainnetAddress(wallet) ?? wallet;
    const changed = this.contextInitialized && (nextWallet !== this.wallet || accountGeneration !== this.accountGeneration || walletVerified !== this.walletVerified);
    this.wallet = nextWallet; this.accountGeneration = accountGeneration; this.walletVerified = walletVerified; this.contextInitialized = true;
    if (!changed) return;
    this.epoch++; this.controller.abort(); this.started = true; this.current = null;
    this.observedAt = 0; this.notifiedChecked = 0; this.notifiedUpdates = 0;
    this.notifiedStatuses = 0; this.notifiedStatusUnresolved = 0;
    this.error = null; this.unavailable = false; this.waitingForCheck = false; this.contextChanged = true;
    this.publish();
  }

  private matchesScope(run: OwnedPriceRun): boolean {
    if ((run.scope ?? 'portfolio') !== (this.target ? 'gift' : 'portfolio')) return false;
    if (this.target && (canonicalMainnetAddress(run.nft_address) !== this.target || run.session_id !== this.sessionId)) return false;
    if (!this.target && this.options.transport.portfolioRefresh && run.session_id !== this.sessionId) return false;
    if (this.accountGeneration !== undefined && run.account_generation !== this.accountGeneration) return false;
    if (run.wallet !== undefined && this.wallet !== undefined && canonicalMainnetAddress(run.wallet) !== canonicalMainnetAddress(this.wallet)) return false;
    return true;
  }

  private accept(response: OwnedPriceResponse, epoch = this.epoch): boolean {
    if (epoch !== this.epoch) return false;
    if (response.run && !this.matchesScope(response.run)) throw new OwnedPriceScopeError();
    if (this.current?.run && (response.run?.id !== this.current.run.id || response.run?.account_generation !== this.current.run.account_generation)) return false;
    // A stop response can precede a pending step's commit. Keep confirmed counts
    // even if the later read observes an older snapshot of the same run.
    if (this.current?.run && response.run && response.run.checked < this.current.run.checked) {
      response = { ...response, run: { ...response.run,
        checked: this.current.run.checked, updated: this.current.run.updated, unresolved: this.current.run.unresolved,
      } };
    }
    const previousState = this.current?.run?.state;
    this.current = response;
    if (response.run && response.run.state !== 'running') this.waitingForCheck = false;
    this.observedAt = (this.options.now ?? Date.now)();
    // Unresolved checks also save observation freshness and historical-price
    // warnings, even when no numeric amount changed.
    // Supplemental TON evidence can update only expiry after the website has
    // already checked every gift. Its final commit must still reload saved
    // data even when price/check counters remain unchanged.
    const completedEvidence = response.run && response.run.checked > 0 && previousState === 'running' && response.run.state !== 'running';
    const reusedComplete = previousState === undefined && response.cache_hit === true && response.run?.state === 'complete';
    if (!reusedComplete && response.run && (response.run.checked > this.notifiedChecked || response.run.updated > this.notifiedUpdates
      || (response.run.status_updated ?? 0) > this.notifiedStatuses || (response.run.status_unresolved ?? 0) > this.notifiedStatusUnresolved
      || completedEvidence)) this.options.onSavedDataChanged({ terminal: response.run.state !== 'running' });
    this.notifiedChecked = Math.max(this.notifiedChecked, response.run?.checked ?? 0);
    this.notifiedUpdates = Math.max(this.notifiedUpdates, response.run?.updated ?? 0);
    this.notifiedStatuses = Math.max(this.notifiedStatuses, response.run?.status_updated ?? 0);
    this.notifiedStatusUnresolved = Math.max(this.notifiedStatusUnresolved, response.run?.status_unresolved ?? 0);
    this.publish();
    return true;
  }

  /** Repeated valid-dashboard notifications and StrictMode effects share this start. */
  start(): Promise<void> {
    if (this.started) return this.active ?? Promise.resolve();
    this.started = true;
    this.pending = true;
    this.publish();
    this.active = this.execute().finally(() => {
      this.pending = false;
      this.active = null;
      this.publish();
    });
    return this.active;
  }

  /** Explicit only. Repeated clicks join pending work; they never queue a retry. */
  refresh(): Promise<void> {
    if ((this.pending || this.stopActive) && this.target) return Promise.reject(new Error(OWNED_PRICE_BUSY_MESSAGE));
    if (this.pending || this.stopActive) return this.active ?? this.stopActive ?? Promise.resolve();
    return this.fresh(null);
  }

  /** A retained Telegram page may reopen hours later. Never retry unfinished or uncertain work. */
  reopen(): Promise<void> {
    if (this.pending || this.stopActive || this.stopRequested || this.unavailable || this.contextChanged
      || this.current?.run?.state !== 'complete' || this.current.run.reason !== null)
      return Promise.resolve();
    return this.fresh(null, true);
  }

  /** A duplicate click joins this gift only; a different check never gets adopted. */
  refreshGift(nftAddress: string): Promise<void> {
    const target = canonicalMainnetAddress(nftAddress);
    if (!target || !canonicalMainnetAddress(this.wallet)) return Promise.reject(new Error('A verified TON mainnet wallet and gift address are required.'));
    if (this.pending || this.stopActive) {
      if (!this.contextChanged && target === this.target && this.active && !this.stopActive) return this.active;
      return Promise.reject(new Error(OWNED_PRICE_BUSY_MESSAGE));
    }
    return this.fresh(target);
  }

  private fresh(target: string | null, automatic = false): Promise<void> {
    const sessionId = (this.options.createSessionId ?? (() => crypto.randomUUID()))();
    if (typeof sessionId !== 'string' || !sessionId || sessionId === this.sessionId) return Promise.resolve();
    // No previous response can still arrive: execute() includes reconciliation
    // and explicit Stop has its own pending fence.
    this.sessionId = sessionId;
    this.target = target;
    this.automatic = automatic;
    this.controller = new AbortController();
    this.current = null;
    this.observedAt = 0;
    this.started = false;
    this.stopRequested = false;
    this.stopRequest = null;
    this.stopConfirmed = false;
    this.reconciliation = null;
    this.unavailable = false;
    this.waitingForCheck = false;
    this.contextChanged = false;
    this.error = null;
    this.notifiedChecked = 0;
    this.notifiedUpdates = 0;
    this.notifiedStatuses = 0;
    this.notifiedStatusUnresolved = 0;
    return this.start();
  }

  /** Hiding the page ends this session's work without stopping another client's run. */
  interrupt(): void {
    this.started = true;
    this.controller.abort();
    if (this.snapshot.phase !== 'idle') this.publish();
  }

  private endpoint(operation: 'get' | 'start' | 'step' | 'stop'): OwnedPriceEndpoint {
    return `${operation}${!this.target && this.options.transport.portfolioRefresh ? 'GiftRefresh' : 'OwnedPriceRefresh'}` as OwnedPriceEndpoint;
  }

  private reconcile(epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch) return Promise.resolve();
    if (!this.reconciliation) this.reconciliation = (async () => {
      try { this.accept(readOwnedPriceResponse(await this.options.transport.call(this.endpoint('get'),
        this.target || this.options.transport.portfolioRefresh ? { session_id: this.sessionId } : undefined)), epoch); }
      catch { /* Retain cached progress; an uncertain mutation is never repeated. */ }
    })();
    return this.reconciliation;
  }

  private stopSavedRun(epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch) return Promise.resolve();
    if (this.stopRequest) return this.stopRequest;
    const run = this.current?.run;
    if (!run || run.state !== 'running') return Promise.resolve();
    this.stopRequest = (async () => {
      try {
        const response = readOwnedPriceResponse(await this.options.transport.call(this.endpoint('stop'), { run_id: run.id,
          ...(!this.target && this.options.transport.portfolioRefresh ? { session_id: this.sessionId } : {}),
          ...(run.account_generation !== undefined ? { account_generation: run.account_generation } : {}) }));
        if (this.accept(response, epoch) && response.run && response.run.state !== 'running') {
          this.stopConfirmed = true; this.unavailable = false; this.error = null; this.publish();
        }
      }
      catch { if (epoch === this.epoch) { this.unavailable = true; this.publish(); } }
    })();
    return this.stopRequest;
  }

  /** Stop is explicit. A pending Start is stopped after its run ID becomes known. */
  stop(): Promise<void> {
    if (this.stopActive) return this.stopActive;
    this.stopRequested = true;
    const epoch = this.epoch;
    this.interrupt();
    this.stopActive = (async () => {
      await this.stopSavedRun(epoch);
      // execute() reconciles after any pending mutation has settled.
      if (!this.active) await this.reconcile(epoch);
    })().finally(() => {
      this.stopActive = null;
      this.publish();
    });
    this.publish();
    return this.stopActive;
  }

  private async execute(): Promise<void> {
    const epoch = this.epoch;
    const controller = this.controller;
    const now = this.options.now ?? Date.now;
    const wait = this.options.wait ?? delay;
    const deadline = now() + Math.min(this.options.maxDurationMs ?? 120000, 120000);
    const maxCalls = Math.min(this.options.maxCalls ?? 60, 60);
    let calls = 0;
    try {
      const response = readOwnedPriceResponse(await this.options.transport.call(this.endpoint('start'), { session_id: this.sessionId,
        ...(!this.target && this.options.transport.portfolioRefresh ? { automatic: this.automatic } : {}),
        ...(this.target ? { nft_address: this.target } : {}) }));
      if (!response.run) throw new Error('A rent price refresh did not return a run.');
      if (!this.accept(response, epoch)) return;
      if (this.stopRequested) await this.stopSavedRun(epoch);
      while (epoch === this.epoch && !controller.signal.aborted && this.current?.run?.state === 'running') {
        // Pacing is relative to the response's server clock, never the device clock.
        const remaining = this.current.next_allowed_at - this.current.server_time - (now() - this.observedAt);
        if (calls >= maxCalls || now() >= deadline || remaining >= deadline - now()) {
          this.interrupt();
          break;
        }
        if (remaining > 0) { await wait(Math.min(remaining, 1000), controller.signal); continue; }
        calls += 1;
        // Keep a possibly committed response observable; only waits are abortable.
        const next = readOwnedPriceResponse(await this.options.transport.call(this.endpoint('step'), { run_id: this.current.run.id,
          ...(!this.target && this.options.transport.portfolioRefresh ? { session_id: this.sessionId } : {}),
          ...(this.current.run.account_generation !== undefined ? { account_generation: this.current.run.account_generation } : {}) }));
        if (epoch !== this.epoch) return;
        if (!next.run || next.run.id !== this.current.run.id || next.run.account_generation !== this.current.run.account_generation) throw new OwnedPriceScopeError();
        if (this.stopRequested && this.current.run.state !== 'running') {
          this.accept({ ...next, run: { ...next.run, state: this.current.run.state,
            reason: this.current.run.reason, completed_at: this.current.run.completed_at,
          } });
        } else this.accept(next);
      }
    } catch (error) {
      if (epoch === this.epoch) {
        // A rejected concurrent request is not a failed check. Reconcile only
        // this exact session; never retry or take over somebody else's run.
        this.waitingForCheck = Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'OWNED_PRICE_BUSY');
        this.unavailable = !this.waitingForCheck;
        this.error = this.waitingForCheck ? null : ownedPriceErrorMessage(error, Boolean(this.target));
        this.interrupt();
      }
    } finally {
      if (epoch === this.epoch && controller.signal.aborted) {
        if (this.stopRequest) await this.stopRequest;
        await this.reconcile(epoch);
        // An uncertain Start may commit without returning its run ID. Explicit
        // Stop still applies after the exact-session status read reveals it.
        if (this.stopRequested) {
          await this.stopSavedRun(epoch);
          if (epoch === this.epoch && this.stopConfirmed && this.current?.run?.state !== 'running') {
            this.unavailable = false; this.error = null; this.publish();
          }
        }
      }
    }
  }
}

/** Refresh permission comes from saved server capabilities, independently of wallet-app connectivity. */
export function savedGiftRefreshEnabled(mode: 'local' | 'serverless' | undefined, capabilities?: { personal_gift_refresh?: boolean; owned_price_refresh?: boolean }): boolean {
  return capabilities?.owned_price_refresh === true || (mode === 'serverless' && capabilities?.personal_gift_refresh === true);
}

/** Hidden preloads wait. Telegram may recheck after a long absence, without resuming interrupted work. */
export function createOwnedPriceStartupGate(
  driver: Pick<OwnedPriceRefreshDriver, 'start' | 'interrupt'> & Partial<Pick<OwnedPriceRefreshDriver, 'reopen'>>,
  isHidden: () => boolean,
  options: { reopenAfterMs?: number; now?: () => number } = {},
) {
  let ready = false;
  let attempted = false;
  let disposed = false;
  let hiddenAt: number | null = null;
  const now = options.now ?? Date.now;
  const startIfVisible = () => {
    if (!ready || disposed || isHidden()) return;
    const previousHiddenAt = hiddenAt;
    hiddenAt = null;
    if (!attempted) {
      attempted = true;
      void driver.start();
    } else if (previousHiddenAt !== null && options.reopenAfterMs !== undefined
      && options.reopenAfterMs >= 300000 && now() - previousHiddenAt >= options.reopenAfterMs) {
      void driver.reopen?.();
    }
  };
  const interrupt = () => { hiddenAt ??= now(); if (attempted) driver.interrupt(); };
  return {
    dashboardLoaded(enabled: boolean) { ready = enabled; startIfVisible(); },
    visibilityChanged() { if (isHidden()) interrupt(); else startIfVisible(); },
    interrupt,
    manualRefresh(refresh: () => Promise<void>, authorized = false) {
      if ((!ready && !authorized) || disposed || isHidden()) return Promise.resolve();
      hiddenAt = null;
      attempted = true;
      return refresh();
    },
    dispose() { disposed = true; interrupt(); },
  };
}

export function ownedPriceStatusText(snapshot: OwnedPriceSnapshot): string {
  const { run, phase } = snapshot;
  if (phase === 'idle') return '';
  if (phase === 'waiting') return 'Another gift check is still finishing. Your saved data is kept. Try Refresh again shortly.';
  if (snapshot.error) return snapshot.error;
  if (run?.scope === 'gift') {
    if (phase === 'checking') return 'Checking this gift…';
    if (phase === 'complete') return run.unresolved ? 'This gift could not be verified. Saved prices kept.' : 'Gift price and rental status checked.';
    if (phase === 'partial') return 'Gift check incomplete. Saved prices kept.';
    return 'This gift could not be checked. Saved prices kept.';
  }
  if (snapshot.provider) {
    if (phase === 'checking' && snapshot.verification?.stage === 'ton') {
      const verification = snapshot.verification;
      if (verification.waiting) return snapshot.provider === 'marketapp_website'
        ? 'TON requested a pause. Saved gift data is already available.' : 'TON requested a pause before continuing gift checks.';
      if (verification.total > 0 && verification.checked === verification.total) return 'Finishing gift checks…';
      return `${snapshot.provider === 'marketapp_website' ? 'Checking additional gift details' : 'Checking your gifts on TON'} · ${verification.checked}/${verification.total}`;
    }
    if (phase === 'checking' && run && run.total > 0 && run.checked === run.total) return 'Finishing gift checks…';
    if (phase === 'checking') return run ? `Refreshing your gifts · ${run.checked}/${run.total}` : 'Refreshing your gifts…';
    if (phase === 'complete') return snapshot.cacheHit ? 'Your gifts were checked recently.'
      : run?.total === 0 ? 'No saved gifts to refresh.' : `Your gifts refreshed · ${run?.checked ?? 0}/${run?.total ?? 0}${run?.unresolved ? ` · ${run.unresolved} unresolved; saved prices kept` : ''}`;
    if (phase === 'partial') return run?.reason === 'provider_wait' || run?.reason === 'retry_wait'
      ? `${snapshot.provider === 'marketapp_website' ? 'TON' : 'The provider'} requested a pause. Saved gift data is kept. Try refreshing again later.`
      : `Gift refresh incomplete${run ? ` · ${run.checked}/${run.total}` : ''}. Saved data kept.`;
    return 'Gift refresh unavailable. Saved data kept.';
  }
  if (phase === 'checking') return run ? `Checking your rent prices · ${run.checked}/${run.total}` : 'Checking your rent prices…';
  if (phase === 'complete') return run?.total === 0 ? 'No saved gifts need a rent price check.'
    : `Rent prices checked · ${run?.checked ?? 0}/${run?.total ?? 0}${run?.unresolved ? ` · ${run.unresolved} unresolved; saved prices kept` : ''}`;
  if (phase === 'partial') return `Rent price check incomplete${run ? ` · ${run.checked}/${run.total}` : ''}${run?.unresolved ? ` · ${run.unresolved} unresolved` : ''}. Saved prices kept.`;
  return `Rent price check unavailable${run ? ` · ${run.checked}/${run.total} checked` : ''}. Saved prices kept.`;
}

/** Provider feedback stays fixed and never reflects website or authentication responses. */
export function giftRefreshSourceText(snapshot: OwnedPriceSnapshot): string | null {
  if (snapshot.provider === 'marketapp_website') return snapshot.cacheHit
    ? 'Recent Marketapp gift data reused. No new provider requests.'
    : snapshot.verification?.stage === 'ton' ? 'Source: your signed-in Marketapp gifts page, with additional TON checks for missing details and rental expiry.'
      : 'Source: your signed-in Marketapp gifts page.';
  if (snapshot.provider !== 'toncenter') return null;
  const fallback: Record<GiftRefreshFallbackReason, string> = {
    no_login: 'No remembered Marketapp login.',
    login_expired: 'Marketapp login expired.',
    website_unavailable: 'Marketapp is temporarily unavailable.',
    unsupported_response: 'Marketapp gift data could not be read safely.',
    request_limit: 'The Marketapp refresh allowance is unavailable.',
    website_disabled: 'Marketapp gift refresh is not enabled for this account yet.',
  };
  const prefix = snapshot.fallbackReason ? fallback[snapshot.fallbackReason] : null;
  return snapshot.cacheHit ? 'Recent TON gift checks reused. No new provider requests.'
    : `${prefix ? `${prefix} ` : ''}Source: TON checks of your saved gifts.`;
}
