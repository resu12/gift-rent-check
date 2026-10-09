import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';

test('large imported chunks use bounded host reads and preserve records across sparse event sequences', async () => {
  const rows=Array.from({length:11},(_,i)=>({sequence:i*3+2,records_json:JSON.stringify([{kind:'listing',key:String(i),record:{source_json:'x'.repeat(230000)}}])}));
  const calls=[];
  const repository=createCloudRepository({async all(sql,params){
    const limit=Number(/LIMIT (\d+)/.exec(sql)?.[1]);
    calls.push({after:params[':after'],limit});
    const batch=rows.filter(row=>row.sequence>params[':after']).slice(0,limit);
    assert.ok(batch.reduce((n,row)=>n+row.records_json.length,0)<1500000,'each host result remains below the reproduced multi-megabyte timeout');
    return batch;
  }});
  const records=await repository.records();
  assert.deepEqual(records.map(record=>record.key),rows.map((_,i)=>String(i)));
  assert.deepEqual(calls.map(call=>call.after),[0,14,29]);
  assert.ok(calls.every(call=>call.limit===5));
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
