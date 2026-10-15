import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundMonitoringWorker, projectBackgroundMonitoring, BACKGROUND_MONITORING_LIMITS as LIMITS} from '../worker/monitoring.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {streamedBody} from './fixtures/http-response.mjs';

const START = Date.parse('2026-10-14T12:00:00Z'), RUNNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const address = n => `0:${n.toString(16).padStart(64, '0')}`, copy = value => structuredClone(value);
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
function fixture() {
  let at = START, revision = 0, state = {job: null, unrelated: {retained: true}}, nextGift = 1, nextJob = 1;
  let scope = {wallet: address(1), wallet_revision: 0, credential_version: 1, session_generation: 1};
  const policy = {wallet: address(1), paused: false, policies: [2, 3].map(n => ({nft_address: address(n), enabled: true, paused: false})), proposals: []};
  const calls = [], inputs = [], events = [];
  const repository = {
    async read() {return {revision, state: copy(state)};},
    async append(expected, event, walletFence = null) {
      if (expected !== revision || walletFence !== null && walletFence !== scope.wallet_revision) return false;
      state = copy(event.state); events.push(copy(event)); revision++; return true;
    },
  };
  const contextCheck = context => {
    assert.equal(context.run_id, state.background_monitoring.run.id);
    assert.equal(context.lease.token, state.background_monitoring.run.lease.token);
    assert.ok(context.lease.until > at);
  };
  const giftProjection = session => ({run: state.gift_refresh?.run ? {...copy(state.gift_refresh.run), session_id: session} : null, next_allowed_at: 0, server_time: at});
  const jobProjection = () => ({...copy(state.job), progress: {next_allowed_at: state.job?.next_allowed_at ?? 0,
    // This matches getJobs: no live lease sets the hint even during an active
    // invocation. It is deliberately broader than the need to call Resume.
    requires_resume: state.job?.requires_resume ?? (['running', 'queued'].includes(state.job?.state) && (state.job.lease_until ?? 0) <= at)}});
  const dependencies = {repository, clock: async () => at, captureScope: async () => copy(scope),
    assertScope: async old => {if (JSON.stringify(old) !== JSON.stringify(scope)) throw Object.assign(new Error('changed'), {code: 'BACKGROUND_SCOPE_CHANGED'});},
    rules: {
      async status() {calls.push('rules.status'); return copy(policy);},
      async evaluate(context) {contextCheck(context); calls.push('rules.evaluate'); return copy(policy);},
    },
    gifts: {
      async status(input, context) {contextCheck(context); calls.push('gifts.status'); return giftProjection(input.session_id);},
      async start(input, context) {
        contextCheck(context); calls.push('gifts.start'); inputs.push(copy(input));
        state.gift_refresh = {run: {id: nextGift++, wallet: scope.wallet, session_id: input.session_id, state: 'running', checked: 0, total: 2, deadline: at + 120000}};
        revision++; return giftProjection(input.session_id);
      },
      async step(input, context) {
        contextCheck(context); calls.push('gifts.step'); inputs.push(copy(input));
        const run = state.gift_refresh.run; assert.equal(input.run_id, run.id); run.checked++;
        if (run.checked === run.total) run.state = 'complete'; revision++; return giftProjection(input.session_id);
      },
    },
    history: {
      async status(context) {contextCheck(context); calls.push('history.status'); return {jobs: state.job ? [jobProjection()] : []};},
      async start(input, context) {
        contextCheck(context); calls.push('history.start'); inputs.push(copy(input));
        state.job = {id: nextJob++, kind: 'rental_prices', state: 'running', reason: null, created_at: new Date(at).toISOString(),
          collection_window: {timeframe: input.timeframe},
          lease_until: 0, invocation_deadline: at + 300000, pages: 0}; revision++; return {job: jobProjection()};
      },
      async step(input, context) {
        contextCheck(context); calls.push('history.step'); inputs.push(copy(input));
        assert.equal(input.job_id, state.job.id); state.job.pages++;
        if (state.job.pages === 2) state.job.state = 'complete'; revision++; return {job: jobProjection()};
      },
      async resume(input, context) {
        contextCheck(context); calls.push('history.resume'); inputs.push(copy(input)); assert.equal(input.job_id, state.job.id);
        state.job.state = 'running'; state.job.reason = null; state.job.requires_resume = false; state.job.invocation_deadline = at + 300000;
        revision++; return {job: jobProjection()};
      },
    },
  };
  const f = {dependencies, policy, calls, inputs, events, repository,
    state: () => copy(state), at: () => at, scope: () => copy(scope), revision: () => revision,
    mutate(fn) {fn(state); revision++;},
    changeScope(change) {Object.assign(scope, change);},
    advance(ms = 1000) {at += ms;},
    tick: (runner_id = RUNNER) => createBackgroundMonitoringWorker(dependencies).tick({runner_id}),
    status: () => createBackgroundMonitoringWorker(dependencies).status(),
    async until(stage) {
      for (let n = 0; n < 30; n++) {
        const row = state.background_monitoring;
        if (row?.run.stage === stage) return;
        const result = await f.tick(); assert.equal(result.state, 'running', JSON.stringify(result)); f.advance();
      }
      assert.fail(`did not reach ${stage}`);
    },
    async complete() {
      for (let n = 0; n < 40; n++) {
        const before = calls.filter(c => c === 'gifts.step' || c === 'history.step').length;
        const result = await f.tick();
        assert.ok(calls.filter(c => c === 'gifts.step' || c === 'history.step').length - before <= 1);
        if (!['running', 'waiting', 'busy'].includes(result.state)) return result;
        f.advance();
      }
      assert.fail('did not finish');
    },
  };
  return f;
}

