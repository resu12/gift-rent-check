// Raw provider bodies are duplicate diagnostics. This admin-only tool leaves
// validated records, checkpoints, keys, cursors and security metadata intact.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {posix} from 'node:path';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';

function bounded(args,name,fallback,maximum){const value=option(args,name)??fallback;if(!/^[1-9][0-9]*$/.test(value)||Number(value)>maximum)throw Error('Invalid purge bound');return Number(value);}
function prune(all,entry){
  const selected=Object.create(null),pending=[entry];
  while(pending.length){const name=pending.pop();if(Object.hasOwn(selected,name))continue;
    if(typeof all[name]!=='string')throw Error('Missing admin dependency');selected[name]=all[name];
    for(const match of all[name].matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\sfrom\s*)?(['"])([^'"\r\n]+)\1/g)){
      const specifier=match[2];if(!specifier.startsWith('.'))continue;
      if(!specifier.startsWith('./')&&!specifier.startsWith('../')||specifier.includes('\\')||/[?#]/.test(specifier))throw Error('Invalid admin dependency');
      const target=posix.normalize(posix.join(posix.dirname(name),specifier)).replace(/\.js$/,'');
      if(target==='..'||target.startsWith('../')||posix.isAbsolute(target)||typeof all[target]!=='string')throw Error('Missing admin dependency');pending.push(target);
    }
  }return selected;
}
function aggregate(result){
  if(!result||!['check','apply'].includes(result.mode)||result.provider_requests!==0
    ||['complete','blocked','paused'].some(key=>typeof result[key]!=='boolean')
    ||['remaining_count','remaining_bytes','estimated_bytes','budget_bytes','rewritten','reclaimed_bytes','passes_completed'].some(key=>!Number.isSafeInteger(result[key])||result[key]<0)
    ||result.passes_completed>64||result.reason!==undefined&&!['legacy_migration_active','maintenance_busy','lease_lost'].includes(result.reason))throw Error('Purge result was not confirmed');
  return Object.fromEntries(['mode','complete','blocked','reason','remaining_count','remaining_bytes','estimated_bytes','budget_bytes','paused','rewritten','reclaimed_bytes','passes_completed','provider_requests']
    .filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]]));
}
try{
  const args=process.argv.slice(2);for(let i=0;i<args.length;i+=2)if(!['--app-id','--owner-id','--mode','--batches','--calls'].includes(args[i]))throw Error('Invalid purge arguments');
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id'),mode=option(args,'--mode')??'check';
  if(!['check','apply'].includes(mode))throw Error('Invalid purge mode');const batches=bounded(args,'--batches','1',64),calls=bounded(args,'--calls','1',12);
  if(mode==='check'&&(batches!==1||calls!==1))throw Error('Check accepts one read-only call');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');const canonical=(await getFiles(token)).canonical_modules;
  if(!canonical||typeof canonical['lib/private-config']!=='string'||typeof canonical['lib/storage-policy']!=='string'||typeof canonical['lib/storage-config']!=='string')throw Error('Missing canonical storage configuration');
  // Configuration and storage policy are always the authenticated deployment's
  // canonical modules. No local credentials or application modules override it.
  const all={...canonical,'lib/admin-provider-body-retention':readFileSync(new URL('./provider-body-retention.mjs',import.meta.url),'utf8')
    .replaceAll("from '../tgcloud/lib/","from './")};
  all['endpoints/purgeProviderBodies']=`import {db} from 'sdk';import {ownerTelegramId} from '../lib/private-config.js';
    import {storagePolicy} from '../lib/storage-config.js';import {createProviderBodyPurge} from '../lib/admin-provider-body-retention.js';
    export default async function(input,ctx){return createProviderBodyPurge({db,ownerTelegramId,policy:storagePolicy})(input,ctx);}`;
  const modules=prune(all,'endpoints/purgeProviderBodies');
  await new Promise(resolve=>setTimeout(resolve,3500));
  for(let call=0;call<calls;call++){
    const result=aggregate((await runFunction(token,'endpoints/purgeProviderBodies',modules,{mode,batches},{initData:{user:{id:Number(owner)}}}))?.result);
    console.log(JSON.stringify(result));if(result.complete||result.blocked||mode==='check')break;
    if(call+1<calls)await new Promise(resolve=>setTimeout(resolve,3500));
  }
}catch(error){
  // Never echo error bodies, source modules, credentials or user records, and
  // never retry a write whose outcome is uncertain (including HTTP429).
  const retry=error?.parameters?.retry_after;console.error(JSON.stringify({provider_body_purge_failed:true,status:Number.isInteger(error?.status)?error.status:null,
    ...(typeof retry==='number'&&Number.isFinite(retry)&&retry>0&&retry<=86400?{retry_after_seconds:Math.ceil(retry)}:{})}));process.exitCode=1;
}
