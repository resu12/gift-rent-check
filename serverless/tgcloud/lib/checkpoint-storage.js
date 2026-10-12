// Store the Marketapp job once per event. Its immutable job_json column is
// already the source for job history/resume; the reference preserves every
// logical checkpoint field while avoiding a second full copy of the job.
import {BUDGET_RESET_MARKER, encodeBudgetResetReference, decodeBudgetResetReference, createBudgetResetCheckpointStorage,
  checkpointSourceIndexReadySql, checkpointSourceScopeSql, CHECKPOINT_SOURCE_TRIGGERS_READY, findBoundedCheckpointSource,
  readCheckpointPhysicalPage} from './budget-reset-checkpoint-storage.js';
const MARKER = '__checkpoint_job_sequence';
const TARGET_MARKER = '__checkpoint_owned_targets_sequence';
const OWNED_MARKER = '__checkpoint_owned_state_sequence';
const GIFT_MARKER = '__checkpoint_gift_state_sequence';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSequence = value => Number.isSafeInteger(value) && value > 0;
// Explicit opt-in after a development reset. New checkpoints are standalone;
// atomic database triggers retain only the head and compact run/job archives.
export const OPERATIONAL_STORAGE_VERSION = 1;
export const COMPACT_OPERATIONAL_TRIGGER_NAMES = Object.freeze(['operational_storage_v1_private_insert', 'operational_storage_v1_public_insert']);
export const COMPACT_OPERATIONAL_READY_SQL = `(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (${COMPACT_OPERATIONAL_TRIGGER_NAMES.map(name => `'${name}'`).join(',')}))=2`;
export const usesCompactOperationalStorage = state => plain(state) && state.operational_storage_version === OPERATIONAL_STORAGE_VERSION;
const targetRun = state => plain(state.owned_prices) && plain(state.owned_prices.run) ? state.owned_prices.run : null;
const targetIdentity = run => plain(run) && validSequence(run.id) && Object.hasOwn(run, 'wallet')
  && (run.wallet === null || typeof run.wallet === 'string');
function sourceTargets(source, sequence, run) {
  if (!source || !validSequence(source.sequence) || source.sequence >= sequence || !targetIdentity(run)
      || source.run_id !== run.id || !Object.hasOwn(source, 'wallet') || source.wallet !== run.wallet
      || typeof source.targets_json !== 'string') throw new Error('Invalid owned-target checkpoint source');
  const targets = JSON.parse(source.targets_json);
  if (!Array.isArray(targets)) throw new Error('Invalid owned-target checkpoint array');
  return targets;
}
function sourceOwned(source, sequence) {
  if (!source || !validSequence(source.sequence) || source.sequence >= sequence || typeof source.owned_prices_json !== 'string'
      || !Object.hasOwn(source, 'target_sequence') || !(source.target_sequence === null
        || validSequence(source.target_sequence) && source.target_sequence < source.sequence)) throw new Error('Invalid owned-state checkpoint source');
  const own = JSON.parse(source.owned_prices_json);
  if (!plain(own)) throw new Error('Invalid owned-state checkpoint object');
  return own;
}
function sourceGift(source, sequence) {
  if (!source || !validSequence(source.sequence) || source.sequence >= sequence || typeof source.gift_refresh_json !== 'string') throw new Error('Invalid gift-state checkpoint source');
  const gift = JSON.parse(source.gift_refresh_json);
  if (!plain(gift)) throw new Error('Invalid gift-state checkpoint object');
  return gift;
}
export function encodeCheckpoint(state, job, sequence, prior = null, targetSource = null, ownedSource = null, giftSource = null, budgetSource = null) {
  if (!plain(state) || Object.hasOwn(state, MARKER) || Object.hasOwn(state, TARGET_MARKER) || Object.hasOwn(state, OWNED_MARKER) || Object.hasOwn(state, GIFT_MARKER) || Object.hasOwn(state, BUDGET_RESET_MARKER)) throw new Error('Invalid checkpoint storage marker');
  if (usesCompactOperationalStorage(state)) return JSON.stringify(state);
  const result = {...state};
  // TON checks do not publish a Marketapp job, but can reference an earlier
  // immutable job column when its entire value still matches this checkpoint.
  let source = sequence;
  if (!plain(job) && prior) {
    if (!Number.isSafeInteger(prior.sequence) || prior.sequence <= 0 || prior.sequence >= sequence || typeof prior.job_json !== 'string') throw new Error('Invalid checkpoint source');
    job = JSON.parse(prior.job_json); source = prior.sequence;
    if (!plain(job) || prior.job_id !== job.id) throw new Error('Invalid checkpoint source job');
  }
  if (plain(job) && validSequence(job.id) && plain(state.job) && JSON.stringify(state.job) === JSON.stringify(job)) {
    if (!validSequence(sequence)) throw new Error('Invalid checkpoint sequence');
    delete result.job; result[MARKER] = source;
  }
  if (targetSource) {
    if (!validSequence(sequence)) throw new Error('Invalid checkpoint sequence');
    const run = targetRun(state), targets = sourceTargets(targetSource, sequence, run);
    if (!Array.isArray(run.targets) || JSON.stringify(run.targets) !== JSON.stringify(targets)) throw new Error('Owned-target checkpoint source does not match');
    const storedRun = {...run}; delete storedRun.targets;
    result.owned_prices = {...state.owned_prices, run: storedRun}; result[TARGET_MARKER] = targetSource.sequence;
  }
  if (ownedSource) {
    if (!validSequence(sequence)) throw new Error('Invalid checkpoint sequence');
    const own = sourceOwned(ownedSource, sequence);
    if (!plain(result.owned_prices) || JSON.stringify(result.owned_prices) !== JSON.stringify(own)
        || (result[TARGET_MARKER] ?? null) !== ownedSource.target_sequence) throw new Error('Owned-state checkpoint source does not match');
    delete result.owned_prices; delete result[TARGET_MARKER]; result[OWNED_MARKER] = ownedSource.sequence;
  }
  if (giftSource) {
    if (!validSequence(sequence)) throw new Error('Invalid checkpoint sequence');
    const gift = sourceGift(giftSource, sequence);
    if (!plain(result.gift_refresh) || JSON.stringify(result.gift_refresh) !== JSON.stringify(gift)) throw new Error('Gift-state checkpoint source does not match');
    delete result.gift_refresh; result[GIFT_MARKER] = giftSource.sequence;
  }
  return JSON.stringify(encodeBudgetResetReference(result, sequence, budgetSource));
}
export function decodeCheckpoint(row, source = row, targetSource = null, ownedSource = null, giftSource = null, budgetSource = null) {
  const state = JSON.parse(row.state_json);
  if (!plain(state)) throw new Error('Invalid saved checkpoint');
  if (Object.hasOwn(state, MARKER)) {
    if (!Number.isSafeInteger(state[MARKER]) || state[MARKER] <= 0 || state[MARKER] > row.sequence || source?.sequence !== state[MARKER] || Object.hasOwn(state, 'job') || typeof source.job_json !== 'string') throw new Error('Invalid saved checkpoint reference');
    const job = JSON.parse(source.job_json);
    if (!plain(job) || !Number.isSafeInteger(job.id) || job.id <= 0 || source.job_id !== job.id) throw new Error('Invalid saved checkpoint job');
    delete state[MARKER]; state.job = job;
  }
  let targetBoundary = row.sequence;
  if (Object.hasOwn(state, OWNED_MARKER)) {
    if (!validSequence(row.sequence) || !validSequence(state[OWNED_MARKER]) || state[OWNED_MARKER] >= row.sequence
        || ownedSource?.sequence !== state[OWNED_MARKER] || Object.hasOwn(state, 'owned_prices') || Object.hasOwn(state, TARGET_MARKER)) throw new Error('Invalid saved owned-state checkpoint reference');
    state.owned_prices = sourceOwned(ownedSource, row.sequence);
    if (ownedSource.target_sequence !== null) state[TARGET_MARKER] = ownedSource.target_sequence;
    targetBoundary = ownedSource.sequence; delete state[OWNED_MARKER];
  }
  if (Object.hasOwn(state, TARGET_MARKER)) {
    const run = targetRun(state);
    if (!validSequence(row.sequence) || !validSequence(state[TARGET_MARKER]) || state[TARGET_MARKER] >= targetBoundary
        || targetSource?.sequence !== state[TARGET_MARKER] || !run || Object.hasOwn(run, 'targets')) throw new Error('Invalid saved owned-target checkpoint reference');
    run.targets = sourceTargets(targetSource, targetBoundary, run); delete state[TARGET_MARKER];
  }
  if (Object.hasOwn(state, GIFT_MARKER)) {
    if (!validSequence(row.sequence) || !validSequence(state[GIFT_MARKER]) || state[GIFT_MARKER] >= row.sequence
        || giftSource?.sequence !== state[GIFT_MARKER] || Object.hasOwn(state, 'gift_refresh')) throw new Error('Invalid saved gift-state checkpoint reference');
    state.gift_refresh = sourceGift(giftSource, row.sequence); delete state[GIFT_MARKER];
  }
  return decodeBudgetResetReference(state, row.sequence, budgetSource);
}
// CASE keeps malformed legacy JSON from entering JSON functions. Only exact
// duplicates qualify; missing/null jobs and existing markers remain untouched.
export const COMPACTABLE_CHECKPOINT = `CASE WHEN json_valid(state_json) AND json_valid(job_json) THEN
  json_type(state_json,'$')='object' AND json_type(state_json,'$.job')='object'
  AND json_type(state_json,'$.__checkpoint_job_sequence') IS NULL
  AND json_type(json_remove(state_json,'$.job'),'$.job') IS NULL
  AND json_type(job_json,'$')='object' AND json_type(job_json,'$.id')='integer'
  AND json_extract(job_json,'$.id')=job_id AND job_id BETWEEN 1 AND 9007199254740991
  AND json_extract(state_json,'$.job')=job_json ELSE 0 END`;
