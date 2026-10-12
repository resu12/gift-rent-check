// Reproducible, owner-only deployment/reset administration. Never prints
// tokens, database documents, provider responses or individual gift records.
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';

try {
  const args=process.argv.slice(2),allowed=['--app-id','--owner-id','--action','--scope','--reset-id','--floor','--after','--generation'];
  for(let i=0;i<args.length;i+=2) if(!allowed.includes(args[i])) throw Error('Invalid compact storage arguments');
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id');
  const action=option(args,'--action'),scope=option(args,'--scope')??'private',resetId=option(args,'--reset-id');
  if(!['setup','status','reset','dispose'].includes(action)||! /^(private|public:[1-9]\d{0,15})$/.test(scope))throw Error('Invalid compact storage action');
  const integer=(name,fallback=null)=>{const value=option(args,name);if(value===null)return fallback;if(!/^(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Invalid cursor');return Number(value);};
  const input={action,scope,resetId,floor:integer('--floor'),after:integer('--after',0),generation:integer('--generation')};
  if(['reset','dispose'].includes(action)&&(!resetId||!/^dev-reset:[a-zA-Z0-9-]{16,80}$/.test(resetId)))throw Error('Supply an explicit development reset ID');
  if(action==='dispose'&&(!input.floor||scope!=='private'&&input.generation===null))throw Error('Supply the reset fence');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const deployed=await getFiles(token),modules={...deployed.canonical_modules};
  for(const filename of readdirSync(new URL('../tgcloud/lib/',import.meta.url)).filter(name=>name.endsWith('.js')))
    modules['lib/'+filename.slice(0,-3)]=readFileSync(new URL('../tgcloud/lib/'+filename,import.meta.url),'utf8');
  for(const name of ['storage-accounting','compact-operational-storage','normalized-record-storage','development-storage-reset'])
    modules['lib/admin-'+name]=readFileSync(new URL('./'+name+'.mjs',import.meta.url),'utf8')
      .replaceAll("from '../tgcloud/lib/","from './").replaceAll("from './compact-operational-storage.mjs'","from './admin-compact-operational-storage.js'");
  modules['endpoints/adminCompactStorage']=`import {db} from 'sdk';
    import {ownerTelegramId} from '../lib/private-config.js';
    import {installCompactStorageAccounting} from '../lib/admin-storage-accounting.js';
    import {installCompactOperationalStorage} from '../lib/admin-compact-operational-storage.js';
    import {upgradeNormalizedRecordStorage} from '../lib/admin-normalized-record-storage.js';
    import {beginDevelopmentStorageReset,disposeDevelopmentStorage} from '../lib/admin-development-storage-reset.js';
    export default async function(input,ctx){
      if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId))throw Error('Private access denied');
      if(input.action==='setup') return {accounting:await installCompactStorageAccounting(db),
        normalized:await upgradeNormalizedRecordStorage(db),operational:await installCompactOperationalStorage(db),provider_requests:0};
      if(input.action==='reset') return {...await beginDevelopmentStorageReset(db,input),provider_requests:0};
      if(input.action==='dispose') {
        let result,after=input.after;const start=Date.now();
        for(let i=0;i<8;i++){result=await disposeDevelopmentStorage(db,{...input,after,limit:25});after=result.after;
          if(result.complete||Date.now()-start>8000)break;}
        return {...result,provider_requests:0};
      }
      if(input.action!=='status')throw Error('Invalid action');
      const usage=await db.get('SELECT total_bytes,initialized_at FROM service_storage_usage WHERE id=1');
      const privateCounts=await db.get("SELECT count(*) AS events,SUM(length(CAST(state_json AS BLOB))) AS state_bytes,SUM(COALESCE(length(CAST(job_json AS BLOB)),0)) AS job_bytes,SUM(length(CAST(records_json AS BLOB))) AS inline_bytes FROM cloud_events");
      const normalized=await db.get("SELECT (SELECT count(*) FROM service_record_payloads) AS payloads,(SELECT count(*) FROM service_record_occurrences) AS observations");
      return {usage,private:privateCounts,normalized,provider_requests:0};
    }`;
  const result=await runFunction(token,'endpoints/adminCompactStorage',modules,input,{initData:{user:{id:Number(owner)}}});
  if(!result?.result||typeof result.result!=='object')throw Error('Administrative result missing');
  console.log(JSON.stringify(result.result));
} catch(error) {
  console.error(JSON.stringify({compact_storage_failed:true,status:Number.isInteger(error?.status)?error.status:null}));process.exitCode=1;
}
