import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPublicProviderBudget,createPublicProviderFetch,PublicProviderBudgetError} from '../tgcloud/lib/public-provider-budget.js';
import {createInviteProviderFetch} from '../tgcloud/lib/invite-provider-fetch.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {createOwnedPriceEngine} from '../tgcloud/lib/owned-price-engine.js';

const MARKET='https://api.marketapp.org/v1/rent/gifts/history/?offset=0',TON='https://toncenter.com/api/v3/nft/items?address=x';
function fixture() {
  const database=new DatabaseSync(':memory:');database.exec('CREATE TABLE public_provider_gates(scope_key TEXT PRIMARY KEY,revision INTEGER,document TEXT); CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT,state_json TEXT,job_id INTEGER,job_json TEXT,records_json TEXT,raw_body TEXT,observed_at TEXT); CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER,document TEXT); CREATE TABLE owned_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT,source_sequence INTEGER); CREATE TABLE owned_refresh_sessions(session_id TEXT PRIMARY KEY,run_id INTEGER,source_sequence INTEGER); CREATE TABLE owned_refresh_index(id INTEGER PRIMARY KEY,sequence INTEGER)');
  let at=Date.parse('2026-10-10T12:00:00Z');
  database.prepare("INSERT INTO cloud_events(sequence,state_json,records_json) VALUES(1,?,'[]')").run(JSON.stringify({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0}));
  const db={async get(sql,p={}){return database.prepare(sql).get(p)??null;},async run(sql,p={}){return {rowsAffected:Number(database.prepare(sql).run(p).changes)};},async all(sql,p={}){return database.prepare(sql).all(p);}};
  const repository={async read(){const row=await db.get('SELECT sequence,state_json FROM cloud_events ORDER BY sequence DESC LIMIT 1');return {revision:row.sequence,state:JSON.parse(row.state_json)};}};
  const clock=async()=>at,config={preservePrivateOwner:true,globalMarketDailyAttempts:3,perUserMarketDailyAttempts:3,perCredentialMarketDailyAttempts:3,globalTonDailyAttempts:3,perUserTonDailyAttempts:3};
  const budget=createPublicProviderBudget({db,masterKey:'11'.repeat(32),config,clock,legacyProviderUsage:async()=>({userId:'1',credentialFingerprint:'aa'.repeat(32),state:(await repository.read()).state})});
  const calls=[];let response={status:200};const fetch=async(url,options)=>{calls.push({url,options});return response;};
  const owner=createInviteProviderFetch({fetch,budget,repository,userId:'1',credentialFingerprint:'aa'.repeat(32)});
  const publicRepo={async ensureAccount(){},async accountGeneration(){return 2;},async read(){return {revision:5};}};
  const invite=createPublicProviderFetch({fetch,budget,repository:publicRepo,userId:'2',credentialFingerprint:'bb'.repeat(32)});
  return {database,db,budget,owner,invite,calls,clock,now:()=>at,advance:ms=>at+=ms,respond:value=>response=value};
}

test('private owner keeps credentials and private storage while provider pacing is shared with invites',async()=>{
  const f=fixture();await f.owner(MARKET,{method:'GET',headers:{Authorization:'owner-token',Accept:'application/json'},redirect:'follow'});
  assert.equal(f.calls[0].options.headers.Authorization,'owner-token');assert.equal(f.calls[0].options.redirect,'error');
  await assert.rejects(f.invite(MARKET,{method:'GET',headers:{Authorization:'invite-token'}}),e=>e instanceof PublicProviderBudgetError&&e.reason==='provider_wait');
  await f.invite(TON,{method:'GET'});assert.equal(f.calls.length,2);
  f.advance(1000);await f.invite(MARKET,{method:'GET',headers:{Authorization:'invite-token'}});
  f.advance(1000);await f.owner(MARKET,{method:'GET',headers:{Authorization:'owner-token'}});
  f.advance(1000);await assert.rejects(f.invite(MARKET,{method:'GET'}),e=>e.reason==='global_limit');
  assert.equal((await f.budget.status('marketapp','1')).used_24h,2);
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='public_accounts'").get().count,0);
  f.database.close();
});

