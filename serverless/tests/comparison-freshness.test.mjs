import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonFreshness, recordComparisonCompletion, completedComparisonEvidence} from '../tgcloud/lib/comparison-freshness.js';
import {resolveCloudWindow} from '../tgcloud/lib/cloud-pricing-core.js';
import {planHistoryRefresh} from '../tgcloud/lib/history-refresh.js';
import {marketCacheKey} from '../tgcloud/lib/market-cache.js';

const now = Date.parse('2026-10-11T12:00:00Z'), at = delta => new Date(now + delta).toISOString();
const scope = `0:${'00'.repeat(32)}`, alias = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c', other = `0:${'11'.repeat(32)}`;
const gifts = [{id: 'one', is_portfolio: true, collection_address: scope}];
const window = resolveCloudWindow({timeframe: '30d'}, now);
const listing = (overrides = {}) => ({kind: 'listing', scope, started: true, complete: true, pages: 1, cursor: null,
  first_observed_at: at(-10000), last_observed_at: at(-5000), ...overrides});
const history = (overrides = {}) => listing({kind: 'history', ordered: true, scope_verified: true,
  history_plan: planHistoryRefresh(null, Math.floor(Date.parse(window.window_from) / 1000) - 10, Math.floor((now - 10000) / 1000)), ...overrides});
const job = (streams) => ({id: 1, scopes: [scope], streams: [{kind: 'collection'}, ...streams], state: 'complete', updated_at: at(0)});

test('source summaries remain independent, use original provider clocks and canonical collection scopes', () => {
  const state = {job: job([listing({scope: alias}), history()])};
  recordComparisonCompletion(state, state.job, 1, now);
  recordComparisonCompletion(state, state.job, 2, now);
  const summary = comparisonFreshness(state, [...gifts, {id:'two',is_portfolio:true,collection_address:alias}], window, now);
  assert.equal(summary.version, 1);
  for (const source of ['listings', 'rentals']) {
    assert.equal(summary[source].total_collections, 1);
    assert.equal(summary[source].checked_collections, 1);
    assert.equal(summary[source].fresh_collections, 1);
    assert.equal(summary[source].complete, true);
    assert.equal(summary[source].oldest_checked_at, at(-10000));
    assert.equal(summary[source].freshest_checked_at, at(-5000));
    assert.equal(summary[source].timeframe, '30d');
  }
});

test('partial, cached, malformed, unordered and conflicting streams never certify a completion', () => {
  for (const stream of [listing({complete:false}), listing({started:false}), listing({pages:0}), listing({cursor:'more'}),
    listing({cache_source:{first_observed_at:at(-20000)}}), listing({first_observed_at:at(1),last_observed_at:at(2)}),
    listing({first_observed_at:'invalid'}), listing({first_observed_at:'2026-02-30T00:00:00Z'}),
    listing({first_observed_at:'2026-10-11T24:00:00Z'}), history({ordered:false}), history({scope_verified:false}), history({history_plan:null})]) {
    assert.equal(completedComparisonEvidence(stream, now), null);
    const state = {job: job([stream])}; recordComparisonCompletion(state, state.job, 1, now);
    const summary = comparisonFreshness(state, gifts, window, now);
    assert.equal(summary.listings.complete, false); assert.equal(summary.rentals.complete, false);
  }
});

test('a newer partial traversal retains prior complete source evidence and does not move its clock', () => {
  const state = {job:job([listing()])}; recordComparisonCompletion(state, state.job, 1, now);
  state.job = {...job([listing({complete:false,first_observed_at:at(-1000),last_observed_at:at(-500)})]), state:'running'};
  recordComparisonCompletion(state, state.job, 1, now);
  const summary = comparisonFreshness(state, gifts, window, now);
  assert.equal(summary.listings.complete, true); assert.equal(summary.listings.oldest_checked_at, at(-10000));
  assert.equal(summary.rentals.complete, false);
});

