import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository,NORMALIZED_RECORD_KINDS,inlineRecordEventSelect,inlineRecordIndexDefinitions} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository,PublicAccountError} from '../tgcloud/lib/public-repository.js';
import {installNormalizedRecordStorage} from '../tools/normalized-record-storage.mjs';
import {installCompactOperationalStorage} from '../tools/compact-operational-storage.mjs';
import {installStorageAccounting} from '../tools/storage-accounting.mjs';
import {installInlineRecordIndex,installInlineRecordIndexBatch} from '../tools/inline-record-index.mjs';
import {inlineRecordAdminSources,inlineRecordAdminRepositorySource} from '../tools/inline-record-index-sources.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

const at='2026-10-13T12:00:00.000Z',state=floor=>({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0,operational_storage_version:1,record_storage_floor:floor??0});
const row=(kind,key,record={saved:key})=>({kind,key,record,observed_at:at});
const event=(key,records=[],floor=0)=>({key,records,state:state(floor),observed_at:at});
async function fixture(t) {
  const f=createPublicDatabase(t);await installCompactOperationalStorage(f.db);await installNormalizedRecordStorage(f.db);
  let cursor=0;for(;;){const result=await installStorageAccounting(f.db,{after:cursor});if(result.complete)break;cursor=result.after;}
  return f;
}
async function install(db,options={}) {
  let cursor={limit:2,...options};
  for(let step=0;step<1000;step++) {
    const result=await installInlineRecordIndex(db,cursor);if(result.complete)return result;
    cursor={phase:result.phase,after:result.after,limit:cursor.limit};
  }
  throw new Error('Synthetic index installation did not finish');
}
const inlineCalls=f=>f.queries.filter(q=>q.method==='all'&&q.sql.includes('json_each(e.records_json)'));
const actualBytes=f=>STORAGE_TABLES.reduce((sum,table)=>sum+f.database.prepare(`SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) AS bytes FROM ${table.name}`).get().bytes,0);

test('administrative bundle strips unrelated endpoints and enforces the host module limit',()=>{
  const canonical={'lib/private-config':'owner-only',...Object.fromEntries(Array.from({length:52},(_,i)=>['lib/dependency'+i,'dependency'])),
    ...Object.fromEntries(Array.from({length:46},(_,i)=>['endpoints/unrelated'+i,'endpoint']))};
  assert.equal(Object.keys(canonical).length,99);
  const sources=inlineRecordAdminSources(canonical,{'lib/storage-accounting':'accounting','lib/inline-record-index':"import './storage-accounting.js';"},"import {db} from 'sdk';import '../lib/private-config.js';\nimport '../lib/inline-record-index.js';");
  assert.equal(Object.keys(sources).length,4);
  assert.deepEqual(Object.keys(sources).filter(name=>name.startsWith('endpoints/')),['endpoints/installInlineRecordIndex']);
  assert.equal(sources['lib/private-config'],canonical['lib/private-config']);
  const chain=Object.fromEntries(Array.from({length:100},(_,i)=>['lib/extra'+i,i===99?'':`import './extra${i+1}.js';`]));
  assert.throws(()=>inlineRecordAdminSources({...canonical,...chain},{},"import '../lib/extra0.js';"),/supported layout/);
  assert.throws(()=>inlineRecordAdminSources(canonical,{},"import '../lib/missing.js';"),/Missing administration dependency/);
  assert.throws(()=>inlineRecordAdminSources(canonical,{},"import 'unapproved-package';"),/Unsupported administration dependency/);
});

test('minimal administrative repository emits byte-identical classifier and trigger SQL',async()=>{
  const source=inlineRecordAdminRepositorySource(),module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  assert.deepEqual(module.NORMALIZED_RECORD_KINDS,NORMALIZED_RECORD_KINDS);
  assert.deepEqual(module.inlineRecordIndexDefinitions(),inlineRecordIndexDefinitions());
  for(const table of ['cloud_events','public_cloud_events'])for(const alias of ['e','NEW'])assert.deepEqual(module.inlineRecordEventSelect(table,alias),inlineRecordEventSelect(table,alias));
  assert.ok(Buffer.byteLength(source)<6000);
  assert.equal(/\bimport\b/.test(source),false);
});

