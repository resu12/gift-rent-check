import type { Job, JobKind } from './types.ts';
import type { OwnedPriceSnapshot } from './ownedPriceRefresh.ts';

export interface SyncProgress {
  completed: number | null;
  total: number | null;
  percent: number | null;
  label: string;
  indeterminate: boolean;
}

export interface SyncPresentation {
  title: string;
  objective: string;
  state: 'preparing' | 'running' | 'waiting' | 'paused' | 'stopping' | 'complete' | 'failed';
  stateLabel: string;
  message: string;
  progress: SyncProgress;
  actionLabel: string | null;
  rawReason: string | null;
  cacheNote: string | null;
}

interface SyncOptions { stopping?: boolean; now?: number; timeframeLabel?: string }
type CountUnit = 'collections' | 'gifts' | 'checks';
type Reason = 'stopped' | 'daily' | 'limit' | 'retry' | 'retry_failed' | 'access' | 'cursor' | 'response' | 'network' | 'interrupted' | 'unknown';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = (value: number) => value.toLocaleString('en-US');
const titles: Record<JobKind, string> = {
  prices: 'Updating listing comparisons', rental_prices: 'Updating rental comparisons', collect: 'Updating market prices and rentals',
  refresh: 'Checking your gifts', discover: 'Finding wallet gifts',
};
const savedTitles: Record<JobKind, string> = {prices: 'Listing comparisons', rental_prices: 'Rental comparisons', collect: 'Market prices and rentals', refresh: 'Your gifts', discover: 'Wallet gifts'};

function knownReason(value: string | null): Reason {
  const text = value?.toLowerCase() ?? '';
  if (/retry_exhausted|retries were exhausted|retry attempts exhausted/.test(text)) return 'retry_failed';
  if (/authentication[ _]failed|rejected authentication|authentication error|unauthorized|forbidden/.test(text)) return 'access';
  if (/cursor_cycle|cursor_rejected|repeated a cursor|rejected the saved cursor|saved cursor may be invalid|incompatible_history_plan|saved history refresh plan is incompatible|non.retryable error/.test(text)) return 'cursor';
  if (/invalid_response|malformed data|malformed response|response_too_large|page safety limit|unexpected_redirect|unexpected url|invalid_retry_after|unsupported retry deadline/.test(text)) return 'response';
  if (/stopped_by_you|user_stopped|stopped by you/.test(text)) return 'stopped';
  if (/daily_limit|dashboard_daily_budget|rolling 24.hour|daily.*(?:limit|allowance|budget)/.test(text)) return 'daily';
  if (/retry_wait|provider retry deadline|retry.after|provider (?:cooldown|wait)|rate.limit/.test(text)) return 'retry';
  if (/invocation_limit|duration_limit|attempt_budget|time[ _]budget|invocation_budget|page[ _]limit|request.*(?:limit|budget)|minute.*allowance|duration limit|allowance ended/.test(text)) return 'limit';
  if (/network_error|network failure|request_timeout|connection error/.test(text)) return 'network';
  if (/interrupted|worker_lease_lost|lease changed|request_lease_expired/.test(text)) return 'interrupted';
  return 'unknown';
}

function windowLabel(job: Job, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim().replace(/^(Last|Selected)\b/, word => word.toLowerCase());
  const window = job.collection_window;
  if (window?.timeframe === '24h') return 'the last 24 hours';
  if (window?.timeframe === 'custom') return 'the selected dates';
  const days = /^(7|30|60|90)d$/.exec(window?.timeframe ?? '');
  return days ? `the last ${days[1]} days` : 'the selected timeframe';
}

function objective(job: Job, label?: string): string {
  switch (job.kind) {
    case 'prices': return 'Update comparison prices from current market listings.';
    case 'rental_prices': return `Update comparison prices from actual rentals for ${windowLabel(job, label)}.`;
    case 'collect': return `Update current listing comparisons and actual rentals for ${windowLabel(job, label)}.`;
    case 'refresh': return 'Check ownership, gift details, and current daily prices for your saved gifts.';
    case 'discover': return 'Find gifts in your wallet and check which ones belong to you.';
    default: return 'Update the saved information used by your dashboard.';
  }
}

