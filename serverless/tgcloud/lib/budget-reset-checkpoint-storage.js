// The one-off reset receipt is permanent audit/idempotency data. Reuse exact
// immutable receipts without changing expiry, timestamps or request accounting.
export const BUDGET_RESET_MARKER = '__checkpoint_budget_reset_sequence';
export const CHECKPOINT_SOURCE_TRIGGER_NAMES = Object.freeze(['checkpoint_sources_v1_private_insert','checkpoint_sources_v1_private_update',
  'checkpoint_sources_v1_public_insert','checkpoint_sources_v1_public_update']);
export const CHECKPOINT_SOURCE_TRIGGERS_READY = `(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'
  AND name IN (${CHECKPOINT_SOURCE_TRIGGER_NAMES.map(name => `'${name}'`).join(',')}))=4`;
export function checkpointSourceScopeSql(scope) {
  if (typeof scope !== 'string' || !/^(private|public:[1-9]\d{0,15})$/.test(scope)
      || scope !== 'private' && !Number.isSafeInteger(Number(scope.slice(7)))) throw new Error('Invalid checkpoint source scope');
  return `'${scope}'`;
}
export function checkpointSourceIndexReadySql(scope) {
  return `EXISTS(SELECT 1 FROM service_checkpoint_source_scans WHERE scope=${checkpointSourceScopeSql(scope)}
    AND initialized_at>0 AND after_sequence>=boundary_sequence) AND ${CHECKPOINT_SOURCE_TRIGGERS_READY}`;
}
// JSON filtering happens only after the physical sequence/byte page is fixed.
// The cursor also advances over rows with no matching component, so a legacy
// unmatched tail cannot repeatedly restart an unbounded JSON scan.
export async function readCheckpointPhysicalPage(db, {after, boundary, projection, predicate = '1=1', ctes = '', parameters = {}}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(boundary) || boundary < after)
    throw new Error('Invalid physical checkpoint page');
  const ids = await db.all(`WITH pending AS MATERIALIZED (
    SELECT sequence,length(CAST(state_json AS BLOB)) AS state_bytes FROM cloud_events
    WHERE sequence>:physical_after AND sequence<:physical_boundary ORDER BY sequence LIMIT 25),
    bounded AS MATERIALIZED (SELECT sequence,SUM(state_bytes) OVER (ORDER BY sequence) AS total_bytes FROM pending)
    SELECT sequence FROM bounded WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`,
    {':physical_after': after, ':physical_boundary': boundary});
  if (!ids.length) return {rows: [], after, complete: true};
  const params = {...parameters}, selected = ids.map((row, index) => {
    params[`:physical_row${index}`] = row.sequence; return `:physical_row${index}`;
  });
  const rows = await db.all(`${ctes ? `WITH ${ctes} ` : ''}SELECT ${projection} FROM cloud_events
    WHERE sequence IN (${selected.join(',')}) AND ${predicate} ORDER BY sequence`, params);
  const next = ids[ids.length - 1].sequence;
  return {rows, after: next, complete: next >= boundary - 1};
}
// Maintenance may miss a distant duplicate, but must not parse the complete
// event history to prove that no source exists. Materialize physical IDs first,
// apply the state-byte window, then evaluate exact component and parser guards
// only for that bounded page. Permanent pins are preferred across host calls.
export async function findBoundedCheckpointSource(db, {kinds, projection, inline, match, before, parameters = {}}) {
  const ready = checkpointSourceIndexReadySql('private');
  if (!await db.get(`SELECT 1 AS ready WHERE ${ready}`)) throw new Error('Checkpoint source index is not ready');
  const params = {...parameters, ':lookup_before': before};
  for (const pinned of [true, false]) {
    const pending = pinned ? `WITH pinned AS MATERIALIZED (
      SELECT DISTINCT source_sequence AS sequence FROM service_checkpoint_sources
      WHERE scope='private' AND kind IN (${kinds.map(kind => `'${kind}'`).join(',')}) AND source_sequence<:lookup_before
      ORDER BY source_sequence DESC LIMIT 25), pending AS MATERIALIZED (
      SELECT cloud_events.sequence,length(CAST(cloud_events.state_json AS BLOB)) AS source_bytes
      FROM pinned JOIN cloud_events ON cloud_events.sequence=pinned.sequence)` : `WITH pending AS MATERIALIZED (
      SELECT sequence,length(CAST(state_json AS BLOB)) AS source_bytes FROM cloud_events
      WHERE sequence<:lookup_before ORDER BY sequence DESC LIMIT 25)`;
    const found = await db.get(`${pending},
      bounded AS MATERIALIZED (SELECT sequence,SUM(source_bytes) OVER (ORDER BY sequence DESC) AS total_bytes FROM pending),
      source_page AS MATERIALIZED (SELECT cloud_events.sequence,cloud_events.state_json FROM cloud_events JOIN bounded
        ON cloud_events.sequence=bounded.sequence WHERE total_bytes<=524288 OR bounded.sequence=(SELECT MAX(sequence) FROM pending))
      SELECT ${projection} FROM source_page WHERE ${inline} AND ${match} AND ${ready} ORDER BY sequence LIMIT 1`, params);
    if (found) return found;
  }
  return null;
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sequence = value => Number.isSafeInteger(value) && value > 0;
const INLINE = `CASE WHEN json_valid(state_json) THEN json_type(state_json,'$')='object'
  AND json_type(state_json,'$.__checkpoint_budget_reset_sequence') IS NULL
  AND json_type(state_json,'$.marketapp_budget_reset')='object'
  AND json_type(json_remove(state_json,'$.marketapp_budget_reset'),'$.marketapp_budget_reset') IS NULL ELSE 0 END`;
const GIFT_INLINE = `CASE WHEN json_valid(state_json) THEN json_type(state_json,'$')='object'
  AND json_type(state_json,'$.__checkpoint_gift_state_sequence') IS NULL
  AND json_type(state_json,'$.gift_refresh')='object'
  AND json_type(json_remove(state_json,'$.gift_refresh'),'$.gift_refresh') IS NULL ELSE 0 END`;
const PROJECTION = `sequence,json_extract(state_json,'$.marketapp_budget_reset') AS budget_reset_json`;
const LEGACY_PROTECTED = `protected_reset_sources AS MATERIALIZED (SELECT
  CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.__checkpoint_budget_reset_sequence') ELSE NULL END AS reset_source,
  CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.__checkpoint_gift_state_sequence') ELSE NULL END AS gift_source
  FROM cloud_events WHERE state_json LIKE '%"__checkpoint_budget_reset_sequence"%' OR state_json LIKE '%"__checkpoint_gift_state_sequence"%')`;
const UNREFERENCED = `NOT EXISTS(SELECT 1 FROM protected_reset_sources WHERE reset_source=cloud_events.sequence)`;
const UNREFERENCED_GIFT = `NOT EXISTS(SELECT 1 FROM protected_reset_sources WHERE gift_source=cloud_events.sequence)`;
export const BUDGET_RESET_SOURCE_FENCE = `(:budget_source IS NULL OR EXISTS(SELECT 1 FROM cloud_events source
  WHERE source.sequence=:budget_source AND source.sequence<:sequence AND ${INLINE.replaceAll('state_json','source.state_json')}
    AND CASE WHEN json_valid(source.state_json) THEN json_extract(source.state_json,'$.marketapp_budget_reset')=:budget_json ELSE 0 END))`;

function receipt(source, before) {
  if (!source || !sequence(source.sequence) || source.sequence >= before || typeof source.budget_reset_json !== 'string') throw new Error('Invalid budget-reset checkpoint source');
  const value = JSON.parse(source.budget_reset_json);
  if (!plain(value)) throw new Error('Invalid budget-reset checkpoint receipt');
  return value;
}
export function encodeBudgetResetReference(state, before, source) {
  if (Object.hasOwn(state, BUDGET_RESET_MARKER)) throw new Error('Invalid checkpoint storage marker');
  if (!source) return state;
  if (!sequence(before)) throw new Error('Invalid budget-reset checkpoint sequence');
  const value = receipt(source, before);
  if (!plain(state.marketapp_budget_reset) || JSON.stringify(state.marketapp_budget_reset) !== JSON.stringify(value)) throw new Error('Budget-reset checkpoint source does not match');
  const result = {...state}; delete result.marketapp_budget_reset; result[BUDGET_RESET_MARKER] = source.sequence; return result;
}
export function decodeBudgetResetReference(state, before, source) {
  if (!Object.hasOwn(state, BUDGET_RESET_MARKER)) return state;
  const marker = state[BUDGET_RESET_MARKER];
  if (!sequence(before) || !sequence(marker) || marker >= before || source?.sequence !== marker || Object.hasOwn(state,'marketapp_budget_reset')) throw new Error('Invalid saved budget-reset checkpoint reference');
  const result = {...state}; result.marketapp_budget_reset = receipt(source, before); delete result[BUDGET_RESET_MARKER]; return result;
}

export function createBudgetResetCheckpointStorage(db, {findGiftStateSource = async () => null, sourceScope = null} = {}) {
  if (sourceScope !== null && sourceScope !== 'private') throw new Error('Invalid private checkpoint source scope');
  const ready = sourceScope === null ? '1=1' : checkpointSourceIndexReadySql(sourceScope);
  const PROTECTED = sourceScope === null ? LEGACY_PROTECTED : `protected_reset_sources AS MATERIALIZED (SELECT
    CASE WHEN kind='budget_reset' THEN source_sequence ELSE NULL END AS reset_source,
    CASE WHEN kind='gift_state' THEN source_sequence ELSE NULL END AS gift_source FROM service_checkpoint_sources
    WHERE scope=${checkpointSourceScopeSql(sourceScope)} AND kind IN ('budget_reset','gift_state'))`;
  const roots = new Map(); let rootBytes = 0;
  async function source(sequenceValue) {
    if (!sequence(sequenceValue)) throw new Error('Invalid budget-reset source sequence');
    return await db.get(`SELECT ${PROJECTION} FROM cloud_events WHERE sequence=:sequence AND ${INLINE}`, {':sequence': sequenceValue});
  }
  async function exact(value, before) {
    if (sourceScope === 'private') return await findBoundedCheckpointSource(db, {
      kinds: ['budget_reset'], projection: PROJECTION, inline: INLINE, before, parameters: {':receipt': value},
      match: "CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.marketapp_budget_reset')=:receipt ELSE 0 END",
    });
    return await db.get(`SELECT ${PROJECTION} FROM cloud_events WHERE sequence<:before AND ${INLINE}
      AND CASE WHEN json_valid(state_json) THEN json_extract(state_json,'$.marketapp_budget_reset')=:receipt ELSE 0 END
      ORDER BY sequence LIMIT 1`, {':before': before, ':receipt': value});
  }
  async function root(row, budget) {
    for (const [key, saved] of roots) if (saved.budget_reset_json === row.budget_reset_json && saved.sequence <= row.sequence) {
      roots.delete(key); roots.set(key,saved); return saved.sequence;
    }
    if (budget.lookups >= 4) return null;
    budget.lookups++;
    const found = await exact(row.budget_reset_json,row.sequence), id = found?.sequence ?? row.sequence, bytes = 2*row.budget_reset_json.length;
    while (roots.size && (roots.size>=16 || rootBytes+bytes>524288)) {
      const key=roots.keys().next().value; rootBytes-=roots.get(key).bytes; roots.delete(key);
    }
    if (roots.has(id)) {rootBytes-=roots.get(id).bytes;roots.delete(id);}
    if (bytes<=524288) {roots.set(id,{sequence:id,budget_reset_json:row.budget_reset_json,bytes});rootBytes+=bytes;}
    return id;
  }
  async function partition(input, compact) {
    if (sourceScope !== null && !await db.get(`SELECT 1 AS ready WHERE ${ready}`)) throw new Error('Checkpoint source index is not ready');
    if (!plain(input) || Object.keys(input).some(key=>!['after','boundary',...(compact?['limit']:[])].includes(key))) throw new Error('Invalid budget-reset partition');
    const afterInput=input.after??0,boundaryInput=input.boundary??0,requestedLimit=input.limit??4;
    if (!Number.isSafeInteger(afterInput)||afterInput<0||!Number.isSafeInteger(boundaryInput)||boundaryInput<0
      ||compact&&(!sequence(boundaryInput)||!Number.isSafeInteger(requestedLimit)||requestedLimit<1||requestedLimit>100)) throw new Error('Invalid budget-reset partition bound');
    const head=(await db.get('SELECT COALESCE(MAX(sequence),0) AS boundary FROM cloud_events')).boundary,boundary=boundaryInput||head,limit=Math.min(requestedLimit,4);
    if (afterInput>boundary||boundary>head) throw new Error('Invalid budget-reset partition cursor');
    let after=afterInput,complete=boundary===0||after>=boundary-1,duplicate_budget_reset_bytes=0,budget_reset_compactable=0;
    const selected=[],budget={lookups:0};
    scan:for(let page=0;page<(sourceScope==='private'?1:2)&&!complete;page++) {
      const physical=sourceScope==='private'?await readCheckpointPhysicalPage(db,{after,boundary,ctes:PROTECTED,
        projection:`${PROJECTION},length(CAST(json_extract(state_json,'$.marketapp_budget_reset') AS BLOB)) AS receipt_bytes,
          CASE WHEN ${GIFT_INLINE} AND ${UNREFERENCED_GIFT} THEN json_extract(state_json,'$.gift_refresh') ELSE NULL END AS gift_refresh_json`,
        predicate:`${INLINE} AND ${UNREFERENCED} AND length(CAST(json_extract(state_json,'$.marketapp_budget_reset') AS BLOB))>64`,
      }):null;
      const rows=physical?.rows??await db.all(`WITH ${PROTECTED}, pending AS (
        SELECT ${PROJECTION},length(CAST(json_extract(state_json,'$.marketapp_budget_reset') AS BLOB)) AS receipt_bytes,
          CASE WHEN ${GIFT_INLINE} AND ${UNREFERENCED_GIFT} THEN json_extract(state_json,'$.gift_refresh') ELSE NULL END AS gift_refresh_json
        FROM cloud_events WHERE sequence>:after AND sequence<:boundary AND ${INLINE} AND ${UNREFERENCED}
          AND length(CAST(json_extract(state_json,'$.marketapp_budget_reset') AS BLOB))>64 ORDER BY sequence LIMIT 25
      ), bounded AS (SELECT *,SUM(receipt_bytes+COALESCE(length(CAST(gift_refresh_json AS BLOB)),0)) OVER (ORDER BY sequence) AS total_bytes FROM pending)
      SELECT sequence,budget_reset_json,receipt_bytes,gift_refresh_json FROM bounded
        WHERE total_bytes<=524288 OR sequence=(SELECT MIN(sequence) FROM pending) ORDER BY sequence`, {':after':after,':boundary':boundary});
      if (!rows.length) {if(physical){after=physical.after;complete=physical.complete;continue;}complete=true;break;}
      for (const row of rows) {
        const resetSource=await root(row,budget); if (resetSource===null) break scan;
        if (resetSource<row.sequence) {
          duplicate_budget_reset_bytes+=row.receipt_bytes;budget_reset_compactable++;
          if(compact) {
            const giftSource=row.gift_refresh_json?await findGiftStateSource(JSON.parse(row.gift_refresh_json),row.sequence):null;
            selected.push({sequence:row.sequence,source:resetSource,giftSource:giftSource?.sequence??null});
          }
        }
        after=row.sequence; if(compact&&selected.length>=limit)break scan;
      }
      if(physical){after=physical.after;complete=physical.complete;}
      if(after>=boundary-1)complete=true;
    }
    if(!compact)return{duplicate_budget_reset_bytes,budget_reset_compactable,boundary,after,complete};
    if(sourceScope==='private') {
      // A combined publication can use another selected row's gift component
      // even when their receipts share a different root. Keep every source
      // row inline; one-hop readers cannot resolve a newly created chain.
      const sources=new Set(selected.flatMap(row=>[row.source,...(row.giftSource===null?[]:[row.giftSource])]));
      selected.splice(0,selected.length,...selected.filter(row=>!sources.has(row.sequence)));
    }
    if(!selected.length)return{rewritten:0,boundary,after,complete};
    const params={':boundary':boundary},resetCases=[],giftCases=[],sequences=[];
    selected.forEach((row,index)=>{
      params[`:sequence${index}`]=row.sequence;params[`:source${index}`]=row.source;params[`:gift${index}`]=row.giftSource;
      sequences.push(`:sequence${index}`);resetCases.push(`WHEN :sequence${index} THEN :source${index}`);giftCases.push(`WHEN :sequence${index} THEN :gift${index}`);
    });
    const chosen=`CASE cloud_events.sequence ${resetCases.join(' ')} END`,giftChosen=`CASE cloud_events.sequence ${giftCases.join(' ')} END`;
    const result=await db.run(`WITH ${PROTECTED} UPDATE cloud_events SET state_json=CASE WHEN ${giftChosen} IS NULL
      THEN json_set(json_remove(state_json,'$.marketapp_budget_reset'),'$.__checkpoint_budget_reset_sequence',${chosen})
      ELSE json_set(json_remove(state_json,'$.marketapp_budget_reset','$.gift_refresh'),
        '$.__checkpoint_budget_reset_sequence',${chosen},'$.__checkpoint_gift_state_sequence',${giftChosen}) END
      WHERE sequence IN (${sequences.join(',')}) AND sequence<:boundary AND sequence<(SELECT MAX(sequence) FROM cloud_events)
        AND ${INLINE} AND ${UNREFERENCED} AND ${ready}
        AND EXISTS(SELECT 1 FROM cloud_events source WHERE source.sequence=${chosen} AND source.sequence<cloud_events.sequence
          AND ${INLINE.replaceAll('state_json','source.state_json')}
          AND CASE WHEN json_valid(source.state_json) THEN json_extract(source.state_json,'$.marketapp_budget_reset')=json_extract(cloud_events.state_json,'$.marketapp_budget_reset') ELSE 0 END)
        AND (${giftChosen} IS NULL OR (${GIFT_INLINE} AND ${UNREFERENCED_GIFT}
          AND EXISTS(SELECT 1 FROM cloud_events source WHERE source.sequence=${giftChosen} AND source.sequence<cloud_events.sequence
            AND ${GIFT_INLINE.replaceAll('state_json','source.state_json')}
            AND CASE WHEN json_valid(source.state_json) THEN json_extract(source.state_json,'$.gift_refresh')=json_extract(cloud_events.state_json,'$.gift_refresh') ELSE 0 END)))`,params);
    return{rewritten:result.rowsAffected,boundary,after,complete};
  }
  return {
    budgetResetSource:source,
    async findBudgetResetSource(value,before,preferred=null) {
      if(!sequence(before))throw new Error('Invalid budget-reset source bound');if(!plain(value))return null;
      const encoded=JSON.stringify(value);if(encoded.length<=64)return null;
      if(sequence(preferred)&&preferred<before){const saved=await source(preferred);if(saved?.sequence===preferred&&saved.budget_reset_json===encoded)return saved;}
      return await exact(encoded,before);
    },
    budgetResetStorageStatsPage:input=>partition(input??{},false),
    compactCheckpointBudgetResetsPage:input=>partition(input,true),
  };
}
