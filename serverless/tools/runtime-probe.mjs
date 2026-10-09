// Administrative, synthetic-only cloud runtime check. No database writes,
// provider requests, private portfolio data, or deployment. Uses the official
// CLI's /run API with only the pure pricing modules and this generated probe.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {option, requireId, validateAuthenticatedDestination} from './destination.mjs';
process.env.TGCLOUD_DEBUG = '0';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
try {
  const appId = requireId(option(process.argv.slice(2), '--app-id'), '--app-id');
  const {resolveToken} = await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const {runFunction} = await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const token = await resolveToken();
  validateAuthenticatedDestination(token, appId);
  const sources = {};
  for (const name of ['cloud-pricing', 'cloud-pricing-core']) sources['lib/' + name] = await readFile(`tgcloud/lib/${name}.js`, 'utf8');
  sources['endpoints/runtimeProbe'] = `
import {buildCloudDashboard} from '../lib/cloud-pricing.js';
import {db} from 'sdk';
export default async function () {
  const before=await db.get("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms");
  const start=Date.now(), date=new Date(start-1000).toISOString(), rows=[];
  for(let i=0;i<28000;i++) {
    const nft='synthetic-'+i, collection='synthetic-collection-'+(i%46);
    const item=i<17000?{nft_address:nft,nft_name:'Synthetic gift',owner:'synthetic-owner',price_per_day:'170000000',min_duration:3600,max_duration:86400,discount_per_day:0,listed_at:null,attributes:[{trait_type:'Model',value:'Sample'},{trait_type:'Backdrop',value:'Black'}]}:{address:nft,name:'Synthetic gift',collection_address:collection,src:'synthetic-from',dst:'synthetic-to',ts:Math.floor(start/1000)-3600,price:'0.34',price_nano:'340000000',currency:'GRAM',duration:172800,is_extend:false};
    item.synthetic_padding='x'.repeat(600);
    rows.push({kind:i<17000?'listing':'history',key:'l'+i,observed_at:date,record:{identity:nft,source_json:JSON.stringify(item),params:{collection_address:collection},collection_address:collection}});
    if(i<194) rows.push({kind:'portfolio',key:'g'+i,observed_at:date,record:{id:nft,nft_address:nft,name:'Synthetic gift',collection_address:collection,is_portfolio:true,membership_sources:['synthetic_test'],uncertainties:[]}});
  }
  const dataset=JSON.parse(JSON.stringify(rows));
  const result=buildCloudDashboard(dataset,{source:'rentals',timeframe:'30d'},{now:start});
  const after=await db.get("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms");
  return {synthetic:true,records:rows.length,gifts:result.gifts.length,rental_recommendations:result.pricing.recommended_count,rental_records:result.pricing.rental_record_count,elapsed_ms:Date.now()-start,sql_elapsed_ms:after.now_ms-before.now_ms,date_minus_sql_ms:Date.now()-after.now_ms,provider_requests:0,database_writes:0};
}`;
  const response = await runFunction(token, 'endpoints/runtimeProbe', sources, {}, {});
  if (!response.result?.synthetic) throw new Error('Probe not acknowledged');
  console.log(JSON.stringify({result: response.result, runtime_seconds: response.time}));
} catch (error) {
  console.error(JSON.stringify({probe_failed: true, status: Number.isInteger(error?.status) ? error.status : null,
    message: String(error?.message || 'Cloud probe failed').replace(/app\d+:[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 500)}));
  process.exitCode = 1;
}