function progress(completedValue: unknown, totalValue: unknown, unit: CountUnit, terminal: boolean, findingTotal = false): SyncProgress {
  const completed = count(completedValue), total = count(totalValue);
  const valid = completed !== null && total !== null && completed <= total && !findingTotal;
  if (!valid) {
    return {
      completed, total: null, percent: terminal ? 100 : null, indeterminate: !terminal,
      label: terminal ? 'Finished' : completed !== null && completed > 0 ? `${number(completed)} ${unit} checked · total still being found` : 'Finding the total…',
    };
  }
  if (total === 0) return {
    completed, total, percent: terminal ? 100 : null, indeterminate: !terminal,
    label: terminal ? `No ${unit} to check` : 'Preparing checks…',
  };
  return {
    completed, total, percent: Math.min(terminal ? 100 : 99, Math.floor(completed / total * 100)), indeterminate: false,
    label: `${number(completed)} of ${number(total)} ${unit} ${unit === 'checks' ? 'finished' : 'checked'}`,
  };
}

function jobProgress(job: Job): SyncProgress {
  const detail = object(job.progress?.sync), terminal = job.state === 'complete';
  // Older listing jobs saved collection completion even when each collection
  // contained many model/backdrop checks. Show that committed work accurately
  // until the worker writes the new explicit checks unit on its next update.
  if (job.kind === 'prices' && detail?.unit === 'collections') {
    const collectionsDone = count(detail.completed), collectionsTotal = count(detail.total);
    const checksDone = count(job.progress?.streams_complete), checksTotal = count(job.progress?.streams_total);
    if (collectionsDone !== null && collectionsTotal !== null && collectionsTotal > 0 && collectionsDone <= collectionsTotal &&
        checksDone !== null && checksTotal !== null && checksTotal > collectionsTotal && checksDone <= checksTotal &&
        (!terminal || checksDone === checksTotal)) return progress(checksDone, checksTotal, 'checks', terminal);
  }
  if (detail && ['collections', 'gifts', 'checks'].includes(String(detail.unit))) {
    return progress(detail.completed, detail.total, detail.unit as CountUnit, terminal, detail.phase === 'discovering');
  }
  // Enumeration can reveal more gifts. Its stream count is not a total wallet
  // size; only the new backend's fixed verification phase has that denominator.
  if (job.kind === 'discover') return progress(null, null, 'gifts', terminal, true);
  return progress(job.progress?.streams_complete, job.progress?.streams_total, 'checks', terminal);
}

function cacheNote(job: Job, now: number): string | null {
  const cache = object(job.progress?.market_cache), reused = count(cache?.reused_streams), total = count(cache?.total_streams);
  if (reused === null || total === null || reused <= 0 || reused > total) return null;
  const storedAge = cache?.oldest_age_seconds;
  const observed = typeof cache?.oldest_observed_at === 'string' ? Date.parse(cache.oldest_observed_at) : NaN;
  const age = typeof storedAge === 'number' && Number.isFinite(storedAge) && storedAge >= 0 ? storedAge
    : Number.isFinite(observed) && observed <= now ? (now - observed) / 1000 : null;
  const ageText = age === null ? 'original observation time retained' : age < 60 ? 'oldest data under a minute old'
    : age < 3600 ? `oldest data ${Math.floor(age / 60)} min old` : `oldest data ${Math.floor(age / 3600)} h old`;
  const ttl = count(cache?.ttl_seconds);
  return `${number(reused)} comparison scan${reused === 1 ? '' : 's'} reused · ${ageText}${ttl && ttl <= 3600 ? ` · cache up to ${Math.ceil(ttl / 60)} min` : ''}.`;
}

