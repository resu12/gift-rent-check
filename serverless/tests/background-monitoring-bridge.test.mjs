import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {BackgroundMonitoringError} from '../worker/monitoring.js';

function bridge(options={}) {
  const {version=1,ledger,at=1000}=options;
  const scopedHistoryVersion=Object.hasOwn(options,'scopedHistoryVersion')?options.scopedHistoryVersion:1;
  const personalAnalyticsVersion=Object.hasOwn(options,'personalAnalyticsVersion')?options.personalAnalyticsVersion:1;
  let accesses=0, guard;
  const access={repository:{read:async()=>({state:{background_monitoring:ledger}})},clock:async()=>at,
    assertScopeReadOnly:options.assertScopeReadOnly,
    analytics:Object.hasOwn(options,'analytics')?options.analytics:{version:1,refresh:async()=>{}},
    ...(options.dashboard?{dashboard:options.dashboard}:{})};
  const source=readFileSync(new URL('../worker/entrypoint.js',import.meta.url),'utf8')
    .replace(/^import[^\n]+\n/gm,'').replace('export default async function','return async function');
  const create=vm.runInNewContext(`(function(createPrivateBackgroundMonitoringAccess,PRIVATE_BACKGROUND_MONITORING_VERSION,PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION,PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION,createBackgroundMonitoringWorker,BackgroundMonitoringError){${source}})`);
  return {call:create(check=>{accesses++;guard=check;return access;},version,scopedHistoryVersion,personalAnalyticsVersion,
    candidate=>{assert.equal(candidate,access);return {tick:async input=>({state:'complete',runner:input.runner_id,retry:input.retry,skip_analytics:input.skip_analytics,yield_only:input.yield_only}),status:async input=>({state:'running',read_only:true,acknowledgement_for:input.runner_id}),prewarm:async input=>({state:'prepared',runner:input.runner_id}),confirmPreparation:async()=>({state:'prepared',read_only:true}),...options.worker};},BackgroundMonitoringError),
    accesses:()=>accesses,guard:context=>guard(context)};
}
const input={runner_id:'a'.repeat(64)}, admin={background_worker:'price-monitoring-v1'};
const denied=async value=>assert.deepEqual(JSON.parse(JSON.stringify(await (typeof value==='function'?value():value))),
  {state:'failed',execution_code:'BACKGROUND_ACCESS_DENIED'});

test('split preparation phases require exact exclusive inputs before obtaining owner access',async()=>{
  const f=bridge();
  for(const prewarm_stage of ['basis','cards'])for(const extra of [{},{prewarm_only:false},{prewarm_confirm_only:true},
    {status_only:true},{prewarm_only:true,retry:false},{prewarm_only:true,skip_analytics:false},
    {prewarm_only:true,yield_only:false},{prewarm_only:true,prewarm_confirm_only:true}])
    await denied(f.call({...input,prewarm_stage,...extra},admin));
  for(const prewarm_stage of [undefined,null,false,1,{},[],'prepare','confirm','Basis','basis '])
    await denied(f.call({...input,prewarm_only:true,prewarm_stage},admin));
  assert.equal(f.accesses(),0);
});

test('split bridge capability requires both builders and read-only confirmation',async()=>{
  const dashboard={version:1,prewarm:async()=>{},confirmation_version:1,prepare:async()=>{},confirm:async()=>{},
    preparation_version:2,prepareBasis:async()=>{},prepareCards:async()=>{}};
  for(const change of [{preparation_version:1},{preparation_version:undefined},{confirmation_version:0},
    {prepareBasis:undefined},{prepareCards:undefined},{confirm:undefined}]) {
    const f=bridge({dashboard:{...dashboard,...change},assertScopeReadOnly:async()=>{}});
    assert.deepEqual(JSON.parse(JSON.stringify(await f.call({...input,prewarm_only:true,prewarm_stage:'basis'},admin))),
      {state:'failed',execution_code:'BACKGROUND_PREWARM_UNSUPPORTED'});
  }
  const absent=bridge({dashboard});
  assert.deepEqual(JSON.parse(JSON.stringify(await absent.call({...input,prewarm_only:true,prewarm_stage:'cards'},admin))),
    {state:'failed',execution_code:'BACKGROUND_PREWARM_UNSUPPORTED'});
  for(const prewarm_stage of ['basis','cards']) {
    let received;
    const f=bridge({dashboard,assertScopeReadOnly:async()=>{},worker:{prewarm:async value=>{received=value;return {state:'pending'};}}});
    assert.equal((await f.call({...input,prewarm_only:true,prewarm_stage},admin)).state,'pending');
    assert.deepEqual(received,{...input,prewarm_only:true,prewarm_stage});
  }
});

