import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizePersonalAnalytics,buildPersonalAnalyticsItemsAllTime,personalAnalyticsDailyTriggers,personalAnalyticsDailyReserve,personalAnalyticsSnapshotPreservedSQL,upgradePersonalAnalyticsTopItems} from '../tgcloud/lib/personal-analytics.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {PublicAccountError,PublicStorageLimitError} from '../tgcloud/lib/public-repository.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';
import {installPersonalAnalyticsDailyStorage,backfillPersonalAnalyticsDailyStorage} from '../tools/analytics-daily-storage.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';
const wallet=`0:${'11'.repeat(32)}`,friendly='EQAREREREREREREREREREREREREREREREREREREREREREeYT';
const name='Heart Locket #1767',url=`https://marketapp.org/nft/${friendly}/`;
const rawItem={name,item_url:url,rentals:'5',rented_days:'53',volume:'19.15',price_per_day:'0.36'};
const item={...rawItem,item_key:wallet,rentals:5};
const day=n=>new Date(Date.UTC(2024,0,1+n)).toISOString().slice(0,10),at=n=>day(n)+'T12:00:00.000Z';
function raw(){return {version:1,source:'marketapp_personal_rent_page',wallet,source_url:`https://marketapp.org/user/${friendly}/?tab=analytics_rent`,captured_at:at(3),
  summary:[{label:'Rent volume',value:'19.15'},{label:'Rentals',value:'5'}],charts:[
    {key:'profile.rent.income',spec_raw:JSON.stringify({gran:'day',unit:'GRAM',x:[day(0)],series:[{name:'Rent volume',data:[19.15]}]})},
    {key:'profile.rent.rentals',spec_raw:JSON.stringify({gran:'day',unit:'',x:[day(0)],series:[{name:'New rentals',data:[5]},{name:'Extensions',data:[0]}]})}
  ],top_items:{status:'available',items:[rawItem]}};}
