// Versioned, saved history traversal policy. Only completed ordered streams
// produced by this policy establish coverage; imported records are not proof.
export const HISTORY_REFRESH_POLICY = Object.freeze({version: 1, overlap_seconds: 172800, full_scan_interval_seconds: 604800});

const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function reusable(coverage, windowSince, checkedThrough) {
  if (!object(coverage) || coverage.version !== HISTORY_REFRESH_POLICY.version || coverage.complete !== true || coverage.ordered !== true || coverage.scope_verified !== true) return false;
  if (![coverage.window_since, coverage.checked_through, coverage.full_scan_at].every(timestamp)) return false;
  if (!object(coverage.source) || coverage.source.provider !== 'marketapp' || !Number.isSafeInteger(coverage.source.job_id) || coverage.source.job_id < 1 || !Number.isSafeInteger(coverage.source.stream_index) || coverage.source.stream_index < 1) return false;
  return coverage.window_since <= windowSince && coverage.window_since <= coverage.checked_through
    && coverage.full_scan_at <= coverage.checked_through && coverage.checked_through <= checkedThrough
    && checkedThrough - coverage.full_scan_at < HISTORY_REFRESH_POLICY.full_scan_interval_seconds;
}

export function validHistoryPlan(plan, windowSince = null, checkedThrough = null) {
  if (!object(plan) || plan.version !== HISTORY_REFRESH_POLICY.version || !['full', 'incremental'].includes(plan.mode)) return false;
  if (![plan.window_since, plan.scan_since, plan.checked_through, plan.full_scan_at].every(timestamp)
    || plan.window_since > plan.scan_since || plan.scan_since > plan.checked_through || plan.full_scan_at > plan.checked_through
    || (windowSince !== null && plan.window_since !== windowSince) || (checkedThrough !== null && plan.checked_through !== checkedThrough)) return false;
  if (plan.mode === 'full') return plan.scan_since === plan.window_since && plan.full_scan_at === plan.checked_through && plan.baseline_provenance === null;
  const baseline = plan.baseline_provenance;
  return object(baseline) && reusable({...baseline, version: plan.version, complete: true, ordered: true, scope_verified: true}, plan.window_since, plan.checked_through)
    && plan.full_scan_at === baseline.full_scan_at && plan.scan_since > plan.window_since
    && plan.scan_since === Math.max(plan.window_since, baseline.checked_through - HISTORY_REFRESH_POLICY.overlap_seconds);
}

export function planHistoryRefresh(coverage, windowSince, checkedThrough) {
  const scanSince = reusable(coverage, windowSince, checkedThrough)
    ? Math.max(windowSince, coverage.checked_through - HISTORY_REFRESH_POLICY.overlap_seconds) : windowSince;
  // If overlap already reaches the requested boundary, this is a full scan.
  // Only successful completion will publish its new reconciliation clock.
  const incremental = scanSince > windowSince;
  return {
    version: HISTORY_REFRESH_POLICY.version, mode: incremental ? 'incremental' : 'full',
    window_since: windowSince,
    scan_since: scanSince,
    checked_through: checkedThrough,
    full_scan_at: incremental ? coverage.full_scan_at : checkedThrough,
    baseline_provenance: incremental ? {
      source: {...coverage.source}, window_since: coverage.window_since,
      checked_through: coverage.checked_through, full_scan_at: coverage.full_scan_at,
    } : null,
  };
}

export function completedHistoryCoverage(stream, jobId, streamIndex) {
  const plan = stream.history_plan;
  if (!stream.complete || stream.ordered !== true || stream.scope_verified !== true || !validHistoryPlan(plan)) return null;
  return {
    version: plan.version, complete: true, ordered: true, scope_verified: true, window_since: plan.window_since,
    checked_through: plan.checked_through, full_scan_at: plan.full_scan_at,
    source: {provider: 'marketapp', job_id: jobId, stream_index: streamIndex},
  };
}

export function historyRefreshProgress(streams) {
  const plans = streams.filter(stream => stream.kind === 'history').map(stream => stream.history_plan);
  if (!plans.some(plan => plan?.version === HISTORY_REFRESH_POLICY.version)) return null;
  return {
    incremental_streams: plans.filter(plan => plan?.mode === 'incremental').length,
    full_streams: plans.filter(plan => plan?.mode === 'full').length,
    overlap_seconds: HISTORY_REFRESH_POLICY.overlap_seconds,
    full_scan_interval_seconds: HISTORY_REFRESH_POLICY.full_scan_interval_seconds,
  };
}