function pausedMessage(reason: Reason): string {
  if (reason === 'daily') return 'The daily request allowance is used up. Your progress is saved; continue when it resets.';
  if (reason === 'retry') return 'The data provider asked us to wait. Your progress is saved; continue later.';
  if (reason === 'limit') return 'This batch reached its limit. Continue to pick up where it stopped.';
  if (reason === 'stopped') return 'Stopped. Your progress is saved; continue whenever you are ready.';
  return 'Your progress is saved. Continue to pick up where it stopped.';
}

function failedMessage(reason: Reason): string {
  if (reason === 'access') return 'Access was rejected. Check the API connection before trying again.';
  if (reason === 'cursor') return 'This saved scan cannot continue. Start a new refresh; your saved data is kept.';
  if (reason === 'response') return 'The provider returned an unexpected response. Saved progress is kept; try again later.';
  if (reason === 'network' || reason === 'retry_failed') return 'The provider could not be reached. Saved progress is kept; try again later.';
  return 'The refresh could not finish. Your saved data is still available; try again later.';
}

/** The main surface needs the next step; diagnostics remain in Details. */
export function compactJobMessage(job: Job, view: SyncPresentation): string {
  const reason = knownReason(job.reason);
  if (view.state === 'paused') {
    if (reason === 'daily') {
      const budget = object(job.progress?.marketapp_budget);
      const used = count(budget?.rolling_24h_used), limit = count(budget?.rolling_24h_limit);
      return used !== null && limit !== null && limit > used
        ? 'Allowance available · ready to continue.' : 'Daily allowance used · progress saved.';
    }
    if (reason === 'retry') return 'Provider cooldown · continue later.';
    return 'Progress saved · ready to continue.';
  }
  if (view.state === 'waiting') return 'Provider cooldown · retrying automatically.';
  if (view.state === 'stopping') return 'Saving progress and stopping…';
  if (view.state === 'preparing') return 'Preparing checks…';
  if (view.state === 'complete') return job.kind === 'refresh' || job.kind === 'discover'
    ? 'Checks finished · unresolved gifts still need review.' : 'Comparison prices saved.';
  if (view.state === 'failed') {
    if (reason === 'access') return 'Access rejected · check the API connection.';
    if (reason === 'cursor') return 'Cannot resume · start a new refresh.';
    return 'Could not finish · saved data kept. Try again later.';
  }
  const detail = object(job.progress?.sync);
  return typeof detail?.current_collection === 'string' && detail.current_collection.trim()
    ? `Checking ${detail.current_collection.trim()}` : job.kind === 'discover' ? 'Finding gifts…' : 'Checking for updates…';
}

