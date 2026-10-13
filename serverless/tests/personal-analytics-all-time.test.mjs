import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository,PublicAccountError,PublicStorageLimitError,migrateLegacyOwner} from '../tgcloud/lib/public-repository.js';
import {buildPersonalAnalyticsAllTime,personalAnalyticsDailyTriggers,personalAnalyticsDailyBackfill,
  personalAnalyticsDailyReserve,personalAnalyticsSnapshotPreservedSQL} from '../tgcloud/lib/personal-analytics.js';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

const wallet=`0:${'11'.repeat(32)}`,otherWallet=`0:${'22'.repeat(32)}`;
const day=number=>new Date(Date.UTC(2024,0,1+number)).toISOString().slice(0,10);
const captured=number=>`${day(number)}T12:00:00.000Z`;
function snapshot(start,length,at,{amount='1.2345',starts=1,extensions=0,owner=wallet,salt='',fingerprint=null}={}) {
  const value={version:1,source:'marketapp_personal_rent_page',source_url:null,wallet:owner,captured_at:at,
    period_start:day(start),period_end:day(start+length-1),timezone:'UTC',currency:'GRAM',volume_basis:'gross_before_fees',
    summary:{rent_volume:'0',rentals:0},by_collection:{status:'missing',scope:'marketapp_by_collection',items:[]},top_items:{status:'missing',scope:'marketapp_top_items',items:[]},daily:Array.from({length},(_,i)=>({date:day(start+i),rent_volume:amount,new_rentals:starts,extensions,rentals:starts+extensions}))};
  return {...value,fingerprint:fingerprint??createHash('sha256').update(JSON.stringify(value)+salt).digest('hex')};
}
function install(f,publicScope=false) {for(const trigger of personalAnalyticsDailyTriggers({publicScope}))f.database.exec(trigger.sql);}
const save=(repo,value,at=value.captured_at)=>repo.importPersonalAnalytics(value,'synthetic analytics source',at);
const rows=(f,publicScope=false)=>f.database.prepare(`SELECT * FROM ${publicScope?'public_personal_analytics_daily':'personal_analytics_daily'} ORDER BY date`).all();

test('daily archive keeps older dates, exact sums and newest correction without adding overlaps',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);
  const first=snapshot(0,3,captured(2)),next=snapshot(1,3,captured(3),{amount:'0.0001',starts:0,extensions:1});
  await save(repo,first);await save(repo,next);
  const report=await repo.personalAnalyticsAllTime(wallet);
  assert.equal(report.report_kind,'all_time');assert.equal(report.source,'marketapp_personal_rent_page');assert.equal(report.source_url,null);
  assert.equal(report.summary.rent_volume,'1.2348');assert.equal(report.summary.new_rentals,1);assert.equal(report.summary.extensions,3);
  assert.equal(report.summary.rentals,4);assert.equal(report.summary.items,null);assert.equal(report.summary.average_duration,null);
  assert.equal(report.summary.price_per_day,null);assert.equal(report.summary.spent_on_rent,null);
  assert.deepEqual(report.coverage,{observed_days:4,missing_days:0,partial_days:1});
  assert.equal(report.daily[2].partial,false,'a later capture completes the old capture day');assert.equal(report.daily[3].partial,true);
  assert.equal(report.daily[1].captured_at,next.captured_at);
  await save(repo,snapshot(0,3,captured(2),{amount:'99',salt:'late older import'}));
  assert.equal((await repo.personalAnalyticsAllTime(wallet)).daily[1].rent_volume,'0.0001');
  f.database.prepare('DELETE FROM personal_rental_analytics WHERE fingerprint=?').run(first.fingerprint);
  assert.equal((await repo.personalAnalyticsAllTime(wallet)).coverage.observed_days,4);
});

test('tie winners, gaps, malformed or future rows and unsafe aggregate counts are explicit',()=>{
  const low='1'.repeat(64),high='f'.repeat(64),at=captured(7);
  const observation=(offset,extra={})=>({wallet,date:day(offset),captured_at:at,fingerprint:low,rent_volume:'9007199254740993.0001',new_rentals:1,extensions:0,...extra});
  const input=[observation(0),observation(2),observation(2,{fingerprint:high,rent_volume:'0.0001'}),observation(7),
    observation(3,{wallet:otherWallet}),observation(4,{date:'2024-02-30'}),observation(5,{captured_at:'2999-01-01T00:00:00.000Z'})];
  const report=buildPersonalAnalyticsAllTime(input,wallet);
  assert.equal(report.summary.rent_volume,'18014398509481986.0003');assert.deepEqual(report.coverage,{observed_days:3,missing_days:5,partial_days:1});
  assert.deepEqual(buildPersonalAnalyticsAllTime([...input].reverse(),wallet),report);
  assert.equal(buildPersonalAnalyticsAllTime([observation(0,{new_rentals:Number.MAX_SAFE_INTEGER}),observation(1)],wallet),null);
  assert.equal(buildPersonalAnalyticsAllTime([],wallet),null);
});

