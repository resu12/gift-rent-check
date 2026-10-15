// Fixed owner-only worker driver. No arbitrary module, endpoint, SQL or user
// identity is accepted. Administrative credentials and deployed source stay in
// memory and never become log or artifact output.
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {adminModuleSources} from './admin-module-sources.mjs';
import {requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';

export const MONITORING_ENDPOINT='endpoints/backgroundMonitoringTick';
export const RUNNER_LIMITS=Object.freeze({duration_ms:20*60*1000,steps:200,request_ms:90000,source_bytes:8*1024*1024,response_bytes:1024*1024,sleep_ms:60000});
const states=new Set(['running','waiting','busy','complete','paused','disabled','partial','blocked','failed']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw Error('BACKGROUND_MONITORING_STOPPED');};
const bounded=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

export function parseMonitoringArgs(args) {
  let appId=null,check=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--check'&&!check){check=true;continue;}
    if(args[i]==='--app-id'&&appId===null){appId=requireId(args[++i],'--app-id');continue;}
    fail();
  }
  return {appId:requireId(appId,'--app-id'),check};
}

async function responseJson(response,maxBytes) {
  if(!response?.ok||!response.body?.getReader)fail();
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes)fail();chunks.push(value);}
  } catch {try{await reader.cancel();}catch{}fail();}
  let envelope;try{envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail();}
  if(!object(envelope)||envelope.ok!==true||!Object.hasOwn(envelope,'result'))fail();
  return envelope.result;
}

// Same /manage/get and /manage/run protocol as the pinned Telegram CLI, with
// explicit time/response limits and no redirects. Nothing is retried here:
// a lost response may represent a successfully committed remote checkpoint.
export function createMonitoringAdminApi({token,appId,env=process.env,fetch:request=globalThis.fetch}) {
  validateServerlessEnvironment(env);validateAuthenticatedDestination(token,appId,env);
  const base=`https://cloud.telegram.org/app${appId}/manage`;
  async function call(path,body,maxBytes,timeoutMs=RUNNER_LIMITS.request_ms) {
    if(!bounded(timeoutMs,RUNNER_LIMITS.request_ms))fail();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await request(base+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return await responseJson(response,maxBytes);
    } catch {fail();} finally {clearTimeout(timer);}
  }
  return {
    getFiles:({timeoutMs}={})=>call('/get',undefined,RUNNER_LIMITS.source_bytes,timeoutMs),
    runFunction:(sources,input,{timeoutMs}={})=>{
      if(!object(input)||Object.keys(input).some(key=>!['runner_id','retry'].includes(key))
        ||typeof input.runner_id!=='string'||!/^[0-9a-f]{64}$/.test(input.runner_id)
        ||Object.hasOwn(input,'retry')&&typeof input.retry!=='boolean')fail();
      return call('/run',{module:MONITORING_ENDPOINT,sources,args:input,ctx:{background_worker:'price-monitoring-v1'}},RUNNER_LIMITS.response_bytes,timeoutMs);
    },
  };
}

export function monitoringSummary(value) {
  if(!object(value)||!states.has(value.state))fail();
  const result={state:value.state};
  for(const field of ['checked','total','proposals'])if(Object.hasOwn(value,field)) {
    if(!Number.isSafeInteger(value[field])||value[field]<0||value[field]>1000000)fail();result[field]=value[field];
  }
  for(const field of ['retry_at','checked_at','completed_at','next_check_at'])if(Object.hasOwn(value,field)&&value[field]!==null) {
    if(!date(value[field]))fail();result[field]=value[field];
  }
  if(result.state==='waiting'&&!result.retry_at)fail();
  return result;
}

export function loadMonitoringSources() {
  return {coreSource:readFileSync(new URL('../worker/monitoring.js',import.meta.url),'utf8'),
    entrypointSource:readFileSync(new URL('../worker/entrypoint.js',import.meta.url),'utf8')};
}

