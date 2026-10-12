import test from 'node:test';
import assert from 'node:assert/strict';
import { activityComparisonActionLabel, activityComparisonRequestBlocker, activityComparisonResumeAvailability, resumableActivityComparisonJob } from './activityFreshnessActions.ts';
import type { Job, PricingSelection } from './types.ts';

const selection: PricingSelection = { source: 'rentals', timeframe: '30d' };
const job = (id: number, changes: Partial<Job> = {}): Job => ({
  id, kind: 'prices', state: 'partial', created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z',
  reason: 'invocation_limit', run_id: id, stop_requested: false,
  progress: { pages: id, observations: id * 100 }, collection_window: { timeframe: '30d' }, ...changes,
});

test('each average row continues its current saved source independent of the selected pricing source', () => {
  const listings = job(1), rentals = job(2, { kind: 'rental_prices' });
  assert.equal(resumableActivityComparisonJob('listings', [rentals, listings], selection), listings);
  assert.equal(resumableActivityComparisonJob('rentals', [listings, rentals], selection), rentals);
  assert.equal(resumableActivityComparisonJob('rentals', [listings], selection), null);
});

test('a current combined scan can continue either source and preserves its cursor and identity', () => {
  const combined = job(3, { kind: 'collect', account_generation: 0 });
  const before = JSON.stringify(combined);
  assert.equal(resumableActivityComparisonJob('listings', [combined], selection, 0), combined);
  assert.equal(resumableActivityComparisonJob('rentals', [combined], selection, 0), combined);
  assert.equal(JSON.stringify(combined), before);
});

test('only partial or explicitly waiting running jobs can continue; an explicit Stop preserves manual Continue', () => {
  const paused = job(1, { state: 'running', progress: { requires_resume: true } });
  assert.equal(resumableActivityComparisonJob('listings', [paused], selection), paused);
  const stopped = job(2, { reason: 'Stopped by you', stop_requested: true });
  assert.equal(resumableActivityComparisonJob('listings', [stopped], selection), stopped);
  for (const candidate of [job(3, { state: 'complete' }), job(3, { state: 'failed' }), job(3, { state: 'queued' }),
    job(3, { state: 'running' }), job(3, { state: 'running', progress: { client_interrupted: true } })]) {
    assert.equal(resumableActivityComparisonJob('listings', [candidate], selection), null);
  }
});

test('newer scans supersede old pauses even when complete, failed, incompatible or for a different period', () => {
  const older = job(1);
  for (const newer of [job(2), job(2, { state: 'complete' }), job(2, { state: 'failed' }),
    job(2, { resume_supported: false }), job(2, { collection_window: { timeframe: '60d' } }),
    job(2, { collection_window: null }), job(2, { kind: 'collect', state: 'complete' })]) {
    assert.notEqual(resumableActivityComparisonJob('listings', [older, newer], selection), older);
  }
  const newest = job(4), active = job(3, { state: 'running' });
  assert.equal(resumableActivityComparisonJob('listings', [newest, active], selection), null,
    'another actively running scan prevents choosing the newer pause outside current activity');
});

test('only a supported saved bounded period matching the displayed timeframe can continue', () => {
  for (const candidate of [job(1, { resume_supported: false }), job(1, { collection_window: null }),
    job(1, { collection_window: { timeframe: 'all' } }), job(1, { collection_window: { timeframe: '60d' } })]) {
    assert.equal(resumableActivityComparisonJob('listings', [candidate], selection), null);
  }
  const legacySupported = job(1, { resume_supported: undefined });
  assert.equal(resumableActivityComparisonJob('listings', [legacySupported], selection), legacySupported);
});

test('custom periods require exact valid saved UTC dates without demanding a new scan window', () => {
  const custom: PricingSelection = { source: 'listings', timeframe: 'custom', dateFrom: '2026-01-01', dateTo: '2026-01-31' };
  const saved = job(1, { collection_window: { timeframe: 'custom', date_from: custom.dateFrom, date_to: custom.dateTo } });
  assert.equal(resumableActivityComparisonJob('listings', [saved], custom), saved,
    'saved old cursors remain resumable without starting a new 90-day provider scan');
  for (const date_from of ['2026-01-02', '2026-02-30', null, undefined]) {
    assert.equal(resumableActivityComparisonJob('listings', [job(1, { collection_window: {
      timeframe: 'custom', date_from, date_to: custom.dateTo,
    } })], custom), null);
  }
  assert.equal(resumableActivityComparisonJob('listings', [saved], { ...custom, dateTo: '2026-01-30' }), null);
  const tooLong: PricingSelection = { ...custom, dateTo: '2026-05-01' };
  assert.equal(resumableActivityComparisonJob('listings', [job(1, { collection_window: {
    timeframe: 'custom', date_from: tooLong.dateFrom, date_to: tooLong.dateTo,
  } })], tooLong), null);
});

