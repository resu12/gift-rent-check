import type { Job, PricingSelection } from './types.ts';
import { historyCollectionError, pricingQuery } from './pricingSelection.ts';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const comparison = (job: Job) => ['prices', 'rental_prices', 'collect'].includes(job.kind);

/** Only an explicit backend incompatibility replaces the saved Resume action. */
export function presentResumeSupport(job: Job) {
  const blocked = job.resume_supported === false;
  const now = typeof job.progress?.server_time === 'number' ? job.progress.server_time : Date.now();
  const lease = job.progress?.lease_until;
  const deadline = typeof lease === 'number' ? lease : typeof job.progress?.next_allowed_at === 'number' ? job.progress.next_allowed_at : 0;
  const idle = Number.isFinite(deadline) && Number.isFinite(now) && deadline <= now;
  return {
    blocked,
    message: blocked ? 'Older scan has no saved timeframe. Start a new 30-day scan; saved records are kept.' : null,
    actionLabel: blocked && comparison(job) && ['partial', 'failed'].includes(job.state) ? 'New 30-day scan' : null,
    canStart: blocked && comparison(job) && ['partial', 'failed'].includes(job.state) && idle,
  };
}

/** Replaced paused scans stay in Activity; the main view emphasizes current work. */
export function visibleDashboardJobs(jobs: Job[]): Job[] {
  const latestId = Math.max(0, ...jobs.map(job => job.id));
  const active = (job: Job) => job.state === 'running' || job.state === 'queued';
  return jobs.filter(job => active(job)
    || (job.state === 'partial' && !jobs.some(newer => newer.kind === job.kind && newer.id > job.id))
    || (job.id === latestId && (job.state === 'failed' || (job.state === 'complete' && (job.progress.market_cache?.reused_streams || 0) > 0))))
    .sort((a, b) => Number(active(b)) - Number(active(a)) || b.id - a.id).slice(0, 3);
}

export function presentCollectionEfficiency(job: Job) {
  const saved = job.progress?.efficiency;
  const valid = saved && count(saved.page_size) && saved.page_size >= 1 && saved.page_size <= 100
    && count(saved.recommended_page_size) && saved.recommended_page_size <= 100 && saved.recommended_page_size >= 1;
  const legacy = Boolean(valid && comparison(job) && ['queued', 'running', 'partial'].includes(job.state) && saved.page_size < saved.recommended_page_size);
  const now = typeof job.progress?.server_time === 'number' ? job.progress.server_time : Date.now();
  const lease = job.progress?.lease_until;
  // Older cloud replies merged the request lease into this deadline. Waiting
  // for that deadline is conservative until the separate lease field is present.
  const deadline = typeof lease === 'number' ? lease : typeof job.progress?.next_allowed_at === 'number' ? job.progress.next_allowed_at : 0;
  const inFlight = !Number.isFinite(deadline) || !Number.isFinite(now) || deadline > now;
  const canStart = legacy && job.state === 'partial' && !inFlight;
  const warning = !legacy ? null : `This saved scan reads only ${saved!.page_size} items per request. New refreshes use ${saved!.recommended_page_size}. `
    + (job.state !== 'partial' ? 'Stop this scan before starting an efficient refresh.' : inFlight ? 'Wait for the current request to finish before starting a new refresh.' : 'Start an efficient refresh from the newest data, or continue this older scan.');
  const sampled = job.state !== 'complete' && saved?.scheduling === 'round_robin' && count(saved.collections_started) && count(saved.collections_total)
    && saved.collections_total > 0 && saved.collections_started <= saved.collections_total
    ? `${saved.collections_started.toLocaleString('en-US')} of ${saved.collections_total.toLocaleString('en-US')} collections sampled · sampling is not completion`
    : null;
  return { legacy, canStart, warning, sampled, pageSize: valid ? saved.page_size : null, recommendedPageSize: valid ? saved.recommended_page_size : null };
}

/** A new run keeps the selected period, not the old traversal's absolute bounds. */
export function efficientRefreshSelection(job: Job, fallback: PricingSelection, now = new Date()): PricingSelection {
  if (!comparison(job)) throw new Error('Only comparison scans support an efficient refresh.');
  if (job.resume_supported === false) return { source: job.kind === 'rental_prices' ? 'rentals' : 'listings', timeframe: '30d' };
  const window = job.collection_window;
  const chosen: PricingSelection = {
    source: job.kind === 'rental_prices' ? 'rentals' : 'listings',
    timeframe: window?.timeframe ?? fallback.timeframe,
    ...(window?.timeframe === 'custom' ? { dateFrom: window.date_from || undefined, dateTo: window.date_to || undefined }
      : !window && fallback.timeframe === 'custom' ? { dateFrom: fallback.dateFrom, dateTo: fallback.dateTo } : {}),
  };
  pricingQuery(chosen);
  if (job.kind !== 'prices') {
    const error = historyCollectionError(chosen, now);
    if (error) throw new Error(`${error} Choose a recent timeframe and start a normal refresh instead.`);
  }
  return chosen;
}
