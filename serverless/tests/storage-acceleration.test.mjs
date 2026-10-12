import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createStorageMaintenance} from '../tgcloud/lib/storage-maintenance.js';
import {STORAGE_TABLES, storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';
import {checkpointSourceAccountingTriggers} from '../tools/storage-accounting.mjs';

const owner = '123450001', invited = '678900002';
const cursor = (phase, boundary) => ({state:'running',phase,after:0,boundary,tenant:null,last_tenant:'',reclaimed_bytes:0});
function fixture(t, {before = () => {}, after = () => {}} = {}) {
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
  let at = Date.now();
  database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(at);
  database.prepare('INSERT INTO service_storage_scope_usage VALUES(?,?,?)').run(`public:${invited}`,1234,at);
  database.prepare('INSERT INTO service_storage_monitor(id,document) VALUES(1,?)').run('{"version":1}');
  for (const table of STORAGE_TABLES) for (const [operation, expression] of [['INSERT',storageTableByteExpression(table,'NEW.')],
    ['DELETE',`-(${storageTableByteExpression(table,'OLD.')})`],['UPDATE',`(${storageTableByteExpression(table,'NEW.')})-(${storageTableByteExpression(table,'OLD.')})`]])
    database.exec(`CREATE TRIGGER ${table.name}_${operation.toLowerCase()} AFTER ${operation} ON ${table.name}
      BEGIN UPDATE service_storage_usage SET total_bytes=total_bytes+(${expression}) WHERE id=1; END;`);
  for (const trigger of checkpointSourceAccountingTriggers()) database.exec(trigger.sql);
  const queries = [], db = Object.fromEntries(['get','all','run'].map(kind => [kind,async (sql,params={}) => {
    queries.push({kind,sql,params}); await before(database,kind,sql,params);
    const statement=database.prepare(sql), result=kind==='run'?{rowsAffected:Number(statement.run(params).changes)}:statement[kind](params)??null;
    await after(database,kind,sql,params,result); return result;
  }]));
  const core=createStorageMaintenance({db,ownerTelegramId:owner,now:()=>at});
  const read=()=>JSON.parse(database.prepare('SELECT document FROM service_storage_monitor WHERE id=1').get().document);
  const save=document=>database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify(document));
  function event(sequence, logical={version:2}, publicUser=null) {
    const fields=[sequence,`synthetic:${sequence}`,JSON.stringify(logical),logical.job?.id??null,logical.job?JSON.stringify(logical.job):null,
      '[{"kind":"history","record":{"exact_amount":"123456789"}}]','{"keep":"provider evidence"}','2026-10-11T10:00:00.000Z'];
    if(publicUser===null)database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(...fields);
    else database.prepare('INSERT INTO public_cloud_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(`${publicUser}:${sequence}`,publicUser,...fields);
  }
  return {database,core,queries,read,save,event,advance:ms=>{at+=ms;}};
}
const published = (kind,sql,params) => kind==='run' && /UPDATE service_storage_monitor SET document=/.test(sql) && typeof params[':document']==='string';
const immutableRows = (database,table='cloud_events') => database.prepare(`SELECT sequence,event_key,job_json,records_json,raw_body,observed_at FROM ${table} ORDER BY sequence`).all();

test('one cleanup request advances several small history pages even with a frozen clock and remains bounded',async t=>{
  const f=fixture(t);for(let i=1;i<=501;i++)f.event(i);
  f.save({version:1,cleanup:cursor(8,501)});const before=immutableRows(f.database);
  const result=await f.core.step({userId:owner,isOwner:true,progress:true});
  assert.equal(result.cleanup.state,'running');assert.equal(f.read().cleanup.phase,8);
  assert.ok(f.read().cleanup.after>=100,'several pages should finish in one request');
  assert.ok(f.read().cleanup.after<=200,'one request must not exceed eight 25-row pages');
  assert.ok(f.queries.length<170,'fixed query budget must hold even when time does not advance');
  assert.deepEqual(immutableRows(f.database),before);
  const pages=f.queries.filter(q=>q.sql.includes(':physical_after'));
  assert.ok(pages.length>1);assert.ok(pages.every(q=>q.sql.includes('LIMIT 25')&&q.sql.includes('524288')));
});

test('a failed second batch retains the first durable cursor and safely resumes without losing evidence',async t=>{
  let writes=0,fail=true;
  const f=fixture(t,{before(_database,kind,sql){if(kind==='run'&&/^UPDATE cloud_events SET/.test(sql)&&++writes===2&&fail)throw Error('synthetic interrupted batch');}});
  const logical={version:2,job:{id:9,state:'partial',streams:[{cursor:'keep',complete:false}]}};
  for(let i=1;i<=41;i++)f.event(i,logical);
  f.save({version:1,cleanup:cursor(8,41)});const before=immutableRows(f.database),head=f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=41').get().state_json;
  const result=await f.core.step({userId:owner,isOwner:true});
  assert.equal(result.cleanup.state,'blocked');assert.equal(f.read().cleanup.after,4);
  assert.deepEqual(immutableRows(f.database),before);assert.equal(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=41').get().state_json,head);
  fail=false;let resumed=await f.core.step({userId:owner,isOwner:true,manual:true});
  for(let i=0;i<50&&resumed.cleanup.state==='running';i++)resumed=await f.core.step({userId:owner,isOwner:true});
  assert.equal(resumed.cleanup.state,'complete');assert.deepEqual(immutableRows(f.database),before);
  for(const row of f.database.prepare('SELECT sequence,state_json,job_json FROM cloud_events').all()) {
    const state=JSON.parse(row.state_json);if(state.__checkpoint_job_sequence!==undefined){state.job=JSON.parse(row.job_json);delete state.__checkpoint_job_sequence;}
    assert.deepEqual(state,logical);
  }
});

test('replacement of the lease after a confirmed batch prevents later cursor publication',async t=>{
  let replaced=false;
  const f=fixture(t,{after(database,kind,sql,params,result){
    if(!replaced&&published(kind,sql,params)&&result.rowsAffected===1&&JSON.parse(params[':document']).cleanup?.after>0){
      replaced=true;database.prepare('UPDATE service_storage_monitor SET lease_id=?,lease_until=? WHERE id=1').run('replacement',Date.now()+30000);
    }
  }});
  for(let i=1;i<=501;i++)f.event(i);f.save({version:1,cleanup:cursor(8,501)});
  await f.core.step({userId:owner,isOwner:true});
  assert.equal(replaced,true);assert.equal(f.read().cleanup.after,25);
  assert.equal(f.database.prepare('SELECT lease_id FROM service_storage_monitor').get().lease_id,'replacement');
});

test('the trusted-time work deadline yields at a saved page instead of restarting or blocking',async t=>{
  let advanced=false,f;
  f=fixture(t,{after(_database,kind,sql,params,result){
    if(!advanced&&published(kind,sql,params)&&result.rowsAffected===1&&JSON.parse(params[':document']).cleanup?.after>0){advanced=true;f.advance(9000);}
  }});
  for(let i=1;i<=501;i++)f.event(i);f.save({version:1,cleanup:cursor(8,501)});
  const result=await f.core.step({userId:owner,isOwner:true});
  assert.equal(advanced,true);assert.equal(result.cleanup.state,'running');assert.equal(f.read().cleanup.after,25);
  assert.equal(f.database.prepare('SELECT lease_id FROM service_storage_monitor').get().lease_id,null);
});

test('query-heavy batches yield at the fixed work allowance and resume instead of marking cleanup blocked',async t=>{
  const f=fixture(t);
  for(let i=1;i<=101;i++)f.event(i,{version:2,gift_refresh:{version:1,run:{id:i,wallet:'synthetic',results:{nft:{exact_amount:String(i),note:'preserve this unique saved rental evidence'}}}}});
  f.database.prepare('INSERT INTO service_checkpoint_source_scans VALUES(?,?,?,?)').run('private',101,101,Date.now());
  f.save({version:1,cleanup:cursor(11,101)});const before=immutableRows(f.database);
  let result=await f.core.step({userId:owner,isOwner:true});
  const saved=f.read().cleanup.after;
  assert.equal(result.cleanup.state,'running');assert.equal(f.read().cleanup.phase,11);
  assert.ok(saved>4&&saved<32,'the query allowance must stop expensive work before eight complete four-row batches');
  assert.ok(f.queries.length<170,'bookkeeping plus worker queries remain bounded');
  assert.equal(f.database.prepare('SELECT lease_id FROM service_storage_monitor').get().lease_id,null);
  result=await f.core.step({userId:owner,isOwner:true});
  assert.equal(result.cleanup.state,'running');assert.ok(f.read().cleanup.after>saved);
  assert.deepEqual(immutableRows(f.database),before);
});

test('account generation changing between batches fences all later data writes and monitoring publication',async t=>{
  let changed=false;
  const f=fixture(t,{after(database,kind,sql,params,result){
    if(!changed&&published(kind,sql,params)&&result.rowsAffected===1&&JSON.parse(params[':document']).accounts?.[invited]
        &&database.prepare("SELECT count(*) AS n FROM public_cloud_events WHERE json_type(state_json,'$.__checkpoint_job_sequence') IS NOT NULL").get().n>0){
      changed=true;database.prepare('UPDATE public_accounts SET generation=4 WHERE user_id=?').run(invited);
    }
  }});
  f.database.prepare('INSERT INTO public_accounts(user_id,generation,status,created_at) VALUES(?,?,?,?)').run(invited,3,'active',Date.now());
  const logical={version:2,job:{id:7,state:'partial',streams:[]}};for(let i=1;i<=41;i++)f.event(i,logical,invited);
  const cleanup={...cursor(4,41),tenant:invited,tenant_generation:3};
  f.save({version:1,accounts:{[invited]:{generation:3,cleanup}}});const before=immutableRows(f.database,'public_cloud_events');
  await f.core.step({userId:invited,isOwner:false,accountGeneration:3});
  assert.equal(changed,true);assert.equal(f.read().accounts[invited].generation,3);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM public_cloud_events WHERE json_type(state_json,'$.__checkpoint_job_sequence') IS NOT NULL").get().n,4);
  assert.deepEqual(immutableRows(f.database,'public_cloud_events'),before);
});

test('completing a cycle stops the invocation without starting cleanup again',async t=>{
  const f=fixture(t);f.save({version:1,cleanup:cursor(15,0)});
  const result=await f.core.step({userId:owner,isOwner:true,manual:true});
  assert.equal(result.cleanup.state,'complete');assert.ok(f.read().cleanup.last_completed_at>0);
  assert.equal(f.queries.filter(q=>/^DELETE FROM dashboard_projection_cache/.test(q.sql)).length,0);
  assert.equal(f.queries.filter(q=>q.sql.includes('user_id>:after_user')).length,1);
});

test('compact private layout skips all five legacy phases without visiting thousands of retired markers',async t=>{
  const f=fixture(t);for(let sequence=1;sequence<=5000;sequence++)f.event(sequence,{});
  f.event(5001,{version:2,operational_storage_version:1});
  f.save({version:1,cleanup:cursor(8,5001)});const before=immutableRows(f.database);
  const result=await f.core.step({userId:owner,isOwner:true});
  assert.equal(result.cleanup.state,'complete');assert.deepEqual(immutableRows(f.database),before);
  assert.equal(f.queries.filter(query=>Object.hasOwn(query.params,':physical_after')).length,0);
  assert.equal(f.queries.filter(query=>query.sql.includes('service_checkpoint_source_scans')).length,0);
  assert.equal(f.queries.filter(query=>query.kind==='run'&&/\bUPDATE\s+cloud_events\s+SET\b/i.test(query.sql)).length,0);
  assert.equal(f.queries.filter(query=>query.sql.includes('AS mode')).length,1,'compact confirmation is reused only within this leased request');
});

for(const isOwner of [true,false])test(`compact public layout skips legacy job/target/discovery rewrites during ${isOwner?'owner':'account'} cleanup while cache cleanup works`,async t=>{
  const f=fixture(t);
  f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  for(let sequence=1;sequence<=1000;sequence++)f.event(sequence,{},invited);
  f.event(1001,{version:2,operational_storage_version:1,job:{id:7,state:'complete',streams:[]}},invited);
  f.database.prepare('INSERT INTO public_dashboard_projection_cache(row_id,user_id,snapshot_json) VALUES(?,?,?)').run('cache',invited,'{"discard":true}');
  f.database.prepare('INSERT INTO public_wallet_attempts(row_id,user_id,created_at) VALUES(?,?,?)').run('old-attempt',invited,1);
  const before=immutableRows(f.database,'public_cloud_events'),caller={userId:isOwner?owner:invited,isOwner,accountGeneration:isOwner?null:3};
  let result=await f.core.step({...caller,manual:true});
  for(let steps=0;steps<8&&result.cleanup.state==='running';steps++)result=await f.core.step(caller);
  assert.equal(result.cleanup.state,'complete');assert.deepEqual(immutableRows(f.database,'public_cloud_events'),before);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache').get().n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_wallet_attempts').get().n,0);
  assert.equal(f.queries.filter(query=>query.sql.includes('service_checkpoint_source_scans')).length,0);
  assert.equal(f.queries.filter(query=>query.kind==='run'&&/\bUPDATE\s+public_cloud_events\s+SET\b/i.test(query.sql)).length,0);
});

