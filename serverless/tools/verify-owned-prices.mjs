// Uses official administrative CLI helpers; output is aggregate-only.
// --decoder: public saved fixtures, no database/provider access.
// --smoke: one bounded TON-only refresh of the existing owned portfolio.
// Otherwise: read existing price-refresh status only.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validateVerificationDestination} from './verify-deployment.mjs';
import {option, requireId} from './destination.mjs';

const OPERATION = `
import {ownedPrices} from '../lib/runtime.js';
import {createCloudRepository} from '../lib/cloud-repository.js';
import {db} from 'sdk';
export default async function(input,ctx) {
  const repository=createCloudRepository(db), before=await repository.read();
  if(!['start','step','getStatus'].includes(input.method)) throw new Error('Invalid diagnostic');
  const result=await ownedPrices[input.method](ctx,input.args||{});
  const reasons={};
  if(input.summary&&result.run) for(const envelope of await repository.records()) {
    if(envelope.kind==='owned_price'&&String(envelope.key).startsWith('owned-price:'+result.run.id+':')) {
      const reason=envelope.record.verified?'verified_contract_price':envelope.record.reason;
      reasons[reason]=(reasons[reason]||0)+1;
    }
  }
  const after=await repository.read();
  const market=s=>JSON.stringify({...s,owned_prices:undefined});
  return {...result,...(input.summary?{reasons}:{}),marketapp_unchanged:market(before.state)===market(after.state),
    ton_attempts:after.state.owned_prices?.run?.attempts??0,
    marketapp_attempts:after.state.attempts.length};
}`;
const DECODER = `
import {decodePriceContract} from '../lib/ton-price-decoder.js';
export default function(input) {
  let verified=0;
  for(let i=0;i<50;i++) {
    const s=input.samples[i%input.samples.length];
    const r=decodePriceContract(s.account,s.nft,s.wallet,s.observed_at);
    if(!r.verified||!r.code_hash_verified||!r.data_hash_verified||r.configured_price_per_day_raw!==s.amount) throw new Error('Decoder fixture mismatch');
    verified++;
  }
  return {verified,public_fixtures:input.samples.length,provider_requests:0,database_writes:0};
}`;

async function main() {
  const args=process.argv.slice(2);
  const appId=requireId(option(args,'--app-id'),'--app-id');
  const owner=Number(requireId(option(args,'--owner-id'),'--owner-id'));
  process.env.TGCLOUD_DEBUG='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const token=await resolveToken(); validateVerificationDestination(token,appId);
  const deployed=await getFiles(token), sources={...deployed.canonical_modules};
  const context={initData:{user:{id:owner}}};
  if(args.includes('--decoder')) {
    sources['lib/ton-price-decoder']=await readFile(new URL('../tgcloud/lib/ton-price-decoder.js',import.meta.url),'utf8');
    sources['endpoints/verifyOwnedPriceDecoder']=DECODER;
    const cases=JSON.parse(await readFile(new URL('../tests/fixtures/ton-price-parity.json',import.meta.url),'utf8')).cases.slice(0,4);
    const samples=await Promise.all(cases.map(async s=>({account:{...s.account,code_boc:(await readFile(new URL('../../tests/fixtures/ton/'+s.code_fixture,import.meta.url),'utf8')).trim()},nft:s.nft,wallet:s.wallet,observed_at:s.observed_at,amount:s.expected.configured_price_per_day_raw})));
    const response=await runFunction(token,'endpoints/verifyOwnedPriceDecoder',sources,{samples},context);
    if(response.result?.verified!==50) throw new Error('Decoder verification failed');
    console.log(JSON.stringify({...response.result,runtime_seconds:response.time})); return;
  }
  if(!sources['lib/owned-price-engine']) throw new Error('Owned-price refresh is not deployed');
  sources['endpoints/verifyOwnedPriceOperation']=OPERATION;
  const call=async(method,input={})=>{
    const response=await runFunction(token,'endpoints/verifyOwnedPriceOperation',sources,{method,args:input,summary:args.includes('--summary')},context);
    const result=response.result;
    if(!result||typeof result.marketapp_unchanged!=='boolean'||!Number.isFinite(result.server_time)) throw new Error('Invalid operation result');
    console.log(JSON.stringify({method,...result,runtime_seconds:response.time,deployed_revision:deployed.revision}));
    if(!result.marketapp_unchanged) throw new Error('Marketapp changed concurrently; check saved state');
    return result;
  };
  if(!args.includes('--smoke')) {await call('getStatus'); return;}
  const began=Date.now();
  let response=await call('start',{session_id:'smoke-'+randomUUID()});
  for(let step=0;step<60&&Date.now()-began<125000&&response.run?.state==='running';step++) {
    const delay=Math.max(0,response.next_allowed_at-response.server_time);
    if(delay>5000) {console.log(JSON.stringify({stopped:'provider_or_lease_wait',delay_ms:delay})); break;}
    if(delay) await new Promise(done=>setTimeout(done,delay));
    response=await call('step',{run_id:response.run.id});
  }
  console.log(JSON.stringify({finished:response.run?.state==='complete',elapsed_seconds:(Date.now()-began)/1000,ton_requests:response.ton_attempts,marketapp_requests:0}));
}
main().catch(error=>{
  const message=String(error?.message||'');
  console.error(JSON.stringify({verification_failed:true,type:/CPU timer exceeded/i.test(message)?'runtime_cpu_limit':/memory|heap/i.test(message)?'runtime_memory_limit':'operation_failed',status:Number.isInteger(error?.status)?error.status:null}));
  process.exitCode=1;
});
