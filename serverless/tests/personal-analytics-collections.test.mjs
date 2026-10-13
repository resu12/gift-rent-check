import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizePersonalAnalytics,buildPersonalAnalyticsCollectionsAllTime,personalAnalyticsDailyTriggers,personalAnalyticsDailyReserve,personalAnalyticsSnapshotPreservedSQL,upgradePersonalAnalyticsTopItems} from '../tgcloud/lib/personal-analytics.js';
import {extractMarketappAnalyticsPage} from '../tgcloud/lib/marketapp-analytics-page.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {PublicAccountError,PublicStorageLimitError} from '../tgcloud/lib/public-repository.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';
import {installPersonalAnalyticsDailyStorage,backfillPersonalAnalyticsDailyStorage} from '../tools/analytics-daily-storage.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';
import {syntheticAnalyticsPage,syntheticCollections,syntheticCollectionsTable,syntheticWallet as wallet,syntheticTopItems} from './fixtures/marketapp-analytics-page-fixture.mjs';
const normalize=source=>normalizePersonalAnalytics(JSON.stringify(source),wallet);
const day=n=>new Date(Date.UTC(2024,0,1+n)).toISOString().slice(0,10),at=n=>day(n)+'T12:00:00.000Z';
const item={collection_key:'name:synthetic collection',name:'Synthetic Collection',rentals:4,volume:'3',price_per_day:'0.125'};
function report(start,end,captured,extra={}){const value={version:1,source:'marketapp_personal_rent_page',source_url:null,wallet,captured_at:at(captured),
 period_start:day(start),period_end:day(end),timezone:'UTC',currency:'GRAM',volume_basis:'gross_before_fees',summary:{rent_volume:'3',rentals:4},
 daily:Array.from({length:end-start+1},(_,i)=>({date:day(start+i),rent_volume:'0',new_rentals:0,extensions:0,rentals:0})),
 top_items:{status:'missing',scope:'marketapp_top_items',items:[]},by_collection:{status:'available',scope:'marketapp_by_collection',items:[{...item,...extra}]}};
 return {...value,fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex')};}
const archive=value=>value.by_collection.items.map(item=>({wallet,collection_key:item.collection_key,period_start:value.period_start,period_end:value.period_end,
 captured_at:value.captured_at,fingerprint:value.fingerprint,item_json:JSON.stringify(item)}));
const save=(repo,value)=>repo.importPersonalAnalytics(value,'source',value.captured_at);
const install=(f,publicScope=false)=>personalAnalyticsDailyTriggers({publicScope}).forEach(trigger=>f.database.exec(trigger.sql));

test('By collection reads the independent provider table with exact amounts and normalized name identity',()=>{
 const source=syntheticAnalyticsPage({collections:syntheticCollections(),topItems:syntheticTopItems()});
 const extracted=extractMarketappAnalyticsPage(source.html,source.options);assert.deepEqual(extracted.by_collection,source.snapshot.by_collection);
 const normalized=normalize(extracted);assert.deepEqual(normalized.by_collection,{status:'available',scope:'marketapp_by_collection',items:[item]});
 assert.notEqual(normalized.by_collection.items[0].rentals,normalized.top_items.items[0].rentals);
 const precise=structuredClone(extracted);precise.by_collection.items[0]={name:'  Synthetic   Collection  ',rentals:'7',volume:'9007199254740993.0001',price_per_day:'—'};
 assert.deepEqual(normalize(precise).by_collection.items[0],{...item,rentals:7,volume:'9007199254740993.0001',price_per_day:null});
 const legacy=structuredClone(extracted);delete legacy.by_collection;legacy.tables=[{headers:['Collection','Rentals','Volume','Price per day'],rows:[{cells:['Synthetic Collection','4','3.00','0.125'],links:[]}]}];
 assert.deepEqual(normalize(legacy).by_collection,normalized.by_collection);
 legacy.by_collection=extracted.by_collection;assert.deepEqual(normalize(legacy).by_collection,normalized.by_collection);
 legacy.by_collection.items[0].rentals='5';assert.throws(()=>normalize(legacy),/invalid/);
});

test('collection parser accepts optional same-origin label links but rejects ambiguous, fake and malformed tables',()=>{
 const source=syntheticAnalyticsPage({collections:syntheticCollections()}),table=syntheticCollectionsTable();
 const extract=html=>extractMarketappAnalyticsPage(html,source.options);
 const linked=source.html.replace('>Synthetic Collection</div>','><a href="/collection/synthetic/">Synthetic Collection</a></div>');
 assert.deepEqual(extract(linked).by_collection,source.snapshot.by_collection);
 assert.throws(()=>extract(linked.replace('href="/collection','href="https://evil.example/collection')));
 for(const altered of [source.html.replace(table,table+table),source.html.replace('>Rentals</th>','>Rented days</th>'),
   source.html.replace('>Synthetic Collection</div>','>Synthetic Collection<script>ignored()</script></div>'),
   source.html.replace('>3.00</div></td>','><a href="/">3.00</a></div></td>')]) assert.throws(()=>extract(altered));
 for(const wrapper of [`<template>${table}</template>`,`<!--${table}-->`,`<script>const text=${JSON.stringify(table)};</script>`]){
  assert.equal(extract(source.html.replace(table,wrapper)).by_collection.status,'missing');
 }
 assert.deepEqual(extract(source.html.replace(table,syntheticCollectionsTable([]))).by_collection,{status:'available',items:[]});
});

test('observed seven-column collection layout maps only named financial columns and matching thumbnail links',()=>{
 const source=syntheticAnalyticsPage({collections:syntheticCollections()}),four=syntheticCollectionsTable(),seven=syntheticCollectionsTable(syntheticCollections(),{extended:true});
 const html=source.html.replace(four,seven),extract=html=>extractMarketappAnalyticsPage(html,source.options);
 assert.deepEqual(extract(html).by_collection,source.snapshot.by_collection);
 assert.deepEqual(normalize(extract(html)).by_collection.items[0],item);
 assert.equal(JSON.stringify(extract(html)).includes('synthetic-collection.webp'),false);
 assert.equal(JSON.stringify(extract(html)).includes('5.45 days'),false);
 const relativeAndAbsolute=html.replace('href="/collection/', 'href="https://marketapp.org/collection/');
 assert.deepEqual(extract(relativeAndAbsolute).by_collection,source.snapshot.by_collection);
 for(const changed of [
  html.replace('<th style="width: 1px;"></th>','<th style="width: 1px;">Unknown</th>'),
  html.replace('>Average duration</th>','>Unknown metric</th>'),
  html.replace('href="/collection/','href="/other-collection/'),
  html.replace('href="/collection/','href="https://evil.example/collection/'),
  html.replace('<img src=', 'Wrong label<img src='),
  html.replace(/<img [^>]+>/,''),
  html.replace('>5.45 days</div>','><a href="/unexpected/">5.45 days</a></div>'),
  html.replace('>22.8%</div>','>22.8%<img src="https://example.com/extra.webp"></div>'),
  html.replace('>5.45 days</div>','>'+ 'x'.repeat(201)+'</div>'),
  html.replace(seven,seven+four),
 ])assert.throws(()=>extract(changed));
 const empty=html.replace(seven,syntheticCollectionsTable([],{extended:true}));
 assert.deepEqual(extract(empty).by_collection,{status:'available',items:[]});
});

test('legacy seven-column collection captures preserve provider values and reject conflicting layout or links',()=>{
 const source=syntheticAnalyticsPage({collections:syntheticCollections()}).snapshot;delete source.by_collection;
 const href='/collection/synthetic/',row={cells:['','Synthetic Collection','4','3.00','0.125','5.45 days','22.8%'],
   links:[{label:'',url:href},{label:'Synthetic Collection',url:'https://marketapp.org'+href}]};
 const table={headers:['','Collection','Rentals','Volume','Price per day','Average duration','Share of volume'],rows:[row]};
 source.tables=[table];assert.deepEqual(normalize(source).by_collection.items[0],item);
 for(const change of [t=>t.headers[5]='Unknown',t=>t.rows[0].cells[0]='wrong label',t=>t.rows[0].links[0].url='/collection/other/',
   t=>t.rows[0].links.pop(),t=>t.rows[0].links[1].label='Different Collection',t=>t.rows[0].cells[5]='x'.repeat(201),
   t=>t.rows[0].cells[6]='22.8%\u0000']) {
  const altered=structuredClone(source);change(altered.tables[0]);assert.throws(()=>normalize(altered),/invalid/);
 }
});

test('invalid collection values, name collisions and oversized tables fail without deriving from Top items',()=>{
 for(const change of [x=>x.items.push({...x.items[0],name:' synthetic collection '}),x=>x.items[0].rentals='1.1',x=>x.items[0].volume='-1',
   x=>x.items[0].name='bad\u0000name',x=>x.items[0].name='x'.repeat(201),x=>x.items=Array.from({length:201},(_,i)=>({...x.items[0],name:'Collection '+i}))]){
  const source=syntheticAnalyticsPage({collections:syntheticCollections()}).snapshot;change(source.by_collection);assert.throws(()=>normalize(source),/invalid/);
 }
 const source=syntheticAnalyticsPage({topItems:syntheticTopItems()}).snapshot;assert.equal(normalize(source).by_collection.status,'missing');
 const collections=Array.from({length:200},(_,i)=>({...syntheticCollections()[0],name:'Collection '+i}));
 const page=syntheticAnalyticsPage({collections});assert.equal(extractMarketappAnalyticsPage(page.html,page.options).by_collection.items.length,200);
});

test('all-time selects disjoint collection periods, keeps exact totals, and leaves combined rate unknown',()=>{
 const first=report(0,9,10,{volume:'10',rentals:2}),overlap=report(5,14,15,{volume:'900',rentals:90}),next=report(10,19,20,{volume:'5',rentals:1});
 const rows=[...archive(first),...archive(overlap),...archive(next)],result=buildPersonalAnalyticsCollectionsAllTime(rows,wallet).items[0];
 assert.equal(result.rentals,3);assert.equal(result.volume,'15');assert.equal(result.price_per_day,null);assert.equal(result.coverage.observed_days,20);
 assert.equal(result.coverage.periods.length,2);assert.equal('rented_days' in result,false);
 assert.deepEqual(buildPersonalAnalyticsCollectionsAllTime(rows,wallet),buildPersonalAnalyticsCollectionsAllTime([...rows].reverse(),wallet));
 assert.equal(buildPersonalAnalyticsCollectionsAllTime(archive(first),wallet).items[0].price_per_day,'0.125');
 const correction=report(0,9,11,{volume:'9007199254740993.0001'});
 assert.equal(buildPersonalAnalyticsCollectionsAllTime([...archive(first),...archive(correction)],wallet).items[0].volume,'9007199254740993.0001');
 assert.equal(buildPersonalAnalyticsCollectionsAllTime(archive(first),'0:'+ '22'.repeat(32)).status,'missing');
 assert.equal(buildPersonalAnalyticsCollectionsAllTime(archive({...first,captured_at:'2999-01-01T00:00:00.000Z'}),wallet).status,'missing');
});

test('collection archive survives missing later rows and snapshot pruning while retention checks every saved name',async t=>{
 const f=createPublicDatabase(t);install(f);const repo=createCloudRepository(f.db),first=report(0,9,10);await save(repo,first);
 assert.equal(f.database.prepare('SELECT count(*) n FROM personal_analytics_collection_reports').get().n,1);
 const preserved=()=>f.database.prepare(`SELECT ${personalAnalyticsSnapshotPreservedSQL('s')} valid FROM personal_rental_analytics s ORDER BY captured_at LIMIT 1`).get().valid;
 assert.equal(preserved(),1);
 const absent=report(0,9,11);absent.by_collection.items=[];await save(repo,absent);f.database.exec('DELETE FROM personal_rental_analytics');
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).by_collection.items[0].rentals,4);
 await save(repo,first);f.database.exec('DELETE FROM personal_analytics_collection_reports');assert.equal(preserved(),0);
 f.database.exec("CREATE TRIGGER fail_collections BEFORE INSERT ON personal_analytics_collection_reports BEGIN SELECT RAISE(ABORT,'collection archive failed'); END");
 await assert.rejects(save(repo,report(1,10,11)),/collection archive failed/);
 assert.equal(f.database.prepare('SELECT count(*) n FROM personal_rental_analytics').get().n,1);
});

