import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPrivateKey,sign} from 'node:crypto';
import {createPublicRuntime,validatePublicReleaseConfig} from '../tgcloud/lib/public-runtime.js';
import {publicReleaseConfig} from '../public-release-config.example.js';
import {publicWalletProofDigest} from '../tgcloud/lib/public-wallet.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {streamedBody} from './fixtures/http-response.mjs';
import {portableModules} from './fixtures/portable-modules.mjs';
import {CloudStorageFullError} from '../tgcloud/lib/cloud-repository.js';
import {StorageCapacityError} from '../tgcloud/lib/storage-admission.js';
import {PublicCredentialChangedError,PublicAccountError} from '../tgcloud/lib/public-repository.js';
const account=JSON.parse(readFileSync(new URL('./fixtures/public-wallet-state-init.json',import.meta.url),'utf8'))[1].account;
const seed=createPrivateKey({key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'),format:'der',type:'pkcs8'});
const user=id=>({initData:{user:{id}}});
const address=n=>`0:${n.toString(16).padStart(64,'0')}`,collection=address(42),nft=address(43);
const catalog=[{address:collection,name:'Test gifts',extra_data:{}}];
const item={address:nft,owner_address:account.address,collection_address:collection,init:true,last_transaction_lt:'100',content:{name:'Gift #1',attributes:[{trait_type:'Model',value:'Test model'},{trait_type:'Backdrop',value:'Black'}]}};
const config={...publicReleaseConfig,enabled:true,preservePrivateOwner:false,invitedUserIds:['12345','67890'],origin:'https://gift.example.test',privacyPolicyUrl:'https://gift.example.test/privacy',termsUrl:'https://gift.example.test/terms',storageEncryptionConfirmed:true,providerUseApproved:true};
function setup(t,extra={},createRuntime=createPublicRuntime) {
  const f=createPublicDatabase(t),calls=[];let at=Date.now(),holdingPages=0,providerHook=null;
  const runtime=createRuntime({db:f.db,config:{...config,...extra},masterKey:'ab'.repeat(32),clock:async()=>at,fetch:async(url,options)=>{
    if(providerHook)await providerHook(url,options);
    calls.push({url,options});let body;
    if(url.includes('/v1/collections/gifts/'))body=catalog;
    else if(url.includes('/v1/rent/gifts/'))body={cursor:null,items:[{nft_address:nft,nft_name:'Gift #1',owner:account.address,attributes:[],min_duration:1,max_duration:30,discount_per_day:0,listed_at:null,price_per_day:'190000000'}]};
    else if(url.includes('/nft/transfers'))body={nft_transfers:[]};
    else if(url.includes('/nft/items'))body={nft_items:url.includes('owner_address=')?(holdingPages++===0?[item]:[]):[item]};
    else throw new Error('Unexpected mocked provider route');
    return {status:200,url,headers:{get:()=>null},body:streamedBody(JSON.stringify(body))};
  }});
  return {...f,runtime,calls,advance:ms=>at+=ms,now:()=>at,setProviderHook:hook=>providerHook=hook};
}
async function onboard(f,id=12345,key='synthetic-user-key-12345') {
  const initial=await f.runtime.invokeAccount('getPublicAccount',{},user(id));
  assert.equal(initial.account.marketapp_key.configured,false);
  assert.equal(initial.account.privacy_policy_url,config.privacyPolicyUrl);assert.equal(initial.account.terms_url,config.termsUrl);
  const challenge=await f.runtime.invokeWallet('startWalletVerification',{},user(id));assert.ok(challenge.challenge,JSON.stringify(challenge));
  const proof={timestamp:Math.floor(f.now()/1000),domain:{lengthBytes:Buffer.byteLength(challenge.domain),value:challenge.domain},payload:challenge.challenge};
  proof.signature=sign(null,publicWalletProofDigest(account.address,proof),seed).toString('base64');
  const bound=await f.runtime.invokeWallet('finishWalletVerification',{attempt_id:challenge.attempt_id,account,proof},user(id));
  assert.equal(bound.account?.wallet?.address,account.address,JSON.stringify(bound));
  const saved=await f.runtime.invokeAccount('saveMarketappApiKey',{api_key:key},user(id));assert.equal(saved.account?.onboarding_complete,true,JSON.stringify(saved));
  return key;
}
test('public config is closed by default and rejects unsafe rollout settings without provisioning accounts',async t=>{
  assert.equal(publicReleaseConfig.enabled,false);
  assert.equal(publicReleaseConfig.openRegistration,false);
  assert.deepEqual(publicReleaseConfig.invitedUserIds,[]);
  for(const key of ['origin','privacyPolicyUrl','termsUrl'])assert.equal(publicReleaseConfig[key],'');
  for(const key of ['storageEncryptionConfirmed','providerUseApproved'])assert.equal(publicReleaseConfig[key],false);
  const f=setup(t,{enabled:false});const response=await f.runtime.invokeAccount('getPublicAccount',{},user(12345));assert.equal(response.error.code,'PUBLIC_MODE_DISABLED');assert.equal(f.queries.length,0);
  for(const patch of [{openRegistration:'false'},{origin:'http://gift.example.test'},{storageEncryptionConfirmed:false},{providerUseApproved:false},{invitedUserIds:[]},{privacyPolicyUrl:''},{maxAccounts:101}])assert.throws(()=>validatePublicReleaseConfig({...config,...patch}));
  const permitted=setup(t);assert.equal((await permitted.runtime.invokeCloud('getDashboard',{},user(777))).error.code,'PUBLIC_ACCESS_DENIED');
  assert.equal((await permitted.runtime.invokeCloud('getDashboard',{},{})).error.code,'PUBLIC_ACCESS_DENIED');assert.equal(permitted.queries.length,0);
});

test('invited dashboard reads expose only safe failure codes and retain account and mutation contracts',async t=>{
  const f=setup(t),get=f.db.get;
  for(const name of ['getDashboard','getDashboardRevision','getJobs']) {
    for(const [failure,expected] of [[Object.assign(Error('private database query'),{code:'SQLITE_LOCKED'}),'READ_BUSY'],
      [Object.assign(Error('private database query'),{type:'DEADLINE_EXCEEDED'}),'READ_TIMEOUT'],
      [Object.assign(Error('private database query'),{code:'SQLITE_NOMEM'}),'READ_LIMIT'],[Error('private database query'),'READ_FAILED'],
      [new CloudStorageFullError(),'STORAGE_FULL'],[new StorageCapacityError(),'STORAGE_CAPACITY_PAUSED'],
      [new PublicCredentialChangedError(),'PUBLIC_KEY_CHANGED'],[new PublicAccountError(),'PUBLIC_ACCOUNT_DELETED']]) {
      f.db.get=async()=>{throw failure;};
      assert.deepEqual(await f.runtime.invokeCloud(name,{},user(12345)),{error:{code:expected}});
    }
  }
  f.db.get=async()=>{throw Object.assign(Error('private database query'),{code:'SQLITE_BUSY'});};
  assert.deepEqual(await f.runtime.invokeCloud('startJob',{kind:'prices',account_generation:0},user(12345)),{error:{code:'PUBLIC_REQUEST_FAILED'}});
  assert.deepEqual(await f.runtime.invokeCloud('getDashboard',{},user(777)),{error:{code:'PUBLIC_ACCESS_DENIED'}});
  f.db.get=get;
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(12345))).summary.portfolio_count,0);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{pricing_source:'unsupported'},user(12345))).error.code,'PUBLIC_REQUEST_FAILED');
  assert.equal(f.calls.length,0);
});
test('wallet proof, encrypted own key, bounded discovery/resume, collection and offline reads work through runtime',async t=>{
  const f=setup(t),key=await onboard(f);assert.equal(f.calls.length,0);
  const encrypted=f.database.prepare('SELECT ciphertext FROM public_provider_credentials').get().ciphertext;assert.ok(!encrypted.includes(key));
  let result=await f.runtime.invokeCloud('startJob',{kind:'discover',account_generation:0},user(12345));assert.equal(result.job?.kind,'discover',JSON.stringify(result));const id=result.job.id;
  assert.equal(result.job.account_generation,0);
  result=await f.runtime.invokeCloud('stepJob',{job_id:id,account_generation:0},user(12345));assert.equal(f.calls.length,1,JSON.stringify(result)); // catalog committed once
  f.advance(121000);result=await f.runtime.invokeCloud('stepJob',{job_id:id,account_generation:0},user(12345));assert.equal(result.job.state,'partial');
  result=await f.runtime.invokeCloud('resumeJob',{job_id:id,account_generation:0},user(12345));assert.equal(result.job.state,'running');
  for(let i=0;i<15&&result.job.state!=='complete';i++){f.advance(1001);result=await f.runtime.invokeCloud('stepJob',{job_id:id,account_generation:0},user(12345));assert.ok(result.job,JSON.stringify(result));}
  assert.equal(result.job.state,'complete');assert.equal(result.job.progress.enumeration_complete,true);
  assert.equal(f.calls.filter(call=>call.url.includes('/v1/collections/gifts/')).length,1,'resume reuses committed catalog');
  const dashboard=await f.runtime.invokeCloud('getDashboard',{pricing_source:'rentals',timeframe:'30d'},user(12345));
  assert.equal(dashboard.summary.portfolio_count,1);assert.equal(dashboard.gifts[0].state,'held_directly');assert.equal(dashboard.capabilities.public_account,true);
  assert.equal(dashboard.update_token,(await f.runtime.invokeCloud('getDashboardRevision',{},user(12345))).token);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(67890))).summary.portfolio_count,0);
  assert.equal((await f.runtime.invokeCloud('getJobs',{},user(67890))).jobs.length,0);
  assert.equal((await f.runtime.invokeCloud('importChunk',{records:[{kind:'portfolio',record:{nft_address:nft}}]},user(67890))).error.code,'PUBLIC_ACCESS_DENIED');
  f.advance(1001);result=await f.runtime.invokeCloud('startJob',{kind:'prices',timeframe:'30d',account_generation:0},user(12345));assert.ok(result.job,JSON.stringify(result));
  for(let i=0;i<10&&result.job.state!=='complete';i++){f.advance(1001);result=await f.runtime.invokeCloud('stepJob',{job_id:result.job.id,account_generation:0},user(12345));assert.ok(result.job,JSON.stringify(result));}
  assert.equal(result.job.state,'complete');const after=await f.runtime.invokeCloud('getDashboard',{},user(12345));assert.equal(after.gifts[0].price_per_day,'0.19');
  for(const call of f.calls){assert.equal(call.options.method,'GET');if(call.url.includes('api.marketapp.org'))assert.equal(call.options.headers.Authorization,key);else assert.equal(call.options.headers.Authorization,undefined);}
  const count=f.calls.length;await f.runtime.invokeCloud('getDashboard',{},user(12345));await f.runtime.invokeCloud('getJobs',{},user(12345));await f.runtime.invokeOwnedPrice('getStatus',{},user(12345));assert.equal(f.calls.length,count,'offline inspection never fetches providers');
});
test('corrupt key stays replaceable and deletable; delete fences old instances and permits deliberate empty reactivation',async t=>{
  const f=setup(t);await onboard(f);f.database.prepare("UPDATE public_provider_credentials SET ciphertext='010000'").run();
  assert.equal((await f.runtime.invokeAccount('getPublicAccount',{},user(12345))).account.marketapp_key.configured,true);
  assert.equal((await f.runtime.invokeAccount('saveMarketappApiKey',{api_key:'replacement-key-12345'},user(12345))).account.marketapp_key.configured,true);
  const old=f.repository('12345');await old.read();assert.equal((await f.runtime.invokeAccount('deletePublicAccount',{confirm:true},user(12345))).account.deleted,true);
  await assert.rejects(old.append(0,{key:'late',state:{},records:[],observed_at:new Date().toISOString()}));
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(12345))).summary.portfolio_count,0);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(12345))).update_token,(await f.runtime.invokeCloud('getDashboardRevision',{},user(12345))).token);
  assert.equal((await f.runtime.invokeAccount('reactivatePublicAccount',{confirm:true},user(12345))).account.marketapp_key.configured,false);
  assert.equal((await f.runtime.invokeCloud('getJobs',{},user(12345))).jobs.length,0);
});
test('a key removed by another tab during Check key never reaches the provider or returns false success',async t=>{
  const f=setup(t);await onboard(f);const original=f.db.run;let revoked=false;
  f.db.run=async(sql,params)=>{
    const result=await original(sql,params);
    if(!revoked&&params?.[':key']?.startsWith('public-key-test:')) {
      revoked=true;const removal=await f.runtime.invokeAccount('removeMarketappApiKey',{},user(12345));assert.equal(removal.account.marketapp_key.configured,false);
    }return result;
  };
  const result=await f.runtime.invokeAccount('testMarketappApiKey',{},user(12345));assert.equal(result.error.code,'PUBLIC_KEY_CHANGED');assert.equal(f.calls.length,0);
});
test('key revocation remains available when saved payload storage is exhausted',async t=>{
  const f=setup(t);await onboard(f);const repo=f.repository('12345'),saved=await repo.read();
  f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('quota-fixture','12345',saved.revision+1,'quota-fixture',JSON.stringify(saved.state),'[]','x'.repeat(8388609),new Date(f.now()).toISOString());
  const count=f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n;
  const result=await f.runtime.invokeAccount('removeMarketappApiKey',{},user(12345));assert.equal(result.account.marketapp_key.configured,false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n,count);assert.equal((await repo.credentialStatus('marketapp')).ciphertext,null);
});

