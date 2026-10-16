import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createBackgroundMonitoringWorker, projectBackgroundMonitoring, BackgroundMonitoringError, BACKGROUND_MONITORING_LIMITS as LIMITS} from '../worker/monitoring.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {streamedBody} from './fixtures/http-response.mjs';
import {runBackgroundMonitoring,MonitoringAdminError,RUNNER_LIMITS} from '../tools/run-background-monitoring.mjs';

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
          collection_window: {timeframe: input.timeframe},background_history:{version:1,targets:[...state.background_monitoring.run.targets].sort()},
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

test('cloud analytics refresh is a separate guarded stage before evaluation and cache preparation', async () => {
  const f = fixture(); let calls = 0;
  f.dependencies.analytics = {version: 1, refresh: async context => {
    calls++; f.calls.push('analytics.refresh');
    const run = f.state().background_monitoring.run;
    assert.equal(run.stage, 'analytics'); assert.equal(run.intent, 'analytics_refresh');
    assert.equal(context.lease.token, run.lease.token); assert.equal(context.run_id, run.id);
    return {state: 'saved', period_days: 30, captured_at: new Date(f.at()).toISOString(), cookie: 'private', raw_html: 'private'};
  }};
  f.dependencies.dashboard = {version: 1, prewarm: async () => {
    assert.equal(f.state().background_monitoring.run.personal_analytics.state, 'saved'); return {prepared: true};
  }};
  const result = await f.complete();
  assert.equal(result.state, 'complete'); assert.equal(calls, 1);
  assert.ok(f.calls.lastIndexOf('history.step') < f.calls.indexOf('analytics.refresh'));
  assert.ok(f.calls.indexOf('analytics.refresh') < f.calls.indexOf('rules.evaluate'));
  assert.deepEqual(result.personal_analytics, f.state().background_monitoring.run.personal_analytics);
  assert.deepEqual(result.background_monitoring.personal_analytics, result.personal_analytics);
  assert.deepEqual(Object.keys(result.personal_analytics), ['state', 'period_days', 'captured_at']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const before = f.revision(); await f.tick(); assert.equal(calls, 1); assert.equal(f.revision(), before);
  assert.deepEqual(await createBackgroundMonitoringWorker(f.dependencies).prewarm({runner_id: RUNNER}), {state: 'prepared'});
});

test('analytics availability and malformed provider outcomes are reported without failing independent price checks', async () => {
  for (const outcome of [new Error('secret error'), {state: 'unavailable', reason: 'no_login', period_days: 365},
    {state: 'busy', reason: 'website_busy', period_days: 30}, {state: 'limited', reason: 'cooldown', period_days: 30,
      retry_at: new Date(START + 600000).toISOString()}, {state: 'saved', period_days: 30}, {state: 'unavailable', reason: 'private error'}]) {
    const f = fixture();
    f.dependencies.analytics = {version: 1, refresh: async () => {if (outcome instanceof Error) throw outcome; return outcome;}};
    const result = await f.complete(); assert.equal(result.state, 'complete');
    assert.equal(f.calls.filter(call => call === 'rules.evaluate').length, 1);
    assert.deepEqual(result.personal_analytics, outcome instanceof Error || ['saved'].includes(outcome.state)
      || outcome.reason === 'private error' ? {state: 'unavailable', reason: 'refresh_failed'} : outcome);
  }
});

test('analytics preserves rule evaluation time instead of starting a provider refresh near the deadline', async () => {
  const f = fixture(); let calls = 0;
  f.dependencies.analytics = {version: 1, refresh: async () => {calls++; throw Error('must not request');}};
  await f.until('analytics');
  f.advance(f.state().background_monitoring.run.deadline - f.at()
    - LIMITS.analytics_refresh_ms - LIMITS.analytics_evaluation_reserve_ms + 1);
  const skipped = await f.tick(); assert.equal(skipped.state, 'complete'); assert.equal(calls, 0);
  assert.deepEqual(skipped.personal_analytics, {state: 'unavailable', reason: 'run_budget'});
  assert.equal(f.calls.filter(call => call === 'rules.evaluate').length, 1);
});

test('runner budget skip evaluates analytics and legacy checkpoints in the same guarded invocation',async()=>{
  for(const stage of ['analytics','evaluate']) {
    const f=fixture();let analyticsCalls=0;
    if(stage==='analytics')f.dependencies.analytics={version:1,refresh:async()=>{analyticsCalls++;throw Error('must not request');}};
    await f.until(stage);
    f.dependencies.analytics={version:1,refresh:async()=>{analyticsCalls++;throw Error('must not request');}};
    const before=f.calls.filter(call=>/^(gifts|history)\./.test(call));
    const result=await createBackgroundMonitoringWorker(f.dependencies).tick({runner_id:RUNNER,skip_analytics:true});
    assert.equal(result.state,'complete',stage);assert.equal(analyticsCalls,0);
    assert.deepEqual(result.personal_analytics,{state:'unavailable',reason:'run_budget'});
    assert.equal(f.calls.filter(call=>call==='rules.evaluate').length,1);
    assert.deepEqual(f.calls.filter(call=>/^(gifts|history)\./.test(call)),before);
    assert.equal(f.state().background_monitoring.last_success_at,new Date(f.at()).toISOString());
  }
});

test('analytics rechecks the server reserve after slow authorization and claim persistence',async()=>{
  const f=fixture();let analyticsCalls=0,delayed=false;
  f.dependencies.analytics={version:1,refresh:async()=>{analyticsCalls++;throw Error('must not request');}};
  await f.until('analytics');
  f.advance(f.state().background_monitoring.run.deadline-f.at()
    -LIMITS.analytics_refresh_ms-LIMITS.analytics_evaluation_reserve_ms);
  const status=f.dependencies.rules.status;
  f.dependencies.rules.status=async()=>{
    if(!delayed&&f.state().background_monitoring.run.intent==='analytics_refresh') {
      delayed=true;f.advance(1000);
    }
    return status();
  };
  const result=await f.tick();
  assert.equal(delayed,true);assert.equal(result.state,'complete');assert.equal(analyticsCalls,0);
  assert.deepEqual(result.personal_analytics,{state:'unavailable',reason:'run_budget'});
  assert.equal(f.calls.filter(call=>call==='rules.evaluate').length,1);
});

test('an old evaluation checkpoint with insufficient server time never needs an extra transition tick',async()=>{
  const f=fixture();await f.until('evaluate');let analyticsCalls=0;
  f.dependencies.analytics={version:1,refresh:async()=>{analyticsCalls++;throw Error('must not request');}};
  f.advance(f.state().background_monitoring.run.deadline-f.at()
    -LIMITS.analytics_refresh_ms-LIMITS.analytics_evaluation_reserve_ms+1);
  const result=await f.tick();
  assert.equal(result.state,'complete');assert.equal(analyticsCalls,0);
  assert.deepEqual(result.personal_analytics,{state:'unavailable',reason:'run_budget'});
  assert.equal(f.calls.filter(call=>call==='rules.evaluate').length,1);
});

test('slow source loading cannot spend the driver remaining time on analytics before rule evaluation',async()=>{
  const reserve=2*RUNNER_LIMITS.request_ms+1000;
  for(const remaining of [40000,reserve-1,reserve]) {
    const f=fixture(),inputs=[];let analyticsCalls=0,arrived=false;
    f.dependencies.analytics={version:1,refresh:async()=>{
      analyticsCalls++;f.advance(LIMITS.analytics_refresh_ms);
      return {state:'saved',period_days:30,captured_at:new Date(f.at()).toISOString()};
    }};
    const evaluate=f.dependencies.rules.evaluate;
    f.dependencies.rules.evaluate=async context=>{f.advance(20000);return evaluate(context);};
    const api={getFiles:async()=>{
      f.advance(80000);
      return {canonical_modules:{'lib/private-config':'export const ownerTelegramId=42;','lib/runtime':
        'export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;\nexport const PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION=1;\nexport const PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION=1;\nexport function createPrivateBackgroundMonitoringAccess() {}'}};
    },runFunction:async(_sources,input,{timeoutMs})=>{
      const at=f.at(),stage=f.state().background_monitoring?.run.stage;
      inputs.push({input:{...input},stage,at});
      if(stage==='analytics'&&remaining===40000) {
        assert.equal(f.state().background_monitoring.run.deadline-f.at(),120000,
          'The worker still sees 120 seconds although source loading consumed 80 driver seconds.');
      }
      const result=await createBackgroundMonitoringWorker(f.dependencies).tick(input);
      assert.ok(f.at()-at<=timeoutMs,'Every request completes within the remaining driver allowance.');
      if(!arrived&&f.state().background_monitoring?.run.stage==='analytics') {
        arrived=true;f.advance(START+RUNNER_LIMITS.duration_ms-remaining-f.at());
      }
      return {result};
    }};
    const result=await runBackgroundMonitoring({api,enabled:true,random:()=>RUNNER,
      now:f.at,monotonic:()=>f.at()-START,sleep:async ms=>f.advance(ms)});
    const skip=remaining<reserve,analyticsTick=inputs.find(call=>call.stage==='analytics');
    assert.equal(result.state,'complete');assert.ok(arrived);assert.ok(analyticsTick);
    assert.equal(analyticsTick.input.skip_analytics,skip?true:undefined);
    assert.equal(analyticsCalls,skip?0:1);
    assert.equal(f.calls.filter(call=>call==='rules.evaluate').length,1);
    assert.ok(f.at()<START+RUNNER_LIMITS.duration_ms);
    assert.equal(f.state().background_monitoring.state,'complete');
    assert.equal(result.personal_analytics.state,skip?'unavailable':'saved');
    if(skip)assert.equal(result.personal_analytics.reason,'run_budget');
  }
});

test('the final runner request skips optional analytics and still completes rule evaluation',async()=>{
  const f=fixture();let analyticsCalls=0;
  f.dependencies.analytics={version:1,refresh:async()=>{analyticsCalls++;throw Error('must not request');}};
  await f.until('analytics');const inputs=[];
  const result=await runBackgroundMonitoring({enabled:true,random:()=>RUNNER,limits:{steps:1},now:f.at,monotonic:()=>f.at()-START,
    api:{getFiles:async()=>({canonical_modules:{'lib/private-config':'export const ownerTelegramId=42;','lib/runtime':
      'export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;\nexport const PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION=1;\nexport const PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION=1;\nexport function createPrivateBackgroundMonitoringAccess() {}'}}),
      runFunction:async(_sources,input)=>{inputs.push(input);return {result:await createBackgroundMonitoringWorker(f.dependencies).tick(input)};}},
    sleep:async ms=>f.advance(ms)});
  assert.equal(result.state,'complete');assert.equal(analyticsCalls,0);
  assert.deepEqual(inputs,[{runner_id:RUNNER,skip_analytics:true}]);
  assert.deepEqual(result.personal_analytics,{state:'unavailable',reason:'run_budget'});
  assert.equal(f.calls.filter(call=>call==='rules.evaluate').length,1);
});

test('pre-upgrade evaluation checkpoints refresh analytics once without repeating gift or history work', async () => {
  const f = fixture(); await f.until('evaluate');
  const calls = [...f.calls]; let analyticsCalls = 0;
  f.dependencies.analytics = {version: 1, refresh: async () => {
    analyticsCalls++; return {state: 'fresh', period_days: 365, captured_at: new Date(f.at()).toISOString()};
  }};
  assert.equal((await f.tick()).state, 'running'); assert.equal(f.state().background_monitoring.run.stage, 'analytics');
  assert.equal((await f.complete()).state, 'complete'); assert.equal(analyticsCalls, 1);
  assert.deepEqual(f.calls.filter(call => /^(?:gifts|history)\./.test(call)), calls.filter(call => /^(?:gifts|history)\./.test(call)));
});

test('an interrupted analytics checkpoint safely reuses a saved fresh report after the lease expires', async () => {
  const f = fixture(); let capturedAt = null, providerCalls = 0, refreshCalls = 0;
  f.dependencies.analytics = {version: 1, refresh: async () => {
    refreshCalls++;
    // The runtime's startup guard recognizes this persisted capture before it
    // performs provider work, even when its earlier invocation lost the lease.
    if (capturedAt) return {state: 'fresh', period_days: 30, captured_at: capturedAt};
    providerCalls++; capturedAt = new Date(f.at()).toISOString(); f.advance(LIMITS.lease_ms + 1);
    throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
  }};
  await f.until('analytics'); const first = await f.tick(); assert.equal(first.state, 'running');
  assert.equal(f.state().background_monitoring.run.intent, 'analytics_refresh');
  const result = await f.complete(); assert.equal(result.state, 'complete');
  assert.equal(providerCalls, 1); assert.equal(refreshCalls, 2);
  assert.deepEqual(result.personal_analytics, {state: 'fresh', period_days: 30, captured_at: capturedAt});
});

test('the frozen personal report period accepts only supported periods and preserves legacy ledgers', async () => {
  const f = fixture(); await f.until('evaluate');
  for (const period of [30, 365, undefined]) {
    f.mutate(state => {
      if (period === undefined) delete state.background_monitoring.run.personal_analytics_period_days;
      else state.background_monitoring.run.personal_analytics_period_days = period;
    });
    assert.equal((await f.status()).state, 'running');
  }
  for (const period of [null, 0, 90, 366, '30', {}, []]) {
    f.mutate(state => {state.background_monitoring.run.personal_analytics_period_days = period;});
    await assert.rejects(() => f.status(), /BACKGROUND_STATE_INVALID/);
    await assert.rejects(() => f.tick(), /BACKGROUND_STATE_INVALID/);
  }
});

test('analytics cannot swallow a pause, scope change, changed rules or a replaced lease', async () => {
  for (const mode of ['scope', 'pause', 'rules', 'lease']) {
    const f = fixture();
    f.dependencies.analytics = {version: 1, refresh: async () => {
      if (mode === 'scope') {f.changeScope({credential_version: 2}); throw new BackgroundMonitoringError('BACKGROUND_SCOPE_CHANGED');}
      if (mode === 'pause') {f.policy.paused = true; throw new BackgroundMonitoringError('BACKGROUND_PAUSED');}
      if (mode === 'rules') {f.policy.policies.pop(); throw new BackgroundMonitoringError('BACKGROUND_RULES_CHANGED');}
      f.advance(LIMITS.lease_ms + 1); throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
    }};
    await f.until('analytics'); const result = await f.tick();
    assert.equal(result.state, mode === 'scope' ? 'blocked' : mode === 'lease' ? 'running' : 'paused');
    assert.equal(result.personal_analytics, undefined); assert.equal(f.calls.includes('rules.evaluate'), false);
  }
});

test('dashboard preparation follows a saved completion in a separate provider-free operation', async () => {
  const f = fixture(); let prepared;
  f.dependencies.dashboard = {version: 1, prewarm: async context => {
    assert.equal(f.state().background_monitoring.state, 'complete');
    assert.equal(context.lease, null); assert.equal(context.prewarm_only, true);
    assert.equal(context.deadline, f.at() + LIMITS.dashboard_prepare_ms);
    prepared = context; return {prepared: true, private_dashboard: 'must not be returned'};
  }};
  const result = await f.complete(); assert.equal(result.runner_acknowledged, true);
  assert.equal(prepared, undefined, 'The completing provider invocation never builds a dashboard.');
  const before = f.state(), revision = f.revision(), calls = [...f.calls];
  assert.deepEqual(await createBackgroundMonitoringWorker(f.dependencies).prewarm({runner_id: RUNNER}), {state: 'prepared'});
  assert.equal(prepared.run_id, before.background_monitoring.run.id);
  assert.deepEqual(f.state(), before); assert.equal(f.revision(), revision); assert.deepEqual(f.calls, calls);
});

test('dashboard preparation passes its terminal-run context through the real bridge scope guard', async () => {
  const f = fixture(); await f.complete();
  const before = f.state(), revision = f.revision(), calls = [...f.calls], contexts = [];
  const assertScope = f.dependencies.assertScope;
  let prepared;
  const source = readFileSync(new URL('../worker/entrypoint.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace('export default async function', 'return async function');
  const create = vm.runInNewContext(`(function(createPrivateBackgroundMonitoringAccess,PRIVATE_BACKGROUND_MONITORING_VERSION,PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION,PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION,createBackgroundMonitoringWorker,BackgroundMonitoringError){${source}})`);
  const entrypoint = create(check => ({...f.dependencies,
    analytics: {version: 1, refresh: async () => {throw Error('Preparation cannot refresh analytics');}},
    assertScope: async (scope, context) => {
      await assertScope(scope); contexts.push(context); await check(context);
    },
    dashboard: {version: 1, prewarm: async context => {
      await check(context); prepared = context; return {prepared: true};
    }},
  }), 1, 1, 1, createBackgroundMonitoringWorker, BackgroundMonitoringError);
  assert.deepEqual(await entrypoint({runner_id: RUNNER, prewarm_only: true}, {background_worker: 'price-monitoring-v1'}), {state: 'prepared'});
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every(context => context === prepared), 'Both scope checks use the same preparation context as the cache callback.');
  assert.equal(prepared.prewarm_only, true); assert.equal(prepared.lease, null);
  assert.equal(prepared.run_id, before.background_monitoring.run.id);
  assert.equal(prepared.deadline, f.at() + LIMITS.dashboard_prepare_ms);
  assert.deepEqual(f.state(), before); assert.equal(f.revision(), revision); assert.deepEqual(f.calls, calls);
});

test('dashboard preparation skips unacknowledged, incomplete, expired and unsupported runs', async () => {
  for (const mode of ['other_runner', 'incomplete', 'expired', 'old_runtime', 'unsupported_version']) {
    const f = fixture(); await f.complete(); let calls = 0;
    if (mode !== 'old_runtime') f.dependencies.dashboard = {version: mode === 'unsupported_version' ? 2 : 1,
      prewarm: async () => {calls++; return {prepared: true};}};
    if (mode === 'incomplete') f.mutate(state => {state.background_monitoring.run.history_complete = false;});
    if (mode === 'expired') f.advance(LIMITS.dashboard_prepare_age_ms);
    const before = f.state(), revision = f.revision();
    assert.deepEqual(await createBackgroundMonitoringWorker(f.dependencies).prewarm({runner_id: mode === 'other_runner' ? OTHER : RUNNER}), {state: 'skipped'});
    assert.equal(calls, 0); assert.deepEqual(f.state(), before); assert.equal(f.revision(), revision);
  }
});

test('dashboard preparation never changes successful monitoring on cache failure or scope changes', async () => {
  for (const mode of ['failure', 'scope_before', 'scope_after', 'replaced', 'deadline']) {
    const f = fixture(); await f.complete(); const completed = copy(f.state().background_monitoring); let calls = 0;
    f.dependencies.dashboard = {version: 1, prewarm: async () => {
      calls++;
      if (mode === 'failure') throw Error('cache unavailable');
      if (mode === 'scope_after') f.changeScope({wallet_revision: 1});
      if (mode === 'replaced') f.mutate(state => {state.background_monitoring.run.id = OTHER + ':' + START;});
      if (mode === 'deadline') f.advance(LIMITS.dashboard_prepare_ms + 1);
      return {prepared: true};
    }};
    if (mode === 'scope_before') f.changeScope({wallet_revision: 1});
    const operation = () => createBackgroundMonitoringWorker(f.dependencies).prewarm({runner_id: RUNNER});
    if (['failure', 'scope_before', 'scope_after'].includes(mode)) await assert.rejects(operation);
    else assert.deepEqual(await operation(), {state: 'skipped'});
    if (mode === 'scope_before') assert.equal(calls, 0);
    assert.equal(f.state().background_monitoring.state, 'complete');
    assert.equal(f.state().background_monitoring.last_success_at, completed.last_success_at);
  }
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

test('automatic listing cycle and reserve pauses yield to cloud history without changing the saved checkpoint', async () => {
  for (const reason of ['comparison_cycle_limit', 'monitoring_reserve']) {
    const f = fixture(), listing = {id: 81, kind: 'prices', state: 'partial', reason, lease_until: 0,
      invocation_deadline: START + 60000, startup_comparisons: {version: 2, cycle_used: 200},
      cursor: 'saved-listing-page', pages: 33};
    f.mutate(saved => {saved.job = copy(listing);});
    const start = f.dependencies.history.start;
    f.dependencies.history.start = async (...args) => {
      assert.deepEqual(f.state().job, listing);
      return start(...args);
    };
    const result = await f.complete();
    assert.equal(result.state, 'complete', reason);
    assert.equal(result.background_monitoring.reason, null);
    assert.equal(f.calls.filter(call => call === 'history.start').length, 1);
    assert.equal(f.calls.includes('history.resume'), false);
    assert.equal(f.state().job.kind, 'rental_prices');
  }
});

test('automatic budget pauses never bypass manual control, Stop, live work, or invalid leases', async () => {
  const changes = [{startup_comparisons: undefined}, {startup_comparisons: {version: 1}},
    {startup_comparisons: {version: 2, manual_control: true}}, {reason: 'stopped_by_you'}, {stop_requested: true},
    {kind: 'rental_prices'}, {kind: 'collect'}, {state: 'running'}, {state: 'queued'},
    {lease_until: START + 300000}, {lease_until: -1}, {lease_until: '0'}, {lease_until: 0.5}];
  for (const reason of ['comparison_cycle_limit', 'monitoring_reserve']) for (const change of changes) {
    const f = fixture(), listing = {id: 81, kind: 'prices', state: 'partial', reason, lease_until: 0,
      invocation_deadline: START + 300000, startup_comparisons: {version: 2, cycle_used: 200}, ...change};
    f.mutate(saved => {saved.job = copy(listing);});
    const result = await f.complete();
    assert.ok(['partial', 'blocked'].includes(result.state), `${reason}/${JSON.stringify(change)}`);
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

test('an acknowledged legacy or changed-target worker history starts a fresh bounded scope instead of resuming broad work',async()=>{
  for(const legacy of [true,false]) {
    const f=fixture();await f.until('history_poll');
    f.mutate(saved=>{saved.background_monitoring.run.history_steps=LIMITS.history_steps;
      saved.job.state='partial';saved.job.reason='invocation_limit';
      if(legacy)delete saved.job.background_history;else saved.job.background_history.targets=[address(2)];});
    await f.tick();await f.tick();const old=f.state().job.id;
    f.advance(LIMITS.cadence_ms);await f.until('history_poll');
    assert.notEqual(f.state().job.id,old);assert.equal(f.calls.filter(c=>c==='history.start').length,2);
    assert.equal(f.calls.includes('history.resume'),false);
    assert.deepEqual(f.state().job.background_history.targets,[address(2),address(3)]);
  }
});

test('an explicitly stopped legacy worker history cannot be replaced for missing scope metadata',async()=>{
  const f=fixture();await f.until('history_poll');
  f.mutate(saved=>{delete saved.job.background_history;saved.job.state='partial';saved.job.reason='stopped_by_you';saved.job.stop_requested=true;});
  await f.tick();await f.tick();const old=f.state().job.id;f.advance(LIMITS.cadence_ms);
  const result=await f.complete();assert.equal(result.background_monitoring.reason,'collection_running');
  assert.equal(f.state().job.id,old);assert.equal(f.calls.filter(c=>c==='history.start').length,1);
});

test('an obsolete monitored portfolio cursor is blocked once and the next cycle starts a fresh history scan',async()=>{
  const f=fixture();await f.until('history_poll');const old=f.state().job.id;
  const step=f.dependencies.history.step;
  f.dependencies.history.step=async()=>{
    f.mutate(saved=>{saved.job.state='failed';saved.job.reason='background_scope_changed';});
    return {job:f.state().job};
  };
  const blocked=await f.tick();assert.equal(blocked.state,'blocked');assert.equal(blocked.background_monitoring.reason,'scope_changed');
  f.dependencies.history.step=step;f.advance(LIMITS.cadence_ms);await f.until('history_poll');
  assert.notEqual(f.state().job.id,old);assert.equal(f.calls.filter(c=>c==='history.start').length,2);
  assert.equal(f.calls.includes('history.resume'),false);
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

test('running status expires after activity, respects provider waits and never extends the run deadline',async()=>{
  const f=fixture();await f.tick();
  const stamp=value=>new Date(value).toISOString();
  const before=f.revision(),calls=f.calls.length;
  let result=await f.status();
  assert.equal(result.background_monitoring.activity_expires_at,stamp(f.at()+60000));
  assert.equal(result.background_monitoring.run_deadline_at,stamp(START+LIMITS.run_ms));
  f.advance(60001);result=await f.status();
  assert.equal(result.background_monitoring.activity_expires_at,stamp(START+60000),'reads must not renew activity');
  assert.equal(f.revision(),before);assert.equal(f.calls.length,calls);
  f.mutate(saved=>{const run=saved.background_monitoring.run;run.next_action_at=f.at()+300000;
    run.lease={token:`${RUNNER}:2`,until:f.at()+120000};});
  result=await f.status();
  assert.equal(result.retry_at,stamp(f.at()+300000));
  assert.equal(result.background_monitoring.activity_expires_at,stamp(f.at()+360000));
  f.mutate(saved=>{saved.background_monitoring.run.lease.until=START+LIMITS.run_ms+120000;});
  result=await f.status();
  assert.equal(result.background_monitoring.activity_expires_at,stamp(START+LIMITS.run_ms));
  f.advance(LIMITS.run_ms);result=await f.status();
  assert.equal(result.state,'partial');assert.equal(result.background_monitoring.reason,'run_deadline');
  assert.equal(f.state().background_monitoring.state,'running','status leaves the recovery checkpoint untouched');
  for(const privateField of ['session_id','history_job_id','lease','targets',RUNNER,address(1)])
    assert.equal(JSON.stringify(result).includes(privateField),false);
});

test('recovery status acknowledges a claimed runner but not the preceding completed cycle',async()=>{
  const f=fixture(),worker=createBackgroundMonitoringWorker(f.dependencies);
  assert.equal((await worker.status({runner_id:RUNNER})).runner_acknowledged,false);
  await f.complete();
  const before=f.revision(),calls=f.calls.length;
  assert.equal((await worker.status({runner_id:RUNNER})).runner_acknowledged,true);
  const previous=await worker.status({runner_id:OTHER});
  assert.equal(previous.state,'complete');assert.equal(previous.runner_acknowledged,false);
  assert.equal(f.revision(),before);assert.equal(f.calls.length,calls);
  f.advance(LIMITS.cadence_ms);await f.tick();await f.tick(OTHER);
  assert.equal((await worker.status({runner_id:OTHER})).runner_acknowledged,true);
  assert.equal((await worker.status({runner_id:'c'.repeat(64)})).runner_acknowledged,false);
  assert.equal(JSON.stringify(previous).includes(RUNNER),false);
  await assert.rejects(()=>worker.status({runner_id:'invalid'}),/BACKGROUND_RUNNER_INVALID/);
  f.mutate(saved=>{delete saved.background_monitoring.run.last_runner_id;});
  assert.equal((await worker.status({runner_id:RUNNER})).runner_acknowledged,true,'legacy run identity remains known');
});

async function preClaimTerminalFixture(reason) {
  const f=fixture();
  if(reason==='history_start_uncertain') {
    await f.until('history_start');
    f.mutate(saved=>{const run=saved.background_monitoring.run;run.intent='history_start';
      run.lease={token:`${RUNNER}:9`,until:f.at()+1000};});
    f.advance(1001);
  } else {
    await f.tick();
    if(reason==='scope_changed')f.changeScope({credential_version:2});
    else f.advance(LIMITS.run_ms);
  }
  return f;
}

test('lost terminal responses before a new claim recover each committed outcome without extra provider work',async()=>{
  for(const reason of ['run_deadline','scope_changed','history_start_uncertain']) {
    const f=await preClaimTerminalFixture(reason),worker=createBackgroundMonitoringWorker(f.dependencies);
    const before=f.state().background_monitoring,revision=f.revision(),calls=f.calls.length,inputs=[];
    const api={getFiles:async()=>({canonical_modules:{'lib/private-config':'export const ownerTelegramId=42;','lib/runtime':
      'export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;\nexport const PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION=1;\nexport const PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION=1;\nexport function createPrivateBackgroundMonitoringAccess() {}'}}),
      runFunction:async(_sources,input)=>{
        inputs.push({...input});
        if(input.status_only)return {result:await worker.status(input)};
        const result=await worker.tick(input);assert.equal(result.background_monitoring.reason,reason);
        throw new MonitoringAdminError('network_error','tick');
      }};
    const result=await runBackgroundMonitoring({api,enabled:true,random:()=>OTHER,
      now:f.at,monotonic:()=>f.at()-START,sleep:async ms=>f.advance(ms)});
    assert.equal(result.state,reason==='run_deadline'?'partial':'blocked',reason);
    assert.deepEqual(inputs,[{runner_id:OTHER},{runner_id:OTHER,status_only:true}]);
    assert.equal(f.revision(),revision+1);assert.equal(f.calls.length,calls);
    const after=f.state().background_monitoring;
    assert.equal(after.run.last_runner_id,OTHER);assert.equal(after.reason,reason);
    for(const key of ['id','started_at','deadline','claim_generation'])assert.equal(after.run[key],before.run[key]);
    assert.equal(after.next_check_at,before.next_check_at);assert.equal(after.last_started_at,before.last_started_at);
    assert.equal((await worker.status({runner_id:OTHER})).runner_acknowledged,true);
  }
});

test('intermediate terminal writes are not acknowledged before a manual or overdue continuation claims its run',async()=>{
  for(const reason of ['run_deadline','scope_changed','history_start_uncertain'])for(const retry of [true,false]) {
    const f=await preClaimTerminalFixture(reason),worker=createBackgroundMonitoringWorker(f.dependencies);
    if(!retry)f.advance(LIMITS.cadence_ms);
    const committed=deferred(),release=deferred(),append=f.repository.append;let intercepted=false;
    f.repository.append=async(...args)=>{
      const result=await append(...args);
      if(result&&!intercepted&&args[1].state.background_monitoring.reason===reason) {
        intercepted=true;committed.resolve();await release.promise;
      }
      return result;
    };
    const pending=worker.tick({runner_id:OTHER,retry});
    await committed.promise;
    try {
      const status=await worker.status({runner_id:OTHER});
      assert.equal(status.runner_acknowledged,false,`${reason}, retry=${retry}`);
      assert.equal(f.state().background_monitoring.run.last_runner_id,RUNNER);
    } finally {release.resolve();}
    await pending;
    assert.equal((await worker.status({runner_id:OTHER})).runner_acknowledged,true);
  }
});

test('read-only no-due terminal replies and active waits cannot stamp a new runner acknowledgement',async()=>{
  for(const mode of ['complete','partial','blocked','busy','waiting']) {
    const f=fixture(),worker=createBackgroundMonitoringWorker(f.dependencies);
    if(['complete','partial','blocked'].includes(mode)) {
      await f.complete();
      if(mode!=='complete')f.mutate(saved=>{saved.background_monitoring.state=mode;});
    } else {
      await f.tick();
      f.mutate(saved=>{const run=saved.background_monitoring.run;
        if(mode==='busy')run.lease={token:`${RUNNER}:9`,until:f.at()+1000};else run.next_action_at=f.at()+1000;});
    }
    const before=f.state(),revision=f.revision(),calls=f.calls.length;
    assert.equal((await worker.tick({runner_id:OTHER})).state,mode);
    assert.equal((await worker.status({runner_id:OTHER})).runner_acknowledged,false);
    assert.equal(f.revision(),revision);assert.equal(f.calls.length,calls);assert.deepEqual(f.state(),before);
  }
});

test('driver reconciles a lost committed history response and completes without replaying history or requesting a wallet',async()=>{
  const f=fixture(),worker=createBackgroundMonitoringWorker(f.dependencies),inputs=[],output=[];
  let lost=false;
  const api={getFiles:async()=>({canonical_modules:{'lib/private-config':'export const ownerTelegramId=42;','lib/runtime':
    'export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;\nexport const PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION=1;\nexport const PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION=1;\nexport function createPrivateBackgroundMonitoringAccess() {}'}}),
    runFunction:async(_sources,input)=>{
      inputs.push({...input});
      if(input.status_only)return {result:await worker.status(input)};
      const result=await worker.tick(input);
      if(!lost&&f.calls.includes('history.step')){lost=true;throw new MonitoringAdminError('network_error','tick');}
      return {result};
    }};
  const result=await runBackgroundMonitoring({api,enabled:true,retry:true,random:()=>RUNNER,
    now:f.at,monotonic:()=>f.at()-START,sleep:async ms=>f.advance(ms),emit:value=>output.push(value)});
  assert.equal(result.state,'complete');assert.equal(lost,true);
  assert.equal(inputs.filter(input=>input.status_only).length,1);
  assert.equal(inputs.filter(input=>input.retry).length,1);
  assert.equal(f.calls.filter(call=>call==='gifts.start').length,1);
  assert.equal(f.calls.filter(call=>call==='history.start').length,1);
  assert.equal(f.calls.filter(call=>call==='history.step').length,2);
  assert.equal(f.calls.filter(call=>call==='rules.evaluate').length,1);
  assert.equal(f.state().background_monitoring.state,'complete');
  assert.equal(output.filter(item=>item.state==='recovering').length,1);
  assert.equal(JSON.stringify(output).includes(RUNNER),false);
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
