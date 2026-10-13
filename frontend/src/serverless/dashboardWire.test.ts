import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDashboardWire,DASHBOARD_WIRE_FORMAT,DASHBOARD_WIRE_LIMITS} from './dashboardWire.ts';
import {createCloudDashboardAdapter} from './cloudAdapter.ts';
import type {CloudTransport,CloudEndpoint} from './cloudTransport.ts';
import type {Dashboard} from '../data/types.ts';
const {encodeDashboardWire,DASHBOARD_WIRE_LIMITS:encoderLimits}=await import(new URL('../../../serverless/tgcloud/lib/bounded-response.js',import.meta.url).href);
const {wireDashboardFixture}=await import(new URL('../../../serverless/tests/fixtures/dashboard-wire.mjs',import.meta.url).href);
const wire=(data:unknown,shapes:unknown[]=[],strings:unknown[]=[])=>({encoding:DASHBOARD_WIRE_FORMAT,shapes,strings,data});

test('frontend and backend roundtrip every dashboard field, proof, decimal, timestamp and sort key',()=>{
  assert.deepEqual(DASHBOARD_WIRE_LIMITS,encoderLimits);
  const original=wireDashboardFixture(),transported=JSON.parse(JSON.stringify(encodeDashboardWire(original)));
  assert.deepEqual(decodeDashboardWire(transported),original);
});

test('tags are unambiguous for nested arrays and Unicode/escape/numeric edge values',()=>{
  const original={text:'nul\u0000\b\t\n\f\r"\\ 雪 😀 \ud800 \udc00',timestamp:'2026-10-12T06:00:00.123456Z',
    prices:['0.100000000',0,-123.5,1e-300,Number.MAX_VALUE,9007199254740991],
    tags:[[0],[1,0],[2,0],[[2,9]]],objects:[{},[],null,true,false],order:{z:1,a:2}};
  const decoded=decodeDashboardWire(JSON.parse(JSON.stringify(encodeDashboardWire(original)))) as typeof original;
  assert.deepEqual(decoded,original);assert.deepEqual(Object.keys(decoded.order),['z','a']);
});

test('encoder retains ordinary JSON serialization semantics for undefined slots and nonfinite numbers',()=>{
  const original={gone:undefined,array:[undefined,NaN,Infinity,-Infinity,-0],nil:null};
  assert.deepEqual(decodeDashboardWire(encodeDashboardWire(original)),JSON.parse(JSON.stringify(original)));
});

test('prototype-like own keys remain ordinary data without polluting inherited properties',()=>{
  const original=JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"own","safe":1}');
  const decoded=decodeDashboardWire(encodeDashboardWire(original)) as Record<string,unknown>;
  assert.deepEqual(decoded,original);assert.equal(Object.getPrototypeOf(decoded),Object.prototype);
  assert.ok(Object.hasOwn(decoded,'__proto__'));assert.equal(({} as {polluted?:boolean}).polluted,undefined);
});

test('decoder rejects malformed tags, references, shapes, envelopes and non-JSON numbers',()=>{
  const invalid=[null,{},wire({}),wire([]),wire([3]),wire([0,undefined]),wire([2]),wire([2,0]),wire([2,-1]),
    wire([2,0,1],[],['saved']),wire([1,0]),wire([1,0], [['one']]),wire([1,0,4,5],[['one']]),
    wire([1,0,1,2],[['duplicate','duplicate']]),wire([1,0],[[1]]),wire([2,0],[],[9]),
    wire(Infinity),wire(NaN),wire([1,0.5],[[]]),{...wire(null),encoding:'unknown'}, {...wire(null),extra:true}];
  for(const value of invalid)assert.throws(()=>decodeDashboardWire(value),/Invalid compact dashboard/);
});

test('dictionary expansion, nesting, cycles and oversized tables fail before unbounded allocation',()=>{
  const repeated=[0,...Array.from({length:13},()=>[2,0])];
  assert.throws(()=>decodeDashboardWire(wire(repeated,[],['x'.repeat(2097152)])),/Invalid compact dashboard/);
  let deep:unknown=null;for(let i=0;i<66;i++)deep=[0,deep];assert.throws(()=>decodeDashboardWire(wire(deep)));
  const cyclic:unknown[]=[0];cyclic.push(cyclic);assert.throws(()=>decodeDashboardWire(wire(cyclic)));
  assert.throws(()=>decodeDashboardWire(wire(null,Array.from({length:4097},()=>[]))));
  assert.throws(()=>decodeDashboardWire(wire(null,[],Array.from({length:16385},()=>''))));
  assert.throws(()=>decodeDashboardWire(wire([1,0], [['x'.repeat(1025)]])));
  assert.throws(()=>decodeDashboardWire(wire([0,...Array.from({length:100001},()=>null)])));
});

test('empty dictionaries and scalar root payloads roundtrip without coercion',()=>{
  for(const value of [null,false,0,'',[],{},'é雪😀'])assert.deepEqual(decodeDashboardWire(encodeDashboardWire(value)),value);
});

