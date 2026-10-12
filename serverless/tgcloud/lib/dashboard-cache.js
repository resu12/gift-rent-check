// Derived, replaceable projections only. Append-only events remain authoritative.
import {sha256} from './ton-price-decoder.js';
import {utf8Size} from './bounded-response.js';
// Bound each SDK call as well as total cache storage. These pieces leave room
// for JSON escaping without adding hundreds of host calls to a cache hit.
const ROW_BYTES = 262144, SNAPSHOT_BYTES = 4194304, CACHE_BYTES = 16777216;
function digest(text) {
  const bytes = new Uint8Array(utf8Size(text)); let at = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 128) bytes[at++] = code;
    else if (code < 2048) {bytes[at++] = 192 | code >> 6; bytes[at++] = 128 | code & 63;}
    else if (code < 65536) {bytes[at++] = 224 | code >> 12; bytes[at++] = 128 | code >> 6 & 63; bytes[at++] = 128 | code & 63;}
    else {bytes[at++] = 240 | code >> 18; bytes[at++] = 128 | code >> 12 & 63; bytes[at++] = 128 | code >> 6 & 63; bytes[at++] = 128 | code & 63;}
  }
  return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function chunks(text) {
  const result = []; let start = 0, offset = 0, bytes = 0;
  for (const char of text) {
    const size = utf8Size(char);
    if (bytes + size > ROW_BYTES) {result.push(text.slice(start, offset)); start = offset; bytes = 0;}
    bytes += size; offset += char.length;
  }
  result.push(text.slice(start)); return result;
}
export function createDashboardCache(db,{storageAdmission=null}={}) {
  async function prune(limit, rows = 2048) {
    await db.run(`DELETE FROM dashboard_projection_cache WHERE selection_key IN (
      SELECT selection_key FROM (SELECT selection_key,SUM(length(CAST(snapshot_json AS BLOB))) OVER
        (ORDER BY time_bucket DESC,records_revision DESC,selection_key) AS total_bytes,
        ROW_NUMBER() OVER (ORDER BY time_bucket DESC,records_revision DESC,selection_key) AS ordinal
        FROM dashboard_projection_cache) WHERE total_bytes>:limit OR ordinal>:rows)`, {':limit': limit, ':rows': rows});
  }
  return {
    async dashboardRevision() {
      const row = await db.get(`SELECT (SELECT COALESCE(MAX(sequence),0) FROM cloud_events) AS state_revision,
        (SELECT COALESCE(MAX(sequence),0) FROM cloud_events WHERE records_json<>'[]') AS records_revision,
        (SELECT count(*) FROM personal_rental_analytics) AS analytics_count,
        (SELECT COALESCE(MAX(imported_at),'') FROM personal_rental_analytics) AS analytics_updated`);
      if (![row?.state_revision, row?.records_revision, row?.analytics_count].every(value => Number.isSafeInteger(value) && value >= 0)
          || typeof row.analytics_updated !== 'string') throw new Error('Dashboard revision unavailable');
      return row;
    },
    async dashboardSnapshot(key, revision, bucket) {
      const row = await db.get(`SELECT snapshot_json FROM dashboard_projection_cache
        WHERE selection_key=:key AND records_revision=:revision AND time_bucket=:bucket
          AND length(CAST(snapshot_json AS BLOB))<=:limit`,
        {':key': 'm:' + key, ':revision': revision, ':bucket': bucket, ':limit': 1024});
      if (!row) return null;
      const manifest = JSON.parse(row.snapshot_json);
      if (manifest.version !== 2 || !/^[0-9a-f]{64}$/.test(manifest.hash) || !Number.isSafeInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > 18
          || !Number.isSafeInteger(manifest.bytes) || manifest.bytes > SNAPSHOT_BYTES || manifest.bytes < 1) return null;
      const parts = []; let bytes = 0;
      for (let index = 0; index < manifest.parts; index++) {
        // Each host read stays small even for the real 161-gift dashboard.
        const part = await db.get(`SELECT snapshot_json FROM dashboard_projection_cache WHERE selection_key=:key
          AND length(CAST(snapshot_json AS BLOB))<=:limit`, {':key': `p:${manifest.hash}:${index}`, ':limit': ROW_BYTES});
        if (!part || typeof part.snapshot_json !== 'string') return null;
        bytes += utf8Size(part.snapshot_json); if (bytes > SNAPSHOT_BYTES) return null;
        parts.push(part.snapshot_json);
      }
      const body = parts.join('');
      // Content-addressed immutable pieces prevent concurrent/stale writers
      // mixing chunks. Missing/evicted/corrupt pieces are simply a cache miss.
      return bytes === manifest.bytes && digest(body) === manifest.hash ? JSON.parse(body) : null;
    },
    async saveDashboardSnapshot(key, revision, bucket, snapshot) {
      const body = JSON.stringify(snapshot);
      const bytes = utf8Size(body); if (bytes > SNAPSHOT_BYTES) return;
      const hash = digest(body), parts = chunks(body);
      // Reserve space before writing, including orphan pieces from a crashed
      // writer. Atomic INSERT guards also bound concurrent interrupted writes.
      await prune(CACHE_BYTES - bytes - 1024, 1500);
      for (let index = 0; index < parts.length; index++) {
        const partKey=`p:${hash}:${index}`,rowBytes=utf8Size(parts[index])+utf8Size(partKey)+utf8Size(String(revision))+utf8Size(String(bucket)),
          admission=storageAdmission?.fence(rowBytes)??{sql:'1',parameters:{}};
        const result=await db.run(`INSERT OR IGNORE INTO dashboard_projection_cache(selection_key,records_revision,time_bucket,snapshot_json)
          SELECT :key,:revision,:bucket,:snapshot WHERE
            (SELECT COALESCE(SUM(length(CAST(snapshot_json AS BLOB))),0) FROM dashboard_projection_cache)+:bytes<=:limit
            AND (SELECT count(*) FROM dashboard_projection_cache)<2048 AND ${admission.sql}`,
          {':key':partKey, ':revision': revision, ':bucket': bucket, ':snapshot': parts[index], ':bytes': utf8Size(parts[index]), ':limit': CACHE_BYTES,...admission.parameters});
        if(result.rowsAffected!==1&&!await db.get('SELECT 1 AS present FROM dashboard_projection_cache WHERE selection_key=:key AND snapshot_json=:part',
          {':key':partKey,':part':parts[index]}))return;
      }
      // Publish the manifest last. A crash never presents incomplete pieces
      // as a valid projection; unchanged source events remain authoritative.
      const manifest=JSON.stringify({version:2,hash,parts:parts.length,bytes}),manifestKey='m:'+key,
        admission=storageAdmission?.fence(utf8Size(manifest)+utf8Size(manifestKey)+utf8Size(String(revision))+utf8Size(String(bucket)))??{sql:'1',parameters:{}};
      await db.run(`INSERT INTO dashboard_projection_cache(selection_key,records_revision,time_bucket,snapshot_json)
        SELECT :key,:revision,:bucket,:snapshot WHERE
          (SELECT COALESCE(SUM(length(CAST(snapshot_json AS BLOB))),0) FROM dashboard_projection_cache)
            -COALESCE((SELECT length(CAST(snapshot_json AS BLOB)) FROM dashboard_projection_cache WHERE selection_key=:key),0)+:bytes<=:limit
          AND ((SELECT count(*) FROM dashboard_projection_cache)<2048 OR EXISTS(SELECT 1 FROM dashboard_projection_cache WHERE selection_key=:key))
          AND ${admission.sql}
        ON CONFLICT(selection_key) DO UPDATE
          SET records_revision=excluded.records_revision,time_bucket=excluded.time_bucket,snapshot_json=excluded.snapshot_json
        WHERE dashboard_projection_cache.records_revision<excluded.records_revision
          OR (dashboard_projection_cache.records_revision=excluded.records_revision AND dashboard_projection_cache.time_bucket<=excluded.time_bucket)`,
        {':key':manifestKey, ':revision':revision, ':bucket':bucket, ':snapshot':manifest, ':bytes':1024, ':limit':CACHE_BYTES,...admission.parameters});
      await db.run(`DELETE FROM dashboard_projection_cache WHERE selection_key IN
        (SELECT selection_key FROM dashboard_projection_cache WHERE selection_key LIKE 'm:%'
          ORDER BY time_bucket DESC,records_revision DESC,selection_key LIMIT -1 OFFSET 16)`);
      // Bound total retained bytes, including pieces left by interrupted or
      // racing writers. Eviction may cause a miss, never financial data loss.
      await prune(CACHE_BYTES);
    },
  };
}
