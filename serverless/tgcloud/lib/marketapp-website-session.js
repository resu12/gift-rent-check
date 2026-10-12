import {configuredAnalyticsWallet} from './personal-analytics.js';
export const MARKETAPP_REMEMBERED_SESSION_MAX_MS=7*86400000;
export class MarketappWebsiteSessionError extends Error {
  constructor(code='MARKETAPP_WEBSITE_SESSION_EXPIRED',retry=null){super('The saved Marketapp login is unavailable.');this.code=code;this.retry=retry;}
}
const fail=code=>{throw new MarketappWebsiteSessionError(code);};
export function createMarketappWebsiteSession({repository,rememberedSessionBox,ownerTelegramId,clock=()=>repository.clock()}) {
  const authorize=value=>{const owner=String(typeof value==='object'?value?.initData?.user?.id:value??'');if(!/^[1-9]\d{0,19}$/.test(owner)||ownerTelegramId!==undefined&&owner!==String(ownerTelegramId))fail('MARKETAPP_WEBSITE_PRIVATE_ACCESS_DENIED');return owner;};
  async function now(){const at=await clock();if(!Number.isSafeInteger(at)||at<=0||at>8640000000000000-MARKETAPP_REMEMBERED_SESSION_MAX_MS)fail();return at;}
  async function wallet(){const records=await(typeof repository.analyticsWalletRecords==='function'?repository.analyticsWalletRecords():repository.records());return configuredAnalyticsWallet(records);}
  async function fence(owner){const value=await repository.marketappSessionFence(owner);if(!value||!['generation','wallet_revision','cookie_version'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0))fail();return value;}
  async function current(value,expectedWallet,stored){const owner=authorize(value);if(stored.value&&stored.value.expires_at<=await now()||await wallet()!==expectedWallet||!await repository.marketappSessionIsCurrent(owner,stored.fence??stored,stored.value?.cookie_version??null))fail();return true;}
  async function invalidate(value,stored=null){const owner=authorize(value);return await repository.clearMarketappSession(owner,stored?.fence??null,stored?.value?.cookie_version??null);}
  async function read(value,expectedWallet){
    const owner=authorize(value),row=await repository.marketappSession(owner);if(!row?.ciphertext)return null;
    const sessionFence=await fence(owner),at=await now();
    const discard=async()=>{await repository.clearMarketappSession(owner,{generation:row.generation},row.cookie_version);return null;};
    if(await wallet()!==expectedWallet||row.wallet!==expectedWallet||row.wallet_revision!==sessionFence.wallet_revision||row.generation!==sessionFence.generation||!Number.isSafeInteger(row.created_at)||!Number.isSafeInteger(row.expires_at)||row.created_at>at||row.expires_at<=at||row.expires_at-row.created_at>MARKETAPP_REMEMBERED_SESSION_MAX_MS||row.expires_at<=row.created_at)return discard();
    let payload;try{payload=rememberedSessionBox.open(row.ciphertext);}catch{return discard();}
    if(payload.owner!==owner||payload.wallet!==expectedWallet||['generation','wallet_revision','cookie_version','created_at','expires_at'].some(key=>payload[key]!==row[key]))return discard();
    if(!await repository.marketappSessionIsCurrent(owner,sessionFence,row.cookie_version))return null;
    return {value:payload,fence:sessionFence};
  }
  async function remember(value,expectedWallet,sessionFence,cookie,created,expires,expectedVersion){
    const owner=authorize(value);await current(owner,expectedWallet,{...sessionFence});
    const at=await now();if(!Number.isSafeInteger(created)||created>at||!Number.isSafeInteger(expires)||expires<=at||expires<=created||expires-created>MARKETAPP_REMEMBERED_SESSION_MAX_MS)fail();
    const version=await repository.reserveMarketappSessionNonce(owner,sessionFence.generation);if(!Number.isSafeInteger(version)||version<1||!rememberedSessionBox)fail();
    const payload={version:1,owner,wallet:expectedWallet,generation:sessionFence.generation,wallet_revision:sessionFence.wallet_revision,cookie_version:version,created_at:created,expires_at:expires,cookie};
    const ciphertext=rememberedSessionBox.seal(payload,version);
    if(!await repository.storeMarketappSession(owner,sessionFence,{wallet:expectedWallet,cookie_version:version,ciphertext,created_at:created,expires_at:expires},expectedVersion))fail();return version;
  }
  async function rotate(value,expectedWallet,stored,metadata){
    const owner=authorize(value);await current(owner,expectedWallet,stored);if(!metadata)return stored;
    if(metadata.deleted||!metadata.cookie){await invalidate(owner,stored);fail('MARKETAPP_WEBSITE_RECONNECT_REQUIRED');}
    const expires=Math.min(stored.value.expires_at,metadata.expires_at??stored.value.expires_at);
    const version=await remember(owner,expectedWallet,stored.fence,metadata.cookie,stored.value.created_at,expires,stored.value.cookie_version);
    return {fence:{...stored.fence,cookie_version:version},value:{...stored.value,cookie:metadata.cookie,expires_at:expires,cookie_version:version}};
  }
  async function acquire(value,id,{durationMs=150000}={}){const owner=authorize(value);return await repository.acquireMarketappWebsiteLease(owner,id,await now(),durationMs);}
  async function release(value,lease){const owner=authorize(value);return await repository.releaseMarketappWebsiteLease(owner,lease);}
  async function reserve(value,lease,id,options={}){const owner=authorize(value);return await repository.reserveMarketappWebsiteRequest(owner,lease,id,await now(),options);}
  async function defer(value,lease,until){const owner=authorize(value);return await repository.deferMarketappWebsiteRequests(owner,lease,until,await now());}
  return {read,current,remember,rotate,invalidate,acquire,release,reserve,defer};
}
