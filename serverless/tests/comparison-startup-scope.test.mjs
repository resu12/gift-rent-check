import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';

const at=Date.parse('2026-10-11T12:00:00Z'),observedAt=new Date(at).toISOString(),
  ctx={initData:{user:{id:101}}},address=value=>'0:'+value.repeat(64),
  portfolio=collection=>({kind:'portfolio',record:{nft_address:address('a'),collection_address:collection,is_portfolio:true}}),
  settings=wallet=>({kind:'settings',record:{wallet}}),
  initial=()=>({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0});

async function fixture(t,mode='private') {
  const f=createPublicDatabase(t),pages=[],readRows=f.db.all;
  const db={...f.db,async all(sql,params){
    const rows=await readRows(sql,params);
    if(sql.includes('WITH pending'))pages.push(rows.flatMap(row=>JSON.parse(row.records_json)));
    return rows;
  }};
  const repository=mode==='private'?createCloudRepository(db):f.repository(101);
  // Public reads retain real account/generation checks while counting pages.
  if(mode==='public') {
    await repository.ensureAccount();
    f.db.all=db.all;
  }
  function insert(sequence,records,state=initial()) {
    if(mode==='private')f.database.prepare('INSERT INTO cloud_events(sequence,event_key,state_json,records_json,observed_at) VALUES(?,?,?,?,?)')
      .run(sequence,'fixture:'+sequence,JSON.stringify(state),JSON.stringify(records),observedAt);
    else f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,observed_at) VALUES(?,?,?,?,?,?,?)')
      .run('fixture:'+sequence,'101',sequence,'fixture:'+sequence,JSON.stringify(state),JSON.stringify(records),observedAt);
  }
  const deps={repository,ownerTelegramId:101,marketappToken:'synthetic-test-token',now:()=>at,
    fetch:async()=>assert.fail('Starting a plan must not spend a provider request')};
  return {...f,repository,pages,insert,deps};
}

for(const mode of ['private','public'])for(const automatic of [false,true]) {
  test(`${mode} ${automatic?'automatic':'manual'} comparison startup reads only portfolio/settings pages`,async t=>{
    const f=await fixture(t,mode);
    f.insert(1,[portfolio(address('b')),settings(address('c'))]);
    for(let sequence=2;sequence<=101;sequence++)f.insert(sequence,Array.from({length:100},()=>
      ({kind:'history',record:{identity:address('d'),payload:'x'.repeat(100)}})));
    const until=[],repository={...f.repository,
      records:async()=>assert.fail('Comparison scope must not materialize all market history'),
      dashboardSeedRecords:async revision=>{until.push(revision);return f.repository.dashboardSeedRecords(revision);}};
    const engine=createCloudEngine({...f.deps,repository}),input={kind:'prices',timeframe:'30d'};
    const result=await (automatic?engine.refreshStartupComparisons(ctx,input):engine.startJob(ctx,input));
    assert.equal(result.job.state,'running');assert.deepEqual(until,[101]);
    assert.deepEqual((await f.repository.read()).state.job.scopes,[address('b')]);
    assert.equal(f.pages.length,2,'one seed page plus its bounded end-of-stream read');
    assert.deepEqual(f.pages.flat().map(row=>row.kind),['portfolio','settings']);
  });
}

test('independent automatic blockers and a blocked manual switch do not read any scope pages',async t=>{
  const variants=[
    {job:{id:1,state:'partial',reason:'stopped_by_you'},reason:'stopped'},
    {job:{id:1,state:'running',lease_until:at+1000},reason:'active_job'},
    {job:{id:1,state:'partial',lease_until:0},reason:'active_job'},
    {owned_prices:{run:{state:'running',deadline:at+1000}},reason:'active_job'},
  ];
  for(const variant of variants) {
    const f=await fixture(t);const {reason,...saved}=variant;
    f.insert(1,[portfolio(address('b')),settings(address('c'))],{...initial(),...saved});
    const repository={...f.repository,
      records:async()=>assert.fail('Blocked starts must not load records'),
      dashboardSeedRecords:async()=>assert.fail('Blocked starts must not load scope seeds')};
    const result=await createCloudEngine({...f.deps,repository}).refreshStartupComparisons(ctx,{kind:'prices'});
    assert.equal(result.reason,reason);assert.equal((await f.repository.read()).revision,1);
  }
  const f=await fixture(t);f.insert(1,[],{...initial(),job:{id:1,state:'running',invocation_deadline:at+1000,lease_until:0}});
  const repository={...f.repository,records:async()=>assert.fail('No full read'),dashboardSeedRecords:async()=>assert.fail('No scope read')};
  await assert.rejects(createCloudEngine({...f.deps,repository}).startJob(ctx,{kind:'prices'}),/Stop or complete/);
});

for(const automatic of [false,true])test(`${automatic?'automatic':'manual'} startup retries scope at the new revision after a concurrent portfolio change`,async t=>{
  const f=await fixture(t);f.insert(1,[portfolio(address('b')),settings(address('c'))]);
  const until=[];
  const repository={...f.repository,records:async()=>assert.fail('No full history read'),
    dashboardSeedRecords:async revision=>{
      until.push(revision);const seeds=await f.repository.dashboardSeedRecords(revision);
      if(until.length===1)f.insert(2,[portfolio(address('d')),settings(address('e'))]);
      return seeds;
    }};
  const engine=createCloudEngine({...f.deps,repository}),input={kind:'prices',timeframe:'30d'};
  const result=await (automatic?engine.refreshStartupComparisons(ctx,input):engine.startJob(ctx,input));
  assert.equal(result.job.state,'running');assert.deepEqual(until,[1,2]);
  const saved=await f.repository.read();assert.equal(saved.revision,3);
  assert.deepEqual(saved.state.job.scopes,[address('d')]);
  if(automatic)assert.equal(saved.state.job.startup_comparisons.wallet,address('e'));
});
