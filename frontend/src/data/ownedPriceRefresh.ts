export type OwnedPriceEndpoint = 'getOwnedPriceRefresh' | 'startOwnedPriceRefresh' | 'stepOwnedPriceRefresh' | 'stopOwnedPriceRefresh';

/** Hosts supply authentication and routing; the price-check lifecycle is shared. */
export interface OwnedPriceTransport {
  call<T>(endpoint: OwnedPriceEndpoint, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export interface OwnedPriceRun {
  id: number;
  state: 'running' | 'complete' | 'partial' | 'failed';
  total: number;
  checked: number;
  updated: number;
  unresolved: number;
  reason: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface OwnedPriceResponse {
  run: OwnedPriceRun | null;
  server_time: number;
  next_allowed_at: number;
}

export interface OwnedPriceSnapshot {
  phase: 'idle' | 'checking' | 'complete' | 'partial' | 'unavailable';
  run: OwnedPriceRun | null;
  canStop: boolean;
}

interface RefreshOptions {
  transport: OwnedPriceTransport;
  sessionId: string;
  onSavedDataChanged(): void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxCalls?: number;
  maxDurationMs?: number;
}

export function readOwnedPriceResponse(value: unknown): OwnedPriceResponse {
  const response = value as OwnedPriceResponse | null;
  const run = response?.run;
  const validTime = (time: unknown) => typeof time === 'number' && Number.isFinite(time) && time >= 0;
  const validCount = (count: unknown) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  if (!response || !validTime(response.server_time) || !validTime(response.next_allowed_at)
    || (run !== null && (!run || !Number.isSafeInteger(run.id) || run.id <= 0
      || !['running', 'complete', 'partial', 'failed'].includes(run.state)
      || ![run.total, run.checked, run.updated, run.unresolved].every(validCount)
      || run.checked > run.total || run.updated > run.checked || run.unresolved > run.checked
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

/** One bounded, independent TON price refresh per page session. Never drives Marketapp jobs. */
export class OwnedPriceRefreshDriver {
  private readonly options: RefreshOptions;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private snapshot: OwnedPriceSnapshot = { phase: 'idle', run: null, canStop: false };
  private current: OwnedPriceResponse | null = null;
  private observedAt = 0;
  private started = false;
  private active: Promise<void> | null = null;
  private stopRequested = false;
  private stopRequest: Promise<void> | null = null;
  private reconciliation: Promise<void> | null = null;
  private unavailable = false;
  private notifiedChecked = 0;
  private notifiedUpdates = 0;

  constructor(options: RefreshOptions) { this.options = options; }

  getSnapshot = (): OwnedPriceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish() {
    const run = this.current?.run ?? null;
    const phase = run?.state === 'complete' ? 'complete'
      : this.unavailable || run?.state === 'failed' ? 'unavailable'
        : run?.state === 'partial' || this.controller.signal.aborted ? 'partial' : 'checking';
    this.snapshot = { phase, run, canStop: phase === 'checking' && !this.stopRequested };
    for (const listener of this.listeners) listener();
  }

  private accept(response: OwnedPriceResponse) {
    if (this.current?.run && response.run?.id !== this.current.run.id) return;
    // A stop response can precede a pending step's commit. Keep confirmed counts
    // even if the later read observes an older snapshot of the same run.
    if (this.current?.run && response.run && response.run.checked < this.current.run.checked) {
      response = { ...response, run: { ...response.run,
        checked: this.current.run.checked, updated: this.current.run.updated, unresolved: this.current.run.unresolved,
      } };
    }
    this.current = response;
    this.observedAt = (this.options.now ?? Date.now)();
    // Unresolved checks also save observation freshness and historical-price
    // warnings, even when no numeric amount changed.
    if (response.run && (response.run.checked > this.notifiedChecked || response.run.updated > this.notifiedUpdates)) this.options.onSavedDataChanged();
    this.notifiedChecked = Math.max(this.notifiedChecked, response.run?.checked ?? 0);
    this.notifiedUpdates = Math.max(this.notifiedUpdates, response.run?.updated ?? 0);
    this.publish();
  }

  /** Repeated valid-dashboard notifications and StrictMode effects share this start. */
  start(): Promise<void> {
    if (this.started) return this.active ?? Promise.resolve();
    this.started = true;
    this.publish();
    this.active = this.execute();
    return this.active;
  }

  /** Hiding the page ends this session's work without stopping another client's run. */
  interrupt(): void {
    this.started = true;
    this.controller.abort();
    if (this.snapshot.phase !== 'idle') this.publish();
  }

  private reconcile(): Promise<void> {
    if (!this.reconciliation) this.reconciliation = (async () => {
      try { this.accept(readOwnedPriceResponse(await this.options.transport.call('getOwnedPriceRefresh'))); }
      catch { /* Retain cached progress; an uncertain mutation is never repeated. */ }
    })();
    return this.reconciliation;
  }

  private stopSavedRun(): Promise<void> {
    if (this.stopRequest) return this.stopRequest;
    const run = this.current?.run;
    if (!run || run.state !== 'running') return Promise.resolve();
    this.stopRequest = (async () => {
      try { this.accept(readOwnedPriceResponse(await this.options.transport.call('stopOwnedPriceRefresh', { run_id: run.id }))); }
      catch { this.unavailable = true; this.publish(); }
    })();
    return this.stopRequest;
  }

  /** Stop is explicit. A pending Start is stopped after its run ID becomes known. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.interrupt();
    await this.stopSavedRun();
    // execute() reconciles after any pending mutation has settled.
    if (!this.active) await this.reconcile();
  }

  private async execute(): Promise<void> {
    const now = this.options.now ?? Date.now;
    const wait = this.options.wait ?? delay;
    const deadline = now() + Math.min(this.options.maxDurationMs ?? 120000, 120000);
    const maxCalls = Math.min(this.options.maxCalls ?? 60, 60);
    let calls = 0;
    try {
      const response = readOwnedPriceResponse(await this.options.transport.call('startOwnedPriceRefresh', { session_id: this.options.sessionId }));
      if (!response.run) throw new Error('A rent price refresh did not return a run.');
      this.accept(response);
      if (this.stopRequested) await this.stopSavedRun();
      while (!this.controller.signal.aborted && this.current?.run?.state === 'running') {
        // Pacing is relative to the response's server clock, never the device clock.
        const remaining = this.current.next_allowed_at - this.current.server_time - (now() - this.observedAt);
        if (calls >= maxCalls || now() >= deadline || remaining >= deadline - now()) {
          this.interrupt();
          break;
        }
        if (remaining > 0) { await wait(Math.min(remaining, 1000), this.controller.signal); continue; }
        calls += 1;
        // Keep a possibly committed response observable; only waits are abortable.
        const next = readOwnedPriceResponse(await this.options.transport.call('stepOwnedPriceRefresh', { run_id: this.current.run.id }));
        if (!next.run || next.run.id !== this.current.run.id) throw new Error('The rent price refresh returned a different run.');
        if (this.stopRequested && this.current.run.state !== 'running') {
          this.accept({ ...next, run: { ...next.run, state: this.current.run.state,
            reason: this.current.run.reason, completed_at: this.current.run.completed_at,
          } });
        } else this.accept(next);
      }
    } catch {
      this.unavailable = true;
      this.interrupt();
    } finally {
      if (this.controller.signal.aborted) {
        if (this.stopRequest) await this.stopRequest;
        await this.reconcile();
      }
    }
  }
}

/** A hidden preload waits for its first display; a started session never resumes. */
export function createOwnedPriceStartupGate(
  driver: Pick<OwnedPriceRefreshDriver, 'start' | 'interrupt'>,
  isHidden: () => boolean,
) {
  let ready = false;
  let attempted = false;
  const startIfVisible = () => {
    if (!ready || attempted || isHidden()) return;
    attempted = true;
    void driver.start();
  };
  const interrupt = () => { if (attempted) driver.interrupt(); };
  return {
    dashboardLoaded(enabled: boolean) { ready = enabled; startIfVisible(); },
    visibilityChanged() { if (isHidden()) interrupt(); else startIfVisible(); },
    interrupt,
  };
}

export function ownedPriceStatusText(snapshot: OwnedPriceSnapshot): string {
  const { run, phase } = snapshot;
  if (phase === 'idle') return '';
  if (phase === 'checking') return run ? `Checking your rent prices · ${run.checked}/${run.total}` : 'Checking your rent prices…';
  if (phase === 'complete') return run?.total === 0 ? 'No saved gifts need a rent price check.'
    : `Rent prices checked · ${run?.checked ?? 0}/${run?.total ?? 0}${run?.unresolved ? ` · ${run.unresolved} unresolved; saved prices kept` : ''}`;
  if (phase === 'partial') return `Rent price check incomplete${run ? ` · ${run.checked}/${run.total}` : ''}${run?.unresolved ? ` · ${run.unresolved} unresolved` : ''}. Saved prices kept.`;
  return `Rent price check unavailable${run ? ` · ${run.checked}/${run.total} checked` : ''}. Saved prices kept.`;
}