test('the complete public runtime graph verifies wallets, encrypts keys and isolates accounts without host globals',async t=>{
  const portable=portableModules(),runtime=portable.load('public-runtime.js');
  assert.equal(portable.evaluate('[typeof URL,typeof URLSearchParams,typeof Buffer,typeof process,typeof require,typeof crypto,typeof setTimeout,typeof AbortController].join(",")'),Array(8).fill('undefined').join(','));
  const f=setup(t,{},runtime.createPublicRuntime);await onboard(f);
  const account=await f.runtime.invokeAccount('getPublicAccount',{},user(12345));assert.equal(account.account.onboarding_complete,true);
  assert.equal((await f.runtime.invokeAccount('getPublicAccount',{},user(67890))).account.marketapp_key.configured,false);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(12345))).capabilities.public_account,true);
  assert.equal((await f.runtime.invokeAccount('removeMarketappApiKey',{},user(12345))).account.marketapp_key.configured,false);
  assert.equal(f.calls.length,0);
});

test('public refresh mutations require the observed account generation before any provider request',async t=>{
  const f=setup(t);await onboard(f);
  for(const account_generation of [undefined,null,-1,1.5,'0',1]) {
    const input=account_generation===undefined?{}:{account_generation};
    for(const name of ['startJob','stepJob','resumeJob','stopJob','refreshStartupComparisons']) {
      const result=await f.runtime.invokeCloud(name,{...input,...(name==='startJob'?{kind:'discover'}:{job_id:1})},user(12345));
      assert.equal(result.error?.code,'PUBLIC_ACCOUNT_CHANGED',`${name}: ${JSON.stringify(input)}`);
    }
    for(const name of ['start','step','stop']) {
      const result=await f.runtime.invokeOwnedPrice(name,{...input,...(name==='start'?{session_id:'generation-test-session'}:{run_id:1})},user(12345));
      assert.equal(result.error?.code,'PUBLIC_ACCOUNT_CHANGED');
    }
  }
  assert.equal(f.calls.length,0);
});

