import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository,preparedRecordJSON} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository,PublicAccountError,PublicStorageLimitError,migrateLegacyOwner} from '../tgcloud/lib/public-repository.js';
import {installNormalizedRecordStorage} from '../tools/normalized-record-storage.mjs';
import {installCompactOperationalStorage} from '../tools/compact-operational-storage.mjs';
import {installStorageAccounting} from '../tools/storage-accounting.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';
import {createStorageAdmission,StorageCapacityError} from '../tgcloud/lib/storage-admission.js';

const at='2026-10-12T12:00:00.000Z';
const state=(floor=0)=>({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0,operational_storage_version:1,record_storage_floor:floor});
const event=(key,records=[],value=state())=>({key,state:value,records,observed_at:at});
const row=(kind,key,record={identity:'gift',source_json:{price:'0.10',unknown:{conflict:false}}})=>({kind,key,observed_at:at,record,extra:{keep:true}});
async function fixture(t) {const f=createPublicDatabase(t);await installCompactOperationalStorage(f.db);await installNormalizedRecordStorage(f.db);return f;}

for(const publicMode of [false,true])test(`${publicMode?'public':'private'} normalized records preserve complete envelopes, variants, ordering and frozen reads`,async t=>{
  const f=await fixture(t),repo=publicMode?f.repository(101,{dashboardCache:true}):createCloudRepository(f.db,{dashboardCache:true});
  const first=[row('settings','wallet',{wallet:'wallet'}),row('listing','one'),row('history','history'),row('metadata','metadata'),row('gift_refresh_binding','binding',{session_id:'binding-session-123',run_id:1})];
  assert.equal(await repo.append(0,event('a',first)),true);
  const second=[row('listing','again'),row('listing','conflict',{identity:'gift',source_json:{price:'0.10',unknown:{conflict:true}}}),row('listing','params',{identity:'gift',source_json:{price:'0.10',unknown:{conflict:false}},params:{model:'filtered'}})];
  assert.equal(await repo.append(1,event('b',second)),true);
  assert.deepEqual(await repo.event('a'),first);assert.deepEqual(await repo.event('b'),second);
  assert.deepEqual(await repo.records(1),first);assert.deepEqual(await repo.records(2),[...first,...second]);
  assert.deepEqual(await repo.dashboardSeedRecords(2),[first[0]]);
  assert.equal((await repo.dashboardRevision()).records_revision,2);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_payloads').get().n,5);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_occurrences').get().n,6);
  const saved=f.database.prepare(`SELECT records_json FROM ${publicMode?'public_cloud_events':'cloud_events'} ORDER BY sequence`).all();
  assert.ok(saved.every(value=>!value.records_json.includes('source_json')));
  assert.equal(await repo.append(1,event('lost',[row('history','orphan')])),false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_occurrences').get().n,6);
});

test('payload conflicts abort the complete event, checkpoint retirement and occurrence writes atomically',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db),records=[row('history','a')];
  const hash=JSON.parse(preparedRecordJSON(records,true))[0].__normalized_write_v1.hash;
  f.database.prepare('INSERT INTO service_record_payloads VALUES(?,?,?)').run('private:g0:'+hash,'private','{"kind":"history","record":{"wrong":true}}');
  await assert.rejects(repo.append(0,event('conflict',records)),/Conflicting normalized/);
  assert.equal((await repo.read()).revision,0);assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_occurrences').get().n,0);
});

test('trigger failure after extraction rolls back all evidence and preserves previous complete head',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);await repo.append(0,event('saved',[row('listing','old')]));
  const previous=await repo.read();
  f.database.exec("CREATE TRIGGER fail_normalized_insert AFTER INSERT ON service_record_occurrences WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(repo.append(1,event('failure',[row('history','new')])),/synthetic failure/);
  assert.deepEqual(await repo.read(),previous);assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_payloads').get().n,1);
  assert.equal(await repo.event('failure'),null);
});

test('compact writes require both trigger sets and cannot downgrade or reduce the reset floor',async t=>{
  const f=createPublicDatabase(t),repo=createCloudRepository(f.db);
  assert.equal(await repo.append(0,event('blocked',[row('listing','a')])),false);
  await installCompactOperationalStorage(f.db);assert.equal(await repo.append(0,event('still-blocked')),false);
  await installNormalizedRecordStorage(f.db);assert.equal(await repo.append(0,event('reset',[row('development_reset','reset',{})],state(1))),true);
  assert.equal(await repo.append(1,event('lower',[],state(0))),false);
  assert.equal(await repo.append(1,event('legacy',[],{version:2,job:null})),false);
  assert.equal((await repo.read()).revision,1);
});

