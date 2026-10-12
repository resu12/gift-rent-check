import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createStorageMaintenance} from '../tgcloud/lib/storage-maintenance.js';
import {DEFAULT_STORAGE_POLICY, normalizeStoragePolicy, STORAGE_TABLES, storageTableByteExpression, storagePaused, utf8Size} from '../tgcloud/lib/storage-policy.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository} from '../tgcloud/lib/public-repository.js';
import {checkpointSourceAccountingTriggers, storageAccountingTriggers} from '../tools/storage-accounting.mjs';

const MiB = 1048576, owner = '123450001', invited = '678900002';
const day = 86400000;
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
  const queries = [], db = {async get(sql, params = {}) {queries.push({kind:'get',sql});return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {queries.push({kind:'all',sql});return database.prepare(sql).all(params);},
    async run(sql, params = {}) {beforeWrite?.(database,sql,params);queries.push({kind:'run',sql});return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
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

test('safety policy is configurable and explicitly smaller than assumed platform capacity', () => {
  assert.equal(DEFAULT_STORAGE_POLICY.budgetBytes,512*MiB);
  assert.deepEqual(normalizeStoragePolicy(),DEFAULT_STORAGE_POLICY);
  for(const value of [{budgetBytes:NaN},{pauseRatio:.85},{resumeRatio:.90},{duplicateWrites:5},{metadataRetentionMs:300000},
    {budgetBytes:2*MiB},{unknown:'ignored'},{reserveBytes:512*MiB}]) assert.throws(()=>normalizeStoragePolicy(value));
  assert.equal(utf8Size('gift 🦋'),9); assert.equal(utf8Size(null),0);
  assert.throws(()=>storageTableByteExpression('untrusted'));assert.throws(()=>storageTableByteExpression(STORAGE_TABLES[0],'bad;'));
  assert.equal(storagePaused(460*MiB,false),false);assert.equal(storagePaused(461*MiB,false),true);
  assert.equal(storagePaused(420*MiB,true),true);assert.equal(storagePaused(409*MiB,true),false);
});

test('monitor reads cached byte counters without scanning history and hides global usage from invited accounts', async t => {
  const f=fixture(t,{bytes:420*MiB});
  const result=await f.core.status({userId:owner,isOwner:true});assert.equal(result.status,'healthy');assert.equal(result.estimated_bytes,420*MiB);
  assert.equal(result.budget_bytes,512*MiB);assert.equal(result.inventory_complete,true);assert.ok(result.checked_at);
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  const scoped=await f.core.status({userId:invited,isOwner:false});assert.equal(scoped.scope,'account');assert.equal(scoped.estimated_bytes,1234);
  assert.equal(scoped.budget_bytes,null);assert.equal(scoped.cleanup.reclaimed_bytes,0);
  assert.ok(f.queries.every(query=>!query.sql.includes('cloud_events')&&!query.sql.includes('SUM(')));
  await assert.rejects(f.core.status({userId:invited,isOwner:true}));await assert.rejects(f.core.status({userId:'invalid',isOwner:false}));
  f.database.prepare('DELETE FROM service_storage_scope_usage WHERE scope=?').run(`public:${invited}`);
  const missing=await f.core.status({userId:invited,isOwner:false});assert.equal(missing.status,'unknown');assert.equal(missing.inventory_complete,false);
});

test('daily usage sampling is bounded, replaces one day and adds no writes to status or legacy fields', async t => {
  const f=fixture(t,{bytes:MiB});let at=f.at+1000;
  const core=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>at}), input={userId:owner,isOwner:true,progress:true,growth:true};
  assert.equal((await core.status(input)).growth.state,'collecting');assert.equal(f.row().usage_history,undefined);
  for(let index=0;index<35;index++) {
    at=f.at+1000+index*day;
    f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run((index+1)*MiB);
    await core.step(input);
  }
  assert.equal(f.row().usage_history.samples.length,31);
  const initial=f.row().usage_history.samples[0];assert.equal(initial.bytes,5*MiB);
  at+=1000;f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run(36*MiB);
  const result=await core.step(input);assert.equal(f.row().usage_history.samples.length,31);
  assert.equal(f.row().usage_history.samples.at(-1).bytes,36*MiB);
  assert.equal(result.growth.state,'growing');assert.equal(result.growth.sample_count,31);
  assert.equal(result.growth.platform_quota_verified,false);
  assert.equal(result.growth.write_limit_bytes,Math.ceil(512*MiB*.9));
  assert.equal(result.growth.net_bytes_per_day,Math.round(31*MiB/(30+1000/day)));
  assert.equal(result.growth.days_to_limit,Math.ceil((Math.ceil(512*MiB*.9)-36*MiB)/result.growth.net_bytes_per_day));
  f.queries.length=0;const before=JSON.stringify(f.row()),legacy=await core.status({...input,progress:false,growth:false});
  assert.equal(Object.hasOwn(legacy,'growth'),false);assert.equal(JSON.stringify(f.row()),before);
  assert.equal(Object.hasOwn(await core.status({...input,growth:false}),'growth'),false,'progress-only clients retain their exact older contract');
  assert.ok(f.queries.every(query=>query.kind!=='run'&&!query.sql.includes('cloud_events')&&!query.sql.includes('SUM(')));
});

test('growth needs three sampled dates spanning 48 hours and recent history, and measures net cleanup', async t => {
  const f=fixture(t);let at=f.at+1000;
  const core=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>at}),input={userId:owner,isOwner:true,progress:true,growth:true};
  const sample=async(offset,bytes)=>{at=f.at+1000+offset;f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run(bytes);return core.step(input);};
  assert.equal((await sample(0,MiB)).growth.state,'collecting');
  assert.equal((await sample(day,2*MiB)).growth.state,'collecting');
  let result=await sample(2*day,3*MiB);assert.equal(result.growth.net_bytes_per_day,MiB);assert.equal(result.growth.state,'growing');
  result=await sample(3*day,0);assert.equal(result.growth.state,'not_growing');assert.equal(result.growth.net_bytes_per_day,-349525);assert.equal(result.growth.days_to_limit,null);
  at+=2*day+1;result=await core.status(input);assert.equal(result.growth.state,'stale');assert.equal(result.growth.net_bytes_per_day,null);assert.equal(result.growth.days_to_limit,null);
  f.database.prepare('UPDATE service_storage_usage SET initialized_at=? WHERE id=1').run(at);
  result=await core.step(input);assert.equal(result.growth.state,'collecting');assert.equal(result.growth.sample_count,1);
  assert.equal(f.row().usage_history.initialized_at,at);
});

