// Administrative read probes of existing accounts. No provider requests,
// enrollment, approvals or refresh jobs; ordinary dashboard caches may update.
import {fileURLToPath} from 'node:url';
import {option,requireId,validateAuthenticatedDestination,validateServerlessEnvironment} from './destination.mjs';
import {adminModuleSources} from './admin-module-sources.mjs';
const source=`import {db} from 'sdk';
import {ownerTelegramId} from '../lib/private-config.js';
import {publicReleaseConfig as config} from '../lib/public-release-config.js';
import dashboard from '../endpoints/getDashboard.js';
import analyticsStatus from '../endpoints/getMarketappAnalyticsRefreshStatus.js';
export default async function(input,ctx) {
  if(String(ctx?.initData?.user?.id)!==String(ownerTelegramId))throw Error('Private access denied');
  const privateBefore=await db.get('SELECT MAX(sequence) AS sequence FROM cloud_events');
  const users=[];
  for(const id of config.invitedUserIds.slice(0,5)) {
    const account=await db.get('SELECT generation,status FROM public_accounts WHERE user_id=:user',{':user':String(id)});
    if(account?.status==='active')users.push({id,generation:account.generation});
  }
  const denied=await dashboard({source:'listings',timeframe:'30d'},{}).then(result=>result?.error?.code==='PUBLIC_ACCESS_DENIED').catch(error=>error?.message==='Private access denied');
  const reports=await Promise.all(users.map(async user=>{
    const context={initData:{user:{id:Number(user.id)}}};
    const before=await db.get('SELECT MAX(sequence) AS sequence FROM public_cloud_events WHERE user_id=:user',{':user':String(user.id)});
    const began=Date.now(),result=await dashboard({source:'listings',timeframe:'30d'},context);
    if(!Array.isArray(result?.gifts)||!result.capabilities?.public_account||result.capabilities.account_generation!==user.generation)throw Error('Dashboard probe failed');
    const status=await analyticsStatus({account_generation:user.generation},context);
    const expected=result.capabilities.wallet_configured?!!status&&!status.error:status?.error?.code==='PUBLIC_WALLET_REQUIRED';
    if(!expected||result.capabilities.marketapp_analytics_refresh!==Boolean(result.capabilities.wallet_configured&&config.experimentalPersonalAnalytics))throw Error('Analytics probe failed');
    const after=await db.get('SELECT MAX(sequence) AS sequence FROM public_cloud_events WHERE user_id=:user',{':user':String(user.id)});
    return {dashboard:true,analytics_status:true,login_enabled:result.capabilities.marketapp_analytics_refresh,
      gift_rows:result.gifts.length,elapsed_ms:Date.now()-began,records_unchanged:before.sequence===after.sequence};
  }));
  const privateAfter=await db.get('SELECT MAX(sequence) AS sequence FROM cloud_events');
  const archive=await db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='public_gift_refresh_archive_v1'");
  return {verified:denied&&reports.length>0&&reports.every(r=>r.records_unchanged)&&privateBefore.sequence===privateAfter.sequence&&archive.count===1,
    missing_identity_denied:denied,existing_accounts_tested:reports.length,accounts:reports,private_records_unchanged:privateBefore.sequence===privateAfter.sequence,
    archive_ready:archive.count===1,registration:config.openRegistration?'open':'invitation_only',provider_requests:0,
    hosted_capacity_verified:false,telegram_client_handshake_checked:false};
}`;
try {
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2)if(!['--app-id','--owner-id'].includes(args[i]))throw Error('Invalid arguments');
  const appId=requireId(option(args,'--app-id'),'--app-id'),owner=requireId(option(args,'--owner-id'),'--owner-id');
  validateServerlessEnvironment();process.env.TGCLOUD_DEBUG='0';process.env.TG_CLOUD_API_URL='https://cloud.telegram.org';process.env.TGCLOUD_BETA='0';
  process.chdir(fileURLToPath(new URL('../',import.meta.url)));
  const {resolveToken}=await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token=await resolveToken();validateAuthenticatedDestination(token,appId);
  const {getFiles,runFunction}=await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const deployed=await getFiles(token),modules=adminModuleSources(deployed.canonical_modules,{},'endpoints/adminVerifyPublicRelease',source);
  const result=await runFunction(token,'endpoints/adminVerifyPublicRelease',modules,{}, {initData:{user:{id:Number(owner)}}});
  if(!result?.result||!Array.isArray(result.result.accounts))throw Error('Verification unavailable');
  console.log(JSON.stringify({revision:deployed.revision,...result.result}));
  if(!result.result.verified)process.exitCode=1;
}catch{console.error('Public release verification failed; no private values were logged.');process.exitCode=1;}