test('split cache guard binds the exact authorized phase without changing cycle or deadline fencing',async()=>{
  const run={id:input.runner_id+':1',session_id:'session',stage:'done',lease:null,gift_complete:true,history_complete:true};
  const ledger={state:'complete',run,last_success_at:new Date(900).toISOString(),last_finished_at:new Date(900).toISOString()};
  const dashboard={version:1,prewarm:async()=>{},confirmation_version:1,prepare:async()=>{},confirm:async()=>{},
    preparation_version:2,prepareBasis:async()=>{},prepareCards:async()=>{}};
  for(const prewarm_stage of ['basis','cards']) {
    const f=bridge({ledger,dashboard,assertScopeReadOnly:async()=>{}});
    await f.call({...input,prewarm_only:true,prewarm_stage},admin);
    const context={run_id:run.id,session_id:run.session_id,prewarm_only:true,prepare_stage:prewarm_stage,deadline:26000};
    await f.guard(context);
    for(const prepare_stage of [undefined,null,'prepare','confirm',prewarm_stage==='basis'?'cards':'basis'])
      await assert.rejects(f.guard({...context,prepare_stage}),/BACKGROUND_PREWARM_DENIED/);
    await assert.rejects(f.guard({...context,confirm_only:true}),/BACKGROUND_PREWARM_DENIED/);
    await assert.rejects(f.guard({...context,deadline:26001}),/BACKGROUND_PREWARM_DENIED/);
    await assert.rejects(f.guard({...context,deadline:1000}),/BACKGROUND_PREWARM_TIMEOUT/);
    await assert.rejects(f.guard({...context,run_id:'other'}),/BACKGROUND_LEASE_LOST/);
  }
  for(const mode of ['prewarm_only','prewarm_confirm_only']) {
    const f=bridge({ledger,dashboard,assertScopeReadOnly:async()=>{}});
    await f.call({...input,[mode]:true},admin);
    const context={run_id:run.id,session_id:run.session_id,prewarm_only:true,
      ...(mode==='prewarm_confirm_only'?{confirm_only:true}:{}),deadline:11000,prepare_stage:'basis'};
    await assert.rejects(f.guard(context),/BACKGROUND_PREWARM_DENIED/);
  }
});

test('ordinary Mini App contexts and arbitrary worker actions never obtain owner access',async()=>{
  const f=bridge();
  for(const [args,ctx] of [[input,{}],[input,{initData:{user:{id:12345}}}],
    [{...input,action:'prepare'},admin],[{...input,user_id:12345},admin],[{runner_id:'invalid'},admin],
    ...['true',1,null,{}].map(retry=>[{...input,retry},admin]),
    ...['true',1,null,{},[]].map(skip_analytics=>[{...input,skip_analytics},admin]),
    ...['true',1,null,{},[]].map(yield_only=>[{...input,yield_only},admin]),
    ...[true,false].flatMap(yield_only=>[{retry:true},{retry:false},{status_only:true},{prewarm_only:true},{skip_analytics:true},{skip_analytics:false}]
      .map(other=>[{...input,...other,yield_only},admin])),
    ...[true,false].flatMap(skip_analytics=>[
      [{...input,status_only:true,skip_analytics},admin],[{...input,prewarm_only:true,skip_analytics},admin]]),
    ...[false,'true',1,null,{}].map(status_only=>[{...input,status_only},admin]),
    ...[true,false].map(retry=>[{...input,status_only:true,retry},admin]),
    ...[false,'true',1,null,{}].map(prewarm_only=>[{...input,prewarm_only},admin]),
    ...[{retry:true},{retry:false},{status_only:true}].map(other=>[{...input,prewarm_only:true,...other},admin])]) {
    await denied(()=>f.call(args,ctx));
  }
  assert.equal(f.accesses(),0);
  const old=bridge({version:0});await denied(()=>old.call(input,admin));
  assert.equal(old.accesses(),0);
});