test('real installer bundle includes only its seven required modules and stays under 64 KiB',()=>{
  const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
  const overrides={'lib/cloud-repository':inlineRecordAdminRepositorySource(),
    'lib/storage-policy':read('../tgcloud/lib/storage-policy.js'),
    'lib/budget-reset-checkpoint-storage':read('../tgcloud/lib/budget-reset-checkpoint-storage.js'),
    'lib/storage-accounting':read('../tools/storage-accounting.mjs').replaceAll("from '../tgcloud/lib/","from './"),
    'lib/inline-record-index':read('../tools/inline-record-index.mjs').replaceAll("from '../tgcloud/lib/","from './").replace("from './storage-accounting.mjs'","from './storage-accounting.js'")};
  const source=inlineRecordAdminSources({'lib/private-config':'export const ownerTelegramId=1;',
    'lib/unrelated':'x'.repeat(1000000),'endpoints/unrelated':'unused'},overrides,
    "import {db} from 'sdk';import {ownerTelegramId} from '../lib/private-config.js';\nimport {installInlineRecordIndex} from '../lib/inline-record-index.js';");
  assert.deepEqual(Object.keys(source).sort(),['endpoints/installInlineRecordIndex','lib/budget-reset-checkpoint-storage','lib/cloud-repository','lib/inline-record-index','lib/private-config','lib/storage-accounting','lib/storage-policy']);
  assert.ok(Buffer.byteLength(JSON.stringify(source))<65536);
});

test('hosted batch combines bounded passes and returns the last confirmed cursor',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);
  for(let i=0;i<21;i++)await repo.append(i,event('batch:'+i,[row('settings','row:'+i)]));
  const first=await installInlineRecordIndexBatch(f.db,{limit:2,now:()=>100});
  assert.deepEqual(first,{complete:false,phase:'private',after:16,events_checked:16,passes:8});
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_inline_events').get().n,16);
  const complete=await installInlineRecordIndexBatch(f.db,{phase:first.phase,after:first.after,limit:2,now:()=>100});
  assert.deepEqual(complete,{complete:true,phase:'complete',after:null,definitions:8,events_checked:5,passes:5});
  const repeated=await installInlineRecordIndexBatch(f.db,{phase:first.phase,after:first.after,limit:2,now:()=>100});
  assert.deepEqual(repeated,{complete:true,phase:'complete',after:null,definitions:8,events_checked:0,passes:1});
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,21);
});

test('hosted batch deadline stops before a subsequent pass without losing progress',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);
  for(let i=0;i<5;i++)await repo.append(i,event('deadline:'+i,[row('settings','row:'+i)]));
  let clock=0;const first=await installInlineRecordIndexBatch(f.db,{limit:2,budgetMs:2,now:()=>clock++});
  assert.deepEqual(first,{complete:false,phase:'private',after:2,events_checked:2,passes:1});
  const second=await installInlineRecordIndexBatch(f.db,{phase:first.phase,after:first.after,limit:2,maxPasses:1,now:()=>100});
  assert.deepEqual(second,{complete:false,phase:'private',after:4,events_checked:2,passes:1});
  await assert.rejects(installInlineRecordIndexBatch(f.db,{maxPasses:9}),/Invalid inline index batch/);
  await assert.rejects(installInlineRecordIndexBatch(f.db,{budgetMs:5001}),/Invalid inline index batch/);
});

