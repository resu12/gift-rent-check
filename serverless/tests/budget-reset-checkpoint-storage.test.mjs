import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {encodeCheckpoint, decodeCheckpoint, createCheckpointStorage} from '../tgcloud/lib/checkpoint-storage.js';
import {BUDGET_RESET_MARKER as marker} from '../tgcloud/lib/budget-reset-checkpoint-storage.js';
import {effectiveMarketAttempts, marketBudgetAvailableAt, applyMarketBudgetReset} from '../tgcloud/lib/market-budget.js';

const now=Date.parse('2026-10-11T12:00:00.000Z'),date=new Date(now).toISOString(),giftMarker='__checkpoint_gift_state_sequence';
const reset=()=>({id:'synthetic-reset-20261011',at:now-1000,expires_at:now+3600000,local_date:'2026-10-11',time_zone:'Europe/Berlin',
  excluded_attempts:Array.from({length:500},(_,index)=>now-2000+index),extra:null});
const gift=()=>({version:1,next_run_id:20,run:{id:19,wallet:'saved-wallet',state:'complete',checked:1,started_at:date,check_started_at:date,
  completed_at:date,targets:[{nft_address:'saved-nft',label:'x'.repeat(55000)}],results:{'saved-nft':{price:true,status:false,exact_price:'0.170000001'}}}});