test('automatic comparisons isolate accounts and enforce own credential, verified wallet and hourly startup reservations',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  const input={kind:'prices',timeframe:'30d',account_generation:0};
  const owner=await f.runtime.invokeCloud('refreshStartupComparisons',input,user(12345));assert.equal(owner.state,'started',JSON.stringify(owner));
  assert.equal(owner.job.account_generation,0);assert.equal(owner.job.progress.marketapp_budget.invocation_limit,20);assert.equal(owner.job.progress.marketapp_budget.run_seconds,60);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(12345))).capabilities.startup_comparison_refresh,true);
  assert.equal((await f.runtime.invokeCloud('refreshStartupComparisons',input,user(67890))).error.code,'PUBLIC_WALLET_REQUIRED');
  assert.equal((await f.repository('67890').read()).state.startup_comparisons,undefined);
  await onboard(f,67890,'second-own-key-67890');await enrollKnownGift(f,67890);
  const second=await f.runtime.invokeCloud('refreshStartupComparisons',input,user(67890));assert.equal(second.state,'started',JSON.stringify(second));assert.equal(second.job.id,owner.job.id);
  assert.equal((await f.runtime.invokeCloud('refreshStartupComparisons',{...input,kind:'rental_prices',timeframe:'60d'},user(12345))).reason,'cooldown');
  const result=await f.runtime.invokeCloud('stepJob',{job_id:owner.job.id,account_generation:0},user(12345));assert.equal(result.job.progress.marketapp_budget.invocation_used,1);
  assert.equal(f.calls[0].options.headers.Authorization,'synthetic-user-key-12345');assert.equal(f.calls[0].options.headers.Cookie,undefined);
  assert.equal((await f.repository('67890').read()).state.job.invocation_used,0);assert.equal((await f.repository('67890').records()).filter(row=>row.kind==='collection').length,0);
});

