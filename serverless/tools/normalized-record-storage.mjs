import {NORMALIZED_RECORD_TRIGGER_NAMES, NORMALIZED_RECORD_READY_SQL} from '../tgcloud/lib/cloud-repository.js';

// Installation is an administrative operation. Runtime writers only use the
// fixed trigger readiness guard; accepted event CAS and evidence publication
// are one SQLite statement, including collision validation and marker rewrite.
export function normalizedRecordStorageTriggers() {
  return ['private','public'].map((kind,index)=>{
    const table=kind==='private'?'cloud_events':'public_cloud_events',scope=kind==='private'?"'private'":"'public:'||NEW.user_id",
      generation=kind==='private'?'0':"(SELECT generation FROM public_accounts WHERE user_id=NEW.user_id AND status='active')",
      prefix=`(${scope}||':g'||${generation}||':')`,payload=`${prefix}||json_extract(j.value,'$.__normalized_write_v1.hash')`,
      entries="json_each(NEW.records_json) j",prepared="json_type(j.value,'$.__normalized_write_v1')='object'";
    return {name:NORMALIZED_RECORD_TRIGGER_NAMES[index],table,sql:`CREATE TRIGGER ${NORMALIZED_RECORD_TRIGGER_NAMES[index]}
      AFTER INSERT ON ${table} WHEN json_extract(NEW.state_json,'$.operational_storage_version')=1 BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM ${entries} WHERE NOT COALESCE(${prepared},0)
        AND json_type(j.value,'$.__normalized_inline_v1') IS NULL)
        THEN RAISE(ABORT,'Unprepared normalized record envelope') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM ${entries} WHERE ${prepared}
        AND (json_type(j.value,'$.__normalized_write_v1.hash')<>'text'
          OR length(json_extract(j.value,'$.__normalized_write_v1.hash'))<>64
          OR json_extract(j.value,'$.__normalized_write_v1.hash') GLOB '*[^0-9a-f]*'
          OR json_type(j.value,'$.__normalized_write_v1.document')<>'object'
          OR json_type(j.value,'$.__normalized_write_v1.envelope')<>'object'))
        THEN RAISE(ABORT,'Invalid normalized record envelope') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM ${entries} JOIN service_record_payloads p ON p.payload_id=${payload}
        WHERE ${prepared} AND (p.scope<>${scope} OR p.document<>json_extract(j.value,'$.__normalized_write_v1.document')))
        THEN RAISE(ABORT,'Conflicting normalized record payload') END;
      INSERT OR IGNORE INTO service_record_payloads(payload_id,scope,document)
        SELECT ${payload},${scope},json_extract(j.value,'$.__normalized_write_v1.document') FROM ${entries} WHERE ${prepared};
      INSERT INTO service_record_occurrences(occurrence_id,scope,sequence,ordinal,event_key,observed_at,payload_id,envelope_json)
        SELECT ${prefix}||NEW.sequence||':'||j.key,${scope},NEW.sequence,CAST(j.key AS INTEGER),NEW.event_key,
          COALESCE(json_extract(j.value,'$.__normalized_write_v1.envelope.observed_at'),''),${payload},
          json_extract(j.value,'$.__normalized_write_v1.envelope') FROM ${entries} WHERE ${prepared};
      UPDATE ${table} SET records_json=(SELECT json_group_array(json(CASE WHEN ${prepared}
        THEN json_object('kind',json_extract(j.value,'$.kind'),'__normalized_record_v1',CAST(j.key AS INTEGER)) ELSE json_quote(json_extract(j.value,'$.__normalized_inline_v1')) END))
        FROM ${entries}) WHERE ${kind==='private'?'sequence=NEW.sequence':'row_id=NEW.row_id'};
      END`};
  });
}
export async function installNormalizedRecordStorage(db) {
  for(const trigger of normalizedRecordStorageTriggers()) {
    const saved=await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name});
    if(saved&&saved.sql!==trigger.sql)throw new Error('Normalized record trigger differs from the expected definition');
    if(!saved)await db.run(trigger.sql);
  }
  if(!await db.get(`SELECT 1 AS ready WHERE ${NORMALIZED_RECORD_READY_SQL}`))throw new Error('Normalized record storage installation is incomplete');
  return {complete:true,trigger_count:NORMALIZED_RECORD_TRIGGER_NAMES.length};
}

// Upgrade only the two known development definitions. While either trigger is
// absent, compact writes fail their SQL readiness guard; retries are safe.
export async function upgradeNormalizedRecordStorage(db) {
  const triggers=normalizedRecordStorageTriggers();
  for(const trigger of triggers) {
    const saved=await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name});
    if(!saved||saved.sql===trigger.sql)continue;
    const unprepared="      SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.records_json) j WHERE NOT COALESCE(json_type(j.value,'$.__normalized_write_v1')='object',0)\n        AND json_type(j.value,'$.__normalized_inline_v1') IS NULL)\n        THEN RAISE(ABORT,'Unprepared normalized record envelope') END;\n";
    const hex="          OR json_extract(j.value,'$.__normalized_write_v1.hash') GLOB '*[^0-9a-f]*'\n";
    const known=[trigger.sql.replace(unprepared,''),trigger.sql.replace(hex,''),trigger.sql.replace(unprepared,'').replace(hex,'')];
    if(!known.includes(saved.sql))throw new Error('Unexpected normalized storage trigger; explicit repair is required');
  }
  for(const trigger of triggers) {
    const saved=await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name});
    if(saved&&saved.sql!==trigger.sql)await db.run(`DROP TRIGGER ${trigger.name}`);
    if(!saved||saved.sql!==trigger.sql)await db.run(trigger.sql);
  }
  return await installNormalizedRecordStorage(db);
}
