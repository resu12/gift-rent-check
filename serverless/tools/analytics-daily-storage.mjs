// Administrative-only additive setup. Daily records preserve validated source
// dates across snapshot retention; they are not disposable dashboard cache.
import {personalAnalyticsDailyTriggers,upgradePersonalAnalyticsTopItems} from '../tgcloud/lib/personal-analytics.js';
import {installAnalyticsStorageAccounting} from './storage-accounting.mjs';
import {createStorageAdmission,StorageCapacityError} from '../tgcloud/lib/storage-admission.js';
import {DEFAULT_PUBLIC_SERVICE_BYTES,utf8Size} from '../tgcloud/lib/storage-policy.js';

export async function installPersonalAnalyticsDailyStorage(db) {
  await installAnalyticsStorageAccounting(db);
  const triggers = [false,true].flatMap(publicScope => personalAnalyticsDailyTriggers({publicScope}));
  for (const trigger of triggers) {
    const saved = await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name", {':name':trigger.name});
    if (saved && saved.sql !== trigger.sql) throw Error('Daily analytics trigger differs from the expected definition');
    if (!saved) await db.run(trigger.sql);
  }
  return {ready:true,trigger_count:triggers.length,provider_requests:0};
}

export async function backfillPersonalAnalyticsDailyStorage(db,{publicScope=false,after='',limit=1}={}) {
  if (typeof publicScope !== 'boolean' || typeof after !== 'string' || after.length>1024 || !Number.isSafeInteger(limit) || limit<1 || limit>5)
    throw Error('Invalid analytics backfill cursor');
  const triggers = personalAnalyticsDailyTriggers({publicScope});
  for (const trigger of triggers) {
    const saved = await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name", {':name':trigger.name});
    if (!saved || saved.sql !== trigger.sql) throw Error('Daily analytics triggers are not ready');
  }
  const table=publicScope?'public_personal_rental_analytics':'personal_rental_analytics',key=publicScope?'row_id':'fingerprint';
  const rows=await db.all(`SELECT ${key} AS cursor FROM ${table} WHERE ${key}>:after ORDER BY ${key} LIMIT :limit`,{':after':after,':limit':limit});
  const admission=createStorageAdmission(db);
  for (const row of rows) {
    const source=await db.get(`SELECT wallet,captured_at,fingerprint,normalized_json,raw_snapshot${publicScope?',user_id':''}
      FROM ${table} WHERE ${key}=:key AND length(CAST(normalized_json AS BLOB))<=262144 AND length(CAST(raw_snapshot AS BLOB))<=262144`,{':key':row.cursor});
    if(!source) {
      if(await db.get(`SELECT 1 AS present FROM ${table} WHERE ${key}=:key`,{':key':row.cursor}))throw Error('Analytics snapshot exceeds migration bound');
      continue;
    }
    if(publicScope&&!await db.get("SELECT 1 AS active FROM public_accounts WHERE user_id=:user AND status='active'",{':user':source.user_id}))continue;
    // Conservative upper bound includes repeated envelope fields for all 366
    // possible rows, even for malformed legacy captures. No source JSON is
    // trusted to lower the allowance before its trigger validation executes.
    const upgraded=upgradePersonalAnalyticsTopItems(source),normalized=upgraded?JSON.stringify(upgraded):source.normalized_json;
    const bytes=2*utf8Size(normalized)+utf8Size(source.normalized_json)+366*(2*utf8Size(source.wallet)+2*utf8Size(source.user_id??'')
      +utf8Size(source.captured_at)+utf8Size(source.fingerprint)+32)
      +300*(4*utf8Size(source.wallet)+2*utf8Size(source.user_id??'')+utf8Size(source.captured_at)+utf8Size(source.fingerprint)+1640);
    const scope=publicScope?'public:'+source.user_id:'private',guard=admission.forScope(scope).fence(bytes);
    const publicBudget=publicScope?`AND COALESCE((SELECT SUM(total_bytes) FROM service_storage_scope_usage WHERE scope LIKE 'public:%'),0)+:migration_bytes<=:public_limit`:'';
    const result=await db.run(`UPDATE ${table} SET normalized_json=:upgraded WHERE ${key}=:key
      AND normalized_json=:normalized AND raw_snapshot=:raw AND ${guard.sql} ${publicBudget}
      ${publicScope?`AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=${table}.user_id AND status='active')`:''}`,
      {':key':row.cursor,':normalized':source.normalized_json,':raw':source.raw_snapshot,':upgraded':normalized,...guard.parameters,
        ...(publicScope?{':migration_bytes':bytes,':public_limit':DEFAULT_PUBLIC_SERVICE_BYTES}:{})});
    if(result.rowsAffected!==1) {
      const current=await db.get(`SELECT normalized_json FROM ${table} WHERE ${key}=:key`,{':key':row.cursor});
      if(current?.normalized_json===source.normalized_json)throw new StorageCapacityError();
      // A concurrent replacement is independently absorbed by the trigger.
    }
  }
  return {complete:rows.length<limit,after:rows.at(-1)?.cursor??after,processed:rows.length,provider_requests:0};
}
