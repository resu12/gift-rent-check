import test from 'node:test';
import assert from 'node:assert/strict';
import {readStorageStatus, storageGrowthSummary, type StorageGrowth, type StorageStatus} from './storageMonitoring.ts';

const now=Date.parse('2026-10-14T12:00:00.000Z');
const growth:StorageGrowth={state:'growing',sample_count:3,observed_from:'2026-10-12T12:00:00.000Z',
  observed_through:'2026-10-14T12:00:00.000Z',net_bytes_per_day:1000000,days_to_limit:8,
  write_limit_bytes:9000000,platform_quota_verified:false};
function status(change:Partial<StorageGrowth>={}):StorageStatus {
  return {version:1,scope:'app',status:'healthy',estimated_bytes:1000000,budget_bytes:10000000,
    checked_at:'2026-10-14T12:00:00.000Z',inventory_complete:true,cleanup:{state:'idle',last_completed_at:null,
      reclaimed_bytes:0,estimated_reclaimable_bytes:null},can_cleanup:true,next_step_at:null,growth:{...growth,...change}};
}
test('new growth metadata and older status responses both validate without changing payloads',()=>{
  const value=status();assert.equal(readStorageStatus(value),value);
  const {growth:unused,...legacy}=value;assert.equal(readStorageStatus(legacy),legacy);
  const collecting=status({state:'collecting',sample_count:0,observed_from:null,observed_through:null,net_bytes_per_day:null,days_to_limit:null});
  assert.equal(readStorageStatus(collecting),collecting);
  const unknown=status({state:'unknown',sample_count:0,observed_from:null,observed_through:null,net_bytes_per_day:null,days_to_limit:null,write_limit_bytes:null});
  assert.equal(readStorageStatus(unknown),unknown);
  for(const rate of [0,-100])assert.doesNotThrow(()=>readStorageStatus(status({state:'not_growing',net_bytes_per_day:rate,days_to_limit:null})));
  assert.doesNotThrow(()=>readStorageStatus(status({state:'stale',net_bytes_per_day:null,days_to_limit:null})));
});
test('malformed, unbounded and contradictory growth metadata rejects safely',()=>{
  const changes:Record<string,unknown>[]=[{sample_count:32},{sample_count:-1},{sample_count:2},{sample_count:1.5},
    {observed_from:'yesterday'},{observed_from:'2026-10-14T12:00:00.000Z'},{observed_through:null},
    {net_bytes_per_day:Infinity},{net_bytes_per_day:NaN},{net_bytes_per_day:0},{net_bytes_per_day:-1},
    {net_bytes_per_day:1.5},{days_to_limit:36501},{days_to_limit:-1},{days_to_limit:'tomorrow'},
    {write_limit_bytes:0},{write_limit_bytes:null},{platform_quota_verified:true},{private_account_id:'secret'},
    {state:['collecting'],net_bytes_per_day:null,days_to_limit:null},{state:'collecting'},{state:'stale'},{state:'unknown'},
    {state:'not_growing',net_bytes_per_day:1,days_to_limit:null}];
  for(const change of changes)assert.throws(()=>readStorageStatus({...status(),growth:{...growth,...change}}),/could not be confirmed/);
});
test('growth wording distinguishes app guard from account allowance and states its uncertainty',()=>{
  assert.match(storageGrowthSummary(growth,'app',now),/Net change: \+1 MB\/day over 2 days, including cleanup/);
  assert.match(storageGrowthSummary(growth,'app',now),/Roughly 8 days to the app write limit if this rate continues/);
  assert.match(storageGrowthSummary(growth,'account',now),/account write limit/);
  assert.match(storageGrowthSummary({...growth,days_to_limit:0},'app',now),/At the app write limit/);
  assert.match(storageGrowthSummary({...growth,days_to_limit:1},'app',now),/Roughly 1 day to/);
  assert.match(storageGrowthSummary({...growth,net_bytes_per_day:1000},'account',now),/\+1 KB\/day/);
  assert.match(storageGrowthSummary({...growth,net_bytes_per_day:1},'account',now),/\+1 B\/day/);
  assert.match(storageGrowthSummary({...growth,state:'not_growing',net_bytes_per_day:-1000000,days_to_limit:null},'app',now),/−1 MB\/day.*No time estimate available/);
  assert.match(storageGrowthSummary({...growth,state:'not_growing',net_bytes_per_day:0,days_to_limit:null},'app',now),/No measurable net growth.*does not mean unlimited/);
});
test('collecting, stale or missing history never shows a time-to-limit prediction',()=>{
  assert.match(storageGrowthSummary({...growth,state:'collecting',sample_count:1},'app',now),/1\/3 samples.*48 hours/);
  assert.match(storageGrowthSummary({...growth,state:'unknown'},'app',now),/waiting for a complete storage check/);
  const stale=storageGrowthSummary(growth,'app',now+172800001);assert.match(stale,/older than two days/);assert.doesNotMatch(stale,/8 days/);
  assert.match(storageGrowthSummary({...growth,state:'stale'},'app',now),/older than two days/);
});
