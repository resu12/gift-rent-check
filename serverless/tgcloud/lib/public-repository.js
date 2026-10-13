import {CloudStorageFullError, preparedRecordJSON, compactStorageGuard, compactStorageParameters, normalizedRecordOverhead,
  visitCompactRecordPages, normalizedEventRecords, normalizedRecordScope, NORMALIZED_RECORD_READY_SQL, compactControlRetirement} from './cloud-repository.js';
import {encodeCheckpoint, decodeCheckpoint, COMPACTABLE_CHECKPOINT, usesCompactOperationalStorage, COMPACT_OPERATIONAL_READY_SQL} from './checkpoint-storage.js';
import {safeMarketappRefreshOutcome} from './marketapp-refresh-outcome.js';
import {sha256} from './ton-price-decoder.js';
import {utf8Size} from './bounded-response.js';
import {CANDIDATES, compactDiscoveryJob, expandDiscoveryJob} from './public-discovery-storage.js';
import {createMarketappWebsiteGate} from './marketapp-website-gate.js';
import {DEFAULT_PUBLIC_ACCOUNT_BYTES} from './storage-policy.js';
import {PERSONAL_ANALYTICS_MAX_BYTES,PERSONAL_ANALYTICS_DAILY_BYTES,PERSONAL_ANALYTICS_ITEM_BYTES,PERSONAL_ANALYTICS_COLLECTION_BYTES,personalAnalyticsDailyReserve,personalAnalyticsDailyReadySQL,personalAnalyticsSnapshotPreservedSQL,readPersonalAnalyticsAllTime,upgradePersonalAnalyticsTopItems} from './personal-analytics.js';
import {StorageCapacityError,PUBLIC_COLLECTION_HEADROOM_BYTES} from './storage-admission.js';
import {ownedScopeRecordFilter} from './owned-price-engine.js';
import {giftRefreshSessionKey} from './gift-refresh-storage.js';

const MAX = 9007199254740991;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const initial = () => ({version: 2, next_job_id: 1, job: null, attempts: [], next_allowed_at: 0});
// These are fixed SQL fragments, never identifiers or SQL supplied by users.
const ACTIVE = "EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:account_generation AND status='active')";
const WALLET_REVISION = `COALESCE((SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant AND records_json LIKE '%"kind":"settings"%'),0)`;
// Carried by subsequent bindings, so retained settings keep disconnects fenced
// even if older checkpoints are compacted. This does not reset account identity.
const WALLET_DISCONNECT_REVISION = `COALESCE((SELECT json_extract(records_json,'$[0].record.wallet_disconnect_revision') FROM public_cloud_events
  WHERE user_id=:tenant AND (event_key LIKE 'wallet-bind:%' OR event_key LIKE 'wallet-disconnect:%') ORDER BY sequence DESC LIMIT 1),0)`;
const INLINE = `CASE WHEN json_valid(state_json) THEN json_type(state_json,'$')='object'
  AND json_type(state_json,'$.__checkpoint_owned_targets_sequence') IS NULL
  AND json_type(state_json,'$.owned_prices')='object' AND json_type(json_remove(state_json,'$.owned_prices'),'$.owned_prices') IS NULL
  AND json_type(state_json,'$.owned_prices.run')='object' AND json_type(json_remove(state_json,'$.owned_prices.run'),'$.owned_prices.run') IS NULL
  AND json_type(state_json,'$.owned_prices.run.id')='integer' AND json_extract(state_json,'$.owned_prices.run.id') BETWEEN 1 AND 9007199254740991
  AND json_type(json_remove(state_json,'$.owned_prices.run.id'),'$.owned_prices.run.id') IS NULL
  AND json_type(state_json,'$.owned_prices.run.wallet') IN ('text','null') AND json_type(json_remove(state_json,'$.owned_prices.run.wallet'),'$.owned_prices.run.wallet') IS NULL
  AND json_type(state_json,'$.owned_prices.run.targets')='array' AND json_type(json_remove(state_json,'$.owned_prices.run.targets'),'$.owned_prices.run.targets') IS NULL ELSE 0 END`;
const TARGETS = `sequence,json_extract(state_json,'$.owned_prices.run.id') AS run_id,
  json_extract(state_json,'$.owned_prices.run.wallet') AS wallet,json_extract(state_json,'$.owned_prices.run.targets') AS targets_json`;
const EVENT_BYTES="length(CAST(state_json AS BLOB))+COALESCE(length(CAST(job_json AS BLOB)),0)+length(CAST(records_json AS BLOB))+COALESCE(length(CAST(raw_body AS BLOB)),0)";
const ANALYTICS_BYTES="length(CAST(raw_snapshot AS BLOB))+length(CAST(normalized_json AS BLOB))";
const PAYLOAD_BYTES="length(CAST(payload_id AS BLOB))+length(CAST(scope AS BLOB))+length(CAST(document AS BLOB))";
const OCCURRENCE_BYTES="length(CAST(occurrence_id AS BLOB))+length(CAST(scope AS BLOB))+length(CAST(event_key AS BLOB))+length(CAST(observed_at AS BLOB))+length(CAST(payload_id AS BLOB))+length(CAST(envelope_json AS BLOB))+32";
const INLINE_INDEX_BYTES="length(CAST(row_id AS BLOB))+length(CAST(scope AS BLOB))+length(CAST(generation AS BLOB))+length(CAST(sequence AS BLOB))+length(CAST(has_seed AS BLOB))";
const FALLBACK_ACCOUNT_BYTES=`COALESCE((SELECT SUM(${EVENT_BYTES}) FROM public_cloud_events WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(${PAYLOAD_BYTES}) FROM service_record_payloads WHERE scope='public:'||:tenant),0)
  +COALESCE((SELECT SUM(${OCCURRENCE_BYTES}) FROM service_record_occurrences WHERE scope='public:'||:tenant),0)
  +COALESCE((SELECT SUM(${INLINE_INDEX_BYTES}) FROM service_record_inline_events WHERE scope='public:'||:tenant),0)
  +COALESCE((SELECT SUM(${ANALYTICS_BYTES}) FROM public_personal_rental_analytics WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_DAILY_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_daily WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_ITEM_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_item_reports WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_COLLECTION_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_collection_reports WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM public_dashboard_projection_cache WHERE user_id=:tenant),0)`;
const FALLBACK_SERVICE_BYTES=`COALESCE((SELECT SUM(${EVENT_BYTES}) FROM public_cloud_events),0)
  +COALESCE((SELECT SUM(${PAYLOAD_BYTES}) FROM service_record_payloads WHERE scope LIKE 'public:%'),0)
  +COALESCE((SELECT SUM(${OCCURRENCE_BYTES}) FROM service_record_occurrences WHERE scope LIKE 'public:%'),0)
  +COALESCE((SELECT SUM(${INLINE_INDEX_BYTES}) FROM service_record_inline_events WHERE scope LIKE 'public:%'),0)
  +COALESCE((SELECT SUM(${ANALYTICS_BYTES}) FROM public_personal_rental_analytics),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_DAILY_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_daily),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_ITEM_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_item_reports),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_COLLECTION_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_collection_reports),0)
  +COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM public_dashboard_projection_cache),0)`;
// Installed accounting is updated by the same write statement as records and
// archives. Use its constant-size scope rows instead of summing every saved
// payload on each provider outcome. Pre-install/test repositories keep the
// conservative direct-table fallback.
const ACCOUNTING_READY="EXISTS(SELECT 1 FROM service_storage_usage WHERE id=1 AND initialized_at>0)";
const ACCOUNT_BYTES=`COALESCE((SELECT MAX(total_bytes,0) FROM service_storage_scope_usage
  WHERE scope='public:'||:tenant AND initialized_at>0 AND ${ACCOUNTING_READY}),(${FALLBACK_ACCOUNT_BYTES}))`;
const SERVICE_BYTES=`CASE WHEN ${ACCOUNTING_READY} THEN
  (SELECT COALESCE(SUM(MAX(total_bytes,0)),0) FROM service_storage_scope_usage WHERE scope LIKE 'public:%') ELSE (${FALLBACK_SERVICE_BYTES}) END`;
const QUOTA=`(${ACCOUNT_BYTES})+:new_bytes<=:max_account_bytes AND (${SERVICE_BYTES})+:new_bytes<=:max_service_bytes`;
// A small fixed recovery reserve is unavailable to data collection. It lets a
// user stop leased work/revoke credentials even when the data quota is full.
const CONTROL_RESERVE = 262144;
export class PublicAccountError extends Error {constructor() {super('Public account is unavailable.');}}
export class PublicCredentialChangedError extends Error {constructor() {super('Provider credential changed. Clear comparisons before starting a new update.');}}
export class PublicWalletChangedError extends Error {constructor() {super('Wallet connection changed. Start a new gift refresh.');this.code='PUBLIC_WALLET_CHANGED';}}
export class PublicStorageLimitError extends Error {constructor() {super('Public storage allowance reached. Saved data and progress are retained.');this.code='PUBLIC_STORAGE_LIMIT';}}
export function verifiedTelegramUserId(ctx) {
  // ctx is supplied by Telegram Serverless after init-data verification.
  return canonicalUser(ctx?.initData?.user?.id);
}
function canonicalUser(value) {
  const id = String(value ?? '');
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new PublicAccountError();
  return id;
}