test('repeat reset preserves historical traits and discards only the explicit reset evidence kinds',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);
  const traits=[row('metadata','meta'),row('ownership','owner'),row('collection','collection'),row('attribute','attribute')];
  await repo.append(0,event('first',[...traits,row('listing','old'),row('owned_status','status')]));
  const marker=row('development_reset','reset',{});await repo.append(1,event('reset',[marker],state(2)));
  assert.deepEqual(await repo.records(2),[...traits,marker]);
  await assert.rejects(repo.records(1),/reload saved data/);
  assert.deepEqual((await repo.event('first')).map(value=>value.kind),['metadata','ownership','collection','attribute','listing','owned_status']);
});

test('account and generation fences isolate payloads, reads, deletion, and recreation',async t=>{
  const f=await fixture(t),a=f.repository(101),b=f.repository(202),records=[row('history','same')];
  await a.append(0,event('same',records));await b.append(0,event('same',records));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_payloads').get().n,2);
  const stale=f.repository(101);await stale.read();
  let result=await a.deleteAccountData(1);while(result.pending_cleanup)result=await a.processAccountDeletion(1);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM service_record_payloads WHERE scope='public:101'").get().n,0);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM service_record_occurrences WHERE scope='public:101'").get().n,0);
  assert.deepEqual(await b.records(),records);await a.reactivateAccount();
  await assert.rejects(stale.records(),PublicAccountError);await assert.rejects(stale.append(0,event('stale',records)),PublicAccountError);
  const fresh=f.repository(101);assert.deepEqual(await fresh.records(),[]);await fresh.append(0,event('same',records));
  assert.ok(f.database.prepare("SELECT payload_id FROM service_record_payloads WHERE scope='public:101'").get().payload_id.startsWith('public:101:g2:'));
});

test('public quota includes normalized payloads and occurrences even after compact event bodies shrink',async t=>{
  const f=await fixture(t),repo=f.repository(101,{maxAccountBytes:12000,maxServiceBytes:24000});
  await repo.ensureAccount();f.database.prepare('INSERT INTO service_record_payloads VALUES(?,?,?)').run('public:101:g0:unreferenced','public:101','x'.repeat(12000));
  await assert.rejects(repo.append(0,event('over',[row('history','a')])),PublicStorageLimitError);
  assert.equal((await repo.read()).revision,0);assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_occurrences').get().n,0);
});

test('compact traversal rejects account replacement or a reset during the captured read',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);await repo.append(0,event('start',[row('metadata','meta'),row('history','one')]));
  let reset=false;await assert.rejects(repo.visitRecords(1,async()=>{if(!reset){reset=true;await repo.append(1,event('reset',[row('development_reset','reset',{})],state(2)));}}),/reload saved data/);
  const a=f.repository(101);await a.append(0,event('a',[row('listing','a')]));
  const reader=f.repository(101);await assert.rejects(reader.visitRecords(1,async()=>{await a.deleteAccountData();await a.reactivateAccount();}),PublicAccountError);
  const g=await fixture(t),unbounded=createCloudRepository(g.db);await unbounded.append(0,event('old',[row('history','old')]));
  await assert.rejects(unbounded.visitRecords(Number.MAX_SAFE_INTEGER,()=>unbounded.append(1,event('reset',[row('development_reset','reset',{})],state(2)))),/reload saved data/);
});

test('deduplication saves repeated large facts without truncating unknown evidence or losing occurrence dates',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db),source={identity:'gift',source_json:JSON.stringify({nested:'🦋'.repeat(8000),unknown:1})};
  for(let i=0;i<8;i++)await repo.append(i,event('page:'+i,[{...row('history','key:'+i,source),observed_at:new Date(Date.parse(at)+i*1000).toISOString()}]));
  const bytes=f.database.prepare("SELECT (SELECT SUM(length(CAST(document AS BLOB))) FROM service_record_payloads)+(SELECT SUM(length(CAST(envelope_json AS BLOB))) FROM service_record_occurrences)+(SELECT SUM(length(CAST(records_json AS BLOB))) FROM cloud_events) AS n").get().n;
  assert.ok(bytes<40000);assert.equal((await repo.records()).length,8);
  assert.equal((await repo.records())[7].observed_at,'2026-10-12T12:00:07.000Z');
});