test('old or partially scoped information is still dated but cannot claim fresh full-portfolio coverage', () => {
  const stale = listing({first_observed_at:at(-7200000),last_observed_at:at(-7195000)});
  const state = {job:job([stale])}; recordComparisonCompletion(state, state.job, 1, now);
  const summary = comparisonFreshness(state, [...gifts, {id:'other',is_portfolio:true,collection_address:other},
    {id:'conflict',is_portfolio:true,collection_address:scope,collection_conflict:true}, {id:'candidate',is_portfolio:false,collection_address:other}], window, now);
  assert.equal(summary.listings.total_collections, 2); assert.equal(summary.listings.unresolved_collections, 1);
  assert.equal(summary.listings.checked_collections, 1); assert.equal(summary.listings.fresh_collections, 0);
  assert.equal(summary.listings.oldest_checked_at, at(-7200000)); assert.equal(summary.listings.complete, false);
});

test('history completion applies only to sufficiently covered starts and fixed custom endpoints', () => {
  const state = {job:job([history()])}; recordComparisonCompletion(state, state.job, 1, now);
  state.job = null;
  assert.equal(comparisonFreshness(state, gifts, resolveCloudWindow({timeframe:'7d'},now), now).rentals.complete, true);
  assert.equal(comparisonFreshness(state, gifts, resolveCloudWindow({timeframe:'90d'},now), now).rentals.complete, false);
  assert.equal(comparisonFreshness(state, gifts, resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-10'},now), now).rentals.complete, true);
  assert.equal(comparisonFreshness(state, gifts, resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now), now).rentals.complete, true);
});

test('a completed current-day custom history remains dated as its endpoint advances, without promoting its watermark', () => {
  const scanStart = now - 10567, stream = history({history_plan:planHistoryRefresh(null,
    Math.floor(Date.parse(window.window_from) / 1000), Math.floor(scanStart / 1000))});
  const state = {job:job([stream])}; recordComparisonCompletion(state,state.job,1,now); state.job = null;
  const input = {timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'};
  const original = JSON.stringify(state.comparison_freshness);
  for (const clock of [now,now+60000,now+3600000]) {
    const displayed = resolveCloudWindow(input,clock), result = comparisonFreshness(state,gifts,displayed,clock).rentals;
    assert.equal(result.checked_collections,1); assert.equal(result.complete,true);
    assert.equal(result.fresh_collections,clock-now < 3600000 ? 1 : 0);
    assert.equal(result.freshest_checked_at,at(-5000)); assert.equal(result.oldest_checked_at,at(-10000));
    assert.equal(result.oldest_checked_through,new Date(Math.floor(scanStart / 1000)*1000).toISOString());
    assert.equal(result.window_to,displayed.window_to,'metadata retains the exact selected projection');
  }
  assert.equal(JSON.stringify(state.comparison_freshness),original,'offline reads never renew provider evidence');
});

test('current-day custom freshness requires a recent saved watermark, even if EOF was observed just now', () => {
  const state = {job:job([history({history_plan:planHistoryRefresh(null,
    Math.floor(Date.parse(window.window_from)/1000),Math.floor((now-7200000)/1000))})])};
  const selected = resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now);
  const result = comparisonFreshness(state,gifts,selected,now).rentals;
  assert.equal(result.checked_collections,1); assert.equal(result.complete,true); assert.equal(result.fresh_collections,0);
  assert.equal(result.freshest_checked_at,at(-5000)); assert.equal(result.oldest_checked_through,at(-7200000));
});

test('per-collection saved watermark range is independent of completion timestamps and remains conservative', () => {
  const broadSince = Math.floor(Date.parse(window.window_from)/1000);
  const state = {job:{...job([
    history({history_plan:planHistoryRefresh(null,broadSince,Math.floor((now-120000)/1000))}),
    history({scope:other,first_observed_at:at(-8000),last_observed_at:at(-3000),
      history_plan:planHistoryRefresh(null,broadSince,Math.floor((now-60000)/1000))}),
  ]),scopes:[scope,other]}};
  recordComparisonCompletion(state,state.job,1,now); recordComparisonCompletion(state,state.job,2,now); state.job = null;
  const selected = resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now);
  const result = comparisonFreshness(state,[...gifts,{id:'two',is_portfolio:true,collection_address:other}],selected,now).rentals;
  assert.equal(result.complete,true); assert.equal(result.checked_collections,2); assert.equal(result.fresh_collections,2);
  assert.equal(result.oldest_checked_through,at(-120000)); assert.equal(result.freshest_checked_through,at(-60000));
  assert.equal(result.oldest_checked_at,at(-10000)); assert.equal(result.freshest_checked_at,at(-3000));
});

