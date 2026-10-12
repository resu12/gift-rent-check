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
  availableAt: string | null;
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

function interruptedMessage(job: Job): string {
  const lease = job.progress?.lease_until, serverTime = job.progress?.server_time;
  return typeof lease === 'number' && Number.isSafeInteger(lease) && typeof serverTime === 'number' && Number.isSafeInteger(serverTime) && lease > serverTime
    ? 'The last request is still finishing. Checking saved progress…' : 'Checking saved progress…';
}

function knownReason(value: string | null): Reason {
  const text = value?.toLowerCase() ?? '';
  if (/retry_exhausted|retries were exhausted|retry attempts exhausted/.test(text)) return 'retry_failed';
  if (/authentication[ _]failed|rejected authentication|authentication error|unauthorized|forbidden/.test(text)) return 'access';
  if (/cursor_cycle|cursor_rejected|repeated a cursor|rejected the saved cursor|saved cursor may be invalid|incompatible_history_plan|saved history refresh plan is incompatible|non.retryable error/.test(text)) return 'cursor';
  if (/invalid_response|malformed data|malformed response|response_too_large|page safety limit|unexpected_redirect|unexpected url|invalid_retry_after|unsupported retry deadline/.test(text)) return 'response';
  if (/stopped_by_you|user_stopped|stopped by you/.test(text)) return 'stopped';
  if (/daily_limit|dashboard_daily_budget|rolling 24.hour|daily.*(?:limit|allowance|budget)/.test(text)) return 'daily';
  if (/retry_wait|provider_wait|provider retry deadline|retry.after|provider (?:cooldown|wait)|rate.limit/.test(text)) return 'retry';
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
  if (reason === 'daily') return 'The rolling 24-hour request allowance is used up. Your progress is saved; continue when requests leave the window.';
  if (reason === 'retry') return 'The data provider asked us to wait. Your progress is saved; continue later.';
  if (reason === 'limit') return 'This batch reached its limit. Continue to pick up where it stopped.';
  if (reason === 'stopped') return 'Stopped. Your progress is saved; continue whenever you are ready.';
  return 'Your progress is saved. Continue to pick up where it stopped.';
}

