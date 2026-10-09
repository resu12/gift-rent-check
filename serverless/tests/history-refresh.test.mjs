import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planHistoryRefresh, validHistoryPlan, completedHistoryCoverage} from '../tgcloud/lib/history-refresh.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/marketapp/history-refresh-policy.json', import.meta.url), 'utf8'));
const source = {provider: 'marketapp', job_id: 1, stream_index: 1};
for (const example of fixture.cases) test(`shared history policy: ${example.name}`, () => {
  const previous = example.previous ? {...example.previous, window_since: example.previous.coverage_since, scope_verified: true, source} : null;
  const plan = planHistoryRefresh(previous, example.requested_since, example.now);
  assert.equal(plan.mode, example.expected.mode); assert.equal(plan.scan_since, example.expected.scan_since); assert.equal(plan.full_scan_at, example.expected.full_scan_at);
  assert.equal(validHistoryPlan(plan, example.requested_since, example.now), true);
  assert.equal(completedHistoryCoverage({complete: true, ordered: true, scope_verified: true, history_plan: plan}, 2, 1)?.checked_through, example.now);
});

test('saved history policy rejects unsupported versions, inconsistent bounds and forged incremental provenance', () => {
  const plan = planHistoryRefresh(null, 100, 1000000);
  for (const bad of [{...plan, version: 2}, {...plan, scan_since: 101}, {...plan, full_scan_at: 999999}, {...plan, mode: 'incremental'}, {...plan, checked_through: 999999}, {...plan, window_since: 101}, {...plan, baseline_provenance: {}}]) {
    assert.equal(validHistoryPlan(bad, 100, 1000000), false); assert.equal(completedHistoryCoverage({complete: true, ordered: true, scope_verified: true, history_plan: bad}, 2, 1), null);
  }
  const incremental = planHistoryRefresh({version: 1, complete: true, ordered: true, scope_verified: true, source, window_since: 100, checked_through: 999000, full_scan_at: 800000}, 100, 1000000);
  assert.equal(incremental.mode, 'incremental');
  for (const bad of [{...incremental, scan_since: incremental.scan_since + 1}, {...incremental, baseline_provenance: null}, {...incremental, baseline_provenance: {...incremental.baseline_provenance, source: {provider: 'import'}}}]) assert.equal(validHistoryPlan(bad), false);
});