test('automatic hourly reservation remains after API key replacement and denied quota allocates no activity',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const input={kind:'prices',timeframe:'30d',account_generation:0};
  const first=await f.runtime.invokeCloud('refreshStartupComparisons',input,user(12345));assert.equal(first.state,'started');
  await f.runtime.invokeCloud('stopJob',{job_id:first.job.id,account_generation:0},user(12345));
  const changed=await f.runtime.invokeAccount('saveMarketappApiKey',{api_key:'replacement-key-12345'},user(12345));assert.equal(changed.account.onboarding_complete,true);
  assert.equal((await f.runtime.invokeCloud('refreshStartupComparisons',{...input,kind:'rental_prices'},user(12345))).reason,'cooldown');
  assert.equal((await f.repository('12345').read()).state.job,null);assert.equal(f.calls.length,0);
  f.advance(3600000);assert.equal((await f.runtime.invokeCloud('refreshStartupComparisons',input,user(12345))).state,'started');
});

test('wallet disconnect at startup CAS fences the old automatic opening before job or provider work',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const original=f.db.run;let disconnected=false;
  f.db.run=async(sql,params)=>{
    if(!disconnected&&sql.startsWith('INSERT OR IGNORE INTO public_cloud_events')&&typeof params?.[':state']==='string'&&params[':state'].includes('startup_comparisons')) {
      disconnected=true;assert.equal((await f.runtime.invokeAccount('disconnectPublicWallet',{},user(12345))).account.wallet,null);
    }return original(sql,params);
  };
  const result=await f.runtime.invokeCloud('refreshStartupComparisons',{kind:'prices',timeframe:'30d',account_generation:0},user(12345));
  assert.equal(result.error.code,'PUBLIC_WALLET_CHANGED');assert.equal((await f.repository('12345').read()).state.job,null);assert.equal(f.calls.length,0);
});

test('delayed startup comparison response cannot commit after API key revocation',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const started=await f.runtime.invokeCloud('refreshStartupComparisons',{kind:'prices',timeframe:'30d',account_generation:0},user(12345));
  f.setProviderHook(async()=>{f.setProviderHook(null);assert.equal((await f.runtime.invokeAccount('removeMarketappApiKey',{},user(12345))).account.marketapp_key.configured,false);});
  const result=await f.runtime.invokeCloud('stepJob',{job_id:started.job.id,account_generation:0},user(12345));assert.equal(result.error.code,'PUBLIC_KEY_CHANGED');
  assert.equal((await f.repository('12345').records()).filter(row=>row.kind==='collection').length,0);assert.equal((await f.repository('12345').read()).state.startup_comparisons.job_id,started.job.id);
});

test('a delayed automatic comparison page cannot write after its wallet binding is revoked',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const started=await f.runtime.invokeCloud('refreshStartupComparisons',{kind:'prices',timeframe:'30d',account_generation:0},user(12345));
  const dbGet=f.db.get;f.db.get=async(sql,params)=>sql.includes('AS server_time')?{server_time:f.now()}:dbGet(sql,params);
  f.setProviderHook(async()=>{f.setProviderHook(null);await f.runtime.invokeCloud('stopJob',{job_id:started.job.id,account_generation:0},user(12345));f.advance(121000);await f.repository('12345').disconnectWallet();});
  const result=await f.runtime.invokeCloud('stepJob',{job_id:started.job.id,account_generation:0},user(12345));assert.equal(result.error.code,'PUBLIC_WALLET_CHANGED');
  assert.equal((await f.repository('12345').records()).filter(row=>row.kind==='collection').length,0);assert.equal((await f.repository('12345').read()).state.startup_comparisons.job_id,started.job.id);
});

test('public automatic opening with known shared API allowance exhaustion creates no collection activity',async t=>{
  const f=setup(t,{perUserMarketDailyAttempts:1});await onboard(f);await enrollKnownGift(f);
  const tested=await f.runtime.invokeAccount('testMarketappApiKey',{},user(12345));assert.equal(tested.status,'valid',JSON.stringify(tested));f.advance(1001);
  const result=await f.runtime.invokeCloud('refreshStartupComparisons',{kind:'prices',timeframe:'30d',account_generation:0},user(12345));assert.equal(result.reason,'provider_limit',JSON.stringify(result));
  assert.equal((await f.runtime.invokeCloud('getJobs',{},user(12345))).jobs.length,0);assert.equal(f.calls.length,1);assert.equal((await f.repository('12345').read()).state.startup_comparisons,undefined);
});