test('three UTC dates alone do not produce a forecast before 48 observed hours', async t => {
  const f=fixture(t),base=(Math.floor(f.at/day)+1)*day+23*3600000;let at=base;
  const core=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>at}),input={userId:owner,isOwner:true,progress:true,growth:true};
  for(const [offset,bytes] of [[0,1000],[2*3600000,2000],[25*3600000,3000]]) {
    at=base+offset;f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run(bytes);await core.step(input);
  }
  let result=await core.status(input);assert.equal(result.growth.sample_count,3);assert.equal(result.growth.state,'collecting');assert.equal(result.growth.net_bytes_per_day,null);
  at=base+2*day;result=await core.step(input);assert.equal(result.growth.sample_count,3);assert.equal(result.growth.state,'growing');assert.equal(result.growth.net_bytes_per_day,1000);
});

test('malformed or future daily histories cannot fabricate a growth projection', async t => {
  const f=fixture(t,{bytes:MiB});const at=f.at+4*day;
  const core=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>at}),input={userId:owner,isOwner:true,progress:true,growth:true};
  const samples=[0,1,2].map(index=>({at:f.at+index*day,bytes:MiB*(index+1)}));
  for(const malformed of [Array(32).fill(samples[0]),[samples[0],samples[0],samples[2]],
    [samples[0],samples[1],{at:at+1,bytes:5*MiB}], [samples[0],samples[1],{...samples[2],bytes:-1}],
    [samples[0],{...samples[1],at:'tomorrow'},samples[2]]]) {
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,usage_history:{version:1,initialized_at:f.at,samples:malformed}}));
    const result=await core.status(input);assert.equal(result.growth.sample_count,0);assert.equal(result.growth.days_to_limit,null);
    await core.step(input);assert.deepEqual(f.row().usage_history.samples,[{at,bytes:MiB}]);
  }
  f.database.prepare('UPDATE service_storage_usage SET initialized_at=NULL WHERE id=1').run();
  assert.equal((await core.status(input)).growth.state,'unknown');assert.equal((await core.status(input)).growth.write_limit_bytes,null);
});

test('public daily growth remains account scoped and resets after account replacement', async t => {
  const f=fixture(t,{bytes:300*MiB});let at=f.at+1000;
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  const core=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>at}),input={userId:invited,isOwner:false,accountGeneration:3,progress:true,growth:true};
  for(let index=0;index<3;index++) {
    at=f.at+1000+index*day;f.database.prepare('UPDATE service_storage_scope_usage SET total_bytes=? WHERE scope=?').run((index+1)*1000,`public:${invited}`);
    await core.step(input);
  }
  const own=f.row().accounts[invited].usage_history;
  const result=await core.status(input);assert.equal(result.growth.net_bytes_per_day,1000);assert.equal(result.growth.write_limit_bytes,8*MiB);
  assert.equal(result.budget_bytes,null);assert.equal(result.growth.days_to_limit,Math.ceil((8*MiB-3000)/1000));
  assert.equal((await core.status({userId:owner,isOwner:true,growth:true})).growth.sample_count,0);
  await core.step({userId:owner,isOwner:true,growth:true});assert.deepEqual(f.row().accounts[invited].usage_history,own);
  f.database.prepare('UPDATE public_accounts SET generation=4 WHERE user_id=?').run(invited);
  assert.equal((await core.status(input)).growth.state,'unknown');
  const replacement=await core.step({...input,accountGeneration:4});assert.equal(replacement.growth.sample_count,1);assert.equal(replacement.growth.state,'collecting');
  assert.equal(f.row().accounts[invited].generation,4);
});

test('lost cleanup lease cannot publish usage samples over a new worker', async t => {
  let stolen=false;
  const f=fixture(t,{bytes:MiB,beforeWrite(database,sql) {
    if(!stolen&&sql.includes('SET document=json_set')) {stolen=true;database.prepare('UPDATE service_storage_monitor SET document=?,lease_id=?,lease_until=? WHERE id=1')
      .run(JSON.stringify({version:1,checked_at:42}), 'replacement',Date.now()+30000);}
  }});
  await f.core.step({userId:owner,isOwner:true,progress:true,growth:true});
  assert.deepEqual(f.row(),{version:1,checked_at:42});
});

