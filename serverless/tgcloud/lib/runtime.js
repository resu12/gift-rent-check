import {db, fetch, EndpointError} from 'sdk';
import {createEngine} from './engine.js';
import {createRepository} from './repository.js';
import {ownerTelegramId, marketappToken} from './private-config.js';
import {createCloudRepository, CloudStorageFullError} from './cloud-repository.js';
import {createCloudEngine, CloudRequestError} from './cloud-engine.js';
import {createOwnedPriceEngine, OwnedPriceRequestError, ownedPriceErrorResponse} from './owned-price-engine.js';
import {createMarketappLoginEngine, marketappLoginErrorResponse} from './marketapp-login.js';
import {marketappRefreshKey} from './private-refresh-key.js';
import {createMarketappSessionBox} from './marketapp-session-box.js';
import {createMarketappRememberedSessionBox} from './marketapp-remembered-session-box.js';
import {createMarketappAnalyticsRefreshEngine, marketappRefreshErrorResponse} from './marketapp-analytics-refresh.js';
import {createMarketappRefreshStatusEngine} from './marketapp-refresh-status.js';
import {publicReleaseConfig} from './public-release-config.js';
import {createPublicRuntime} from './public-runtime.js';
import {shouldUsePublicAccount} from './public-routing.js';
import {createPublicCredentialBox,validMarketappApiKey} from './public-credential-box.js';
import {createPublicProviderBudget} from './public-provider-budget.js';
import {createInviteProviderFetch} from './invite-provider-fetch.js';
import {createGiftRefreshEngine} from './gift-refresh-engine.js';
import {createPrivateMarketappSettings,PrivateMarketappSettingsError} from './private-marketapp-settings.js';
import {createStorageAdmission,StorageCapacityError} from './storage-admission.js';
import {createStorageMaintenance} from './storage-maintenance.js';
import {storagePolicy} from './storage-config.js';
import {cloudReadErrorResponse} from './bounded-response.js';

const storageAdmission=createStorageAdmission(db,{policy:storagePolicy});
const privateStorage=storageAdmission.forScope('private');
const storageMaintenance=createStorageMaintenance({db,ownerTelegramId,policy:storagePolicy});

let publicRuntime;
const publicApp = () => publicRuntime ??= createPublicRuntime({db,fetch,config:publicReleaseConfig,masterKey:marketappRefreshKey,
  storageAdmission,storageMaintenance,
  legacyProviderUsage: publicReleaseConfig.preservePrivateOwner === true ? legacyProviderUsage : null});
const publicAccount = ctx => shouldUsePublicAccount(publicReleaseConfig, ownerTelegramId, ctx);

const prototype = createEngine({repository: createRepository(db), fetch, ownerTelegramId, marketappToken});
const cloudRepository = createCloudRepository(db, {dashboardCache: true,storageAdmission:privateStorage});
let privateBudget, privateFetch, privateUsageReady;
const privateFingerprint = () => validMarketappApiKey(marketappToken)?createPublicCredentialBox(marketappRefreshKey).fingerprint(marketappToken):null;
const legacyProviderUsage = async () => ({userId: String(ownerTelegramId), credentialFingerprint: privateFingerprint(), state: (await cloudRepository.read()).state});
const sharedPrivateBudget = () => privateBudget ??= createPublicProviderBudget({db,masterKey:marketappRefreshKey,config:publicReleaseConfig,
  clock: () => cloudRepository.clock(),legacyProviderUsage});