async function recreate(f) {
  let deletion=await f.runtime.invokeAccount('deletePublicAccount',{confirm:true},user(12345));
  while(deletion.account.pending_cleanup)deletion=await f.runtime.invokeAccount('getPublicAccount',{},user(12345));
  const result=await f.runtime.invokeAccount('reactivatePublicAccount',{confirm:true},user(12345));
  f.advance(61000);await onboard(f);return result.account.account_generation;
}
test('old browser commands cannot address a reused collection ID after account reactivation',async t=>{
  const f=setup(t);await onboard(f);
  const token=(await f.runtime.invokeCloud('getDashboardRevision',{},user(12345))).token;
  const old=(await f.runtime.invokeCloud('startJob',{kind:'discover',account_generation:0},user(12345))).job;
  const generation=await recreate(f);assert.ok(generation>old.account_generation);
  const current=(await f.runtime.invokeCloud('startJob',{kind:'discover',account_generation:generation},user(12345))).job;
  assert.equal(current.id,old.id,'the test exercises an actually reused ID');
  const before=await f.repository('12345').read();
  for(const name of ['stepJob','resumeJob','stopJob']) {
    const result=await f.runtime.invokeCloud(name,{job_id:old.id,account_generation:old.account_generation},user(12345));
    assert.equal(result.error.code,'PUBLIC_ACCOUNT_CHANGED');
  }
  assert.equal((await f.runtime.invokeCloud('startJob',{kind:'discover',account_generation:0},user(12345))).error.code,'PUBLIC_ACCOUNT_CHANGED');
  assert.deepEqual(await f.repository('12345').read(),before);
  assert.equal((await f.runtime.invokeCloud('getJobs',{},user(12345))).jobs[0].account_generation,generation);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(12345))).capabilities.account_generation,generation);
  assert.notEqual((await f.runtime.invokeCloud('getDashboardRevision',{},user(12345))).token,token);
  const stopped=await f.runtime.invokeCloud('stopJob',{job_id:current.id,account_generation:generation},user(12345));
  assert.equal(stopped.job.state,'partial');assert.equal(stopped.job.account_generation,generation);
  assert.equal(f.calls.length,0);
});
test('old owned-gift refresh controls cannot stop or advance the new incarnation of run 1',async t=>{
  const f=setup(t);await onboard(f);
  async function enroll() {
    const repo=f.repository('12345'),saved=await repo.read();
    assert.equal(await repo.append(saved.revision,{key:`enrollment:${saved.revision}`,state:saved.state,records:[{kind:'portfolio',record:{nft_address:nft,collection_address:collection,is_portfolio:true}}],observed_at:new Date(f.now()).toISOString()}),true);
  }
  await enroll();const old=(await f.runtime.invokeOwnedPrice('start',{session_id:'old-account-session',account_generation:0},user(12345))).run;
  assert.equal(old.state,'running');
  const generation=await recreate(f);await enroll();
  const current=(await f.runtime.invokeOwnedPrice('start',{session_id:'new-account-session',account_generation:generation},user(12345))).run;
  assert.equal(current.id,old.id);assert.equal(current.account_generation,generation);
  const before=await f.repository('12345').read();
  for(const name of ['step','stop'])assert.equal((await f.runtime.invokeOwnedPrice(name,{run_id:old.id,account_generation:old.account_generation},user(12345))).error.code,'PUBLIC_ACCOUNT_CHANGED');
  assert.deepEqual(await f.repository('12345').read(),before);
  assert.equal((await f.runtime.invokeOwnedPrice('getStatus',{},user(12345))).run.state,'running');
  assert.equal((await f.runtime.invokeOwnedPrice('stop',{run_id:current.id,account_generation:generation},user(12345))).run.state,'partial');
  assert.equal(f.calls.length,0);
});

test('public single-gift checks use account portfolio, preserve scoped archives and return stable busy errors',async t=>{
  const f=setup(t);await onboard(f);await onboard(f,67890,'synthetic-other-key-67890');
  const other=address(44);
  for(const [id,target] of [['12345',nft],['67890',other]]) {
    const repo=f.repository(id),saved=await repo.read();
    assert.equal(await repo.append(saved.revision,{key:`single-gift-enrollment:${saved.revision}`,state:saved.state,
      records:[{kind:'portfolio',record:{nft_address:target,collection_address:collection,is_portfolio:true}}],observed_at:new Date(f.now()).toISOString()}),true);
  }
  const dashboard=await f.runtime.invokeCloud('getDashboard',{},user(12345));assert.equal(dashboard.capabilities.owned_price_refresh_single,true);
  const input={session_id:'public-single-gift-session',nft_address:nft,account_generation:0};
  assert.equal((await f.runtime.invokeOwnedPrice('start',{...input,nft_address:other},user(12345))).error.code,'OWNED_PRICE_INVALID_TARGET');
  assert.equal((await f.runtime.invokeOwnedPrice('start',input,user(67890))).error.code,'OWNED_PRICE_INVALID_TARGET');
  let result=await f.runtime.invokeOwnedPrice('start',input,user(12345));assert.equal(result.run.scope,'gift');assert.equal(result.run.nft_address,nft);
  assert.equal(result.run.wallet,account.address);assert.equal(result.run.session_id,input.session_id);assert.equal(result.run.account_generation,0);
  const id=result.run.id;
  assert.equal((await f.runtime.invokeOwnedPrice('start',{...input,session_id:'public-other-gift-session'},user(12345))).error.code,'OWNED_PRICE_BUSY');
  assert.equal((await f.runtime.invokeOwnedPrice('start',{session_id:'public-portfolio-session',account_generation:0},user(12345))).error.code,'OWNED_PRICE_BUSY');
  assert.equal((await f.runtime.invokeOwnedPrice('start',{session_id:input.session_id,account_generation:0},user(12345))).error.code,'OWNED_PRICE_SCOPE_CHANGED');
  assert.equal(f.calls.length,0);
  for(let i=0;i<2;i++){f.advance(1001);result=await f.runtime.invokeOwnedPrice('step',{run_id:id,account_generation:0},user(12345));assert.ok(result.run,JSON.stringify(result));}
  assert.equal(result.run.state,'complete');assert.equal(result.run.total,1);assert.equal(result.run.status_updated,1);
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.url.includes('toncenter.com/api/v3/nft/items')));
  assert.deepEqual(f.calls.map(call=>new URL(call.url).searchParams.getAll('address')),[[nft],[nft]]);
  const saved=await f.repository('12345').ownedRefreshRun(id);assert.equal(saved.scope,'gift');assert.equal(saved.nft_address,nft);assert.equal(saved.wallet,account.address);assert.equal(saved.session_id,input.session_id);
  await f.runtime.invokeOwnedPrice('start',{...input,session_id:'public-replacement-session'},user(12345));
  const recovered=await f.runtime.invokeOwnedPrice('getStatus',{session_id:input.session_id},user(12345));assert.equal(recovered.run.id,id);assert.equal(recovered.run.state,'complete');
  assert.equal((await f.runtime.invokeOwnedPrice('getStatus',{session_id:input.session_id},user(67890))).run,null);
  assert.equal((await f.repository('67890').records()).filter(row=>['owned_price','owned_status'].includes(row.kind)).length,0);
});

