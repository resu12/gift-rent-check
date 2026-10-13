// Local-only encrypted archives and isolated recovery drills. There is
// deliberately NO API accepting a live database connection or restore path.
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {DatabaseSync,constants as SQL} from 'node:sqlite';
import {captureDatabaseSnapshot,SNAPSHOT_MAX_BYTES} from './database-snapshot.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const MAGIC = Buffer.from('GRCBACKUP1\n');
const MAX_ARCHIVE_BYTES = SNAPSHOT_MAX_BYTES * 8;
function keyCheck(key) {if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('Backup key must contain exactly 32 bytes');}
export function snapshotManifest(snapshot, {appId,revision = null} = {}) {
  if (!/^[1-9]\d*$/.test(String(appId))) throw Error('Invalid backup app ID');
  return {format:1,app_id:String(appId),deployment_revision:revision,captured_at:snapshot.captured_at,
    consistency:'single_sql_statement',recovery:'isolated_verification_only',schema_sha256:hash(canonical(snapshot.schema)),
    tables:snapshot.descriptors.map(t => ({name:t.name,rows:snapshot.tables[t.name].length,sha256:hash(canonical(snapshot.tables[t.name]))})),
    snapshot_sha256:hash(canonical(snapshot)),nonce_warning:'Never resume writes under the old encryption key after rollback. Rotate to a new key domain and invalidate/re-encrypt old credentials and login sessions first.'};
}
export function encryptBackup(snapshot, key, metadata) {
  keyCheck(key); const manifest=snapshotManifest(snapshot,metadata),plain=Buffer.from(canonical({manifest,snapshot}));
  if (plain.length > MAX_ARCHIVE_BYTES) throw Error('Backup exceeds local archive bound');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
  const bytes=Buffer.concat([MAGIC,iv,cipher.update(gzipSync(plain)),cipher.final(),cipher.getAuthTag()]);
  return {bytes,manifest:{...manifest,archive_sha256:hash(bytes),archive_bytes:bytes.length}};
}
export function decryptBackup(bytes,key) {
  keyCheck(key);
  if (!Buffer.isBuffer(bytes) || bytes.length < MAGIC.length+28 || bytes.length>MAX_ARCHIVE_BYTES || !bytes.subarray(0,MAGIC.length).equals(MAGIC)) throw Error('Invalid encrypted backup');
  const start=MAGIC.length,decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(start,start+12));decipher.setAAD(MAGIC);decipher.setAuthTag(bytes.subarray(-16));
  const compressed=Buffer.concat([decipher.update(bytes.subarray(start+12,-16)),decipher.final()]);
  const result=JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX_ARCHIVE_BYTES}).toString('utf8'));
  const expected=snapshotManifest(result.snapshot,{appId:result.manifest?.app_id,revision:result.manifest?.deployment_revision});
  if (canonical(result.manifest)!==canonical(expected)) throw Error('Backup integrity mismatch');
  return result;
}
const quote = value => {if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(value)) throw Error('Invalid backup identifier');return '"'+value+'"';};
export async function verifyBackupRecovery(bytes,key,{expectedAppId}={}) {
  const {manifest,snapshot}=decryptBackup(bytes,key);
  if (expectedAppId!==undefined && String(expectedAppId)!==manifest.app_id) throw Error('Backup belongs to another app');
  const db=new DatabaseSync(':memory:');
  try {
    if (typeof db.setAuthorizer!=='function') throw Error('Recovery verification requires Node with SQLite authorization');
    const ddl = sql => {
      db.setAuthorizer((action,arg1,arg2) => {
        if ([SQL.SQLITE_ATTACH,SQL.SQLITE_DETACH,SQL.SQLITE_PRAGMA,SQL.SQLITE_CREATE_VTABLE,SQL.SQLITE_DROP_VTABLE].includes(action)) return SQL.SQLITE_DENY;
        if ([SQL.SQLITE_INSERT,SQL.SQLITE_UPDATE,SQL.SQLITE_DELETE].includes(action) && !['sqlite_master','sqlite_schema'].includes(arg1)) return SQL.SQLITE_DENY;
        if (action===SQL.SQLITE_FUNCTION && arg2==='load_extension') return SQL.SQLITE_DENY;
        return SQL.SQLITE_OK;
      });
      db.exec(sql);
    };
    for (const object of snapshot.schema.filter(s => s.type==='table')) {
      if (!/^CREATE TABLE\s/i.test(object.sql) || /\bAUTOINCREMENT\b/i.test(object.sql)) throw Error('Unsupported backup table');
      ddl(object.sql);
    }
    db.setAuthorizer((action,arg1) => [SQL.SQLITE_INSERT,SQL.SQLITE_SELECT,SQL.SQLITE_READ].includes(action) && arg1!=='sqlite_master' ? SQL.SQLITE_OK : SQL.SQLITE_DENY);
    for (const table of snapshot.descriptors) {
      const statement=db.prepare(`INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(',')}) VALUES(${table.columns.map(()=>'?').join(',')})`);
      for (const row of snapshot.tables[table.name]) {
        if (!Array.isArray(row) || row.length!==table.columns.length || row.some(v=>v!==null && typeof v!=='string' && !Number.isSafeInteger(v))) throw Error('Unsupported backup value');
        statement.run(...row);
      }
    }
    for (const object of snapshot.schema.filter(s => s.type!=='table')) {
      if (!['index','trigger','view'].includes(object.type) || !new RegExp('^CREATE (?:UNIQUE )?'+object.type+'\\s','i').test(object.sql)) throw Error('Unsupported backup schema object');
      ddl(object.sql);
    }
    db.setAuthorizer((action,arg1,arg2) => {
      if ([SQL.SQLITE_READ,SQL.SQLITE_SELECT,SQL.SQLITE_FUNCTION,SQL.SQLITE_RECURSIVE].includes(action) && arg2!=='load_extension') return SQL.SQLITE_OK;
      return action===SQL.SQLITE_PRAGMA && ['integrity_check','foreign_key_check','table_info'].includes(arg1) ? SQL.SQLITE_OK : SQL.SQLITE_DENY;
    });
    if (db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Restored database integrity failed');
    const adapter={all:async(sql,args={})=>db.prepare(sql).all(args),get:async(sql,args={})=>db.prepare(sql).get(args)};
    const restored=await captureDatabaseSnapshot(adapter);
    if (canonical(restored.schema)!==canonical(snapshot.schema) || canonical(restored.tables)!==canonical(snapshot.tables)) throw Error('Restored data differs from backup');
    return {verified:true,verified_at:new Date().toISOString(),app_id:manifest.app_id,tables:manifest.tables.length,rows:manifest.tables.reduce((n,t)=>n+t.rows,0),consistency:manifest.consistency,
      live_restore_performed:false,credential_decryption_verified:false,nonce_rollback_safe_for_live_writes:false};
  } finally {db.close();}
}
