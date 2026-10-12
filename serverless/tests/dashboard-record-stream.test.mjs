import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository,PublicAccountError} from '../tgcloud/lib/public-repository.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';

const at='2026-10-11T12:00:00.000Z';
async function fixture(t,mode) {
  const f=createPublicDatabase(t),batches=[];
  const db={...f.db,async all(sql,params){
    const rows=await f.db.all(sql,params);
    if(sql.includes('WITH pending')) {
      batches.push(rows.map(row=>row.sequence));
      assert.ok(rows.length<=16);
      assert.ok(rows.reduce((bytes,row)=>bytes+Buffer.byteLength(row.records_json),0)<=1048576||rows.length===1);
    }
    return rows;
  }};
  const repo=mode==='private'?createCloudRepository(db):createPublicRepository(db,'101');
  if(mode==='public')await repo.ensureAccount();
  function insert(sequence,records,user='101',pretty=false) {
    const raw=typeof records==='string'?records:JSON.stringify(records,null,pretty?2:undefined);
    if(mode==='private')f.database.prepare(`INSERT INTO cloud_events(sequence,event_key,state_json,records_json,observed_at)
      VALUES(?,?,?, ?,?)`).run(sequence,'event-'+sequence,'{}',raw,at);
    else f.database.prepare(`INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(JSON.stringify([user,sequence]),user,sequence,'event-'+sequence,'{}',raw,at);
  }
  return {...f,db,repo,batches,insert};
}

for(const mode of ['private','public']) {
  test(`${mode} small events are batched without losing frozen records or order`,async t=>{
    const f=await fixture(t,mode),expected=[];
    for(let index=1;index<=100;index++) {
      const record={kind:'history',key:String(index),record:{text:'quotes " slash \\ and 🦋'}};
      f.insert(index,[record]);expected.push(record);
    }
    f.insert(101,[{kind:'history',key:'future'}]);
    assert.deepEqual(await f.repo.records(100),expected);
    assert.deepEqual(f.batches.map(batch=>batch.length),[16,16,16,16,16,16,4,0]);
  });

  test(`${mode} escaped data stays below the byte budget before the row limit`,async t=>{
    const f=await fixture(t,mode),expected=[];
    for(let index=1;index<=10;index++) {
      const record={kind:'history',key:String(index),record:{text:'"\\'.repeat(30000)}};
      f.insert(index,[record]);expected.push(record);
    }
    assert.deepEqual(await f.repo.records(10),expected);
    assert.ok(f.batches.filter(batch=>batch.length).every(batch=>batch.length<=8));
  });

  test(`${mode} streamed records retain sparse order, frozen revision and bounded multibyte pages`,async t=>{
    const f=await fixture(t,mode),expected=[];
    for(let index=0;index<9;index++) {
      const records=[{kind:'listing',key:'listing-'+index,record:{unknown:'🦋'.repeat(60000)}},
        {kind:'history',key:'history-'+index,record:{nested:{preserved:true}}}];
      f.insert(index*3+2,records);if(index*3+2<=20)expected.push(...records);
    }
    if(mode==='public')f.insert(1,[{kind:'settings',record:{wallet:'foreign-wallet'}}],'202');
    const seen=[];let visits=0;
    assert.equal(await f.repo.visitRecords(20,async page=>{
      visits++;await Promise.resolve();
      if(visits===1)f.insert(100,[{kind:'settings',record:{wallet:'later-wallet'}}]);
      seen.push(...page);
    }),undefined);
    assert.equal(visits,7);assert.deepEqual(seen,expected);
    assert.deepEqual(await f.repo.records(20),expected);
    assert.ok(f.batches.every(batch=>batch.every(sequence=>sequence<=20)));
  });

  test(`${mode} dashboard seeds preserve every matching envelope and settings order with spaced JSON`,async t=>{
    const f=await fixture(t,mode),first={kind:'settings',observed_at:at,record:{wallet:'old',unknown:{saved:1}}},
      gift={kind:'gift',record:{nft_address:'gift-a',extra:'keep'}},portfolio={kind:'portfolio',record:{nft_address:'gift-b',is_portfolio:true}},
      last={kind:'settings',record:{wallet:'new',wallet_address:'fallback'}};
    f.insert(2,[first,{kind:'history',record:{label:'portfolio'}}]);
    f.insert(7,[{kind:'listing',record:{label:'gift'}},gift,portfolio],undefined,true);
    f.insert(8,[{kind:'metadata',record:{label:'settings'}},null]);
    f.insert(11,[last],undefined,true);
    f.insert(12,[{kind:'settings',record:{wallet:'future'}}]);
    if(mode==='public')f.insert(3,[{kind:'portfolio',record:{nft_address:'foreign'}}],'202');
    assert.deepEqual(await f.repo.dashboardSeedRecords(11),[first,gift,portfolio,last]);
    assert.deepEqual(await f.repo.dashboardSeedRecords(0),[]);
  });

  test(`${mode} visitors are awaited, errors abort and invalid traversal cannot read`,async t=>{
    const f=await fixture(t,mode);
    for(let index=1;index<=7;index++)f.insert(index,[{key:String(index)}]);
    const failure=Error('Synthetic visitor failure');let release,visits=0;
    const gate=new Promise(resolve=>{release=resolve;});
    const pending=f.repo.visitRecords(7,async()=>{visits++;await gate;throw failure;});
    // Public traversal performs several account checks before its first page.
    while(visits===0)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(visits,1);assert.equal(f.batches.length,1);
    release();await assert.rejects(pending,error=>error===failure);
    assert.equal(visits,1);assert.equal(f.batches.length,1);
    const before=f.queries.length;
    for(const until of [-1,1.5,Number.MAX_SAFE_INTEGER+1,null])await assert.rejects(f.repo.visitRecords(until,()=>{}),/Invalid record traversal/);
    await assert.rejects(f.repo.visitRecords(7,null),/Invalid record traversal/);
    assert.equal(f.queries.length,before);
  });

  test(`${mode} streaming preserves the legacy oversized-row fallback and parse errors`,async t=>{
    const f=await fixture(t,mode);
    f.insert(1,[{key:'oversized',value:'x'.repeat(1100000)}]);
    f.insert(2,[{key:'small'}]);f.insert(3,'invalid JSON');
    const seen=[];await assert.rejects(f.repo.visitRecords(3,page=>{seen.push(...page.map(row=>row.key));}),SyntaxError);
    assert.deepEqual(seen,['oversized','small']);assert.deepEqual(f.batches[0],[1]);
  });
}

test('public streaming aborts when the account is deleted or reactivated during a visitor',async t=>{
  for(const status of ['deleted','active']) {
    const f=await fixture(t,'public');for(let sequence=1;sequence<=8;sequence++)f.insert(sequence,[{key:String(sequence)}]);
    let visits=0;
    await assert.rejects(f.repo.visitRecords(8,()=>{
      visits++;if(visits===1)f.database.prepare('UPDATE public_accounts SET status=?,generation=generation+1 WHERE user_id=?').run(status,'101');
    }),PublicAccountError);
    assert.equal(f.batches.length,1);
  }
});

test('public end-of-stream account recheck rejects deletion races inside the final ACTIVE query',async t=>{
  for(const kind of ['visit','seeds']) {
    const f=await fixture(t,'public');let raced=false;
    const db={...f.db,async all(sql,params){
      if(!raced&&sql.includes('WITH pending')) {
        raced=true;f.database.prepare("UPDATE public_accounts SET generation=generation+1 WHERE user_id='101'").run();
      }
      return f.db.all(sql,params);
    }};
    const repo=createPublicRepository(db,'101',{accountGenerationFence:0});
    await assert.rejects(kind==='seeds'?repo.dashboardSeedRecords(10):repo.visitRecords(10,()=>{throw Error('Must not visit new generation');}),PublicAccountError);
    assert.equal(raced,true);
  }
});
