import assert from 'node:assert/strict';
import test from 'node:test';
import { activityStatusPresentation, activityStatusTimestamp } from './activityStatusPresentation.ts';
import type { ActivityFreshnessRow } from './activityFreshness.ts';

const now = Date.parse('2026-10-12T04:40:00Z'), old = '2026-10-11T18:48:00.000Z';
function row(changes: Partial<ActivityFreshnessRow> = {}): ActivityFreshnessRow {
  return { id: 'gifts', label: 'Gifts & rental status', tone: 'older', state: 'incomplete', status: 'Partly updated',
    updatedAt: old, oldestUpdatedAt: old, coverage: '112 statuses confirmed · 49 unverified', detail: 'Retained source details.',
    freshnessMinutes: 5, updating: false, checkStatus: 'Check complete · 161/161 checked', checkedAt: old,
    availabilityWarning: true, ...changes };
}

test('compact fresh check presentation retains the unavailable-value warning without renewing old observations', () => {
  const input = row({ checkPresentation: { tone: 'fresh', status: 'Checked', checkedAt: new Date(now - 30000).toISOString() } });
  const before = JSON.stringify(input), shown = activityStatusPresentation(input, now);
  assert.equal(shown.status, 'Checked'); assert.equal(shown.tone, 'fresh'); assert.equal(shown.time, 'Just now');
  assert.equal(shown.timeDescription, 'Checked Just now'); assert.equal(shown.coverage, '49 unverified');
  assert.equal(shown.coverageWarning, true); assert.equal(input.updatedAt, old);
  assert.equal(JSON.stringify(input), before);
});

test('failed refresh exposes only one explicit notice while dating the saved values', () => {
  const input = row({ refreshFailure: 'Refresh failed. Saved data is kept.',
    checkPresentation: { tone: 'older', status: 'Check failed', checkedAt: null } });
  const shown = activityStatusPresentation(input, now, { tone: 'error', message: 'Duplicate failure feedback.' });
  assert.equal(shown.status, 'Check failed'); assert.equal(shown.tone, 'older');
  assert.equal(shown.time, 'Saved data 9h ago'); assert.equal(shown.timestamp, old);
  assert.deepEqual(shown.notice, { tone: 'error', message: 'Refresh failed. Saved data is kept.' });
});

test('checking progress appears once without changing old source freshness', () => {
  const input = row({ updating: true, checkStatus: 'Checking · 52/161 checked' });
  const shown = activityStatusPresentation(input, now, { tone: 'pending', message: 'A detailed pending explanation.' });
  assert.equal(shown.pending, true); assert.equal(shown.status, 'Updating'); assert.equal(shown.tone, 'older');
  assert.equal(shown.coverage, '52/161 checked · 49 unverified'); assert.equal(shown.notice, undefined);
  assert.equal(shown.timestamp, old);
});

test('pending start feedback uses a single starting state instead of a duplicate pending message', () => {
  const shown = activityStatusPresentation(row(), now, { tone: 'pending', message: 'Starting the comparison check.' });
  assert.equal(shown.status, 'Starting'); assert.equal(shown.pending, true); assert.equal(shown.notice, undefined);
  assert.equal(shown.time, 'Updated 9h ago');
});

test('comparison coverage stays concise and keeps unresolved collections', () => {
  const shown = activityStatusPresentation(row({ id: 'rentals', coverage: '17 of 45 collections checked · 2 unresolved · last 30 days', availabilityWarning: false }), now);
  assert.equal(shown.coverage, '17/45 collections · 2 unresolved');
  assert.equal(activityStatusPresentation(row({ id: 'listings', coverage: 'Coverage not confirmed' }), now).coverage, 'Coverage unknown');
});

test('complete source coverage and analytics avoid repeating the title’s reporting period', () => {
  assert.equal(activityStatusPresentation(row({ coverage: '161 statuses confirmed', availabilityWarning: false }), now).coverage, '161 confirmed');
  assert.equal(activityStatusPresentation(row({ id: 'prices', coverage: '161 prices available', availabilityWarning: false }), now).coverage, '161 prices available');
  assert.equal(activityStatusPresentation(row({ id: 'analytics-365', label: 'Analytics · 1 year', coverage: '1 year report' }), now).coverage, '');
});

test('missing dates remain distinct from recent confirmed dates and never acquire a synthetic timestamp', () => {
  const shown = activityStatusPresentation(row({ updatedAt: null, oldestUpdatedAt: null, checkedAt: null,
    checkPresentation: { tone: 'older', status: 'Check not confirmed', checkedAt: null } }), now);
  assert.equal(shown.time, 'No check date'); assert.equal(shown.timestamp, null); assert.equal(shown.tone, 'older');
  const failed = activityStatusPresentation(row({ updatedAt: null, refreshFailure: 'Refresh failed.' }), now);
  assert.equal(failed.time, 'No saved update'); assert.equal(failed.timestamp, null);
  for (const invalid of ['invalid', new Date(now + 30001).toISOString(), null]) assert.equal(activityStatusTimestamp(invalid, now), null);
});

test('a started update suppresses obsolete success feedback, while current warnings remain visible', () => {
  assert.equal(activityStatusPresentation(row({ updating: true }), now, { tone: 'success', message: 'The update started.' }).notice, undefined);
  assert.deepEqual(activityStatusPresentation(row(), now, { tone: 'warning', message: 'Available again tomorrow.' }).notice,
    { tone: 'warning', message: 'Available again tomorrow.' });
});

test('analytics refresh notices remain visible and All time keeps dated coverage', () => {
  const notice = { tone: 'error' as const, message: 'Automatic refresh did not finish. Try Refresh again.' };
  const failed = activityStatusPresentation(row({ id: 'analytics-30', status: 'Refresh failed', refreshNotice: notice }), now);
  assert.equal(failed.status, 'Refresh failed'); assert.equal(failed.pending, false); assert.deepEqual(failed.notice, notice);
  const history = activityStatusPresentation(row({ id: 'analytics-all_time', status: 'Gaps in history', coverage: '29 days saved · 1 day missing' }), now);
  assert.equal(history.coverage, '29 days saved · 1 day missing'); assert.equal(history.time, 'Latest capture 9h ago');
});
