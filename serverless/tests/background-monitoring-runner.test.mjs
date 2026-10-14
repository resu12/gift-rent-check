import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {MONITORING_ENDPOINT,RUNNER_LIMITS,parseMonitoringArgs,createMonitoringAdminApi,monitoringSummary,runBackgroundMonitoring,monitoringMain,loadMonitoringSources} from '../tools/run-background-monitoring.mjs';
import {adminModuleSources} from '../tools/admin-module-sources.mjs';

const token='app123:synthetic_test_secret',runner='a'.repeat(64),start=Date.parse('2026-10-14T12:00:00.000Z');
const canonical={'lib/private-config':'export const ownerTelegramId=42;',
  'lib/runtime':'export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;\nexport function createPrivateBackgroundMonitoringAccess() {}',
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

test('deployed runtime protocol and owner factory are required before check or execution',async()=>{
  for(const check of [false,true])for(const runtime of [undefined,'// export const PRIVATE_BACKGROUND_MONITORING_VERSION=1;',
    canonical['lib/runtime'].replace('VERSION=1','VERSION=2'),canonical['lib/runtime'].replace('export function','function')]) {
    let requests=0;const f=fixture([],{check,api:{getFiles:async()=>({canonical_modules:{...canonical,'lib/runtime':runtime}}),
      runFunction:async()=>{requests++;throw Error('must not execute');}}});
    await assert.rejects(f.run(),{message:'BACKGROUND_MONITORING_STOPPED'});assert.equal(requests,0);assert.deepEqual(f.output,[]);
  }
});

test('terminal worker states and bare busy responses do not trigger further calls',async()=>{
  for(const state of ['complete','partial','paused','disabled','blocked','failed','busy']) {
    const f=fixture([{state}]);assert.equal((await f.run()).state,state);assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[]);
  }
});

test('deadline and step caps keep durable future work pending instead of calling early',async()=>{
  const later=new Date(start+RUNNER_LIMITS.duration_ms+1).toISOString(),f=fixture([{state:'waiting',retry_at:later}]);
  assert.deepEqual(await f.run(),{state:'partial',retry_at:later});assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[]);
  const limited=fixture([{state:'running'},{state:'running'},{state:'complete'}],{limits:{steps:2}});
  assert.equal((await limited.run()).state,'partial');assert.equal(limited.calls.filter(call=>call.operation==='run').length,2);
  const expired=fixture([{state:'running'},{state:'complete'}],{limits:{duration_ms:1000}});
  assert.equal((await expired.run()).state,'partial');assert.equal(expired.calls.filter(call=>call.operation==='run').length,1);
  for(const limits of [{steps:201},{duration_ms:RUNNER_LIMITS.duration_ms+1},{request_ms:1},{steps:0}])await assert.rejects(fixture([],{limits}).run());
});

test('unknown failures and malformed results stop without a speculative retry',async()=>{
  for(const result of [Error('uncertain commit '+token),{state:'unexpected'}, {error:token}, {state:'waiting'}, {state:'complete',checked:-1}]) {
    const f=fixture([result,{state:'complete'}]);await assert.rejects(f.run());assert.equal(f.calls.filter(call=>call.operation==='run').length,1);
  }
  for(const value of [null,{}, {state:'running',retry_at:'tomorrow'},{state:'complete',total:'3'},{state:'complete',proposals:Infinity}])assert.throws(()=>monitoringSummary(value));
});

test('CLI failure logs contain only an enum even when the administrative failure contains secrets',async t=>{
  let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error(token+' private source');});
  const output=[],exit=await monitoringMain({args:['--app-id','123'],env:{BACKGROUND_MONITORING_ENABLED:'true',TGCLOUD_TOKEN:token},emit:value=>output.push(value)});
  assert.equal(exit,1);assert.deepEqual(output,[{state:'failed'}]);assert.equal(requests,1);
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
  assert.match(workflow,/cron: '37 \*\/6 \* \* \*'/);assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/pull_request|repository_dispatch|workflow_run/);
  assert.match(workflow,/github\.repository == 'resu12\/gift-rent-check'/);assert.match(workflow,/github\.event\.repository\.default_branch/);
  assert.match(workflow,/vars\.BACKGROUND_MONITORING_ENABLED == 'true'/);assert.match(workflow,/environment: price-monitoring/);
  assert.match(workflow,/BACKGROUND_MONITORING_MANUAL_RETRY: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(workflow,/contents: read/);assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/cancel-in-progress: false/);
  assert.equal((workflow.match(/secrets\./g)||[]).length,1);assert.ok(workflow.indexOf('secrets.TGCLOUD_TOKEN')>workflow.indexOf('- name: Run bounded owner monitoring'));
  assert.doesNotMatch(workflow,/npm (install|ci)|pnpm |upload-artifact|set -x/);
  for(const match of workflow.matchAll(/uses: ([^\s]+)/g))assert.match(match[1],/@[0-9a-f]{40}$/);
});
