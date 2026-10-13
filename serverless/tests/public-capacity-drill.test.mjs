import test from 'node:test';
import assert from 'node:assert/strict';
import {runPublicCapacityDrill} from '../tools/public-capacity-drill.mjs';
test('concurrent invited-account workload preserves isolation, CAS, quota and deletion fences through compact writes',async()=>{
  const report=await runPublicCapacityDrill({accounts:5,giftsPerAccount:30,observations:3});
  assert.equal(report.passed,true);assert.ok(Object.values(report.checks).every(Boolean));
  assert.equal(report.normalized_payloads,150);assert.equal(report.normalized_observations,450);
  assert.equal(report.hosting_quota_verified,false);assert.equal(report.hosted_load_verified,false);
  assert.equal(report.provider_requests,0);assert.ok(report.logical_bytes_before_deletion<report.source_record_bytes_before_deduplication);
});
test('capacity workload bounds reject accidental unbounded local load',async()=>{
  for(const options of [{accounts:1},{accounts:10001},{giftsPerAccount:0},{observations:50}])await assert.rejects(runPublicCapacityDrill(options),/Invalid bounded/);
});
