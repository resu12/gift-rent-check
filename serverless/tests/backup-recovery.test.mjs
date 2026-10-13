import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {captureDatabaseSnapshot} from '../tools/database-snapshot.mjs';
import {encryptBackup,decryptBackup,verifyBackupRecovery} from '../tools/backup-recovery.mjs';
import {installNormalizedRecordStorage} from '../tools/normalized-record-storage.mjs';
import {installCompactOperationalStorage} from '../tools/compact-operational-storage.mjs';
import {installStorageAccounting} from '../tools/storage-accounting.mjs';

test('encrypted full backup restores all tables, operational triggers, counters, tenant generations and tombstones in isolation',async t=>{
  const f=createPublicDatabase(t);await installNormalizedRecordStorage(f.db);await installCompactOperationalStorage(f.db);
  let progress={after:0};do{progress=await installStorageAccounting(f.db,{after:progress.after});}while(!progress.complete);
  await f.repository(101).append(0,{key:'first',state:(await f.repository(101).read()).state,records:[{kind:'history',key:'x',record:{price:'0.12',note:'private payload'}}],observed_at:'2026-10-12T00:00:00.000Z'});
  await f.repository(202).ensureAccount();
  f.database.prepare("UPDATE public_accounts SET status='deleted',generation=17,wallet_nonce_counter=29 WHERE user_id='202'").run();
  const before=f.database.prepare('SELECT total_bytes FROM service_storage_usage').get();
  const snapshot=await captureDatabaseSnapshot(f.db),key=randomBytes(32),archive=encryptBackup(snapshot,key,{appId:123,revision:104});
  assert.ok(!archive.bytes.includes(Buffer.from('private payload')));
  assert.equal(decryptBackup(archive.bytes,key).snapshot.tables.public_accounts[1][1],17);
  const verified=await verifyBackupRecovery(archive.bytes,key,{expectedAppId:123});
  assert.equal(verified.verified,true);assert.equal(verified.live_restore_performed,false);assert.equal(verified.nonce_rollback_safe_for_live_writes,false);
  assert.deepEqual(f.database.prepare('SELECT total_bytes FROM service_storage_usage').get(),before);
});

test('backup authentication rejects wrong key, truncation, corruption and wrong destination',async t=>{
  const f=createPublicDatabase(t),key=randomBytes(32),snapshot=await captureDatabaseSnapshot(f.db),{bytes}=encryptBackup(snapshot,key,{appId:123});
  assert.throws(()=>decryptBackup(bytes,randomBytes(32)));
  assert.throws(()=>decryptBackup(bytes.subarray(0,20),key));
  const corrupt=Buffer.from(bytes);corrupt[corrupt.length-20]^=1;assert.throws(()=>decryptBackup(corrupt,key));
  await assert.rejects(verifyBackupRecovery(bytes,key,{expectedAppId:456}),/another app/);
});

test('single-statement export sees changes before capture consistently and refuses excess size',async t=>{
  const f=createPublicDatabase(t);let changed=false,captures=0;
  const adapter={...f.db,async all(sql,args){if(sql.includes('backup_total_rows')){captures++;if(!changed){changed=true;f.database.prepare("INSERT INTO public_accounts VALUES('101',2,'deleted',1,2,33)").run();}}return f.db.all(sql,args);}};
  const snapshot=await captureDatabaseSnapshot(adapter);assert.equal(captures,1);assert.equal(snapshot.tables.public_accounts[0][5],33);
  f.database.prepare('INSERT INTO collector_state VALUES(1,1,?)').run('x'.repeat(3000));
  await assert.rejects(captureDatabaseSnapshot(f.db,{maxBytes:1024}),/bounded export/);
});

test('isolated verification rejects schema side effects and unsupported numeric precision',async t=>{
  const f=createPublicDatabase(t),snapshot=await captureDatabaseSnapshot(f.db),key=randomBytes(32);
  snapshot.schema[0].sql+="; ATTACH DATABASE 'never-create.db' AS malicious";
  await assert.rejects(verifyBackupRecovery(encryptBackup(snapshot,key,{appId:123}).bytes,key),/authorized/);
  const other=await captureDatabaseSnapshot(f.db);other.tables.collector_state.push([1,Number.MAX_SAFE_INTEGER+1,'{}']);
  await assert.rejects(verifyBackupRecovery(encryptBackup(other,key,{appId:123}).bytes,key),/Unsupported backup value/);
});

test('silent truncation and schema changes cannot produce a verified partial archive',async t=>{
  const f=createPublicDatabase(t);
  const truncated={...f.db,async all(sql,args){const rows=await f.db.all(sql,args);return sql.includes('backup_total_rows')?rows.slice(1):rows;}};
  await assert.rejects(captureDatabaseSnapshot(truncated),/truncated/);
  let changed=false;
  const migrated={...f.db,async all(sql,args){if(!changed&&sql.includes('backup_total_rows')){changed=true;f.database.exec('CREATE TABLE added_during_capture(id INTEGER PRIMARY KEY)');}return f.db.all(sql,args);}};
  await assert.rejects(captureDatabaseSnapshot(migrated),/schema changed/);
});
