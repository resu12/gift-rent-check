import {safeMarketappRefreshOutcome} from './marketapp-refresh-outcome.js';
import {createDashboardCache} from './dashboard-cache.js';
import {createOwnedRefreshArchive} from './owned-refresh-archive.js';
import {encodeCheckpoint, decodeCheckpoint, createCheckpointStorage, OWNED_SOURCE_FENCE, OWNED_TARGET_SOURCE_FENCE, GIFT_SOURCE_FENCE, usesCompactOperationalStorage, COMPACT_OPERATIONAL_READY_SQL} from './checkpoint-storage.js';
import {createMarketappWebsiteGate} from './marketapp-website-gate.js';
import {createGiftRefreshStorage} from './gift-refresh-storage.js';
import {BUDGET_RESET_SOURCE_FENCE} from './budget-reset-checkpoint-storage.js';
import {utf8Size} from './bounded-response.js';
import {ownedScopeRecordFilter} from './owned-price-engine.js';
import {canonicalJSON} from './cloud-pricing-core.js';
import {sha256} from './ton-price-decoder.js';
import {utf8Bytes,personalAnalyticsDailyReserve,readPersonalAnalyticsAllTime,upgradePersonalAnalyticsTopItems} from './personal-analytics.js';

// The opt-in layout keeps immutable observations separate from the latest
// operational checkpoint. Payload identity includes every source field; it
// must never erase a contradictory variant or a filtered listing query.
export const NORMALIZED_RECORD_KINDS = Object.freeze(['listing','history','metadata','ownership','collection','attribute','owned_price','owned_status','personal_gift']);
export const RESET_EVIDENCE_KINDS = Object.freeze(['listing','history','owned_price','owned_status','personal_gift']);
// An optional, rebuildable selector avoids paging marker-only events twice.
// Keep the classifier identical to the marker exclusion in the reader: a
// present (even null) marker is disposable only for known kinds without record.
export function inlineRecordEventSelect(table,alias='e') {
  if(!['cloud_events','public_cloud_events'].includes(table)||!['e','NEW'].includes(alias))throw new Error('Invalid inline record index source');
  const publicScope=table==='public_cloud_events',source=`${alias}.records_json`,scope=publicScope?`'public:'||${alias}.user_id`:"'private'",
    generation=publicScope?`COALESCE((SELECT generation FROM public_accounts WHERE user_id=${alias}.user_id),-1)`:'0',
    marker=`CASE WHEN j.type='object' THEN COALESCE(json_type(j.value,'$.__normalized_record_v1') IS NOT NULL
      AND json_type(j.value,'$.record') IS NULL AND json_extract(j.value,'$.kind') IN(${NORMALIZED_RECORD_KINDS.map(kind=>`'${kind}'`).join(',')}),0) ELSE 0 END`,
    test=predicate=>`CASE WHEN json_valid(${source}) THEN CASE WHEN json_type(${source})='array'
      THEN EXISTS(SELECT 1 FROM json_each(${source}) j WHERE ${predicate}) ELSE 1 END ELSE 1 END`,
    inline=test(`NOT(${marker})`),seed=test("CASE WHEN j.type='object' THEN json_extract(j.value,'$.kind') IN('settings','portfolio','gift') ELSE 0 END");
  return {scope,generation,inline,seed,select:`SELECT json_array(${scope},${generation},${alias}.sequence),${scope},${generation},${alias}.sequence,${seed}`};
}
export function inlineRecordIndexDefinitions() {
  const triggers=['cloud_events','public_cloud_events'].flatMap(table=>['insert','update','delete'].map(operation=>{
    const name=`record_inline_index_v1_${table}_${operation}`,source=inlineRecordEventSelect(table,'NEW'),
      oldScope=table==='public_cloud_events'?"'public:'||OLD.user_id":"'private'",
      cleanup=`DELETE FROM service_record_inline_events WHERE scope=${oldScope} AND sequence=OLD.sequence;`,
      write=`INSERT INTO service_record_inline_events(row_id,scope,generation,sequence,has_seed)
      ${source.select} WHERE ${source.inline}
      ON CONFLICT(row_id) DO UPDATE SET has_seed=excluded.has_seed;`;
    return {type:'trigger',name,table,sql:`CREATE TRIGGER ${name} AFTER ${operation==='insert'?'INSERT':operation==='delete'?'DELETE':`UPDATE OF records_json,sequence${table==='public_cloud_events'?',user_id':''}`} ON ${table} BEGIN
      ${operation==='insert'?'':cleanup}
      ${operation==='delete'?'':write}
      END`};
  }));
  return [...triggers,...[['record_inline_events_v1_idx',''],['record_seed_events_v1_idx',' WHERE has_seed=1']].map(([name,condition])=>({type:'index',name,table:'service_record_inline_events',
    sql:`CREATE INDEX ${name} ON service_record_inline_events(scope,generation,sequence)${condition}`}))];
}
async function inlineRecordIndexReady(get,publicScope) {
  const definitions=inlineRecordIndexDefinitions(),parameters={},clauses=definitions.map((entry,index)=>{
    for(const key of ['name','type','sql'])parameters[`:${key}${index}`]=entry[key];
    return `(name=:name${index} AND type=:type${index} AND sql=:sql${index})`;
  });
  // Indexes are the final installation step, after the backfill and all six
  // mutation triggers. A missing/changed definition always uses the old path.
  try{return (await get(`SELECT count(*) AS ready FROM sqlite_master WHERE (${clauses.join(' OR ')})${publicScope?' AND :tenant IS NOT NULL AND :account_generation>=0':''}`,parameters))?.ready===definitions.length;}
  catch{return false;}
}
export const NORMALIZED_RECORD_TRIGGER_NAMES = Object.freeze(['normalized_records_v1_private_insert','normalized_records_v1_public_insert']);
export const NORMALIZED_RECORD_READY_SQL = `(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN(${NORMALIZED_RECORD_TRIGGER_NAMES.map(name=>`'${name}'`).join(',')}))=2`;
export function compactStorageGuard(table,where='1') {
  const head=`SELECT state_json FROM ${table} WHERE ${where} ORDER BY sequence DESC LIMIT 1`;
  return `(:compact_mode=0 OR (${COMPACT_OPERATIONAL_READY_SQL}) AND (${NORMALIZED_RECORD_READY_SQL})
    AND :record_floor BETWEEN 0 AND :sequence)
    AND (COALESCE(json_extract((${head}),'$.operational_storage_version'),0)<>1 OR :compact_mode=1
      AND :record_floor>=COALESCE(json_extract((${head}),'$.record_storage_floor'),0))`;
}
export function compactStorageParameters(state) {
  const compact=usesCompactOperationalStorage(state),floor=state?.record_storage_floor??0;
  if(compact&&(!Number.isSafeInteger(floor)||floor<0))throw new Error('Invalid saved record boundary');
  return {':compact_mode':compact?1:0,':record_floor':compact?floor:0};
}
export function normalizedRecordOverhead(records,eventKey,compact) {
  return compact?(records||[]).filter(value=>NORMALIZED_RECORD_KINDS.includes(value?.kind)&&Object.hasOwn(value,'record')).length*(1024+utf8Size(eventKey||'')):0;
}
// These are the fixed fields copied by the compact operational archive
// trigger. Reserve their complete JSON plus keys, IDs, sessions and watermark;
// large resumable target arrays remain only in the replacement checkpoint.
const CONTROL_OWN_KEYS=['id','state','total','checked','updated','unresolved','status_updated','status_unresolved','reason','started_at','completed_at','scope','nft_address','wallet','session_id'];
const CONTROL_GIFT_KEYS=[...CONTROL_OWN_KEYS,'scope_signature','check_started_at','provider','cache_hit','fallback_reason','deadline','stage','next_allowed_at'];
export async function compactControlRetirement(get,{table,where='1',expected,event,stateJson,bytes,publicScope=false}) {
  let archives=4096;
  for(const [group,keys] of [[event.state?.owned_prices,CONTROL_OWN_KEYS],...(publicScope?[]:[[event.state?.gift_refresh,CONTROL_GIFT_KEYS]])]) {
    for(const run of [group?.previous_run,group?.run])if(run&&typeof run==='object')
      archives+=utf8Size(JSON.stringify(Object.fromEntries(keys.filter(key=>Object.hasOwn(run,key)).map(key=>[key,run[key]]))));
  }
  const sql=`COALESCE((SELECT MAX(0,length(CAST(state_json AS BLOB))-2)
    +CASE WHEN job_id=:control_job_id THEN COALESCE(length(CAST(job_json AS BLOB)),0) ELSE 0 END
    FROM ${table} WHERE ${where} AND sequence=:expected AND json_extract(state_json,'$.operational_storage_version')=1),0)`;
  const parameters={':expected':expected,':control_job_id':event.job?event.job.id??null:null};
  const previous=await get(`SELECT ${sql} AS bytes`,parameters);
  if(!Number.isSafeInteger(previous?.bytes)||previous.bytes<=0)return null;
  // Replace the ordinary conservative archive allowance with the bounded
  // summary allowance, then credit only bytes this exact INSERT retires.
  const net=Math.max(0,bytes-utf8Size(stateJson)-4096+archives-previous.bytes);
  if(net>262144)return null;
  return {bytes:net,sql:`${sql}=:control_retirement_bytes`,parameters:{':control_job_id':parameters[':control_job_id'],':control_retirement_bytes':previous.bytes}};
}
export function preparedRecordJSON(records, compact) {
  const values=JSON.parse(JSON.stringify(records||[]));
  if(!compact)return JSON.stringify(values);
  return JSON.stringify(values.map(value=>{
    // All input envelopes are wrapped, including protected kinds, so an
    // imported unknown field can never impersonate our internal write tag.
    if(!NORMALIZED_RECORD_KINDS.includes(value?.kind)||!Object.hasOwn(value,'record'))return {__normalized_inline_v1:value};
    const document=canonicalJSON({kind:value.kind,record:value.record}),envelope={...value};delete envelope.kind;delete envelope.record;
    const hash=Array.from(sha256(utf8Bytes(document)),byte=>byte.toString(16).padStart(2,'0')).join('');
    return {kind:value.kind,__normalized_write_v1:{hash,document:JSON.parse(document),envelope}};
  }));
}
export function normalizedRecordScope(userId=null) {return userId===null?'private':`public:${userId}`;}
export function normalizedRecordPrefix(scope,generation=0) {return `${scope}:g${generation}:`;}
export function decodeNormalizedRecord(row) {
  if(row.envelope_json===null)return JSON.parse(row.document);
  const document=JSON.parse(row.document),envelope=JSON.parse(row.envelope_json);
  if(!document||typeof document!=='object'||!NORMALIZED_RECORD_KINDS.includes(document.kind)||!Object.hasOwn(document,'record')
    ||!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw new Error('Invalid normalized record');
  return {...envelope,...document};
}
// Both repositories supply account-fenced adapters. Each page is bounded by
// rows and serialized bytes before crossing the host boundary, and contains
// the original event order. SQL never parses source_json or nested evidence.
export async function visitCompactRecordPages({get,all,table,where='1',parameters={},scope,generation=0,until,floor=0,visitor,selection='all',filter=null}) {
  if(!['cloud_events','public_cloud_events'].includes(table)||!Number.isSafeInteger(floor)||floor<0||floor>until)throw new Error('Saved records changed; reload saved data');
  if(filter&&typeof filter.matches!=='function')throw new Error('Invalid compact record filter');
  const prefix=normalizedRecordPrefix(scope,generation),indexed=await inlineRecordIndexReady(get,table==='public_cloud_events'),seeds=selection!=='all';
  const inlineQuery=`
      SELECT e.sequence,CAST(j.key AS INTEGER) AS ordinal,j.value AS document,NULL AS envelope_json
      FROM ${indexed?`service_record_inline_events i INDEXED BY ${seeds?'record_seed_events_v1_idx':'record_inline_events_v1_idx'}
      CROSS JOIN ${table} e ON e.sequence=i.sequence CROSS JOIN json_each(e.records_json) j`:`${table} e,json_each(e.records_json) j`}
      WHERE ${where} AND e.sequence>=:record_after AND e.sequence<=:record_until AND e.records_json<>'[]'
      ${indexed?`AND i.scope=:inline_scope AND i.generation=:inline_generation AND i.sequence>=:record_after AND i.sequence<=:record_until${seeds?' AND i.has_seed=1':''}`:''}
      AND (e.sequence>:record_after OR e.sequence=:record_after AND CAST(j.key AS INTEGER)>:record_ordinal)
      ORDER BY e.sequence,CAST(j.key AS INTEGER) LIMIT 800`;
  const observationQuery=`
      SELECT o.sequence,o.ordinal,p.document,o.envelope_json FROM service_record_occurrences o
      JOIN service_record_payloads p ON p.payload_id=o.payload_id AND p.scope=o.scope
      WHERE o.scope=:record_scope AND o.occurrence_id LIKE :record_prefix
      AND o.sequence>=:record_after AND o.sequence<=:record_until
      AND (o.sequence>:record_after OR o.sequence=:record_after AND o.ordinal>:record_ordinal)
      AND EXISTS(SELECT 1 FROM ${table} e WHERE e.sequence=o.sequence AND ${where})
      ORDER BY o.sequence,o.ordinal LIMIT 800`;
  const streams=[{query:inlineQuery,normalized:false,sequence:-1,ordinal:-1,rows:[],offset:0,done:false},
    {query:observationQuery,normalized:true,sequence:-1,ordinal:-1,rows:[],offset:0,done:selection!=='all'}];
  async function fill(stream) {
    if(stream.done||stream.offset<stream.rows.length)return;
    const args={...parameters,':record_until':until,':record_after':stream.sequence,':record_ordinal':stream.ordinal};
    if(stream.normalized)Object.assign(args,{':record_scope':scope,':record_prefix':prefix+'%'});
    else if(indexed)Object.assign(args,{':inline_scope':scope,':inline_generation':generation});
    const rows=await all(`WITH candidates AS (${stream.query}),
      pending AS (SELECT *,length(CAST(document AS BLOB))+COALESCE(length(CAST(envelope_json AS BLOB)),0) AS bytes FROM candidates), bounded AS (
      SELECT *,SUM(bytes) OVER(ORDER BY sequence,ordinal) AS total_bytes FROM pending
    ) SELECT sequence,ordinal,document,envelope_json,bytes FROM bounded
      WHERE total_bytes<=1048576 OR (sequence=(SELECT sequence FROM pending LIMIT 1) AND ordinal=(SELECT ordinal FROM pending LIMIT 1))
      ORDER BY sequence,ordinal`,args);
    stream.rows=rows;stream.offset=0;stream.done=!rows.length;
    if(rows.length){stream.sequence=rows[rows.length-1].sequence;stream.ordinal=rows[rows.length-1].ordinal;}
  }
  // Independent cursors avoid rescanning all remaining inline marker events
  // for each observation page. The merge retains exact event/record ordering.
  let batch=[],bytes=0;
  for(;;) {
    for(const stream of streams)await fill(stream);
    const ready=streams.filter(stream=>!stream.done);
    if(!ready.length)break;
    const stream=ready.length===1?ready[0]:ready.reduce((first,next)=>{
      const a=first.rows[first.offset],b=next.rows[next.offset];
      return b.sequence<a.sequence||b.sequence===a.sequence&&b.ordinal<a.ordinal?next:first;
    });
    const row=stream.rows[stream.offset++];
    const record=decodeNormalizedRecord(row);
    // Page raw inline entries as well as normalized observations. Filtering
    // sparse seeds or markers before LIMIT scanned the complete remaining
    // history on the final empty page and hit the hosted query budget.
    if(!stream.normalized&&record&&typeof record==='object'&&Object.hasOwn(record,'__normalized_record_v1')&&!Object.hasOwn(record,'record')&&NORMALIZED_RECORD_KINDS.includes(record.kind))continue;
    if(row.sequence<floor&&RESET_EVIDENCE_KINDS.includes(record?.kind))continue;
    if(selection==='seeds'&&!['settings','portfolio','gift'].includes(record?.kind)||selection==='settings'&&record?.kind!=='settings')continue;
    // Advance the raw stream even when no candidate matches. A selective
    // filter in the SQL WHERE clause can inspect the entire rental history
    // before reaching LIMIT, exceeding the hosted query execution budget.
    if(filter&&!filter.matches(record))continue;
    if(batch.length&&(bytes+row.bytes>1048576||batch.length>=800)){await visitor(batch);batch=[];bytes=0;}
    batch.push(record);bytes+=row.bytes;
  }
  if(batch.length)await visitor(batch);
  // A reset during the traversal invalidates this captured snapshot. Public
  // adapters also re-check account generation after an empty page.
  const current=await get(`SELECT COALESCE(json_extract(state_json,'$.record_storage_floor'),0) AS floor FROM ${table} e WHERE ${where} ORDER BY sequence DESC LIMIT 1`,parameters);
  if(!current||current.floor!==floor)throw new Error('Saved records changed; reload saved data');
}
export async function normalizedEventRecords(all,row,{scope,generation=0,parameters={},where='1'}={}) {
  if(!row)return null;
  const records=JSON.parse(row.records_json);
  if(!records.some(value=>Number.isSafeInteger(value?.__normalized_record_v1)&&NORMALIZED_RECORD_KINDS.includes(value.kind)&&!Object.hasOwn(value,'record')))return records;
  const byOrdinal=new Map();let after=-1;
  for(;;) {
    const rows=await all(`WITH pending AS (SELECT o.ordinal,p.document,o.envelope_json,
      length(CAST(p.document AS BLOB))+length(CAST(o.envelope_json AS BLOB)) AS bytes FROM service_record_occurrences o
      JOIN service_record_payloads p ON p.payload_id=o.payload_id AND p.scope=o.scope
      WHERE o.scope=:record_scope AND o.sequence=:record_sequence AND o.occurrence_id LIKE :record_prefix
      AND o.ordinal>:record_ordinal AND ${where} ORDER BY o.ordinal LIMIT 100),
      bounded AS (SELECT *,SUM(bytes) OVER(ORDER BY ordinal) AS total_bytes FROM pending)
      SELECT ordinal,document,envelope_json FROM bounded WHERE total_bytes<=393216 OR ordinal=(SELECT MIN(ordinal) FROM pending) ORDER BY ordinal`,
      {...parameters,':record_scope':scope,':record_sequence':row.sequence,':record_prefix':normalizedRecordPrefix(scope,generation)+'%',':record_ordinal':after});
    if(!rows.length)break;
    for(const value of rows)byOrdinal.set(value.ordinal,decodeNormalizedRecord(value));
    after=rows[rows.length-1].ordinal;
  }
  return records.map((value,index)=>{
    if(!Number.isSafeInteger(value?.__normalized_record_v1)||!NORMALIZED_RECORD_KINDS.includes(value.kind)||Object.hasOwn(value,'record'))return value;
    const result=byOrdinal.get(index);if(!result||value.__normalized_record_v1!==index||result.kind!==value.kind)throw new Error('Normalized record unavailable');return result;
  });
}
const initial = () => ({version: 2, next_job_id: 1, job: null, attempts: [], next_allowed_at: 0});
export class CloudStorageFullError extends Error {
  constructor() {super('Private storage is full. Saved data and progress are retained. Storage maintenance is needed before updating.');}
}

export function createCloudRepository(db, {dashboardCache = false, credentialFence = null, storageAdmission = null} = {}) {
  if(credentialFence!==null&&(!credentialFence||typeof credentialFence.row_id!=='string'||!/^private-owner-marketapp:[1-9]\d{0,15}$/.test(credentialFence.row_id)
    ||typeof credentialFence.user_id!=='string'||credentialFence.row_id!==`private-owner-marketapp:${credentialFence.user_id}`
    ||!Number.isSafeInteger(credentialFence.credential_version)||credentialFence.credential_version<0))throw new Error('Invalid private credential fence');
  const credentialGuard=credentialFence===null?'':`AND COALESCE((SELECT credential_version FROM private_provider_credentials
    WHERE row_id=:credential_row AND user_id=:credential_owner AND provider='marketapp'),0)=:credential_version`;
  const credentialParameters=credentialFence===null?{}:{':credential_row':credentialFence.row_id,':credential_owner':credentialFence.user_id,':credential_version':credentialFence.credential_version};
  function credentialJob(job) {
    if(!job||credentialFence===null||!['queued','running','partial'].includes(job.state))return job;
    const version=Object.hasOwn(job,'private_credential_version')?job.private_credential_version:0;
    return version===credentialFence.credential_version?job:{...job,state:'failed',reason:'credential_changed',lease:null,lease_until:0};
  }
  const checkpoints = createCheckpointStorage(db);
  // Hints come only from a successfully decoded read or our successful append.
  // Every reuse does a guarded primary-key read and exact content comparison;
  // changed/new state falls back to the historical source lookup.
  let sourceHints = null;
  let readSaved;
  async function checkpointSources(expected, state) {
    if(usesCompactOperationalStorage(state))return {targetSource:null,ownedSource:null,giftSource:null,budgetSource:null};
    const hints = sourceHints?.revision === expected ? sourceHints : null;
    const targetSource = await checkpoints.findOwnedTargetSource(state?.owned_prices?.run, expected + 1, hints?.target ?? null);
    const ownedSource = await checkpoints.findOwnedStateSource(state?.owned_prices, expected + 1, targetSource, hints?.owned ?? null);
    const giftSource = await checkpoints.findGiftStateSource(state?.gift_refresh, expected + 1, hints?.gift ?? null);
    const budgetSource = await checkpoints.findBudgetResetSource(state?.marketapp_budget_reset, expected + 1, hints?.budget ?? null);
    return {targetSource, ownedSource, giftSource, budgetSource};
  }
  function rememberSources(revision, targetSource, ownedSource, giftSource, budgetSource) {
    sourceHints = {revision, target: targetSource?.sequence ?? revision, owned: ownedSource?.sequence ?? revision, gift: giftSource?.sequence ?? revision, budget: budgetSource?.sequence ?? revision};
  }
  async function appendWithCacheRecovery(insert, parameters) {
    try {return await db.run(insert, parameters);}
    catch (error) {
      if (!/database or disk is full/i.test(String(error?.message || ''))) throw error;
      // Only derived dashboard projections are disposable. Retry the already
      // captured INSERT once, so every CAS, source, wallet and session fence
      // is reevaluated by SQL without another provider request or new values.
      let evicted;
      try {evicted = await db.run('DELETE FROM dashboard_projection_cache');}
      catch {throw new CloudStorageFullError();}
      if (!Number.isSafeInteger(evicted?.rowsAffected) || evicted.rowsAffected <= 0) throw new CloudStorageFullError();
      try {return await db.run(insert, parameters);}
      catch (retryError) {
        if (/database or disk is full/i.test(String(retryError?.message || ''))) throw new CloudStorageFullError();
        throw retryError;
      }
    }
  }
  // Compact records_json is produced exclusively by JSON.stringify. A textual
  // false positive only invalidates a login conservatively; it cannot approve
  // a wallet change. The revision fences old→new→old wallet transitions too.
  const walletRevision = "COALESCE((SELECT MAX(sequence) FROM cloud_events WHERE records_json LIKE '%\"kind\":\"settings\"%'),0)";
  async function visitRecordPages(until, visitor, seedsOnly = false, filter = null) {
    if (!Number.isSafeInteger(until) || until < 0 || typeof visitor !== 'function') throw new Error('Invalid record traversal');
    const context=await db.get("SELECT json_extract(state_json,'$.operational_storage_version') AS mode,COALESCE(json_extract(state_json,'$.record_storage_floor'),0) AS floor FROM cloud_events ORDER BY sequence DESC LIMIT 1");
    if(context?.mode===1)return await visitCompactRecordPages({get:(...args)=>db.get(...args),all:(...args)=>db.all(...args),table:'cloud_events',
      scope:'private',until,floor:context.floor,visitor,selection:seedsOnly?'seeds':'all',filter});
    let after = 0;
    for (;;) {
      // Batch small events to avoid hundreds of host round trips, keeping the
      // existing byte ceiling. A legacy oversized row still advances alone,
      // and visitors retain only needed evidence.
      const rows = await db.all(`WITH pending AS (
        SELECT sequence,records_json,length(CAST(records_json AS BLOB)) AS bytes
        FROM cloud_events WHERE sequence>:after AND sequence<=:until AND records_json<>'[]'
          AND (:seeds=0 OR records_json LIKE '%"portfolio"%' OR records_json LIKE '%"gift"%' OR records_json LIKE '%"settings"%')
          AND ${filter?.sql??'1'}
          ORDER BY sequence LIMIT 16
      ), bounded AS (
        SELECT sequence,records_json,SUM(bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending
      ) SELECT sequence,records_json FROM bounded
        WHERE total_bytes<=1048576 OR sequence=(SELECT MIN(sequence) FROM pending)
        ORDER BY sequence`, {':after': after, ':until': until, ':seeds': seedsOnly ? 1 : 0,...filter?.parameters});
      if (!rows.length) {
        const latest=await db.get("SELECT COALESCE(json_extract(state_json,'$.record_storage_floor'),0) AS floor FROM cloud_events ORDER BY sequence DESC LIMIT 1");
        if((latest?.floor??0)!==(context?.floor??0))throw new Error('Saved records changed; reload saved data');
        return;
      }
      for (const row of rows) {
        const parsed = JSON.parse(row.records_json);
        await visitor(seedsOnly ? parsed.filter(value => ['portfolio', 'gift', 'settings'].includes(value?.kind)) : parsed);
      }
      after = rows[rows.length - 1].sequence;
    }
  }
  return {
    ...(storageAdmission?{reserveStorage:storageAdmission.reserveStorage,releaseStorage:storageAdmission.releaseStorage}:{}),
    ...createMarketappWebsiteGate(db),
    ...createGiftRefreshStorage(db),
    ...createOwnedRefreshArchive(db),
    ...checkpoints,
    ...(dashboardCache ? createDashboardCache(db,{storageAdmission}) : {}),
    async clock() {
      // V8 wall time may be held constant until a host call. SQLite evaluates
      // 'now' for this statement; preserve its millisecond precision so a
      // relative Retry-After cannot be shortened by rounding to whole seconds.
      const row = await db.get("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS server_time");
      if (!Number.isSafeInteger(row?.server_time) || row.server_time <= 0 || row.server_time > 8640000000000000) throw new Error('Server clock unavailable');
      return row.server_time;
    },
    read:readSaved=async function() {
      const row = await db.get('SELECT sequence,state_json,job_id,job_json FROM cloud_events ORDER BY sequence DESC LIMIT 1');
      if (row) {
        const saved = JSON.parse(row.state_json), marker = saved?.__checkpoint_job_sequence;
        const source = Number.isSafeInteger(marker) && marker > 0 && marker < row.sequence
          ? await db.get('SELECT sequence,job_id,job_json FROM cloud_events WHERE sequence=:sequence', {':sequence': marker}) : row;
        const ownedMarker = saved?.__checkpoint_owned_state_sequence;
        const ownedSource = Number.isSafeInteger(ownedMarker) && ownedMarker > 0 && ownedMarker < row.sequence
          ? await checkpoints.ownedStateSource(ownedMarker) : null;
        const targetMarker = Object.hasOwn(saved, '__checkpoint_owned_state_sequence')
          ? ownedSource?.target_sequence : saved?.__checkpoint_owned_targets_sequence;
        const targetSource = Number.isSafeInteger(targetMarker) && targetMarker > 0 && targetMarker < (ownedSource?.sequence ?? row.sequence)
          ? await checkpoints.ownedTargetSource(targetMarker) : null;
        const giftMarker = saved?.__checkpoint_gift_state_sequence;
        const giftSource = Number.isSafeInteger(giftMarker) && giftMarker > 0 && giftMarker < row.sequence
          ? await checkpoints.giftStateSource(giftMarker) : null;
        const budgetMarker = saved?.__checkpoint_budget_reset_sequence;
        const budgetSource = Number.isSafeInteger(budgetMarker) && budgetMarker > 0 && budgetMarker < row.sequence
          ? await checkpoints.budgetResetSource(budgetMarker) : null;
        const state = decodeCheckpoint(row, source, targetSource, ownedSource, giftSource, budgetSource);
        if(credentialFence!==null&&state.job)state.job=credentialJob(state.job);
        rememberSources(row.sequence, targetSource, ownedSource, giftSource, budgetSource);
        return {revision: row.sequence, state};
      }
      const state = initial();
      // Do not give a freshly upgraded deployment another daily allowance.
      // Prototype only retained aggregate attempt counts, so conservatively
      // date each attempt at that run's last update rather than invent precision.
      const previous = await db.get('SELECT document FROM collector_state WHERE id=1');
      if (previous) {
        const legacy = JSON.parse(previous.document);
        state.next_allowed_at = Number.isSafeInteger(legacy.provider_next_allowed_at) ? legacy.provider_next_allowed_at : 0;
        for (const run of legacy.runs || []) {
          const count = Number.isSafeInteger(run.attempts) && run.attempts > 0 ? Math.min(run.attempts, 500) : 0;
          const at = Number.isSafeInteger(run.updated_at) && run.updated_at > 0 ? run.updated_at : Date.now();
          for (let i = 0; i < count; i++) state.attempts.push(at);
        }
        state.attempts.sort((a, b) => a - b);
      }
      else if(await db.get(`SELECT 1 AS ready WHERE (${COMPACT_OPERATIONAL_READY_SQL}) AND (${NORMALIZED_RECORD_READY_SQL})`)) {
        state.operational_storage_version=1;state.record_storage_floor=0;
      }
      sourceHints = null;
      return {revision: 0, state};
    },
    async append(expected, event, walletFence = null) {
      if(walletFence!==null&&(!Number.isSafeInteger(walletFence)||walletFence<0))return false;
      const compact=usesCompactOperationalStorage(event.state);
      if(compact&&!event.job&&Number.isSafeInteger(event.state?.job?.id))event={...event,job:event.state.job};
      if(credentialFence!==null&&Number.isSafeInteger(event.state?.job?.id)) {
        const savedVersion=event.state.job.private_credential_version;
        const active=['queued','running','partial'].includes(event.state.job.state);
        if(active&&savedVersion!==undefined&&savedVersion!==credentialFence.credential_version)return false;
        const job=active?{...event.state.job,private_credential_version:credentialFence.credential_version}:event.state.job;
        event={...event,state:{...event.state,job},...(event.job?{job}:{})};
      }
      let prior = null;
      if (!compact && !event.job && Number.isSafeInteger(event.state?.job?.id) && event.state.job.id > 0) {
        prior = await db.get(`SELECT sequence,job_id,job_json FROM cloud_events
          WHERE sequence<=:expected AND job_id=:id AND job_json=:job ORDER BY sequence DESC LIMIT 1`,
          {':expected': expected, ':id': event.state.job.id, ':job': JSON.stringify(event.state.job)});
      }
      const {targetSource, ownedSource, giftSource, budgetSource} = await checkpointSources(expected, event.state);
      const stateJson=encodeCheckpoint(event.state,event.job,expected+1,prior,targetSource,ownedSource,giftSource,budgetSource),
        jobJson=event.job?JSON.stringify(event.job):null,recordsJson=preparedRecordJSON(event.records,compact),raw=null;
      // Validated observations and checkpoint state are sufficient to rebuild
      // the dashboard. Provider bodies often repeat those rows plus large TON
      // BOCs, so never retain a second copy. Keep the original evidence flag
      // below: discarding it must not turn a provider result into a control.
      let bytes=utf8Size(stateJson)+utf8Size(jobJson??'')+utf8Size(recordsJson)+utf8Size(raw??'')
        +utf8Size(String(expected+1))+utf8Size(event.key)+utf8Size(String(event.job?.id??''))+utf8Size(event.observed_at)
        +1024+normalizedRecordOverhead(event.records,event.key,compact)+(compact?utf8Size(stateJson)+4096:0);
      let control=!event.raw_body&&!(event.records||[]).length&&(compact||bytes<=262144)&&(
        event.state?.job?.state==='partial'&&event.state.job.reason==='stopped_by_you'
        ||event.state?.job?.state==='failed'&&event.state.job.reason==='credential_removed'
        ||event.state?.owned_prices?.run?.state==='partial'&&event.state.owned_prices.run.reason==='stopped_by_you'
        ||event.state?.gift_refresh?.run?.state==='partial'&&event.state.gift_refresh.run.reason==='stopped_by_you');
      if(control&&storageAdmission) {
        const before=await readSaved(),previous=before.state;
        control=before.revision===expected&&Boolean(
          event.state.job?.state==='partial'&&event.state.job.reason==='stopped_by_you'&&previous.job?.id===event.state.job.id&&['running','queued'].includes(previous.job.state)
          ||event.state.job?.state==='failed'&&event.state.job.reason==='credential_removed'&&previous.job?.id===event.state.job.id&&['running','queued','partial'].includes(previous.job.state)
          ||event.state.owned_prices?.run?.reason==='stopped_by_you'&&previous.owned_prices?.run?.id===event.state.owned_prices.run.id&&previous.owned_prices.run.state==='running'
          ||event.state.gift_refresh?.run?.reason==='stopped_by_you'&&previous.gift_refresh?.run?.id===event.state.gift_refresh.run.id&&previous.gift_refresh.run.state==='running');
      }
      let retirement={sql:'1',parameters:{}};
      if(compact&&control&&storageAdmission) {
        const credited=await compactControlRetirement((...args)=>db.get(...args),{table:'cloud_events',expected,event,stateJson,bytes});
        if(credited){retirement=credited;bytes=credited.bytes;}else control=false;
      }
      const admission=storageAdmission?.fence(bytes,event.storage_token??null,{control})??{sql:'1',parameters:{}};
      const insert = `INSERT OR IGNORE INTO cloud_events
        (sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at)
        SELECT :sequence,:key,:state,:job_id,:job,:records,:raw,:observed
        WHERE COALESCE((SELECT MAX(sequence) FROM cloud_events),0)=:expected
        AND NOT EXISTS (SELECT 1 FROM cloud_events WHERE event_key=:key)
        AND (:wallet_fence IS NULL OR ${walletRevision}=:wallet_fence)
        AND ${compactStorageGuard('cloud_events')}
        AND ${retirement.sql}
        AND ${OWNED_SOURCE_FENCE} AND ${OWNED_TARGET_SOURCE_FENCE} AND ${GIFT_SOURCE_FENCE} AND ${BUDGET_RESET_SOURCE_FENCE} ${credentialGuard}
        AND ${admission.sql}`;
      const parameters = {
        ':sequence': expected + 1, ':expected': expected, ':key': event.key,
        ':state':stateJson, ':job_id': event.job?.id ?? null,
        ':job':jobJson,
        ':records':recordsJson, ':raw':raw,
        ':observed': event.observed_at,
        ...compactStorageParameters(event.state),
        ':wallet_fence': walletFence,
        ':owned_source': ownedSource?.sequence ?? null, ':owned_json': ownedSource?.owned_prices_json ?? null,
        ':owned_target': ownedSource?.target_sequence ?? null,
        ':target_source': targetSource?.sequence ?? null, ':target_id': targetSource?.run_id ?? null,
        ':target_wallet': targetSource?.wallet ?? null, ':targets_json': targetSource?.targets_json ?? null,
        ':gift_source': giftSource?.sequence ?? null, ':gift_json': giftSource?.gift_refresh_json ?? null,
        ':budget_source': budgetSource?.sequence ?? null, ':budget_json': budgetSource?.budget_reset_json ?? null,
        ...credentialParameters,
        ...admission.parameters,
        ...retirement.parameters,
      };
      const result = await appendWithCacheRecovery(insert, parameters);
      if (result.rowsAffected === 1) rememberSources(expected + 1, targetSource, ownedSource, giftSource, budgetSource);
      else if(storageAdmission)await storageAdmission.assertAdmitted(bytes,event.storage_token??null,{control});
      return result.rowsAffected === 1;
    },
    async appendWebsite(expected,event,owner,stored) {
      if(!stored?.value||!stored?.fence||String(stored.value.owner)!==String(owner))return false;
      const observedAt=Date.parse(event.observed_at);
      if(!Number.isSafeInteger(observedAt)||observedAt<=0||typeof event.observed_at!=='string'||new Date(observedAt).toISOString()!==event.observed_at)return false;
      const compact=usesCompactOperationalStorage(event.state);
      if(compact&&!event.job&&Number.isSafeInteger(event.state?.job?.id))event={...event,job:event.state.job};
      let prior=null;
      if(!compact&&!event.job&&Number.isSafeInteger(event.state?.job?.id)&&event.state.job.id>0)prior=await db.get(`SELECT sequence,job_id,job_json FROM cloud_events
        WHERE sequence<=:expected AND job_id=:id AND job_json=:job ORDER BY sequence DESC LIMIT 1`,
        {':expected':expected,':id':event.state.job.id,':job':JSON.stringify(event.state.job)});
      const {targetSource,ownedSource,giftSource,budgetSource}=await checkpointSources(expected,event.state);
      const stateJson=encodeCheckpoint(event.state,event.job,expected+1,prior,targetSource,ownedSource,giftSource,budgetSource),
        jobJson=event.job?JSON.stringify(event.job):null,recordsJson=preparedRecordJSON(event.records,compact),raw=null;
      const bytes=utf8Size(stateJson)+utf8Size(jobJson??'')+utf8Size(recordsJson)+utf8Size(raw??'')
        +utf8Size(String(expected+1))+utf8Size(event.key)+utf8Size(String(event.job?.id??''))+utf8Size(event.observed_at)
        +1024+normalizedRecordOverhead(event.records,event.key,compact)+(compact?utf8Size(stateJson)+4096:0);
      const admission=storageAdmission?.fence(bytes,event.storage_token??null)??{sql:'1',parameters:{}};
      const insert=`INSERT OR IGNORE INTO cloud_events
        (sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at)
        SELECT :sequence,:key,:state,:job_id,:job,:records,:raw,:observed
        WHERE COALESCE((SELECT MAX(sequence) FROM cloud_events),0)=:expected
        AND NOT EXISTS(SELECT 1 FROM cloud_events WHERE event_key=:key)
        AND ${compactStorageGuard('cloud_events')}
        AND EXISTS(SELECT 1 FROM marketapp_analytics_sessions WHERE owner_id=:owner AND generation=:generation
          AND wallet=:wallet AND ${walletRevision}=:wallet_revision AND cookie_version=:cookie_version AND ciphertext IS NOT NULL
          AND created_at<=:observation AND expires_at>:observation)
        AND ${OWNED_SOURCE_FENCE} AND ${OWNED_TARGET_SOURCE_FENCE} AND ${GIFT_SOURCE_FENCE} AND ${BUDGET_RESET_SOURCE_FENCE}
        AND ${admission.sql}`;
      const parameters={
        ':sequence':expected+1,':expected':expected,':key':event.key,
        ...compactStorageParameters(event.state),
        ':state':stateJson,':job_id':event.job?.id??null,
        ':job':jobJson,':records':recordsJson,':raw':raw,':observed':event.observed_at,
        ':owner':String(owner),':generation':stored.fence.generation,':wallet':stored.value.wallet,
        ':wallet_revision':stored.fence.wallet_revision,':cookie_version':stored.value.cookie_version,
        ':observation':observedAt,
        ':owned_source':ownedSource?.sequence??null,':owned_json':ownedSource?.owned_prices_json??null,':owned_target':ownedSource?.target_sequence??null,
        ':target_source':targetSource?.sequence??null,':target_id':targetSource?.run_id??null,
        ':target_wallet':targetSource?.wallet??null,':targets_json':targetSource?.targets_json??null,
        ':gift_source':giftSource?.sequence??null,':gift_json':giftSource?.gift_refresh_json??null,
        ':budget_source':budgetSource?.sequence??null,':budget_json':budgetSource?.budget_reset_json??null,
        ...admission.parameters,
      };
      const result=await appendWithCacheRecovery(insert,parameters);
      if(result.rowsAffected===1)rememberSources(expected+1,targetSource,ownedSource,giftSource,budgetSource);
      else if(storageAdmission)await storageAdmission.assertAdmitted(bytes,event.storage_token??null);
      return result.rowsAffected===1;
    },
    async event(key) {
      const row = await db.get('SELECT sequence,records_json FROM cloud_events WHERE event_key=:key LIMIT 1', {':key': key});
      return await normalizedEventRecords((...args)=>db.all(...args),row,{scope:'private'});
    },
    async job(id) {
      const row = await db.get('SELECT job_json FROM cloud_events WHERE job_id=:id AND job_json IS NOT NULL ORDER BY sequence DESC LIMIT 1', {':id': id});
      return row ? credentialJob(JSON.parse(row.job_json)) : null;
    },
    async jobs() {
      const rows = await db.all(`SELECT e.job_json FROM cloud_events e JOIN
        (SELECT job_id,MAX(sequence) AS seq FROM cloud_events WHERE job_id IS NOT NULL AND job_json IS NOT NULL GROUP BY job_id) j
        ON e.sequence=j.seq ORDER BY e.job_id DESC LIMIT 100`);
      return rows.map(row => credentialJob(JSON.parse(row.job_json)));
    },
    async records(until = Number.MAX_SAFE_INTEGER) {
      const result = [];
      await visitRecordPages(until, page => {for (const record of page) result.push(record);});
      return result;
    },
    visitRecords: (until, visitor) => visitRecordPages(until, visitor),
    visitOwnedScopeRecords: (until, identities, visitor) => visitRecordPages(until,visitor,false,ownedScopeRecordFilter(identities)),
    async dashboardSeedRecords(until) {
      const result = [];
      await visitRecordPages(until, page => {for (const record of page) result.push(record);}, true);
      return result;
    },
    async importPersonalAnalytics(snapshot, raw, importedAt, storageToken = null) {
      const normalized=JSON.stringify(snapshot),bytes=utf8Size(raw)+utf8Size(normalized)+utf8Size(snapshot.fingerprint)
        +utf8Size(snapshot.wallet)+utf8Size(snapshot.captured_at)+utf8Size(importedAt)+personalAnalyticsDailyReserve(snapshot),
        admission=storageAdmission?.fence(bytes,storageToken)??{sql:'1',parameters:{}};
      const result = await db.run(`INSERT OR IGNORE INTO personal_rental_analytics
        (fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json)
        SELECT :fingerprint,:wallet,:captured,:imported,:raw,:normalized WHERE ${admission.sql}`, {
        ':fingerprint': snapshot.fingerprint, ':wallet': snapshot.wallet,
        ':captured': snapshot.captured_at, ':imported': importedAt,
        ':raw': raw, ':normalized':normalized,...admission.parameters,
      });
      if(result.rowsAffected!==1&&storageAdmission) {
        const duplicate=await db.get('SELECT 1 AS valid FROM personal_rental_analytics WHERE fingerprint=:fingerprint', {':fingerprint':snapshot.fingerprint});
        if(!duplicate)await storageAdmission.assertAdmitted(bytes,storageToken);
      }
      return result.rowsAffected === 1;
    },
    async marketappSession(owner) {
      return await db.get(`SELECT owner_id,generation,nonce_counter,cookie_version,wallet,wallet_revision,ciphertext,created_at,expires_at
        FROM marketapp_analytics_sessions WHERE owner_id=:owner`, {':owner': owner});
    },
    async giftScopeRevision() {
      const row=await db.get(`SELECT COALESCE(MAX(sequence),0) AS revision FROM cloud_events WHERE
        records_json LIKE '%"kind":"settings"%' OR records_json LIKE '%"kind":"portfolio"%' OR records_json LIKE '%"kind":"metadata"%'
        OR records_json LIKE '%"kind":"ownership"%' OR records_json LIKE '%"kind":"listing"%' OR records_json LIKE '%"kind":"history"%'
        OR records_json LIKE '%"kind":"development_reset"%'`);
      if(!Number.isSafeInteger(row?.revision)||row.revision<0)throw new Error('Gift scope revision unavailable');return row.revision;
    },
    async marketappSessionFence(owner) {
      await db.run(`INSERT OR IGNORE INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version)
        VALUES(:owner,0,0,0)`, {':owner': owner});
      return await db.get(`SELECT generation,cookie_version,${walletRevision} AS wallet_revision
        FROM marketapp_analytics_sessions WHERE owner_id=:owner`, {':owner': owner});
    },
    async marketappSessionIsCurrent(owner, fence, cookieVersion = null) {
      const row = await db.get(`SELECT 1 AS valid FROM marketapp_analytics_sessions WHERE owner_id=:owner
        AND generation=:generation AND ${walletRevision}=:wallet_revision
        AND (:cookie_version IS NULL OR cookie_version=:cookie_version)`, {':owner': owner, ':generation': fence.generation,
        ':wallet_revision': fence.wallet_revision, ':cookie_version': cookieVersion});
      return row?.valid === 1;
    },
    async reserveMarketappSessionNonce(owner, generation) {
      for (let attempt = 0; attempt < 16; attempt++) {
        const row = await db.get('SELECT nonce_counter FROM marketapp_analytics_sessions WHERE owner_id=:owner AND generation=:generation',
          {':owner': owner, ':generation': generation});
        if (!Number.isSafeInteger(row?.nonce_counter) || row.nonce_counter < 0 || row.nonce_counter >= Number.MAX_SAFE_INTEGER) return null;
        const next = row.nonce_counter + 1;
        const result = await db.run(`UPDATE marketapp_analytics_sessions SET nonce_counter=:next
          WHERE owner_id=:owner AND generation=:generation AND nonce_counter=:previous`,
          {':owner': owner, ':generation': generation, ':previous': row.nonce_counter, ':next': next});
        if (result.rowsAffected === 1) return next;
      }
      return null;
    },
    async storeMarketappSession(owner, fence, session, expectedVersion) {
      const result = await db.run(`UPDATE marketapp_analytics_sessions SET wallet=:wallet,wallet_revision=:wallet_revision,
        ciphertext=:ciphertext,created_at=:created,expires_at=:expires,cookie_version=:version
        WHERE owner_id=:owner AND generation=:generation AND cookie_version=:previous
        AND nonce_counter>=:version AND :version>:previous AND ${walletRevision}=:wallet_revision`, {
        ':owner': owner, ':generation': fence.generation, ':wallet_revision': fence.wallet_revision, ':previous': expectedVersion,
        ':wallet': session.wallet, ':ciphertext': session.ciphertext, ':created': session.created_at,
        ':expires': session.expires_at, ':version': session.cookie_version,
      });
      return result.rowsAffected === 1;
    },
    async clearMarketappSession(owner, fence = null, cookieVersion = null) {
      await db.run(`INSERT OR IGNORE INTO marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version)
        VALUES(:owner,0,0,0)`, {':owner': owner});
      const result = await db.run(`UPDATE marketapp_analytics_sessions SET generation=generation+1,wallet=NULL,wallet_revision=NULL,
        ciphertext=NULL,created_at=NULL,expires_at=NULL
        WHERE owner_id=:owner AND generation<:maximum AND (:generation IS NULL OR generation=:generation)
          AND (:version IS NULL OR cookie_version=:version)`, {':owner': owner, ':generation': fence?.generation ?? null,
        ':version': cookieVersion, ':maximum': Number.MAX_SAFE_INTEGER});
      return result.rowsAffected === 1;
    },
    async importPersonalAnalyticsFenced(snapshot, raw, importedAt, owner, fence, cookieVersion = null, storageToken = null) {
      const normalized=JSON.stringify(snapshot),bytes=utf8Size(raw)+utf8Size(normalized)+utf8Size(snapshot.fingerprint)
        +utf8Size(snapshot.wallet)+utf8Size(snapshot.captured_at)+utf8Size(importedAt)+personalAnalyticsDailyReserve(snapshot),
        admission=storageAdmission?.fence(bytes,storageToken)??{sql:'1',parameters:{}};
      const insert = `INSERT OR IGNORE INTO personal_rental_analytics
        (fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json)
        SELECT :fingerprint,:wallet,:captured,:imported,:raw,:normalized
        WHERE EXISTS(SELECT 1 FROM marketapp_analytics_sessions WHERE owner_id=:owner AND generation=:generation
          AND ${walletRevision}=:wallet_revision AND (:version IS NULL OR cookie_version=:version)) AND ${admission.sql}`;
      const parameters = {
        ':fingerprint': snapshot.fingerprint, ':wallet': snapshot.wallet, ':captured': snapshot.captured_at,
        ':imported': importedAt, ':raw': raw, ':normalized':normalized, ':owner': owner,
        ':generation': fence.generation, ':wallet_revision': fence.wallet_revision, ':version': cookieVersion,
        ...admission.parameters,
      };
      let result;
      try {result = await db.run(insert, parameters);}
      catch (error) {
        if (!/database or disk is full/i.test(String(error?.message || ''))) throw error;
        // Projections are replaceable derivatives. Free only that cache, then
        // retry the identical INSERT once with all logout/wallet/session fences
        // still inside SQL. Never discard source evidence or renew a login.
        let evicted;
        try {evicted = await db.run('DELETE FROM dashboard_projection_cache');} catch {throw error;}
        if (!Number.isSafeInteger(evicted?.rowsAffected) || evicted.rowsAffected <= 0) throw error;
        result = await db.run(insert, parameters);
      }
      if (result.rowsAffected === 1) return true;
      // An identical snapshot already committed is still a successful refresh;
      // a lost logout/wallet fence can never become success through deduplication.
      const row = await db.get(`SELECT 1 AS valid FROM personal_rental_analytics s
        WHERE s.fingerprint=:fingerprint AND s.wallet=:wallet AND EXISTS(SELECT 1 FROM marketapp_analytics_sessions
          WHERE owner_id=:owner AND generation=:generation AND ${walletRevision}=:wallet_revision
          AND (:version IS NULL OR cookie_version=:version))`, {':fingerprint': snapshot.fingerprint, ':wallet': snapshot.wallet,
        ':owner': owner, ':generation': fence.generation, ':wallet_revision': fence.wallet_revision, ':version': cookieVersion});
      if(row?.valid!==1&&storageAdmission)await storageAdmission.assertAdmitted(bytes,storageToken);
      return row?.valid === 1;
    },
    async latestPersonalAnalytics(wallet) {
      const row = await db.get(`SELECT normalized_json,CASE WHEN json_valid(normalized_json) AND (json_type(normalized_json,'$.top_items') IS NULL OR json_type(normalized_json,'$.by_collection') IS NULL)
          AND length(CAST(raw_snapshot AS BLOB))<=262144 THEN raw_snapshot ELSE NULL END AS raw_snapshot FROM personal_rental_analytics
        WHERE wallet=:wallet ORDER BY captured_at DESC,fingerprint DESC LIMIT 1`, {':wallet': wallet});
      return row ? upgradePersonalAnalyticsTopItems(row) : null;
    },
    async analyticsWalletRecords() {
      // Status recovery needs only the saved wallet settings. Avoid returning
      // all portfolio and comparison records on each read-only status check.
      // Every event writes records_json through JSON.stringify. The textual
      // prefilter therefore cannot miss a settings kind; false matches are
      // discarded by the structural check. Avoid json_each, which is not
      // supported by Telegram's SQL interface, and bound returned bytes.
      const records = []; let after = 0;
      for (;;) {
        const rows = await db.all(`WITH pending AS (
          SELECT sequence,records_json,length(CAST(records_json AS BLOB)) AS bytes
          FROM cloud_events WHERE sequence>:after AND records_json LIKE :match ORDER BY sequence LIMIT 5
        ), bounded AS (
          SELECT sequence,records_json,SUM(bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending
        ) SELECT sequence,records_json FROM bounded
          WHERE total_bytes<=1048576 OR sequence=(SELECT MIN(sequence) FROM pending)
          ORDER BY sequence`, {':after': after, ':match': '%settings%'});
        for (const row of rows) for (const entry of JSON.parse(row.records_json)) {
          if (entry.kind !== 'settings' || !entry.record || typeof entry.record !== 'object' || Array.isArray(entry.record)) continue;
          records.push({kind: 'settings', record: Object.fromEntries(['wallet', 'wallet_address']
            .filter(key => Object.hasOwn(entry.record, key)).map(key => [key, entry.record[key]]))});
        }
        if (!rows.length) return records;
        after = rows[rows.length - 1].sequence;
      }
    },
    async personalAnalyticsSnapshots(wallet) {
      // A saved reporting period is independent of chart grouping. Retain the
      // newest capture for each daily span without reading all historical raw
      // snapshots into the host. Eight 128 KiB rows cap this result at 1 MiB.
      const rows = await db.all(`WITH periods AS (
        SELECT normalized_json,captured_at,fingerprint,
          CASE WHEN json_valid(normalized_json)
            THEN json_array_length(normalized_json,'$.daily') ELSE NULL END AS period_days
        FROM personal_rental_analytics WHERE wallet=:wallet
          AND length(CAST(normalized_json AS BLOB))<=131072
      ), ranked AS (
        SELECT normalized_json,captured_at,fingerprint,
          ROW_NUMBER() OVER (PARTITION BY period_days ORDER BY captured_at DESC,fingerprint DESC) AS ordinal
        FROM periods WHERE period_days BETWEEN 1 AND 366
      ) SELECT normalized_json FROM ranked WHERE ordinal=1
        ORDER BY captured_at DESC,fingerprint DESC LIMIT 8`, {':wallet': wallet});
      const result=[];
      for(const row of rows) {
        const saved=upgradePersonalAnalyticsTopItems(row);
        if(saved&&(!Object.hasOwn(saved,'top_items')||!Object.hasOwn(saved,'by_collection'))) {
          // Legacy source reads are separate, bounded 256 KiB requests. The
          // normal eight-report result stays within its original 1 MiB cap.
          const raw=await db.get(`SELECT raw_snapshot FROM personal_rental_analytics WHERE wallet=:wallet AND fingerprint=:fingerprint
            AND length(CAST(raw_snapshot AS BLOB))<=262144`,{':wallet':wallet,':fingerprint':saved.fingerprint});
          result.push(upgradePersonalAnalyticsTopItems({...row,raw_snapshot:raw?.raw_snapshot}));
        }else result.push(saved);
      }
      return result;
    },
    async personalAnalyticsAllTime(wallet) {
      return readPersonalAnalyticsAllTime((sql,params)=>db.all(sql,params),wallet);
    },
    async reserveMarketappLoginAttempt(attempt, limits) {
      // Reservation and rate checks are one statement, including failed GETs.
      // Keep at most one day of metadata; the rolling hour allowance survives
      // cancellation and consumption, so neither can bypass the cooldown.
      await db.run('DELETE FROM marketapp_login_attempts WHERE owner_id=:owner AND created_at<:before', {':owner': attempt.owner, ':before': attempt.created - 86400000});
      const result = await db.run(`INSERT OR IGNORE INTO marketapp_login_attempts
        (attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint)
        SELECT :id,:owner,:wallet,:created,:expires,'pending',NULL
        WHERE NOT EXISTS (SELECT 1 FROM marketapp_login_attempts WHERE owner_id=:owner AND created_at>:cooldown)
        AND (SELECT count(*) FROM marketapp_login_attempts WHERE owner_id=:owner AND created_at>:hour)<:limit`, {
        ':id': attempt.id, ':owner': attempt.owner, ':wallet': attempt.wallet, ':created': attempt.created,
        ':expires': attempt.expires, ':cooldown': attempt.created - limits.cooldown_ms,
        ':hour': attempt.created - 3600000, ':limit': limits.hourly_attempts,
      });
      return result.rowsAffected === 1;
    },
    async issueMarketappLoginAttempt(id, owner, wallet, fingerprint, at) {
      const result = await db.run(`UPDATE marketapp_login_attempts SET nonce_fingerprint=:fingerprint,state='issued'
        WHERE attempt_id=:id AND owner_id=:owner AND wallet=:wallet AND state='pending' AND expires_at>:at`,
        {':id': id, ':owner': owner, ':wallet': wallet, ':fingerprint': fingerprint, ':at': at});
      return result.rowsAffected === 1;
    },
    async marketappLoginRetry(owner, at, limits) {
      // The same rolling window and strict boundary as reservation. Only
      // timestamps are read; no nonce, wallet, proof or session is projected.
      const rows = await db.all(`SELECT created_at FROM marketapp_login_attempts
        WHERE owner_id=:owner AND created_at>:hour ORDER BY created_at DESC LIMIT :limit`,
        {':owner': owner, ':hour': at - 3600000, ':limit': limits.hourly_attempts});
      if (!rows.length) return null;
      const cooldownAt = rows[0].created_at + limits.cooldown_ms;
      const hourlyAt = rows.length >= limits.hourly_attempts ? rows[limits.hourly_attempts - 1].created_at + 3600000 : 0;
      const retryAt = Math.max(cooldownAt, hourlyAt);
      if (!Number.isSafeInteger(retryAt) || retryAt <= at) return null;
      return {retry_at: new Date(retryAt).toISOString(), retry_after_seconds: Math.ceil((retryAt - at) / 1000), reason: hourlyAt >= cooldownAt ? 'hourly' : 'cooldown'};
    },
    async marketappLoginAttempt(id, owner) {
      return await db.get(`SELECT attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint
        FROM marketapp_login_attempts WHERE attempt_id=:id AND owner_id=:owner`, {':id': id, ':owner': owner});
    },
    async consumeMarketappLoginAttempt(id, owner, wallet, at) {
      const result = await db.run(`UPDATE marketapp_login_attempts SET state='consumed'
        WHERE attempt_id=:id AND owner_id=:owner AND wallet=:wallet AND state='issued' AND expires_at>:at`,
        {':id': id, ':owner': owner, ':wallet': wallet, ':at': at});
      return result.rowsAffected === 1;
    },
    async recordMarketappLoginOutcome(id, owner, outcome) {
      // Defense in depth: never serialize arbitrary caller-supplied metadata.
      // Raw account/proof/session fields cannot enter this diagnostic column.
      const names = ['wallet_matches', 'mainnet', 'domain_matches', 'challenge_matches', 'timestamp_fresh', 'signature_present'];
      const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!plain(outcome) || Object.keys(outcome).length !== 3 || Object.keys(outcome).some(key => !['compatible', 'checks', 'finished_at'].includes(key)) ||
          !plain(outcome.checks) || Object.keys(outcome.checks).length !== names.length || Object.keys(outcome.checks).some(key => !names.includes(key)) || names.some(key => typeof outcome.checks[key] !== 'boolean') ||
          typeof outcome.compatible !== 'boolean' || outcome.compatible !== names.every(key => outcome.checks[key]) || typeof outcome.finished_at !== 'string' || outcome.finished_at.length > 32 || !Number.isFinite(Date.parse(outcome.finished_at)) || new Date(outcome.finished_at).toISOString() !== outcome.finished_at) throw new Error('Invalid connection-test diagnostic');
      const safe = {compatible: outcome.compatible, checks: Object.fromEntries(names.map(key => [key, outcome.checks[key]])), finished_at: outcome.finished_at};
      const result = await db.run(`UPDATE marketapp_login_attempts SET outcome_json=:outcome
        WHERE attempt_id=:id AND owner_id=:owner AND state='consumed' AND outcome_json IS NULL`,
        {':id': id, ':owner': owner, ':outcome': JSON.stringify(safe)});
      return result.rowsAffected === 1;
    },
    async recordMarketappRefreshOutcome(id, owner, outcome) {
      const safe = safeMarketappRefreshOutcome(outcome);
      if (!safe) throw new Error('Invalid analytics-refresh diagnostic');
      const result = await db.run(`UPDATE marketapp_login_attempts SET outcome_json=:outcome
        WHERE attempt_id=:id AND owner_id=:owner
        AND ((:state='awaiting_approval' AND state='issued')
          OR (:state IN ('updating','saved') AND state='consumed')
          OR (:state='failed' AND state IN ('cancelled','consumed')))
        AND (outcome_json IS NULL OR (json_valid(outcome_json)
          AND json_extract(outcome_json,'$.flow')='analytics_refresh'
          AND json_extract(outcome_json,'$.state') IN ('awaiting_approval','updating')
          AND json_extract(outcome_json,'$.observed_at')<=:observed))`,
        {':id': id, ':owner': owner, ':state': safe.state, ':observed': safe.observed_at, ':outcome': JSON.stringify(safe)});
      return result.rowsAffected === 1;
    },
    async latestMarketappRefreshAttempt(owner, wallet, periodDays = null) {
      return await db.get(`SELECT a.attempt_id,a.state,a.created_at,a.expires_at,a.outcome_json,s.imported_at AS saved_at,
          s.captured_at AS snapshot_captured_at
        FROM marketapp_login_attempts a LEFT JOIN personal_rental_analytics s
          ON s.wallet=a.wallet AND s.fingerprint=CASE WHEN json_valid(a.outcome_json)
            THEN json_extract(a.outcome_json,'$.snapshot_fingerprint') ELSE NULL END
        WHERE a.owner_id=:owner AND a.wallet=:wallet AND CASE WHEN json_valid(a.outcome_json)
          THEN json_extract(a.outcome_json,'$.flow')='analytics_refresh'
            AND (:period IS NULL OR json_extract(a.outcome_json,'$.period_days')=:period)
          ELSE :period IS NOT NULL END
        ORDER BY a.created_at DESC LIMIT 1`, {':owner': owner, ':wallet': wallet, ':period': periodDays});
    },
    async pendingMarketappRefreshAttempt(owner, wallet, at) {
      return await db.get(`SELECT attempt_id,state,created_at,expires_at FROM marketapp_login_attempts
        WHERE owner_id=:owner AND wallet=:wallet AND created_at<=:at AND expires_at>:at
          AND state IN ('pending','issued','consumed') AND CASE WHEN json_valid(outcome_json)
            THEN json_extract(outcome_json,'$.state') IN ('awaiting_approval','updating') ELSE 1 END
        ORDER BY created_at DESC LIMIT 1`, {':owner': owner, ':wallet': wallet, ':at': at});
    },
    async cancelMarketappLoginAttempt(id, owner) {
      await db.run(`UPDATE marketapp_login_attempts SET state='cancelled'
        WHERE attempt_id=:id AND owner_id=:owner AND state IN ('pending','issued')`, {':id': id, ':owner': owner});
    },
  };
}