test('account generation is an exact filter including zero and never changes another identity', () => {
  const own = job(1, { account_generation: 0 }), other = job(5, { account_generation: 1 });
  assert.equal(resumableActivityComparisonJob('listings', [other, own], selection, 0), own);
  assert.equal(resumableActivityComparisonJob('listings', [own], selection, 1), null);
  assert.equal(resumableActivityComparisonJob('listings', [job(1)], selection, 0), null);
  assert.equal(resumableActivityComparisonJob('listings', [own], selection, -1), null);
  assert.equal(resumableActivityComparisonJob('listings', [own], selection, Number.NaN), null);
});

test('a stopped partial scan retains Continue identity but waits for its live provider lease', () => {
  const stopped = job(8, {
    reason: 'Stopped by you', stop_requested: true,
    progress: { server_time: 1000, lease_until: 3000 },
  });
  const saved = resumableActivityComparisonJob('listings', [stopped], selection);
  assert.equal(saved, stopped, 'the active lease must not turn a saved cursor into a fresh Update');
  const before = JSON.stringify(stopped);
  assert.deepEqual(activityComparisonResumeAvailability(stopped), {
    canResume: false, actionLabel: 'Finishing…',
    reason: 'The last request is still finishing. Reload saved data before continuing.',
  });
  assert.equal(JSON.stringify(stopped), before, 'evaluating readiness must not change the cursor or lease');
});

test('Continue is enabled only after saved status confirms a cleared or expired lease', () => {
  const finishing = job(1, { progress: { server_time: 1000, lease_until: 3000 } });
  assert.equal(activityComparisonResumeAvailability(finishing).canResume, false,
    'even a much later local clock must not authorize the stale saved response');
  for (const progress of [
    { server_time: 3000, lease_until: 3000 },
    { server_time: 3001, lease_until: 3000 },
    { server_time: 1001, lease_until: 0, next_allowed_at: 5000 },
  ]) {
    assert.deepEqual(activityComparisonResumeAvailability({ ...finishing, progress }), {
      canResume: true, actionLabel: 'Continue', reason: null,
    }, 'an explicit cleared lease is independent of a provider cooldown handled by the driver');
  }
});

test('missing or malformed timing for a nonzero saved lease fails closed', () => {
  for (const progress of [
    { lease_until: 3000 },
    { server_time: 1000, lease_until: '3000' },
    { server_time: 1000, lease_until: undefined },
    { server_time: 1000, lease_until: Number.NaN },
    { server_time: 1000, lease_until: Infinity },
    { server_time: 1000, lease_until: -1 },
    { server_time: 1000, lease_until: 1.5 },
    { server_time: Number.NaN, lease_until: 0 },
    { server_time: -1, lease_until: 0 },
    { server_time: '3001', lease_until: 3000 },
    { server_time: null, lease_until: 0 },
  ]) {
    const candidate = job(1, { progress });
    assert.equal(resumableActivityComparisonJob('listings', [candidate], selection), candidate);
    assert.deepEqual(activityComparisonResumeAvailability(candidate), {
      canResume: false, actionLabel: 'Check status',
      reason: 'Saved request timing could not be confirmed. Reload saved data before continuing.',
    });
  }
});

test('legacy replies use their merged request deadline while untimed desktop pauses remain compatible', () => {
  assert.equal(activityComparisonResumeAvailability(job(1)).canResume, true);
  assert.equal(activityComparisonResumeAvailability(job(1, {
    progress: { server_time: 1000, next_allowed_at: 3000 },
  })).canResume, false);
  assert.equal(activityComparisonResumeAvailability(job(1, {
    progress: { server_time: 3000, next_allowed_at: 3000 },
  })).canResume, true);
  assert.equal(activityComparisonResumeAvailability(job(1, {
    progress: { next_allowed_at: 3000 },
  })).canResume, false);
});