async function enrollKnownGift(f,id='12345') {
  const repo=f.repository(id),saved=await repo.read();
  assert.equal(await repo.append(saved.revision,{key:`known-gift:${saved.revision}`,state:saved.state,
    records:[{kind:'portfolio',record:{nft_address:nft,collection_address:collection,is_portfolio:true}}],observed_at:new Date(f.now()).toISOString()}),true);
}
test('disconnected accounts refresh only existing saved-wallet gifts through TON without restoring grants',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  const result=await f.runtime.invokeAccount('disconnectPublicWallet',{},user(12345));assert.equal(result.account.wallet,null);
  const dashboard=await f.runtime.invokeCloud('getDashboard',{},user(12345));
  assert.equal(dashboard.wallet,account.address);assert.equal(dashboard.capabilities.wallet_configured,false);
  for(const name of ['personal_gift_refresh','owned_price_refresh','owned_price_refresh_single','owned_status_refresh'])assert.equal(dashboard.capabilities[name],true,name);
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(67890))).capabilities.personal_gift_refresh,false);
  const beforeMembership=(await f.repository('12345').records()).filter(row=>row.kind==='portfolio');
  for(const kind of ['discover','prices','collect'])assert.equal((await f.runtime.invokeCloud('startJob',{kind,account_generation:0},user(12345))).error.code,'PUBLIC_WALLET_REQUIRED');
  assert.equal((await f.runtime.invokeAnalytics('status','getMarketappAnalyticsRefreshStatus',{},user(12345))).error.code,'PUBLIC_WALLET_REQUIRED');
  assert.equal((await f.runtime.invokeGiftRefresh('start',{session_id:'disconnected-forged-wallet',wallet:address(999),account_generation:0},user(12345))).error.code,'PUBLIC_REQUEST_FAILED');
  assert.equal((await f.runtime.invokeGiftRefresh('start',{session_id:'disconnected-outside-gift',nft_address:address(999),account_generation:0},user(12345))).error.code,'OWNED_PRICE_INVALID_TARGET');
  assert.equal(f.calls.length,0);
  let refresh=await f.runtime.invokeGiftRefresh('start',{session_id:'disconnected-owned-portfolio',automatic:true,account_generation:0},user(12345));
  assert.equal(refresh.provider,'toncenter');assert.equal(refresh.fallback_reason,'website_disabled');assert.equal(refresh.run.wallet,account.address);assert.equal(refresh.run.total,1);
  for(let i=0;i<2;i++){f.advance(1001);refresh=await f.runtime.invokeGiftRefresh('step',{run_id:refresh.run.id,session_id:refresh.run.session_id,account_generation:0},user(12345));}
  assert.equal(refresh.run.state,'complete');assert.equal(refresh.run.status_updated,1);
  assert.ok(f.calls.every(call=>call.url.startsWith('https://toncenter.com/api/v3/nft/items?')));
  assert.deepEqual((await f.repository('12345').records()).filter(row=>row.kind==='portfolio'),beforeMembership);
  assert.equal((await f.runtime.invokeAccount('getPublicAccount',{},user(12345))).account.wallet,null);
});

test('disconnect immediately before owned Start INSERT atomically rejects the old start; a fresh saved-wallet check works',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  const original=f.db.run;let disconnected=false;
  f.db.run=async(sql,params)=>{
    if(!disconnected&&sql.startsWith('INSERT OR IGNORE INTO public_cloud_events')&&params?.[':key']?.startsWith('owned-price:')) {
      disconnected=true;assert.equal((await f.runtime.invokeAccount('disconnectPublicWallet',{},user(12345))).account.wallet,null);
    }
    return original(sql,params);
  };
  const old=await f.runtime.invokeGiftRefresh('start',{session_id:'old-pre-disconnect-start',account_generation:0},user(12345));
  assert.equal(old.error.code,'PUBLIC_WALLET_CHANGED');assert.equal(f.calls.length,0);
  assert.equal((await f.repository('12345').read()).state.owned_prices,undefined);
  const fresh=await f.runtime.invokeGiftRefresh('start',{session_id:'new-post-disconnect-start',account_generation:0},user(12345));assert.equal(fresh.run.state,'running');
  assert.equal((await f.repository('12345').read()).state.owned_prices.run.public_wallet_revision,(await f.repository('12345').publicAccount()).wallet_revision);
});

