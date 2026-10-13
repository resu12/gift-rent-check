import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {compactOperationalStorageTriggers,installCompactOperationalStorage,developmentResetState} from '../tools/compact-operational-storage.mjs';
import {encodeCheckpoint,decodeCheckpoint,COMPACT_OPERATIONAL_READY_SQL} from '../tgcloud/lib/checkpoint-storage.js';
import {createOwnedRefreshArchive} from '../tgcloud/lib/owned-refresh-archive.js';
import {createGiftRefreshStorage,giftRefreshSessionKey} from '../tgcloud/lib/gift-refresh-storage.js';

const date='2026-10-12T12:00:00.000Z';
const state=(id=1)=>({version:2,operational_storage_version:1,next_job_id:10,attempts:[1000,2000],next_allowed_at:3000,
  marketapp_budget_reset:{id:'saved-reset',excluded_attempts:[1000],at:2000,expires_at:4000},
  job:{id:5,kind:'prices',state:'partial',streams:[{cursor:'saved cursor',complete:false}]},
  owned_prices:{version:2,next_run_id:id+1,attempts:[4000],next_allowed_at:5000,previous_run:null,
    last_session:{id:`owned-session-${id}-saved`,run_id:id},run:{id,wallet:'synthetic-wallet',scope:'portfolio',state:'complete',
      total:2,checked:2,updated:1,unresolved:1,status_updated:2,status_unresolved:0,reason:null,started_at:date,completed_at:date,
      session_id:`owned-session-${id}-saved`,targets:[{nft_address:'a',extension:'x'.repeat(20000)}],pending:[],lease_until:0}},
  gift_refresh:{version:1,next_run_id:id+1,last_complete:null,run:{id,scope:'portfolio',wallet:'synthetic-wallet',session_id:`gift-session-${id}-saved`,
    state:'complete',total:2,checked:2,updated:1,unresolved:1,status_updated:2,status_unresolved:0,reason:null,started_at:date,
    check_started_at:date,completed_at:date,provider:'marketapp_website',cache_hit:true,scope_signature:'a'.repeat(64),
    fallback_reason:null,deadline:8000,stage:'website',next_allowed_at:0,targets:['synthetic-nft'],results:{large:'x'.repeat(15000)},
    session_fence:{generation:4,cookie_version:9},inflight:null}}});

