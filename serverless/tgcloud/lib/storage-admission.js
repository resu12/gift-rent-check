import {utf8Size} from './bounded-response.js';
import {normalizeStoragePolicy,DEFAULT_PUBLIC_ACCOUNT_BYTES} from './storage-policy.js';

// SQLite evaluates this once for the whole statement. No client clock can make
// an expired reservation reusable or spend somebody else's reserved space.
export const STORAGE_SQL_NOW = "CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)";
export class StorageCapacityError extends Error {
  constructor() {
    super('Updates are paused to protect saved data. Clean up storage from Status, then try again.');
    this.code='STORAGE_CAPACITY_PAUSED';
  }
}
const positive=value=>Number.isSafeInteger(value)&&value>0;
const validToken=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{16,160}$/.test(value);
const validKind=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(value);
const MAX_RESERVATION_MS=300000;
// Disposable invited-account projections leave room for a normal comparison
// page (3.5 MiB plus checkpoint growth). Larger jobs still reserve their exact
// bound and may reclaim their own cache before retrying admission once.
export const PUBLIC_COLLECTION_HEADROOM_BYTES=4*1048576;

export function createStorageAdmission(db,{policy}={}) {
  const cap=normalizeStoragePolicy(policy??{}), ordinaryLimit=Math.floor(cap.budgetBytes*cap.pauseRatio),
    recoveryLimit=cap.budgetBytes-cap.reserveBytes,resumeLimit=Math.floor(cap.budgetBytes*cap.resumeRatio);
  const ready=`EXISTS(SELECT 1 FROM service_storage_usage WHERE id=1 AND initialized_at>0 AND total_bytes>=0)`;
  const used='COALESCE((SELECT total_bytes FROM service_storage_usage WHERE id=1),0)';
  const paused="COALESCE((SELECT json_extract(document,'$.paused') FROM service_storage_monitor WHERE id=1),0)";
  function forScope(scope,{maxBytes=DEFAULT_PUBLIC_ACCOUNT_BYTES}={}) {
    if(typeof scope!=='string'||! /^(?:private|public:[1-9]\d{0,15})$/.test(scope))throw new Error('Invalid storage scope');
    if(!positive(maxBytes)||maxBytes>cap.budgetBytes)throw new Error('Invalid storage scope budget');
    const tenant=scope.startsWith('public:');
    function fence(bytes,token=null,{control=false}={}) {
      if(!Number.isSafeInteger(bytes)||bytes<0||token!==null&&!validToken(token)||typeof control!=='boolean')throw new Error('Invalid storage admission');
      const own=`EXISTS(SELECT 1 FROM service_storage_reservations WHERE token=:storage_token AND scope=:storage_scope
        AND expires_at>${STORAGE_SQL_NOW} AND bytes>=:storage_bytes)`;
      const reserved=`COALESCE((SELECT SUM(bytes) FROM service_storage_reservations WHERE expires_at>${STORAGE_SQL_NOW}
        AND (:storage_token IS NULL OR token<>:storage_token OR scope<>:storage_scope)),0)`;
      const tenantFence=tenant?`AND COALESCE((SELECT total_bytes FROM service_storage_scope_usage WHERE scope=:storage_scope),0)
        +COALESCE((SELECT SUM(bytes) FROM service_storage_reservations WHERE scope=:storage_scope AND expires_at>${STORAGE_SQL_NOW}
          AND (:storage_token IS NULL OR token<>:storage_token)),0)+:storage_bytes<=:storage_scope_limit`:'';
      return {sql:`${ready} AND (:storage_control=1 OR (${paused}=0 OR ${used}<=:storage_resume_limit))
        AND (:storage_token IS NULL OR ${own}) AND ${used}+${reserved}+:storage_bytes<=:storage_limit ${tenantFence}`,
        parameters:{':storage_scope':scope,':storage_token':token,':storage_bytes':bytes,':storage_control':control?1:0,
          ':storage_limit':control?recoveryLimit:ordinaryLimit,':storage_resume_limit':resumeLimit,...(tenant?{':storage_scope_limit':maxBytes+(control?262144:0)}:{})}};
    }
    async function assertAdmitted(bytes,token=null,options={}) {
      const guard=fence(bytes,token,options);
      if(!await db.get(`SELECT 1 AS admitted WHERE ${guard.sql}`,guard.parameters))throw new StorageCapacityError();
    }
    async function reserveStorage({token,bytes,expiresAt,kind}) {
      if(!validToken(token)||!positive(bytes)||bytes>16777216||!positive(expiresAt)||!validKind(kind))throw new Error('Invalid storage reservation');
      // Update only the hysteresis bit. A concurrent cleanup's lease and cursor
      // remain untouched, and returning below 90% alone cannot reopen updates.
      await db.run(`UPDATE service_storage_monitor SET document=json_set(document,'$.paused',
        json(CASE WHEN ${used}>=:pause_limit THEN 'true' ELSE 'false' END)) WHERE id=1 AND json_valid(document)
        AND ${ready} AND (${used}>=:pause_limit OR ${used}<=:resume_limit)`,
        {':pause_limit':ordinaryLimit,':resume_limit':resumeLimit});
      await db.run(`DELETE FROM service_storage_reservations WHERE expires_at<=${STORAGE_SQL_NOW}`);
      const existing=await db.get('SELECT scope,bytes,expires_at,kind FROM service_storage_reservations WHERE token=:token',{':token':token});
      if(existing) {
        if(existing.scope!==scope||existing.bytes!==bytes||existing.expires_at!==expiresAt||existing.kind!==kind)throw new Error('Invalid storage reservation');
        await assertAdmitted(0,token);return token;
      }
      const guard=fence(bytes);
      const result=await db.run(`INSERT OR IGNORE INTO service_storage_reservations(token,scope,bytes,expires_at,kind)
        SELECT :token,:scope,:bytes,:expires,:kind WHERE ${guard.sql}
        AND :expires>${STORAGE_SQL_NOW} AND :expires<=${STORAGE_SQL_NOW}+${MAX_RESERVATION_MS}`,
        {...guard.parameters,':token':token,':scope':scope,':bytes':bytes,':expires':expiresAt,':kind':kind});
      if(result.rowsAffected!==1)throw new StorageCapacityError();
      return token;
    }
    async function releaseStorage(token) {
      if(!validToken(token))throw new Error('Invalid storage reservation');
      await db.run('DELETE FROM service_storage_reservations WHERE token=:token AND scope=:scope',{':token':token,':scope':scope});
    }
    return {reserveStorage,releaseStorage,fence,assertAdmitted};
  }
  return {forScope};
}

