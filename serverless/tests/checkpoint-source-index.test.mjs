import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCheckpointSourceIndex,createCheckpointStorage,decodeCheckpoint} from '../tgcloud/lib/checkpoint-storage.js';
import {checkpointSourceIndexReadySql,CHECKPOINT_SOURCE_TRIGGER_NAMES} from '../tgcloud/lib/budget-reset-checkpoint-storage.js';
import {installStorageAccounting,installCheckpointSourceAccounting} from '../tools/storage-accounting.mjs';

async function readyUsage(db) {let after=0,result;do{result=await installStorageAccounting(db,{after});after=result.after;}while(!result.complete);}
function fixture(t) {
  const f=createPublicDatabase(t),insert=f.database.prepare('INSERT INTO cloud_events(sequence,event_key,state_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?)');
  const event=(sequence,state='{}')=>insert.run(sequence,`synthetic:${sequence}`,state,'[{"kind":"history","record":{"exact_amount":"123456789"}}]','financial-evidence','2026-10-11T10:00:00.000Z');
  const publicEvent=(user,sequence,state='{}')=>f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`${user}:${sequence}`,user,sequence,`synthetic:${sequence}`,state,'[{"kind":"history"}]','financial-evidence','2026-10-11T10:00:00.000Z');
  return {...f,event,publicEvent,index:createCheckpointSourceIndex(f.db),pins:()=>f.database.prepare('SELECT scope,kind,source_sequence FROM service_checkpoint_sources ORDER BY scope,kind,source_sequence').all()};
}

test('index bootstrap pins every duplicate top-level integer/decimal/exponent marker and isolates public scopes',async t=>{
  const f=fixture(t);f.event(1);f.event(2);
  f.event(3,'{"__checkpoint_owned_targets_sequence":1.0,"__checkpoint_owned_targets_sequence":2e0,"__checkpoint_gift_state_sequence":1,"nested":{"__checkpoint_budget_reset_sequence":2},"__checkpoint_budget_reset_sequence":1.5}');
  f.publicEvent('123',1);f.publicEvent('123',2,'{"__checkpoint_owned_state_sequence":1}');f.publicEvent('456',1);f.publicEvent('456',2,'{"__checkpoint_budget_reset_sequence":1}');
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  assert.equal((await f.index.ensurePage('private')).complete,true);
  assert.equal((await f.index.ensurePage('public:123')).complete,true);assert.equal((await f.index.ensurePage('public:456')).complete,true);
  assert.deepEqual(f.pins().map(row=>({...row})),[{scope:'private',kind:'gift_state',source_sequence:1},
    {scope:'private',kind:'owned_targets',source_sequence:1},{scope:'private',kind:'owned_targets',source_sequence:2},
    {scope:'public:123',kind:'owned_state',source_sequence:1},{scope:'public:456',kind:'budget_reset',source_sequence:1}]);
  const before=f.pins();await f.index.ensurePage('private');assert.deepEqual(f.pins(),before);
});

test('bootstrap is bounded and freezes its initial boundary while triggers protect later references',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=31;sequence++)f.event(sequence);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  const first=await f.index.ensurePage('private');assert.equal(first.complete,false);assert.equal(first.after_sequence,25);
  f.event(100,'{"__checkpoint_budget_reset_sequence":2e0}');assert.ok(f.pins().some(row=>row.kind==='budget_reset'&&row.source_sequence===2));
  const second=await f.index.ensurePage('private');assert.equal(second.complete,true);assert.equal(second.after_sequence,31);
  const scan=f.database.prepare("SELECT * FROM service_checkpoint_source_scans WHERE scope='private'").get();assert.equal(scan.boundary_sequence,31);
  f.database.prepare("UPDATE cloud_events SET state_json=? WHERE sequence=100").run('{"__checkpoint_gift_state_sequence":3.0}');
  assert.ok(f.pins().some(row=>row.kind==='gift_state'&&row.source_sequence===3));
  f.database.exec('DELETE FROM cloud_events WHERE sequence=100');assert.ok(f.pins().some(row=>row.kind==='gift_state'&&row.source_sequence===3));
});

