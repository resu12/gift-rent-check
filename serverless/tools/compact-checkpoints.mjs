// Administrative maintenance only; never exposed as a Mini App endpoint.
import {option, requireId, validateAuthenticatedDestination, validateServerlessEnvironment} from './destination.mjs';
import {fileURLToPath} from 'node:url';

const endpoint = `
import {db} from 'sdk';
import {ownerTelegramId} from '../lib/private-config.js';
import {createCloudRepository} from '../lib/cloud-repository.js';
export default async function(input,ctx) {
  if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId)) throw Error('Private access denied');
  if(!input || typeof input!=='object' || Array.isArray(input) || !['check','apply'].includes(input.mode)
    || Object.keys(input).some(key=>!['mode','phase','after','boundary','limit','clear_cache'].includes(key))) throw Error('Invalid maintenance mode');
  const phase=input.phase,after=input.after??0,boundaryInput=input.boundary??0;
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(boundaryInput)||boundaryInput<0
    || (boundaryInput>0&&after>boundaryInput)) throw Error('Invalid maintenance bound');
  const repo=createCloudRepository(db);
  if(input.mode==='check') {
    if(!['base','owned_states','gift_states','budget_resets'].includes(phase)||Object.hasOwn(input,'limit')||Object.hasOwn(input,'clear_cache')) throw Error('Invalid maintenance mode');
    // Only one bounded state partition is inspected per hosted call.
    const page=phase==='budget_resets'?await repo.budgetResetStorageStatsPage({after,boundary:boundaryInput}):phase==='gift_states'?await repo.giftStateStorageStatsPage({after,boundary:boundaryInput}):await repo.ownedStateStorageStatsPage({after,boundary:boundaryInput});
    return {mode:'check',phase,...(phase==='base'?{...await repo.checkpointStorageStats(),...await repo.ownedTargetStorageStats()}:{}),...page,provider_requests:0};
  }
  if(!['jobs','targets','owned_states','gift_states','budget_resets'].includes(phase)||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>(phase==='targets'?25:4)
    || Object.hasOwn(input,'clear_cache')&&typeof input.clear_cache!=='boolean'||phase==='targets'&&after!==0) throw Error('Invalid maintenance mode');
  // Apply deliberately skips full statistics: storage recovery must remain
  // possible when a complete inventory exceeds the hosted runtime allowance.
  const head=await repo.read(),boundary=boundaryInput||head.revision;
  if(boundary>head.revision||after>boundary) throw Error('Invalid maintenance bound');
  if(input.clear_cache===true) await db.run('DELETE FROM dashboard_projection_cache');
  let page;
  if(!boundary) page={rewritten:0,boundary,after,complete:true};
  else if(phase==='jobs') page=await repo.compactCheckpointJobsPage({boundary,after,limit:input.limit});
  else if(phase==='owned_states') page=await repo.compactCheckpointOwnedStatesPage({boundary,after,limit:input.limit});
  else if(phase==='gift_states') page=await repo.compactCheckpointGiftStatesPage({boundary,after,limit:input.limit});
  else if(phase==='budget_resets') page=await repo.compactCheckpointBudgetResetsPage({boundary,after,limit:input.limit});
  else {
    const count=await repo.compactCheckpointOwnedTargets(boundary,input.limit);
    page={rewritten:count,boundary,after,complete:count===0};
  }
  const latest=await repo.read();
  if(latest.revision===head.revision&&JSON.stringify(latest.state)!==JSON.stringify(head.state)) throw Error('Checkpoint preservation check failed');
  return {mode:'apply',phase,...page,head_unchanged:latest.revision===head.revision,provider_requests:0};
}`;