test('background worker refreshes gifts, then bounded history, then evaluates and preserves unrelated saved data', async () => {
  const f = fixture(), result = await f.complete();
  assert.equal(result.state, 'complete'); assert.equal(result.checked, 2); assert.equal(result.total, 2);
  assert.equal(result.proposals, 0); assert.equal(f.calls.filter(c => c === 'rules.evaluate').length, 1);
  assert.ok(f.calls.lastIndexOf('gifts.step') < f.calls.indexOf('history.start'));
  assert.ok(f.calls.lastIndexOf('history.step') < f.calls.indexOf('rules.evaluate'));
  assert.deepEqual(f.inputs.find(input => input.kind), {kind: 'rental_prices', timeframe: '30d', force_refresh: true});
  assert.deepEqual(f.state().unrelated, {retained: true});
  assert.equal(result.background_monitoring.cadence_hours, 6);
  assert.equal(result.background_monitoring.last_success_at, result.background_monitoring.last_finished_at);
  assert.equal(result.background_monitoring.next_check_at, '2026-10-14T18:00:00.000Z');
  assert.ok(f.events.every(event => event.records.length === 0 && event.raw_body === null));
});

test('the live getJobs requires_resume hint does not restart a healthy history invocation', async () => {
  const f = fixture(); await f.until('history_poll');
  const context = f.state().background_monitoring.run;
  assert.ok(context.history_job_id);
  await f.complete(); assert.equal(f.calls.filter(c => c === 'history.step').length, 2);
  assert.equal(f.calls.includes('history.resume'), false);
});

test('actual CloudEngine history completes through getJobs despite its broad Resume hint', async () => {
  let at = START, revision = 0, state = {version: 2, next_job_id: 1, job: null, attempts: [], next_allowed_at: 0};
  const wallet = address(1), nft = address(2), collection = address(3), ctx = {initData: {user: {id: 42}}};
  const records = [{kind: 'portfolio', record: {nft_address: nft, is_portfolio: true, collection_address: collection}}];
  const scope = {wallet, wallet_revision: 0, credential_version: 1, session_generation: 1}, calls = [];
  const repository = {read: async () => ({revision, state: copy(state)}),
    append: async (expected, event) => {if (expected !== revision) return false; state = copy(event.state); revision++; return true;},
    records: async () => copy(records), jobs: async () => state.job ? [copy(state.job)] : []};
  let requests = 0;
  const collector = createCloudEngine({repository, ownerTelegramId: 42, marketappToken: 'synthetic', now: () => at,
    fetch: async url => {
      requests++;
      const body = new URL(url).pathname === '/v1/collections/gifts/'
        ? [{address: collection, name: 'Gifts', extra_data: {}}] : {cursor: null, items: []};
      return {status: 200, headers: {get: () => null}, body: streamedBody(JSON.stringify(body))};
    }});
  const policy = {wallet, paused: false, policies: [{nft_address: nft, enabled: true, paused: false}], defaults: {}, proposals: []};
  const deps = {repository, clock: async () => at, captureScope: async () => copy(scope), assertScope: async () => {},
    rules: {status: async () => copy(policy), evaluate: async () => {calls.push('evaluate'); return copy(policy);}},
    gifts: {status: async () => ({run: copy(state.gift_refresh.run), next_allowed_at: 0}),
      start: async input => {state.gift_refresh = {run: {id: 1, wallet, session_id: input.session_id, state: 'complete', checked: 1, total: 1}};
        revision++; return {run: copy(state.gift_refresh.run), next_allowed_at: 0};},
      step: async () => {assert.fail('completed gift check cannot be stepped');}},
    history: {status: async () => {calls.push('status'); return collector.getJobs(ctx);},
      start: async input => {calls.push('start'); return collector.startJob(ctx, input);},
      step: async input => {calls.push('step'); return collector.stepJob(ctx, input);},
      resume: async input => {calls.push('resume'); return collector.resumeJob(ctx, input);}}};
  let result;
  for (let n = 0; n < 15; n++) {
    result = await createBackgroundMonitoringWorker(deps).tick({runner_id: RUNNER});
    if (!['running', 'waiting', 'busy'].includes(result.state)) break;
    at += 1000;
  }
  assert.equal(result.state, 'complete'); assert.equal(requests, 2); assert.equal(state.job.pages, 2);
  assert.equal(calls.includes('resume'), false); assert.equal(state.background_monitoring.run.history_resumes, 0);
  assert.equal(state.history_coverage[collection].complete, true);
  assert.ok(state.history_coverage[collection].checked_through * 1000 >= START);
  assert.equal(calls.at(-1), 'evaluate');
});

test('hourly wake-ups keep delayed and legacy cycles at least six hours apart', async () => {
  for (const legacy of [false, true]) {
    const f = fixture(); f.advance(Date.parse('2026-10-14T17:37:00Z') - f.at()); await f.complete();
    if (legacy) f.mutate(saved => {saved.background_monitoring.next_check_at = '2026-10-14T18:37:00.000Z';});
    const calls = f.calls.length, revision = f.revision(), due = Date.parse('2026-10-14T23:37:00Z');
    const status = await f.status();
    assert.equal(status.background_monitoring.next_check_at, new Date(due).toISOString());
    assert.equal(Date.parse(status.retry_at), due);
    for (let hour = 18; hour <= 22; hour++) {
      f.advance(Date.parse(`2026-10-14T${hour}:37:00Z`) - f.at());
      assert.equal((await f.tick(OTHER)).state, 'complete');
      assert.equal(f.calls.length, calls); assert.equal(f.revision(), revision);
    }
    f.advance(due - 1 - f.at());
    assert.equal((await createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: OTHER, retry: true})).state, 'complete');
    assert.equal(f.calls.length, calls); assert.equal(f.revision(), revision);
    f.advance(1); const result = await f.tick(OTHER); assert.equal(result.state, 'running');
    assert.equal(f.calls.filter(c => c === 'gifts.start').length, 2);
    assert.equal(result.background_monitoring.next_check_at, '2026-10-15T05:37:00.000Z');
  }
});

test('a wake after missed slots catches up once and leaves early wake-ups read-only', async () => {
  const f = fixture(); await f.complete(); f.advance(Date.parse('2026-10-15T04:37:00Z') - f.at());
  assert.equal((await f.complete()).state, 'complete');
  assert.equal(f.calls.filter(c => c === 'gifts.start').length, 2);
  assert.equal(f.state().background_monitoring.next_check_at, '2026-10-15T10:37:00.000Z');
  const calls = f.calls.length, revision = f.revision();
  for (let hour = 5; hour <= 9; hour++) {
    f.advance(Date.parse(`2026-10-15T0${hour}:37:00Z`) - f.at());
    assert.equal((await f.tick(OTHER)).state, 'complete');
    assert.equal(f.calls.length, calls); assert.equal(f.revision(), revision);
  }
});