test('public scope or sequence moves add conservative pins under the new identity',async t=>{
  const f=fixture(t);await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  f.publicEvent('123',3,'{"__checkpoint_owned_targets_sequence":2e0}');
  f.database.prepare("UPDATE public_cloud_events SET user_id='456' WHERE user_id='123'").run();
  assert.ok(f.pins().some(row=>row.scope==='public:456'&&row.kind==='owned_targets'&&row.source_sequence===2));
  assert.ok(f.pins().some(row=>row.scope==='public:123'&&row.kind==='owned_targets'&&row.source_sequence===2));
  f.publicEvent('789',1,'{"__checkpoint_owned_targets_sequence":2e0}');
  assert.equal(f.pins().some(row=>row.scope==='public:789'),false);
  f.database.prepare("UPDATE public_cloud_events SET sequence=4 WHERE user_id='789'").run();
  assert.ok(f.pins().some(row=>row.scope==='public:789'&&row.source_sequence===2));
});

test('physical page byte bound advances oversized first row alone and never changes source evidence',async t=>{
  const f=fixture(t);f.event(1,JSON.stringify({padding:'x'.repeat(600000)}));for(let sequence=2;sequence<=20;sequence++)f.event(sequence,JSON.stringify({padding:'x'.repeat(60000)}));
  const before=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  assert.equal((await f.index.ensurePage('private')).after_sequence,1);assert.equal((await f.index.ensurePage('private')).after_sequence,9);
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(),before);
});

test('missing triggers or incomplete cursors fail closed and source compaction cannot use another tenant scope',async t=>{
  const f=fixture(t);f.event(1);await readyUsage(f.db);
  await assert.rejects(f.index.ensurePage('private'),/triggers/);await installCheckpointSourceAccounting(f.db);
  const compact=createCheckpointStorage(f.db,{sourceScope:'private'});
  await assert.rejects(compact.compactCheckpointGiftStatesPage({after:0,boundary:1,limit:4}),/not ready/);
  await f.index.ensurePage('private');f.database.exec(`DROP TRIGGER ${CHECKPOINT_SOURCE_TRIGGER_NAMES[0]}`);
  assert.equal(f.database.prepare(`SELECT 1 WHERE ${checkpointSourceIndexReadySql('private')}`).get(),undefined);
  await assert.rejects(compact.compactCheckpointGiftStatesPage({after:0,boundary:1,limit:4}),/not ready/);
  assert.throws(()=>createCheckpointStorage(f.db,{sourceScope:'public:123'}));
  for(const value of ['public:0',"private' OR 1=1",'public:9999999999999999'])await assert.rejects(f.index.ensurePage(value));
});

test('a reference committed between selection and final publication atomically protects the newly pinned root',async t=>{
  const f=fixture(t),gift={version:1,run:{id:3,results:{nft:{exact_amount:'123456789'}},targets:Array.from({length:10},(_,i)=>({nft:`gift-${i}`}))}};
  for(let sequence=1;sequence<=3;sequence++)f.event(sequence,JSON.stringify({version:2,gift_refresh:gift}));
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);await f.index.ensurePage('private');
  let injected=false;
  const raced={...f.db,async run(sql,params={}){if(!injected&&/UPDATE cloud_events SET state_json=json_set\(json_remove\(state_json,'\$\.gift_refresh'/.test(sql)){
    injected=true;f.event(4,'{"__checkpoint_gift_state_sequence":2e0}');}return f.db.run(sql,params);}};
  const before=f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get();
  const result=await createCheckpointStorage(raced,{sourceScope:'private'}).compactCheckpointGiftStatesPage({after:0,boundary:3,limit:4});
  assert.equal(injected,true);assert.equal(result.rewritten,0);assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get(),before);
  assert.ok(f.pins().some(row=>row.kind==='gift_state'&&row.source_sequence===2));
  assert.ok(f.queries.some(query=>query.sql.includes('service_checkpoint_sources')&&query.sql.includes("kind='gift_state'")));
});