for(const publicMode of [false,true])test(`${publicMode?'public':'private'} index skips marker-only events, preserves exact order and bounds the empty tail`,async t=>{
  const f=await fixture(t),repo=publicMode?f.repository(101):createCloudRepository(f.db),source=[];
  const seeds=[row('settings','wallet',{wallet:'saved-wallet'}),row('portfolio','gift',{nft_address:'gift'})];
  await repo.append(0,event('seeds',seeds));source.push(...seeds);
  for(let page=0;page<5;page++) {
    const records=Array.from({length:1000},(_,i)=>row('history',`${page}:${i}`,{sequence:page*1000+i}));
    await repo.append(page+1,event('history:'+page,records));source.push(...records);
  }
  const tail=[row('unknown','kept'),row('gift','tail',{nft_address:'another-gift'})];
  await repo.append(6,event('tail',tail));source.push(...tail);
  f.queries.length=0;assert.deepEqual(await repo.dashboardSeedRecords(7),[...seeds,tail[1]]);assert.ok(inlineCalls(f).length>=8);
  const table=publicMode?'public_cloud_events':'cloud_events',before=f.database.prepare(`SELECT sequence,records_json FROM ${table} ORDER BY sequence`).all();
  await install(f.db);
  assert.deepEqual(f.database.prepare(`SELECT sequence,records_json FROM ${table} ORDER BY sequence`).all(),before);
  f.queries.length=0;assert.deepEqual(await repo.dashboardSeedRecords(7),[...seeds,tail[1]]);
  const calls=inlineCalls(f);assert.equal(calls.length,2,'one seed page plus bounded empty page');
  assert.ok(calls.every(call=>call.sql.includes('INDEXED BY record_seed_events_v1_idx')));
  const plan=f.database.prepare('EXPLAIN QUERY PLAN '+calls.at(-1).sql).all(calls.at(-1).params);
  assert.ok(plan.some(row=>/SEARCH i USING.*record_seed_events_v1_idx/.test(row.detail)),JSON.stringify(plan));
  f.queries.length=0;assert.deepEqual(await repo.records(7),source);assert.equal(inlineCalls(f).length,2);
  assert.deepEqual(await repo.records(1),seeds,'captured revision excludes later rows');
  assert.deepEqual(await install(f.db),{complete:true,phase:'complete',after:null,definitions:8});
});

test('indexed classification preserves mixed, protected, unknown and legacy envelope shapes',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);
  await repo.append(0,event('seed',[row('settings','wallet')]));
  const retained=[{kind:'metadata',record:null,__normalized_record_v1:null},{kind:'unknown',__normalized_record_v1:0},
    {kind:'metadata',other:'retained'},{kind:'settings',value:{wallet:'legacy'}},{kind:'portfolio',nft_address:'legacy-gift'}];
  f.database.prepare('UPDATE cloud_events SET records_json=? WHERE sequence=1').run(JSON.stringify([
    {kind:'metadata',__normalized_record_v1:null},...retained,
  ]));
  assert.deepEqual(await repo.records(1),retained);await install(f.db);assert.deepEqual(await repo.records(1),retained);
  assert.deepEqual(await repo.dashboardSeedRecords(1),retained.slice(-2));
  const fresh=[row('history','normalized'),row('settings','protected',{wallet:'real'})];
  fresh[1].__normalized_record_v1=0;
  await repo.append(1,event('mixed',fresh));assert.deepEqual(await repo.records(2),[...retained,...fresh]);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_inline_events').get().n,2);
});

test('partial installation and changed catalog definitions keep the legacy bounded traversal',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);await repo.append(0,event('first',[row('settings','one')]));
  let result=await installInlineRecordIndex(f.db,{limit:1});assert.equal(result.complete,false);
  f.queries.length=0;assert.equal((await repo.records(1)).length,1);assert.ok(inlineCalls(f).every(q=>!q.sql.includes('INDEXED BY')));
  await repo.append(1,event('during-backfill',[row('gift','two')]));await install(f.db);
  assert.equal((await repo.records(2)).length,2);
  f.database.exec('DROP TRIGGER record_inline_index_v1_cloud_events_insert');
  await repo.append(2,event('missing-trigger',[row('portfolio','three')]));
  f.queries.length=0;assert.equal((await repo.records(3)).length,3);assert.ok(inlineCalls(f).every(q=>!q.sql.includes('INDEXED BY')));
  await assert.rejects(install(f.db),/explicit repair/);
});

