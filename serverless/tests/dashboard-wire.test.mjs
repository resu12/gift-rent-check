import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeDashboardWire,DASHBOARD_WIRE_FORMAT,DASHBOARD_WIRE_LIMITS} from '../tgcloud/lib/bounded-response.js';
import {wireDashboardFixture} from './fixtures/dashboard-wire.mjs';

test('compact transport substantially reduces a production-like dashboard without mutating it',()=>{
  const original=wireDashboardFixture(),before=JSON.stringify(original),wire=encodeDashboardWire(original),encoded=JSON.stringify(wire);
  assert.equal(wire.encoding,DASHBOARD_WIRE_FORMAT);assert.equal(JSON.stringify(original),before);
  assert.ok(Buffer.byteLength(encoded)<Buffer.byteLength(before)*0.6,'repeated shapes and strings should save at least 40%');
  assert.ok(wire.shapes.length>0&&wire.strings.length>0);
  assert.ok(Buffer.byteLength(encoded)<=DASHBOARD_WIRE_LIMITS.wire_bytes);
});

test('encoder rejects cyclic, deeply nested and non-JSON object inputs within bounded work',()=>{
  const cyclic={};cyclic.self=cyclic;assert.throws(()=>encodeDashboardWire(cyclic));
  let deep=null;for(let i=0;i<66;i++)deep=[deep];assert.throws(()=>encodeDashboardWire(deep));
  assert.throws(()=>encodeDashboardWire(new Date()));assert.throws(()=>encodeDashboardWire({amount:1n}));
  assert.throws(()=>encodeDashboardWire({text:'x'.repeat(DASHBOARD_WIRE_LIMITS.string_length+1)}));
});

test('dictionary choice is deterministic and skips strings too short to save bytes',()=>{
  const value={rows:Array.from({length:20},()=>({name:'A',note:'A sufficiently long repeated string ✨'}))};
  const wire=encodeDashboardWire(value);assert.deepEqual(encodeDashboardWire(value),wire);
  assert.ok(!wire.strings.includes('A'));assert.ok(wire.strings.includes(value.rows[0].note));
});