test('readiness is rechecked inside final SQL when a trigger disappears after selection',async t=>{
  const f=fixture(t),gift={version:1,padding:'unchanged'.repeat(20)};for(let sequence=1;sequence<=3;sequence++)f.event(sequence,JSON.stringify({gift_refresh:gift}));
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);await f.index.ensurePage('private');
  const before=f.database.prepare('SELECT * FROM cloud_events').all();let dropped=false;
  const raced={...f.db,async run(sql,params={}){if(!dropped&&/UPDATE cloud_events SET state_json=json_set\(json_remove\(state_json,'\$\.gift_refresh'/.test(sql)){
    dropped=true;f.database.exec(`DROP TRIGGER ${CHECKPOINT_SOURCE_TRIGGER_NAMES[0]}`);}return f.db.run(sql,params);}};
  assert.equal((await createCheckpointStorage(raced,{sourceScope:'private'}).compactCheckpointGiftStatesPage({after:0,boundary:3,limit:4})).rewritten,0);
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events').all(),before);
});

test('private maintenance source matching never searches unbounded historical JSON for a late unique variant',async t=>{
  const f=fixture(t),run={id:7,wallet:'wallet',targets:Array.from({length:8},(_,i)=>({nft:`gift-${i}`}))},
    owned={version:1,run},gift={version:1,results:{nft:{exact_amount:'123456789',memo:'x'.repeat(80)}}},
    reset={version:1,receipts:[{at:123,excluded:Array.from({length:20},(_,i)=>i)}]};
  f.event(1,JSON.stringify({owned_prices:owned,gift_refresh:gift,marketapp_budget_reset:reset}));
  for(let sequence=2;sequence<=100;sequence++)f.event(sequence);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);await f.index.ensurePage('private');
  while(!(await f.index.ensurePage('private')).complete){}
  const start=f.queries.length,storage=createCheckpointStorage(f.db,{sourceScope:'private'});
  assert.equal(await storage.findOwnedTargetSource(run,101),null);
  assert.equal(await storage.findOwnedStateSource(owned,101),null);
  assert.equal(await storage.findGiftStateSource(gift,101),null);
  assert.equal(await storage.findBudgetResetSource(reset,101),null);
  assert.equal(await storage.findGiftStateSource({...gift,variant:'new'},101),null);
  const searches=f.queries.slice(start).filter(query=>query.sql.includes('source_page AS MATERIALIZED'));
  assert.equal(searches.length,10);
  for(const {sql} of searches) {
    assert.ok(sql.includes('ORDER BY')&&sql.includes('LIMIT 25')&&sql.includes('total_bytes<=524288'));
    assert.ok(sql.indexOf('LIMIT 25')<sql.indexOf('FROM source_page WHERE'));
  }
  assert.ok(!f.queries.slice(start).some(query=>/FROM cloud_events WHERE sequence<:before/.test(query.sql)));
  // Operator/provider behavior remains unchanged when no sourceScope is set.
  assert.equal((await createCheckpointStorage(f.db).findGiftStateSource(gift,101)).sequence,1);
});

test('a nearby first copy becomes a permanent pin and is reused after leaving the physical lookup window',async t=>{
  const f=fixture(t),gift={version:1,run:{id:5,results:{nft:{exact_amount:'123456789',memo:'x'.repeat(100)}}}},
    original=JSON.stringify({version:2,gift_refresh:gift,unknown:null});
  for(let sequence=1;sequence<=80;sequence++)f.event(sequence);
  f.event(81,original);f.event(82,original);f.event(83);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  while(!(await f.index.ensurePage('private')).complete){}
  const evidence=f.database.prepare('SELECT sequence,records_json,raw_body,observed_at FROM cloud_events').all();
  const first=await createCheckpointStorage(f.db,{sourceScope:'private'}).compactCheckpointGiftStatesPage({after:80,boundary:83,limit:1});
  assert.equal(first.rewritten,1);
  assert.ok(f.pins().some(pin=>pin.kind==='gift_state'&&pin.source_sequence===81));
  const rewritten=f.database.prepare('SELECT * FROM cloud_events WHERE sequence=82').get(),storage=createCheckpointStorage(f.db,{sourceScope:'private'});
  assert.deepEqual(decodeCheckpoint(rewritten,rewritten,null,null,await storage.giftStateSource(81)),JSON.parse(original));
  assert.deepEqual(f.database.prepare('SELECT sequence,records_json,raw_body,observed_at FROM cloud_events').all(),evidence);
  for(let sequence=84;sequence<=130;sequence++)f.event(sequence);
  const start=f.queries.length,found=await createCheckpointStorage(f.db,{sourceScope:'private'}).findGiftStateSource(gift,131);
  assert.equal(found.sequence,81);
  assert.equal(f.queries.slice(start).filter(query=>query.sql.includes('source_page AS MATERIALIZED')).length,1);
});

