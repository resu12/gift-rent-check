import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {PublicStorageLimitError} from '../tgcloud/lib/public-repository.js';
import {personalAnalyticsDailyTriggers,personalAnalyticsDailyReserve,personalAnalyticsSnapshotPreservedSQL,
  buildPersonalAnalyticsItemsAllTime,buildPersonalAnalyticsCollectionsAllTime} from '../tgcloud/lib/personal-analytics.js';
import {installPersonalAnalyticsDailyStorage,backfillPersonalAnalyticsDailyStorage} from '../tools/analytics-daily-storage.mjs';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

const wallet='0:'+ '11'.repeat(32),otherWallet='0:'+ '22'.repeat(32);
function snapshot({top='available',collections='available',captured='2024-01-03T12:00:00.000Z'}={}) {
  const value={version:1,source:'marketapp_personal_rent_page',source_url:null,wallet,captured_at:captured,
    period_start:'2024-01-01',period_end:'2024-01-02',currency:'GRAM',timezone:'UTC',volume_basis:'gross_before_fees',
    summary:{rent_volume:'0',rentals:0},daily:['2024-01-01','2024-01-02'].map(date=>({date,rent_volume:'0',new_rentals:0,extensions:0,rentals:0})),
    top_items:{status:top,scope:'marketapp_top_items',items:[]},by_collection:{status:collections,scope:'marketapp_by_collection',items:[]}};
  return {...value,fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
const save=(repo,value)=>repo.importPersonalAnalytics(value,'source',value.captured_at);
function install(f,{legacy=false}={}) {
  const triggers=[false,true].flatMap(publicScope=>personalAnalyticsDailyTriggers({publicScope}));
  const selected=legacy?triggers.filter(trigger=>/^personal_analytics_(daily|items|collections)_v1_/.test(trigger.name)):triggers;
  if(legacy)assert.equal(selected.length,24);
  for(const trigger of selected)f.database.exec(trigger.sql);
}
function accountStorage(f) {
  f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());
  for(const trigger of storageAccountingTriggers())f.database.exec(trigger.sql);
}
const measure=(f,tables,where='')=>tables.reduce((total,table)=>total+f.database.prepare(
  `SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) bytes FROM ${table.name} ${where}`).get().bytes,0);
const assertStatus=(report,top,collections)=>{
  assert.ok(report);
  assert.equal(report.top_items.status,top);assert.deepEqual(report.top_items.items,[]);
  assert.equal(report.by_collection.status,collections);assert.deepEqual(report.by_collection.items,[]);
  assert.equal(report.top_items.incomplete,true);assert.equal(report.by_collection.incomplete,true);
};

test('explicit empty reports remain available after snapshot cleanup without leaking across private/public accounts',async t=>{
  const f=createPublicDatabase(t);install(f);
  const privateRepo=createCloudRepository(f.db),a=f.repository(101),b=f.repository(202),unknown=f.repository(303);
  await a.ensureAccount();await b.ensureAccount();await unknown.ensureAccount();
  await save(privateRepo,snapshot());
  await save(a,snapshot({collections:'missing'}));await save(b,snapshot({top:'missing'}));
  await save(unknown,snapshot({top:'missing',collections:'missing'}));
  f.database.exec('DELETE FROM personal_rental_analytics');f.database.exec('DELETE FROM public_personal_rental_analytics');
  assertStatus(await privateRepo.personalAnalyticsAllTime(wallet),'available','available');
  assertStatus(await a.personalAnalyticsAllTime(wallet),'available','missing');
  assertStatus(await b.personalAnalyticsAllTime(wallet),'missing','available');
  assertStatus(await unknown.personalAnalyticsAllTime(wallet),'missing','missing');
  assert.equal(await a.personalAnalyticsAllTime(otherWallet),null);
  let deletion=await a.deleteAccountData(20);while(deletion.pending_cleanup)deletion=await a.processAccountDeletion(20);
  assert.equal(f.database.prepare("SELECT count(*) n FROM public_personal_analytics_item_reports WHERE user_id='101'").get().n,0);
  assertStatus(await b.personalAnalyticsAllTime(wallet),'missing','available');
  assertStatus(await privateRepo.personalAnalyticsAllTime(wallet),'available','available');
});

test('available empty tables need durable evidence before cleanup is allowed',async t=>{
  const f=createPublicDatabase(t);install(f);const repo=createCloudRepository(f.db);await save(repo,snapshot());
  const preserved=()=>f.database.prepare(`SELECT ${personalAnalyticsSnapshotPreservedSQL('s')} valid FROM personal_rental_analytics s`).get().valid;
  assert.equal(preserved(),1);
  const item=f.database.prepare('SELECT * FROM personal_analytics_item_reports').get();assert.ok(item);
  f.database.exec('DELETE FROM personal_analytics_item_reports');assert.equal(preserved(),0);
  f.database.prepare('INSERT INTO personal_analytics_item_reports VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(item));
  assert.equal(preserved(),1);
  f.database.exec('DELETE FROM personal_analytics_collection_reports');assert.equal(preserved(),0);
});

test('empty report archives are reserved and charged before writes for private and public storage',async t=>{
  const f=createPublicDatabase(t);install(f);accountStorage(f);
  const value=snapshot(),reserve=personalAnalyticsDailyReserve(value,'101');
  const tiny=f.repository(101,{maxAccountBytes:reserve-1,maxServiceBytes:1048576});await tiny.ensureAccount();
  await assert.rejects(save(tiny,value),PublicStorageLimitError);
  assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_analytics_item_reports').get().n,0);
  const repo=f.repository(101);await repo.ensureAccount();await save(repo,value);
  const archived=STORAGE_TABLES.filter(table=>/^public_personal_analytics_(daily|item_reports|collection_reports)$/.test(table.name));
  const bytes=measure(f,archived,"WHERE user_id='101'");
  assert.equal(reserve,bytes,'admission reserves all daily observations and both empty-table markers');
  assert.equal(f.database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:101'").get().total_bytes,
    measure(f,STORAGE_TABLES.filter(table=>table.tenant==='user_id'),"WHERE user_id='101'"));
  await save(createCloudRepository(f.db),value);
  assert.equal(personalAnalyticsDailyReserve(value),measure(f,STORAGE_TABLES.filter(table=>/^personal_analytics_(daily|item_reports|collection_reports)$/.test(table.name))));
  assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measure(f,STORAGE_TABLES));
});

test('legacy 24-trigger installation can be upgraded and backfilled without losing empty table availability',async t=>{
  const f=createPublicDatabase(t);accountStorage(f);install(f,{legacy:true});
  const privateRepo=createCloudRepository(f.db),publicRepo=f.repository(101);await publicRepo.ensureAccount();
  const value=snapshot();await save(privateRepo,value);await save(publicRepo,value);
  assertStatus(await privateRepo.personalAnalyticsAllTime(wallet),'missing','missing');
  const before=f.database.prepare('SELECT * FROM personal_rental_analytics').get();
  const preserved=()=>f.database.prepare(`SELECT ${personalAnalyticsSnapshotPreservedSQL('s')} valid FROM personal_rental_analytics s`).get().valid;
  assert.equal(preserved(),0);
  assert.equal((await installPersonalAnalyticsDailyStorage(f.db)).trigger_count,40);
  await backfillPersonalAnalyticsDailyStorage(f.db,{limit:5});await backfillPersonalAnalyticsDailyStorage(f.db,{publicScope:true,limit:5});
  assert.deepEqual(f.database.prepare('SELECT * FROM personal_rental_analytics').get(),before);
  assert.equal(preserved(),1);
  assertStatus(await privateRepo.personalAnalyticsAllTime(wallet),'available','available');
  assertStatus(await publicRepo.personalAnalyticsAllTime(wallet),'available','available');
  const total=f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes;
  await installPersonalAnalyticsDailyStorage(f.db);await backfillPersonalAnalyticsDailyStorage(f.db,{limit:5});
  await backfillPersonalAnalyticsDailyStorage(f.db,{publicScope:true,limit:5});
  assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,total);
  f.database.exec('DELETE FROM personal_rental_analytics');f.database.exec('DELETE FROM public_personal_rental_analytics');
  assertStatus(await privateRepo.personalAnalyticsAllTime(wallet),'available','available');
  assertStatus(await publicRepo.personalAnalyticsAllTime(wallet),'available','available');
});