test('manual retry immediately starts recovered terminal work but does not bypass a completed cadence', async () => {
  for (const state of ['failed', 'blocked', 'partial', 'paused']) {
    const f = fixture(); await f.complete(); f.advance(3600000);
    f.mutate(saved => {saved.background_monitoring.state = state; saved.background_monitoring.last_success_at = null;});
    const original = f.state().background_monitoring.run.id;
    const row = await createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: OTHER, retry: true});
    assert.equal(row.state, 'running', state);assert.notEqual(f.state().background_monitoring.run.id, original);
    assert.equal(f.calls.filter(c => c === 'gifts.start').length, 2);
    assert.equal(Date.parse(row.background_monitoring.next_check_at), f.at() + LIMITS.cadence_ms);
  }
  const f = fixture();await f.complete();const before = f.calls.length;
  const row = await createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: OTHER, retry: true});
  assert.equal(row.state, 'complete');assert.equal(f.calls.length, before);
});

test('manual retries have a durable one-minute cooldown and retain pause controls', async () => {
  const f = fixture();f.dependencies.gifts.start = async () => {f.calls.push('failed.start');throw Error('provider failure');};
  assert.equal((await f.tick()).state, 'failed');
  const retry = () => createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: OTHER, retry: true});
  assert.equal((await retry()).state, 'failed');assert.equal(f.calls.filter(c => c === 'failed.start').length, 2);
  const blocked = await createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: RUNNER, retry: true});assert.equal(blocked.state, 'failed');
  assert.equal(Date.parse(blocked.retry_at), f.at() + LIMITS.manual_retry_ms);
  assert.equal(f.calls.filter(c => c === 'failed.start').length, 2);
  f.advance(LIMITS.manual_retry_ms);assert.equal((await retry()).state, 'failed');
  assert.equal(f.calls.filter(c => c === 'failed.start').length, 2, 'the same invocation retry cannot create another cycle');
  f.policy.paused = true;
  assert.equal((await createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: RUNNER, retry: true})).state, 'paused');
  assert.equal(f.calls.filter(c => c === 'failed.start').length, 2);
  await assert.rejects(createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: OTHER, retry: 'true'}), {code: 'BACKGROUND_RUNNER_INVALID'});
});

test('manual retry cannot bypass a live worker lease or its provider retry deadline', async () => {
  const f = fixture();await f.tick();const before = f.calls.length;
  f.mutate(saved => {saved.background_monitoring.run.lease = {token: `${RUNNER}:2`, until: f.at() + LIMITS.lease_ms};});
  const retry = () => createBackgroundMonitoringWorker(f.dependencies).tick({runner_id: OTHER, retry: true});
  assert.equal((await retry()).state, 'busy');assert.equal(f.calls.length, before);
  f.mutate(saved => {saved.background_monitoring.run.lease = null; saved.background_monitoring.run.next_action_at = f.at() + 45000;});
  const row = await retry();assert.equal(row.state, 'waiting');assert.equal(Date.parse(row.retry_at), f.at() + 45000);
  assert.equal(f.calls.length, before);
});

test('unfinished TON cursor carries into the next bounded cycle despite complete website counts', async () => {
  for (const deadline of [false, true]) {
    const f = fixture();await f.tick();
    f.mutate(saved => {
      const gift = saved.gift_refresh.run;gift.checked = gift.total;
      gift.ton_run_id = 92;gift.ton_session_id = `${gift.session_id}_ton`;gift.ton_targets = [address(2), address(3)];
      saved.owned_prices = {run: {id: 92, wallet: gift.wallet, session_id: gift.ton_session_id, state: 'partial', offset: 1,
        targets: [{nft_address: address(2)}, {nft_address: address(3)}]}};
      if (!deadline) gift.state = 'partial';
    });
    if (deadline) {f.advance(LIMITS.run_ms);assert.equal((await f.tick()).state, 'partial');}
    else assert.equal((await f.complete()).state, 'partial');
    f.advance(LIMITS.cadence_ms);
    const original = f.dependencies.gifts.start;let cursor;
    f.dependencies.gifts.start = async (input, context) => {cursor = context.gift_start_address;return original(input, context);};
    assert.equal((await f.tick(OTHER)).state, 'running');assert.equal(cursor, address(3), String(deadline));
    assert.equal(f.state().background_monitoring.run.gift_start_address, address(3));
  }
});

test('completed, unrelated or changed-scope gift runs cannot donate an unfinished cursor', async () => {
  for (const mode of ['complete', 'session', 'scope', 'wallet', 'outside']) {
    const f = fixture();await f.tick();
    f.mutate(saved => {
      const gift = saved.gift_refresh.run;gift.state = 'partial';gift.ton_run_id = 92;gift.ton_session_id = `${gift.session_id}_ton`;
      gift.ton_targets = mode === 'outside' ? [address(2)] : [address(2), address(3)];
      saved.owned_prices = {run: {id: 92, wallet: mode === 'wallet' ? address(99) : gift.wallet, session_id: mode === 'session' ? 'someone_else' : gift.ton_session_id,
        state: mode === 'complete' ? 'complete' : 'partial', offset: 1, targets: [{nft_address: address(2)}, {nft_address: address(3)}]}};
    });
    await f.complete();if (mode === 'scope') f.changeScope({credential_version: 2});f.advance(LIMITS.cadence_ms);
    let cursor;const start = f.dependencies.gifts.start;
    f.dependencies.gifts.start = async (input, context) => {cursor = context.gift_start_address;return start(input, context);};
    await f.tick(OTHER);assert.equal(cursor, null, mode);
  }
});

