// Offline synthetic workload through production repositories and admission.
// No credentials, network calls or hosted database are used. This measures
// logical storage and local SQLite behavior, never a Telegram hosting quota.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createPublicDatabase} from '../tests/fixtures/public-database.mjs';
import {createPublicRepository,PublicAccountError,PublicStorageLimitError} from '../tgcloud/lib/public-repository.js';
import {createStorageAdmission,StorageCapacityError} from '../tgcloud/lib/storage-admission.js';
import {STORAGE_TABLES,storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';
import {installStorageAccounting} from './storage-accounting.mjs';
import {installCompactOperationalStorage} from './compact-operational-storage.mjs';
import {installNormalizedRecordStorage} from './normalized-record-storage.mjs';
const MiB=1048576;
const percentile=(values,p)=>Number([...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))].toFixed(2));
const event=(key,state,records=[])=>({key,state,records,observed_at:new Date().toISOString()});
async function install(db) {
  await installCompactOperationalStorage(db);await installNormalizedRecordStorage(db);
  let progress={after:0};do{progress=await installStorageAccounting(db,{after:progress.after});}while(!progress.complete);
}
async function reservationChecks() {
  const f=createPublicDatabase();
  try {
    await install(f.db);
    // The separate fixture creates pressure at the exact service threshold.
    f.database.prepare('UPDATE service_storage_usage SET total_bytes=?').run(25*MiB);
    const admission=createStorageAdmission(f.db,{policy:{budgetBytes:32*MiB,reserveBytes:MiB}});
    const a=admission.forScope('public:101'),b=admission.forScope('public:202');
    const inputs=[{token:'capacity-drill-token-a',bytes:3*MiB,expiresAt:Date.now()+120000,kind:'comparison'},
      {token:'capacity-drill-token-b',bytes:3*MiB,expiresAt:Date.now()+120000,kind:'comparison'}];
    const outcomes=await Promise.allSettled([a.reserveStorage(inputs[0]),b.reserveStorage(inputs[1])]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.ok(outcomes.find(r=>r.status==='rejected').reason instanceof StorageCapacityError);
    const winner=outcomes[0].status==='fulfilled'?a:b,loser=winner===a?b:a,token=outcomes[0].status==='fulfilled'?inputs[0].token:inputs[1].token;
    await assert.rejects(loser.assertAdmitted(1,token),StorageCapacityError);
    await loser.releaseStorage(token);await winner.assertAdmitted(1,token);
    await winner.releaseStorage(token);assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM service_storage_reservations').get().n,0);
    return {global_reservation_race:true,cross_account_reservation_reuse_rejected:true};
  } finally {f.database.close();}
}
export async function runPublicCapacityDrill({accounts=16,giftsPerAccount=200,observations=3}={}) {
  if(!Number.isSafeInteger(accounts)||accounts<2||accounts>100||!Number.isSafeInteger(giftsPerAccount)||giftsPerAccount<2||giftsPerAccount>500
    ||!Number.isSafeInteger(observations)||observations<2||observations>10)throw Error('Invalid bounded capacity workload');
  const f=createPublicDatabase(),started=performance.now(),appendTimes=[],readTimes=[];
  try {
    await install(f.db);const admission=createStorageAdmission(f.db);
    const options=id=>({maxAccounts:accounts,storageAdmission:admission.forScope('public:'+id)});
    const repos=Array.from({length:accounts},(_,i)=>createPublicRepository(f.db,10001+i,options(10001+i)));
    await Promise.all(repos.map(repo=>repo.ensureAccount()));
    await assert.rejects(createPublicRepository(f.db,999999,{maxAccounts:accounts}).ensureAccount(),PublicAccountError);
    const states=await Promise.all(repos.map(async repo=>(await repo.read()).state));
    let sourceBytes=0;
    for(let pass=0;pass<observations;pass++)await Promise.all(repos.map(async(repo,index)=>{
      const records=Array.from({length:giftsPerAccount},(_,gift)=>({kind:'history',key:`synthetic:${index}:${pass}:${gift}`,observed_at:'2026-10-12T00:00:00.000Z',
        record:{identity:`synthetic-gift-${index}-${gift}`,account_marker:index,price_per_day:'0.10',collection:'Synthetic Collection '+gift%12,model:'Model '+gift%7,
          backdrop:gift%5?'Blue':'Black',rental_duration:86400,source_json:{price:'100000000',stable_unknown:'synthetic evidence '.repeat(20)}}}));
      sourceBytes+=Buffer.byteLength(JSON.stringify(records));const start=performance.now();
      assert.equal(await repo.append(pass,event('page:'+pass,states[index],records)),true);appendTimes.push(performance.now()-start);
    }));
    await Promise.all(repos.map(async(repo,index)=>{
      const start=performance.now(),records=await repo.records();readTimes.push(performance.now()-start);
      assert.equal(records.length,giftsPerAccount*observations);assert.ok(records.every(r=>r.record.account_marker===index));
    }));
    const head=await repos[0].read();
    const conflicts=await Promise.all([repos[0].append(head.revision,event('race:a',head.state)),repos[0].append(head.revision,event('race:b',head.state))]);
    assert.deepEqual([...conflicts].sort(),[false,true]);
    const logical=f.database.prepare('SELECT total_bytes FROM service_storage_usage WHERE id=1').get().total_bytes;
    const exact=f.database.prepare(`SELECT ${STORAGE_TABLES.map(t=>`(SELECT COALESCE(SUM(${storageTableByteExpression(t)}),0) FROM ${t.name})`).join('+')} AS n`).get().n;
    assert.equal(logical,exact);
    const sizes=f.database.prepare("SELECT total_bytes FROM service_storage_scope_usage WHERE scope LIKE 'public:%'").all().map(r=>r.total_bytes);
    const normalized=f.database.prepare('SELECT (SELECT COUNT(*) FROM service_record_payloads) AS payloads,(SELECT COUNT(*) FROM service_record_occurrences) AS observations').get();
    assert.equal(normalized.payloads,accounts*giftsPerAccount);assert.equal(normalized.observations,accounts*giftsPerAccount*observations);
    const stale=createPublicRepository(f.db,10001,options(10001));await stale.read();
    let deletion=await repos[0].deleteAccountData(100),passes=1;
    while(deletion.pending_cleanup){assert.ok(passes++<1000);deletion=await repos[0].processAccountDeletion(100);}
    await repos[0].reactivateAccount();await assert.rejects(stale.append(head.revision,event('late-write',head.state)),PublicAccountError);
    assert.equal((await repos[0].records()).length,0);assert.equal((await repos[1].records()).length,giftsPerAccount*observations);
    const quotaRepo=createPublicRepository(f.db,10002,{maxAccounts:accounts,maxAccountBytes:1024,maxServiceBytes:128*MiB});
    const second=await repos[1].read();await assert.rejects(quotaRepo.append(second.revision,event('quota-blocked',second.state)),PublicStorageLimitError);
    const reservations=await reservationChecks();
    const pages=f.database.prepare('PRAGMA page_count').get().page_count,pageSize=f.database.prepare('PRAGMA page_size').get().page_size;
    return {version:1,passed:true,completed_at:new Date().toISOString(),mode:'offline_synthetic',accounts,gifts_per_account:giftsPerAccount,observations_per_gift:observations,
      logical_bytes_before_deletion:logical,source_record_bytes_before_deduplication:sourceBytes,account_bytes:{median:percentile(sizes,.5),largest:Math.max(...sizes)},
      normalized_payloads:normalized.payloads,normalized_observations:normalized.observations,local_sqlite_allocated_bytes:pages*pageSize,
      duration_ms:Number((performance.now()-started).toFixed(2)),append_p95_ms:percentile(appendTimes,.95),read_p95_ms:percentile(readTimes,.95),
      checks:{account_cap:true,isolation:true,conflicting_write_cas:true,deletion_generation_fence:true,tenant_quota:true,accounting_exact:true,...reservations},
      provider_requests:0,hosting_quota_verified:false,hosted_load_verified:false};
  } finally {f.database.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2),names={'--accounts':'accounts','--gifts':'giftsPerAccount','--observations':'observations'},options={};
  try {
    for(let i=0;i<args.length;i+=2){const key=names[args[i]];if(!key||key in options||!/^\d+$/.test(args[i+1]??''))throw Error('Invalid drill argument');options[key]=Number(args[i+1]);}
    console.log(JSON.stringify(await runPublicCapacityDrill(options),null,2));
  } catch {console.error(JSON.stringify({capacity_drill_failed:true,live_database_modified:false}));process.exitCode=1;}
}