export async function runBackgroundMonitoring({api,enabled=false,check=false,retry=false,loadSources=loadMonitoringSources,
  now=Date.now,monotonic=()=>performance.now(),sleep=delay,random=()=>randomBytes(32).toString('hex'),emit=()=>{},limits={}}={}) {
  const cap={...RUNNER_LIMITS};
  for(const [key,value] of Object.entries(limits)) {
    if(!['duration_ms','steps'].includes(key)||!bounded(value,cap[key]))fail();cap[key]=value;
  }
  if(!enabled&&!check){const result={state:'disabled'};emit(result);return result;}
  const began=monotonic(),remaining=()=>Math.floor(cap.duration_ms-(monotonic()-began));
  const requestTime=()=>Math.max(1,Math.min(cap.request_ms,remaining()));
  const deployed=await api.getFiles({timeoutMs:requestTime()});
  if(!object(deployed?.canonical_modules))fail();
  // The bridge must use the reviewed deployed owner-access implementation.
  // Missing/older runtimes fail closed before any administrative execution.
  const runtime=deployed.canonical_modules['lib/runtime'];
  if(typeof runtime!=='string'||!/^\s*export\s+const\s+PRIVATE_BACKGROUND_MONITORING_VERSION\s*=\s*1\s*;/m.test(runtime)
    ||!/^\s*export\s+function\s+createPrivateBackgroundMonitoringAccess\s*\(/m.test(runtime))fail();
  const {coreSource,entrypointSource}=loadSources();
  const sources=adminModuleSources(deployed.canonical_modules,{'lib/background-monitoring':coreSource},MONITORING_ENDPOINT,entrypointSource);
  if(check){const result={state:'ready',modules:Object.keys(sources).length};emit(result);return result;}
  const runner=random();if(typeof runner!=='string'||!/^[0-9a-f]{64}$/.test(runner))fail();
  let summary={state:'partial'};
  for(let step=0;step<cap.steps&&remaining()>0;step++) {
    // A manual launch can recover a terminal incomplete run once. Continuing
    // that launch never repeatedly bypasses due times or terminal safeguards.
    const response=await api.runFunction(sources,{runner_id:runner,...(retry===true&&step===0?{retry:true}:{})},{timeoutMs:requestTime()});
    // /run returns an envelope containing the endpoint's result. Its logs,
    // errors and any unrelated fields are intentionally never forwarded.
    summary=monitoringSummary(response?.result);emit(summary);
    if(!['running','waiting','busy'].includes(summary.state)||summary.state==='busy'&&!summary.retry_at)return summary;
    const current=now();if(!Number.isSafeInteger(current)||current<=0)fail();
    // A running step already commits the provider's next permitted time.
    // Do not add another second after network/host work has consumed that
    // interval. Waiting/busy without a future deadline retains a small floor
    // so stale contention replies cannot turn into a hot polling loop.
    const fallback=summary.state==='running'?current:current+1000;
    const retryAt=Math.max(current,summary.retry_at?Date.parse(summary.retry_at):fallback,
      summary.state==='running'?current:current+1000);
    // Stop with the durable checkpoint intact when its due time is outside
    // this invocation. Never call early or start an unbounded provider wait.
    if(retryAt-current>=remaining())break;
    while(now()<retryAt&&remaining()>0)await sleep(Math.min(cap.sleep_ms,retryAt-now(),remaining()));
  }
  const result={state:'partial',...Object.fromEntries(Object.entries(summary).filter(([key])=>['checked','total','proposals','retry_at'].includes(key)))};
  emit(result);return result;
}

export async function monitoringMain({args=process.argv.slice(2),env=process.env,emit=value=>console.log(JSON.stringify(value))}={}) {
  try {
    // Inactive jobs do not read credentials, files or the network. --check is
    // an explicit read-only configuration check before enabling the schedule.
    if(env.BACKGROUND_MONITORING_ENABLED!=='true'&&!args.includes('--check')){emit({state:'disabled'});return 0;}
    const options=parseMonitoringArgs(args);
    const api=createMonitoringAdminApi({token:env.TGCLOUD_TOKEN,appId:options.appId,env});
    const result=await runBackgroundMonitoring({api,check:options.check,enabled:env.BACKGROUND_MONITORING_ENABLED==='true',
      retry:env.BACKGROUND_MONITORING_MANUAL_RETRY==='true',emit});
    return ['failed','blocked'].includes(result.state)?1:0;
  } catch {emit({state:'failed'});return 1;}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)process.exitCode=await monitoringMain();