test('opted-in owner progress reports the current bounded stage without changing legacy status responses',async t=>{
  const f=fixture(t),stages=['cache','cache','expired_metadata','expired_metadata','expired_metadata','expired_metadata',
    'expired_metadata','expired_metadata','sync_history','gift_checks','saved_status','saved_status','request_allowance',
    'sync_history','gift_checks','discovery'];
  for(let phase=0;phase<stages.length;phase++) {
    const cleanup={state:phase%2?'blocked':'running',phase,after:1956,boundary:4958,tenant:null,reclaimed_bytes:123};
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.at,cleanup}));
    const before=JSON.stringify(f.row()),old=await f.core.status({userId:owner,isOwner:true}),current=await f.core.status({userId:owner,isOwner:true,progress:true});
    assert.equal(Object.hasOwn(old.cleanup,'progress'),false);
    assert.deepEqual(current.cleanup.progress,{stage:stages[phase],stage_number:phase+1,stage_count:16,percent:phase>=8&&phase<=12?39:null});
    const {progress,...legacy}=current.cleanup;assert.deepEqual(legacy,old.cleanup);assert.equal(JSON.stringify(f.row()),before);
  }
  assert.ok(f.queries.every(query=>query.kind!=='run'&&!query.sql.includes('cloud_events')));
});

test('progress is nullable for idle or corrupt cursors and complete only for a finished pass',async t=>{
  const f=fixture(t),base={state:'running',phase:8,after:0,boundary:4958,tenant:null,reclaimed_bytes:0};
  for(const patch of [{state:'idle'},{state:'needed'},{phase:-1},{phase:16},{after:-1},{boundary:null},{tenant:'invalid'}]) {
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.at,cleanup:{...base,...patch}}));
    assert.equal((await f.core.status({userId:owner,isOwner:true,progress:true})).cleanup.progress,null);
  }
  for(const [patch,expected] of [[{boundary:0},null],[{after:0},0],[{after:9999},100]]) {
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.at,cleanup:{...base,...patch}}));
    assert.equal((await f.core.status({userId:owner,isOwner:true,progress:true})).cleanup.progress.percent,expected);
  }
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.at,
    cleanup:{...base,state:'complete',phase:0,last_completed_at:f.at}}));
  assert.deepEqual((await f.core.status({userId:owner,isOwner:true,progress:true})).cleanup.progress,
    {stage:'discovery',stage_number:16,stage_count:16,percent:100});
  f.database.prepare('UPDATE service_storage_usage SET initialized_at=NULL').run();
  assert.equal((await f.core.status({userId:owner,isOwner:true,progress:true})).cleanup.progress,null);
  const before=f.queries.length;
  for(const progress of [null,'true',1,{},[]])for(const method of ['status','step'])
    await assert.rejects(f.core[method]({userId:owner,isOwner:true,progress}),/Invalid storage maintenance input/);
  assert.equal(f.queries.length,before);
});

test('invited progress exposes only its own seven stages and never a shared cursor percentage',async t=>{
  const f=fixture(t);f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  const stages=['cache','expired_metadata','expired_metadata','expired_metadata','sync_history','gift_checks','discovery'];
  const privateCleanup={state:'running',phase:8,after:1956,boundary:4958,tenant:null,reclaimed_bytes:16700000};
  for(let phase=0;phase<stages.length;phase++) {
    const cleanup={state:'running',phase,after:987,boundary:12345,tenant:invited,reclaimed_bytes:9000};
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.at,cleanup:privateCleanup,
      accounts:{[invited]:{generation:3,checked_at:f.at,cleanup}}}));
    const result=await f.core.status({userId:invited,isOwner:false,accountGeneration:3,progress:true});
    assert.deepEqual(result.cleanup.progress,{stage:stages[phase],stage_number:phase+1,stage_count:7,percent:null});
    assert.equal(result.cleanup.reclaimed_bytes,0);assert.equal(result.budget_bytes,null);
    assert.doesNotMatch(JSON.stringify(result.cleanup.progress),/1956|4958|987|12345|678900002|16700000/);
  }
  const row=f.row();row.accounts[invited].generation=2;
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify(row));
  assert.equal((await f.core.status({userId:invited,isOwner:false,accountGeneration:3,progress:true})).cleanup.progress,null);
  row.accounts[invited].generation=3;row.accounts[invited].cleanup.phase=8;
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify(row));
  assert.equal((await f.core.status({userId:invited,isOwner:false,progress:true})).cleanup.progress,null);
});

test('missing initialized usage cannot appear healthy or authorize collection', async t => {
  const f=fixture(t);f.database.prepare('UPDATE service_storage_usage SET initialized_at=NULL').run();
  const result=await f.core.status({userId:owner,isOwner:true});assert.equal(result.status,'unknown');assert.equal(result.inventory_complete,false);
  assert.equal(result.estimated_bytes,null);assert.equal(result.checked_at,null);assert.equal(result.can_cleanup,false);
  const before=f.row();await f.core.step({userId:owner,isOwner:true});assert.deepEqual(f.row(),before);
});

test('global pause hysteresis survives refreshes and resumes only below 80 percent', async t => {
  const f=fixture(t,{bytes:470*MiB});let result=await f.core.step({userId:owner,isOwner:true});assert.equal(result.status,'paused');assert.equal(f.row().paused,true);
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(420*MiB);
  result=await f.core.step({userId:owner,isOwner:true});assert.equal(result.status,'paused');
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(400*MiB);
  result=await f.core.step({userId:owner,isOwner:true});assert.notEqual(result.status,'paused');assert.equal(f.row().paused,false);
});

