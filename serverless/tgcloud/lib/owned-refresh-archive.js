// Legacy rows are recoverable projections of cloud_events. Compact mode makes
// these fixed-size archives authoritative in the same SQL commit as each event.
// The event commit stays authoritative: a crash while updating a projection
// replays the same rows before advancing its watermark, without issuing HTTP.
const summaryKeys = ['id', 'state', 'total', 'checked', 'updated', 'unresolved', 'status_updated', 'status_unresolved', 'reason', 'started_at', 'completed_at', 'scope', 'nft_address', 'wallet', 'session_id'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => Number.isSafeInteger(value) && value > 0;
// Do not return full old checkpoint documents or their growing arrays through
// the host. Run targets/pending are preserved in the event, but not needed to
// index a historical summary. Only fixed-size summary/session fields are read.
const projection = `sequence,
  json_remove(json_extract(state_json,'$.owned_prices.run'),'$.targets','$.pending') AS run_json,
  json_extract(state_json,'$.owned_prices.previous_run') AS previous_json,
  json_extract(state_json,'$.owned_prices.last_session') AS session_json`;
const sourceSequence = alias => `CASE WHEN json_valid(${alias}.state_json)
  AND json_type(${alias}.state_json,'$.__checkpoint_owned_state_sequence')='integer'
  AND json_extract(${alias}.state_json,'$.__checkpoint_owned_state_sequence') BETWEEN 1 AND 9007199254740991
  AND json_extract(${alias}.state_json,'$.__checkpoint_owned_state_sequence')<${alias}.sequence
  THEN json_extract(${alias}.state_json,'$.__checkpoint_owned_state_sequence') ELSE NULL END`;
const inlineSource = alias => `CASE WHEN json_valid(${alias}.state_json) THEN json_type(${alias}.state_json,'$.owned_prices')='object'
  AND json_type(${alias}.state_json,'$.__checkpoint_owned_state_sequence') IS NULL ELSE 0 END`;
const projectedFields = document => `json_remove(json_extract(${document},'$.owned_prices.run'),'$.targets','$.pending') AS run_json,
  json_extract(${document},'$.owned_prices.previous_run') AS previous_json,
  json_extract(${document},'$.owned_prices.last_session') AS session_json`;
// Whole owned-state references point only to earlier permanent inline rows.
// Resolve inside SQL before projecting fixed-size summaries; no attempt/target
// array enters the host while rebuilding an index after maintenance.
const resolved = `resolved AS NOT MATERIALIZED (
  SELECT e.sequence,e.event_key,COALESCE(s.state_json,e.state_json) AS state_json,
    COALESCE(s.sequence,e.sequence) AS storage_sequence FROM cloud_events e
  LEFT JOIN cloud_events s ON s.sequence=CASE WHEN json_valid(e.state_json)
    AND json_type(e.state_json,'$.__checkpoint_owned_state_sequence')='integer'
    AND json_extract(e.state_json,'$.__checkpoint_owned_state_sequence') BETWEEN 1 AND 9007199254740991
    AND json_extract(e.state_json,'$.__checkpoint_owned_state_sequence')<e.sequence
    THEN json_extract(e.state_json,'$.__checkpoint_owned_state_sequence') ELSE NULL END
    AND CASE WHEN json_valid(s.state_json) THEN json_type(s.state_json,'$.owned_prices')='object'
      AND json_type(s.state_json,'$.__checkpoint_owned_state_sequence') IS NULL ELSE 0 END
)`;

export function createOwnedRefreshArchive(db) {
  async function indexOwn(own, sequence) {
    if (!plain(own)) return;
    const runs = new Map(), sessions = new Map();
    for (const run of [...(Array.isArray(own.history) ? own.history : []), own.previous_run, own.run]) {
      if (!plain(run) || !validId(run.id) || runs.has(run.id)) continue;
      const summary = Object.fromEntries(summaryKeys.filter(key => Object.hasOwn(run, key)).map(key => [key, run[key]]));
      runs.set(run.id, JSON.stringify(summary));
    }
    if (runs.size) {
      const params = {':sequence': sequence}, values = [];
      [...runs].forEach(([id, summary], i) => {
        params[`:id${i}`] = id; params[`:summary${i}`] = summary;
        values.push(`(:id${i},:summary${i},:sequence)`);
      });
      // Migration pages use at most 100 rows, staying below SQLite's 999
      // parameter floor while avoiding a host round trip for every old run.
      await db.run(`INSERT INTO owned_refresh_runs(run_id,summary_json,source_sequence)
        VALUES ${values.join(',')} ON CONFLICT(run_id) DO UPDATE SET
        summary_json=excluded.summary_json,source_sequence=excluded.source_sequence
        WHERE excluded.source_sequence>owned_refresh_runs.source_sequence`, params);
    }
    for (const session of [...(Array.isArray(own.sessions) ? own.sessions : []), own.last_session]) {
      if (!plain(session) || typeof session.id !== 'string' || !/^[A-Za-z0-9._:-]{16,160}$/.test(session.id) || !validId(session.run_id)) continue;
      if (sessions.has(session.id) && sessions.get(session.id) !== session.run_id) throw new Error('Conflicting saved refresh session');
      sessions.set(session.id, session.run_id);
    }
    if (sessions.size) {
      const params = {':sequence': sequence}, lookup = {}, values = [], ids = [];
      [...sessions].forEach(([id, run], i) => {
        params[`:id${i}`] = id; params[`:run${i}`] = run; lookup[`:id${i}`] = id;
        values.push(`(:id${i},:run${i},:sequence)`); ids.push(`:id${i}`);
      });
      // Never evict or remap an old session identifier. Its original result is
      // immutable even after the associated run leaves the active checkpoint.
      await db.run(`INSERT OR IGNORE INTO owned_refresh_sessions(session_id,run_id,source_sequence)
        VALUES ${values.join(',')}`, params);
      const mapped = await db.all(`SELECT session_id,run_id FROM owned_refresh_sessions WHERE session_id IN (${ids.join(',')})`, lookup);
      if (mapped.length !== sessions.size || mapped.some(row => sessions.get(row.session_id) !== row.run_id)) throw new Error('Conflicting saved refresh session');
    }
  }
  async function advance(sequence) {
    await db.run('UPDATE owned_refresh_index SET sequence=MAX(sequence,:sequence) WHERE id=1', {':sequence': sequence});
  }
  async function indexRow(row) {
    const read = value => value === null || value === undefined ? null : JSON.parse(value);
    await indexOwn({run: read(row.run_json), previous_run: read(row.previous_json), last_session: read(row.session_json)}, row.sequence);
  }
  async function indexLegacy(row) {
    await indexRow(row);
    for (const field of ['history', 'sessions']) {
      const count = row[`${field}_count`] ?? 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid legacy refresh archive');
      for (let offset = 0; offset < count; offset += 100) {
        const rows = await db.all(`WITH RECURSIVE offsets(ordinal) AS (
          SELECT CAST(:offset AS INTEGER) UNION ALL SELECT ordinal+1 FROM offsets WHERE ordinal+1<:end
        ) SELECT json_extract(state_json,:path||'['||ordinal||']') AS entry_json
          FROM cloud_events,offsets WHERE sequence=:sequence ORDER BY ordinal`,
          {':offset': offset, ':end': Math.min(count, offset + 100), ':path': `$.owned_prices.${field}`, ':sequence': row.storage_sequence ?? row.sequence});
        const entries = rows.map(entry => entry.entry_json === null ? null : JSON.parse(entry.entry_json));
        await indexOwn({[field]: entries}, row.sequence);
      }
    }
    // No compact checkpoint can rely on the legacy index until *all* old
    // sessions and outcomes have been inserted. Partial indexing is replayed.
    await advance(row.sequence);
  }
  async function sync() {
    await db.run('INSERT OR IGNORE INTO owned_refresh_index(id,sequence) VALUES(1,0)');
    let after = (await db.get('SELECT sequence FROM owned_refresh_index WHERE id=1')).sequence;
    const head = await db.get(`SELECT COALESCE(MAX(sequence),0) AS sequence,
      CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.operational_storage_version') END AS storage_version FROM cloud_events`);
    const boundary = head.sequence;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(boundary) || boundary < after) throw new Error('Invalid refresh archive checkpoint');
    if (head.storage_version === 1) {
      if (after !== boundary) throw new Error('Compact refresh archive is not current');
      return;
    }
    if (after === 0) {
      // A v1 checkpoint already contains every older session and run summary.
      // Index the newest committed one once, rather than repeatedly rereading
      // its expanding arrays from all preceding legacy events.
      const legacy = await db.get(`WITH ${resolved} SELECT ${projection},storage_sequence,
        json_array_length(state_json,'$.owned_prices.history') AS history_count,
        json_array_length(state_json,'$.owned_prices.sessions') AS sessions_count FROM resolved
        WHERE sequence<=:through AND json_valid(state_json)
          AND json_extract(state_json,'$.owned_prices.version')=1
        ORDER BY sequence DESC LIMIT 1`, {':through': boundary});
      if (legacy) {await indexLegacy(legacy); after = legacy.sequence;}
    }
    for (;;) {
      const currentDocument = 'COALESCE(s.state_json,e.state_json)', previousDocument = 'COALESCE(ps.state_json,p.state_json)';
      const rows = await db.all(`SELECT e.sequence,${projectedFields(currentDocument)} FROM cloud_events e
        LEFT JOIN cloud_events s ON s.sequence=${sourceSequence('e')} AND ${inlineSource('s')}
        LEFT JOIN cloud_events p ON p.sequence=e.sequence-1
        LEFT JOIN cloud_events ps ON ps.sequence=${sourceSequence('p')} AND ${inlineSource('ps')}
        WHERE e.sequence>:after AND e.sequence<=:through
          AND (e.event_key LIKE 'owned-price:%'
            OR COALESCE(json_remove(json_extract(${currentDocument},'$.owned_prices'),'$.run.targets'),'null')
              <>COALESCE(json_remove(json_extract(${previousDocument},'$.owned_prices'),'$.run.targets'),'null'))
        ORDER BY e.sequence LIMIT 20`, {':after': after, ':through': boundary});
      if (!rows.length) {await advance(boundary); return;}
      // Marketapp pages and reservations copy unchanged owned state. Filter
      // those events inside SQLite instead of performing projection writes for
      // each copy. Comparing the predecessor also catches migration/manual
      // checkpoint changes whose key predates the owned-price convention.
      // Frozen target arrays do not affect summaries or sessions; changing
      // their physical representation must not manufacture archive work.
      for (const row of rows) {await indexRow(row); after = row.sequence;}
      // Advance only after every relevant row through this position succeeded.
      // A crashed batch is safely replayed; concurrent advances stay monotonic.
      await advance(after);
    }
  }
  return {
    syncOwnedRefreshArchive: sync,
    async ownedRefreshSession(id) {
      await sync();
      const row = await db.get('SELECT run_id FROM owned_refresh_sessions WHERE session_id=:id', {':id': id});
      return row?.run_id ?? null;
    },
    async ownedRefreshRun(id) {
      await sync();
      const row = await db.get('SELECT summary_json FROM owned_refresh_runs WHERE run_id=:id', {':id': id});
      return row ? JSON.parse(row.summary_json) : null;
    },
  };
}
