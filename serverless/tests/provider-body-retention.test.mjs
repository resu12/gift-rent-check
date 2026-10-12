import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createProviderBodyPurge} from '../tools/provider-body-retention.mjs';
import {STORAGE_TABLES} from '../tgcloud/lib/storage-policy.js';
import {storageAccountingTriggers} from '../tools/storage-accounting.mjs';

const owner='123450001',ctx={initData:{user:{id:Number(owner)}}},MiB=1048576;
function fixture(t,{beforeRun=null,policy={}}={}){
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  const integers=new Set(['id','revision','sequence','job_id','created_at','expires_at','generation','nonce_counter','cookie_version','wallet_revision',
    'lease_until','next_allowed_at','attempted_at','run_id','source_sequence','records_revision','time_bucket','deleted_at','wallet_nonce_counter',
    'credential_version','updated_at','boundary','wallet_disconnect_revision','consumed_at']);
  for(const table of STORAGE_TABLES){
    const primary=table.name==='cloud_events'?'sequence':table.name==='public_cloud_events'?'row_id':table.columns[0];
    database.exec(`CREATE TABLE ${table.name}(${table.columns.map(column=>`${column} ${integers.has(column)?'INTEGER':'TEXT'}${column===primary?' PRIMARY KEY':''}`).join(',')})`);
  }
  database.exec(`CREATE TABLE service_storage_usage(id INTEGER PRIMARY KEY,total_bytes INTEGER,initialized_at INTEGER);
    CREATE TABLE service_storage_scope_usage(scope TEXT PRIMARY KEY,total_bytes INTEGER,initialized_at INTEGER);
    CREATE TABLE service_storage_monitor(id INTEGER PRIMARY KEY,document TEXT,lease_id TEXT,lease_until INTEGER DEFAULT 0);`);
  const document={version:1,paused:false,checked_at:1,other:'keep',cleanup:{state:'complete',phase:12,after:4000,boundary:4087,
    tenant:null,last_tenant:'678900002',reclaimed_bytes:123,started_at:2,last_completed_at:3,completed_bytes:4}};
  database.prepare('INSERT INTO service_storage_usage VALUES(1,0,?)').run(Date.now());
  database.prepare('INSERT INTO service_storage_monitor(id,document) VALUES(1,?)').run(JSON.stringify(document));
  for(const trigger of storageAccountingTriggers())database.exec(trigger.sql);
  const queries=[],db={async get(sql,params={}){queries.push({kind:'get',sql});return database.prepare(sql).get(params)??null;},
    async all(sql,params={}){queries.push({kind:'all',sql});return database.prepare(sql).all(params);},
    async run(sql,params={}){beforeRun?.(database,sql,params);queries.push({kind:'run',sql});return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  const purge=createProviderBodyPurge({db,ownerTelegramId:owner,policy,random:()=>.4});
  function event(id,raw,{publicUser=null}={}){
    const columns=['sequence','event_key','state_json','job_id','job_json','records_json','raw_body','observed_at'];
    const values=[id,`synthetic:${id}`,JSON.stringify({version:2,next_job_id:9,attempts:[1,2],job:{id:8,streams:[{cursor:'opaque'}]},
      owned_prices:{run:{id:7,targets:['owned'],pending:{one:'keep'}}}}),8,JSON.stringify({id:8,state:'partial',streams:[{cursor:'opaque'}]}),
      JSON.stringify([{kind:'history',record:{price_nano:'123456789'}},{kind:'settings',record:{wallet:'keep'}}]),raw,'2026-10-11T10:00:00.000Z'];
    if(publicUser!==null){columns.unshift('row_id','user_id');values.unshift(JSON.stringify([publicUser,'event',id]),publicUser);}
    database.prepare(`INSERT INTO ${publicUser===null?'cloud_events':'public_cloud_events'}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values);
  }
  const rows=table=>database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}));
  const monitor=()=>JSON.parse(database.prepare('SELECT document FROM service_storage_monitor WHERE id=1').get().document);
  return {database,db,purge,queries,event,rows,monitor,document};
}

test('check is read-only and denied identity/input performs no database work',async t=>{
  const f=fixture(t);f.event(1,'provider body');
  for(const observed of [{},{initData:{user:{id:678900002}}},{owner_id:owner}])await assert.rejects(f.purge({mode:'apply',batches:1},observed),/denied/);
  for(const input of [{mode:'delete',batches:1},{mode:'apply',batches:65},{mode:'apply',batches:0},{mode:'check',batches:1,owner_id:owner}])await assert.rejects(f.purge(input,ctx),/Invalid/);
  assert.equal(f.queries.length,0);
  const before=f.rows('cloud_events'),monitor=f.rows('service_storage_monitor');
  const result=await f.purge({mode:'check',batches:1},ctx);assert.equal(result.remaining_count,1);assert.equal(result.remaining_bytes,13);
  assert.equal(result.reclaimed_bytes,0);assert.equal(result.passes_completed,0);assert.equal(result.provider_requests,0);
  assert.deepEqual(f.rows('cloud_events'),before);assert.deepEqual(f.rows('service_storage_monitor'),monitor);assert.ok(f.queries.every(row=>row.kind!=='run'));
});

test('bounded raw purge preserves every key, checkpoint, job, record and security field and accounts scopes exactly',async t=>{
  const f=fixture(t);for(let id=1;id<=55;id++)f.event(id,'raw-'+id);for(let id=1;id<=3;id++)f.event(id,'🦋 public body',{publicUser:'678900002'});
  f.database.prepare('INSERT INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version,ciphertext) VALUES(?,?,?,?,?)').run(owner,3,40,39,'cipher');
  f.database.prepare('INSERT INTO public_accounts(user_id,generation,status,wallet_nonce_counter) VALUES(?,?,?,?)').run('678900002',4,'active',7);
  const beforePrivate=f.rows('cloud_events'),beforePublic=f.rows('public_cloud_events'),security=f.rows('marketapp_analytics_sessions'),accounts=f.rows('public_accounts');
  const beforeUsage=f.rows('service_storage_usage')[0].total_bytes,scopes=f.rows('service_storage_scope_usage');
  let rawBytes=[...beforePrivate,...beforePublic].reduce((sum,row)=>sum+Buffer.byteLength(row.raw_body),0);
  const result=await f.purge({mode:'apply',batches:8},ctx);assert.equal(result.complete,true);assert.equal(result.rewritten,58);assert.equal(result.reclaimed_bytes,rawBytes);
  for(const [table,original]of [['cloud_events',beforePrivate],['public_cloud_events',beforePublic]])assert.deepEqual(f.rows(table),original.map(row=>({...row,raw_body:null})));
  assert.deepEqual(f.rows('marketapp_analytics_sessions'),security);assert.deepEqual(f.rows('public_accounts'),accounts);
  assert.equal(f.rows('service_storage_usage')[0].total_bytes,beforeUsage-rawBytes);
  for(const scope of scopes){const rows=scope.scope==='private'?beforePrivate:scope.scope==='public:678900002'?beforePublic:[];
    const freed=rows.reduce((sum,row)=>sum+Buffer.byteLength(row.raw_body),0);
    assert.equal(f.rows('service_storage_scope_usage').find(row=>row.scope===scope.scope).total_bytes,scope.total_bytes-freed);}
  assert.deepEqual(f.monitor().cleanup,{...f.document.cleanup,reclaimed_bytes:123+rawBytes});assert.equal(f.monitor().other,'keep');
  assert.ok(f.monitor().checked_at>1);assert.equal(f.rows('service_storage_monitor')[0].lease_id,null);
  const writes=f.queries.filter(row=>row.kind==='run'&&row.sql.includes('SET raw_body=NULL'));
  assert.equal(writes.length,4);assert.ok(writes.every(row=>row.sql.includes('lease_until>')&&row.sql.includes('public_legacy_migrations')));
});

test('each pass selects at most 25 rows and 512 KiB of UTF-8 bytes, with one oversized first row alone',async t=>{
  const f=fixture(t);for(let id=1;id<=30;id++)f.event(id,'🦋'.repeat(7500));
  let result=await f.purge({mode:'apply',batches:1},ctx);assert.equal(result.rewritten,17);assert.equal(result.reclaimed_bytes,510000);assert.equal(result.remaining_count,13);
  for(const row of f.rows('cloud_events'))assert.equal(row.raw_body===null,row.sequence<=17);
  f.event(31,'x'.repeat(600000));result=await f.purge({mode:'apply',batches:1},ctx);assert.equal(result.rewritten,13);assert.equal(result.remaining_count,1);
  result=await f.purge({mode:'apply',batches:1},ctx);assert.equal(result.rewritten,1);assert.equal(result.reclaimed_bytes,600000);assert.equal(result.complete,true);
});

test('existing maintenance lease blocks purge without changing its cursor',async t=>{
  const f=fixture(t);f.event(1,'retain until lease');f.database.prepare('UPDATE service_storage_monitor SET lease_id=?,lease_until=?').run('other',Date.now()+60000);
  const before=f.rows('service_storage_monitor');const result=await f.purge({mode:'apply',batches:3},ctx);
  assert.equal(result.blocked,true);assert.equal(result.reason,'maintenance_busy');assert.equal(result.rewritten,0);assert.equal(result.passes_completed,0);
  assert.equal(f.rows('cloud_events')[0].raw_body,'retain until lease');assert.deepEqual(f.rows('service_storage_monitor'),before);
});

test('expired/replaced lease cannot purge data or overwrite replacement metadata',async t=>{
  let replaced=false;const f=fixture(t,{beforeRun(database,sql){if(!replaced&&sql.includes('SET raw_body=NULL')){replaced=true;
    database.prepare('UPDATE service_storage_monitor SET lease_id=?,lease_until=?,document=?').run('replacement',Date.now()+60000,'{"version":1,"replacement":true}');}}});
  f.event(1,'keep');const result=await f.purge({mode:'apply',batches:2},ctx);assert.equal(result.blocked,true);assert.equal(result.reason,'lease_lost');
  assert.equal(f.rows('cloud_events')[0].raw_body,'keep');assert.equal(f.rows('service_storage_monitor')[0].lease_id,'replacement');assert.equal(f.monitor().replacement,true);
});

test('partial legacy migration and reservation gap block purge; completed migration permits it',async t=>{
  const f=fixture(t);f.event(1,'keep');f.database.prepare('INSERT INTO public_accounts(user_id,status) VALUES(?,?)').run('123','migrating');
  let result=await f.purge({mode:'apply',batches:2},ctx);assert.equal(result.reason,'legacy_migration_active');assert.equal(f.rows('cloud_events')[0].raw_body,'keep');
  f.database.prepare('UPDATE public_accounts SET status=?').run('active');f.database.prepare('INSERT INTO public_legacy_migrations(user_id,status) VALUES(?,?)').run('123','copying');
  result=await f.purge({mode:'apply',batches:2},ctx);assert.equal(result.reason,'legacy_migration_active');assert.equal(f.rows('cloud_events')[0].raw_body,'keep');
  f.database.prepare('UPDATE public_legacy_migrations SET status=?').run('complete');result=await f.purge({mode:'apply',batches:2},ctx);assert.equal(result.complete,true);assert.equal(result.reclaimed_bytes,4);
});

test('migration beginning between selection and publication is fenced inside the purge SQL',async t=>{
  let started=false;const f=fixture(t,{beforeRun(database,sql){if(!started&&sql.includes('SET raw_body=NULL')){started=true;
    database.prepare('INSERT INTO public_accounts(user_id,status) VALUES(?,?)').run('123','migrating');}}});
  f.event(1,'keep');const result=await f.purge({mode:'apply',batches:1},ctx);assert.equal(result.reason,'legacy_migration_active');assert.equal(result.reclaimed_bytes,0);
  assert.equal(f.rows('cloud_events')[0].raw_body,'keep');assert.deepEqual(f.monitor().cleanup,f.document.cleanup);
});

test('actual accounting clears paused hysteresis below 80 percent and preserves cleanup progress',async t=>{
  const f=fixture(t,{policy:{budgetBytes:32*MiB,reserveBytes:MiB}});f.event(1,'x'.repeat(4*MiB));
  f.database.prepare('INSERT INTO collector_state(id,revision,document) VALUES(1,1,?)').run('x'.repeat(25*MiB));
  f.database.prepare('UPDATE service_storage_monitor SET document=?').run(JSON.stringify({...f.document,paused:true}));
  const check=await f.purge({mode:'check',batches:1},ctx);assert.equal(check.paused,true);
  const result=await f.purge({mode:'apply',batches:1},ctx);assert.equal(result.paused,false);assert.equal(f.monitor().paused,false);
  assert.equal(result.reclaimed_bytes,4*MiB);assert.deepEqual(f.monitor().cleanup,{...f.document.cleanup,reclaimed_bytes:123+4*MiB});
});

test('accounting must be initialized with all expected triggers before apply',async t=>{
  const f=fixture(t);f.event(1,'keep');f.database.exec('DROP TRIGGER storage_usage_v1_cloud_events_update');
  await assert.rejects(f.purge({mode:'apply',batches:1},ctx),/accounting/);assert.equal(f.rows('cloud_events')[0].raw_body,'keep');
});

test('final monitor write preserves a concurrent admission pause while usage remains above resume threshold',async t=>{
  let paused=false;const f=fixture(t,{policy:{budgetBytes:32*MiB,reserveBytes:MiB},beforeRun(database,sql){
    if(!paused&&sql.includes("SET document=json_set(:document,'$.paused'")){
      paused=true;database.exec("UPDATE service_storage_monitor SET document=json_set(document,'$.paused',json('true')) WHERE id=1");
    }
  }});
  f.event(1,'x'.repeat(MiB));
  f.database.prepare('INSERT INTO collector_state(id,revision,document) VALUES(1,1,?)').run('x'.repeat(27*MiB));
  const result=await f.purge({mode:'apply',batches:1},ctx);
  assert.equal(result.complete,true);assert.equal(result.paused,true);assert.equal(f.monitor().paused,true);
  assert.deepEqual(f.monitor().cleanup,{...f.document.cleanup,reclaimed_bytes:123+MiB});
});

test('admin RPC stops subsequent passes after 10 seconds measured by its trusted SQLite clock',async t=>{
  const f=fixture(t);for(let id=1;id<=50;id++)f.event(id,'raw');let calls=0;
  const original=f.db.get;f.db.get=async(sql,params)=>{const result=await original(sql,params);if(sql.endsWith(' AS at'))result.at+=calls++>=3?11000:0;return result;};
  const result=await f.purge({mode:'apply',batches:64},ctx);assert.equal(result.passes_completed,1);assert.equal(result.rewritten,25);assert.equal(result.remaining_count,25);
});

function cliFixture(t){
  const tmp=fileURLToPath(new URL('../../.tmp/',import.meta.url));mkdirSync(tmp,{recursive:true});const root=mkdtempSync(join(tmp,'provider-body-tool-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmp)+sep));rmSync(root,{recursive:true,force:true});});
  const project=join(root,'serverless');for(const path of ['tools','node_modules/@tgcloud/cli/src/core','node_modules/@tgcloud/cli/src/api'])mkdirSync(join(project,path),{recursive:true});
  writeFileSync(join(project,'package.json'),'{"type":"module"}');writeFileSync(join(project,'node_modules/@tgcloud/cli/package.json'),'{"type":"module"}');
  for(const name of ['purge-provider-bodies.mjs','provider-body-retention.mjs','destination.mjs'])writeFileSync(join(project,'tools',name),readFileSync(new URL('../tools/'+name,import.meta.url)));
  const record="import {appendFileSync} from 'node:fs';const record=value=>appendFileSync('calls.jsonl',JSON.stringify(value)+'\\n');";
  writeFileSync(join(project,'node_modules/@tgcloud/cli/src/core/credentials.js'),`${record}record({stage:'credentials'});export async function resolveToken(){return process.env.TGCLOUD_TOKEN??'app54321:synthetic_secret';}`);
  writeFileSync(join(project,'node_modules/@tgcloud/cli/src/api/endpoints.js'),`${record}
    export async function getFiles(){record({stage:'getFiles'});return {canonical_modules:{'lib/private-config':'export const ownerTelegramId=42;',
      'lib/storage-policy':'export const normalizeStoragePolicy=x=>x;export const storagePaused=()=>false;export const STORAGE_TABLES=[];',
      'lib/storage-config':'export const storagePolicy={};','lib/unrelated':'SENSITIVE_UNUSED'}};}
    export async function runFunction(auth,name,modules,input,ctx){record({stage:'runFunction',name,modules,input,ctx});
      if(process.env.TEST_UNCERTAIN==='1')throw Object.assign(Error('SECRET_ERROR_BODY'),{status:429,parameters:{retry_after:13}});
      return {result:{mode:input.mode,complete:true,blocked:false,remaining_count:0,remaining_bytes:0,estimated_bytes:100,
        budget_bytes:512000000,paused:false,rewritten:0,reclaimed_bytes:0,passes_completed:0,provider_requests:0,arbitrary_secret:'MUST_NOT_PRINT'}};}`);
  const run=(args=[],env={})=>{const clean={...process.env};for(const key of ['TGCLOUD_TOKEN','TG_CLOUD_API_URL','TGCLOUD_BETA','NODE_OPTIONS','TEST_UNCERTAIN'])delete clean[key];
    return spawnSync(process.execPath,[join(project,'tools/purge-provider-bodies.mjs'),...args],{cwd:root,env:{...clean,...env},encoding:'utf8',timeout:20000});};
  const calls=()=>existsSync(join(project,'calls.jsonl'))?readFileSync(join(project,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  return {run,calls};
}

test('CLI validates destination and explicit bounded mode before loading credentials',t=>{
  const f=cliFixture(t),base=['--app-id','54321','--owner-id','42'];
  for(const args of [[],['--app-id','54321'],[...base,'--mode','delete'],[...base,'--batches','65'],[...base,'--calls','13'],
    [...base,'--owner-id','43'],[...base,'--mode','check','--batches','2'],[...base,'--unknown','x']]){const result=f.run(args);assert.equal(result.status,1);}
  for(const env of [{TG_CLOUD_API_URL:'https://other.invalid'},{TGCLOUD_BETA:'1'}])assert.equal(f.run(base,env).status,1);
  assert.deepEqual(f.calls(),[]);const result=f.run(base,{TGCLOUD_TOKEN:'app65432:other_secret'});assert.equal(result.status,1);
  assert.equal(f.calls().filter(row=>row.stage==='getFiles').length,0);assert.ok(!result.stderr.includes('other_secret'));
});

test('CLI defaults to check, uses only canonical transitive modules and emits aggregates',t=>{
  const f=cliFixture(t),result=f.run(['--app-id','54321','--owner-id','42']);assert.equal(result.status,0,result.stderr);
  const call=f.calls().find(row=>row.stage==='runFunction');assert.deepEqual(call.input,{mode:'check',batches:1});assert.equal(call.ctx.initData.user.id,42);
  assert.equal(Object.keys(call.modules).length,5);assert.equal(call.modules['lib/unrelated'],undefined);
  assert.equal(call.modules['lib/private-config'],'export const ownerTelegramId=42;');
  assert.ok(!`${result.stdout}${result.stderr}`.includes('MUST_NOT_PRINT'));assert.ok(!result.stdout.includes('synthetic_secret'));
  assert.equal(JSON.parse(result.stdout).provider_requests,0);
});

test('CLI never retries an uncertain or throttled mutation and logs only safe cooldown metadata',t=>{
  const f=cliFixture(t),result=f.run(['--app-id','54321','--owner-id','42','--mode','apply','--batches','64','--calls','12'],{TEST_UNCERTAIN:'1'});
  assert.equal(result.status,1);assert.equal(f.calls().filter(row=>row.stage==='runFunction').length,1);
  assert.deepEqual(JSON.parse(result.stderr),{provider_body_purge_failed:true,status:429,retry_after_seconds:13});
  assert.ok(!`${result.stdout}${result.stderr}`.includes('SECRET_ERROR_BODY'));
});
