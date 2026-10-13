import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {installStorageAccounting,installAnalyticsStorageAccounting,storageAccountingTriggers} from '../tools/storage-accounting.mjs';
import {installPersonalAnalyticsDailyStorage,backfillPersonalAnalyticsDailyStorage} from '../tools/analytics-daily-storage.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

async function accounted(db){let after=0;for(;;){const result=await installStorageAccounting(db,{after});if(result.complete)return;after=result.after;}}
const measured=database=>STORAGE_TABLES.reduce((sum,t)=>sum+database.prepare(`SELECT COALESCE(SUM(${storageTableByteExpression(t)}),0) AS n FROM ${t.name}`).get().n,0);
const wallet='0:'+ '11'.repeat(32),fingerprint='a'.repeat(64);
const sample={version:1,source:'marketapp_personal_rent_page',wallet,captured_at:'2026-10-13T03:00:00.000Z',fingerprint,
  currency:'GRAM',timezone:'UTC',volume_basis:'gross_before_fees',period_start:'2026-10-12',period_end:'2026-10-13',
  daily:[{date:'2026-10-12',rent_volume:'1.2345',new_rentals:1,extensions:0,rentals:1},{date:'2026-10-13',rent_volume:'0.2',new_rentals:0,extensions:1,rentals:1}]};
const insert=(database,value=sample)=>database.prepare('INSERT INTO personal_rental_analytics VALUES(?,?,?,?,?,?)').run(value.fingerprint,wallet,value.captured_at,value.captured_at,'unchanged-raw',JSON.stringify(value));

test('daily setup upgrades an older baseline missing both public gift-refresh and daily accounting',async t=>{
  const {database,db}=createPublicDatabase(t);await accounted(db);
  insert(database);
  const additions=new Set(['public_gift_refresh_runs','personal_analytics_daily','public_personal_analytics_daily']);
  for(const trigger of storageAccountingTriggers().filter(row=>additions.has(row.table)))database.exec(`DROP TRIGGER ${trigger.name}`);
  const before=database.prepare('SELECT * FROM service_storage_usage').get();
  await installAnalyticsStorageAccounting(db);
  assert.deepEqual(database.prepare('SELECT * FROM service_storage_usage').get(),before);
  await installPersonalAnalyticsDailyStorage(db);
  const source=database.prepare('SELECT * FROM personal_rental_analytics').get();
  const first=await backfillPersonalAnalyticsDailyStorage(db);assert.equal(first.processed,1);assert.equal(first.after,fingerprint);
  assert.equal((await backfillPersonalAnalyticsDailyStorage(db,{after:first.after})).complete,true);
  assert.equal(database.prepare('SELECT count(*) AS n FROM personal_analytics_daily').get().n,2);
  assert.deepEqual(database.prepare('SELECT * FROM personal_rental_analytics').get(),source);
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured(database));
  const after=database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes;
  await installPersonalAnalyticsDailyStorage(db);await backfillPersonalAnalyticsDailyStorage(db);
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,after);
});

test('setup refuses unaccounted daily data rather than resetting a live budget',async t=>{
  const {database,db}=createPublicDatabase(t);await accounted(db);
  for(const trigger of storageAccountingTriggers().filter(row=>row.table==='personal_analytics_daily'))database.exec(`DROP TRIGGER ${trigger.name}`);
  database.prepare('INSERT INTO personal_analytics_daily VALUES(?,?,?,?,?,?,?,?)').run('old',wallet,'2026-10-12',sample.captured_at,fingerprint,'1',1,0);
  await assert.rejects(()=>installPersonalAnalyticsDailyStorage(db),/Unaccounted/);
});

test('backfill requires installed expected triggers and bounds its operator cursor',async t=>{
  const {db}=createPublicDatabase(t);await accounted(db);
  await assert.rejects(()=>backfillPersonalAnalyticsDailyStorage(db),/not ready/);
  for(const value of [{publicScope:'true'},{after:'a'.repeat(1025)},{limit:0},{limit:6}])await assert.rejects(()=>backfillPersonalAnalyticsDailyStorage(db,value),/cursor/);
});

test('backfill stops before daily growth when the storage budget cannot admit it',async t=>{
  const {database,db}=createPublicDatabase(t);await accounted(db);insert(database);
  await installPersonalAnalyticsDailyStorage(db);
  const source=database.prepare('SELECT * FROM personal_rental_analytics').get();
  database.exec('UPDATE service_storage_usage SET total_bytes=536870912 WHERE id=1');
  await assert.rejects(()=>backfillPersonalAnalyticsDailyStorage(db),error=>error.code==='STORAGE_CAPACITY_PAUSED');
  assert.equal(database.prepare('SELECT count(*) AS n FROM personal_analytics_daily').get().n,0);
  assert.deepEqual(database.prepare('SELECT * FROM personal_rental_analytics').get(),source);
});