test('maintenance source matching applies the physical byte window before component matching',async t=>{
  const f=fixture(t),gift={version:1,padding:'saved'.repeat(40)};
  f.event(1,JSON.stringify({gift_refresh:gift}));f.event(2,JSON.stringify({padding:'x'.repeat(600000)}));f.event(3);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);await f.index.ensurePage('private');
  while(!(await f.index.ensurePage('private')).complete){}
  assert.equal(await createCheckpointStorage(f.db,{sourceScope:'private'}).findGiftStateSource(gift,3),null);
  const large={version:1,padding:'y'.repeat(600000)};f.event(4,JSON.stringify({gift_refresh:large}));
  assert.equal((await createCheckpointStorage(f.db,{sourceScope:'private'}).findGiftStateSource(large,5)).sequence,4);
});

test('private candidate cursors cross unmatched and malformed tails in physical pages without scanning JSON history',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=76;sequence++)f.event(sequence,sequence%9===0?'{malformed':JSON.stringify({archive:`unique-${sequence}`}));
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  while(!(await f.index.ensurePage('private')).complete){}
  const original=f.database.prepare('SELECT * FROM cloud_events').all(),start=f.queries.length;
  for(const method of ['compactCheckpointJobsPage','compactCheckpointOwnedStatesPage','compactCheckpointGiftStatesPage','compactCheckpointBudgetResetsPage']) {
    let after=0;
    for(const expected of [25,50,75]) {
      const result=await createCheckpointStorage(f.db,{sourceScope:'private'})[method]({after,boundary:76,limit:4});
      assert.equal(result.rewritten,0);assert.equal(result.after,expected);assert.equal(result.complete,expected===75);after=result.after;
    }
  }
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events').all(),original);
  const pages=f.queries.slice(start).filter(query=>query.sql.includes(':physical_after'));
  assert.equal(pages.length,12);
  for(const {sql} of pages)assert.ok(sql.includes('LIMIT 25')&&sql.includes('total_bytes<=524288')&&!sql.includes('json_extract'));
  const candidates=f.queries.slice(start).filter(query=>query.sql.includes(':physical_row0'));
  assert.equal(candidates.length,12);
  for(const {sql,params} of candidates)assert.ok(sql.includes('WHERE sequence IN')&&Object.keys(params).length<=25);
});

test('a no-source cursor stops at the lookup budget and preserves the next first copy for later reuse',async t=>{
  const f=fixture(t),logical=[];
  for(let sequence=1;sequence<=5;sequence++)logical.push({version:2,
    owned_prices:{version:1,run:{id:sequence,wallet:'wallet',targets:Array.from({length:8},(_,i)=>({nft:`${sequence}-${i}`}))}},
    gift_refresh:{version:1,variant:sequence,padding:'x'.repeat(100)},
    marketapp_budget_reset:{version:1,variant:sequence,excluded:Array.from({length:30},(_,i)=>i)}});
  for(let sequence=1;sequence<=5;sequence++)f.event(sequence,JSON.stringify(logical[sequence-1]));
  f.event(6,JSON.stringify(logical[4]));f.event(7);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);await f.index.ensurePage('private');
  const evidence=f.database.prepare('SELECT sequence,records_json,raw_body,observed_at FROM cloud_events').all();
  for(const method of ['compactCheckpointOwnedStatesPage','compactCheckpointGiftStatesPage','compactCheckpointBudgetResetsPage']) {
    const first=await createCheckpointStorage(f.db,{sourceScope:'private'})[method]({after:0,boundary:7,limit:1});
    assert.equal(first.rewritten,0);assert.equal(first.after,4);assert.equal(first.complete,false);
    const next=await createCheckpointStorage(f.db,{sourceScope:'private'})[method]({after:first.after,boundary:7,limit:1});
    assert.equal(next.rewritten,1);assert.equal(next.after,6);
  }
  const row=f.database.prepare('SELECT * FROM cloud_events WHERE sequence=6').get(),storage=createCheckpointStorage(f.db,{sourceScope:'private'});
  assert.deepEqual(decodeCheckpoint(row,row,null,await storage.ownedStateSource(5),await storage.giftStateSource(5),await storage.budgetResetSource(5)),logical[4]);
  assert.deepEqual(f.database.prepare('SELECT sequence,records_json,raw_body,observed_at FROM cloud_events').all(),evidence);
  assert.deepEqual(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=5').get().state_json),logical[4]);
});

