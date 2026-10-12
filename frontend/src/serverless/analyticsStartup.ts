import type { MarketappAnalyticsPeriod, MarketappAnalyticsStartupResult } from '../data/types.ts';

export interface AnalyticsStartupContext {
  identity: string;
  enabled: boolean;
  periodDays: MarketappAnalyticsPeriod;
  capturedAt?: string | null;
}
export interface AnalyticsStartupSnapshot {
  phase: 'idle' | 'waiting' | 'updating' | MarketappAnalyticsStartupResult['state'];
  busy: boolean;
  periodDays?: MarketappAnalyticsPeriod;
  reason?: MarketappAnalyticsStartupResult['reason'];
  /** Confirmed report metadata, retained until the saved view catches up. */
  capturedAt?: string;
  retryAt?: string;
  reloadFailed?: boolean;
  outcomeAt?: string;
  storagePaused?: boolean;
}
const isoTime = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);

/** The automatic endpoint returns fixed status metadata, never login material. */
export function readAnalyticsStartupResult(value: unknown, periodDays: MarketappAnalyticsPeriod, now = Date.now()): MarketappAnalyticsStartupResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected analytics refresh status.');
  const result = value as MarketappAnalyticsStartupResult;
  if (Object.keys(result).some(key => !['state', 'period_days', 'captured_at', 'retry_at', 'reason'].includes(key)) ||
      result.period_days !== periodDays || !['saved', 'fresh', 'unavailable', 'busy', 'limited'].includes(result.state) ||
      (result.captured_at !== undefined && (!isoTime(result.captured_at) || Date.parse(result.captured_at) > now + 30000)) ||
      (result.retry_at !== undefined && !isoTime(result.retry_at))) throw new Error('Unexpected analytics refresh status.');
  if (['saved', 'fresh'].includes(result.state)) {
    if (!isoTime(result.captured_at) || result.reason !== undefined) throw new Error('Unexpected analytics refresh status.');
  } else {
    const reasons = result.state === 'unavailable' ? ['no_login', 'wallet_missing', 'refresh_failed']
      : result.state === 'busy' ? ['active_refresh', 'website_busy'] : ['cooldown', 'request_limit'];
    if (!result.reason || !reasons.includes(result.reason)) throw new Error('Unexpected analytics refresh status.');
  }
  return result;
}