const preparePrivateUsage = () => {
  if (!publicReleaseConfig.enabled || !publicReleaseConfig.preservePrivateOwner) return;
  // Seed before the private engines reserve an attempt in their own checkpoint.
  // Seeding at fetch time would count the current request twice on first use.
  return privateUsageReady ??= Promise.all(['marketapp','toncenter'].map(provider => sharedPrivateBudget().status(provider,String(ownerTelegramId),provider === 'marketapp' ? privateFingerprint() : null)))
    .catch(error => {privateUsageReady = null; throw error;});
};
const privateProviderFetch = (url, options) => {
  if (!publicReleaseConfig.enabled || !publicReleaseConfig.preservePrivateOwner) return fetch(url, options);
  privateFetch ??= createInviteProviderFetch({fetch,budget:sharedPrivateBudget(),repository:cloudRepository,userId:String(ownerTelegramId),credentialFingerprint:privateFingerprint()});
  return privateFetch(url, options);
};
const privateSettings=createPrivateMarketappSettings({db,repository:cloudRepository,ownerTelegramId,masterKey:marketappRefreshKey,bootstrapToken:marketappToken});
async function privateCloud() {
  const credential=await privateSettings.capture(),repository=createCloudRepository(db,{dashboardCache:true,credentialFence:credential.fence,storageAdmission:privateStorage});
  const providerFetch=publicReleaseConfig.enabled&&publicReleaseConfig.preservePrivateOwner
    ?createInviteProviderFetch({fetch,budget:sharedPrivateBudget(),repository,userId:String(ownerTelegramId),credentialFingerprint:credential.fingerprint,
      credentialCheck:()=>privateSettings.assertCurrent(credential.fence)})
    :async(url,options)=>{await privateSettings.assertCurrent(credential.fence);return fetch(url,options);};
  return createCloudEngine({repository,clock:()=>repository.clock(),fetch:providerFetch,ownerTelegramId,marketappToken:credential.token,ownedPriceRefresh:true,
    providerStatus:()=>publicReleaseConfig.enabled&&publicReleaseConfig.preservePrivateOwner
      ?sharedPrivateBudget().status('marketapp',String(ownerTelegramId),credential.fingerprint):null});
}
// Exported maintenance readers and callable endpoints use the same effective
// key. No warm runtime closure can silently restore the bootstrap after clear.
export const cloud=Object.fromEntries(['getDashboard','getDashboardRevision','getJobs','startJob','stepJob','stopJob','resumeJob','refreshStartupComparisons','importChunk','importPersonalAnalytics']
  .map(name=>[name,async(ctx,input)=>{if(String(ctx?.initData?.user?.id??'')!==String(ownerTelegramId))throw new CloudRequestError('Private access denied');
    const engine=await privateCloud();return engine[name](ctx,input);} ]));
export const ownedPrices = createOwnedPriceEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch: privateProviderFetch, ownerTelegramId});
export const giftRefresh = createGiftRefreshEngine({repository:cloudRepository,clock:()=>cloudRepository.clock(),fetch,tonFetch:privateProviderFetch,ownerTelegramId,
  rememberedSessionBox:createMarketappRememberedSessionBox(marketappRefreshKey)});
export const marketappLogin = createMarketappLoginEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch, ownerTelegramId});
export const marketappAnalytics = createMarketappAnalyticsRefreshEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch, ownerTelegramId,
  sessionBox: createMarketappSessionBox(marketappRefreshKey), rememberedSessionBox: createMarketappRememberedSessionBox(marketappRefreshKey)});
const marketappRefreshStatus = createMarketappRefreshStatusEngine({repository: cloudRepository, ownerTelegramId, clock: () => cloudRepository.clock(),
  sessionStatus: ctx => marketappAnalytics.getMarketappAnalyticsSessionStatus(ctx)});
