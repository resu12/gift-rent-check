import {STORAGE_TABLES, storageTableByteExpression} from '../tgcloud/lib/storage-policy.js';
import {CHECKPOINT_SOURCE_TRIGGER_NAMES, CHECKPOINT_SOURCE_TRIGGERS_READY} from '../tgcloud/lib/budget-reset-checkpoint-storage.js';

const NOW = "CAST(strftime('%s','now') AS INTEGER)*1000";
const shared = new Set(['marketapp_website_gates','marketapp_website_requests','public_provider_gates']);
function scopeExpression(table, alias) {
  return table.scopeColumn ? `${alias}${table.scopeColumn}` : table.tenant ? `'public:'||${alias}${table.tenant}` : shared.has(table.name) ? "'shared'" : "'private'";
}
function triggerName(table, operation) {return `storage_usage_v1_${table.name}_${operation}`;}
export function storageAccountingTriggers() {
  return STORAGE_TABLES.flatMap(table => ['insert','update','delete'].map(operation => {
    const oldBytes = operation === 'insert' ? '0' : `(${storageTableByteExpression(table,'OLD.')})`;
    const newBytes = operation === 'delete' ? '0' : `(${storageTableByteExpression(table,'NEW.')})`;
    const changes = [];
    if (operation !== 'insert') changes.push(`INSERT INTO service_storage_scope_usage(scope,total_bytes,initialized_at)
      VALUES(${scopeExpression(table,'OLD.')},-${oldBytes},${NOW})
      ON CONFLICT(scope) DO UPDATE SET total_bytes=total_bytes-${oldBytes};`);
    if (operation !== 'delete') changes.push(`INSERT INTO service_storage_scope_usage(scope,total_bytes,initialized_at)
      VALUES(${scopeExpression(table,'NEW.')},${newBytes},${NOW})
      ON CONFLICT(scope) DO UPDATE SET total_bytes=total_bytes+${newBytes};`);
    return {name:triggerName(table,operation),table:table.name,sql:`CREATE TRIGGER IF NOT EXISTS ${triggerName(table,operation)}
      AFTER ${operation.toUpperCase()} ON ${table.name} BEGIN
      UPDATE service_storage_usage SET total_bytes=total_bytes+${newBytes}-${oldBytes} WHERE id=1;
      ${changes.join('\n')}
      END`};
  }));
}
const globalSum = () => STORAGE_TABLES.map(table => `(SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) FROM ${table.name})`).join('+');
function scopedSum(scope) {
  return STORAGE_TABLES.filter(table=>table.scopeColumn || (scope==='public'?table.tenant:scope==='shared'?shared.has(table.name):!table.tenant&&!shared.has(table.name)))
    .map(table=>`(SELECT COALESCE(SUM(${storageTableByteExpression(table)}),0) FROM ${table.name}
      ${table.scopeColumn?`WHERE ${table.scopeColumn}=service_storage_scope_usage.scope`:scope==='public'?`WHERE ${table.tenant}=substr(service_storage_scope_usage.scope,8)`:''})`).join('+')||'0';
}