test('a delayed owned response after Stop and disconnect cannot commit price or status evidence',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  const dbGet=f.db.get;f.db.get=async(sql,params)=>sql.includes('AS server_time')?{server_time:f.now()}:dbGet(sql,params);
  const start=await f.runtime.invokeGiftRefresh('start',{session_id:'delayed-owned-before-disconnect',account_generation:0},user(12345));
  f.setProviderHook(async()=>{
    f.setProviderHook(null);
    assert.equal((await f.runtime.invokeGiftRefresh('stop',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},user(12345))).run.state,'partial');
    f.advance(121000);
    assert.equal((await f.runtime.invokeAccount('disconnectPublicWallet',{},user(12345))).account.wallet,null);
  });
  f.advance(1001);const response=await f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},user(12345));
  assert.equal(response.error.code,'PUBLIC_WALLET_CHANGED');
  assert.equal((await f.repository('12345').records()).filter(row=>['owned_price','owned_status'].includes(row.kind)).length,0);
  assert.equal((await f.runtime.invokeGiftRefresh('start',{session_id:'delayed-new-disconnected-check',account_generation:0},user(12345))).run.state,'running');
});

test('same-wallet reconnection fences an ongoing run and permits stopping it before a new check',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  const start=await f.runtime.invokeGiftRefresh('start',{session_id:'old-before-wallet-rebind',account_generation:0},user(12345));
  f.advance(61000);
  const challenge=await f.runtime.invokeWallet('startWalletVerification',{},user(12345));
  const proof={timestamp:Math.floor(f.now()/1000),domain:{lengthBytes:Buffer.byteLength(challenge.domain),value:challenge.domain},payload:challenge.challenge};
  proof.signature=sign(null,publicWalletProofDigest(account.address,proof),seed).toString('base64');
  assert.equal((await f.runtime.invokeWallet('finishWalletVerification',{attempt_id:challenge.attempt_id,account,proof},user(12345))).account.wallet.address,account.address);
  assert.equal((await f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},user(12345))).error.code,'PUBLIC_WALLET_CHANGED');
  assert.equal(f.calls.length,0);
  assert.equal((await f.runtime.invokeGiftRefresh('stop',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},user(12345))).run.state,'partial');
  assert.equal((await f.runtime.invokeGiftRefresh('start',{session_id:'new-after-wallet-rebind',account_generation:0},user(12345))).run.state,'running');
});

test('public personal refresh facade binds mutations to the page session and echoes joined sessions',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  const first=await f.runtime.invokeGiftRefresh('start',{session_id:'public-personal-original-session',account_generation:0},user(12345));
  const joined=await f.runtime.invokeGiftRefresh('start',{session_id:'public-personal-joined-session',automatic:false,account_generation:0},user(12345));
  assert.equal(joined.run.id,first.run.id);assert.equal(joined.run.session_id,'public-personal-joined-session');
  const recovered=await f.runtime.invokeGiftRefresh('getStatus',{session_id:'public-personal-joined-session'},user(12345));assert.equal(recovered.run.session_id,joined.run.session_id);
  const before=await f.repository('12345').read();
  for(const name of ['step','stop']) {
    assert.equal((await f.runtime.invokeGiftRefresh(name,{run_id:joined.run.id,account_generation:0},user(12345))).error.code,'PUBLIC_INVALID_INPUT');
    assert.equal((await f.runtime.invokeGiftRefresh(name,{run_id:joined.run.id,session_id:'public-personal-unbound-session',account_generation:0},user(12345))).error.code,'OWNED_PRICE_SCOPE_CHANGED');
  }
  assert.deepEqual(await f.repository('12345').read(),before);assert.equal(f.calls.length,0);
  const stopped=await f.runtime.invokeGiftRefresh('stop',{run_id:joined.run.id,session_id:joined.run.session_id,account_generation:0},user(12345));
  assert.equal(stopped.run.session_id,joined.run.session_id);assert.equal(stopped.run.state,'partial');
});

async function completePersonalCheck(f,session='public-cache-original-session') {
  let result=await f.runtime.invokeGiftRefresh('start',{session_id:session,account_generation:0},user(12345));
  for(let i=0;i<2;i++){f.advance(1001);result=await f.runtime.invokeGiftRefresh('step',{run_id:result.run.id,session_id:session,account_generation:0},user(12345));}
  assert.equal(result.run.state,'complete');return result;
}

