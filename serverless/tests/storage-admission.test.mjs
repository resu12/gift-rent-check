import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createStorageAdmission,StorageCapacityError,withStorageReservation} from '../tgcloud/lib/storage-admission.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {createOwnedPriceEngine} from '../tgcloud/lib/owned-price-engine.js';
import {createMarketappAnalyticsRefreshEngine} from '../tgcloud/lib/marketapp-analytics-refresh.js';
import {storageAccountingTriggers,installCheckpointSourceAccounting} from '../tools/storage-accounting.mjs';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';

const MiB=1048576,policy={budgetBytes:32*MiB,reserveBytes:MiB},token='storage-private-token-001';
function fixture(t,{used=0,paused=false,initialized=true}={}) {
  const f=createPublicDatabase(t);
  f.database.exec(`CREATE TABLE IF NOT EXISTS service_storage_usage(id INTEGER PRIMARY KEY,total_bytes INTEGER NOT NULL,initialized_at INTEGER);
    CREATE TABLE IF NOT EXISTS service_storage_scope_usage(scope TEXT PRIMARY KEY,total_bytes INTEGER NOT NULL,initialized_at INTEGER);
    CREATE TABLE IF NOT EXISTS service_storage_monitor(id INTEGER PRIMARY KEY,document TEXT NOT NULL,lease_id TEXT,lease_until INTEGER);
    CREATE TABLE IF NOT EXISTS service_storage_reservations(token TEXT PRIMARY KEY,scope TEXT NOT NULL,bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL,kind TEXT NOT NULL);`);
  f.database.prepare('INSERT OR REPLACE INTO service_storage_usage VALUES(1,?,?)').run(used,initialized?Date.now():0);
  f.database.prepare('INSERT OR REPLACE INTO service_storage_monitor VALUES(1,?,NULL,0)').run(JSON.stringify({paused}));
  f.admission=createStorageAdmission(f.db,{policy});return f;
}
const reserve=(repo,bytes,id=token)=>repo.reserveStorage({token:id,bytes,expiresAt:Date.now()+120000,kind:'comparison'});