test('archive backfill and OLD triggers preserve legacy dates during replacement and deletion atomically',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db),old=snapshot(0,3,captured(3)),next=snapshot(2,3,captured(5));
  await save(repo,old);assert.equal(rows(f).length,0);install(f);
  const command=personalAnalyticsDailyBackfill({limit:1});await f.db.run(command.sql,command.parameters);
  assert.equal(rows(f).length,3);
  f.database.prepare('DELETE FROM personal_analytics_daily').run();
  f.database.prepare(`UPDATE personal_rental_analytics SET fingerprint=?,captured_at=?,imported_at=?,normalized_json=? WHERE fingerprint=?`)
    .run(next.fingerprint,next.captured_at,next.captured_at,JSON.stringify(next),old.fingerprint);
  assert.equal(rows(f).length,5);assert.equal((await repo.personalAnalyticsAllTime(wallet)).coverage.observed_days,5);
  f.database.prepare('DELETE FROM personal_analytics_daily WHERE date=?').run(day(4));
  f.database.prepare('DELETE FROM personal_rental_analytics').run();
  assert.equal(rows(f).length,5);
  const bad=snapshot(8,1,captured(8));
  f.database.exec("CREATE TRIGGER fail_daily BEFORE INSERT ON personal_analytics_daily BEGIN SELECT RAISE(ABORT,'synthetic archive write failure'); END");
  await assert.rejects(save(repo,bad),/synthetic archive write failure/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM personal_rental_analytics').get().n,0,'parent snapshot rolled back too');
});

test('future capture imports cannot poison the permanent daily winner',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);
  const good=snapshot(0,2,captured(2)),future=snapshot(0,2,'2999-01-01T00:00:00.000Z',{amount:'999'});
  await save(repo,good);await save(repo,future,captured(3));
  assert.equal(rows(f).length,2);assert.equal((await repo.personalAnalyticsAllTime(wallet)).summary.rent_volume,'2.469');
  f.database.prepare('DELETE FROM personal_rental_analytics').run();
  assert.equal((await repo.personalAnalyticsAllTime(wallet)).summary.rent_volume,'2.469');
});

test('malformed legacy daily arrays cannot partially overwrite valid archived dates',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);await save(repo,snapshot(0,3,captured(3)));
  const before=await repo.personalAnalyticsAllTime(wallet);
  for(const [index,mutate] of [value=>{value.daily[1].date=value.daily[0].date;},value=>{value.period_start=day(10);},
    value=>{value.daily[1]='invalid';},value=>{value.daily[1].rent_volume='01.2';},value=>{value.daily[1].extensions=-1;},
    value=>{delete value.daily[1].new_rentals;}].entries()) {
    const bad=snapshot(0,3,captured(4),{amount:'99',salt:String(index)});mutate(bad);await save(repo,bad);
    assert.deepEqual(await repo.personalAnalyticsAllTime(wallet),before);
  }
});

test('all-time exceeds a one-year report without truncation and reads small indexed pages',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);
  await save(repo,snapshot(0,365,captured(365)));await save(repo,snapshot(335,365,captured(700)));
  f.database.prepare('DELETE FROM personal_rental_analytics').run();f.queries.length=0;
  const report=await repo.personalAnalyticsAllTime(wallet);
  assert.equal(report.daily.length,700);assert.equal(report.summary.rent_volume,'864.15');
  assert.equal(report.period_start,day(0));assert.equal(report.period_end,day(699));
  const pages=f.queries.filter(query=>query.method==='all'&&query.sql.includes('FROM personal_analytics_daily'));
  assert.equal(pages.length,3);assert.ok(pages.every(query=>query.sql.includes('LIMIT 500')));
});

test('invited accounts keep wallet-scoped daily history across retained snapshot replacement',async t=>{
  const f=createPublicDatabase(t);install(f,true);const a=f.repository(101),b=f.repository(202);await a.ensureAccount();await b.ensureAccount();
  const first=snapshot(0,3,captured(3)),next=snapshot(1,3,captured(4),{amount:'2'});
  await save(a,first);await save(a,next);await save(b,snapshot(0,3,captured(4),{amount:'8'}));
  await save(a,snapshot(0,3,captured(4),{owner:otherWallet,amount:'9'}));
  assert.equal((await a.personalAnalyticsAllTime(wallet)).summary.rent_volume,'7.2345');
  assert.equal((await b.personalAnalyticsAllTime(wallet)).summary.rent_volume,'24');
  assert.equal((await a.personalAnalyticsAllTime(otherWallet)).summary.rent_volume,'27');
  assert.equal(await b.personalAnalyticsAllTime(otherWallet),null);
  assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics WHERE user_id=? AND wallet=?').get('101',wallet).n,1);
  const preserved=await f.db.get(`SELECT ${personalAnalyticsSnapshotPreservedSQL('s',true)} AS valid FROM public_personal_rental_analytics s WHERE user_id=:user AND wallet=:wallet`,{':user':'101',':wallet':wallet});
  assert.equal(preserved.valid,1);
});

