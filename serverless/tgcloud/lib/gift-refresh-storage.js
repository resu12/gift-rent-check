// Refresh checkpoints stay authoritative in the existing atomic event ledger.
// Indexed event keys bind each page opening permanently to its original run.
// No website HTML, cookie, approval or arbitrary response body is persisted.
import {sha256} from './ton-price-decoder.js';
import {utf8Bytes} from './personal-analytics.js';
export const giftRefreshSessionKey = session => 'gift-refresh-session:' + Array.from(sha256(utf8Bytes(session)), byte => byte.toString(16).padStart(2, '0')).join('');
export function createGiftRefreshStorage(db) {
  return {
    async giftRefreshSession(session) {
      const row = await db.get('SELECT records_json FROM cloud_events WHERE event_key=:key LIMIT 1', {':key': giftRefreshSessionKey(session)});
      if (!row) return null;
      const binding = JSON.parse(row.records_json)?.[0]?.record;
      if (binding?.session_id !== session || !Number.isSafeInteger(binding.run_id) || binding.run_id <= 0) throw new Error('Invalid saved gift refresh binding');
      return binding.run_id;
    },
    async giftRefreshRun(id) {
      const head = await db.get(`SELECT CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.operational_storage_version') END AS storage_version
        FROM cloud_events ORDER BY sequence DESC LIMIT 1`);
      if (head?.storage_version === 1) {
        // Compact mode archives the fixed-size result in the event's own SQL
        // commit, before the previous operational checkpoint is discarded.
        const archived = await db.get('SELECT summary_json FROM gift_refresh_runs WHERE run_id=:id', {':id':id});
        return archived?.summary_json ? JSON.parse(archived.summary_json) : null;
      }
      const row = await db.get(`WITH resolved AS (
        SELECT e.sequence,CASE WHEN json_valid(e.state_json) AND json_type(e.state_json,'$.__checkpoint_gift_state_sequence') IS NULL
          THEN e.state_json ELSE s.state_json END AS state_json FROM cloud_events e
        LEFT JOIN cloud_events s ON s.sequence=CASE WHEN json_valid(e.state_json)
          AND json_type(e.state_json,'$.__checkpoint_gift_state_sequence')='integer'
          AND json_extract(e.state_json,'$.__checkpoint_gift_state_sequence') BETWEEN 1 AND 9007199254740991
          AND json_extract(e.state_json,'$.__checkpoint_gift_state_sequence')<e.sequence
          AND json_type(e.state_json,'$.gift_refresh') IS NULL THEN json_extract(e.state_json,'$.__checkpoint_gift_state_sequence') ELSE NULL END
          AND CASE WHEN json_valid(s.state_json) THEN json_type(s.state_json,'$.__checkpoint_gift_state_sequence') IS NULL
            AND json_type(s.state_json,'$.gift_refresh')='object' ELSE 0 END
        WHERE e.event_key LIKE 'gift-refresh:%' OR e.event_key LIKE 'gift-refresh-session:%'
      ) SELECT json_extract(state_json,'$.gift_refresh.run') AS run_json FROM resolved
        WHERE CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.gift_refresh.run.id')=:id ELSE 0 END
        ORDER BY sequence DESC LIMIT 1`, {':id': id});
      return row?.run_json ? JSON.parse(row.run_json) : null;
    },
  };
}