async function resumableGiftFixture() {
  const f = fixture(); await f.tick(); f.advance(300000);
  f.mutate(saved => {
    const gift = saved.gift_refresh.run;
    Object.assign(gift, {state: 'partial', reason: 'duration_limit', execution_profile: 'background-monitoring-v1',
      stage: 'ton', checked: gift.total, attempts: 1, deadline: f.at(), next_allowed_at: 0,
      ton_run_id: 91, ton_session_id: `${gift.session_id}_ton`, ton_targets: [address(2), address(3)],
      results: {[address(2)]: {checked: true, price: true, status: true}, [address(3)]: {checked: true, price: true, status: true}}});
    saved.owned_prices = {attempts: [f.at() - 4000, f.at() - 3000, f.at() - 2000, f.at() - 1000], next_allowed_at: 0,
      run: {id: 91, session_id: gift.ton_session_id, wallet: gift.wallet,
      execution_profile: 'background-monitoring-v1', state: 'partial', reason: 'duration_limit', lease_until: 0,
      deadline: f.at(), attempts: 4, offset: 1, checked: 1, targets: [2, 3].map(n => ({nft_address: address(n)}))}};
  });
  f.dependencies.gifts.resume = async (input, context) => {
    f.calls.push('gifts.resume'); f.inputs.push(copy(input));
    const saved = f.state(), run = saved.background_monitoring.run;
    assert.equal(run.intent, 'gift_resume'); assert.equal(run.gift_resumes, 1);
    assert.equal(context.deadline, run.deadline); assert.equal(context.session_id, input.session_id);
    assert.equal(context.gift_run_id, input.run_id); assert.equal(run.lease.token, context.lease.token);
    f.mutate(state => {
      for (const gift of [state.gift_refresh.run, state.owned_prices.run]) {
        gift.state = 'running'; gift.reason = null; gift.deadline = f.at() + 300000;
      }
    });
    return {run: f.state().gift_refresh.run, next_allowed_at: 0};
  };
  f.dependencies.gifts.step = async (input, context) => {
    f.calls.push('gifts.step'); assert.equal(input.run_id, context.gift_run_id);
    f.mutate(state => {state.owned_prices.run.offset = 2; state.owned_prices.run.checked = 2;
      state.owned_prices.run.state = 'complete'; state.gift_refresh.run.state = 'complete';});
    return {run: f.state().gift_refresh.run, next_allowed_at: 0};
  };
  return f;
}

test('an exact bounded cloud gift traversal resumes once in the same cycle before completing history', async () => {
  const f = await resumableGiftFixture(), before = f.state(), first = await f.tick();
  assert.equal(first.state, 'running'); assert.equal(f.calls.filter(call => call === 'gifts.resume').length, 1);
  const after = f.state();
  assert.equal(after.background_monitoring.run.id, before.background_monitoring.run.id);
  assert.equal(after.gift_refresh.run.id, before.gift_refresh.run.id);
  assert.equal(after.owned_prices.run.id, before.owned_prices.run.id);
  assert.equal(after.owned_prices.run.offset, 1); assert.equal(after.owned_prices.run.attempts, 4);
  assert.deepEqual(after.gift_refresh.run.results, before.gift_refresh.run.results);
  assert.equal(after.background_monitoring.run.gift_complete, false, 'website checked counts do not complete TON work');
  assert.equal(after.background_monitoring.last_success_at, null);
  assert.equal(f.calls.includes('history.start'), false);
  const result = await f.complete(); assert.equal(result.state, 'complete');
  assert.equal(f.calls.filter(call => call === 'gifts.resume').length, 1);
  assert.ok(f.calls.indexOf('gifts.step') < f.calls.indexOf('history.start'));
  assert.equal(result.background_monitoring.last_success_at, result.background_monitoring.last_finished_at);
});

test('gift continuation rejects exhausted, stopped, foreign, unfinished-request and non-cloud checkpoints', async () => {
  const cases = {
    request_limit: saved => {saved.gift_refresh.run.attempts = 2; saved.owned_prices.run.attempts = 18;},
    stopped: saved => {saved.gift_refresh.run.reason = 'stopped_by_you';},
    stop_requested: saved => {saved.gift_refresh.run.stop_requested = true;},
    daily_limit: saved => {saved.owned_prices.run.reason = 'daily_limit';},
    invocation_limit: saved => {saved.gift_refresh.run.reason = 'invocation_limit';},
    failed: saved => {saved.gift_refresh.run.state = 'failed';},
    manual_wrapper: saved => {delete saved.gift_refresh.run.execution_profile;},
    manual_inner: saved => {delete saved.owned_prices.run.execution_profile;},
    website: saved => {saved.gift_refresh.run.stage = 'website';},
    inner_session: saved => {saved.owned_prices.run.session_id = 'foreign';},
    inner_wallet: saved => {saved.owned_prices.run.wallet = address(99);},
    inner_id: saved => {saved.owned_prices.run.id++;},
    target_mismatch: saved => {saved.owned_prices.run.targets[1].nft_address = address(99);},
    exhausted_targets: saved => {saved.owned_prices.run.offset = 2;},
    live_lease: (saved, at) => {saved.owned_prices.run.lease_until = at + 1000;},
    live_http: (saved, at) => {saved.gift_refresh.run.inflight = {until: at + 1000};},
    long_provider_wait: (saved, at) => {saved.owned_prices.next_allowed_at = at + LIMITS.gift_resume_ms;},
    missing_daily_ledger: saved => {delete saved.owned_prices.attempts;},
    invalid_daily_ledger: saved => {saved.owned_prices.attempts = {};},
    invalid_daily_timestamp: saved => {saved.owned_prices.attempts.push('not-a-time');},
    future_daily_timestamp: (saved, at) => {saved.owned_prices.attempts.push(at + 1);},
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = await resumableGiftFixture(); f.mutate(saved => change(saved, f.at()));
    await f.tick(); assert.equal(f.calls.includes('gifts.resume'), false, name);
    assert.equal(f.state().background_monitoring.run.stage, 'history_start', name);
    assert.equal(f.state().background_monitoring.run.gift_complete, false, name);
    const result = await f.complete(); assert.equal(result.state, 'partial', name);
    assert.equal(result.background_monitoring.last_success_at, null, name);
  }
});