const usage='Use --app-id, --mode check or apply, and optional --after, --boundary, --phase jobs|targets|owned_states|gift_states|budget_resets.';
const numberOption=(args,name)=>{
  const value=option(args,name);if(value===null)return 0;
  if(!/^(?:0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value))||String(Number(value))!==value)throw Error(usage);
  return Number(value);
};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const verified=()=>{throw Error('Maintenance did not return a verified result.');};
const recoverable=error=>/database or disk is full|query[^\r\n]{0,80}limit/i.test(String(error?.message||''));
const rateLimited=error=>error?.status===429||error?.type==='RATE_LIMITED';
const retryAfter=error=>{
  const value=error?.parameters?.retry_after;
  return typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=86400?Math.ceil(value):undefined;
};

async function main() {
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2)if(!['--app-id','--mode','--after','--boundary','--phase'].includes(args[i]))throw Error(usage);
  const appId=requireId(option(args,'--app-id'),'--app-id'),mode=option(args,'--mode')??'check';
  const startAfter=numberOption(args,'--after'),requestedBoundary=numberOption(args,'--boundary'),requestedPhase=option(args,'--phase');
  if(!['check','apply'].includes(mode)||requestedPhase!==null&&!['jobs','targets','owned_states','gift_states','budget_resets'].includes(requestedPhase)
    ||mode==='check'&&requestedPhase!==null&&!['owned_states','gift_states','budget_resets'].includes(requestedPhase)
    ||startAfter>0&&requestedPhase==='targets'||requestedBoundary>0&&startAfter>requestedBoundary)throw Error(usage);
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const {ownerTelegramId}=await import('../tgcloud/lib/private-config.js');
  if(!/^[1-9]\d*$/.test(String(ownerTelegramId)))throw Error('Private owner configuration is missing.');
  const deployed=await getFiles(token),checkpoint=deployed.canonical_modules?.['lib/checkpoint-storage'],repository=deployed.canonical_modules?.['lib/cloud-repository'],gifts=deployed.canonical_modules?.['lib/gift-refresh-storage'],resets=deployed.canonical_modules?.['lib/budget-reset-checkpoint-storage'];
  if(!checkpoint?.includes('ownedTargetSource')||!checkpoint?.includes('ownedStateSource')
    ||!checkpoint?.includes('ownedStateStorageStatsPage')||!checkpoint?.includes('compactCheckpointOwnedStatesPage')
    ||!checkpoint?.includes('compactCheckpointJobsPage')
    ||!checkpoint?.includes('giftStateSource')||!checkpoint?.includes('findGiftStateSource')||!checkpoint?.includes('__checkpoint_gift_state_sequence')
    ||!checkpoint?.includes('giftStateStorageStatsPage')||!checkpoint?.includes('compactCheckpointGiftStatesPage')
    ||!repository?.includes('checkpoints.ownedTargetSource')||!repository?.includes('checkpoints.ownedStateSource')
    ||!repository?.includes('checkpoints.giftStateSource')||!repository?.includes('GIFT_SOURCE_FENCE')||!gifts?.includes('__checkpoint_gift_state_sequence'))throw Error('Publish the checkpoint reader before maintenance.');
  if(requestedPhase==='budget_resets'&&(!resets?.includes('budgetResetSource')||!resets?.includes('findBudgetResetSource')
    ||!resets?.includes('__checkpoint_budget_reset_sequence')||!resets?.includes('BUDGET_RESET_MARKER')||!resets?.includes('decodeBudgetResetReference')
    ||!resets?.includes('budgetResetStorageStatsPage')||!resets?.includes('compactCheckpointBudgetResetsPage')
    ||!checkpoint?.includes('decodeBudgetResetReference')||!checkpoint?.includes('createBudgetResetCheckpointStorage')||!checkpoint?.includes('BUDGET_RESET_MARKER')
    ||!repository?.includes('checkpoints.budgetResetSource')||!repository?.includes('BUDGET_RESET_SOURCE_FENCE')))throw Error('Publish the checkpoint reader before maintenance.');
  const modules={...deployed.canonical_modules,'endpoints/maintainCheckpoints':endpoint};
  const phases=requestedPhase==='budget_resets'?['budget_resets']:['jobs','targets','owned_states','gift_states'];
  let phase=mode==='check'?requestedPhase??'base':requestedPhase??(startAfter>0||requestedBoundary>0?'owned_states':'jobs');
  let after=startAfter,boundary=requestedBoundary,calls=0,rewritten=0,complete=false,headUnchanged=true,limit=1,verifiedCalls=0,pause=null;
  const counts=requestedPhase==='budget_resets'?{duplicate_budget_reset_bytes:0,budget_reset_compactable:0}:requestedPhase==='gift_states'?{duplicate_gift_state_bytes:0,gift_state_compactable:0}:{duplicate_owned_state_bytes:0,owned_state_compactable:0};let base={};
  while(calls<20&&!complete&&rewritten<500) {
    const input={mode,phase,after,boundary,...(mode==='apply'?{limit:Math.min(limit,500-rewritten),clear_cache:calls===0}:{})};
    let response;
    try{calls++;response=await runFunction(token,'endpoints/maintainCheckpoints',modules,input,{initData:{user:{id:ownerTelegramId}}});}
    catch(error){
      // A throttled management call is never retried in this invocation. Keep
      // only the last verified cursor; an unacknowledged mutation may have run.
      if(rateLimited(error)&&verifiedCalls>0){pause={paused_reason:'rate_limit',retry_after_seconds:retryAfter(error)};break;}
      if(mode!=='apply'||limit===1||calls>=20||!recoverable(error))throw error;limit=1;continue;
    }
    const result=response?.result;
    if(!result||result.mode!==mode||result.phase!==phase||result.provider_requests!==0||!integer(result.boundary)||!integer(result.after)
      ||result.after<after||result.after>result.boundary||boundary>0&&result.boundary!==boundary||typeof result.complete!=='boolean')verified();
    if(mode==='check') {
      if(phase==='base')for(const key of ['events','state_bytes','duplicate_job_bytes','compactable','duplicate_target_bytes','target_compactable']){if(!integer(result[key]))verified();base[key]=result[key];}
      for(const key of Object.keys(counts)){if(!integer(result[key])||!integer(counts[key]+result[key]))verified();counts[key]+=result[key];}
    } else {
      if(!integer(result.rewritten)||result.rewritten>input.limit||typeof result.head_unchanged!=='boolean')verified();
      rewritten+=result.rewritten;headUnchanged&&=result.head_unchanged;
    }
    const paged=mode==='check'||phase==='jobs'||phase==='owned_states'||phase==='gift_states'||phase==='budget_resets';
    if(paged&&!result.complete&&result.after===after||!paged&&result.after!==after)verified();
    verifiedCalls++;
    after=result.after;boundary=result.boundary;
    if(mode==='check'){complete=result.complete;if(phase==='base')phase='owned_states';}
    else if(result.complete){const next=phases.indexOf(phase)+1;if(!boundary||next===phases.length)complete=true;else{phase=phases[next];after=0;limit=1;}}
    else limit=Math.min(phase==='targets'?25:4,limit*2);
    // Aggregate progress only; no checkpoint, provider body or credential.
    console.error(JSON.stringify({mode,phase,calls,after,boundary,complete,...(mode==='apply'?{rewritten}:{}),provider_requests:0}));
  }
  const display={mode,...base,...(mode==='check'?counts:{rewritten,head_unchanged:headUnchanged}),phase,after,boundary,complete,calls,provider_requests:0,...(pause??{}),
    ...(mode==='check'?{[requestedPhase==='budget_resets'?'budget_reset_counts_partial':requestedPhase==='gift_states'?'gift_state_counts_partial':'owned_state_counts_partial']:!complete||startAfter>0}:{})};
  console.log(JSON.stringify(display));
  if(pause)process.exitCode=3;
}
main().catch(error=>{
  const safe=[usage,'Supply --app-id with a positive numeric Telegram ID','Administrative tools require the official Telegram cloud API','Administrative tools require the production Telegram app','The CLI credentials do not match the explicit Telegram app ID','Private owner configuration is missing.','Publish the checkpoint reader before maintenance.'];
  console.error(safe.includes(error?.message)?error.message:'Checkpoint maintenance failed; no private data or credentials logged.');process.exitCode=1;
});
