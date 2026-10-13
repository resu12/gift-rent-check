import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonActionFeedback, comparisonAllowanceFeedback, currentComparisonActionFeedback } from './activityComparisonFeedback.ts';
import type { ComparisonActionState } from './activityComparisonFeedback.ts';
import { activityStatusPresentation } from './activityStatusPresentation.ts';
import type { ActivityFreshnessRow } from './activityFreshness.ts';
import { availableAgainMessage } from './syncPresentation.ts';
import type { Capabilities, Job } from './types.ts';

const now = Date.parse('2026-10-11T14:00:00Z');
const later = '2026-10-11T16:00:00.000Z';
const job = (changes: Partial<Job> = {}): Job => ({
  id: 1, kind: 'prices', state: 'partial', created_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:01:00Z',
  reason: 'invocation_limit', run_id: 1, stop_requested: false, progress: {}, ...changes,
});
const limits = (changes: Partial<NonNullable<Capabilities['marketapp_limits']>> = {}): Pick<Capabilities, 'marketapp_limits'> => ({
  marketapp_limits: { max_attempts: 100, rolling_24h_attempts: 500, run_seconds: 300, requests_per_second: 1,
    used_24h: 87, remaining_24h: 413, available_at: null, ...changes },
});

test('the immediate action result shows started, finished, paused and failed outcomes', () => {
  for (const state of ['running', 'queued'] as const) {
    assert.deepEqual(comparisonActionFeedback(job({ state, reason: null }), now), {
      message: 'Update started · checking comparison prices…', tone: 'pending',
    });
  }
  assert.deepEqual(comparisonActionFeedback(job({ state: 'complete' }), now), {
    message: 'Finished · comparison prices saved.', tone: 'success',
  });
  const pause = comparisonActionFeedback(job(), now);
  assert.equal(pause.tone, 'warning'); assert.match(pause.message, /^Paused · Progress saved/);
  assert.match(comparisonActionFeedback(job({ state: 'failed', reason: 'authentication_failed' }), now).message,
    /Access rejected · check the API connection/);
  assert.equal(comparisonActionFeedback(job({ state: 'failed' }), now).tone, 'error');
});

test('an immediately returned exhausted pause gives a clear availability date', () => {
  const saved = job({ reason: 'daily_limit', progress: {
    marketapp_budget: { rolling_24h_used: 500, rolling_24h_limit: 500, available_at: later },
  } });
  assert.deepEqual(comparisonActionFeedback(saved, now), {
    message: `Paused · ${availableAgainMessage(later, now)}`, tone: 'warning',
  });
  assert.deepEqual(comparisonAllowanceFeedback([saved], undefined, undefined, now), {
    message: availableAgainMessage(later, now), tone: 'warning', availableAt: later,
  });
});

test('current 87 of 500 dashboard budget permits Continue despite an old daily pause', () => {
  const old = job({ reason: 'daily_limit', progress: { provider_budget: {
    rolling_24h_used: 705, rolling_24h_limit: 500, available_at: later, provider_allowance_blocked: true,
  } } });
  assert.equal(comparisonAllowanceFeedback([old], limits(), undefined, now), null);
  assert.equal(comparisonAllowanceFeedback([old], limits({ used_24h: 499, remaining_24h: 1 }), undefined, now), null);
  assert.equal(comparisonAllowanceFeedback([job({ reason: 'daily_limit' })], undefined, undefined, now), null);
});

test('current exhausted budget or explicit provider block disables with a useful explanation', () => {
  assert.deepEqual(comparisonAllowanceFeedback([], limits({ used_24h: 500, remaining_24h: 0, available_at: later }), undefined, now), {
    message: availableAgainMessage(later, now), tone: 'warning', availableAt: later,
  });
  const shared = comparisonAllowanceFeedback([], limits({ provider_allowance_blocked: true, available_at: later }), undefined, now);
  assert.equal(shared?.availableAt, later); assert.match(shared!.message, /^Available again/);
  const unknown = comparisonAllowanceFeedback([], limits({ provider_allowance_blocked: true }), undefined, now);
  assert.equal(unknown?.availableAt, null); assert.match(unknown!.message, /request allowance is unavailable/);
});

