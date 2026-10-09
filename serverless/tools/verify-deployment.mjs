// Read-only post-deployment verification using the pinned official CLI helpers.
// Executes the deployed code snapshot, returns aggregates only, and checks that
// each dashboard read leaves the database sequence and provider ledger intact.
// Administrative /run supplies a test context: this does not replace opening
// the Mini App in Telegram to verify its platform authentication handshake.
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {option, requireId, validateAuthenticatedDestination} from './destination.mjs';

const RECORDS_DIAGNOSTIC_SOURCE=`
import getJobs from '../endpoints/getJobs.js';
import {createCloudRepository} from '../lib/cloud-repository.js';
import {db} from 'sdk';
export default async function(input,ctx) {
  await getJobs({},ctx);
  const repository=createCloudRepository(db), before=await repository.read();
  const records=await repository.records();
  const after=await repository.read();
  return {diagnostic:true,records_only:true,record_count:records.length,
    database_unchanged:before.revision===after.revision&&JSON.stringify(before.state)===JSON.stringify(after.state)};
}
`;

const DIAGNOSTIC_SOURCE = `
import {cloud} from '../lib/runtime.js';
import {db} from 'sdk';
export default async function(input,ctx) {
  const before=await db.get('SELECT MAX(sequence) AS sequence FROM cloud_events');
  try {
    const result=await cloud.getDashboard(ctx,input);
    return {diagnostic:true,success:true,gift_rows:result.gifts.length};
  } catch(error) {
    const message=String(error?.message||'');
    const builtIn=/^(?:Cannot read properties of (?:undefined|null) \\(reading '[A-Za-z_][A-Za-z0-9_]*'\\)|[A-Za-z_$][A-Za-z0-9_$.]* is not (?:a function|defined|iterable)|Maximum call stack size exceeded|Invalid time value)$/.test(message);
    const after=await db.get('SELECT MAX(sequence) AS sequence FROM cloud_events');
    return {diagnostic:true,success:false,name:/^[A-Za-z]+Error$/.test(error?.name||'')?error.name:'Error',
      safe_message:builtIn?message:'Suppressed nonstandard message',
      error_terms:message.toLowerCase().match(/\\b(?:database|query|sql|result|response|output|size|limit|maximum|exceeded|too|large|memory|time|timeout|budget|rows|bytes|payload|read|only|unsupported|bind|parameter|invalid|permission|denied|column|table|missing|parse|range|function|call|db|all|get|run)\\b/g)||[],
      locations:String(error?.stack||'').match(/(?:lib|endpoints)\\/[A-Za-z0-9_-]+(?:\\.js)?:\\d+(?::\\d+)?/g)||[],
      database_unchanged:before.sequence===after.sequence};
  }
}
`;

