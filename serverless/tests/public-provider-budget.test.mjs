import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPublicProviderBudget,createPublicProviderFetch,PublicProviderBudgetError} from '../tgcloud/lib/public-provider-budget.js';
import {portableModules} from './fixtures/portable-modules.mjs';
function fixture(overrides={}, options={}) {
  const database=new DatabaseSync(':memory:');database.exec('CREATE TABLE public_provider_gates(scope_key TEXT PRIMARY KEY,revision INTEGER,document TEXT)');
  const db={async get(sql,p={}){return database.prepare(sql).get(p)??null;},async run(sql,p={}){return {rowsAffected:Number(database.prepare(sql).run(p).changes)};}};
  let at=Date.parse('2026-10-10T12:00:00Z');const clock=async()=>at;
  const config={globalMarketDailyAttempts:3,perUserMarketDailyAttempts:2,perCredentialMarketDailyAttempts:2,globalTonDailyAttempts:4,perUserTonDailyAttempts:2,...overrides};
  const createBudget=()=>createPublicProviderBudget({db,masterKey:'11'.repeat(32),config,clock,...options});
  return {database,db,config,budget:createBudget(),createBudget,clock,advance:ms=>at+=ms};
}
test('per user/key/global rolling quotas survive credential rotation and share reused keys',async()=>{
  const f=fixture(),key='aa'.repeat(32);await f.budget.reserve('marketapp','1',key,'request');f.advance(1000);
  await f.budget.reserve('marketapp','2',key,'request');f.advance(1000);
  await assert.rejects(f.budget.reserve('marketapp','3',key,'request'),e=>e instanceof PublicProviderBudgetError&&e.reason==='credential_limit');
  await f.budget.reserve('marketapp','1','bb'.repeat(32),'rotated');f.advance(1000);
  await assert.rejects(f.budget.reserve('marketapp','1','cc'.repeat(32),'rotated-again'),e=>e.reason==='user_limit'||e.reason==='global_limit');
  await assert.rejects(f.budget.reserve('marketapp','4','dd'.repeat(32),'other'),e=>e.reason==='global_limit');
  const value=await f.budget.status('marketapp','1','cc'.repeat(32));assert.equal(value.used_24h,2);assert.equal(value.remaining_24h,0);assert.ok(value.available_at);
  const raw=f.database.prepare('SELECT document FROM public_provider_gates').get().document;assert.ok(!raw.includes('"actor":"1"'));
  f.advance(86400000);await f.budget.reserve('marketapp','1',key,'request');f.database.close();
});
test('parallel users cannot overshoot provider allowance; equal reservation labels never bypass accounting',async()=>{
  const f=fixture({globalMarketDailyAttempts:1,perUserMarketDailyAttempts:5});
  const values=await Promise.allSettled([f.budget.reserve('marketapp','1',null,'same'),f.budget.reserve('marketapp','2',null,'same')]);
  assert.equal(values.filter(x=>x.status==='fulfilled').length,1);assert.equal(JSON.parse(f.database.prepare('SELECT document FROM public_provider_gates').get().document).attempts.length,1);
  f.advance(1000);await assert.rejects(f.budget.reserve('marketapp','1',null,'same'));f.database.close();
});
test('provider-specific pacing and Retry-After do not block the other provider',async()=>{
  const f=fixture();await f.budget.reserve('toncenter','1',null,'a');
  const before=await f.clock();
  await f.budget.throttle('toncenter',{status:429,headers:{get:()=> '120'}});
  await assert.rejects(f.budget.reserve('toncenter','2',null,'b'),e=>e.reason==='provider_wait'&&e.readyAt===before+120000);
  await f.budget.reserve('marketapp','2',null,'independent');
  f.database.close();
});
test('public fetch rejects mutations, unknown routes and credentials on the wrong origin before network',async()=>{
  const f=fixture(),calls=[],repository={ensureAccount:async()=>{},accountGeneration:async()=>0,read:async()=>({revision:1})};
  const fetch=createPublicProviderFetch({fetch:async(...args)=>{calls.push(args);return {status:200};},budget:f.budget,repository,userId:'1'});
  await assert.rejects(fetch('https://api.marketapp.org/v1/rent/gifts/',{method:'POST'}));
  await assert.rejects(fetch('https://api.marketapp.org/v1/rent/gifts/my-rented/',{method:'GET'}));
  await assert.rejects(fetch('https://toncenter.com/api/v3/accountStates',{method:'GET',headers:{Authorization:'private-secret'}}));
  await assert.rejects(fetch('https://toncenter.com/api/v3/accountStates',{method:'GET',headers:new Headers({'X-Api-Key':'private-secret'})}));
  await assert.rejects(fetch('https://toncenter.com/api/v3/accountStates',{method:'GET',headers:[['Authorization','private-secret']]}));
  assert.equal(calls.length,0);await fetch('https://toncenter.com/api/v3/accountStates?address=x',{method:'GET'});assert.equal(calls.length,1);f.database.close();
});