for(const publicScope of [false,true])test(`a layout switch between phase check and ${publicScope?'public':'private'} compaction fences the legacy rewrite atomically`,async t=>{
  let switched=false,f;
  f=fixture(t,{before(_database,kind,sql){
    const mutation=publicScope?/\bUPDATE\s+public_cloud_events\s+SET\b/i:/\bUPDATE\s+cloud_events\s+SET\b/i;
    if(!switched&&kind==='run'&&mutation.test(sql)){switched=true;f.event(3,{version:2,operational_storage_version:1},publicScope?invited:null);}
  }});
  if(publicScope)f.database.prepare("INSERT INTO public_accounts(user_id,generation,status) VALUES(?,3,'active')").run(invited);
  for(let sequence=1;sequence<=2;sequence++)f.event(sequence,{version:2,job:{id:7,state:'partial',streams:[]}},publicScope?invited:null);
  f.save(publicScope?{version:1,accounts:{[invited]:{generation:3,cleanup:{...cursor(4,2),tenant:invited,tenant_generation:3}}}}
    :{version:1,cleanup:cursor(8,2)});
  await f.core.step({userId:publicScope?invited:owner,isOwner:!publicScope,accountGeneration:publicScope?3:null});
  assert.equal(switched,true);
  const table=publicScope?'public_cloud_events':'cloud_events';
  assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${table} WHERE json_type(state_json,'$.__checkpoint_job_sequence') IS NOT NULL`).get().n,0);
  assert.equal(JSON.parse(f.database.prepare(`SELECT state_json FROM ${table} WHERE sequence=3`).get().state_json).operational_storage_version,1);
});
