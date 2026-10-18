import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {MONITORING_ENDPOINT,RUNNER_LIMITS,MonitoringAdminError,parseMonitoringArgs,createMonitoringAdminApi,monitoringSummary,runBackgroundMonitoring,monitoringMain,loadMonitoringSources} from '../tools/run-background-monitoring.mjs';
import {adminModuleSources} from '../tools/admin-module-sources.mjs';

const token='app123:synthetic_test_secret',runner='a'.repeat(64),start=Date.parse('2026-10-14T12:00:00.000Z');
const canonical={'lib/private-config':'export const ownerTelegramId=42;',
  'lib/runtime':'export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;\nexport const PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION=1;\nexport const PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION=1;\nexport function createPrivateBackgroundMonitoringAccess() {}',
  'lib/existing':'export const value=1;','endpoints/unrelated':'private source not needed'};
const local={coreSource:"import {value} from './existing.js';\nexport const core=value;",
  entrypointSource:"import {core} from '../lib/background-monitoring.js';\nexport default async()=>core;"};
function fixture(results,options={}) {
  let now=start;const calls=[],output=[],waits=[];
  const args={enabled:true,api:{getFiles:async value=>{calls.push({operation:'get',value});return {canonical_modules:canonical};},
    runFunction:async(sources,input,value)=>{calls.push({operation:'run',sources,input,value,at:now});const result=results.shift();if(result instanceof Error)throw result;return {result,logs:['private token, address and source must not leak']};}},
    loadSources:()=>local,now:()=>now,monotonic:()=>now-start,sleep:async ms=>{waits.push(ms);now+=ms;},random:()=>runner,emit:value=>output.push(value),...options};
  return {args,calls,output,waits,run:()=>runBackgroundMonitoring(args)};
}

test('disabled monitoring does not load credentials modules or contact the host',async()=>{
  const f=fixture([],{enabled:false,loadSources:()=>{throw Error('must not read');},random:()=>{throw Error('must not generate');}});
  assert.deepEqual(await f.run(),{state:'disabled'});assert.deepEqual(f.calls,[]);
  const output=[];assert.equal(await monitoringMain({args:[],env:{},emit:value=>output.push(value)}),0);assert.deepEqual(output,[{state:'disabled'}]);
});

test('runner arguments allow only one explicit app and optional check, never arbitrary operations',()=>{
  assert.deepEqual(parseMonitoringArgs(['--app-id','123','--check']),{appId:'123',check:true});
  for(const args of [[],['--app-id','00123'],['--app-id','123','--app-id','123'],['--app-id','123','--check','--check'],
    ['--app-id','123','--sql','DELETE'],['--app-id','123','--endpoint','unsafe'],['--app-id','123','--source','private'],['--app-id','123','--token',token]])assert.throws(()=>parseMonitoringArgs(args));
});

test('explicit token destination and environment checks happen before any administrative request',()=>{
  let requests=0;const request=()=>{requests++;throw Error('must not request');};
  for(const options of [{token:'app456:wrong',appId:'123'}, {token,appId:'123',env:{TG_CLOUD_API_URL:'https://example.invalid'}},
    {token,appId:'123',env:{TGCLOUD_BETA:'1'}},{token:null,appId:'123'},{token,appId:'0123'}])assert.throws(()=>createMonitoringAdminApi({env:{},fetch:request,...options}));
  assert.equal(requests,0);
});

test('administrative transport pins the official get/run protocol, identity and redirects',async()=>{
  const requests=[],api=createMonitoringAdminApi({token,appId:'123',env:{TGCLOUD_DEBUG:'true'},fetch:async(url,options)=>{
    requests.push({url,options});return Response.json({ok:true,result:requests.length===1?{canonical_modules:canonical}:{result:{state:'complete'}}});
  }});
  assert.deepEqual(await api.getFiles(),{canonical_modules:canonical});
  assert.deepEqual(await api.runFunction({'lib/a':'source'},{runner_id:runner}),{result:{state:'complete'}});
  assert.equal(requests[0].url,'https://cloud.telegram.org/app123/manage/get');assert.equal(requests[0].options.method,'GET');
  assert.equal(requests[1].url,'https://cloud.telegram.org/app123/manage/run');assert.equal(requests[1].options.method,'POST');
  for(const {options} of requests){assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);assert.ok(options.signal instanceof AbortSignal);}
  assert.deepEqual(JSON.parse(requests[1].options.body),{module:MONITORING_ENDPOINT,sources:{'lib/a':'source'},args:{runner_id:runner},ctx:{background_worker:'price-monitoring-v1'}});
  assert.throws(()=>api.runFunction({}, {runner_id:runner,action:'approve'}));assert.throws(()=>api.runFunction({}, {runner_id:'not-a-runner'}));assert.equal(requests.length,2);
  for(const retry of ['true',1,null,{}])assert.throws(()=>api.runFunction({}, {runner_id:runner,retry}));
  await api.runFunction({}, {runner_id:runner,retry:true});
  assert.deepEqual(JSON.parse(requests[2].options.body).args,{runner_id:runner,retry:true});
  await api.runFunction({}, {runner_id:runner,status_only:true});
  assert.deepEqual(JSON.parse(requests[3].options.body).args,{runner_id:runner,status_only:true});
  for(const status_only of [false,'true',1,null,{}])assert.throws(()=>api.runFunction({}, {runner_id:runner,status_only}));
  for(const retry of [true,false])assert.throws(()=>api.runFunction({}, {runner_id:runner,status_only:true,retry}));
  assert.equal(requests.length,4);
  await api.runFunction({}, {runner_id:runner,prewarm_only:true});
  assert.deepEqual(JSON.parse(requests[4].options.body).args,{runner_id:runner,prewarm_only:true});
  for(const prewarm_only of [false,'true',1,null,{}])assert.throws(()=>api.runFunction({}, {runner_id:runner,prewarm_only}));
  for(const input of [{retry:true},{retry:false},{status_only:true}])assert.throws(()=>api.runFunction({}, {runner_id:runner,prewarm_only:true,...input}));
  assert.equal(requests.length,5);
  for(const skip_analytics of ['true',1,null,{},[]])assert.throws(()=>api.runFunction({}, {runner_id:runner,skip_analytics}));
  for(const skip_analytics of [true,false]) {
    for(const mode of [{status_only:true},{prewarm_only:true}])assert.throws(()=>api.runFunction({}, {runner_id:runner,...mode,skip_analytics}));
    await api.runFunction({}, {runner_id:runner,skip_analytics});
    assert.deepEqual(JSON.parse(requests.at(-1).options.body).args,{runner_id:runner,skip_analytics});
  }
  assert.equal(requests.length,7);
});

