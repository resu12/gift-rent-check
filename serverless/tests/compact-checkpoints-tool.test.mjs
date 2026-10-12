import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const token='app54321:synthetic_cli_secret',otherToken='app65432:synthetic_other_secret';
const providerSecret='synthetic_marketapp_secret',privateBody='synthetic_private_checkpoint_body',owner=42;
const canonical={
  'lib/checkpoint-storage':readFileSync(new URL('../tgcloud/lib/checkpoint-storage.js',import.meta.url),'utf8'),
  'lib/cloud-repository':readFileSync(new URL('../tgcloud/lib/cloud-repository.js',import.meta.url),'utf8'),
  'lib/gift-refresh-storage':readFileSync(new URL('../tgcloud/lib/gift-refresh-storage.js',import.meta.url),'utf8'),
  'lib/budget-reset-checkpoint-storage':readFileSync(new URL('../tgcloud/lib/budget-reset-checkpoint-storage.js',import.meta.url),'utf8'),
  'lib/private-config':`export const ownerTelegramId=${owner};export const marketappToken=${JSON.stringify(providerSecret)};`,
  'endpoints/readOnlySentinel':'export default async function(){return {synthetic:true}}',
};
const baseStats={events:12,state_bytes:1024,duplicate_job_bytes:256,compactable:3,duplicate_target_bytes:512,target_compactable:5};
const checkPage={...baseStats,duplicate_owned_state_bytes:768,owned_state_compactable:7,boundary:12,after:11,complete:true};
const giftCheckPage={duplicate_gift_state_bytes:384,gift_state_compactable:6,boundary:12,after:11,complete:true};
const budgetCheckPage={duplicate_budget_reset_bytes:192,budget_reset_compactable:4,boundary:12,after:11,complete:true};
const applyPage={rewritten:1,boundary:12,after:11,complete:true,head_unchanged:true};
function fixture(t){
  const temporaryRoot=fileURLToPath(new URL('../../.tmp/',import.meta.url));mkdirSync(temporaryRoot,{recursive:true});
  const root=mkdtempSync(join(temporaryRoot,'checkpoint-maintenance-guard-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(temporaryRoot)+sep));rmSync(root,{recursive:true,force:true});});
  const project=join(root,'serverless');
  for(const relative of ['tools','node_modules/@tgcloud/cli/src/core','node_modules/@tgcloud/cli/src/api','tgcloud/lib'])mkdirSync(join(project,relative),{recursive:true});
  writeFileSync(join(project,'package.json'),'{"type":"module"}');writeFileSync(join(project,'node_modules/@tgcloud/cli/package.json'),'{"type":"module"}');
  for(const name of ['compact-checkpoints.mjs','destination.mjs'])writeFileSync(join(project,'tools',name),readFileSync(new URL('../tools/'+name,import.meta.url)));
  writeFileSync(join(project,'tgcloud/lib/private-config.js'),canonical['lib/private-config']);writeFileSync(join(project,'canonical.json'),JSON.stringify(canonical));
  writeFileSync(join(project,'node_modules/@tgcloud/cli/src/core/credentials.js'),`
import {appendFileSync} from 'node:fs';
appendFileSync('calls.jsonl',JSON.stringify({stage:'credentials-import'})+'\\n');
export async function resolveToken(){return process.env.TGCLOUD_TOKEN||${JSON.stringify(token)}}
`);
  writeFileSync(join(project,'node_modules/@tgcloud/cli/src/api/endpoints.js'),`
import {appendFileSync,readFileSync} from 'node:fs';
const record=value=>appendFileSync('calls.jsonl',JSON.stringify(value)+'\\n');let ordinal=0;
record({stage:'endpoints-import'});
export async function getFiles(auth){
  record({stage:'getFiles',auth,debug:process.env.TGCLOUD_DEBUG});
  if(process.env.TEST_FAILURE==='getFiles')throw Error(${JSON.stringify(providerSecret+' '+token+' '+privateBody)});
  const modules=JSON.parse(readFileSync('canonical.json','utf8'));
  if(process.env.TEST_NO_READER==='1')delete modules['lib/checkpoint-storage'];
  if(process.env.TEST_NO_REPOSITORY==='1')delete modules['lib/cloud-repository'];
  if(process.env.TEST_NO_BUDGET_READER==='1')delete modules['lib/budget-reset-checkpoint-storage'];
  if(process.env.TEST_MISSING_SYMBOL){const [module,symbol]=JSON.parse(process.env.TEST_MISSING_SYMBOL);modules[module]=modules[module].replaceAll(symbol,'legacyUnsupportedSymbol');}
  return {canonical_modules:modules};
}
export async function runFunction(auth,name,modules,input,ctx){
  record({stage:'runFunction',auth,name,modules,input,ctx,debug:process.env.TGCLOUD_DEBUG});
  if(process.env.TEST_FAILURE==='runFunction')throw Error(${JSON.stringify(providerSecret+' '+token+' '+privateBody)});
  const plan=process.env.TEST_PAGE_PLAN?JSON.parse(process.env.TEST_PAGE_PLAN):null,entry=plan?.[ordinal++];
  if(entry?.failure){
    if(typeof entry.failure==='string')throw Error(entry.failure);
    throw Object.assign(Error(entry.failure.message),entry.failure);
  }
  const fallback=input.mode==='check'?(input.phase==='budget_resets'?${JSON.stringify(budgetCheckPage)}:input.phase==='gift_states'?${JSON.stringify(giftCheckPage)}:${JSON.stringify(checkPage)}):input.phase==='owned_states'?${JSON.stringify(applyPage)}:{rewritten:0,boundary:12,after:input.phase==='jobs'||input.phase==='gift_states'||input.phase==='budget_resets'?11:0,complete:true,head_unchanged:true};
  const result={mode:input.mode,phase:input.phase,...(entry??fallback),provider_requests:0};
  if(process.env.TEST_RESULT_PATCH)Object.assign(result,JSON.parse(process.env.TEST_RESULT_PATCH));
  return {result};
}
`);
  const baseEnv={...process.env};
  for(const name of ['TGCLOUD_TOKEN','TG_CLOUD_API_URL','TGCLOUD_BETA','TGCLOUD_DEBUG','NODE_OPTIONS','TEST_NO_READER','TEST_NO_REPOSITORY','TEST_NO_BUDGET_READER','TEST_MISSING_SYMBOL','TEST_FAILURE','TEST_RESULT_PATCH','TEST_PAGE_PLAN'])delete baseEnv[name];
  const run=(args=['--app-id','54321'],env={})=>spawnSync(process.execPath,[join(project,'tools/compact-checkpoints.mjs'),...args],{cwd:root,env:{...baseEnv,...env},encoding:'utf8',timeout:15000});
  const calls=()=>existsSync(join(project,'calls.jsonl'))?readFileSync(join(project,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  return {root,project,run,calls};
}
const noSecrets=result=>{for(const secret of [token,otherToken,providerSecret,privateBody])assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));};
const rejected=result=>{assert.equal(result.status,1,result.stdout+result.stderr);noSecrets(result);};
const invokeCalls=f=>f.calls().filter(row=>row.stage==='runFunction');
const applyArgs=['--app-id','54321','--mode','apply'];
const pageArgs=[...applyArgs,'--after','0','--boundary','12','--phase','owned_states'];
function runtime(f,db,repo){
  assert.equal(f.run().status,0);const source=invokeCalls(f)[0].modules['endpoints/maintainCheckpoints'];
  const stripped=source.replace(/^import .*;\s*$/gm,'').replace('export default async function','return async function');
  return new Function('db','ownerTelegramId','createCloudRepository',stripped)(db,owner,()=>repo);
}

test('maintenance rejects unsafe destination and malformed continuation arguments before importing credentials',t=>{
  const f=fixture(t);
  for(const env of [{TG_CLOUD_API_URL:'https://other.invalid'},{TG_CLOUD_API_URL:'https://cloud.telegram.org.evil.invalid'},{TGCLOUD_BETA:'1'}])rejected(f.run(undefined,env));
  for(const args of [[],['--app-id'],['--app-id','0'],['--app-id','01'],['--app-id','54321\n'],['--app-id','9007199254740992'],
    [...applyArgs,'--after'],[...applyArgs,'--after','-1'],[...applyArgs,'--after','01'],[...applyArgs,'--boundary','1.2'],
    [...applyArgs,'--after','13','--boundary','12'],[...applyArgs,'--after','1','--phase','targets'],['--app-id','54321','--phase','jobs'],
    ['--app-id','54321','--mode','delete'],[...applyArgs,'--unknown','check'],[...applyArgs,'--app-id','65432'],[...applyArgs,'--after','0','--after','1']])rejected(f.run(args));
  assert.deepEqual(f.calls(),[]);
});

test('credentials must match the explicit app before authenticated imports or private configuration',t=>{
  for(const credential of [otherToken,token+'\n','Bearer '+token,'app54321:','malformed']){
    const f=fixture(t),path=resolve(f.project,'tgcloud/lib/private-config.js');assert.ok(path.startsWith(resolve(f.root)+sep));rmSync(path);
    rejected(f.run(undefined,{TGCLOUD_TOKEN:credential}));assert.deepEqual(f.calls().map(row=>row.stage),['credentials-import']);
  }
});

test('check and apply use only canonical authenticated modules and aggregate progress',t=>{
  for(const mode of ['check','apply']){
    const f=fixture(t),result=f.run(['--app-id','54321','--mode',mode],{TGCLOUD_DEBUG:'1'});assert.equal(result.status,0,result.stderr);noSecrets(result);
    const display=JSON.parse(result.stdout);assert.equal(display.mode,mode);assert.equal(display.provider_requests,0);assert.equal(display.complete,true);
    assert.equal(display.calls,mode==='check'?1:4);
    if(mode==='check')assert.equal(display.owned_state_counts_partial,false);else assert.equal(display.rewritten,1);
    for(const invocation of invokeCalls(f)){
      assert.equal(invocation.auth,token);assert.equal(invocation.name,'endpoints/maintainCheckpoints');assert.equal(invocation.debug,'0');
      assert.deepEqual(invocation.ctx,{initData:{user:{id:owner}}});for(const [name,body]of Object.entries(canonical))assert.equal(invocation.modules[name],body);
      assert.deepEqual(Object.keys(invocation.modules).sort(),[...Object.keys(canonical),'endpoints/maintainCheckpoints'].sort());
      assert.doesNotMatch(invocation.modules['endpoints/maintainCheckpoints'],/\bfetch\b|(?:api\.marketapp|toncenter)\./);
      assert.doesNotMatch(invocation.modules['endpoints/maintainCheckpoints'],/\.ownedStateStorageStats\(|\.giftStateStorageStats\(|\.compactCheckpointOwnedStates\(|\.compactCheckpointGiftStates\(|\.compactCheckpointJobs\(/);
    }
    assert.ok(result.stderr.trim().split('\n').every(line=>JSON.parse(line).provider_requests===0));
  }
});

test('maintenance requires the deployed bounded readers and private owner before invoking maintenance',t=>{
  const missing=[['lib/checkpoint-storage','ownedTargetSource'],['lib/checkpoint-storage','ownedStateSource'],['lib/checkpoint-storage','ownedStateStorageStatsPage'],
    ['lib/checkpoint-storage','compactCheckpointOwnedStatesPage'],['lib/checkpoint-storage','compactCheckpointJobsPage'],['lib/cloud-repository','checkpoints.ownedTargetSource'],['lib/cloud-repository','checkpoints.ownedStateSource'],
    ['lib/checkpoint-storage','giftStateSource'],['lib/checkpoint-storage','findGiftStateSource'],['lib/checkpoint-storage','__checkpoint_gift_state_sequence'],
    ['lib/checkpoint-storage','giftStateStorageStatsPage'],['lib/checkpoint-storage','compactCheckpointGiftStatesPage'],
    ['lib/cloud-repository','checkpoints.giftStateSource'],['lib/cloud-repository','GIFT_SOURCE_FENCE'],['lib/gift-refresh-storage','__checkpoint_gift_state_sequence']];
  for(const env of [{TEST_NO_READER:'1'},{TEST_NO_REPOSITORY:'1'},...missing.map(pair=>({TEST_MISSING_SYMBOL:JSON.stringify(pair)}))]){
    const f=fixture(t),result=f.run(applyArgs,env);rejected(result);assert.match(result.stderr,/Publish the checkpoint reader/);assert.equal(invokeCalls(f).length,0);
  }
  const f=fixture(t);writeFileSync(join(f.project,'tgcloud/lib/private-config.js'),'export const ownerTelegramId=null;');rejected(f.run());assert.equal(f.calls().some(row=>row.stage==='getFiles'),false);
});

test('unsafe responses and operational failures never print credentials or private evidence',t=>{
  for(const stage of ['getFiles','runFunction']){const f=fixture(t);rejected(f.run(undefined,{TEST_FAILURE:stage}));}
  for(const patch of [{mode:'apply'},{phase:'jobs'},{events:-1},{state_bytes:1.5},{compactable:'3'},{provider_requests:1},{duplicate_owned_state_bytes:-1},
    {owned_state_compactable:'7'},{boundary:'12'},{after:-1},{after:13},{after:0,complete:false},{complete:'true'}]){
    const f=fixture(t);rejected(f.run(undefined,{TEST_RESULT_PATCH:JSON.stringify(patch)}));
  }
  for(const patch of [{rewritten:-1},{rewritten:501},{rewritten:1.5},{head_unchanged:'true'}]){
    const f=fixture(t);rejected(f.run(applyArgs,{TEST_RESULT_PATCH:JSON.stringify(patch)}));
  }
  const f=fixture(t),result=f.run(undefined,{TEST_RESULT_PATCH:JSON.stringify({provider_body:privateBody,provider_token:providerSecret})});assert.equal(result.status,0);noSecrets(result);assert.equal(JSON.parse(result.stdout).provider_body,undefined);
});

test('owned apply advances across zero-rewrite partitions, warms up only to four rows and preserves a frozen boundary',t=>{
  const f=fixture(t),plan=[{rewritten:0,boundary:12,after:2,complete:false,head_unchanged:true},
    {rewritten:2,boundary:12,after:5,complete:false,head_unchanged:true},{rewritten:4,boundary:12,after:9,complete:false,head_unchanged:true},
    {rewritten:1,boundary:12,after:11,complete:true,head_unchanged:true}];
  const result=f.run(pageArgs,{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,0,result.stderr);
  const calls=invokeCalls(f),owned=calls.filter(row=>row.input.phase==='owned_states');assert.deepEqual(owned.map(row=>row.input.limit),[1,2,4,4]);assert.deepEqual(owned.map(row=>row.input.after),[0,2,5,9]);
  assert.ok(calls.every(row=>row.input.boundary===12));assert.deepEqual(calls.map(row=>row.input.clear_cache),[true,false,false,false,false]);
  assert.deepEqual(calls.at(-1).input,{mode:'apply',phase:'gift_states',after:0,boundary:12,limit:1,clear_cache:false});
  assert.equal(JSON.parse(result.stdout).rewritten,7);assert.equal(JSON.parse(result.stdout).complete,true);
});

test('jobs resume advances across zero-rewrite partitions with at most four rewrites per page',t=>{
  const f=fixture(t),plan=[{rewritten:0,boundary:12,after:2,complete:false,head_unchanged:true},
    {rewritten:2,boundary:12,after:5,complete:false,head_unchanged:true},{rewritten:4,boundary:12,after:9,complete:false,head_unchanged:true},
    {rewritten:0,boundary:12,after:10,complete:false,head_unchanged:true},{rewritten:0,boundary:12,after:11,complete:true,head_unchanged:true}];
  const result=f.run([...applyArgs,'--after','1','--boundary','12','--phase','jobs'],{TEST_PAGE_PLAN:JSON.stringify(plan)});
  assert.equal(result.status,0,result.stderr);noSecrets(result);
  const calls=invokeCalls(f),jobs=calls.filter(row=>row.input.phase==='jobs');
  assert.deepEqual(jobs.map(row=>row.input.limit),[1,2,4,4,4]);assert.deepEqual(jobs.map(row=>row.input.after),[1,2,5,9,10]);
  assert.ok(calls.every(row=>row.input.boundary===12));
  assert.deepEqual(calls.slice(5).map(row=>[row.input.phase,row.input.after,row.input.limit]),[['targets',0,1],['owned_states',0,1],['gift_states',0,1]]);
  assert.equal(JSON.parse(result.stdout).complete,true);assert.equal(JSON.parse(result.stdout).rewritten,7);
});

test('jobs, owned, gift and budget cursors must advance on unfinished pages while targets cannot advance a cursor',t=>{
  for(const phase of ['jobs','owned_states','gift_states','budget_resets']){
    const f=fixture(t),result=f.run([...applyArgs,'--phase',phase],{TEST_PAGE_PLAN:JSON.stringify([{rewritten:0,boundary:12,after:0,complete:false,head_unchanged:true}])});
    rejected(result);assert.equal(invokeCalls(f).length,1);
  }
  for(const complete of [false,true]){
    const f=fixture(t),result=f.run([...applyArgs,'--phase','targets'],{TEST_PAGE_PLAN:JSON.stringify([{rewritten:0,boundary:12,after:1,complete,head_unchanged:true}])});
    rejected(result);assert.equal(invokeCalls(f).length,1);
  }
});

test('apply orders jobs then targets then owned and gift partitions with warmup reset for each phase',t=>{
  const f=fixture(t),plan=[{rewritten:1,boundary:12,after:2,complete:false,head_unchanged:true},{rewritten:0,boundary:12,after:11,complete:true,head_unchanged:true},
    {rewritten:1,boundary:12,after:0,complete:false,head_unchanged:true},{rewritten:0,boundary:12,after:0,complete:true,head_unchanged:true},
    {rewritten:0,boundary:12,after:11,complete:true,head_unchanged:true}];
  const result=f.run(applyArgs,{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,0,result.stderr);
  assert.deepEqual(invokeCalls(f).map(row=>[row.input.phase,row.input.limit]),[['jobs',1],['jobs',2],['targets',1],['targets',2],['owned_states',1],['gift_states',1]]);
  assert.deepEqual(invokeCalls(f).map(row=>row.input.after),[0,2,0,0,0,0]);
  assert.equal(JSON.parse(result.stdout).rewritten,2);
});

test('twenty hosted apply attempts include failed query-limit retries and return continuation even with zero rewrites',t=>{
  for(const phase of ['jobs','owned_states','gift_states','budget_resets']){
    const f=fixture(t),plan=[];for(let i=0;i<20;i++)plan.push(i===1?{failure:'CODE_RUN_FAILED: QUERY MEMORY LIMIT '+privateBody}:
      {rewritten:0,boundary:100,after:i+1,complete:false,head_unchanged:true});
    const result=f.run([...applyArgs,'--boundary','100','--phase',phase],{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,0,result.stderr);noSecrets(result);
    const calls=invokeCalls(f);assert.equal(calls.length,20);assert.deepEqual(calls.slice(0,4).map(row=>row.input.limit),[1,2,1,2]);
    const display=JSON.parse(result.stdout);assert.equal(display.complete,false);assert.equal(display.phase,phase);assert.equal(display.after,20);assert.equal(display.rewritten,0);assert.equal(display.calls,20);
    const resumed=fixture(t),resume=resumed.run([...applyArgs,'--after',String(display.after),'--boundary',String(display.boundary),'--phase',display.phase],
      {TEST_PAGE_PLAN:JSON.stringify([{rewritten:0,boundary:100,after:21,complete:false,head_unchanged:true},...Array.from({length:19},(_,index)=>({rewritten:0,boundary:100,after:index+22,complete:false,head_unchanged:true}))])});
    assert.equal(resume.status,0,resume.stderr);assert.equal(invokeCalls(resumed)[0].input.after,20);assert.equal(invokeCalls(resumed)[0].input.limit,1);
  }
});

test('management throttling pauses at the last verified cursor without retrying or exposing the failed response',t=>{
  for(const signal of [{status:429},{type:'RATE_LIMITED'}]){
    const f=fixture(t),plan=[{rewritten:1,boundary:12,after:2,complete:false,head_unchanged:true},
      {failure:{...signal,message:'Query limit '+privateBody+' '+providerSecret+' '+token,
        parameters:{retry_after:17.2,body:privateBody,token:providerSecret}}},
      {rewritten:2,boundary:12,after:5,complete:false,head_unchanged:true}];
    const result=f.run([...applyArgs,'--phase','jobs'],{TEST_PAGE_PLAN:JSON.stringify(plan)});
    assert.equal(result.status,3,result.stderr);noSecrets(result);
    const display=JSON.parse(result.stdout);
    assert.deepEqual(display,{mode:'apply',rewritten:1,head_unchanged:true,phase:'jobs',after:2,boundary:12,
      complete:false,calls:2,provider_requests:0,paused_reason:'rate_limit',retry_after_seconds:18});
    assert.deepEqual(invokeCalls(f).map(row=>[row.input.after,row.input.limit]),[[0,1],[2,2]]);
    const resumed=fixture(t),resume=resumed.run([...applyArgs,'--after',String(display.after),'--boundary',String(display.boundary),'--phase',display.phase]);
    assert.equal(resume.status,0,resume.stderr);assert.equal(invokeCalls(resumed)[0].input.after,2);assert.equal(invokeCalls(resumed)[0].input.limit,1);
    assert.equal(invokeCalls(resumed)[0].input.boundary,12);
  }
});

test('management throttle retry hints accept only bounded positive numbers and all phases retain verified progress',t=>{
  for(const retry of [undefined,null,'30',0,-1,86400.1,{private:privateBody},86400]){
    const f=fixture(t),result=f.run([...applyArgs,'--phase','owned_states','--boundary','12'],{TEST_PAGE_PLAN:JSON.stringify([
      {rewritten:0,boundary:12,after:5,complete:false,head_unchanged:false},
      {failure:{status:429,message:privateBody,parameters:{retry_after:retry,private:providerSecret}}},
    ])});
    assert.equal(result.status,3,result.stderr);noSecrets(result);assert.equal(invokeCalls(f).length,2);
    const display=JSON.parse(result.stdout);assert.equal(display.after,5);assert.equal(display.head_unchanged,false);
    assert.equal(display.retry_after_seconds,retry===86400?86400:undefined);
  }
  const targets=fixture(t),targetPause=targets.run([...applyArgs,'--phase','targets'],{TEST_PAGE_PLAN:JSON.stringify([
    {rewritten:1,boundary:12,after:0,complete:false,head_unchanged:true},{failure:{status:429,message:privateBody}},
  ])});
  assert.equal(targetPause.status,3,targetPause.stderr);assert.equal(JSON.parse(targetPause.stdout).phase,'targets');
  assert.equal(JSON.parse(targetPause.stdout).after,0);assert.equal(invokeCalls(targets).length,2);noSecrets(targetPause);
  const check=fixture(t),checkPause=check.run(undefined,{TEST_PAGE_PLAN:JSON.stringify([
    {...checkPage,after:2,complete:false},{failure:{type:'RATE_LIMITED',message:privateBody}},
  ])});
  assert.equal(checkPause.status,3,checkPause.stderr);assert.equal(invokeCalls(check).length,2);noSecrets(checkPause);
  const checked=JSON.parse(checkPause.stdout);assert.equal(checked.phase,'owned_states');assert.equal(checked.after,2);
  assert.equal(checked.owned_state_counts_partial,true);assert.equal(checked.duplicate_owned_state_bytes,768);
});

test('throttling before a verified page cannot claim a preserved checkpoint and unknown failures stay operational',t=>{
  for(const plan of [[{failure:{status:429,message:privateBody,parameters:{retry_after:30}}}],
    [{rewritten:0,boundary:12,after:2,complete:false,head_unchanged:true},{failure:{type:'UNKNOWN_RATE_TYPE',message:privateBody}}]]){
    const f=fixture(t),result=f.run(pageArgs,{TEST_PAGE_PLAN:JSON.stringify(plan)});
    rejected(result);assert.equal(result.stdout,'');assert.equal(invokeCalls(f).length,plan.length);
  }
});

test('targets stay nonpaged and capped at25 while the whole invocation retains its hosted-call and rewrite caps',t=>{
  const f=fixture(t),limits=[1,2,4,8,16,...Array(15).fill(25)],plan=limits.map(rewritten=>({rewritten,boundary:100,after:0,complete:false,head_unchanged:true}));
  const result=f.run([...applyArgs,'--phase','targets','--boundary','100'],{TEST_PAGE_PLAN:JSON.stringify(plan)});
  assert.equal(result.status,0,result.stderr);noSecrets(result);
  const calls=invokeCalls(f);assert.equal(calls.length,20);assert.deepEqual(calls.map(row=>row.input.limit),limits);assert.ok(calls.every(row=>row.input.after===0));
  const display=JSON.parse(result.stdout);assert.equal(display.rewritten,406);assert.ok(display.rewritten<=500);assert.equal(display.complete,false);
});

test('minimum rewrite failures and unrelated failures stop instead of retrying indefinitely',t=>{
  for(const plan of [[{failure:'database or disk is full '+providerSecret}],
    [{rewritten:0,boundary:12,after:2,complete:false,head_unchanged:true},{failure:'Database query timed out '+privateBody}]]){
    const f=fixture(t),result=f.run(pageArgs,{TEST_PAGE_PLAN:JSON.stringify(plan)});rejected(result);assert.equal(invokeCalls(f).length,plan.length);
  }
});

test('bounded check aggregates partitions and labels unfinished or explicitly ranged counts partial',t=>{
  const f=fixture(t),plan=Array.from({length:20},(_,i)=>({...checkPage,boundary:100,after:i+1,complete:false,duplicate_owned_state_bytes:10,owned_state_compactable:1}));
  const result=f.run(undefined,{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,0,result.stderr);
  const display=JSON.parse(result.stdout);assert.equal(display.complete,false);assert.equal(display.calls,20);assert.equal(display.duplicate_owned_state_bytes,200);assert.equal(display.owned_state_compactable,20);assert.equal(display.owned_state_counts_partial,true);
  const calls=invokeCalls(f);assert.equal(calls[0].input.phase,'base');assert.ok(calls.slice(1).every(row=>row.input.phase==='owned_states'&&row.input.boundary===100));
  const ranged=fixture(t),snapshot=ranged.run(['--app-id','54321','--after','5','--boundary','12']);assert.equal(snapshot.status,0);assert.equal(JSON.parse(snapshot.stdout).owned_state_counts_partial,true);
  const isolated=fixture(t),onlyOwned=isolated.run(['--app-id','54321','--phase','owned_states']);assert.equal(onlyOwned.status,0);
  assert.equal(invokeCalls(isolated)[0].input.phase,'owned_states');assert.equal(JSON.parse(onlyOwned.stdout).events,undefined);
});

test('gift check aggregates only its bounded counters and retains a resumable verified cursor',t=>{
  const f=fixture(t),plan=Array.from({length:20},(_,i)=>({...giftCheckPage,boundary:100,after:i+1,complete:false,duplicate_gift_state_bytes:10,gift_state_compactable:1}));
  const args=['--app-id','54321','--mode','check','--phase','gift_states'];
  const result=f.run(args,{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,0,result.stderr);noSecrets(result);
  const display=JSON.parse(result.stdout);assert.equal(display.complete,false);assert.equal(display.phase,'gift_states');assert.equal(display.calls,20);
  assert.equal(display.duplicate_gift_state_bytes,200);assert.equal(display.gift_state_compactable,20);assert.equal(display.gift_state_counts_partial,true);
  assert.equal(display.events,undefined);assert.equal(display.duplicate_owned_state_bytes,undefined);assert.equal(display.owned_state_counts_partial,undefined);
  const calls=invokeCalls(f);assert.ok(calls.every(row=>row.input.phase==='gift_states'));assert.equal(calls[0].input.boundary,0);assert.ok(calls.slice(1).every(row=>row.input.boundary===100));
  const ranged=fixture(t),resumed=ranged.run([...args,'--after','5','--boundary','12']);assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(invokeCalls(ranged)[0].input.after,5);assert.equal(JSON.parse(resumed.stdout).gift_state_counts_partial,true);
  const complete=fixture(t),completed=complete.run(args);assert.equal(completed.status,0,completed.stderr);assert.equal(JSON.parse(completed.stdout).gift_state_counts_partial,false);
  for(const patch of [{duplicate_gift_state_bytes:-1},{duplicate_gift_state_bytes:1.5},{gift_state_compactable:'6'}]){
    const invalid=fixture(t);rejected(invalid.run(args,{TEST_RESULT_PATCH:JSON.stringify(patch)}));
  }
});

test('gift apply uses a frozen cursor, at most four rewrites, and only the last verified progress after throttling',t=>{
  const f=fixture(t),plan=[{rewritten:0,boundary:12,after:2,complete:false,head_unchanged:true},
    {rewritten:2,boundary:12,after:5,complete:false,head_unchanged:true},{rewritten:4,boundary:12,after:9,complete:false,head_unchanged:true},
    {failure:{status:429,message:privateBody+' '+providerSecret,parameters:{retry_after:12}}}];
  const result=f.run([...applyArgs,'--phase','gift_states','--boundary','12'],{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,3,result.stderr);noSecrets(result);
  const calls=invokeCalls(f);assert.deepEqual(calls.map(row=>row.input.limit),[1,2,4,4]);assert.deepEqual(calls.map(row=>row.input.after),[0,2,5,9]);
  assert.ok(calls.every(row=>row.input.phase==='gift_states'&&row.input.boundary===12));
  assert.deepEqual(JSON.parse(result.stdout),{mode:'apply',rewritten:6,head_unchanged:true,phase:'gift_states',after:9,boundary:12,
    complete:false,calls:4,provider_requests:0,paused_reason:'rate_limit',retry_after_seconds:12});
});

test('budget maintenance requires all deployed budget readers and stays explicitly selected',t=>{
  const missing=[['lib/budget-reset-checkpoint-storage','budgetResetSource'],['lib/budget-reset-checkpoint-storage','findBudgetResetSource'],
    ['lib/budget-reset-checkpoint-storage','__checkpoint_budget_reset_sequence'],['lib/budget-reset-checkpoint-storage','BUDGET_RESET_MARKER'],
    ['lib/budget-reset-checkpoint-storage','decodeBudgetResetReference'],['lib/budget-reset-checkpoint-storage','budgetResetStorageStatsPage'],
    ['lib/budget-reset-checkpoint-storage','compactCheckpointBudgetResetsPage'],['lib/checkpoint-storage','decodeBudgetResetReference'],
    ['lib/checkpoint-storage','createBudgetResetCheckpointStorage'],['lib/checkpoint-storage','BUDGET_RESET_MARKER'],
    ['lib/cloud-repository','checkpoints.budgetResetSource'],['lib/cloud-repository','BUDGET_RESET_SOURCE_FENCE']];
  for(const pair of missing){
    const f=fixture(t),result=f.run([...applyArgs,'--phase','budget_resets'],{TEST_MISSING_SYMBOL:JSON.stringify(pair)});
    rejected(result);assert.match(result.stderr,/Publish the checkpoint reader/);assert.equal(invokeCalls(f).length,0);
  }
  const missingModule=fixture(t),missingResult=missingModule.run([...applyArgs,'--phase','budget_resets'],{TEST_NO_BUDGET_READER:'1'});
  rejected(missingResult);assert.match(missingResult.stderr,/Publish the checkpoint reader/);assert.equal(invokeCalls(missingModule).length,0);
  const f=fixture(t),result=f.run(applyArgs);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(invokeCalls(f).map(row=>row.input.phase),['jobs','targets','owned_states','gift_states']);
});

test('explicit budget check aggregates only bounded budget counters without changing default inventory semantics',t=>{
  const args=['--app-id','54321','--mode','check','--phase','budget_resets'];
  const f=fixture(t),result=f.run(args,{TEST_PAGE_PLAN:JSON.stringify([
    {...budgetCheckPage,after:4,complete:false},{...budgetCheckPage,after:11,complete:true},
  ])});assert.equal(result.status,0,result.stderr);noSecrets(result);
  const display=JSON.parse(result.stdout);assert.equal(display.phase,'budget_resets');assert.equal(display.complete,true);assert.equal(display.calls,2);
  assert.equal(display.duplicate_budget_reset_bytes,384);assert.equal(display.budget_reset_compactable,8);assert.equal(display.budget_reset_counts_partial,false);
  assert.equal(display.events,undefined);assert.equal(display.duplicate_owned_state_bytes,undefined);assert.equal(display.duplicate_gift_state_bytes,undefined);
  assert.deepEqual(invokeCalls(f).map(row=>[row.input.phase,row.input.after,row.input.boundary]),[['budget_resets',0,0],['budget_resets',4,12]]);
  const ranged=fixture(t),resumed=ranged.run([...args,'--after','5','--boundary','12']);assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).budget_reset_counts_partial,true);
  for(const patch of [{duplicate_budget_reset_bytes:-1},{duplicate_budget_reset_bytes:1.5},{budget_reset_compactable:'4'}]){
    const invalid=fixture(t);rejected(invalid.run(args,{TEST_RESULT_PATCH:JSON.stringify(patch)}));
  }
});

test('explicit budget apply preserves bounded frozen progress and stops at the final budget partition',t=>{
  const f=fixture(t),plan=[{rewritten:0,boundary:12,after:2,complete:false,head_unchanged:true},
    {rewritten:2,boundary:12,after:5,complete:false,head_unchanged:true},{rewritten:4,boundary:12,after:9,complete:false,head_unchanged:true},
    {rewritten:1,boundary:12,after:11,complete:true,head_unchanged:true}];
  const result=f.run([...applyArgs,'--phase','budget_resets','--boundary','12'],{TEST_PAGE_PLAN:JSON.stringify(plan)});assert.equal(result.status,0,result.stderr);noSecrets(result);
  const calls=invokeCalls(f);assert.deepEqual(calls.map(row=>row.input.limit),[1,2,4,4]);assert.deepEqual(calls.map(row=>row.input.after),[0,2,5,9]);
  assert.ok(calls.every(row=>row.input.phase==='budget_resets'&&row.input.boundary===12));
  assert.deepEqual(JSON.parse(result.stdout),{mode:'apply',rewritten:7,head_unchanged:true,phase:'budget_resets',after:11,boundary:12,complete:true,calls:4,provider_requests:0});
});

test('budget apply pauses at the last verified cursor after management throttling without retrying',t=>{
  const f=fixture(t),result=f.run([...applyArgs,'--phase','budget_resets','--boundary','12'],{TEST_PAGE_PLAN:JSON.stringify([
    {rewritten:1,boundary:12,after:4,complete:false,head_unchanged:true},
    {failure:{status:429,message:privateBody+' '+providerSecret+' '+token,parameters:{retry_after:15}}},
  ])});assert.equal(result.status,3,result.stderr);noSecrets(result);assert.equal(invokeCalls(f).length,2);
  assert.deepEqual(JSON.parse(result.stdout),{mode:'apply',rewritten:1,head_unchanged:true,phase:'budget_resets',after:4,boundary:12,
    complete:false,calls:2,provider_requests:0,paused_reason:'rate_limit',retry_after_seconds:15});
});

test('server wrapper checks authorization and bounds before touching storage and check stays read-only',async t=>{
  const f=fixture(t);let reads=0,writes=0;
  const repo={async ownedStateStorageStatsPage(input){reads++;assert.deepEqual(input,{after:0,boundary:0});return checkPage;},async checkpointStorageStats(){reads++;return baseStats;},async ownedTargetStorageStats(){reads++;return baseStats;}};
  const handler=runtime(f,{async run(){writes++;}},repo),ctx={initData:{user:{id:owner}}};
  for(const other of [undefined,{}, {initData:{user:{id:43}}}])await assert.rejects(handler({mode:'apply',phase:'owned_states',limit:4},other),/Private access denied/);
  for(const input of [null,{}, {mode:'delete'}, {mode:'apply',phase:'owned_states',limit:8}, {mode:'check',phase:'base',limit:1},
    {mode:'apply',phase:'jobs',after:1,limit:5}, {mode:'apply',phase:'targets',after:1,limit:1}, {mode:'apply',phase:'targets',limit:26},
    {mode:'apply',phase:'gift_states',limit:5},{mode:'check',phase:'gift_states',clear_cache:true},
    {mode:'apply',phase:'budget_resets',limit:5},{mode:'check',phase:'budget_resets',limit:1},
    {mode:'check',phase:'base',after:-1}, {mode:'check',phase:'base',extra:true}])await assert.rejects(handler(input,ctx),/Invalid maintenance/);
  assert.equal(reads,0);assert.equal(writes,0);const result=await handler({mode:'check',phase:'base'},ctx);assert.equal(result.provider_requests,0);assert.equal(writes,0);
});

test('server apply skips full inventory, preserves the exact head, and allows concurrent normal commits',async t=>{
  const f=fixture(t),checkpoint={revision:12,state:{attempts:[1000],next_allowed_at:9000,owned_prices:{attempts:[2000],run:{pending:[{holding_contract:'saved-holder'}],lease:'opaque'}}}};
  let reads=0;const deletes=[],inputs=[];
  const repo={async checkpointStorageStats(){throw Error('Apply must not perform inventory');},async ownedTargetStorageStats(){throw Error('Apply must not perform inventory');},
    async ownedStateStorageStats(){throw Error('Full owned inventory is forbidden');},async compactCheckpointOwnedStates(){throw Error('Full owned apply is forbidden');},
    async read(){reads++;return structuredClone(checkpoint);},async compactCheckpointOwnedStatesPage(input){inputs.push(input);return{rewritten:0,boundary:12,after:5,complete:false};}};
  const handler=runtime(f,{async run(sql){deletes.push(sql);return{rowsAffected:0};}},repo),ctx={initData:{user:{id:owner}}};
  const result=await handler({mode:'apply',phase:'owned_states',after:0,boundary:12,limit:4,clear_cache:true},ctx);
  assert.equal(result.head_unchanged,true);assert.equal(result.complete,false);assert.equal(result.after,5);assert.equal(reads,2);
  assert.deepEqual(inputs,[{boundary:12,after:0,limit:4}]);assert.deepEqual(deletes,['DELETE FROM dashboard_projection_cache']);
  reads=0;repo.read=async()=>reads++?{revision:12,state:{attempts:[]}}:structuredClone(checkpoint);
  await assert.rejects(handler({mode:'apply',phase:'owned_states',limit:1},ctx),/Checkpoint preservation check failed/);
  reads=0;repo.read=async()=>reads++?{revision:13,state:{attempts:[]}}:structuredClone(checkpoint);
  assert.equal((await handler({mode:'apply',phase:'owned_states',limit:1},ctx)).head_unchanged,false);
});

test('server jobs apply uses the paged API with a saved cursor and performs no full inventory or count scan',async t=>{
  const f=fixture(t),head={revision:12,state:{job:{id:1,state:'partial',cursor:'opaque-cursor'},attempts:[1000],next_allowed_at:9000}};
  const inputs=[],deletes=[];let reads=0;
  const forbidden=async()=>{throw Error('Unbounded inventory or compaction is forbidden');};
  const repo={checkpointStorageStats:forbidden,ownedTargetStorageStats:forbidden,ownedStateStorageStats:forbidden,
    compactCheckpointJobs:forbidden,compactCheckpointOwnedStates:forbidden,
    async read(){reads++;return structuredClone(head);},
    async compactCheckpointJobsPage(input){inputs.push(input);return{rewritten:0,boundary:12,after:9,complete:false};}};
  const handler=runtime(f,{async run(sql){deletes.push(sql);return{rowsAffected:0};}},repo),ctx={initData:{user:{id:owner}}};
  const result=await handler({mode:'apply',phase:'jobs',after:5,boundary:12,limit:4,clear_cache:true},ctx);
  assert.equal(result.head_unchanged,true);assert.equal(result.complete,false);assert.equal(result.after,9);assert.equal(result.rewritten,0);assert.equal(reads,2);
  assert.deepEqual(inputs,[{boundary:12,after:5,limit:4}]);assert.deepEqual(deletes,['DELETE FROM dashboard_projection_cache']);
  reads=0;await assert.rejects(handler({mode:'apply',phase:'jobs',after:13,boundary:12,limit:4},ctx),/Invalid maintenance/);assert.equal(reads,0);
  await assert.rejects(handler({mode:'apply',phase:'jobs',after:0,boundary:13,limit:4},ctx),/Invalid maintenance bound/);assert.equal(inputs.length,1);
});

test('server gift check and apply call only their bounded APIs and preserve the complete durable head',async t=>{
  const f=fixture(t),head={revision:12,state:{gift_refresh:{portfolio_fingerprint:'synthetic-portfolio',run:{pending:[{nft:'synthetic-gift'}],checked:4},last_complete:{started_at:'2026-10-11T12:00:00Z'}},
    attempts:[1000],job:{id:1,cursor:'opaque-saved-cursor'}}};
  const inputs=[],deletes=[];let reads=0;
  const forbidden=async()=>{throw Error('Unbounded inventory or compaction is forbidden');};
  const repo={checkpointStorageStats:forbidden,ownedTargetStorageStats:forbidden,ownedStateStorageStats:forbidden,giftStateStorageStats:forbidden,
    compactCheckpointJobs:forbidden,compactCheckpointOwnedStates:forbidden,compactCheckpointGiftStates:forbidden,
    async read(){reads++;return structuredClone(head);},
    async giftStateStorageStatsPage(input){inputs.push({check:input});return giftCheckPage;},
    async compactCheckpointGiftStatesPage(input){inputs.push({apply:input});return{rewritten:2,boundary:12,after:9,complete:false};}};
  const handler=runtime(f,{async run(sql){deletes.push(sql);return{rowsAffected:0};}},repo),ctx={initData:{user:{id:owner}}};
  const checked=await handler({mode:'check',phase:'gift_states',after:5,boundary:12},ctx);
  assert.equal(checked.duplicate_gift_state_bytes,384);assert.equal(checked.provider_requests,0);assert.equal(reads,0);assert.deepEqual(deletes,[]);
  const result=await handler({mode:'apply',phase:'gift_states',after:5,boundary:12,limit:4,clear_cache:true},ctx);
  assert.equal(result.head_unchanged,true);assert.equal(result.complete,false);assert.equal(result.after,9);assert.equal(result.rewritten,2);assert.equal(reads,2);
  assert.deepEqual(inputs,[{check:{after:5,boundary:12}},{apply:{boundary:12,after:5,limit:4}}]);assert.deepEqual(deletes,['DELETE FROM dashboard_projection_cache']);
  reads=0;repo.read=async()=>reads++?{revision:12,state:{...head.state,gift_refresh:{run:{pending:[]}}}}:structuredClone(head);
  await assert.rejects(handler({mode:'apply',phase:'gift_states',limit:1},ctx),/Checkpoint preservation check failed/);
});

test('server budget check and atomic apply use only bounded APIs and verify the complete durable head',async t=>{
  const f=fixture(t),head={revision:12,state:{budget_resets:[{id:'saved-reset',at:1000}],attempts:[1100],next_allowed_at:9000,
    gift_refresh:{run:{pending:['saved-gift']},last_complete:{checked:161}},job:{id:1,cursor:'opaque-saved-cursor'}}};
  const inputs=[],deletes=[];let reads=0;
  const forbidden=async()=>{throw Error('Unbounded inventory or compaction is forbidden');};
  const repo={checkpointStorageStats:forbidden,ownedTargetStorageStats:forbidden,ownedStateStorageStats:forbidden,budgetResetStorageStats:forbidden,
    compactCheckpointJobs:forbidden,compactCheckpointBudgetResets:forbidden,
    async read(){reads++;return structuredClone(head);},
    async budgetResetStorageStatsPage(input){inputs.push({check:input});return budgetCheckPage;},
    async compactCheckpointBudgetResetsPage(input){inputs.push({apply:input});return{rewritten:2,boundary:12,after:9,complete:false};}};
  const handler=runtime(f,{async run(sql){deletes.push(sql);return{rowsAffected:0};}},repo),ctx={initData:{user:{id:owner}}};
  const checked=await handler({mode:'check',phase:'budget_resets',after:5,boundary:12},ctx);
  assert.equal(checked.duplicate_budget_reset_bytes,192);assert.equal(checked.provider_requests,0);assert.equal(reads,0);assert.deepEqual(deletes,[]);
  const result=await handler({mode:'apply',phase:'budget_resets',after:5,boundary:12,limit:4,clear_cache:true},ctx);
  assert.equal(result.head_unchanged,true);assert.equal(result.complete,false);assert.equal(result.after,9);assert.equal(result.rewritten,2);assert.equal(reads,2);
  assert.deepEqual(inputs,[{check:{after:5,boundary:12}},{apply:{boundary:12,after:5,limit:4}}]);assert.deepEqual(deletes,['DELETE FROM dashboard_projection_cache']);
  reads=0;repo.read=async()=>reads++?{revision:12,state:{...head.state,budget_resets:[]}}:structuredClone(head);
  await assert.rejects(handler({mode:'apply',phase:'budget_resets',limit:1},ctx),/Checkpoint preservation check failed/);
});
