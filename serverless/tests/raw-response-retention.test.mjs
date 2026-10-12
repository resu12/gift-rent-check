import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createStorageAdmission,StorageCapacityError} from '../tgcloud/lib/storage-admission.js';
import {storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

const MiB=1048576,owner='101',observed=new Date().toISOString();
const event=(key,state={version:2,next_job_id:1,job:null,attempts:[1000],next_allowed_at:2000})=>({
  key,state,job:state.job,observed_at:observed,
  records:[{kind:'listing',key:'validated-listing',observed_at:observed,record:{identity:'known-nft',source_json:{nft_address:'known-nft',price_per_day:'170000001',note:'€🙂'}}}],
  raw_body:JSON.stringify({body:'discarded-provider-payload'.repeat(100000)}),
});

function repository(f,kind,admission=null) {
  return kind==='public'?f.repository(owner,{storageAdmission:admission,maxAccountBytes:4096,maxServiceBytes:16384})
    :createCloudRepository(f.db,{storageAdmission:admission});
}
function websiteSession(f) {
  const at=Date.now();
  f.database.prepare(`INSERT INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version,wallet,wallet_revision,ciphertext,created_at,expires_at)
    VALUES(?,0,0,0,'known-wallet',0,'synthetic-encrypted-session',?,?)`).run(owner,at-1000,at+120000);
  return {value:{owner,wallet:'known-wallet',cookie_version:0},fence:{generation:0,wallet_revision:0}};
}
const append=(repo,kind,expected,value,stored)=>kind==='website'?repo.appendWebsite(expected,value,owner,stored):repo.append(expected,value);

test('private, website and public saves discard duplicate provider bodies while preserving records, state and idempotency',async t=>{
  for(const kind of ['private','website','public']) {
    const f=createPublicDatabase(t),repo=repository(f,kind),stored=kind==='website'?websiteSession(f):null,value=event('provider-page');
    if(kind==='public')await repo.ensureAccount();
    assert.equal(await append(repo,kind,0,value,stored),true);
    assert.deepEqual(await repo.records(),value.records);
    assert.deepEqual(await repo.event(value.key),value.records);
    assert.deepEqual(await repo.read(),{revision:1,state:value.state});
    const table=kind==='public'?'public_cloud_events':'cloud_events',row=f.database.prepare(`SELECT * FROM ${table}`).get();
    assert.equal(row.raw_body,null);assert.equal(row.records_json,JSON.stringify(value.records));
    assert.doesNotMatch(JSON.stringify(row),/discarded-provider-payload/);
    assert.equal(await append(repo,kind,1,value,stored),false);
    assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);
    assert.deepEqual(await repo.read(),{revision:1,state:value.state});
  }
});

test('admission and public byte quotas charge retained UTF-8 data and source-pin headroom, not discarded bodies',async t=>{
  for(const kind of ['private','website','public']) {
    const f=createPublicDatabase(t),calls=[],admission={fence(bytes,token,options){calls.push({bytes,token,options});return{sql:'1',parameters:{}};},async assertAdmitted(){assert.fail('unexpected admission fallback');}},
      repo=repository(f,kind,admission),stored=kind==='website'?websiteSession(f):null,value=event('sized-provider-page');
    if(kind==='public')await repo.ensureAccount();
    assert.equal(await append(repo,kind,0,value,stored),true);
    const table=kind==='public'?'public_cloud_events':'cloud_events',retained=f.database.prepare(`SELECT ${storageTableByteExpression(table)} AS bytes FROM ${table}`).get().bytes;
    assert.equal(calls.length,1);assert.equal(calls[0].bytes,retained+1024);
    assert.ok(retained<4096);assert.ok(Buffer.byteLength(value.raw_body)>2*MiB);
  }
});

test('dropping a provider body never grants recovery-control admission to a provider result',async t=>{
  for(const kind of ['private','public']) {
    const f=createPublicDatabase(t);
    f.database.prepare('INSERT INTO service_storage_usage(id,total_bytes,initialized_at) VALUES(1,0,?)').run(Date.now());
    f.database.prepare('INSERT INTO service_storage_monitor(id,document,lease_until) VALUES(1,?,0)').run('{"paused":true}');
    const admission=createStorageAdmission(f.db,{policy:{budgetBytes:32*MiB,reserveBytes:MiB}}).forScope(kind==='public'?'public:101':'private'),
      repo=repository(f,kind,admission),job={id:1,state:'running',lease:null,lease_until:0},running={...event('running',{version:2,job}),records:[],raw_body:null};
    if(kind==='public')await repo.ensureAccount();
    assert.equal(await repo.append(0,running),true);
    f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(29*MiB);
    const stopped={...job,state:'partial',reason:'stopped_by_you'},provider={...event('provider-stopped',{version:2,job:stopped}),records:[]};
    await assert.rejects(repo.append(1,provider),StorageCapacityError);
    assert.equal((await repo.read()).state.job.state,'running');
    assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${kind==='public'?'public_cloud_events':'cloud_events'}`).get().n,1);
    assert.equal(await repo.append(1,{...provider,key:'real-stop',raw_body:null}),true);
    assert.equal((await repo.read()).state.job.reason,'stopped_by_you');
  }
});

test('a bounded live reservation can save its validated result even when a discarded body is larger',async t=>{
  const f=createPublicDatabase(t);
  f.database.prepare('INSERT INTO service_storage_usage(id,total_bytes,initialized_at) VALUES(1,0,?)').run(Date.now());
  const admission=createStorageAdmission(f.db,{policy:{budgetBytes:32*MiB,reserveBytes:MiB}}).forScope('private'),repo=repository(f,'private',admission),
    token='provider-result-storage-reservation';
  await admission.reserveStorage({token,bytes:4096,expiresAt:Date.now()+120000,kind:'comparison'});
  const value={...event('reserved-provider-page'),storage_token:token};
  assert.equal(await repo.append(0,value),true);
  assert.deepEqual(await repo.records(),value.records);
  assert.equal(f.database.prepare('SELECT raw_body FROM cloud_events').get().raw_body,null);
});