test('runner reserves two bounded requests before allowing optional analytics',async()=>{
  const reserve=2*RUNNER_LIMITS.request_ms+1000;
  for(const [remaining,steps,skip] of [[reserve-1,2,true],[reserve,2,false],[reserve+1,2,false],[reserve+1,1,true]]) {
    const f=fixture([{state:'complete'}],{limits:{duration_ms:remaining,steps}});
    assert.equal((await f.run()).state,'complete');
    const input=f.calls.find(call=>call.operation==='run').input;
    assert.deepEqual(input,{runner_id:runner,...(skip?{skip_analytics:true}:{})});
  }
});

test('analytics budget uses elapsed monotonic time including source loading despite wall-clock changes',async()=>{
  const reserve=2*RUNNER_LIMITS.request_ms+1000;
  for(const [elapsed,wallShift,skip] of [[80000,-3600000,true],[0,3600000,false]]) {
    let monotonic=0,wall=start;
    const f=fixture([{state:'complete'}],{limits:{duration_ms:reserve+79000},now:()=>wall,monotonic:()=>monotonic});
    f.args.api.getFiles=async()=>{monotonic+=elapsed;wall+=wallShift;return {canonical_modules:canonical};};
    assert.equal((await f.run()).state,'complete');
    const call=f.calls.find(row=>row.operation==='run');
    assert.deepEqual(call.input,{runner_id:runner,...(skip?{skip_analytics:true}:{})});
    assert.equal(call.value.timeoutMs,Math.min(RUNNER_LIMITS.request_ms,reserve+79000-elapsed));
  }
});

test('acknowledged completion prepares the dashboard once in a separate bounded optional request',async()=>{
  const f=fixture([{state:'complete',checked:2,total:2,runner_acknowledged:true},{state:'prepared',private_data:token}]);
  f.args.api.getFiles=async()=>({canonical_modules:{...canonical,'lib/runtime':canonical['lib/runtime']+'\nexport const PRIVATE_BACKGROUND_DASHBOARD_PREWARM_VERSION=1;'}});
  assert.deepEqual(await f.run(),{state:'complete',checked:2,total:2});
  assert.deepEqual(f.calls.map(call=>call.input),[{runner_id:runner},{runner_id:runner,prewarm_only:true}]);
  assert.equal(f.calls[1].value.timeoutMs,RUNNER_LIMITS.prewarm_ms);
  assert.deepEqual(f.output,[{state:'complete',checked:2,total:2},{dashboard_preparation:'prepared'}]);
});

test('dashboard preparation errors never retry or convert a saved monitoring success to failure',async()=>{
  for(const [failure,expected] of [
    [new MonitoringAdminError('network_error','prewarm'),{error:'network_error'}],
    [Object.assign(new MonitoringAdminError('remote_error','prewarm',400,'execution',400),{description:token,parameters:{log:[token]}}),
      {error:'remote_error',http_status:400,remote_error:'execution',remote_code:400}],
    [Error(token),{error:'unexpected_error'}],
    [{state:'failed'},{error:'invalid_result'}],[{arbitrary:token},{error:'invalid_result'}],
  ]) {
    const f=fixture([{state:'complete',runner_acknowledged:true},failure]);
    f.args.api.getFiles=async()=>({canonical_modules:{...canonical,'lib/runtime':canonical['lib/runtime']+'\nexport const PRIVATE_BACKGROUND_DASHBOARD_PREWARM_VERSION=1;'}});
    assert.deepEqual(await f.run(),{state:'complete'});
    assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[]);
    assert.deepEqual(f.output,[{state:'complete'},{dashboard_preparation:'failed',...expected,stage:'prewarm'}]);
    assert.ok(!JSON.stringify(f.output).includes(token));
  }
});

test('dashboard preparation is skipped for old runtimes, unacknowledged cycles and exhausted budgets',async()=>{
  for(const mode of ['old_runtime','unacknowledged','partial','time','steps']) {
    const f=fixture([{state:mode==='partial'?'partial':'complete',runner_acknowledged:mode!=='unacknowledged'}],
      mode==='time'?{limits:{duration_ms:RUNNER_LIMITS.prewarm_ms-1}}:mode==='steps'?{limits:{steps:1}}:{});
    f.args.api.getFiles=async()=>({canonical_modules:{...canonical,'lib/runtime':canonical['lib/runtime']+(mode==='old_runtime'?'':'\nexport const PRIVATE_BACKGROUND_DASHBOARD_PREWARM_VERSION=1;')}});
    assert.equal((await f.run()).state,mode==='partial'?'partial':'complete');
    assert.equal(f.calls.length,1);assert.equal(f.output.length,1);
  }
});

