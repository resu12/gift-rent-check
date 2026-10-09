import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveMarketAttempts, applyMarketBudgetReset} from '../tgcloud/lib/market-budget.js';
import {todayResetWindow, RESET_SOURCE} from '../tools/reset-market-budget.mjs';

const NOW = Date.parse('2026-10-09T11:00:00Z');
const input = {id: 'test-reset-20261009', ...todayResetWindow(NOW)};
const make = (patch = {}) => {
  let revision = 1, state = {attempts: [NOW - 3000, NOW - 2000], next_allowed_at: NOW + 90000,
    job: {id: 1, state: 'partial', reason: 'daily_limit', lease_until: 0}, records: ['untouched'], ...patch};
  const events = new Map();
  return {clock: async () => NOW, read: async () => ({revision, state}), event: async key => events.get(key) ?? null,
    append: async (expected, event) => {
      if (expected !== revision || events.has(event.key)) return false;
      revision++; state = event.state; events.set(event.key, event.records); return true;
    }};
};

test('reset expires at Berlin midnight, including 23- and 25-hour days', () => {
  assert.equal(new Date(input.expires_at).toISOString(), '2026-10-09T22:00:00.000Z');
  assert.equal(input.local_date, '2026-10-09');
  const spring = Date.parse('2026-03-28T23:00:00Z'), autumn = Date.parse('2026-10-24T22:00:00Z');
  assert.equal(todayResetWindow(spring).expires_at - spring, 23 * 3600000);
  assert.equal(todayResetWindow(autumn).expires_at - autumn, 25 * 3600000);
  assert.throws(() => todayResetWindow(NaN));
  assert.throws(() => todayResetWindow(NOW, 'UTC'));
});

test('one-off reset preserves ledger, provider cooldown, saved job and records', async () => {
  const repository = make(), before = structuredClone((await repository.read()).state);
  const result = await applyMarketBudgetReset(repository, input);
  const {state} = await repository.read();
  assert.equal(result.reset, true); assert.equal(result.effective_used, 0);
  for (const field of ['attempts', 'next_allowed_at', 'job', 'records']) assert.deepEqual(state[field], before[field]);
  assert.deepEqual(effectiveMarketAttempts(state, NOW), []);
  assert.deepEqual(effectiveMarketAttempts(state, input.expires_at), before.attempts);
  const revision = (await repository.read()).revision;
  assert.equal((await applyMarketBudgetReset(repository, input)).already_applied, true);
  assert.equal((await repository.read()).revision, revision);
  await assert.rejects(applyMarketBudgetReset(repository, {...input, id: 'different-reset-id'}), /already applied/);
});

test('future requests count even if their timestamp equals an excluded request', async () => {
  const repository = make({attempts: [NOW, NOW]});
  await applyMarketBudgetReset(repository, input);
  const {state} = await repository.read();
  state.attempts.push(NOW, NOW + 1000);
  assert.deepEqual(effectiveMarketAttempts(state, NOW + 1000), [NOW, NOW + 1000]);
  assert.deepEqual(effectiveMarketAttempts(state, input.expires_at), [NOW, NOW, NOW, NOW + 1000]);
});

test('expired or malformed reset metadata fails closed', () => {
  const state = {attempts: [NOW - 86400001, NOW - 1000], marketapp_budget_reset: {id: input.id, at: NOW, expires_at: input.expires_at, excluded_attempts: [NOW - 1000]}};
  for (const patch of [{at: NOW + 1}, {expires_at: NOW}, {expires_at: NOW + 27 * 3600000}, {excluded_attempts: [NOW + 1]}, {id: ''}]) {
    assert.deepEqual(effectiveMarketAttempts({...state, marketapp_budget_reset: {...state.marketapp_budget_reset, ...patch}}, NOW), [NOW - 1000]);
  }
  assert.deepEqual(effectiveMarketAttempts({attempts: state.attempts}, NOW), [NOW - 1000]);
});

test('reset refuses running work, live leases, bad input and stale windows', async () => {
  for (const job of [{state: 'running'}, {state: 'queued'}, {state: 'partial', lease_until: NOW + 1}]) {
    await assert.rejects(applyMarketBudgetReset(make({job}), input), /Stop the active/);
  }
  for (const patch of [{id: 'bad'}, {expires_at: NOW}, {expires_at: NOW + 27 * 3600000}, {time_zone: 'UTC'}, {local_date: 'bad'}]) {
    await assert.rejects(applyMarketBudgetReset(make(), {...input, ...patch}));
  }
});

test('reset retries CAS against fresh state and records a single event', async () => {
  const repository = make(), append = repository.append;
  let calls = 0;
  repository.append = async (...args) => ++calls === 1 ? false : append(...args);
  assert.equal((await applyMarketBudgetReset(repository, input)).reset, true);
  assert.equal(calls, 2);
  assert.equal((await repository.read()).revision, 2);
});

test('administrative wrapper authorizes owner and contains no provider request or published endpoint', () => {
  assert.match(RESET_SOURCE, /await getJobs\(\{\},ctx\)/);
  assert.doesNotMatch(RESET_SOURCE, /fetch\(|stepJob|startJob|resumeJob/);
});