/** One silent attempt for this page opening, after gift and manual refreshes settle. */
export function createAnalyticsStartupGate(options: {
  refresh(periodDays: MarketappAnalyticsPeriod, signal: AbortSignal): Promise<MarketappAnalyticsStartupResult>;
  onSavedDataChanged(): Promise<void>;
  isHidden(): boolean;
  now?(): number;
  timer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear?(handle: ReturnType<typeof setTimeout>): void;
}) {
  let context: AnalyticsStartupContext | null = null, ready = false, attempted = false, disposed = false, contextChanged = false;
  let giftsSettled = false, manualBusy = false, generation = 0;
  let abort: AbortController | null = null, deadline: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
  let snapshot: AnalyticsStartupSnapshot = { phase: 'idle', busy: false };
  const listeners = new Set<() => void>();
  const now = options.now ?? Date.now, timer = options.timer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clear = options.clear ?? (handle => globalThis.clearTimeout(handle));
  const publish = (next: AnalyticsStartupSnapshot) => { snapshot = next; if (!disposed) for (const listener of listeners) listener(); };
  const clearDeadline = () => { if (deadline !== undefined) clear(deadline); deadline = undefined; };
  const clearGrace = () => { if (grace !== undefined) clear(grace); grace = undefined; };
  const interrupt = () => {
    clearGrace();
    if (!abort) return;
    generation++; clearDeadline(); abort.abort(); abort = null;
    publish(['saved', 'fresh'].includes(snapshot.phase) && snapshot.capturedAt
      ? { ...snapshot, busy: false, reloadFailed: true }
      : { phase: 'unavailable', busy: false, periodDays: context?.periodDays, reason: 'refresh_failed', outcomeAt: new Date(now()).toISOString() });
  };
  const canStart = () => !disposed && !contextChanged && !attempted && ready && context?.enabled && giftsSettled && !manualBusy && !options.isHidden();
  const launch = () => {
    if (!canStart() || !context) return;
    attempted = true;
    const savedContext = { ...context }, token = ++generation, active = new AbortController(); abort = active;
    publish({ phase: 'updating', busy: true, periodDays: savedContext.periodDays });
    const current = () => !disposed && generation === token && abort === active;
    deadline = timer(() => { if (current()) interrupt(); }, 120000);
    void (async () => {
      try {
        const response = await options.refresh(savedContext.periodDays, active.signal);
        if (!current()) return;
        const result = readAnalyticsStartupResult(response, savedContext.periodDays, now());
        clearDeadline();
        publish({ phase: result.state, busy: true, periodDays: result.period_days, outcomeAt: result.captured_at ?? new Date(now()).toISOString(), ...(result.reason ? { reason: result.reason } : {}),
          ...(result.captured_at ? { capturedAt: result.captured_at } : {}), ...(result.retry_at ? { retryAt: result.retry_at } : {}) });
        // A different page may have saved fresher analytics while this page opened.
        if (result.state === 'saved' || (result.state === 'fresh' && result.captured_at !== savedContext.capturedAt)) {
          try { await options.onSavedDataChanged(); }
          catch { if (current()) publish({ ...snapshot, reloadFailed: true }); }
        }
      } catch (error) {
        const storagePaused = error && typeof error === 'object' && 'code' in error &&
          (error.code === 'STORAGE_CAPACITY_PAUSED' || error.code === 'STORAGE_FULL');
        if (current()) publish({ phase: 'unavailable', busy: true, periodDays: savedContext.periodDays, reason: 'refresh_failed',
          outcomeAt: new Date(now()).toISOString(), ...(storagePaused ? { storagePaused: true } : {}) });
      } finally {
        if (current()) { clearDeadline(); abort = null; publish({ ...snapshot, busy: false }); }
      }
    })();
  };
  const startIfReady = () => {
    if (!canStart()) { clearGrace(); return; }
    if (grace !== undefined) return;
    // Gift and analytics reads share Marketapp's one-request-per-second pacing.
    grace = timer(() => { grace = undefined; launch(); }, 1100);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dashboardLoaded(next: AnalyticsStartupContext | null) {
      // Query reloads temporarily remove data; they do not revoke the saved wallet.
      ready = next !== null;
      if (!next) { clearGrace(); return; }
      if (context && context.identity !== next.identity) {
        contextChanged = true; clearGrace(); interrupt(); publish({ phase: 'idle', busy: false }); return;
      }
      context ??= { ...next };
      if (!attempted) context.enabled = next.enabled;
      if (!context.enabled || contextChanged) { clearGrace(); return; }
      if (!attempted) publish({ phase: 'waiting', busy: false, periodDays: context.periodDays });
      startIfReady();
    },
    giftsChanged(settled: boolean) { giftsSettled = settled; startIfReady(); },
    manualChanged(busy: boolean) { manualBusy = busy; startIfReady(); },
    visibilityChanged() { if (options.isHidden()) { clearGrace(); interrupt(); } else startIfReady(); },
    interrupt,
    dispose() { disposed = true; clearGrace(); interrupt(); listeners.clear(); },
  };
}

export function analyticsStartupStatus(snapshot?: AnalyticsStartupSnapshot): { label: string; title: string } | null {
  if (!snapshot || ['idle', 'waiting'].includes(snapshot.phase)) return null;
  if (snapshot.phase === 'updating') return { label: 'Updating…', title: 'Refreshing your rental analytics with the remembered Marketapp login.' };
  if (snapshot.reloadFailed) return { label: 'Reload needed', title: 'The refresh finished, but this view could not load the saved report.' };
  if (snapshot.storagePaused) return { label: 'Storage cleanup needed', title: 'Updates are paused to protect saved data. Clean up storage from Status, then try again.' };
  if (snapshot.phase === 'saved' || snapshot.phase === 'fresh') return { label: snapshot.busy ? 'Loading report…' : 'Recently refreshed', title: snapshot.busy ? 'Loading the refreshed rental report.' : 'A rental report was refreshed recently; check the displayed report’s capture time.' };
  if (snapshot.reason === 'no_login') return { label: 'Login required', title: 'Refresh analytics and remember the Marketapp login to enable automatic updates.' };
  if (snapshot.reason === 'wallet_missing') return { label: 'Wallet required', title: 'Save your wallet before automatically refreshing analytics.' };
  return { label: 'Saved data', title: snapshot.phase === 'busy' ? 'Another refresh is running. Your saved analytics remain visible.'
    : snapshot.phase === 'limited' ? 'The refresh allowance is temporarily unavailable. Your saved analytics remain visible.'
      : 'Analytics could not be refreshed. Your saved analytics remain visible; use Refresh analytics to retry.' };
}
