const initial = () => ({version: 2, next_job_id: 1, job: null, attempts: [], next_allowed_at: 0});

export function createCloudRepository(db) {
  return {
    async clock() {
      // V8 wall time may be held constant until a host call. SQLite evaluates
      // 'now' for this statement; preserve its millisecond precision so a
      // relative Retry-After cannot be shortened by rounding to whole seconds.
      const row = await db.get("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS server_time");
      if (!Number.isSafeInteger(row?.server_time) || row.server_time <= 0 || row.server_time > 8640000000000000) throw new Error('Server clock unavailable');
      return row.server_time;
    },
    async read() {
      const row = await db.get('SELECT sequence, state_json FROM cloud_events ORDER BY sequence DESC LIMIT 1');
      if (row) return {revision: row.sequence, state: JSON.parse(row.state_json)};
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
      return {revision: 0, state};
    },
    async append(expected, event) {
      const result = await db.run(`INSERT OR IGNORE INTO cloud_events
        (sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at)
        SELECT :sequence,:key,:state,:job_id,:job,:records,:raw,:observed
        WHERE COALESCE((SELECT MAX(sequence) FROM cloud_events),0)=:expected
        AND NOT EXISTS (SELECT 1 FROM cloud_events WHERE event_key=:key)`, {
        ':sequence': expected + 1, ':expected': expected, ':key': event.key,
        ':state': JSON.stringify(event.state), ':job_id': event.job?.id ?? null,
        ':job': event.job ? JSON.stringify(event.job) : null,
        ':records': JSON.stringify(event.records || []), ':raw': event.raw_body ?? null,
        ':observed': event.observed_at,
      });
      return result.rowsAffected === 1;
    },
    async event(key) {
      const row = await db.get('SELECT records_json FROM cloud_events WHERE event_key=:key LIMIT 1', {':key': key});
      return row ? JSON.parse(row.records_json) : null;
    },
    async job(id) {
      const row = await db.get('SELECT job_json FROM cloud_events WHERE job_id=:id ORDER BY sequence DESC LIMIT 1', {':id': id});
      return row ? JSON.parse(row.job_json) : null;
    },
    async jobs() {
      const rows = await db.all(`SELECT e.job_json FROM cloud_events e JOIN
        (SELECT job_id,MAX(sequence) AS seq FROM cloud_events WHERE job_id IS NOT NULL GROUP BY job_id) j
        ON e.sequence=j.seq ORDER BY e.job_id DESC LIMIT 100`);
      return rows.map(row => JSON.parse(row.job_json));
    },
    async records() {
      const result = []; let after = 0;
      for (;;) {
        // Keep normal pages batched, but cap their combined bytes. Larger
        // provider pages must not recreate the live host's ~5 MB result timeout.
        // Always include the first row so an old oversized import can advance.
        const rows = await db.all(`WITH pending AS (
          SELECT sequence,records_json,length(CAST(records_json AS BLOB)) AS bytes
          FROM cloud_events WHERE sequence>:after AND records_json<>'[]' ORDER BY sequence LIMIT 5
        ), bounded AS (
          SELECT sequence,records_json,SUM(bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending
        ) SELECT sequence,records_json FROM bounded
          WHERE total_bytes<=1048576 OR sequence=(SELECT MIN(sequence) FROM pending)
          ORDER BY sequence`, {':after': after});
        for (const row of rows) result.push(...JSON.parse(row.records_json));
        if (!rows.length) return result;
        after = rows[rows.length - 1].sequence;
      }
    },
  };
}