test('new growth near the warning threshold prioritizes cleanup without repeatedly rescanning unchanged history', async t => {
  const f=fixture(t,{bytes:440*MiB});await f.finish();const completed=f.row().cleanup.last_completed_at;
  let value=await f.core.status({userId:owner,isOwner:true});assert.equal(value.cleanup.state,'complete');
  await f.core.step({userId:owner,isOwner:true});assert.equal(f.row().cleanup.last_completed_at,completed);
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=total_bytes+?').run(2*MiB);
  value=await f.core.status({userId:owner,isOwner:true});assert.equal(value.cleanup.state,'needed');
  await f.core.step({userId:owner,isOwner:true});assert.equal(f.row().cleanup.state,'running');
});

test('lossless cleanup restores logical gift/job checkpoints and preserves immutable provider evidence and latest head', async t => {
  const f=fixture(t);const job={id:2,state:'partial',streams:[{cursor:'opaque',complete:false}]};
  const gifts={version:1,next_run_id:5,run:{id:4,wallet:'synthetic',results:{nft:{exact_amount:'123456789'}},targets:Array.from({length:8},(_,i)=>({nft:`gift-${i}`}))}};
  const owned={version:1,run:{id:3,wallet:'synthetic',targets:Array.from({length:8},(_,i)=>({nft:`gift-${i}`})),inflight:null}};
  const reset={version:1,at:12345,attempts:Array.from({length:30},(_,i)=>i)};
  const logical={version:2,attempts:[123,456],next_allowed_at:999,job,gift_refresh:gifts,owned_prices:owned,marketapp_budget_reset:reset};
  for(let i=1;i<=8;i++)f.event(i,logical);
  const before=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), bytes=f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes;
  const result=await f.finish();assert.equal(result.cleanup.state,'complete');assert.ok(result.cleanup.reclaimed_bytes>0);
  assert.ok(f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes<bytes);
  const after=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();assert.equal(after.length,before.length);
  for(let i=0;i<after.length;i++)for(const column of ['event_key','job_json','records_json','raw_body','observed_at'])assert.equal(after[i][column],before[i][column]);
  assert.equal(after.at(-1).state_json,before.at(-1).state_json);
  assert.deepEqual((await createCloudRepository(f.db).read()).state,logical);
  const maintenanceWrites=f.queries.filter(query=>query.kind==='run'&&/UPDATE cloud_events SET/.test(query.sql));
  assert.ok(maintenanceWrites.every(query=>query.sql.includes('lease_id=:storage_lease')));
});

test('cleanup deletes only expired non-secret metadata beyond security windows', async t => {
  const f=fixture(t);const old=f.at-3*86400000,recent=f.at-60000;
  for(const [id,created,expires]of[['old',old,old+300000],['recent',recent,f.at+300000],['old-live',old,f.at+300000]])
    f.database.prepare('INSERT INTO marketapp_login_attempts(attempt_id,owner_id,created_at,expires_at,state) VALUES(?,?,?,?,?)').run(id,owner,created,expires,'pending');
  f.database.prepare('INSERT INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version,ciphertext,expires_at) VALUES(?,?,?,?,?,?)')
    .run(owner,7,31,10,'synthetic-secret',old);
  f.database.prepare('INSERT INTO private_provider_credentials(row_id,user_id,generation,nonce_counter,credential_version,ciphertext) VALUES(?,?,?,?,?,?)')
    .run('private',owner,9,17,6,'synthetic-key');
  f.database.prepare('INSERT INTO public_accounts(user_id,generation,status,created_at,wallet_nonce_counter) VALUES(?,?,?,?,?)').run(invited,9,'deleted',old,26);
  f.database.prepare('INSERT INTO public_provider_gates(scope_key,revision,document) VALUES(?,?,?)').run('synthetic',4,'{"attempts":[1,2]}');
  f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run('synthetic',1,1,'derived only');
  f.database.prepare('INSERT INTO service_storage_reservations VALUES(?,?,?,?)').run('expired',100,old,'provider');
  f.database.prepare('INSERT INTO service_storage_reservations VALUES(?,?,?,?)').run('active',100,f.at+300000,'provider');
  const preserved=['marketapp_analytics_sessions','private_provider_credentials','public_accounts','public_provider_gates'].map(name=>f.database.prepare(`SELECT * FROM ${name}`).all());
  await f.finish();assert.deepEqual(f.database.prepare('SELECT attempt_id FROM marketapp_login_attempts ORDER BY attempt_id').all().map(row=>row.attempt_id),['old-live','recent']);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,0);
  assert.deepEqual(f.database.prepare('SELECT token FROM service_storage_reservations').all().map(row=>row.token),['active']);
  for(const [i,name]of['marketapp_analytics_sessions','private_provider_credentials','public_accounts','public_provider_gates'].entries())
    assert.deepEqual(f.database.prepare(`SELECT * FROM ${name}`).all(),preserved[i]);
});

test('maintenance lease prevents concurrent workers and stale cleanup writes', async t => {
  let replaced=false;
  const f=fixture(t,{beforeWrite(database,sql){if(!replaced&&/^DELETE FROM dashboard_projection_cache/.test(sql)){
    replaced=true;database.prepare('UPDATE service_storage_monitor SET lease_id=?,lease_until=? WHERE id=1').run('replacement',Date.now()+30000);}}});
  f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run('keep',1,1,'saved-cache');
  await f.core.step({userId:owner,isOwner:true,manual:true});assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,1);
  assert.equal(f.database.prepare('SELECT lease_id FROM service_storage_monitor').get().lease_id,'replacement');
  const mutations=f.queries.length;await f.core.step({userId:owner,isOwner:true,manual:true});
  assert.equal(f.queries.slice(mutations).filter(query=>/DELETE FROM|UPDATE cloud_events SET/.test(query.sql)).length,0);
});