test('private and public reservations share one atomic capacity budget',async t=>{
  const f=fixture(t,{used:25*MiB}),a=f.admission.forScope('private'),b=f.admission.forScope('public:101');
  const outcomes=await Promise.allSettled([reserve(a,3*MiB),reserve(b,3*MiB,'storage-public-token-002')]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
  assert.ok(outcomes.find(row=>row.status==='rejected').reason instanceof StorageCapacityError);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_storage_reservations').get().n,1);
});

test('a final write uses its own reservation and cannot take another request reservation',async t=>{
  const f=fixture(t,{used:25*MiB}),a=f.admission.forScope('private'),b=f.admission.forScope('public:101');
  await reserve(a,3*MiB);
  await a.assertAdmitted(2*MiB,token);
  await assert.rejects(b.assertAdmitted(2*MiB),StorageCapacityError);
  await assert.rejects(b.assertAdmitted(1,token),StorageCapacityError);
  await assert.rejects(a.assertAdmitted(4*MiB,token),StorageCapacityError);
});

test('expired reservations cannot approve saves, are purged before a new request, and cannot be released across accounts',async t=>{
  const f=fixture(t),a=f.admission.forScope('private'),b=f.admission.forScope('public:101');
  await reserve(a,MiB);await b.releaseStorage(token);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_storage_reservations').get().n,1);
  f.database.prepare('UPDATE service_storage_reservations SET expires_at=1').run();
  await assert.rejects(a.assertAdmitted(1,token),StorageCapacityError);
  await reserve(b,MiB,'storage-public-token-002');
  assert.deepEqual(f.database.prepare('SELECT scope FROM service_storage_reservations').all().map(row=>row.scope),['public:101']);
});

test('unknown accounting fails closed and hysteresis retains the pause until below 80 percent',async t=>{
  const unknown=fixture(t,{initialized:false});await assert.rejects(reserve(unknown.admission.forScope('private'),1),StorageCapacityError);
  const f=fixture(t,{used:27*MiB,paused:true}),a=f.admission.forScope('private');
  await assert.rejects(reserve(a,1),StorageCapacityError);
  await a.assertAdmitted(262144,null,{control:true});
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(25*MiB);
  await reserve(a,MiB);
});

test('tenant allowance includes reserved bytes and usage in all tenant tables',async t=>{
  const f=fixture(t),a=f.admission.forScope('public:101');
  f.database.prepare('INSERT INTO service_storage_scope_usage VALUES(?,?,?)').run('public:101',7*MiB,Date.now());
  await assert.rejects(reserve(a,2*MiB),StorageCapacityError);
  await reserve(a,MiB);
  await a.assertAdmitted(MiB,token);
  await assert.rejects(a.assertAdmitted(1),StorageCapacityError);
});

test('reservations are idempotent only for the exact immutable request and invalid data never reaches SQL',async t=>{
  const f=fixture(t),a=f.admission.forScope('private'),input={token,bytes:MiB,expiresAt:Date.now()+120000,kind:'comparison'};
  assert.equal(await a.reserveStorage(input),token);assert.equal(await a.reserveStorage(input),token);
  await assert.rejects(a.reserveStorage({...input,bytes:MiB+1}),/Invalid storage reservation/);
  const before=f.queries.length;
  await assert.rejects(a.reserveStorage({...input,token:'bad'}),/Invalid storage reservation/);
  assert.equal(f.queries.length,before);
  assert.ok(!f.queries.some(query=>/SUM\([^)]*state_json|FROM cloud_events|FROM public_cloud_events/.test(query.sql)),'admission reads indexed counters, not history scans');
});

test('private append admission is in the same SQL statement as the checkpoint CAS and preserves saved data when blocked',async t=>{
  const f=fixture(t),repo=createCloudRepository(f.db,{storageAdmission:f.admission.forScope('private')});
  const first={key:'first',state:{version:2,next_job_id:1,attempts:[100],next_allowed_at:1000,job:null},job:null,records:[],raw_body:null,observed_at:new Date().toISOString()};
  assert.equal(await repo.append(0,first),true);
  const before=f.database.prepare('SELECT * FROM cloud_events').all();
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(29*MiB);
  await assert.rejects(repo.append(1,{...first,key:'blocked',state:{...first.state,attempts:[100,200]}}),StorageCapacityError);
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events').all(),before);
  assert.ok(f.queries.some(query=>query.sql.startsWith('INSERT OR IGNORE INTO cloud_events')&&query.sql.includes('service_storage_usage')&&query.sql.includes('MAX(sequence)')));
});

test('public append and analytics import retain active-account fences while enforcing global admission',async t=>{
  const f=fixture(t),repo=f.repository(101,{storageAdmission:f.admission.forScope('public:101')});
  await repo.ensureAccount();
  const event={key:'first',state:{version:2,job:null},job:null,records:[],raw_body:null,observed_at:new Date().toISOString()};
  assert.equal(await repo.append(0,event),true);
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(29*MiB);
  await assert.rejects(repo.append(1,{...event,key:'blocked'}),StorageCapacityError);
  await assert.rejects(repo.importPersonalAnalytics({fingerprint:'snapshot',wallet:'wallet',captured_at:new Date().toISOString()},'{}',new Date().toISOString()),StorageCapacityError);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n,1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_personal_rental_analytics').get().n,0);
});

test('recovery reserve permits one verified stop transition but not repeated stop checkpoint inflation',async t=>{
  const f=fixture(t),repo=createCloudRepository(f.db,{storageAdmission:f.admission.forScope('private')}),job={id:1,state:'running',lease:null,lease_until:0};
  const event={key:'running',state:{version:2,job},job,records:[],raw_body:null,observed_at:new Date().toISOString()};
  assert.equal(await repo.append(0,event),true);
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(29*MiB);
  const stopped={...job,state:'partial',reason:'stopped_by_you'},stop={...event,key:'stop',state:{version:2,job:stopped},job:stopped};
  assert.equal(await repo.append(1,stop),true);
  await assert.rejects(repo.append(2,{...stop,key:'repeat-stop'}),StorageCapacityError);
});

test('public personal gift Stop uses recovery space above global and tenant limits and rejects repeated or false transitions',async t=>{
  const f=fixture(t),admission=f.admission.forScope('public:101',{maxBytes:2048}),repo=f.repository(101,{storageAdmission:admission,maxAccountBytes:2048,maxServiceBytes:MiB});
  await repo.ensureAccount();
  const run={id:7,state:'running',stage:'website',inflight:{id:'synthetic-lease',until:Date.now()+60000}},
    event={key:'gift-running',state:{version:2,job:null,gift_refresh:{version:1,run}},job:null,records:[],raw_body:null,observed_at:new Date().toISOString()};
  assert.equal(await repo.append(0,event),true);
  f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(29*MiB);
  f.database.prepare('INSERT INTO service_storage_scope_usage VALUES(?,?,?)').run('public:101',2048,Date.now());
  const stop={...event,key:'gift-stop',state:{...event.state,gift_refresh:{version:1,run:{...run,state:'partial',reason:'stopped_by_you'}}}};
  assert.equal(await repo.append(1,stop),true);
  await assert.rejects(repo.append(2,{...stop,key:'repeat-gift-stop'}),StorageCapacityError);
  await assert.rejects(repo.append(2,{...stop,key:'foreign-gift-stop',state:{...stop.state,gift_refresh:{version:1,run:{...stop.state.gift_refresh.run,id:8}}}}),StorageCapacityError);
  assert.equal((await repo.read()).state.gift_refresh.run.id,7);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n,2);
});

