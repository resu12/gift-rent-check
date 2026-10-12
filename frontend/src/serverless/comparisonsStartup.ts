import type { ComparisonStartupResult, PricingSelection } from '../data/types.ts';
import { readJob } from './cloudDriver.ts';

export interface ComparisonStartupContext {
  identity: string;
  enabled: boolean;
  selection: PricingSelection;
}
export interface ComparisonStartupSnapshot {
  phase: 'idle' | 'waiting' | 'updating' | 'skipped' | ComparisonStartupResult['state'];
  busy: boolean;
}
const isoTime = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);

/** Startup status contains a validated job or fixed, non-sensitive skip metadata. */
export function readComparisonStartupResult(value: unknown): ComparisonStartupResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected comparison refresh status.');
  const result = value as ComparisonStartupResult;
  if (Object.keys(result).some(key => !['state', 'job', 'reason', 'retry_at'].includes(key)) ||
      !['started', 'fresh', 'busy', 'limited', 'unavailable'].includes(result.state) ||
      (result.retry_at !== undefined && !isoTime(result.retry_at))) throw new Error('Unexpected comparison refresh status.');
  if (result.state === 'started') {
    const job = readJob({ job: result.job! });
    if (!['prices', 'rental_prices'].includes(job.kind) || !['queued', 'running'].includes(job.state) || result.reason !== undefined)
      throw new Error('Unexpected comparison refresh status.');
  } else {
    if (result.job !== undefined) throw new Error('Unexpected comparison refresh status.');
    const reasons = result.state === 'busy' ? ['active_job', 'provider_wait']
      : result.state === 'limited' ? ['cooldown', 'daily_limit', 'provider_limit']
        : result.state === 'unavailable' ? ['key_missing', 'portfolio_missing', 'wallet_missing', 'stopped', 'failed'] : [];
    if (result.state === 'fresh' ? result.reason !== undefined : !result.reason || !reasons.includes(result.reason))
      throw new Error('Unexpected comparison refresh status.');
  }
  return result;
}

/** A fresh page makes at most one comparison request, after gift and analytics work. */
export function createComparisonStartupGate(options: {
  refresh(selection: PricingSelection, signal: AbortSignal): Promise<ComparisonStartupResult>;
  isHidden(): boolean;
  timer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear?(handle: ReturnType<typeof setTimeout>): void;
}) {
  let context: ComparisonStartupContext | null = null, ready = false, attempted = false, disposed = false, changed = false;
  let giftsSettled = false, analyticsSettled = false, manualBusy = false, jobsBusy = false, generation = 0;
  let abort: AbortController | null = null, grace: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let snapshot: ComparisonStartupSnapshot = { phase: 'idle', busy: false };
  const listeners = new Set<() => void>();
  const timer = options.timer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clear = options.clear ?? (handle => globalThis.clearTimeout(handle));
  const publish = (next: ComparisonStartupSnapshot) => { snapshot = next; if (!disposed) for (const listener of listeners) listener(); };
  const clearGrace = () => { if (grace !== undefined) clear(grace); grace = undefined; };
  const clearDeadline = () => { if (deadline !== undefined) clear(deadline); deadline = undefined; };
  const interrupt = () => {
    clearGrace(); clearDeadline();
    if (abort) { generation++; abort.abort(); abort = null; }
    if (snapshot.busy) publish({ phase: 'unavailable', busy: false });
  };
  const canStart = () => !disposed && !changed && !attempted && ready && context?.enabled && giftsSettled && analyticsSettled && !manualBusy && !jobsBusy && !options.isHidden();
  const launch = () => {
    if (!canStart() || !context) return;
    attempted = true;
    const chosen = { ...context.selection }, token = ++generation, active = new AbortController(); abort = active;
    publish({ phase: 'updating', busy: true });
    const current = () => !disposed && generation === token && abort === active;
    deadline = timer(() => { if (current()) interrupt(); }, 60000);
    void (async () => {
      try {
        const result = readComparisonStartupResult(await options.refresh(chosen, active.signal));
        if (!current()) return;
        clearDeadline(); publish({ phase: result.state, busy: false });
        // A started driver retains this signal so hide/close stops future steps.
        if (result.state !== 'started') abort = null;
      } catch {
        if (current()) { clearDeadline(); abort = null; publish({ phase: 'unavailable', busy: false }); }
      }
    })();
  };
  const startIfReady = () => {
    if (!canStart()) { clearGrace(); return; }
    if (grace !== undefined) return;
    grace = timer(() => { grace = undefined; launch(); }, 1100);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dashboardLoaded(next: ComparisonStartupContext | null) {
      ready = next !== null;
      if (!next) { clearGrace(); return; }
      if (context && context.identity !== next.identity) { changed = true; interrupt(); publish({ phase: 'idle', busy: false }); return; }
      context ??= { ...next, selection: { ...next.selection } };
      if (!attempted) context.enabled = next.enabled;
      if (!context.enabled || changed) { clearGrace(); return; }
      if (!attempted) publish({ phase: 'waiting', busy: false });
      startIfReady();
    },
    giftsChanged(settled: boolean) { giftsSettled = settled; startIfReady(); },
    analyticsChanged(settled: boolean) { analyticsSettled = settled; startIfReady(); },
    manualChanged(busy: boolean) { manualBusy = busy; startIfReady(); },
    jobsChanged(busy: boolean) { jobsBusy = busy; startIfReady(); },
    manualAction() {
      if (attempted) return;
      attempted = true; clearGrace(); publish({ phase: 'skipped', busy: false });
    },
    visibilityChanged() { if (options.isHidden()) interrupt(); else startIfReady(); },
    interrupt,
    dispose() { disposed = true; interrupt(); listeners.clear(); },
  };
}
