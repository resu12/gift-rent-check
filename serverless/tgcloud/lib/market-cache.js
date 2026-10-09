import {addressKey} from './cloud-pricing-core.js';
import {validHistoryPlan} from './history-refresh.js';

// Reuse completed public comparison traversals, never personal portfolio data.
// Records remain in their original events, with their original observed times.
export const MARKET_CACHE_POLICY = Object.freeze({version: 1, ttl_seconds: 3600, max_entries: 1000});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && /Z$/.test(value) ? Date.parse(value) : NaN;
const kind = value => ['listing', 'history'].includes(value);

export function marketCacheKey(stream, pageSize) {
  return JSON.stringify([MARKET_CACHE_POLICY.version, stream.kind, addressKey(stream.scope), pageSize,
    stream.kind === 'listing' ? 'recently_touch' : 'new_to_old']);
}

function usable(entry, now) {
  if (!object(entry) || entry.version !== MARKET_CACHE_POLICY.version || entry.complete !== true || !kind(entry.kind)
    || typeof entry.collection_address !== 'string' || !entry.collection_address || !Number.isSafeInteger(entry.page_size) || entry.page_size < 1 || entry.page_size > 100
    || !Number.isSafeInteger(entry.job_id) || entry.job_id < 1 || !Number.isSafeInteger(entry.stream_index) || entry.stream_index < 1) return false;
  const first = timestamp(entry.first_observed_at), last = timestamp(entry.last_observed_at);
  return Number.isFinite(first) && first > 0 && Number.isFinite(last) && first <= last && last <= now && now - first < MARKET_CACHE_POLICY.ttl_seconds * 1000;
}

export function pruneMarketCache(index, now) {
  if (!object(index)) return {};
  return Object.fromEntries(Object.entries(index)
    .filter(([key, entry]) => usable(entry, now) && key === marketCacheKey({kind: entry.kind, scope: entry.collection_address}, entry.page_size))
    .sort(([, a], [, b]) => timestamp(b.first_observed_at) - timestamp(a.first_observed_at))
    .slice(0, MARKET_CACHE_POLICY.max_entries));
}

export function cachedMarketStream(index, stream, pageSize, now) {
  const entry = index?.[marketCacheKey(stream, pageSize)];
  if (!usable(entry, now)) return null;
  if (entry.kind !== stream.kind || entry.collection_address !== addressKey(stream.scope) || entry.page_size !== pageSize) return null;
  if (stream.kind === 'history') {
    const plan = stream.history_plan;
    if (!validHistoryPlan(plan) || entry.history_policy_version !== plan.version || entry.ordered !== true || entry.scope_verified !== true
      || !Number.isSafeInteger(entry.scan_since) || !Number.isSafeInteger(entry.window_since) || entry.window_since <= 0 || entry.scan_since < entry.window_since
      || entry.window_since > plan.window_since || entry.scan_since > plan.scan_since) return null;
  }
  return {job_id: entry.job_id, stream_index: entry.stream_index, first_observed_at: entry.first_observed_at, last_observed_at: entry.last_observed_at};
}

export function completedMarketStream(job, streamIndex, now) {
  const stream = job.streams[streamIndex];
  if (job.market_cache_version !== MARKET_CACHE_POLICY.version || !kind(stream.kind) || !stream.complete || !stream.started || stream.pages < 1 || stream.cache_source) return null;
  const entry = {
    version: MARKET_CACHE_POLICY.version, complete: true, kind: stream.kind, collection_address: addressKey(stream.scope), page_size: job.page_size,
    job_id: job.id, stream_index: streamIndex, first_observed_at: stream.first_observed_at, last_observed_at: stream.last_observed_at,
  };
  if (stream.kind === 'listing' && stream.cursor !== null) return null;
  if (stream.kind === 'history') {
    if (stream.ordered !== true || stream.scope_verified !== true || !validHistoryPlan(stream.history_plan)) return null;
    Object.assign(entry, {ordered: true, scope_verified: true, history_policy_version: stream.history_plan.version, scan_since: stream.history_plan.scan_since, window_since: stream.history_plan.window_since});
  }
  return usable(entry, now) ? entry : null;
}

export function marketCacheProgress(streams, now = NaN) {
  const eligible = streams.filter(stream => kind(stream.kind)), cached = eligible.filter(stream => stream.cache_source);
  const oldest = cached.map(stream => stream.cache_source.first_observed_at).sort((a, b) => timestamp(a) - timestamp(b))[0] ?? null;
  return {reused_streams: cached.length, total_streams: eligible.length, ttl_seconds: MARKET_CACHE_POLICY.ttl_seconds, oldest_observed_at: oldest,
    oldest_age_seconds: oldest && Number.isFinite(now) ? Math.max(0, Math.floor((now - timestamp(oldest)) / 1000)) : null};
}