test('classification update/delete is atomic, accounted, and malformed evidence still fails visibly',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);await repo.append(0,event('inline',[row('settings','one')]));await install(f.db);
  const tracked=()=>f.database.prepare('SELECT total_bytes FROM service_storage_usage WHERE id=1').get().total_bytes;
  assert.equal(tracked(),actualBytes(f));
  await install(f.db);assert.equal(tracked(),actualBytes(f),'idempotent installation does not double-count index rows');
  f.database.prepare('UPDATE cloud_events SET records_json=? WHERE sequence=1').run(JSON.stringify([{kind:'history',__normalized_record_v1:0}]));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_inline_events').get().n,0);assert.equal(tracked(),actualBytes(f));
  f.database.prepare('UPDATE cloud_events SET records_json=? WHERE sequence=1').run('invalid JSON');
  assert.equal(f.database.prepare('SELECT has_seed FROM service_record_inline_events').get().has_seed,1);await assert.rejects(repo.records(1));
  f.database.exec('DELETE FROM cloud_events WHERE sequence=1');assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_inline_events').get().n,0);assert.equal(tracked(),actualBytes(f));
});

test('index rollback preserves events and accounting when classification cannot be saved',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);await install(f.db);
  f.database.exec("CREATE TRIGGER fail_inline_index BEFORE INSERT ON service_record_inline_events BEGIN SELECT RAISE(ABORT,'synthetic selector failure'); END");
  await assert.rejects(repo.append(0,event('rollback',[row('settings','one'),row('history','history')])),/synthetic selector failure/);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_occurrences').get().n,0);
  assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_usage WHERE id=1').get().total_bytes,actualBytes(f));
});

test('indexed reads keep reset and account-generation fences, including deletion and recreation',async t=>{
  const f=await fixture(t),a=f.repository(101),b=f.repository(202),privateRepo=createCloudRepository(f.db);
  await a.append(0,event('a',[row('settings','a')]));await b.append(0,event('b',[row('settings','b')]));
  await privateRepo.append(0,event('p',[row('metadata','keep'),row('history','old')]));await install(f.db);
  const stale=f.repository(101);await stale.publicAccount();
  let deleted=await a.deleteAccountData(1);while(deleted.pending_cleanup)deleted=await a.processAccountDeletion(1);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM service_record_inline_events WHERE scope='public:101'").get().n,0);
  await a.reactivateAccount();const fresh=f.repository(101);await fresh.append(0,event('new',[row('settings','new')]));
  await assert.rejects(stale.records(),PublicAccountError);assert.deepEqual(await fresh.records(),[row('settings','new')]);assert.deepEqual(await b.records(),[row('settings','b')]);
  assert.equal(f.database.prepare("SELECT generation FROM service_record_inline_events WHERE scope='public:101'").get().generation,2);
  let reset=false;await assert.rejects(privateRepo.visitRecords(1,async()=>{if(!reset){reset=true;await privateRepo.append(1,event('reset',[row('development_reset','reset')],2));}}),/reload saved data/);
  assert.deepEqual((await privateRepo.records(2)).map(value=>value.key),['keep','reset']);
});

test('installer rejects unexpected definitions without replacing them',async t=>{
  const f=await fixture(t),definition=inlineRecordIndexDefinitions()[0];
  f.database.exec(`CREATE TRIGGER ${definition.name} AFTER INSERT ON cloud_events BEGIN SELECT 1; END`);
  await assert.rejects(install(f.db),/explicit repair/);
  assert.match(f.database.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(definition.name).sql,/SELECT 1/);
});

test('unmigrated schema preserves private and public read-only fallback',async t=>{
  const f=await fixture(t),a=f.repository(101),privateRepo=createCloudRepository(f.db),records=[row('settings','saved'),row('history','kept')];
  await a.append(0,event('a',records));await privateRepo.append(0,event('p',records));
  f.database.exec('DROP TABLE service_record_inline_events');
  assert.deepEqual(await privateRepo.records(1),records);assert.deepEqual(await a.records(1),records);
  assert.deepEqual(await privateRepo.dashboardSeedRecords(1),[records[0]]);assert.deepEqual(await a.dashboardSeedRecords(1),[records[0]]);
});
