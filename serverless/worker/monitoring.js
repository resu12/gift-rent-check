// Portable orchestration only. The hosting bridge supplies owner authorization,
// provider budgets and a guard that checks this checkpoint before every write
// and provider request. This worker has no transaction or notification API.
export const BACKGROUND_MONITORING_LIMITS = Object.freeze({
  cadence_ms: 6 * 60 * 60 * 1000, run_ms: 20 * 60 * 1000,
  lease_ms: 120000, history_steps: 100, history_resumes: 3, manual_retry_ms: 60000,
  gift_resumes: 1, gift_resume_ms: 300000, gift_history_reserve_ms: 300000, gift_attempts: 20, gift_daily_attempts: 1000,
  dashboard_prepare_ms: 25000, dashboard_prepare_age_ms: 5 * 60 * 1000,
  analytics_refresh_ms: 60000, analytics_evaluation_reserve_ms: 60000,
});
const STATES = new Set(['running', 'complete', 'partial', 'paused', 'blocked', 'failed']);
const REASONS = new Set(['monitoring_paused', 'no_enabled_gifts', 'rules_changed', 'scope_changed',
  'gift_update_running', 'collection_running', 'gift_refresh_partial', 'history_partial',
  'history_limit', 'history_start_uncertain', 'history_changed', 'gift_refresh_changed',
  'request_failed', 'run_deadline', 'history_stopped']);
