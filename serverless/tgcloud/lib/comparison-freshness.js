import {addressKey, instant, validateSavedCloudWindow} from './cloud-pricing-core.js';
import {validHistoryPlan} from './history-refresh.js';
import {marketCacheKey} from './market-cache.js';

// Small, dated completion proofs. These are not page caches: their clocks never
// advance when a job is started, resumed or fulfilled from cached records.
const VERSION = 1, HOUR = 3600000, MAX_SCOPES = 500, MAX_WINDOWS = 6;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(value)) return null;
  const parsed = instant(value);
  return parsed !== null && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : null;
};

function currentDayCustomWindow(window, to, now) {
  // Only an exact current UTC date has an advancing end. A future date clipped
  // by the pricing resolver, malformed period or yesterday's fixed end must
  // not acquire this exception. Preserve the selected projection's endpoint.
  if (window.timeframe !== 'custom' || window.date_to !== new Date(now).toISOString().slice(0, 10)
    || to === null || to > now) return false;
  try {validateSavedCloudWindow(window);} catch {return false;}
  return new Date(to).toISOString().slice(0, 10) === window.date_to;
}

function validEvidence(value, history, now) {
  if (!object(value)) return false;
  const first = time(value.first_observed_at), last = time(value.last_observed_at);
  if (first === null || last === null || first <= 0 || first > last || last > now) return false;
  return !history || Number.isSafeInteger(value.window_since) && Number.isSafeInteger(value.checked_through)
    && value.window_since > 0 && value.window_since <= value.checked_through
    && value.checked_through * 1000 <= last;
}

export function completedComparisonEvidence(stream, now, job = null) {
  if (!object(stream) || !['listing', 'history'].includes(stream.kind) || !addressKey(stream.scope)
    || stream.complete !== true || stream.started !== true || !Number.isSafeInteger(stream.pages) || stream.pages < 1 || stream.cache_source) return null;
  const evidence = {first_observed_at: stream.first_observed_at, last_observed_at: stream.last_observed_at};
  if (stream.kind === 'listing') {
    if (stream.cursor !== null) return null;
  } else {
    if (stream.ordered !== true || stream.scope_verified !== true) return null;
    if (Object.hasOwn(stream, 'history_plan')) {
      if (!validHistoryPlan(stream.history_plan)) return null;
      Object.assign(evidence, {window_since: stream.history_plan.window_since, checked_through: stream.history_plan.checked_through});
    } else {
      // Resuming a pre-policy traversal retains its frozen window. Its actual
      // provider clocks can still date a completed, explicitly verified scan;
      // an invalid/missing window or malformed newer policy cannot be rescued.
      try {validateSavedCloudWindow(job?.collection_window);} catch {return null;}
      const created = time(job?.created_at), from = time(job.collection_window.window_from);
      if (created === null || from === null || from > created || created > time(evidence.first_observed_at)
        || stream.cursor !== null && stream.completion_reason !== 'timeframe_covered') return null;
      Object.assign(evidence, {window_since: Math.floor(from / 1000), checked_through: Math.floor(created / 1000)});
    }
  }
  return validEvidence(evidence, stream.kind === 'history', now) ? evidence : null;
}

function candidates(index, key, history, now) {
  const value = index?.[key], values = history ? Array.isArray(value) ? value : [] : [value];
  return values.filter(row => validEvidence(row, history, now));
}

export function recordComparisonCompletion(state, job, streamIndex, now) {
  const stream = job.streams?.[streamIndex], evidence = completedComparisonEvidence(stream, now, job);
  if (!evidence) return;
  const known = new Set((job.scopes || []).map(addressKey).filter(Boolean)), previous = state.comparison_freshness;
  const index = {version: VERSION, listings: {}, rentals: {}};
  // Keep only this portfolio's current traversal scopes, and cap even malformed
  // imported/legacy state before carrying it into another checkpoint.
  if (previous?.version === VERSION) for (const history of [false, true]) {
    const source = history ? 'rentals' : 'listings';
    for (const key of [...known].slice(0, MAX_SCOPES)) {
      const rows = candidates(previous[source], key, history, now);
      if (rows.length) index[source][key] = history ? rows.slice(0, MAX_WINDOWS) : rows[0];
    }
  }
  const key = addressKey(stream.scope), source = stream.kind === 'history' ? 'rentals' : 'listings';
  if (!known.has(key) || [...known].slice(0, MAX_SCOPES).indexOf(key) < 0) return;
  if (source === 'listings') {
    if (!index.listings[key] || time(evidence.first_observed_at) >= time(index.listings[key].first_observed_at)) index.listings[key] = evidence;
  }
  else {
    const rows = [...candidates(index.rentals, key, true, now), evidence];
    const latestPerWindow = new Map();
    for (const row of rows) if (!latestPerWindow.has(row.window_since) || time(row.first_observed_at) > time(latestPerWindow.get(row.window_since).first_observed_at)) latestPerWindow.set(row.window_since, row);
    // Newest completions first, retaining a small number of broader windows.
    index.rentals[key] = [...latestPerWindow.values()].sort((a, b) => time(b.first_observed_at) - time(a.first_observed_at)).slice(0, MAX_WINDOWS);
  }
  state.comparison_freshness = index;
}