test('provider engines spend neither HTTP requests nor attempt checkpoints when storage reservation is denied',async()=>{
  const state={version:2,job:{id:1,state:'running'},attempts:[100],owned_prices:{version:2,run:{id:1,state:'running'},attempts:[200]}};
  let requests=0,writes=0,reservations=0;
  const repository={clock:async()=>Date.now(),read:async()=>({revision:1,state:structuredClone(state)}),append:async()=>{writes++;return true;},
    reserveStorage:async()=>{reservations++;throw new StorageCapacityError();},releaseStorage:async()=>assert.fail('no reservation to release')};
  const ctx={initData:{user:{id:101}}},fetch=async()=>{requests++;assert.fail('provider must not be called');};
  const cloud=createCloudEngine({repository,fetch,ownerTelegramId:101,marketappToken:'synthetic-token'}),owned=createOwnedPriceEngine({repository,fetch,ownerTelegramId:101}),analytics=createMarketappAnalyticsRefreshEngine({repository,fetch,ownerTelegramId:101});
  await assert.rejects(cloud.stepJob(ctx,{job_id:1}),StorageCapacityError);
  await assert.rejects(owned.step(ctx,{run_id:1}),StorageCapacityError);
  await assert.rejects(analytics.startMarketappAnalyticsRefresh(ctx,{period_days:30}),StorageCapacityError);
  assert.equal(requests,0);assert.equal(writes,0);assert.equal(reservations,3);
  assert.deepEqual(state.attempts,[100]);assert.deepEqual(state.owned_prices.attempts,[200]);
});

test('request budget is released after failure without resetting any provider allowance',async()=>{
  let acquired=null,released=null;
  const repository={clock:async()=>Date.now(),read:async()=>({state:{attempts:[100]}}),reserveStorage:async input=>{acquired=input;},releaseStorage:async token=>{released=token;}};
  await assert.rejects(withStorageReservation(repository,{kind:'comparison'},async token=>{assert.equal(token,acquired.token);throw new Error('synthetic failure');}),/synthetic failure/);
  assert.equal(released,acquired.token);assert.ok(acquired.bytes>=3.5*MiB&&acquired.bytes<4*MiB);
});

test('retained-data reservation lets an invited account with 4 MiB used run a comparison without reserving a discarded raw copy',async t=>{
  const f=fixture(t,{used:4*MiB});
  f.database.prepare('INSERT INTO service_storage_scope_usage VALUES(?,?,?)').run('public:101',4*MiB,Date.now());
  const admission=f.admission.forScope('public:101'),repo=f.repository(101,{storageAdmission:admission});
  await repo.ensureAccount();let calls=0;
  await withStorageReservation(repo,{kind:'comparison'},async reservedToken=>{
    calls++;
    const reservation=f.database.prepare('SELECT bytes,scope FROM service_storage_reservations WHERE token=?').get(reservedToken);
    assert.equal(reservation.scope,'public:101');assert.ok(reservation.bytes>=3.5*MiB&&reservation.bytes<4*MiB);
    assert.equal(await repo.append(0,{key:'retained-provider-result',state:{version:2,job:null},job:null,
      records:[{kind:'listing',record:{price_per_day:'170000000'}}],raw_body:'discarded-response',
      observed_at:new Date().toISOString(),storage_token:reservedToken}),true);
    assert.equal(f.database.prepare('SELECT raw_body FROM public_cloud_events').get().raw_body,null);
  });
  assert.equal(calls,1);assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_storage_reservations').get().n,0);
});