export const VERIFICATION_SOURCE = `
import getDashboard from '../endpoints/getDashboard.js';
import getJobs from '../endpoints/getJobs.js';
import {db} from 'sdk';

async function checkpoint() {
  const row = await db.get('SELECT sequence,state_json FROM cloud_events ORDER BY sequence DESC LIMIT 1');
  if (!row) throw new Error('The imported dataset is missing');
  const state = JSON.parse(row.state_json);
  return {sequence:row.sequence, state_json:row.state_json, attempts:state.attempts.length};
}

async function denied(endpoint, input, context) {
  try {await endpoint(input, context); return false;}
  catch(error) {return error?.message === 'Private access denied';}
}

export default async function(input, ctx) {
  const before=await checkpoint();
  const foreign={initData:{user:{id:Number(ctx.initData.user.id)+1}}};
  const authorization={
    dashboard_missing:await denied(getDashboard, input, {}),
    dashboard_foreign:await denied(getDashboard, input, foreign),
    jobs_missing:await denied(getJobs, {}, {}),
    jobs_foreign:await denied(getJobs, {}, foreign),
  };
  if(!Object.values(authorization).every(Boolean)) throw new Error('Endpoint authorization verification failed');
  const data=await getDashboard(input, ctx);
  const jobResult=await getJobs({}, ctx);
  const after=await checkpoint();
  if(before.sequence!==after.sequence || before.state_json!==after.state_json) throw new Error('The database changed during the read-only check; check for concurrent collection');
  if(!Array.isArray(data.gifts) || !Array.isArray(jobResult.jobs)) throw new Error('Unexpected deployed endpoint response');
  const portfolio=data.gifts.filter(g=>g.is_portfolio);
  if(data.summary.portfolio_count!==portfolio.length || data.summary.unresolved_count!==data.gifts.length-portfolio.length) throw new Error('Dashboard membership counts disagree');
  const source=input.source, backdrop=input.backdrop??null;
  if(data.pricing.source!==source || data.pricing.backdrop!==backdrop || data.pricing.timeframe!==input.timeframe) throw new Error('Pricing selection was not applied');
  if(data.gifts.some(g=>g.pricing?.source!==source || g.pricing?.backdrop!==backdrop)) throw new Error('Gift comparison selection was not applied');
  if(data.gifts.some(g=>!g.is_portfolio && g.pricing?.recommended_price_per_day!==null)) throw new Error('An unresolved candidate received a recommendation');
  if(backdrop && data.gifts.some(g=>g.pricing?.recommended_price_per_day!==null && g.backdrop?.trim().toLowerCase()!=='black')) throw new Error('An unrelated backdrop received a Black recommendation');
  return {verified:true,source,backdrop,timeframe:data.pricing.timeframe,
    gift_rows:data.gifts.length,portfolio_gifts:portfolio.length,unresolved_candidates:data.gifts.length-portfolio.length,
    recommended_gifts:data.pricing.recommended_count,peer_nfts:data.pricing.fresh_peer_count,
    rental_records:data.pricing.rental_record_count??null,
    counted_portfolio_gifts:portfolio.filter(g=>g.rental_history?.recorded_count!==null).length,
    job_count:jobResult.jobs.length,active_jobs:jobResult.jobs.filter(j=>['queued','running'].includes(j.state)).length,
    marketapp_configured:data.capabilities.marketapp_configured,
    limits:data.capabilities.marketapp_limits,authorization,
    db_sequence:after.sequence,provider_ledger_entries:after.attempts,
    database_unchanged:true,provider_ledger_unchanged:true};
}
`;

export function validateVerificationDestination(token, appId, env = process.env) {
  validateAuthenticatedDestination(token, appId, env);
}

export function expectedCounts(args) {
  const values = {portfolio: option(args, '--expect-portfolio'), unresolved: option(args, '--expect-unresolved')};
  if (!Object.values(values).every(value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && String(Number(value)) === value)) throw new Error('Supply --expect-portfolio and --expect-unresolved with nonnegative integer counts from your seed preview');
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Number(value)]));
}