function adapterFixture(generation=7):Dashboard {
  const data=wireDashboardFixture(3);
  return {...data,generated_at:data.saved_at,summary:{portfolio:3},activity:[],coverage:{},runs:[],review:[],
    capabilities:{public_account:true,account_generation:generation},
    gifts:data.gifts.map((gift:Record<string,unknown>,index:number)=>({...gift,id:`gift-${index}`,uncertainties:[],
      status_checked_at:'2026-10-12T06:00:00.123456Z',price_checked_at:'2026-10-12T06:00:01.123456Z',
      last_verified_rental_started_at:'2026-10-11T03:04:05.000000Z',last_verified_rental_start_source:'verified_contract'}))} as unknown as Dashboard;
}
const mockTransport=(call:(name:CloudEndpoint,input:Record<string,unknown>)=>unknown):CloudTransport=>({
  async call<T>(name:CloudEndpoint,input:Record<string,unknown>={}){return call(name,input) as T;},
});

test('adapter requests compact transport and produces the same dashboard as legacy plain JSON',async()=>{
  const source=adapterFixture(),seen:unknown[]=[],requests:Record<string,unknown>[]=[];
  const compact=createCloudDashboardAdapter(mockTransport((name,input)=>{
    assert.equal(name,'getDashboard');requests.push(input);return encodeDashboardWire(source);
  }),{onDashboardLoaded:data=>seen.push(data)});
  const legacy=createCloudDashboardAdapter(mockTransport(()=>structuredClone(source)));
  const selection={source:'rentals' as const,timeframe:'30d' as const};
  const result=await compact.getDashboard(selection);
  assert.deepEqual(result,await legacy.getDashboard(selection));assert.deepEqual(seen,[source]);
  assert.deepEqual(requests,[{pricing_source:'rentals',timeframe:'30d',response_format:DASHBOARD_WIRE_FORMAT}]);
  assert.equal(result.gifts[0].last_verified_rental_started_at,source.gifts[0].last_verified_rental_started_at);
  assert.equal(result.gifts[0].price_checked_at,source.gifts[0].price_checked_at);
  assert.equal(result.gifts[0].status_checked_at,source.gifts[0].status_checked_at);
});

test('adapter rejects malformed compact responses and still fences account-generation rollback',async()=>{
  let response:unknown=encodeDashboardWire(adapterFixture());const seen:Dashboard[]=[];
  const adapter=createCloudDashboardAdapter(mockTransport(()=>response),{onDashboardLoaded:data=>seen.push(data)});
  const selection={source:'rentals' as const,timeframe:'30d' as const};
  await adapter.getDashboard(selection);
  response=wire([1,999]);await assert.rejects(adapter.getDashboard(selection),/unexpected dashboard/);
  for(const scalar of [null,false,1,'wrong root']) {
    response=encodeDashboardWire(scalar);await assert.rejects(adapter.getDashboard(selection),/unexpected dashboard/);
  }
  response=encodeDashboardWire(adapterFixture(6));await assert.rejects(adapter.getDashboard(selection),/account changed/);
  assert.equal(seen.length,1,'malformed and stale compact responses are never accepted as dashboard updates');
});

test('startup previews use the compact authenticated dashboard path with the same account checks',async()=>{
  const source={...adapterFixture(),startup_preview:{generated_at:'2026-10-13T00:00:00Z'}},requests:Record<string,unknown>[]=[];
  let response:unknown=encodeDashboardWire(source);
  const adapter=createCloudDashboardAdapter(mockTransport((name,input)=>{assert.equal(name,'getDashboard');requests.push(input);return response;}));
  const selection={source:'rentals' as const,timeframe:'30d' as const};
  assert.deepEqual((await adapter.getStartupDashboard!(selection)).startup_preview,source.startup_preview);
  assert.equal(requests[0].startup,true);assert.equal(requests[0].response_format,DASHBOARD_WIRE_FORMAT);
  response=encodeDashboardWire({...adapterFixture(6),startup_preview:source.startup_preview});
  await assert.rejects(adapter.getStartupDashboard!(selection),/account changed/);
  response=encodeDashboardWire({...source,startup_preview:{generated_at:'not a date'}});
  await assert.rejects(adapter.getStartupDashboard!(selection),/unexpected saved dashboard/);
});


test('an aborted startup transport cannot advance account context or notify loaded data',async()=>{
  const seen:Dashboard[]=[], controller=new AbortController();
  const adapter=createCloudDashboardAdapter(mockTransport(()=>{controller.abort();return encodeDashboardWire(adapterFixture(9));}),{onDashboardLoaded:data=>seen.push(data)});
  const selection={source:'rentals' as const,timeframe:'30d' as const};
  await assert.rejects(adapter.getStartupDashboard!(selection,controller.signal),{name:'AbortError'});
  assert.equal(seen.length,0);
});