// Private historical TON checkpoints may have copied the last Marketapp job
// without publishing their own job column. Reuse only a real immutable column,
// never another state marker, and keep the public tenant predicate unchanged.
const INLINE_JOB = `CASE WHEN json_valid(state_json) THEN
  json_type(state_json,'$')='object' AND json_type(state_json,'$.job')='object'
  AND json_type(state_json,'$.__checkpoint_job_sequence') IS NULL
  AND json_type(json_remove(state_json,'$.job'),'$.job') IS NULL
  AND json_type(state_json,'$.job.id')='integer'
  AND json_extract(state_json,'$.job.id') BETWEEN 1 AND 9007199254740991
  AND json_type(json_remove(state_json,'$.job.id'),'$.job.id') IS NULL ELSE 0 END`;
const validJobColumn = (prefix = '') => `CASE WHEN json_valid(${prefix}job_json) THEN
  json_type(${prefix}job_json,'$')='object' AND json_type(${prefix}job_json,'$.id')='integer'
  AND json_extract(${prefix}job_json,'$.id')=${prefix}job_id AND ${prefix}job_id BETWEEN 1 AND 9007199254740991
  AND json_type(json_remove(${prefix}job_json,'$.id'),'$.id') IS NULL ELSE 0 END`;
// Keep the first exact array for each frozen run/wallet inline permanently.
// Only later copies can reference it, so maintenance never creates chains.
// Duplicate parent/id/wallet/targets keys are skipped: SQLite and JSON.parse
// can otherwise disagree about which value a malformed legacy object means.
export const INLINE_TARGETS = `CASE WHEN json_valid(state_json) THEN
  json_type(state_json,'$')='object'
  AND json_type(state_json,'$.__checkpoint_owned_targets_sequence') IS NULL
  AND json_type(state_json,'$.__checkpoint_owned_state_sequence') IS NULL
  AND json_type(state_json,'$.owned_prices')='object'
  AND json_type(json_remove(state_json,'$.owned_prices'),'$.owned_prices') IS NULL
  AND json_type(state_json,'$.owned_prices.run')='object'
  AND json_type(json_remove(state_json,'$.owned_prices.run'),'$.owned_prices.run') IS NULL
  AND json_type(state_json,'$.owned_prices.run.id')='integer'
  AND json_extract(state_json,'$.owned_prices.run.id') BETWEEN 1 AND 9007199254740991
  AND json_type(json_remove(state_json,'$.owned_prices.run.id'),'$.owned_prices.run.id') IS NULL
  AND json_type(state_json,'$.owned_prices.run.wallet') IN ('text','null')
  AND json_type(json_remove(state_json,'$.owned_prices.run.wallet'),'$.owned_prices.run.wallet') IS NULL
  AND json_type(state_json,'$.owned_prices.run.targets')='array'
  AND json_type(json_remove(state_json,'$.owned_prices.run.targets'),'$.owned_prices.run.targets') IS NULL
  ELSE 0 END`;
const TARGET_PROJECTION = `sequence,json_extract(state_json,'$.owned_prices.run.id') AS run_id,
  json_extract(state_json,'$.owned_prices.run.wallet') AS wallet,
  json_extract(state_json,'$.owned_prices.run.targets') AS targets_json`;
// Source rows stay inline. Guard duplicate root keys and malformed target
// markers so SQLite and the JavaScript reader agree on the physical document.
const INLINE_OWNED = `CASE WHEN json_valid(state_json) THEN
  json_type(state_json,'$')='object' AND json_type(state_json,'$.__checkpoint_owned_state_sequence') IS NULL
  AND json_type(state_json,'$.owned_prices')='object'
  AND json_type(json_remove(state_json,'$.owned_prices'),'$.owned_prices') IS NULL
  AND (json_type(state_json,'$.__checkpoint_owned_targets_sequence') IS NULL OR
    (json_type(state_json,'$.__checkpoint_owned_targets_sequence')='integer'
      AND json_extract(state_json,'$.__checkpoint_owned_targets_sequence') BETWEEN 1 AND 9007199254740991
      AND json_extract(state_json,'$.__checkpoint_owned_targets_sequence')<sequence
      AND json_type(json_remove(state_json,'$.__checkpoint_owned_targets_sequence'),'$.__checkpoint_owned_targets_sequence') IS NULL))
  ELSE 0 END`;
const OWNED_PROJECTION = `sequence,json_extract(state_json,'$.owned_prices') AS owned_prices_json,
  json_extract(state_json,'$.__checkpoint_owned_targets_sequence') AS target_sequence`;
const INLINE_GIFT = `CASE WHEN json_valid(state_json) THEN
  json_type(state_json,'$')='object' AND json_type(state_json,'$.__checkpoint_gift_state_sequence') IS NULL
  AND json_type(state_json,'$.gift_refresh')='object'
  AND json_type(json_remove(state_json,'$.gift_refresh'),'$.gift_refresh') IS NULL ELSE 0 END`;
const GIFT_PROJECTION = `sequence,json_extract(state_json,'$.gift_refresh') AS gift_refresh_json`;
const LEGACY_PROTECTED_GIFT_SOURCES = `protected_gift_sources AS MATERIALIZED (
  SELECT CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.__checkpoint_gift_state_sequence') ELSE NULL END AS source
  FROM cloud_events WHERE state_json LIKE '%"__checkpoint_gift_state_sequence"%')`;