/** Per-source completion coverage for the selected period, scoped to saved gifts. */
export function comparisonFreshness(state, gifts, window, now, {allowRelativeListingCompletionBeyondWindow = false} = {}) {
  const scopes = new Set(), unresolved = new Set();
  for (const gift of gifts || []) if (gift?.is_portfolio) {
    const key = addressKey(gift.collection_address);
    if (!key || gift.collection_conflict) unresolved.add(gift.id || gift.nft_address); else scopes.add(key);
  }
  const index = state.comparison_freshness?.version === VERSION ? state.comparison_freshness : {};
  const from = time(window.window_from), to = time(window.window_to);
  const advancingCustomEnd = currentDayCustomWindow(window, to, now);
  const result = {version: VERSION};
  for (const history of [false, true]) {
    const source = history ? 'rentals' : 'listings', selected = new Map();
    const consider = (key, evidence) => {
      if (!scopes.has(key) || !validEvidence(evidence, history, now) || from === null || to === null || from > to || to > now) return;
      const first = time(evidence.first_observed_at), last = time(evidence.last_observed_at);
      // Relative and current-day custom reports remain dated samples up to
      // their saved watermark; they cannot promise events after that point.
      // Fixed custom periods require their complete end, at the provider's
      // integer-second precision (including the final .999ms of a UTC date).
      const fits = history ? evidence.window_since * 1000 <= from
        && evidence.checked_through * 1000 >= from
        && (window.timeframe !== 'custom' || advancingCustomEnd || evidence.checked_through >= Math.floor(to / 1000))
        : first >= from && (last <= to || window.timeframe !== 'custom' && allowRelativeListingCompletionBeyondWindow === true);
      if (!fits || selected.has(key) && time(selected.get(key).first_observed_at) >= first) return;
      selected.set(key, evidence);
    };
    for (const key of scopes) for (const evidence of candidates(index[source], key, history, now)) consider(key, evidence);
    // Existing provider-completed streams can describe their original evidence
    // without a migration or trusting a newer cached job's completion clock.
    for (const stream of state.job?.streams || []) if (stream.kind === (history ? 'history' : 'listing')) {
      const evidence = completedComparisonEvidence(stream, now, state.job); if (evidence) consider(addressKey(stream.scope), evidence);
    }
    if (!history) for (const [key, entry] of Object.entries(state.market_cache || {})) {
      if (entry?.version === 1 && entry.kind === 'listing' && entry.complete === true
        && Number.isSafeInteger(entry.job_id) && entry.job_id > 0 && Number.isSafeInteger(entry.stream_index) && entry.stream_index > 0
        && Number.isSafeInteger(entry.page_size) && entry.page_size > 0 && entry.page_size <= 100
        && key === marketCacheKey({kind:'listing',scope:entry.collection_address},entry.page_size)) consider(addressKey(entry.collection_address), entry);
    }
    const times = [...selected.values()].map(row => time(row.first_observed_at));
    const completed = [...selected.values()].map(row => time(row.last_observed_at));
    const fresh = [...selected.values()].filter(row => now - time(row.first_observed_at) < HOUR
      && (!history || window.timeframe === 'custom' && !advancingCustomEnd || now - row.checked_through * 1000 < HOUR)).length;
    result[source] = {total_collections: scopes.size, unresolved_collections: unresolved.size,
      checked_collections: selected.size, fresh_collections: fresh,
      freshest_checked_at: completed.length ? new Date(Math.max(...completed)).toISOString() : null,
      oldest_checked_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
      complete: scopes.size > 0 && selected.size === scopes.size && unresolved.size === 0,
      timeframe: window.timeframe, window_from: window.window_from, window_to: window.window_to};
    if (history) {
      const watermarks = [...selected.values()].map(row => row.checked_through * 1000);
      result[source].oldest_checked_through = watermarks.length ? new Date(Math.min(...watermarks)).toISOString() : null;
      result[source].freshest_checked_through = watermarks.length ? new Date(Math.max(...watermarks)).toISOString() : null;
    }
  }
  return result;
}
