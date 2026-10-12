// Additive owner-only setup; no source records, secrets or request allowances
// are removed. Keep each invocation bounded and continue using the printed cursor.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';
import {STORAGE_TABLES} from '../tgcloud/lib/storage-policy.js';

try {
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2)if(!['--app-id','--owner-id','--after','--source-index'].includes(args[i]))throw new Error('Invalid setup arguments');
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id');
  const cursor=option(args,'--after')??'0';if(!/^(0|[1-9][0-9]{0,2})$/.test(cursor)||Number(cursor)>STORAGE_TABLES.length*3)throw new Error('Invalid setup cursor');
  const sourceIndex=option(args,'--source-index');if(sourceIndex!==null&&sourceIndex!=='true')throw new Error('Invalid source index setup');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const files=await getFiles(token),sources={...files.canonical_modules};
  sources['lib/storage-policy']=readFileSync(new URL('../tgcloud/lib/storage-policy.js',import.meta.url),'utf8');
  sources['lib/checkpoint-storage']=readFileSync(new URL('../tgcloud/lib/checkpoint-storage.js',import.meta.url),'utf8');
  sources['lib/budget-reset-checkpoint-storage']=readFileSync(new URL('../tgcloud/lib/budget-reset-checkpoint-storage.js',import.meta.url),'utf8');
  // Setup code is owner-only CLI material, not a permanent app module. Keep
  // the runtime within Telegram's 100-module limit while retaining reproducible setup.
  sources['lib/storage-accounting']=readFileSync(new URL('./storage-accounting.mjs',import.meta.url),'utf8')
    .replaceAll("from '../tgcloud/lib/","from './");
  sources['endpoints/installStorageAccounting']=`import {db} from 'sdk';import {ownerTelegramId} from '../lib/private-config.js';
    import {installStorageAccounting,installCheckpointSourceAccounting} from '../lib/storage-accounting.js';
    export default async function(input,ctx){if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId))throw Error('Private access denied');
      if(!input||Object.keys(input).some(key=>!['after','source_index'].includes(key))||typeof input.source_index!=='boolean')throw Error('Invalid setup input');
      if(input.source_index)await installCheckpointSourceAccounting(db);
      return {...await installStorageAccounting(db,{after:input.after,limit:6}),provider_requests:0};}`;
  const response=await runFunction(token,'endpoints/installStorageAccounting',sources,{after:Number(cursor),source_index:sourceIndex==='true'},{initData:{user:{id:Number(owner)}}});
  const result=response?.result;
  if(!result||typeof result.complete!=='boolean'||!Number.isSafeInteger(result.after))throw new Error('Accounting setup was not confirmed');
  console.log(JSON.stringify(result));
}catch(error) {
  console.error(JSON.stringify({accounting_setup_failed:true,status:Number.isInteger(error?.status)?error.status:null}));process.exitCode=1;
}
