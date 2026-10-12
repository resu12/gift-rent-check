// Explicit administrative migration; never called during public onboarding.
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';
import {fileURLToPath} from 'node:url';

const endpoint=`
import {db} from 'sdk';
import {ownerTelegramId} from '../lib/private-config.js';
import {publicReleaseConfig} from '../lib/public-release-config.js';
import {migrateLegacyOwner} from '../lib/public-repository.js';
export default async function(input,ctx) {
  if(publicReleaseConfig.enabled!==false) throw Error('Private-owner migration requires public mode disabled.');
  const owner=String(ownerTelegramId);
  if(String(ctx?.initData?.user?.id)!==owner || String(input?.owner_id)!==owner) throw Error('Private access denied');
  if(!input || Object.keys(input).some(key=>!['mode','owner_id','limit','confirm_owner_id'].includes(key))) throw Error('Invalid migration input');
  return await migrateLegacyOwner(db,owner,{mode:input.mode,limit:input.limit,confirmOwnerId:input.confirm_owner_id});
}`;
async function main() {
  const args=process.argv.slice(2),allowed=['--app-id','--owner-id','--mode','--limit','--confirm-legacy-owner'];
  if(args.length%2)throw Error('Use explicit app, owner, mode and optional bounded limit.');
  const names=new Set();for(let i=0;i<args.length;i+=2){if(!allowed.includes(args[i])||names.has(args[i]))throw Error('Use explicit app, owner, mode and optional bounded limit.');names.add(args[i]);}
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id');
  const mode=option(args,'--mode')??'check',limit=Number(option(args,'--limit')??25),confirmation=option(args,'--confirm-legacy-owner');
  if(!['check','apply','clear'].includes(mode)||!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error('Choose check, apply or clear and a limit from 1 to 25.');
  if(mode==='apply'&&String(confirmation)!==String(owner))throw Error('Apply requires --confirm-legacy-owner matching --owner-id; stop private writes first.');
  if(mode==='clear'&&String(confirmation)!==String(owner))throw Error('Clear requires --confirm-legacy-owner matching --owner-id; only a partial migration can be cleared.');
  if(mode==='check'&&confirmation!==null)throw Error('Check mode does not use migration confirmation.');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {publicReleaseConfig}=await import('../tgcloud/lib/public-release-config.js');
  if(publicReleaseConfig.enabled!==false)throw Error('Private-owner migration requires public mode disabled.');
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const deployed=await getFiles(token);
  if(!deployed.canonical_modules?.['lib/public-repository']?.includes('migrateLegacyOwner'))throw Error('Publish the additive public schema and migration reader first.');
  const result=(await runFunction(token,'endpoints/migratePublicOwner',{...deployed.canonical_modules,'endpoints/migratePublicOwner':endpoint},
    {mode,owner_id:String(owner),limit,confirm_owner_id:confirmation},{initData:{user:{id:Number(owner)}}}))?.result;
  if(!result||result.mode!==mode||result.provider_requests!==0||!['not_started','copying','complete','clearing'].includes(result.status))throw Error('Migration did not return verified aggregate counts.');
  const display={mode,status:result.status};
  for(const key of ['boundary','sequence','source_events','copied_events','source_analytics','copied_analytics','source_attempts','copied_attempts']) {
    if(!Number.isSafeInteger(result[key])||result[key]<0)throw Error('Migration did not return verified aggregate counts.');display[key]=result[key];
  }
  if(Object.hasOwn(result,'pending_cleanup')) {
    if(typeof result.pending_cleanup!=='boolean')throw Error('Migration did not return verified aggregate counts.');display.pending_cleanup=result.pending_cleanup;
  }
  display.provider_requests=0;console.log(JSON.stringify(display));
}
main().catch(error=>{
  const safe=['Use explicit app, owner, mode and optional bounded limit.','Choose check, apply or clear and a limit from 1 to 25.',
    'Apply requires --confirm-legacy-owner matching --owner-id; stop private writes first.','Check mode does not use migration confirmation.',
    'Clear requires --confirm-legacy-owner matching --owner-id; only a partial migration can be cleared.','Private-owner migration requires public mode disabled.',
    'Supply --app-id with a positive numeric Telegram ID','Supply --owner-id with a positive numeric Telegram ID',
    'Administrative tools require the official Telegram cloud API','Administrative tools require the production Telegram app',
    'The CLI credentials do not match the explicit Telegram app ID','Publish the additive public schema and migration reader first.'];
  console.error(safe.includes(error?.message)?error.message:'Public-owner migration stopped; no private records or credentials were logged.');process.exitCode=1;
});