test('a past or malformed deadline cannot locally release a server allowance block', () => {
  for (const available_at of ['2026-10-11T13:00:00Z', 'not-a-date', null]) {
    const blocked = comparisonAllowanceFeedback([], limits({ used_24h: 500, available_at }), undefined, now);
    assert.equal(blocked?.tone, 'warning');
    assert.doesNotMatch(blocked!.message, /try Continue|available again|ready to continue/i);
  }
  const badClock = comparisonAllowanceFeedback([], limits({ used_24h: 500, available_at: later }), undefined, NaN);
  assert.match(badClock!.message, /Reload saved data/);
});

test('newest scoped comparison budget wins without old generation or non-comparison leakage', () => {
  const exhausted = job({ account_generation: 0, progress: { marketapp_budget: {
    rolling_24h_used: 500, rolling_24h_limit: 500, available_at: later,
  } } });
  const otherAccount = job({ id: 2, account_generation: 1, progress: { marketapp_budget: {
    rolling_24h_used: 0, rolling_24h_limit: 500,
  } } });
  assert.equal(comparisonAllowanceFeedback([exhausted, otherAccount], undefined, 0, now)?.availableAt, later);
  assert.equal(comparisonAllowanceFeedback([exhausted, otherAccount], undefined, 1, now), null);
  const current = job({ id: 3, kind: 'rental_prices', account_generation: 0, progress: { provider_budget: {
    rolling_24h_used: 87, rolling_24h_limit: 500,
  } } });
  assert.equal(comparisonAllowanceFeedback([current, exhausted], undefined, 0, now), null);
  assert.equal(comparisonAllowanceFeedback([job({ ...exhausted, id: 4, kind: 'refresh' })], undefined, 0, now), null);
  assert.equal(comparisonAllowanceFeedback([exhausted], undefined, -1, now), null);
  assert.equal(comparisonAllowanceFeedback([exhausted], undefined, NaN, now), null);
});

test('ordinary pacing and an invocation pause do not become an indefinite allowance block', () => {
  for (const reason of ['duration_limit', 'invocation_limit', 'retry_wait']) {
    const paced = job({ reason, progress: { next_allowed_at: now + 1000, marketapp_budget: {
      rolling_24h_used: 87, rolling_24h_limit: 500, available_at: later,
    } } });
    assert.equal(comparisonAllowanceFeedback([paced], undefined, undefined, now), null);
  }
  for (const used of [-1, NaN, Infinity, '500', 500.5]) {
    assert.equal(comparisonAllowanceFeedback([job({ progress: { marketapp_budget: {
      rolling_24h_used: used, rolling_24h_limit: 500,
    } } })], undefined, undefined, now), null);
  }
});

test('a pending request remains visibly pending and raw reasons are never displayed', () => {
  const finishing = comparisonActionFeedback(job({ progress: { lease_until: now + 1000, server_time: now } }), now);
  assert.deepEqual(finishing, { message: 'Finishing the previous request…', tone: 'pending' });
  const paused = comparisonActionFeedback(job({ state: 'running', progress: { requires_resume: true } }), now);
  assert.equal(paused.tone, 'warning'); assert.match(paused.message, /^Paused/);
  const interrupted = comparisonActionFeedback(job({ state: 'running', progress: {
    client_interrupted: true, server_time: now, lease_until: 0,
  } }), now);
  assert.equal(interrupted.tone, 'warning'); assert.match(interrupted.message, /^Paused/);
  const stillFinishing = comparisonActionFeedback(job({ state: 'running', progress: {
    client_interrupted: true, server_time: now, lease_until: now + 1000,
  } }), now);
  assert.equal(stillFinishing.tone, 'pending'); assert.match(stillFinishing.message, /Finishing/);
  const secret = '<script>token=secret-key</script>'.repeat(100);
  const failed = comparisonActionFeedback(job({ state: 'failed', reason: secret }), now);
  assert.doesNotMatch(failed.message, /script|secret|token=/); assert.ok(failed.message.length <= 240);
  const original = job(); const before = JSON.stringify(original);
  comparisonActionFeedback(original, now); comparisonAllowanceFeedback([original], limits(), undefined, now);
  assert.equal(JSON.stringify(original), before);
});

