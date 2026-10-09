import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';

test('large imported chunks use bounded host reads and preserve records across sparse event sequences', async () => {
  const rows=Array.from({length:11},(_,i)=>({sequence:i*3+2,records_json:JSON.stringify([{kind:'listing',key:String(i),record:{source_json:'x'.repeat(230000)}}])}));
  const database=new DatabaseSync(':memory:');
  database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,records_json TEXT NOT NULL)');
  for(const row of rows) database.prepare('INSERT INTO cloud_events VALUES(?,?)').run(row.sequence,row.records_json);
  const calls=[];
  const repository=createCloudRepository({async all(sql,params){
    const limit=Number(/LIMIT (\d+)/.exec(sql)?.[1]);
    calls.push({after:params[':after'],limit});
    const batch=database.prepare(sql).all(params);
    assert.ok(batch.reduce((n,row)=>n+Buffer.byteLength(row.records_json),0)<=1048576,'each host result remains bounded by bytes as well as row count');
    return batch;
  }});
  const records=await repository.records();
  assert.deepEqual(records.map(record=>record.key),rows.map((_,i)=>String(i)));
  assert.deepEqual(calls.map(call=>call.after),[0,11,23,32]);
  assert.ok(calls.every(call=>call.limit===5));
  database.close();
});

test('an exact multiple of bounded chunks checks the following empty page',async()=>{
  let calls=0;
  const repository=createCloudRepository({async all(_sql,params){
    calls++;
    return params[':after']===0?Array.from({length:5},(_,i)=>({sequence:i+1,records_json:JSON.stringify([{key:String(i)}])})):[];
  }});
  assert.equal((await repository.records()).length,5);
  assert.equal(calls,2);
});

test('a legacy oversized first row advances alone and multibyte row budgets use UTF-8 bytes', async () => {
  const database = new DatabaseSync(':memory:'); database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,records_json TEXT NOT NULL)');
  const rows = ['x'.repeat(1100000), '🦋'.repeat(140000), '🦋'.repeat(140000)].map((value, i) => ({sequence: i + 1, records_json: JSON.stringify([{key: String(i), value}])}));
  for (const row of rows) database.prepare('INSERT INTO cloud_events VALUES(?,?)').run(row.sequence, row.records_json);
  const batches = []; const repository = createCloudRepository({async all(sql, params) {const batch = database.prepare(sql).all(params); batches.push(batch.map(row => row.sequence)); return batch;}});
  assert.deepEqual((await repository.records()).map(row => row.key), ['0', '1', '2']);
  assert.deepEqual(batches, [[1], [2], [3], []]); database.close();
});