const STAGES = new Set(['gift_start', 'gift_poll', 'history_start', 'history_poll', 'analytics', 'evaluate', 'done']);
const INTENTS = new Set(['gift_start', 'gift_step', 'gift_resume', 'history_start', 'history_step', 'history_resume', 'analytics_refresh', 'evaluate']);
const ANALYTICS_STATES = new Set(['saved', 'fresh', 'busy', 'limited', 'unavailable']);
const ANALYTICS_REASONS = new Set(['wallet_missing', 'no_login', 'active_refresh', 'website_busy', 'cooldown', 'request_limit', 'refresh_failed', 'run_budget']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const iso = at => new Date(at).toISOString();
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const millis = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000000 - BACKGROUND_MONITORING_LIMITS.cadence_ms;
const count = value => Number.isSafeInteger(value) && value >= 0;
// Never persist or log provider HTML, cookies, error text or account details.
function analyticsResult(value) {
  if (!object(value) || !ANALYTICS_STATES.has(value.state)
    || value.period_days !== undefined && ![30, 365].includes(value.period_days)
    || value.reason !== undefined && !ANALYTICS_REASONS.has(value.reason)
    || ['captured_at', 'retry_at'].some(key => value[key] !== undefined && !millis(time(value[key])))
    || ['saved', 'fresh'].includes(value.state) && (![30, 365].includes(value.period_days) || !millis(time(value.captured_at))))
    throw new BackgroundMonitoringError('BACKGROUND_ANALYTICS_INVALID');
  return Object.fromEntries(['state', 'period_days', 'captured_at', 'reason', 'retry_at']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
// Hourly wake-ups do not imply hourly checks. Also protect saved ledgers from
// the old fixed-slot schedule, which could follow a late run less than 6h later.
const automaticDue = ledger => Math.max(time(ledger.next_check_at) ?? 0,
  ledger.run.started_at + BACKGROUND_MONITORING_LIMITS.cadence_ms);
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const validScope = value => object(value) && /^0:[a-f0-9]{64}$/.test(value.wallet ?? '')
  && count(value.wallet_revision) && count(value.credential_version)
  && canonical(value).length <= 4096;
const activeTargets = rules => {
  if (!object(rules) || typeof rules.paused !== 'boolean' || !Array.isArray(rules.policies)
    || rules.policies.length > 250 || rules.policies.some(policy => !object(policy)
      || typeof policy.enabled !== 'boolean' || typeof policy.paused !== 'boolean'
      || !/^0:[a-f0-9]{64}$/.test(policy.nft_address ?? ''))) throw new BackgroundMonitoringError('BACKGROUND_RULES_INVALID');
  return rules.paused ? [] : [...new Set(rules.policies.filter(policy => policy.enabled && !policy.paused)
    .map(policy => policy.nft_address))].sort();
};
function historyTimeframe(rules) {
  let days = 30;
  for (const policy of rules.policies.filter(item => item.enabled && !item.paused)) {
    const effective = {...rules.defaults, ...policy.overrides};
    for (const [enabled, value] of [[effective.decrease_enabled, effective.idle_days],
      [effective.increase_enabled, effective.increase_window_days]]) {
      if (enabled === true && Number.isSafeInteger(value) && value > 0) days = Math.max(days, Math.min(90, value));
    }
  }
  return days <= 30 ? '30d' : days <= 60 ? '60d' : '90d';
}
export class BackgroundMonitoringError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function validate(value) {
  if (value === undefined || value === null) return null;
  const run = value.run;
  if (!object(value) || value.version !== 1 || value.cadence_hours !== 6 || !STATES.has(value.state)
    || value.reason !== null && !REASONS.has(value.reason)
    || !['last_started_at', 'last_finished_at', 'last_success_at', 'next_check_at'].every(key => value[key] === null || millis(time(value[key])))
    || value.last_manual_retry_at !== undefined && value.last_manual_retry_at !== null && !millis(time(value.last_manual_retry_at))
    || value.last_manual_retry_runner !== undefined && value.last_manual_retry_runner !== null && !/^[a-f0-9]{64}$/.test(value.last_manual_retry_runner)
    || !object(run) || typeof run.id !== 'string' || !/^[a-f0-9]{64}:\d+$/.test(run.id)
    || typeof run.session_id !== 'string' || !/^background_[a-f0-9]{64}_\d+$/.test(run.session_id)
    || !validScope(run.scope) || !STAGES.has(run.stage) || !millis(run.started_at) || !millis(run.deadline)
    || run.deadline !== run.started_at + BACKGROUND_MONITORING_LIMITS.run_ms
    || !count(run.claim_generation) || !count(run.next_action_at) || !count(run.history_steps) || !count(run.history_resumes)
    || run.last_runner_id !== undefined && (typeof run.last_runner_id !== 'string' || !/^[a-f0-9]{64}$/.test(run.last_runner_id))
    || run.personal_analytics_period_days !== undefined && ![30, 365].includes(run.personal_analytics_period_days)
    || !count(run.gift_resumes ?? 0) || (run.gift_resumes ?? 0) > BACKGROUND_MONITORING_LIMITS.gift_resumes
    || run.history_after_at !== null && !millis(run.history_after_at)
    || run.history_steps > BACKGROUND_MONITORING_LIMITS.history_steps || run.history_resumes > BACKGROUND_MONITORING_LIMITS.history_resumes
    || !['gift_run_id', 'history_job_id', 'previous_history_job_id'].every(key => run[key] === null || Number.isSafeInteger(run[key]) && run[key] > 0)
    || run.intent !== null && !INTENTS.has(run.intent)
    || !Array.isArray(run.targets) || run.targets.length > 250 || run.targets.some(nft => !/^0:[a-f0-9]{64}$/.test(nft))
    || !['gift_start_address', 'next_gift_start_address'].every(key => run[key] === undefined || run[key] === null || /^0:[a-f0-9]{64}$/.test(run[key]))
    || typeof run.gift_complete !== 'boolean' || typeof run.history_complete !== 'boolean'
    || !['checked', 'total', 'proposals'].every(key => run[key] === null || count(run[key]))
    || run.lease !== null && (!object(run.lease) || !/^[a-f0-9]{64}:\d+$/.test(run.lease.token ?? '') || !millis(run.lease.until))) {
    throw new BackgroundMonitoringError('BACKGROUND_STATE_INVALID');
  }
  if (run.personal_analytics !== undefined && run.personal_analytics !== null) analyticsResult(run.personal_analytics);
  return value;
}

/** Public metadata excludes identities, lease tokens and job cursors. */
export function projectBackgroundMonitoring(value, now = Date.now()) {
  const ledger = validate(value);
  if (!ledger) return null;
  const result = Object.fromEntries(['version', 'cadence_hours', 'state', 'last_started_at', 'last_finished_at',
    'last_success_at', 'next_check_at', 'reason'].map(key => [key, ledger[key]]));
  result.next_check_at = iso(automaticDue(ledger));
  if (ledger.run.personal_analytics) result.personal_analytics = analyticsResult(ledger.run.personal_analytics);
  if (ledger.state === 'running') {
    result.run_deadline_at = iso(ledger.run.deadline);
    // Allow a minute for the next driver request after the current lease or
    // provider wait. Expose a display deadline, never the lease identity.
    result.activity_expires_at = iso(Math.min(ledger.run.deadline,
      Math.max(ledger.run.started_at, ledger.run.next_action_at, ledger.run.lease?.until ?? 0) + 60000));
  }
  if (ledger.state === 'running' && ledger.run.deadline <= now) {result.state = 'partial'; result.reason = 'run_deadline';}
  return result;
}

/**
 * All callbacks are bound to the private owner by the hosting bridge.
 * status/start/step callbacks use existing gift/job projections. Every mutation
 * callback must enforce context.scope and context.lease at its own CAS boundary.
 * tick performs at most one provider step. It never resumes an unidentified job.
 */
export function createBackgroundMonitoringWorker({repository, clock, captureScope, assertScope,
  rules, gifts, history, analytics, dashboard}) {
  for (const fn of [repository?.read, repository?.append, clock, captureScope, assertScope,
    rules?.status, rules?.evaluate, gifts?.status, gifts?.start, gifts?.step,
    history?.status, history?.start, history?.step, history?.resume]) {
    if (typeof fn !== 'function') throw new BackgroundMonitoringError('BACKGROUND_CONFIGURATION');
  }
  const now = async () => {const at = await clock(); if (!millis(at)) throw new BackgroundMonitoringError('BACKGROUND_CLOCK_INVALID'); return at;};
  const hasAnalytics = analytics?.version === 1 && typeof analytics.refresh === 'function';
  const afterHistory = () => hasAnalytics ? 'analytics' : 'evaluate';
  const context = run => ({run_id: run.id, session_id: run.session_id, scope: clone(run.scope),
    lease: clone(run.lease), gift_run_id: run.gift_run_id, history_job_id: run.history_job_id,
    gift_start_address: run.gift_start_address ?? null, deadline: run.deadline});
  const reply = (ledger, at, state = null, retryAt = null) => ({
    state: state ?? ledger?.state ?? 'disabled', server_time: iso(at),
    ...(retryAt !== null ? {retry_at: iso(Math.max(at, retryAt))} : {}),
    ...Object.fromEntries(['checked', 'total', 'proposals'].filter(key => count(ledger?.run?.[key])).map(key => [key, ledger.run[key]])),
    ...(ledger?.run?.personal_analytics ? {personal_analytics: analyticsResult(ledger.run.personal_analytics)} : {}),
    background_monitoring: projectBackgroundMonitoring(ledger, at),
  });
  async function status({runner_id} = {}) {
    if (runner_id !== undefined && (typeof runner_id !== 'string' || !/^[a-f0-9]{64}$/.test(runner_id)))
      throw new BackgroundMonitoringError('BACKGROUND_RUNNER_INVALID');
    const saved = await repository.read(), at = await now(), ledger = validate(saved.state.background_monitoring);
    const result = reply(ledger, at, ledger?.state === 'running' && ledger.run.deadline <= at ? 'partial' : null, ledger?.state === 'running'
      ? Math.max(ledger.run.next_action_at, ledger.run.lease?.until ?? 0, at) : ledger ? automaticDue(ledger) : null);
    // A lost initial response may precede the claim. Never let a recovery read
    // mistake the preceding cycle's completion for this runner's outcome.
    if (runner_id !== undefined) result.runner_acknowledged = Boolean(ledger &&
      (ledger.run.last_runner_id === runner_id || ledger.run.id.startsWith(runner_id + ':')));
    return result;
  }
  // A separate invocation prepares derived display data only AFTER a successful
  // run has been saved. It cannot claim/extend a run or repeat provider work.
  // The hosting callback must bound its reads and fence any cache write to this
  // exact completed run and scope. An old runtime simply lacks this capability.
  async function prewarm({runner_id} = {}) {
    if (typeof runner_id !== 'string' || !/^[a-f0-9]{64}$/.test(runner_id))
      throw new BackgroundMonitoringError('BACKGROUND_RUNNER_INVALID');
    if (dashboard?.version !== 1 || typeof dashboard.prewarm !== 'function') return {state: 'skipped'};
    const saved = await repository.read(), at = await now(), ledger = validate(saved.state.background_monitoring);
    const eligible = row => row?.state === 'complete' && row.run.stage === 'done'
      && row.run.gift_complete && row.run.history_complete && row.run.lease === null
      && (row.run.last_runner_id === runner_id || row.run.id.startsWith(runner_id + ':'))
      && row.last_success_at === row.last_finished_at && time(row.last_finished_at) <= at
      && time(row.last_finished_at) > at - BACKGROUND_MONITORING_LIMITS.dashboard_prepare_age_ms;
    if (!eligible(ledger)) return {state: 'skipped'};
    const input = {...context(ledger.run), prewarm_only: true, deadline: at + BACKGROUND_MONITORING_LIMITS.dashboard_prepare_ms};
    await assertScope(ledger.run.scope, input);
    const result = await dashboard.prewarm(input);
    const current = validate((await repository.read()).state.background_monitoring);
    await assertScope(ledger.run.scope, input);
    if (!eligible(current) || current.run.id !== ledger.run.id || await now() > input.deadline) return {state: 'skipped'};
    return {state: result?.prepared === true ? 'prepared' : 'skipped'};
  }
  async function append(saved, ledger, at, {allowScopeChange = false} = {}) {
    if (!allowScopeChange) await assertScope(ledger.run.scope, context(ledger.run));
    // A changed-scope failure is metadata only. Fence it to the current wallet
    // revision instead of retrying an obsolete scope that can never commit.
    const fence = allowScopeChange ? (await captureScope())?.wallet_revision : ledger.run.scope.wallet_revision;
    if (!count(fence)) throw new BackgroundMonitoringError('BACKGROUND_SCOPE_INVALID');
    const state = {...saved.state, background_monitoring: ledger};
    return repository.append(saved.revision, {key: `background:${saved.revision + 1}:${ledger.run.id}:${ledger.run.claim_generation}`,
      state, job: null, records: [], raw_body: null, observed_at: iso(at)}, fence);
  }
  async function update(claim, change, {checkScope = true} = {}) {
    for (let n = 0; n < 12; n++) {
      const saved = await repository.read(), at = await now(), ledger = clone(validate(saved.state.background_monitoring));
      if (!ledger || ledger.state !== 'running' || ledger.run.id !== claim.id
        || ledger.run.lease?.token !== claim.lease?.token || ledger.run.lease.until <= at) {
        throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
      }
      if (checkScope) await assertScope(ledger.run.scope, context(ledger.run));
      await change(ledger, at, saved.state);
      if (await append(saved, ledger, at, {allowScopeChange: !checkScope})) return ledger;
    }
    throw new BackgroundMonitoringError('BACKGROUND_CONFLICT');
  }
  const finished = (ledger, at, state, reason) => {
    ledger.state = state; ledger.reason = reason; ledger.last_finished_at = iso(at);
    if (state === 'complete') ledger.last_success_at = iso(at);
    ledger.run.stage = 'done'; ledger.run.intent = null; ledger.run.lease = null;
    ledger.run.next_action_at = 0;
    ledger.next_check_at = iso(automaticDue(ledger));
  };
  const finish = (claim, state, reason, options) => update(claim, (ledger, at) => finished(ledger, at, state, reason), options);
  const release = (claim, change = () => {}) => update(claim, (ledger, at) => {
    change(ledger, at); ledger.run.intent = null; ledger.run.lease = null;
  });
  async function gate(claim) {
    await assertScope(claim.scope, context(claim));
    const current = await rules.status(context(claim)), targets = activeTargets(current);
    if (current.wallet !== claim.scope.wallet) throw new BackgroundMonitoringError('BACKGROUND_SCOPE_CHANGED');
    if (!targets.length) return {stop: current.paused ? 'monitoring_paused' : 'no_enabled_gifts'};
    if (claim.targets.length && canonical(targets) !== canonical(claim.targets)) return {stop: 'rules_changed'};
    return {targets, history_timeframe: historyTimeframe(current)};
  }
  async function intent(claim, kind) {
    const ledger = await update(claim, row => {
      row.run.intent = kind;
      if (kind === 'history_step') row.run.history_steps++;
      if (kind === 'history_resume') row.run.history_resumes++;
      if (kind === 'gift_resume') row.run.gift_resumes = (row.run.gift_resumes ?? 0) + 1;
    });
    const checked = await gate(ledger.run);
    if (checked.stop) return {stopped: await finish(ledger.run, 'paused', checked.stop)};
    return {run: ledger.run};
  }
  function busyCollection(state, run, at) {
    const job = state.job;
    if (!job) return false;
    const knownOld = job.id === run.previous_history_job_id;
    if (job.reason === 'stopped_by_you' || job.stop_requested === true) return true;
    const lease = job.lease_until ?? 0;
    if (!count(lease) || lease > at) return true;
    // An allowance-ended listing scan is inactive. A separate history job can
    // use the current slot; the listing's saved checkpoint remains resumable.
    // A terminated hosting request may leave the raw state running or queued;
    // require its saved invocation and request lease to have both expired.
    const active = ['running', 'queued'].includes(job.state);
    const expiredInvocation = active && millis(job.invocation_deadline) && job.invocation_deadline <= at;
    const automaticBudgetPause = job.startup_comparisons?.version === 2 && !job.startup_comparisons.manual_control
      && ['comparison_cycle_limit', 'monitoring_reserve'].includes(job.reason);
    const inactiveListing = job.kind === 'prices' && (expiredInvocation || job.state === 'partial'
      && (['invocation_limit', 'duration_limit'].includes(job.reason) || automaticBudgetPause));
    if (active) return !expiredInvocation || !knownOld && !inactiveListing;
    return job.state === 'partial' && !knownOld && !inactiveListing;
  }
  function waitAt(value, at) {
    return count(value) ? Math.max(value, at) : at;
  }
  function giftResult(result, run) {
    if (!object(result?.run) || !Number.isSafeInteger(result.run.id) || result.run.id <= 0
      || result.run.wallet !== run.scope.wallet || result.run.session_id !== run.session_id
      || !['running', 'complete', 'partial', 'failed'].includes(result.run.state)
      || !count(result.run.checked) || !count(result.run.total) || result.run.checked > result.run.total
      || run.gift_run_id !== null && result.run.id !== run.gift_run_id) throw new BackgroundMonitoringError('BACKGROUND_GIFT_INVALID');
    return result.run;
  }
  function nextGiftAddress(state, run) {
    const gift = state.gift_refresh?.run, ton = state.owned_prices?.run;
    // Website rows can already report every gift checked while TON verification
    // has only visited a prefix. Continue from the owned engine's frozen cursor,
    // never from the wrapper's aggregate count or a different session's run.
    if (object(ton) && gift?.id === run.gift_run_id && gift.session_id === run.session_id && gift.wallet === run.scope.wallet
      && gift.ton_run_id === ton?.id && gift.ton_session_id === ton.session_id && ton.wallet === run.scope.wallet
      && Array.isArray(ton.targets) && count(ton.offset) && ton.offset <= ton.targets.length) {
      if (ton.state === 'complete' || ton.offset === ton.targets.length) return null;
      const address = ton.targets[ton.offset]?.nft_address;
      if (/^0:[a-f0-9]{64}$/.test(address ?? '') && Array.isArray(gift.ton_targets) && gift.ton_targets.includes(address)) return address;
    }
    return run.next_gift_start_address ?? run.gift_start_address ?? null;
  }
  function resumableGift(state, run, gift, at) {
    const current = state.gift_refresh?.run, inner = state.owned_prices?.run;
    const limits = BACKGROUND_MONITORING_LIMITS, profile = 'background-monitoring-v1';
    // Resume this cycle's exact persisted TON traversal once. Website counts
    // cannot prove TON completion, and already saved prefix evidence is never
    // relabelled as fresh evidence from a different six-hour cycle.
    if (typeof gifts.resume !== 'function' || (run.gift_resumes ?? 0) >= limits.gift_resumes
      || gift.state !== 'partial' || !['duration_limit', 'provider_wait'].includes(gift.reason)
      || current?.id !== run.gift_run_id || current.session_id !== run.session_id || current.wallet !== run.scope.wallet
      || current.execution_profile !== profile || current.stage !== 'ton' || current.stop_requested === true
      || !['running', 'partial'].includes(current.state) || current.reason === 'stopped_by_you'
      || current.state === 'running' && (!millis(current.deadline) || current.deadline > at)
      || current.state === 'partial' && !['duration_limit', 'provider_wait'].includes(current.reason)
      || !count(current.inflight?.until ?? 0) || (current.inflight?.until ?? 0) > at
      || !object(inner) || inner.id !== current.ton_run_id || inner.session_id !== current.ton_session_id
      || inner.wallet !== run.scope.wallet || inner.execution_profile !== profile
      || !['running', 'partial'].includes(inner.state) || inner.stop_requested === true
      || inner.state === 'partial' && !['duration_limit', 'provider_wait'].includes(inner.reason)
      || !count(inner.lease_until ?? 0) || (inner.lease_until ?? 0) > at
      || !Array.isArray(inner.targets) || !count(inner.offset) || inner.offset >= inner.targets.length
      || !Array.isArray(current.ton_targets) || inner.targets.length !== current.ton_targets.length
      || inner.targets.some((target, index) => target.nft_address !== current.ton_targets[index])
      || !count(current.attempts) || !count(inner.attempts) || current.attempts + inner.attempts >= limits.gift_attempts
      || !Array.isArray(state.owned_prices.attempts)
      || state.owned_prices.attempts.some(value => !Number.isSafeInteger(value) || value <= 0 || value > at)
      || state.owned_prices.attempts.filter(value => value > at - 86400000).length >= limits.gift_daily_attempts
      || at + limits.gift_resume_ms + limits.gift_history_reserve_ms > run.deadline) return false;
    const next = Math.max(state.owned_prices?.next_allowed_at ?? 0, current.next_allowed_at ?? 0);
    return count(next) && next < at + limits.gift_resume_ms;
  }
  async function saveGift(claim, result) {
    const gift = giftResult(result, claim);
    const state = (await repository.read()).state, current = state.gift_refresh?.run;
    if (current?.id !== gift.id || current.session_id !== claim.session_id) return finish(claim, 'blocked', 'gift_refresh_changed');
    return release(claim, (ledger, at) => {
      const run = ledger.run; run.gift_run_id = gift.id; run.checked = gift.checked; run.total = gift.total;
      run.next_gift_start_address = nextGiftAddress(state, run);
      run.next_action_at = waitAt(result.next_allowed_at, at);
      if (gift.state === 'running' && run.next_action_at < run.deadline || resumableGift(state, run, gift, at)) run.stage = 'gift_poll';
      else {
        run.gift_complete = gift.state === 'complete'; run.stage = 'history_start';
        // Coverage certificates store seconds. Freeze the next history window
        // after the last gift observation, including its fractional second.
        run.next_action_at = Math.floor(at / 1000) * 1000 + 1000;
        run.history_after_at = run.next_action_at;
        if (!run.gift_complete) ledger.reason = 'gift_refresh_partial';
      }
    });
  }
  function jobResult(result, run) {
    const job = result?.job;
    if (!object(job) || !Number.isSafeInteger(job.id) || job.id <= 0 || job.kind !== 'rental_prices'
      || !['running', 'queued', 'complete', 'partial', 'failed'].includes(job.state)
      || run.history_job_id !== null && job.id !== run.history_job_id) throw new BackgroundMonitoringError('BACKGROUND_HISTORY_INVALID');
    return job;
  }
  async function saveHistory(claim, result) {
    const job = jobResult(result, claim);
    const selected = (await repository.read()).state.job;
    if (selected?.id !== job.id) return finish(claim, 'blocked', 'history_changed');
    if(selected.reason==='background_scope_changed')return finish(claim,'blocked','scope_changed');
    return release(claim, (ledger, at) => {
      const run = ledger.run; run.history_job_id = job.id;
      run.next_action_at = waitAt(job.progress?.next_allowed_at, at);
      run.stage = 'history_poll';
      if (job.state === 'complete') {
        // A resumed prior cycle finishes its original frozen watermark first.
        // Follow it with a fresh incremental head before certifying this cycle.
        const started = time(job.created_at);
        if (started !== null && Math.floor(started / 1000) * 1000 >= run.history_after_at) {
          run.history_complete = true; run.stage = afterHistory(); run.next_action_at = at;
        } else {
          run.previous_history_job_id = job.id; run.history_job_id = null;
          run.stage = 'history_start'; run.next_action_at = at;
        }
      }
      else if (job.state === 'failed' || job.stop_requested || run.next_action_at >= run.deadline) {
        ledger.reason = job.stop_requested ? 'history_stopped' : 'history_partial'; run.stage = afterHistory(); run.next_action_at = at;
      }
    });
  }
  async function tick({runner_id, retry = false} = {}) {
    if (typeof runner_id !== 'string' || !/^[a-f0-9]{64}$/.test(runner_id)) throw new BackgroundMonitoringError('BACKGROUND_RUNNER_INVALID');
    if (typeof retry !== 'boolean') throw new BackgroundMonitoringError('BACKGROUND_RUNNER_INVALID');
    let claim;
    for (let n = 0; n < 12; n++) {
      const saved = await repository.read(), at = await now(), old = validate(saved.state.background_monitoring);
      let ledger;
      if (old?.state === 'running') {
        if (old.run.lease?.until > at) return reply(old, at, 'busy', old.run.lease.until);
        if (old.run.next_action_at > at && old.run.deadline > at) return reply(old, at, 'waiting', Math.min(old.run.next_action_at, old.run.deadline));
        ledger = clone(old);
        // A terminal checkpoint returned before claiming must acknowledge its
        // writer too. Intermediate cleanup before a retry/due cycle must not.
        if (automaticDue(ledger) > at && !retry) ledger.run.last_runner_id = runner_id;
        if (canonical(await captureScope()) !== canonical(ledger.run.scope)) {
          finished(ledger, at, 'blocked', 'scope_changed');
          if (await append(saved, ledger, at, {allowScopeChange: true}) && automaticDue(ledger) > at && !retry) return reply(ledger, at);
          continue;
        }
        if (ledger.run.intent === 'history_start' && ledger.run.history_job_id === null) {
          finished(ledger, at, 'blocked', 'history_start_uncertain');
          if (await append(saved, ledger, at) && automaticDue(ledger) > at && !retry) return reply(ledger, at);
          continue;
        }
        if (ledger.run.deadline <= at) {
          finished(ledger, at, 'partial', 'run_deadline');
          if (await append(saved, ledger, at) && automaticDue(ledger) > at && !retry) return reply(ledger, at);
          continue;
        }
      } else {
        const manualRetry = Boolean(retry && old && old.state !== 'complete');
        const due = old ? automaticDue(old) : null;
        if (manualRetry && old.last_manual_retry_runner === runner_id) return reply(old, at, null, due);
        if (old && due > at && (!manualRetry
          || (time(old.last_manual_retry_at) ?? 0) + BACKGROUND_MONITORING_LIMITS.manual_retry_ms > at)) {
          return reply(old, at, null, manualRetry
            ? Math.min(due, time(old.last_manual_retry_at) + BACKGROUND_MONITORING_LIMITS.manual_retry_ms)
            : due);
        }
        const scope = await captureScope();
        if (!validScope(scope)) throw new BackgroundMonitoringError('BACKGROUND_SCOPE_INVALID');
        const sameScope = old && canonical(old.run.scope) === canonical(scope);
        ledger = {version: 1, cadence_hours: 6, state: 'running', reason: null, last_started_at: iso(at),
          last_finished_at: sameScope ? old.last_finished_at : null, last_success_at: sameScope ? old.last_success_at : null,
          last_manual_retry_at: manualRetry ? iso(at) : sameScope ? old.last_manual_retry_at ?? null : null,
          last_manual_retry_runner: manualRetry ? runner_id : sameScope ? old.last_manual_retry_runner ?? null : null,
          next_check_at: iso(at + BACKGROUND_MONITORING_LIMITS.cadence_ms), run: {
            id: `${runner_id}:${at}`, session_id: `background_${runner_id}_${at}`, scope: clone(scope),
            stage: 'gift_start', started_at: at, deadline: at + BACKGROUND_MONITORING_LIMITS.run_ms,
            claim_generation: 0, lease: null, intent: null, targets: [], next_action_at: at,
            gift_run_id: null, history_job_id: null,
            gift_start_address: sameScope ? nextGiftAddress(saved.state, old.run) : null,
            next_gift_start_address: sameScope ? nextGiftAddress(saved.state, old.run) : null,
            previous_history_job_id: sameScope ? old.run.history_job_id ?? old.run.previous_history_job_id : null,
            history_steps: 0, history_resumes: 0, gift_resumes: 0, gift_complete: false, history_complete: false,
            history_after_at: null,
            checked: null, total: null, proposals: null,
          }};
      }
      if (ledger.run.claim_generation >= Number.MAX_SAFE_INTEGER) throw new BackgroundMonitoringError('BACKGROUND_STATE_INVALID');
      ledger.run.claim_generation++;
      ledger.run.last_runner_id = runner_id;
      ledger.run.lease = {token: `${runner_id}:${ledger.run.claim_generation}`, until: at + BACKGROUND_MONITORING_LIMITS.lease_ms};
      if (await append(saved, ledger, at)) {claim = ledger.run; break;}
    }
    if (!claim) throw new BackgroundMonitoringError('BACKGROUND_CONFLICT');
    try {
      const enabled = await gate(claim);
      if (enabled.stop) return reply(await finish(claim, 'paused', enabled.stop), await now());
      if (!claim.targets.length) claim = (await update(claim, ledger => {ledger.run.targets = enabled.targets;})).run;
      let result;
      if (claim.stage === 'gift_start') {
        const saved = await repository.read(), at = await now(), active = saved.state.gift_refresh?.run;
        // A user's saved partial comparison must not prevent fresh gift
        // observations. Preserve that traversal and skip history later instead.
        if (saved.state.job && (saved.state.job.lease_until > at || ['running', 'queued'].includes(saved.state.job.state)
          && (!millis(saved.state.job.invocation_deadline) || saved.state.job.invocation_deadline > at))) {
          return reply(await finish(claim, 'blocked', 'collection_running'), at);
        }
        if (active?.session_id === claim.session_id) {
          result = await gifts.status({session_id: claim.session_id}, context(claim));
        } else if (active?.state === 'running' || (active?.inflight?.until ?? 0) > at) {
          if (!millis(active.deadline) || active.deadline > at || (active.inflight?.until ?? 0) > at) {
            const row = await release(claim, ledger => {ledger.reason = 'gift_update_running'; ledger.run.next_action_at = at + 15000;});
            return reply(row, at, 'waiting', row.run.next_action_at);
          }
        }
        if (!result) {
          const prepared = await intent(claim, 'gift_start');
          if (prepared.stopped) return reply(prepared.stopped, await now());
          claim = prepared.run; result = await gifts.start({session_id: claim.session_id, automatic: false}, context(claim));
        }
        const row = await saveGift(claim, result); return reply(row, await now(), null, row.run.next_action_at || null);
      }
      if (claim.stage === 'gift_poll') {
        const active = (await repository.read()).state.gift_refresh?.run;
        if (active?.id !== claim.gift_run_id || active.session_id !== claim.session_id) {
          return reply(await finish(claim, 'blocked', 'gift_refresh_changed'), await now());
        }
        result = await gifts.status({session_id: claim.session_id}, context(claim));
        const gift = giftResult(result, claim), at = await now();
        if (gift.state === 'partial' && resumableGift((await repository.read()).state, claim, gift, at)) {
          const prepared = await intent(claim, 'gift_resume');
          if (prepared.stopped) return reply(prepared.stopped, await now());
          claim = prepared.run;
          const row = await saveGift(claim, await gifts.resume({run_id: claim.gift_run_id, session_id: claim.session_id}, context(claim)));
          return reply(row, await now(), null, row.run.next_action_at || null);
        }
        if (gift.state !== 'running' || waitAt(result.next_allowed_at, at) > at) {
          const row = await saveGift(claim, result); return reply(row, at, row.run.next_action_at > at ? 'waiting' : null, row.run.next_action_at || null);
        }
        const prepared = await intent(claim, 'gift_step');
        if (prepared.stopped) return reply(prepared.stopped, await now());
        claim = prepared.run;
        const row = await saveGift(claim, await gifts.step({run_id: claim.gift_run_id, session_id: claim.session_id}, context(claim)));
        return reply(row, await now(), null, row.run.next_action_at || null);
      }
      if (claim.stage === 'history_start') {
        const saved = await repository.read(), at = await now();
        if (claim.history_steps >= BACKGROUND_MONITORING_LIMITS.history_steps) {
          const row = await release(claim, ledger => {ledger.reason = 'history_limit'; ledger.run.stage = afterHistory(); ledger.run.next_action_at = at;});
          return reply(row, at, null, at);
        }
        if (busyCollection(saved.state, claim, at)) {
          const row = await release(claim, ledger => {ledger.reason = 'collection_running'; ledger.run.stage = afterHistory(); ledger.run.next_action_at = at;});
          return reply(row, at, null, at);
        }
        const prior = saved.state.job;
        if (prior?.id === claim.previous_history_job_id && prior.kind === 'rental_prices'
          && ['running', 'queued', 'partial'].includes(prior.state)
          && prior.collection_window?.timeframe === enabled.history_timeframe
          && prior.background_history?.version===1
          && canonical(prior.background_history.targets)===canonical([...claim.targets].sort())) {
          // This ID comes only from this same scope's acknowledged worker run.
          // Persist ownership before Resume; never infer ownership from a job's
          // matching parameters, latest position or creation timestamp.
          const row = await release(claim, ledger => {
            ledger.run.history_job_id = prior.id; ledger.run.stage = 'history_poll'; ledger.run.next_action_at = at;
          });
          return reply(row, at, null, at);
        }
        const prepared = await intent(claim, 'history_start');
        if (prepared.stopped) return reply(prepared.stopped, await now());
        claim = prepared.run;
        result = await history.start({kind: 'rental_prices', timeframe: enabled.history_timeframe, force_refresh: true}, context(claim));
        const row = await saveHistory(claim, result); return reply(row, await now(), null, row.run.next_action_at || null);
      }
      if (claim.stage === 'history_poll') {
        const saved = await repository.read();
        if (saved.state.job?.id !== claim.history_job_id) return reply(await finish(claim, 'blocked', 'history_changed'), await now());
        const status = await history.status(context(claim));
        result = {job: status?.jobs?.find(job => job.id === claim.history_job_id)};
        const job = jobResult(result, claim), at = await now();
        if (job.state === 'complete' || job.state === 'failed' || job.stop_requested || waitAt(job.progress?.next_allowed_at, at) > at) {
          const row = await saveHistory(claim, result); return reply(row, at, row.run.next_action_at > at ? 'waiting' : null, row.run.next_action_at || null);
        }
        if (claim.history_steps >= BACKGROUND_MONITORING_LIMITS.history_steps) {
          const row = await release(claim, ledger => {ledger.reason = 'history_limit'; ledger.run.stage = afterHistory(); ledger.run.next_action_at = at;});
          return reply(row, at, null, at);
        }
        // getJobs' requires_resume is a UI hint whenever no request owns a
        // lease; even a newly created running job sets it. Only an expired
        // durable invocation or a saved partial traversal needs Resume.
        const expiredInvocation = ['running', 'queued'].includes(saved.state.job.state)
          && millis(saved.state.job.invocation_deadline) && saved.state.job.invocation_deadline <= at;
        const resume = job.state === 'partial' || expiredInvocation;
        if (resume && (claim.history_resumes >= BACKGROUND_MONITORING_LIMITS.history_resumes
          || !['duration_limit', 'invocation_limit', 'daily_limit', 'provider_wait'].includes(saved.state.job.reason)
            && !expiredInvocation)) {
          const row = await release(claim, ledger => {ledger.reason = 'history_partial'; ledger.run.stage = afterHistory(); ledger.run.next_action_at = at;});
          return reply(row, at, null, at);
        }
        const prepared = await intent(claim, resume ? 'history_resume' : 'history_step');
        if (prepared.stopped) return reply(prepared.stopped, await now());
        claim = prepared.run;
        result = await history[resume ? 'resume' : 'step']({job_id: claim.history_job_id}, context(claim));
        const row = await saveHistory(claim, result); return reply(row, await now(), null, row.run.next_action_at || null);
      }
      // A pre-upgrade checkpoint can already be at evaluation. Move it through
      // the new stage once; a saved outcome prevents re-running this work.
      if (claim.stage === 'evaluate' && hasAnalytics && !claim.personal_analytics) {
        const row = await release(claim, (ledger, at) => {ledger.run.stage = 'analytics'; ledger.run.next_action_at = at;});
        return reply(row, await now());
      }
      if (claim.stage === 'analytics') {
        const at = await now();
        let outcome;
        if (!hasAnalytics) throw new BackgroundMonitoringError('BACKGROUND_CONFIGURATION');
        if (at + BACKGROUND_MONITORING_LIMITS.analytics_refresh_ms + BACKGROUND_MONITORING_LIMITS.analytics_evaluation_reserve_ms > claim.deadline) {
          outcome = {state: 'unavailable', reason: 'run_budget'};
        } else {
          const prepared = await intent(claim, 'analytics_refresh');
          if (prepared.stopped) return reply(prepared.stopped, await now());
          claim = prepared.run;
          try {outcome = analyticsResult(await analytics.refresh(context(claim)));}
          catch (error) {
            // Independent analytics availability must not fail an otherwise
            // complete gift/rule check. Authorization and cancellation fences
            // always escape this optional-stage handler.
            if (error?.code === 'BACKGROUND_LEASE_LOST' || error?.code === 'BACKGROUND_PAUSED'
              || error?.code === 'BACKGROUND_RULES_CHANGED'
              || /(?:SCOPE|WALLET|CREDENTIAL|ACCOUNT)_CHANGED|BACKGROUND_SCOPE/.test(error?.code ?? '')) throw error;
            outcome = {state: 'unavailable', reason: 'refresh_failed'};
          }
          const checked = await gate(claim);
          if (checked.stop) return reply(await finish(claim, 'paused', checked.stop), await now());
        }
        const row = await release(claim, (ledger, at) => {
          ledger.run.personal_analytics = outcome; ledger.run.stage = 'evaluate'; ledger.run.next_action_at = at;
        });
        return reply(row, await now());
      }
      if (claim.stage === 'evaluate') {
        const prepared = await intent(claim, 'evaluate');
        if (prepared.stopped) return reply(prepared.stopped, await now());
        claim = prepared.run; result = await rules.evaluate(context(claim));
        if (!object(result) || !Array.isArray(result.proposals) || result.wallet !== claim.scope.wallet) throw new BackgroundMonitoringError('BACKGROUND_RULES_INVALID');
        const row = await update(claim, (ledger, at) => {
          ledger.run.proposals = result.proposals.length;
          const complete = ledger.run.gift_complete && ledger.run.history_complete;
          finished(ledger, at, complete ? 'complete' : 'partial', complete ? null : ledger.reason ?? 'history_partial');
        });
        return {...reply(row, await now()), runner_acknowledged: true};
      }
      throw new BackgroundMonitoringError('BACKGROUND_STATE_INVALID');
    } catch (error) {
      if (error?.code === 'BACKGROUND_LEASE_LOST') return status();
      const scopeChanged = /(?:SCOPE|WALLET|CREDENTIAL|ACCOUNT)_CHANGED|BACKGROUND_SCOPE/.test(error?.code ?? '');
      const paused = error?.code === 'BACKGROUND_PAUSED';
      const rulesChanged = error?.code === 'BACKGROUND_RULES_CHANGED';
      const uncertainStart = claim.intent === 'history_start' && claim.history_job_id === null;
      try {
        const row = await finish(claim, paused || rulesChanged ? 'paused' : scopeChanged || uncertainStart ? 'blocked' : 'failed',
          paused ? 'monitoring_paused' : rulesChanged ? 'rules_changed' : scopeChanged ? 'scope_changed'
            : uncertainStart ? 'history_start_uncertain' : 'request_failed', {checkScope: !scopeChanged});
        return reply(row, await now());
      } catch (failure) {
        if (failure?.code === 'BACKGROUND_LEASE_LOST') return status();
        throw failure;
      }
    }
  }
  return {tick, status, prewarm};
}
