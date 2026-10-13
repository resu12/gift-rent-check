export interface StorageCleanupProgress {
  stage: 'cache' | 'expired_metadata' | 'sync_history' | 'gift_checks' | 'saved_status' | 'request_allowance' | 'discovery';
  stage_number: number;
  stage_count: number;
  /** Position within this scan stage, not overall work or time remaining. */
  percent: number | null;
}

export interface StorageGrowth {
  state: 'unknown' | 'collecting' | 'stale' | 'growing' | 'not_growing';
  sample_count: number;
  observed_from: string | null;
  observed_through: string | null;
  /** Net logical payload change, including cleanup; not provider disk usage. */
  net_bytes_per_day: number | null;
  days_to_limit: number | null;
  write_limit_bytes: number | null;
  platform_quota_verified: false;
}

export interface StorageStatus {
  version: 1;
  scope: 'app' | 'account';
  status: 'unknown' | 'healthy' | 'cleaning' | 'warning' | 'paused';
  estimated_bytes: number | null;
  budget_bytes: number | null;
  checked_at: string | null;
  inventory_complete: boolean;
  cleanup: {
    state: 'idle' | 'running' | 'complete' | 'needed' | 'blocked';
    last_completed_at: string | null;
    reclaimed_bytes: number;
    estimated_reclaimable_bytes: number | null;
    progress?: StorageCleanupProgress | null;
  };
  can_cleanup: boolean;
  next_step_at: string | null;
  growth?: StorageGrowth;
}

export interface StorageMaintenanceAdapter {
  get(signal?: AbortSignal): Promise<StorageStatus>;
  /** An explicit manual request checks for cleanup even when the last check is recent. */
  step(manual?: boolean): Promise<StorageStatus>;
}