test('checkpoint reservations retain growth headroom and non-checkpoint analytics retain both report copies',async()=>{
  const state={job:{cursor:'€🙂'.repeat(3000)},attempts:[100]},reserved=[],released=[];
  const repository={clock:async()=>Date.now(),read:async()=>({state}),reserveStorage:async value=>reserved.push(value),releaseStorage:async value=>released.push(value)};
  await withStorageReservation(repository,{kind:'comparison',responseBytes:MiB},async()=>{});
  await withStorageReservation(repository,{kind:'analytics_refresh',responseBytes:262144,checkpoint:false},async()=>{});
  assert.equal(reserved[0].bytes,Buffer.byteLength(JSON.stringify(state))*6+3*MiB+524288);
  assert.equal(reserved[1].bytes,1048576);
  assert.deepEqual(released,reserved.map(value=>value.token));
});

test('private and public dashboard caches cannot spend space reserved for provider results',async t=>{
  const f=fixture(t,{used:28*MiB}),privateAdmission=f.admission.forScope('private'),
    privateRepo=createCloudRepository(f.db,{dashboardCache:true,storageAdmission:privateAdmission}),
    publicRepo=f.repository(101,{dashboardCache:true,storageAdmission:f.admission.forScope('public:101')});
  await publicRepo.ensureAccount();await reserve(privateAdmission,Math.floor(.7*MiB));
  const snapshot={version:1,gifts:['🦋'.repeat(100000)]};
  await privateRepo.saveDashboardSnapshot('private-view',1,1,snapshot);
  await publicRepo.saveDashboardSnapshot('public-view',1,1,snapshot);
  assert.equal(await privateRepo.dashboardSnapshot('private-view',1,1),null);
  assert.equal(await publicRepo.dashboardSnapshot('public-view',1,1),null);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_dashboard_projection_cache').get().n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_storage_reservations').get().n,1,'cache does not release a request reservation');
});

test('storage reservation cannot bypass private analytics logout fencing or turn an existing snapshot into false success',async t=>{
  const f=fixture(t),admission=f.admission.forScope('private'),repo=createCloudRepository(f.db,{storageAdmission:admission});
  f.database.prepare('INSERT INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version) VALUES(101,0,0,0)').run();
  await reserve(admission,MiB);
  const snapshot={fingerprint:'snapshot',wallet:'wallet',captured_at:new Date().toISOString()},raw='{}',at=new Date().toISOString();
  assert.equal(await repo.importPersonalAnalyticsFenced(snapshot,raw,at,'101',{generation:0,wallet_revision:0},0,token),true);
  f.database.prepare('UPDATE marketapp_analytics_sessions SET generation=1 WHERE owner_id=101').run();
  assert.equal(await repo.importPersonalAnalyticsFenced(snapshot,raw,at,'101',{generation:0,wallet_revision:0},0,token),false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n,1);
});

async function sourcePinFixture(t,kind='private') {
  const f=fixture(t);
  for(const trigger of storageAccountingTriggers())f.database.exec(trigger.sql);
  const installed=await installCheckpointSourceAccounting(f.db);assert.equal(installed.trigger_count,4);
  const isPublic=kind==='public',scope=isPublic?'public:101':'private',table=isPublic?'public_cloud_events':'cloud_events',
    admission=f.admission.forScope(scope),repo=isPublic?f.repository(101,{storageAdmission:admission}):createCloudRepository(f.db,{storageAdmission:admission});
  if(isPublic)await repo.ensureAccount();
  const run={id:1,wallet:'synthetic-wallet',state:'complete',targets:[{nft_address:'synthetic-nft',collection_address:'synthetic-collection',metadata:'x'.repeat(500)}]},
    event={key:'source-event',state:{version:2,job:null,owned_prices:{version:2,run},gift_refresh:{version:1,run:{id:2,state:'complete',results:{synthetic:{checked:true}}}}},
      job:null,records:[],raw_body:null,observed_at:new Date().toISOString()};
  assert.equal(await repo.append(0,event),true);
  let append=(expected,proposed)=>repo.append(expected,proposed);
  if(kind==='website') {
    const at=Date.now();
    f.database.prepare(`INSERT INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version,wallet,wallet_revision,ciphertext,created_at,expires_at)
      VALUES('101',0,0,0,'synthetic-wallet',0,'synthetic-encrypted-session',?,?)`).run(at-1000,at+120000);
    const stored={value:{owner:'101',wallet:'synthetic-wallet',cookie_version:0},fence:{generation:0,wallet_revision:0}};
    append=(expected,proposed)=>repo.appendWebsite(expected,proposed,'101',stored);
  }
  return {...f,scope,table,repo,append,event};
}
const summedBytes=(database,table)=>database.prepare(`SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) AS n FROM ${table}`).get().n;

