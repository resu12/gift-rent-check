import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {BackgroundMonitoringError} from '../worker/monitoring.js';

function bridge({version=1, ledger, at=1000}={}) {
  let accesses=0, guard;
  const access={repository:{read:async()=>({state:{background_monitoring:ledger}})},clock:async()=>at};
  const source=readFileSync(new URL('../worker/entrypoint.js',import.meta.url),'utf8')
    .replace(/^import[^\n]+\n/gm,'').replace('export default async function','return async function');
  const create=vm.runInNewContext(`(function(createPrivateBackgroundMonitoringAccess,PRIVATE_BACKGROUND_MONITORING_VERSION,createBackgroundMonitoringWorker,BackgroundMonitoringError){${source}})`);
  return {call:create(check=>{accesses++;guard=check;return access;},version,
    candidate=>{assert.equal(candidate,access);return {tick:async input=>({state:'complete',runner:input.runner_id,retry:input.retry})};},BackgroundMonitoringError),
    accesses:()=>accesses,guard:context=>guard(context)};
}
const input={runner_id:'a'.repeat(64)}, admin={background_worker:'price-monitoring-v1'};

test('ordinary Mini App contexts and arbitrary worker actions never obtain owner access',async()=>{
  const f=bridge();
  for(const [args,ctx] of [[input,{}],[input,{initData:{user:{id:12345}}}],
    [{...input,action:'prepare'},admin],[{...input,user_id:12345},admin],[{runner_id:'invalid'},admin],
    ...['true',1,null,{}].map(retry=>[{...input,retry},admin])]) {
    await assert.rejects(()=>f.call(args,ctx),/BACKGROUND_ACCESS_DENIED/);
  }
  assert.equal(f.accesses(),0);
  const old=bridge({version:0});await assert.rejects(()=>old.call(input,admin),/BACKGROUND_ACCESS_DENIED/);
  assert.equal(old.accesses(),0);
});

test('administrative bridge invokes only the fixed worker tick',async()=>{
  const f=bridge();assert.equal((await f.call(input,admin)).state,'complete');assert.equal(f.accesses(),1);
  assert.equal((await f.call({...input,retry:true},admin)).retry,true);
  assert.equal((await f.call({...input,retry:false},admin)).retry,false);
});

test('provider guard rejects replaced, expired and terminal worker claims',async()=>{
  const run={id:'run',session_id:'session',deadline:3000,lease:{token:'lease',until:2000}},context={run_id:'run',session_id:'session',lease:{...run.lease}};
  const ledger={state:'running',run},f=bridge({ledger});await f.call(input,admin);await f.guard(context);
  for(const change of [{run_id:'other'},{session_id:'other'},{lease:{token:'other',until:2000}},{lease:{token:'lease',until:3000}}])
    await assert.rejects(()=>f.guard({...context,...change}),/BACKGROUND_LEASE_LOST/);
  ledger.state='paused';await assert.rejects(()=>f.guard(context),/BACKGROUND_LEASE_LOST/);
  ledger.state='running';run.lease.until=1000;context.lease.until=1000;
  await assert.rejects(()=>f.guard(context),/BACKGROUND_LEASE_LOST/);
  run.lease.until=2000;context.lease.until=2000;run.deadline=1000;
  await assert.rejects(()=>f.guard(context),/BACKGROUND_LEASE_LOST/);
});
