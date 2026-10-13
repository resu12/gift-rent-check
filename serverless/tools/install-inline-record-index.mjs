// Guarded, owner-only, bounded administration. This command never publishes
// modules or calls Marketapp/TON, and prints no source records or credentials.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';
import {inlineRecordAdminSources,inlineRecordAdminRepositorySource} from './inline-record-index-sources.mjs';

try {
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2)if(!['--app-id','--owner-id','--cursor'].includes(args[i]))throw new Error('Invalid index setup arguments');
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id'),encoded=option(args,'--cursor');
  let cursor={phase:'private',after:null};
  if(encoded!==null) {
    if(encoded.length>2048||!/^[-_A-Za-z0-9]+$/.test(encoded))throw new Error('Invalid index setup cursor');
    cursor=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if(!cursor||Object.keys(cursor).sort().join(',')!=='after,phase'||!['private','public'].includes(cursor.phase)
      ||cursor.after!==null&&(cursor.phase==='private'?(!Number.isSafeInteger(cursor.after)||cursor.after<0):typeof cursor.after!=='string'||cursor.after.length>1024))throw new Error('Invalid index setup cursor');
  }
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const files=await getFiles(token),overrides={};
  overrides['lib/cloud-repository']=inlineRecordAdminRepositorySource();
  for(const name of ['storage-policy','budget-reset-checkpoint-storage'])overrides['lib/'+name]=readFileSync(new URL('../tgcloud/lib/'+name+'.js',import.meta.url),'utf8');
  overrides['lib/storage-accounting']=readFileSync(new URL('./storage-accounting.mjs',import.meta.url),'utf8').replaceAll("from '../tgcloud/lib/","from './");
  overrides['lib/inline-record-index']=readFileSync(new URL('./inline-record-index.mjs',import.meta.url),'utf8')
    .replaceAll("from '../tgcloud/lib/","from './").replace("from './storage-accounting.mjs'","from './storage-accounting.js'");
  const endpoint=`import {db} from 'sdk';import {ownerTelegramId} from '../lib/private-config.js';
    import {installInlineRecordIndexBatch} from '../lib/inline-record-index.js';
    export default async function(input,ctx){if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId))throw Error('Private access denied');
      if(!input||Object.keys(input).some(key=>!['phase','after'].includes(key)))throw Error('Invalid index setup input');
      return await installInlineRecordIndexBatch(db,{phase:input.phase,after:input.after,limit:25,maxPasses:8,budgetMs:4500});}`;
  const sources=inlineRecordAdminSources(files.canonical_modules,overrides,endpoint);
  let result,checked=0;
  // One command makes at most eight hosted batches, each with at most eight
  // existing bounded SQL passes. An uncertain write is not retried
  // automatically; restart with the last printed cursor.
  for(let pass=0;pass<8;pass++) {
    const response=await runFunction(token,'endpoints/installInlineRecordIndex',sources,cursor,{initData:{user:{id:Number(owner)}}});
    result=response?.result;
    if(!result||typeof result.complete!=='boolean'||!['private','public','complete'].includes(result.phase))throw new Error('Index setup not confirmed');
    checked+=result.events_checked??0;
    if(result.complete)break;
    cursor={phase:result.phase,after:result.after};
  }
  console.log(JSON.stringify({complete:result.complete,events_checked:checked,provider_requests:0,
    cursor:result.complete?null:Buffer.from(JSON.stringify(cursor)).toString('base64url'),
    ...(result.complete?{definitions:result.definitions}:{phase:result.phase})}));
}catch(error){console.error(JSON.stringify({inline_index_setup_failed:true,status:Number.isInteger(error?.status)?error.status:null}));process.exitCode=1;}