test('collection admission/accounting and account deletion preserve tenant boundaries',async t=>{
 const f=createPublicDatabase(t);install(f,true);f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());storageAccountingTriggers().forEach(trigger=>f.database.exec(trigger.sql));
 const value=report(0,9,10),reserve=personalAnalyticsDailyReserve(value,'101');
 const tiny=f.repository(101,{maxAccountBytes:reserve-1,maxServiceBytes:1048576});await tiny.ensureAccount();await assert.rejects(save(tiny,value),PublicStorageLimitError);
 const a=f.repository(101),b=f.repository(202);await a.ensureAccount();await b.ensureAccount();await save(a,value);await save(b,report(0,9,10,{volume:'77'}));
 const measured=STORAGE_TABLES.filter(table=>table.tenant==='user_id').reduce((sum,table)=>sum+f.database.prepare(`SELECT COALESCE(sum(${storageTableByteExpression(table)}),0) n FROM ${table.name} WHERE user_id='101'`).get().n,0);
 assert.equal(f.database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:101'").get().total_bytes,measured);
 const stale=f.repository(101);await stale.ensureAccount();let progress=await a.deleteAccountData(20);while(progress.pending_cleanup)progress=await a.processAccountDeletion(20);
 assert.equal(f.database.prepare("SELECT count(*) n FROM public_personal_analytics_collection_reports WHERE user_id='101'").get().n,0);
 assert.equal((await b.personalAnalyticsAllTime(wallet)).by_collection.items[0].volume,'77');await a.reactivateAccount();await assert.rejects(save(stale,value),PublicAccountError);
});

