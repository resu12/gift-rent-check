import test from 'node:test';
import assert from 'node:assert/strict';
import {compactJobMessage, presentJobSync, presentOwnedPriceSync} from './syncPresentation.ts';
import type {Job, JobKind} from './types.ts';
import type {OwnedPriceSnapshot} from './ownedPriceRefresh.ts';

function job(overrides: Omit<Partial<Job>, 'progress'> & {progress?: Record<string, unknown>} = {}): Job {
  return {id: 1, kind: 'rental_prices', state: 'running', created_at: '2026-10-09T12:00:00Z', updated_at: '2026-10-09T12:01:00Z', reason: null, run_id: 1, stop_requested: false,
    progress: {sync: {phase: 'rentals', completed: 3, total: 12, unit: 'collections', current_collection: 'Low Riders', processed_items: 120}}, collection_window: {timeframe: '30d'}, ...overrides} as Job;
}
function owned(overrides: Partial<OwnedPriceSnapshot> = {}): OwnedPriceSnapshot {
  return {phase: 'checking', canStop: true, run: {id: 1, state: 'running', total: 160, checked: 40, updated: 20, unresolved: 20, reason: null, started_at: '2026-10-09T12:00:00Z', completed_at: null}, ...overrides};
}

test('purpose distinguishes current owned prices, listings, actual rentals, status and discovery', () => {
  const expected: [JobKind, string, RegExp][] = [['prices', 'Updating listing comparisons', /current market listings/], ['rental_prices', 'Updating rental comparisons', /actual rentals for the last 30 days/], ['collect', 'Updating market prices and rentals', /current listing comparisons and actual rentals/], ['refresh', 'Checking your gifts', /ownership, gift details/], ['discover', 'Finding wallet gifts', /which ones belong to you/]];
  for (const [kind, title, purpose] of expected) {const model = presentJobSync(job({kind})); assert.equal(model.title, title); assert.match(model.objective, purpose);}
  const model = presentOwnedPriceSync(owned()); assert.equal(model.title, 'Updating your gift prices'); assert.equal(model.objective, 'Checking daily prices for gifts you already own.');
  assert.doesNotMatch(model.objective, /comparison|Marketapp|TON/);
});

test('known collection progress is an honest percentage with a friendly current collection', () => {
  const model = presentJobSync(job());
  assert.deepEqual(model.progress, {completed: 3, total: 12, percent: 25, label: '3 of 12 collections checked', indeterminate: false});
  assert.equal(model.message, 'Checking Low Riders. 120 records read.'); assert.equal(model.stateLabel, 'In progress');
});

test('request allowance is never converted to completion and legacy stream units stay checks', () => {
  const model = presentJobSync(job({progress: {streams_complete: 2, streams_total: 8, marketapp_budget: {invocation_used: 99, invocation_limit: 100}}}));
  assert.equal(model.progress.percent, 25); assert.equal(model.progress.label, '2 of 8 checks finished');
  const unknown = presentJobSync(job({progress: {marketapp_budget: {invocation_used: 99, invocation_limit: 100}}}));
  assert.equal(unknown.progress.percent, null); assert.equal(unknown.progress.indeterminate, true);
});

test('explicit listing-check progress shows completed cohort work before a collection finishes', () => {
  const model = presentJobSync(job({ kind: 'prices', progress: {
    sync: { phase: 'listings', completed: 157, total: 274, unit: 'checks', current_collection: 'Low Riders' },
    streams_complete: 1, streams_total: 5,
  } }));
  assert.deepEqual(model.progress, { completed: 157, total: 274, percent: 57, label: '157 of 274 checks finished', indeterminate: false });
  assert.equal(compactJobMessage(job({kind: 'prices'}), model), 'Checking Low Riders');
});

test('legacy listing-only saved progress uses validated checks without claiming collection completion', () => {
  const progress = { sync: { phase: 'listings', completed: 0, total: 45, unit: 'collections' }, streams_complete: 157, streams_total: 274 };
  for (const state of ['running', 'partial'] as const) {
    const model = presentJobSync(job({ kind: 'prices', state, progress }));
    assert.equal(model.progress.percent, 57);
    assert.equal(model.progress.label, '157 of 274 checks finished');
    assert.equal(progress.sync.completed, 0);
  }
  for (const kind of ['rental_prices', 'collect'] as const) {
    const model = presentJobSync(job({ kind, progress }));
    assert.equal(model.progress.percent, 0);
    assert.equal(model.progress.label, '0 of 45 collections checked');
  }
});