test('failed cleanup keeps data/cursor, exposes no database errors or credentials, and permits a manual retry', async t => {
  let fail=true;
  const f=fixture(t,{beforeWrite(database,sql){if(fail&&/^DELETE FROM dashboard_projection_cache/.test(sql))throw new Error('database or disk is full synthetic-secret');}});
  f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run('keep',1,1,'saved-cache');
  let result=await f.core.step({userId:owner,isOwner:true,manual:true});assert.equal(result.cleanup.state,'blocked');assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,1);
  fail=false;result=await f.finish();assert.equal(result.cleanup.state,'complete');assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,0);
});

test('blocked cleanup waits for a manual retry and resumes its durable phase, boundary and savings', async t => {
  let fail=true;
  const f=fixture(t,{beforeWrite(_database,sql){
    if(fail&&/^UPDATE cloud_events SET state_json=json_set\(json_remove\(state_json,'\$\.owned_prices/.test(sql))throw new Error('synthetic interrupted publication');
  }});
  const logical={version:2,owned_prices:{version:1,run:{id:9,wallet:'synthetic',targets:Array.from({length:10},(_,i)=>({nft:`gift:${i}`}))}}};
  for(let sequence=1;sequence<=3;sequence++)f.event(sequence,logical);
  f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run('keep',1,1,'derived-cache');
  const cleanup={state:'running',phase:9,after:1,boundary:3,tenant:null,last_tenant:'',reclaimed_bytes:999,started_at:123};
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,cleanup}));
  await f.core.step({userId:owner,isOwner:true});
  assert.deepEqual(f.row().cleanup,{...cleanup,state:'blocked'});
  fail=false;
  await f.core.step({userId:owner,isOwner:true});
  assert.deepEqual(f.row().cleanup,{...cleanup,state:'blocked'});
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,1);
  await f.core.step({userId:owner,isOwner:true,manual:true});
  assert.equal(f.row().cleanup.state,'complete');
  assert.ok(f.row().cleanup.reclaimed_bytes>999);
  assert.equal(f.row().cleanup.started_at,123);
  assert.equal(f.row().cleanup.boundary,3);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,1);
  assert.deepEqual((await createCloudRepository(f.db).read()).state,logical);
});

test('cleanup runs multiple disposable batches while each deletion stays bounded and creates no sync events', async t => {
  const remaining=[];
  const f=fixture(t,{beforeWrite(database,sql){if(sql.startsWith('DELETE FROM dashboard_projection_cache'))remaining.push(database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n);}});
  const insert=f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)');for(let i=0;i<60;i++)insert.run(`cache-${i}`,1,1,'derived');
  const result=await f.core.step({userId:owner,isOwner:true,manual:true});assert.equal(result.cleanup.state,'running');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,0);
  assert.deepEqual(remaining,[60,35,10]);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,0);assert.ok(f.row().cleanup.phase>0);
});

test('public checkpoints compact within each tenant and preserve protected TON roots, history and active head', async t => {
  const f=fixture(t);const second='444',accounts=[invited,second];
  const insert=f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const originals=[];
  for(const user of accounts) {
    f.database.prepare('INSERT INTO public_accounts(user_id,generation,status,created_at,wallet_nonce_counter) VALUES(?,?,?,?,?)').run(user,3,'active',f.at,7);
    for(let sequence=1;sequence<=6;sequence++) {
      const job={id:2,state:'partial',streams:[{cursor:`${user}:cursor`,complete:false}]};
      const logical={version:2,job,owned_prices:{version:1,run:{id:9,wallet:`wallet:${user}`,targets:Array.from({length:10},(_,i)=>({nft:`${user}:${i}`})),cursor:'unchanged'}}};
      insert.run(`${user}:${sequence}`,user,sequence,`synthetic:${sequence}`,JSON.stringify(logical),job.id,JSON.stringify(job),'[{"kind":"history","record":{"exact_amount":"123456789"}}]','{"raw":"retained"}','2026-10-11T10:00:00.000Z');
    }
    originals.push(f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all(user));
  }
  const result=await f.finish();assert.equal(result.cleanup.state,'complete');
  for(const [index,user]of accounts.entries()) {
    const rows=f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all(user);
    assert.equal(rows.length,6);assert.equal(rows[0].state_json.includes('targets'),true);
    assert.equal(rows.at(-1).state_json,originals[index].at(-1).state_json);
    for(const [at,row]of rows.entries())for(const column of ['job_json','records_json','raw_body','observed_at'])assert.equal(row[column],originals[index][at][column]);
    for(const row of rows)if(JSON.parse(row.state_json).__checkpoint_owned_targets_sequence) {
      const source=f.database.prepare('SELECT state_json FROM public_cloud_events WHERE user_id=? AND sequence=?').get(user,JSON.parse(row.state_json).__checkpoint_owned_targets_sequence);
      assert.equal(JSON.parse(source.state_json).owned_prices.run.wallet,`wallet:${user}`);
      assert.ok(Array.isArray(JSON.parse(source.state_json).owned_prices.run.targets));
    }
  }
  const publicWrites=f.queries.filter(query=>query.kind==='run'&&/^UPDATE public_cloud_events/.test(query.sql));
  assert.ok(publicWrites.length>0);assert.ok(publicWrites.every(query=>query.sql.includes('lease_id=:storage_lease')));
});