test('version-1 access without the supported scoped-history capability never obtains owner access',async()=>{
  for(const scopedHistoryVersion of [undefined,null,0,2,'1',NaN,{}]) {
    const f=bridge({scopedHistoryVersion});
    await denied(()=>f.call(input,admin));
    assert.equal(f.accesses(),0);
  }
});

test('administrative bridge invokes only the fixed worker tick',async()=>{
  const f=bridge();assert.equal((await f.call(input,admin)).state,'complete');assert.equal(f.accesses(),1);
  assert.equal((await f.call({...input,retry:true},admin)).retry,true);
  assert.equal((await f.call({...input,retry:false},admin)).retry,false);
  assert.equal((await f.call({...input,skip_analytics:true},admin)).skip_analytics,true);
  assert.equal((await f.call({...input,skip_analytics:false},admin)).skip_analytics,false);
  assert.equal((await f.call({...input,yield_only:true},admin)).yield_only,true);
  assert.equal((await f.call({...input,yield_only:false},admin)).yield_only,false);
});

test('personal analytics requires both the supported runtime protocol and implementation',async()=>{
  for(const personalAnalyticsVersion of [undefined,null,0,2,'1',NaN,{}]) {
    const f=bridge({personalAnalyticsVersion});
    await denied(()=>f.call(input,admin));assert.equal(f.accesses(),0);
  }
  for(const analytics of [undefined,{version:0,refresh:async()=>{}},{version:1}]) {
    const f=bridge({analytics});await denied(()=>f.call(input,admin));
  }
});

test('administrative recovery reads status without invoking a tick or accepting a retry',async()=>{
  const f=bridge();
  const result=await f.call({...input,status_only:true},admin);
  assert.equal(result.state,'running');assert.equal(result.read_only,true);assert.equal(f.accesses(),1);
  assert.equal(result.acknowledgement_for,input.runner_id);
  await denied(()=>f.call({...input,status_only:true},{}));
});

test('dashboard preparation requires an explicit supported access capability',async()=>{
  for(const dashboard of [undefined,{version:0,prewarm:async()=>{}},{version:1}]) {
    const f=bridge({dashboard});assert.deepEqual(JSON.parse(JSON.stringify(await f.call({...input,prewarm_only:true},admin))),
      {state:'failed',execution_code:'BACKGROUND_ACCESS_DENIED'});
  }
  const f=bridge({dashboard:{version:1,prewarm:async()=>{}}});
  assert.equal((await f.call({...input,prewarm_only:true},admin)).state,'prepared');
});