test('simultaneous gift deadline and daily request exhaustion remain partial while history proceeds', async () => {
  const f = await resumableGiftFixture();
  f.mutate(saved => {saved.owned_prices.attempts = Array(LIMITS.gift_daily_attempts).fill(f.at());});
  const result = await f.complete();
  assert.equal(result.state, 'partial'); assert.equal(result.background_monitoring.reason, 'gift_refresh_partial');
  assert.equal(f.calls.includes('gifts.resume'), false); assert.equal(f.calls.includes('history.step'), true);
  assert.equal(f.calls.includes('rules.evaluate'), true); assert.equal(result.background_monitoring.last_success_at, null);
  const expired = await resumableGiftFixture();
  expired.mutate(saved => {saved.owned_prices.attempts = [
    ...Array(LIMITS.gift_daily_attempts).fill(expired.at() - 86400000), expired.at() - 1000,
  ];});
  await expired.tick(); assert.equal(expired.calls.includes('gifts.resume'), true, 'only attempts strictly inside the rolling day consume its allowance');
});

test('gift continuation leaves a full bounded window for history and honors its one-resume cap', async () => {
  const late = await resumableGiftFixture();
  late.advance(LIMITS.run_ms - LIMITS.gift_resume_ms - LIMITS.gift_history_reserve_ms - (late.at() - START) + 1);
  await late.tick(); assert.equal(late.calls.includes('gifts.resume'), false);
  assert.equal(late.state().background_monitoring.run.stage, 'history_start');
  const repeated = await resumableGiftFixture(); await repeated.tick();
  repeated.advance(300000); repeated.mutate(saved => {
    for (const run of [saved.gift_refresh.run, saved.owned_prices.run]) {run.state = 'partial'; run.reason = 'duration_limit';}
  });
  await repeated.tick(); assert.equal(repeated.calls.filter(call => call === 'gifts.resume').length, 1);
  assert.equal(repeated.state().background_monitoring.run.stage, 'history_start');
  assert.equal((await repeated.complete()).state, 'partial');
});

test('gift continuation preserves legacy ledgers and optional adapters without widening authority', async () => {
  const legacy = await resumableGiftFixture(); legacy.mutate(saved => {delete saved.background_monitoring.run.gift_resumes;});
  await legacy.tick(); assert.equal(legacy.calls.includes('gifts.resume'), true);
  const oldAdapter = await resumableGiftFixture(); delete oldAdapter.dependencies.gifts.resume;
  await oldAdapter.tick(); assert.equal(oldAdapter.state().background_monitoring.run.stage, 'history_start');
  assert.equal((await oldAdapter.complete()).state, 'partial');
});

test('a lost gift-resume response is counted before dispatch and cannot be replayed in the same cycle', async () => {
  const f = await resumableGiftFixture(), original = f.dependencies.gifts.resume;
  f.dependencies.gifts.resume = async (...args) => {await original(...args); throw Error('lost response');};
  const result = await f.tick(); assert.equal(result.state, 'failed');
  assert.equal(f.state().background_monitoring.run.gift_resumes, 1);
  await f.tick(); assert.equal(f.calls.filter(call => call === 'gifts.resume').length, 1);
});

test('pausing rules or changing scope prevents a pending gift continuation', async () => {
  for (const mode of ['pause', 'scope', 'targets']) {
    const f = await resumableGiftFixture();
    if (mode === 'pause') f.policy.paused = true;
    if (mode === 'scope') f.changeScope({credential_version: 2});
    if (mode === 'targets') f.policy.policies[0].paused = true;
    const result = await f.tick(); assert.ok(['paused', 'blocked'].includes(result.state));
    assert.equal(f.calls.includes('gifts.resume'), false, mode);
  }
});

test('the next scheduled tick closes an abandoned prior run and starts the due cycle immediately', async () => {
  const f = fixture(); f.advance(37 * 60000); await f.tick();
  const prior = f.state().background_monitoring.run.id;
  f.advance(LIMITS.cadence_ms); const result = await f.tick(OTHER);
  assert.equal(result.state, 'running'); assert.notEqual(f.state().background_monitoring.run.id, prior);
  assert.equal(f.calls.filter(c => c === 'gifts.start').length, 2);
  assert.ok(f.events.some(event => event.state.background_monitoring.reason === 'run_deadline'));
});

test('history lookback covers active rules without allocating a needless 90-day scan', async () => {
  for (const [days, expected] of [[10, '30d'], [45, '60d'], [90, '90d'], [365, '90d']]) {
    const f = fixture(); f.policy.defaults = {decrease_enabled: true, idle_days: days};
    await f.until('history_poll'); assert.equal(f.inputs.find(input => input.kind).timeframe, expected);
  }
  const f = fixture(); f.policy.defaults = {decrease_enabled: true, idle_days: 10, increase_enabled: false, increase_window_days: 90};
  f.policy.policies[0].overrides = {increase_enabled: true, increase_window_days: 45};
  await f.until('history_poll'); assert.equal(f.inputs.find(input => input.kind).timeframe, '60d');
});

test('history start waits past fractional-second gift observations before freezing its coverage watermark', async () => {
  const f = fixture(); f.advance(123); await f.tick(); await f.tick(); await f.tick();
  const waiting = await f.tick(); assert.equal(waiting.state, 'waiting'); assert.equal(f.calls.includes('history.start'), false);
  assert.equal(Date.parse(waiting.retry_at) % 1000, 0); f.advance(877); await f.tick();
  assert.equal(f.calls.includes('history.start'), true);
});

test('finished checks do no work before six-hour due time, then start a fresh gift session and history job', async () => {
  const f = fixture(); await f.complete(); const first = f.state().background_monitoring.run;
  const count = f.calls.length; await f.tick(); assert.equal(f.calls.length, count);
  f.advance(LIMITS.cadence_ms); await f.complete();
  const second = f.state().background_monitoring.run;
  assert.notEqual(first.id, second.id); assert.notEqual(first.session_id, second.session_id);
  assert.notEqual(first.history_job_id, second.history_job_id);
  assert.equal(f.calls.filter(c => c === 'history.start').length, 2);
});

test('global pause and zero enabled policies save honest paused status without provider work', async () => {
  for (const global of [true, false]) {
    const f = fixture(); f.policy.paused = global;
    if (!global) for (const policy of f.policy.policies) policy.enabled = false;
    const result = await f.tick(); assert.equal(result.state, 'paused');
    assert.equal(result.background_monitoring.reason, global ? 'monitoring_paused' : 'no_enabled_gifts');
    assert.equal(result.background_monitoring.last_success_at, null);
    assert.deepEqual(f.calls, ['rules.status']);
  }
});

