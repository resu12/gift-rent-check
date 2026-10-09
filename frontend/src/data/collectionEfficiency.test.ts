import test from 'node:test';
import assert from 'node:assert/strict';
import { efficientRefreshSelection, presentCollectionEfficiency, visibleDashboardJobs } from './collectionEfficiency.ts';
import type { Job } from './types.ts';

const job = (overrides: Partial<Job> = {}): Job => ({id: 1, kind: 'rental_prices', state: 'partial', created_at: '', updated_at: '', reason: null, run_id: 1, stop_requested: false,
  progress: {server_time: 1000, lease_until: 0, efficiency: {page_size: 10, recommended_page_size: 100, scheduling: 'sequential', collections_started: 1, collections_total: 45}}, collection_window: {timeframe: '30d', window_from: '2026-09-01T00:00:00Z', window_to: '2026-10-01T00:00:00Z'}, ...overrides});

test('new scans replace same-kind paused banners while Activity history stays intact', () => {
  const older = job(), newer = job({id: 2, state: 'running'}), unrelated = job({id: 3, kind: 'prices'});
  const jobs = [older, newer, unrelated];
  assert.deepEqual(visibleDashboardJobs(jobs).map(item => item.id), [2, 3]);
  newer.state = 'complete';
  assert.deepEqual(visibleDashboardJobs(jobs).map(item => item.id), [3]);
  assert.equal(jobs.length, 3); assert.equal(older.state, 'partial');
  older.state = 'running';
  assert.deepEqual(visibleDashboardJobs(jobs).map(item => item.id), [1, 3]);
});

test('latest cache completion remains visible without reviving superseded paused scans', () => {
  const cached = job({id: 2, state: 'complete', progress: {market_cache: {reused_streams: 1, total_streams: 1, ttl_seconds: 3600, oldest_observed_at: null}}});
  assert.deepEqual(visibleDashboardJobs([job(), cached]).map(item => item.id), [2]);
  cached.state = 'failed';
  assert.deepEqual(visibleDashboardJobs([job(), cached]).map(item => item.id), [2]);
});

test('legacy warning offers a new efficient refresh only for paused scans without a request lease', () => {
  assert.equal(presentCollectionEfficiency(job()).canStart, true);
  assert.match(presentCollectionEfficiency(job()).warning!, /10 items.*100/);
  for (const state of ['running', 'queued'] as const) {
    const view = presentCollectionEfficiency(job({state})); assert.equal(view.canStart, false); assert.match(view.warning!, /Stop this scan/);
  }
  const pending = job(); pending.progress.lease_until = 1100;
  assert.equal(presentCollectionEfficiency(pending).canStart, false);
  assert.match(presentCollectionEfficiency(pending).warning!, /current request/);
  pending.progress.lease_until = 1000; assert.equal(presentCollectionEfficiency(pending).canStart, true);
  for (const state of ['complete', 'failed'] as const) assert.equal(presentCollectionEfficiency(job({state})).legacy, false);
});

test('unknown lease deadline uses a conservative legacy fallback; cooldown does not block an explicit cleared lease', () => {
  const saved = job(); delete saved.progress.lease_until; saved.progress.next_allowed_at = 2000;
  assert.equal(presentCollectionEfficiency(saved).canStart, false);
  saved.progress.lease_until = 0; assert.equal(presentCollectionEfficiency(saved).canStart, true);
});

test('round-robin sampling is separate from completion and unknown totals stay unknown', () => {
  const saved = job(); saved.progress.efficiency = {page_size: 100, recommended_page_size: 100, scheduling: 'round_robin', collections_started: 12, collections_total: 45};
  assert.equal(presentCollectionEfficiency(saved).sampled, '12 of 45 collections sampled · sampling is not completion');
  assert.equal(presentCollectionEfficiency(saved).legacy, false);
  saved.progress.efficiency.collections_total = null; assert.equal(presentCollectionEfficiency(saved).sampled, null);
  saved.progress.efficiency.collections_total = 10; assert.equal(presentCollectionEfficiency(saved).sampled, null);
  saved.progress.efficiency.page_size = NaN; assert.equal(presentCollectionEfficiency(saved).legacy, false);
  assert.equal(presentCollectionEfficiency(job({kind: 'discover'})).legacy, false);
});

test('efficient refresh retains saved kind period but never carries cursor or frozen absolute bounds', () => {
  const saved = job(); saved.progress.cursor = 'opaque';
  const before = JSON.stringify(saved);
  assert.deepEqual(efficientRefreshSelection(saved, {source: 'listings', timeframe: '7d'}), {source: 'rentals', timeframe: '30d'});
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(efficientRefreshSelection(job({kind: 'prices', collection_window: {timeframe: '60d'}}), {source: 'rentals', timeframe: '7d'}), {source: 'listings', timeframe: '60d'});
});

test('custom restart preserves valid dates, rejects obsolete history windows and unbounded legacy scans', () => {
  const custom = job({collection_window: {timeframe: 'custom', date_from: '2026-10-01', date_to: '2026-10-08'}});
  assert.deepEqual(efficientRefreshSelection(custom, {source: 'listings', timeframe: '7d'}, new Date('2026-10-09T12:00:00Z')), {source: 'rentals', timeframe: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-08'});
  assert.throws(() => efficientRefreshSelection(custom, {source: 'listings', timeframe: '7d'}, new Date('2027-10-09T12:00:00Z')), /Choose a recent timeframe/);
  assert.throws(() => efficientRefreshSelection(job({collection_window: {timeframe: 'all'}}), {source: 'listings', timeframe: '7d'}), /90 days/);
});
