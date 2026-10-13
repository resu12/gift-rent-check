// Administrative installation material, never a Mini App endpoint/module.
// Each event INSERT and its archive/retirement trigger form one SQLite commit.
import {COMPACT_OPERATIONAL_TRIGGER_NAMES, COMPACT_OPERATIONAL_READY_SQL, OPERATIONAL_STORAGE_VERSION} from '../tgcloud/lib/checkpoint-storage.js';

const ownKeys = ['id','state','total','checked','updated','unresolved','status_updated','status_unresolved','reason','started_at','completed_at','scope','nft_address','wallet','session_id'];
const giftKeys = [...ownKeys,'scope_signature','check_started_at','provider','cache_hit','fallback_reason','deadline','stage','next_allowed_at'];
const markers = ['__checkpoint_job_sequence','__checkpoint_owned_targets_sequence','__checkpoint_owned_state_sequence','__checkpoint_gift_state_sequence','__checkpoint_budget_reset_sequence'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
export const COMPACT_TERMINAL_JOB_LIMIT = 20;
export const COMPACT_OPERATIONAL_INDEXES = Object.freeze([
  'CREATE INDEX IF NOT EXISTS operational_jobs_private_live_idx ON cloud_events(sequence) WHERE job_json IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS operational_jobs_public_live_idx ON public_cloud_events(user_id,sequence) WHERE job_json IS NOT NULL',
]);

// Whitelist fields, preserving absent properties and JSON scalar types. Targets,
// provider bodies, arbitrary extensions and request/session fences never enter
// historical summaries. JSON subtype must be re-established inside aggregation.
function summary(path, keys) {
  return `(SELECT json_group_object(key,json(CASE type WHEN 'text' THEN json_quote(value)
    WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(value AS TEXT) END))
    FROM json_each(NEW.state_json,'${path}') WHERE key IN(${keys.map(key => `'${key}'`).join(',')}))`;
}
const idAt = path => `json_extract(NEW.state_json,'${path}.id')`;
const validRun = path => `json_type(NEW.state_json,'${path}')='object'
  AND json_type(NEW.state_json,'${path}.id')='integer' AND ${idAt(path)} BETWEEN 1 AND 9007199254740991`;
function archiveRun(publicScope, path) {
  const table = publicScope ? 'public_owned_refresh_runs' : 'owned_refresh_runs', id = idAt(path);
  return `INSERT INTO ${table}(${publicScope ? 'row_id,user_id,' : ''}run_id,summary_json,source_sequence)
    SELECT ${publicScope ? `json_array(NEW.user_id,'run',${id}),NEW.user_id,` : ''}${id},${summary(path,ownKeys)},NEW.sequence
    WHERE ${validRun(path)} ON CONFLICT(${publicScope ? 'row_id' : 'run_id'}) DO UPDATE SET
    summary_json=excluded.summary_json,source_sequence=excluded.source_sequence
    WHERE excluded.source_sequence>=${table}.source_sequence;`;
}
function archiveSession(publicScope, id, run, present) {
  const table = publicScope ? 'public_owned_refresh_sessions' : 'owned_refresh_sessions';
  const tenant = publicScope ? 'user_id=NEW.user_id AND ' : '';
  const valid = `typeof(${id})='text' AND length(${id}) BETWEEN 16 AND 160 AND ${id} NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND typeof(${run})='integer' AND ${run} BETWEEN 1 AND 9007199254740991`;
  return `SELECT CASE WHEN ${present} AND NOT(${valid}) THEN RAISE(ABORT,'Invalid compact refresh session') END;
    SELECT CASE WHEN ${present} AND EXISTS(SELECT 1 FROM ${table} WHERE ${tenant}session_id=${id} AND run_id<>${run})
      THEN RAISE(ABORT,'Conflicting compact refresh session') END;
    INSERT OR IGNORE INTO ${table}(${publicScope ? 'row_id,user_id,' : ''}session_id,run_id,source_sequence)
    SELECT ${publicScope ? `json_array(NEW.user_id,'session',${id}),NEW.user_id,` : ''}${id},${run},NEW.sequence WHERE ${present} AND ${valid};`;
}

export function compactOperationalStorageTriggers() {
  return [false,true].map((publicScope,index) => {
    const table = publicScope ? 'public_cloud_events' : 'cloud_events', tenant = publicScope ? 'user_id=NEW.user_id AND ' : '';
    const paths = ['$.owned_prices.previous_run','$.owned_prices.run'];
    const sessions = paths.map(path => archiveSession(publicScope,`json_extract(NEW.state_json,'${path}.session_id')`,idAt(path),
      `json_type(NEW.state_json,'${path}.session_id') IS NOT NULL AND json_type(NEW.state_json,'${path}.session_id')<>'null'`));
    sessions.push(archiveSession(publicScope,"json_extract(NEW.state_json,'$.owned_prices.last_session.id')",
      "json_extract(NEW.state_json,'$.owned_prices.last_session.run_id')","json_type(NEW.state_json,'$.owned_prices.last_session')='object'"));
    const validation = `${markers.map(marker => `json_type(NEW.state_json,'$.${marker}') IS NOT NULL`).join(' OR ')}
      OR json_type(NEW.state_json,'$.job.__public_discovery_candidates') IS NOT NULL
      OR json_type(NEW.state_json,'$.job.__public_discovery_catalog') IS NOT NULL
      OR CASE WHEN NEW.job_json IS NULL THEN 0 WHEN NOT json_valid(NEW.job_json) THEN 1 ELSE
        json_type(NEW.job_json,'$.__public_discovery_candidates') IS NOT NULL
        OR json_type(NEW.job_json,'$.__public_discovery_catalog') IS NOT NULL END
      OR COALESCE(json_array_length(NEW.state_json,'$.owned_prices.history'),0)>0
      OR COALESCE(json_array_length(NEW.state_json,'$.owned_prices.sessions'),0)>0`;
    const gift = publicScope ? '' : ['$.gift_refresh.previous_run','$.gift_refresh.run'].map(path=>
      `INSERT INTO gift_refresh_runs(run_id,summary_json,source_sequence)
      SELECT ${idAt(path)},${summary(path,giftKeys)},NEW.sequence WHERE ${validRun(path)}
      ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,source_sequence=excluded.source_sequence
      WHERE excluded.source_sequence>=gift_refresh_runs.source_sequence;`).join('\n');
    const watermark = publicScope ? `INSERT INTO public_owned_refresh_index(user_id,sequence) VALUES(NEW.user_id,NEW.sequence)
      ON CONFLICT(user_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence);`
      : 'INSERT INTO owned_refresh_index(id,sequence) VALUES(1,NEW.sequence) ON CONFLICT(id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence);';
    const name = COMPACT_OPERATIONAL_TRIGGER_NAMES[index];
    return {name,table,sql:`CREATE TRIGGER ${name} AFTER INSERT ON ${table}
      WHEN CASE WHEN json_valid(NEW.state_json) THEN json_extract(NEW.state_json,'$.operational_storage_version')=${OPERATIONAL_STORAGE_VERSION} ELSE 0 END
      BEGIN
      SELECT CASE WHEN ${validation} THEN RAISE(ABORT,'Compact checkpoint must be self-contained') END;
      ${paths.map(path => archiveRun(publicScope,path)).join('\n')}
      ${sessions.join('\n')}
      ${gift}
      ${watermark}
      UPDATE ${table} SET state_json='{}' WHERE ${tenant}sequence=(SELECT MAX(sequence) FROM ${table} WHERE ${tenant}sequence<NEW.sequence);
      UPDATE ${table} SET job_json=NULL WHERE ${tenant}job_id=NEW.job_id AND sequence<NEW.sequence AND job_json IS NOT NULL
        AND NEW.job_json IS NOT NULL;
      UPDATE ${table} SET job_json=NULL WHERE ${tenant}sequence IN(SELECT sequence FROM ${table}
        WHERE ${tenant}job_json IS NOT NULL AND CASE WHEN json_valid(job_json) THEN
          json_extract(job_json,'$.state') IN('complete','stopped','failed','cancelled') ELSE 0 END
        ORDER BY CASE WHEN job_id IS json_extract(NEW.state_json,'$.job.id') THEN 0 ELSE 1 END,sequence DESC
        LIMIT -1 OFFSET ${COMPACT_TERMINAL_JOB_LIMIT})
        AND job_id IS NOT json_extract(NEW.state_json,'$.job.id');
      END`};
  }).concat({name:COMPACT_OPERATIONAL_TRIGGER_NAMES[2],table:'public_cloud_events',sql:`CREATE TRIGGER ${COMPACT_OPERATIONAL_TRIGGER_NAMES[2]} AFTER INSERT ON public_cloud_events
    WHEN json_valid(NEW.state_json) BEGIN
    ${['$.gift_refresh.previous_run','$.gift_refresh.run'].map(path=>`INSERT INTO public_gift_refresh_runs(row_id,user_id,run_id,summary_json,source_sequence)
      SELECT json_array(NEW.user_id,'gift-run',${idAt(path)}),NEW.user_id,${idAt(path)},${summary(path,giftKeys)},NEW.sequence
      WHERE ${validRun(path)} ON CONFLICT(row_id) DO UPDATE SET summary_json=excluded.summary_json,source_sequence=excluded.source_sequence
      WHERE excluded.source_sequence>=public_gift_refresh_runs.source_sequence;`).join('\n')}
    END`});
}

export async function installCompactOperationalStorage(db) {
  for (const sql of COMPACT_OPERATIONAL_INDEXES) await db.run(sql);
  for (const trigger of compactOperationalStorageTriggers()) {
    const saved = await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name", {':name':trigger.name});
    if (saved && saved.sql !== trigger.sql) throw Error('Compact storage trigger differs from the expected definition');
    if (!saved) await db.run(trigger.sql);
  }
  if (!await db.get(`SELECT 1 AS ready WHERE ${COMPACT_OPERATIONAL_READY_SQL}`)) throw Error('Compact storage triggers are not installed');
  return {ready:true,trigger_count:COMPACT_OPERATIONAL_TRIGGER_NAMES.length};
}

// Root's single-statement administrative reset uses this pure transformation.
// It never changes IDs, attempt evidence, expiry or nonce/session counters.
// Preserve other top-level fields conservatively; only operational runs reset.
export function developmentResetState(saved, at = null) {
  if (at!==null&&(!Number.isSafeInteger(at)||at<=0||at>8640000000000000)) throw Error('Invalid development reset time');
  if (!plain(saved) || !counter(saved.next_job_id) || !Array.isArray(saved.attempts)
    || saved.attempts.some(value=>!nonnegative(value)) || !nonnegative(saved.next_allowed_at)
    || markers.some(marker=>Object.hasOwn(saved,marker))) throw Error('Invalid decoded development reset checkpoint');
  const state = JSON.parse(JSON.stringify(saved));
  const resetSummary=(run,keys)=>{
    if(!plain(run))return null;
    const result=Object.fromEntries(keys.filter(key=>Object.hasOwn(run,key)).map(key=>[key,run[key]]));
    if(!['complete','failed','cancelled','stopped'].includes(result.state)) {
      if(at===null)throw Error('Development reset of active refresh requires a trusted time');
      result.state='failed';result.reason='development_reset';result.completed_at=new Date(at).toISOString();
    }
    return result;
  };
  if (state.job?.id !== undefined && (!counter(state.job.id) || state.next_job_id<=state.job.id)) throw Error('Invalid development reset job counter');
  if (state.job?.lease_until !== undefined && !nonnegative(state.job.lease_until)) throw Error('Invalid development reset job lease');
  state.next_allowed_at=Math.max(state.next_allowed_at,state.job?.lease_until??0); state.job=null;
  if (state.owned_prices!==undefined) {
    const own=state.owned_prices;
    if (!plain(own) || !counter(own.next_run_id) || !Array.isArray(own.attempts) || own.attempts.some(value=>!nonnegative(value))
      || !nonnegative(own.next_allowed_at) || own.run?.lease_until!==undefined&&!nonnegative(own.run.lease_until)
      || own.run?.id!==undefined&&(!counter(own.run.id)||own.next_run_id<=own.run.id)) throw Error('Invalid development reset owned checkpoint');
    own.version=2; own.next_allowed_at=Math.max(own.next_allowed_at,own.run?.lease_until??0);
    own.previous_run=resetSummary(own.run??own.previous_run,ownKeys);
    own.run=null; delete own.history; delete own.sessions;
  }
  if (state.gift_refresh!==undefined) {
    const gifts=state.gift_refresh;
    if (!plain(gifts) || !counter(gifts.next_run_id) || gifts.run?.id!==undefined&&(!counter(gifts.run.id)||gifts.next_run_id<=gifts.run.id))
      throw Error('Invalid development reset gift checkpoint');
    gifts.previous_run=resetSummary(gifts.run??gifts.previous_run,giftKeys);
    gifts.run=null; gifts.last_complete=null;
  }
  state.operational_storage_version=OPERATIONAL_STORAGE_VERSION;
  return state;
}
