import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {createPrivateMarketappSettings} from '../tgcloud/lib/private-marketapp-settings.js';
import {createPublicCredentialBox,createPrivateCredentialBox} from '../tgcloud/lib/public-credential-box.js';
const owner='12345',ctx={initData:{user:{id:owner}}},bootstrap='synthetic-private-bootstrap-key',replacement='synthetic-private-replacement-key',masterKey='a5'.repeat(32);
async function fixture(t) {
  const f=createPublicDatabase(t),repository=createCloudRepository(f.db);let at=Date.parse('2026-10-11T12:00:00Z');
  const state={version:2,next_job_id:2,job:null,attempts:[at-10000],next_allowed_at:at+1000,market_cache:{old:{body:'saved coverage'}},history_coverage:{old:{coverage:true}},
    owned_prices:{attempts:[at-5000],next_allowed_at:at+5000,run:null}};
  await repository.append(0,{key:'seed',state,job:null,records:[{kind:'listing',key:'saved',record:{price:'0.100'}}],raw_body:'synthetic raw evidence',observed_at:new Date(at).toISOString()});
  const settings=createPrivateMarketappSettings({db:f.db,repository,ownerTelegramId:owner,masterKey,bootstrapToken:bootstrap,clock:async()=>at});
  return {...f,repository,settings,now:()=>at,advance:ms=>at+=ms};
}
test('private owner status never echoes its bootstrap key and does not create public accounts',async t=>{
  const f=await fixture(t),before=(await f.repository.read()).revision,status=await f.settings.getMarketappSettings(ctx,{});
  assert.deepEqual(status,{configured:true,source:'serverless_private',updated_at:null,persistent_storage_available:true,network_enabled:true,can_manage:true,restart_required:false});
  assert.doesNotMatch(JSON.stringify(status),new RegExp(bootstrap));assert.equal((await f.repository.read()).revision,before);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM private_provider_credentials').get().n,0);
});
test('saving uses authenticated encryption and preserves provider evidence, history, and all request budgets',async t=>{
  const f=await fixture(t),prior=(await f.repository.read()).state,status=await f.settings.saveMarketappApiKey(ctx,{api_key:replacement});
  assert.equal(status.configured,true);assert.equal(status.source,'encrypted_backend');assert.doesNotMatch(JSON.stringify(status),new RegExp(replacement));
  const row=f.database.prepare('SELECT * FROM private_provider_credentials').get();
  assert.doesNotMatch(row.ciphertext,new RegExp(replacement));
  assert.equal(createPrivateCredentialBox(masterKey).open(row.ciphertext,{user_id:owner,provider:'marketapp',account_generation:0,credential_generation:row.generation,counter:row.credential_version}),replacement);
  const current=(await f.repository.read()).state;assert.deepEqual(current.attempts,prior.attempts);assert.equal(current.next_allowed_at,prior.next_allowed_at);
  assert.deepEqual(current.owned_prices,prior.owned_prices);assert.deepEqual(current.market_cache,{});assert.deepEqual(current.history_coverage,{});
  assert.equal((await f.repository.records()).length,1);assert.equal(f.database.prepare('SELECT raw_body FROM cloud_events WHERE sequence=1').get().raw_body,null);
  for(const event of f.database.prepare('SELECT state_json,job_json,records_json,raw_body FROM cloud_events').all())assert.doesNotMatch(JSON.stringify(event),new RegExp(replacement));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_provider_credentials').get().n,0);
});
test('independent private/public counters use distinct encryption domains while sharing quota identity',()=>{
  const privateBox=createPrivateCredentialBox(masterKey),publicBox=createPublicCredentialBox(masterKey);
  const payload={version:1,user_id:owner,provider:'marketapp',account_generation:0,credential_generation:0,counter:1,api_key:replacement};
  const expected={user_id:owner,provider:'marketapp',account_generation:0,credential_generation:0,counter:1};
  const privateCipher=privateBox.seal(payload),publicCipher=publicBox.seal(payload);
  assert.notEqual(privateCipher,publicCipher);assert.notEqual(privateCipher.slice(2,50),publicCipher.slice(2,50));
  assert.throws(()=>publicBox.open(privateCipher,expected));assert.throws(()=>privateBox.open(publicCipher,expected));
  assert.equal(privateBox.open(privateCipher,expected),replacement);assert.equal(publicBox.open(publicCipher,expected),replacement);
  assert.equal(privateBox.fingerprint(replacement),publicBox.fingerprint(replacement));
});
test('clearing bootstrap and saved keys retains tombstones, never falls back, and keeps nonce counters increasing',async t=>{
  const f=await fixture(t);
  assert.equal((await f.settings.removeMarketappApiKey(ctx)).configured,false);
  assert.equal((await f.settings.capture()).token,'');const first=f.database.prepare('SELECT * FROM private_provider_credentials').get();assert.equal(first.ciphertext,null);
  const reload=createPrivateMarketappSettings({db:f.db,repository:f.repository,ownerTelegramId:owner,masterKey,bootstrapToken:bootstrap,clock:async()=>f.now()});
  assert.equal((await reload.getMarketappSettings(ctx)).source,'none');assert.equal((await reload.capture()).token,'');
  await reload.saveMarketappApiKey(ctx,{api_key:replacement});const saved=f.database.prepare('SELECT * FROM private_provider_credentials').get();assert.ok(saved.credential_version>first.credential_version);assert.ok(saved.nonce_counter>first.nonce_counter);
  await reload.removeMarketappApiKey(ctx);const cleared=f.database.prepare('SELECT * FROM private_provider_credentials').get();assert.equal(cleared.ciphertext,null);assert.ok(cleared.generation>saved.generation);assert.ok(cleared.nonce_counter>saved.nonce_counter);
  assert.equal((await f.settings.capture()).token,'');
});
test('owner-only authentication and invalid input are rejected before any reads or writes',async t=>{
  const f=await fixture(t);f.queries.length=0;
  for(const bad of [{},{initData:{user:{id:'012345'}}},{initData:{user:{id:67890}}},{user:{id:owner}},{initData:{user:{id:{toString:()=>owner}}}}]) {
    for(const name of ['getMarketappSettings','saveMarketappApiKey','removeMarketappApiKey'])await assert.rejects(f.settings[name](bad,{api_key:replacement}),e=>e.code==='PRIVATE_ACCESS_DENIED');
  }
  await assert.rejects(f.settings.getMarketappSettings(ctx,{token:replacement}),e=>e.code==='PRIVATE_INVALID_INPUT');
  await assert.rejects(f.settings.saveMarketappApiKey(ctx,{api_key:'invalid\nkey'}),e=>e.code==='PRIVATE_KEY_INVALID');
  await assert.rejects(f.settings.removeMarketappApiKey(ctx,{confirm:true}),e=>e.code==='PRIVATE_INVALID_INPUT');assert.equal(f.queries.length,0);
});
test('valid live comparison invocations and leases block replacement, expired jobs are safely invalidated',async t=>{
  const f=await fixture(t),saved=await f.repository.read();saved.state.job={id:1,kind:'prices',state:'running',invocation_deadline:f.now()+10000,lease_until:f.now()+10000,lease:'synthetic-lease'};
  await f.repository.append(saved.revision,{key:'running',state:saved.state,job:saved.state.job,records:[],observed_at:new Date(f.now()).toISOString()});
  const before=(await f.repository.read()).revision;assert.equal((await f.settings.getMarketappSettings(ctx)).can_manage,true);assert.equal((await f.settings.getMarketappSettings(ctx)).reason,'active_job');
  await assert.rejects(f.settings.saveMarketappApiKey(ctx,{api_key:replacement}),e=>e.code==='PRIVATE_ACCOUNT_BUSY');
  assert.equal((await f.repository.read()).revision,before);f.advance(10001);assert.equal((await f.settings.saveMarketappApiKey(ctx,{api_key:replacement})).configured,true);
  assert.equal((await f.repository.read()).state.job,null);const historical=await f.repository.job(1);assert.equal(historical.state,'failed');assert.equal(historical.reason,'credential_changed');assert.equal(historical.lease,null);
});
test('clear revokes active workers even when a larger invalidation checkpoint cannot fit',async t=>{
  const f=await fixture(t);await f.settings.saveMarketappApiKey(ctx,{api_key:replacement});const captured=await f.settings.capture(),worker=createCloudRepository(f.db,{credentialFence:captured.fence});
  const saved=await worker.read();saved.state.job={id:1,kind:'prices',state:'running',streams:[],scopes:[],invocation_deadline:f.now()+10000,lease_until:f.now()+10000,lease:'synthetic-lease'};
  assert.equal(await worker.append(saved.revision,{key:'active-worker',state:saved.state,job:saved.state.job,records:[],observed_at:new Date(f.now()).toISOString()}),true);
  const previousAppend=f.repository.append;f.repository.append=async()=>{throw new Error('database or disk is full');};
  assert.equal((await f.settings.removeMarketappApiKey(ctx)).configured,false);assert.equal((await f.settings.capture()).token,'');
  await assert.rejects(f.settings.assertCurrent(captured.fence),e=>e.code==='PRIVATE_KEY_CHANGED');
  const current=await f.settings.capture(),fresh=createCloudRepository(f.db,{credentialFence:current.fence});
  assert.equal((await fresh.read()).state.job.state,'failed');assert.equal((await fresh.job(1)).state,'failed');assert.equal((await fresh.jobs())[0].state,'failed');
  const head=await fresh.read();assert.equal(await worker.append(head.revision,{key:'late-after-clear',state:head.state,records:[],observed_at:new Date(f.now()).toISOString()}),false);
  f.repository.append=previousAppend;
  let requests=0;const newEngine=createCloudEngine({repository:fresh,ownerTelegramId:owner,marketappToken:'synthetic-new-key-for-fence-test',now:()=>f.now(),fetch:async()=>{requests++;throw new Error('No request allowed');}});
  assert.equal((await newEngine.stepJob(ctx,{job_id:1})).job.state,'failed');
  await assert.rejects(newEngine.resumeJob(ctx,{job_id:1}),/cannot resume/);assert.equal(requests,0);assert.equal((await fresh.read()).revision,head.revision);
  assert.equal((await f.settings.getMarketappSettings(ctx)).reason,undefined);
  assert.equal((await f.settings.saveMarketappApiKey(ctx,{api_key:replacement})).configured,true);
});
test('late private collector commits are atomically fenced after replacement or bootstrap clearance',async t=>{
  for(const action of ['save','clear']) {
    const f=await fixture(t),old=await f.settings.capture(),worker=createCloudRepository(f.db,{credentialFence:old.fence});
    if(action==='save')await f.settings.saveMarketappApiKey(ctx,{api_key:replacement});else await f.settings.removeMarketappApiKey(ctx);
    await assert.rejects(f.settings.assertCurrent(old.fence),e=>e.code==='PRIVATE_KEY_CHANGED');
    const head=await f.repository.read();assert.equal(await worker.append(head.revision,{key:`late-${action}`,state:head.state,job:null,records:[{kind:'listing',record:{late:true}}],raw_body:'late response',observed_at:new Date(f.now()).toISOString()}),false);
    assert.equal((await f.repository.read()).revision,head.revision);assert.equal((await f.repository.records()).length,1);
  }
});
test('credential races fail compare-and-swap without resetting history or nonce counters',async t=>{
  const f=await fixture(t),run=f.db.run;let moved=false;
  f.db.run=async(sql,params)=>{if(!moved&&sql.startsWith('UPDATE private_provider_credentials SET credential_version=')){moved=true;const head=await f.repository.read();await f.repository.append(head.revision,{key:'racing-checkpoint',state:head.state,job:null,records:[],observed_at:new Date(f.now()).toISOString()});}return run(sql,params);};
  await assert.rejects(f.settings.saveMarketappApiKey(ctx,{api_key:replacement}),e=>e.code==='PRIVATE_CONFLICT');assert.equal((await f.settings.capture()).token,bootstrap);
  const counter=f.database.prepare('SELECT nonce_counter FROM private_provider_credentials').get().nonce_counter;await f.settings.saveMarketappApiKey(ctx,{api_key:replacement});assert.ok(f.database.prepare('SELECT nonce_counter FROM private_provider_credentials').get().nonce_counter>counter);assert.equal((await f.repository.records()).length,1);
});
