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
export const RUNNER_LIMITS=Object.freeze({duration_ms:20*60*1000,steps:200,request_ms:90000,source_bytes:8*1024*1024,response_bytes:1024*1024,sleep_ms:60000,recoveries:3,prewarm_ms:30000});
const states=new Set(['running','waiting','busy','complete','paused','disabled','partial','blocked','failed']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const reasons=new Set(['invalid_request','invalid_response','invalid_json','invalid_envelope','invalid_result','response_too_large','network_error','request_timeout','http_error','remote_error','capability_missing','source_error','unacknowledged_status','recovery_exhausted','unexpected_error']);
const stages=new Set(['configuration','get_files','sources','tick','status','prewarm','runner']);
export class MonitoringAdminError extends Error {
  constructor(reason,stage='runner',httpStatus,remoteError,remoteCode) {
    super('BACKGROUND_MONITORING_STOPPED');
    this.reason=reasons.has(reason)?reason:'unexpected_error';this.stage=stages.has(stage)?stage:'runner';
    if(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599)this.http_status=httpStatus;
    if(['internal','endpoint','other'].includes(remoteError))this.remote_error=remoteError;
    if(Number.isInteger(remoteCode)&&remoteCode>=100&&remoteCode<=599)this.remote_code=remoteCode;
  }
}
const fail=(reason='invalid_response',stage='runner',httpStatus,remoteError,remoteCode)=>{throw new MonitoringAdminError(reason,stage,httpStatus,remoteError,remoteCode);};
const recoverable=error=>error instanceof MonitoringAdminError&&(['network_error','request_timeout'].includes(error.reason)
  ||error.reason==='http_error'&&error.http_status>=500&&error.http_status<=599);
function diagnostic(error) {
  if(!(error instanceof MonitoringAdminError))return {error:'unexpected_error',stage:'runner'};
  return {error:error.reason,stage:error.stage,...Object.fromEntries(['http_status','remote_error','remote_code'].filter(key=>Object.hasOwn(error,key)).map(key=>[key,error[key]]))};
}
const bounded=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

export function parseMonitoringArgs(args) {
  let appId=null,check=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--check'&&!check){check=true;continue;}
    if(args[i]==='--app-id'&&appId===null){appId=requireId(args[++i],'--app-id');continue;}
    fail('invalid_request','configuration');
  }
  return {appId:requireId(appId,'--app-id'),check};
}