test('acknowledged lost-response recovery can prepare once without replaying the completed tick',async()=>{
  const f=fixture([new MonitoringAdminError('network_error','tick'),{state:'complete',runner_acknowledged:true},{state:'skipped'}]);
  f.args.api.getFiles=async()=>({canonical_modules:{...canonical,'lib/runtime':canonical['lib/runtime']+'\nexport const PRIVATE_BACKGROUND_DASHBOARD_PREWARM_VERSION=1;'}});
  assert.deepEqual(await f.run(),{state:'complete'});
  assert.deepEqual(f.calls.map(call=>call.input),[{runner_id:runner},{runner_id:runner,status_only:true},{runner_id:runner,prewarm_only:true}]);
  assert.deepEqual(f.output.at(-1),{dashboard_preparation:'skipped'});
});

test('timeouts and remote errors are bounded and never echoed or retried',async()=>{
  let requests=0;const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async(_url,{signal})=>{
    requests++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private provider URL and token')),{once:true}));
  }});
  await assert.rejects(api.getFiles({timeoutMs:5}),{message:'BACKGROUND_MONITORING_STOPPED'});assert.equal(requests,1);
  for(const response of [Response.json({ok:false,description:token}),Response.json({ok:true,result:{secret:token}},{status:302}),new Response(token)]) {
    const failed=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>response});
    await assert.rejects(failed.getFiles(),{message:'BACKGROUND_MONITORING_STOPPED'});
  }
  const oversized=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>new Response('x'.repeat(RUNNER_LIMITS.response_bytes+1))});
  await assert.rejects(oversized.runFunction({}, {runner_id:runner}),{message:'BACKGROUND_MONITORING_STOPPED'});
});

test('read-only check builds only the needed deployed dependency closure without invoking the worker',async()=>{
  const f=fixture([],{enabled:false,check:true});assert.deepEqual(await f.run(),{state:'ready',modules:4});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'get');assert.deepEqual(f.waits,[]);
  const missing=fixture([],{loadSources:()=>({...local,coreSource:"import './missing.js';"})});
  await assert.rejects(missing.run(),/Missing administration dependency/);assert.equal(missing.calls.length,1);
});

test('an interrupted successful source response retries only the read-only download before starting the worker',async()=>{
  let reads=0,writes=0,loads=0;
  const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async(url)=>{
    if(url.endsWith('/get')) {
      assert.equal(loads,0);assert.equal(writes,0);
      if(++reads===1) {
        let chunks=0;
        return new Response(new ReadableStream({pull(controller){
          if(chunks++===0)controller.enqueue(new TextEncoder().encode('{"ok":true,"result":'));
          else controller.error(new TypeError(token+' interrupted source body'));
        }}),{status:200});
      }
      return Response.json({ok:true,result:{canonical_modules:canonical}});
    }
    writes++;return Response.json({ok:true,result:{result:{state:'complete'}}});
  }});
  const f=fixture([],{api,loadSources:()=>{loads++;assert.equal(reads,2);return local;}});
  assert.deepEqual(await f.run(),{state:'complete'});
  assert.equal(reads,2);assert.equal(writes,1);assert.equal(loads,1);assert.deepEqual(f.waits,[1000]);
  assert.deepEqual(f.output,[{state:'recovering',error:'network_error',stage:'get_files',http_status:200},{state:'complete'}]);
  assert.ok(!JSON.stringify(f.output).includes(token));
});

test('source recovery has two retries with bounded backoff and preserves the terminal failure diagnostics',async()=>{
  for(const [reason,httpStatus] of [['network_error',200],['request_timeout',200],['http_error',503]]) {
    let reads=0,loads=0,writes=0;const failure=new MonitoringAdminError(reason,'get_files',httpStatus);
    const f=fixture([],{loadSources:()=>{loads++;return local;},api:{
      getFiles:async()=>{reads++;throw failure;},runFunction:async()=>{writes++;return {result:{state:'complete'}};}}});
    await assert.rejects(f.run(),error=>error===failure);
    assert.equal(reads,3);assert.equal(loads,0);assert.equal(writes,0);assert.deepEqual(f.waits,[1000,2000]);
    assert.deepEqual(f.output,Array.from({length:2},()=>({state:'recovering',error:reason,stage:'get_files',http_status:httpStatus})));
  }
});

test('source retries use the original deadline and never start after waiting exhausts it',async()=>{
  for(const [budget,elapsedBeforeFailure,waitElapsed,expectedReads,expectedWaits] of [
    [1000,0,1000,1,[]],[2000,1000,1000,1,[]],[2000,0,2100,1,[1000]],
    [5000,3000,1000,2,[1000]],
  ]) {
    let elapsed=0,reads=0;const timeouts=[],waits=[],failure=new MonitoringAdminError('network_error','get_files',200);
    const f=fixture([],{limits:{duration_ms:budget},monotonic:()=>elapsed,sleep:async ms=>{waits.push(ms);elapsed+=waitElapsed;},
      api:{getFiles:async({timeoutMs})=>{timeouts.push(timeoutMs);reads++;elapsed+=elapsedBeforeFailure;throw failure;},
        runFunction:async()=>{throw Error('must not execute');}}});
    await assert.rejects(f.run(),error=>error===failure);
    assert.equal(reads,expectedReads);assert.deepEqual(waits,expectedWaits);
    assert.equal(timeouts[0],budget);
    if(reads===2)assert.equal(timeouts[1],1000);
  }
  let readings=0,requests=0;
  const alreadyExpired=fixture([],{limits:{duration_ms:1},monotonic:()=>readings++===0?0:2,
    api:{getFiles:async()=>{requests++;return {canonical_modules:canonical};}}});
  await assert.rejects(alreadyExpired.run(),error=>error.reason==='request_timeout'&&error.stage==='get_files');
  assert.equal(requests,0);
});