test('empty markers require valid capture, identity, period and payload when all-time reports are built',async t=>{
  const f=createPublicDatabase(t);install(f);await save(createCloudRepository(f.db),snapshot());
  const now=Date.parse('2024-02-01T00:00:00.000Z'),range={period_start:'2024-01-01',period_end:'2024-01-02'};
  for(const [table,key,build] of [['personal_analytics_item_reports','item_key',buildPersonalAnalyticsItemsAllTime],
    ['personal_analytics_collection_reports','collection_key',buildPersonalAnalyticsCollectionsAllTime]]) {
    const row=f.database.prepare(`SELECT * FROM ${table}`).get();assert.ok(row);
    assert.equal(build([row],wallet,now,range).status,'available');
    for(const change of [{wallet:otherWallet},{fingerprint:'invalid'},{captured_at:'2024-03-01T00:00:00.000Z'},
      {captured_at:'invalid'},{period_start:'2023-12-31'},{period_end:'2024-01-03'},{period_end:'2023-12-31'},
      {[key]:'not-a-table-marker'},{item_json:'{}'},{item_json:'{"status":"missing","items":[]}'},
      {item_json:'{"status":"available","items":[{}]}'},{item_json:'{'}]) {
      assert.equal(build([{...row,...change}],wallet,now,range).status,'missing',JSON.stringify(change));
    }
  }
});

test('malformed available-empty table envelopes never establish table availability',async t=>{
  for(const field of ['top_items','by_collection'])for(const change of [{scope:'unrecognized'},{items:null},{status:'missing'}])await t.test(`${field} ${JSON.stringify(change)}`,async t=>{
    const f=createPublicDatabase(t);install(f);const repo=createCloudRepository(f.db),value=snapshot();
    value[field]={...value[field],...change};await save(repo,value);
    assert.equal((await repo.personalAnalyticsAllTime(wallet))[field].status,'missing');
  });
});

test('failed empty-table archival rolls the complete snapshot write back',async t=>{
  const f=createPublicDatabase(t);install(f);
  f.database.exec("CREATE TRIGGER fail_empty_archive BEFORE INSERT ON personal_analytics_item_reports BEGIN SELECT RAISE(ABORT,'empty archive unavailable'); END");
  await assert.rejects(save(createCloudRepository(f.db),snapshot()),/empty archive unavailable/);
  for(const table of ['personal_rental_analytics','personal_analytics_daily','personal_analytics_item_reports','personal_analytics_collection_reports'])
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
