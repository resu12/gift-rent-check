// Owner CLI only. A reset publishes one monotonic checkpoint before bounded
// disposal. Readers ignore old market evidence immediately via the reset floor.
// Credentials, analytics, wallet bindings, nonces and provider ledgers survive.
import {createCloudRepository,NORMALIZED_RECORD_READY_SQL,preparedRecordJSON} from '../tgcloud/lib/cloud-repository.js';
import {createPublicRepository} from '../tgcloud/lib/public-repository.js';
import {COMPACT_OPERATIONAL_READY_SQL} from '../tgcloud/lib/checkpoint-storage.js';
import {developmentResetState} from './compact-operational-storage.mjs';

const disposable = "'listing','history','owned_price','owned_status','personal_gift'";
function target(scope) {
  if (scope === 'private') return {table:'cloud_events',where:'1',params:{},cache:'dashboard_projection_cache'};
  if (!/^public:[1-9]\d{0,15}$/.test(scope)) throw new Error('Invalid development reset scope');
  return {table:'public_cloud_events',where:'user_id=:tenant',params:{':tenant':scope.slice(7)},cache:'public_dashboard_projection_cache'};
}
async function head(db,t) {
  const row = await db.get(`SELECT sequence,state_json FROM ${t.table} WHERE ${t.where} ORDER BY sequence DESC LIMIT 1`,t.params);
  return {sequence:row?.sequence??0,state:row?JSON.parse(row.state_json):null};
}
export async function beginDevelopmentStorageReset(db,{scope='private',resetId}={}) {
  if (typeof resetId!=='string'||!/^dev-reset:[a-zA-Z0-9-]{16,80}$/.test(resetId)) throw new Error('Invalid development reset ID');
  const t=target(scope);
  const beforeAccount=scope==='private'?null:await db.get("SELECT generation FROM public_accounts WHERE user_id=:tenant AND status='active'",t.params);
  if(scope!=='private'&&!beforeAccount) throw new Error('Development account is not active');
  const old=await db.get(`SELECT sequence,state_json FROM ${t.table} WHERE ${t.where} AND event_key=:key`,{...t.params,':key':resetId});
  if(old) return {started:true,already_started:true,floor:old.sequence,scope,resetId,generation:beforeAccount?.generation??null};
  if(!await db.get(`SELECT 1 AS ready WHERE (${COMPACT_OPERATIONAL_READY_SQL}) AND (${NORMALIZED_RECORD_READY_SQL})`)) throw new Error('Compact storage is not installed');
  const repo=scope==='private'?createCloudRepository(db):createPublicRepository(db,scope.slice(7));
  if(typeof repo.syncOwnedRefreshArchive==='function') await repo.syncOwnedRefreshArchive();
  const saved=await repo.read();
  const now=await db.get("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at");
  const state=developmentResetState(saved.state,Date.parse(now.at));
  state.record_storage_floor=saved.revision+1;
  const account=scope==='private'?null:await repo.publicAccount();
  if(scope!=='private'&&account?.generation!==beforeAccount.generation) throw new Error('Development account changed');
  const params={...t.params,':sequence':saved.revision+1,':expected':saved.revision,':key':resetId,':state':JSON.stringify(state),':at':now.at,
    ':records':preparedRecordJSON([{kind:'development_reset',record:{floor:saved.revision+1}}],true),...(account?{':generation':account.generation}: {})};
  const cols=scope==='private'?'':'row_id,user_id,',values=scope==='private'?'':"json_array(:tenant,'event',:sequence),:tenant,";
  const result=await db.run(`INSERT INTO ${t.table}(${cols}sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at)
    SELECT ${values}:sequence,:key,:state,NULL,NULL,:records,NULL,:at
    WHERE COALESCE((SELECT MAX(sequence) FROM ${t.table} WHERE ${t.where}),0)=:expected
      AND NOT EXISTS(SELECT 1 FROM ${t.table} WHERE ${t.where} AND event_key=:key)
      AND ${COMPACT_OPERATIONAL_READY_SQL}
      AND ${NORMALIZED_RECORD_READY_SQL}
      AND EXISTS(SELECT 1 FROM service_storage_usage WHERE id=1 AND initialized_at>0)
      AND NOT EXISTS(SELECT 1 FROM public_accounts WHERE status='migrating')
      ${account?"AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:generation AND status='active')":''}`,params);
  if(result.rowsAffected!==1) throw new Error('Data changed; retry the development reset');
  return {started:true,already_started:false,floor:saved.revision+1,scope,resetId,generation:account?.generation??null};
}

