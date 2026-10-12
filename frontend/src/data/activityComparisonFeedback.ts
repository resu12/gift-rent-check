import type { Capabilities, Job } from './types.ts';
import { activityComparisonResumeAvailability } from './activityFreshnessActions.ts';
import { availableAgainMessage, compactJobMessage, marketappAvailableAt, presentJobSync } from './syncPresentation.ts';

export interface ComparisonActionFeedback {
  message: string;
  tone: 'pending' | 'success' | 'warning' | 'error';
}

export interface ComparisonAllowanceFeedback {
  message: string;
  tone: 'warning';
  availableAt: string | null;
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 ? value : null;
const comparison = (job: Job): boolean => job.kind === 'prices' || job.kind === 'rental_prices' || job.kind === 'collect';
const messageText = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);

/** Report what the action actually returned, including an immediate saved pause.
 * Raw provider reasons never become the user-facing explanation.
 */
export function comparisonActionFeedback(job: Job, now = Date.now()): ComparisonActionFeedback {
  const view = presentJobSync(job, { now });
  if (view.state === 'complete') return { message: 'Finished · comparison prices saved.', tone: 'success' };
  if (view.state === 'failed') return { message: messageText(compactJobMessage(job, view, now)), tone: 'error' };
  if (view.state === 'paused' || job.progress?.client_interrupted === true) {
    const availability = activityComparisonResumeAvailability(job);
    if (!availability.canResume) return {
      message: availability.actionLabel === 'Finishing…' ? 'Finishing the previous request…'
        : 'Reload saved data to confirm the previous request has finished.',
      tone: 'pending',
    };
    return {
      message: job.progress?.client_interrupted === true && view.state !== 'paused'
        ? 'Paused · progress saved. Continue to resume the checks.'
        : messageText(`Paused · ${compactJobMessage(job, view, now)}`),
      tone: 'warning',
    };
  }
  if (view.state === 'stopping') return { message: 'Finishing the current request and saving progress…', tone: 'pending' };
  if (view.state === 'waiting') return { message: messageText(compactJobMessage(job, view, now)), tone: 'pending' };
  return { message: 'Update started · checking comparison prices…', tone: 'pending' };
}

/** A current allowance snapshot takes precedence over old saved pause reasons.
 * Availability dates explain a server block; a local clock never clears it.
 * Missing/malformed counters and ordinary pacing are not evidence of exhaustion.
 */
export function comparisonAllowanceFeedback(
  jobs: Job[], capabilities?: Pick<Capabilities, 'marketapp_limits'> | null, accountGeneration?: number,
  now = Date.now(),
): ComparisonAllowanceFeedback | null {
  if (accountGeneration !== undefined && (!Number.isSafeInteger(accountGeneration) || accountGeneration < 0)) return null;
  const scoped = jobs.filter(job => comparison(job)
    && (accountGeneration === undefined || job.account_generation === accountGeneration));
  const newest = scoped.reduce<Job | null>((saved, job) => count(job.id) !== null
    && (!saved || job.id > saved.id) ? job : saved, null);
  const current = object(capabilities?.marketapp_limits);
  const budget = current ?? object(newest?.progress?.provider_budget ?? newest?.progress?.marketapp_budget);
  if (!budget) return null;
  const used = count(current ? budget.used_24h : budget.rolling_24h_used);
  const limit = count(current ? budget.rolling_24h_attempts : budget.rolling_24h_limit);
  const providerBlocked = budget.provider_allowance_blocked === true;
  const exhausted = used !== null && limit !== null && limit > 0 && used >= limit;
  if (!providerBlocked && !exhausted) return null;
  const availableAt = marketappAvailableAt(providerBlocked ? 1 : used, providerBlocked ? 1 : limit, budget.available_at);
  const at = availableAt === null ? NaN : Date.parse(availableAt);
  const deadline = availableAt && Number.isFinite(now) && at > now ? availableAgainMessage(availableAt, now) : null;
  return {
    message: deadline ?? (availableAt ? 'Allowance status needs a refresh. Reload saved data before continuing.'
      : providerBlocked ? 'Marketapp request allowance is unavailable · progress saved.'
        : 'Rolling 24-hour request allowance used · progress saved.'),
    tone: 'warning', availableAt,
  };
}
