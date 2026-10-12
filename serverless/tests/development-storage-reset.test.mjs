import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {installStorageAccounting} from '../tools/storage-accounting.mjs';
import {installCompactOperationalStorage} from '../tools/compact-operational-storage.mjs';
import {installNormalizedRecordStorage} from '../tools/normalized-record-storage.mjs';
import {beginDevelopmentStorageReset,disposeDevelopmentStorage} from '../tools/development-storage-reset.mjs';

async function fixture(t) {
  const f=createPublicDatabase(t);let result,after=0;
  do {result=await installStorageAccounting(f.db,{after});after=result.after;}while(!result.complete);
  await installCompactOperationalStorage(f.db);
  await installNormalizedRecordStorage(f.db);
  const state={version:2,next_job_id:12,job:null,attempts:[100,200],next_allowed_at:300};
  const records=[{kind:'settings',record:{wallet:'saved wallet'}},{kind:'portfolio',record:{nft_address:'saved gift'}},
    {kind:'metadata',record:{model:'saved model'}},{kind:'history',record:{source_json:{price:'1.0'}}}];
  f.database.prepare("INSERT INTO cloud_events VALUES(1,'old-import',?,NULL,NULL,?,NULL,'today')").run(JSON.stringify(state),JSON.stringify(records));
  f.database.exec("INSERT INTO public_accounts(user_id,created_at) VALUES('123',1)");
  f.database.exec("INSERT INTO public_cloud_events VALUES('other','123',1,'other','{}',NULL,NULL,'[]',NULL,'today')");
  f.database.exec("INSERT INTO private_provider_credentials(row_id,user_id,provider,nonce_counter,credential_version,ciphertext) VALUES('owner','123450001','marketapp',7,3,'encrypted')");
  f.database.exec("INSERT INTO marketapp_website_requests VALUES('request','owner',1)");
  return f;
}
test('development reset preserves access, limits, bindings and monotonic IDs; bounded disposal retains saved gift traits',async t=>{
  const f=await fixture(t),key='dev-reset:12345678-1234-1234-1234-123456789012';
  const started=await beginDevelopmentStorageReset(f.db,{resetId:key});assert.equal(started.floor,2);
  const current=await createCloudRepository(f.db).read();
  assert.deepEqual(await createCloudRepository(f.db).event(key),[{kind:'development_reset',record:{floor:2}}]);
  assert.equal(current.state.record_storage_floor,2);assert.equal(current.state.next_job_id,12);
  assert.deepEqual(current.state.attempts,[100,200]);assert.equal(current.state.next_allowed_at,300);
  assert.equal((await beginDevelopmentStorageReset(f.db,{resetId:key})).already_started,true);
  let result,after=0;do {result=await disposeDevelopmentStorage(f.db,{floor:2,resetId:key,after,limit:1});after=result.after;}while(!result.complete);
  const old=f.database.prepare("SELECT * FROM cloud_events WHERE sequence=1").get();
  assert.equal(old.event_key,'old-import');assert.equal(old.state_json,'{}');
  assert.deepEqual(JSON.parse(old.records_json).map(row=>row.kind),['settings','portfolio','metadata']);
  assert.equal(f.database.prepare('SELECT nonce_counter FROM private_provider_credentials').get().nonce_counter,7);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM marketapp_website_requests').get().n,1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n,1);
  assert.equal((await createCloudRepository(f.db).append(1,{key:'late',state:{},records:[],observed_at:'now'})),false);
});
test('disposal refuses an incorrect floor and reset requires installed atomic triggers',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>disposeDevelopmentStorage(f.db,{floor:1,resetId:'dev-reset:1234567812345678'}),/changed/);
  f.database.exec('DROP TRIGGER operational_storage_v1_private_insert');
  await assert.rejects(()=>beginDevelopmentStorageReset(f.db,{resetId:'dev-reset:1234567812345678'}),/not installed/);
});

test('repeated disposal preserves normalized trait ordinals after an earlier market observation is removed',async t=>{
  const f=await fixture(t),first='dev-reset:1234567812345678',second='dev-reset:8765432187654321';
  await beginDevelopmentStorageReset(f.db,{resetId:first});
  const repo=createCloudRepository(f.db),saved=await repo.read();
  const metadata={kind:'metadata',record:{identity:'gift',model:'keep'}};
  assert.equal(await repo.append(2,{key:'mixed-normalized',state:saved.state,records:[{kind:'history',record:{old:'remove'}},metadata],observed_at:'today'}),true);
  const reset=await beginDevelopmentStorageReset(f.db,{resetId:second});
  let result,after=0;do {result=await disposeDevelopmentStorage(f.db,{floor:reset.floor,resetId:second,after});after=result.after;}while(!result.complete);
  assert.deepEqual(await repo.event('mixed-normalized'),[{},metadata]);
  const records=await repo.records(reset.floor);assert.ok(records.every(row=>row!==null),JSON.stringify(f.database.prepare('SELECT sequence,records_json FROM cloud_events').all()));
  assert.ok(records.some(row=>row.record?.model==='keep'));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_record_payloads').get().n,1);
});

