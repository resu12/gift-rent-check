import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository,PublicAccountError} from '../tgcloud/lib/public-repository.js';
import {createOwnedPriceEngine,ownedGiftScope,readOwnedGiftScope,ownedScopeRecordFilter} from '../tgcloud/lib/owned-price-engine.js';
import {createGiftRefreshEngine} from '../tgcloud/lib/gift-refresh-engine.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';

const at=Date.parse('2026-10-12T06:00:00Z'),observedAt=new Date(at).toISOString(),ctx={initData:{user:{id:101}}},
  address=value=>'0:'+createHash('sha256').update(value).digest('hex'),nft=address('owned'),wallet=address('wallet'),collection=address('collection'),
  portfolio=id=>({kind:'portfolio',observed_at:observedAt,record:{nft_address:id,collection_address:collection,is_portfolio:true}}),
  settings=value=>({kind:'settings',record:{wallet:value}}),
  initial=()=>({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0});
function friendly(raw,bounce=true,url=true) {
  const [wc,hex]=raw.split(':'),bytes=Buffer.from([bounce?0x11:0x51,Number(wc)&255,...Buffer.from(hex,'hex')]);let crc=0;
  for(const byte of bytes){crc^=byte<<8;for(let i=0;i<8;i++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}
  const text=Buffer.concat([bytes,Buffer.from([crc>>8,crc&255])]).toString('base64');
  return url?text.replace(/\+/g,'-').replace(/\//g,'_'):text;
}
async function fixture(t,mode='private') {
  const f=createPublicDatabase(t),pages=[];
  const db={...f.db,async all(sql,params){
    const rows=await f.db.all(sql,params);
    if(sql.includes('WITH pending'))pages.push({scope:sql.includes('scope_ids'),bytes:rows.reduce((sum,row)=>sum+Buffer.byteLength(row.records_json),0),rows:rows.length});
    return rows;
  }};
  const repository=mode==='private'?createCloudRepository(db):createPublicRepository(db,'101');
  if(mode==='public')await repository.ensureAccount();
  let sequence=0;
  function insert(records,state=null){
    const latest=mode==='private'?f.database.prepare('SELECT state_json FROM cloud_events ORDER BY sequence DESC LIMIT 1').get()
      :f.database.prepare("SELECT state_json FROM public_cloud_events WHERE user_id='101' ORDER BY sequence DESC LIMIT 1").get();
    const count=mode==='private'?f.database.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM cloud_events').get().n
      :f.database.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM public_cloud_events WHERE user_id='101'").get().n;
    sequence=count+1;const saved=JSON.stringify(state??(latest?JSON.parse(latest.state_json):initial()));
    if(mode==='private')f.database.prepare('INSERT INTO cloud_events(sequence,event_key,state_json,records_json,observed_at) VALUES(?,?,?,?,?)')
      .run(sequence,'fixture:'+sequence,saved,JSON.stringify(records),observedAt);
    else f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,observed_at) VALUES(?,?,?,?,?,?,?)')
      .run('fixture:'+sequence,'101',sequence,'fixture:'+sequence,saved,JSON.stringify(records),observedAt);
    return sequence;
  }
  const bounded={...repository,records:async()=>assert.fail('Refresh preparation must not materialize complete history'),
    visitRecords:async()=>assert.fail('Scoped repositories must not traverse unrelated history')};
  const engine=kind=>kind==='gifts'?createGiftRefreshEngine({repository:bounded,ownerTelegramId:101,clock:async()=>at,fetch:async()=>assert.fail('No provider request expected')})
    :createOwnedPriceEngine({repository:bounded,ownerTelegramId:101,now:()=>at,fetch:async()=>assert.fail('No provider request expected')});
  return {...f,repository,bounded,pages,insert,engine,revision:()=>sequence};
}

for(const mode of ['private','public'])test(`${mode} owned scope excludes unrelated history pages and preserves owned collection conflicts`,async t=>{
  const f=await fixture(t,mode),second=address('second');f.insert([settings(wallet),portfolio(nft),portfolio(second)]);
  for(let i=0;i<100;i++)f.insert(Array.from({length:100},(_,n)=>({kind:'history',record:{identity:address('foreign:'+n),
    collection_address:collection,source_json:{payload:'x'.repeat(500)}}})));
  f.insert([{kind:'history',record:{identity:friendly(second,false,false),collection_address:address('conflicting-collection')}}]);
  const before=await f.repository.read(),result=await readOwnedGiftScope(f.bounded,before.revision);
  assert.deepEqual(result,{wallet,targets:[{nft_address:nft,collection_address:collection}]});
  assert.equal(f.pages.length,4,'two seed and two targeted evidence page reads');
  assert.ok(f.pages.reduce((sum,row)=>sum+row.bytes,0)<5000,'large unrelated market data never crosses into the worker');
  assert.deepEqual(await f.repository.read(),before,'scope reads preserve every checkpoint');
});

for(const mode of ['private','public'])test(`${mode} scope filtering retains canonical aliases and escaped legacy conflict evidence`,async t=>{
  const f=await fixture(t,mode),variants=[id=>id,id=>id.toUpperCase().replace('0:','00:'),id=>friendly(id),id=>friendly(id,false),id=>friendly(id,true,false),id=>friendly(id,false,false)];
  for(const [index,variant] of variants.entries()) {
    const identity=address('alias:'+index),id=variant(identity);
    f.insert([settings(wallet),portfolio(identity)]);
    assert.ok((await readOwnedGiftScope(f.bounded,f.revision())).targets.some(row=>row.nft_address===identity));
    const kind=['metadata','ownership','listing','history'][index%4];
    f.insert([{kind,record:{source_json:JSON.stringify({nft_address:id,collection_address:address('conflict')})}}]);
    assert.deepEqual(await readOwnedGiftScope(f.bounded,f.revision()),ownedGiftScope(await f.repository.records(f.revision())));
    assert.ok(!(await readOwnedGiftScope(f.bounded,f.revision())).targets.some(row=>row.nft_address===identity));
  }
  const escaped=address('escaped-only');f.insert([portfolio(escaped)]);
  const source=JSON.stringify({address:escaped,collection_address:address('conflict')}).replaceAll(escaped,'\\u0030'+escaped.slice(1));
  f.insert([{kind:'history',record:{source_json:source}}]);
  assert.equal((await readOwnedGiftScope(f.bounded,f.revision())).targets.length,0);
});

test('owned scope keeps its requested revision when later history adds conflicts',async t=>{
  const f=await fixture(t);const saved=f.insert([settings(wallet),portfolio(nft)]);
  f.insert([{kind:'history',record:{identity:nft,collection_address:address('new-conflict')}}]);
  assert.equal((await readOwnedGiftScope(f.bounded,saved)).targets.length,1);
  assert.equal((await readOwnedGiftScope(f.bounded,f.revision())).targets.length,0);
});

for(const mode of ['private','public'])test(`${mode} large portfolio scope fits the hosted shallow SQL expression limit`,async t=>{
  const f=await fixture(t,mode),identities=Array.from({length:256},(_,index)=>address('large-owned:'+index));
  const filter=ownedScopeRecordFilter(identities);let depth=0,maximum=0;
  for(const char of filter.sql){if(char==='(')maximum=Math.max(maximum,++depth);else if(char===')')depth--;}
  assert.ok(maximum<20,'IN filter stays below the hosted expression depth limit of 100');
  f.insert([settings(wallet),...identities.map(portfolio)]);
  const conflicts=identities.filter((_,index)=>index%2===1);
  f.insert(conflicts.map(identity=>({kind:'history',record:{identity:friendly(identity,false,false),collection_address:address('conflict')}})));
  const result=await readOwnedGiftScope(f.bounded,f.revision());
  assert.deepEqual(result.targets.map(row=>row.nft_address).sort(),identities.filter((_,index)=>index%2===0).sort());
});

for(const mode of ['private','public'])test(`${mode} scope candidate parsing preserves falsy aliases, nested evidence and mixed envelopes`,async t=>{
  const f=await fixture(t,mode),cases=[
    id=>({nft_address:'',identity:id}),id=>({nft_address:false,identity:id}),id=>({nft_address:0,identity:id}),
    id=>({nft_address:null,identity:'',source_json:JSON.stringify({nft_address:id})}),
    id=>({nft_address:0,identity:false,source_json:JSON.stringify({nft_address:'',address:id})}),
    id=>({source_json:null,source:{address:id}}),id=>({source_json:0,source:{address:address('wrong')},id}),
    id=>({source_json:'malformed JSON',id}),id=>({source_json:{nft_address:false,address:id}}),
    id=>({source_json:JSON.stringify({nft_address:0,address:friendly(id,false,false).replace(/\//g,'_')})}),
  ];
  f.insert([settings(wallet),...cases.map((_,index)=>portfolio(address('false:'+index)))]);
  f.insert([{kind:'owned_price',record:{nft_address:address('false:0'),collection_address:address('ignored-conflict')}},
    ...cases.map((make,index)=>({kind:['metadata','ownership','listing','history'][index%4],record:{...make(address('false:'+index)),collection_address:address('conflict')}}))]);
  const scope=await readOwnedGiftScope(f.bounded,f.revision());
  assert.deepEqual(scope,ownedGiftScope(await f.repository.records(f.revision())));
  assert.equal(scope.targets.length,0,'no falsy or encoded alias hides conflicting collection evidence');
});

for(const mode of ['private','public'])test(`${mode} nested source duplicates and deep JSON cannot hide collection conflicts`,async t=>{
  const f=await fixture(t,mode),duplicate=address('duplicate'),deep=address('deep');
  f.insert([settings(wallet),portfolio(duplicate),portfolio(deep)]);
  f.insert([{kind:'history',record:{source_json:`{"nft_address":"${address('foreign')}","nft_address":"${duplicate}","collection_address":"${address('conflict')}"}`}},
    {kind:'metadata',record:{source_json:`{"nft_address":"${deep}","collection_address":"${address('conflict')}","nested":${'['.repeat(1001)}0${']'.repeat(1001)}}`}}]);
  const scope=await readOwnedGiftScope(f.bounded,f.revision());
  assert.deepEqual(scope,ownedGiftScope(await f.repository.records(f.revision())));
  assert.equal(scope.targets.length,0);
});

for(const kind of ['gifts','ton'])test(`${kind} start and same-session replay use fresh bounded scope and retain frozen runs`,async t=>{
  const f=await fixture(t);f.insert([settings(wallet),portfolio(nft)]);const engine=f.engine(kind),session='scope-replay-session-01';
  const first=await engine.start(ctx,{session_id:session});assert.equal(first.run.total,1);
  const other=address('added');f.insert([portfolio(other)]);
  const replay=await engine.start(ctx,{session_id:session});assert.equal(replay.run.id,first.run.id);assert.equal(replay.run.total,1);
  f.insert([settings(address('changed-wallet'))]);
  await assert.rejects(engine.start(ctx,{session_id:session}),error=>error.code==='OWNED_PRICE_SCOPE_CHANGED');
});

test('gift step detects newly saved conflicting history before spending a request',async t=>{
  const f=await fixture(t);f.insert([settings(wallet),portfolio(nft)]);const engine=f.engine('gifts'),session='scope-conflict-session-01';
  const started=await engine.start(ctx,{session_id:session});
  f.insert([{kind:'history',record:{identity:nft,collection_address:address('conflict')}}]);
  await assert.rejects(engine.step(ctx,{session_id:session,run_id:started.run.id}),error=>error.code==='OWNED_PRICE_SCOPE_CHANGED');
});

for(const kind of ['gifts','ton'])test(`${kind} scope preparation retries a concurrently changed portfolio`,async t=>{
  const f=await fixture(t);f.insert([settings(wallet),portfolio(nft)]);let reads=0;
  const seeds=f.bounded.dashboardSeedRecords;f.bounded.dashboardSeedRecords=async revision=>{
    reads++;const result=await seeds(revision);if(reads===1)f.insert([portfolio(address('concurrent'))]);return result;
  };
  const started=await f.engine(kind).start(ctx,{session_id:'scope-race-session-001'});
  assert.equal(started.run.total,2);assert.equal(reads,2);
});

test('public scope traversal rejects an account generation change during the candidate read',async t=>{
  const f=await fixture(t,'public');f.insert([settings(wallet),portfolio(nft)]);
  const visit=f.bounded.visitOwnedScopeRecords;f.bounded.visitOwnedScopeRecords=async(...args)=>{
    f.database.prepare("UPDATE public_accounts SET generation=generation+1 WHERE user_id='101'").run();return visit(...args);
  };
  await assert.rejects(readOwnedGiftScope(f.bounded,f.revision()),PublicAccountError);
});