// Only the owner CLI calls this installer, never a normal screen or refresh.
// Each pass installs at most six fixed triggers. The final SQL baseline reads
// source tables in one SQLite statement, so concurrent writes cannot fall
// between counting and activation. Subsequent passes never reset live counters.
export async function installStorageAccounting(db,{after=0,limit=6}={}) {
  const triggers = storageAccountingTriggers();
  if (!Number.isSafeInteger(after)||after<0||after>triggers.length||!Number.isSafeInteger(limit)||limit<1||limit>6) throw new Error('Invalid accounting pass');
  await db.run('INSERT OR IGNORE INTO service_storage_usage(id,total_bytes,initialized_at) VALUES(1,0,0)');
  await db.run("INSERT OR IGNORE INTO service_storage_monitor(id,document,lease_until) VALUES(1,'{}',0)");
  await db.run('CREATE INDEX IF NOT EXISTS service_storage_reservations_expiry_idx ON service_storage_reservations(expires_at)');
  await db.run('CREATE INDEX IF NOT EXISTS service_storage_reservations_scope_idx ON service_storage_reservations(scope,expires_at)');
  const current=await db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1');
  if(current?.initialized_at>0) {
    const installed=await db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'storage_usage_v1_%'");
    if(installed?.count!==triggers.length)throw new Error('Storage accounting requires repair');
    return {complete:true,after:triggers.length,trigger_count:triggers.length,total_bytes:current.total_bytes};
  }
  const page=triggers.slice(after,after+limit);
  for(const trigger of page) {
    // The hosted SDK treats an already-existing CREATE TRIGGER as read-only
    // and rejects db.run. A fixed catalog check keeps setup resumable there.
    if(!await db.get("SELECT 1 AS present FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name}))await db.run(trigger.sql);
  }
  const next=after+page.length;
  if(next<triggers.length)return {complete:false,after:next,trigger_count:triggers.length};
  const installed=await db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'storage_usage_v1_%'");
  if(installed?.count!==triggers.length)throw new Error('Storage accounting installation is incomplete');
  for(const scope of ['private','shared'])await db.run(`INSERT OR IGNORE INTO service_storage_scope_usage(scope,total_bytes,initialized_at)
    SELECT :scope,0,0 WHERE (SELECT initialized_at FROM service_storage_usage WHERE id=1)=0`,{':scope':scope});
  // Seed only identifiers, in fixed separate statements. Telegram uses a
  // lower compound-SELECT limit than desktop SQLite, so avoid a 27-way UNION.
  for(const table of STORAGE_TABLES.filter(table=>table.tenant))await db.run(`INSERT OR IGNORE INTO service_storage_scope_usage(scope,total_bytes,initialized_at)
    SELECT DISTINCT 'public:'||${table.tenant},0,0 FROM ${table.name}
    WHERE (SELECT initialized_at FROM service_storage_usage WHERE id=1)=0`);
  for(const table of STORAGE_TABLES.filter(table=>table.scopeColumn))await db.run(`INSERT OR IGNORE INTO service_storage_scope_usage(scope,total_bytes,initialized_at)
    SELECT DISTINCT ${table.scopeColumn},0,0 FROM ${table.name} WHERE (SELECT initialized_at FROM service_storage_usage WHERE id=1)=0`);
  // All scope baselines publish together. Triggers already cover concurrent
  // source writes; final global activation occurs only after this succeeds.
  await db.run(`UPDATE service_storage_scope_usage SET total_bytes=CASE
    WHEN scope='private' THEN ${scopedSum('private')}
    WHEN scope='shared' THEN ${scopedSum('shared')}
    ELSE ${scopedSum('public')} END,initialized_at=${NOW}
    WHERE (SELECT initialized_at FROM service_storage_usage WHERE id=1)=0`);
  await db.run(`UPDATE service_storage_usage SET total_bytes=${globalSum()},initialized_at=${NOW}
    WHERE id=1 AND initialized_at=0`);
  const ready=await db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1');
  if(!ready?.initialized_at||!Number.isSafeInteger(ready.total_bytes)||ready.total_bytes<0)throw new Error('Storage accounting initialization failed');
  return {complete:true,after:next,trigger_count:triggers.length,total_bytes:ready.total_bytes};
}

// Every additive installer shares this allowlist. Otherwise an older deployed
// baseline can require analytics accounting before compact accounting, while
// analytics setup simultaneously requires the new compact accounting triggers.
const ACCOUNTING_ADDITIONS = new Set(['service_checkpoint_sources','service_record_payloads','service_record_occurrences','service_record_inline_events',
  'gift_refresh_runs','public_gift_refresh_runs','personal_analytics_daily','public_personal_analytics_daily',
  'personal_analytics_item_reports','public_personal_analytics_item_reports','personal_analytics_collection_reports','public_personal_analytics_collection_reports']);
function additiveWriteGuard(table,triggers) {
  const name=`storage_accounting_upgrade_v1_${table}`;
  return {name,sql:`CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
    WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'
      AND name IN(${triggers.map(trigger=>`'${trigger.name}'`).join(',')}))<>3
    BEGIN SELECT RAISE(ABORT,'Storage accounting upgrade is incomplete'); END`};
}
async function installAdditiveStorageAccounting(db,feature) {
  const all = storageAccountingTriggers(), old = all.filter(item => !ACCOUNTING_ADDITIONS.has(item.table));
  const usage = await db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1');
  if (!usage || !Number.isSafeInteger(usage.total_bytes) || usage.total_bytes < 0
    || !Number.isSafeInteger(usage.initialized_at) || usage.initialized_at <= 0)
    throw new Error(`Storage accounting must be initialized before ${feature}`);
  const installed = await db.get(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'
    AND name IN(${old.map(item=>`'${item.name}'`).join(',')})`);
  if (installed?.count !== old.length) throw new Error('Storage accounting requires repair');
  const pending=[];
  for (const table of ACCOUNTING_ADDITIONS) {
    const triggers=all.filter(item=>item.table===table);
    const missing = [];
    for (const trigger of triggers)
      if (!await db.get("SELECT 1 AS present FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name})) missing.push(trigger);
    if (missing.length) {
      if (await db.get(`SELECT 1 AS present FROM ${table} LIMIT 1`)) throw new Error('Unaccounted additive storage requires repair');
      if (table==='service_checkpoint_sources') {
        const active=await db.get(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'
          AND name IN(${CHECKPOINT_SOURCE_TRIGGER_NAMES.map(name=>`'${name}'`).join(',')})`);
        if(active?.count)throw new Error('Active source pins require accounting repair');
      }
      pending.push({table,triggers,missing});
    }
  }
  for (const {table,triggers,missing} of pending) {
    // SQLite DDL statements commit separately in the hosted SDK. Install an
    // insert fence first, then recheck emptiness in case a write raced the
    // preflight. An empty table cannot change via UPDATE or DELETE. Keep this
    // fence through interruptions until all three accounting triggers exist.
    const guard=additiveWriteGuard(table,triggers);
    const saved=await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':guard.name});
    if(saved && saved.sql!==guard.sql)throw new Error('Storage accounting upgrade guard requires repair');
    if(!saved)await db.run(guard.sql);
    if(await db.get(`SELECT 1 AS present FROM ${table} LIMIT 1`))throw new Error('Unaccounted additive storage requires repair');
    for(const trigger of missing) {
      if(!await db.get("SELECT 1 AS present FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name}))await db.run(trigger.sql);
    }
  }
  for(const table of ACCOUNTING_ADDITIONS) {
    const guard=additiveWriteGuard(table,all.filter(item=>item.table===table));
    const saved=await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':guard.name});
    if(saved && saved.sql!==guard.sql)throw new Error('Storage accounting upgrade guard requires repair');
    if(saved)await db.run(`DROP TRIGGER ${guard.name}`);
  }
  return {complete:true,trigger_count:all.length};
}

// Install all pending known additions before their writers or backfills run.
// These entry points may run in either order and never reset live counters.
export async function installCompactStorageAccounting(db) {return installAdditiveStorageAccounting(db,'compact storage');}
export async function installAnalyticsStorageAccounting(db) {return installAdditiveStorageAccounting(db,'daily analytics');}
export async function installInlineRecordStorageAccounting(db) {return installAdditiveStorageAccounting(db,'inline record indexing');}

export function checkpointSourceAccountingTriggers() {
  return ['private','public'].flatMap((scope,index)=>['insert','update'].map((operation,offset)=>{
    const table=scope==='private'?'cloud_events':'public_cloud_events',scopeSql=scope==='private'?"'private'":"'public:'||NEW.user_id";
    return {name:CHECKPOINT_SOURCE_TRIGGER_NAMES[index*2+offset],table,sql:`CREATE TRIGGER IF NOT EXISTS ${CHECKPOINT_SOURCE_TRIGGER_NAMES[index*2+offset]}
      AFTER ${operation==='insert'?'INSERT':'UPDATE'} ON ${table} BEGIN
      INSERT OR IGNORE INTO service_checkpoint_sources(row_id,scope,kind,source_sequence)
      SELECT json_array(${scopeSql},CASE marker.key WHEN '__checkpoint_owned_targets_sequence' THEN 'owned_targets'
        WHEN '__checkpoint_owned_state_sequence' THEN 'owned_state' WHEN '__checkpoint_gift_state_sequence' THEN 'gift_state'
        WHEN '__checkpoint_budget_reset_sequence' THEN 'budget_reset' END,CAST(marker.value AS INTEGER)),${scopeSql},
        CASE marker.key WHEN '__checkpoint_owned_targets_sequence' THEN 'owned_targets'
          WHEN '__checkpoint_owned_state_sequence' THEN 'owned_state' WHEN '__checkpoint_gift_state_sequence' THEN 'gift_state'
          WHEN '__checkpoint_budget_reset_sequence' THEN 'budget_reset' END,CAST(marker.value AS INTEGER)
      FROM json_each(CASE WHEN json_valid(NEW.state_json) THEN CASE WHEN json_type(NEW.state_json,'$')='object'
        THEN NEW.state_json ELSE '{}' END ELSE '{}' END) marker
      WHERE marker.key IN('__checkpoint_owned_targets_sequence','__checkpoint_owned_state_sequence','__checkpoint_gift_state_sequence','__checkpoint_budget_reset_sequence')
        AND marker.type IN('integer','real') AND marker.value BETWEEN 1 AND 9007199254740991
        AND marker.value=CAST(marker.value AS INTEGER) AND marker.value<NEW.sequence;
      END`};
  }));
}
export async function installCheckpointSourceAccounting(db) {
  const usageTriggers=storageAccountingTriggers();
  await installAdditiveStorageAccounting(db,'source indexing');
  if(!await db.get("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='service_checkpoint_sources_lookup_idx'"))
    await db.run('CREATE INDEX service_checkpoint_sources_lookup_idx ON service_checkpoint_sources(scope,kind,source_sequence)');
  for(const trigger of checkpointSourceAccountingTriggers())
    if(!await db.get("SELECT 1 AS present FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name}))await db.run(trigger.sql);
  if(!await db.get(`SELECT 1 AS ready WHERE ${CHECKPOINT_SOURCE_TRIGGERS_READY}`))throw new Error('Checkpoint source accounting installation is incomplete');
  return {complete:true,trigger_count:4,usage_trigger_count:usageTriggers.length};
}
