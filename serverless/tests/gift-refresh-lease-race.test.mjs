import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createGiftRefreshEngine} from '../tgcloud/lib/gift-refresh-engine.js';
import {createMarketappWebsiteSession} from '../tgcloud/lib/marketapp-website-session.js';
import {createMarketappRememberedSessionBox} from '../tgcloud/lib/marketapp-remembered-session-box.js';
import {syntheticGiftsHead,syntheticGiftAddress as nft,syntheticWallet as wallet} from './fixtures/marketapp-gifts-page-fixture.mjs';
import {streamedBody} from './fixtures/http-response.mjs';

const owner='12345',ctx={initData:{user:{id:12345}}},collection=`0:${'44'.repeat(32)}`;
function fixture(t,{more=false}={}) {
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE owned_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT NOT NULL,source_sequence INTEGER NOT NULL);
    CREATE TABLE owned_refresh_sessions(session_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,source_sequence INTEGER NOT NULL);
    CREATE TABLE owned_refresh_index(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,nonce_counter INTEGER NOT NULL DEFAULT 0,cookie_version INTEGER NOT NULL DEFAULT 0,wallet TEXT,wallet_revision INTEGER,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE marketapp_website_gates(scope_key TEXT PRIMARY KEY,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_allowed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE marketapp_website_requests(request_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,attempted_at INTEGER NOT NULL);`);
  const db={get:async(sql,params={})=>database.prepare(sql).get(params)||null,all:async(sql,params={})=>database.prepare(sql).all(params),run:async(sql,params={})=>({rowsAffected:Number(database.prepare(sql).run(params).changes)})};
  let at=Date.parse('2026-10-11T12:00:00Z'),requests=0;
  const repository=createCloudRepository(db),box=createMarketappRememberedSessionBox('11'.repeat(32)),clock=async()=>at;
  const records=[{kind:'settings',record:{wallet}},{kind:'portfolio',record:{nft_address:nft(0),collection_address:collection,is_portfolio:true}}];
  database.prepare('INSERT INTO cloud_events VALUES(1,?,?,?,?,?,?,?)').run('seed',JSON.stringify({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0}),null,null,JSON.stringify(records),null,new Date(at).toISOString());
  const session=createMarketappWebsiteSession({repository,rememberedSessionBox:box,ownerTelegramId:owner,clock});
  const engine=createGiftRefreshEngine({repository,ownerTelegramId:owner,rememberedSessionBox:box,clock,
    fetch:async url=>{requests++;return {url,status:200,headers:{get:key=>key==='Content-Type'?'text/html':null},body:streamedBody(syntheticGiftsHead({count:1,more,cardOptions:{state:'for_rent'}}).body)};},
    tonFetch:async()=>{throw new Error('No TON request expected');}});
  const ready=(async()=>{const fence=await repository.marketappSessionFence(owner);await session.remember(owner,wallet,fence,'session=synthetic-only',at,at+86400000,fence.cookie_version);})();
  return {engine,repository,database,session,ready,requests:()=>requests,advance:ms=>at+=ms,now:()=>at,
    gate:()=>database.prepare('SELECT lease_id,lease_until FROM marketapp_website_gates WHERE scope_key=?').get('private:'+owner)};
}
async function begin(f,id='synthetic-lease-race-session-1') {await f.ready;return f.engine.start(ctx,{session_id:id});}
const input=run=>({run_id:run.run.id,session_id:run.run.session_id});
async function assertAvailable(f) {
  assert.equal(f.gate().lease_id,null);assert.equal(f.gate().lease_until,0);
  const lease=await f.session.acquire(owner,'synthetic_analytics_refresh');assert.ok(lease,'analytics must be able to acquire immediately');
  await f.session.release(owner,lease);
}

test('Stop between website acquisition and checkpoint reservation releases the orphan lease',async t=>{
  const f=fixture(t),started=await begin(f),acquire=f.repository.acquireMarketappWebsiteLease;
  f.repository.acquireMarketappWebsiteLease=async(...args)=>{const lease=await acquire(...args);await f.engine.stop(ctx,input(started));return lease;};
  const stopped=await f.engine.step(ctx,input(started));assert.equal(stopped.run.state,'partial');assert.equal(stopped.run.reason,'stopped_by_you');assert.equal(f.requests(),0);
  assert.equal((await f.repository.read()).state.gift_refresh.run.website_lease,null);
  await assertAvailable(f);
  f.repository.acquireMarketappWebsiteLease=acquire;
  const fresh=await begin(f,'synthetic-lease-race-session-2'),done=await f.engine.step(ctx,input(fresh));
  assert.equal(done.run.state,'complete');assert.equal(done.run.updated,1);assert.equal(f.requests(),1);
});

test('an append failure before reservation commits releases only the newly acquired lease',async t=>{
  const f=fixture(t),started=await begin(f),append=f.repository.append;
  f.repository.append=async(_revision,event,...rest)=>{if(event.state.gift_refresh?.run?.inflight)throw new Error('Synthetic checkpoint failure');return append(_revision,event,...rest);};
  await assert.rejects(f.engine.step(ctx,input(started)),/Synthetic checkpoint failure/);
  assert.equal(f.requests(),0);assert.equal((await f.repository.read()).state.gift_refresh.run.inflight,null);await assertAvailable(f);
});

test('exhausted checkpoint CAS retries release an unclaimed acquisition',async t=>{
  const f=fixture(t),started=await begin(f),append=f.repository.append;let rejected=0;
  f.repository.append=async(_revision,event,...rest)=>{if(event.state.gift_refresh?.run?.inflight){rejected++;return false;}return append(_revision,event,...rest);};
  await assert.rejects(f.engine.step(ctx,input(started)),/Another request updated gift refresh state/);
  assert.equal(rejected,16);assert.equal(f.requests(),0);await assertAvailable(f);
});

test('an uncertain append that committed preserves its checkpoint-owned live fence',async t=>{
  const f=fixture(t),started=await begin(f),append=f.repository.append;
  f.repository.append=async(revision,event,...rest)=>{const committed=await append(revision,event,...rest);if(event.state.gift_refresh?.run?.inflight)throw new Error('Synthetic response lost after commit');return committed;};
  await assert.rejects(f.engine.step(ctx,input(started)),/Synthetic response lost after commit/);
  const run=(await f.repository.read()).state.gift_refresh.run,gate=f.gate();
  assert.ok(run.inflight);assert.equal(gate.lease_id,run.website_lease.id);assert.equal(gate.lease_until,run.website_lease.expires_at);assert.equal(f.requests(),0);
  assert.equal(await f.session.acquire(owner,'synthetic_analytics_refresh'),null,'an uncertain committed request must stay fenced');
});

test('a failed continuation reservation does not release an existing checkpoint-owned lease',async t=>{
  const f=fixture(t,{more:true}),started=await begin(f);await f.engine.step(ctx,input(started));f.advance(1000);
  const claimed=(await f.repository.read()).state.gift_refresh.run.website_lease,append=f.repository.append;
  f.repository.append=async(revision,event,...rest)=>{if(event.state.gift_refresh?.run?.inflight)throw new Error('Synthetic continuation checkpoint failure');return append(revision,event,...rest);};
  await assert.rejects(f.engine.step(ctx,input(started)),/Synthetic continuation checkpoint failure/);
  assert.equal(f.gate().lease_id,claimed.id);assert.equal(f.gate().lease_until,claimed.expires_at);assert.equal(f.requests(),1);
  assert.equal(await f.session.acquire(owner,'synthetic_analytics_refresh'),null);
});