// Preserve read-only access to prototype evidence. Provider collection now has
// one authoritative rate ledger; old entrypoints cannot bypass the new limits.
const upgraded = async ctx => {await prototype.getState(ctx); throw new EndpointError('The pricing dashboard replaced prototype collection. Refresh the Mini App and use its collection controls.');};
export const engine = {...prototype, startRun: upgraded, stepRun: upgraded, resumeRun: upgraded};
export async function invokeCloud(name, input, ctx) {
  if (publicAccount(ctx)) return publicApp().invokeCloud(name, input, ctx);
  try {await preparePrivateUsage(); return await cloud[name](ctx, input);}
  catch (error) {
    if(error instanceof StorageCapacityError)return {error:{code:error.code}};
    if(error instanceof PrivateMarketappSettingsError)return {error:{code:error.code}};
    if (error instanceof CloudStorageFullError) return {error: {code: 'STORAGE_FULL'}};
    if (error instanceof CloudRequestError) throw new EndpointError(error.message);
    const readFailure=cloudReadErrorResponse(name,error);if(readFailure)return readFailure;
    // Unexpected mutation errors keep their existing transport contract.
    throw new Error('The private dashboard request could not be completed.');
  }
}
export async function invokeOwnedPrice(name, input, ctx) {
  if (publicAccount(ctx)) return publicApp().invokeOwnedPrice(name, input, ctx);
  try {await preparePrivateUsage(); return await ownedPrices[name](ctx, input);}
  catch (error) {
    if(error instanceof StorageCapacityError)return {error:{code:error.code}};
    if (error instanceof CloudStorageFullError) return {error: {code: 'STORAGE_FULL'}};
    const response = ownedPriceErrorResponse(error); if (response) return response;
    if (error instanceof OwnedPriceRequestError) throw new EndpointError(error.message);
    throw new Error('The private rent-price check could not be completed.');
  }
}
export async function invokeGiftRefresh(name,input,ctx) {
  if (publicAccount(ctx)) return publicApp().invokeGiftRefresh(name,input,ctx);
  try {await preparePrivateUsage();return await giftRefresh[name](ctx,input);}
  catch(error) {
    if(error instanceof StorageCapacityError)return {error:{code:error.code}};
    if(error instanceof CloudStorageFullError)return {error:{code:'STORAGE_FULL'}};
    const response=ownedPriceErrorResponse(error);if(response)return response;
    if(error instanceof OwnedPriceRequestError)throw new EndpointError(error.message);
    throw new Error('The private gift refresh could not be completed.');
  }
}
export async function invokeMarketappLogin(name, input, ctx) {
  if (publicAccount(ctx)) return publicApp().invokeAnalytics('login', name, input, ctx);
  try {return await marketappLogin[name](ctx, input);}
  catch (error) {return error instanceof StorageCapacityError?{error:{code:error.code}}:marketappLoginErrorResponse(error);}
}
export async function invokeMarketappAnalytics(name, input, ctx) {
  if (publicAccount(ctx)) return publicApp().invokeAnalytics('analytics', name, input, ctx);
  try {return await marketappAnalytics[name](ctx, input);}
  catch (error) {return error instanceof StorageCapacityError?{error:{code:error.code}}:marketappRefreshErrorResponse(error);}
}
export async function invokeMarketappRefreshStatus(input, ctx) {
  if (publicAccount(ctx)) return publicApp().invokeAnalytics('status', '', input, ctx);
  try {return await marketappRefreshStatus.getMarketappAnalyticsRefreshStatus(ctx, input);}
  catch (error) {return marketappRefreshErrorResponse(error);}
}

export async function invokePublicAccount(name, input, ctx) {
  if(!publicAccount(ctx)&&['saveMarketappApiKey','removeMarketappApiKey'].includes(name))return invokeMarketappSettings(name,input,ctx);
  if (!publicReleaseConfig.enabled) return {error:{code:'PUBLIC_MODE_DISABLED'}};
  if (!publicAccount(ctx)) return {error:{code:'PUBLIC_ACCESS_DENIED'}};
  return publicApp().invokeAccount(name, input, ctx);
}
export async function invokeMarketappSettings(name,input={},ctx) {
  if(publicAccount(ctx))return {error:{code:'PUBLIC_ACCESS_DENIED'}};
  try {
    if(!['getMarketappSettings','saveMarketappApiKey','removeMarketappApiKey'].includes(name))return {error:{code:'PRIVATE_INVALID_INPUT'}};
    return await privateSettings[name](ctx,input);
  } catch(error) {
    if(error instanceof PrivateMarketappSettingsError)return {error:{code:error.code}};
    if(error instanceof CloudStorageFullError)return {error:{code:'STORAGE_FULL'}};
    return {error:{code:'PRIVATE_SETTINGS_FAILED'}};
  }
}
export async function invokePublicWallet(name, input, ctx) {
  if (!publicReleaseConfig.enabled) return {error:{code:'PUBLIC_MODE_DISABLED'}};
  if (!publicAccount(ctx)) return {error:{code:'PUBLIC_ACCESS_DENIED'}};
  return publicApp().invokeWallet(name, input, ctx);
}

export async function invokeStorage(name,input={},ctx) {
  if(publicAccount(ctx))return publicApp().invokeStorage(name,input,ctx);
  if(String(ctx?.initData?.user?.id??'')!==String(ownerTelegramId))return {error:{code:'PUBLIC_ACCESS_DENIED'}};
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['manual','progress','growth'].includes(key))
      ||Object.hasOwn(input,'manual')&&(name!=='step'||typeof input.manual!=='boolean')
      ||Object.hasOwn(input,'progress')&&typeof input.progress!=='boolean'
      ||Object.hasOwn(input,'growth')&&typeof input.growth!=='boolean'||!['status','step'].includes(name))return {error:{code:'PUBLIC_INVALID_INPUT'}};
  try {
    const caller={userId:String(ownerTelegramId),isOwner:true,progress:input.progress===true,growth:input.growth===true};
    return name==='status'?await storageMaintenance.status(caller):await storageMaintenance.step({...caller,manual:input.manual===true});
  }catch{return {error:{code:'STORAGE_MAINTENANCE_FAILED'}};}
}