const UNREFERENCED_GIFT = `NOT EXISTS(SELECT 1 FROM protected_gift_sources WHERE source=cloud_events.sequence)`;
export const GIFT_SOURCE_FENCE = `(:gift_source IS NULL OR EXISTS(SELECT 1 FROM cloud_events source
  WHERE source.sequence=:gift_source AND source.sequence<:sequence AND ${INLINE_GIFT}
    AND CASE WHEN json_valid(source.state_json) THEN json_extract(source.state_json,'$.gift_refresh')=:gift_json ELSE 0 END))`;
// Recheck both immutable representations in the same statement that publishes
// a reference. Source hints only save lookup work; they never replace SQL CAS
// or the exact identity/content guards against concurrent maintenance.
export const OWNED_SOURCE_FENCE = `(:owned_source IS NULL OR EXISTS(SELECT 1 FROM cloud_events source
  WHERE source.sequence=:owned_source AND source.sequence<:sequence AND ${INLINE_OWNED}
    AND CASE WHEN json_valid(source.state_json) THEN
      json_extract(source.state_json,'$.owned_prices')=:owned_json
      AND json_extract(source.state_json,'$.__checkpoint_owned_targets_sequence') IS :owned_target ELSE 0 END))`;
export const OWNED_TARGET_SOURCE_FENCE = `(:target_source IS NULL OR EXISTS(SELECT 1 FROM cloud_events source
  WHERE source.sequence=:target_source AND source.sequence<:sequence AND ${INLINE_TARGETS}
    AND CASE WHEN json_valid(source.state_json) THEN
      json_extract(source.state_json,'$.owned_prices.run.id')=:target_id
      AND json_extract(source.state_json,'$.owned_prices.run.wallet') IS :target_wallet
      AND json_extract(source.state_json,'$.owned_prices.run.targets')=:targets_json ELSE 0 END))`;
// A source can be referenced by a future event between selection and UPDATE.
// Recheck at publication: never remove or change either source representation.
const REFERENCE_FILTER = `(state_json LIKE '%"__checkpoint_owned_state_sequence"%' OR state_json LIKE '%"__checkpoint_owned_targets_sequence"%')`;
const REFERENCE_PROJECTION = `sequence,
  CASE WHEN json_valid(state_json) THEN CASE WHEN json_type(state_json,'$.__checkpoint_owned_state_sequence')='integer'
    THEN json_extract(state_json,'$.__checkpoint_owned_state_sequence') ELSE NULL END ELSE NULL END AS owned_source,
  CASE WHEN json_valid(state_json) THEN CASE WHEN json_type(state_json,'$.__checkpoint_owned_targets_sequence')='integer'
    THEN json_extract(state_json,'$.__checkpoint_owned_targets_sequence') ELSE NULL END ELSE NULL END AS target_source`;
const LEGACY_PROTECTED_SOURCES = `protected_checkpoint_sources AS MATERIALIZED (SELECT ${REFERENCE_PROJECTION}
  FROM cloud_events WHERE ${REFERENCE_FILTER})`;