const timestamp = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullableBytes = (value: unknown) => value === null || bytes(value);
const nullableTime = (value: unknown) => value === null || timestamp(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Project fixed status metadata only. No table names, account IDs or provider data reach the card. */
export function readStorageStatus(value: unknown): StorageStatus {
  if (!object(value) || Object.keys(value).some(key => !['version', 'scope', 'status', 'estimated_bytes', 'budget_bytes', 'checked_at',
    'inventory_complete', 'cleanup', 'can_cleanup', 'next_step_at', 'growth'].includes(key)) || value.version !== 1 ||
    typeof value.scope !== 'string' || !['app', 'account'].includes(value.scope) || typeof value.status !== 'string' ||
    !['unknown', 'healthy', 'cleaning', 'warning', 'paused'].includes(value.status) ||
    !nullableBytes(value.estimated_bytes) || !nullableBytes(value.budget_bytes) || value.budget_bytes === 0 ||
    !nullableTime(value.checked_at) || typeof value.inventory_complete !== 'boolean' || typeof value.can_cleanup !== 'boolean' ||
    !nullableTime(value.next_step_at) || !object(value.cleanup)) throw new Error('Storage status could not be confirmed.');
  const cleanup = value.cleanup;
  if (Object.keys(cleanup).some(key => !['state', 'last_completed_at', 'reclaimed_bytes', 'estimated_reclaimable_bytes', 'progress'].includes(key)) ||
    typeof cleanup.state !== 'string' || !['idle', 'running', 'complete', 'needed', 'blocked'].includes(cleanup.state) || !nullableTime(cleanup.last_completed_at) ||
    !bytes(cleanup.reclaimed_bytes) || !nullableBytes(cleanup.estimated_reclaimable_bytes) ||
    (value.status === 'healthy' && (value.inventory_complete !== true || value.checked_at === null)))
    throw new Error('Storage status could not be confirmed.');
  const progress = cleanup.progress;
  if (progress !== undefined && progress !== null && (!object(progress) || Object.keys(progress).length !== 4 ||
    typeof progress.stage !== 'string' || !['cache', 'expired_metadata', 'sync_history', 'gift_checks', 'saved_status', 'request_allowance', 'discovery'].includes(progress.stage) ||
    !bytes(progress.stage_count) || progress.stage_count !== (value.scope === 'app' ? 16 : 7) ||
    !bytes(progress.stage_number) || progress.stage_number < 1 || progress.stage_number > progress.stage_count ||
    !(progress.percent === null || bytes(progress.percent) && progress.percent <= 100)))
    throw new Error('Storage status could not be confirmed.');
  const growth = value.growth;
  if (growth !== undefined) {
    if (!object(growth) || Object.keys(growth).length !== 8 || Object.keys(growth).some(key => !['state', 'sample_count',
      'observed_from', 'observed_through', 'net_bytes_per_day', 'days_to_limit', 'write_limit_bytes', 'platform_quota_verified'].includes(key)) ||
      typeof growth.state !== 'string' || !['unknown', 'collecting', 'stale', 'growing', 'not_growing'].includes(growth.state) ||
      !bytes(growth.sample_count) || growth.sample_count > 31 || !nullableTime(growth.observed_from) || !nullableTime(growth.observed_through) ||
      !(growth.net_bytes_per_day === null || Number.isSafeInteger(growth.net_bytes_per_day)) ||
      !nullableBytes(growth.days_to_limit) || typeof growth.days_to_limit === 'number' && growth.days_to_limit > 36500 ||
      !nullableBytes(growth.write_limit_bytes) || growth.write_limit_bytes === 0 || growth.platform_quota_verified !== false)
      throw new Error('Storage status could not be confirmed.');
    const elapsed = growth.observed_from !== null && growth.observed_through !== null
      ? Date.parse(growth.observed_through as string) - Date.parse(growth.observed_from as string) : null;
    const measured = growth.state === 'growing' || growth.state === 'not_growing';
    if ((growth.sample_count === 0 ? growth.observed_from !== null || growth.observed_through !== null : elapsed === null || elapsed < 0) ||
      (growth.state === 'unknown' ? growth.sample_count !== 0 || growth.write_limit_bytes !== null : growth.write_limit_bytes === null) ||
      (measured ? growth.sample_count < 3 || elapsed === null || elapsed < 172800000 || growth.net_bytes_per_day === null
        : growth.net_bytes_per_day !== null || growth.days_to_limit !== null) ||
      (growth.state === 'growing' ? Number(growth.net_bytes_per_day) <= 0 : growth.days_to_limit !== null) ||
      (growth.state === 'not_growing' && Number(growth.net_bytes_per_day) > 0))
      throw new Error('Storage status could not be confirmed.');
  }
  return value as unknown as StorageStatus;
}

export function storageGrowthSummary(growth: StorageGrowth, scope: StorageStatus['scope'], now = Date.now()): string {
  if (growth.state === 'unknown') return 'Growth estimate is waiting for a complete storage check.';
  if (growth.state === 'stale' || growth.observed_through && now - Date.parse(growth.observed_through) > 172800000)
    return 'Growth history is older than two days. Open the app on more days to update the estimate.';
  if (growth.state === 'collecting') return `Collecting daily usage (${growth.sample_count}/3 samples). An estimate needs at least three days of checks spanning 48 hours.`;
  const rate = growth.net_bytes_per_day ?? 0, days = Math.max(2, Math.round((Date.parse(growth.observed_through!) - Date.parse(growth.observed_from!)) / 86400000));
  if (rate === 0) return `No measurable net growth over ${days} days. This does not mean unlimited capacity.`;
  const size = Math.abs(rate) < 1000 ? `${Math.abs(rate)} B` : Math.abs(rate) < 100000
    ? `${(Math.abs(rate) / 1000).toLocaleString(undefined, {maximumFractionDigits: 1})} KB` : storageSize(Math.abs(rate));
  const trend = `Net change: ${rate > 0 ? '+' : '−'}${size}/day over ${days} days, including cleanup.`;
  if (growth.days_to_limit === null) return `${trend} No time estimate available.`;
  const limit = scope === 'app' ? 'app write limit' : 'account write limit';
  return `${trend} ${growth.days_to_limit === 0 ? `At the ${limit}.` : `Roughly ${growth.days_to_limit.toLocaleString()} day${growth.days_to_limit === 1 ? '' : 's'} to the ${limit} if this rate continues.`}`;
}

export interface StorageMaintenanceSnapshot {
  status: StorageStatus | null;
  phase: 'idle' | 'checking' | 'cleaning' | 'settled' | 'error';
  busy: boolean;
  error: string | null;
  bounded: boolean;
  /** Scheduled work spans the gaps between requests; waiting work is resumable. */
  continuation?: 'scheduled' | 'waiting' | null;
  pauseReason?: 'provider' | 'hidden' | 'automatic_limit' | 'manual_limit' | 'request_error' | null;
  /** Other updates prevent manual cleanup too, independently of its saved pause or error. */
  providerBusy?: boolean;
}

export function storageNeedsStep(status: StorageStatus): boolean {
  return status.can_cleanup && (!status.inventory_complete || status.status === 'cleaning' || status.status === 'warning' ||
    status.status === 'paused' || status.status === 'unknown' || status.cleanup.state === 'running' || status.cleanup.state === 'needed');
}

/** Serialized, visible-page maintenance. A timeout never retries an uncertain write. */
export function createStorageMaintenanceController(options: {
  adapter: StorageMaintenanceAdapter;
  isHidden(): boolean;
  now?(): number;
  timer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear?(handle: ReturnType<typeof setTimeout>): void;
  maxAutomaticSteps?: number;
  maxManualSteps?: number;
  maxManualActiveMs?: number;
}) {
  const now = options.now ?? Date.now;
  const timer = options.timer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clear = options.clear ?? (handle => globalThis.clearTimeout(handle));
  let snapshot: StorageMaintenanceSnapshot = { status: null, phase: 'idle', busy: false, error: null, bounded: false };
  let identity: string | null = null, generation = 0, disposed = false, pending = false, inhibited = false, automaticSteps = 0, readRequested = false;
  let pacingDeadline: number | null = null;
  let manualSession: { steps: number; activeMs: number; activeSince: number | null } | null = null;
  let completedManualCycle = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const updateManualClock = () => {
    if (!manualSession) return;
    if (manualSession.activeSince !== null) manualSession.activeMs += Math.max(0, now() - manualSession.activeSince);
    manualSession.activeSince = !options.isHidden() && !inhibited ? now() : null;
  };
  const limitReason = () => {
    updateManualClock();
    return manualSession
      ? manualSession.steps >= (options.maxManualSteps ?? 300) || manualSession.activeMs >= (options.maxManualActiveMs ?? 15 * 60000)
        ? 'manual_limit' as const : null
      : automaticSteps >= (options.maxAutomaticSteps ?? 24) ? 'automatic_limit' as const : null;
  };
  const publish = (value: StorageMaintenanceSnapshot) => {
    const needsStep = value.status !== null && storageNeedsStep(value.status);
    const ongoing = value.status !== null && (value.status.cleanup.state === 'running' || value.status.status === 'cleaning' ||
      !value.status.inventory_complete);
    const limit = limitReason();
    const bounded = value.bounded || !value.busy && !value.error && needsStep && !completedManualCycle && limit !== null;
    const continuation = !value.busy && !value.error && !bounded && !completedManualCycle && needsStep && ongoing && identity !== null
      ? inhibited || options.isHidden() ? 'waiting' : 'scheduled' : null;
    const pauseReason = value.error ? 'request_error' : !value.busy && bounded ? limit
      : continuation === 'waiting' ? options.isHidden() ? 'hidden' : 'provider' : null;
    snapshot = { ...value, bounded, continuation, pauseReason, providerBusy: inhibited };
    if (!disposed) for (const listener of listeners) listener();
  };
  const unschedule = () => { if (scheduled !== undefined) clear(scheduled); scheduled = undefined; };
  const current = (savedGeneration: number) => !disposed && identity !== null && generation === savedGeneration;
  const canRun = () => !disposed && identity !== null && !options.isHidden() && !pending;
  const continuingCleanup = (status: StorageStatus | null) => status?.can_cleanup === true && status.cleanup.state !== 'blocked' &&
    (status.cleanup.state === 'running' || status.status === 'cleaning');

  const plan = (delay?: number) => {
    unschedule();
    if (!canRun() || snapshot.error || inhibited) return;
    if (!snapshot.status || readRequested) {
      scheduled = timer(() => { scheduled = undefined; void perform(false, true); }, delay ?? 1500);
      return;
    }
    if (inhibited || completedManualCycle || snapshot.status.cleanup.state === 'blocked' || !storageNeedsStep(snapshot.status)) return;
    if (limitReason()) { publish({ ...snapshot, bounded: true }); return; }
    // Pause/resume events must not move the local deadline forward repeatedly.
    // The latest backend deadline still takes precedence, including live leases.
    const deadline = Math.max(pacingDeadline ?? (pacingDeadline = now() + 2500),
      snapshot.status.next_step_at === null ? 0 : Date.parse(snapshot.status.next_step_at));
    const wait = Math.min(300000, Math.max(0, deadline - now(), delay ?? 0));
    scheduled = timer(() => {
      scheduled = undefined;
      if ((pacingDeadline ?? 0) > now() || snapshot.status?.next_step_at && Date.parse(snapshot.status.next_step_at) > now()) plan();
      else void perform(false, false);
    }, wait);
  };

  async function perform(manual: boolean, readOnly: boolean): Promise<void> {
    if (!canRun() || (!readOnly && inhibited)) return;
    if (!readOnly && !manual && limitReason()) { publish({ ...snapshot, bounded: true }); return; }
    unschedule(); pending = true;
    if (readOnly) readRequested = false;
    const savedGeneration = generation;
    if (!readOnly) {
      if (manualSession) manualSession.steps += 1;
      else if (!manual) automaticSteps += 1;
    }
    publish({ ...snapshot, phase: readOnly ? 'checking' : 'cleaning', busy: true, error: null, bounded: false });
    try {
      const result = readStorageStatus(await (readOnly ? options.adapter.get() : options.adapter.step(manual)));
      if (!current(savedGeneration)) return;
      pacingDeadline = now() + 2500;
      if (continuingCleanup(result)) readRequested = false;
      if (manualSession && (result.cleanup.state === 'complete' && result.inventory_complete || !storageNeedsStep(result))) {
        manualSession = null;
        completedManualCycle = true;
      }
      publish({ status: result, phase: 'settled', busy: false, error: null, bounded: false });
    } catch {
      if (!current(savedGeneration)) return;
      manualSession = null;
      // A write may still have completed. One saved-only read reconciles its
      // outcome; no automatic mutation is sent after this uncertain failure.
      let saved = snapshot.status;
      if (!readOnly) { try { saved = readStorageStatus(await options.adapter.get()); } catch { /* Keep the previous verified status. */ } }
      if (current(savedGeneration)) publish({ status: saved, phase: 'error', busy: false,
        error: 'Storage check could not finish. Saved data is retained. Try again.', bounded: false });
    } finally {
      pending = false;
      if (current(savedGeneration)) plan();
      else if (!disposed) plan();
    }
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    context(next: string | null) {
      if (next === identity || disposed) return;
      identity = next; generation += 1; automaticSteps = 0; readRequested = false; pacingDeadline = null;
      manualSession = null; completedManualCycle = false; unschedule();
      publish({ status: null, phase: 'idle', busy: false, error: null, bounded: false });
      plan();
    },
    providerBusy(busy: boolean) {
      updateManualClock();
      // Continuing cleanup already reloads and fences server state in its next
      // step. Extra status reads after every provider pulse can postpone that
      // step indefinitely because each read advertises a fresh server cooldown.
      if (inhibited && !busy && !continuingCleanup(snapshot.status)) readRequested = true;
      inhibited = busy; publish(snapshot); plan();
    },
    visibilityChanged() { updateManualClock(); publish(snapshot); plan(); },
    /** Explicit saved-status reads remain usable while provider updates are busy. */
    checkNow() { return perform(false, true); },
    async cleanNow() {
      // A second tap between scheduled chunks must not restart the batch or
      // reset its safety counter. Paused work and explicit retries remain usable.
      if (!canRun() || inhibited || snapshot.continuation === 'scheduled') return;
      automaticSteps = 0;
      manualSession = { steps: 0, activeMs: 0, activeSince: now() };
      completedManualCycle = false;
      await perform(true, false);
    },
    dispose() { disposed = true; generation += 1; pacingDeadline = null; manualSession = null; unschedule(); listeners.clear(); },
  };
}

export function storageSize(value: number): string {
  return `${(value / 1000000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

export function storageCleanupStage(progress: StorageCleanupProgress): string {
  return { cache: 'Removing cached views', expired_metadata: 'Removing expired request records',
    sync_history: 'Checking saved sync history', gift_checks: 'Checking saved gift checks',
    saved_status: 'Checking saved gift updates', request_allowance: 'Checking saved request counters',
    discovery: 'Checking saved gift discovery' }[progress.stage];
}

/** Status is deliberately neutral when the inventory is incomplete or stale. */
export function presentStorage(snapshot: StorageMaintenanceSnapshot, now = Date.now()) {
  const value = snapshot.status;
  const active = snapshot.busy || snapshot.continuation === 'scheduled';
  const waitingForProvider = !active && (snapshot.providerBusy === true || snapshot.pauseReason === 'provider');
  const cleaning = active && (snapshot.phase === 'cleaning' || value?.status === 'cleaning' ||
    value?.cleanup.state === 'running' || value?.cleanup.state === 'needed');
  const resumable = !active && (snapshot.bounded || snapshot.continuation === 'waiting' ||
    value?.status === 'cleaning' || value?.cleanup.state === 'running' || value?.cleanup.state === 'blocked');
  const recent = value?.checked_at != null && Date.parse(value.checked_at) <= now + 30000 && now - Date.parse(value.checked_at) < 6 * 3600000;
  const status = value?.status === 'paused' ? 'paused'
    : snapshot.error || resumable ? 'unknown' : cleaning ? 'cleaning'
      : value?.cleanup.state === 'blocked' || !value?.inventory_complete || !recent ? 'unknown' : value.status;
  const label = status === 'healthy' ? 'Healthy' : status === 'cleaning' ? 'Cleaning up'
    : status === 'warning' ? 'Storage nearly full' : status === 'paused' ? 'Updates paused'
      : snapshot.error ? 'Check unavailable' : resumable ? 'Cleanup paused'
        : active || snapshot.phase === 'checking' ? 'Checking storage' : 'Check incomplete';
  return { status, label, tone: status === 'healthy' ? 'fresh' : status === 'paused' ? 'critical' : 'warning',
    active, waitingForProvider, actionLabel: active ? cleaning ? 'Cleaning…' : 'Checking…' : waitingForProvider ? 'Waiting…'
      : snapshot.error ? 'Try again' : resumable ? 'Continue cleanup' : 'Clean up now',
    actionDisabled: active || waitingForProvider || snapshot.pauseReason === 'hidden' || value?.can_cleanup === false,
    progressPercent: value?.inventory_complete && value.estimated_bytes !== null && value.budget_bytes !== null
      ? Math.min(100, Math.round(value.estimated_bytes / value.budget_bytes * 100)) : null } as const;
}
