import {inlineRecordIndexDefinitions,inlineRecordEventSelect} from '../tgcloud/lib/cloud-repository.js';
import {installInlineRecordStorageAccounting} from './storage-accounting.mjs';

// Call repeatedly with the returned cursor. Source documents stay in SQLite;
// each backfill statement inspects at most 25 events. Triggers are installed
// first, so writes/deletions during an interrupted backfill remain covered.
// Both seek indexes publish last and also act as the activation certificate.
export async function installInlineRecordIndex(db,{phase='private',after=null,limit=25}={}) {
  if(!['private','public'].includes(phase)||!Number.isSafeInteger(limit)||limit<1||limit>25
    ||after!==null&&(phase==='private'?(!Number.isSafeInteger(after)||after<0):typeof after!=='string'))throw new Error('Invalid inline index cursor');
  const definitions=inlineRecordIndexDefinitions(),triggers=definitions.filter(row=>row.type==='trigger'),indexes=definitions.filter(row=>row.type==='index');
  const names=Object.fromEntries(definitions.map((entry,index)=>[`:name${index}`,entry.name]));
  const savedDefinitions=new Map((await db.all(`SELECT name,type,sql FROM sqlite_master WHERE name IN(${Object.keys(names).join(',')})`,names)).map(row=>[row.name,row]));
  const present=[];
  for(const entry of definitions) {
    const saved=savedDefinitions.get(entry.name);
    if(saved&&(saved.type!==entry.type||saved.sql!==entry.sql))throw new Error('Inline record index definition requires explicit repair');
    if(saved)present.push(entry.name);
  }
  if(indexes.every(row=>present.includes(row.name))) {
    if(!triggers.every(row=>present.includes(row.name)))throw new Error('Active inline record index requires explicit repair');
    return {complete:true,phase:'complete',after:null,definitions:definitions.length};
  }
  // A caller-supplied resume cursor must not skip source rows after a missing
  // trigger. Only the initial cursor may install or resume installation.
  if((phase!=='private'||after!==null)&&!triggers.every(row=>present.includes(row.name)))throw new Error('Restart inline index installation from its initial cursor');
  if(!triggers.every(row=>present.includes(row.name)))await installInlineRecordStorageAccounting(db);
  for(const trigger of triggers)if(!present.includes(trigger.name))await db.run(trigger.sql);
  const table=phase==='private'?'cloud_events':'public_cloud_events',key=phase==='private'?'sequence':'row_id',cursor=after??(phase==='private'?0:''),source=inlineRecordEventSelect(table),
    args={':after':cursor,':limit':limit};
  // Select bounded IDs before testing JSON; no selective JSON predicate scans
  // the remaining archive looking for a matching event on the final page.
  const rows=await db.all(`WITH candidates AS (
      SELECT ${key} AS cursor,length(CAST(records_json AS BLOB)) AS bytes FROM ${table} WHERE ${key}>:after ORDER BY ${key} LIMIT :limit
    ), bounded AS (SELECT cursor,SUM(bytes) OVER(ORDER BY cursor) AS bytes FROM candidates)
    SELECT cursor FROM bounded WHERE bytes<=1048576 OR cursor=(SELECT MIN(cursor) FROM candidates) ORDER BY cursor`,args);
  if(rows.length) {
    const last=rows.at(-1).cursor;
    const keys=Object.fromEntries(rows.map((row,index)=>[`:key${index}`,row.cursor]));
    await db.run(`INSERT INTO service_record_inline_events(row_id,scope,generation,sequence,has_seed)
      ${source.select} FROM ${table} e WHERE e.${key} IN(${Object.keys(keys).join(',')}) AND ${source.inline}
      ON CONFLICT(row_id) DO UPDATE SET has_seed=excluded.has_seed`,keys);
    return {complete:false,phase,after:last,events_checked:rows.length};
  }
  if(phase==='private')return {complete:false,phase:'public',after:null,events_checked:0};
  // Recheck definitions before activation: an operator removing a trigger
  // during backfill must not publish an index that could omit a source event.
  for(const trigger of triggers) {
    const saved=await db.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=:name",{':name':trigger.name});
    if(saved?.sql!==trigger.sql)throw new Error('Inline record index changed during installation');
  }
  for(const index of indexes)if(!present.includes(index.name))await db.run(index.sql);
  return {complete:true,phase:'complete',after:null,definitions:definitions.length};
}

// Amortize management API throttling without increasing any SQL page. The
// deadline prevents starting another pass; an already-awaited SDK statement
// cannot be cancelled. Retrying the last confirmed cursor is idempotent if the
// host interrupts a batch before its response reaches the operator.
export async function installInlineRecordIndexBatch(db,{phase='private',after=null,limit=25,maxPasses=8,budgetMs=4500,now=()=>Date.now()}={}) {
  if(!Number.isSafeInteger(maxPasses)||maxPasses<1||maxPasses>8||!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>5000||typeof now!=='function')throw new Error('Invalid inline index batch');
  const started=now();if(!Number.isFinite(started)||started<0)throw new Error('Invalid inline index clock');
  let cursor={phase,after},result,checked=0,passes=0;
  while(passes<maxPasses) {
    const current=now();if(!Number.isFinite(current)||current<started)throw new Error('Invalid inline index clock');
    if(passes>0&&current-started>=budgetMs)break;
    result=await installInlineRecordIndex(db,{...cursor,limit});
    checked+=result.events_checked??0;passes++;
    if(result.complete)break;
    cursor={phase:result.phase,after:result.after};
  }
  return {...result,events_checked:checked,passes};
}