test('source retries retain elapsed time when deciding whether optional analytics fits',async()=>{
  let elapsed=0,reads=0,loads=0;const sourceTimeouts=[],inputs=[];
  const f=fixture([],{limits:{duration_ms:260000},monotonic:()=>elapsed,sleep:async ms=>{elapsed+=ms;},
    loadSources:()=>{loads++;return local;},api:{
      getFiles:async({timeoutMs})=>{sourceTimeouts.push(timeoutMs);reads++;elapsed+=80000;
        if(reads===1)throw new MonitoringAdminError('network_error','get_files',200);
        return {canonical_modules:canonical};},
      runFunction:async(_sources,input,{timeoutMs})=>{inputs.push({input,timeoutMs});return {result:{state:'complete'}};}}});
  assert.deepEqual(await f.run(),{state:'complete'});assert.equal(reads,2);assert.equal(loads,1);
  assert.deepEqual(sourceTimeouts,[90000,90000]);
  assert.deepEqual(inputs,[{input:{runner_id:runner,skip_analytics:true},timeoutMs:90000}]);
});

test('source authentication, malformed responses, size and remote execution failures are not retried',async()=>{
  const cases=[
    ...[400,401,403,429].map(status=>[()=>new Response(token,{status}),'http_error',status]),
    [()=>new Response('{'+token),'invalid_json',200],
    [()=>Response.json({ok:true,secret:token}),'invalid_envelope',200],
    [()=>Response.json({ok:true,result:{}}),'invalid_response',undefined],
    [()=>new Response('x'.repeat(RUNNER_LIMITS.source_bytes+1)),'response_too_large',200],
    ...[200,400,500].map(status=>[()=>Response.json({ok:false,error_type:'CODE_RUN_FAILED',error_code:400,description:token},{status}),'remote_error',status]),
  ];
  for(const [response,reason,status] of cases) {
    let requests=0,loads=0;
    const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>{requests++;return response();}});
    const f=fixture([],{api,loadSources:()=>{loads++;return local;}});
    await assert.rejects(f.run(),error=>error.reason===reason&&error.stage==='get_files'&&error.http_status===status);
    assert.equal(requests,1);assert.equal(loads,0);assert.deepEqual(f.waits,[]);assert.deepEqual(f.output,[]);
  }
  const wrongStage=fixture([],{api:{getFiles:async()=>{throw new MonitoringAdminError('network_error','tick',200);}}});
  await assert.rejects(wrongStage.run(),error=>error.reason==='network_error'&&error.stage==='tick');
  assert.deepEqual(wrongStage.waits,[]);assert.deepEqual(wrongStage.output,[]);
});

test('worker waits resume with the same runner ID and sanitized progress only',async()=>{
  const f=fixture([{state:'running',checked:1,total:3,token,items:['gift']},
    {state:'waiting',checked:2,total:3,retry_at:new Date(start+65000).toISOString(),provider_url:'private'},
    {state:'busy',retry_at:new Date(start+67000).toISOString()},
    {state:'complete',checked:3,total:3,proposals:1,account:'private'}]);
  assert.deepEqual(await f.run(),{state:'complete',checked:3,total:3,proposals:1});
  const runs=f.calls.filter(row=>row.operation==='run');assert.equal(runs.length,4);
  assert.ok(runs.every(row=>Object.keys(row.input).join() === 'runner_id'&&row.input.runner_id===runner));
  assert.ok(runs[2].at>=start+65000);assert.ok(runs[3].at>=start+67000);
  assert.ok(f.waits.every(ms=>ms<=60000));assert.ok(!JSON.stringify(f.output).includes('private'));assert.ok(!JSON.stringify(f.output).includes(token));
  assert.equal(runs[0].sources['lib/private-config'],canonical['lib/private-config']);assert.equal(runs[0].sources['lib/background-monitoring'],local.coreSource);
  assert.equal(runs[0].sources['endpoints/unrelated'],undefined);
});

test('a manual retry is sent only on the first tick and never repeats after a terminal failure',async()=>{
  const f=fixture([{state:'running'},{state:'waiting',retry_at:new Date(start+3000).toISOString()},{state:'complete'}],{retry:true});
  assert.equal((await f.run()).state,'complete');
  assert.deepEqual(f.calls.filter(row=>row.operation==='run').map(row=>row.input),
    [{runner_id:runner,retry:true},{runner_id:runner},{runner_id:runner}]);
  const failed=fixture([{state:'failed'},{state:'complete'}],{retry:true});
  assert.equal((await failed.run()).state,'failed');assert.equal(failed.calls.filter(row=>row.operation==='run').length,1);
  const check=fixture([],{check:true,retry:true});await check.run();assert.equal(check.calls.length,1);
});

test('a lost committed response recovers from read-only status without replaying a manual retry',async()=>{
  let durable=null,ticks=0,at=start;const calls=[],output=[],waits=[];
  const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async(url,options)=>{
    if(url.endsWith('/get'))return Response.json({ok:true,result:{canonical_modules:canonical}});
    const input=JSON.parse(options.body).args;calls.push({input,at});
    if(input.status_only)return Response.json({ok:true,result:{result:durable}});
    if(++ticks===1) {durable={state:'running',checked:1,total:2,retry_at:new Date(start+65000).toISOString()};throw TypeError(token+' response lost after commit');}
    durable={state:'complete',checked:2,total:2};return Response.json({ok:true,result:{result:durable}});
  }});
  const result=await runBackgroundMonitoring({api,enabled:true,retry:true,loadSources:()=>local,random:()=>runner,
    now:()=>at,monotonic:()=>at-start,sleep:async ms=>{waits.push(ms);at+=ms;},emit:value=>output.push(value)});
  assert.deepEqual(result,{state:'complete',checked:2,total:2});
  assert.deepEqual(calls.map(row=>row.input),[{runner_id:runner,retry:true},{runner_id:runner,status_only:true},{runner_id:runner}]);
  assert.ok(calls[2].at>=start+65000);assert.equal(ticks,2);assert.ok(waits.every(ms=>ms<=60000));
  assert.deepEqual(output[0],{state:'recovering',error:'network_error',stage:'tick'});
  assert.ok(!JSON.stringify(output).includes(token));
});

