import { relativeTime } from './helpers.ts';
import type { ActivityFreshnessRow } from './activityFreshness.ts';

export interface ActivityStatusFeedback {
  message: string;
  tone: 'pending' | 'success' | 'warning' | 'error';
}

export function activityStatusTimestamp(value: string | null | undefined, now: number): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + 30000 ? value : null;
}

/** Layout only: preserve the source model's independent check and value evidence. */
export function activityStatusPresentation(row: ActivityFreshnessRow, now: number, feedback?: ActivityStatusFeedback) {
  const primaryCheck = row.checkPresentation;
  const pending = row.updating || feedback?.tone === 'pending';
  const tone = primaryCheck?.tone ?? row.tone;
  const status = pending ? row.updating ? 'Updating' : 'Starting' : primaryCheck?.status ?? row.status;
  const timestamp = activityStatusTimestamp(row.refreshFailure ? row.updatedAt : primaryCheck ? primaryCheck.checkedAt : row.updatedAt, now);
  const timeSubject = row.refreshFailure ? 'Saved data' : primaryCheck ? 'Checked' : 'Updated';
  const age = timestamp ? relativeTime(timestamp, now) : null;
  const time = age ? primaryCheck && !row.refreshFailure ? age : `${timeSubject} ${age}`
    : primaryCheck && !row.refreshFailure ? 'No check date' : 'No saved update';
  let coverage = row.coverage;
  if (row.id === 'gifts' || row.id === 'prices') {
    const checking = pending && /(?:Checking|Check paused) · (\d+\/\d+) checked/.exec(row.checkStatus ?? '');
    const warning = row.availabilityWarning ? row.coverage.split(' · ').slice(1).join(' · ') : '';
    const confirmed = /^(\d+) (?:status(?:es)? confirmed|prices? available)/.exec(row.coverage);
    coverage = checking ? `${checking[1]} checked${warning ? ` · ${warning}` : ''}`
      : warning || (confirmed ? `${confirmed[1]} ${row.id === 'gifts' ? 'confirmed' : 'prices available'}` : row.coverage);
  } else if (row.id === 'listings' || row.id === 'rentals') {
    const counts = /^(\d+) of (\d+) collections checked(?: · (\d+) unresolved)?/.exec(row.coverage);
    coverage = counts ? `${counts[1]}/${counts[2]} collections${counts[3] ? ` · ${counts[3]} unresolved` : ''}`
      : row.coverage === 'Coverage not confirmed' ? 'Coverage unknown' : row.coverage;
  } else if (row.id.startsWith('analytics-')) coverage = '';
  const notice = row.refreshFailure ? { message: row.refreshFailure, tone: 'error' as const }
    : feedback && feedback.tone !== 'pending' && !(pending && feedback.tone === 'success') ? feedback : undefined;
  return { tone, status, pending, timestamp, time, timeDescription: age ? `${timeSubject} ${age}` : time,
    coverage, coverageWarning: row.availabilityWarning === true, notice };
}