function savePrivate(f,state,sequence=1) {
  f.database.exec('CREATE TABLE IF NOT EXISTS cloud_events(sequence INTEGER PRIMARY KEY,state_json TEXT)');
  f.database.prepare('INSERT INTO cloud_events(sequence,state_json) VALUES(?,?)').run(sequence,JSON.stringify(state));
}
function usageFromPrivate(f,owner='1',credential='aa'.repeat(32)) {
  return async()=>({userId:owner,credentialFingerprint:credential,state:JSON.parse((await f.db.get('SELECT state_json FROM cloud_events ORDER BY sequence DESC LIMIT 1')).state_json)});
}

test('first status seeds latest private Market/TON raw rolling usage and cooldown before invite requests',async()=>{
  const f=fixture({preservePrivateOwner:false}),at=await f.clock(),key='aa'.repeat(32);
  savePrivate(f,{attempts:[at-2000],next_allowed_at:0,owned_prices:{attempts:[],next_allowed_at:0}},1);
  const state={attempts:[at-86400000,at-2000,at-1000],next_allowed_at:at+4000,
    marketapp_budget_reset:{excluded_attempts:[at-2000,at-1000]},owned_prices:{attempts:[at-3000],next_allowed_at:at+8000}};
  savePrivate(f,state,2);
  const config={...f.config,preservePrivateOwner:true},options={db:f.db,masterKey:'11'.repeat(32),config,clock:f.clock,legacyProviderUsage:usageFromPrivate(f)};
  const budget=createPublicProviderBudget(options);
  const market=await budget.status('marketapp','1',key),ton=await budget.status('toncenter','1');
  assert.equal(market.used_24h,2);assert.equal(market.reason,'user_limit');assert.equal(market.remaining_24h,0);
  assert.equal(ton.used_24h,1);assert.equal(ton.available_at,new Date(at+8000).toISOString());
  await assert.rejects(budget.reserve('marketapp','2',key,'shared-owner-key'),e=>e.reason==='credential_limit');
  await assert.rejects(budget.reserve('toncenter','2',null,'new-invite'),e=>e.readyAt===at+8000&&e.next_allowed_at===at+8000);
  const documents=f.database.prepare('SELECT document FROM public_provider_gates').all().map(row=>JSON.parse(row.document));
  assert.ok(documents.every(value=>value.private_owner_seed.actor.match(/^[0-9a-f]{64}$/)));
  assert.equal(documents.find(value=>value.attempts.length===2).private_owner_seed.credential,key);
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='public_accounts'").get().count,0);
  f.database.close();
});

test('CAS seed races are idempotent, retain existing invite attempts and never repeat after expiry',async()=>{
  const f=fixture({globalMarketDailyAttempts:5,perUserMarketDailyAttempts:5,perCredentialMarketDailyAttempts:5}),at=await f.clock();
  await f.budget.reserve('marketapp','3',null,'prior-invite');
  savePrivate(f,{attempts:[at-2000],next_allowed_at:at+1000});
  const create=()=>createPublicProviderBudget({db:f.db,masterKey:'11'.repeat(32),config:{...f.config,preservePrivateOwner:true},clock:f.clock,legacyProviderUsage:usageFromPrivate(f)});
  const budgets=[create(),create(),create()];
  await Promise.all(budgets.map(budget=>budget.status('marketapp','1')));
  let value=JSON.parse(f.database.prepare('SELECT document FROM public_provider_gates').get().document);
  assert.equal(value.attempts.length,2);assert.equal(value.attempts.filter(row=>row.id.startsWith('private-seed:')).length,1);
  const marker=value.private_owner_seed;
  f.advance(86400000+1000);
  savePrivate(f,{attempts:[await f.clock()-1000],next_allowed_at:0},2);
  const status=await create().status('marketapp','1');assert.equal(status.used_24h,0);
  await create().reserve('marketapp','2',null,'new-after-expiry');
  value=JSON.parse(f.database.prepare('SELECT document FROM public_provider_gates').get().document);
  assert.deepEqual(value.private_owner_seed,marker);assert.equal(value.attempts.length,1);
  f.database.close();
});