const UNREFERENCED_OWNED = `NOT EXISTS(SELECT 1 FROM protected_checkpoint_sources WHERE owned_source=cloud_events.sequence)`;
const UNREFERENCED_TARGET = `NOT EXISTS(SELECT 1 FROM protected_checkpoint_sources WHERE target_source=cloud_events.sequence)`;
// The tiny monotonic index keeps root protection out of historical JSON scans.
// Triggers capture new references before a bounded bootstrap starts; bootstrap
// pins every duplicate top-level marker, including integral JSON real numbers.
export function createCheckpointSourceIndex(db) {
  return {async ensurePage(scope) {
    const scopeSql = checkpointSourceScopeSql(scope), publicScope = scope.startsWith('public:'),
      table = publicScope ? 'public_cloud_events' : 'cloud_events', tenant = publicScope ? 'AND user_id=:source_tenant' : '',
      tenantParameters = publicScope ? {':source_tenant': scope.slice(7)} : {};
    if (!await db.get(`SELECT 1 AS ready WHERE ${CHECKPOINT_SOURCE_TRIGGERS_READY}`)) throw new Error('Checkpoint source triggers are not installed');
    await db.run(`INSERT OR IGNORE INTO service_checkpoint_source_scans(scope,after_sequence,boundary_sequence,initialized_at)
      SELECT ${scopeSql},0,(SELECT COALESCE(MAX(sequence),0) FROM ${table} WHERE 1=1 ${tenant}),0
      WHERE ${CHECKPOINT_SOURCE_TRIGGERS_READY}`, tenantParameters);
    const scan = await db.get(`SELECT after_sequence,boundary_sequence,initialized_at FROM service_checkpoint_source_scans WHERE scope=${scopeSql}`);
    if (!scan || !Number.isSafeInteger(scan.after_sequence) || scan.after_sequence < 0 || !Number.isSafeInteger(scan.boundary_sequence)
        || scan.boundary_sequence < scan.after_sequence || !Number.isSafeInteger(scan.initialized_at) || scan.initialized_at < 0) throw new Error('Invalid checkpoint source cursor');
    if (scan.initialized_at > 0) return {complete: true, after_sequence: scan.after_sequence, initialized_at: scan.initialized_at};
    const rows = await db.all(`WITH pending AS MATERIALIZED(SELECT sequence,state_json,length(CAST(state_json AS BLOB)) AS bytes FROM ${table}
      WHERE sequence>:source_after AND sequence<=:source_boundary ${tenant} ORDER BY sequence LIMIT 25),
      bounded AS(SELECT sequence,bytes,SUM(bytes) OVER(ORDER BY sequence) AS total_bytes FROM pending)
      SELECT sequence,bytes FROM bounded WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`,
      {...tenantParameters, ':source_after': scan.after_sequence, ':source_boundary': scan.boundary_sequence});
    let after = rows.length ? rows[rows.length - 1].sequence : scan.boundary_sequence;
    if (rows.length) {
      const parameters = {...tenantParameters}, selected = rows.map((row, index) => {parameters[`:source_row${index}`] = row.sequence; return `:source_row${index}`;});
      await db.run(`WITH page AS MATERIALIZED(SELECT sequence,state_json FROM ${table} WHERE sequence IN(${selected.join(',')}) ${tenant}),
        markers AS(SELECT sequence,marker.key,CAST(marker.value AS INTEGER) AS source_sequence,CASE marker.key
          WHEN '__checkpoint_owned_targets_sequence' THEN 'owned_targets' WHEN '__checkpoint_owned_state_sequence' THEN 'owned_state'
          WHEN '__checkpoint_gift_state_sequence' THEN 'gift_state' WHEN '__checkpoint_budget_reset_sequence' THEN 'budget_reset' END AS kind
          FROM page,json_each(CASE WHEN json_valid(page.state_json) THEN CASE WHEN json_type(page.state_json,'$')='object'
            THEN page.state_json ELSE '{}' END ELSE '{}' END) marker
          WHERE marker.key IN('__checkpoint_owned_targets_sequence','__checkpoint_owned_state_sequence','__checkpoint_gift_state_sequence','__checkpoint_budget_reset_sequence')
            AND marker.type IN('integer','real') AND marker.value BETWEEN 1 AND 9007199254740991
            AND marker.value=CAST(marker.value AS INTEGER) AND marker.value<page.sequence)
        INSERT OR IGNORE INTO service_checkpoint_sources(row_id,scope,kind,source_sequence)
        SELECT json_array(${scopeSql},kind,source_sequence),${scopeSql},kind,source_sequence FROM markers
        WHERE ${CHECKPOINT_SOURCE_TRIGGERS_READY}`, parameters);
    }
    const result = await db.run(`UPDATE service_checkpoint_source_scans SET after_sequence=:source_next,
      initialized_at=CASE WHEN :source_next>=boundary_sequence THEN CAST(strftime('%s','now') AS INTEGER)*1000 ELSE 0 END
      WHERE scope=${scopeSql} AND after_sequence=:source_after AND boundary_sequence=:source_boundary AND initialized_at=0
        AND ${CHECKPOINT_SOURCE_TRIGGERS_READY}`, {':source_next': after, ':source_after': scan.after_sequence, ':source_boundary': scan.boundary_sequence});
    if (result.rowsAffected !== 1) throw new Error('Checkpoint source cursor changed');
    const saved = await db.get(`SELECT after_sequence,initialized_at FROM service_checkpoint_source_scans WHERE scope=${scopeSql}`);
    return {complete: saved.initialized_at > 0, after_sequence: saved.after_sequence, initialized_at: saved.initialized_at};
  }};
}
export function createCheckpointStorage(db, {sourceScope = null} = {}) {
  if (sourceScope !== null && sourceScope !== 'private') throw new Error('Invalid private checkpoint source scope');
  const indexReady = sourceScope === null ? '1=1' : checkpointSourceIndexReadySql(sourceScope);
  const PROTECTED_SOURCES = sourceScope === null ? LEGACY_PROTECTED_SOURCES : `protected_checkpoint_sources AS MATERIALIZED (SELECT
    CASE WHEN kind='owned_state' THEN source_sequence ELSE NULL END AS owned_source,
    CASE WHEN kind='owned_targets' THEN source_sequence ELSE NULL END AS target_source FROM service_checkpoint_sources
    WHERE scope=${checkpointSourceScopeSql(sourceScope)} AND kind IN ('owned_state','owned_targets'))`;
  const PROTECTED_GIFT_SOURCES = sourceScope === null ? LEGACY_PROTECTED_GIFT_SOURCES : `protected_gift_sources AS MATERIALIZED (
    SELECT source_sequence AS source FROM service_checkpoint_sources WHERE scope=${checkpointSourceScopeSql(sourceScope)} AND kind='gift_state')`;
  // Grouping every historical array inside SQLite exceeded the live query
  // memory allowance. Read at most 25 arrays / 512 KiB per host result instead.
  // The first row can advance alone even when an oversized legacy array exists.
  const roots = new Map(); let rootBytes = 0, compactionBoundary = null, compactionAfter = 0;
  const ownedRoots = new Map(); let ownedRootBytes = 0, ownedBoundary = null, ownedAfter = 0;
  const jobRoots = new Map(); let jobRootBytes = 0, jobBoundary = null, jobAfter = 0;
  const giftRoots = new Map(); let giftRootBytes = 0;
  let protectedSources = null, protectedRevision = -1;
  function rememberJobSource(source) {
    for (const cached of jobRoots.values()) if (cached.job_id === source.job_id && cached.job_json === source.job_json) return;
    const bytes = 2 * source.job_json.length;
    while (jobRoots.size && (jobRoots.size >= 16 || jobRootBytes + bytes > 524288)) {
      const oldest = jobRoots.keys().next().value; jobRootBytes -= jobRoots.get(oldest).bytes; jobRoots.delete(oldest);
    }
    if (bytes <= 524288) {jobRoots.set(source.sequence, {...source, bytes}); jobRootBytes += bytes;}
  }
  async function jobSourceFor(row, budget) {
    if (row.local_source !== null) {
      const source = {sequence: row.sequence, job_id: row.job_id, job_json: row.job_json};
      rememberJobSource(source); return source;
    }
    for (const [key, cached] of jobRoots) if (cached.sequence < row.sequence && cached.job_id === row.job_id && cached.job_json === row.job_json) {
      jobRoots.delete(key); jobRoots.set(key, cached); return cached;
    }
    if (budget.lookups >= 4) return undefined;
    budget.lookups++;
    const source = await db.get(`SELECT sequence,job_id,job_json FROM cloud_events WHERE sequence<:before
      AND job_id=:id AND job_json=:job AND ${validJobColumn()} ORDER BY sequence DESC LIMIT 1`,
      {':before': row.sequence, ':id': row.job_id, ':job': row.job_json});
    if (source) rememberJobSource(source);
    return source ?? null;
  }
  async function inlineJobPage(after, boundary) {
    return await db.all(`WITH pending AS (
      SELECT sequence,json_extract(state_json,'$.job.id') AS job_id,json_extract(state_json,'$.job') AS job_json,
        CASE WHEN ${COMPACTABLE_CHECKPOINT} AND ${validJobColumn()} THEN sequence ELSE NULL END AS local_source,
        length(CAST(json_extract(state_json,'$.job') AS BLOB)) AS job_bytes FROM cloud_events
      WHERE sequence>:after AND sequence<:boundary AND sequence<(SELECT MAX(sequence) FROM cloud_events)
        AND ${INLINE_JOB} AND ((job_id IS NULL AND job_json IS NULL) OR (${COMPACTABLE_CHECKPOINT} AND ${validJobColumn()}))
      ORDER BY sequence LIMIT 25
    ), bounded AS (SELECT *,SUM(job_bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending)
    SELECT sequence,job_id,job_json,local_source,job_bytes FROM bounded
      WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`, {':after': after, ':boundary': boundary});
  }
  async function publishJobs(selected, boundary) {
    if (!selected.length) return 0;
    const params = {':boundary': boundary}, sources = [], jobs = [], ids = [], sequences = [];
    selected.forEach((row, index) => {
      params[`:sequence${index}`] = row.sequence; params[`:source${index}`] = row.source.sequence;
      params[`:job${index}`] = row.job_json; params[`:id${index}`] = row.job_id;
      sources.push(`WHEN :sequence${index} THEN :source${index}`); jobs.push(`WHEN :sequence${index} THEN :job${index}`);
      ids.push(`WHEN :sequence${index} THEN :id${index}`); sequences.push(`:sequence${index}`);
    });
    const source = `CASE cloud_events.sequence ${sources.join(' ')} END`, jobJson = `CASE cloud_events.sequence ${jobs.join(' ')} END`, jobId = `CASE cloud_events.sequence ${ids.join(' ')} END`;
    const result = await db.run(`UPDATE cloud_events SET state_json=json_set(json_remove(state_json,'$.job'),'$.__checkpoint_job_sequence',${source})
      WHERE sequence IN (${sequences.join(',')}) AND sequence<:boundary AND sequence<(SELECT MAX(sequence) FROM cloud_events)
        AND ${INLINE_JOB} AND ((job_id IS NULL AND job_json IS NULL) OR (${COMPACTABLE_CHECKPOINT} AND ${validJobColumn()}))
        AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.job')=${jobJson} ELSE 0 END
        AND EXISTS(SELECT 1 FROM cloud_events source WHERE source.sequence=${source} AND source.sequence<=cloud_events.sequence
          AND source.job_id=${jobId} AND source.job_json=${jobJson} AND ${validJobColumn('source.')})`, params);
    return result.rowsAffected;
  }
  async function jobPartition(input) {
    if (!plain(input) || Object.keys(input).some(key => !['after', 'boundary', 'limit'].includes(key))) throw new Error('Invalid job partition');
    const afterInput = input.after ?? 0, boundary = input.boundary, requestedLimit = input.limit ?? 4;
    if (!Number.isSafeInteger(afterInput) || afterInput < 0 || !validSequence(boundary) || afterInput > boundary
        || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new Error('Invalid job partition bound');
    const limit = Math.min(requestedLimit, 4), selected = [], budget = {lookups: 0};
    let after = afterInput, complete = after >= boundary - 1;
    scan: for (let page = 0; page < (sourceScope === 'private' ? 1 : 2) && !complete; page++) {
      const physical = sourceScope === 'private' ? await readCheckpointPhysicalPage(db, {after, boundary,
        projection: `sequence,json_extract(state_json,'$.job.id') AS job_id,json_extract(state_json,'$.job') AS job_json,
          CASE WHEN ${COMPACTABLE_CHECKPOINT} AND ${validJobColumn()} THEN sequence ELSE NULL END AS local_source,
          length(CAST(json_extract(state_json,'$.job') AS BLOB)) AS job_bytes`,
        predicate: `${INLINE_JOB} AND ((job_id IS NULL AND job_json IS NULL) OR (${COMPACTABLE_CHECKPOINT} AND ${validJobColumn()}))`,
      }) : null;
      const rows = physical?.rows ?? await inlineJobPage(after, boundary);
      if (!rows.length) {if (physical) {after = physical.after; complete = physical.complete; continue;} complete = true; break;}
      for (const row of rows) {
        const source = await jobSourceFor(row, budget);
        if (source === undefined) break scan;
        if (source) selected.push({...row, source});
        after = row.sequence;
        if (selected.length >= limit) break scan;
      }
      if (physical) {after = physical.after; complete = physical.complete;}
      if (after >= boundary - 1) complete = true;
    }
    return {rewritten: await publishJobs(selected, boundary), boundary, after, complete};
  }
  async function protectedRoots() {
    if (sourceScope !== null && !await db.get(`SELECT 1 AS ready WHERE ${indexReady}`)) throw new Error('Checkpoint source index is not ready');
    const revision = (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary;
    if (protectedSources && revision === protectedRevision) return protectedSources;
    const owned = new Set(), targets = new Set();
    // Group only integer sequence metadata, never historical JSON payloads.
    // One host result replaces many calls when thousands of pages share roots.
    const rows = sourceScope === null ? await db.all(`WITH references_only AS (SELECT ${REFERENCE_PROJECTION} FROM cloud_events WHERE ${REFERENCE_FILTER})
      SELECT DISTINCT CASE WHEN owned_source BETWEEN 1 AND 9007199254740991 AND owned_source<sequence THEN owned_source ELSE NULL END AS owned_source,
        CASE WHEN target_source BETWEEN 1 AND 9007199254740991 AND target_source<sequence THEN target_source ELSE NULL END AS target_source
      FROM references_only LIMIT 8193`) : await db.all(`WITH ${PROTECTED_SOURCES} SELECT owned_source,target_source FROM protected_checkpoint_sources LIMIT 8193`);
    for (const row of rows) {
      if (validSequence(row.owned_source)) owned.add(row.owned_source);
      if (validSequence(row.target_source)) targets.add(row.target_source);
    }
    if (rows.length > 8192 || owned.size + targets.size > 8192) throw new Error('Checkpoint source maintenance bound reached');
    protectedRevision = revision; protectedSources = {owned, targets}; return protectedSources;
  }
  async function inlineOwnedPage(after, boundary) {
    return await db.all(`WITH pending AS (
      SELECT ${OWNED_PROJECTION},length(CAST(json_extract(state_json,'$.owned_prices') AS BLOB)) AS owned_bytes
      FROM cloud_events WHERE sequence>:after AND sequence<:boundary AND ${INLINE_OWNED}
        AND length(CAST(json_extract(state_json,'$.owned_prices') AS BLOB))>64 ORDER BY sequence LIMIT 25
    ), bounded AS (SELECT *,SUM(owned_bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending)
    SELECT sequence,owned_prices_json,target_sequence,owned_bytes FROM bounded
      WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`, {':after': after, ':boundary': boundary});
  }
  async function exactOwnedSource(own, target, beforeSequence) {
    if (sourceScope === 'private') return await findBoundedCheckpointSource(db, {
      kinds: ['owned_state'], projection: OWNED_PROJECTION, inline: INLINE_OWNED, before: beforeSequence,
      parameters: {':own': own, ':target': target}, match: `CASE WHEN json_valid(state_json) THEN
        json_extract(state_json,'$.owned_prices')=:own AND json_extract(state_json,'$.__checkpoint_owned_targets_sequence') IS :target ELSE 0 END`,
    });
    return await db.get(`SELECT ${OWNED_PROJECTION} FROM cloud_events WHERE sequence<:before
      AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.owned_prices')=:own
        AND json_extract(state_json,'$.__checkpoint_owned_targets_sequence') IS :target ELSE 0 END
      AND ${INLINE_OWNED} ORDER BY sequence LIMIT 1`, {':before': beforeSequence, ':own': own, ':target': target});
  }
  async function ownedRootFor(row, budget = null) {
    // Cache a bounded number of variants without keeping growing ledgers in
    // object keys. Compare exact JSON and the physical target-source identity.
    for (const [key, cached] of ownedRoots) if (cached.owned_prices_json === row.owned_prices_json
        && cached.target_sequence === row.target_sequence && cached.sequence <= row.sequence) {
      ownedRoots.delete(key); ownedRoots.set(key, cached); return cached.sequence;
    }
    if (budget && budget.lookups >= 4) return null;
    if (budget) budget.lookups++;
    const source = await exactOwnedSource(row.owned_prices_json, row.target_sequence, row.sequence);
    const sequence = source?.sequence ?? row.sequence, bytes = 2 * row.owned_prices_json.length;
    while (ownedRoots.size && (ownedRoots.size >= 16 || ownedRootBytes + bytes > 524288)) {
      const oldest = ownedRoots.keys().next().value; ownedRootBytes -= ownedRoots.get(oldest).bytes; ownedRoots.delete(oldest);
    }
    if (ownedRoots.has(sequence)) {ownedRootBytes -= ownedRoots.get(sequence).bytes; ownedRoots.delete(sequence);}
    if (bytes <= 524288) {ownedRoots.set(sequence, {...row, sequence, bytes}); ownedRootBytes += bytes;}
    return sequence;
  }
  async function ownedPartition(input, compact) {
    if (!plain(input) || Object.keys(input).some(key => !['after', 'boundary', ...(compact ? ['limit'] : [])].includes(key))) throw new Error('Invalid owned-state partition');
    const afterInput = input.after ?? 0, boundaryInput = input.boundary ?? 0, requestedLimit = input.limit ?? 4;
    if (!Number.isSafeInteger(afterInput) || afterInput < 0 || !Number.isSafeInteger(boundaryInput) || boundaryInput < 0
        || compact && (!validSequence(boundaryInput) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)) throw new Error('Invalid owned-state partition bound');
    const limit = Math.min(requestedLimit, 4);
    const boundary = boundaryInput || (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary;
    if (afterInput > boundary) throw new Error('Invalid owned-state partition cursor');
    const protectedRows = await protectedRoots(), budget = {lookups: 0}, selected = [];
    if (boundary > protectedRevision) throw new Error('Invalid owned-state partition boundary');
    let after = afterInput, complete = boundary === 0 || after >= boundary - 1, duplicate_owned_state_bytes = 0, owned_state_compactable = 0;
    scan: for (let page = 0; page < (sourceScope === 'private' ? 1 : 2) && !complete; page++) {
      const physical = sourceScope === 'private' ? await readCheckpointPhysicalPage(db, {after, boundary,
        projection: `${OWNED_PROJECTION},length(CAST(json_extract(state_json,'$.owned_prices') AS BLOB)) AS owned_bytes`,
        predicate: `${INLINE_OWNED} AND length(CAST(json_extract(state_json,'$.owned_prices') AS BLOB))>64`,
      }) : null;
      const rows = physical?.rows ?? await inlineOwnedPage(after, boundary);
      if (!rows.length) {if (physical) {after = physical.after; complete = physical.complete; continue;} complete = true; break;}
      for (const row of rows) {
        if (!protectedRows.owned.has(row.sequence) && !protectedRows.targets.has(row.sequence)) {
          const source = await ownedRootFor(row, budget);
          if (source === null) break scan;
          if (source < row.sequence) {
            duplicate_owned_state_bytes += row.owned_bytes; owned_state_compactable++;
            if (compact) selected.push({sequence: row.sequence, source});
          }
        }
        after = row.sequence;
        if (compact && selected.length >= limit) break scan;
      }
      if (physical) {after = physical.after; complete = physical.complete;}
      if (after >= boundary - 1) complete = true;
    }
    if (compact) return {rewritten: await publishOwned(selected, boundary, protectedRows), boundary, after, complete};
    return {duplicate_owned_state_bytes, owned_state_compactable, boundary, after, complete};
  }
  async function publishOwned(selected, boundary, protectedRows) {
    if (sourceScope === 'private') {
      const sources = new Set(selected.map(row => row.source));
      selected = selected.filter(row => !sources.has(row.sequence));
    }
    if (!selected.length) return 0;
    // The hosted SQL engine rejects larger CASE publications at its query
    // limit. Compatibility callers can still request more work, but every
    // physical mutation uses the same tested maximum of four rows.
    if (selected.length > 4) {
      let rewritten = 0;
      for (let offset = 0; offset < selected.length; offset += 4)
        rewritten += await publishOwned(selected.slice(offset, offset + 4), boundary, protectedRows);
      return rewritten;
    }
    const params = {':boundary': boundary}, cases = [], sequences = [];
    selected.forEach((row, index) => {
      params[`:sequence${index}`] = row.sequence; params[`:source${index}`] = row.source;
      cases.push(`WHEN :sequence${index} THEN :source${index}`); sequences.push(`:sequence${index}`);
    });
    const chosen = `CASE cloud_events.sequence ${cases.join(' ')} END`;
    const result = await db.run(`WITH ${PROTECTED_SOURCES} UPDATE cloud_events SET state_json=json_set(
        json_remove(state_json,'$.owned_prices','$.__checkpoint_owned_targets_sequence'),
        '$.__checkpoint_owned_state_sequence',${chosen})
      WHERE sequence IN (${sequences.join(',')}) AND sequence<:boundary
        AND sequence<(SELECT MAX(sequence) FROM cloud_events) AND ${INLINE_OWNED}
        AND ${UNREFERENCED_OWNED} AND ${UNREFERENCED_TARGET} AND ${indexReady}
        AND EXISTS(SELECT 1 FROM cloud_events source WHERE source.sequence=${chosen} AND source.sequence<cloud_events.sequence
          AND ${INLINE_OWNED.replaceAll('state_json','source.state_json')}
          AND CASE WHEN json_valid(source.state_json) THEN
            json_extract(source.state_json,'$.owned_prices')=json_extract(cloud_events.state_json,'$.owned_prices')
            AND json_extract(source.state_json,'$.__checkpoint_owned_targets_sequence') IS json_extract(cloud_events.state_json,'$.__checkpoint_owned_targets_sequence') ELSE 0 END)`, params);
    for (const row of selected) protectedRows.owned.add(row.source);
    return result.rowsAffected;
  }
  async function giftStateSource(sequence) {
    if (!validSequence(sequence)) throw new Error('Invalid gift-state source sequence');
    return await db.get(`SELECT ${GIFT_PROJECTION} FROM cloud_events WHERE sequence=:sequence AND ${INLINE_GIFT}`, {':sequence': sequence});
  }
  async function exactGiftSource(gift, beforeSequence) {
    if (sourceScope === 'private') return await findBoundedCheckpointSource(db, {
      kinds: ['gift_state'], projection: GIFT_PROJECTION, inline: INLINE_GIFT, before: beforeSequence,
      parameters: {':gift': gift}, match: "CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.gift_refresh')=:gift ELSE 0 END",
    });
    return await db.get(`SELECT ${GIFT_PROJECTION} FROM cloud_events WHERE sequence<:before
      AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.gift_refresh')=:gift ELSE 0 END
      AND ${INLINE_GIFT} ORDER BY sequence LIMIT 1`, {':before': beforeSequence, ':gift': gift});
  }
  async function giftRootFor(row, budget) {
    for (const [key, cached] of giftRoots) if (cached.gift_refresh_json === row.gift_refresh_json && cached.sequence <= row.sequence) {
      giftRoots.delete(key); giftRoots.set(key, cached); return cached.sequence;
    }
    if (budget.lookups >= 4) return null;
    budget.lookups++;
    const source = await exactGiftSource(row.gift_refresh_json, row.sequence);
    const sequence = source?.sequence ?? row.sequence, bytes = 2 * row.gift_refresh_json.length;
    while (giftRoots.size && (giftRoots.size >= 16 || giftRootBytes + bytes > 524288)) {
      const oldest = giftRoots.keys().next().value; giftRootBytes -= giftRoots.get(oldest).bytes; giftRoots.delete(oldest);
    }
    if (giftRoots.has(sequence)) {giftRootBytes -= giftRoots.get(sequence).bytes; giftRoots.delete(sequence);}
    if (bytes <= 524288) {giftRoots.set(sequence, {...row, sequence, bytes}); giftRootBytes += bytes;}
    return sequence;
  }
  async function giftPartition(input, compact) {
    if (sourceScope !== null && !await db.get(`SELECT 1 AS ready WHERE ${indexReady}`)) throw new Error('Checkpoint source index is not ready');
    if (!plain(input) || Object.keys(input).some(key => !['after', 'boundary', ...(compact ? ['limit'] : [])].includes(key))) throw new Error('Invalid gift-state partition');
    const afterInput = input.after ?? 0, boundaryInput = input.boundary ?? 0, requestedLimit = input.limit ?? 4;
    if (!Number.isSafeInteger(afterInput) || afterInput < 0 || !Number.isSafeInteger(boundaryInput) || boundaryInput < 0
        || compact && (!validSequence(boundaryInput) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)) throw new Error('Invalid gift-state partition bound');
    const head = (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary;
    const boundary = boundaryInput || head, limit = Math.min(requestedLimit, 4);
    if (boundary > head || afterInput > boundary) throw new Error('Invalid gift-state partition cursor');
    const budget = {lookups: 0}, selected = [];
    let after = afterInput, complete = boundary === 0 || after >= boundary - 1, duplicate_gift_state_bytes = 0, gift_state_compactable = 0;
    scan: for (let page = 0; page < (sourceScope === 'private' ? 1 : 2) && !complete; page++) {
      const physical = sourceScope === 'private' ? await readCheckpointPhysicalPage(db, {after, boundary, ctes: PROTECTED_GIFT_SOURCES,
        projection: `${GIFT_PROJECTION},length(CAST(json_extract(state_json,'$.gift_refresh') AS BLOB)) AS gift_bytes`,
        predicate: `${INLINE_GIFT} AND length(CAST(json_extract(state_json,'$.gift_refresh') AS BLOB))>64 AND ${UNREFERENCED_GIFT}`,
      }) : null;
      const rows = physical?.rows ?? await db.all(`WITH ${PROTECTED_GIFT_SOURCES}, pending AS (
        SELECT ${GIFT_PROJECTION},length(CAST(json_extract(state_json,'$.gift_refresh') AS BLOB)) AS gift_bytes FROM cloud_events
        WHERE sequence>:after AND sequence<:boundary AND ${INLINE_GIFT}
          AND length(CAST(json_extract(state_json,'$.gift_refresh') AS BLOB))>64
          AND ${UNREFERENCED_GIFT}
        ORDER BY sequence LIMIT 25
      ), bounded AS (SELECT *,SUM(gift_bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending)
      SELECT sequence,gift_refresh_json,gift_bytes FROM bounded WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending)
        ORDER BY sequence`, {':after': after, ':boundary': boundary});
      if (!rows.length) {if (physical) {after = physical.after; complete = physical.complete; continue;} complete = true; break;}
      for (const row of rows) {
        const source = await giftRootFor(row, budget);
        if (source === null) break scan;
        if (source < row.sequence) {
          duplicate_gift_state_bytes += row.gift_bytes; gift_state_compactable++;
          if (compact) selected.push({sequence: row.sequence, source});
        }
        after = row.sequence;
        if (compact && selected.length >= limit) break scan;
      }
      if (physical) {after = physical.after; complete = physical.complete;}
      if (after >= boundary - 1) complete = true;
    }
    if (!compact) return {duplicate_gift_state_bytes, gift_state_compactable, boundary, after, complete};
    if (sourceScope === 'private') {
      const sources = new Set(selected.map(row => row.source));
      selected.splice(0, selected.length, ...selected.filter(row => !sources.has(row.sequence)));
    }
    if (!selected.length) return {rewritten: 0, boundary, after, complete};
    const params = {':boundary': boundary}, cases = [], sequences = [];
    selected.forEach((row, index) => {
      params[`:sequence${index}`] = row.sequence; params[`:source${index}`] = row.source;
      cases.push(`WHEN :sequence${index} THEN :source${index}`); sequences.push(`:sequence${index}`);
    });
    const chosen = `CASE cloud_events.sequence ${cases.join(' ')} END`;
    const result = await db.run(`WITH ${PROTECTED_GIFT_SOURCES} UPDATE cloud_events SET state_json=json_set(json_remove(state_json,'$.gift_refresh'),
      '$.__checkpoint_gift_state_sequence',${chosen}) WHERE sequence IN (${sequences.join(',')}) AND sequence<:boundary
      AND sequence<(SELECT MAX(sequence) FROM cloud_events) AND ${INLINE_GIFT}
      AND ${UNREFERENCED_GIFT} AND ${indexReady}
      AND EXISTS(SELECT 1 FROM cloud_events source WHERE source.sequence=${chosen} AND source.sequence<cloud_events.sequence
        AND ${INLINE_GIFT.replaceAll('state_json', 'source.state_json')}
        AND CASE WHEN json_valid(source.state_json) THEN json_extract(source.state_json,'$.gift_refresh')=json_extract(cloud_events.state_json,'$.gift_refresh') ELSE 0 END)`, params);
    return {rewritten: result.rowsAffected, boundary, after, complete};
  }
  async function inlineTargetPage(after, boundary) {
    return await db.all(`WITH pending AS (
      SELECT ${TARGET_PROJECTION},length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB)) AS target_bytes
      FROM cloud_events WHERE sequence>:after AND sequence<:boundary AND ${INLINE_TARGETS}
        AND length(CAST(json_extract(state_json,'$.owned_prices.run.targets') AS BLOB))>64
      ORDER BY sequence LIMIT 25
    ), bounded AS (
      SELECT *,SUM(target_bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending
    ) SELECT sequence,run_id,wallet,targets_json,target_bytes FROM bounded
      WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`, {':after': after, ':boundary': boundary});
  }
  async function exactTargetSource(runId, wallet, targets, beforeSequence) {
    if (sourceScope === 'private') return await findBoundedCheckpointSource(db, {
      kinds: ['owned_targets','owned_state'], projection: TARGET_PROJECTION, inline: INLINE_TARGETS, before: beforeSequence,
      parameters: {':id': runId, ':wallet': wallet, ':targets': targets}, match: `CASE WHEN json_valid(state_json) THEN
        json_extract(state_json,'$.owned_prices.run.id')=:id AND json_extract(state_json,'$.owned_prices.run.wallet') IS :wallet
        AND json_extract(state_json,'$.owned_prices.run.targets')=:targets ELSE 0 END`,
    });
    // Filter the cheap run/wallet identities before the more involved legacy
    // safety checks. ORDER BY sequence can stop at the earliest matching root.
    return await db.get(`SELECT ${TARGET_PROJECTION} FROM cloud_events WHERE sequence<:before
      AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.owned_prices.run.id')=:id
        AND json_extract(state_json,'$.owned_prices.run.wallet') IS :wallet
        AND json_extract(state_json,'$.owned_prices.run.targets')=:targets ELSE 0 END
      AND ${INLINE_TARGETS} ORDER BY sequence LIMIT 1`,
      {':before': beforeSequence, ':id': runId, ':wallet': wallet, ':targets': targets});
  }
  async function ownedTargetSource(sequence) {
    if (!validSequence(sequence)) throw new Error('Invalid owned-target source sequence');
    return await db.get(`SELECT ${TARGET_PROJECTION} FROM cloud_events WHERE sequence=:sequence AND ${INLINE_TARGETS}`, {':sequence': sequence});
  }
  async function ownedStateSource(sequence) {
    if (!validSequence(sequence)) throw new Error('Invalid owned-state source sequence');
    return await db.get(`SELECT ${OWNED_PROJECTION} FROM cloud_events WHERE sequence=:sequence AND ${INLINE_OWNED}`, {':sequence': sequence});
  }
  async function rootFor(row) {
    const key = JSON.stringify([row.run_id, row.wallet]), cached = roots.get(key);
    if (cached && cached.targets_json === row.targets_json && cached.sequence <= row.sequence) {
      roots.delete(key); roots.set(key, cached); return cached.sequence;
    }
    const source = await exactTargetSource(row.run_id, row.wallet, row.targets_json, row.sequence);
    const sequence = source?.sequence ?? row.sequence;
    if (cached) {rootBytes -= cached.bytes; roots.delete(key);}
    // Account for retained UTF-16 strings, including the bounded identity key.
    // Variant-heavy legacy data cannot turn this cache into an 80 MiB buffer.
    const bytes = 2 * (row.targets_json.length + key.length);
    while (roots.size && (roots.size >= 16 || rootBytes + bytes > 524288)) {
      const oldest = roots.keys().next().value; rootBytes -= roots.get(oldest).bytes; roots.delete(oldest);
    }
    if (bytes <= 524288) {roots.set(key, {sequence, targets_json: row.targets_json, bytes}); rootBytes += bytes;}
    return sequence;
  }
  return {
    ...createBudgetResetCheckpointStorage(db, {findGiftStateSource: (gift, before) => exactGiftSource(JSON.stringify(gift), before), sourceScope}),
    async checkpointStorageStats() {
      return await db.get(`SELECT count(*) AS events,
        COALESCE(SUM(length(CAST(state_json AS BLOB))),0) AS state_bytes,
        COALESCE(SUM(CASE WHEN ${COMPACTABLE_CHECKPOINT} THEN length(CAST(job_json AS BLOB)) ELSE 0 END),0) AS duplicate_job_bytes,
        COALESCE(SUM(CASE WHEN ${COMPACTABLE_CHECKPOINT} THEN 1 ELSE 0 END),0) AS compactable,
        COALESCE(MAX(sequence),0) AS boundary FROM cloud_events`);
    },
    async compactCheckpointJobs(boundary, limit = 100) {
      if (!Number.isSafeInteger(boundary) || boundary <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid checkpoint compaction bound');
      if (jobBoundary !== boundary) {jobBoundary = boundary; jobAfter = 0;}
      let rewritten = 0;
      // Compatibility callers retain their count result; administrative tools
      // use the explicit Page cursor to continue across fresh host invocations.
      for (let call = 0; call < 25 && rewritten < limit; call++) {
        const page = await jobPartition({boundary, after: jobAfter, limit: Math.min(limit - rewritten, 4)});
        rewritten += page.rewritten; jobAfter = page.after;
        if (page.complete) break;
      }
      return rewritten;
    },
    compactCheckpointJobsPage: input => jobPartition(input),
    giftStateSource,
    async findGiftStateSource(gift, beforeSequence, preferredSequence = null) {
      if (!validSequence(beforeSequence)) throw new Error('Invalid gift-state source bound');
      if (!plain(gift)) return null;
      const encoded = JSON.stringify(gift);
      if (encoded.length <= 64) return null;
      if (validSequence(preferredSequence) && preferredSequence < beforeSequence) {
        const source = await giftStateSource(preferredSequence);
        if (source?.sequence === preferredSequence && source.gift_refresh_json === encoded) return source;
      }
      return await exactGiftSource(encoded, beforeSequence);
    },
    giftStateStorageStatsPage: input => giftPartition(input ?? {}, false),
    compactCheckpointGiftStatesPage: input => giftPartition(input, true),
    ownedTargetSource,
    ownedStateSource,
    async findOwnedStateSource(own, beforeSequence, targetSource = null, preferredSequence = null) {
      if (!validSequence(beforeSequence)) throw new Error('Invalid owned-state source bound');
      if (!plain(own)) return null;
      const physical = JSON.parse(encodeCheckpoint({owned_prices: own}, null, beforeSequence, null, targetSource));
      const encoded = JSON.stringify(physical.owned_prices);
      if (encoded.length <= 64) return null;
      if (validSequence(preferredSequence) && preferredSequence < beforeSequence) {
        const source = await ownedStateSource(preferredSequence);
        if (source?.sequence === preferredSequence && source.owned_prices_json === encoded
            && source.target_sequence === (physical[TARGET_MARKER] ?? null)) return source;
      }
      return await exactOwnedSource(encoded, physical[TARGET_MARKER] ?? null, beforeSequence);
    },
    async findOwnedTargetSource(run, beforeSequence, preferredSequence = null) {
      if (!validSequence(beforeSequence)) throw new Error('Invalid owned-target source bound');
      if (!targetIdentity(run) || !Array.isArray(run.targets)) return null;
      const targets = JSON.stringify(run.targets);
      // A marker is larger than an empty/tiny array. Keep those inline, and
      // avoid a historical source scan when it cannot reduce storage.
      if (targets.length <= 64) return null;
      if (validSequence(preferredSequence) && preferredSequence < beforeSequence) {
        const source = await ownedTargetSource(preferredSequence);
        if (source?.sequence === preferredSequence && source.run_id === run.id
            && Object.hasOwn(source, 'wallet') && source.wallet === run.wallet
            && source.targets_json === targets) return source;
      }
      return await exactTargetSource(run.id, run.wallet, targets, beforeSequence);
    },
    async ownedTargetStorageStats() {
      const boundary = (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary;
      const protectedRows = await protectedRoots();
      let after = 0, duplicate_target_bytes = 0, target_compactable = 0;
      for (;;) {
        const rows = await inlineTargetPage(after, boundary);
        if (!rows.length) return {duplicate_target_bytes, target_compactable, boundary};
        for (const row of rows) if (!protectedRows.owned.has(row.sequence) && await rootFor(row) < row.sequence) {duplicate_target_bytes += row.target_bytes; target_compactable++;}
        after = rows[rows.length - 1].sequence;
      }
    },
    async compactCheckpointOwnedTargets(boundary, limit = 100) {
      if (!validSequence(boundary) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid owned-target compaction bound');
      if (compactionBoundary !== boundary) {compactionBoundary = boundary; compactionAfter = 0;}
      const protectedRows = await protectedRoots();
      let after = compactionAfter;
      const selected = [];
      scan: for (;;) {
        const rows = await inlineTargetPage(after, boundary);
        if (!rows.length) break;
        for (const row of rows) {
          after = row.sequence;
          if (protectedRows.owned.has(row.sequence)) continue;
          const source = await rootFor(row);
          if (source < row.sequence) selected.push({sequence: row.sequence, source});
          if (selected.length >= limit) break scan;
        }
      }
      if (!selected.length) {compactionAfter = after; return 0;}
      const params = {':boundary': boundary}, cases = [], sequences = [];
      selected.forEach((row, index) => {
        params[`:sequence${index}`] = row.sequence; params[`:source${index}`] = row.source;
        cases.push(`WHEN :sequence${index} THEN :source${index}`); sequences.push(`:sequence${index}`);
      });
      // Selection is bounded outside SQL; publication remains one atomic
      // update. Earliest inline source rows are never in the selected set.
      const result = await db.run(`WITH ${PROTECTED_SOURCES} UPDATE cloud_events SET state_json=json_set(json_remove(state_json,'$.owned_prices.run.targets'),
          '$.__checkpoint_owned_targets_sequence',CASE sequence ${cases.join(' ')} END)
        WHERE sequence IN (${sequences.join(',')}) AND sequence<:boundary
          AND sequence<(SELECT MAX(sequence) FROM cloud_events) AND ${INLINE_TARGETS} AND ${UNREFERENCED_OWNED} AND ${UNREFERENCED_TARGET} AND ${indexReady}`, params);
      compactionAfter = after;
      for (const row of selected) protectedRows.targets.add(row.source);
      return result.rowsAffected;
    },
    async ownedStateStorageStats() {
      const boundary = (await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary;
      const protectedRows = await protectedRoots();
      let after = 0, duplicate_owned_state_bytes = 0, owned_state_compactable = 0;
      for (;;) {
        const rows = await inlineOwnedPage(after, boundary);
        if (!rows.length) return {duplicate_owned_state_bytes, owned_state_compactable, boundary};
        for (const row of rows) if (!protectedRows.owned.has(row.sequence) && !protectedRows.targets.has(row.sequence)
          && await ownedRootFor(row) < row.sequence) {duplicate_owned_state_bytes += row.owned_bytes; owned_state_compactable++;}
        after = rows[rows.length - 1].sequence;
      }
    },
    ownedStateStorageStatsPage: input => ownedPartition(input ?? {}, false),
    compactCheckpointOwnedStatesPage: input => ownedPartition(input, true),
    async compactCheckpointOwnedStates(boundary, limit = 100) {
      if (!validSequence(boundary) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid owned-state compaction bound');
      if (ownedBoundary !== boundary) {ownedBoundary = boundary; ownedAfter = 0;}
      const protectedRows = await protectedRoots();
      let after = ownedAfter; const selected = [];
      scan: for (;;) {
        const rows = await inlineOwnedPage(after, boundary);
        if (!rows.length) break;
        for (const row of rows) {
          after = row.sequence;
          if (protectedRows.owned.has(row.sequence) || protectedRows.targets.has(row.sequence)) continue;
          const source = await ownedRootFor(row);
          if (source < row.sequence) selected.push({sequence: row.sequence, source});
          if (selected.length >= limit) break scan;
        }
      }
      if (!selected.length) {ownedAfter = after; return 0;}
      const result = await publishOwned(selected, boundary, protectedRows);
      ownedAfter = after;
      return result;
    },
  };
}