test('a current-day exception ends at UTC rollover and fixed ends respect provider-second precision', () => {
  const state = {job:job([history()])}, selected = {timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'};
  const nextDay = Date.parse('2026-10-12T00:00:00.123Z');
  assert.equal(comparisonFreshness(state,gifts,resolveCloudWindow(selected,nextDay),nextDay).rentals.checked_collections,0);
  // Marketapp timestamps and traversal boundaries are integer seconds. The
  // last second covers events from 23:59:59 despite the UI's .999ms endpoint.
  const dayEnd = Math.floor(Date.parse('2026-10-11T23:59:59.999Z')/1000);
  state.job.streams[1] = history({first_observed_at:'2026-10-11T23:59:59.100Z',last_observed_at:'2026-10-12T00:00:00.000Z',
    history_plan:planHistoryRefresh(null,Math.floor(Date.parse(window.window_from)/1000),dayEnd)});
  const result = comparisonFreshness(state,gifts,resolveCloudWindow(selected,nextDay),nextDay).rentals;
  assert.equal(result.complete,true); assert.equal(result.fresh_collections,1);
  assert.equal(result.oldest_checked_through,'2026-10-11T23:59:59.000Z');
  state.job.streams[1].history_plan = planHistoryRefresh(null,Math.floor(Date.parse(window.window_from)/1000),dayEnd-1);
  assert.equal(comparisonFreshness(state,gifts,resolveCloudWindow(selected,nextDay),nextDay).rentals.complete,false);
});

test('future, malformed and uncovered custom periods do not inherit a current-day exception', () => {
  const state = {job:job([history()])};
  for (const selected of [
    resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-12'},now),
    {...resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now),window_to:at(1)},
    {...resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now),date_from:'invalid'},
    resolveCloudWindow({timeframe:'custom',date_from:'2026-09-01',date_to:'2026-10-11'},now),
  ]) assert.equal(comparisonFreshness(state,gifts,selected,now).rentals.checked_collections,0);
});

test('completed legacy history uses its verified frozen traversal and original provider clocks', () => {
  const stream = history(); delete stream.history_plan;
  const savedJob = {...job([stream]), created_at:at(-20000), collection_window:resolveCloudWindow({timeframe:'30d'},now-20000)};
  const state = {job:savedJob}; recordComparisonCompletion(state,savedJob,1,now);
  const summary = comparisonFreshness(state,gifts,window,now).rentals;
  assert.equal(summary.checked_collections,1); assert.equal(summary.fresh_collections,1);
  assert.equal(summary.complete,true); assert.equal(summary.freshest_checked_at,at(-5000));
  assert.equal(summary.oldest_checked_at,at(-10000));
  assert.equal(comparisonFreshness(state,gifts,resolveCloudWindow({timeframe:'90d'},now),now).rentals.checked_collections,0);
  const currentDay = comparisonFreshness(state,gifts,resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now),now).rentals;
  assert.equal(currentDay.checked_collections,1); assert.equal(currentDay.oldest_checked_through,at(-20000));
});

