// Owner CLI material, uploaded only for an administrative invocation. The
// deployed app remains within its existing module limit.
import {normalizeStoragePolicy, storagePaused, STORAGE_TABLES} from '../tgcloud/lib/storage-policy.js';

const CLOCK="CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)";
const NO_MIGRATION=`NOT EXISTS(SELECT 1 FROM public_accounts WHERE status='migrating')
  AND NOT EXISTS(SELECT 1 FROM public_legacy_migrations WHERE status<>'complete')`;
const READY=`EXISTS(SELECT 1 FROM service_storage_usage WHERE id=1 AND initialized_at>0 AND total_bytes>=0)
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'storage_usage_v1_%')=${STORAGE_TABLES.length*3}`;
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const identity=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function createProviderBodyPurge({db,ownerTelegramId,policy:inputPolicy={},random=Math.random}) {
  const owner=String(ownerTelegramId),policy=normalizeStoragePolicy(inputPolicy);
  if(!identity(owner)||!db?.get||!db?.all||!db?.run)throw Error('Invalid provider-body maintenance configuration');
  async function clock(){const at=(await db.get(`SELECT ${CLOCK} AS at`))?.at;if(!safe(at)||at<1)throw Error('Storage clock unavailable');return at;}
  async function summary(mode,extra={}){
    const row=await db.get(`SELECT
      (SELECT COUNT(*) FROM cloud_events WHERE raw_body IS NOT NULL)+(SELECT COUNT(*) FROM public_cloud_events WHERE raw_body IS NOT NULL) AS remaining_count,
      (SELECT COALESCE(SUM(length(CAST(raw_body AS BLOB))),0) FROM cloud_events)+(SELECT COALESCE(SUM(length(CAST(raw_body AS BLOB))),0) FROM public_cloud_events) AS remaining_bytes,
      (SELECT total_bytes FROM service_storage_usage WHERE id=1) AS estimated_bytes,
      (SELECT document FROM service_storage_monitor WHERE id=1) AS document`);
    if(!safe(row?.remaining_count)||!safe(row.remaining_bytes)||!safe(row.estimated_bytes))throw Error('Storage accounting unavailable');
    let document;try{document=JSON.parse(row.document);}catch{throw Error('Invalid storage monitor');}
    if(!object(document))throw Error('Invalid storage monitor');
    return {mode,complete:row.remaining_count===0,remaining_count:row.remaining_count,remaining_bytes:row.remaining_bytes,
      estimated_bytes:row.estimated_bytes,budget_bytes:policy.budgetBytes,paused:storagePaused(row.estimated_bytes,document.paused===true,policy),
      rewritten:0,reclaimed_bytes:0,passes_completed:0,blocked:false,provider_requests:0,...extra};
  }
  async function pass(){
    const at=await clock(),lease=`raw:${at}:${Math.floor(random()*9007199254740991).toString(36)}:${Math.floor(random()*9007199254740991).toString(36)}`;
    if(!await db.get(`SELECT 1 AS ready WHERE ${READY}`))throw Error('Storage accounting unavailable');
    if(!await db.get(`SELECT 1 AS safe WHERE ${NO_MIGRATION}`))return {blocked:true,reason:'legacy_migration_active',rewritten:0,reclaimed_bytes:0};
    const acquired=await db.run(`UPDATE service_storage_monitor SET lease_id=:lease,lease_until=:until
      WHERE id=1 AND lease_until<=${CLOCK} AND ${READY} AND ${NO_MIGRATION}`,{':lease':lease,':until':at+policy.leaseMs});
    if(acquired.rowsAffected!==1)return {blocked:true,reason:'maintenance_busy',rewritten:0,reclaimed_bytes:0};
    const leaseGuard=`EXISTS(SELECT 1 FROM service_storage_monitor WHERE id=1 AND lease_id=:lease AND lease_until>${CLOCK})`;
    let rewritten=0,reclaimed=0;
    try{
      for(const [table,key]of [['cloud_events','sequence'],['public_cloud_events','row_id']]){
        const page=await db.all(`WITH pending AS MATERIALIZED(SELECT ${key} AS id,length(CAST(raw_body AS BLOB)) AS bytes
          FROM ${table} WHERE raw_body IS NOT NULL ORDER BY ${key} LIMIT 25),
          bounded AS MATERIALIZED(SELECT id,bytes,SUM(bytes) OVER(ORDER BY id) AS total_bytes FROM pending)
          SELECT id,bytes FROM bounded WHERE total_bytes<=524288 OR id=(SELECT MIN(id) FROM pending) ORDER BY id`);
        if(!page.length)continue;
        if(page.length>25||page.some(row=>!safe(row.bytes)))throw Error('Invalid provider-body page');
        const parameters={':lease':lease},ids=[];let bytes=0;
        for(const [index,row]of page.entries()){
          if(key==='sequence'&&(!safe(row.id)||row.id<1)||key==='row_id'&&typeof row.id!=='string')throw Error('Invalid provider-body identifier');
          parameters[`:id${index}`]=row.id;parameters[`:bytes${index}`]=row.bytes;bytes+=row.bytes;
          ids.push(`(${key}=:id${index} AND length(CAST(raw_body AS BLOB))=:bytes${index})`);
        }
        if(!safe(bytes)||bytes>524288&&page.length!==1)throw Error('Invalid provider-body byte bound');
        const result=await db.run(`UPDATE ${table} SET raw_body=NULL WHERE raw_body IS NOT NULL AND (${ids.join(' OR ')})
          AND ${leaseGuard} AND ${READY} AND ${NO_MIGRATION}`,parameters);
        if(result.rowsAffected===0){
          const migration=await db.get(`SELECT 1 AS safe WHERE ${NO_MIGRATION}`);
          return {blocked:true,reason:migration?'lease_lost':'legacy_migration_active',rewritten:0,reclaimed_bytes:0};
        }
        // A concurrent account erasure can remove selected rows. Do not claim
        // their bytes as this purge's savings or retry an uncertain mutation.
        if(result.rowsAffected!==page.length)throw Error('Provider-body purge was not fully confirmed');
        rewritten=result.rowsAffected;reclaimed=bytes;break;
      }
      const saved=await db.get('SELECT document FROM service_storage_monitor WHERE id=1 AND lease_id=:lease',{':lease':lease});
      let document;try{document=JSON.parse(saved?.document);}catch{throw Error('Invalid storage monitor');}
      if(!object(document))throw Error('Invalid storage monitor');
      const cleanup=object(document.cleanup)?document.cleanup:{};
      if(cleanup.reclaimed_bytes!==undefined&&!safe(cleanup.reclaimed_bytes))throw Error('Invalid storage savings');
      const after=(await db.get('SELECT total_bytes FROM service_storage_usage WHERE id=1'))?.total_bytes;
      if(!safe(after))throw Error('Storage accounting unavailable');
      // Preserve all cursor, phase, boundary and outcome fields. Only the
      // savings total and freshness/admission metadata change.
      document={...document,version:1,checked_at:await clock(),paused:storagePaused(after,document.paused===true,policy),
        cleanup:{...cleanup,reclaimed_bytes:(cleanup.reclaimed_bytes??0)+reclaimed}};
      if(!safe(document.cleanup.reclaimed_bytes))throw Error('Invalid storage savings');
      // Admission can change the hysteresis bit without taking this lease.
      // Recalculate it from the live counter and current bit in the final
      // statement rather than overwriting a concurrent admission update.
      const updated=await db.run(`UPDATE service_storage_monitor SET document=json_set(:document,'$.paused',
        json(CASE WHEN (SELECT total_bytes FROM service_storage_usage WHERE id=1)>=
          CASE WHEN json_extract(document,'$.paused')=1 THEN :resume_limit ELSE :pause_limit END
          THEN 'true' ELSE 'false' END)),lease_id=NULL,lease_until=0
        WHERE id=1 AND lease_id=:lease AND lease_until>${CLOCK} AND ${READY}`,
        {':document':JSON.stringify(document),':lease':lease,':resume_limit':policy.budgetBytes*policy.resumeRatio,
          ':pause_limit':policy.budgetBytes*policy.pauseRatio});
      if(updated.rowsAffected!==1)throw Error('Storage metadata update was not confirmed');
      return {blocked:false,rewritten,reclaimed_bytes:reclaimed};
    }finally{
      // Release only our still-live lease. A replacement worker's ownership
      // and document can never be changed by a delayed invocation.
      await db.run(`UPDATE service_storage_monitor SET lease_id=NULL,lease_until=0
        WHERE id=1 AND lease_id=:lease AND lease_until>${CLOCK}`,{':lease':lease});
    }
  }
  return async function(input,ctx){
    if(String(ctx?.initData?.user?.id)!==owner)throw Error('Private access denied');
    if(!object(input)||Object.keys(input).some(key=>!['mode','batches'].includes(key))||!['check','apply'].includes(input.mode)
      ||!Number.isSafeInteger(input.batches)||input.batches<1||input.batches>64)throw Error('Invalid provider-body maintenance input');
    if(!await db.get(`SELECT 1 AS ready WHERE ${READY}`))throw Error('Storage accounting unavailable');
    if(!await db.get(`SELECT 1 AS safe WHERE ${NO_MIGRATION}`))return summary(input.mode,{blocked:true,reason:'legacy_migration_active'});
    if(input.mode==='check')return summary(input.mode);
    const started=await clock();let passes=0,rewritten=0,reclaimed=0,outcome={blocked:false};
    for(;passes<input.batches;){
      if(passes&&await clock()-started>=10000)break;
      outcome=await pass();if(outcome.blocked)break;
      passes++;rewritten+=outcome.rewritten;reclaimed+=outcome.reclaimed_bytes;
      if(outcome.rewritten===0)break;
    }
    return summary(input.mode,{passes_completed:passes,rewritten,reclaimed_bytes:reclaimed,blocked:outcome.blocked,
      ...(outcome.reason?{reason:outcome.reason}:{})});
  };
}
