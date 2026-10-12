import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {normalizedRecordStorageTriggers,upgradeNormalizedRecordStorage} from '../tools/normalized-record-storage.mjs';

test('only the known development trigger definitions can be upgraded; source data stays unchanged',async t=>{
  const f=createPublicDatabase(t);
  for(const trigger of normalizedRecordStorageTriggers()) {
    const old=trigger.sql.replace(/      SELECT CASE WHEN EXISTS\(SELECT 1 FROM json_each\(NEW.records_json\) j WHERE NOT COALESCE[\s\S]*?Unprepared normalized record envelope'\) END;\n/,'')
      .replace("          OR json_extract(j.value,'$.__normalized_write_v1.hash') GLOB '*[^0-9a-f]*'\n",'');
    assert.notEqual(old,trigger.sql);f.database.exec(old);
  }
  f.database.exec("INSERT INTO cloud_events(sequence,event_key,state_json,records_json,observed_at) VALUES(1,'kept','{}','[]','today')");
  await upgradeNormalizedRecordStorage(f.db);
  for(const trigger of normalizedRecordStorageTriggers())assert.equal(f.database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(trigger.name).sql,trigger.sql);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,1);
  await upgradeNormalizedRecordStorage(f.db);
});
test('an unknown installed trigger fails before any trigger is removed',async t=>{
  const f=createPublicDatabase(t);
  for(const trigger of normalizedRecordStorageTriggers())f.database.exec(trigger.sql.replace("Invalid normalized record envelope","unknown definition"));
  await assert.rejects(()=>upgradeNormalizedRecordStorage(f.db),/Unexpected/);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'normalized_records_v1_%'").get().n,2);
});
