// Explicit owner-only backup; never deploys, restores or mutates the live DB.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {adminModuleSources} from './admin-module-sources.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';
import {encryptBackup,verifyBackupRecovery} from './backup-recovery.mjs';

let stage='arguments';
async function main() {
  const args=process.argv.slice(2),allowed=['--action','--app-id','--owner-id','--key-file','--archive'];
  for(let i=0;i<args.length;i+=2) if(!allowed.includes(args[i]))throw Error('Invalid backup argument');
  const action=option(args,'--action'),keyPath=option(args,'--key-file'),archivePath=option(args,'--archive');
  if(!['keygen','export','verify'].includes(action)||!keyPath?.endsWith('.grc-backup.key'))throw Error('Supply a backup action and .grc-backup.key path');
  if(action==='keygen') {
    mkdirSync(dirname(resolve(keyPath)),{recursive:true});writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({backup_key_created:true,keep_separate_from_archive:true}));return;
  }
  if(!archivePath?.endsWith('.grc-backup.enc'))throw Error('Supply an encrypted .grc-backup.enc archive path');
  stage='key_read';const key=readFileSync(keyPath),appId=requireId(option(args,'--app-id'),'--app-id');
  if(action==='verify') {
    stage='local_verification';console.log(JSON.stringify(await verifyBackupRecovery(readFileSync(archivePath),key,{expectedAppId:appId})));return;
  }
  const owner=requireId(option(args,'--owner-id'),'--owner-id');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  stage='credentials';const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  stage='deployment_read';const deployed=await getFiles(token);
  const overrides={'lib/admin-database-snapshot':readFileSync(new URL('./database-snapshot.mjs',import.meta.url),'utf8')};
  const endpoint=`import {db} from 'sdk';
    import {ownerTelegramId} from '../lib/private-config.js';
    import {captureDatabaseSnapshot} from '../lib/admin-database-snapshot.js';
    export default async function(input,ctx){
      if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId))throw Error('Private access denied');
      try{return {snapshot:await captureDatabaseSnapshot(db)};}
      catch(error){const text=String(error?.message||'');
        const detail=['column','depth','compound','argument','length','size','complex','subquer','function','row','byte','step','budget','response','output','time','resource','result','instruction','memory','maximum','expression'].find(word=>text.toLowerCase().includes(word));
        const category=/SQLITE_QUERY_LIMIT|query.limit|too (?:many|large)|limit exceeded/i.test(text)?'query_limit'+(detail?'_'+detail:''):/syntax/i.test(text)?'syntax':/not authorized|permission/i.test(text)?'permission':/no such/i.test(text)?'unsupported_sql':/bounded export size/i.test(text)?'size':'unknown';
        return {snapshot_error_stage:['catalog','columns','size_precheck','capture','size','schema'].includes(error.snapshot_stage)?error.snapshot_stage:'unknown',snapshot_error_category:category};}
    }`;
  const modules=adminModuleSources(deployed.canonical_modules,overrides,'endpoints/adminBackupSnapshot',endpoint);
  stage='remote_snapshot';const result=await runFunction(token,'endpoints/adminBackupSnapshot',modules,{}, {initData:{user:{id:Number(owner)}}});
  if(result?.result?.snapshot_error_stage){stage='snapshot_'+result.result.snapshot_error_stage+'_'+result.result.snapshot_error_category;throw Error('Snapshot unavailable');}
  if(!result?.result?.snapshot)throw Error('Snapshot response unavailable');
  stage='archive_encryption';const {bytes,manifest}=encryptBackup(result.result.snapshot,key,{appId,revision:deployed.revision??null});
  stage='local_verification';const verification=await verifyBackupRecovery(bytes,key,{expectedAppId:appId});
  stage='archive_write';
  mkdirSync(dirname(archivePath),{recursive:true});
  writeFileSync(archivePath,bytes,{flag:'wx',mode:0o600});
  writeFileSync(archivePath.replace(/\.enc$/,'.manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({...verification,encrypted_archive_saved:true,archive_bytes:bytes.length,provider_requests:0}));
}
// Resolve paths before changing into the serverless CLI project directory.
for(const flag of ['--key-file','--archive']){const index=process.argv.indexOf(flag);if(index>=0&&process.argv[index+1])process.argv[index+1]=resolve(process.argv[index+1]);}
main().catch(error=>{console.error(JSON.stringify({backup_failed:true,stage,status:Number.isInteger(error?.status)?error.status:null,live_database_modified:false}));process.exitCode=1;});