test('unbackfilled invited snapshots remain intact until their old dates are archived',async t=>{
  const f=createPublicDatabase(t),repo=f.repository(101);await repo.ensureAccount();
  const old=snapshot(0,3,captured(3)),next=snapshot(1,3,captured(4));
  await save(repo,old);install(f,true);await save(repo,next);
  assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,2,'old date zero is not yet rolled up');
  const command=personalAnalyticsDailyBackfill({publicScope:true,limit:8});await f.db.run(command.sql,command.parameters);
  await save(repo,snapshot(2,3,captured(5)));
  assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,1);
  assert.equal((await repo.personalAnalyticsAllTime(wallet)).daily.length,5);
});

test('account generation, wallet and website session revocation fence snapshot and daily writes together',async t=>{
  for(const mode of ['generation','wallet','session'])await t.test(mode,async t=>{
    const f=createPublicDatabase(t);install(f,true);const repo=f.repository(101);await repo.ensureAccount();
    const fence=await repo.marketappSessionFence('101'),original=f.db.run;let changed=false;
    f.db.run=async(sql,params)=>{
      if(!changed&&sql.includes('INSERT OR IGNORE INTO public_personal_rental_analytics')) {
        changed=true;
        if(mode==='generation')f.database.exec("UPDATE public_accounts SET generation=generation+1 WHERE user_id='101'");
        else if(mode==='wallet')await repo.append(0,{key:'wallet-change',state:{version:2,job:null},records:[{kind:'settings',record:{wallet:otherWallet}}],observed_at:captured(4)});
        else f.database.exec("UPDATE public_marketapp_analytics_sessions SET generation=generation+1 WHERE owner_id='101'");
      }
      return original(sql,params);
    };
    const value=snapshot(0,3,captured(3));
    if(mode==='generation')await assert.rejects(repo.importPersonalAnalyticsFenced(value,'raw',value.captured_at,'101',fence,0),PublicAccountError);
    else assert.equal(await repo.importPersonalAnalyticsFenced(value,'raw',value.captured_at,'101',fence,0),false);
    assert.equal(rows(f,true).length,0);assert.equal(f.database.prepare('SELECT count(*) n FROM public_personal_rental_analytics').get().n,0);
  });
});

test('deletion removes only the account archive and stale workers cannot restore it after recreation',async t=>{
  const f=createPublicDatabase(t);install(f,true);const a=f.repository(101),b=f.repository(202);await a.ensureAccount();await b.ensureAccount();
  const value=snapshot(0,3,captured(3));await save(a,value);await save(b,value);
  const stale=f.repository(101);await stale.ensureAccount();
  let progress=await a.deleteAccountData(1),turns=0;
  while(progress.pending_cleanup&&turns++<30)progress=await a.processAccountDeletion(1);
  assert.equal(progress.pending_cleanup,false);assert.equal(f.database.prepare("SELECT count(*) n FROM public_personal_analytics_daily WHERE user_id='101'").get().n,0);
  assert.equal((await b.personalAnalyticsAllTime(wallet)).daily.length,3);
  await a.reactivateAccount();assert.equal(await a.personalAnalyticsAllTime(wallet),null);
  await assert.rejects(save(stale,snapshot(0,3,captured(4))),PublicAccountError);
  assert.equal(await a.personalAnalyticsAllTime(wallet),null);
});

test('daily archive is accounted and storage admission reserves trigger growth before any write',async t=>{
  const f=createPublicDatabase(t);install(f,true);f.database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());
  for(const trigger of storageAccountingTriggers())f.database.exec(trigger.sql);
  const value=snapshot(0,3,captured(3)),reserve=personalAnalyticsDailyReserve(value,'101');assert.ok(reserve>600);
  const tiny=f.repository(101,{maxAccountBytes:reserve-1,maxServiceBytes:1048576});await tiny.ensureAccount();
  const initialUsage=f.database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:101'").get().total_bytes;
  await assert.rejects(save(tiny,value),PublicStorageLimitError);assert.equal(rows(f,true).length,0);
  const repo=f.repository(101);await save(repo,value);
  const tables=['public_personal_rental_analytics','public_personal_analytics_daily'];
  const measured=tables.reduce((total,name)=>total+f.database.prepare(`SELECT COALESCE(SUM(${storageTableByteExpression(STORAGE_TABLES.find(table=>table.name===name))}),0) n FROM ${name}`).get().n,0);
  assert.equal(f.database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:101'").get().total_bytes,measured+initialUsage);
});

test('legacy migration refuses to lose archived dates that rolling captures no longer contain',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);install(f);await save(repo,snapshot(0,3,captured(3)));
  f.database.prepare('DELETE FROM personal_rental_analytics').run();
  await assert.rejects(migrateLegacyOwner(f.db,101,{mode:'apply',confirmOwnerId:101}),/cannot copy durable all-time analytics/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM public_accounts').get().n,0);
});