const normalize=value=>normalizePersonalAnalytics(JSON.stringify(value),wallet);
function report(start,end,captured,extra={}){const value={version:1,source:'marketapp_personal_rent_page',source_url:null,wallet,captured_at:at(captured),
 period_start:day(start),period_end:day(end),timezone:'UTC',currency:'GRAM',volume_basis:'gross_before_fees',summary:{rent_volume:'19.15',rentals:5},
 daily:Array.from({length:end-start+1},(_,i)=>({date:day(start+i),rent_volume:'0',new_rentals:0,extensions:0,rentals:0})),
 by_collection:{status:'missing',scope:'marketapp_by_collection',items:[]},top_items:{status:'available',scope:'marketapp_top_items',items:[{...item,...extra}]}};
 return {...value,fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex')};}
function archive(value){return value.top_items.items.map(row=>({wallet:value.wallet,item_key:row.item_key,period_start:value.period_start,period_end:value.period_end,
 captured_at:value.captured_at,fingerprint:value.fingerprint,item_json:JSON.stringify(row)}));}
const save=(repo,value)=>repo.importPersonalAnalytics(value,'source',value.captured_at);
const install=(f,publicScope=false)=>personalAnalyticsDailyTriggers({publicScope}).forEach(trigger=>f.database.exec(trigger.sql));

test('Top items normalize exact provider figures and canonical identity without public-history attribution',()=>{
 const result=normalize(raw());assert.deepEqual(result.top_items,{status:'available',scope:'marketapp_top_items',items:[item]});
 const legacy=raw();delete legacy.top_items;legacy.tables=[{headers:['Item','Rentals','Rented days','Volume','Price per day'],rows:[{cells:[name,'5','53','19.15','0.36'],links:[{label:name,url:`/nft/${friendly}/`}]}]}];
 assert.deepEqual(normalize(legacy),result);
 legacy.top_items={status:'available',items:[rawItem]};assert.deepEqual(normalize(legacy),result);
 legacy.top_items.items=[{...rawItem,volume:'20'}];assert.throws(()=>normalize(legacy),/invalid/);
 const unknown=raw();delete unknown.top_items;assert.equal(normalize(unknown).top_items.status,'missing');
 unknown.top_items={status:'available',items:[]};assert.equal(normalize(unknown).top_items.status,'available');
 const precise=raw();precise.top_items.items=[{...rawItem,volume:'9007199254740993.0001',price_per_day:null}];assert.equal(normalize(precise).top_items.items[0].volume,'9007199254740993.0001');
});

test('malformed or ambiguous Top items fail closed',()=>{
 for(const change of [x=>x.top_items.items.push(rawItem),x=>x.top_items.items[0]={...rawItem,item_url:'https://evil.example/nft/'+friendly+'/'},
 x=>x.top_items.items[0]={...rawItem,rentals:'1.5'},x=>x.top_items.items[0]={...rawItem,volume:'-1'},x=>x.top_items.items[0]={...rawItem,rented_days:'0.00001'},
 x=>x.top_items.status='missing',x=>x.top_items.items[0]={...rawItem,item_url:url+'?x=1'},x=>x.top_items.items[0]={...rawItem,item_url:url.replace(/eYT/,'eYU')}]){
  const value=raw();change(value);assert.throws(()=>normalize(value),/invalid/);
 }
});

test('all-time maximizes disjoint covered dates and never adds overlapping rolling windows',()=>{
 const first=report(0,9,10,{volume:'10',rented_days:'10',rentals:2,price_per_day:'1'}),overlap=report(5,14,15,{volume:'200',rented_days:'20',rentals:8}),
 next=report(10,19,20,{volume:'5',rented_days:'10',rentals:1,price_per_day:'0.5'});
 const rows=[...archive(first),...archive(overlap),...archive(next)],result=buildPersonalAnalyticsItemsAllTime(rows,wallet);
 assert.equal(result.items[0].volume,'15');assert.equal(result.items[0].rentals,3);assert.equal(result.items[0].rented_days,'20');assert.equal(result.items[0].price_per_day,'0.75');
 assert.equal(result.items[0].coverage.observed_days,20);assert.equal(result.items[0].coverage.missing_days,0);assert.equal(result.items[0].coverage.periods.length,2);
 assert.deepEqual(buildPersonalAnalyticsItemsAllTime([...rows].reverse(),wallet),result);
 assert.equal(result.incomplete,true);assert.equal(result.scope,'saved_non_overlapping_reports');
});

test('latest correction wins, partial boundaries and gaps remain explicit, currency totals exact',()=>{
 const first=report(0,1,1,{volume:'9007199254740993.0001'}),correction=report(0,1,3,{volume:'0.0001'}),next=report(3,4,4,{volume:'9007199254740993.0001'});
 const result=buildPersonalAnalyticsItemsAllTime([...archive(first),...archive(correction),...archive(next)],wallet).items[0];
 assert.equal(result.volume,'9007199254740993.0002');assert.equal(result.coverage.partial_days,1);assert.equal(result.coverage.missing_days,1);
 assert.equal(buildPersonalAnalyticsItemsAllTime(archive(first),wallet).items[0].price_per_day,'0.36','single report retains displayed provider rate');
 assert.equal(buildPersonalAnalyticsItemsAllTime(archive({...first,captured_at:'2999-01-01T00:00:00.000Z'}),wallet).status,'missing');
 assert.equal(buildPersonalAnalyticsItemsAllTime(archive(first),`0:${'22'.repeat(32)}`).status,'missing');
});

test('archive preserves Top items through snapshot deletion and later top-table absence',async t=>{
 const f=createPublicDatabase(t);install(f);const repo=createCloudRepository(f.db),first=report(0,9,10);await save(repo,first);
 assert.equal(f.database.prepare('SELECT count(*) n FROM personal_analytics_item_reports').get().n,1);
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).top_items.items[0].volume,'19.15');
 const absent=report(0,9,11);absent.top_items.items=[];await save(repo,absent);
 f.database.exec('DELETE FROM personal_rental_analytics');
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).top_items.items[0].rentals,5);
});

test('archive writes roll back with the snapshot and retention requires all named gift observations',async t=>{
 const f=createPublicDatabase(t);install(f);const repo=createCloudRepository(f.db),first=report(0,9,10);await save(repo,first);
 const query=()=>f.database.prepare(`SELECT ${personalAnalyticsSnapshotPreservedSQL('s')} valid FROM personal_rental_analytics s`).get().valid;
 assert.equal(query(),1);f.database.exec('DELETE FROM personal_analytics_item_reports');assert.equal(query(),0);
 f.database.exec("CREATE TRIGGER fail_items BEFORE INSERT ON personal_analytics_item_reports BEGIN SELECT RAISE(ABORT,'archive failed'); END");
 await assert.rejects(save(repo,report(1,10,11)),/archive failed/);assert.equal(f.database.prepare('SELECT count(*) n FROM personal_rental_analytics').get().n,1);
});

