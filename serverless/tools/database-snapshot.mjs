// Read-only SDK-compatible export. Data and schema are captured in ONE SQLite
// statement: paginating across calls would not give a consistent backup.
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(value)) throw Error('Unsupported database identifier');
  return '"' + value + '"';
};
const literal = value => "'" + value.replaceAll("'", "''") + "'";
export const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export async function captureDatabaseSnapshot(db, {maxBytes = SNAPSHOT_MAX_BYTES} = {}) {
  let stage='catalog';
  try {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > SNAPSHOT_MAX_BYTES) throw Error('Invalid snapshot limit');
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  if (!tables.length || tables.length > 100) throw Error('Unsupported database table count');
  const descriptors = [];
  stage='columns';
  for (const {name} of tables) {
    const columns = await db.all(`PRAGMA table_info(${identifier(name)})`);
    if (!columns.length || columns.some(c => !['TEXT', 'INTEGER'].includes(String(c.type).toUpperCase()))) throw Error('Unsupported database column');
    const pk = columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk);
    if (!pk.length) throw Error('Snapshot requires explicit primary keys');
    descriptors.push({name, columns: columns.map(c => c.name), primaryKey: pk.map(c => c.name)});
  }
  // Resource precheck only; consistency still comes from the final statement.
  // Independent aggregate reads may conservatively reject concurrent growth,
  // but can never authorize a partial or mixed-time backup.
  stage='size_precheck';let estimatedBytes=0;
  for(const t of descriptors) {
    const size=t.columns.map(c=>`COALESCE(length(CAST(${identifier(c)} AS BLOB)),0)`).join('+');
    const row=await db.get(`SELECT COALESCE(SUM(${size}),0) AS bytes FROM ${identifier(t.name)}`);
    if(!Number.isSafeInteger(row?.bytes)||row.bytes<0)throw Error('Invalid snapshot size');
    estimatedBytes+=row.bytes;
    if(estimatedBytes>maxBytes)throw Error('Snapshot exceeds bounded export size; use a provider-native snapshot');
  }
  const schemaSql = "SELECT 'schema' AS kind,type||':'||name AS name,0 AS ordinal,json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql) AS document FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL";
  const statements=[schemaSql,...descriptors.map(t=>{
    // Ordered chunks keep each response row small without splitting the read
    // into multiple statements. A single unusually large source row remains
    // intact and will fail closed if it exceeds the host's per-row limit.
    const row=`json_array(${t.columns.map(identifier).join(',')})`,order=t.primaryKey.map(identifier).join(',');
    return `SELECT 'table' AS kind,${literal(t.name)} AS name,bucket AS ordinal,json_group_array(json(document)) AS document
      FROM (SELECT ${row} AS document,CAST(SUM(length(CAST(${row} AS BLOB))+1) OVER(ORDER BY ${order} ROWS UNBOUNDED PRECEDING)/65536 AS INTEGER) AS bucket
      FROM ${identifier(t.name)} ORDER BY ${order}) GROUP BY bucket`;
  })];
  // The hosted compound-SELECT limit is lower than desktop SQLite. Nest small
  // groups, retaining one final statement and one consistent read snapshot.
  const groups=[];for(let i=0;i<statements.length;i+=6)groups.push(`SELECT * FROM (${statements.slice(i,i+6).join(' UNION ALL ')})`);
  const union=groups.join(' UNION ALL ');
  stage='capture';
  const rows=await db.all(`SELECT kind,name,ordinal,CASE WHEN backup_total_bytes<=:limit THEN document ELSE NULL END AS document,
      backup_total_rows,backup_total_bytes,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS captured_at
    FROM (SELECT *,COUNT(*) OVER() AS backup_total_rows,SUM(length(CAST(document AS BLOB))) OVER() AS backup_total_bytes FROM (${union}))
    ORDER BY kind,name,ordinal LIMIT 1000`,{':limit':maxBytes});
  stage='size';
  if(!rows.length||rows[0].backup_total_rows!==rows.length||rows[0].backup_total_bytes>maxBytes
    ||rows.some(row=>typeof row.document!=='string'||row.backup_total_rows!==rows.length||row.captured_at!==rows[0].captured_at))
    throw Error('Snapshot exceeds bounded export size or was truncated; use a provider-native snapshot');
  // A schema migration between descriptor discovery and capture must fail
  // closed. The single SELECT includes the actual schema at capture time.
  const snapshot={version:1,captured_at:rows[0].captured_at,descriptors,schema:[],tables:Object.fromEntries(descriptors.map(t=>[t.name,[]]))};
  for(const row of rows) {
    if(row.kind==='schema')snapshot.schema.push(JSON.parse(row.document));
    else if(row.kind==='table'&&Object.hasOwn(snapshot.tables,row.name))snapshot.tables[row.name].push(...JSON.parse(row.document));
    else throw Error('Invalid snapshot row');
  }
  stage='schema';
  if (JSON.stringify(snapshot.schema.filter(s => s.type === 'table').map(s => s.name).sort()) !== JSON.stringify(descriptors.map(t => t.name))) throw Error('Database schema changed during export');
  return snapshot;
  } catch(error) {
    // Only this fixed category may cross an operator log boundary. The original
    // SDK error can contain SQL or response bodies and must never be printed.
    error.snapshot_stage=stage;throw error;
  }
}