export function createPublicRepository(db, verifiedUserId, {dashboardCache = false, maxAccounts = 100, credentialFence = null, walletFence = null, accountGenerationFence = null,
  maxAccountBytes=DEFAULT_PUBLIC_ACCOUNT_BYTES,maxServiceBytes=134217728,storageAdmission=null,websiteLimits=null} = {}) {
  const userId = canonicalUser(verifiedUserId);
  if(!positive(maxAccounts)||maxAccounts>10000)throw new Error('Invalid public account cap');
  if(!positive(maxAccountBytes)||!positive(maxServiceBytes)||maxAccountBytes>maxServiceBytes||maxServiceBytes>536870912)throw new Error('Invalid public storage cap');
  const storage={maxAccountBytes,maxServiceBytes};
  if(accountGenerationFence!==null&&(!Number.isSafeInteger(accountGenerationFence)||accountGenerationFence<0))throw new Error('Invalid public account fence');
  let capturedGeneration = accountGenerationFence;
  let capturedCredentialFence=null;
  // Targeted checks may read a retained portfolio wallet after disconnect, but
  // no request captured before a disconnect/rebind may write into that state.
  const capturedWalletRevision=walletFence===null?null:walletFence.revision;
  if(walletFence!==null&&(!plain(walletFence)||!Number.isSafeInteger(capturedWalletRevision)||capturedWalletRevision<0))throw new Error('Invalid public wallet fence');
  function setCredentialFence(value) {
    if(!plain(value)||!/^[a-z][a-z0-9_-]{0,31}$/.test(value.provider)||!positive(value.credential_version)
      ||!/^[0-9a-f]{64}$/.test(value.fingerprint??value.credential_fingerprint))throw new Error('Invalid provider credential fence');
    const next={provider:value.provider,credential_version:value.credential_version,fingerprint:value.fingerprint??value.credential_fingerprint};
    if(capturedCredentialFence&&JSON.stringify(capturedCredentialFence)!==JSON.stringify(next))throw new Error('Provider credential fence is immutable');
    capturedCredentialFence=next;
  }
  if(credentialFence)setCredentialFence(credentialFence);
  const key = (...parts) => JSON.stringify([userId, ...parts]);
  const owner = value => {if (canonicalUser(value) !== userId) throw new PublicAccountError();};
  async function clock() {
    const row = await db.get("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS server_time");
    if (!positive(row?.server_time)) throw new Error('Server clock unavailable');
    return row.server_time;
  }
  async function accountRow() {return await db.get('SELECT * FROM public_accounts WHERE user_id=:tenant', {':tenant': userId});}
  async function ensureAccount() {
    if (capturedGeneration === null) {
      await db.run(`INSERT OR IGNORE INTO public_accounts(user_id,generation,status,created_at,wallet_nonce_counter)
        SELECT :tenant,0,'active',:created,0 WHERE (SELECT count(*) FROM public_accounts WHERE status IN ('active','migrating','deleting'))<:max_accounts`,
        {':tenant': userId, ':created': await clock(), ':max_accounts': maxAccounts});
    }
    const row = await accountRow();
    if (!row || row.status !== 'active' || !Number.isSafeInteger(row.generation) || row.generation < 0
      || (capturedGeneration !== null && capturedGeneration !== row.generation)) throw new PublicAccountError();
    capturedGeneration = row.generation;
    if(capturedWalletRevision!==null) {
      const current=await db.get(`SELECT ${WALLET_REVISION} AS wallet_revision WHERE ${ACTIVE}`,
        {':tenant':userId,':account_generation':capturedGeneration});
      if(current?.wallet_revision!==capturedWalletRevision)throw new PublicWalletChangedError();
    }
    if(capturedCredentialFence) {
      const current=await db.get(`SELECT 1 AS valid FROM public_provider_credentials WHERE user_id=:tenant AND provider=:provider
        AND credential_version=:version AND credential_fingerprint=:fingerprint AND ciphertext IS NOT NULL AND ${ACTIVE}`,
        {':tenant':userId,':account_generation':capturedGeneration,':provider':capturedCredentialFence.provider,
          ':version':capturedCredentialFence.credential_version,':fingerprint':capturedCredentialFence.fingerprint});
      if(!current)throw new PublicCredentialChangedError();
    }
    return row;
  }
  async function params(extra = {}) {await ensureAccount(); return {...extra, ':tenant': userId, ':account_generation': capturedGeneration};}
  async function get(sql, extra = {}) {return await db.get(sql, await params(extra));}
  async function all(sql, extra = {}) {return await db.all(sql, await params(extra));}
  async function run(sql, extra = {}) {
    try {return await db.run(sql, await params(extra));}
    catch (error) {if (/database or disk is full/i.test(String(error?.message || ''))) throw new CloudStorageFullError(); throw error;}
  }
  async function reserveStorage(request) {
    await ensureAccount();
    const reserve=async()=>{
      const token=await storageAdmission.reserveStorage(request);
      try {await ensureAccount();} catch(error) {await storageAdmission.releaseStorage(token);throw error;}
      return token;
    };
    try {return await reserve();}
    catch(error) {
      if(!(error instanceof StorageCapacityError))throw error;
      // Only this account's replaceable projection is eligible. One bounded
      // delete and one fresh admission attempt preserve the original capacity
      // limits, reservations, credential fences and account generation.
      const result=await run(`DELETE FROM public_dashboard_projection_cache WHERE user_id=:tenant AND ${ACTIVE}
        AND row_id IN(SELECT row_id FROM public_dashboard_projection_cache WHERE user_id=:tenant
          ORDER BY time_bucket,records_revision,row_id LIMIT 128)`);
      if(!result.rowsAffected)throw error;
      return await reserve();
    }
  }
  async function ownedTargetSource(sequence) {
    if (!positive(sequence)) throw new Error('Invalid owned-target source sequence');
    return await get(`SELECT ${TARGETS} FROM public_cloud_events WHERE user_id=:tenant AND sequence=:sequence AND ${INLINE} AND ${ACTIVE}`, {':sequence': sequence});
  }
  async function findOwnedTargetSource(value, beforeSequence) {
    if (!positive(beforeSequence)) throw new Error('Invalid owned-target source bound');
    if (!plain(value) || !positive(value.id) || !Object.hasOwn(value, 'wallet') || !(value.wallet === null || typeof value.wallet === 'string') || !Array.isArray(value.targets)) return null;
    const targets = JSON.stringify(value.targets); if (targets.length <= 64) return null;
    return await get(`SELECT ${TARGETS} FROM public_cloud_events WHERE user_id=:tenant AND sequence<:before
      AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.owned_prices.run.id')=:id
        AND json_extract(state_json,'$.owned_prices.run.wallet') IS :wallet AND json_extract(state_json,'$.owned_prices.run.targets')=:targets ELSE 0 END
      AND ${INLINE} AND ${ACTIVE} ORDER BY sequence LIMIT 1`, {':before': beforeSequence, ':id': value.id, ':wallet': value.wallet, ':targets': targets});
  }
  async function discoverySourceRow(id, sequence) {
    return await get(`SELECT sequence,job_id,job_json FROM public_cloud_events WHERE user_id=:tenant
      AND job_id=:id AND sequence=:sequence AND ${ACTIVE}`, {':id':id,':sequence':sequence});
  }
  async function* discoverySourceRows(id, until) {
    const root=await get(`SELECT COALESCE(MAX(sequence),0) AS sequence FROM public_cloud_events WHERE user_id=:tenant AND job_id=:id AND sequence<=:until
      AND CASE WHEN json_valid(job_json) THEN json_type(job_json,'$.candidates')='object'
        OR json_extract(job_json,'$.${CANDIDATES}.base')=1 ELSE 0 END AND ${ACTIVE}`,{':id':id,':until':until});
    let after=Math.max(0,root.sequence-1);
    for(;;) {
      const rows=await all(`WITH pending AS (SELECT sequence,job_id,job_json,length(CAST(job_json AS BLOB)) AS bytes
        FROM public_cloud_events WHERE user_id=:tenant AND job_id=:id AND sequence>:after AND sequence<=:until
          AND CASE WHEN json_valid(job_json) THEN json_type(job_json,'$.candidates')='object'
            OR json_type(job_json,'$.${CANDIDATES}.changes')='object' ELSE 0 END AND ${ACTIVE} ORDER BY sequence LIMIT 25),
        bounded AS (SELECT *,SUM(bytes) OVER(ORDER BY sequence) AS total_bytes FROM pending)
        SELECT sequence,job_id,job_json FROM bounded WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`,
        {':id':id,':after':after,':until':until});
      if(!rows.length)return;
      for(const row of rows)yield row;
      after=rows.at(-1).sequence;
    }
  }
  async function expandedJob(row) {return await expandDiscoveryJob(row,discoverySourceRows,discoverySourceRow);}
  async function read() {
    const row = await get(`SELECT sequence,state_json,job_id,job_json FROM public_cloud_events WHERE user_id=:tenant AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`);
    if (!row) {
      const legacy = await get(`SELECT document FROM public_legacy_collector_state WHERE user_id=:tenant AND ${ACTIVE}`);
      const state = initial();
      if (legacy) {
        const saved = JSON.parse(legacy.document); state.next_allowed_at = Number.isSafeInteger(saved.provider_next_allowed_at) ? saved.provider_next_allowed_at : 0;
        for (const value of saved.runs || []) for (let i = 0; i < Math.min(Number.isSafeInteger(value.attempts) ? Math.max(0, value.attempts) : 0, 500); i++) state.attempts.push(positive(value.updated_at) ? value.updated_at : await clock());
        state.attempts.sort((a,b) => a-b);
      }
      else if(await get(`SELECT 1 AS ready WHERE ${ACTIVE} AND (${COMPACT_OPERATIONAL_READY_SQL}) AND (${NORMALIZED_RECORD_READY_SQL})`)) {
        state.operational_storage_version=1;state.record_storage_floor=0;
      }
      return {revision: 0, state};
    }
    const saved = JSON.parse(row.state_json), marker = saved?.__checkpoint_job_sequence;
    const source = positive(marker) && marker < row.sequence ? await get(`SELECT sequence,job_id,job_json FROM public_cloud_events WHERE user_id=:tenant AND sequence=:sequence AND ${ACTIVE}`, {':sequence': marker}) : row;
    const targetMarker = saved?.__checkpoint_owned_targets_sequence;
    const targetSource = positive(targetMarker) && targetMarker < row.sequence ? await ownedTargetSource(targetMarker) : null;
    const state=decodeCheckpoint(row, source, targetSource);
    if(state.job?.kind==='discover'&&typeof source?.job_json==='string')state.job=await expandedJob(source);
    return {revision: row.sequence, state};
  }
  async function append(expected, event, challenge = null, website = null) {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected >= MAX) throw new Error('Invalid public checkpoint revision');
    const compact=usesCompactOperationalStorage(event.state);
    if(compact&&!event.job&&positive(event.state?.job?.id))event={...event,job:event.state.job};
    if(capturedWalletRevision!==null&&event.key?.startsWith('owned-price:')&&plain(event.state?.owned_prices?.run)) {
      const ownedRun=event.state.owned_prices.run;
      const stopping=ownedRun.state==='partial'&&ownedRun.reason==='stopped_by_you'&&!event.raw_body&&!(event.records||[]).length;
      if(ownedRun.public_wallet_revision!==undefined&&ownedRun.public_wallet_revision!==capturedWalletRevision&&!stopping)throw new PublicWalletChangedError();
      if(ownedRun.public_wallet_revision===undefined)event={...event,state:{...event.state,owned_prices:{...event.state.owned_prices,run:{...ownedRun,public_wallet_revision:capturedWalletRevision}}}};
    }
    if(capturedWalletRevision!==null&&event.key?.startsWith('gift-refresh')&&plain(event.state?.gift_refresh?.run)) {
      const giftRun=event.state.gift_refresh.run,stopping=giftRun.state==='partial'&&giftRun.reason==='stopped_by_you'&&!event.raw_body&&!(event.records||[]).length;
      if(giftRun.public_wallet_revision!==undefined&&giftRun.public_wallet_revision!==capturedWalletRevision&&!stopping)throw new PublicWalletChangedError();
      if(giftRun.public_wallet_revision===undefined)event={...event,state:{...event.state,gift_refresh:{...event.state.gift_refresh,run:{...giftRun,public_wallet_revision:capturedWalletRevision}}}};
    }
    const websiteTime=website?Date.parse(event.observed_at):null;
    if(website&&(!website.value||!website.fence||website.value.owner!==userId||!positive(websiteTime)
      ||!Number.isSafeInteger(website.fence.generation)||website.fence.generation<0
      ||!Number.isSafeInteger(website.fence.wallet_revision)||website.fence.wallet_revision<0
      ||!positive(website.value.cookie_version)||website.value.generation!==website.fence.generation
      ||website.value.wallet_revision!==website.fence.wallet_revision||typeof website.value.wallet!=='string'
      ||new Date(websiteTime).toISOString()!==event.observed_at))return false;
    if(capturedCredentialFence&&plain(event.state?.job)) {
      const saved=event.state.job.public_credential;
      if(saved!==undefined&&JSON.stringify(saved)!==JSON.stringify(capturedCredentialFence))throw new PublicCredentialChangedError();
      if(saved===undefined) {
        const job={...event.state.job,public_credential:{...capturedCredentialFence}};
        const same=plain(event.job)&&JSON.stringify(event.job)===JSON.stringify(event.state.job);
        event={...event,state:{...event.state,job},job:same?job:event.job};
      }
    }
    const originalJob=event.state?.job;
    const controlJob=originalJob?.state==='partial'&&originalJob.reason==='stopped_by_you'
      ||originalJob?.state==='failed'&&originalJob.reason==='credential_removed';
    const controlOwned=event.state?.owned_prices?.run?.state==='partial'&&event.state.owned_prices.run.reason==='stopped_by_you';
    const controlGift=event.state?.gift_refresh?.run?.state==='partial'&&event.state.gift_refresh.run.reason==='stopped_by_you';
    const possibleControl=(controlJob||controlOwned||controlGift)&&!event.raw_body&&!(event.records||[]).length;
    let control=false;
    if(possibleControl) {
      const before=await read(),previousJob=before.state.job,previousOwned=before.state.owned_prices?.run,previousGift=before.state.gift_refresh?.run;
      control=before.revision===expected&&Boolean(
        controlJob&&previousJob?.id===originalJob.id&&(['running','queued','pending'].includes(previousJob.state)
          ||originalJob.reason==='credential_removed'&&previousJob.state==='partial')
        ||controlOwned&&previousOwned?.id===event.state.owned_prices.run.id&&['running','queued','pending'].includes(previousOwned.state)
        ||controlGift&&previousGift?.id===event.state.gift_refresh.run.id&&previousGift.state==='running');
    }
    if(!compact&&originalJob?.kind==='discover') {
      const previousRow=await get(`SELECT sequence,job_id,job_json FROM public_cloud_events WHERE user_id=:tenant AND job_id=:id
        AND sequence<=:expected AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`,{':id':originalJob.id,':expected':expected});
      const previous=previousRow?{physical:JSON.parse(previousRow.job_json),job:await expandedJob(previousRow)}:null;
      const savedJob=compactDiscoveryJob(originalJob,expected+1,previous,previousRow?.sequence);
      const same=event.job&&JSON.stringify(event.job)===JSON.stringify(originalJob);
      event={...event,state:{...event.state,job:savedJob},job:same||!event.job?savedJob:event.job};
    }
    let prior = null;
    if (!compact && !event.job && positive(event.state?.job?.id)) prior = await get(`SELECT sequence,job_id,job_json FROM public_cloud_events
      WHERE user_id=:tenant AND sequence<=:expected AND job_id=:id AND job_json=:job AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`,
      {':expected': expected, ':id': event.state.job.id, ':job': JSON.stringify(event.state.job)});
    const targetSource = compact?null:await findOwnedTargetSource(event.state?.owned_prices?.run, expected + 1);
    const stateJson=encodeCheckpoint(event.state,event.job,expected+1,prior,targetSource),jobJson=event.job?JSON.stringify(event.job):null,
      // Validated records/checkpoints are authoritative for the app. Raw
      // responses duplicate them and may contain large TON contract BOCs.
      // Control classification above still inspects the original raw_body.
      recordsJson=preparedRecordJSON(event.records,compact),raw=null;
    const bytes=utf8Size(stateJson)+utf8Size(jobJson??'')+utf8Size(recordsJson)+utf8Size(raw??'')+normalizedRecordOverhead(event.records,event.key,compact)
      +(compact?utf8Size(stateJson)+4096:0);
    control=control&&(compact||bytes<=CONTROL_RESERVE);
    let admissionBytes=bytes+utf8Size(key('event',expected+1))+utf8Size(userId)+utf8Size(String(expected+1))
      +utf8Size(event.key)+utf8Size(String(event.job?.id??''))+utf8Size(event.observed_at)
      +1024; // Account for up to four new source pins in the same transaction.
    let retirement={sql:'1',parameters:{}};
    if(compact&&control) {
      const credited=await compactControlRetirement(get,{table:'public_cloud_events',where:`user_id=:tenant AND ${ACTIVE}`,expected,event,stateJson,bytes:admissionBytes,publicScope:true});
      if(credited){retirement=credited;admissionBytes=credited.bytes;}else control=false;
    }
    const admission=storageAdmission?.fence(admissionBytes,event.storage_token??null,{control})??{sql:'1',parameters:{}};
    const quota={':new_bytes':compact&&control?admissionBytes:bytes,
      ':max_account_bytes':maxAccountBytes+(control?CONTROL_RESERVE:0),':max_service_bytes':maxServiceBytes+(control?CONTROL_RESERVE*maxAccounts:0)};
    const result = await run(`INSERT OR IGNORE INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at)
      SELECT :row_id,:tenant,:sequence,:key,:state,:job_id,:job,:records,:raw,:observed WHERE ${ACTIVE}
      AND ${QUOTA}
      AND ${admission.sql}
      AND COALESCE((SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant),0)=:expected
      AND NOT EXISTS(SELECT 1 FROM public_cloud_events WHERE user_id=:tenant AND event_key=:key)
      AND ${compactStorageGuard('public_cloud_events','user_id=:tenant')}
      AND ${retirement.sql}
      AND (:wallet_revision IS NULL OR :wallet_revision=${WALLET_REVISION})
      AND (:website_generation IS NULL OR EXISTS(SELECT 1 FROM public_marketapp_analytics_sessions WHERE owner_id=:tenant
        AND generation=:website_generation AND wallet=:website_wallet AND ${WALLET_REVISION}=:website_wallet_revision
        AND cookie_version=:website_cookie_version AND ciphertext IS NOT NULL AND created_at<=:website_observed AND expires_at>:website_observed))
      AND (:credential_provider IS NULL OR EXISTS(SELECT 1 FROM public_provider_credentials WHERE user_id=:tenant
        AND provider=:credential_provider AND credential_version=:credential_version AND credential_fingerprint=:credential_fingerprint AND ciphertext IS NOT NULL))
      AND (:challenge IS NULL OR EXISTS(SELECT 1 FROM public_wallet_challenges WHERE user_id=:tenant AND challenge_id=:challenge
        AND generation=:account_generation AND consumed_at IS NOT NULL AND expires_at>:verified
        AND wallet_disconnect_revision=${WALLET_DISCONNECT_REVISION}
        AND (wallet IS NULL OR wallet=:binding_wallet)))`,
      {':row_id': key('event', expected + 1), ':sequence': expected + 1, ':expected': expected, ':key': event.key,
        ...compactStorageParameters(event.state),
        ':state':stateJson, ':job_id': event.job?.id ?? null,
        ':job':jobJson, ':records':recordsJson, ':raw':raw,...quota,...admission.parameters,...retirement.parameters,
        ':observed': event.observed_at, ':challenge': challenge?.id ?? null, ':verified': challenge?.at ?? 0, ':binding_wallet': challenge?.wallet ?? null,
        ':credential_provider':capturedCredentialFence?.provider??null,':credential_version':capturedCredentialFence?.credential_version??null,
        ':credential_fingerprint':capturedCredentialFence?.fingerprint??null,':wallet_revision':capturedWalletRevision,
        ':website_generation':website?.fence.generation??null,':website_wallet':website?.value.wallet??null,
        ':website_wallet_revision':website?.fence.wallet_revision??null,':website_cookie_version':website?.value.cookie_version??null,':website_observed':websiteTime});
    if(result.rowsAffected===1)return true;
    if(storageAdmission)await storageAdmission.assertAdmitted(admissionBytes,event.storage_token??null,{control});
    if(await get(`SELECT 1 AS limited WHERE ${ACTIVE} AND NOT(${QUOTA})
      AND COALESCE((SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant),0)=:expected
      AND NOT EXISTS(SELECT 1 FROM public_cloud_events WHERE user_id=:tenant AND event_key=:key)`,{...quota,':expected':expected,':key':event.key}))throw new PublicStorageLimitError();
    return false;
  }
  async function visitRecordPages(until, visitor, selection = 'all', filter = null) {
    if (!Number.isSafeInteger(until) || until < 0 || typeof visitor !== 'function') throw new Error('Invalid record traversal');
    const context=await get(`SELECT json_extract(state_json,'$.operational_storage_version') AS mode,COALESCE(json_extract(state_json,'$.record_storage_floor'),0) AS floor
      FROM public_cloud_events WHERE user_id=:tenant AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`);
    if(context?.mode===1) {
      await visitCompactRecordPages({get,all,table:'public_cloud_events',where:`e.user_id=:tenant AND ${ACTIVE}`,
        scope:normalizedRecordScope(userId),generation:capturedGeneration,until,floor:context.floor,
        visitor:selection==='settings'?page=>visitor(page.map(value=>({kind:'settings',record:Object.fromEntries(['wallet','wallet_address','wallet_verification','wallet_verified_at']
          .filter(name=>Object.hasOwn(value.record||{},name)).map(name=>[name,value.record[name]]))}))):visitor,selection,filter});
      await ensureAccount();return;
    }
    let after = 0;
    for (;;) {
      // Amortize host-call overhead for small events within the existing byte
      // ceiling. Tenant and captured-generation fences still apply.
      const rows = await all(`WITH pending AS (SELECT sequence,records_json,length(CAST(records_json AS BLOB)) AS bytes
        FROM public_cloud_events WHERE user_id=:tenant AND sequence>:after AND sequence<=:until AND records_json<>'[]'
          AND (:settings=0 OR records_json LIKE '%settings%')
          AND (:seeds=0 OR records_json LIKE '%"portfolio"%' OR records_json LIKE '%"gift"%' OR records_json LIKE '%"settings"%')
          AND ${filter?.sql??'1'}
          AND ${ACTIVE} ORDER BY sequence LIMIT 16),
        bounded AS (SELECT sequence,records_json,SUM(bytes) OVER(ORDER BY sequence) AS total_bytes FROM pending)
        SELECT sequence,records_json FROM bounded WHERE total_bytes<=1048576 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`,
        {':after': after, ':until': until, ':settings': selection === 'settings' ? 1 : 0, ':seeds': selection === 'seeds' ? 1 : 0,...filter?.parameters});
      if (!rows.length) {
        // A deletion/recreation between params() and the SQL read can make
        // ACTIVE return an empty page. It must fail this captured traversal,
        // rather than certify a partial dashboard as complete.
        await ensureAccount();
        const latest=await get(`SELECT COALESCE(json_extract(state_json,'$.record_storage_floor'),0) AS floor FROM public_cloud_events
          WHERE user_id=:tenant AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`);
        if((latest?.floor??0)!==(context?.floor??0))throw new Error('Saved records changed; reload saved data');
        return;
      }
      for (const row of rows) {
        const parsed = JSON.parse(row.records_json);
        const page = selection === 'seeds' ? parsed.filter(value => ['portfolio','gift','settings'].includes(value?.kind))
          : selection === 'settings' ? parsed.filter(value => value.kind === 'settings' && plain(value.record)).map(value =>
            ({kind:'settings',record:Object.fromEntries(['wallet','wallet_address','wallet_verification','wallet_verified_at'].filter(name=>Object.hasOwn(value.record,name)).map(name=>[name,value.record[name]]))})) : parsed;
        await visitor(page);
      }
      after = rows[rows.length-1].sequence;
    }
  }
  async function records(until = MAX, settingsOnly = false) {
    const result = [];
    await visitRecordPages(until, page => {for (const record of page) result.push(record);}, settingsOnly ? 'settings' : 'all');
    return result;
  }
  async function publicAccount() {
    const row = await accountRow(); if (!row) return null;
    if (capturedGeneration !== null && row.generation !== capturedGeneration) throw new PublicAccountError();
    if (row.status !== 'active') return {...row, wallet: null, wallet_verified_at: null};
    // Pin the row before any further await: a delete/reactivation between the
    // metadata read and wallet queries must not mix two account generations.
    capturedGeneration=row.generation;
    const binding = await get(`SELECT json_extract(records_json,'$[0].record.wallet') AS wallet,
      json_extract(records_json,'$[0].record.wallet_verified_at') AS wallet_verified_at,
      COALESCE(json_extract(records_json,'$[0].record.wallet_disconnect_revision'),0) AS wallet_disconnect_revision,
      json_extract(records_json,'$[0].record.wallet_challenge_id') AS wallet_challenge_id FROM public_cloud_events
      WHERE user_id=:tenant AND (event_key LIKE 'wallet-bind:%' OR event_key LIKE 'wallet-disconnect:%') AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`);
    const settings=await records(MAX,true); let savedWallet=null;
    for(const value of settings) {const wallet=value.record.wallet??value.record.wallet_address;if(typeof wallet==='string'&&wallet)savedWallet=wallet;}
    const walletRevision=await get(`SELECT ${WALLET_REVISION} AS wallet_revision WHERE ${ACTIVE}`);
    return {...row, wallet:savedWallet??binding?.wallet??null, wallet_verified_at:binding?.wallet_verified_at??null,wallet_revision:walletRevision?.wallet_revision??0,
      wallet_disconnect_revision:binding?.wallet_disconnect_revision??0, wallet_challenge_id:binding?.wallet_challenge_id??null};
  }
  async function credentialStatus(provider) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) throw new Error('Invalid credential provider');
    return await get(`SELECT * FROM public_provider_credentials WHERE user_id=:tenant AND provider=:provider AND ${ACTIVE}`, {':provider': provider});
  }
  async function reserveCredentialNonce(provider, expectedAccountGeneration) {
    await ensureAccount(); if (capturedGeneration !== expectedAccountGeneration) return null;
    await credentialStatus(provider);
    await run(`INSERT OR IGNORE INTO public_provider_credentials(row_id,user_id,provider,generation,nonce_counter,credential_version)
      SELECT :row_id,:tenant,:provider,0,0,0 WHERE ${ACTIVE}`, {':row_id':key('credential',provider), ':provider':provider});
    for (let i=0;i<16;i++) {
      const value=await credentialStatus(provider); if (!value || !Number.isSafeInteger(value.nonce_counter) || value.nonce_counter<0 || value.nonce_counter>=MAX) return null;
      const counter=value.nonce_counter+1;
      const updated=await run(`UPDATE public_provider_credentials SET nonce_counter=:counter WHERE user_id=:tenant AND provider=:provider
        AND nonce_counter=:previous AND generation=:generation AND ${ACTIVE}`, {':provider':provider,':counter':counter,':previous':value.nonce_counter,':generation':value.generation});
      if(updated.rowsAffected===1)return {counter,generation:value.generation,credential_version:value.credential_version};
    } return null;
  }
  async function storeCredentialCAS(provider, expectedAccountGeneration, expectedCredentialVersion, value, expectedCheckpoint=null) {
    await ensureAccount(); if (capturedGeneration!==expectedAccountGeneration) return false;
    await credentialStatus(provider);
    if (!plain(value) || !positive(value.credential_version) || !/^[0-9a-f]{64}$/.test(value.credential_fingerprint) || typeof value.ciphertext!=='string'
      || value.ciphertext.length>32768 || !positive(value.created_at) || !positive(value.updated_at)
      || (expectedCheckpoint!==null&&(!Number.isSafeInteger(expectedCheckpoint)||expectedCheckpoint<0))) throw new Error('Invalid encrypted credential');
    return (await run(`UPDATE public_provider_credentials SET credential_version=:version,ciphertext=:ciphertext,
      credential_fingerprint=:fingerprint,created_at=:created,updated_at=:updated WHERE user_id=:tenant AND provider=:provider
      AND credential_version=:previous AND :version>:previous AND nonce_counter>=:version AND ${ACTIVE}
      AND (:checkpoint IS NULL OR COALESCE((SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant),0)=:checkpoint)`,
      {':provider':provider,':version':value.credential_version,':previous':expectedCredentialVersion,':ciphertext':value.ciphertext,
        ':fingerprint':value.credential_fingerprint,':created':value.created_at,':updated':value.updated_at,':checkpoint':expectedCheckpoint})).rowsAffected===1;
  }
  async function clearCredential(provider, expectedAccountGeneration, expectedCheckpoint=null) {
    await ensureAccount(); if (capturedGeneration!==expectedAccountGeneration) return false;
    await credentialStatus(provider);
    if(expectedCheckpoint!==null&&(!Number.isSafeInteger(expectedCheckpoint)||expectedCheckpoint<0))throw new Error('Invalid credential checkpoint');
    return (await run(`UPDATE public_provider_credentials SET generation=generation+1,nonce_counter=nonce_counter+1,
      credential_version=nonce_counter+1,ciphertext=NULL,credential_fingerprint=NULL,created_at=NULL,updated_at=NULL
      WHERE user_id=:tenant AND provider=:provider AND generation<9007199254740991 AND nonce_counter<9007199254740991 AND ${ACTIVE}
      AND (:checkpoint IS NULL OR COALESCE((SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant),0)=:checkpoint)`, {':provider':provider,':checkpoint':expectedCheckpoint})).rowsAffected===1;
  }
  const repository = {
    ...(storageAdmission?{reserveStorage,releaseStorage:storageAdmission.releaseStorage}:{}),
    userId, clock, ensureAccount, publicAccount, accountGeneration:async()=> (await ensureAccount()).generation,setCredentialFence,
    credentialStatus,reserveCredentialNonce,storeCredentialCAS,clearCredential,
    read, append:(expected,event)=>append(expected,event), records:(until)=>records(until), analyticsWalletRecords:()=>records(MAX,true),
    visitRecords:(until,visitor)=>visitRecordPages(until,visitor),
    visitOwnedScopeRecords:(until,identities,visitor)=>visitRecordPages(until,visitor,'all',ownedScopeRecordFilter(identities)),
    async dashboardSeedRecords(until) {
      const result=[];
      await visitRecordPages(until,page=>{for(const record of page)result.push(record);},'seeds');
      return result;
    },
    ownedTargetSource,findOwnedTargetSource,
    async compactCompletedDiscoveryCheckpoints(limit=25) {
      if(!positive(limit)||limit>25)throw new Error('Invalid discovery compaction bound');
      const row=await get(`SELECT e.sequence,e.job_id,e.job_json FROM public_cloud_events e JOIN
        (SELECT job_id,MAX(sequence) AS sequence FROM public_cloud_events WHERE user_id=:tenant AND job_id IS NOT NULL GROUP BY job_id) latest
        ON e.job_id=latest.job_id AND e.sequence=latest.sequence WHERE e.user_id=:tenant AND ${ACTIVE}
        AND CASE WHEN json_valid(e.job_json) THEN json_extract(e.job_json,'$.kind')='discover'
          AND json_extract(e.job_json,'$.state') IN ('complete','failed') ELSE 0 END
        AND EXISTS(SELECT 1 FROM public_cloud_events old WHERE old.user_id=:tenant AND old.job_id=e.job_id AND old.sequence<e.sequence
          AND CASE WHEN json_valid(old.job_json) THEN json_type(old.job_json,'$.${CANDIDATES}')='object' OR json_type(old.job_json,'$.candidates')='object' ELSE 0 END)
        ORDER BY e.job_id LIMIT 1`);
      if(!row)return 0;
      const jobJson=JSON.stringify(await expandedJob(row));
      // First fold the final run, then retire at most25 transient checkpoints
      // in the same UPDATE. Immutable raw responses/normalized records remain.
      // A full candidate root lets later checkpoints bypass retired deltas.
      const result=await run(`UPDATE public_cloud_events SET job_json=CASE WHEN sequence=:final THEN :job ELSE
        json_set(json_remove(job_json,'$.${CANDIDATES}','$.__public_discovery_catalog','$.candidates','$.catalog','$.batch','$.pending','$.enumeration'),
          '$.__retired_discovery_checkpoint',1) END
        WHERE user_id=:tenant AND job_id=:id AND ${ACTIVE} AND (sequence=:final OR sequence IN
          (SELECT sequence FROM public_cloud_events WHERE user_id=:tenant AND job_id=:id AND sequence<:final
            AND CASE WHEN json_valid(job_json) THEN json_type(job_json,'$.${CANDIDATES}')='object' OR json_type(job_json,'$.candidates')='object' ELSE 0 END
            ORDER BY length(CAST(job_json AS BLOB)) DESC,sequence LIMIT :limit))
        AND EXISTS(SELECT 1 FROM public_cloud_events last WHERE last.user_id=:tenant AND last.sequence=:final AND last.job_json=:previous)
        AND (length(CAST(:job AS BLOB))-length(CAST(:previous AS BLOB)))<=COALESCE((SELECT SUM(bytes) FROM
          (SELECT length(CAST(job_json AS BLOB))-length(CAST(json_set(json_remove(job_json,'$.${CANDIDATES}','$.__public_discovery_catalog','$.candidates','$.catalog','$.batch','$.pending','$.enumeration'),
            '$.__retired_discovery_checkpoint',1) AS BLOB)) AS bytes FROM public_cloud_events WHERE user_id=:tenant AND job_id=:id AND sequence<:final
            AND CASE WHEN json_valid(job_json) THEN json_type(job_json,'$.${CANDIDATES}')='object' OR json_type(job_json,'$.candidates')='object' ELSE 0 END
            ORDER BY length(CAST(job_json AS BLOB)) DESC,sequence LIMIT :limit)),0)`,
        {':id':row.job_id,':final':row.sequence,':job':jobJson,':previous':row.job_json,':limit':limit});
      return result.rowsAffected;
    },
    async event(id) {const row=await get(`SELECT sequence,records_json FROM public_cloud_events WHERE user_id=:tenant AND event_key=:id AND ${ACTIVE} LIMIT 1`,{':id':id});
      const result=await normalizedEventRecords(all,row,{scope:normalizedRecordScope(userId),generation:capturedGeneration,where:ACTIVE});await ensureAccount();return result;},
    async appendWebsite(expected,event,id,stored) {owner(id);return await append(expected,event,null,stored);},
    async giftScopeRevision() {
      const row=await get(`SELECT COALESCE(MAX(sequence),0) AS revision FROM public_cloud_events WHERE user_id=:tenant AND ${ACTIVE} AND (
        records_json LIKE '%"kind":"settings"%' OR records_json LIKE '%"kind":"portfolio"%' OR records_json LIKE '%"kind":"metadata"%'
        OR records_json LIKE '%"kind":"ownership"%' OR records_json LIKE '%"kind":"listing"%' OR records_json LIKE '%"kind":"history"%'
        OR records_json LIKE '%"kind":"development_reset"%')`);
      if(!Number.isSafeInteger(row?.revision)||row.revision<0)throw new Error('Gift scope revision unavailable');return row.revision;
    },
    async giftRefreshSession(session) {
      const records=await repository.event(giftRefreshSessionKey(session));if(!records)return null;
      const binding=records[0]?.record;
      if(binding?.session_id!==session||!positive(binding.run_id))throw new Error('Invalid saved gift refresh binding');return binding.run_id;
    },
    async giftRefreshRun(id) {
      const head=await read();
      if(head.state.gift_refresh?.run?.id===id)return head.state.gift_refresh.run;
      if(usesCompactOperationalStorage(head.state)) {
        const row=await get(`SELECT summary_json FROM public_gift_refresh_runs WHERE row_id=:row AND user_id=:tenant AND ${ACTIVE}`,{':row':key('gift-run',id)});
        return row?.summary_json?JSON.parse(row.summary_json):null;
      }
      const row=await get(`SELECT json_extract(state_json,'$.gift_refresh.run') AS run_json FROM public_cloud_events
        WHERE user_id=:tenant AND ${ACTIVE} AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.gift_refresh.run.id')=:id ELSE 0 END
        ORDER BY sequence DESC LIMIT 1`,{':id':id});return row?.run_json?JSON.parse(row.run_json):null;
    },
    async job(id) {const row=await get(`SELECT sequence,job_id,job_json FROM public_cloud_events WHERE user_id=:tenant AND job_id=:id AND job_json IS NOT NULL AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`,{':id':id});return await expandedJob(row);},
    async jobs() {const rows=await all(`SELECT e.sequence,e.job_id,e.job_json FROM public_cloud_events e JOIN
      (SELECT job_id,MAX(sequence) AS seq FROM public_cloud_events WHERE user_id=:tenant AND job_id IS NOT NULL AND job_json IS NOT NULL GROUP BY job_id) j
      ON e.sequence=j.seq WHERE e.user_id=:tenant AND ${ACTIVE} ORDER BY e.job_id DESC LIMIT 100`);const result=[];for(const row of rows)result.push(await expandedJob(row));return result;},
    async reserveWalletChallengeNonce(id) {
      owner(id); for(let i=0;i<16;i++) {
        const row=await ensureAccount(); if(!Number.isSafeInteger(row.wallet_nonce_counter)||row.wallet_nonce_counter>=MAX) return null;
        const fence=await get(`SELECT ${WALLET_DISCONNECT_REVISION} AS revision WHERE ${ACTIVE}`);
        const counter=row.wallet_nonce_counter+1;
        const updated=await run(`UPDATE public_accounts SET wallet_nonce_counter=:counter WHERE user_id=:tenant
          AND generation=:account_generation AND status='active' AND wallet_nonce_counter=:previous`,{':counter':counter,':previous':row.wallet_nonce_counter});
        if(updated.rowsAffected===1)return {generation:row.generation,counter,wallet_disconnect_revision:fence.revision};
      }return null;
    },
    async issueWalletChallenge(id,value) {
      const disconnectRevision=value?.wallet_disconnect_revision??0;
      owner(id); if(!plain(value)||typeof value.challenge_id!=='string'||value.challenge_id.length>160||typeof value.payload!=='string'||value.payload.length>256
        ||typeof value.domain!=='string'||value.domain.length>253||!positive(value.created_at)||!positive(value.expires_at)||value.expires_at<=value.created_at
        ||!Number.isSafeInteger(disconnectRevision)||disconnectRevision<0
        ||value.expires_at-value.created_at>300000)throw new Error('Invalid wallet challenge');
      // Non-secret attempts retain the cooldown across deletion/reactivation.
      await run(`DELETE FROM public_wallet_attempts WHERE user_id=:tenant AND created_at<:before AND ${ACTIVE}`,{':before':value.created_at-86400000});
      await run(`DELETE FROM public_wallet_challenges WHERE user_id=:tenant AND created_at<:before AND ${ACTIVE}`,{':before':value.created_at-86400000});
      const result=await run(`INSERT OR IGNORE INTO public_wallet_challenges(row_id,user_id,challenge_id,generation,payload,domain,wallet_disconnect_revision,wallet,created_at,expires_at,consumed_at)
        SELECT :row_id,:tenant,:id,:account_generation,:payload,:domain,:disconnect_revision,:wallet,:created,:expires,NULL WHERE ${ACTIVE}
        AND :disconnect_revision=${WALLET_DISCONNECT_REVISION}
        AND NOT EXISTS(SELECT 1 FROM public_wallet_attempts WHERE user_id=:tenant AND created_at>:cooldown)
        AND NOT EXISTS(SELECT 1 FROM public_wallet_challenges WHERE user_id=:tenant AND created_at>:cooldown)
        AND (SELECT count(*) FROM (SELECT created_at FROM public_wallet_attempts WHERE user_id=:tenant AND created_at>:hour
          UNION SELECT created_at FROM public_wallet_challenges WHERE user_id=:tenant AND created_at>:hour))<5`,
        {':row_id':key('challenge',value.challenge_id),':id':value.challenge_id,':payload':value.payload,':domain':value.domain,':wallet':value.wallet??null,':disconnect_revision':disconnectRevision,
          ':created':value.created_at,':expires':value.expires_at,':cooldown':value.created_at-60000,':hour':value.created_at-3600000});
      if(result.rowsAffected!==1)return false;
      // The challenge itself also participates in the same gate, so a crash
      // before this ledger copy cannot grant another immediate challenge.
      await run(`INSERT OR IGNORE INTO public_wallet_attempts(row_id,user_id,created_at) SELECT :row_id,:tenant,:created WHERE ${ACTIVE}`,
        {':row_id':key('challenge',value.challenge_id),':created':value.created_at});
      return true;
    },
    async consumeWalletChallenge(id,challenge,payload,at) {
      owner(id); const changed=await run(`UPDATE public_wallet_challenges SET consumed_at=:at WHERE user_id=:tenant AND challenge_id=:id
        AND payload=:payload AND generation=:account_generation AND consumed_at IS NULL AND expires_at>:at AND ${ACTIVE}
        AND wallet_disconnect_revision=${WALLET_DISCONNECT_REVISION}`,
        {':id':challenge,':payload':payload,':at':at});
      return changed.rowsAffected===1?await get(`SELECT challenge_id,payload,domain,wallet,created_at,expires_at,generation,consumed_at,wallet_disconnect_revision FROM public_wallet_challenges
        WHERE user_id=:tenant AND challenge_id=:id AND generation=:account_generation AND ${ACTIVE}
        AND wallet_disconnect_revision=${WALLET_DISCONNECT_REVISION}`,{':id':challenge}):null;
    },
    async bindVerifiedWallet(id,wallet,at,challenge) {
      owner(id); if(typeof wallet!=='string'||wallet.length>100||!positive(at))throw new Error('Invalid verified wallet');
      for(let i=0;i<16;i++) {
        const account=await publicAccount(); if(account?.wallet && account.wallet!==wallet)return false;
        const existing=await repository.event(`wallet-bind:${challenge}`); if(existing)return existing[0]?.record?.wallet===wallet && !!await get(`SELECT 1 AS valid
          FROM public_wallet_challenges WHERE user_id=:tenant AND challenge_id=:id AND generation=:account_generation AND consumed_at IS NOT NULL
          AND wallet_disconnect_revision=${WALLET_DISCONNECT_REVISION} AND ${ACTIVE}`,{':id':challenge});
        const current=await read();
        const event={key:`wallet-bind:${challenge}`,state:current.state,job:null,records:[{kind:'settings',record:{wallet,wallet_address:wallet,
          wallet_verified_at:new Date(at).toISOString(),wallet_verification:'ton_proof',wallet_challenge_id:challenge,
          wallet_disconnect_revision:account?.wallet_disconnect_revision??0}}],observed_at:new Date(at).toISOString()};
        if(await append(current.revision,event,{id:challenge,wallet,at}))return true;
        const check=await get(`SELECT 1 AS valid FROM public_wallet_challenges WHERE user_id=:tenant AND challenge_id=:id
          AND generation=:account_generation AND consumed_at IS NOT NULL AND expires_at>:at AND ${ACTIVE}
          AND wallet_disconnect_revision=${WALLET_DISCONNECT_REVISION}`,{':id':challenge,':at':at});
        if(!check)return false;
      }throw new Error('Verified wallet checkpoint contention');
    },
    async disconnectWallet() {
      for(let i=0;i<16;i++) {
        const account=await publicAccount();if(!account?.wallet)return false;
        const current=await read(),at=await clock();
        const active=value=>plain(value)&&(value.state==='running'||(positive(value.lease_until)&&value.lease_until>at));
        if(active(current.state.job)||active(current.state.owned_prices?.run)||active(current.state.public_discovery?.run)||active(current.state.gift_refresh?.run))throw new Error('Stop active updates before disconnecting wallet.');
        if(await append(current.revision,{key:`wallet-disconnect:${current.revision+1}`,state:current.state,job:null,
          records:[{kind:'settings',record:{wallet:account.wallet,wallet_address:account.wallet,wallet_verified_at:null,wallet_verification:null,
            wallet_disconnect_revision:current.revision+1}}],observed_at:new Date(at).toISOString()})) {
          await repository.clearMarketappSession(userId);return true;
        }
      }throw new Error('Wallet disconnect checkpoint contention');
    },
  };
  Object.assign(repository, analyticsMethods({get,all,run,key,owner,storage,storageAdmission,userId,capturedWalletRevision}), archiveMethods({get,all,run,key}), checkpointMethods({get,all,run,repository}));
  Object.assign(repository,createMarketappWebsiteGate(db,{scopeFor:()=>`public:${userId}`,access:async id=>{owner(id);await ensureAccount();return true;},...(websiteLimits?{limits:websiteLimits}:{})}));
  if(dashboardCache)Object.assign(repository,cacheMethods({get,all,run,key,storage,storageAdmission,userId}));
  Object.assign(repository,accountLifecycle({db,userId,key,accountRow,clock,maxAccounts,capture:()=>capturedGeneration,setCapture:value=>{capturedGeneration=value;}}));
  return repository;
}

