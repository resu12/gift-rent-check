import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createStorageMaintenance} from '../tgcloud/lib/storage-maintenance.js';
import {DEFAULT_STORAGE_POLICY, normalizeStoragePolicy, STORAGE_TABLES, storageTableByteExpression, storagePaused, utf8Size} from '../tgcloud/lib/storage-policy.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository} from '../tgcloud/lib/public-repository.js';
import {checkpointSourceAccountingTriggers, storageAccountingTriggers} from '../tools/storage-accounting.mjs';

const MiB = 1048576, owner = '123450001', invited = '678900002';
function fixture(t, {bytes = 0, document = '{}', beforeWrite = null, accountScopes = false, maxAccountBytes} = {}) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const integers = new Set(['id','revision','sequence','job_id','created_at','expires_at','generation','nonce_counter','cookie_version','wallet_revision',
    'lease_until','next_allowed_at','attempted_at','run_id','source_sequence','records_revision','time_bucket','deleted_at','wallet_nonce_counter',
    'credential_version','updated_at','boundary','wallet_disconnect_revision','consumed_at']);
  for (const table of STORAGE_TABLES) {
    const primary = table.name === 'cloud_events' ? 'sequence' : table.name === 'public_cloud_events' ? 'row_id'
      : table.name === 'public_accounts' ? 'user_id' : table.name === 'collector_state' ? 'id' : table.columns[0];
    database.exec(`CREATE TABLE ${table.name}(${table.columns.map(column => `${column} ${integers.has(column) ? 'INTEGER' : 'TEXT'}${column === primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
  }
  database.exec(`CREATE TABLE service_storage_usage(id INTEGER PRIMARY KEY,total_bytes INTEGER NOT NULL,initialized_at INTEGER);
    CREATE TABLE service_storage_scope_usage(scope TEXT PRIMARY KEY,total_bytes INTEGER NOT NULL,initialized_at INTEGER);
    CREATE TABLE service_storage_monitor(id INTEGER PRIMARY KEY,document TEXT NOT NULL,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE service_storage_reservations(token TEXT PRIMARY KEY,bytes INTEGER,expires_at INTEGER,kind TEXT);
    CREATE TABLE service_checkpoint_source_scans(scope TEXT PRIMARY KEY,after_sequence INTEGER NOT NULL DEFAULT 0,
      boundary_sequence INTEGER NOT NULL DEFAULT 0,initialized_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX service_checkpoint_sources_lookup_idx ON service_checkpoint_sources(scope,kind,source_sequence);`);
  const at = Date.now();
  database.prepare('INSERT INTO service_storage_usage VALUES(1,?,?)').run(bytes, at);
  database.prepare('INSERT INTO service_storage_scope_usage VALUES(?,?,?)').run(`public:${invited}`, 1234, at);
  database.prepare('INSERT INTO service_storage_monitor(id,document) VALUES(1,?)').run(document);
  if (accountScopes) for (const trigger of storageAccountingTriggers()) database.exec(trigger.sql);
  else for (const table of STORAGE_TABLES) for (const [operation, expression] of [['INSERT', storageTableByteExpression(table,'NEW.')],
    ['DELETE', `-(${storageTableByteExpression(table,'OLD.')})`], ['UPDATE', `(${storageTableByteExpression(table,'NEW.')})-(${storageTableByteExpression(table,'OLD.')})`]])
    database.exec(`CREATE TRIGGER ${table.name}_${operation.toLowerCase()} AFTER ${operation} ON ${table.name}
      BEGIN UPDATE service_storage_usage SET total_bytes=total_bytes+(${expression}) WHERE id=1; END;`);
  for (const trigger of checkpointSourceAccountingTriggers()) database.exec(trigger.sql);
  const queries = [], db = {async get(sql, params = {}) {queries.push({kind:'get',sql,params});return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {queries.push({kind:'all',sql,params});return database.prepare(sql).all(params);},
    async run(sql, params = {}) {beforeWrite?.(database,sql,params);queries.push({kind:'run',sql,params});return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  const core = createStorageMaintenance({db, ownerTelegramId:owner, ...(maxAccountBytes === undefined ? {} : {maxAccountBytes})});
  const row = () => JSON.parse(database.prepare('SELECT document FROM service_storage_monitor WHERE id=1').get().document);
  async function finish() {let value = await core.step({userId:owner,isOwner:true,manual:true});for(let i=0;i<300 && value.cleanup.state==='running';i++)value=await core.step({userId:owner,isOwner:true});return value;}
  function event(sequence, logical, raw = '{"evidence":"keep"}') {
    database.prepare('INSERT INTO cloud_events(sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(sequence,`synthetic:${sequence}`,JSON.stringify(logical),logical.job?.id ?? null,logical.job?JSON.stringify(logical.job):null,
        JSON.stringify([{kind:'history',record:{exact_amount:'123456789'}}]),raw,'2026-10-11T10:00:00.000Z');
  }
  return {database,db,core,queries,row,finish,event,at};
}

const privatePhases = ['jobs','targets','owned_states','gift_states','budget_resets'];
const physicalReads = f => f.queries.filter(query => Object.hasOwn(query.params, ':physical_after'));
function save(f, cleanup) {
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1')
    .run(JSON.stringify({...f.row(),version:1,cleanup}));
}
function mark(boundary, fullAt) {return {version:1,boundary,full_at:fullAt};}
function running(phase, boundary, overrides={}) {
  return {state:'running',phase,after:0,boundary,tenant:null,last_tenant:'',reclaimed_bytes:0,...overrides};
}
async function finishActive(f) {
  let value=await f.core.status({userId:owner,isOwner:true});
  for(let i=0;i<300&&['running','blocked'].includes(value.cleanup.state);i++)
    value=await f.core.step({userId:owner,isOwner:true,manual:value.cleanup.state==='blocked'});
  return value;
}

test('completed private scans revisit only new history and the former protected head',async t=>{
  const f=fixture(t),job={id:2,state:'partial',streams:[{cursor:'saved',complete:false}]};
  const logical={version:2,attempts:[],next_allowed_at:0,job};
  for(let sequence=1;sequence<=60;sequence++)f.event(sequence,logical);
  const before=f.database.prepare('SELECT sequence,records_json,raw_body,job_json FROM cloud_events ORDER BY sequence').all();
  assert.equal((await f.finish()).cleanup.state,'complete');
  const first=f.row().cleanup;
  for(const phase of privatePhases) {
    assert.equal(first.scan_marks[phase].boundary,60);
    assert.ok(first.scan_marks[phase].full_at>=f.at);
  }
  assert.ok(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=60').get().state_json).job);
  f.event(61,logical);f.event(62,logical);f.queries.length=0;
  assert.equal((await f.finish()).cleanup.state,'complete');
  assert.ok(physicalReads(f).length>0);
  assert.ok(physicalReads(f).every(query=>query.params[':physical_after']>=59));
  const second=f.row().cleanup;
  for(const phase of privatePhases) {
    assert.equal(second.scan_marks[phase].boundary,62);
    assert.equal(second.scan_marks[phase].full_at,first.scan_marks[phase].full_at);
  }
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=60').get().state_json).job,undefined);
  assert.ok(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=62').get().state_json).job);
  assert.deepEqual(f.database.prepare('SELECT sequence,records_json,raw_body,job_json FROM cloud_events WHERE sequence<=60 ORDER BY sequence').all(),before);
  assert.deepEqual((await createCloudRepository(f.db).read()).state,logical);
});

test('routine incremental cleanup still removes newly expired metadata',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=30;sequence++)f.event(sequence,{version:2});
  await f.finish();
  f.database.prepare('INSERT INTO marketapp_login_attempts(attempt_id,owner_id,created_at,expires_at,state) VALUES(?,?,?,?,?)')
    .run('newly-expired',owner,f.at-4*86400000,f.at-3*86400000,'expired');
  f.queries.length=0;await f.finish();
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM marketapp_login_attempts').get().n,0);
  assert.ok(physicalReads(f).every(query=>query.params[':physical_after']>=29));
});

test('full scan is required after 24 hours, algorithm change, invalid marker or boundary regression',async t=>{
  for(const invalid of [mark(80,Date.now()-86400001),{...mark(80,Date.now()),version:0},
    {...mark(80,Date.now()),boundary:-1},{...mark(80,Date.now()),full_at:Date.now()+86400000},mark(999,Date.now()),null]) {
    const f=fixture(t);for(let sequence=1;sequence<=90;sequence++)f.event(sequence,{version:2});
    save(f,running(8,90,{scan_marks:{jobs:invalid}}));
    await f.core.step({userId:owner,isOwner:true});
    assert.equal(physicalReads(f)[0].params[':physical_after'],0);
    assert.equal((await finishActive(f)).cleanup.state,'complete');
    assert.equal(f.row().cleanup.scan_marks.jobs.version,1);
    assert.equal(f.row().cleanup.scan_marks.jobs.boundary,90);
    assert.ok(f.row().cleanup.scan_marks.jobs.full_at>=f.at);
  }
});

test('legacy partial scans continue in place but cannot certify a complete new-algorithm sweep',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=90;sequence++)f.event(sequence,{version:2});
  save(f,running(8,90,{after:50}));
  await f.core.step({userId:owner,isOwner:true});
  assert.equal(physicalReads(f)[0].params[':physical_after'],50);
  await finishActive(f);assert.equal(f.row().cleanup.scan_marks.jobs,undefined);
  f.queries.length=0;await f.finish();
  assert.equal(physicalReads(f)[0].params[':physical_after'],0);
  assert.equal(f.row().cleanup.scan_marks.jobs.boundary,90);
});

test('watermark advances only after its phase completes and failed writes preserve the durable mark',async t=>{
  let fail=false;
  const f=fixture(t,{beforeWrite(_database,sql){if(fail&&/^UPDATE cloud_events SET/.test(sql))throw new Error('synthetic failure');}});
  const logical={version:2,job:{id:2,state:'partial',streams:[]}};
  for(let sequence=1;sequence<=90;sequence++)f.event(sequence,logical);
  const existing=mark(40,f.at);save(f,running(8,90,{scan_marks:{jobs:existing}}));
  fail=true;await f.core.step({userId:owner,isOwner:true});
  assert.deepEqual(f.row().cleanup.scan_marks.jobs,existing);
  assert.equal(f.row().cleanup.state,'blocked');
  fail=false;await finishActive(f);
  assert.equal(f.row().cleanup.scan_marks.jobs.boundary,90);
  assert.equal(f.row().cleanup.scan_marks.jobs.full_at,existing.full_at);
});

test('incremental progress measures the current stage range and never changes account responses',async t=>{
  const f=fixture(t);
  save(f,running(8,110,{after:104,phase_scan:{version:1,phase:'jobs',boundary:110,origin:99,full:false,previous_full_at:f.at}}));
  const value=await f.core.status({userId:owner,isOwner:true,progress:true});
  assert.equal(value.cleanup.progress.percent,45);
  assert.equal(Object.hasOwn((await f.core.status({userId:owner,isOwner:true})).cleanup,'progress'),false);
  assert.equal(JSON.stringify(value).includes('scan_marks'),false);
  assert.equal(JSON.stringify(value).includes('phase_scan'),false);
});

test('scan metadata stays bounded to five sanitized private phases',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=3;sequence++)f.event(sequence,{version:2});
  save(f,running(8,3,{scan_marks:{jobs:{...mark(2,f.at),untrusted:'discard'},
    unknown:{...mark(2,f.at)},targets:mark(2,f.at),owned_states:mark(2,f.at),gift_states:mark(2,f.at),budget_resets:mark(2,f.at)}}));
  await finishActive(f);
  assert.deepEqual(Object.keys(f.row().cleanup.scan_marks).sort(),privatePhases.toSorted());
  for(const value of Object.values(f.row().cleanup.scan_marks))assert.deepEqual(Object.keys(value).sort(),['boundary','full_at','version']);
});

test('corrupt in-flight scan evidence cannot certify skipped rows as fully checked',async t=>{
  for(const scan of [
    {version:1,phase:'jobs',boundary:60,origin:40,full:true,previous_full_at:0},
    {version:1,phase:'jobs',boundary:60,origin:40,full:false,previous_full_at:Date.now()+86400000},
  ]) {
    const f=fixture(t);for(let sequence=1;sequence<=60;sequence++)f.event(sequence,{version:2});
    save(f,running(8,60,{after:50,phase_scan:scan}));
    await finishActive(f);
    assert.equal(f.row().cleanup.scan_marks.jobs,undefined);
    f.queries.length=0;await f.finish();
    assert.equal(physicalReads(f)[0].params[':physical_after'],0);
  }
});