const comparisonRow: ActivityFreshnessRow = {
  id: 'listings', label: 'Listing averages', tone: 'older', state: 'older', status: 'Older data',
  updatedAt: '2026-10-11T12:01:00Z', oldestUpdatedAt: '2026-10-11T12:01:00Z',
  coverage: '45 of 45 collections checked', detail: '', freshnessMinutes: 60, updating: false,
  checkStatus: null, checkedAt: null,
};
const startedAction = (changes: Partial<ComparisonActionState> = {}): ComparisonActionState => ({
  context: 'wallet-generation:period', rowId: 'listings', jobId: 1,
  feedback: { tone: 'pending', message: 'Update started · checking comparison prices…' }, ...changes,
});

test('a polled completion clears cached Starting after the app missed a driver event while hidden', () => {
  const action = startedAction();
  const initial = currentComparisonActionFeedback(action, action.context, 'listings', [job({ state: 'running' })], undefined, now);
  assert.equal(activityStatusPresentation(comparisonRow, now, initial).pending, true);
  // A saved-data reload changes jobs, without changing the action or emitting an event.
  const polled = currentComparisonActionFeedback(action, action.context, 'listings', [job({ state: 'complete' })], undefined, now);
  assert.deepEqual(polled, { tone: 'success', message: 'Finished · comparison prices saved.' });
  const shown = activityStatusPresentation(comparisonRow, now, polled);
  assert.equal(shown.pending, false); assert.notEqual(shown.status, 'Starting');
  assert.equal(action.feedback.tone, 'pending');
});

test('a fresh server pause releases the pending control even when the job update timestamp is unchanged', () => {
  const action = startedAction();
  const finishing = job({ progress: { client_interrupted: true, server_time: now, lease_until: now + 1000 } });
  const first = currentComparisonActionFeedback(action, action.context, 'listings', [finishing], undefined, now);
  assert.equal(activityStatusPresentation(comparisonRow, now, first).pending, true);
  const paused = { ...finishing, progress: { ...finishing.progress, server_time: now + 2000 } };
  const polled = currentComparisonActionFeedback(action, action.context, 'listings', [paused], undefined, now + 2000);
  assert.equal(polled?.tone, 'warning'); assert.match(polled!.message, /^Paused/);
  assert.equal(activityStatusPresentation(comparisonRow, now + 2000, polled).pending, false);
  const failed = currentComparisonActionFeedback(action, action.context, 'listings', [job({ state: 'failed', reason: 'authentication_failed' })], undefined, now);
  assert.equal(failed?.tone, 'error'); assert.match(failed!.message, /Access rejected/);
});

test('unbound launch and failure feedback remain visible but never cross row or account context', () => {
  for (const feedback of [{ tone: 'pending', message: 'Starting update…' }, { tone: 'error', message: 'The sync could not be started.' }] as const) {
    const action = startedAction({ jobId: undefined, feedback });
    assert.equal(currentComparisonActionFeedback(action, action.context, 'listings', [], undefined, now), feedback);
    assert.equal(currentComparisonActionFeedback(action, 'other-wallet:period', 'listings', [], undefined, now), undefined);
    assert.equal(currentComparisonActionFeedback(action, action.context, 'rentals', [], undefined, now), undefined);
  }
  const action = startedAction();
  for (const jobs of [[], [job({ account_generation: 1 })], [job({ kind: 'refresh', account_generation: 0 })]]) {
    assert.equal(currentComparisonActionFeedback(action, action.context, 'listings', jobs, 0, now), undefined);
  }
  assert.equal(currentComparisonActionFeedback(action, action.context, 'listings', [job()], NaN, now), undefined);
});

test('superseded historical feedback no longer describes the current scan', () => {
  const action = startedAction();
  const newer = job({ id: 2, state: 'complete' });
  assert.equal(currentComparisonActionFeedback(action, action.context, 'listings', [job(), newer], undefined, now), undefined);
  const active = job({ state: 'running' });
  assert.equal(currentComparisonActionFeedback(action, action.context, 'listings', [active, newer], undefined, now)?.tone, 'pending');
});
