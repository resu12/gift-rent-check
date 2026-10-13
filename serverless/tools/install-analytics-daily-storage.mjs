import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';
import {adminModuleSources} from './admin-module-sources.mjs';

try {
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2)if(!['--app-id','--owner-id','--action','--scope','--after'].includes(args[i]))throw Error('Invalid setup arguments');
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id');
  const action=option(args,'--action'),scope=option(args,'--scope')??'private',after=option(args,'--after')??'';
  if(!['install','backfill'].includes(action)||!['private','public'].includes(scope)||after.length>1024)throw Error('Invalid setup arguments');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const files=await getFiles(token),overrides={};
  for(const name of ['storage-policy','personal-analytics'])overrides['lib/'+name]=readFileSync(new URL('../tgcloud/lib/'+name+'.js',import.meta.url),'utf8');
  overrides['lib/storage-accounting']=readFileSync(new URL('./storage-accounting.mjs',import.meta.url),'utf8').replaceAll("from '../tgcloud/lib/","from './");
  overrides['lib/analytics-daily-storage']=readFileSync(new URL('./analytics-daily-storage.mjs',import.meta.url),'utf8')
    .replaceAll("from '../tgcloud/lib/","from './").replace("from './storage-accounting.mjs'","from './storage-accounting.js'");
  const endpoint=`import {db} from 'sdk';import {ownerTelegramId} from '../lib/private-config.js';
    import {installPersonalAnalyticsDailyStorage,backfillPersonalAnalyticsDailyStorage} from '../lib/analytics-daily-storage.js';
    export default async function(input,ctx){if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId))throw Error('Private access denied');
      if(!input||Object.keys(input).some(key=>!['action','publicScope','after'].includes(key))||!['install','backfill'].includes(input.action))throw Error('Invalid setup input');
      return input.action==='install'?await installPersonalAnalyticsDailyStorage(db):await backfillPersonalAnalyticsDailyStorage(db,{publicScope:input.publicScope,after:input.after,limit:1});}`;
  const sources=adminModuleSources(files.canonical_modules,overrides,'endpoints/installAnalyticsDailyStorage',endpoint);
  let cursor=after,processed=0,result;
  // Each hosted transaction handles at most one source snapshot. The CLI can
  // resume safely; rows and source snapshots are never deleted or rewritten.
  for(let pass=0;pass<(action==='install'?1:25);pass++) {
    const response=await runFunction(token,'endpoints/installAnalyticsDailyStorage',sources,{action,publicScope:scope==='public',after:cursor},{initData:{user:{id:Number(owner)}}});
    result=response?.result;
    if(action==='install') {if(result?.ready!==true)throw Error('Setup not confirmed');break;}
    if(typeof result?.complete!=='boolean'||typeof result.after!=='string'||!Number.isSafeInteger(result.processed))throw Error('Backfill not confirmed');
    cursor=result.after;processed+=result.processed;if(result.complete)break;
  }
  console.log(JSON.stringify({...result,...(action==='backfill'?{processed,after:cursor}:{}),scope,provider_requests:0}));
}catch(error){console.error(JSON.stringify({analytics_setup_failed:true,status:Number.isInteger(error?.status)?error.status:null}));process.exitCode=1;}