export function validateVerificationResult(result, selection, expected) {
  if (!result?.verified || !result.database_unchanged || !result.provider_ledger_unchanged
      || result.source !== selection.source || result.backdrop !== (selection.backdrop ?? null)
      || result.timeframe !== selection.timeframe
      || result.portfolio_gifts !== expected.portfolio || result.unresolved_candidates !== expected.unresolved
      || result.gift_rows !== expected.portfolio + expected.unresolved
      || !result.authorization || Object.keys(result.authorization).length !== 4
      || !Object.values(result.authorization).every(value => value === true)
      || !Number.isSafeInteger(result.db_sequence) || !Number.isSafeInteger(result.provider_ledger_entries)) {
    throw new Error('Deployed verification did not match the expected read-only dataset');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getOption = name => option(args, name);
  const appId = requireId(getOption('--app-id'), '--app-id');
  const owner = requireId(getOption('--owner-id'), '--owner-id');
  const expected = args.includes('--diagnostic') ? null : expectedCounts(args);
  process.env.TGCLOUD_DEBUG = '0';
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  const {resolveToken} = await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token = await resolveToken();
  validateVerificationDestination(token, appId);
  const {getFiles, runFunction} = await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const deployed = await getFiles(token);
  const sources = {...deployed.canonical_modules};
  if (!['endpoints/getDashboard', 'endpoints/getJobs', 'lib/cloud-engine'].every(name => typeof sources[name] === 'string')) throw new Error('The upgraded dashboard is not deployed');
  if(args.includes('--diagnostic')) {
    if(getOption('--batch-size')!==null) {
      const batch=Number(getOption('--batch-size'));
      if(!Number.isInteger(batch)||batch<1||batch>20) throw new Error('Diagnostic batch size must be 1–20');
      sources['lib/cloud-repository']=sources['lib/cloud-repository'].replace(/ORDER BY sequence LIMIT \d+/,'ORDER BY sequence LIMIT '+batch).replace(/rows.length < \d+/,'rows.length < '+batch);
    }
    sources['endpoints/verifyDiagnostic']=args.includes('--records-only')?RECORDS_DIAGNOSTIC_SOURCE:DIAGNOSTIC_SOURCE;
    const response=await runFunction(token,'endpoints/verifyDiagnostic',sources,{source:'listings',timeframe:'30d'},{initData:{user:{id:Number(owner)}}});
    if(!response.result?.diagnostic) throw new Error('Diagnostic did not return its safe envelope');
    console.log(JSON.stringify({deployed_revision:deployed.revision,result:response.result,runtime_seconds:response.time}));
    return;
  }
  sources['endpoints/verifyDeployment'] = VERIFICATION_SOURCE;
  const context = {initData: {user: {id: Number(owner)}}};
  const chosenSource=getOption('--source'), chosenBackdrop=getOption('--backdrop');
  if(chosenSource!==null&&!['listings','rentals'].includes(chosenSource)) throw new Error('Verification source must be listings or rentals');
  if(chosenBackdrop!==null&&!['all','Black'].includes(chosenBackdrop)) throw new Error('Verification backdrop must be all or Black');
  const selections=[];
  for(const source of chosenSource?[chosenSource]:['listings','rentals']) for(const backdrop of chosenBackdrop?[chosenBackdrop==='all'?null:'Black']:[null,'Black']) selections.push({source,timeframe:'30d',...(backdrop?{backdrop}:{})});
  let initial = null;
  for (const selection of selections) {
    if(args.includes('--full-response')) {
      const response=await runFunction(token,'endpoints/getDashboard',sources,selection,context);
      const data=response.result;
      if(!Array.isArray(data?.gifts)||data.gifts.length!==expected.portfolio+expected.unresolved
        ||data.summary?.portfolio_count!==expected.portfolio||data.summary?.unresolved_count!==expected.unresolved
        ||data.pricing?.source!==selection.source||data.pricing?.backdrop!==(selection.backdrop??null)) throw new Error('Full dashboard response did not match expectations');
      console.log(JSON.stringify({verified:true,full_response:true,source:selection.source,backdrop:selection.backdrop??null,
        gift_rows:data.gifts.length,portfolio_gifts:data.summary.portfolio_count,unresolved_candidates:data.summary.unresolved_count,
        payload_bytes:Buffer.byteLength(JSON.stringify(data)),deployed_revision:deployed.revision,runtime_seconds:response.time}));
      continue;
    }
    const response = await runFunction(token, 'endpoints/verifyDeployment', sources, selection, context);
    const result = response.result;
    validateVerificationResult(result, selection, expected);
    initial ??= {sequence: result.db_sequence, attempts: result.provider_ledger_entries};
    if (result.db_sequence !== initial.sequence || result.provider_ledger_entries !== initial.attempts) throw new Error('Cloud state changed between read checks; check for concurrent collection');
    console.log(JSON.stringify({...result, deployed_revision: deployed.revision, runtime_seconds: response.time}));
  }
  console.log(JSON.stringify({complete:true,deployed_revision:deployed.revision,checks:selections.length,database_writes:0,provider_requests:0,administrative_context:true,telegram_client_handshake_checked:false}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Do not print cloud error bodies: they can contain record values or code.
    const detail=String(error?.message||'');
    const failure=/CPU timer exceeded/i.test(detail)?'runtime_cpu_limit'
      :/memory|heap|allocation/i.test(detail)?'runtime_memory_limit'
      :/Endpoint authorization verification failed/i.test(detail)?'endpoint_auth_contract'
      :/Private access denied/i.test(detail)?'owner_denied'
      :/could not be completed/i.test(detail)?'endpoint_runtime_error'
      :/snapshot|module|import|syntax/i.test(detail)?'module_runtime_error':'unknown';
    console.error(JSON.stringify({verification_failed:true,status:Number.isInteger(error?.status)?error.status:null,
      failure_type:failure,error_type:/^[a-zA-Z0-9_-]{1,80}$/.test(error?.type||'')?error.type:null,
      message:'Read-only cloud verification did not complete. No private records or credentials were logged.'}));
    process.exitCode = 1;
  });
}
