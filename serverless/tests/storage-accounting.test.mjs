import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {installStorageAccounting,storageAccountingTriggers,installCheckpointSourceAccounting,checkpointSourceAccountingTriggers,installCompactStorageAccounting} from '../tools/storage-accounting.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

async function install(db) {let after=0,result;do {result=await installStorageAccounting(db,{after});after=result.after;}while(!result.complete);return result;}
function measured(database) {return STORAGE_TABLES.reduce((sum,table)=>sum+database.prepare(`SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) AS bytes FROM ${table.name}`).get().bytes,0);}
const eventSql="INSERT INTO cloud_events(sequence,event_key,state_json,records_json,raw_body,observed_at) VALUES(1,'e','{}','[]','€🙂','2026-10-11')";

test('compact-table accounting upgrades an existing baseline without recounting or losing bytes',async t=>{
  const {database,db}=createPublicDatabase(t);await install(db);database.exec(eventSql);
  const added=new Set(['service_record_payloads','service_record_occurrences','gift_refresh_runs']);
  for(const trigger of storageAccountingTriggers().filter(item=>added.has(item.table))) database.exec(`DROP TRIGGER ${trigger.name}`);
  const before=database.prepare('SELECT * FROM service_storage_usage').get();
  await installCompactStorageAccounting(db);
  assert.deepEqual(database.prepare('SELECT * FROM service_storage_usage').get(),before);
  database.exec("INSERT INTO service_record_payloads VALUES('payload','public:123','{\"kind\":\"history\"}')");
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured(database));
  assert.ok(database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:123'").get().total_bytes>0);
  await installCompactStorageAccounting(db);
});

test('compact accounting fails closed when an unaccounted new table already contains data',async t=>{
  const {database,db}=createPublicDatabase(t);await install(db);
  for(const trigger of storageAccountingTriggers().filter(item=>item.table==='gift_refresh_runs')) database.exec(`DROP TRIGGER ${trigger.name}`);
  database.exec("INSERT INTO gift_refresh_runs VALUES(1,'{}',1)");
  await assert.rejects(()=>installCompactStorageAccounting(db),/Unaccounted/);
});

test('fixed descriptors cover every persisted source column and exclude accounting metadata',t=>{
  const {database}=createPublicDatabase(t);
  for(const table of STORAGE_TABLES)assert.deepEqual(table.columns,[...database.prepare(`PRAGMA table_info(${table.name})`).all()].map(row=>row.name));
  assert.equal(storageAccountingTriggers().length,STORAGE_TABLES.length*3);
  assert.equal(new Set(storageAccountingTriggers().map(row=>row.name)).size,STORAGE_TABLES.length*3);
  assert.equal(STORAGE_TABLES.some(table=>table.name.startsWith('service_storage_')),false);
});
test('bootstrap activates only after all bounded trigger batches and measures old data once',async t=>{
  const {database,db,queries}=createPublicDatabase(t);database.exec(eventSql);
  const first=await installStorageAccounting(db);assert.equal(first.complete,false);assert.equal(first.after,6);
  assert.equal(database.prepare('SELECT initialized_at FROM service_storage_usage').get().initialized_at,0);
  database.exec("UPDATE cloud_events SET raw_body=raw_body||'during-install'");
  const result=await install(db);assert.equal(result.total_bytes,measured(database));
  const ready=database.prepare('SELECT * FROM service_storage_usage').get();assert.ok(ready.initialized_at>0);
  assert.equal(database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='private'").get().total_bytes,ready.total_bytes);
  const queryCount=queries.length;await installStorageAccounting(db);
  assert.equal(queries.slice(queryCount).some(query=>query.sql.includes('SUM(')),false);
});
test('all committed insert/update/delete changes adjust counters in the source transaction',async t=>{
  const {database,db}=createPublicDatabase(t);await install(db);database.exec(eventSql);
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured(database));
  database.exec("UPDATE cloud_events SET raw_body='short',state_json='{\"test\":123}'");
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured(database));
  const before=measured(database);database.exec("BEGIN;UPDATE cloud_events SET raw_body='uncommitted data';ROLLBACK;");
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,before);
  database.exec('DELETE FROM cloud_events');assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,0);
});
test('tenant moves remain isolated; shared gates and private rows still count globally',async t=>{
  const {database,db}=createPublicDatabase(t);await install(db);
  database.exec("INSERT INTO public_accounts(user_id,created_at) VALUES('123',1),('456',1)");
  database.exec("INSERT INTO public_cloud_events VALUES('123:1','123',1,'e','{}',NULL,NULL,'[]',NULL,'today')");
  const own=scope=>database.prepare('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=?').get(scope).total_bytes;
  const a=own('public:123'),b=own('public:456');
  database.exec("UPDATE public_cloud_events SET user_id='456'");assert.ok(own('public:123')<a);assert.ok(own('public:456')>b);
  database.exec("INSERT INTO marketapp_website_requests VALUES('req','public:123',1)");
  assert.ok(own('shared')>0);assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured(database));
  const sum=database.prepare('SELECT SUM(total_bytes) AS total FROM service_storage_scope_usage').get().total;
  assert.equal(sum,measured(database));
});
test('repair is explicit and unknown or malicious installer arguments cannot publish readiness',async t=>{
  const {database,db}=createPublicDatabase(t);
  await assert.rejects(()=>installStorageAccounting(db,{after:-1}));await assert.rejects(()=>installStorageAccounting(db,{limit:7}));
  await assert.rejects(()=>installStorageAccounting(db,{after:STORAGE_TABLES.length*3}),/incomplete/);
  await install(db);database.exec(`DROP TRIGGER ${storageAccountingTriggers()[0].name}`);
  await assert.rejects(()=>install(db),/repair/);
});

