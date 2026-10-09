import test from 'node:test';
import assert from 'node:assert/strict';
import {MARKET_CACHE_POLICY, marketCacheKey, cachedMarketStream, completedMarketStream, pruneMarketCache} from '../tgcloud/lib/market-cache.js';
import {planHistoryRefresh} from '../tgcloud/lib/history-refresh.js';

const now = 1800000000000, scope = `0:${'00'.repeat(32)}`, friendly = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const at = offset => new Date(now + offset).toISOString();
const listing = {kind: 'listing', scope, started: true, complete: true, cursor: null, pages: 1, first_observed_at: at(-2000), last_observed_at: at(-1000)};
const job = stream => ({id: 1, page_size: 100, market_cache_version: 1, streams: [{kind: 'collection'}, stream]});
const full = planHistoryRefresh(null, Math.floor(now / 1000) - 30 * 86400, Math.floor(now / 1000));
const history = {...listing, kind: 'history', ordered: true, scope_verified: true, cursor: 'past-window', history_plan: full};

test('cache keys use canonical collection identity and exact fixed traversal parameters', () => {
  const entry = completedMarketStream(job(listing), 1, now), index = {[marketCacheKey(listing, 100)]: entry};
  assert.equal(cachedMarketStream(index, {...listing, scope: friendly}, 100, now).job_id, 1);
  assert.equal(cachedMarketStream(index, {...listing, scope: 'another'}, 100, now), null);
  assert.equal(cachedMarketStream(index, listing, 10, now), null);
  assert.equal(cachedMarketStream(index, history, 100, now), null);
});

test('partial, legacy, cached, unordered and wrong-collection streams cannot seed the index', () => {
  for (const stream of [{...listing, complete: false}, {...listing, started: false}, {...listing, pages: 0}, {...listing, cursor: 'pending'}, {...listing, cache_source: {job_id: 4}}, {...history, ordered: false}, {...history, scope_verified: false}, {...history, history_plan: undefined}]) assert.equal(completedMarketStream(job(stream), 1, now), null);
  assert.equal(completedMarketStream({...job(listing), market_cache_version: undefined}, 1, now), null);
  assert.equal(completedMarketStream(job({...listing, first_observed_at: at(-3600000)}), 1, now), null);
});

test('history cache accepts only sufficient requested-window and scan coverage', () => {
  const entry = completedMarketStream(job(history), 1, now), index = {[marketCacheKey(history, 100)]: entry};
  assert.ok(cachedMarketStream(index, history, 100, now));
  const wider = {...history, history_plan: planHistoryRefresh(null, full.window_since - 1, full.checked_through)};
  assert.equal(cachedMarketStream(index, wider, 100, now), null);
  for (const bad of [{...entry, scan_since: full.scan_since + 1}, {...entry, ordered: false}, {...entry, scope_verified: false}, {...entry, history_policy_version: 2}]) assert.equal(cachedMarketStream({[marketCacheKey(history, 100)]: bad}, history, 100, now), null);
});

test('cache cleanup rejects future, expired, malformed or mismatched entries and caps its public index', () => {
  const entry = completedMarketStream(job(listing), 1, now), key = marketCacheKey(listing, 100);
  for (const bad of [{...entry, first_observed_at: at(-3600000)}, {...entry, last_observed_at: at(1)}, {...entry, first_observed_at: at(0)}, {...entry, version: 2}, {...entry, job_id: '1'}, {...entry, complete: false}]) assert.deepEqual(pruneMarketCache({[key]: bad}, now), {});
  assert.deepEqual(pruneMarketCache({wrongKey: entry}, now), {});
  const many = Object.fromEntries(Array.from({length: MARKET_CACHE_POLICY.max_entries + 1}, (_, i) => {
    const collection = `collection-${i}`; return [marketCacheKey({...listing, scope: collection}, 100), {...entry, collection_address: collection, first_observed_at: at(-2000 - i)}];
  }));
  assert.equal(Object.keys(pruneMarketCache(many, now)).length, MARKET_CACHE_POLICY.max_entries);
});