test('fresh accounts opt into installed compact storage while existing legacy accounts remain unchanged',async t=>{
  const f=createPublicDatabase(t),legacy=f.repository(101);await legacy.append(0,event('legacy',[],{version:2,job:null}));
  await installCompactOperationalStorage(f.db);await installNormalizedRecordStorage(f.db);
  assert.equal((await legacy.read()).state.operational_storage_version,undefined);
  assert.equal((await f.repository(202).read()).state.operational_storage_version,1);
  assert.equal((await createCloudRepository(f.db).read()).state.operational_storage_version,1);
});

test('protected imported fields cannot impersonate storage envelopes or payload references',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db);
  const records=[{...row('settings','protected',{wallet:'real-wallet'}),__normalized_write_v1:{hash:'0'.repeat(64),document:{kind:'history',record:{forged:true}},envelope:{key:'forged'}},__normalized_record_v1:0},
    {...row('history','real',{unknown:true}),__normalized_write_v1:{hash:'spoof'},__normalized_record_v1:9}];
  assert.equal(await repo.append(0,event('safe',records)),true);
  assert.deepEqual(await repo.records(),records);assert.deepEqual(await repo.event('safe'),records);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_payloads').get().n,1);
});

test('owned-scope reads exclude unrelated normalized records while preserving source-only and conflicting variants',async t=>{
  const f=await fixture(t),repo=createCloudRepository(f.db),wanted='0:'+ '11'.repeat(32),other='0:'+ '22'.repeat(32);
  const records=[row('metadata','wanted',{identity:wanted,model:'old'}),row('metadata','conflict',{identity:wanted,model:'other'}),row('metadata','unrelated',{identity:other}),
    row('history','source-only',{source_json:JSON.stringify({address:wanted})}),row('owned_status','irrelevant',{identity:wanted})];
  await repo.append(0,event('scope',records));const result=[];await repo.visitOwnedScopeRecords(1,[wanted],page=>result.push(...page));
  assert.deepEqual(result,records.filter(value=>['wanted','conflict','source-only'].includes(value.key)));
});

test('atomic accounting matches physical normalized bytes and admission covers record and archive amplification',async t=>{
  const f=await fixture(t);let after=0;
  for(;;){const result=await installStorageAccounting(f.db,{after});if(result.complete)break;after=result.after;}
  let admitted=0;const admission={fence(bytes){admitted=bytes;return{sql:'1',parameters:{}};},async assertAdmitted(){}};
  const repo=createCloudRepository(f.db,{storageAdmission:admission}),value=state(),long='🦋'.repeat(200);
  value.owned_prices={version:2,next_run_id:3,run:{id:2,state:'completed',wallet:long,nft_address:long,session_id:'long-session-00000002'},
    previous_run:{id:1,state:'completed',wallet:long,nft_address:long,session_id:'long-session-00000001'},last_session:{id:'long-session-00000003',run_id:2}};
  const before=f.database.prepare('SELECT total_bytes FROM service_storage_usage WHERE id=1').get().total_bytes;
  await repo.append(0,event(long,Array.from({length:80},(_,i)=>row('history','key:'+i,{identity:'gift',unknown:long})),value));
  const tracked=f.database.prepare('SELECT total_bytes FROM service_storage_usage WHERE id=1').get().total_bytes;
  const actual=STORAGE_TABLES.reduce((total,table)=>total+f.database.prepare(`SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) AS bytes FROM ${table.name}`).get().bytes,0);
  assert.equal(tracked,actual);assert.ok(tracked-before<=admitted,`${tracked-before} persisted bytes exceeded ${admitted} admission`);
  const publicRepo=f.repository(101);await publicRepo.append(0,event('public',[row('history','a')]));
  const limited=f.repository(101,{maxAccountBytes:1000,maxServiceBytes:2000});
  await assert.rejects(limited.append(1,event('blocked',[row('history','b')])),PublicStorageLimitError);
  assert.equal((await publicRepo.read()).revision,1);
});

test('legacy owner migration fails closed before reserving an account for a compact source',async t=>{
  const f=await fixture(t);await createCloudRepository(f.db).append(0,event('compact',[row('history','one')]));
  await assert.rejects(migrateLegacyOwner(f.db,101,{mode:'apply',confirmOwnerId:101}),/Compact private storage/);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n,0);
});