// Reserve the full bounded request/save operation before any provider allowance
// or checkpoint is spent. Holding the original amount until finally releases it
// is deliberately conservative while intermediate checkpoints are committed.
export async function withStorageReservation(repository,{kind,responseBytes=1048576,checkpoint=true},work) {
  if(typeof repository.reserveStorage!=='function')return await work(null);
  if(!validKind(kind)||!positive(responseBytes)||responseBytes>1048576||typeof checkpoint!=='boolean')throw new Error('Invalid storage request budget');
  const at=await repository.clock(),saved=checkpoint?await repository.read():null;
  const stateBytes=saved?utf8Size(JSON.stringify(saved.state)):0;
  // Keep headroom for three state/job checkpoints, a bounded normalized page
  // and response-derived state copied into both checkpoint and job. Raw
  // provider bodies are discarded. Analytics without checkpoints still saves
  // its compact source snapshot and normalized report, so budget both copies.
  const bytes=Math.max(262144,stateBytes*6+responseBytes*(checkpoint?3:2)+524288);
  if(bytes>16777216)throw new StorageCapacityError();
  const token=`storage:${kind}:${at}:${Math.floor(Math.random()*Number.MAX_SAFE_INTEGER)}`;
  await repository.reserveStorage({token,bytes,expiresAt:at+MAX_RESERVATION_MS,kind});
  try{return await work(token);}finally{try{await repository.releaseStorage(token);}catch{/* bounded reservation expires without resetting any provider allowance */}}
}