test('an oversized unmatched physical candidate advances alone before smaller rows',async t=>{
  const f=fixture(t);f.event(1,JSON.stringify({padding:'x'.repeat(600000)}));f.event(2);f.event(3);f.event(4);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  while(!(await f.index.ensurePage('private')).complete){}
  for(const method of ['compactCheckpointOwnedStatesPage','compactCheckpointGiftStatesPage','compactCheckpointBudgetResetsPage']) {
    const first=await createCheckpointStorage(f.db,{sourceScope:'private'})[method]({after:0,boundary:4,limit:4});
    assert.equal(first.after,1);assert.equal(first.complete,false);assert.equal(first.rewritten,0);
    const second=await createCheckpointStorage(f.db,{sourceScope:'private'})[method]({after:1,boundary:4,limit:4});
    assert.equal(second.after,3);assert.equal(second.complete,true);assert.equal(second.rewritten,0);
  }
});

test('combined receipt and gift publication keeps a same-batch gift source inline when byte windows differ',async t=>{
  const f=fixture(t),gift={version:1,padding:'gift'.repeat(40)},reset={version:1,excluded:Array.from({length:30},(_,i)=>i)},
    compact={version:2,gift_refresh:gift,marketapp_budget_reset:reset};
  f.event(1,JSON.stringify({...compact,padding:'x'.repeat(400000)}));f.event(2,JSON.stringify(compact));
  f.event(3,JSON.stringify({padding:'x'.repeat(300000)}));f.event(4,JSON.stringify(compact));f.event(5);
  await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);
  while(!(await f.index.ensurePage('private')).complete){}
  const original=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(),storage=createCheckpointStorage(f.db,{sourceScope:'private'});
  const result=await storage.compactCheckpointBudgetResetsPage({after:1,boundary:5,limit:4});
  assert.equal(result.rewritten,1);assert.equal(result.after,4);
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get(),original[1]);
  const row=f.database.prepare('SELECT * FROM cloud_events WHERE sequence=4').get(),physical=JSON.parse(row.state_json);
  assert.equal(physical.__checkpoint_budget_reset_sequence,1);assert.equal(physical.__checkpoint_gift_state_sequence,2);
  assert.deepEqual(decodeCheckpoint(row,row,null,null,await storage.giftStateSource(2),await storage.budgetResetSource(1)),compact);
  for(const before of original) {
    const after=f.database.prepare('SELECT * FROM cloud_events WHERE sequence=?').get(before.sequence);
    for(const column of ['records_json','raw_body','observed_at'])assert.equal(after[column],before[column]);
  }
});

test('owned-state publication rechecks canonical source guards after duplicate-root or target-marker races',async t=>{
  const own={version:1,run:{id:3,wallet:'wallet',results:{nft:{exact_amount:'123456789',memo:'x'.repeat(100)}}}},
    logical={version:2,owned_prices:own};
  const replacements=[`{"owned_prices":${JSON.stringify(own)},"owned_prices":{}}`,
    `{"owned_prices":${JSON.stringify(own)},"__checkpoint_owned_targets_sequence":null,"__checkpoint_owned_targets_sequence":1}`];
  for(const replacement of replacements) {
    const f=fixture(t);for(let sequence=1;sequence<=3;sequence++)f.event(sequence,JSON.stringify(logical));
    await readyUsage(f.db);await installCheckpointSourceAccounting(f.db);await f.index.ensurePage('private');
    const candidate=f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get();let injected=false;
    const raced={...f.db,async run(sql,params={}) {
      if(!injected&&/UPDATE cloud_events SET state_json=json_set\(/.test(sql)&&sql.includes("'$.__checkpoint_owned_state_sequence'")) {
        injected=true;f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run(replacement);
      }
      return f.db.run(sql,params);
    }};
    const storage=createCheckpointStorage(raced,{sourceScope:'private'}),result=await storage.compactCheckpointOwnedStatesPage({after:0,boundary:3,limit:4});
    assert.equal(injected,true);assert.equal(result.rewritten,0);
    assert.equal(await storage.ownedStateSource(1),null);
    assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get(),candidate);
    assert.deepEqual(decodeCheckpoint(candidate,candidate),logical);
  }
});