test('source-pin accounting upgrades the live empty additive table without resetting historical counters',async t=>{
  const {database,db,queries}=createPublicDatabase(t);await install(db);database.exec(eventSql);
  for(const trigger of storageAccountingTriggers().filter(trigger=>trigger.table==='service_checkpoint_sources'))database.exec(`DROP TRIGGER ${trigger.name}`);
  const before=database.prepare('SELECT * FROM service_storage_usage').get(),start=queries.length;
  const result=await installCheckpointSourceAccounting(db);assert.equal(result.usage_trigger_count,STORAGE_TABLES.length*3);
  assert.deepEqual(database.prepare('SELECT * FROM service_storage_usage').get(),before);
  assert.ok(!queries.slice(start).some(query=>/^UPDATE service_storage_(?:usage|scope_usage) SET/.test(query.sql)));
  database.exec(`INSERT INTO service_checkpoint_sources VALUES('pin','public:123','owned_targets',1)`);
  assert.equal(database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured(database));
  const scoped=database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope='public:123'").get().total_bytes;
  const bytes=database.prepare(`SELECT ${storageTableByteExpression('service_checkpoint_sources')} AS bytes FROM service_checkpoint_sources`).get().bytes;
  assert.equal(scoped,bytes);assert.equal(database.prepare("SELECT count(*) AS n FROM service_storage_scope_usage WHERE scope='public:public:123'").get().n,0);
  await installCheckpointSourceAccounting(db);
});

test('upgrade refuses unaccounted pins and active pin triggers while counter triggers are missing',async t=>{
  const {database,db}=createPublicDatabase(t);await install(db);
  for(const trigger of storageAccountingTriggers().filter(trigger=>trigger.table==='service_checkpoint_sources'))database.exec(`DROP TRIGGER ${trigger.name}`);
  database.exec("INSERT INTO service_checkpoint_sources VALUES('unaccounted','private','owned_targets',1)");
  await assert.rejects(()=>installCheckpointSourceAccounting(db),/repair/);
  database.exec('DELETE FROM service_checkpoint_sources');
  database.exec(checkpointSourceAccountingTriggers()[0].sql);
  await assert.rejects(()=>installCheckpointSourceAccounting(db),/Active source pins require accounting repair/);
  assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'storage_usage_v1_service_checkpoint_sources_%'").get().count,0);
});