function fixture(t) {
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT UNIQUE,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT);
    CREATE TABLE public_cloud_events(row_id TEXT PRIMARY KEY,user_id TEXT,sequence INTEGER,event_key TEXT,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT);
    CREATE UNIQUE INDEX public_sequence ON public_cloud_events(user_id,sequence);
    CREATE TABLE owned_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT,source_sequence INTEGER);
    CREATE TABLE owned_refresh_sessions(session_id TEXT PRIMARY KEY,run_id INTEGER,source_sequence INTEGER);
    CREATE TABLE owned_refresh_index(id INTEGER PRIMARY KEY,sequence INTEGER);
    CREATE TABLE gift_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT,source_sequence INTEGER);
    CREATE TABLE public_gift_refresh_runs(row_id TEXT PRIMARY KEY,user_id TEXT,run_id INTEGER,summary_json TEXT,source_sequence INTEGER);
    CREATE TABLE public_owned_refresh_runs(row_id TEXT PRIMARY KEY,user_id TEXT,run_id INTEGER,summary_json TEXT,source_sequence INTEGER);
    CREATE TABLE public_owned_refresh_sessions(row_id TEXT PRIMARY KEY,user_id TEXT,session_id TEXT,run_id INTEGER,source_sequence INTEGER);
    CREATE TABLE public_owned_refresh_index(user_id TEXT PRIMARY KEY,sequence INTEGER);`);
  const queries=[];
  const db={async get(sql,params={}){queries.push(sql);return database.prepare(sql).get(params)??null;},
    async all(sql,params={}){queries.push(sql);return database.prepare(sql).all(params);},
    async run(sql,params={}){queries.push(sql);return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  for(const value of compactOperationalStorageTriggers())database.exec(value.sql);
  function append(sequence,logical=state(),{tenant=null,records=[{kind:'owned_price',record:{price:'0.123'}}],key=`event:${sequence}`,job=logical.job}={}) {
    const values=[sequence,key,JSON.stringify(logical),job?.id??null,job?JSON.stringify(job):null,JSON.stringify(records),null,date];
    if(tenant===null)return database.prepare('INSERT OR IGNORE INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(...values);
    return database.prepare('INSERT OR IGNORE INTO public_cloud_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(JSON.stringify([tenant,'event',sequence]),tenant,...values);
  }
  const rows=(tenant=null)=>tenant===null?database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all():database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all(tenant);
  return {database,db,queries,append,rows};
}

test('compact checkpoint codec remains standalone even when legacy reuse hints are supplied',()=>{
  const logical=state(),before=structuredClone(logical),saved=encodeCheckpoint(logical,logical.job,99,{sequence:1,job_json:JSON.stringify(logical.job)},null,null,{sequence:1,gift_refresh_json:JSON.stringify(logical.gift_refresh)});
  assert.deepEqual(JSON.parse(saved),before);assert.deepEqual(decodeCheckpoint({sequence:99,state_json:saved}),before);assert.deepEqual(logical,before);
  assert.throws(()=>encodeCheckpoint({...logical,__checkpoint_job_sequence:1},null,2),/marker/);
});

test('many private progress events retain one state, latest job per ID, exact evidence and fixed summaries',async t=>{
  const f=fixture(t), originals=[];
  for(let sequence=1;sequence<=60;sequence++) {
    const logical=state(sequence<31?1:2);logical.attempts.push(sequence);logical.job.id=sequence<21?5:6;logical.job.progress=sequence;
    if(sequence>=31)logical.owned_prices.previous_run=state().owned_prices.run;
    f.append(sequence,logical);originals.push({logical,records:f.rows().at(-1).records_json});
  }
  const rows=f.rows();assert.equal(rows.filter(row=>row.state_json!=='{}').length,1);
  assert.deepEqual(JSON.parse(rows.at(-1).state_json),originals.at(-1).logical);
  assert.deepEqual(rows.filter(row=>row.job_json!==null).map(row=>[row.sequence,row.job_id]),[[20,5],[60,6]]);
  assert.deepEqual(rows.map(row=>row.records_json),originals.map(row=>row.records));
  assert.deepEqual(rows.map(row=>row.event_key),Array.from({length:60},(_,i)=>`event:${i+1}`));
  assert.equal(rows.reduce((n,row)=>n+Buffer.byteLength(row.state_json),0),Buffer.byteLength(rows.at(-1).state_json)+59*2,
    'state storage is the current checkpoint plus two-byte retired markers');
  const archive=createOwnedRefreshArchive(f.db);f.queries.length=0;
  assert.equal((await archive.ownedRefreshRun(1)).checked,2);assert.equal(await archive.ownedRefreshSession('owned-session-1-saved'),1);
  assert.ok(!f.queries.some(sql=>sql.includes('WITH resolved')||sql.includes('LEFT JOIN cloud_events')),'compact archives are not reconstructed from retired state');
  const own=JSON.parse(f.database.prepare('SELECT summary_json FROM owned_refresh_runs WHERE run_id=1').get().summary_json);
  assert.equal(Object.hasOwn(own,'targets'),false);assert.equal(Object.hasOwn(own,'pending'),false);
  const gift=await createGiftRefreshStorage(f.db).giftRefreshRun(1);
  assert.equal(gift.cache_hit,true);assert.equal(gift.reason,null);assert.equal(gift.provider,'marketapp_website');
  assert.equal(Object.hasOwn(gift,'results'),false);assert.equal(Object.hasOwn(gift,'session_fence'),false);
  assert.equal(f.database.prepare('SELECT sequence FROM owned_refresh_index').get().sequence,60);
});

test('session binding records and old gift outcomes survive retirement',async t=>{
  const f=fixture(t),id='gift-session-1-saved';
  f.append(1,state(),{key:giftRefreshSessionKey(id),records:[{kind:'gift_refresh_binding',record:{session_id:id,run_id:1}}]});
  f.append(2,state(2));
  const repository=createGiftRefreshStorage(f.db);
  assert.equal(await repository.giftRefreshSession(id),1);assert.equal((await repository.giftRefreshRun(1)).id,1);assert.equal(f.rows()[0].state_json,'{}');
});

test('public retirement, summaries, replay bindings and watermarks stay within tenant',t=>{
  const f=fixture(t);f.append(1,state(),{tenant:'41'});f.append(1,state(),{tenant:'42'});
  const other=f.rows('42');f.append(2,state(2),{tenant:'41'});
  assert.deepEqual(f.rows('42'),other);assert.equal(f.rows('41')[0].state_json,'{}');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_owned_refresh_runs WHERE user_id=?').get('41').n,2);
  assert.equal(f.database.prepare('SELECT sequence FROM public_owned_refresh_index WHERE user_id=?').get('41').sequence,2);
  assert.equal(f.database.prepare('SELECT sequence FROM public_owned_refresh_index WHERE user_id=?').get('42').sequence,1);
  assert.equal(f.database.prepare('SELECT run_id FROM public_owned_refresh_sessions WHERE row_id=?').get(JSON.stringify(['42','session','owned-session-1-saved'])).run_id,1);
  const gifts=f.database.prepare('SELECT user_id,run_id,summary_json FROM public_gift_refresh_runs ORDER BY user_id,run_id').all();
  assert.deepEqual(gifts.map(row=>[row.user_id,row.run_id]),[['41',1],['41',2],['42',1]]);
  assert.ok(gifts.every(row=>!Object.hasOwn(JSON.parse(row.summary_json),'results')&&!Object.hasOwn(JSON.parse(row.summary_json),'session_fence')));
});

test('a remapped immutable session aborts the complete event and every preceding archive write',t=>{
  for(const tenant of [null,'41']) {
    const f=fixture(t);f.append(1,state(),{tenant});const before=f.rows(tenant),next=state(2);
    next.owned_prices.last_session={id:'owned-session-1-saved',run_id:2};
    assert.throws(()=>f.append(2,next,{tenant}),/Conflicting compact refresh session/);assert.deepEqual(f.rows(tenant),before);
    const table=tenant===null?'owned_refresh_runs':'public_owned_refresh_runs';assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);
    const index=tenant===null?'owned_refresh_index':'public_owned_refresh_index';assert.equal(f.database.prepare(`SELECT sequence FROM ${index}`).get().sequence,1);
  }
});

test('archive storage failure rolls back new evidence, snapshots, budgets and watermarks',t=>{
  const f=fixture(t);f.append(1);const before=f.rows();
  f.database.exec("CREATE TRIGGER fail_archive BEFORE UPDATE ON gift_refresh_runs BEGIN SELECT RAISE(ABORT,'synthetic archive failure'); END");
  const next=state();next.attempts.push(9999);next.owned_prices.run.checked=1;
  assert.throws(()=>f.append(2,next),/synthetic archive failure/);assert.deepEqual(f.rows(),before);
  assert.equal(JSON.parse(f.database.prepare('SELECT summary_json FROM owned_refresh_runs').get().summary_json).checked,2);
  assert.equal(f.database.prepare('SELECT sequence FROM owned_refresh_index').get().sequence,1);
});

test('compact inserts reject references and discovery deltas before retiring anything',t=>{
  for(const mutate of [value=>value.__checkpoint_job_sequence=1,value=>value.job.__public_discovery_candidates={sequence:1},
    value=>value.job.__public_discovery_catalog={sequence:1},value=>value.owned_prices.history=[{id:99}]]) {
    const f=fixture(t);f.append(1);const before=f.rows(),next=state();mutate(next);
    assert.throws(()=>f.append(2,next),/self-contained/);assert.deepEqual(f.rows(),before);
  }
});

test('legacy events are unaffected until a caller explicitly enters compact mode',t=>{
  const f=fixture(t),legacy=state();delete legacy.operational_storage_version;
  f.append(1,legacy);f.append(2,legacy);assert.equal(f.rows().filter(row=>row.state_json!=='{}').length,2);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM owned_refresh_runs').get().n,0);
});

test('archived current run takes precedence over an equal-ID previous summary',t=>{
  const f=fixture(t),logical=state();logical.owned_prices.previous_run={...logical.owned_prices.run,checked:1};
  f.append(1,logical);assert.equal(JSON.parse(f.database.prepare('SELECT summary_json FROM owned_refresh_runs').get().summary_json).checked,2);
});

test('only twenty terminal job bodies remain; current, resumable and unknown states survive in each scope',t=>{
  for(const tenant of [null,'41']) {
    const f=fixture(t);
    for(let sequence=1;sequence<=35;sequence++) {
      const logical=state();logical.job={id:sequence,state:sequence<=5?['queued','running','partial','unknown',null][sequence-1]
        :['complete','stopped','failed','cancelled'][sequence%4]};logical.next_job_id=sequence+1;
      f.append(sequence,logical,{tenant});
    }
    const live=f.rows(tenant).filter(row=>row.job_json!==null);
    assert.deepEqual(live.map(row=>row.job_id),[1,2,3,4,5,...Array.from({length:20},(_,i)=>i+16)]);
    // The current job remains available even if an unrelated event carries it
    // without publishing another job column.
    const current=state();current.job={id:16,state:'failed'};current.next_job_id=36;
    f.append(36,current,{tenant,job:null});assert.ok(f.rows(tenant).find(row=>row.job_id===16).job_json);
    assert.equal(f.rows(tenant).filter(row=>row.job_json!==null).length,25);
  }
});

test('compact archive watermark mismatch fails closed rather than rebuilding missing history',async t=>{
  const f=fixture(t);f.append(1);f.append(2);f.database.exec('UPDATE owned_refresh_index SET sequence=1');
  await assert.rejects(createOwnedRefreshArchive(f.db).ownedRefreshRun(1),/archive is not current/);
});

test('installation is idempotent and rejects unexpected existing trigger definitions',async t=>{
  const f=fixture(t);assert.deepEqual(await installCompactOperationalStorage(f.db),{ready:true,trigger_count:3});
  assert.equal((await f.db.get(`SELECT 1 AS ready WHERE ${COMPACT_OPERATIONAL_READY_SQL}`)).ready,1);
  f.database.exec('DROP TRIGGER operational_storage_v1_private_insert');assert.equal(await f.db.get(`SELECT 1 AS ready WHERE ${COMPACT_OPERATIONAL_READY_SQL}`),null);
  f.database.exec('CREATE TRIGGER operational_storage_v1_private_insert AFTER INSERT ON cloud_events BEGIN SELECT 1; END');
  await assert.rejects(installCompactOperationalStorage(f.db),/differs/);
});

test('development reset keeps counters, exact budgets, receipt and cooldown while clearing scans',()=>{
  const saved=state();saved.job.lease_until=12000;saved.owned_prices.run.lease_until=15000;
  saved.owned_prices.history=[{id:1}];saved.owned_prices.sessions=[{id:'old-session-saved',run_id:1}];
  saved.record_storage_floor=500;saved.extra_durable={protected:'unchanged'};
  const before=structuredClone(saved),result=developmentResetState(saved);
  assert.deepEqual(saved,before);assert.equal(result.next_job_id,before.next_job_id);assert.deepEqual(result.attempts,before.attempts);
  assert.deepEqual(result.marketapp_budget_reset,before.marketapp_budget_reset);assert.equal(result.next_allowed_at,12000);
  assert.equal(result.owned_prices.next_run_id,before.owned_prices.next_run_id);assert.deepEqual(result.owned_prices.attempts,before.owned_prices.attempts);
  assert.equal(result.owned_prices.next_allowed_at,15000);assert.equal(result.owned_prices.run,null);assert.equal(result.owned_prices.previous_run.id,1);
  assert.equal(Object.hasOwn(result.owned_prices.previous_run,'targets'),false);assert.deepEqual(result.owned_prices.last_session,before.owned_prices.last_session);
  assert.equal(Object.hasOwn(result.owned_prices,'history'),false);assert.equal(Object.hasOwn(result.owned_prices,'sessions'),false);
  assert.equal(result.gift_refresh.next_run_id,before.gift_refresh.next_run_id);assert.equal(result.gift_refresh.run,null);
  assert.equal(result.job,null);assert.equal(result.operational_storage_version,1);assert.equal(result.record_storage_floor,500);
  assert.deepEqual(result.extra_durable,before.extra_durable);
});

test('reset rejects malformed counters, leases and unresolved physical references',()=>{
  for(const mutate of [value=>value.next_job_id=0,value=>value.next_job_id=value.job.id,value=>value.attempts=[-1],
    value=>value.job.lease_until=-1,value=>value.owned_prices.next_run_id=1,value=>value.gift_refresh.next_run_id=1,
    value=>value.__checkpoint_job_sequence=1]) {const logical=state();mutate(logical);assert.throws(()=>developmentResetState(logical),/Invalid/);}
});

test('reset archives abandoned refreshes as terminal results and preserves original session replay',async t=>{
  const f=fixture(t),logical=state();logical.owned_prices.run.state='running';logical.gift_refresh.run.state='running';
  f.append(1,logical,{key:giftRefreshSessionKey('gift-session-1-saved'),records:[{kind:'gift_refresh_binding',record:{session_id:'gift-session-1-saved',run_id:1}}]});
  assert.throws(()=>developmentResetState(logical),/trusted time/);
  const reset=developmentResetState(logical,Date.parse(date));f.append(2,reset,{job:null});
  const own=await createOwnedRefreshArchive(f.db).ownedRefreshRun(1),gift=await createGiftRefreshStorage(f.db).giftRefreshRun(1);
  for(const value of [own,gift]) {assert.equal(value.state,'failed');assert.equal(value.reason,'development_reset');assert.equal(value.completed_at,date);assert.equal(Object.hasOwn(value,'targets'),false);}
  assert.equal(await createOwnedRefreshArchive(f.db).ownedRefreshSession('owned-session-1-saved'),1);
  assert.equal(await createGiftRefreshStorage(f.db).giftRefreshSession('gift-session-1-saved'),1);
});
