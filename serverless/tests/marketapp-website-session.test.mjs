import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createMarketappRememberedSessionBox} from '../tgcloud/lib/marketapp-remembered-session-box.js';
import {createMarketappWebsiteSession} from '../tgcloud/lib/marketapp-website-session.js';
import {createMarketappWebsiteGate} from '../tgcloud/lib/marketapp-website-gate.js';
const wallet=`0:${'11'.repeat(32)}`,owner='12345';
function fixture(t,{limits}={}){
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE marketapp_website_gates(scope_key TEXT PRIMARY KEY,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_allowed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE marketapp_website_requests(request_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,attempted_at INTEGER NOT NULL);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,nonce_counter INTEGER NOT NULL DEFAULT 0,cookie_version INTEGER NOT NULL DEFAULT 0,wallet TEXT,wallet_revision INTEGER,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);`);
  database.prepare('INSERT INTO cloud_events VALUES(1,?,?,?,?,?,?,?)').run('seed',JSON.stringify({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0}),null,null,JSON.stringify([{kind:'settings',record:{wallet}}]),null,'2026-10-09T12:00:00.000Z');
  const db={async run(sql,params={}){return {rowsAffected:Number(database.prepare(sql).run(params).changes)};},async get(sql,params={}){return database.prepare(sql).get(params)||null;},async all(sql,params={}){return database.prepare(sql).all(params);}};
  const repository=createCloudRepository(db),box=createMarketappRememberedSessionBox('22'.repeat(32));let at=Date.parse('2026-10-09T12:00:00.000Z');
  const session=createMarketappWebsiteSession({repository,rememberedSessionBox:box,ownerTelegramId:owner,clock:async()=>at});
  const gate=createMarketappWebsiteGate(db,limits?{limits}:{});
  async function remember(){const fence=await repository.marketappSessionFence(owner);await session.remember(owner,wallet,fence,'session=synthetic-private-cookie',at,at+86400000,fence.cookie_version);return await session.read(owner,wallet);}
  return {database,db,repository,session,gate,box,remember,now:()=>at,advance:ms=>{at+=ms;}};
}
test('one durable owner lease serializes analytics and gift refresh and obsolete release cannot unlock replacement',async t=>{
  const f=fixture(t),first=await f.session.acquire(owner,'analytics');assert.ok(first);
  assert.equal(await f.session.acquire(owner,'gifts'),null);
  const secondInstance=createMarketappWebsiteSession({repository:f.repository,rememberedSessionBox:f.box,ownerTelegramId:owner,clock:async()=>f.now()});
  assert.equal(await secondInstance.acquire(owner,'other-runtime'),null);
  f.advance(150000);const second=await f.session.acquire(owner,'analytics');assert.ok(second);
  assert.equal(await f.session.release(owner,first),false);
  assert.equal((await f.session.reserve(owner,first,'old2')).reason,'busy');
  assert.deepEqual(await f.session.reserve(owner,second,'fresh'),{allowed:true});
  assert.equal(await f.session.release(owner,second),true);
});
test('website pacing, attempts and retry deadlines are shared across owners and survive lease release',async t=>{
  const f=fixture(t),lease=await f.gate.acquireMarketappWebsiteLease(owner,'first',f.now());
  assert.deepEqual(await f.gate.reserveMarketappWebsiteRequest(owner,lease,'r1',f.now()),{allowed:true});
  assert.equal((await f.gate.reserveMarketappWebsiteRequest(owner,lease,'r1',f.now())).reason,'replay');
  const other=await f.gate.acquireMarketappWebsiteLease('67890','second',f.now());
  const throttled=await f.gate.reserveMarketappWebsiteRequest('67890',other,'r2',f.now());assert.equal(throttled.reason,'cooldown');assert.equal(throttled.retry_after_seconds,1);
  f.advance(1000);assert.deepEqual(await f.gate.reserveMarketappWebsiteRequest('67890',other,'r2',f.now()),{allowed:true});
  await f.gate.deferMarketappWebsiteRequests('67890',other,f.now()+120000,f.now());
  await f.gate.releaseMarketappWebsiteLease('67890',other);
  const next=await f.gate.acquireMarketappWebsiteLease('67890','third',f.now());
  assert.equal((await f.gate.reserveMarketappWebsiteRequest('67890',next,'r3',f.now())).retry_after_seconds,120);
  assert.equal((await f.gate.reserveMarketappWebsiteRequest(owner,lease,'r4',f.now())).retry_after_seconds,120);
  const text=JSON.stringify(f.database.prepare('SELECT * FROM marketapp_website_requests').all());assert.equal(text.includes('cookie'),false);
});
test('a reservation atomically enforces rolling service quota across concurrent accounts and recovers at exact boundary',async t=>{
  const limits={owner_attempts:3,service_attempts:2,window_ms:86400000,interval_ms:1000,lease_ms:150000},f=fixture(t,{limits});
  const first=await f.gate.acquireMarketappWebsiteLease(owner,'a',f.now()),second=await f.gate.acquireMarketappWebsiteLease('67890','b',f.now());
  await f.gate.reserveMarketappWebsiteRequest(owner,first,'1',f.now());f.advance(1000);
  const concurrent=await Promise.all([f.gate.reserveMarketappWebsiteRequest(owner,first,'2',f.now()),f.gate.reserveMarketappWebsiteRequest('67890',second,'3',f.now())]);
  assert.equal(concurrent.filter(x=>x.allowed).length,1);
  const denied=concurrent.find(x=>!x.allowed);assert.equal(denied.reason,'daily');assert.equal(denied.retry_after_seconds,86399);
  f.advance(86399000);const next=await f.gate.acquireMarketappWebsiteLease('67890','c',f.now());
  assert.deepEqual(await f.gate.reserveMarketappWebsiteRequest('67890',next,'4',f.now()),{allowed:true});
});
test('the timerless proof exchange permits only its fixed three accounted requests and never personal gifts',async t=>{
  const f=fixture(t),id='aa'.repeat(32),prepare=await f.gate.acquireMarketappWebsiteLease(owner,`${id}_prepare`,f.now());
  assert.deepEqual(await f.gate.reserveMarketappWebsiteRequest(owner,prepare,`${id}_home`,f.now(),{authentication:true}),{allowed:true});
  await f.gate.releaseMarketappWebsiteLease(owner,prepare);
  const finish=await f.gate.acquireMarketappWebsiteLease(owner,`${id}_finish`,f.now());
  assert.deepEqual(await f.gate.reserveMarketappWebsiteRequest(owner,finish,`${id}_auth`,f.now(),{authentication:true}),{allowed:true});
  assert.deepEqual(await f.gate.reserveMarketappWebsiteRequest(owner,finish,`${id}_analytics`,f.now(),{authentication:true}),{allowed:true});
  assert.equal((await f.gate.reserveMarketappWebsiteRequest(owner,finish,`${id}_gifts`,f.now(),{authentication:true})).reason,'cooldown');
  assert.equal((await f.gate.reserveMarketappWebsiteRequest(owner,finish,`${'bb'.repeat(32)}_auth`,f.now(),{authentication:true})).reason,'cooldown');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM marketapp_website_requests').get().n,3);
  await f.gate.deferMarketappWebsiteRequests(owner,finish,f.now()+60000,f.now());
  assert.equal((await f.gate.reserveMarketappWebsiteRequest(owner,finish,`${id}_home`,f.now(),{authentication:true})).reason,'replay');
});
test('session reuse and rotation preserve owner, wallet, cap, fresh durable nonce and encrypted-only storage',async t=>{
  const f=fixture(t),first=await f.remember();assert.equal(first.value.cookie_version,1);f.advance(1000);
  const next=await f.session.rotate(owner,wallet,first,{cookie:'session=synthetic-rotated-cookie',expires_at:f.now()+3600000,deleted:false});
  assert.equal(next.value.cookie_version,2);assert.equal(next.value.created_at,first.value.created_at);assert.equal(next.value.expires_at,f.now()+3600000);
  await assert.rejects(f.session.current(owner,wallet,first),error=>error.code==='MARKETAPP_WEBSITE_SESSION_EXPIRED');
  assert.equal((await f.session.read(owner,wallet)).value.cookie,next.value.cookie);
  const persisted=JSON.stringify(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all());assert.equal(persisted.includes('synthetic-private-cookie'),false);assert.equal(persisted.includes('synthetic-rotated-cookie'),false);
  const third=await f.session.rotate(owner,wallet,next,{cookie:next.value.cookie,expires_at:f.now()+7*86400000,deleted:false});assert.equal(third.value.expires_at,next.value.expires_at);
});
test('session authorization rejects before storage and decryption; logout and wallet changes invalidate late work',async t=>{
  let accesses=0;const denied=createMarketappWebsiteSession({repository:new Proxy({},{get(){accesses++;throw new Error('synthetic-secret');}}),ownerTelegramId:owner});
  for(const operation of [()=>denied.read('67890',wallet),()=>denied.acquire('67890','id'),()=>denied.current('67890',wallet,{})])await assert.rejects(operation,error=>error.code==='MARKETAPP_WEBSITE_PRIVATE_ACCESS_DENIED');
  assert.equal(accesses,0);
  const f=fixture(t),stored=await f.remember();await f.session.invalidate(owner,stored);
  await assert.rejects(f.session.current(owner,wallet,stored));assert.equal(await f.session.read(owner,wallet),null);
  assert.equal(f.database.prepare('SELECT nonce_counter FROM marketapp_analytics_sessions').get().nonce_counter,1);
  const current=await f.remember();f.database.prepare('INSERT INTO cloud_events VALUES(2,?,?,?,?,?,?,?)').run('wallet-change','{}',null,null,JSON.stringify([{kind:'settings',record:{wallet:`0:${'33'.repeat(32)}`}}]),null,new Date(f.now()).toISOString());
  await assert.rejects(f.session.current(owner,wallet,current));assert.equal(await f.session.read(owner,wallet),null);
});
test('authoritative website observations commit with the same atomic session and wallet fences as their checkpoint',async t=>{
  const f=fixture(t),stored=await f.remember(),saved=await f.repository.read();
  const event={key:'website-first',state:{...saved.state,website_gifts:{checked:1}},records:[{kind:'listing',record:{nft_address:`0:${'44'.repeat(32)}`,price_per_day:'190000000'}}],observed_at:new Date(f.now()).toISOString()};
  assert.equal(await f.repository.appendWebsite(saved.revision,event,owner,stored),true);
  await f.session.invalidate(owner,stored);
  const next=await f.repository.read();assert.equal(await f.repository.appendWebsite(next.revision,{...event,key:'website-stale'},owner,stored),false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,2);
  assert.equal((await f.repository.read()).state.website_gifts.checked,1);
});
test('authoritative website commits reject an expired session at the saved page observation boundary',async t=>{
  const f=fixture(t),stored=await f.remember(),saved=await f.repository.read();f.advance(86400000);
  const event={key:'website-expired',state:{...saved.state,gift_refresh:{run:{checked:1}}},records:[{kind:'owned_price',record:{nft_address:`0:${'44'.repeat(32)}`}}],observed_at:new Date(f.now()).toISOString()};
  assert.equal(await f.repository.appendWebsite(saved.revision,event,owner,stored),false);
  assert.deepEqual(await f.repository.read(),saved);
  assert.equal(await f.repository.appendWebsite(saved.revision,{...event,observed_at:'invalid'},owner,stored),false);
});