test('per-gift pause between provider steps stops the current pass instead of continuing its frozen target set', async () => {
  const f = fixture(); await f.tick(); f.policy.policies[0].paused = true;
  const result = await f.tick(); assert.equal(result.state, 'paused');
  assert.equal(result.background_monitoring.reason, 'rules_changed'); assert.equal(f.calls.includes('gifts.step'), false);
});

test('pause after the first policy read is checked again before the provider action', async () => {
  const f = fixture(), original = f.dependencies.rules.status; let n = 0;
  f.dependencies.rules.status = async (...args) => {if (++n === 2) f.policy.paused = true; return original(...args);};
  const result = await f.tick(); assert.equal(result.state, 'paused'); assert.equal(f.calls.includes('gifts.start'), false);
});

test('duplicate concurrent runner ticks acquire one lease and never overlap provider work', async () => {
  const f = fixture(), wait = deferred(), original = f.dependencies.gifts.start;
  f.dependencies.gifts.start = async (...args) => {await wait.promise; return original(...args);};
  const first = f.tick();
  for (let n = 0; n < 10 && !f.state().background_monitoring?.run.intent; n++) await new Promise(resolve => setImmediate(resolve));
  const second = await f.tick(OTHER); assert.equal(second.state, 'busy'); assert.ok(Date.parse(second.retry_at) > f.at());
  wait.resolve(); await first; assert.equal(f.calls.filter(c => c === 'gifts.start').length, 1);
});

test('expired lease recovers the exact committed gift session without creating another refresh', async () => {
  const f = fixture(); await f.tick();
  f.mutate(state => {const run = state.background_monitoring.run; run.stage = 'gift_start'; run.gift_run_id = null;
    run.intent = 'gift_start'; run.lease = {token: `${RUNNER}:1`, until: f.at() + 1000};});
  f.advance(1001); const result = await f.tick(OTHER);
  assert.equal(result.state, 'running'); assert.equal(f.calls.filter(c => c === 'gifts.start').length, 1);
  assert.equal(f.state().background_monitoring.run.gift_run_id, 1);
});

test('a lost history-start response is never retried or associated with a guessed job', async () => {
  const f = fixture(); await f.until('history_start');
  const original = f.dependencies.history.start;
  f.dependencies.history.start = async (...args) => {await original(...args); throw new Error('lost reply with private details');};
  const result = await f.tick(); assert.equal(result.state, 'blocked');
  assert.equal(result.background_monitoring.reason, 'history_start_uncertain');
  await f.tick(OTHER); assert.equal(f.calls.filter(c => c === 'history.start').length, 1);
  assert.equal(f.calls.includes('history.resume'), false); assert.equal(f.calls.includes('history.step'), false);
  assert.equal(JSON.stringify(result).includes('private details'), false);
});

test('crashed history-start intent is blocked after lease expiry without repeating the start', async () => {
  const f = fixture(); await f.until('history_start');
  f.mutate(state => {const run = state.background_monitoring.run; run.intent = 'history_start';
    run.lease = {token: `${RUNNER}:9`, until: f.at() + 1000};});
  f.advance(1001); const result = await f.tick(OTHER);
  assert.equal(result.state, 'blocked'); assert.equal(result.background_monitoring.reason, 'history_start_uncertain');
  assert.equal(f.calls.includes('history.start'), false);
});

test('a user collection is not adopted, stopped, resumed or replaced', async () => {
  for (const state of ['running', 'queued']) {
    const f = fixture(); f.mutate(saved => {saved.job = {id: 81, kind: 'rental_prices', state, lease_until: 0, invocation_deadline: START + 300000};});
    const result = await f.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.background_monitoring.reason, 'collection_running');
    assert.equal(f.state().job.id, 81); assert.equal(f.calls.some(c => /^(gifts|history)\./.test(c)), false);
  }
});

test('a user partial history traversal is preserved while fresh gifts still advance monitoring observations', async () => {
  const f = fixture(); f.mutate(saved => {saved.job = {id: 81, kind: 'rental_prices', state: 'partial', reason: 'stopped_by_you', lease_until: 0, invocation_deadline: START - 1};});
  const result = await f.complete(); assert.equal(result.state, 'partial');
  assert.equal(result.background_monitoring.reason, 'collection_running');
  assert.equal(f.calls.filter(c => c === 'gifts.step').length, 2); assert.equal(f.calls.includes('rules.evaluate'), true);
  assert.equal(f.calls.some(c => /^history\./.test(c)), false); assert.equal(f.state().job.id, 81);
});

test('an inactive allowance-ended listing scan permits a separate cloud history check', async () => {
  for (const reason of ['invocation_limit', 'duration_limit']) {
    const f = fixture(), listing = {id: 81, kind: 'prices', state: 'partial', reason, lease_until: 0,
      invocation_deadline: START - 1, cursor: 'saved-listing-page', pages: 33};
    f.mutate(saved => {saved.job = copy(listing);});
    const start = f.dependencies.history.start;
    f.dependencies.history.start = async (...args) => {
      assert.deepEqual(f.state().job, listing, 'The worker must not edit the saved listing before starting history.');
      return start(...args);
    };
    const result = await f.complete();
    assert.equal(result.state, 'complete', reason);
    assert.equal(f.calls.filter(call => call === 'history.start').length, 1);
    assert.equal(f.calls.includes('history.resume'), false);
    assert.equal(f.state().job.kind, 'rental_prices');
  }
});

test('the inactive-listing exception never bypasses stops, leases, or unrelated partial work', async () => {
  const cases = [
    {reason: 'stopped_by_you'}, {stop_requested: true}, {reason: 'provider_wait'}, {reason: 'daily_limit'},
    {reason: 'unknown'}, {reason: null}, {kind: 'rental_prices'}, {kind: 'collect'},
    {lease_until: START + 300000}, {lease_until: -1}, {lease_until: '0'},
    {state: 'running', invocation_deadline: START + 300000}, {state: 'queued', invocation_deadline: START + 300000},
  ];
  for (const change of cases) {
    const f = fixture(), listing = {id: 81, kind: 'prices', state: 'partial', reason: 'invocation_limit',
      lease_until: 0, invocation_deadline: START - 1, ...change};
    f.mutate(saved => {saved.job = copy(listing);});
    const result = await f.complete();
    assert.ok(['partial', 'blocked'].includes(result.state), JSON.stringify(change));
    assert.equal(result.background_monitoring.reason, 'collection_running');
    assert.equal(f.calls.some(call => /^history\./.test(call)), false);
    assert.deepEqual(f.state().job, listing);
  }
});

