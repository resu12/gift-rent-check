import test from 'node:test';
import assert from 'node:assert/strict';
import { activityJobGroups, visibleActivityJobs } from './activityHistory.ts';
import type { Job } from './types.ts';

const job = (id: number, changes: Partial<Job> = {}): Job => ({
  id, kind: 'prices', state: 'partial', created_at: '', updated_at: '', run_id: id, stop_requested: false,
  reason: 'daily_limit', progress: {pages: 0, observations: 0, streams_complete: 0,
    sync: {phase: 'listings', completed: 0, total: 45, unit: 'collections', current_collection: null, processed_items: 0}}, ...changes,
});
const ids = (jobs: Job[]) => visibleActivityJobs(jobs).map(entry => entry.id);

test('repeated empty daily-limit pauses leave one current scan with its saved Continue identity', () => {
  const jobs = [job(2), job(1), job(4), job(3)], before = JSON.stringify(jobs);
  assert.deepEqual(ids(jobs), [4]);
  assert.equal(visibleActivityJobs(jobs)[0], jobs[2]);
  assert.equal(JSON.stringify(jobs), before);
  assert.deepEqual(ids(visibleActivityJobs(jobs)), [4]);
});

test('latest pending scan is kept independently for each collection kind', () => {
  assert.deepEqual(ids([job(1), job(2, {kind: 'rental_prices'}), job(3), job(4, {kind: 'collect'})]), [4, 3, 2]);
});

test('zero percent does not hide pages, records, discoveries, checks or reused comparisons', () => {
  for (const extra of [
    {pages: 1}, {observations: 1}, {streams_complete: 1}, {candidates: 1}, {verified: 1}, {pending: 1}, {checked: 1},
    {sync: {phase: 'listings', completed: 0, total: 45, unit: 'collections', processed_items: 10, current_collection: null}},
    {sync: {phase: 'listings', completed: 1, total: 45, unit: 'collections', processed_items: 0, current_collection: null}},
    {market_cache: {reused_streams: 1}}, {listing_refresh: {reused_streams: 1}}, {efficiency: {collections_started: 1}},
  ]) {
    const saved = job(1, {progress: {...job(1).progress, ...extra} as Job['progress']});
    assert.deepEqual(ids([saved, job(2)]), [2, 1], JSON.stringify(extra));
  }
});

test('completed empty scans, cache completions and failures remain visible', () => {
  assert.deepEqual(ids([job(1), job(2, {state: 'complete'}), job(3, {state: 'failed', reason: 'authentication_failed'}), job(4),
    job(5, {state: 'complete', progress: {pages: 0, market_cache: {reused_streams: 2, total_streams: 2, ttl_seconds: 3600, oldest_observed_at: null}}})]), [5, 3, 2]);
});

test('attempted scans retain failed-response and retry evidence before the first valid page', () => {
  for (const extra of [{attempts: 1}, {marketapp_budget: {invocation_used: 1}}]) {
    const attempted = job(1, {reason: 'retry_wait', progress: {...job(1).progress, ...extra}});
    assert.deepEqual(ids([attempted, job(2)]), [2, 1]);
  }
});

test('active scans remain visible while superseded interrupted empty scans are hidden', () => {
  assert.deepEqual(ids([job(1, {state: 'running'}), job(2, {state: 'queued'}),
    job(3, {state: 'running', progress: {...job(3).progress, requires_resume: true}}),
    job(4, {state: 'queued', progress: {...job(4).progress, requires_resume: true}}), job(5)]), [5, 2, 1]);
});

test('missing or uncertain legacy progress remains visible conservatively', () => {
  for (const progress of [{}, {sync: job(1).progress.sync}, {pages: null}, {pages: -1}, {pages: '0'},
    {pages: 0, observations: null}, {pages: 0, observations: NaN}, {pages: 0, sync: null}]) {
    assert.deepEqual(ids([job(1, {progress: progress as Job['progress']}), job(2)]), [2, 1]);
  }
});

test('desktop discovery progress is preserved and input order does not change newest selection', () => {
  assert.deepEqual(ids([job(9, {kind: 'discover', progress: {pages: 0, candidates: 3, verified: 0}}),
    job(10, {kind: 'discover'}), job(7, {kind: 'discover'})]), [10, 9]);
  assert.deepEqual(visibleActivityJobs([]), []);
});