test('cache-only guard requires the exact recent successful completed run and bounded deadline',async()=>{
  const run={id:input.runner_id+':1',session_id:'session',stage:'done',lease:null,gift_complete:true,history_complete:true};
  const ledger={state:'complete',run,last_success_at:new Date(900).toISOString(),last_finished_at:new Date(900).toISOString()};
  const f=bridge({ledger,dashboard:{version:1,prewarm:async()=>{}}});
  await f.call({...input,prewarm_only:true},admin);
  const context={run_id:run.id,session_id:'session',prewarm_only:true,deadline:26000};await f.guard(context);
  for(const change of [{run_id:'other'},{session_id:'other'}])
    await assert.rejects(()=>f.guard({...context,...change}),/BACKGROUND_LEASE_LOST/);
  for(const deadline of [26001,null])await assert.rejects(()=>f.guard({...context,deadline}),/BACKGROUND_PREWARM_DENIED/);
  await assert.rejects(()=>f.guard({...context,deadline:1000}),/BACKGROUND_PREWARM_TIMEOUT/);
  for(const state of ['running','partial','failed']) {ledger.state=state;await assert.rejects(()=>f.guard(context),/BACKGROUND_LEASE_LOST/);}
  ledger.state='complete';run.history_complete=false;await assert.rejects(()=>f.guard(context),/BACKGROUND_LEASE_LOST/);
  run.history_complete=true;ledger.last_finished_at=new Date(-299000).toISOString();ledger.last_success_at=ledger.last_finished_at;
  await assert.rejects(()=>f.guard(context),/BACKGROUND_LEASE_LOST/);
  const normal=bridge({ledger,dashboard:{version:1,prewarm:async()=>{}}});await normal.call(input,admin);
  await assert.rejects(()=>normal.guard(context),/BACKGROUND_PREWARM_DENIED/);
});

test('confirmation is an exclusive capability with a distinct read-only deadline',async()=>{
  const dashboard={version:1,prewarm:async()=>{},confirmation_version:1,prepare:async()=>{},confirm:async()=>{}};
  const run={id:input.runner_id+':1',session_id:'session',stage:'done',lease:null,gift_complete:true,history_complete:true};
  const ledger={state:'complete',run,last_success_at:new Date(900).toISOString(),last_finished_at:new Date(900).toISOString()};
  for(const extra of [{prewarm_only:true},{status_only:true},{retry:false},{yield_only:false},{skip_analytics:false}]) {
    const f=bridge({dashboard,assertScopeReadOnly:async()=>{}});
    await denied(()=>f.call({...input,prewarm_confirm_only:true,...extra},admin));
    assert.equal(f.accesses(),0);
  }
  for(const value of [false,'true',1,null,{}]) {
    const f=bridge();
    await denied(()=>f.call({...input,prewarm_confirm_only:value},admin));
    assert.equal(f.accesses(),0);
  }
  for(const options of [{dashboard},{dashboard:{...dashboard,confirmation_version:0},assertScopeReadOnly:async()=>{}},
    {dashboard:{...dashboard,confirm:undefined},assertScopeReadOnly:async()=>{}}]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await bridge(options).call({...input,prewarm_confirm_only:true},admin))),
      {state:'failed',execution_code:'BACKGROUND_PREWARM_UNSUPPORTED'});
  }
  const f=bridge({ledger,dashboard,assertScopeReadOnly:async()=>{}});
  assert.equal((await f.call({...input,prewarm_confirm_only:true},admin)).read_only,true);
  const context={run_id:run.id,session_id:run.session_id,prewarm_only:true,confirm_only:true,deadline:11000};
  await f.guard(context);
  await assert.rejects(()=>f.guard({...context,deadline:11001}),/BACKGROUND_PREWARM_DENIED/);
  await assert.rejects(()=>f.guard({...context,deadline:1000}),/BACKGROUND_PREWARM_TIMEOUT/);
  await assert.rejects(()=>f.guard({...context,confirm_only:false}),/BACKGROUND_PREWARM_DENIED/);
  await assert.rejects(()=>f.guard({...context,run_id:'other'}),/BACKGROUND_LEASE_LOST/);
  const prepare=bridge({ledger,dashboard,assertScopeReadOnly:async()=>{}});
  await prepare.call({...input,prewarm_only:true},admin);
  await assert.rejects(()=>prepare.guard(context),/BACKGROUND_PREWARM_DENIED/);
});