test('a listing interrupted before saving its expired invocation can yield without changing its raw checkpoint', async () => {
  for (const state of ['running', 'queued']) for (const lease_until of [0, START - 1]) {
    const f = fixture(), listing = {id: 81, kind: 'prices', state, reason: null, lease_until,
      invocation_deadline: START, cursor: 'saved-listing-page', pages: 33};
    f.mutate(saved => {saved.job = copy(listing);});
    const start = f.dependencies.history.start;
    f.dependencies.history.start = async (...args) => {
      assert.deepEqual(f.state().job, listing);
      return start(...args);
    };
    const result = await f.complete();
    assert.equal(result.state, 'complete', `${state}/${lease_until}`);
    assert.equal(f.calls.filter(call => call === 'history.start').length, 1);
    assert.equal(f.calls.includes('history.resume'), false);
  }
});

test('foreign running listing scans require a valid expired invocation and lease before yielding', async () => {
  const changes = [
    ...[undefined, null, 0, -1, 1.5, String(START - 1), START + 60000].map(invocation_deadline => ({invocation_deadline})),
    {lease_until: START + 60000}, {lease_until: -1}, {lease_until: '0'}, {lease_until: 1.5},
    {reason: 'stopped_by_you'}, {stop_requested: true}, {kind: 'rental_prices'}, {kind: 'collect'},
  ];
  for (const state of ['running', 'queued']) for (const change of changes) {
    const f = fixture(), listing = {id: 81, kind: 'prices', state, reason: null,
      lease_until: 0, invocation_deadline: START - 1, ...change};
    f.mutate(saved => {saved.job = copy(listing);});
    const result = await f.complete();
    assert.ok(['partial', 'blocked'].includes(result.state), `${state}/${JSON.stringify(change)}`);
    assert.equal(result.background_monitoring.reason, 'collection_running');
    assert.equal(f.calls.some(call => /^history\./.test(call)), false);
    assert.deepEqual(f.state().job, listing);
  }
});

test('a foreground gift refresh is waited for rather than joined or stepped', async () => {
  const f = fixture(); f.mutate(saved => {saved.gift_refresh = {run: {id: 81, wallet: address(1), session_id: 'foreground', state: 'running', deadline: START + 30000}};});
  const result = await f.tick(); assert.equal(result.state, 'waiting');
  assert.equal(result.background_monitoring.reason, 'gift_update_running'); assert.equal(f.calls.some(c => /^gifts\./.test(c)), false);
  assert.equal((await f.tick(OTHER)).state, 'waiting');
  f.advance(31000); await f.tick(); assert.equal(f.calls.filter(c => c === 'gifts.start').length, 1);
});

test('a gift-start race joining somebody else’s refresh is rejected before stepping it', async () => {
  const f = fixture(), original = f.dependencies.gifts.start;
  f.dependencies.gifts.start = async (...args) => {const result = await original(...args); f.mutate(saved => {saved.gift_refresh.run.session_id = 'foreground';}); return result;};
  const result = await f.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.background_monitoring.reason, 'gift_refresh_changed');
  assert.equal(f.calls.includes('gifts.step'), false);
});

test('history selection changed by the user is not resumed', async () => {
  const f = fixture(); await f.until('history_poll');
  f.mutate(saved => {saved.job.id = 99; saved.job.kind = 'prices';});
  const result = await f.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.background_monitoring.reason, 'history_changed');
  assert.equal(f.calls.includes('history.resume'), false); assert.equal(f.calls.includes('history.step'), false);
});

test('history can resume only its own bounded traversal, and never an explicit user Stop', async () => {
  const f = fixture(); await f.until('history_poll');
  f.mutate(saved => {saved.job.state = 'partial'; saved.job.reason = 'duration_limit';});
  const result = await f.tick(); assert.equal(result.state, 'running'); assert.equal(f.calls.filter(c => c === 'history.resume').length, 1);
  f.mutate(saved => {saved.job.state = 'partial'; saved.job.reason = 'stopped_by_you'; saved.job.stop_requested = true;});
  await f.tick(); const finished = await f.tick(); assert.equal(finished.state, 'partial');
  assert.equal(finished.background_monitoring.reason, 'history_stopped'); assert.equal(f.calls.filter(c => c === 'history.resume').length, 1);
  assert.equal(f.calls.includes('rules.evaluate'), true);
});

test('partial gift checks and failed history still evaluate saved evidence without claiming successful completion', async () => {
  const f = fixture(), original = f.dependencies.gifts.step;
  f.dependencies.gifts.step = async (...args) => {const result = await original(...args); result.run.state = 'partial';
    f.mutate(saved => {saved.gift_refresh.run.state = 'partial';}); return result;};
  await f.until('history_poll'); f.mutate(saved => {saved.job.state = 'failed';});
  await f.tick(); const result = await f.tick(); assert.equal(result.state, 'partial');
  assert.equal(result.background_monitoring.last_success_at, null); assert.equal(f.calls.includes('rules.evaluate'), true);
});

test('provider deadlines are respected and a wait past the run deadline becomes a partial evaluation', async () => {
  const f = fixture(); await f.until('history_poll');
  f.mutate(saved => {saved.job.next_allowed_at = f.at() + 5000;});
  const waiting = await f.tick(); assert.equal(waiting.state, 'waiting'); assert.equal(f.calls.includes('history.step'), false);
  await f.tick(); assert.equal(f.calls.includes('history.step'), false);
  f.advance(5001); f.mutate(saved => {saved.job.next_allowed_at = START + LIMITS.run_ms + 1000;});
  await f.tick(); const result = await f.tick(); assert.equal(result.state, 'partial');
  assert.equal(result.background_monitoring.reason, 'history_partial'); assert.equal(f.calls.includes('rules.evaluate'), true);
});