test('parallel private/public reservations perform only one provider request in a second',async()=>{
  const f=fixture(),results=await Promise.allSettled([f.owner(MARKET,{method:'GET'}),f.invite(MARKET,{method:'GET'})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(f.calls.length,1);
  assert.equal(JSON.parse(f.database.prepare("SELECT document FROM public_provider_gates WHERE scope_key='public-provider-v1:marketapp'").get().document).attempts.length,1);
  f.database.close();
});

test('private 429 throttle is visible to public wrapper and the other provider stays available',async()=>{
  const f=fixture(),at=await f.clock();f.respond({status:429,headers:{get:()=> '120'}});
  await f.owner(TON,{method:'GET',headers:{Accept:'application/json'}});
  f.advance(1000);await assert.rejects(f.invite(TON,{method:'GET'}),e=>e.readyAt===at+120000&&e.next_allowed_at===at+120000);
  f.respond({status:200});await f.invite(MARKET,{method:'GET'});assert.equal(f.calls.length,2);f.database.close();
});

test('owner wrapper rejects forbidden routes, methods and cross-origin credentials before storage or network',async()=>{
  let reads=0,reservations=0,requests=0;
  const fetch=createInviteProviderFetch({fetch:async()=>{requests++;},budget:{reserve:async()=>{reservations++;}},repository:{read:async()=>{reads++;}},userId:'1'});
  for(const [url,options] of [[MARKET,{method:'POST'}],['https://api.marketapp.org/v1/rent/gifts/my-rented/',{method:'GET'}],['https://marketapp.org/api/analytics',{method:'GET'}],[TON,{method:'GET',headers:{Authorization:'owner-token'}}],[TON,{method:'GET',headers:new Headers({'X-Api-Key':'owner-token'})}],[MARKET,{method:'GET',headers:[['Cookie','website-session']]}]])await assert.rejects(fetch(url,options));
  assert.equal(reads,0);assert.equal(reservations,0);assert.equal(requests,0);
});

test('network failures retain a shared attempted request without exposing or importing an operator token',async()=>{
  const attempts=[],fetch=createInviteProviderFetch({fetch:async()=>{throw new Error('network failure');},budget:{reserve:async(...args)=>attempts.push(args)},repository:{read:async()=>({revision:9})},userId:'1',credentialFingerprint:'aa'.repeat(32)});
  await assert.rejects(fetch(MARKET,{method:'GET',headers:{Authorization:'owner-token'}}),/network failure/);
  assert.deepEqual(attempts,[['marketapp','1','aa'.repeat(32),'private:9:1']]);
});

test('private collector and owned-price engines save provider wait and undo their unsent local attempt',async()=>{
  for(const provider of ['marketapp','toncenter']) {
    const f=fixture(),repository=createCloudRepository(f.db),ctx={initData:{user:{id:1}}};
    const address=n=>`0:${n.toString(16).padStart(64,'0')}`;
    const previous=await repository.read();
    await repository.append(previous.revision,{key:'seed',state:previous.state,job:null,records:[
      {kind:'settings',record:{wallet:address(1)}},
      {kind:'portfolio',key:'gift',observed_at:new Date(f.now()).toISOString(),record:{nft_address:address(2),collection_address:address(3),is_portfolio:true,membership_sources:['verified_ton'],uncertainties:[]}},
    ],observed_at:new Date(f.now()).toISOString()});
    await f.budget.status(provider,'1',provider==='marketapp'?'aa'.repeat(32):null);
    await f.budget.reserve(provider,'2',null,'invite-in-flight');
    const readyAt=f.now()+1000;
    if(provider==='marketapp') {
      const engine=createCloudEngine({repository,ownerTelegramId:1,marketappToken:'owner-token',now:f.now,fetch:f.owner});
      const job=await engine.startJob(ctx,{kind:'prices'}),result=await engine.stepJob(ctx,{job_id:job.job.id}),saved=await repository.read();
      assert.equal(result.job.state,'running');assert.equal(saved.state.job.reason,'provider_wait');
      assert.equal(saved.state.attempts.length,0);assert.equal(saved.state.next_allowed_at,readyAt);
      assert.equal(saved.state.job.invocation_used,0);
    } else {
      const engine=createOwnedPriceEngine({repository,ownerTelegramId:1,now:f.now,fetch:f.owner});
      const started=await engine.start(ctx,{session_id:'private-owner-session'}),result=await engine.step(ctx,{run_id:started.run.id}),own=(await repository.read()).state.owned_prices;
      assert.equal(result.run.state,'running');assert.equal(result.run.reason,'provider_wait');
      assert.equal(own.attempts.length,0);assert.equal(own.next_allowed_at,readyAt);assert.equal(own.run.attempts,0);
    }
    assert.equal(f.calls.length,0);f.database.close();
  }
});
