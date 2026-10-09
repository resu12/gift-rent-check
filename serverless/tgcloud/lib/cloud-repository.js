import {safeMarketappRefreshOutcome} from './marketapp-refresh-status.js';
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
    async importPersonalAnalytics(snapshot, raw, importedAt) {
      const result = await db.run(`INSERT OR IGNORE INTO personal_rental_analytics
        (fingerprint,wallet,captured_at,imported_at,raw_snapshot,normalized_json)
        VALUES(:fingerprint,:wallet,:captured,:imported,:raw,:normalized)`, {
        ':fingerprint': snapshot.fingerprint, ':wallet': snapshot.wallet,
        ':captured': snapshot.captured_at, ':imported': importedAt,
        ':raw': raw, ':normalized': JSON.stringify(snapshot),
      });
      return result.rowsAffected === 1;
    },
    async latestPersonalAnalytics(wallet) {
      const row = await db.get(`SELECT normalized_json FROM personal_rental_analytics
        WHERE wallet=:wallet ORDER BY captured_at DESC,fingerprint DESC LIMIT 1`, {':wallet': wallet});
      return row ? JSON.parse(row.normalized_json) : null;
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
      return rows.map(row => JSON.parse(row.normalized_json));
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
    async latestMarketappRefreshAttempt(owner, wallet) {
      return await db.get(`SELECT a.attempt_id,a.state,a.expires_at,a.outcome_json,s.imported_at AS saved_at
        FROM marketapp_login_attempts a LEFT JOIN personal_rental_analytics s
          ON s.wallet=a.wallet AND s.fingerprint=CASE WHEN json_valid(a.outcome_json)
            THEN json_extract(a.outcome_json,'$.snapshot_fingerprint') ELSE NULL END
        WHERE a.owner_id=:owner AND a.wallet=:wallet AND json_valid(a.outcome_json)
          AND json_extract(a.outcome_json,'$.flow')='analytics_refresh'
        ORDER BY a.created_at DESC LIMIT 1`, {':owner': owner, ':wallet': wallet});
    },
    async cancelMarketappLoginAttempt(id, owner) {
      await db.run(`UPDATE marketapp_login_attempts SET state='cancelled'
        WHERE attempt_id=:id AND owner_id=:owner AND state IN ('pending','issued')`, {':id': id, ':owner': owner});
    },
  };
}