test('public account reactivation while cleanup is selecting cannot publish stale target references', async t => {
  let replaced=false;
  const f=fixture(t,{beforeWrite(database,sql){if(!replaced&&/^UPDATE public_cloud_events SET state_json=json_set\(json_remove\(state_json,'\$\.owned_prices/.test(sql)){
    replaced=true;database.prepare('UPDATE public_accounts SET generation=generation+1 WHERE user_id=?').run(invited);}}});
  f.database.prepare('INSERT INTO public_accounts(user_id,generation,status,created_at,wallet_nonce_counter) VALUES(?,?,?,?,?)').run(invited,3,'active',f.at,7);
  const logical={version:2,owned_prices:{version:1,run:{id:9,wallet:'synthetic',targets:Array.from({length:10},(_,i)=>({nft:`gift:${i}`}))}}};
  const insert=f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,observed_at) VALUES(?,?,?,?,?,?,?)');
  for(let sequence=1;sequence<=5;sequence++)insert.run(`event:${sequence}`,invited,sequence,`synthetic:${sequence}`,JSON.stringify(logical),'[]','2026-10-11T10:00:00.000Z');
  await f.finish();assert.equal(replaced,true);
  for(const row of f.database.prepare('SELECT state_json FROM public_cloud_events').all())assert.equal(JSON.parse(row.state_json).__checkpoint_owned_targets_sequence,undefined);
});

test('TON target cleanup skips duplicate owned_prices/run parents in private and public candidates and sources', async t => {
  for(const publicMode of [false,true])for(const parent of ['owned_prices','run']) {
    const f=fixture(t), run={id:9,wallet:'synthetic',targets:Array.from({length:10},(_,i)=>({nft:`gift:${i}`}))};
    const different={...run,wallet:'different',targets:[{nft:'different'}]}, own={version:1,run}, logical={version:2,owned_prices:own};
    const duplicate=parent==='owned_prices'
      ? `{"version":2,"owned_prices":${JSON.stringify(own)},"owned_prices":${JSON.stringify({version:1,run:different})}}`
      : `{"version":2,"owned_prices":{"version":1,"run":${JSON.stringify(run)},"run":${JSON.stringify(different)}}}`;
    const table=publicMode?'public_cloud_events':'cloud_events';
    if(publicMode) {
      f.database.prepare('INSERT INTO public_accounts(user_id,generation,status,created_at,wallet_nonce_counter) VALUES(?,?,?,?,?)').run(invited,3,'active',f.at,7);
      const insert=f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?)');
      for(let sequence=1;sequence<=4;sequence++)insert.run(`event:${sequence}`,invited,sequence,`synthetic:${sequence}`,JSON.stringify(logical),'[{"kind":"history"}]','saved-evidence','2026-10-11T10:00:00.000Z');
    } else for(let sequence=1;sequence<=4;sequence++)f.event(sequence,logical);
    // Both the source and a later candidate have duplicate parent keys; the
    // canonical normal source remains sequence2 and the malformed copy stays.
    f.database.prepare(`UPDATE ${table} SET state_json=? WHERE sequence IN(1,3)`).run(duplicate);
    const before=f.database.prepare(`SELECT sequence,state_json,records_json,raw_body,observed_at FROM ${table} ORDER BY sequence`).all();
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,cleanup:{state:'running',phase:publicMode?14:9,
      after:0,boundary:4,tenant:publicMode?invited:null,tenant_generation:3,last_tenant:'',reclaimed_bytes:0}}));
    // Stop after this target phase so the assertion excludes other lossless
    // component formats applied by later stages in the accelerated request.
    const phase=publicMode?14:9;
    const phaseCore=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>f.at+(f.row().cleanup.phase===phase?0:8000)});
    await phaseCore.step({userId:owner,isOwner:true});
    const after=f.database.prepare(`SELECT sequence,state_json,records_json,raw_body,observed_at FROM ${table} ORDER BY sequence`).all();
    assert.deepEqual(after,before,`${table} duplicate ${parent} parents must stay byte-identical`);
  }
});

test('TON target publication rechecks strict parent guards after source or candidate changes', async t => {
  for(const changedSequence of [1,2]) {
    const run={id:9,wallet:'synthetic',targets:Array.from({length:10},(_,i)=>({nft:`gift:${i}`}))}, own={version:1,run};
    const duplicate=`{"version":2,"owned_prices":${JSON.stringify(own)},"owned_prices":${JSON.stringify({version:1,run:{...run,wallet:'changed'}})}}`;
    let changed=false;
    const f=fixture(t,{beforeWrite(database,sql){if(!changed&&/^UPDATE cloud_events SET state_json=json_set\(json_remove\(state_json,'\$\.owned_prices/.test(sql)) {
      changed=true;database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=?').run(duplicate,changedSequence);
    }}});
    for(let sequence=1;sequence<=3;sequence++)f.event(sequence,{version:2,owned_prices:own});
    const evidence=f.database.prepare('SELECT sequence,records_json,raw_body,observed_at FROM cloud_events ORDER BY sequence').all();
    f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,cleanup:{state:'running',phase:9,
      after:0,boundary:3,tenant:null,last_tenant:'',reclaimed_bytes:0}}));
    await f.core.step({userId:owner,isOwner:true});assert.equal(changed,true);
    const candidate=JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=2').get().state_json);
    assert.equal(candidate.__checkpoint_owned_targets_sequence,undefined);
    assert.deepEqual(f.database.prepare('SELECT sequence,records_json,raw_body,observed_at FROM cloud_events ORDER BY sequence').all(),evidence);
  }
});