test('recovery returns acknowledged terminal status without issuing another tick',async()=>{
  for(const state of ['complete','paused','disabled','partial','blocked','failed','busy']) {
    const f=fixture([new MonitoringAdminError('request_timeout','tick'),{state,runner_acknowledged:true},{state:'complete'}],{retry:true});
    assert.deepEqual(await f.run(),{state});
    assert.deepEqual(f.calls.filter(row=>row.operation==='run').map(row=>row.input),[{runner_id:runner,retry:true},{runner_id:runner,status_only:true}]);
  }
});

test('failure before claiming a run only reads status and cannot repeat a manual retry',async()=>{
  let ticks=0;const inputs=[];
  const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async(url,options)=>{
    if(url.endsWith('/get'))return Response.json({ok:true,result:{canonical_modules:canonical}});
    const input=JSON.parse(options.body).args;inputs.push(input);
    if(!input.status_only){ticks++;return new Response(token,{status:503});}
    return Response.json({ok:true,result:{result:{state:'disabled',runner_acknowledged:false}}});
  }});
  const f=fixture([],{api,retry:true});await assert.rejects(f.run(),error=>error.reason==='recovery_exhausted');assert.equal(ticks,1);
  assert.deepEqual(inputs,[{runner_id:runner,retry:true},...Array.from({length:3},()=>({runner_id:runner,status_only:true}))]);
  assert.deepEqual(f.output[0],{state:'recovering',error:'http_error',stage:'tick',http_status:503});
});

test('recovery waits for leases and provider deadlines before continuing with the same runner',async()=>{
  for(const state of ['running','waiting','busy']) {
    const f=fixture([new MonitoringAdminError('network_error','tick'),{state,retry_at:new Date(start+120000).toISOString()},{state:'complete'}]);
    assert.equal((await f.run()).state,'complete');
    const calls=f.calls.filter(row=>row.operation==='run');assert.equal(calls.length,3);assert.equal(calls[1].input.status_only,true);
    assert.ok(calls[2].at>=start+120000);assert.deepEqual(calls[2].input,{runner_id:runner});
    assert.ok(f.waits.every(ms=>ms<=60000));
  }
});

test('status-read failures have a shared recovery cap and exponential bounded backoff',async()=>{
  const f=fixture([new MonitoringAdminError('network_error','tick'),new MonitoringAdminError('http_error','status',502),
    new MonitoringAdminError('request_timeout','status'),{state:'complete',runner_acknowledged:true}]);
  assert.equal((await f.run()).state,'complete');assert.deepEqual(f.waits,[1000,2000,4000]);
  assert.equal(f.calls.filter(row=>row.input?.status_only).length,3);
  const exhausted=fixture([new MonitoringAdminError('network_error','tick'),...Array.from({length:4},()=>new MonitoringAdminError('network_error','status'))]);
  await assert.rejects(exhausted.run(),error=>error.reason==='recovery_exhausted'&&error.stage==='status');
  assert.equal(exhausted.calls.filter(row=>row.operation==='run').length,4);
  assert.deepEqual(exhausted.waits,[1000,2000,4000]);
});

test('an old complete checkpoint cannot falsely acknowledge a delayed tick claim',async()=>{
  const f=fixture([new MonitoringAdminError('network_error','tick'),
    {state:'complete',checked:161,total:161,runner_acknowledged:false},
    {state:'running',checked:1,total:2,retry_at:new Date(start+120000).toISOString(),runner_acknowledged:true},
    {state:'complete',checked:2,total:2}],{retry:true});
  assert.deepEqual(await f.run(),{state:'complete',checked:2,total:2});
  const calls=f.calls.filter(row=>row.operation==='run');
  assert.deepEqual(calls.map(row=>row.input),[{runner_id:runner,retry:true},{runner_id:runner,status_only:true},{runner_id:runner,status_only:true},{runner_id:runner}]);
  assert.ok(calls[3].at>=start+120000);
  assert.ok(!f.output.some(row=>row.state==='complete'&&row.checked===161));
});

test('unacknowledged terminal checkpoints exhaust only read-only recovery and never report success',async()=>{
  for(const runner_acknowledged of [false,undefined,'true',1]) {
    const f=fixture([new MonitoringAdminError('network_error','tick'),
      ...Array.from({length:3},()=>({state:'complete',checked:161,runner_acknowledged}))],{retry:true});
    await assert.rejects(f.run(),error=>error.reason==='recovery_exhausted'&&error.stage==='status');
    assert.equal(f.calls.filter(row=>row.operation==='run').length,4);
    assert.ok(f.calls.filter(row=>row.operation==='run').slice(1).every(row=>row.input.status_only===true));
    assert.ok(!f.output.some(row=>row.state==='complete'));
  }
});