function analyticsMethods({get,all,run,key,owner,storage,storageAdmission,userId,capturedWalletRevision}) {
  const quotaFor=(raw,normalized,dailyBytes)=>({':new_bytes':utf8Size(raw)+utf8Size(normalized)+dailyBytes,':max_account_bytes':storage.maxAccountBytes,':max_service_bytes':storage.maxServiceBytes});
  const SESSION_FENCE=`EXISTS(SELECT 1 FROM public_marketapp_analytics_sessions WHERE owner_id=:tenant
    AND generation=:generation AND ${WALLET_REVISION}=:wallet_revision AND (:version IS NULL OR cookie_version=:version))`;
  const clockSql="CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)";
  const period=alias=>`CASE WHEN json_valid(${alias}.normalized_json) THEN json_array_length(${alias}.normalized_json,'$.daily') ELSE NULL END`;
  // Only recognizable normalized captures with consistent metadata are
  // retention candidates. Unknown legacy layouts remain intact. Incoming
  // snapshots have already passed the full source normalizer at the boundary.
  const validSnapshot=alias=>`CASE WHEN json_valid(${alias}.normalized_json) THEN
    json_type(${alias}.normalized_json,'$')='object' AND json_type(${alias}.normalized_json,'$.daily')='array'
    AND json_extract(${alias}.normalized_json,'$.version')=1
    AND json_extract(${alias}.normalized_json,'$.source')='marketapp_personal_rent_page'
    AND json_extract(${alias}.normalized_json,'$.currency')='GRAM'
    AND json_extract(${alias}.normalized_json,'$.timezone')='UTC'
    AND json_extract(${alias}.normalized_json,'$.volume_basis')='gross_before_fees'
    AND json_type(${alias}.normalized_json,'$.summary')='object'
    AND ${period(alias)} BETWEEN 1 AND 366 AND length(CAST(${alias}.normalized_json AS BLOB))<=${PERSONAL_ANALYTICS_MAX_BYTES}
    AND json_extract(${alias}.normalized_json,'$.daily[0].date')=json_extract(${alias}.normalized_json,'$.period_start')
    AND json_extract(${alias}.normalized_json,'$.daily['||(${period(alias)}-1)||'].date')=json_extract(${alias}.normalized_json,'$.period_end')
    AND json_extract(${alias}.normalized_json,'$.wallet')=${alias}.wallet
    AND json_extract(${alias}.normalized_json,'$.fingerprint')=${alias}.fingerprint
    AND json_extract(${alias}.normalized_json,'$.captured_at')=${alias}.captured_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ',${alias}.captured_at)=${alias}.captured_at ELSE 0 END`;
  const payloadBytes=alias=>`length(CAST(${alias}.raw_snapshot AS BLOB))+length(CAST(${alias}.normalized_json AS BLOB))`;
  const retainedBytes=alias=>['row_id','user_id','fingerprint','wallet','captured_at','imported_at','raw_snapshot','normalized_json']
    .map(column=>`COALESCE(length(CAST(${alias}.${column} AS BLOB)),0)`).join('+');
  // Refresh confirmation joins the exact fingerprint. Keep active operations,
  // one hour of recent result replays, and the latest provider audit for each
  // wallet/period even when an unrelated browser import has a newer capture.
  const protectedSnapshot=alias=>`EXISTS(SELECT 1 FROM public_marketapp_login_attempts a
    WHERE a.user_id=:tenant AND a.wallet=${alias}.wallet AND CASE WHEN json_valid(a.outcome_json) THEN
      json_extract(a.outcome_json,'$.flow')='analytics_refresh'
      AND json_extract(a.outcome_json,'$.snapshot_fingerprint')=${alias}.fingerprint
      AND (a.expires_at>${clockSql} OR a.created_at>${clockSql}-3600000
        OR NOT EXISTS(SELECT 1 FROM public_marketapp_login_attempts newer WHERE newer.user_id=:tenant
          AND newer.wallet=a.wallet AND (newer.created_at>a.created_at OR newer.created_at=a.created_at AND newer.attempt_id>a.attempt_id)
          AND CASE WHEN json_valid(newer.outcome_json) THEN
            json_extract(newer.outcome_json,'$.flow')='analytics_refresh'
              AND json_extract(newer.outcome_json,'$.period_days')=${period(alias)}
              AND json_extract(newer.outcome_json,'$.stage') IN ('save_snapshot','complete')
              AND (json_extract(newer.outcome_json,'$.snapshot_fingerprint')=:fingerprint AND ${period(alias)}=:period
                OR EXISTS(SELECT 1 FROM public_personal_rental_analytics confirmed WHERE confirmed.user_id=:tenant
                  AND confirmed.wallet=newer.wallet AND confirmed.fingerprint=json_extract(newer.outcome_json,'$.snapshot_fingerprint')
                  AND ${validSnapshot('confirmed')} AND ${period('confirmed')}=${period(alias)})) ELSE 0 END)) ELSE 0 END)`;
  async function saveAnalytics(snapshot,raw,at,{fence=null,version=null,storageToken=null}={}) {
    const normalized=JSON.stringify(snapshot),dailyBytes=personalAnalyticsDailyReserve(snapshot,userId),quota=quotaFor(raw,normalized,dailyBytes),
      bytes=utf8Size(raw)+utf8Size(normalized)+utf8Size(key('analytics',snapshot.fingerprint))+utf8Size(snapshot.fingerprint)
        +utf8Size(snapshot.wallet)+utf8Size(snapshot.captured_at)+utf8Size(at)+utf8Size(userId)+dailyBytes,
      admission=storageAdmission?.fence(bytes,storageToken)??{sql:'1',parameters:{}},
      guard=`${ACTIVE}${capturedWalletRevision!==null?` AND ${WALLET_REVISION}=:analytics_wallet_revision`:''}${fence?` AND ${SESSION_FENCE}`:''}`,
      fenceArgs={...(capturedWalletRevision!==null?{':analytics_wallet_revision':capturedWalletRevision}:{}),
        ...(fence?{':generation':fence.generation,':wallet_revision':fence.wallet_revision,':version':version}:{})},
      args={':row_id':key('analytics',snapshot.fingerprint),':fingerprint':snapshot.fingerprint,':wallet':snapshot.wallet,
        ':captured':snapshot.captured_at,':imported':at,':raw':raw,':normalized':normalized,...quota,...admission.parameters,
        ...fenceArgs},
      span=Array.isArray(snapshot.daily)&&snapshot.daily.length>=1&&snapshot.daily.length<=366?snapshot.daily.length:null;
    const existing=()=>get(`SELECT 1 AS valid FROM public_personal_rental_analytics
      WHERE user_id=:tenant AND fingerprint=:fingerprint AND wallet=:wallet AND ${guard}`,
      {':fingerprint':snapshot.fingerprint,':wallet':snapshot.wallet,...fenceArgs});
    if(await existing())return {changed:false,valid:true};
    let changed=false;
    if(span!==null) {
      // Replace one obsolete capture atomically. Its actual bytes are deducted
      // inside both capacity fences, so a near-full account can save a newer
      // report without deleting the old report before the replacement commits.
      const replacementQuota=QUOTA.replaceAll(':new_bytes','MAX(0,:new_bytes-(SELECT payload_bytes FROM selected))'),
        replacementAdmission=admission.sql.replaceAll(':storage_bytes','MAX(0,:storage_bytes-(SELECT retained_bytes FROM selected))');
      const result=await run(`WITH selected AS MATERIALIZED(SELECT s.row_id,${payloadBytes('s')} AS payload_bytes,
          ${retainedBytes('s')} AS retained_bytes FROM public_personal_rental_analytics s
        WHERE s.user_id=:tenant AND s.wallet=:wallet AND ${validSnapshot('s')} AND ${personalAnalyticsSnapshotPreservedSQL('s',true)} AND ${period('s')}=:period
          AND (s.captured_at<:captured OR s.captured_at=:captured AND s.fingerprint<:fingerprint)
          AND NOT ${protectedSnapshot('s')} ORDER BY payload_bytes DESC,s.captured_at,s.fingerprint LIMIT 1)
        UPDATE OR IGNORE public_personal_rental_analytics SET row_id=:row_id,fingerprint=:fingerprint,wallet=:wallet,
          captured_at=:captured,imported_at=:imported,raw_snapshot=:raw,normalized_json=:normalized
        WHERE user_id=:tenant AND row_id=(SELECT row_id FROM selected) AND ${guard} AND ${personalAnalyticsDailyReadySQL(true)}
          AND ${replacementQuota} AND ${replacementAdmission}
          AND NOT EXISTS(SELECT 1 FROM public_personal_rental_analytics duplicate WHERE duplicate.user_id=:tenant AND duplicate.fingerprint=:fingerprint)`,
        {...args,':period':span});
      changed=result.rowsAffected===1;
    }
    if(!changed) {
      const result=await run(`INSERT OR IGNORE INTO public_personal_rental_analytics(row_id,user_id,fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json)
        SELECT :row_id,:tenant,:fingerprint,:wallet,:captured,:imported,:raw,:normalized WHERE ${guard} AND ${QUOTA} AND ${admission.sql}`,args);
      changed=result.rowsAffected===1;
    }
    const valid=changed||!!await existing();
    if(!valid) {
      if(storageAdmission)await storageAdmission.assertAdmitted(bytes,storageToken);
      if(await get(`SELECT 1 AS limited WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM public_personal_rental_analytics
        WHERE user_id=:tenant AND fingerprint=:fingerprint) AND NOT(${QUOTA})`,
        {':fingerprint':snapshot.fingerprint,...quota,...fenceArgs}))throw new PublicStorageLimitError();
      return {changed:false,valid:false};
    }
    if(span!==null) {
      // Cleanup is secondary: failure cannot erase a successfully saved report.
      // Recheck the saved row, identity/session fences and reference protection
      // in the DELETE itself. Concurrent logout/rebind or a newer replacement
      // therefore cannot let this stale worker prune another report.
      try {await run(`DELETE FROM public_personal_rental_analytics WHERE user_id=:tenant AND ${guard} AND ${personalAnalyticsDailyReadySQL(true)}
        AND row_id IN(SELECT s.row_id FROM public_personal_rental_analytics s WHERE s.user_id=:tenant AND s.wallet=:wallet
          AND ${validSnapshot('s')} AND ${personalAnalyticsSnapshotPreservedSQL('s',true)} AND ${period('s')}=:period AND s.fingerprint<>:fingerprint
          AND NOT ${protectedSnapshot('s')} AND EXISTS(SELECT 1 FROM public_personal_rental_analytics newer
            WHERE newer.user_id=:tenant AND newer.wallet=s.wallet AND ${validSnapshot('newer')}
              AND ${period('newer')}=${period('s')} AND (newer.captured_at>s.captured_at
                OR newer.captured_at=s.captured_at AND newer.fingerprint>s.fingerprint)) ORDER BY s.captured_at,s.fingerprint LIMIT 25)
        AND EXISTS(SELECT 1 FROM public_personal_rental_analytics saved WHERE saved.user_id=:tenant
          AND saved.fingerprint=:fingerprint AND saved.wallet=:wallet AND saved.normalized_json=:normalized)`,
        {':wallet':snapshot.wallet,':fingerprint':snapshot.fingerprint,':normalized':normalized,':period':span,
          ...fenceArgs});}catch{/* Saved replacement remains usable; a later import resumes bounded cleanup. */}
    }
    return {changed,valid};
  }
  async function sessionFence(id) {
    owner(id); await run(`INSERT OR IGNORE INTO public_marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version)
      SELECT :tenant,0,0,0 WHERE ${ACTIVE}`);
    return await get(`SELECT generation,cookie_version,${WALLET_REVISION} AS wallet_revision FROM public_marketapp_analytics_sessions WHERE owner_id=:tenant AND ${ACTIVE}`);
  }
  return {
    async importPersonalAnalytics(snapshot,raw,at,storageToken=null) {
      return (await saveAnalytics(snapshot,raw,at,{storageToken})).changed;
    },
    async marketappSession(id) {owner(id);return await get(`SELECT owner_id,generation,nonce_counter,cookie_version,wallet,wallet_revision,ciphertext,created_at,expires_at
      FROM public_marketapp_analytics_sessions WHERE owner_id=:tenant AND ${ACTIVE}`);},
    marketappSessionFence:sessionFence,
    async marketappSessionIsCurrent(id,fence,version=null) {
      owner(id);return !!await get(`SELECT 1 AS valid WHERE ${SESSION_FENCE} AND ${ACTIVE}`,
        {':generation':fence.generation,':wallet_revision':fence.wallet_revision,':version':version});
    },
    async reserveMarketappSessionNonce(id,generation) {
      owner(id);for(let i=0;i<16;i++) {
        const row=await get(`SELECT nonce_counter FROM public_marketapp_analytics_sessions WHERE owner_id=:tenant AND generation=:generation AND ${ACTIVE}`,{':generation':generation});
        if(!row||!Number.isSafeInteger(row.nonce_counter)||row.nonce_counter<0||row.nonce_counter>=MAX)return null;
        const counter=row.nonce_counter+1;
        if((await run(`UPDATE public_marketapp_analytics_sessions SET nonce_counter=:counter WHERE owner_id=:tenant AND generation=:generation
          AND nonce_counter=:previous AND ${ACTIVE}`,{':generation':generation,':previous':row.nonce_counter,':counter':counter})).rowsAffected===1)return counter;
      }return null;
    },
    async storeMarketappSession(id,fence,session,previous) {
      owner(id);return (await run(`UPDATE public_marketapp_analytics_sessions SET wallet=:wallet,wallet_revision=:wallet_revision,
        ciphertext=:ciphertext,created_at=:created,expires_at=:expires,cookie_version=:version WHERE owner_id=:tenant
        AND generation=:generation AND cookie_version=:previous AND nonce_counter>=:version AND :version>:previous
        AND ${WALLET_REVISION}=:wallet_revision AND ${ACTIVE}`,{':generation':fence.generation,':wallet_revision':fence.wallet_revision,
          ':previous':previous,':version':session.cookie_version,':wallet':session.wallet,':ciphertext':session.ciphertext,':created':session.created_at,':expires':session.expires_at})).rowsAffected===1;
    },
    async clearMarketappSession(id,fence=null,version=null) {
      owner(id);await sessionFence(id);
      return (await run(`UPDATE public_marketapp_analytics_sessions SET generation=generation+1,wallet=NULL,wallet_revision=NULL,
        ciphertext=NULL,created_at=NULL,expires_at=NULL WHERE owner_id=:tenant AND generation<9007199254740991
        AND (:generation IS NULL OR generation=:generation) AND (:version IS NULL OR cookie_version=:version)
        AND (:captured_wallet_revision IS NULL OR ${WALLET_REVISION}=:captured_wallet_revision) AND ${ACTIVE}`,
        {':generation':fence?.generation??null,':version':version,':captured_wallet_revision':capturedWalletRevision})).rowsAffected===1;
    },
    async importPersonalAnalyticsFenced(snapshot,raw,at,id,fence,version=null,storageToken=null) {
      owner(id);return (await saveAnalytics(snapshot,raw,at,{fence,version,storageToken})).valid;
    },
    async latestPersonalAnalytics(wallet) {const row=await get(`SELECT normalized_json,CASE WHEN json_valid(normalized_json) AND (json_type(normalized_json,'$.top_items') IS NULL OR json_type(normalized_json,'$.by_collection') IS NULL)
        AND length(CAST(raw_snapshot AS BLOB))<=262144 THEN raw_snapshot ELSE NULL END AS raw_snapshot FROM public_personal_rental_analytics
      WHERE user_id=:tenant AND wallet=:wallet AND ${ACTIVE} ORDER BY captured_at DESC,fingerprint DESC LIMIT 1`,{':wallet':wallet});return row?upgradePersonalAnalyticsTopItems(row):null;},
    async personalAnalyticsSnapshots(wallet) {const rows=await all(`WITH periods AS (SELECT normalized_json,captured_at,fingerprint,
      CASE WHEN json_valid(normalized_json) THEN json_array_length(normalized_json,'$.daily') ELSE NULL END AS period_days
      FROM public_personal_rental_analytics WHERE user_id=:tenant AND wallet=:wallet AND length(CAST(normalized_json AS BLOB))<=131072 AND ${ACTIVE}),
      ranked AS (SELECT normalized_json,captured_at,fingerprint,ROW_NUMBER() OVER(PARTITION BY period_days ORDER BY captured_at DESC,fingerprint DESC) AS ordinal
        FROM periods WHERE period_days BETWEEN 1 AND 366)
      SELECT normalized_json FROM ranked WHERE ordinal=1 ORDER BY captured_at DESC,fingerprint DESC LIMIT 8`,{':wallet':wallet});
      const result=[];
      for(const row of rows) {
        const saved=upgradePersonalAnalyticsTopItems(row);
        if(saved&&(!Object.hasOwn(saved,'top_items')||!Object.hasOwn(saved,'by_collection'))) {
          const raw=await get(`SELECT raw_snapshot FROM public_personal_rental_analytics WHERE user_id=:tenant AND wallet=:wallet
            AND fingerprint=:fingerprint AND length(CAST(raw_snapshot AS BLOB))<=262144 AND ${ACTIVE}`,{':wallet':wallet,':fingerprint':saved.fingerprint});
          result.push(upgradePersonalAnalyticsTopItems({...row,raw_snapshot:raw?.raw_snapshot}));
        }else result.push(saved);
      }
      return result;}
,
    async personalAnalyticsAllTime(wallet) {
      return readPersonalAnalyticsAllTime(all,wallet,{publicScope:true,active:ACTIVE});
    },
    async reserveMarketappLoginAttempt(value,limits) {
      owner(value.owner);await run(`DELETE FROM public_marketapp_login_attempts WHERE user_id=:tenant AND created_at<:before AND ${ACTIVE}`,{':before':value.created-86400000});
      return (await run(`INSERT OR IGNORE INTO public_marketapp_login_attempts(row_id,user_id,attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint)
        SELECT :row_id,:tenant,:id,:tenant,:wallet,:created,:expires,'pending',NULL WHERE ${ACTIVE}
        AND NOT EXISTS(SELECT 1 FROM public_marketapp_login_attempts WHERE user_id=:tenant AND created_at>:cooldown)
        AND (SELECT count(*) FROM public_marketapp_login_attempts WHERE user_id=:tenant AND created_at>:hour)<:limit`,
        {':row_id':key('login',value.id),':id':value.id,':wallet':value.wallet,':created':value.created,':expires':value.expires,
          ':cooldown':value.created-limits.cooldown_ms,':hour':value.created-3600000,':limit':limits.hourly_attempts})).rowsAffected===1;
    },
    async issueMarketappLoginAttempt(id,user,wallet,fingerprint,at) {owner(user);return (await run(`UPDATE public_marketapp_login_attempts SET nonce_fingerprint=:fingerprint,state='issued'
      WHERE user_id=:tenant AND attempt_id=:id AND wallet=:wallet AND state='pending' AND expires_at>:at AND ${ACTIVE}`,
      {':id':id,':wallet':wallet,':fingerprint':fingerprint,':at':at})).rowsAffected===1;},
    async marketappLoginRetry(user,at,limits) {
      owner(user);const rows=await all(`SELECT created_at FROM public_marketapp_login_attempts WHERE user_id=:tenant AND created_at>:hour AND ${ACTIVE}
        ORDER BY created_at DESC LIMIT :limit`,{':hour':at-3600000,':limit':limits.hourly_attempts});if(!rows.length)return null;
      const cooldown=rows[0].created_at+limits.cooldown_ms,hour=rows.length>=limits.hourly_attempts?rows[limits.hourly_attempts-1].created_at+3600000:0,retry=Math.max(cooldown,hour);
      return retry>at?{retry_at:new Date(retry).toISOString(),retry_after_seconds:Math.ceil((retry-at)/1000),reason:hour>=cooldown?'hourly':'cooldown'}:null;
    },
    async marketappLoginAttempt(id,user) {owner(user);return await get(`SELECT attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint
      FROM public_marketapp_login_attempts WHERE user_id=:tenant AND attempt_id=:id AND ${ACTIVE}`,{':id':id});},
    async consumeMarketappLoginAttempt(id,user,wallet,at) {owner(user);return (await run(`UPDATE public_marketapp_login_attempts SET state='consumed'
      WHERE user_id=:tenant AND attempt_id=:id AND wallet=:wallet AND state='issued' AND expires_at>:at AND ${ACTIVE}`,{':id':id,':wallet':wallet,':at':at})).rowsAffected===1;},
    async recordMarketappLoginOutcome(id,user,value) {
      owner(user);const names=['wallet_matches','mainnet','domain_matches','challenge_matches','timestamp_fresh','signature_present'];
      if(!plain(value)||Object.keys(value).length!==3||Object.keys(value).some(name=>!['compatible','checks','finished_at'].includes(name))
        ||!plain(value.checks)||Object.keys(value.checks).length!==names.length||Object.keys(value.checks).some(name=>!names.includes(name))
        ||names.some(name=>typeof value.checks[name]!=='boolean')||typeof value.compatible!=='boolean'||value.compatible!==names.every(name=>value.checks[name])
        ||typeof value.finished_at!=='string'||value.finished_at.length>32||!Number.isFinite(Date.parse(value.finished_at))||new Date(value.finished_at).toISOString()!==value.finished_at)throw new Error('Invalid connection-test diagnostic');
      const safe={compatible:value.compatible,checks:Object.fromEntries(names.map(name=>[name,value.checks[name]])),finished_at:value.finished_at};
      return (await run(`UPDATE public_marketapp_login_attempts SET outcome_json=:outcome WHERE user_id=:tenant AND attempt_id=:id AND state='consumed'
        AND outcome_json IS NULL AND ${ACTIVE}`,{':id':id,':outcome':JSON.stringify(safe)})).rowsAffected===1;
    },
    async recordMarketappRefreshOutcome(id,user,value) {
      owner(user);const safe=safeMarketappRefreshOutcome(value);if(!safe)throw new Error('Invalid analytics-refresh diagnostic');
      return (await run(`UPDATE public_marketapp_login_attempts SET outcome_json=:outcome WHERE user_id=:tenant AND attempt_id=:id AND ${ACTIVE}
        AND ((:state='awaiting_approval' AND state='issued') OR (:state IN ('updating','saved') AND state='consumed') OR (:state='failed' AND state IN ('cancelled','consumed')))
        AND (outcome_json IS NULL OR (json_valid(outcome_json) AND json_extract(outcome_json,'$.flow')='analytics_refresh'
          AND json_extract(outcome_json,'$.state') IN ('awaiting_approval','updating') AND json_extract(outcome_json,'$.observed_at')<=:observed))`,
        {':id':id,':state':safe.state,':observed':safe.observed_at,':outcome':JSON.stringify(safe)})).rowsAffected===1;
    },
    async latestMarketappRefreshAttempt(user,wallet,periodDays=null) {owner(user);return await get(`SELECT a.attempt_id,a.state,a.created_at,a.expires_at,a.outcome_json,s.imported_at AS saved_at,
        s.captured_at AS snapshot_captured_at
      FROM public_marketapp_login_attempts a LEFT JOIN public_personal_rental_analytics s ON s.user_id=a.user_id AND s.wallet=a.wallet
        AND s.fingerprint=CASE WHEN json_valid(a.outcome_json) THEN json_extract(a.outcome_json,'$.snapshot_fingerprint') ELSE NULL END
      WHERE a.user_id=:tenant AND a.wallet=:wallet AND CASE WHEN json_valid(a.outcome_json)
        THEN json_extract(a.outcome_json,'$.flow')='analytics_refresh'
          AND (:period IS NULL OR json_extract(a.outcome_json,'$.period_days')=:period)
        ELSE :period IS NOT NULL END
        AND ${ACTIVE} ORDER BY a.created_at DESC,a.attempt_id DESC LIMIT 1`,{':wallet':wallet,':period':periodDays});},
    async pendingMarketappRefreshAttempt(user,wallet,at) {owner(user);return await get(`SELECT attempt_id,state,created_at,expires_at
      FROM public_marketapp_login_attempts WHERE user_id=:tenant AND wallet=:wallet AND created_at<=:at AND expires_at>:at
        AND state IN ('pending','issued','consumed') AND CASE WHEN json_valid(outcome_json)
          THEN json_extract(outcome_json,'$.state') IN ('awaiting_approval','updating') ELSE 1 END
        AND ${ACTIVE} ORDER BY created_at DESC LIMIT 1`,{':wallet':wallet,':at':at});},
    async cancelMarketappLoginAttempt(id,user) {owner(user);await run(`UPDATE public_marketapp_login_attempts SET state='cancelled'
      WHERE user_id=:tenant AND attempt_id=:id AND state IN ('pending','issued') AND ${ACTIVE}`,{':id':id});},
  };
}