export async function disposeDevelopmentStorage(db,{scope='private',floor,resetId,generation=null,after=0,limit=16}={}) {
  const t=target(scope);
  if(!Number.isSafeInteger(floor)||floor<1||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>25)
    throw new Error('Invalid development disposal bounds');
  if(typeof resetId!=='string'||!/^dev-reset:[a-zA-Z0-9-]{16,80}$/.test(resetId)
    ||scope==='private'&&generation!==null||scope!=='private'&&(!Number.isSafeInteger(generation)||generation<0)) throw new Error('Invalid development reset fence');
  const current=await head(db,t);
  if(current.state?.operational_storage_version!==1||current.state?.record_storage_floor!==floor)
    throw new Error('Development reset changed');
  if(scope!=='private') t.params[':generation']=generation;
  t.params[':reset_id']=resetId;
  const fence=`EXISTS(SELECT 1 FROM ${t.table} h WHERE ${scope==='private'?'1':'h.user_id=:tenant'}
    AND h.sequence=(SELECT MAX(sequence) FROM ${t.table} WHERE ${t.where})
    AND json_extract(h.state_json,'$.operational_storage_version')=1 AND json_extract(h.state_json,'$.record_storage_floor')=:floor)
    AND EXISTS(SELECT 1 FROM ${t.table} WHERE ${t.where} AND sequence=:floor AND event_key=:reset_id)
    ${scope==='private'?'':"AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND status='active' AND generation=:generation)"}`;
  if(!await db.get(`SELECT 1 AS ready WHERE ${fence}`,{...t.params,':floor':floor})) throw new Error('Development reset changed');
  const params={...t.params,':floor':floor,':after':after,':limit':limit};
  // Read identifiers and byte counts only, never provider records or secrets.
  const page=await db.all(`WITH pending AS(SELECT sequence,
      length(CAST(state_json AS BLOB))+COALESCE(length(CAST(job_json AS BLOB)),0)+length(CAST(records_json AS BLOB)) AS bytes
      FROM ${t.table} WHERE ${t.where} AND sequence>:after AND sequence<:floor AND ${fence} ORDER BY sequence LIMIT :limit),
    bounded AS(SELECT sequence,SUM(bytes) OVER(ORDER BY sequence) AS total_bytes FROM pending)
    SELECT sequence FROM bounded WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`,params);
  if(page.length) {
    const end=page.at(-1).sequence;
    const result=await db.run(`UPDATE ${t.table} SET state_json='{}',job_json=NULL,raw_body=NULL,
      records_json=CASE WHEN EXISTS(SELECT 1 FROM json_each(${t.table}.records_json)
        WHERE json_type(value,'$.__normalized_record_v1')='integer' AND COALESCE(json_extract(value,'$.kind'),'') NOT IN(${disposable}))
        THEN (SELECT json_group_array(json(CASE WHEN COALESCE(json_extract(value,'$.kind'),'') IN(${disposable}) THEN '{}' ELSE value END)) FROM json_each(${t.table}.records_json))
        ELSE COALESCE((SELECT json_group_array(json(value)) FROM json_each(${t.table}.records_json)
          WHERE COALESCE(json_extract(value,'$.kind'),'') NOT IN(${disposable})),'[]') END
      WHERE ${t.where} AND sequence>:after AND sequence<=:end AND sequence<:floor AND ${fence}`,
      {...t.params,':floor':floor,':after':after,':end':end});
    if(result.rowsAffected!==page.length) throw new Error('Development disposal lost its fence');
    return {complete:false,scope,floor,after:end,rows:page.length};
  }
  // The bounded evidence tables are normally empty on the first reset. Their
  // cleanup also makes subsequent development resets resumable and isolated.
  for(const [table,column,condition] of [
    ['service_record_occurrences','occurrence_id',`scope=:scope AND sequence<:floor AND EXISTS
      (SELECT 1 FROM service_record_payloads p WHERE p.payload_id=service_record_occurrences.payload_id AND json_extract(p.document,'$.kind') IN(${disposable}))`],
    ['service_record_payloads','payload_id','scope=:scope AND NOT EXISTS(SELECT 1 FROM service_record_occurrences o WHERE o.payload_id=service_record_payloads.payload_id)'],
    ['service_checkpoint_sources','row_id','scope=:scope AND source_sequence<:floor'],
  ]) {
    const values={...t.params,':floor':floor,':scope':scope,':limit':limit};
    const removed=await db.run(`DELETE FROM ${table} WHERE ${column} IN(SELECT ${column} FROM ${table} WHERE ${condition} LIMIT :limit)
      AND ${fence}`,values);
    if(removed.rowsAffected) return {complete:false,scope,floor,after,rows:removed.rowsAffected};
  }
  const cache=await db.run(`DELETE FROM ${t.cache} WHERE ${scope==='private'?'selection_key':'row_id'} IN
    (SELECT ${scope==='private'?'selection_key':'row_id'} FROM ${t.cache} WHERE ${t.where} LIMIT :limit) AND ${fence}`,
    {...t.params,':floor':floor,':limit':limit});
  if(cache.rowsAffected) return {complete:false,scope,floor,after,rows:cache.rowsAffected};
  return {complete:true,scope,floor,after,rows:0};
}