test('recovery shares the original time and step budgets and does not call ahead of a future lease',async()=>{
  const error=()=>new MonitoringAdminError('network_error','tick');
  const one=fixture([error(),{state:'complete'}],{limits:{steps:1}});
  assert.equal((await one.run()).state,'partial');assert.equal(one.calls.length,2);assert.deepEqual(one.waits,[]);
  const two=fixture([error(),{state:'running'},{state:'complete'}],{limits:{steps:2}});
  assert.equal((await two.run()).state,'partial');assert.equal(two.calls.filter(row=>row.operation==='run').length,2);
  const short=fixture([error(),{state:'complete'}],{limits:{duration_ms:1000}});
  assert.equal((await short.run()).state,'partial');assert.equal(short.calls.length,2);assert.deepEqual(short.waits,[]);
  const lease=fixture([error(),{state:'busy',retry_at:new Date(start+100000).toISOString()},{state:'complete'}],{limits:{duration_ms:5000}});
  assert.equal((await lease.run()).state,'partial');assert.equal(lease.calls.filter(row=>row.operation==='run').length,2);assert.deepEqual(lease.waits,[1000]);
});

test('unknown status and nontransient failures stop without speculative writes',async()=>{
  for(const result of [{state:'unknown'},{},{state:'waiting'},new MonitoringAdminError('http_error','status',403),new MonitoringAdminError('remote_error','status',200)]) {
    const f=fixture([new MonitoringAdminError('network_error','tick'),result,{state:'complete'}],{retry:true});
    await assert.rejects(f.run());assert.equal(f.calls.filter(row=>row.operation==='run').length,2);
    assert.equal(f.calls.at(-1).input.status_only,true);
  }
  for(const error of [new MonitoringAdminError('http_error','tick',400),new MonitoringAdminError('http_error','tick',429),
    new MonitoringAdminError('invalid_response','tick'),new MonitoringAdminError('remote_error','tick',200,'internal',500)]) {
    const f=fixture([error,{state:'complete'}]);await assert.rejects(f.run());assert.equal(f.calls.filter(row=>row.operation==='run').length,1);
  }
});

test('completed running steps do not add a client delay after the server allowance has elapsed',async()=>{
  const f=fixture([{state:'running',retry_at:new Date(start-1000).toISOString()},
    {state:'running'},{state:'complete'}]);
  assert.equal((await f.run()).state,'complete');
  assert.deepEqual(f.waits,[]);
  assert.equal(f.calls.filter(call=>call.operation==='run').length,3);
  const future=fixture([{state:'running',retry_at:new Date(start+2500).toISOString()},{state:'complete'}]);
  await future.run();assert.deepEqual(future.waits,[2500]);
  const contention=fixture([{state:'busy',retry_at:new Date(start).toISOString()},{state:'complete'}]);
  await contention.run();assert.deepEqual(contention.waits,[1000]);
});

test('deployed runtime protocol and owner factory are required before check or execution',async()=>{
  for(const check of [false,true])for(const runtime of [undefined,'// export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;',
    canonical['lib/runtime'].replace('VERSION=1','VERSION=2'),canonical['lib/runtime'].replace('export function','function')]) {
    let requests=0;const f=fixture([],{check,api:{getFiles:async()=>({canonical_modules:{...canonical,'lib/runtime':runtime}}),
      runFunction:async()=>{requests++;throw Error('must not execute');}}});
    await assert.rejects(f.run(),{message:'BACKGROUND_MONITORING_STOPPED'});assert.equal(requests,0);assert.deepEqual(f.output,[]);
  }
});

test('scoped-history capability is required before loading or executing a worker against a version-1 runtime',async()=>{
  const marker='export const PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION=1;';
  for(const check of [false,true])for(const capability of ['',`// ${marker}`,marker.replace('export ',''),marker.replace('const','let'),
    ...['0','2','-1','null','NaN','"1"'].map(value=>marker.replace('VERSION=1',`VERSION=${value}`))]) {
    let reads=0,loads=0,requests=0;
    const runtime=canonical['lib/runtime'].replace(marker,capability);
    const f=fixture([],{check,loadSources:()=>{loads++;return local;},
      api:{getFiles:async()=>{reads++;return {canonical_modules:{...canonical,'lib/runtime':runtime}};},
        runFunction:async()=>{requests++;throw Error('must not execute');}}});
    await assert.rejects(f.run(),{message:'BACKGROUND_MONITORING_STOPPED'});
    assert.equal(reads,1);assert.equal(loads,0);assert.equal(requests,0);assert.deepEqual(f.output,[]);
  }
});

test('terminal worker states and bare busy responses do not trigger further calls',async()=>{
  for(const state of ['complete','partial','paused','disabled','blocked','failed','busy']) {
    const f=fixture([{state}]);assert.equal((await f.run()).state,state);assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[]);
  }
});

test('personal analytics capability is required before loading or executing the worker',async()=>{
  const marker='export const PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION=1;';
  for(const check of [false,true])for(const capability of ['',`// ${marker}`,marker.replace('export ',''),marker.replace('const','let'),
    ...['0','2','-1','null','NaN','"1"'].map(value=>marker.replace('VERSION=1',`VERSION=${value}`))]) {
    let loads=0,requests=0;
    const f=fixture([],{check,loadSources:()=>{loads++;return local;},api:{
      getFiles:async()=>({canonical_modules:{...canonical,'lib/runtime':canonical['lib/runtime'].replace(marker,capability)}}),
      runFunction:async()=>{requests++;throw Error('must not execute');}}});
    await assert.rejects(f.run(),{message:'BACKGROUND_MONITORING_STOPPED'});
    assert.equal(loads,0);assert.equal(requests,0);
  }
});

