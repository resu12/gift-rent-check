import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {PublicAccountError} from '../tgcloud/lib/public-repository.js';

const wallet=`0:${'11'.repeat(32)}`,otherWallet=`0:${'22'.repeat(32)}`;
const day=index=>new Date(Date.UTC(2010,0,1+index)).toISOString().slice(0,10);
const captured='2025-01-01T12:00:00.000Z',fingerprint='a'.repeat(64);
const kinds=['daily','item_reports','collection_reports'];
const table=(kind,user=null)=>`${user===null?'':'public_'}personal_analytics_${kind}`;
const coverage=(daily=false,items=false,collections=false)=>({daily_limited:daily,items_limited:items,collections_limited:collections});
const archiveQuery=query=>query.method==='all'&&/FROM (?:public_)?personal_analytics_(?:daily|item_reports|collection_reports)\b/.test(query.sql);

function insert(f,kind,rows,{user=null,owner=wallet,prefix='seed'}={}) {
  const names=kind==='daily'?['date','captured_at','fingerprint','rent_volume','new_rentals','extensions']:
    [kind==='item_reports'?'item_key':'collection_key','period_start','period_end','captured_at','fingerprint','item_json'];
  const columns=['row_id',...(user===null?[]:['user_id']),'wallet',...names];
  const statement=f.database.prepare(`INSERT INTO ${table(kind,user)} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for(let index=0;index<rows.length;index++) {
    const row=rows[index];statement.run(row.row_id??`${prefix}:${String(index).padStart(8,'0')}`,...(user===null?[]:[String(user)]),owner,...names.map(name=>row[name]));
  }
}
function dailyRows(count,{offset=0,amount='1'}={}) {
  return Array.from({length:count},(_,index)=>({date:day(offset+index),captured_at:captured,fingerprint,rent_volume:amount,new_rentals:1,extensions:0}));
}
function reportRows(kind,count,{date=day(0),payload='{}',time=captured}={}) {
  const key=kind==='item_reports'?'item_key':'collection_key';
  return Array.from({length:count},(_,index)=>({[key]:'invalid',period_start:date,period_end:date,captured_at:time,fingerprint,
    item_json:typeof payload==='function'?payload(index):payload}));
}
function observe(f) {
  const original=f.db.all,batches=[];
  f.db.all=async(sql,params)=>{
    const rows=await original(sql,params);
    if(archiveQuery({method:'all',sql}))batches.push({sql,rows:structuredClone(rows)});
    return rows;
  };
  return batches;
}
async function repository(f,user) {
  if(user===null)return createCloudRepository(f.db);
  const result=f.repository(user);await result.ensureAccount();return result;
}
function assertBounded(f,batches) {
  const queries=f.queries.filter(archiveQuery);assert.ok(queries.length<=9,`${queries.length} archive queries exceeded the fixed request budget`);
  for(const [kind,cap,pageSize] of [['daily',2000,500],['item_reports',400,200],['collection_reports',600,200]]) {
    const pages=batches.filter(batch=>new RegExp(`FROM (?:public_)?personal_analytics_${kind}\\b`).test(batch.sql));
    assert.ok(pages.reduce((count,page)=>count+page.rows.length,0)<=cap+1,`${kind} transfers at most its cap and one overflow row`);
    assert.ok(pages.every(page=>page.rows.length<=pageSize+1));
    assert.ok(pages.every(page=>/\bLIMIT\b/.test(page.sql)));
  }
}

for(const user of [null,101])for(const excess of [0,1,3000])test(`${user===null?'private':'invited'} archive reads have fixed row/query budgets with ${excess} extra rows`,async t=>{
  const f=createPublicDatabase(t),repo=await repository(f,user);
  insert(f,'daily',dailyRows(2000+excess),{user});
  insert(f,'item_reports',reportRows('item_reports',400+excess),{user});
  insert(f,'collection_reports',reportRows('collection_reports',600+excess),{user});
  const before=kinds.map(kind=>f.database.prepare(`SELECT count(*) n FROM ${table(kind,user)}`).get().n);
  const batches=observe(f);f.queries.length=0;
  const report=await repo.personalAnalyticsAllTime(wallet);
  assert.equal(report.daily.length,2000);assert.equal(report.period_start,day(excess));assert.equal(report.period_end,day(1999+excess));
  assert.equal(report.summary.rent_volume,'2000');assert.deepEqual(report.read_coverage,coverage(excess>0,excess>0,excess>0));
  assertBounded(f,batches);
  assert.deepEqual(kinds.map(kind=>f.database.prepare(`SELECT count(*) n FROM ${table(kind,user)}`).get().n),before,'reading never prunes the durable archive');
  if(user!==null)for(const query of f.queries.filter(archiveQuery)) {
    assert.match(query.sql,/user_id\s*=\s*:tenant/);assert.match(query.sql,/generation\s*=\s*:account_generation/);
    assert.match(query.sql,/status\s*=\s*'active'/);assert.equal(query.params[':tenant'],String(user));assert.equal(query.params[':wallet'],wallet);
    const plan=f.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(query.params).map(row=>row.detail).join('\n');
    assert.doesNotMatch(plan,/USE TEMP B-TREE/,'tenant-scoped pagination must also use archive indexes');
  }
});

for(const limited of ['daily','item_reports','collection_reports'])test(`read coverage identifies the ${limited} limit without claiming complete history`,async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);
  insert(f,'daily',dailyRows(limited==='daily'?2001:1));
  insert(f,'item_reports',reportRows('item_reports',limited==='item_reports'?401:1));
  insert(f,'collection_reports',reportRows('collection_reports',limited==='collection_reports'?601:1));
  const report=await repo.personalAnalyticsAllTime(wallet);
  assert.deepEqual(report.read_coverage,coverage(limited==='daily',limited==='daily'||limited==='item_reports',limited==='daily'||limited==='collection_reports'));
});

test('report pages use newest capture first with deterministic row-id ties and indexed seek queries',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);insert(f,'daily',dailyRows(1));
  for(const [kind,count] of [['item_reports',650],['collection_reports',850]]) {
    const rows=reportRows(kind,count).map((row,index)=>({...row,row_id:`${String(count-index).padStart(6,'0')}`,
      captured_at:index<100?'2024-01-01T00:00:00.000Z':'2025-01-01T00:00:00.000Z'}));
    insert(f,kind,[...rows].reverse());
  }
  const batches=observe(f);await repo.personalAnalyticsAllTime(wallet);
  for(const [kind,cap] of [['item_reports',400],['collection_reports',600]]) {
    const actual=batches.filter(batch=>batch.sql.includes(`FROM personal_analytics_${kind} `)).flatMap(batch=>batch.rows);
    const expected=f.database.prepare(`SELECT row_id FROM personal_analytics_${kind} ORDER BY captured_at DESC,row_id DESC LIMIT ?`).all(cap+1);
    assert.deepEqual(actual.map(row=>row.row_id),expected.map(row=>row.row_id));
    assert.equal(actual[0].captured_at,'2025-01-01T00:00:00.000Z');
    for(const query of f.queries.filter(query=>archiveQuery(query)&&query.sql.includes(`FROM personal_analytics_${kind} `))) {
      const plan=f.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(query.params).map(row=>row.detail).join('\n');
      assert.doesNotMatch(plan,/USE TEMP B-TREE/,'recency pagination must use the archive index');
    }
  }
  assertBounded(f,batches);
});

test('oversized and malformed rows consume the read budget without transferring large JSON or searching indefinitely for valid rows',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);insert(f,'daily',dailyRows(1));
  for(const [kind,cap] of [['item_reports',400],['collection_reports',600]]) {
    insert(f,kind,reportRows(kind,cap+200,{payload:index=>index%2?'not JSON':'x'.repeat(5000)}));
    const key=kind==='item_reports'?'item_key':'collection_key';
    insert(f,kind,[{...reportRows(kind,1)[0],row_id:'older-empty',captured_at:'2024-01-01T00:00:00.000Z',
      [key]:'table:empty',item_json:'{"status":"available","items":[]}'}]);
  }
  const batches=observe(f),report=await repo.personalAnalyticsAllTime(wallet);
  assert.equal(report.top_items.status,'missing');assert.equal(report.by_collection.status,'missing');
  assert.deepEqual(report.read_coverage,coverage(false,true,true));assertBounded(f,batches);
  const payloads=batches.filter(batch=>!batch.sql.includes('analytics_daily ')).flatMap(batch=>batch.rows.map(row=>row.item_json));
  assert.ok(payloads.some(value=>value===null),'oversized JSON becomes a small SQL NULL before transfer');
  assert.ok(payloads.every(value=>value===null||Buffer.byteLength(value)<=4096));
});

test('wallet and account scoping applies before bounded selection for every archive section',async t=>{
  const f=createPublicDatabase(t),privateRepo=createCloudRepository(f.db),a=await repository(f,101),b=await repository(f,202);
  for(const [user,owner,amount] of [[null,wallet,'1'],[null,otherWallet,'2'],[101,wallet,'3'],[101,otherWallet,'4'],[202,wallet,'5']]) {
    insert(f,'daily',dailyRows(2,{amount}),{user,owner,prefix:`${owner}:${amount}`});
    for(const kind of ['item_reports','collection_reports']) {
      const key=kind==='item_reports'?'item_key':'collection_key';
      insert(f,kind,[{...reportRows(kind,1)[0],[key]:'table:empty',item_json:'{"status":"available","items":[]}'}],{user,owner,prefix:`${owner}:${amount}`});
    }
  }
  for(const [repo,owner,amount] of [[privateRepo,wallet,'2'],[privateRepo,otherWallet,'4'],[a,wallet,'6'],[a,otherWallet,'8'],[b,wallet,'10']]) {
    const report=await repo.personalAnalyticsAllTime(owner);
    assert.equal(report.summary.rent_volume,amount);assert.equal(report.top_items.status,'available');assert.equal(report.by_collection.status,'available');
    assert.deepEqual(report.read_coverage,coverage());
  }
  assert.equal(await b.personalAnalyticsAllTime(otherWallet),null);
});

for(const change of ['generation','deleting'])test(`public account ${change} fence remains effective between archive pages`,async t=>{
  const f=createPublicDatabase(t),repo=await repository(f,101);insert(f,'daily',dailyRows(700),{user:101});
  const original=f.db.all;let pages=0;
  f.db.all=async(sql,params)=>{
    if(archiveQuery({method:'all',sql})&&++pages===2)f.database.exec(change==='generation'?
      "UPDATE public_accounts SET generation=generation+1 WHERE user_id='101'":"UPDATE public_accounts SET status='deleting' WHERE user_id='101'");
    const rows=await original(sql,params);
    if(pages>=2)assert.equal(rows.length,0,'the active-account predicate also fences a revocation racing the SQL request');
    return rows;
  };
  await assert.rejects(repo.personalAnalyticsAllTime(wallet),PublicAccountError);
});

test('small archives preserve dates and available-empty markers exactly without limit warnings',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);
  insert(f,'daily',dailyRows(3,{offset:50}));
  for(const kind of ['item_reports','collection_reports']) {
    const key=kind==='item_reports'?'item_key':'collection_key';
    insert(f,kind,[{...reportRows(kind,1,{date:day(50)})[0],period_end:day(52),[key]:'table:empty',item_json:'{"status":"available","items":[]}'}]);
  }
  const before=kinds.map(kind=>f.database.prepare(`SELECT * FROM ${table(kind)} ORDER BY row_id`).all());
  const report=await repo.personalAnalyticsAllTime(wallet);
  assert.deepEqual(report.daily.map(row=>row.date),[day(50),day(51),day(52)]);
  assert.equal(report.top_items.status,'available');assert.deepEqual(report.top_items.items,[]);
  assert.equal(report.by_collection.status,'available');assert.deepEqual(report.by_collection.items,[]);
  assert.deepEqual(report.read_coverage,coverage());
  assert.deepEqual(kinds.map(kind=>f.database.prepare(`SELECT * FROM ${table(kind)} ORDER BY row_id`).all()),before);
});