/** Human-facing status uses workload counts, never the HTTP request allowance. */
export function presentJobSync(job: Job, options: SyncOptions = {}): SyncPresentation {
  const detail = object(job.progress?.sync), reason = knownReason(job.reason), requiresResume = job.progress?.requires_resume === true;
  const active = job.state === 'queued' || job.state === 'running';
  let state: SyncPresentation['state'], message: string;
  if (active && !requiresResume && (options.stopping || job.stop_requested)) {
    state = 'stopping'; message = 'Finishing the current request, then stopping. Your progress will be saved.';
  } else if (job.state === 'complete') {
    state = 'complete'; message = job.kind === 'refresh' || job.kind === 'discover' ? 'Checks finished. Review any gifts still marked unknown.' : 'Your saved comparison prices are ready.';
  } else if (job.state === 'failed') {
    state = 'failed'; message = failedMessage(reason);
  } else if (job.state === 'partial' || requiresResume) {
    state = 'paused';
    const budget = object(job.progress?.marketapp_budget), used = count(budget?.rolling_24h_used), limit = count(budget?.rolling_24h_limit);
    message = reason === 'daily' && used !== null && limit !== null && limit > 0 && used < limit
      ? 'Your request allowance is available again. Continue from your saved progress.'
      : pausedMessage(reason);
  } else if (reason === 'retry') {
    state = 'waiting'; message = 'Waiting for the data provider before retrying. Your progress is saved.';
  } else if (job.state === 'queued' || detail?.phase === 'preparing') {
    state = 'preparing'; message = 'Preparing the checks for this refresh.';
  } else {
    state = 'running';
    const collection = typeof detail?.current_collection === 'string' && detail.current_collection.trim() ? detail.current_collection.trim() : null;
    const processed = count(detail?.processed_items);
    message = detail?.phase === 'discovering' ? 'Looking for gifts. The total will be known when the search finishes.'
      : collection ? `Checking ${collection}.` : job.kind === 'refresh' ? 'Checking your saved gifts.' : 'Checking and saving new information.';
    if (processed !== null && processed > 0 && detail?.phase !== 'discovering') message += ` ${number(processed)} records read.`;
  }
  const labels: Record<SyncPresentation['state'], string> = {preparing: 'Preparing', running: 'In progress', waiting: 'Waiting', paused: 'Paused', stopping: 'Stopping', complete: 'Complete', failed: 'Needs attention'};
  return {
    title: (['paused', 'complete', 'failed'].includes(state) ? savedTitles[job.kind] : titles[job.kind]) || 'Saved data', objective: objective(job, options.timeframeLabel), state, stateLabel: labels[state], message,
    progress: jobProgress(job), actionLabel: state === 'paused' ? 'Continue' : state === 'failed' ? reason === 'cursor' ? 'Start again' : 'Retry' : null,
    rawReason: job.reason, cacheNote: cacheNote(job, options.now ?? Date.now()),
  };
}

export function presentOwnedPriceSync(snapshot: OwnedPriceSnapshot, options: {stopping?: boolean} = {}): SyncPresentation {
  const run = snapshot.run, reason = knownReason(run?.reason ?? null);
  let state: SyncPresentation['state'], message: string;
  if (options.stopping && snapshot.phase === 'checking') {
    state = 'stopping'; message = 'Finishing the current check, then stopping.';
  } else if (snapshot.phase === 'complete') {
    state = 'complete';
    const updated = count(run?.updated), unresolved = count(run?.unresolved);
    message = run?.total === 0 ? 'No saved gifts need a price check.' : updated !== null ? `${number(updated)} gift price${updated === 1 ? '' : 's'} refreshed.` : 'Your gift price check is complete.';
    if (unresolved !== null && unresolved > 0) message += ` ${number(unresolved)} could not be updated.`;
  } else if (snapshot.phase === 'unavailable') {
    state = 'failed'; message = 'The price check could not finish. Your saved prices are still available.';
  } else if (snapshot.phase === 'partial') {
    state = 'paused'; message = reason === 'stopped' ? 'Stopped. Checked prices are saved.' : 'The price check paused. Checked prices are saved.';
  } else if (reason === 'retry') {
    state = 'waiting'; message = 'Waiting for the data provider before checking more prices.';
  } else if (!run) {
    state = 'preparing'; message = 'Preparing to check your saved gifts.';
  } else {
    state = 'running'; message = 'Checking current daily prices for your saved gifts.';
  }
  const labels: Record<SyncPresentation['state'], string> = {preparing: 'Preparing', running: 'In progress', waiting: 'Waiting', paused: 'Paused', stopping: 'Stopping', complete: 'Complete', failed: 'Needs attention'};
  return {
    title: ['paused', 'complete', 'failed'].includes(state) ? 'Your gift prices' : 'Updating your gift prices', objective: 'Checking daily prices for gifts you already own.', state, stateLabel: labels[state], message,
    progress: progress(run?.checked, run?.total, 'gifts', snapshot.phase === 'complete'),
    actionLabel: null, rawReason: run?.reason ?? null, cacheNote: null,
  };
}
