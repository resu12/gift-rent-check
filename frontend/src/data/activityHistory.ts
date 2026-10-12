import type { DataRecord, Job } from './types.ts';

const object = (value: unknown): DataRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as DataRecord : null;

function zeroCounters(record: DataRecord, fields: string[]): boolean {
  return fields.every(field => !Object.hasOwn(record, field) || record[field] === 0);
}

function neverCollected(job: Job): boolean {
  const detail = object(job.progress);
  // Page counts survive Resume. A displayed 0% or a fresh invocation's request
  // count cannot prove that an older traversal has no saved work.
  if (!detail || detail.pages !== 0 || !zeroCounters(detail, ['observations', 'streams_complete', 'candidates', 'verified', 'checked', 'pending', 'attempts'])) return false;
  for (const [field, counters] of [
    ['sync', ['completed', 'processed_items']],
    ['market_cache', ['reused_streams']],
    ['listing_refresh', ['reused_streams']],
    ['efficiency', ['collections_started']],
    ['marketapp_budget', ['invocation_used']],
  ] as const) {
    if (!Object.hasOwn(detail, field)) continue;
    const nested = object(detail[field]);
    if (!nested || !zeroCounters(nested, [...counters])) return false;
  }
  return true;
}

/** Hide superseded empty pauses without deleting checkpoints or evidence. */
export function visibleActivityJobs(jobs: Job[]): Job[] {
  const latest = new Map<Job['kind'], number>();
  for (const job of jobs) latest.set(job.kind, Math.max(latest.get(job.kind) ?? 0, job.id));
  return jobs.filter(job => {
    const paused = job.state === 'partial' || ((job.state === 'running' || job.state === 'queued') && job.progress?.requires_resume === true);
    return !paused || job.id === latest.get(job.kind) || !neverCollected(job);
  }).sort((a, b) => b.id - a.id);
}

/**
 * Keep each kind's active syncs, or its newest sync if unfinished, in current.
 * A newer completion supersedes older pauses. Saved work and failure evidence
 * remain in previous; only the empty pauses hidden by visibleActivityJobs are
 * omitted. Every truly active job stays current so its Stop control is available.
 */
export function activityJobGroups(jobs: Job[]): {current: Job[]; previous: Job[]} {
  const visible = visibleActivityJobs(jobs);
  const active = (job: Job): boolean => (job.state === 'queued' || job.state === 'running') && job.progress?.requires_resume !== true;
  const activeKinds = new Set(visible.filter(active).map(job => job.kind));
  const newest = new Map<Job['kind'], Job>();
  for (const job of visible) if (!newest.has(job.kind)) newest.set(job.kind, job);

  const current: Job[] = [], previous: Job[] = [];
  for (const job of visible) {
    if (active(job) || (!activeKinds.has(job.kind) && newest.get(job.kind) === job && job.state !== 'complete')) current.push(job);
    else previous.push(job);
  }
  current.sort((a, b) => Number(active(b)) - Number(active(a)) || b.id - a.id);
  return {current, previous};
}