test('personal analytics logs expose bounded outcomes without provider details',async()=>{
  const personal_analytics={state:'saved',period_days:30,captured_at:new Date(start).toISOString(),cookie:token,html:'private'};
  const safe={state:'saved',period_days:30,captured_at:new Date(start).toISOString()};
  const f=fixture([{state:'complete',personal_analytics}]);
  assert.deepEqual(await f.run(),{state:'complete',personal_analytics:safe});
  assert.deepEqual(f.output,[{state:'complete',personal_analytics:safe}]);
  for(const row of [{state:'saved',period_days:30},{state:'fresh',period_days:365,captured_at:'bad'},
    {state:'unavailable',reason:token},{state:'saved',period_days:90,captured_at:safe.captured_at},
    {state:'limited',retry_at:'bad'},null]) {
    if(row!==null)assert.throws(()=>monitoringSummary({state:'complete',personal_analytics:row}));
  }
  const partial=fixture([{state:'running',personal_analytics:safe}],{limits:{steps:1}});
  assert.deepEqual(await partial.run(),{state:'partial',personal_analytics:safe});
});

test('deadline and step caps keep durable future work pending instead of calling early',async()=>{
  const later=new Date(start+RUNNER_LIMITS.duration_ms+1).toISOString(),f=fixture([{state:'waiting',retry_at:later}]);
  assert.deepEqual(await f.run(),{state:'partial',retry_at:later});assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[]);
  const limited=fixture([{state:'running'},{state:'running'},{state:'complete'}],{limits:{steps:2}});
  assert.equal((await limited.run()).state,'partial');assert.equal(limited.calls.filter(call=>call.operation==='run').length,2);
  const expired=fixture([{state:'waiting',retry_at:new Date(start+1000).toISOString()},{state:'complete'}],{limits:{duration_ms:1000}});
  assert.equal((await expired.run()).state,'partial');assert.equal(expired.calls.filter(call=>call.operation==='run').length,1);
  for(const limits of [{steps:201},{duration_ms:RUNNER_LIMITS.duration_ms+1},{request_ms:1},{steps:0}])await assert.rejects(fixture([],{limits}).run());
});

test('unknown failures and malformed results stop without a speculative retry',async()=>{
  for(const result of [Error('uncertain commit '+token),{state:'unexpected'}, {error:token}, {state:'waiting'}, {state:'complete',checked:-1}]) {
    const f=fixture([result,{state:'complete'}]);await assert.rejects(f.run());assert.equal(f.calls.filter(call=>call.operation==='run').length,1);
  }
  for(const value of [null,{}, {state:'running',retry_at:'tomorrow'},{state:'complete',total:'3'},{state:'complete',proposals:Infinity}])assert.throws(()=>monitoringSummary(value));
});

test('CLI failure logs contain only safe enums even when the administrative failure contains secrets',async t=>{
  let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error(token+' private source');});
  const output=[],exit=await monitoringMain({args:['--app-id','123'],env:{BACKGROUND_MONITORING_ENABLED:'true',TGCLOUD_TOKEN:token},emit:value=>output.push(value)});
  assert.equal(exit,1);assert.deepEqual(output,[{state:'recovering',error:'network_error',stage:'get_files'},
    {state:'recovering',error:'network_error',stage:'get_files'},{state:'failed',error:'network_error',stage:'get_files'}]);assert.equal(requests,3);
});

test('transport diagnostics distinguish HTTP errors, malformed envelopes and remote execution failures without bodies',async()=>{
  for(const [response,expected] of [
    [new Response(token,{status:502}),{reason:'http_error',http_status:502}],
    [new Response(token,{status:400}),{reason:'http_error',http_status:400}],
    [Response.json({secret:token},{status:403}),{reason:'http_error',http_status:403}],
    [Response.json({ok:true,result:{secret:token}},{status:400}),{reason:'http_error',http_status:400}],
    [Response.json({ok:false,error_type:'CODE_RUN_FAILED',error_code:400,description:token,parameters:{log:[token]}},{status:400}),
      {reason:'remote_error',http_status:400,remote_error:'execution',remote_code:400}],
    [Response.json({ok:false,error_type:'ENDPOINT_ERROR',error_code:token,description:token},{status:400}),
      {reason:'remote_error',http_status:400,remote_error:'endpoint'}],
    [Response.json({ok:false,error_type:token,error_code:999999999,description:token},{status:400}),
      {reason:'remote_error',http_status:400,remote_error:'other'}],
    [new Response('{'+token),{reason:'invalid_json',http_status:200}],
    [Response.json({ok:true,secret:token}),{reason:'invalid_envelope',http_status:200}],
    [Response.json({ok:true,secret:token},{status:500}),{reason:'invalid_envelope',http_status:500}],
    [Response.json({ok:false,error_type:'INTERNAL',error_code:500,description:token}),{reason:'remote_error',http_status:200,remote_error:'internal',remote_code:500}],
    [Response.json({ok:false,error_type:'INTERNAL',error_code:500,description:token},{status:500}),{reason:'remote_error',http_status:500,remote_error:'internal',remote_code:500}],
    [Response.json({ok:false,error_type:'ENDPOINT_ERROR',error_code:token,description:token}),{reason:'remote_error',http_status:200,remote_error:'endpoint'}],
    [Response.json({ok:false,error_type:token,error_code:999999999,description:token}),{reason:'remote_error',http_status:200,remote_error:'other'}],
  ]) {
    const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>response});
    await assert.rejects(api.runFunction({}, {runner_id:runner,status_only:true}),error=>{
      assert.equal(error.message,'BACKGROUND_MONITORING_STOPPED');assert.equal(error.stage,'status');
      for(const [key,value] of Object.entries(expected))assert.equal(error[key],value);
      assert.ok(!JSON.stringify(error).includes(token));return true;
    });
  }
});