test('private/public item storage is fully accounted, reserved before writes and isolated through deletion',async t=>{
 const f=createPublicDatabase(t);install(f,true);f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());storageAccountingTriggers().forEach(trigger=>f.database.exec(trigger.sql));
 const value=report(0,9,10),reserve=personalAnalyticsDailyReserve(value,'101');
 const tiny=f.repository(101,{maxAccountBytes:reserve-1,maxServiceBytes:1048576});await tiny.ensureAccount();await assert.rejects(save(tiny,value),PublicStorageLimitError);
 const a=f.repository(101),b=f.repository(202);await a.ensureAccount();await b.ensureAccount();await save(a,value);await save(b,report(0,9,10,{volume:'77'}));
 assert.equal((await a.personalAnalyticsAllTime(wallet)).top_items.items[0].volume,'19.15');assert.equal((await b.personalAnalyticsAllTime(wallet)).top_items.items[0].volume,'77');
 const measured=STORAGE_TABLES.filter(table=>table.tenant==='user_id').reduce((sum,table)=>sum+f.database.prepare(`SELECT COALESCE(sum(${storageTableByteExpression(table)}),0) n FROM ${table.name} WHERE user_id='101'`).get().n,0);
 assert.equal(f.database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:101'").get().total_bytes,measured);
 const stale=f.repository(101);await stale.ensureAccount();let progress=await a.deleteAccountData(20);while(progress.pending_cleanup)progress=await a.processAccountDeletion(20);
 assert.equal(f.database.prepare("SELECT count(*) n FROM public_personal_analytics_item_reports WHERE user_id='101'").get().n,0);
 assert.equal((await b.personalAnalyticsAllTime(wallet)).top_items.items[0].volume,'77');await a.reactivateAccount();await assert.rejects(save(stale,value),PublicAccountError);
});


test('legacy raw tables are validated, upgraded without a new refresh date and backfilled into durable item history',async t=>{
 const f=createPublicDatabase(t),repo=createCloudRepository(f.db),source=raw(),normalized=normalize(source),legacy={...normalized};delete legacy.top_items;
 const stored={normalized_json:JSON.stringify(legacy),raw_snapshot:JSON.stringify(source)};
 const upgraded=upgradePersonalAnalyticsTopItems(stored);assert.deepEqual(upgraded.top_items,normalized.top_items);assert.equal(upgraded.fingerprint,legacy.fingerprint);assert.equal(upgraded.captured_at,legacy.captured_at);
 const mismatch={...source,wallet:`0:${'22'.repeat(32)}`};assert.equal(upgradePersonalAnalyticsTopItems({...stored,raw_snapshot:JSON.stringify(mismatch)}).top_items,undefined);
 const wrongPeriod=structuredClone(source);wrongPeriod.captured_at=at(4);assert.equal(upgradePersonalAnalyticsTopItems({...stored,raw_snapshot:JSON.stringify(wrongPeriod)}).top_items,undefined);
 await repo.importPersonalAnalytics(legacy,stored.raw_snapshot,legacy.captured_at);
 assert.equal((await repo.latestPersonalAnalytics(wallet)).top_items.items[0].volume,'19.15');
 f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());storageAccountingTriggers().forEach(trigger=>f.database.exec(trigger.sql));
 await installPersonalAnalyticsDailyStorage(f.db);await backfillPersonalAnalyticsDailyStorage(f.db);
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).top_items.items[0].volume,'19.15');
 assert.equal(f.database.prepare('SELECT captured_at FROM personal_rental_analytics').get().captured_at,legacy.captured_at);
 f.database.exec('DELETE FROM personal_rental_analytics');assert.equal((await repo.personalAnalyticsAllTime(wallet)).top_items.items[0].rentals,5);
});

test('corrupt per-item rows cannot poison archived values or cross report boundaries',async t=>{
 const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);await save(repo,report(0,9,10));
 const before=(await repo.personalAnalyticsAllTime(wallet)).top_items;
 for(const change of [x=>x.top_items.items[0].volume='bad',x=>x.top_items.items[0].rentals=-1,x=>x.top_items.items.push({...item}),
   x=>x.period_end=day(366),x=>x.top_items.items[0].item_url='https://evil.example/']){
  const value=report(0,9,11);change(value);await save(repo,value);assert.deepEqual((await repo.personalAnalyticsAllTime(wallet)).top_items,before);
 }
});


test('concurrent refresh cannot prune legacy Top items before the bounded backfill archives them',async t=>{
 const f=createPublicDatabase(t),repo=f.repository(101);await repo.ensureAccount();
 const source=raw(),legacy=normalize(source);delete legacy.top_items;
 await repo.importPersonalAnalytics(legacy,JSON.stringify(source),legacy.captured_at);
 f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());storageAccountingTriggers().forEach(trigger=>f.database.exec(trigger.sql));
 await installPersonalAnalyticsDailyStorage(f.db);
 const refreshed=raw();refreshed.captured_at=at(5);refreshed.top_items.items=[];
 const fresh=normalize(refreshed);await repo.importPersonalAnalytics(fresh,JSON.stringify(refreshed),fresh.captured_at);
 assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,2);
 await backfillPersonalAnalyticsDailyStorage(f.db,{publicScope:true,limit:5});
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).top_items.items[0].volume,'19.15');
 refreshed.captured_at=at(6);const newer=normalize(refreshed);await repo.importPersonalAnalytics(newer,JSON.stringify(refreshed),newer.captured_at);
 assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,1);
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).top_items.items[0].rentals,5);
});