function archiveMethods({get,all,run,key}) {
  const names=['id','state','total','checked','updated','unresolved','status_updated','status_unresolved','reason','started_at','completed_at','scope','nft_address','wallet','session_id'];
  const projection=`sequence,json_remove(json_extract(state_json,'$.owned_prices.run'),'$.targets','$.pending') AS run_json,
    json_extract(state_json,'$.owned_prices.previous_run') AS previous_json,json_extract(state_json,'$.owned_prices.last_session') AS session_json`;
  async function indexOwn(own,sequence) {
    if(!plain(own))return;
    const runs=new Map(),sessions=new Map();
    for(const value of [...(Array.isArray(own.history)?own.history:[]),own.previous_run,own.run]) {
      if(!plain(value)||!positive(value.id)||runs.has(value.id))continue;
      runs.set(value.id,JSON.stringify(Object.fromEntries(names.filter(name=>Object.hasOwn(value,name)).map(name=>[name,value[name]]))));
    }
    if(runs.size) {
      const args={':sequence':sequence},values=[];
      [...runs].forEach(([id,summary],i)=>{args[`:row${i}`]=key('run',id);args[`:id${i}`]=id;args[`:summary${i}`]=summary;values.push(`(:row${i},:id${i},:summary${i})`);});
      await run(`WITH rows(row_id,run_id,summary_json) AS(VALUES ${values.join(',')})
        INSERT INTO public_owned_refresh_runs(row_id,user_id,run_id,summary_json,source_sequence)
        SELECT row_id,:tenant,run_id,summary_json,:sequence FROM rows WHERE ${ACTIVE} ON CONFLICT(row_id) DO UPDATE
        SET summary_json=excluded.summary_json,source_sequence=excluded.source_sequence
        WHERE excluded.source_sequence>public_owned_refresh_runs.source_sequence`,args);
    }
    for(const value of [...(Array.isArray(own.sessions)?own.sessions:[]),own.last_session]) {
      if(!plain(value)||typeof value.id!=='string'||!/^[A-Za-z0-9._:-]{16,160}$/.test(value.id)||!positive(value.run_id))continue;
      if(sessions.has(value.id)&&sessions.get(value.id)!==value.run_id)throw new Error('Conflicting saved refresh session');sessions.set(value.id,value.run_id);
    }
    if(sessions.size) {
      const args={':sequence':sequence},lookup={},values=[],ids=[];
      [...sessions].forEach(([id,idRun],i)=>{args[`:row${i}`]=key('session',id);args[`:id${i}`]=id;args[`:run${i}`]=idRun;lookup[`:id${i}`]=id;values.push(`(:row${i},:id${i},:run${i})`);ids.push(`:id${i}`);});
      await run(`WITH rows(row_id,session_id,run_id) AS(VALUES ${values.join(',')}) INSERT OR IGNORE INTO public_owned_refresh_sessions(row_id,user_id,session_id,run_id,source_sequence)
        SELECT row_id,:tenant,session_id,run_id,:sequence FROM rows WHERE ${ACTIVE}`,args);
      const mapped=await all(`SELECT session_id,run_id FROM public_owned_refresh_sessions WHERE user_id=:tenant AND session_id IN(${ids.join(',')}) AND ${ACTIVE}`,lookup);
      if(mapped.length!==sessions.size||mapped.some(row=>sessions.get(row.session_id)!==row.run_id))throw new Error('Conflicting saved refresh session');
    }
  }
  async function indexRow(row) {const read=value=>value==null?null:JSON.parse(value);await indexOwn({run:read(row.run_json),previous_run:read(row.previous_json),last_session:read(row.session_json)},row.sequence);}
  async function advance(sequence) {await run(`UPDATE public_owned_refresh_index SET sequence=MAX(sequence,:sequence) WHERE user_id=:tenant AND ${ACTIVE}`,{':sequence':sequence});}
  async function sync() {
    await run(`INSERT OR IGNORE INTO public_owned_refresh_index(user_id,sequence) SELECT :tenant,0 WHERE ${ACTIVE}`);
    let after=(await get(`SELECT sequence FROM public_owned_refresh_index WHERE user_id=:tenant AND ${ACTIVE}`))?.sequence;
    const head=await get(`SELECT sequence,json_extract(state_json,'$.operational_storage_version') AS mode,
      (SELECT sequence FROM public_owned_refresh_index WHERE user_id=:tenant) AS watermark FROM public_cloud_events
      WHERE user_id=:tenant AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`);
    const boundary=head?.sequence??0;
    if(head?.mode===1) {
      if(head.watermark!==boundary)throw new Error('Compact refresh archive is incomplete');
      return;
    }
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(boundary)||boundary<after)throw new Error('Invalid refresh archive checkpoint');
    if(after===0) {
      const legacy=await get(`SELECT ${projection},json_array_length(state_json,'$.owned_prices.history') AS history_count,
        json_array_length(state_json,'$.owned_prices.sessions') AS sessions_count FROM public_cloud_events WHERE user_id=:tenant AND sequence<=:boundary
        AND json_valid(state_json) AND json_extract(state_json,'$.owned_prices.version')=1 AND ${ACTIVE} ORDER BY sequence DESC LIMIT 1`,{':boundary':boundary});
      if(legacy) {
        await indexRow(legacy);
        for(const field of ['history','sessions']) {
          const count=legacy[`${field}_count`]??0;if(!Number.isSafeInteger(count)||count<0)throw new Error('Invalid legacy refresh archive');
          for(let offset=0;offset<count;offset+=100) {
            const entries=await all(`WITH RECURSIVE offsets(ordinal) AS(SELECT CAST(:offset AS INTEGER) UNION ALL SELECT ordinal+1 FROM offsets WHERE ordinal+1<:end)
              SELECT json_extract(state_json,:path||'['||ordinal||']') AS entry_json FROM public_cloud_events,offsets
              WHERE user_id=:tenant AND sequence=:sequence AND ${ACTIVE} ORDER BY ordinal`,
              {':offset':offset,':end':Math.min(count,offset+100),':path':`$.owned_prices.${field}`,':sequence':legacy.sequence});
            await indexOwn({[field]:entries.map(value=>value.entry_json===null?null:JSON.parse(value.entry_json))},legacy.sequence);
          }
        }await advance(legacy.sequence);after=legacy.sequence;
      }
    }
    for(;;) {
      const rows=await all(`WITH pending AS(SELECT e.sequence,e.state_json FROM public_cloud_events e LEFT JOIN public_cloud_events p
        ON p.user_id=e.user_id AND p.sequence=e.sequence-1 WHERE e.user_id=:tenant AND e.sequence>:after AND e.sequence<=:boundary AND ${ACTIVE}
        AND (e.event_key LIKE 'owned-price:%' OR COALESCE(json_remove(json_extract(e.state_json,'$.owned_prices'),'$.run.targets'),'null')
          <>COALESCE(json_remove(json_extract(p.state_json,'$.owned_prices'),'$.run.targets'),'null')) ORDER BY e.sequence LIMIT 20)
        SELECT ${projection} FROM pending ORDER BY sequence`,{':after':after,':boundary':boundary});
      if(!rows.length){await advance(boundary);return;}
      for(const row of rows){await indexRow(row);after=row.sequence;}await advance(after);
    }
  }
  return {syncOwnedRefreshArchive:sync,
    async ownedRefreshRun(id) {await sync();const row=await get(`SELECT summary_json FROM public_owned_refresh_runs WHERE user_id=:tenant AND run_id=:id AND ${ACTIVE}`,{':id':id});return row?JSON.parse(row.summary_json):null;},
    async ownedRefreshSession(id) {await sync();const row=await get(`SELECT run_id FROM public_owned_refresh_sessions WHERE user_id=:tenant AND session_id=:id AND ${ACTIVE}`,{':id':id});return row?.run_id??null;},
  };
}