test('private target maintenance advances over bounded physical pages with no target matches', async t => {
  const f=fixture(t), plain={version:2,retained:'x'.repeat(20000)};
  for(let sequence=1;sequence<=70;sequence++)f.event(sequence,plain);
  const own={version:1,run:{id:9,wallet:'synthetic',targets:Array.from({length:10},(_,i)=>({nft:`gift:${i}`}))}};
  for(let sequence=71;sequence<=74;sequence++)f.event(sequence,{version:2,owned_prices:own});
  const before=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  f.database.prepare('INSERT INTO service_checkpoint_source_scans VALUES(?,?,?,?)').run('private',74,74,f.at);
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,cleanup:{state:'running',phase:9,
    after:0,boundary:74,tenant:null,last_tenant:'',reclaimed_bytes:0}}));
  const phaseCore=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>f.at+(f.row().cleanup.phase===9?0:8000)});
  await phaseCore.step({userId:owner,isOwner:true});
  assert.equal(f.row().cleanup.phase,10);
  const after=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  for(let i=0;i<70;i++)assert.deepEqual(after[i],before[i]);
  for(const sequence of [72,73])assert.equal(JSON.parse(after[sequence-1].state_json).__checkpoint_owned_targets_sequence,71);
  assert.deepEqual(after.at(-1),before.at(-1));
  assert.deepEqual((await createCloudRepository(f.db).read()).state,{version:2,owned_prices:own});
});

test('oversized legacy target page advances one unmatched event without skipping later duplicates', async t => {
  const f=fixture(t), own={version:1,run:{id:9,wallet:'synthetic',targets:Array.from({length:10},(_,i)=>({nft:`gift:${i}`}))}};
  f.event(1,{version:2,retained:'x'.repeat(600000)});
  for(let sequence=2;sequence<=4;sequence++)f.event(sequence,{version:2,owned_prices:own});
  const before=f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=1').get().state_json;
  f.database.prepare('INSERT INTO service_checkpoint_source_scans VALUES(?,?,?,?)').run('private',4,4,f.at);
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,cleanup:{state:'running',phase:9,
    after:0,boundary:4,tenant:null,last_tenant:'',reclaimed_bytes:0}}));
  const phaseCore=createStorageMaintenance({db:f.db,ownerTelegramId:owner,now:()=>f.at+(f.row().cleanup.phase===9?0:8000)});
  await phaseCore.step({userId:owner,isOwner:true});assert.equal(f.row().cleanup.phase,10);
  assert.equal(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=1').get().state_json,before);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=3').get().state_json).__checkpoint_owned_targets_sequence,2);
});

test('final cleanup metadata preserves concurrent admission pause and uses live usage', async t => {
  let paused=false;
  const f=fixture(t,{bytes:420*MiB,beforeWrite(database,sql){
    if(!paused&&sql.startsWith("UPDATE service_storage_monitor SET document=json_set(:document")){
      paused=true;database.exec("UPDATE service_storage_monitor SET document=json_set(document,'$.paused',json('true')) WHERE id=1");
    }
  }});
  await f.core.step({userId:owner,isOwner:true});
  assert.equal(paused,true);assert.equal(f.row().paused,true);
  assert.equal((await f.core.status({userId:owner,isOwner:true})).status,'paused');
});

test('account pressure uses its configured cap even when shared storage is healthy and does not expose shared metadata', async t => {
  const f=fixture(t,{bytes:10*MiB,maxAccountBytes:2*MiB,document:JSON.stringify({version:1,checked_at:123456,cleanup:{state:'blocked',reclaimed_bytes:987654,last_completed_at:123456}})});
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,4,'active')").run(invited);
  f.database.prepare('UPDATE service_storage_scope_usage SET total_bytes=? WHERE scope=?').run(1.8*MiB,`public:${invited}`);
  // SQLite integers are explicit in production counters.
  f.database.prepare('UPDATE service_storage_scope_usage SET total_bytes=CAST(total_bytes AS INTEGER)').run();
  let value=await f.core.status({userId:invited,isOwner:false,accountGeneration:4});
  assert.equal(value.status,'warning');assert.equal(value.cleanup.state,'needed');assert.equal(value.budget_bytes,null);
  assert.equal(value.cleanup.reclaimed_bytes,0);assert.equal(value.cleanup.last_completed_at,null);assert.notEqual(value.checked_at,new Date(123456).toISOString());
  f.database.prepare('UPDATE service_storage_scope_usage SET total_bytes=?').run(2*MiB);
  value=await f.core.status({userId:invited,isOwner:false,accountGeneration:4});assert.equal(value.status,'paused');
  assert.equal((await f.core.status({userId:owner,isOwner:true})).status,'healthy');
  value=await f.core.status({userId:invited,isOwner:false,accountGeneration:3});assert.equal(value.status,'unknown');assert.equal(value.estimated_bytes,null);assert.equal(value.can_cleanup,false);
});