test('timing gate does not weaken account, period, or superseded cursor guards', () => {
  const pending = job(1, { account_generation: 1,
    progress: { server_time: 1000, lease_until: 3000 },
    collection_window: { timeframe: 'custom', date_from: '2026-10-01', date_to: '2026-10-11' },
  });
  const custom: PricingSelection = { source: 'listings', timeframe: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-11' };
  assert.equal(resumableActivityComparisonJob('listings', [pending], custom, 1), pending);
  assert.equal(activityComparisonResumeAvailability(pending).canResume, false);
  assert.equal(resumableActivityComparisonJob('listings', [pending], custom, 0), null);
  assert.equal(resumableActivityComparisonJob('listings', [pending], { ...custom, dateTo: '2026-10-10' }, 1), null);
  assert.equal(resumableActivityComparisonJob('listings', [pending, job(2, {
    state: 'complete', account_generation: 1,
  })], custom, 1), null);
});

test('a finishing comparison blocks Update even for a different source or selected period', () => {
  const finishing = job(4, { kind: 'rental_prices',
    collection_window: { timeframe: '60d' }, progress: { server_time: 1000, lease_until: 3000 },
  });
  assert.equal(resumableActivityComparisonJob('listings', [finishing], selection), null);
  assert.equal(resumableActivityComparisonJob('rentals', [finishing], selection), null);
  assert.deepEqual(activityComparisonRequestBlocker([finishing]), activityComparisonResumeAvailability(finishing));
  assert.equal(activityComparisonRequestBlocker([{ ...finishing,
    progress: { server_time: 3001, lease_until: 0 },
  }]), null, 'a fresh saved status reply clears the shared request blocker');
});

test('historical and superseded leases cannot block current Update or Continue', () => {
  const historical = job(1, { progress: { server_time: 1000, lease_until: 3000 } });
  for (const newer of [job(2), job(2, { state: 'complete' }), job(2, { state: 'failed' })]) {
    assert.equal(activityComparisonRequestBlocker([historical, newer]), null);
  }
  assert.equal(activityComparisonRequestBlocker([historical, job(2, {
    state: 'running', progress: { server_time: 1000, lease_until: 0 },
  })]), null, 'a superseded partial lease is not the actively running scan lease');
});

test('shared comparison blocker applies only to the current exact account generation', () => {
  const own = job(1, { account_generation: 0, progress: { server_time: 1000, lease_until: 0 } });
  const other = job(2, { account_generation: 1, progress: { server_time: 1000, lease_until: 3000 } });
  assert.equal(activityComparisonRequestBlocker([other, own], 0), null);
  assert.equal(activityComparisonRequestBlocker([other, own], 1)?.actionLabel, 'Finishing…');
  assert.equal(activityComparisonRequestBlocker([job(3, { progress: other.progress }), own], 0), null,
    'an unscoped legacy reply is never treated as evidence for a known account generation');
  for (const generation of [-1, Number.NaN, Infinity, 0.5]) {
    assert.equal(activityComparisonRequestBlocker([own], generation)?.canResume, false);
    assert.equal(activityComparisonRequestBlocker([own], generation)?.actionLabel, 'Check status');
  }
});

test('shared blocker ignores unrelated gift jobs and uses the newest current blocked comparison', () => {
  const waiting = { server_time: 1000, lease_until: 3000 };
  for (const kind of ['refresh', 'discover'] as const) {
    assert.equal(activityComparisonRequestBlocker([job(1, { kind, progress: waiting })]), null);
  }
  const older = job(1, { kind: 'collect', progress: { server_time: Number.NaN, lease_until: 0 } });
  const newer = job(2, { kind: 'rental_prices', progress: waiting });
  assert.equal(activityComparisonRequestBlocker([older, newer])?.actionLabel, 'Finishing…');
  assert.equal(activityComparisonRequestBlocker([newer, older])?.actionLabel, 'Finishing…');
  assert.equal(activityComparisonRequestBlocker([]), null);
});

test('active comparison labels stay stable through page leases and do not label the other source as finishing', () => {
  for (const lease_until of [0, 3000, 0, 4000]) {
    const active = job(2, { kind: 'rental_prices', state: 'running',
      progress: { server_time: 1000, lease_until, requires_resume: false } });
    const jobs = [job(1, { state: 'complete' }), active];
    assert.equal(activityComparisonActionLabel('rentals', jobs, selection), 'Updating…');
    assert.equal(activityComparisonActionLabel('listings', jobs, selection), 'Update');
    assert.equal(Boolean(activityComparisonRequestBlocker(jobs)), lease_until > 0,
      'the shared mutation guard remains independent of the stable row labels');
  }
  const combined = job(3, { kind: 'collect', state: 'running', progress: { server_time: 1000, lease_until: 3000 } });
  for (const source of ['listings', 'rentals'] as const) assert.equal(activityComparisonActionLabel(source, [combined], selection), 'Updating…');
});

test('only the interrupted or stopped source shows Finishing until saved status confirms the lease ended', () => {
  for (const change of [
    { state: 'partial' as const, stop_requested: true },
    { state: 'running' as const, progress: { client_interrupted: true } },
    { state: 'running' as const, progress: { requires_resume: true } },
  ]) {
    const candidate = job(3, { ...change, kind: 'rental_prices',
      progress: { ...change.progress, server_time: 1000, lease_until: 3000 } });
    assert.equal(activityComparisonActionLabel('rentals', [candidate], selection), 'Finishing…');
    assert.equal(activityComparisonActionLabel('listings', [candidate], selection), 'Update');
    const confirmed = { ...candidate, state: 'partial' as const, progress: { server_time: 3001, lease_until: 0 } };
    assert.equal(activityComparisonActionLabel('rentals', [confirmed], selection), 'Continue');
  }
});

test('comparison labels honor scope, replacement scans and active scans in another period', () => {
  const old = job(1, { kind: 'rental_prices', state: 'partial', account_generation: 0 });
  const current = job(2, { kind: 'rental_prices', state: 'complete', account_generation: 0 });
  const foreign = job(5, { kind: 'prices', state: 'running', account_generation: 1 });
  assert.equal(activityComparisonActionLabel('rentals', [old, current, foreign], selection, 0), 'Update');
  assert.equal(activityComparisonActionLabel('listings', [current, foreign], selection, 0), 'Update');
  assert.equal(activityComparisonActionLabel('listings', [foreign], selection, 1), 'Updating…');
  assert.equal(activityComparisonActionLabel('rentals', [current], selection, -1), 'Check status');
  assert.equal(activityComparisonActionLabel('rentals', [{ ...old, state: 'running', collection_window: { timeframe: '60d' } }], selection, 0), 'Updating…');
});