function checkpointMethods({get,all,run,repository}) {
  async function page(after,boundary) {return await all(`WITH pending AS(SELECT ${TARGETS},length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB)) AS target_bytes
    FROM public_cloud_events WHERE user_id=:tenant AND sequence>:after AND sequence<:boundary AND ${INLINE} AND ${ACTIVE}
    AND length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB))>64 ORDER BY sequence LIMIT 25),
    bounded AS(SELECT *,SUM(target_bytes) OVER(ORDER BY sequence) AS total_bytes FROM pending)
    SELECT sequence,run_id,wallet,targets_json,target_bytes FROM bounded WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`,{':after':after,':boundary':boundary});}
  async function root(row) {return await repository.findOwnedTargetSource({id:row.run_id,wallet:row.wallet,targets:JSON.parse(row.targets_json)},row.sequence);}
  let scanBoundary=null,scanAfter=0;
  return {
    async checkpointStorageStats() {return await get(`SELECT count(*) AS events,COALESCE(SUM(length(CAST(state_json AS BLOB))),0) AS state_bytes,
      COALESCE(SUM(CASE WHEN ${COMPACTABLE_CHECKPOINT} THEN length(CAST(job_json AS BLOB)) ELSE 0 END),0) AS duplicate_job_bytes,
      COALESCE(SUM(CASE WHEN ${COMPACTABLE_CHECKPOINT} THEN 1 ELSE 0 END),0) AS compactable,COALESCE(MAX(sequence),0) AS boundary
      FROM public_cloud_events WHERE user_id=:tenant AND ${ACTIVE}`);},
    async compactCheckpointJobs(boundary,limit=100) {
      if(!positive(boundary)||!positive(limit)||limit>100)throw new Error('Invalid checkpoint compaction bound');
      return (await run(`UPDATE public_cloud_events SET state_json=json_set(json_remove(state_json,'$.job'),'$.__checkpoint_job_sequence',sequence)
        WHERE user_id=:tenant AND ${ACTIVE} AND sequence IN(SELECT sequence FROM public_cloud_events WHERE user_id=:tenant
          AND sequence<:boundary AND sequence<(SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant) AND ${COMPACTABLE_CHECKPOINT}
          ORDER BY sequence LIMIT :limit) AND ${COMPACTABLE_CHECKPOINT}`,{':boundary':boundary,':limit':limit})).rowsAffected;
    },
    async ownedTargetStorageStats() {
      const boundary=(await get(`SELECT COALESCE(MAX(sequence),0) AS boundary FROM public_cloud_events WHERE user_id=:tenant AND ${ACTIVE}`)).boundary;
      let after=0,duplicate_target_bytes=0,target_compactable=0;
      for(;;){const rows=await page(after,boundary);if(!rows.length)return {boundary,duplicate_target_bytes,target_compactable};
        for(const row of rows)if(await root(row)){duplicate_target_bytes+=row.target_bytes;target_compactable++;}after=rows.at(-1).sequence;}
    },
    async compactCheckpointOwnedTargets(boundary,limit=100) {
      if(!positive(boundary)||!positive(limit)||limit>100)throw new Error('Invalid owned-target compaction bound');
      if(scanBoundary!==boundary){scanBoundary=boundary;scanAfter=0;}let after=scanAfter;const selected=[];
      scan:for(;;){const rows=await page(after,boundary);if(!rows.length)break;for(const row of rows){after=row.sequence;const source=await root(row);
        if(source)selected.push({sequence:row.sequence,source:source.sequence});if(selected.length>=limit)break scan;}}
      if(!selected.length){scanAfter=after;return 0;}
      const args={':boundary':boundary},cases=[],ids=[];selected.forEach((value,i)=>{args[`:seq${i}`]=value.sequence;args[`:source${i}`]=value.source;cases.push(`WHEN :seq${i} THEN :source${i}`);ids.push(`:seq${i}`);});
      const result=await run(`UPDATE public_cloud_events SET state_json=json_set(json_remove(state_json,'$.owned_prices.run.targets'),
        '$.__checkpoint_owned_targets_sequence',CASE sequence ${cases.join(' ')} END) WHERE user_id=:tenant AND ${ACTIVE}
        AND sequence IN(${ids.join(',')}) AND sequence<:boundary AND sequence<(SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant) AND ${INLINE}`,args);
      scanAfter=after;return result.rowsAffected;
    },
  };
}