test('legacy By collection backfill preserves snapshot identity and existing Top items',async t=>{
 const f=createPublicDatabase(t),repo=createCloudRepository(f.db),source=syntheticAnalyticsPage({collections:syntheticCollections(),topItems:syntheticTopItems()}).snapshot;
 const complete=normalize(source),legacy={...complete};delete legacy.by_collection;
 const raw=JSON.stringify(source),stored={normalized_json:JSON.stringify(legacy),raw_snapshot:raw},upgraded=upgradePersonalAnalyticsTopItems(stored);
 assert.deepEqual(upgraded.by_collection,complete.by_collection);assert.deepEqual(upgraded.top_items,complete.top_items);assert.equal(upgraded.fingerprint,legacy.fingerprint);
 const other=structuredClone(source);other.captured_at='2026-10-10T12:00:00Z';assert.equal(upgradePersonalAnalyticsTopItems({...stored,raw_snapshot:JSON.stringify(other)}).by_collection,undefined);
 await repo.importPersonalAnalytics(legacy,raw,legacy.captured_at);assert.deepEqual((await repo.latestPersonalAnalytics(wallet)).by_collection,complete.by_collection);
 f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());storageAccountingTriggers().forEach(trigger=>f.database.exec(trigger.sql));
 assert.equal((await installPersonalAnalyticsDailyStorage(f.db)).trigger_count,40);await backfillPersonalAnalyticsDailyStorage(f.db);
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).by_collection.items[0].volume,'3');
 f.database.exec('DELETE FROM personal_rental_analytics');assert.equal((await repo.personalAnalyticsAllTime(wallet)).by_collection.items[0].rentals,4);
});

