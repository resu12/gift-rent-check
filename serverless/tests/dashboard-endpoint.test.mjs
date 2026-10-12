import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DASHBOARD_WIRE_FORMAT,encodeDashboardWire} from '../tgcloud/lib/bounded-response.js';

function endpoint(invokeCloud,encode=encodeDashboardWire) {
  const source=readFileSync(new URL('../tgcloud/endpoints/getDashboard.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/gm,'').replace('export default async function','return async function');
  return new Function('invokeCloud','DASHBOARD_WIRE_FORMAT','encodeDashboardWire',source)(invokeCloud,DASHBOARD_WIRE_FORMAT,encode);
}
test('dashboard wire format is explicit, strips only its transport option and preserves caller context',async()=>{
  const ctx={initData:{user:{id:123}}},selection={source:'rentals',timeframe:'30d'},data={gifts:[{id:'one',current_rental_started_at:null,last_verified_rental_started_at:'2026-10-12T05:33:18Z'}]};
  let calls=0;
  const read=endpoint(async(name,input,caller)=>{calls++;assert.equal(name,'getDashboard');assert.deepEqual(input,selection);assert.equal(caller,ctx);return data;});
  assert.equal(await read(selection,ctx),data);
  const input={...selection,response_format:DASHBOARD_WIRE_FORMAT};
  assert.deepEqual(await read(input,ctx),encodeDashboardWire(data));
  assert.equal(input.response_format,DASHBOARD_WIRE_FORMAT);assert.equal(calls,2);
});
test('read errors remain plain and authorization failures are not caught by optional compaction',async()=>{
  const error={error:{code:'READ_BUSY'}},input={response_format:DASHBOARD_WIRE_FORMAT};
  assert.equal(await endpoint(async()=>error,()=>assert.fail('must not encode an error'))(input,{}),error);
  const refused=Error('synthetic access refusal');
  await assert.rejects(endpoint(async()=>{throw refused;})(input,{}),error=>error===refused);
});
test('plain response remains available for legacy shapes outside optional compaction limits',async()=>{
  const data={gifts:[]};let calls=0;
  const read=endpoint(async()=>{calls++;return data;},()=>{throw Error('synthetic codec limit');});
  assert.equal(await read({response_format:DASHBOARD_WIRE_FORMAT},{}),data);assert.equal(calls,1);
});
test('non-object input remains subject to the original endpoint validation',async()=>{
  for(const input of [undefined,null,1,'invalid',[]]) {
    const read=endpoint(async(name,received)=>{assert.equal(received,input);return {error:{code:'INVALID_INPUT'}};});
    assert.deepEqual(await read(input,{}),{error:{code:'INVALID_INPUT'}});
  }
});