function digest(value) {
  const bytes=new Uint8Array(utf8Size(value));let at=0;
  for(const char of value){const code=char.codePointAt(0);if(code<128)bytes[at++]=code;else if(code<2048){bytes[at++]=192|code>>6;bytes[at++]=128|code&63;}
    else if(code<65536){bytes[at++]=224|code>>12;bytes[at++]=128|code>>6&63;bytes[at++]=128|code&63;}
    else {bytes[at++]=240|code>>18;bytes[at++]=128|code>>12&63;bytes[at++]=128|code>>6&63;bytes[at++]=128|code&63;}}
  return Array.from(sha256(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function cacheMethods({get,run,key,storage,storageAdmission,userId}) {
  const ROW=262144,SNAPSHOT=4194304,TENANT=6291456,GLOBAL=16777216;
  const accountLimit=Math.max(0,storage.maxAccountBytes-(storageAdmission?PUBLIC_COLLECTION_HEADROOM_BYTES:0));
  const quotaFor=bytes=>({':new_bytes':bytes,':max_account_bytes':accountLimit,':max_service_bytes':storage.maxServiceBytes});
  async function prune(limit,tenantOnly) {
    // Eviction touches only replaceable data. Each tenant has a byte cap and
    // manifests are scoped; the shared cap prevents per-user multiplication.
    await run(`DELETE FROM public_dashboard_projection_cache WHERE row_id IN(SELECT row_id FROM(SELECT row_id,
      SUM(length(CAST(snapshot_json AS BLOB))) OVER(ORDER BY time_bucket DESC,records_revision DESC,row_id) AS bytes,
      ROW_NUMBER() OVER(ORDER BY time_bucket DESC,records_revision DESC,row_id) AS ordinal
      FROM public_dashboard_projection_cache WHERE (:own=0 OR user_id=:tenant)) WHERE bytes>:limit OR ordinal>2048) AND ${ACTIVE}`,{':own':tenantOnly?1:0,':limit':limit});
  }
  return {
    async dashboardRevision() {return await get(`SELECT
      (SELECT COALESCE(MAX(sequence),0) FROM public_cloud_events WHERE user_id=:tenant) AS state_revision,
      (SELECT COALESCE(MAX(sequence),0) FROM public_cloud_events WHERE user_id=:tenant AND records_json<>'[]') AS records_revision,
      (SELECT count(*) FROM public_personal_rental_analytics WHERE user_id=:tenant) AS analytics_count,
      (SELECT COALESCE(MAX(imported_at),'') FROM public_personal_rental_analytics WHERE user_id=:tenant) AS analytics_updated WHERE ${ACTIVE}`);},
    async dashboardSnapshot(id,revision,bucket,{startup=false}={}) {
      const row=await get(`SELECT snapshot_json FROM public_dashboard_projection_cache WHERE user_id=:tenant AND selection_key=:id
        AND records_revision=:revision AND time_bucket BETWEEN :minimum_bucket AND :bucket AND length(CAST(snapshot_json AS BLOB))<=1024 AND ${ACTIVE}`,{':id':'m:'+id,':revision':revision,':bucket':bucket,':minimum_bucket':startup?bucket-1440:bucket});
      if(!row)return null;let value;try{value=JSON.parse(row.snapshot_json);}catch{return null;}
      if(value.version!==2||!/^[0-9a-f]{64}$/.test(value.hash)||!positive(value.parts)||value.parts>18||!positive(value.bytes)||value.bytes>SNAPSHOT)return null;
      const parts=[];let bytes=0;
      for(let i=0;i<value.parts;i++) {const part=await get(`SELECT snapshot_json FROM public_dashboard_projection_cache WHERE user_id=:tenant
        AND selection_key=:id AND length(CAST(snapshot_json AS BLOB))<=262144 AND ${ACTIVE}`,{':id':`p:${value.hash}:${i}`});
        if(typeof part?.snapshot_json!=='string')return null;bytes+=utf8Size(part.snapshot_json);if(bytes>SNAPSHOT)return null;parts.push(part.snapshot_json);}
      const body=parts.join('');return bytes===value.bytes&&digest(body)===value.hash?JSON.parse(body):null;
    },
    async saveDashboardSnapshot(id,revision,bucket,snapshot) {
      const body=JSON.stringify(snapshot),bytes=utf8Size(body);if(bytes>SNAPSHOT)return;
      const usage=await get(`SELECT (${ACCOUNT_BYTES})-COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB)))
        FROM public_dashboard_projection_cache WHERE user_id=:tenant),0) AS retained_bytes WHERE ${ACTIVE}`);
      const tenantLimit=Math.max(0,Math.min(TENANT,accountLimit-(usage?.retained_bytes??accountLimit)));
      if(bytes+1024>tenantLimit){await prune(tenantLimit,true);return;}
      const parts=[];let start=0,offset=0,partBytes=0;
      for(const char of body){const size=utf8Size(char);if(partBytes+size>ROW){parts.push(body.slice(start,offset));start=offset;partBytes=0;}partBytes+=size;offset+=char.length;}parts.push(body.slice(start));
      const hash=digest(body);await prune(tenantLimit-bytes-1024,true);await prune(GLOBAL-bytes-1024,false);
      for(let i=0;i<parts.length;i++) {
        const partId=`p:${hash}:${i}`,admissionBytes=utf8Size(parts[i])+utf8Size(key('cache',partId))+utf8Size(partId)+utf8Size(userId)
          +utf8Size(String(revision))+utf8Size(String(bucket)),admission=storageAdmission?.fence(admissionBytes)??{sql:'1',parameters:{}};
        const partResult=await run(`INSERT OR IGNORE INTO public_dashboard_projection_cache(row_id,user_id,selection_key,records_revision,time_bucket,snapshot_json)
        SELECT :row_id,:tenant,:id,:revision,:bucket,:snapshot WHERE ${ACTIVE}
        AND ${QUOTA}
        AND ${admission.sql}
        AND (SELECT COALESCE(SUM(length(CAST(snapshot_json AS BLOB))),0) FROM public_dashboard_projection_cache)+:bytes<=16777216
        AND (SELECT COALESCE(SUM(length(CAST(snapshot_json AS BLOB))),0) FROM public_dashboard_projection_cache WHERE user_id=:tenant)+:bytes<=6291456
        AND (SELECT count(*) FROM public_dashboard_projection_cache)<2048`,{':row_id':key('cache',partId),':id':partId,
          ':revision':revision,':bucket':bucket,':snapshot':parts[i],':bytes':utf8Size(parts[i]),...quotaFor(utf8Size(parts[i])),...admission.parameters});
        if(partResult.rowsAffected!==1&&!await get(`SELECT 1 AS valid FROM public_dashboard_projection_cache WHERE user_id=:tenant
          AND row_id=:row_id AND snapshot_json=:snapshot AND ${ACTIVE}`,{':row_id':key('cache',partId),':snapshot':parts[i]}))return;
      }
      const manifest=JSON.stringify({version:2,hash,parts:parts.length,bytes}),manifestId='m:'+id,
        admissionBytes=utf8Size(manifest)+utf8Size(key('cache',manifestId))+utf8Size(manifestId)+utf8Size(userId)
          +utf8Size(String(revision))+utf8Size(String(bucket)),admission=storageAdmission?.fence(admissionBytes)??{sql:'1',parameters:{}};
      await run(`INSERT INTO public_dashboard_projection_cache(row_id,user_id,selection_key,records_revision,time_bucket,snapshot_json)
        SELECT :row_id,:tenant,:id,:revision,:bucket,:snapshot WHERE ${ACTIVE}
        AND ${QUOTA}
        AND ${admission.sql}
        AND (SELECT COALESCE(SUM(length(CAST(snapshot_json AS BLOB))),0) FROM public_dashboard_projection_cache)
          -COALESCE((SELECT length(CAST(snapshot_json AS BLOB)) FROM public_dashboard_projection_cache WHERE row_id=:row_id),0)+1024<=16777216
        AND (SELECT count(*) FROM public_dashboard_projection_cache)<2048
        ON CONFLICT(row_id) DO UPDATE SET records_revision=excluded.records_revision,time_bucket=excluded.time_bucket,snapshot_json=excluded.snapshot_json
        WHERE public_dashboard_projection_cache.records_revision<excluded.records_revision
          OR (public_dashboard_projection_cache.records_revision=excluded.records_revision AND public_dashboard_projection_cache.time_bucket<=excluded.time_bucket)`,
        {':row_id':key('cache',manifestId),':id':manifestId,':revision':revision,':bucket':bucket,':snapshot':manifest,...quotaFor(1024),...admission.parameters});
      await run(`DELETE FROM public_dashboard_projection_cache WHERE user_id=:tenant AND ${ACTIVE} AND row_id IN
        (SELECT row_id FROM public_dashboard_projection_cache WHERE user_id=:tenant AND selection_key LIKE 'm:%'
          ORDER BY time_bucket DESC,records_revision DESC,row_id LIMIT -1 OFFSET 4)`);
    },
  };
}

function accountLifecycle({db,userId,accountRow,clock,maxAccounts,capture,setCapture}) {
  const CLEANING="EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:generation AND status='deleting')";
  // Identifiers below are an immutable allowlist, never supplied by callers.
  const tables=['public_cloud_events','public_personal_rental_analytics','public_personal_analytics_daily','public_personal_analytics_item_reports','public_personal_analytics_collection_reports','public_marketapp_login_attempts','public_owned_refresh_runs','public_gift_refresh_runs',
    'public_owned_refresh_sessions','public_dashboard_projection_cache','public_wallet_challenges'];
  async function processAccountDeletion(limit=100) {
    if(!positive(limit)||limit>100)throw new Error('Invalid deletion batch');
    const row=await accountRow();if(!row)return {deleted:true,pending_cleanup:false};
    if(capture()!==null&&capture()!==row.generation)throw new PublicAccountError();
    if(row.status==='deleted')return {deleted:true,pending_cleanup:false};if(row.status!=='deleting')throw new PublicAccountError();
    setCapture(row.generation);const args={':tenant':userId,':generation':row.generation};
    // These fences also repair an interruption immediately after account bump.
    await db.run(`UPDATE public_provider_credentials SET generation=MIN(generation+1,9007199254740991),nonce_counter=MIN(nonce_counter+1,9007199254740991),
      credential_version=MIN(nonce_counter+1,9007199254740991),ciphertext=NULL,credential_fingerprint=NULL,created_at=NULL,updated_at=NULL
      WHERE user_id=:tenant AND ${CLEANING}`,args);
    await db.run(`UPDATE public_marketapp_analytics_sessions SET generation=MIN(generation+1,9007199254740991),wallet=NULL,wallet_revision=NULL,ciphertext=NULL,
      created_at=NULL,expires_at=NULL WHERE owner_id=:tenant AND ${CLEANING}`,args);
    // Copy only non-secret anti-abuse timestamps before deleting challenges.
    await db.run(`INSERT OR IGNORE INTO public_wallet_attempts(row_id,user_id,created_at)
      SELECT row_id,user_id,created_at FROM public_wallet_challenges WHERE user_id=:tenant AND ${CLEANING}`,args);
    let left=limit;
    for(const table of tables) {
      const result=await db.run(`DELETE FROM ${table} WHERE user_id=:tenant AND ${CLEANING}
        AND row_id IN(SELECT row_id FROM ${table} WHERE user_id=:tenant LIMIT :limit)`,{...args,':limit':left});
      left-=result.rowsAffected;if(left<=0)return {deleted:true,pending_cleanup:true};
    }
    for(const [table,column] of [['service_record_occurrences','occurrence_id'],['service_record_payloads','payload_id'],['service_record_inline_events','row_id']]) {
      const result=await db.run(`DELETE FROM ${table} WHERE scope='public:'||:tenant AND ${CLEANING}
        AND ${column} IN(SELECT ${column} FROM ${table} WHERE scope='public:'||:tenant LIMIT :limit)`,{...args,':limit':left});
      left-=result.rowsAffected;if(left<=0)return {deleted:true,pending_cleanup:true};
    }
    for(const table of ['public_owned_refresh_index','public_legacy_migrations','public_legacy_collector_state'])await db.run(`DELETE FROM ${table} WHERE user_id=:tenant AND ${CLEANING}`,args);
    await db.run(`UPDATE public_accounts SET status='deleted' WHERE user_id=:tenant AND generation=:generation AND status='deleting'`,args);
    return {deleted:true,pending_cleanup:false};
  }
  return {
    processAccountDeletion,
    async deleteAccountData(limit=100) {
      const row=await accountRow();if(!row)return {deleted:true,pending_cleanup:false};
      if(capture()!==null&&capture()!==row.generation)throw new PublicAccountError();
      if(row.status==='active'||row.status==='migrating') {
        if(row.generation>=MAX)throw new PublicAccountError();
        const changed=await db.run(`UPDATE public_accounts SET generation=generation+1,status='deleting',deleted_at=:at
          WHERE user_id=:tenant AND generation=:generation AND status IN ('active','migrating')`,{':tenant':userId,':generation':row.generation,':at':await clock()});
        if(changed.rowsAffected!==1)throw new PublicAccountError();setCapture(row.generation+1);
      }return await processAccountDeletion(limit);
    },
    async reactivateAccount() {
      const row=await accountRow();if(!row||row.status!=='deleted'||row.generation>=MAX||(capture()!==null&&capture()!==row.generation))throw new PublicAccountError();
      const changed=await db.run(`UPDATE public_accounts SET generation=generation+1,status='active',deleted_at=NULL
        WHERE user_id=:tenant AND generation=:generation AND status='deleted'
        AND (SELECT count(*) FROM public_accounts WHERE status IN ('active','migrating','deleting'))<:max_accounts`,{':tenant':userId,':generation':row.generation,':max_accounts':maxAccounts});
      if(changed.rowsAffected!==1)throw new PublicAccountError();setCapture(row.generation+1);return await accountRow();
    },
  };
}

// Administrative additive migration only. No runtime endpoint invokes this.
// Copying remains inside SQLite, bounded by row count and serialized bytes;
// the account stays inaccessible until every source table is copied.
const LEGACY_SOURCES=[
  {table:'cloud_events',key:'sequence',columns:['sequence','event_key','state_json','job_id','job_json','records_json','raw_body','observed_at'],where:'1'},
  {table:'personal_rental_analytics',key:'fingerprint',columns:['fingerprint','wallet','captured_at','imported_at','raw_snapshot','normalized_json'],where:'1'},
  {table:'marketapp_login_attempts',key:'attempt_id',columns:['attempt_id','owner_id','wallet','created_at','expires_at','state','nonce_fingerprint','outcome_json'],where:'owner_id=:tenant'},
  {table:'collector_state',key:'id',columns:['id','revision','document'],where:'id=1'},
  {table:'marketapp_analytics_sessions',key:'owner_id',columns:['owner_id','generation','nonce_counter','cookie_version','wallet','wallet_revision','ciphertext','created_at','expires_at'],where:'owner_id=:tenant'},
];
const legacyChanged=()=>new Error('Legacy owner changed during migration; keep private writes stopped and clear the partial copy before restarting');
// Capacity is checked before this helper. No query returns a whole large row:
// small rows have at most 8 KiB of source text, larger fields stream 8 Ki chars.
// The hash chain retains only fixed-size signatures, not historical bodies.
async function legacySnapshot(db,userId) {
  const signatures={},counts={};let session=null,prototypeRevision=null;
  for(const source of LEGACY_SOURCES) {
    const params=source.where.includes(':tenant')?{':tenant':userId}:{};
    const bytes=source.columns.map(column=>`COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
    let after=null,signature=digest(source.table),count=0;
    for(;;) {
      const row=await db.get(`SELECT ${source.key} AS source_key,${bytes} AS bytes FROM ${source.table}
        WHERE ${source.where} AND (:after IS NULL OR ${source.key}>:after) ORDER BY ${source.key} LIMIT 1`,{...params,':after':after});
      if(!row)break;after=row.source_key;count++;
      let rowSignature;
      if(row.bytes<=8192) {
        const value=await db.get(`SELECT CASE WHEN (${bytes})<=8192 THEN json_array(${source.columns.join(',')}) END AS content FROM ${source.table} WHERE ${source.where} AND ${source.key}=:key`,{...params,':key':after});
        if(typeof value?.content!=='string')throw legacyChanged();rowSignature=digest(value.content);
        const fields=JSON.parse(value.content);
        if(source.table==='marketapp_analytics_sessions')session=Object.fromEntries(source.columns.map((column,i)=>[column,fields[i]]));
        if(source.table==='collector_state')prototypeRevision=fields[1];
      } else {
        rowSignature=digest('streamed-row');
        for(const column of source.columns) {
          const metadata=await db.get(`SELECT typeof(${column}) AS kind,length(${column}) AS size FROM ${source.table} WHERE ${source.where} AND ${source.key}=:key`,{...params,':key':after});
          if(!metadata)throw legacyChanged();let field=digest(JSON.stringify([column,metadata.kind,metadata.size]));
          for(let offset=1;offset<=(metadata.size??0);offset+=8192) {
            const chunk=await db.get(`SELECT substr(${column},:offset,8192) AS content FROM ${source.table} WHERE ${source.where} AND ${source.key}=:key`,{...params,':key':after,':offset':offset});
            if(!chunk)throw legacyChanged();field=digest(JSON.stringify([field,chunk.content]));
          }
          rowSignature=digest(JSON.stringify([rowSignature,field]));
        }
        // Private login cookies are bounded separately and never copied.
        if(source.table==='marketapp_analytics_sessions')throw new PublicStorageLimitError();
        if(source.table==='collector_state')prototypeRevision=(await db.get('SELECT revision FROM collector_state WHERE id=1')).revision;
      }
      signature=digest(JSON.stringify([signature,after,rowSignature]));
    }
    signatures[source.table]=signature;counts[source.table]=count;
  }
  return {saved:{version:1,signatures,counts,prototypeRevision},session};
}
function legacySourceMatch(snapshot,session) {
  const params={},guards=[];
  for(const source of LEGACY_SOURCES) {
    const name=':source_count_'+source.table;params[name]=snapshot.counts[source.table];
    guards.push(`(SELECT count(*) FROM ${source.table} WHERE ${source.where})=${name}`);
    if(['cloud_events','personal_rental_analytics','marketapp_login_attempts'].includes(source.table)) {
      const target='public_'+source.table;
      guards.push(`(SELECT count(*) FROM ${target} WHERE user_id=:tenant)=${name}`);
      guards.push(`NOT EXISTS(SELECT 1 FROM ${source.table} s WHERE ${source.where.replace('owner_id=','s.owner_id=')} AND NOT EXISTS
        (SELECT 1 FROM ${target} p WHERE p.user_id=:tenant AND p.${source.key}=s.${source.key} AND ${source.columns.map(column=>`p.${column} IS s.${column}`).join(' AND ')}))`);
    }
  }
  params[':prototype_revision']=snapshot.prototypeRevision;
  guards.push(`NOT EXISTS(SELECT 1 FROM collector_state s WHERE s.id=1 AND (s.revision IS NOT :prototype_revision OR NOT EXISTS
    (SELECT 1 FROM public_legacy_collector_state p WHERE p.user_id=:tenant AND p.document IS s.document)))`);
  guards.push(`(SELECT count(*) FROM public_legacy_collector_state WHERE user_id=:tenant)=:source_count_collector_state`);
  if(session) {
    const source=LEGACY_SOURCES[4];
    for(const column of source.columns)params[':session_'+column]=session[column];
    guards.push(`EXISTS(SELECT 1 FROM marketapp_analytics_sessions WHERE ${source.columns.map(column=>`${column} IS :session_${column}`).join(' AND ')})`);
    guards.push(`EXISTS(SELECT 1 FROM public_marketapp_analytics_sessions WHERE owner_id=:tenant
      AND generation>=:session_generation AND nonce_counter>=:session_nonce_counter AND cookie_version>=:session_cookie_version
      AND wallet IS NULL AND wallet_revision IS NULL AND ciphertext IS NULL AND created_at IS NULL AND expires_at IS NULL)`);
  }
  return {sql:guards.join(' AND '),params};
}
export async function migrateLegacyOwner(db,verifiedOwnerId,{mode='check',limit=25,confirmOwnerId=null,maxAccountBytes=8388608,maxServiceBytes=134217728}={}) {
  const userId=canonicalUser(verifiedOwnerId);
  if(!['check','apply','clear'].includes(mode)||!positive(limit)||limit>25||!positive(maxAccountBytes)||!positive(maxServiceBytes)
    ||maxAccountBytes>maxServiceBytes||maxServiceBytes>536870912)throw new Error('Invalid public migration bounds');
  const privateHead=(await db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM cloud_events')).sequence;
  const legacyLayout="COALESCE((SELECT json_extract(state_json,'$.operational_storage_version') FROM cloud_events ORDER BY sequence DESC LIMIT 1),0)<>1";
  if(mode==='apply'&&!await db.get(`SELECT 1 AS legacy WHERE ${legacyLayout}`))throw new Error('Compact private storage cannot be copied by the legacy migration tool');
  const progress=await db.get('SELECT * FROM public_legacy_migrations WHERE user_id=:tenant',{':tenant':userId});
  const counts=await db.get(`SELECT (SELECT count(*) FROM cloud_events) AS source_events,
    (SELECT count(*) FROM personal_analytics_daily) AS source_daily_days,
    (SELECT count(*) FROM personal_analytics_item_reports) AS source_item_reports,
    (SELECT count(*) FROM personal_analytics_collection_reports) AS source_collection_reports,
    (SELECT count(*) FROM public_cloud_events WHERE user_id=:tenant) AS copied_events,
    (SELECT count(*) FROM personal_rental_analytics) AS source_analytics,
    (SELECT count(*) FROM public_personal_rental_analytics WHERE user_id=:tenant) AS copied_analytics,
    (SELECT count(*) FROM marketapp_login_attempts WHERE owner_id=:tenant) AS source_attempts,
    (SELECT count(*) FROM public_marketapp_login_attempts WHERE user_id=:tenant) AS copied_attempts,
    ${LEGACY_SOURCES.map(source=>`COALESCE((SELECT SUM(${source.columns.map(column=>`COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')}) FROM ${source.table} WHERE ${source.where}),0)`).join('+')}
      +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_DAILY_BYTES}) FROM personal_analytics_daily),0)
      +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_ITEM_BYTES}) FROM personal_analytics_item_reports),0)
      +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_COLLECTION_BYTES}) FROM personal_analytics_collection_reports),0) AS source_bytes,
    COALESCE((SELECT SUM(${EVENT_BYTES}) FROM public_cloud_events WHERE user_id=:tenant),0)
      +COALESCE((SELECT SUM(${ANALYTICS_BYTES}) FROM public_personal_rental_analytics WHERE user_id=:tenant),0)
      +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_DAILY_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_daily WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_ITEM_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_item_reports WHERE user_id=:tenant),0)
  +COALESCE((SELECT SUM(${PERSONAL_ANALYTICS_COLLECTION_BYTES}+length(CAST(user_id AS BLOB))) FROM public_personal_analytics_collection_reports WHERE user_id=:tenant),0) AS copied_bytes,
    (${SERVICE_BYTES}) AS current_service_bytes`,{':tenant':userId});
  if(mode==='check')return {mode,status:progress?.status??'not_started',boundary:progress?.boundary??privateHead,sequence:progress?.sequence??0,...counts,provider_requests:0};
  if(mode==='apply'&&(counts.source_daily_days>0||counts.source_item_reports>0||counts.source_collection_reports>0))throw new Error('Legacy owner migration cannot copy durable all-time analytics; preserve owner mode or use a migration that includes daily analytics');
  if(canonicalUser(confirmOwnerId)!==userId)throw new Error('Explicit legacy-owner migration confirmation is required');
  if(mode==='clear') {
    const account=await db.get('SELECT status,generation FROM public_accounts WHERE user_id=:tenant',{':tenant':userId});
    if(account&&account.status!=='deleted'&&!['migrating','deleting'].includes(account.status))throw new Error('Only an inaccessible partial legacy migration can be cleared');
    if(account&&account.status!=='deleted') {
      // An activation racing this clear must never turn it into deletion of an
      // active account. Reserve deletion while the target is still inaccessible.
      if(account.status==='migrating') {
        const fenced=await db.run(`UPDATE public_accounts SET generation=generation+1,status='deleting',deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000
          WHERE user_id=:tenant AND generation=:generation AND status='migrating' AND generation<9007199254740991`,{':tenant':userId,':generation':account.generation});
        if(fenced.rowsAffected!==1)throw new Error('Only an inaccessible partial legacy migration can be cleared');
      }
      const cleanup=await createPublicRepository(db,userId).processAccountDeletion(limit);
      return {...await migrateLegacyOwner(db,userId,{mode:'check',limit}),mode:'clear',status:cleanup.pending_cleanup?'clearing':'not_started',pending_cleanup:cleanup.pending_cleanup};
    }
    return {...await migrateLegacyOwner(db,userId,{mode:'check',limit}),mode:'clear',pending_cleanup:false};
  }
  if(counts.source_bytes>maxAccountBytes||counts.current_service_bytes-counts.copied_bytes+counts.source_bytes>maxServiceBytes)throw new PublicStorageLimitError();
  let migration=progress;
  const args={':tenant':userId,':limit':limit};
  if(!migration) {
    const existing=await db.get('SELECT * FROM public_accounts WHERE user_id=:tenant',argsSubset(args,':tenant'));
    if(existing&&(!['migrating','deleted'].includes(existing.status)||counts.copied_events!==0||counts.copied_analytics!==0||counts.copied_attempts!==0))throw new Error('Legacy migration requires an unused public account');
    const time=await db.get("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS at");
    await db.run(`INSERT OR IGNORE INTO public_accounts(user_id,generation,status,created_at,wallet_nonce_counter)
      SELECT :tenant,0,'migrating',:at,0 WHERE NOT EXISTS(SELECT 1 FROM public_cloud_events WHERE user_id=:tenant)
        AND ${legacyLayout}
        AND NOT EXISTS(SELECT 1 FROM public_personal_rental_analytics WHERE user_id=:tenant)
        AND NOT EXISTS(SELECT 1 FROM public_provider_credentials WHERE user_id=:tenant)`,{':tenant':userId,':at':time.at});
    if(existing?.status==='deleted')await db.run(`UPDATE public_accounts SET generation=generation+1,status='migrating',deleted_at=NULL
      WHERE user_id=:tenant AND generation=:previous_generation AND generation<9007199254740991 AND status='deleted' AND ${legacyLayout}`,{':tenant':userId,':previous_generation':existing.generation});
    const reserved=await db.get("SELECT generation FROM public_accounts WHERE user_id=:tenant AND status='migrating'",{':tenant':userId});
    if(!reserved)throw new Error('Legacy migration could not reserve its account');
    const snapshot=await legacySnapshot(db,userId);
    await db.run(`INSERT OR IGNORE INTO public_legacy_migrations(user_id,boundary,sequence,status,created_at,generation,source_snapshot_json)
      SELECT :tenant,:boundary,0,'copying',:at,:migration_generation,:source_snapshot WHERE EXISTS
        (SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:migration_generation AND status='migrating')`,
      {':tenant':userId,':boundary':privateHead,':at':time.at,':migration_generation':reserved.generation,':source_snapshot':JSON.stringify(snapshot.saved)});
    migration=await db.get('SELECT * FROM public_legacy_migrations WHERE user_id=:tenant',{':tenant':userId});
    if(!migration)throw new Error('Legacy migration could not reserve its account');
  }
  const account=await db.get('SELECT generation,status FROM public_accounts WHERE user_id=:tenant',{':tenant':userId});
  if(migration.status==='complete'&&account?.status==='active'&&account.generation===migration.generation)
    return {...await migrateLegacyOwner(db,userId,{mode:'check',limit}),mode:'apply'};
  if(!Number.isSafeInteger(migration.generation)||typeof migration.source_snapshot_json!=='string')throw new Error('Legacy migration snapshot is missing; clear the partial copy before restarting');
  const frozen=JSON.parse(migration.source_snapshot_json);
  if(frozen?.version!==1||!plain(frozen.counts)||!plain(frozen.signatures))throw new Error('Legacy migration snapshot is invalid; clear the partial copy before restarting');
  if(migration.boundary!==privateHead||frozen.counts.cloud_events!==counts.source_events||frozen.counts.personal_rental_analytics!==counts.source_analytics||frozen.counts.marketapp_login_attempts!==counts.source_attempts)throw legacyChanged();
  args[':migration_generation']=migration.generation;
  const migrationArgs=argsSubset(args,':tenant',':migration_generation');
  const COPYING="EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:migration_generation AND status='migrating')";
  const eligible=await db.get(`SELECT 1 AS valid WHERE ${COPYING}`,migrationArgs);if(!eligible)throw new Error('Legacy migration account is fenced');
  // Oversized legacy rows advance alone; returned data contains counts only.
  const copied=await db.run(`WITH pending AS(SELECT *,length(CAST(state_json AS BLOB))+COALESCE(length(CAST(job_json AS BLOB)),0)
      +length(CAST(records_json AS BLOB))+COALESCE(length(CAST(raw_body AS BLOB)),0) AS bytes
    FROM cloud_events WHERE sequence>:after AND sequence<=:boundary ORDER BY sequence LIMIT :limit),
    bounded AS(SELECT *,SUM(bytes) OVER(ORDER BY sequence) AS total_bytes FROM pending)
    INSERT OR IGNORE INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at)
    SELECT json_array(:tenant,'event',sequence),:tenant,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at FROM bounded
    WHERE (total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending)) AND ${COPYING}
      AND (${ACCOUNT_BYTES})+total_bytes<=:max_account_bytes AND (${SERVICE_BYTES})+total_bytes<=:max_service_bytes`,
    {...args,':after':migration.sequence,':boundary':migration.boundary,':max_account_bytes':maxAccountBytes,':max_service_bytes':maxServiceBytes});
  await db.run(`UPDATE public_legacy_migrations SET sequence=COALESCE((SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant),0)
    WHERE user_id=:tenant AND generation=:migration_generation AND status='copying' AND ${COPYING}`,migrationArgs);
  const copiedProgress=await db.get('SELECT sequence,generation FROM public_legacy_migrations WHERE user_id=:tenant',{':tenant':userId});
  if(!copiedProgress||copiedProgress.generation!==migration.generation)throw new Error('Legacy migration account is fenced');
  if(copied.rowsAffected>0||copiedProgress.sequence>migration.sequence)
    return {...await migrateLegacyOwner(db,userId,{mode:'check',limit,maxAccountBytes,maxServiceBytes}),mode:'apply'};
  if(await db.get('SELECT 1 AS pending FROM cloud_events WHERE sequence>:after AND sequence<=:boundary LIMIT 1',{':after':migration.sequence,':boundary':migration.boundary}))throw new PublicStorageLimitError();
  const analytics=await db.run(`WITH pending AS(SELECT *,length(CAST(raw_snapshot AS BLOB))+length(CAST(normalized_json AS BLOB)) AS bytes FROM personal_rental_analytics
      WHERE NOT EXISTS(SELECT 1 FROM public_personal_rental_analytics p WHERE p.user_id=:tenant AND p.fingerprint=personal_rental_analytics.fingerprint)
      ORDER BY fingerprint LIMIT :limit),bounded AS(SELECT *,SUM(bytes) OVER(ORDER BY fingerprint) AS total_bytes FROM pending)
    INSERT OR IGNORE INTO public_personal_rental_analytics(row_id,user_id,fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json)
    SELECT json_array(:tenant,'analytics',fingerprint),:tenant,fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json FROM bounded
      WHERE (total_bytes<=524288 OR fingerprint=(SELECT MIN(fingerprint) FROM pending)) AND ${COPYING}
        AND (${ACCOUNT_BYTES})+total_bytes<=:max_account_bytes AND (${SERVICE_BYTES})+total_bytes<=:max_service_bytes`,
      {...args,':max_account_bytes':maxAccountBytes,':max_service_bytes':maxServiceBytes});
  if(analytics.rowsAffected>0)return {...await migrateLegacyOwner(db,userId,{mode:'check',limit}),mode:'apply'};
  if(await db.get(`SELECT 1 AS pending FROM personal_rental_analytics s WHERE NOT EXISTS(SELECT 1 FROM public_personal_rental_analytics p
    WHERE p.user_id=:tenant AND p.fingerprint=s.fingerprint) LIMIT 1`,{':tenant':userId}))throw new PublicStorageLimitError();
  const attempts=await db.run(`INSERT OR IGNORE INTO public_marketapp_login_attempts(row_id,user_id,attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint,outcome_json)
    SELECT json_array(:tenant,'login',attempt_id),:tenant,attempt_id,owner_id,wallet,created_at,expires_at,state,nonce_fingerprint,outcome_json FROM marketapp_login_attempts
    WHERE owner_id=:tenant AND NOT EXISTS(SELECT 1 FROM public_marketapp_login_attempts p WHERE p.user_id=:tenant AND p.attempt_id=marketapp_login_attempts.attempt_id)
      AND ${COPYING} ORDER BY created_at,attempt_id LIMIT :limit`,args);
  if(attempts.rowsAffected>0)return {...await migrateLegacyOwner(db,userId,{mode:'check',limit}),mode:'apply'};
  await db.run(`INSERT OR IGNORE INTO public_marketapp_analytics_sessions(owner_id,generation,nonce_counter,cookie_version,wallet,wallet_revision,ciphertext,created_at,expires_at)
    SELECT owner_id,generation,nonce_counter,cookie_version,NULL,NULL,NULL,NULL,NULL FROM marketapp_analytics_sessions
    WHERE owner_id=:tenant AND ${COPYING}
    ON CONFLICT(owner_id) DO UPDATE SET generation=MAX(generation,excluded.generation),nonce_counter=MAX(nonce_counter,excluded.nonce_counter),
      cookie_version=MAX(cookie_version,excluded.cookie_version),wallet=NULL,wallet_revision=NULL,ciphertext=NULL,created_at=NULL,expires_at=NULL`,migrationArgs);
  await db.run(`INSERT OR IGNORE INTO public_legacy_collector_state(user_id,document) SELECT :tenant,document FROM collector_state WHERE id=1 AND ${COPYING}`,migrationArgs);
  const final=await legacySnapshot(db,userId);
  if(JSON.stringify(final.saved)!==migration.source_snapshot_json)throw legacyChanged();
  const sourceMatch=legacySourceMatch(frozen,final.session),commitArgs={...migrationArgs,...sourceMatch.params,':boundary':migration.boundary};
  const FINAL_GUARD=`${COPYING} AND (SELECT COALESCE(MAX(sequence),0) FROM cloud_events)=:boundary AND ${sourceMatch.sql}`;
  // Exact native equality of every physical event and prototype document also
  // preserves every referenced job/target and therefore the decoded checkpoint.
  // Validation returns no large checkpoint, archived body or prototype document.
  if(migration.status==='copying') {
    const completed=await db.run(`UPDATE public_legacy_migrations SET status='complete' WHERE user_id=:tenant AND generation=:migration_generation
      AND status='copying' AND ${FINAL_GUARD}`,commitArgs);
    if(completed.rowsAffected!==1)throw legacyChanged();
  }
  // The first active read happens only after full preservation validation.
  // A crash between completion and activation is repaired on explicit retry.
  const activated=await db.run(`UPDATE public_accounts SET status='active' WHERE user_id=:tenant AND generation=:migration_generation AND status='migrating'
    AND EXISTS(SELECT 1 FROM public_legacy_migrations WHERE user_id=:tenant AND generation=:migration_generation AND status='complete') AND ${FINAL_GUARD}`,commitArgs);
  if(activated.rowsAffected!==1)throw legacyChanged();
  return {...await migrateLegacyOwner(db,userId,{mode:'check',limit}),mode:'apply'};
}
function argsSubset(values,...names) {return Object.fromEntries(names.map(name=>[name,values[name]]));}
