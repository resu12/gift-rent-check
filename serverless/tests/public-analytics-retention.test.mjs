import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createPublicRepository,PublicAccountError,PublicStorageLimitError} from '../tgcloud/lib/public-repository.js';
import {createStorageAdmission,StorageCapacityError} from '../tgcloud/lib/storage-admission.js';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

const now=Date.now(),hour=3600000,wallet='same-wallet',owner='101';
const at=offset=>new Date(now+offset).toISOString();
const fingerprint=index=>index.toString(16).padStart(64,'0');
const snapshot=(index,span=30,offset=index*1000,address=wallet)=>({version:1,source:'marketapp_personal_rent_page',currency:'GRAM',
  timezone:'UTC',volume_basis:'gross_before_fees',summary:{rent_volume:'1.2'},period_start:'day-0',period_end:`day-${span-1}`,
  fingerprint:fingerprint(index),wallet:address,captured_at:at(offset),
  daily:Array.from({length:span},(_,day)=>({date:`day-${day}`,rent_volume:'1.2',rentals:1}))});
const raw=value=>JSON.stringify({capture:value.fingerprint,padding:'🦋'.repeat(100)});
function seed(f,value,{tenant=owner,body=raw(value),normalized=JSON.stringify(value)}={}) {
  f.database.prepare(`INSERT INTO public_personal_rental_analytics
    (row_id,user_id,fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json) VALUES(?,?,?,?,?,?,?,?)`)
    .run(JSON.stringify([tenant,'analytics',value.fingerprint]),tenant,value.fingerprint,value.wallet,value.captured_at,value.captured_at,body,normalized);
}
function attempt(f,value,{id=`attempt-${value.fingerprint}`,created=now-2*hour,expires=created+300000,
  state='saved',stage=state==='saved'?'complete':'save_snapshot',fingerprintValue=value.fingerprint,outcome=null}={}) {
  const saved=outcome??JSON.stringify({version:1,flow:'analytics_refresh',state,stage,code:null,
    observed_at:at(created-now),period_days:value.daily.length,authenticated:true,analytics_refreshed:state==='saved',
    ...(fingerprintValue===null?{}:{snapshot_fingerprint:fingerprintValue})});
  f.database.prepare(`INSERT INTO public_marketapp_login_attempts
    (row_id,user_id,attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint,outcome_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(JSON.stringify([owner,'login',id]),owner,id,owner,value.wallet,created,expires,'consumed',null,saved);
}
const rows=f=>f.database.prepare('SELECT * FROM public_personal_rental_analytics WHERE user_id=? ORDER BY fingerprint').all(owner);
const ids=f=>rows(f).map(row=>row.fingerprint);
async function fixture(t) {const f=createPublicDatabase(t);f.repo=f.repository(owner);await f.repo.ensureAccount();return f;}

test('repeated invited refreshes retain the newest capture per wallet/span instead of a lifetime count limit',async t=>{
  const f=await fixture(t);
  for(let index=1;index<=28;index++)for(const span of [30,365]) {
    const value=snapshot(index*2+(span===365?1:0),span);
    assert.equal(await f.repo.importPersonalAnalytics(value,raw(value),value.captured_at),true);
  }
  assert.equal(rows(f).length,2);
  assert.deepEqual((await f.repo.personalAnalyticsSnapshots(wallet)).map(value=>value.daily.length).sort((a,b)=>a-b),[30,365]);
  const latest=snapshot(57,365);
  assert.equal(await f.repo.importPersonalAnalytics(latest,raw(latest),latest.captured_at),false);
  assert.equal((await f.repo.latestPersonalAnalytics(wallet)).fingerprint,latest.fingerprint);
});

test('older and equal-time captures never replace or remove the newest capture and remain tenant/wallet isolated',async t=>{
  const f=await fixture(t),other=f.repository(202),newest=snapshot(9,30,9000),older=snapshot(1,30,1000),tie=snapshot(3,30,9000),otherWallet=snapshot(4,30,4000,'other-wallet');
  await other.ensureAccount();
  await f.repo.importPersonalAnalytics(newest,raw(newest),newest.captured_at);
  await f.repo.importPersonalAnalytics(older,raw(older),older.captured_at);
  await f.repo.importPersonalAnalytics(tie,raw(tie),tie.captured_at);
  await f.repo.importPersonalAnalytics(otherWallet,raw(otherWallet),otherWallet.captured_at);
  await other.importPersonalAnalytics(older,'foreign-raw',older.captured_at);
  assert.equal((await f.repo.latestPersonalAnalytics(wallet)).fingerprint,newest.fingerprint);
  assert.equal((await f.repo.latestPersonalAnalytics('other-wallet')).fingerprint,otherWallet.fingerprint);
  assert.equal((await other.latestPersonalAnalytics(wallet)).fingerprint,older.fingerprint);
  assert.equal(await other.latestPersonalAnalytics('other-wallet'),null);
  assert.equal(f.database.prepare('SELECT raw_snapshot FROM public_personal_rental_analytics WHERE user_id=?').get('202').raw_snapshot,'foreign-raw');
});

test('active, recent and latest per-period audit fingerprints survive bounded cleanup and replay',async t=>{
  const f=await fixture(t),expired=snapshot(1,30,-10*hour),active=snapshot(2,30,-8*hour),recent=snapshot(3,30,-2*hour),latestYear=snapshot(4,365,-4*hour);
  for(const value of [expired,active,recent,latestYear])seed(f,value);
  attempt(f,expired,{created:now-9*hour});
  attempt(f,active,{created:now-7*hour,expires:now+300000,state:'updating'});
  attempt(f,recent,{created:now-hour/2});
  attempt(f,latestYear,{created:now-3*hour});
  for(const value of [snapshot(10,30),snapshot(11,365)])await f.repo.importPersonalAnalytics(value,raw(value),value.captured_at);
  assert.deepEqual(ids(f),[active,recent,latestYear,snapshot(10),snapshot(11)].map(value=>value.fingerprint).sort());
  const fence=await f.repo.marketappSessionFence(owner);
  assert.equal(await f.repo.importPersonalAnalyticsFenced(recent,raw(recent),at(10000),owner,fence,0),true);
  const audited=await f.repo.latestMarketappRefreshAttempt(owner,wallet,365);
  assert.equal(audited.snapshot_captured_at,latestYear.captured_at);
});

test('a pending, unsaved or malformed newer attempt cannot retire the last confirmed provider fingerprint',async t=>{
  for(const mode of ['pending','unsaved','malformed'])await t.test(mode,async t=>{
    const f=await fixture(t),old=snapshot(1,30,-5*hour),pending=snapshot(2,30,-3*hour);
    seed(f,old);attempt(f,old,{created:now-4*hour});
    attempt(f,pending,{created:now-2*hour,fingerprintValue:mode==='unsaved'?pending.fingerprint:null,state:'updating',stage:mode==='unsaved'?'save_snapshot':'fetch_analytics',
      ...(mode==='malformed'?{outcome:'{malformed'}:{})});
    const fresh=snapshot(3,30);
    await f.repo.importPersonalAnalytics(fresh,raw(fresh),fresh.captured_at);
    assert.ok(ids(f).includes(old.fingerprint));
  });
});

test('equal-time audits retain deterministic latest confirmation and its save_snapshot crash-gap evidence',async t=>{
  const f=await fixture(t),old=snapshot(1,30,-5*hour),latest=snapshot(2,30,-4*hour),fresh=snapshot(3);
  seed(f,old);seed(f,latest);
  attempt(f,old,{id:'attempt-a',created:now-3*hour});
  attempt(f,latest,{id:'attempt-z',created:now-3*hour,state:'updating'});
  await f.repo.importPersonalAnalytics(fresh,raw(fresh),fresh.captured_at);
  assert.deepEqual(ids(f),[latest.fingerprint,fresh.fingerprint]);
  const status=await f.repo.latestMarketappRefreshAttempt(owner,wallet,30);
  assert.equal(status.attempt_id,'attempt-z');assert.equal(status.snapshot_captured_at,latest.captured_at);
  assert.equal(JSON.parse(status.outcome_json).stage,'save_snapshot');
});

test('an exact incoming save_snapshot audit can atomically supersede expired confirmation evidence',async t=>{
  const f=await fixture(t),old=snapshot(1,30,-5*hour),fresh=snapshot(2,30);
  seed(f,old);attempt(f,old,{created:now-4*hour});
  attempt(f,fresh,{created:now,state:'updating'});
  const fence=await f.repo.marketappSessionFence(owner);
  assert.equal(await f.repo.importPersonalAnalyticsFenced(fresh,raw(fresh),fresh.captured_at,owner,fence,0),true);
  assert.deepEqual(ids(f),[fresh.fingerprint]);
  const unfinished=await f.repo.latestMarketappRefreshAttempt(owner,wallet,30);
  assert.equal(unfinished.snapshot_captured_at,fresh.captured_at);
  assert.equal(JSON.parse(unfinished.outcome_json).stage,'save_snapshot');
  assert.equal(await f.repo.importPersonalAnalyticsFenced(fresh,raw(fresh),fresh.captured_at,owner,fence,0),true);
});

test('malformed legacy JSON and inconsistent identity/period metadata are retained conservatively',async t=>{
  const f=await fixture(t),invalid=['{malformed','{}',JSON.stringify({...snapshot(1),daily:[]}),JSON.stringify({...snapshot(2),wallet:'wrong-wallet'}),
    JSON.stringify({...snapshot(3),fingerprint:'wrong-fingerprint'}),JSON.stringify({...snapshot(4),captured_at:'not-a-time'}),
    JSON.stringify({...snapshot(5),daily:Array(30).fill(null)}),JSON.stringify({...snapshot(6),source:'unknown-layout'})];
  invalid.forEach((normalized,index)=>seed(f,snapshot(index+100),{normalized}));
  const before=rows(f);
  for(let index=1;index<=15;index++){const value=snapshot(index);await f.repo.importPersonalAnalytics(value,raw(value),value.captured_at);}
  for(const saved of before)assert.deepEqual(rows(f).find(row=>row.row_id===saved.row_id),saved);
  assert.equal(rows(f).length,before.length+1);
});

test('near-cap replacement credits exact UTF-8 retained bytes in both account quota and atomic admission',async t=>{
  const f=await fixture(t);
  f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(now);
  f.database.prepare('INSERT INTO service_storage_monitor VALUES(1,?,NULL,0)').run(JSON.stringify({version:1,paused:false}));
  for(const trigger of storageAccountingTriggers())f.database.exec(trigger.sql);
  const old=snapshot(1),fresh=snapshot(2),oldRaw=raw(old),freshRaw=raw(fresh)+'🦋';seed(f,old,{body:oldRaw});
  const used=f.database.prepare('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=?').get('public:101').total_bytes,
    maxBytes=used+32,admission=createStorageAdmission(f.db).forScope('public:101',{maxBytes}),
    repo=f.repository(owner,{maxAccountBytes:maxBytes,maxServiceBytes:1048576,storageAdmission:admission});
  await assert.rejects(admission.assertAdmitted(used),StorageCapacityError);
  assert.equal(await repo.importPersonalAnalytics(fresh,freshRaw,fresh.captured_at),true);
  assert.deepEqual(ids(f),[fresh.fingerprint]);
  const measured=f.database.prepare(`SELECT SUM(${storageTableByteExpression(STORAGE_TABLES.find(table=>table.name==='public_personal_rental_analytics'))}) AS bytes
    FROM public_personal_rental_analytics WHERE user_id=?`).get(owner).bytes;
  assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=?').get('public:101').total_bytes,measured);
  assert.equal(measured,used+4);
});

test('protected evidence near the cap refuses a new capture without deleting the existing report',async t=>{
  const f=await fixture(t),old=snapshot(1),fresh=snapshot(2);seed(f,old);attempt(f,old,{created:now});
  const payload=f.database.prepare('SELECT length(CAST(raw_snapshot AS BLOB))+length(CAST(normalized_json AS BLOB)) AS bytes FROM public_personal_rental_analytics').get().bytes,
    repo=f.repository(owner,{maxAccountBytes:payload+10,maxServiceBytes:1048576}),before=rows(f);
  await assert.rejects(repo.importPersonalAnalytics(fresh,raw(fresh),fresh.captured_at),PublicStorageLimitError);
  assert.deepEqual(rows(f),before);
});

test('logout, cookie rotation, wallet rebind and account generation races cannot replace an older capture',async t=>{
  for(const mode of ['logout','cookie','wallet','generation'])await t.test(mode,async t=>{
    const f=await fixture(t),old=snapshot(1),fresh=snapshot(2);seed(f,old);
    const fence=await f.repo.marketappSessionFence(owner);let injected=false;
    const db={...f.db,async run(sql,args){if(!injected&&sql.includes('UPDATE OR IGNORE public_personal_rental_analytics')) {
      injected=true;
      if(mode==='logout')f.database.prepare('UPDATE public_marketapp_analytics_sessions SET generation=generation+1 WHERE owner_id=?').run(owner);
      if(mode==='cookie')f.database.prepare('UPDATE public_marketapp_analytics_sessions SET cookie_version=cookie_version+1 WHERE owner_id=?').run(owner);
      if(mode==='wallet')await f.repo.append(0,{key:'rebind',state:{version:2,job:null},records:[{kind:'settings',record:{wallet:'new-wallet'}}],observed_at:at(0)});
      if(mode==='generation')f.database.prepare("UPDATE public_accounts SET generation=generation+1,status='deleted' WHERE user_id=?").run(owner);
    }return f.db.run(sql,args);}};
    const worker=createPublicRepository(db,owner),before=rows(f);
    if(mode==='generation')await assert.rejects(worker.importPersonalAnalyticsFenced(fresh,raw(fresh),fresh.captured_at,owner,fence,0),PublicAccountError);
    else assert.equal(await worker.importPersonalAnalyticsFenced(fresh,raw(fresh),fresh.captured_at,owner,fence,0),false);
    assert.equal(injected,true);assert.deepEqual(rows(f),before);
  });
});

test('newly referenced evidence is protected inside the replacement SQL after planning',async t=>{
  const f=await fixture(t),old=snapshot(1),fresh=snapshot(2);seed(f,old);let injected=false;
  const db={...f.db,async run(sql,args){if(!injected&&sql.includes('UPDATE OR IGNORE public_personal_rental_analytics')){
    injected=true;attempt(f,old,{created:now,expires:now+300000,state:'updating'});
  }return f.db.run(sql,args);}},worker=createPublicRepository(db,owner);
  assert.equal(await worker.importPersonalAnalytics(fresh,raw(fresh),fresh.captured_at),true);
  assert.deepEqual(ids(f),[old.fingerprint,fresh.fingerprint]);
});

test('concurrent duplicate insertion remains idempotent and never prunes newer evidence before confirmation',async t=>{
  const f=await fixture(t),old=snapshot(1),fresh=snapshot(2);seed(f,old);let injected=false;
  const db={...f.db,async run(sql,args){if(!injected&&sql.includes('UPDATE OR IGNORE public_personal_rental_analytics')){
    injected=true;seed(f,fresh);
  }return f.db.run(sql,args);}},worker=createPublicRepository(db,owner);
  assert.equal(await worker.importPersonalAnalytics(fresh,raw(fresh),fresh.captured_at),false);
  assert.deepEqual(ids(f),[fresh.fingerprint]);
});

test('older capture racing a newer replacement cannot overwrite or prune the newer report',async t=>{
  const f=await fixture(t),old=snapshot(1),incoming=snapshot(2),newer=snapshot(3);seed(f,old);let injected=false;
  const db={...f.db,async run(sql,args){if(!injected&&sql.includes('UPDATE OR IGNORE public_personal_rental_analytics')){
    injected=true;await f.repo.importPersonalAnalytics(newer,raw(newer),newer.captured_at);
  }return f.db.run(sql,args);}},worker=createPublicRepository(db,owner);
  assert.equal(await worker.importPersonalAnalytics(incoming,raw(incoming),incoming.captured_at),true);
  assert.equal((await worker.latestPersonalAnalytics(wallet)).fingerprint,newer.fingerprint);
  assert.ok(ids(f).includes(newer.fingerprint));
});

test('logout, cookie, wallet or generation changes between saving and pruning prevent stale-worker cleanup',async t=>{
  for(const mode of ['logout','cookie','wallet','generation'])await t.test(mode,async t=>{
    const f=await fixture(t),old=snapshot(1),older=snapshot(2,30,500),fresh=snapshot(3);seed(f,old);seed(f,older);
    const fence=await f.repo.marketappSessionFence(owner);let injected=false;
    const db={...f.db,async run(sql,args){if(!injected&&sql.startsWith('DELETE FROM public_personal_rental_analytics')){
      injected=true;
      if(mode==='logout')f.database.prepare('UPDATE public_marketapp_analytics_sessions SET generation=generation+1 WHERE owner_id=?').run(owner);
      if(mode==='cookie')f.database.prepare('UPDATE public_marketapp_analytics_sessions SET cookie_version=cookie_version+1 WHERE owner_id=?').run(owner);
      if(mode==='wallet')await f.repo.append(0,{key:'prune-rebind',state:{version:2,job:null},records:[{kind:'settings',record:{wallet:'new-wallet'}}],observed_at:at(0)});
      if(mode==='generation')f.database.prepare("UPDATE public_accounts SET generation=generation+1,status='deleted' WHERE user_id=?").run(owner);
    }return f.db.run(sql,args);}},worker=createPublicRepository(db,owner);
    assert.equal(await worker.importPersonalAnalyticsFenced(fresh,raw(fresh),fresh.captured_at,owner,fence,0),true);
    assert.equal(injected,true);assert.equal(rows(f).length,2);assert.ok(ids(f).includes(fresh.fingerprint));
  });
});

test('failed atomic replacement leaves the old capture intact and never runs pruning',async t=>{
  const f=await fixture(t),old=snapshot(1),fresh=snapshot(2);seed(f,old);const before=rows(f);let deletes=0;
  const db={...f.db,async run(sql,args){if(sql.includes('UPDATE OR IGNORE public_personal_rental_analytics'))throw new Error('synthetic storage failure');
    if(sql.startsWith('DELETE FROM public_personal_rental_analytics'))deletes++;return f.db.run(sql,args);}},worker=createPublicRepository(db,owner);
  await assert.rejects(worker.importPersonalAnalytics(fresh,raw(fresh),fresh.captured_at),/synthetic storage failure/);
  assert.deepEqual(rows(f),before);assert.equal(deletes,0);
});

test('retention cleanup is bounded and cannot turn a committed capture into a failure',async t=>{
  const f=await fixture(t);
  for(let index=1;index<=60;index++)seed(f,snapshot(index));
  const value=snapshot(100),before=rows(f).length;
  assert.equal(await f.repo.importPersonalAnalytics(value,raw(value),value.captured_at),true);
  assert.equal(rows(f).length,before-25);
  let attempted=false;
  const db={...f.db,async run(sql,args){if(sql.startsWith('DELETE FROM public_personal_rental_analytics')){attempted=true;throw new Error('uncertain cleanup');}return f.db.run(sql,args);}},worker=createPublicRepository(db,owner),newer=snapshot(101);
  assert.equal(await worker.importPersonalAnalytics(newer,raw(newer),newer.captured_at),true);
  assert.equal(attempted,true);assert.equal((await worker.latestPersonalAnalytics(wallet)).fingerprint,newer.fingerprint);
});
