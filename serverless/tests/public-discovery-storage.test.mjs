import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createPublicDiscoveryEngine} from '../tgcloud/lib/public-discovery.js';
import {createPublicAccountEngine} from '../tgcloud/lib/public-account.js';
import {createPublicCredentialBox} from '../tgcloud/lib/public-credential-box.js';
import {PublicCredentialChangedError,PublicStorageLimitError} from '../tgcloud/lib/public-repository.js';

const address=n=>`0:${n.toString(16).padStart(64,'0')}`;
const wallet=address(1),collection=address(2),ctx={initData:{user:{id:123}}};
const response=value=>({status:200,headers:{get:()=>null},body:{async *[Symbol.asyncIterator](){yield new TextEncoder().encode(JSON.stringify(value));}}});
async function fixture(t,{gifts=161,historical=0,repositoryOptions={}}={}) {
  const f=createPublicDatabase(t),repository=f.repository(123,repositoryOptions);
  let at=Date.parse('2026-10-10T12:00:00Z'),requests=0;
  const items=Array.from({length:gifts},(_,n)=>({address:address(1000+n),owner_address:wallet,collection_address:collection,init:true,
    last_transaction_lt:'100',content:{name:`Gift #${n}`,image:`https://images.example/gift-${n}.png`,attributes:[{trait_type:'Model',value:'Let Me Ride'},{trait_type:'Backdrop',value:'Black'}]}}));
  await repository.append(0,{key:'verified',state:{version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0},records:[{kind:'settings',record:{wallet,wallet_verification:'ton_proof',wallet_verified_at:new Date(at).toISOString()}}],observed_at:new Date(at).toISOString()});
  const account=createPublicAccountEngine({repository,box:createPublicCredentialBox('11'.repeat(32)),clock:()=>at});
  await account.saveMarketappApiKey(ctx,{api_key:'synthetic-own-key'});
  const engine=createPublicDiscoveryEngine({repository,ownerTelegramId:123,marketappToken:'synthetic-own-key',enabled:true,clock:()=>at,fetch:async url=>{
    requests++;const parsed=new URL(url),ids=parsed.searchParams.getAll('address');
    if(parsed.hostname==='api.marketapp.org')return response([{address:collection,name:'Test',extra_data:{}}]);
    if(parsed.pathname.endsWith('/items'))return response({nft_items:ids.length?items.filter(item=>ids.includes(item.address))
      :items.slice(Number(parsed.searchParams.get('offset')),Number(parsed.searchParams.get('offset'))+50)});
    const end=Number(parsed.searchParams.get('end_lt')??'10000'),offset=Number(parsed.searchParams.get('offset')),first=10000-end+offset;
    return response({nft_transfers:Array.from({length:Math.max(0,Math.min(50,historical-first))},(_,index)=>({nft_address:address(100000+first+index),old_owner:wallet,
      new_owner:address(9),nft_collection:collection,transaction_lt:String(10000-first-index),transaction_aborted:false}))});
  }});
  async function scan(){const started=await engine.startJob(ctx,{kind:'discover'});for(let step=0;step<1000;step++){
    at+=1100;const saved=await repository.read();if(saved.state.job.state==='complete')return saved.state.job;
    if(saved.state.job.state==='partial')await engine.resumeJob(ctx,{job_id:started.job.id});
    await engine.stepJob(ctx,{job_id:started.job.id});
  }assert.fail('scan did not complete');}
  const stats=()=>f.database.prepare(`SELECT count(*) AS events,SUM(length(CAST(state_json AS BLOB))+COALESCE(length(CAST(job_json AS BLOB)),0)
    +length(CAST(records_json AS BLOB))+COALESCE(length(CAST(raw_body AS BLOB)),0)) AS bytes,
    SUM(CASE WHEN raw_body IS NOT NULL THEN 1 ELSE 0 END) AS raw FROM public_cloud_events WHERE user_id='123'`).get();
  return {...f,repositoryFor:f.repository,repository,account,engine,scan,stats,now:()=>at,advance:ms=>{at+=ms;},requests:()=>requests};
}
test('candidate deltas retain every page occurrence and three 250-gift snapshots inside the data allowance',async t=>{
  const f=await fixture(t,{gifts:250});
  for(let i=1;i<=3;i++) {
    const job=await f.scan();assert.equal(job.verified,250);assert.equal(Object.keys(job.candidates).length,250);
    assert.equal(f.stats().raw,0);assert.ok(f.stats().bytes<8388608);
    assert.equal((await f.repository.job(i)).candidates[address(1000)].prior.is_portfolio,true);
  }
  const records=await f.repository.records();assert.equal(records.filter(value=>value.kind==='ownership').length,750);
  assert.equal(records.filter(value=>value.kind==='portfolio').length,750);
  assert.equal((await f.repository.jobs()).length,3);
  const physical=f.database.prepare("SELECT job_json FROM public_cloud_events WHERE user_id='123' AND job_id=3 ORDER BY sequence DESC LIMIT 1").get();
  assert.ok(!Object.hasOwn(JSON.parse(physical.job_json),'candidates'));
});
test('completed checkpoint maintenance is bounded, preserves final jobs/raw/history and never alters another tenant',async t=>{
  const f=await fixture(t,{gifts:161});await f.scan();const before=f.stats(),job=await f.repository.job(1),records=await f.repository.records();
  const other=f.repositoryFor(456);await other.append(0,{key:'other',state:{version:2,job:null},records:[{kind:'listing',record:{name:'other'}}],raw_body:'other-raw',observed_at:new Date(f.now()).toISOString()});
  const otherBefore=f.database.prepare("SELECT * FROM public_cloud_events WHERE user_id='456'").all();
  for(let i=0;i<10;i++){const changed=await f.repository.compactCompletedDiscoveryCheckpoints(25);assert.ok(changed<=26);if(!changed)break;}
  assert.ok(f.stats().bytes<before.bytes);assert.equal(f.stats().raw,before.raw);assert.deepEqual(await f.repository.job(1),job);
  assert.deepEqual((await f.repository.read()).state.job,job);assert.deepEqual(await f.repository.records(),records);
  assert.deepEqual(f.database.prepare("SELECT * FROM public_cloud_events WHERE user_id='456'").all(),otherBefore);
  assert.equal((await f.scan()).verified,161,'fresh run still reconstructs verified membership');
});
test('eventual evidence storage limit is recoverable without corrupting snapshots or retaining the API key',async t=>{
  const f=await fixture(t,{gifts:250});let completed=0,limited=false;
  for(let i=0;i<10;i++) {
    try{await f.scan();completed++;}catch(error){assert.ok(error instanceof PublicStorageLimitError);limited=true;break;}
  }
  assert.ok(completed>=3);assert.equal(limited,true,'retained raw evidence remains subject to the fixed data cap');
  const saved=await f.repository.read(),raw=f.stats().raw;
  assert.ok(f.stats().bytes<=8388608);assert.equal((await f.repository.job(1)).verified,250);
  const stopped=await f.engine.stopJob(ctx,{job_id:saved.state.job.id});assert.equal(stopped.job.state,'partial');
  assert.equal((await f.account.removeMarketappApiKey(ctx)).account.marketapp_key.configured,false);
  assert.equal(f.stats().raw,raw);assert.equal((await f.repository.read()).state.job.reason,'credential_removed');
  assert.equal((await f.repository.records()).filter(value=>value.kind==='ownership').filter(value=>value.key.startsWith('discovery-ownership:1:')).length,250);
});
test('the full 1000-candidate allowance fits and resumes with immutable catalog and evidence',async t=>{
  const f=await fixture(t,{gifts:250,historical:750}),job=await f.scan();
  assert.equal(job.verified,250);assert.equal(job.unresolved,750);assert.equal(Object.keys(job.candidates).length,1000);
  assert.equal(job.enumeration_complete,true);assert.ok(f.stats().bytes<8388608);assert.equal(f.stats().raw,0);
  const saved=await f.repository.read();assert.deepEqual((await f.repository.job(job.id)),saved.state.job);
  assert.deepEqual(saved.state.job.catalog,[collection]);assert.equal((await f.repository.records()).filter(value=>value.kind==='ownership').length,1000);
  const second=await f.engine.startJob(ctx,{kind:'discover'});
  for(let i=0;i<6;i++){f.advance(1100);await f.engine.stepJob(ctx,{job_id:second.job.id});}
  const continuing=(await f.repository.read()).state.job;assert.equal(continuing.id,2);assert.equal(Object.keys(continuing.candidates).length,250);
  assert.ok(continuing.verified>0);assert.equal(continuing.candidates[address(1000)].prior.is_portfolio,true);
  assert.deepEqual(continuing.catalog,[collection]);assert.equal(f.stats().raw,0);
});
test('discovery references cannot read another account candidate or catalog evidence',async t=>{
  const f=await fixture(t,{gifts:1});await f.scan();await f.repositoryFor(456).ensureAccount();
  const latest=f.database.prepare("SELECT * FROM public_cloud_events WHERE user_id='123' ORDER BY sequence DESC LIMIT 1").get();
  f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('foreign','456',latest.sequence,'forged',latest.state_json,latest.job_id,latest.job_json,'[]',null,latest.observed_at);
  await assert.rejects(f.repositoryFor(456).read(),/Missing discovery/);
});
test('stop and immediate key revocation remain available at a full account and service data quota',async t=>{
  const f=await fixture(t,{gifts:1,repositoryOptions:{maxAccountBytes:10000,maxServiceBytes:10000}});
  const started=await f.engine.startJob(ctx,{kind:'discover'}),saved=await f.repository.read();
  const remaining=10000-f.stats().bytes;
  f.database.prepare("UPDATE public_cloud_events SET raw_body=? WHERE user_id='123' AND sequence=?").run('x'.repeat(remaining),saved.revision);
  await assert.rejects(f.repository.append(saved.revision,{key:'oversized',state:saved.state,job:saved.state.job,records:[],observed_at:new Date(f.now()).toISOString()}),PublicStorageLimitError);
  const stop=await f.engine.stopJob(ctx,{job_id:started.job.id});assert.equal(stop.job.state,'partial');assert.equal(stop.job.stop_requested,true);
  assert.ok((await f.repository.read()).revision>saved.revision,'control advances the CAS fence');
  assert.equal((await f.account.removeMarketappApiKey(ctx)).account.marketapp_key.configured,false);
  assert.equal((await f.repository.read()).state.job.reason,'credential_removed');
  assert.equal(f.database.prepare("SELECT SUM(length(raw_body)) AS bytes FROM public_cloud_events WHERE user_id='123'").get().bytes,remaining);
  await assert.rejects(f.repository.append((await f.repository.read()).revision,{key:'still-full',state:(await f.repository.read()).state,records:[{kind:'listing',record:{}}],observed_at:new Date(f.now()).toISOString()}),PublicStorageLimitError);
});
test('revoking a key cancels a running leased discovery and fences its old credential worker without waiting',async t=>{
  const f=await fixture(t,{gifts:1}),row=await f.repository.credentialStatus('marketapp');
  const worker=f.repositoryFor(123,{credentialFence:{provider:'marketapp',credential_version:row.credential_version,fingerprint:row.credential_fingerprint}});
  await f.engine.startJob(ctx,{kind:'discover'});const saved=await f.repository.read();saved.state.job.lease='old-request';saved.state.job.lease_until=f.now()+120000;
  await f.repository.append(saved.revision,{key:'leased',state:saved.state,job:saved.state.job,records:[],observed_at:new Date(f.now()).toISOString()});
  await worker.read();const before=f.requests();assert.equal((await f.account.removeMarketappApiKey(ctx)).account.marketapp_key.configured,false);
  assert.equal(f.requests(),before);assert.equal((await f.repository.read()).state.job.state,'failed');
  await assert.rejects(worker.read(),PublicCredentialChangedError);
});
test('owned-gift stop has its own recovery gate when a Marketapp job is already stopped at quota',async t=>{
  const f=await fixture(t,{gifts:1,repositoryOptions:{maxAccountBytes:10000,maxServiceBytes:10000}});
  const saved=await f.repository.read();saved.state.job={id:1,kind:'prices',state:'partial',reason:'stopped_by_you'};
  saved.state.owned_prices={run:{id:1,state:'running',reason:null,targets:[],pending:[]}};
  await f.repository.append(saved.revision,{key:'parallel-work',state:saved.state,job:saved.state.job,records:[],observed_at:new Date(f.now()).toISOString()});
  const before=await f.repository.read(),remaining=10000-f.stats().bytes;
  f.database.prepare("UPDATE public_cloud_events SET raw_body=? WHERE user_id='123' AND sequence=?").run('x'.repeat(remaining),before.revision);
  before.state.owned_prices.run.state='partial';before.state.owned_prices.run.reason='stopped_by_you';
  assert.equal(await f.repository.append(before.revision,{key:'owned-stop',state:before.state,records:[],observed_at:new Date(f.now()).toISOString()}),true);
  assert.equal((await f.repository.read()).state.owned_prices.run.reason,'stopped_by_you');
});