test('over-cap private history is bounded conservatively without resetting the shared quota',async()=>{
  const f=fixture({globalMarketDailyAttempts:5000,perUserMarketDailyAttempts:5000,perCredentialMarketDailyAttempts:5000}),at=await f.clock();
  savePrivate(f,{attempts:Array.from({length:6000},(_,index)=>at-6000+index),next_allowed_at:0});
  const budget=createPublicProviderBudget({db:f.db,masterKey:'11'.repeat(32),config:f.config,clock:f.clock,legacyProviderUsage:usageFromPrivate(f)});
  const status=await budget.status('marketapp','1','aa'.repeat(32));
  assert.equal(status.used_24h,5000);assert.equal(status.remaining_24h,0);
  assert.equal(status.available_at,new Date(at-5000+86400000).toISOString());
  await assert.rejects(budget.reserve('marketapp','2',null,'invite'),e=>e.reason==='global_limit');
  assert.equal(JSON.parse(f.database.prepare('SELECT document FROM public_provider_gates').get().document).attempts.length,5000);
  f.advance(86400000-4999);await budget.reserve('marketapp','2',null,'expired-discarded-history');f.database.close();
});

test('full private and invited ledgers use constant identity hashing on status probes without exposing identities',async t=>{
  const modules=portableModules(),credentials=modules.load('public-credential-box.js'),hmac=credentials.hmacSha256;
  let hashes=0;
  credentials.hmacSha256=(...args)=>{hashes++;return hmac(...args);};
  const {createPublicProviderBudget:createBudget}=modules.load('public-provider-budget.js');
  const f=fixture({globalMarketDailyAttempts:5000,perUserMarketDailyAttempts:5000,perCredentialMarketDailyAttempts:5000,
    globalTonDailyAttempts:5000,perUserTonDailyAttempts:5000}),at=await f.clock();
  t.after(()=>f.database.close());
  const attempts=Array.from({length:5000},(_,index)=>at-5000+index),credential='aa'.repeat(32);
  const budget=createBudget({db:f.db,masterKey:'11'.repeat(32),config:{...f.config,preservePrivateOwner:true},clock:f.clock,
    legacyProviderUsage:async()=>({userId:'1',credentialFingerprint:credential,state:{attempts,next_allowed_at:0,
      owned_prices:{attempts,next_allowed_at:0}}})});
  for(const provider of ['marketapp','toncenter']) {
    hashes=0;
    const owner=await budget.status(provider,'1',provider==='marketapp'?credential:null);
    assert.equal(hashes,2,'one identity derivation for the initial legacy seed and one for the status probe');
    assert.equal(owner.used_24h,5000);assert.equal(owner.remaining_24h,0);
    assert.equal(owner.available_at,new Date(at-5000+86400000).toISOString());
    hashes=0;
    const invited=await budget.status(provider,'2',provider==='marketapp'?credential:null);
    assert.equal(hashes,1,'a seeded full ledger must not repeat identity hashing per attempt');
    assert.equal(invited.used_24h,0);assert.equal(invited.remaining_24h,0);assert.equal(invited.reason,'global_limit');
    assert.equal(invited.available_at,owner.available_at);
    for(const status of [owner,invited])assert.deepEqual(Object.keys(status).sort(),
      ['available_at','reason','remaining_24h','rolling_24h_attempts','used_24h']);
  }
  for(const {document} of f.database.prepare('SELECT document FROM public_provider_gates').all()) {
    const ledger=JSON.parse(document);
    assert.ok(ledger.attempts.every(attempt=>/^[0-9a-f]{64}$/.test(attempt.actor)));
    assert.equal(ledger.attempts.length,5000);
  }
});

test('malformed or unbounded private usage fails closed with no seed marker or reservation',async()=>{
  for(const state of [{attempts:['bad'],next_allowed_at:0},{attempts:Array(10001).fill(1),next_allowed_at:0},{attempts:[],next_allowed_at:-1},{attempts:[],next_allowed_at:0,owned_prices:{attempts:[null],next_allowed_at:0}}]) {
    const f=fixture(),options={db:f.db,masterKey:'11'.repeat(32),config:f.config,clock:f.clock,legacyProviderUsage:async()=>({userId:'1',credentialFingerprint:null,state})};
    const budget=createPublicProviderBudget(options),provider=state.owned_prices?'toncenter':'marketapp';
    await assert.rejects(budget.status(provider,'2'),/Private provider usage unavailable/);
    await assert.rejects(budget.reserve(provider,'2',null,'invite'),/Private provider usage unavailable/);
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM public_provider_gates').get().count,0);f.database.close();
  }
  const f=fixture();assert.throws(()=>createPublicProviderBudget({db:f.db,masterKey:'11'.repeat(32),config:{...f.config,preservePrivateOwner:true},clock:f.clock}),/Private provider usage unavailable/);f.database.close();
});