const state=()=>({version:2,next_job_id:8,job:null,attempts:[now-2000,now-1000],next_allowed_at:now+10000,marketapp_budget_reset:reset(),gift_refresh:gift()});
function fixture(t,{beforeWrite=null}={}) {
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE INDEX event_keys ON cloud_events(event_key); CREATE TABLE collector_state(id INTEGER PRIMARY KEY,document TEXT);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER,cookie_version INTEGER,wallet TEXT,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);`);
  const queries=[];
  const db={async get(sql,params={}){queries.push({kind:'get',sql});return database.prepare(sql).get(params)??null;},
    async all(sql,params={}){const rows=database.prepare(sql).all(params);queries.push({kind:'all',sql,rows});return rows;},
    async run(sql,params={}){beforeWrite?.(database,sql,params);queries.push({kind:'run',sql});return{rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  const storage=createCheckpointStorage(db),repository=createCloudRepository(db);
  const legacy=(sequence,saved=state(),key=`event:${sequence}`)=>database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(sequence,key,JSON.stringify(saved),saved.job?.id??null,saved.job?JSON.stringify(saved.job):null,'[]',null,date);
  const rows=()=>database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  const source=sequence=>({sequence,budget_reset_json:JSON.stringify(reset())});
  return{database,db,storage,repository,legacy,rows,queries,source};
}

test('receipt references preserve excluded multiplicities, expiry, original clocks and missing/null values',()=>{
  const logical=state(),source={sequence:1,budget_reset_json:JSON.stringify(logical.marketapp_budget_reset)},before=structuredClone(logical);
  const encoded=encodeCheckpoint(logical,null,3,null,null,null,null,source),row={sequence:3,state_json:encoded};
  assert.equal(JSON.parse(encoded)[marker],1);assert.equal(Object.hasOwn(JSON.parse(encoded),'marketapp_budget_reset'),false);
  const decoded=decodeCheckpoint(row,row,null,null,null,source);assert.deepEqual(decoded,before);assert.deepEqual(logical,before);
  for(const at of [now-1,now,now+3600000,now+86400000]) {
    assert.deepEqual(effectiveMarketAttempts(decoded,at),effectiveMarketAttempts(logical,at));
    assert.equal(marketBudgetAvailableAt(decoded,at,1),marketBudgetAvailableAt(logical,at,1));
  }
  assert.equal(decoded.marketapp_budget_reset.excluded_attempts.length,500);assert.equal(decoded.marketapp_budget_reset.extra,null);
});

test('receipt codec rejects reserved, cyclic, mixed, malformed or conflicting source representations',()=>{
  const logical=state(),source={sequence:1,budget_reset_json:JSON.stringify(reset())},encoded=encodeCheckpoint(logical,null,3,null,null,null,null,source),row={sequence:3,state_json:encoded};
  assert.throws(()=>encodeCheckpoint({...logical,[marker]:1},null,3));
  for(const changed of [{...source,sequence:0},{...source,sequence:3},{...source,sequence:4},{...source,budget_reset_json:'[]'},{...source,budget_reset_json:'null'},{...source,budget_reset_json:'{'}]) {
    assert.throws(()=>encodeCheckpoint(logical,null,3,null,null,null,null,changed));assert.throws(()=>decodeCheckpoint(row,row,null,null,null,changed));
  }
  assert.throws(()=>encodeCheckpoint(logical,null,3,null,null,null,null,{...source,budget_reset_json:JSON.stringify({...reset(),expires_at:now+1})}));
  assert.throws(()=>decodeCheckpoint(row,row));
  assert.throws(()=>decodeCheckpoint({...row,state_json:JSON.stringify({...JSON.parse(encoded),marketapp_budget_reset:reset()})},row,null,null,null,source));
  for(const value of [null,undefined,[]]){const saved={version:2,marketapp_budget_reset:value};if(value===undefined)delete saved.marketapp_budget_reset;
    assert.deepEqual(decodeCheckpoint({sequence:1,state_json:encodeCheckpoint(saved,null,1)}),saved);}
});

test('private append and website append reuse receipt roots without changing budgets, clocks or fences',async t=>{
  for(const website of [false,true]) {
    const f=fixture(t);f.legacy(1);const logical=state();await f.repository.read();
    f.database.prepare('INSERT INTO marketapp_analytics_sessions VALUES(?,?,?,?,?,?,?)').run('42',2,3,'saved-wallet','synthetic-encrypted-cookie',0,9999999999999);
    const stored={value:{owner:'42',wallet:'saved-wallet',cookie_version:3},fence:{generation:2,wallet_revision:0}},event={key:'next',state:logical,job:null,records:[],observed_at:date};
    assert.equal(website?await f.repository.appendWebsite(1,event,'42',stored):await f.repository.append(1,event,0),true);
    const physical=JSON.parse(f.rows()[1].state_json);assert.equal(physical[marker],1);assert.equal(physical[giftMarker],1);
    assert.deepEqual((await f.repository.read()).state,logical);
    assert.equal(website?await f.repository.appendWebsite(1,{...event,key:'stale'},'42',stored):await f.repository.append(1,{...event,key:'stale'},0),false);
    const changed=structuredClone(logical);changed.marketapp_budget_reset.excluded_attempts.push(now-5000);
    assert.equal(await f.repository.append(2,{...event,key:'changed',state:changed}),true);
    assert.equal(Object.hasOwn(JSON.parse(f.rows()[2].state_json),marker),false);assert.deepEqual((await f.repository.read()).state,changed);
    await assert.rejects(applyMarketBudgetReset({...f.repository,clock:async()=>now},{id:'another-reset-id',local_date:'2026-10-11',time_zone:'Europe/Berlin',expires_at:now+100000}),/already applied/);
  }
});

test('receipt source fences reject concurrent root mutation or removal after validated lookup',async t=>{
  for(const website of [false,true])for(const race of [db=>db.prepare('DELETE FROM cloud_events WHERE sequence=1').run(),
    db=>{const saved=state();saved.marketapp_budget_reset.at++;db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run(JSON.stringify(saved));},
    db=>db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run('{'),
    db=>db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run(JSON.stringify({[marker]:99})),
  ]) {
    let fired=false;const f=fixture(t,{beforeWrite:(db,sql)=>{if(!fired&&/^INSERT OR IGNORE INTO cloud_events/.test(sql)){fired=true;race(db);}}});
    f.legacy(1);f.legacy(2,{...state(),marketapp_budget_reset:{...reset(),unique:'second'}});
    f.database.prepare('INSERT INTO marketapp_analytics_sessions VALUES(?,?,?,?,?,?,?)').run('42',2,3,'saved-wallet','synthetic-encrypted-cookie',0,9999999999999);
    const event={key:'must-not-commit',state:state(),job:null,records:[],observed_at:date},stored={value:{owner:'42',wallet:'saved-wallet',cookie_version:3},fence:{generation:2,wallet_revision:0}};
    assert.equal(website?await f.repository.appendWebsite(2,event,'42',stored):await f.repository.append(2,event),false);
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM cloud_events WHERE event_key=?').get(event.key).count,0);
  }
});

test('combined maintenance preserves all checkpoints and immutable evidence while keeping exact roots and head inline',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=15;sequence++)f.legacy(sequence,{...state(),attempts:[now-sequence]});
  const before=f.rows(),head=await f.repository.read();let after=0,complete=false,rewritten=0;
  while(!complete){const result=await createCheckpointStorage(f.db).compactCheckpointBudgetResetsPage({boundary:15,after,limit:4});after=result.after;complete=result.complete;rewritten+=result.rewritten;}
  assert.equal(rewritten,13);const saved=f.rows();assert.equal(saved[0].state_json,before[0].state_json);assert.equal(saved[14].state_json,before[14].state_json);
  for(let index=0;index<saved.length;index++) {
    const physical=JSON.parse(saved[index].state_json),giftSource=physical[giftMarker]?await f.storage.giftStateSource(physical[giftMarker]):null,budgetSource=physical[marker]?await f.storage.budgetResetSource(physical[marker]):null;
    assert.deepEqual(decodeCheckpoint(saved[index],saved[index],null,null,giftSource,budgetSource),JSON.parse(before[index].state_json));
    for(const column of ['sequence','event_key','job_id','job_json','records_json','raw_body','observed_at'])assert.equal(saved[index][column],before[index][column]);
  }
  assert.deepEqual(await f.repository.read(),head);assert.ok(saved.slice(1,14).every(row=>JSON.parse(row.state_json)[marker]===1&&JSON.parse(row.state_json)[giftMarker]===1));
});

test('combined rewrite creates headroom at max_page_count when ordinary gift-only shrinking fails',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=60;sequence++)f.legacy(sequence);
  const pageCount=f.database.prepare('PRAGMA page_count').get().page_count;assert.equal(f.database.prepare('PRAGMA freelist_count').get().freelist_count,0);
  f.database.exec(`PRAGMA max_page_count=${pageCount}`);const before=f.rows(),head=await f.repository.read();
  await assert.rejects(f.storage.compactCheckpointGiftStatesPage({boundary:60,after:1,limit:1}),/database or disk is full/);
  assert.deepEqual(f.rows(),before);assert.equal(f.database.prepare('PRAGMA freelist_count').get().freelist_count,0);
  const result=await f.storage.compactCheckpointBudgetResetsPage({boundary:60,after:1,limit:1});assert.equal(result.rewritten,1);
  assert.ok(f.database.prepare('PRAGMA freelist_count').get().freelist_count>0);assert.deepEqual(await f.repository.read(),head);
  const row=f.rows()[1],physical=JSON.parse(row.state_json);assert.equal(physical[marker],1);assert.equal(physical[giftMarker],1);
  assert.deepEqual(decodeCheckpoint(row,row,null,null,await f.storage.giftStateSource(1),await f.storage.budgetResetSource(1)),JSON.parse(before[1].state_json));
  for(const column of ['sequence','event_key','job_id','job_json','records_json','raw_body','observed_at'])assert.equal(row[column],before[1][column]);
});

test('new receipt or gift source references after selection prevent maintenance from retiring roots',async t=>{
  for(const addedMarker of [marker,giftMarker]) {
    let fired=false;const f=fixture(t,{beforeWrite:(db,sql)=>{if(!fired&&/UPDATE cloud_events SET state_json/.test(sql)) {
      fired=true;const logical=state();delete logical[addedMarker===marker?'marketapp_budget_reset':'gift_refresh'];logical[addedMarker]=2;
      db.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(5,'concurrent-reference',JSON.stringify(logical),null,null,'[]',null,date);
    }}});
    for(let sequence=1;sequence<=4;sequence++)f.legacy(sequence);const protectedState=f.rows()[1].state_json;
    const result=await f.storage.compactCheckpointBudgetResetsPage({boundary:4,after:1,limit:1});assert.equal(result.rewritten,0);assert.equal(f.rows()[1].state_json,protectedState);
    assert.deepEqual((await f.repository.read()).state,state());
  }
});

test('maintenance and lookup skip malformed/duplicate parents and never chain receipt markers',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=6;sequence++)f.legacy(sequence);
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=2').run(JSON.stringify({...state(),marketapp_budget_reset:undefined,[marker]:1}));
  const original=f.rows()[2].state_json;f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=3').run(original.replace('"marketapp_budget_reset":','"marketapp_budget_reset":{},"marketapp_budget_reset":'));
  const changed=state();changed.marketapp_budget_reset.id='different-reset-20261011';f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=4').run(JSON.stringify(changed));
  const before=f.rows();const result=await f.storage.compactCheckpointBudgetResetsPage({boundary:6,after:0,limit:4});assert.equal(result.rewritten,1);
  assert.equal(f.rows()[0].state_json,before[0].state_json);assert.equal(f.rows()[2].state_json,before[2].state_json);assert.equal(f.rows()[3].state_json,before[3].state_json);
  assert.deepEqual({...await f.storage.findBudgetResetSource(reset(),7,2)},f.source(1));assert.equal(await f.storage.budgetResetSource(2),null);
  assert.equal(JSON.parse(f.rows()[4].state_json)[marker],1);
});

test('receipt partitions bound lookups, mutations and response payloads across fresh repository invocations',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=100;sequence++)f.legacy(sequence);
  const stats=await f.storage.budgetResetStorageStatsPage({});assert.equal(stats.complete,false);assert.ok(stats.budget_reset_compactable>0);
  assert.ok(f.queries.filter(query=>query.kind==='all').every(query=>query.rows.length<=25&&query.rows.reduce((bytes,row)=>bytes+Buffer.byteLength(row.budget_reset_json||'')+Buffer.byteLength(row.gift_refresh_json||''),0)<=524288));
  assert.ok((await f.storage.compactCheckpointBudgetResetsPage({boundary:100,after:0,limit:100})).rewritten<=4);
  for(const input of [{boundary:101},{boundary:-1},{boundary:100,after:101},{boundary:100,limit:0},{boundary:100,limit:101},{boundary:100,unknown:true}])await assert.rejects(f.storage.compactCheckpointBudgetResetsPage(input));
});