test('history request allowance prevents the next provider step but still evaluates partial evidence', async () => {
  const f = fixture(); await f.until('history_poll');
  f.mutate(saved => {saved.background_monitoring.run.history_steps = LIMITS.history_steps;});
  await f.tick(); const result = await f.tick(); assert.equal(result.state, 'partial');
  assert.equal(result.background_monitoring.reason, 'history_limit'); assert.equal(f.calls.includes('history.step'), false);
  assert.equal(f.calls.includes('rules.evaluate'), true);
});

test('only the acknowledged prior worker history cursor carries over, followed by a fresh coverage job', async () => {
  const f = fixture(); await f.until('history_poll');
  f.mutate(saved => {saved.background_monitoring.run.history_steps = LIMITS.history_steps;
    saved.job.state = 'partial'; saved.job.reason = 'invocation_limit';});
  await f.tick(); assert.equal((await f.tick()).state, 'partial'); const old = f.state().job.id;
  f.advance(LIMITS.cadence_ms); await f.until('history_poll');
  assert.equal(f.state().background_monitoring.run.history_job_id, old);
  assert.equal(f.calls.filter(c => c === 'history.start').length, 1);
  const result = await f.complete(); assert.equal(result.state, 'complete');
  assert.equal(f.calls.filter(c => c === 'history.resume').length, 1);
  assert.equal(f.calls.filter(c => c === 'history.start').length, 2);
  assert.notEqual(f.state().job.id, old);
  assert.ok(Date.parse(f.state().job.created_at) >= f.state().background_monitoring.run.history_after_at);
});

test('a stopped prior worker history is not silently resumed or replaced in the next cycle', async () => {
  const f = fixture(); await f.until('history_poll');
  f.mutate(saved => {saved.job.state = 'partial'; saved.job.reason = 'stopped_by_you'; saved.job.stop_requested = true;});
  await f.tick(); await f.tick(); const id = f.state().job.id;
  f.advance(LIMITS.cadence_ms); const result = await f.complete();
  assert.equal(result.state, 'partial'); assert.equal(result.background_monitoring.reason, 'collection_running');
  assert.equal(f.state().job.id, id); assert.equal(f.calls.filter(c => c === 'history.start').length, 1);
  assert.equal(f.calls.includes('history.resume'), false);
});

test('overall deadline stops work and never invents a last successful check', async () => {
  const f = fixture(); await f.tick(); f.advance(LIMITS.run_ms);
  const result = await f.tick(); assert.equal(result.state, 'partial'); assert.equal(result.background_monitoring.reason, 'run_deadline');
  assert.equal(result.background_monitoring.last_success_at, null); assert.equal(f.calls.includes('gifts.step'), false);
});

test('scope change stops before the next provider request or evaluation', async () => {
  const f = fixture(); await f.tick(); f.changeScope({credential_version: 2});
  const result = await f.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.background_monitoring.reason, 'scope_changed');
  assert.equal(f.calls.includes('gifts.step'), false); assert.equal(f.calls.includes('rules.evaluate'), false);
});

test('wallet change records only blocked metadata with the current wallet fence and resets success for the new scope', async () => {
  const f = fixture(); await f.complete(); f.advance(LIMITS.cadence_ms); await f.tick();
  f.changeScope({wallet: address(4), wallet_revision: 8}); f.policy.wallet = address(4);
  const result = await f.tick(); assert.equal(result.state, 'blocked'); assert.equal(result.background_monitoring.reason, 'scope_changed');
  const steps = f.calls.filter(c => c === 'gifts.step').length;
  assert.equal(steps, 2); f.advance(LIMITS.cadence_ms); await f.tick();
  assert.equal(f.state().background_monitoring.last_success_at, null);
  assert.equal(f.state().background_monitoring.run.previous_history_job_id, null);
});

test('provider-boundary pause rejection is reflected as paused rather than failed', async () => {
  const f = fixture(); await f.tick();
  f.dependencies.gifts.step = async () => {throw Object.assign(new Error('paused'), {code: 'BACKGROUND_PAUSED'});};
  const result = await f.tick(); assert.equal(result.state, 'paused'); assert.equal(result.background_monitoring.reason, 'monitoring_paused');
});

test('clock, corrupted checkpoints and runner IDs fail closed', async () => {
  const f = fixture(); await assert.rejects(f.tick('invalid'), /BACKGROUND_RUNNER_INVALID/);
  assert.deepEqual(f.calls, []); await f.tick();
  f.mutate(saved => {saved.background_monitoring.run.deadline += 1;});
  await assert.rejects(f.tick(), /BACKGROUND_STATE_INVALID/);
  const g = fixture(); g.dependencies.clock = async () => NaN; await assert.rejects(g.tick(), /BACKGROUND_CLOCK_INVALID/);
});

test('metadata and read-only status disclose no wallet, session, job, lease, policy or credentials', async () => {
  const f = fixture(); await f.complete(); const before = f.revision(), calls = f.calls.length;
  const result = await f.status(), projected = projectBackgroundMonitoring(f.state().background_monitoring, f.at());
  assert.deepEqual(projected, result.background_monitoring); assert.equal(f.revision(), before); assert.equal(f.calls.length, calls);
  for (const secret of [address(1), RUNNER, 'credential_version', 'session_id', 'history_job_id', 'lease', 'targets']) assert.equal(JSON.stringify(result).includes(secret), false, secret);
  assert.equal(projectBackgroundMonitoring(null), null);
});

test('a delayed old runner cannot acknowledge or overwrite a newer lease', async () => {
  const f = fixture(), wait = deferred(), original = f.dependencies.gifts.start;
  f.dependencies.gifts.start = async (...args) => {const result = await original(...args); await wait.promise; return result;};
  const first = f.tick();
  for (let n = 0; n < 10 && !f.state().gift_refresh; n++) await new Promise(resolve => setImmediate(resolve));
  f.advance(LIMITS.lease_ms + 1); const replacement = await f.tick(OTHER);
  assert.equal(replacement.state, 'running'); const revision = f.revision();
  wait.resolve(); await first; assert.equal(f.revision(), revision);
  assert.equal(f.calls.filter(c => c === 'gifts.start').length, 1);
});