test('listing legacy fallback does not replace malformed or unknown progress, or invent final completion', () => {
  const baseline = { sync: { phase: 'listings', completed: 0, total: 45, unit: 'collections' }, streams_complete: 157, streams_total: 274 };
  for (const [completed, total] of [[-1, 45], [NaN, 45], [46, 45], [0, null], [0, '45']]) {
    const model = presentJobSync(job({ kind: 'prices', progress: { ...baseline, sync: { ...baseline.sync, completed, total } } }));
    assert.equal(model.progress.percent, null);
  }
  for (const [streams_complete, streams_total] of [[-1, 274], [275, 274], [1.5, 274], [157, null], [157, '274'], [2, 45]]) {
    const model = presentJobSync(job({ kind: 'prices', progress: { ...baseline, streams_complete, streams_total } }));
    assert.equal(model.progress.label, '0 of 45 collections checked');
  }
  const unknownTotal = presentJobSync(job({ kind: 'prices', progress: { ...baseline, sync: { ...baseline.sync, total: 0 } } }));
  assert.equal(unknownTotal.progress.percent, null);
  const finished = { ...baseline, streams_complete: 274, sync: { ...baseline.sync, completed: 45 } };
  assert.equal(presentJobSync(job({kind: 'prices', state: 'complete', progress: finished})).progress.percent, 100);
  assert.equal(presentJobSync(job({kind: 'prices', state: 'complete', progress: finished})).progress.label, '274 of 274 checks finished');
  assert.equal(presentJobSync(job({kind: 'prices', state: 'running', progress: finished})).progress.percent, 99);
  const contradictoryFinished = { ...finished, streams_complete: 157 };
  assert.equal(presentJobSync(job({kind: 'prices', state: 'complete', progress: contradictoryFinished})).progress.label, '45 of 45 collections checked');
});

test('running, stopped, paused and failed progress cannot claim 100 percent before completion', () => {
  for (const state of ['running', 'partial', 'failed'] as const) {
    const model = presentJobSync(job({state, progress: {sync: {phase: 'rentals', completed: 12, total: 12, unit: 'collections'}}})); assert.equal(model.progress.percent, 99);
  }
  assert.equal(presentJobSync(job({state: 'complete', progress: {sync: {phase: 'complete', completed: 12, total: 12, unit: 'collections'}}})).progress.percent, 100);
  const resumed = presentJobSync(job({progress: {requires_resume: true, streams_complete: 8, streams_total: 8}}));
  assert.equal(resumed.state, 'paused'); assert.equal(resumed.title, 'Rental comparisons'); assert.equal(resumed.actionLabel, 'Continue'); assert.equal(resumed.progress.percent, 99); assert.match(resumed.message, /progress is saved/);
});

test('discovery has no fixed percentage until enumeration finishes, even if known candidates are checked', () => {
  const searching = presentJobSync(job({kind: 'discover', progress: {sync: {phase: 'discovering', completed: 40, total: 40, unit: 'gifts', processed_items: 100}}}));
  assert.equal(searching.progress.percent, null); assert.equal(searching.progress.indeterminate, true); assert.match(searching.message, /total will be known/);
  const legacy = presentJobSync(job({kind: 'discover', progress: {streams_complete: 2, streams_total: 2}})); assert.equal(legacy.progress.percent, null);
  const verifying = presentJobSync(job({kind: 'discover', progress: {sync: {phase: 'verifying', completed: 40, total: 80, unit: 'gifts'}}}));
  assert.equal(verifying.progress.percent, 50); assert.equal(verifying.progress.label, '40 of 80 gifts checked');
});

