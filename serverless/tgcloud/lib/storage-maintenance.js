import {createCheckpointStorage, createCheckpointSourceIndex, COMPACTABLE_CHECKPOINT, INLINE_TARGETS} from './checkpoint-storage.js';
import {checkpointSourceIndexReadySql, checkpointSourceScopeSql, readCheckpointPhysicalPage} from './budget-reset-checkpoint-storage.js';
import {createPublicRepository} from './public-repository.js';
import {normalizeStoragePolicy, storagePaused, DEFAULT_PUBLIC_ACCOUNT_BYTES} from './storage-policy.js';
import {PUBLIC_COLLECTION_HEADROOM_BYTES} from './storage-admission.js';

const CLOCK = "CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)";
const REQUEST_BATCHES = 8, REQUEST_QUERIES = 128, REQUEST_WORK_MS = 8000;
class CleanupWorkLimit extends Error {}
const phases = ['private_cache','public_cache','private_attempts','public_attempts','wallet_challenges','wallet_attempts',
  'website_requests','reservations','jobs','targets','owned_states','gift_states','budget_resets','public_jobs','public_targets','public_discovery'];
const accountPhases = ['public_cache','public_attempts','wallet_challenges','wallet_attempts','public_jobs','public_targets','public_discovery'];
const progressStages = Object.freeze({private_cache:'cache',public_cache:'cache',private_attempts:'expired_metadata',
  public_attempts:'expired_metadata',wallet_challenges:'expired_metadata',wallet_attempts:'expired_metadata',
  website_requests:'expired_metadata',reservations:'expired_metadata',jobs:'sync_history',targets:'gift_checks',
  owned_states:'saved_status',gift_states:'saved_status',budget_resets:'request_allowance',public_jobs:'sync_history',
  public_targets:'gift_checks',public_discovery:'discovery'});
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => nonnegative(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : null;
const identity = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);
const USAGE_DAY = 86400000, USAGE_DAYS = 31;
// Small daily measurements live with the already leased monitor, outside the
// payload counters. No extra writes on status reads or retained event history.
function usageSamples(history, initializedAt, at) {
  if (!object(history) || history.version !== 1 || history.initialized_at !== initializedAt
    || !iso(initializedAt) || initializedAt > at || !Array.isArray(history.samples) || history.samples.length > USAGE_DAYS) return [];
  let previousDay = -1;
  const samples = [];
  for (const sample of history.samples) {
    if (!object(sample) || !iso(sample.at) || sample.at < initializedAt || sample.at > at || !nonnegative(sample.bytes)) return [];
    const day = Math.floor(sample.at / USAGE_DAY);
    if (day <= previousDay) return [];
    previousDay = day;
    if (day > Math.floor(at / USAGE_DAY) - USAGE_DAYS) samples.push({at: sample.at, bytes: sample.bytes});
  }
  return samples;
}
function recordUsage(history, usage, at) {
  if (!nonnegative(usage?.total_bytes) || !iso(usage?.initialized_at) || usage.initialized_at > at) throw new Error('Storage accounting unavailable');
  const samples = usageSamples(history, usage.initialized_at, at), day = Math.floor(at / USAGE_DAY);
  if (samples.length && Math.floor(samples.at(-1).at / USAGE_DAY) === day) samples.pop();
  samples.push({at, bytes: usage.total_bytes});
  return {version: 1, initialized_at: usage.initialized_at, samples: samples.slice(-USAGE_DAYS)};
}
function usageGrowth(history, usage, at, writeLimit, complete) {
  const samples = complete ? usageSamples(history, usage.initialized_at, at) : [], first = samples[0], last = samples.at(-1);
  const value = {state: complete ? 'collecting' : 'unknown', sample_count: samples.length,
    observed_from: iso(first?.at), observed_through: iso(last?.at), net_bytes_per_day: null,
    days_to_limit: null, write_limit_bytes: complete ? writeLimit : null, platform_quota_verified: false};
  if (!last) return value;
  if (at - last.at > 2 * USAGE_DAY) return {...value, state: 'stale'};
  if (samples.length < 3 || last.at - first.at < 2 * USAGE_DAY) return value;
  // Net change includes cleanup. This is an observed trend, not a prediction
  // of account capacity or the provider's physical database quota.
  const rate = Math.round((last.bytes - first.bytes) / ((last.at - first.at) / USAGE_DAY));
  const days = rate > 0 ? Math.ceil(Math.max(0, writeLimit - usage.total_bytes) / rate) : null;
  return {...value, state: rate > 0 ? 'growing' : 'not_growing', net_bytes_per_day: rate,
    days_to_limit: days !== null && days <= 36500 ? days : null};
}
// Only these append-only physical histories have durable scan watermarks.
// Expiring metadata and public candidate queries must be reconsidered each pass.
const incrementalPhases = ['jobs','targets','owned_states','gift_states','budget_resets'];
const SCAN_VERSION = 1, FULL_SCAN_MS = 86400000;
function scanMark(cleanup, phase, at) {
  const mark = object(cleanup.scan_marks) ? cleanup.scan_marks[phase] : null;
  return object(mark) && mark.version === SCAN_VERSION && nonnegative(mark.boundary)
    && nonnegative(mark.full_at) && mark.full_at > 0 && mark.full_at <= at ? mark : null;
}
function validPhaseScan(cleanup, phase) {
  const scan = cleanup.phase_scan;
  return object(scan) && scan.version === SCAN_VERSION && scan.phase === phase && scan.boundary === cleanup.boundary
    && nonnegative(scan.origin) && scan.origin <= cleanup.after && cleanup.after <= cleanup.boundary
    && typeof scan.full === 'boolean' && nonnegative(scan.previous_full_at)
    && (scan.full ? scan.origin === 0 && scan.previous_full_at === 0 : scan.origin === 0 || scan.previous_full_at > 0);
}
function preparePhaseScan(cleanup, phase, at) {
  if (validPhaseScan(cleanup, phase)) return;
  const mark = scanMark(cleanup, phase, at), inFlight = cleanup.after > 0;
  const incremental = !inFlight && mark && mark.boundary <= cleanup.boundary && at - mark.full_at < FULL_SCAN_MS;
  // The previous boundary was the protected current head. Revisit it after
  // new events arrive; never skip that row by resuming after the old boundary.
  const origin = incremental ? Math.max(0, mark.boundary - 1) : 0;
  if (!inFlight) cleanup.after = origin;
  cleanup.phase_scan = {version: SCAN_VERSION, phase, boundary: cleanup.boundary, origin,
    full: !inFlight && !incremental, previous_full_at: incremental ? mark.full_at : 0};
}
function completePhaseScan(cleanup, phase, at) {
  if (!validPhaseScan(cleanup, phase)) return;
  const fullAt = cleanup.phase_scan.full ? at : cleanup.phase_scan.previous_full_at;
  // A legacy in-flight cursor does not certify that its earlier range used
  // this algorithm. Finish it in place, then conservatively sweep next time.
  const marks = Object.fromEntries(incrementalPhases.filter(name => scanMark(cleanup, name, at))
    .map(name => {const mark=scanMark(cleanup,name,at);return [name,{version:SCAN_VERSION,boundary:mark.boundary,full_at:mark.full_at}];}));
  if (fullAt > 0 && fullAt <= at) marks[phase] = {version: SCAN_VERSION, boundary: cleanup.boundary, full_at: fullAt};
  else delete marks[phase];
  cleanup.scan_marks = marks;
}
function decodeDocument(value) {
  let document; try {document = JSON.parse(value || '{}');} catch {return {};}
  if (!object(document) || document.version !== 1) return {};
  return document;
}
function validCleanup(cleanup) {
  return object(cleanup) && Number.isSafeInteger(cleanup.phase) && cleanup.phase >= 0 && cleanup.phase < phases.length
    && nonnegative(cleanup.after) && nonnegative(cleanup.boundary) && nonnegative(cleanup.reclaimed_bytes)
    && (cleanup.tenant === null || identity(cleanup.tenant));
}
function cleanupProgress(cleanup,isOwner) {
  const steps=isOwner?phases:accountPhases;
  if(!validCleanup(cleanup)||cleanup.phase>=steps.length||!['running','blocked','complete'].includes(cleanup.state))return null;
  const phase=cleanup.state==='complete'?steps.length-1:cleanup.phase,stage=steps[phase];
  const origin=validPhaseScan(cleanup,stage)?cleanup.phase_scan.origin:0;
  // These private phases walk a frozen sequence boundary. Other phases lack
  // a known total, and account cleanup must not reveal a shared scan's size.
  const percent=cleanup.state==='complete'?100:isOwner&&cleanup.boundary>0
    &&['jobs','targets','owned_states','gift_states','budget_resets'].includes(stage)
      ?Math.min(100,Math.max(0,Math.floor((cleanup.after-origin)/Math.max(1,cleanup.boundary-origin)*100))):null;
  return {stage:progressStages[stage],stage_number:phase+1,stage_count:steps.length,percent};
}
function urgentCleanup(bytes, cleanup, policy) {
  return bytes >= policy.budgetBytes * policy.warningRatio && nonnegative(cleanup.completed_bytes)
    && bytes - cleanup.completed_bytes >= Math.min(1048576, policy.reserveBytes / 4, policy.budgetBytes * .025);
}
export function createStorageMaintenance({db, ownerTelegramId, policy: inputPolicy = {}, maxAccountBytes = DEFAULT_PUBLIC_ACCOUNT_BYTES, now = null, random = Math.random}) {
  const owner = String(ownerTelegramId); if (!identity(owner) || !db?.get || !db?.run || !db?.all) throw new Error('Invalid storage maintenance configuration');
  const policy = normalizeStoragePolicy(inputPolicy);
  if (!Number.isSafeInteger(maxAccountBytes) || maxAccountBytes < 1 || maxAccountBytes > policy.budgetBytes) throw new Error('Invalid account storage budget');
  async function time() {
    const at = now ? await now() : (await db.get(`SELECT ${CLOCK} AS server_time`))?.server_time;
    if (!nonnegative(at) || at < 1 || !iso(at)) throw new Error('Storage clock unavailable'); return at;
  }
  function authorize(userId, isOwner) {
    const user = String(userId); if (!identity(user) || typeof isOwner !== 'boolean' || isOwner && user !== owner) throw new Error('Storage access denied');
    return user;
  }
  async function snapshot() {
    const [usage, monitor] = await Promise.all([db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1'),
      db.get('SELECT document,lease_id,lease_until FROM service_storage_monitor WHERE id=1')]);
    return {usage, monitor, document: decodeDocument(monitor?.document)};
  }
  async function account(user, generation = null) {
    const row = await db.get('SELECT generation,status FROM public_accounts WHERE user_id=:user', {':user': user});
    return row?.status === 'active' && nonnegative(row.generation) && (generation === null || generation === row.generation) ? row : null;
  }
  const accountDocument = (document, user, generation) => object(document.accounts) && object(document.accounts[user]) && document.accounts[user].generation === generation
    ? document.accounts[user] : {};
  async function response(user, isOwner, at, saved = null, generation = null, progress = false, growth = false) {
    const {usage, monitor, document} = saved || await snapshot(), complete = nonnegative(usage?.total_bytes) && Boolean(iso(usage?.initialized_at));
    const scoped = isOwner ? usage : await db.get('SELECT total_bytes,initialized_at FROM service_storage_scope_usage WHERE scope=:scope', {':scope': `public:${user}`});
    const active = isOwner ? null : await account(user, generation);
    const scopedComplete = complete && (isOwner || active !== null) && nonnegative(scoped?.total_bytes) && Boolean(iso(scoped?.initialized_at));
    const ownDocument = isOwner ? document : accountDocument(document, user, active?.generation);
    const cleanup = object(ownDocument.cleanup) ? ownDocument.cleanup : {};
    const running = cleanup.state === 'running' || isOwner && Boolean(monitor?.lease_id && monitor.lease_until > at);
    const paused = !complete || storagePaused(usage.total_bytes, document.paused === true, policy) || !isOwner && scopedComplete && scoped.total_bytes >= maxAccountBytes;
    const shownBytes = isOwner ? usage?.total_bytes : scoped?.total_bytes, shownBudget = isOwner ? policy.budgetBytes : maxAccountBytes;
    const headroomLow = !isOwner && scopedComplete && shownBytes > Math.max(0, maxAccountBytes - PUBLIC_COLLECTION_HEADROOM_BYTES);
    let state = !scopedComplete ? 'unknown' : paused ? 'paused' : running ? 'cleaning'
      : headroomLow || shownBytes >= shownBudget * policy.warningRatio ? 'warning' : 'healthy';
    const checked = iso(ownDocument.checked_at) || (scopedComplete ? iso(scoped.initialized_at) : null);
    let cleanupState = ['idle','running','complete','needed','blocked'].includes(cleanup.state) ? cleanup.state : 'idle';
    const due = !checked || at - Date.parse(checked) >= policy.inventoryFreshMs;
    const cleanupDue = !iso(cleanup.last_completed_at) || at - cleanup.last_completed_at >= policy.cleanupFreshMs
      || urgentCleanup(shownBytes, cleanup, {...policy, budgetBytes: shownBudget});
    if (scopedComplete && cleanupState !== 'running' && cleanupState !== 'blocked'
        && (due || cleanupDue && (headroomLow || shownBytes >= shownBudget * policy.cleanupRatio))) cleanupState = 'needed';
    // Shared pressure may pause an invited account, but never disclose another
    // user's byte counts, identifiers, cleanup savings or the global budget.
    let next = running ? Math.max(at + 2500, monitor?.lease_until > at ? monitor.lease_until : 0)
      : cleanupState === 'needed' ? at + 2500 : Math.max(at + 2500, (cleanup.last_completed_at || at) + policy.cleanupFreshMs);
    if (!scopedComplete) next = at + 30000;
    return {version: 1, scope: isOwner ? 'app' : 'account', status: state,
      estimated_bytes: scopedComplete ? scoped.total_bytes : null, budget_bytes: isOwner ? policy.budgetBytes : null,
      checked_at: scopedComplete ? checked : null, inventory_complete: scopedComplete,
      cleanup: {state: cleanupState, last_completed_at: iso(cleanup.last_completed_at),
        reclaimed_bytes: isOwner && nonnegative(cleanup.reclaimed_bytes) ? cleanup.reclaimed_bytes : 0,
        estimated_reclaimable_bytes: null,...(progress?{progress:scopedComplete?cleanupProgress({...cleanup,state:cleanupState},isOwner):null}:{})},
      can_cleanup: scopedComplete, next_step_at: iso(next),
      ...(growth ? {growth: usageGrowth(ownDocument.usage_history, scoped, at,
        isOwner ? Math.ceil(policy.budgetBytes * policy.pauseRatio) : maxAccountBytes, scopedComplete)} : {})};
  }
  // Fence every cleanup write in SQL, including protected-source publications.
  // A delayed worker cannot keep mutating after its lease has expired/replaced.
  function leasedDb(lease, user = null, generation = null) {
    return {get: (...args) => db.get(...args), all: (...args) => db.all(...args),
      run: (sql, params = {}) => {
        // An administrative reset can switch layouts after our phase check.
        // Fence every legacy checkpoint rewrite in the same SQL statement so
        // it cannot add references to rows the compact writer will retire.
        const legacy = /\bUPDATE\s+cloud_events\s+SET\b/i.test(sql)
          ? " AND COALESCE((SELECT CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.operational_storage_version') ELSE 0 END FROM cloud_events ORDER BY sequence DESC LIMIT 1),0)<>1"
          : /\bUPDATE\s+public_cloud_events\s+SET\b/i.test(sql)
            ? " AND COALESCE((SELECT CASE WHEN json_valid(storage_head.state_json) THEN json_extract(storage_head.state_json,'$.operational_storage_version') ELSE 0 END FROM public_cloud_events storage_head WHERE storage_head.user_id=public_cloud_events.user_id ORDER BY storage_head.sequence DESC LIMIT 1),0)<>1" : '';
        return db.run(`${sql}${legacy} AND EXISTS(SELECT 1 FROM service_storage_monitor
        WHERE id=1 AND lease_id=:storage_lease AND lease_until>${CLOCK})${user === null ? '' : ` AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:maintenance_user AND generation=:maintenance_generation AND status='active')`}`,
          {...params, ':storage_lease': lease, ...(user === null ? {} : {':maintenance_user': user, ':maintenance_generation': generation})});
      }};
  }
  function maintenanceWork(guarded) {
    let queries = 0;
    const limited = Object.fromEntries(['get','all','run'].map(method => [method, async (...args) => {
      if (queries >= REQUEST_QUERIES) throw new CleanupWorkLimit();
      queries++;
      return guarded[method](...args);
    }]));
    const sourceIndex = createCheckpointSourceIndex(limited), readyScopes = new Set(), compactScopes = new Set();
    return {db: limited, queries: () => queries, repository: createCheckpointStorage(limited, {sourceScope: 'private'}),
      async compactScope(scope) {
        if (compactScopes.has(scope)) return true;
        const privateScope = scope === 'private';
        const row = await limited.get(`SELECT CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.operational_storage_version') ELSE 0 END AS mode
          FROM ${privateScope ? 'cloud_events' : 'public_cloud_events'} ${privateScope ? '' : 'WHERE user_id=:compact_tenant'} ORDER BY sequence DESC LIMIT 1`,
          privateScope ? {} : {':compact_tenant': scope.slice(7)});
        if (row?.mode === 1) compactScopes.add(scope);
        return row?.mode === 1;
      },
      async sourceReady(scope) {
        if (readyScopes.has(scope)) return true;
        const ready = (await sourceIndex.ensurePage(scope)).complete;
        if (ready) readyScopes.add(scope);
        return ready;
      }};
  }
  async function deleteBatch(guarded, table, condition, params = {}) {
    const result = await guarded.run(`DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE ${condition} ORDER BY rowid LIMIT :maintenance_rows)`,
      {...params, ':maintenance_rows': policy.batchRows});
    return {complete: result.rowsAffected < policy.batchRows, rewritten: 0};
  }
  async function targetPage(guarded, cursor, tenant = null, work = null) {
    const table = tenant === null ? 'cloud_events' : 'public_cloud_events';
    const active = tenant === null ? '' : `AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant
      AND generation=:account_generation AND status='active')`;
    const scoped = tenant === null ? '' : `AND user_id=:tenant ${active}`;
    const tenantParams = tenant === null ? {} : {':tenant': tenant, ':account_generation': cursor.tenant_generation};
    const params = {':after': cursor.after, ':boundary': cursor.boundary, ...tenantParams};
    const inline = INLINE_TARGETS;
    const sourceScope = tenant === null ? 'private' : `public:${tenant}`;
    const protectedSource = alias => `${checkpointSourceIndexReadySql(sourceScope)}
      AND NOT EXISTS(SELECT 1 FROM service_checkpoint_sources WHERE scope=${checkpointSourceScopeSql(sourceScope)}
        AND kind IN ('owned_targets','owned_state') AND source_sequence=${alias}.sequence)`;
    const privatePage = tenant === null ? await readCheckpointPhysicalPage(guarded, {
      after: cursor.after, boundary: cursor.boundary,
      projection: `sequence,json_extract(state_json,'$.owned_prices.run.id') AS run_id,
        json_extract(state_json,'$.owned_prices.run.wallet') AS wallet,json_extract(state_json,'$.owned_prices.run.targets') AS targets_json`,
      predicate: `${inline} AND ${protectedSource(table)}
        AND length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB))>64`,
    }) : null;
    const rows = privatePage ? privatePage.rows : await guarded.all(`WITH pending AS(SELECT sequence,json_extract(state_json,'$.owned_prices.run.id') AS run_id,
      json_extract(state_json,'$.owned_prices.run.wallet') AS wallet,json_extract(state_json,'$.owned_prices.run.targets') AS targets_json,
      length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB)) AS bytes FROM ${table}
      WHERE sequence>:after AND sequence<:boundary ${scoped} AND ${inline} AND ${protectedSource(table)}
        AND length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB))>64 ORDER BY sequence LIMIT 25),
      bounded AS(SELECT *,SUM(bytes) OVER(ORDER BY sequence) AS total FROM pending)
      SELECT sequence,run_id,wallet,targets_json FROM bounded WHERE total<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`, params);
    if (!rows.length) return {after: privatePage?.after ?? cursor.after, complete: privatePage?.complete ?? true, rewritten: 0};
    const selected = [], privateSources = tenant === null ? work?.repository ?? createCheckpointStorage(guarded, {sourceScope: 'private'}) : null;
    let after = cursor.after, lookups = 0, processed = 0;
    for (const row of rows) {
      if (lookups >= 4) break; lookups++;
      const source = privateSources
        ? await privateSources.findOwnedTargetSource({id: row.run_id, wallet: row.wallet, targets: JSON.parse(row.targets_json)}, row.sequence)
        : await guarded.get(`SELECT sequence FROM ${table} WHERE sequence<:sequence ${scoped} AND ${inline}
        AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.owned_prices.run.id')=:run
          AND json_extract(state_json,'$.owned_prices.run.wallet') IS :wallet
          AND json_extract(state_json,'$.owned_prices.run.targets')=:targets ELSE 0 END ORDER BY sequence LIMIT 1`,
        {...tenantParams, ':sequence': row.sequence, ':run': row.run_id, ':wallet': row.wallet, ':targets': row.targets_json});
      after = row.sequence; processed++; if (source) selected.push({...row, source: source.sequence});
      if (selected.length >= policy.duplicateWrites) break;
    }
    // Each row publication rechecks source content and all protected roots.
    // Four single statements avoid host SQL expression/query size limits.
    let rewritten = 0;
    const sources = new Set(selected.map(row => row.source));
    for (const row of selected.filter(row => !sources.has(row.sequence))) {
      const args = {...params, ':sequence': row.sequence, ':source': row.source, ':run': row.run_id, ':wallet': row.wallet, ':targets': row.targets_json};
      delete args[':after'];
      const result = await guarded.run(`UPDATE ${table} SET state_json=json_set(json_remove(state_json,'$.owned_prices.run.targets'),
        '$.__checkpoint_owned_targets_sequence',:source) WHERE sequence=:sequence ${scoped} AND sequence<:boundary
        AND sequence<(SELECT MAX(sequence) FROM ${table} WHERE ${tenant === null ? '1=1' : 'user_id=:tenant'})
        AND ${inline} AND ${protectedSource(table)}
        AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.owned_prices.run.id')=:run
          AND json_extract(state_json,'$.owned_prices.run.wallet') IS :wallet AND json_extract(state_json,'$.owned_prices.run.targets')=:targets ELSE 0 END
        AND EXISTS(SELECT 1 FROM ${table} source WHERE source.sequence=:source ${tenant === null ? '' : 'AND source.user_id=:tenant'}
          AND ${inline.replaceAll('state_json','source.state_json')}
          AND CASE WHEN json_valid(source.state_json) THEN json_extract(source.state_json,'$.owned_prices.run.id')=:run
            AND json_extract(source.state_json,'$.owned_prices.run.wallet') IS :wallet
            AND json_extract(source.state_json,'$.owned_prices.run.targets')=:targets
            AND json_type(source.state_json,'$.__checkpoint_owned_targets_sequence') IS NULL ELSE 0 END)`, args);
      rewritten += result.rowsAffected;
    }
    if (privatePage && processed === rows.length) after = privatePage.after;
    return {after, complete: privatePage ? processed === rows.length && privatePage.complete : after >= cursor.boundary - 1, rewritten};
  }
  async function publicPhase(guarded, cursor, phase, work) {
    let tenant = cursor.tenant;
    if (tenant === null) {
      const account = await guarded.get(`SELECT user_id,generation FROM public_accounts WHERE status='active' AND user_id>:after_user ORDER BY user_id LIMIT 1`,
        {':after_user': cursor.last_tenant || ''});
      tenant = account?.user_id; if (!tenant) return {complete: true, rewritten: 0};
      cursor.tenant = tenant; cursor.tenant_generation = account.generation; cursor.after = 0;
      cursor.boundary = (await guarded.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM public_cloud_events WHERE user_id=:tenant', {':tenant': tenant})).boundary;
    }
    const current = await guarded.get('SELECT generation,status FROM public_accounts WHERE user_id=:tenant', {':tenant': tenant});
    if (!current || current.status !== 'active' || current.generation !== cursor.tenant_generation) {
      cursor.last_tenant = tenant; cursor.tenant = null; cursor.after = 0; cursor.boundary = 0; return {complete: false, rewritten: 0};
    }
    if (await work.compactScope(`public:${tenant}`)) {
      cursor.last_tenant = tenant; cursor.tenant = null; cursor.after = 0; cursor.boundary = 0;
      return {complete: false, rewritten: 0};
    }
    const active = `EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:account_generation AND status='active')`;
    if (!await work.sourceReady(`public:${tenant}`))
      return {complete: false, rewritten: 0};
    let result;
    if (!cursor.boundary) result = {complete: true, rewritten: 0};
    else if (phase === 'public_jobs') {
      const update = await guarded.run(`UPDATE public_cloud_events SET state_json=json_set(json_remove(state_json,'$.job'),'$.__checkpoint_job_sequence',sequence)
        WHERE user_id=:tenant AND ${active} AND sequence IN(SELECT sequence FROM public_cloud_events WHERE user_id=:tenant
          AND sequence<:boundary AND sequence<(SELECT MAX(sequence) FROM public_cloud_events WHERE user_id=:tenant)
          AND ${COMPACTABLE_CHECKPOINT} ORDER BY sequence LIMIT :limit) AND ${COMPACTABLE_CHECKPOINT}`,
        {':tenant': tenant, ':account_generation': cursor.tenant_generation, ':boundary': cursor.boundary, ':limit': policy.duplicateWrites});
      result = {complete: update.rowsAffected < policy.duplicateWrites, rewritten: update.rowsAffected};
    } else if (phase === 'public_targets') result = await targetPage(guarded, cursor, tenant, work);
    else {
      const repository = createPublicRepository(guarded, tenant, {accountGenerationFence: cursor.tenant_generation});
      const count = await repository.compactCompletedDiscoveryCheckpoints(3);
      result = {complete: count === 0, rewritten: count};
    }
    if (result.after !== undefined) cursor.after = result.after;
    if (result.complete) {cursor.last_tenant = tenant; cursor.tenant = null; cursor.after = 0; cursor.boundary = 0;}
    return {...result, complete: false};
  }
  async function batch(guarded, cursor, at, work) {
    const phase = phases[cursor.phase], incremental = incrementalPhases.includes(phase);
    if (incremental && await work.compactScope('private')) return {complete: true, rewritten: 0};
    if (incremental) preparePhaseScan(cursor, phase, at);
    const result = await batchPage(guarded, cursor, at, work);
    if (result.after !== undefined) cursor.after = result.after;
    if (incremental && result.complete) completePhaseScan(cursor, phase, at);
    return result;
  }
  async function batchPage(guarded, cursor, at, work) {
    const phase = phases[cursor.phase], cutoff = at - policy.metadataRetentionMs;
    if (phase === 'private_cache') return deleteBatch(guarded, 'dashboard_projection_cache', '1=1');
    if (phase === 'public_cache') return deleteBatch(guarded, 'public_dashboard_projection_cache', '1=1');
    if (phase === 'private_attempts') return deleteBatch(guarded, 'marketapp_login_attempts', 'created_at<:cutoff AND expires_at<:cutoff', {':cutoff': cutoff});
    if (phase === 'public_attempts') return deleteBatch(guarded, 'public_marketapp_login_attempts', 'created_at<:cutoff AND expires_at<:cutoff', {':cutoff': cutoff});
    if (phase === 'wallet_challenges') return deleteBatch(guarded, 'public_wallet_challenges', 'created_at<:cutoff AND expires_at<:cutoff', {':cutoff': cutoff});
    if (phase === 'wallet_attempts') return deleteBatch(guarded, 'public_wallet_attempts', 'created_at<:cutoff', {':cutoff': cutoff});
    if (phase === 'website_requests') return deleteBatch(guarded, 'marketapp_website_requests', 'attempted_at<:cutoff', {':cutoff': cutoff});
    if (phase === 'reservations') return deleteBatch(guarded, 'service_storage_reservations', 'expires_at<:cutoff', {':cutoff': cutoff});
    if (phase.startsWith('public_')) return publicPhase(guarded, cursor, phase, work);
    if (!cursor.boundary) return {complete: true, rewritten: 0};
    if (phase !== 'jobs' && !await work.sourceReady('private'))
      return {complete: false, rewritten: 0};
    if (phase === 'targets') return targetPage(guarded, cursor, null, work);
    const repository = work.repository, input = {after: cursor.after, boundary: cursor.boundary, limit: policy.duplicateWrites};
    const method = {jobs: 'compactCheckpointJobsPage', owned_states: 'compactCheckpointOwnedStatesPage',
      gift_states: 'compactCheckpointGiftStatesPage', budget_resets: 'compactCheckpointBudgetResetsPage'}[phase];
    return repository[method](input);
  }
  async function accountBatch(guarded, cursor, at, user, generation, work) {
    const phase = accountPhases[cursor.phase], active = `user_id=:tenant AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:tenant AND generation=:account_generation AND status='active')`;
    const params = {':tenant': user, ':account_generation': generation, ':cutoff': at - policy.metadataRetentionMs};
    if (phase === 'public_cache') return deleteBatch(guarded, 'public_dashboard_projection_cache', active, {':tenant': user, ':account_generation': generation});
    if (phase === 'public_attempts') return deleteBatch(guarded, 'public_marketapp_login_attempts', `${active} AND created_at<:cutoff AND expires_at<:cutoff`, params);
    if (phase === 'wallet_challenges') return deleteBatch(guarded, 'public_wallet_challenges', `${active} AND created_at<:cutoff AND expires_at<:cutoff`, params);
    if (phase === 'wallet_attempts') return deleteBatch(guarded, 'public_wallet_attempts', `${active} AND created_at<:cutoff`, params);
    cursor.tenant = user; cursor.tenant_generation = generation;
    const result = await publicPhase(guarded, cursor, phase, work);
    return {...result, complete: cursor.tenant === null};
  }
  async function publish(document, lease, user = null, generation = null, release = true) {
    // Admission may change the pause bit while this worker owns the cleanup
    // lease. Recalculate from its current bit and live usage in this statement.
    const result = await db.run(`UPDATE service_storage_monitor SET document=json_set(:document,'$.paused',json(CASE
      WHEN (SELECT total_bytes FROM service_storage_usage WHERE id=1)>=CASE
        WHEN json_extract(document,'$.paused')=1 THEN :resume_limit ELSE :pause_limit END THEN 'true' ELSE 'false' END)),
        lease_id=CASE WHEN :release=1 THEN NULL ELSE lease_id END,lease_until=CASE WHEN :release=1 THEN 0 ELSE lease_until END
      WHERE id=1 AND lease_id=:lease AND lease_until>${CLOCK}${user === null ? '' : ` AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:maintenance_user AND generation=:maintenance_generation AND status='active')`}`,
      {':document': JSON.stringify(document), ':lease': lease, ':release': release ? 1 : 0, ':resume_limit': policy.budgetBytes * policy.resumeRatio,
        ':pause_limit': policy.budgetBytes * policy.pauseRatio, ...(user === null ? {} : {':maintenance_user': user, ':maintenance_generation': generation})});
    return result.rowsAffected === 1;
  }
  async function runCleanup(cleanup, at, lease, checkpoint, user = null, generation = null) {
    const work = maintenanceWork(leasedDb(lease, user, generation)), wallStart = Date.now();
    const duration = Math.min(REQUEST_WORK_MS, Math.floor(policy.leaseMs / 2));
    for (let index = 0; index < REQUEST_BATCHES && cleanup.state === 'running'; index++) {
      const currentTime = await time();
      // Count bounds are independent of host clocks, which can be fixed for
      // an invocation. Each SQL page and publication retains its smaller cap.
      if (currentTime - at >= duration || Date.now() - wallStart >= duration || work.queries() >= REQUEST_QUERIES) break;
      const next = {...cleanup};
      try {
        const result = user === null ? await batch(work.db, next, currentTime, work)
          : await accountBatch(work.db, next, currentTime, user, generation, work);
        if (result.after !== undefined) next.after = result.after;
        if (result.complete) {
          next.phase++; next.after = 0; next.tenant = user; next.last_tenant = '';
          next.boundary = user === null
            ? (await work.db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary
            : (await work.db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM public_cloud_events WHERE user_id=:user', {':user': user})).boundary;
          if (next.phase >= (user === null ? phases.length : accountPhases.length)) {
            next.phase = 0; next.state = 'complete'; next.last_completed_at = currentTime;
          }
        }
      } catch (error) {
        // A partially rewritten batch is safe to repeat from its old cursor.
        // Exhausting our work allowance is an ordinary yield, not a failure.
        if (error instanceof CleanupWorkLimit) break;
        throw error;
      }
      // Publication confirms both the lease and, for invited users, the active
      // account generation. Never continue after a lost or uncertain commit.
      await checkpoint(next, currentTime);
      cleanup = next;
    }
    return cleanup;
  }
  async function stepAccount(user, manual, at, current, generation, progress, growth) {
    const active = await account(user, generation);
    if (!active) return response(user, false, at, current, generation, progress, growth);
    const usage = await db.get('SELECT total_bytes,initialized_at FROM service_storage_scope_usage WHERE scope=:scope', {':scope': `public:${user}`});
    if (!nonnegative(usage?.total_bytes) || !iso(usage?.initialized_at)) return response(user, false, at, current, active.generation, progress, growth);
    const lease = `${at}:${Math.floor(random() * 9007199254740991).toString(36)}:${Math.floor(random() * 9007199254740991).toString(36)}`;
    const acquired = await db.run(`UPDATE service_storage_monitor SET lease_id=:lease,lease_until=:until
      WHERE id=1 AND lease_until<=${CLOCK} AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=:user AND generation=:generation AND status='active')`,
      {':lease': lease, ':until': at + policy.leaseMs, ':user': user, ':generation': active.generation});
    if (acquired.rowsAffected !== 1) return response(user, false, at, null, active.generation, progress, growth);
    let document = decodeDocument((await db.get('SELECT document FROM service_storage_monitor WHERE id=1 AND lease_id=:lease', {':lease': lease}))?.document);
    const own = accountDocument(document, user, active.generation);
    try {
      let before = (await db.get('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=:scope', {':scope': `public:${user}`})).total_bytes;
      let cleanup = validCleanup(own.cleanup) && own.cleanup.phase < accountPhases.length ? {...own.cleanup} : {state: 'idle'};
      const stale = !iso(own.checked_at) || at - own.checked_at >= policy.inventoryFreshMs;
      const due = !iso(cleanup.last_completed_at) || at - cleanup.last_completed_at >= policy.cleanupFreshMs
        || urgentCleanup(before, cleanup, {...policy, budgetBytes: maxAccountBytes});
      const headroomLow = before > Math.max(0, maxAccountBytes - PUBLIC_COLLECTION_HEADROOM_BYTES);
      const required = manual || cleanup.state === 'running' || cleanup.state !== 'blocked' && due && (headroomLow || before >= maxAccountBytes * policy.cleanupRatio);
      if (required && cleanup.state !== 'running') {
        if (cleanup.state === 'blocked' && validCleanup(cleanup)) cleanup.state = 'running';
        else Object.assign(cleanup, {state: 'running', phase: 0, after: 0, tenant: user, tenant_generation: active.generation, last_tenant: '',
          boundary: (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM public_cloud_events WHERE user_id=:user', {':user': user})).boundary,
          reclaimed_bytes: 0, started_at: at});
      }
      const activeAccounts = await db.all("SELECT user_id,generation FROM public_accounts WHERE status='active' ORDER BY user_id LIMIT 101");
      if (activeAccounts.length > 100) throw new Error('Invalid account storage inventory');
      const retainedMonitors = Object.fromEntries(activeAccounts.filter(row => object(document.accounts?.[row.user_id]) && document.accounts[row.user_id].generation === row.generation)
        .map(row => [row.user_id, document.accounts[row.user_id]]));
      if (cleanup.state === 'running') cleanup = await runCleanup(cleanup, at, lease, async (next, checked) => {
        const bytes = (await db.get('SELECT total_bytes FROM service_storage_scope_usage WHERE scope=:scope', {':scope': `public:${user}`})).total_bytes;
        if (!nonnegative(bytes)) throw new Error('Storage accounting unavailable');
        next.reclaimed_bytes = (nonnegative(next.reclaimed_bytes) ? next.reclaimed_bytes : 0) + Math.max(0, before - bytes);
        if (next.state === 'complete') next.completed_bytes = bytes;
        const updated = {...document, version: 1, accounts: {...retainedMonitors,
          [user]: {...accountDocument(document, user, active.generation), generation: active.generation, checked_at: checked, cleanup: next}}};
        if (!await publish(updated, lease, user, active.generation, false)) throw new Error('Cleanup lease changed');
        document = updated; before = bytes;
      }, user, active.generation);
      const measured = await db.get('SELECT total_bytes,initialized_at FROM service_storage_scope_usage WHERE scope=:scope', {':scope': `public:${user}`});
      const after = measured.total_bytes;
      if (!nonnegative(after)) throw new Error('Storage accounting unavailable');
      if (cleanup.state === 'complete' && cleanup.last_completed_at === at) cleanup.completed_bytes = after;
      cleanup.reclaimed_bytes = (nonnegative(cleanup.reclaimed_bytes) ? cleanup.reclaimed_bytes : 0) + Math.max(0, before - after);
      // At most 100 active accounts are accepted by the public runtime. Retire
      // deleted/generation-changed monitoring cursors instead of accumulating them.
      const accounts = await db.all("SELECT user_id,generation FROM public_accounts WHERE status='active' ORDER BY user_id LIMIT 101");
      if (accounts.length > 100) throw new Error('Invalid account storage inventory');
      const monitors = Object.fromEntries(accounts.filter(row => object(document.accounts?.[row.user_id]) && document.accounts[row.user_id].generation === row.generation)
        .map(row => [row.user_id, document.accounts[row.user_id]]));
      monitors[user] = {generation: active.generation, checked_at: stale || required ? at : own.checked_at, cleanup,
        usage_history: recordUsage(accountDocument(document, user, active.generation).usage_history, measured, await time())};
      document = {...document, version: 1, accounts: monitors};
    } catch {
      // A corrupt or previously unbounded map must not grow further on the
      // error path. Ordinary maps retain every other account's durable cursor.
      const monitors = Object.fromEntries(Object.entries(object(document.accounts) ? document.accounts : {})
        .filter(([id, value]) => id !== user && identity(id) && object(value) && nonnegative(value.generation)).slice(0, 99));
      document = {...document, version: 1, accounts: {...monitors,
        [user]: {...accountDocument(document, user, active.generation), generation: active.generation,
          cleanup: {...(accountDocument(document, user, active.generation).cleanup || {}), state: 'blocked'}}}};
    } finally {
      await publish(document, lease, user, active.generation);
      // An account generation may change between cleanup and publication. Only
      // release our live lease; never publish the old account's cursor to its replacement.
      await db.run(`UPDATE service_storage_monitor SET lease_id=NULL,lease_until=0 WHERE id=1 AND lease_id=:lease AND lease_until>${CLOCK}`, {':lease': lease});
    }
    return response(user, false, await time(), null, active.generation, progress, growth);
  }
  return {
    async status({userId, isOwner, accountGeneration = null, progress = false, growth = false}) {
      const user = authorize(userId, isOwner);if(typeof progress!=='boolean'||typeof growth!=='boolean')throw new Error('Invalid storage maintenance input');
      return response(user, isOwner, await time(), null, accountGeneration, progress, growth);
    },
    async step({userId, isOwner, manual = false, accountGeneration = null, progress = false, growth = false}) {
      const user = authorize(userId, isOwner); if (typeof manual !== 'boolean'||typeof progress!=='boolean'||typeof growth!=='boolean') throw new Error('Invalid storage maintenance input');
      const at = await time(), current = await snapshot();
      if (!nonnegative(current.usage?.total_bytes) || !iso(current.usage?.initialized_at)) return response(user, isOwner, at, current,accountGeneration,progress,growth);
      if (!isOwner) return stepAccount(user, manual, at, current, accountGeneration,progress,growth);
      const lease = `${at}:${Math.floor(random() * 9007199254740991).toString(36)}:${Math.floor(random() * 9007199254740991).toString(36)}`;
      const acquired = await db.run(`UPDATE service_storage_monitor SET lease_id=:lease,lease_until=:until
        WHERE id=1 AND lease_until<=${CLOCK}`, {':lease': lease, ':until': at + policy.leaseMs});
      if (acquired.rowsAffected !== 1) return response(user, isOwner, at,null,accountGeneration,progress,growth);
      let document = decodeDocument((await db.get('SELECT document FROM service_storage_monitor WHERE id=1 AND lease_id=:lease', {':lease': lease}))?.document);
      try {
        let before = (await db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1')).total_bytes;
        let cleanup = validCleanup(document.cleanup) ? {...document.cleanup} : {state: 'idle'};
        const stale = !iso(document.checked_at) || at - document.checked_at >= policy.inventoryFreshMs;
        const due = !iso(cleanup.last_completed_at) || at - cleanup.last_completed_at >= policy.cleanupFreshMs
          || urgentCleanup(before, cleanup, policy);
        const required = manual || cleanup.state === 'running'
          || cleanup.state !== 'blocked' && due && before >= policy.budgetBytes * policy.cleanupRatio;
        if (required && cleanup.state !== 'running') {
          if (cleanup.state === 'blocked' && validCleanup(cleanup)) cleanup.state = 'running';
          else Object.assign(cleanup, {state: 'running', phase: 0, after: 0, tenant: null, last_tenant: '',
              boundary: (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary,
              reclaimed_bytes: 0, started_at: at});
        }
        if (cleanup.state === 'running') cleanup = await runCleanup(cleanup, at, lease, async (next, checked) => {
          const bytes = (await db.get('SELECT total_bytes FROM service_storage_usage WHERE id=1')).total_bytes;
          if (!nonnegative(bytes)) throw new Error('Storage accounting unavailable');
          next.reclaimed_bytes = (nonnegative(next.reclaimed_bytes) ? next.reclaimed_bytes : 0) + Math.max(0, before - bytes);
          if (next.state === 'complete') next.completed_bytes = bytes;
          const updated = {...document, version: 1, checked_at: checked, cleanup: next};
          if (!await publish(updated, lease, null, null, false)) throw new Error('Cleanup lease changed');
          document = updated; before = bytes;
        });
        const measured = await db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1');
        const after = measured.total_bytes;
        if (!nonnegative(after)) throw new Error('Storage accounting unavailable');
        if (cleanup.state === 'complete' && cleanup.last_completed_at === at) cleanup.completed_bytes = after;
        cleanup.reclaimed_bytes = (nonnegative(cleanup.reclaimed_bytes) ? cleanup.reclaimed_bytes : 0) + Math.max(0, before - after);
        document = {...document, version: 1, paused: storagePaused(after, document.paused === true, policy),
          checked_at: stale || required ? at : document.checked_at, cleanup,
          usage_history: recordUsage(document.usage_history, measured, await time())};
      } catch {
        // Preserve the last durable cursor. Any successful shrink before an
        // interrupted metadata write is safe to repeat; source evidence stays.
        document = {...document, version: 1, paused: document.paused === true,
          cleanup: {...(object(document.cleanup) ? document.cleanup : {}), state: 'blocked'}};
      } finally {
        await publish(document, lease);
      }
      return response(user, isOwner, await time(),null,accountGeneration,progress,growth);
    },
  };
}