for(const publicMode of [false,true])test(`${publicMode?'public':'private'} large compact checkpoints can stop at storage pause without increasing the fixed recovery budget`,async t=>{
  const f=await fixture(t);let after=0;
  for(;;){const result=await installStorageAccounting(f.db,{after});if(result.complete)break;after=result.after;}
  const MiB=1048576,scope=publicMode?'public:101':'private',admission=createStorageAdmission(f.db,{policy:{budgetBytes:32*MiB,reserveBytes:MiB}}).forScope(scope,{maxBytes:2*MiB});
  const repo=publicMode?f.repository(101,{storageAdmission:admission,maxAccountBytes:2*MiB,maxServiceBytes:16*MiB}):createCloudRepository(f.db,{storageAdmission:admission});
  const value=state();value.owned_prices={version:2,next_run_id:2,run:{id:1,state:'running',wallet:'wallet',targets:[{nft_address:'gift',large:'x'.repeat(400000)}]}};
  assert.equal(await repo.append(0,event('running',[],value)),true);
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run(31*MiB-65536);
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({paused:true}));
  if(publicMode)f.database.prepare('UPDATE service_storage_scope_usage SET total_bytes=? WHERE scope=?').run(2*MiB+131072,scope);
  const stopped=structuredClone(value);stopped.owned_prices.run.state='partial';stopped.owned_prices.run.reason='stopped_by_you';
  const inflated=structuredClone(stopped);inflated.unrelated='x'.repeat(300000);
  await assert.rejects(repo.append(1,event('inflated',[],inflated)),StorageCapacityError);
  assert.equal(await repo.append(1,event('stop',[],stopped)),true);
  assert.equal((await repo.read()).state.owned_prices.run.state,'partial');
  assert.ok(f.database.prepare('SELECT total_bytes FROM service_storage_usage WHERE id=1').get().total_bytes<31*MiB);
  await assert.rejects(repo.append(2,event('repeat',[],stopped)),StorageCapacityError);
});

for(const publicMode of [false,true])test(`${publicMode?'public':'private'} compact recovery credit is rechecked in the committing SQL and cannot include another job`,async t=>{
  const f=await fixture(t);let after=0;
  for(;;){const result=await installStorageAccounting(f.db,{after});if(result.complete)break;after=result.after;}
  const MiB=1048576,scope=publicMode?'public:101':'private',admission=createStorageAdmission(f.db,{policy:{budgetBytes:32*MiB,reserveBytes:MiB}}).forScope(scope,{maxBytes:3*MiB});
  let race=false;const table=publicMode?'public_cloud_events':'cloud_events';
  const db={...f.db,async run(sql,params){if(race&&sql.startsWith(`INSERT OR IGNORE INTO ${table}`)) {
    race=false;f.database.prepare(`UPDATE ${table} SET job_json=NULL WHERE sequence=1`).run();
  }return f.db.run(sql,params);}};
  const repo=publicMode?createPublicRepository(db,101,{storageAdmission:admission,maxAccountBytes:3*MiB,maxServiceBytes:16*MiB}):createCloudRepository(db,{storageAdmission:admission});
  const value=state();value.job={id:1,state:'running',streams:[{cursor:'x'.repeat(400000)}]};
  await repo.append(0,{...event('running',[],value),job:value.job});
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run(31*MiB-65536);
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({paused:true}));
  const stopped=structuredClone(value);stopped.job.state='failed';stopped.job.reason='credential_removed';
  // A same-size checkpoint with a different job cannot borrow the old job body.
  const foreign=structuredClone(stopped);foreign.job.id=2;
  await assert.rejects(repo.append(1,{...event('foreign',[],foreign),job:foreign.job}),StorageCapacityError);
  race=true;assert.equal(await repo.append(1,{...event('raced',[],stopped),job:stopped.job}),false);
  assert.equal((await repo.read()).revision,1);assert.equal(await repo.event('raced'),null);
  // Restoring the exact old job permits only the legitimate revocation.
  f.database.prepare(`UPDATE ${table} SET job_json=? WHERE sequence=1`).run(JSON.stringify(value.job));
  assert.equal(await repo.append(1,{...event('revoke',[],stopped),job:stopped.job}),true);
  assert.equal((await repo.read()).state.job.reason,'credential_removed');
});