/** First usable capacity, not merely the first request leaving the window. */
export function marketappAvailableAt(usedValue: unknown, limitValue: unknown, value: unknown): string | null {
  const used = count(usedValue), limit = count(limitValue);
  if (used === null || limit === null || limit === 0 || used < limit || typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null;
}

export function availableAgainMessage(at: string, now = Date.now()): string {
  const date = new Date(at);
  if (date.getTime() <= now) return 'Availability time reached · try Continue.';
  const current = new Date(now), tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = (other: Date) => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
  const day = sameDay(current) ? 'today' : sameDay(tomorrow) ? 'tomorrow'
    : new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', ...(date.getFullYear() !== current.getFullYear() ? {year: 'numeric' as const} : {})}).format(date);
  const time = new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit', timeZoneName: 'short'}).format(date);
  return `Available again ${day} at ${time}`;
}

function failedMessage(reason: Reason): string {
  if (reason === 'access') return 'Access was rejected. Check the API connection before trying again.';
  if (reason === 'cursor') return 'This saved scan cannot continue. Start a new refresh; your saved data is kept.';
  if (reason === 'response') return 'The provider returned an unexpected response. Saved progress is kept; try again later.';
  if (reason === 'network' || reason === 'retry_failed') return 'The provider could not be reached. Saved progress is kept; try again later.';
  return 'The refresh could not finish. Your saved data is still available; try again later.';
}

/** The main surface needs the next step; diagnostics remain in Details. */
export function compactJobMessage(job: Job, view: SyncPresentation, now = Date.now()): string {
  const reason = knownReason(job.reason);
  if (view.state === 'paused') {
    if (reason === 'daily') {
      const budget = object(job.progress?.provider_budget ?? job.progress?.marketapp_budget);
      const used = count(budget?.rolling_24h_used), limit = count(budget?.rolling_24h_limit);
      return budget?.provider_allowance_blocked !== true && used !== null && limit !== null && limit > used
        ? 'Allowance available · ready to continue.' : view.availableAt
          ? availableAgainMessage(view.availableAt, now) : 'Rolling 24-hour allowance used · progress saved.';
    }
    if (reason === 'retry') return 'Provider cooldown · continue later.';
    return 'Progress saved · ready to continue.';
  }
  if (view.state === 'waiting') return job.progress?.client_interrupted === true
    ? interruptedMessage(job) : 'Provider cooldown · retrying automatically.';
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
  const current = typeof detail?.current_collection === 'string' && detail.current_collection.trim()
    ? `Checking ${detail.current_collection.trim()}` : job.kind === 'discover' ? 'Finding gifts…' : 'Checking for updates…';
  const processed = count(detail?.processed_items);
  return view.progress.completed === 0 && processed !== null && processed > 0 && detail?.phase !== 'discovering'
    ? `${current} · ${number(processed)} records read` : current;
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
    const budget = object(job.progress?.provider_budget ?? job.progress?.marketapp_budget), used = count(budget?.rolling_24h_used), limit = count(budget?.rolling_24h_limit);
    message = reason === 'daily' && budget?.provider_allowance_blocked !== true && used !== null && limit !== null && limit > 0 && used < limit
      ? 'Your request allowance is available again. Continue from your saved progress.'
      : pausedMessage(reason);
  } else if (active && job.progress?.client_interrupted === true) {
    state = 'waiting'; message = interruptedMessage(job);
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
  const budget = object(job.progress?.provider_budget ?? job.progress?.marketapp_budget);
  return {
    title: (['paused', 'complete', 'failed'].includes(state) ? savedTitles[job.kind] : titles[job.kind]) || 'Saved data', objective: objective(job, options.timeframeLabel), state, stateLabel: labels[state], message,
    progress: jobProgress(job), actionLabel: state === 'paused' ? 'Continue' : state === 'failed' ? reason === 'cursor' ? 'Start again' : 'Retry' : null,
    rawReason: job.reason, cacheNote: cacheNote(job, options.now ?? Date.now()),
    availableAt: state === 'paused' && reason === 'daily'
      ? marketappAvailableAt(budget?.provider_allowance_blocked ? 1 : budget?.rolling_24h_used, budget?.provider_allowance_blocked ? 1 : budget?.rolling_24h_limit, budget?.available_at) : null,
  };
}

export function presentOwnedPriceSync(snapshot: OwnedPriceSnapshot, options: {stopping?: boolean; rentalStatus?: boolean} = {}): SyncPresentation {
  const run = snapshot.run, reason = knownReason(run?.reason ?? null);
  const combined = options.rentalStatus === true;
  const single = run?.scope === 'gift';
  const verification = snapshot.verification;
  const supplemental = verification?.stage === 'ton' && snapshot.provider === 'marketapp_website';
  const finalizing = snapshot.phase === 'checking' && (verification?.stage === 'ton'
    ? verification.total > 0 && verification.checked === verification.total
    : Boolean(snapshot.provider && run && run.total > 0 && run.checked === run.total));
  let state: SyncPresentation['state'], message: string;
  if (options.stopping && snapshot.phase === 'checking') {
    state = 'stopping'; message = 'Finishing the current check, then stopping.';
  } else if (snapshot.phase === 'complete') {
    state = 'complete';
    const updated = count(run?.updated), unresolved = count(run?.unresolved);
    const statuses = count(run?.status_updated), statusUnresolved = count(run?.status_unresolved);
    message = combined ? run?.total === 0 ? 'No saved gifts to check.' : statuses !== null ? `${number(statuses)} rental status${statuses === 1 ? '' : 'es'} checked.` : 'Gift check finished. Rental status was not confirmed.'
      : run?.total === 0 ? 'No saved gifts need a price check.' : updated !== null ? `${number(updated)} gift price${updated === 1 ? '' : 's'} refreshed.` : 'Your gift price check is complete.';
    if (snapshot.cacheHit) message = 'Your gifts were checked recently.';
    const failures = combined ? statusUnresolved : unresolved;
    if (failures !== null && failures > 0) message += ` ${number(failures)} could not be updated.`;
  } else if (snapshot.phase === 'unavailable') {
    state = 'failed'; message = combined ? 'The gift check could not finish. Saved evidence is still available.' : 'The price check could not finish. Your saved prices are still available.';
  } else if (snapshot.phase === 'partial') {
    state = 'paused'; message = reason === 'retry' ? snapshot.provider === 'marketapp_website'
      ? 'TON requested a pause. Marketapp gift data is saved. Try refreshing again later.'
      : 'The provider requested a pause. Completed checks are saved. Try refreshing again later.'
      : combined ? reason === 'stopped' ? 'Stopped. Completed checks are saved.' : 'The gift check paused. Completed checks are saved.'
      : reason === 'stopped' ? 'Stopped. Checked prices are saved.' : 'The price check paused. Checked prices are saved.';
  } else if (reason === 'retry' || verification?.waiting) {
    state = 'waiting'; message = supplemental ? 'TON requested a pause. Saved gift data is already available.'
      : verification?.stage === 'ton' ? 'TON requested a pause before continuing gift checks.'
        : single ? 'Waiting for the data provider to check this gift.' : combined ? 'Waiting for the data provider before checking more gifts.' : 'Waiting for the data provider before checking more prices.';
  } else if (!run) {
    state = 'preparing'; message = 'Preparing to check your saved gifts.';
  } else {
    state = 'running'; message = finalizing ? 'Finishing gift checks and confirming saved results.'
      : supplemental ? 'Marketapp data saved. Checking missing details and rental expiry on TON.'
        : single ? combined ? 'Checking this gift’s rental status and daily price.' : 'Checking this gift’s daily price.' : snapshot.provider === 'marketapp_website' ? 'Refreshing your saved gifts from Marketapp.' : combined ? 'Checking rental status and daily prices for your saved gifts.' : 'Checking current daily prices for your saved gifts.';
  }
  const labels: Record<SyncPresentation['state'], string> = {preparing: 'Preparing', running: 'In progress', waiting: 'Waiting', paused: 'Paused', stopping: 'Stopping', complete: 'Complete', failed: 'Needs attention'};
  let workload = progress(run?.checked, run?.total, 'gifts', snapshot.phase === 'complete');
  if (verification?.stage === 'ton' && snapshot.phase === 'checking') {
    workload = progress(verification.checked, verification.total, 'checks', false);
    if (supplemental && verification.total > 0) workload.label = `${number(verification.checked)} of ${number(verification.total)} additional TON checks finished`;
  }
  // Checked gifts and completed supplemental work are distinct. Never imply
  // a remaining one percent when the server is still confirming the result.
  if (finalizing) workload = { ...workload, percent: null, indeterminate: true, label: 'Finishing gift checks…' };
  else if (snapshot.provider && run && run.total > 0 && run.checked === run.total
    && (snapshot.phase === 'partial' || snapshot.phase === 'unavailable')) {
    workload = { ...workload, percent: null, indeterminate: false, label: 'Gift data saved · Check incomplete' };
  }
  return {
    title: supplemental && snapshot.phase === 'checking' ? 'Checking additional gift details' : run?.scope === 'gift' ? ['paused', 'complete', 'failed'].includes(state) ? 'Selected gift' : 'Checking selected gift' : combined ? ['paused', 'complete', 'failed'].includes(state) ? 'Your gifts' : 'Updating your gifts' : ['paused', 'complete', 'failed'].includes(state) ? 'Your gift prices' : 'Updating your gift prices', objective: run?.scope === 'gift' ? 'Checking only the selected gift through TON.' : combined ? 'Checking rental status and daily prices for gifts you already own.' : 'Checking daily prices for gifts you already own.', state, stateLabel: labels[state], message,
    progress: workload,
    actionLabel: null, rawReason: run?.reason ?? null, cacheNote: null, availableAt: null,
  };
}