const publicResetKey='dev-reset:public-reset-1234567890';
const publicNextKey='dev-reset:public-replacement-1234567890';
async function seedPublic(f,label='original',count=1) {
  const repo=f.repository(101);
  for(let sequence=0;sequence<count;sequence++) {
    assert.equal(await repo.append(sequence,{key:`${label}:${sequence}`,state:{version:2,next_job_id:12,job:null,
      attempts:[100,200],next_allowed_at:300},records:[{kind:'settings',record:{wallet:label}},
      {kind:'history',record:{identity:label,price:'0.1'}}],observed_at:'2026-10-12T12:00:00.000Z'}),true);
  }
  return repo;
}
async function replacePublic(f,repo,label='replacement') {
  let deleted=await repo.deleteAccountData(5);
  while(deleted.pending_cleanup)deleted=await repo.processAccountDeletion(5);
  await repo.reactivateAccount();
  return await seedPublic(f,label);
}
function publicRows(f) {
  return f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all('101');
}

for(const phase of ['before_binding','before_read','after_read','before_insert']) {
  test(`public development reset rejects account replacement ${phase}`,async t=>{
    const f=await fixture(t),original=await seedPublic(f);
    let raced=false,expected;
    async function replace() {raced=true;await replacePublic(f,original);expected=publicRows(f);}
    const db={...f.db,
      async get(sql,args) {
        if(!raced&&phase==='before_binding'&&sql.includes('AND event_key=:key'))await replace();
        const reading=sql.startsWith('SELECT sequence,state_json,job_id,job_json FROM public_cloud_events');
        if(!raced&&phase==='before_read'&&reading)await replace();
        const result=await f.db.get(sql,args);
        if(!raced&&phase==='after_read'&&reading)await replace();
        return result;
      },
      async run(sql,args) {
        if(!raced&&phase==='before_insert'&&sql.startsWith('INSERT INTO public_cloud_events(')&&args?.[':key']===publicResetKey)await replace();
        return await f.db.run(sql,args);
      },
    };
    await assert.rejects(beginDevelopmentStorageReset(db,{scope:'public:101',resetId:publicResetKey}),
      /account changed|account is unavailable|Data changed|account was deleted|account is not active/i);
    assert.equal(raced,true);assert.deepEqual(publicRows(f),expected);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events WHERE user_id=? AND event_key=?').get('101',publicResetKey).n,0);
    assert.equal((await f.repository(101).records())[0].record.wallet,'replacement');
  });
}

test('public disposal requires the original reset key and leaves all data untouched on mismatch',async t=>{
  const f=await fixture(t);await seedPublic(f);
  const reset=await beginDevelopmentStorageReset(f.db,{scope:'public:101',resetId:publicResetKey}),before=publicRows(f);
  await assert.rejects(disposeDevelopmentStorage(f.db,{...reset,resetId:publicNextKey}),/reset changed/);
  assert.deepEqual(publicRows(f),before);
  assert.deepEqual(await f.repository(101).event(publicResetKey),[{kind:'development_reset',record:{floor:2}}]);
});

for(const originalCount of [1,3])test(`old public disposal cannot affect a recreated account with ${originalCount===1?'reused':'lower'} sequence numbers`,async t=>{
  const f=await fixture(t),original=await seedPublic(f,'original',originalCount);
  const old=await beginDevelopmentStorageReset(f.db,{scope:'public:101',resetId:publicResetKey});
  await replacePublic(f,original);
  const fresh=await beginDevelopmentStorageReset(f.db,{scope:'public:101',resetId:publicNextKey}),before=publicRows(f);
  assert.ok(fresh.generation>old.generation);
  assert.equal(fresh.floor,2);assert.equal(old.floor,originalCount+1);
  await assert.rejects(disposeDevelopmentStorage(f.db,old),/reset changed/);
  // Matching a recycled floor is insufficient: both key and generation are
  // independently required, even if an old administrative worker resumes.
  await assert.rejects(disposeDevelopmentStorage(f.db,{...fresh,generation:old.generation}),/reset changed/);
  await assert.rejects(disposeDevelopmentStorage(f.db,{...fresh,resetId:old.resetId}),/reset changed/);
  assert.deepEqual(publicRows(f),before);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM public_cloud_events WHERE user_id='123'").get().n,1);
});

test('public disposal rechecks its account generation at the write after the page was selected',async t=>{
  const f=await fixture(t),original=await seedPublic(f);
  const old=await beginDevelopmentStorageReset(f.db,{scope:'public:101',resetId:publicResetKey});
  let raced=false,expected;
  const db={...f.db,async all(sql,args) {
    const rows=await f.db.all(sql,args);
    if(!raced&&sql.startsWith('WITH pending AS(SELECT sequence,')) {
      raced=true;await replacePublic(f,original);
      await beginDevelopmentStorageReset(f.db,{scope:'public:101',resetId:publicResetKey});
      expected=publicRows(f);
    }
    return rows;
  }};
  await assert.rejects(disposeDevelopmentStorage(db,old),/lost its fence/);
  assert.equal(raced,true);assert.deepEqual(publicRows(f),expected);
});