test('automatic account cleanup at its cap removes only own disposable data and preserves private progress and other accounts', async t => {
  const privateCleanup={state:'blocked',phase:9,after:100,boundary:4000,tenant:null,last_tenant:'',reclaimed_bytes:777};
  const f=fixture(t,{accountScopes:true,maxAccountBytes:MiB,document:JSON.stringify({version:1,cleanup:privateCleanup})});
  for(const user of [invited,'444'])f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(user);
  f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run('private-cache',1,1,'keep');
  f.database.prepare('INSERT INTO public_dashboard_projection_cache VALUES(?,?,?,?,?,?)').run('own-cache',invited,'own',1,1,'x'.repeat(MiB));
  f.database.prepare('INSERT INTO public_dashboard_projection_cache VALUES(?,?,?,?,?,?)').run('other-cache','444','other',1,1,'keep');
  const old=f.at-3*86400000;
  for(const user of [invited,'444'])f.database.prepare('INSERT INTO public_marketapp_login_attempts(row_id,user_id,attempt_id,owner_id,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?)').run(`${user}:old`,user,'old',user,old,old+300000,'pending');
  f.database.prepare('INSERT INTO public_provider_credentials(row_id,user_id,generation,nonce_counter,credential_version,ciphertext) VALUES(?,?,?,?,?,?)').run('key',invited,3,9,2,'keep-secret');
  const credentials=f.database.prepare('SELECT * FROM public_provider_credentials').all();
  let value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3});
  assert.equal(value.cleanup.state,'complete');assert.deepEqual(f.row().cleanup,privateCleanup);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache WHERE user_id=?').get(invited).n,0);
  for(let index=0;index<30&&value.cleanup.state==='running';index++)value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3});
  assert.equal(value.cleanup.state,'complete');assert.equal(value.status,'warning','the deliberately tiny 1 MiB test quota cannot provide comparison headroom');assert.equal(value.budget_bytes,null);assert.equal(value.cleanup.reclaimed_bytes,0);
  assert.ok(f.row().accounts[invited].cleanup.reclaimed_bytes>=MiB);
  assert.deepEqual(f.row().cleanup,privateCleanup);
  assert.deepEqual(f.database.prepare('SELECT * FROM public_provider_credentials').all(),credentials);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache WHERE user_id=?').get('444').n,1);
  assert.deepEqual(f.database.prepare('SELECT user_id FROM public_marketapp_login_attempts').all().map(row=>row.user_id),['444']);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,0);
});

test('account maintenance generation fences prevent deletion and cursor publication after reactivation', async t => {
  let changed=false;
  const f=fixture(t,{beforeWrite(database,sql){if(!changed&&sql.startsWith('DELETE FROM public_dashboard_projection_cache')){
    changed=true;database.prepare('UPDATE public_accounts SET generation=generation+1 WHERE user_id=?').run(invited);
  }}});
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  f.database.prepare('INSERT INTO public_dashboard_projection_cache VALUES(?,?,?,?,?,?)').run('own-cache',invited,'own',1,1,'keep');
  const value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3,manual:true});
  assert.equal(changed,true);assert.equal(value.status,'unknown');assert.equal(value.can_cleanup,false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache').get().n,1);
  assert.equal(f.row().accounts,undefined);assert.equal(f.database.prepare('SELECT lease_id FROM service_storage_monitor').get().lease_id,null);
});

test('account cleanup compacts only its exact duplicate checkpoints and preserves sources, records and decoded active state', async t => {
  const f=fixture(t,{accountScopes:true});
  for(const user of [invited,'444'])f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(user);
  const job={id:9,state:'partial',streams:[{cursor:'keep-current'}]},logical={version:2,job,owned_prices:{version:1,run:{id:4,wallet:'synthetic',targets:Array.from({length:10},(_,index)=>({nft:`gift:${index}`}))}}};
  const insert=f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for(const user of [invited,'444'])for(let sequence=1;sequence<=6;sequence++)insert.run(`${user}:${sequence}`,user,sequence,`event:${sequence}`,JSON.stringify(logical),9,JSON.stringify(job),'[{"kind":"history","record":{"amount":"123"}}]',null,'2026-10-11T10:00:00.000Z');
  const original=f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all(invited);
  const others=f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all('444');
  let value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3,manual:true});
  for(let index=0;index<100&&value.cleanup.state==='running';index++)value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3});
  assert.equal(value.cleanup.state,'complete');
  const after=f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all(invited);
  assert.equal(after.length,original.length);assert.deepEqual(after.at(-1),original.at(-1));
  assert.equal(JSON.parse(after[0].state_json).owned_prices.run.targets.length,10);
  assert.ok(after.some(row=>JSON.parse(row.state_json).__checkpoint_owned_targets_sequence));
  for(let index=0;index<after.length;index++)for(const column of ['row_id','user_id','sequence','event_key','job_json','records_json','raw_body','observed_at'])assert.equal(after[index][column],original[index][column]);
  assert.deepEqual((await createPublicRepository(f.db,invited,{accountGenerationFence:3}).read()).state,logical);
  assert.deepEqual(f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=? ORDER BY sequence').all('444'),others);
});

test('account cleanup rejects a global phase index and prunes stale generation monitoring cursors', async t => {
  const stale={generation:2,checked_at:1,cleanup:{state:'running',phase:12,after:10,boundary:20,tenant:null,reclaimed_bytes:999}};
  const f=fixture(t,{document:JSON.stringify({version:1,accounts:{[invited]:{...stale,generation:3},'444':stale}})});
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES('444',3,'active')").run();
  const value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3,manual:true});
  assert.equal(value.cleanup.state,'complete');assert.equal(f.row().accounts[invited].cleanup.phase,0);
  assert.equal(f.row().accounts['444'],undefined);
});

test('account cleanup error handling bounds malformed monitor maps and keeps private metadata intact', async t => {
  const accounts=Object.fromEntries(Array.from({length:110},(_,index)=>[String(index+1),{generation:3,cleanup:{state:'idle'}}]));
  const f=fixture(t,{document:JSON.stringify({version:1,private:'keep',accounts}),beforeWrite(_database,sql){
    if(sql.startsWith('DELETE FROM public_dashboard_projection_cache'))throw new Error('synthetic private failure');
  }});
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  const value=await f.core.step({userId:invited,isOwner:false,accountGeneration:3,manual:true});
  assert.equal(value.cleanup.state,'blocked');assert.equal(f.row().private,'keep');assert.equal(Object.keys(f.row().accounts).length,100);
  assert.equal(JSON.stringify(value).includes('synthetic private failure'),false);
});