test('provider retry is distinct from a request in flight or ordinary pacing', () => {
  const timing = {server_time: 1000, next_allowed_at: 121000, lease_until: 121000, streams_complete: 1, streams_total: 5};
  assert.equal(presentJobSync(job({progress: timing})).state, 'running');
  for (const reason of ['retry_wait', 'Waiting for the provider retry deadline.']) {
    const model = presentJobSync(job({reason, progress: timing})); assert.equal(model.state, 'waiting'); assert.match(model.message, /before retrying/); assert.equal(model.actionLabel, null);
    const paused = presentJobSync(job({state: 'partial', reason, progress: timing})); assert.equal(paused.state, 'paused'); assert.equal(paused.actionLabel, 'Continue'); assert.match(paused.message, /continue later/);
  }
});

test('known machine and cloud human reasons explain actions without exposing raw technical text', () => {
  for (const reason of ['invocation_limit', 'The 100-request invocation limit was reached. Resume when ready.', 'Dashboard Marketapp request budget reached; resume saved work later']) assert.match(presentJobSync(job({state: 'partial', reason})).message, /batch reached its limit/);
  for (const reason of ['daily_limit', 'The rolling 24-hour request allowance was reached. Resume after its reset.']) assert.match(presentJobSync(job({state: 'partial', reason})).message, /daily request allowance/);
  for (const reason of ['authentication_failed', 'Marketapp rejected authentication. Check the private backend token.']) assert.match(presentJobSync(job({state: 'failed', reason})).message, /Access was rejected/);
  for (const reason of ['cursor_cycle', 'Marketapp rejected the saved cursor. Start a fresh collection.']) {const model = presentJobSync(job({state: 'failed', reason})); assert.equal(model.actionLabel, 'Start again'); assert.match(model.message, /Start a new refresh/);}
  const technical = 'schema_failed: internal_field_983'; const model = presentJobSync(job({state: 'failed', reason: technical}));
  assert.equal(model.rawReason, technical); assert.equal(model.message.includes(technical), false);
});

test('stopping and preparation take precedence over active progress messages', () => {
  assert.equal(presentJobSync(job(), {stopping: true}).state, 'stopping'); assert.equal(presentJobSync(job({stop_requested: true})).state, 'stopping');
  assert.equal(presentJobSync(job({state: 'queued'})).state, 'preparing');
  const preparing = presentJobSync(job({progress: {sync: {phase: 'preparing', completed: 0, total: 12, unit: 'collections'}}}));
  assert.equal(preparing.progress.percent, 0); assert.equal(preparing.state, 'preparing');
});

test('invalid, fractional and contradictory counts do not become NaN or invented percentages', () => {
  for (const completed of [NaN, Infinity, -1, 0.5, '3', 13]) {
    const model = presentJobSync(job({progress: {sync: {phase: 'rentals', completed, total: 12, unit: 'collections'}}})); assert.equal(model.progress.percent, null); assert.equal(model.progress.indeterminate, true);
  }
  for (const total of [NaN, Infinity, -1, 0.5, '12', null]) assert.equal(presentJobSync(job({progress: {sync: {phase: 'rentals', completed: 3, total, unit: 'collections'}}})).progress.percent, null);
  const empty = presentJobSync(job({state: 'complete', progress: {sync: {phase: 'complete', completed: 0, total: 0, unit: 'collections'}}})); assert.equal(empty.progress.percent, 100); assert.equal(empty.progress.label, 'No collections to check');
});

test('cache reuse is explained but not counted twice or relabeled as freshly observed', () => {
  const original = job(); original.progress.market_cache = {reused_streams: 4, total_streams: 8, ttl_seconds: 300, oldest_observed_at: '2026-10-09T11:59:00Z'};
  const model = presentJobSync(original, {now: Date.parse('2026-10-09T12:00:00Z')}); assert.equal(model.progress.percent, 25); assert.equal(model.cacheNote, '4 comparison scans reused · oldest data 1 min old · cache up to 5 min.');
  original.progress.market_cache.reused_streams = 9; assert.equal(presentJobSync(original).cacheNote, null);
  original.progress.market_cache.reused_streams = 0; assert.equal(presentJobSync(original).cacheNote, null);
});