test('legacy history cannot bypass invalid policy, missing identity checks or unproven traversal dates', () => {
  const legacy = history(); delete legacy.history_plan;
  const saved = {...job([legacy]),created_at:at(-20000),collection_window:resolveCloudWindow({timeframe:'30d'},now-20000)};
  for (const [stream, savedJob] of [
    [{...legacy,history_plan:null},saved], [{...legacy,scope_verified:false},saved],
    [{...legacy,ordered:false},saved], [{...legacy,first_observed_at:null},saved],
    [{...legacy,cursor:'more'},saved], [legacy,{...saved,collection_window:null}],
    [legacy,{...saved,created_at:at(-1000)}], [legacy,{...saved,created_at:null}],
  ]) assert.equal(completedComparisonEvidence(stream,now,savedJob),null);
  assert.notEqual(completedComparisonEvidence({...legacy,cursor:'more',completion_reason:'timeframe_covered'},now,saved),null);
});

test('later listing EOF needs an explicit records-projection fence and never relaxes a custom historical period', () => {
  const state = {job:job([listing()])};
  const displayed = resolveCloudWindow({timeframe:'30d'},now-6000);
  assert.equal(comparisonFreshness(state,gifts,displayed,now).listings.checked_collections,0);
  assert.equal(comparisonFreshness(state,gifts,displayed,now,{allowRelativeListingCompletionBeyondWindow:true}).listings.checked_collections,1);
  const custom = resolveCloudWindow({timeframe:'custom',date_from:'2026-10-01',date_to:'2026-10-11'},now-6000);
  assert.equal(comparisonFreshness(state,gifts,custom,now,{allowRelativeListingCompletionBeyondWindow:true}).listings.checked_collections,0);
  const future = {job:job([listing({last_observed_at:at(1)})])};
  assert.equal(comparisonFreshness(future,gifts,displayed,now,{allowRelativeListingCompletionBeyondWindow:true}).listings.checked_collections,0);
});

test('legacy listing cache keeps original observation age and cached history never inherits a newer traversal watermark', () => {
  const cached = {version:1,kind:'listing',complete:true,collection_address:scope,job_id:1,stream_index:1,page_size:100,first_observed_at:at(-7200000),last_observed_at:at(-7195000)};
  const key = marketCacheKey({kind:'listing',scope},100);
  const state = {market_cache:{[key]:cached}, job:job([history({started:false,pages:0,cache_source:{first_observed_at:at(-10000),last_observed_at:at(-5000)}})])};
  const summary = comparisonFreshness(state, gifts, window, now);
  assert.equal(summary.listings.checked_collections,1); assert.equal(summary.listings.fresh_collections,0);
  assert.equal(summary.listings.oldest_checked_at,at(-7200000)); assert.equal(summary.rentals.checked_collections,0);
  assert.equal(comparisonFreshness({market_cache:{wrong:cached}},gifts,window,now).listings.checked_collections,0);
});

test('completion index is bounded to the current portfolio scopes and six distinct history windows', () => {
  const state = {job:job([history()]),comparison_freshness:{version:1,listings:{[other]:listing()},rentals:{}}};
  for (let i=0;i<12;i++) {
    state.job.streams[1] = history({first_observed_at:at(-10000+i),history_plan:planHistoryRefresh(null,Math.floor(Date.parse(window.window_from)/1000)-i-10,Math.floor((now-10000)/1000))});
    recordComparisonCompletion(state,state.job,1,now);
  }
  assert.equal(state.comparison_freshness.rentals[scope].length,6);
  assert.equal(state.comparison_freshness.listings[other],undefined);
  assert.deepEqual(comparisonFreshness(state, [], window, now).rentals, {total_collections:0,unresolved_collections:0,checked_collections:0,fresh_collections:0,freshest_checked_at:null,oldest_checked_at:null,complete:false,timeframe:'30d',window_from:window.window_from,window_to:window.window_to,oldest_checked_through:null,freshest_checked_through:null});
});