test('preparation and confirmation return only fixed known failures instead of host-wrapped exception text',async()=>{
  const secret='synthetic-secret-must-not-leak',dashboard={version:1,prewarm:async()=>{},
    confirmation_version:1,prepare:async()=>{},confirm:async()=>{}};
  for(const code of ['BACKGROUND_PREWARM_TIMEOUT','BACKGROUND_PREWARM_DENIED','BACKGROUND_LEASE_LOST',
    'BACKGROUND_SCOPE_CHANGED','BACKGROUND_ACCESS_DENIED','BACKGROUND_RULES_CHANGED',
    'BACKGROUND_PREWARM_CONFIRMATION_FAILED','BACKGROUND_PREWARM_INCOMPLETE','BACKGROUND_PREWARM_UNSUPPORTED']) {
    for(const failure of [new BackgroundMonitoringError(code),new Error(code)]) {
      failure.stack=secret;failure.parameters={private:secret};failure.cause=Error(secret);
      for(const mode of ['prewarm_only','prewarm_confirm_only']) {
        const f=bridge({dashboard,assertScopeReadOnly:async()=>{},worker:{
          prewarm:async()=>{throw failure;},confirmPreparation:async()=>{throw failure;},
        }});
        const result=await f.call({...input,[mode]:true},admin);
        assert.deepEqual(JSON.parse(JSON.stringify(result)),{state:'failed',execution_code:code});
        assert.ok(!JSON.stringify(result).includes(secret));
      }
    }
  }
});

test('unknown preparation errors still throw without acquiring a preparation result',async()=>{
  const dashboard={version:1,prewarm:async()=>{},confirmation_version:1,prepare:async()=>{},confirm:async()=>{}};
  const failures=[Error('private provider text'),Error('BACKGROUND_PREWARM_TIMEOUT extra private text'),
    Object.assign(Error('BACKGROUND_PREWARM_TIMEOUT'),{code:'BACKGROUND_SCOPE_CHANGED'}),
    Object.assign(Error('private provider text'),{code:'BACKGROUND_PREWARM_TIMEOUT'}),Error('UNKNOWN_CODE')];
  for(const failure of failures) {
    const f=bridge({dashboard,assertScopeReadOnly:async()=>{},worker:{
      prewarm:async()=>{throw failure;},confirmPreparation:async()=>{throw failure;},
    }});
    for(const mode of ['prewarm_only','prewarm_confirm_only'])
      await assert.rejects(f.call({...input,[mode]:true},admin),error=>error===failure);
  }
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


test('normal ticks and status reads return only fixed application failures, not ambiguous host aborts',async()=>{
  const secret='synthetic-provider-secret',codes=['BACKGROUND_ANALYTICS_INVALID','BACKGROUND_RULES_INVALID',
    'BACKGROUND_STATE_INVALID','BACKGROUND_CONFIGURATION','BACKGROUND_CLOCK_INVALID','BACKGROUND_RUNNER_INVALID',
    'BACKGROUND_SCOPE_INVALID','BACKGROUND_CONFLICT','BACKGROUND_GIFT_INVALID','BACKGROUND_HISTORY_INVALID',
    'BACKGROUND_SCOPE_CHANGED','BACKGROUND_ACCESS_DENIED','BACKGROUND_LEASE_LOST','BACKGROUND_RULES_CHANGED'];
  const failures=[...codes.flatMap(code=>[new BackgroundMonitoringError(code),Error(code)].map(error=>[error,code])),
    [Error(secret),'BACKGROUND_OPERATION_FAILED'],[Error('BACKGROUND_SCOPE_CHANGED '+secret),'BACKGROUND_OPERATION_FAILED'],
    [Object.assign(Error('BACKGROUND_SCOPE_CHANGED'),{code:'BACKGROUND_LEASE_LOST'}),'BACKGROUND_OPERATION_FAILED'],
    [Object.assign(Error(secret),{code:'BACKGROUND_SCOPE_CHANGED'}),'BACKGROUND_OPERATION_FAILED'],
    [null,'BACKGROUND_OPERATION_FAILED']];
  for(const [failure,execution_code] of failures)for(const mode of ['tick','status']) {
    if(failure){failure.stack=secret;failure.parameters={log:[secret]};failure.cause=Error(secret);}
    const f=bridge({worker:{[mode]:async()=>{throw failure;}}});
    const result=await f.call({...input,...(mode==='status'?{status_only:true}:{})},admin);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{state:'failed',execution_code});
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});