test('automatic public launch durably joins recent complete TON evidence without renewing timestamps or requests',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const original=await completePersonalCheck(f);
  const before=(await f.repository('12345').records()).filter(row=>['owned_price','owned_status'].includes(row.kind));
  f.advance(120000);const session='public-cache-second-page-session';
  const cached=await f.runtime.invokeGiftRefresh('start',{session_id:session,automatic:true,account_generation:0},user(12345));
  assert.equal(cached.cache_hit,true);assert.equal(cached.run.id,original.run.id);assert.equal(cached.run.session_id,session);
  assert.equal(cached.run.started_at,original.run.started_at);assert.equal(cached.run.completed_at,original.run.completed_at);assert.equal(cached.run.status_updated,1);
  assert.equal(await f.repository('12345').ownedRefreshSession(session),original.run.id);assert.equal(f.calls.length,2);
  assert.deepEqual((await f.repository('12345').records()).filter(row=>['owned_price','owned_status'].includes(row.kind)),before);
  const recovered=await f.runtime.invokeGiftRefresh('getStatus',{session_id:session},user(12345));assert.equal(recovered.run.id,original.run.id);assert.equal(recovered.run.session_id,session);
  assert.equal((await f.runtime.invokeGiftRefresh('step',{run_id:original.run.id,session_id:session,account_generation:0},user(12345))).run.state,'complete');
  f.advance(180001);const expired=await f.runtime.invokeGiftRefresh('start',{session_id:'public-cache-expired-page-session',automatic:true,account_generation:0},user(12345));
  assert.notEqual(expired.run.id,original.run.id);assert.equal(expired.run.state,'running');assert.notEqual(expired.cache_hit,true);
});

test('manual public launch does not reuse recent complete evidence',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const original=await completePersonalCheck(f);
  const manual=await f.runtime.invokeGiftRefresh('start',{session_id:'public-cache-manual-page-session',automatic:false,account_generation:0},user(12345));
  assert.notEqual(manual.run.id,original.run.id);assert.equal(manual.run.state,'running');assert.notEqual(manual.cache_hit,true);
  assert.equal(f.calls.length,2);
});

test('changed eligible gift scope does not reuse recent complete public evidence',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const original=await completePersonalCheck(f);
  const repo=f.repository('12345'),saved=await repo.read();
  assert.equal(await repo.append(saved.revision,{key:'second-cache-gift',state:saved.state,records:[{kind:'portfolio',record:{nft_address:address(99),collection_address:collection,is_portfolio:true}}],observed_at:new Date(f.now()).toISOString()}),true);
  const changed=await f.runtime.invokeGiftRefresh('start',{session_id:'public-cache-expanded-scope-session',automatic:true,account_generation:0},user(12345));
  assert.notEqual(changed.run.id,original.run.id);assert.equal(changed.run.state,'running');assert.equal(changed.run.total,2);assert.notEqual(changed.cache_hit,true);assert.equal(f.calls.length,2);
});

test('public automatic cache cannot renew a pre-disconnect security boundary or accept forged options',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);const original=await completePersonalCheck(f);
  assert.equal((await f.runtime.invokeGiftRefresh('start',{session_id:'public-cache-forged-wallet-session',automatic:true,account_generation:0,wallet:address(999)},user(12345))).error.code,'PUBLIC_REQUEST_FAILED');
  assert.equal((await f.runtime.invokeGiftRefresh('start',{session_id:'public-cache-wrong-generation-session',automatic:true,account_generation:1},user(12345))).error.code,'PUBLIC_ACCOUNT_CHANGED');
  await f.runtime.invokeAccount('disconnectPublicWallet',{},user(12345));
  const fresh=await f.runtime.invokeGiftRefresh('start',{session_id:'public-cache-post-disconnect-session',automatic:true,account_generation:0},user(12345));
  assert.notEqual(fresh.run.id,original.run.id);assert.equal(fresh.run.state,'running');assert.notEqual(fresh.cache_hit,true);assert.equal(f.calls.length,2);
});

test('disconnect immediately before automatic cache binding atomically rejects the old page launch',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);await completePersonalCheck(f);
  const original=f.db.run;let disconnected=false;
  f.db.run=async(sql,params)=>{
    if(!disconnected&&sql.startsWith('INSERT OR IGNORE INTO public_cloud_events')&&params?.[':key']?.includes(':cache:')) {
      disconnected=true;await f.runtime.invokeAccount('disconnectPublicWallet',{},user(12345));
    }
    return original(sql,params);
  };
  const session='public-cache-disconnect-race-session';
  const response=await f.runtime.invokeGiftRefresh('start',{session_id:session,automatic:true,account_generation:0},user(12345));
  assert.equal(response.error.code,'PUBLIC_WALLET_CHANGED');assert.equal(await f.repository('12345').ownedRefreshSession(session),null);assert.equal(f.calls.length,2);
});

test('public personal facade stops at 20 invocation attempts while the original targeted action retains its budget',async t=>{
  const f=setup(t);await onboard(f);await enrollKnownGift(f);
  async function seedAttempts() {
    const repo=f.repository('12345'),saved=await repo.read();saved.state.owned_prices.run.attempts=20;
    saved.state.owned_prices.attempts=Array.from({length:20},()=>f.now()-1000);
    assert.equal(await repo.append(saved.revision,{key:`mocked-prior-attempts:${saved.revision}`,state:saved.state,records:[],observed_at:new Date(f.now()).toISOString()}),true);
  }
  const started=await f.runtime.invokeGiftRefresh('start',{session_id:'public-personal-bounded-attempts-session',account_generation:0},user(12345));
  await seedAttempts();
  const ended=await f.runtime.invokeGiftRefresh('step',{run_id:started.run.id,session_id:started.run.session_id,account_generation:0},user(12345));
  assert.equal(ended.run.state,'partial');assert.equal(ended.run.reason,'invocation_limit');assert.equal(f.calls.length,0);
  const single=await f.runtime.invokeOwnedPrice('start',{session_id:'public-original-targeted-attempts-session',nft_address:nft,account_generation:0},user(12345));
  await seedAttempts();f.advance(1001);
  const continued=await f.runtime.invokeOwnedPrice('step',{run_id:single.run.id,account_generation:0},user(12345));
  assert.equal(continued.run.state,'running');assert.equal(f.calls.length,1);
});
