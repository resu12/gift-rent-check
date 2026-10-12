import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createPublicRepository} from '../tgcloud/lib/public-repository.js';
import {createStorageAdmission,StorageCapacityError,withStorageReservation} from '../tgcloud/lib/storage-admission.js';
import {createStorageMaintenance} from '../tgcloud/lib/storage-maintenance.js';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';

const MiB=1048576,user='101',other='202';
async function fixture(t,{beforeWrite=null}={}) {
  const f=createPublicDatabase(t),at=Date.now();
  f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(at);
  f.database.prepare('INSERT INTO service_storage_monitor VALUES(1,?,NULL,0)').run(JSON.stringify({version:1,accounts:{[user]:{generation:0,checked_at:at,cleanup:{state:'idle'}}}}));
  for(const trigger of storageAccountingTriggers())f.database.exec(trigger.sql);
  const db={...f.db,run:async(sql,p={})=>{beforeWrite?.(f.database,sql,p);return await f.db.run(sql,p);}};
  const admission=createStorageAdmission(db).forScope(`public:${user}`),repo=createPublicRepository(db,user,{dashboardCache:true,storageAdmission:admission});
  await repo.ensureAccount();await f.repository(other).ensureAccount();
  const event={key:'saved-evidence',state:{version:2,job:null,attempts:[123]},records:[
    {kind:'portfolio',record:{nft_address:'saved-gift',is_portfolio:true}},
    {kind:'history',record:{price_per_day:'170000000'}}],observed_at:new Date(at).toISOString()};
  assert.equal(await repo.append(0,event),true);
  f.database.prepare('INSERT INTO public_dashboard_projection_cache VALUES(?,?,?,?,?,?)').run('other-cache',other,'other',1,1,'keep');
  const before=f.database.prepare('SELECT * FROM public_cloud_events').all();
  const maintenance=createStorageMaintenance({db,ownerTelegramId:'123450001'});
  return {...f,db,repo,maintenance,before};
}
function legacyCache(f,count=20,size=262144) {
  const insert=f.database.prepare('INSERT INTO public_dashboard_projection_cache VALUES(?,?,?,?,?,?)');
  for(let i=0;i<count;i++)insert.run(`legacy-${i}`,user,`p:legacy:${i}`,1,1,'x'.repeat(size));
}
const ownBytes=f=>f.database.prepare('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=?').get(`public:${user}`).total_bytes;
const status=f=>f.maintenance.status({userId:user,isOwner:false});
const preserved=f=>{
  assert.deepEqual(f.database.prepare('SELECT * FROM public_cloud_events').all(),f.before);
  assert.equal(f.database.prepare('SELECT snapshot_json FROM public_dashboard_projection_cache WHERE row_id=?').get('other-cache').snapshot_json,'keep');
};

test('new invited projections preserve comparison headroom instead of filling most of the account',async t=>{
  const f=await fixture(t);
  await f.repo.saveDashboardSnapshot('first',1,1,{value:'a'.repeat(2.5*MiB)});
  await f.repo.saveDashboardSnapshot('second',1,1,{value:'b'.repeat(2.5*MiB)});
  assert.ok(ownBytes(f)<4*MiB);
  assert.equal((await status(f)).status,'healthy');
  assert.equal((await f.repo.dashboardSnapshot('second',1,1)).value.length,2.5*MiB);
  let calls=0;await withStorageReservation(f.repo,{kind:'comparison'},async()=>{calls++;});assert.equal(calls,1);
  preserved(f);
});

test('legacy cache pressure warns and is reclaimed once before the same guarded reservation retries',async t=>{
  const f=await fixture(t);legacyCache(f);
  const before=await status(f);assert.equal(before.status,'warning');assert.equal(before.cleanup.state,'needed');
  let calls=0;await withStorageReservation(f.repo,{kind:'comparison'},async token=>{
    calls++;assert.ok(f.database.prepare('SELECT bytes FROM service_storage_reservations WHERE token=?').get(token).bytes>3.5*MiB);
  });
  assert.equal(calls,1);assert.equal((await status(f)).status,'healthy');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache WHERE user_id=?').get(user).n,0);
  assert.equal(f.queries.filter(q=>q.sql.startsWith('DELETE FROM public_dashboard_projection_cache')&&q.sql.includes('LIMIT 128')).length,1);
  preserved(f);
});

test('admission recovery remains bounded when a legacy cache has many small fragments',async t=>{
  const f=await fixture(t);legacyCache(f,130,41000);
  await withStorageReservation(f.repo,{kind:'comparison'},async()=>{});
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache WHERE user_id=?').get(user).n,2);
  preserved(f);
});

test('changing an account generation immediately before cache eviction fences deletion and provider work',async t=>{
  let armed=false,switched=false;
  const f=await fixture(t,{beforeWrite(database,sql){if(armed&&!switched&&sql.startsWith('DELETE FROM public_dashboard_projection_cache')){
    switched=true;database.prepare('UPDATE public_accounts SET generation=generation+1 WHERE user_id=?').run(user);
  }}});legacyCache(f);armed=true;
  let calls=0;await assert.rejects(withStorageReservation(f.repo,{kind:'comparison'},async()=>{calls++;}),StorageCapacityError);
  assert.equal(switched,true);assert.equal(calls,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache WHERE user_id=?').get(user).n,20);
  preserved(f);
});

test('cache eviction cannot bypass a competing reservation or free any saved evidence',async t=>{
  const f=await fixture(t);legacyCache(f);
  f.database.prepare('INSERT INTO service_storage_reservations VALUES(?,?,?,?,?)').run('competing-request-token',`public:${user}`,5*MiB,Date.now()+120000,'comparison');
  let calls=0;await assert.rejects(withStorageReservation(f.repo,{kind:'comparison'},async()=>{calls++;}),StorageCapacityError);
  assert.equal(calls,0);assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_storage_reservations').get().n,1);
  preserved(f);
});