test('one-hour cache exposes original data age without replacing observation time or completion', () => {
  const saved = job({state: 'complete'}); saved.progress.market_cache = {reused_streams: 4, total_streams: 8, ttl_seconds: 3600, oldest_observed_at: '2026-10-09T11:30:00Z', oldest_age_seconds: 1800};
  const originalTime = saved.progress.market_cache.oldest_observed_at;
  assert.equal(presentJobSync(saved).cacheNote, '4 comparison scans reused · oldest data 30 min old · cache up to 60 min.');
  assert.equal(saved.progress.market_cache.oldest_observed_at, originalTime);
  saved.progress.market_cache.oldest_age_seconds = null; saved.progress.market_cache.oldest_observed_at = null;
  assert.match(presentJobSync(saved).cacheNote!, /original observation time retained/);
  assert.doesNotMatch(presentJobSync(saved).cacheNote!, /fresh|just now/);
});

test('a saved daily-limit pause reflects restored allowance after reset or rolling expiry', () => {
  for (const used of [0, 499]) {
    const saved = job({state: 'partial', reason: 'daily_limit', progress: {marketapp_budget: {rolling_24h_used: used, rolling_24h_limit: 500}}});
    const view = presentJobSync(saved);
    assert.equal(view.message, 'Your request allowance is available again. Continue from your saved progress.');
    assert.equal(view.state, 'paused'); assert.equal(view.actionLabel, 'Continue');
  }
  for (const used of [500, null, '0', -1]) {
    const saved = job({state: 'partial', reason: 'daily_limit', progress: {marketapp_budget: {rolling_24h_used: used, rolling_24h_limit: 500}}});
    assert.match(presentJobSync(saved).message, /daily request allowance is used up/);
  }
});

test('owned price check counts fixed gifts and treats unavailable updates conservatively', () => {
  assert.equal(presentOwnedPriceSync(owned()).progress.percent, 25);
  const done = owned({phase: 'complete'}); done.run = {...done.run!, state: 'complete', checked: 160, updated: 100, unresolved: 60};
  const model = presentOwnedPriceSync(done); assert.equal(model.title, 'Your gift prices'); assert.equal(model.progress.percent, 100); assert.equal(model.message, '100 gift prices refreshed. 60 could not be updated.');
  const stopped = owned({phase: 'partial', canStop: false}); stopped.run = {...stopped.run!, state: 'partial', checked: 160, reason: 'stopped_by_you'};
  assert.equal(presentOwnedPriceSync(stopped).progress.percent, 99); assert.equal(presentOwnedPriceSync(stopped).actionLabel, null);
  assert.equal(presentOwnedPriceSync(owned(), {stopping: true}).state, 'stopping');
  assert.equal(presentOwnedPriceSync(owned({phase: 'unavailable'})).state, 'failed');
  const none = presentOwnedPriceSync(owned({run: null})); assert.equal(none.state, 'preparing'); assert.equal(none.progress.indeterminate, true);
});

test('custom rental timeframes affect purpose while listing purpose stays current', () => {
  assert.match(presentJobSync(job({collection_window: {timeframe: 'custom'}})).objective, /selected dates/);
  assert.match(presentJobSync(job(), {timeframeLabel: 'Last 7 days'}).objective, /last 7 days/);
  assert.doesNotMatch(presentJobSync(job({kind: 'prices'}), {timeframeLabel: 'Last 90 days'}).objective, /90/);
});

test('compact status retains pause cause, restored allowance, failures and the current collection', () => {
  const compact = (value: Job) => compactJobMessage(value, presentJobSync(value));
  assert.equal(compact(job()), 'Checking Low Riders');
  assert.equal(compact(job({state: 'partial', reason: 'daily_limit'})), 'Daily allowance used · progress saved.');
  assert.equal(compact(job({state: 'partial', reason: 'daily_limit', progress: {marketapp_budget: {rolling_24h_used: 0, rolling_24h_limit: 500}}})), 'Allowance available · ready to continue.');
  assert.equal(compact(job({state: 'partial', reason: 'retry_wait'})), 'Provider cooldown · continue later.');
  assert.equal(compact(job({reason: 'retry_wait'})), 'Provider cooldown · retrying automatically.');
  assert.equal(compact(job({state: 'failed', reason: 'authentication_failed'})), 'Access rejected · check the API connection.');
  assert.equal(compact(job({state: 'failed', reason: 'cursor_rejected'})), 'Cannot resume · start a new refresh.');
});