test('an explicit execution error is never recovered regardless of its HTTP status',async()=>{
  for(const status of [200,400,500])for(const error_type of ['INTERNAL','CODE_RUN_FAILED']) {
    let writes=0;
    const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async(url)=>{
      if(url.endsWith('/get'))return Response.json({ok:true,result:{canonical_modules:canonical}});
      writes++;return Response.json({ok:false,error_type,error_code:500,description:token},{status});
    }});
    const f=fixture([],{api,retry:true});await assert.rejects(f.run(),error=>error.reason==='remote_error'&&error.http_status===status);
    assert.equal(writes,1);assert.deepEqual(f.waits,[]);
  }
});

test('unknown and oversized client-error bodies preserve HTTP failures without retrying',async()=>{
  for(const body of [token,JSON.stringify({ok:true,result:{secret:token}}),'x'.repeat(RUNNER_LIMITS.response_bytes+1)]) {
    let writes=0;
    const api=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async(url)=>{
      if(url.endsWith('/get'))return Response.json({ok:true,result:{canonical_modules:canonical}});
      writes++;return new Response(body,{status:400});
    }});
    const f=fixture([],{api,retry:true});
    await assert.rejects(f.run(),error=>error.reason==='http_error'&&error.http_status===400&&!JSON.stringify(error).includes(token));
    assert.equal(writes,1);assert.deepEqual(f.waits,[]);
  }
});

test('CLI execution-error diagnostics never include the host description or parameters',async t=>{
  let executions=0;t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/get'))return Response.json({ok:true,result:{canonical_modules:canonical}});
    executions++;return Response.json({ok:false,error_type:'CODE_RUN_FAILED',error_code:400,description:token,
      parameters:{log:[token],module:token,time:0.012}},{status:400});
  });
  const output=[],exit=await monitoringMain({args:['--app-id','123'],env:{BACKGROUND_MONITORING_ENABLED:'true',TGCLOUD_TOKEN:token},emit:value=>output.push(value)});
  assert.equal(exit,1);assert.equal(executions,1);
  assert.deepEqual(output,[{state:'failed',error:'remote_error',stage:'tick',http_status:400,remote_error:'execution',remote_code:400}]);
  assert.ok(!JSON.stringify(output).includes(token));
});

test('timeouts bound header and body reads even when a transport ignores abort',async()=>{
  const stalled=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>new Promise(()=>{})});
  await assert.rejects(stalled.runFunction({}, {runner_id:runner,status_only:true},{timeoutMs:5}),error=>error.reason==='request_timeout'&&error.stage==='status');
  let cancelled=false;
  const body=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});
  await assert.rejects(body.runFunction({}, {runner_id:runner},{timeoutMs:5}),error=>error.reason==='request_timeout'&&error.stage==='tick');
  assert.equal(cancelled,true);
  let errorCancelled=false;
  const errorBody=createMonitoringAdminApi({token,appId:'123',env:{},fetch:async()=>new Response(new ReadableStream({cancel(){errorCancelled=true;}}),{status:400})});
  await assert.rejects(errorBody.runFunction({}, {runner_id:runner},{timeoutMs:5}),error=>error.reason==='http_error'&&error.http_status===400&&error.stage==='tick');
  assert.equal(errorCancelled,true);
});

test('actual worker sources fit the administrative closure without reading local ignored configuration',()=>{
  const modules={};
  function visit(directory,prefix){for(const item of readdirSync(directory,{withFileTypes:true})) {
    const name=prefix+'/'+item.name;if(item.isDirectory())visit(new URL(item.name+'/',directory),name);
    else if(item.name.endsWith('.js')&&!['private-config.js','private-refresh-key.js','public-release-config.js'].includes(item.name))modules[name.slice(0,-3)]=readFileSync(new URL(item.name,directory),'utf8');
  }}
  visit(new URL('../tgcloud/lib/',import.meta.url),'lib');visit(new URL('../tgcloud/endpoints/',import.meta.url),'endpoints');
  Object.assign(modules,{'lib/private-config':'export const ownerTelegramId=42;export const marketappToken="synthetic";',
    'lib/private-refresh-key':'export const marketappRefreshKey="synthetic";','lib/public-release-config':'export const publicReleaseConfig={enabled:false};'});
  const source=loadMonitoringSources(),bundle=adminModuleSources(modules,{'lib/background-monitoring':source.coreSource},MONITORING_ENDPOINT,source.entrypointSource);
  assert.ok(Object.keys(bundle).length<=100);assert.equal(bundle['lib/private-config'],modules['lib/private-config']);assert.ok(bundle[MONITORING_ENDPOINT]);
});

test('scheduled workflow is inert by default and confines credentials to its protected worker step',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/background-monitoring.yml',import.meta.url),'utf8');
  assert.match(workflow,/cron: '37 \* \* \* \*'/);assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/pull_request|repository_dispatch|workflow_run/);
  assert.match(workflow,/github\.repository == 'resu12\/gift-rent-check'/);assert.match(workflow,/github\.event\.repository\.default_branch/);
  assert.match(workflow,/vars\.BACKGROUND_MONITORING_ENABLED == 'true'/);assert.match(workflow,/environment: price-monitoring/);
  assert.match(workflow,/scheduled:\s+description: 'Scheduled wake: respect the saved monitoring due time'\s+type: boolean\s+required: false\s+default: false/);
  assert.match(workflow,/BACKGROUND_MONITORING_MANUAL_RETRY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.scheduled != true \}\}/);
  assert.match(workflow,/contents: read/);assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/cancel-in-progress: false/);
  assert.equal((workflow.match(/secrets\./g)||[]).length,1);assert.ok(workflow.indexOf('secrets.TGCLOUD_TOKEN')>workflow.indexOf('- name: Run bounded owner monitoring'));
  assert.doesNotMatch(workflow,/npm (install|ci)|pnpm |upload-artifact|set -x/);
  for(const match of workflow.matchAll(/uses: ([^\s]+)/g))assert.match(match[1],/@[0-9a-f]{40}$/);
});