test('source pins are inserted once and their UTF-8 bytes remain in the same private/public accounting transaction',async t=>{
  for(const kind of ['private','public']) {
    const f=await sourcePinFixture(t,kind),second={...f.event,key:'second-event'};
    const before=f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes;
    assert.equal(await f.append(1,second),true);
    const pins=f.database.prepare('SELECT * FROM service_checkpoint_sources WHERE scope=?').all(f.scope);
    assert.ok(pins.length>0&&pins.length<=4);
    const pinBytes=summedBytes(f.database,'service_checkpoint_sources');assert.ok(pinBytes>0&&pinBytes<1024);
    const after=f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,
      eventBytes=f.database.prepare(`SELECT ${storageTableByteExpression(f.table)} AS n FROM ${f.table} WHERE sequence=2`).get().n;
    assert.equal(after-before,eventBytes+pinBytes);
    assert.equal(await f.append(2,{...f.event,key:'third-event'}),true);
    const stablePins=f.database.prepare('SELECT * FROM service_checkpoint_sources WHERE scope=?').all(f.scope);
    // A nested owned-target reference can make checkpoint 2 the first whole
    // owned-state root. That additional pin is legitimate; reusing either root
    // repeatedly must not duplicate its indexed row.
    assert.ok(pins.every(pin=>stablePins.some(row=>row.row_id===pin.row_id)));
    assert.equal(new Set(stablePins.map(row=>row.row_id)).size,stablePins.length);
    assert.equal(await f.append(3,{...f.event,key:'fourth-event'}),true);
    assert.deepEqual(f.database.prepare('SELECT * FROM service_checkpoint_sources WHERE scope=?').all(f.scope),stablePins);
    const measured=STORAGE_TABLES.reduce((sum,table)=>sum+summedBytes(f.database,table.name),0);
    assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,measured);
  }
});

test('append admission reserves first-time source-pin overhead at ordinary, shared and tenant boundaries',async t=>{
  for(const [kind,boundary] of [['private','ordinary'],['website','shared'],['public','shared'],['public','tenant']]) {
    const f=await sourcePinFixture(t,kind),proposed={...f.event,key:'second-event'};
    assert.equal(await f.append(1,proposed),true);
    const eventBytes=f.database.prepare(`SELECT ${storageTableByteExpression(f.table)} AS n FROM ${f.table} WHERE sequence=2`).get().n,
      pinBytes=summedBytes(f.database,'service_checkpoint_sources');assert.ok(pinBytes>0&&pinBytes<1024);
    // Rewind only this isolated test database's trial commit. Usage triggers
    // remove its exact bytes, leaving the source event and real append fences.
    f.database.prepare(`DELETE FROM ${f.table} WHERE sequence=2`).run();
    f.database.prepare('DELETE FROM service_checkpoint_sources WHERE scope=?').run(f.scope);
    const otherReservation=boundary==='shared'?257:0,cap=boundary==='tenant'?8*MiB:Math.floor(policy.budgetBytes*.90),
      used=cap-eventBytes-otherReservation-Math.floor(pinBytes/2);
    if(boundary==='tenant')f.database.prepare('UPDATE service_storage_scope_usage SET total_bytes=? WHERE scope=?').run(used,f.scope);
    else f.database.prepare('UPDATE service_storage_usage SET total_bytes=? WHERE id=1').run(used);
    if(otherReservation)f.database.prepare(`INSERT INTO service_storage_reservations VALUES('other-active-provider-reservation','public:202',?,?, 'comparison')`).run(otherReservation,Date.now()+120000);
    assert.ok(used+otherReservation+eventBytes<=cap,'the event alone would fit');
    assert.ok(used+otherReservation+eventBytes+pinBytes>cap,'its first-time pin rows would cross the boundary');
    const beforeGlobal=f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,
      beforeScope=f.database.prepare('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=?').get(f.scope).total_bytes;
    await assert.rejects(f.append(1,proposed),StorageCapacityError,`${kind}/${boundary}`);
    assert.equal((await f.repo.read()).revision,1);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_checkpoint_sources WHERE scope=?').get(f.scope).n,0);
    assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_usage').get().total_bytes,beforeGlobal);
    assert.equal(f.database.prepare('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=?').get(f.scope).total_bytes,beforeScope);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_storage_reservations').get().n,otherReservation?1:0);
  }
});