const savedJob = (id: number, completed: number, changes: Partial<Job> = {}): Job => job(id, {
  progress: {pages: completed, sync: {phase: 'listings', completed, total: 46, unit: 'collections', current_collection: null, processed_items: completed}},
  ...changes,
});
const groupIds = (jobs: Job[]) => {
  const groups = activityJobGroups(jobs);
  return {current: groups.current.map(entry => entry.id), previous: groups.previous.map(entry => entry.id)};
};

test('one running comparison stays current while both saved pauses move to previous', () => {
  assert.deepEqual(groupIds([savedJob(1, 18), savedJob(2, 9), savedJob(3, 8, {state: 'running'})]), {
    current: [3], previous: [2, 1],
  });
});

test('the newest saved pause stays current when no comparison is running', () => {
  assert.deepEqual(groupIds([savedJob(2, 9), savedJob(1, 18), savedJob(3, 8)]), {
    current: [3], previous: [2, 1],
  });
});

test('an active older scan takes priority over a newer pause or completion', () => {
  for (const state of ['partial', 'complete'] as const) {
    assert.deepEqual(groupIds([savedJob(4, 46, {state}), savedJob(2, 8, {state: 'running'}), savedJob(3, 18)]), {
      current: [2], previous: [4, 3],
    });
  }
});

test('a latest completion supersedes saved pauses instead of presenting stale Continue work', () => {
  assert.deepEqual(groupIds([savedJob(1, 18), savedJob(3, 46, {state: 'complete'}), savedJob(2, 9)]), {
    current: [], previous: [3, 2, 1],
  });
});

test('latest failures stay current and older failure evidence remains in previous', () => {
  assert.deepEqual(groupIds([savedJob(1, 18), job(2, {state: 'failed', reason: 'authentication_failed'}),
    job(3, {state: 'failed', reason: 'request_failed'})]), {current: [3], previous: [2, 1]});
  assert.deepEqual(groupIds([job(1, {state: 'failed'}), job(2)]), {current: [2], previous: [1]});
});

test('each kind gets its own current scan with active scans first', () => {
  assert.deepEqual(groupIds([savedJob(5, 4, {kind: 'rental_prices'}), savedJob(4, 3, {kind: 'collect'}),
    savedJob(2, 1, {state: 'running'}), savedJob(3, 2, {kind: 'collect', state: 'queued'}), savedJob(1, 18)]), {
    current: [3, 2, 5], previous: [4, 1],
  });
});

test('running and queued jobs requiring Resume are treated as pauses', () => {
  for (const state of ['running', 'queued'] as const) {
    const interrupted = savedJob(3, 9, {state, progress: {...savedJob(3, 9).progress, requires_resume: true}});
    assert.deepEqual(groupIds([interrupted, savedJob(1, 18)]), {current: [3], previous: [1]});
    assert.deepEqual(groupIds([interrupted, savedJob(2, 8, {state: 'running'})]), {current: [2], previous: [3]});
  }
});

test('all active scans remain current so every Stop control is accessible', () => {
  assert.deepEqual(groupIds([job(1, {state: 'running'}), job(2, {state: 'queued'}), savedJob(3, 18)]), {
    current: [2, 1], previous: [3],
  });
});

test('groups preserve all visible history and job references without changing the input', () => {
  const jobs = [savedJob(1, 18), job(2), job(3, {state: 'failed'}), savedJob(4, 9),
    savedJob(5, 8, {state: 'running'}), job(6, {kind: 'discover', state: 'complete'})];
  const before = JSON.stringify(jobs), originalOrder = [...jobs];
  const groups = activityJobGroups(jobs);
  assert.deepEqual(groupIds(jobs), {current: [5], previous: [6, 4, 3, 1]});
  assert.deepEqual([...groups.current, ...groups.previous].sort((a, b) => b.id - a.id), visibleActivityJobs(jobs));
  for (const grouped of [...groups.current, ...groups.previous]) assert.equal(grouped, jobs.find(entry => entry.id === grouped.id));
  assert.equal(JSON.stringify(jobs), before);
  assert.deepEqual(jobs, originalOrder);
  assert.deepEqual(activityJobGroups([...groups.current, ...groups.previous]), groups);
  assert.deepEqual(activityJobGroups([]), {current: [], previous: []});
});