function cancel(reader) {try{reader?.cancel()?.catch?.(()=>{});}catch{}}
async function responseJson(response,maxBytes,stage,signal) {
  if(!response.body?.getReader)fail('invalid_response',stage,response.status);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  const abort=()=>cancel(reader);signal.addEventListener('abort',abort,{once:true});
  try {
    for(;;){const {value,done}=await reader.read();if(signal.aborted)fail('request_timeout',stage,response.status);if(done)break;
      if(!(value instanceof Uint8Array))fail('invalid_response',stage,response.status);
      bytes+=value.byteLength;if(bytes>maxBytes)fail('response_too_large',stage,response.status);chunks.push(value);}
  } catch(error) {if(error instanceof MonitoringAdminError)throw error;fail(signal.aborted?'request_timeout':'network_error',stage,response.status);}
  finally {signal.removeEventListener('abort',abort);cancel(reader);}
  let envelope;try{envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json',stage,response.status);}
  if(object(envelope)&&envelope.ok===false)fail('remote_error',stage,response.status,
    envelope.error_type==='INTERNAL'?'internal':envelope.error_type==='ENDPOINT_ERROR'?'endpoint':'other',envelope.error_code);
  if(!object(envelope)||envelope.ok!==true||!Object.hasOwn(envelope,'result'))fail('invalid_envelope',stage,response.status);
  return envelope.result;
}

// Same /manage/get and /manage/run protocol as the pinned Telegram CLI, with
// explicit time/response limits and no redirects. Nothing is retried here:
// a lost response may represent a successfully committed remote checkpoint.
export function createMonitoringAdminApi({token,appId,env=process.env,fetch:request=globalThis.fetch}) {
  validateServerlessEnvironment(env);validateAuthenticatedDestination(token,appId,env);
  const base=`https://cloud.telegram.org/app${appId}/manage`;
  async function call(path,body,maxBytes,stage,timeoutMs=RUNNER_LIMITS.request_ms) {
    if(!bounded(timeoutMs,RUNNER_LIMITS.request_ms))fail('invalid_request',stage);
    const controller=new AbortController();let timer,response;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel(response?.body);
      reject(new MonitoringAdminError('request_timeout',stage,response?.status));},timeoutMs);});
    const work=(async()=>{
      response=await request(base+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(controller.signal.aborted){cancel(response?.body);fail('request_timeout',stage,response?.status);}
      if(response?.redirected||response?.status>=300&&response.status<400)fail('http_error',stage,response?.status);
      if(!response?.ok) {
        if(response?.status>=500&&response.status<=599) {
          // A hosting execution error is not a transient gateway failure, even
          // if it is returned with HTTP 500 rather than an HTTP 200 envelope.
          if(response.body)try {await responseJson(response,maxBytes,stage,controller.signal);}
          catch(error) {if(!(error instanceof MonitoringAdminError)||error.reason!=='invalid_json')throw error;}
        }
        fail('http_error',stage,response?.status);
      }
      return await responseJson(response,maxBytes,stage,controller.signal);
    })();
    try {return await Promise.race([work,timeout]);}
    catch(error) {if(error instanceof MonitoringAdminError)throw error;fail(controller.signal.aborted?'request_timeout':'network_error',stage,response?.status);}
    finally {clearTimeout(timer);cancel(response?.body);}
  }
  return {
    getFiles:({timeoutMs}={})=>call('/get',undefined,RUNNER_LIMITS.source_bytes,'get_files',timeoutMs),
    runFunction:(sources,input,{timeoutMs}={})=>{
      if(!object(input)||Object.keys(input).some(key=>!['runner_id','retry','status_only','prewarm_only'].includes(key))
        ||typeof input.runner_id!=='string'||!/^[0-9a-f]{64}$/.test(input.runner_id)
        ||Object.hasOwn(input,'retry')&&typeof input.retry!=='boolean'
        ||Object.hasOwn(input,'status_only')&&(input.status_only!==true||Object.hasOwn(input,'retry'))
        ||Object.hasOwn(input,'prewarm_only')&&(input.prewarm_only!==true||Object.hasOwn(input,'retry')||Object.hasOwn(input,'status_only')))fail('invalid_request','configuration');
      return call('/run',{module:MONITORING_ENDPOINT,sources,args:input,ctx:{background_worker:'price-monitoring-v1'}},RUNNER_LIMITS.response_bytes,input.prewarm_only?'prewarm':input.status_only?'status':'tick',timeoutMs);
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
  if(!object(deployed?.canonical_modules))fail('invalid_response','get_files');
  // The bridge must use the reviewed deployed owner-access implementation.
  // The additive capability keeps existing v1 runners compatible while this
  // worker rejects runtimes that cannot persist and resume scoped history.
  // Missing/older runtimes fail closed before loading or executing the worker.
  const runtime=deployed.canonical_modules['lib/runtime'];
  if(typeof runtime!=='string'||!/^\s*export\s+const\s+PRIVATE_BACKGROUND_MONITORING_VERSION\s*=\s*1\s*;/m.test(runtime)
    ||!/^\s*export\s+const\s+PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION\s*=\s*1\s*;/m.test(runtime)
    ||!/^\s*export\s+function\s+createPrivateBackgroundMonitoringAccess\s*\(/m.test(runtime))fail('capability_missing','sources');
  const canPrewarm=/^\s*export\s+const\s+PRIVATE_BACKGROUND_DASHBOARD_PREWARM_VERSION\s*=\s*1\s*;/m.test(runtime);
  const {coreSource,entrypointSource}=loadSources();
  const sources=adminModuleSources(deployed.canonical_modules,{'lib/background-monitoring':coreSource},MONITORING_ENDPOINT,entrypointSource);
  if(check){const result={state:'ready',modules:Object.keys(sources).length};emit(result);return result;}
  const runner=random();if(typeof runner!=='string'||!/^[0-9a-f]{64}$/.test(runner))fail();
  let summary={state:'partial'},statusOnly=false,recoveries=0,tickAttempted=false;
  for(let step=0;step<cap.steps&&remaining()>0;step++) {
    if(statusOnly) {
      if(recoveries>=cap.recoveries)fail('recovery_exhausted','status');
      // Every recovery read consumes this same invocation's request/time
      // budget. Back off even when a failed status response commits nothing.
      const backoff=1000*2**recoveries;
      if(backoff>=remaining())break;
      await sleep(backoff);
      if(remaining()<=0)break;
      recoveries++;
    }
    // A manual launch can recover a terminal incomplete run once. Continuing
    // that launch never repeatedly bypasses due times or terminal safeguards.
    const input={runner_id:runner,...(statusOnly?{status_only:true}:retry===true&&!tickAttempted?{retry:true}:{})};
    if(!statusOnly)tickAttempted=true;
    let response;
    try {response=await api.runFunction(sources,input,{timeoutMs:requestTime()});}
    catch(error) {
      if(!recoverable(error))throw error;
      emit({state:'recovering',...diagnostic(error)});
      if(recoveries>=cap.recoveries)fail('recovery_exhausted',statusOnly?'status':'tick');
      statusOnly=true;continue;
    }
    // /run returns an envelope containing the endpoint's result. Its logs,
    // errors and any unrelated fields are intentionally never forwarded.
    let observed;try {observed=monitoringSummary(response?.result);}catch{fail('invalid_result',statusOnly?'status':'tick');}
    // A previous cycle's terminal ledger may be visible before an uncertain
    // tick claims its run. Only acknowledge terminal results for this runner;
    // otherwise keep reading without replaying the tick or claiming success.
    if(statusOnly&&!['running','waiting','busy'].includes(observed.state)&&response.result.runner_acknowledged!==true) {
      emit({state:'recovering',error:'unacknowledged_status',stage:'status'});continue;
    }
    summary=observed;
    statusOnly=false;emit(summary);
    if(!['running','waiting','busy'].includes(summary.state)||summary.state==='busy'&&!summary.retry_at) {
      // Best effort, at most once, in its OWN hosting request. Never turn a
      // saved successful check into a failure because preparing display data
      // failed or its response was lost. Old runtimes and old-cycle completion
      // replies cannot authorize this extra work. Reserve the entire 30s read
      // budget and count the request against the invocation's step limit.
      if(summary.state==='complete'&&response.result.runner_acknowledged===true&&canPrewarm
        &&step+1<cap.steps&&remaining()>=cap.prewarm_ms) {
        try {
          const prepared=await api.runFunction(sources,{runner_id:runner,prewarm_only:true},{timeoutMs:cap.prewarm_ms});
          if(!['prepared','skipped'].includes(prepared?.result?.state))fail('invalid_result','prewarm');
          emit({dashboard_preparation:prepared.result.state});
        } catch {emit({dashboard_preparation:'failed'});}
      }
      return summary;
    }
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
  } catch(error) {emit({state:'failed',...diagnostic(error)});return 1;}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)process.exitCode=await monitoringMain();