test('Unicode collection keys and quoted names remain accounted and provably retained',async t=>{
 const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);
 for(const name of ['İ'.repeat(200),'Quoted "Collection"']) {
  const source=syntheticAnalyticsPage({collections:[{...syntheticCollections()[0],name}]}).snapshot;
  const value=normalize(source);await repo.importPersonalAnalytics(value,JSON.stringify(source),value.captured_at);
  const preserved=f.database.prepare(`SELECT ${personalAnalyticsSnapshotPreservedSQL('s')} valid FROM personal_rental_analytics s WHERE fingerprint=?`).get(value.fingerprint);
  assert.equal(preserved.valid,1);assert.ok(personalAnalyticsDailyReserve(value)>0);
  assert.ok((await repo.personalAnalyticsAllTime(wallet)).by_collection.items.some(row=>row.collection_key==='name:'+name.toLowerCase()));
 }
});

test('concurrent new refresh retains legacy collection evidence until its bounded backfill',async t=>{
 const f=createPublicDatabase(t),repo=f.repository(101);await repo.ensureAccount();
 const source=syntheticAnalyticsPage({collections:syntheticCollections(),topItems:syntheticTopItems()}).snapshot,legacy=normalize(source);delete legacy.by_collection;
 await repo.importPersonalAnalytics(legacy,JSON.stringify(source),legacy.captured_at);
 f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());storageAccountingTriggers().forEach(trigger=>f.database.exec(trigger.sql));
 await installPersonalAnalyticsDailyStorage(f.db);
 const freshSource=structuredClone(source);freshSource.captured_at='2026-10-10T12:00:00Z';freshSource.by_collection.items=[];
 const fresh=normalize(freshSource);await repo.importPersonalAnalytics(fresh,JSON.stringify(freshSource),fresh.captured_at);
 assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,2);
 await backfillPersonalAnalyticsDailyStorage(f.db,{publicScope:true,limit:5});
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).by_collection.items[0].volume,'3');
 freshSource.captured_at='2026-10-11T12:00:00Z';const newest=normalize(freshSource);await repo.importPersonalAnalytics(newest,JSON.stringify(freshSource),newest.captured_at);
 assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,1);
 assert.equal((await repo.personalAnalyticsAllTime(wallet)).by_collection.items[0].rentals,4);
});
