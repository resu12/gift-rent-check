import type { Job, PricingSelection, PricingSource } from './types.ts';
import { activityJobGroups } from './activityHistory.ts';
import { validDateRange } from './pricingSelection.ts';

const boundedPeriods = new Set(['24h', '7d', '30d', '60d', '90d']);
const covers = (job: Job, source: PricingSource): boolean => job.kind === 'collect'
  || job.kind === (source === 'listings' ? 'prices' : 'rental_prices');

export interface ActivityComparisonResumeAvailability {
  canResume: boolean;
  actionLabel: 'Continue' | 'Finishing…' | 'Check status';
  reason: string | null;
}

const savedTime = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0;

/** A Stop can save a partial job before its provider request releases the lease.
 * Keep that cursor, but require a saved status response to confirm it is safe
 * to continue. A local clock must not enable Continue on stale lease evidence.
 */
export function activityComparisonResumeAvailability(job: Job): ActivityComparisonResumeAvailability {
  const progress = job.progress ?? {};
  const hasLease = Object.hasOwn(progress, 'lease_until');
  const hasLegacyDeadline = !hasLease && Object.hasOwn(progress, 'next_allowed_at');
  const deadline = hasLease ? progress.lease_until : hasLegacyDeadline ? progress.next_allowed_at : 0;
  const serverTime = progress.server_time;
  const invalidTiming = !savedTime(deadline)
    || Object.hasOwn(progress, 'server_time') && !savedTime(serverTime)
    || deadline > 0 && !savedTime(serverTime);
  if (invalidTiming) return {
    canResume: false, actionLabel: 'Check status',
    reason: 'Saved request timing could not be confirmed. Reload saved data before continuing.',
  };
  if (deadline > 0 && savedTime(serverTime) && deadline > serverTime) return {
    canResume: false, actionLabel: 'Finishing…',
    reason: 'The last request is still finishing. Reload saved data before continuing.',
  };
  return { canResume: true, actionLabel: 'Continue', reason: null };
}

/** Collection requests share a lease, including when another source or period
 * is displayed. Ignore superseded jobs and other account generations before
 * deciding whether any current request prevents Update or Continue.
 */
export function activityComparisonRequestBlocker(
  jobs: Job[], accountGeneration?: number,
): ActivityComparisonResumeAvailability | null {
  if (accountGeneration !== undefined && (!Number.isSafeInteger(accountGeneration) || accountGeneration < 0)) return {
    canResume: false, actionLabel: 'Check status',
    reason: 'The current account could not be confirmed. Reload saved data before continuing.',
  };
  const scoped = jobs.filter(job => accountGeneration === undefined || job.account_generation === accountGeneration);
  const current = activityJobGroups(scoped).current
    .filter(job => job.kind === 'prices' || job.kind === 'rental_prices' || job.kind === 'collect')
    .sort((a, b) => b.id - a.id);
  for (const candidate of current) {
    const availability = activityComparisonResumeAvailability(candidate);
    if (!availability.canResume) return availability;
  }
  return null;
}

/** A live request lease is normal while a scan advances through pages. Describe
 * the scan here; reserve Finishing for its interrupted or stopped request.
 * Another source's lease disables actions without changing this row's label.
 */
export function activityComparisonActionLabel(
  source: PricingSource, jobs: Job[], selection: PricingSelection, accountGeneration?: number,
): string {
  if (accountGeneration !== undefined && (!Number.isSafeInteger(accountGeneration) || accountGeneration < 0)) return 'Check status';
  const scoped = jobs.filter(job => accountGeneration === undefined || job.account_generation === accountGeneration);
  const current = activityJobGroups(scoped).current.filter(job => covers(job, source));
  const working = current.some(job => (job.state === 'running' || job.state === 'queued')
    && job.progress?.requires_resume !== true && job.progress?.client_interrupted !== true && !job.stop_requested);
  if (working) return 'Updating…';
  for (const candidate of current) {
    const availability = activityComparisonResumeAvailability(candidate);
    if (!availability.canResume) return availability.actionLabel;
  }
  return resumableActivityComparisonJob(source, jobs, selection, accountGeneration) ? 'Continue' : 'Update';
}

/** Continue only the current scan's saved cursor; never resurrect an older scan. */
export function resumableActivityComparisonJob(
  source: PricingSource, jobs: Job[], selection: PricingSelection, accountGeneration?: number,
): Job | null {
  if (accountGeneration !== undefined && (!Number.isSafeInteger(accountGeneration) || accountGeneration < 0)) return null;
  const scoped = jobs.filter(job => accountGeneration === undefined || job.account_generation === accountGeneration);
  const newest = scoped.filter(job => covers(job, source)).reduce<Job | null>(
    (found, job) => !found || job.id > found.id ? job : found, null,
  );
  if (!newest || newest.resume_supported === false || !activityJobGroups(scoped).current.includes(newest)) return null;
  if (newest.state !== 'partial' && !(newest.state === 'running' && newest.progress?.requires_resume === true)) return null;
  const window = newest.collection_window;
  if (!window || window.timeframe !== selection.timeframe) return null;
  if (window.timeframe === 'custom') {
    const from = window.date_from, to = window.date_to;
    if (typeof from !== 'string' || typeof to !== 'string' || !validDateRange(from, to)
      || from !== selection.dateFrom || to !== selection.dateTo) return null;
  } else if (!boundedPeriods.has(window.timeframe)) return null;
  return newest;
}
