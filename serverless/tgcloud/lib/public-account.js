import {validMarketappApiKey} from './public-credential-box.js';
import {fetchBoundedResponse} from './bounded-response.js';
import {parseCloudPage} from './cloud-engine.js';
export class PublicRequestError extends Error {constructor(code) {super(code);this.code=code;}}
const error=code=>{throw new PublicRequestError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function input(value,keys=[]) {if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))error('PUBLIC_INVALID_INPUT');}
const active=(value,at)=>value&&(['queued','running','pending'].includes(value.state)||Number.isSafeInteger(value.lease_until)&&value.lease_until>at);
export function openPublicMarketappKey(box,row,userId,generation) {
  if(!row?.ciphertext)return '';
  return box.open(row.ciphertext,{user_id:userId,provider:'marketapp',account_generation:generation,credential_generation:row.generation,counter:row.credential_version});
}
export function createPublicAccountEngine({repository,box,fetch:providerFetch,clock=()=>repository.clock()}) {
  async function status() {
    let account=await repository.publicAccount();
    if(!account) {await repository.ensureAccount();account=await repository.publicAccount();}
    if(account.status!=='active')return {public_mode:true,deleted:true,pending_cleanup:account.status==='deleting',wallet:null,marketapp_key:{configured:false,updated_at:null},onboarding_complete:false};
    const key=await repository.credentialStatus('marketapp'),verified=Boolean(account.wallet&&account.wallet_verified_at);
    return {public_mode:true,wallet:verified?{address:account.wallet,verified_at:new Date(account.wallet_verified_at).toISOString()}:null,
      marketapp_key:{configured:Boolean(key?.ciphertext),updated_at:key?.updated_at?new Date(key.updated_at).toISOString():null},onboarding_complete:verified&&Boolean(key?.ciphertext)};
  }
  async function available() {const row=await repository.publicAccount();if(row&&row.status!=='active')error('PUBLIC_ACCOUNT_DELETED');await repository.ensureAccount();return await repository.accountGeneration();}
  async function idle() {const {state}=await repository.read(),at=await clock();if(active(state.job,at)||active(state.owned_prices?.run,at))error('PUBLIC_ACCOUNT_BUSY');return state;}
  async function clearComparisons() {
    for(let i=0;i<16;i++) {
      const {revision,state}=await repository.read(),at=await clock();if(active(state.job,at)||active(state.owned_prices?.run,at))error('PUBLIC_ACCOUNT_BUSY');
      state.market_cache={};state.history_coverage={};
      if(state.job&&state.job.state==='partial'){state.job.state='failed';state.job.reason='credential_changed';state.job.lease=null;state.job.lease_until=0;}
      const job=state.job??null;state.job=null;
      if(await repository.append(revision,{key:`public-key-change:${revision+1}`,state,job,records:[],observed_at:new Date(await clock()).toISOString()}))return revision+1;
    }error('PUBLIC_CONFLICT');
  }
  return {
    async getPublicAccount(_ctx,value={}) {input(value);if((await repository.publicAccount())?.status==='deleting')await repository.processAccountDeletion(100);return {account:await status()};},
    async saveMarketappApiKey(_ctx,value={}) {
      input(value,['api_key']);if(!validMarketappApiKey(value.api_key))error('PUBLIC_KEY_INVALID');
      const generation=await available();await idle();
      // Invalidate reusable comparison coverage before a credential is changed.
      const checkpoint=await clearComparisons();
      const reserved=await repository.reserveCredentialNonce('marketapp',generation);if(!reserved)error('PUBLIC_CONFLICT');
      const at=await clock(),ciphertext=box.seal({version:1,user_id:repository.userId,provider:'marketapp',account_generation:generation,
        credential_generation:reserved.generation,counter:reserved.counter,api_key:value.api_key});
      const saved=await repository.storeCredentialCAS('marketapp',generation,reserved.credential_version,{credential_version:reserved.counter,ciphertext,
        credential_fingerprint:box.fingerprint(value.api_key),created_at:at,updated_at:at},checkpoint);
      if(!saved)error('PUBLIC_CONFLICT');return {account:await status()};
    },
    async removeMarketappApiKey(_ctx,value={}) {
      input(value);const generation=await available();let revoked=false;
      // Revocation must not depend on stopping a worker or reserving payload
      // space. The credential fence rejects its next request and late commit.
      for(let i=0;i<16;i++) {const {revision}=await repository.read();if(await repository.clearCredential('marketapp',generation,revision)){revoked=true;break;}}
      if(!revoked)error('PUBLIC_CONFLICT');
      for(let i=0;i<16;i++) {
        const {revision,state}=await repository.read();
        if(!state.job||!['queued','running','partial'].includes(state.job.state))break;
        state.job.state='failed';state.job.reason='credential_removed';state.job.updated_at=new Date(await clock()).toISOString();state.job.lease=null;state.job.lease_until=0;
        // The repository admits only this bounded control-only checkpoint to
        // its recovery reserve, preserving all collected raw/record evidence.
        if(await repository.append(revision,{key:`public-key-remove:${revision+1}`,state,job:state.job,records:[],observed_at:state.job.updated_at}))break;
        if(i===15)error('PUBLIC_CONFLICT');
      }
      return {account:await status()};
    },
    async testMarketappApiKey(_ctx,value={}) {
      input(value);const generation=await available();await idle();const row=await repository.credentialStatus('marketapp');
      if(!row?.ciphertext)error('PUBLIC_KEY_REQUIRED');let token;try{token=openPublicMarketappKey(box,row,repository.userId,generation);}catch{error('PUBLIC_KEY_INVALID');}
      repository.setCredentialFence({provider:'marketapp',credential_version:row.credential_version,fingerprint:row.credential_fingerprint});
      const at=await clock();
      for(let i=0;i<16;i++) {
        const {revision,state}=await repository.read();if(Number.isSafeInteger(state.public_key_test_at)&&state.public_key_test_at>at-60000)error('PUBLIC_PROVIDER_WAIT');
        state.public_key_test_at=at;
        if(await repository.append(revision,{key:`public-key-test:${revision+1}`,state,job:null,records:[],observed_at:new Date(at).toISOString()}))break;
        if(i===15)error('PUBLIC_CONFLICT');
      }
      let result='unavailable';
      try {
        const {response,body}=await fetchBoundedResponse(providerFetch,'https://api.marketapp.org/v1/collections/gifts/',{method:'GET',headers:{Authorization:token,Accept:'application/json'},redirect:'error'},
          {maxBytes:1048576,timeoutMs:30000,deadlineAt:at+30000,clock});
        if([401,403].includes(response.status))result='invalid';
        else if(response.status===200&&!response.redirected){parseCloudPage('collection',body,null,new Date(await clock()).toISOString(),'public-key-test');result='valid';}
      }catch(cause){if(cause?.code==='PUBLIC_PROVIDER_WAIT')throw cause;}
      return {account:await status(),status:result,checked_at:new Date(await clock()).toISOString()};
    },
    async disconnectPublicWallet(_ctx,value={}) {input(value);await available();await idle();await repository.disconnectWallet();return {account:await status()};},
    async deletePublicAccount(_ctx,value={}) {input(value,['confirm']);if(value.confirm!==true)error('PUBLIC_INVALID_INPUT');await repository.deleteAccountData(100);return {account:await status()};},
    async reactivatePublicAccount(_ctx,value={}) {input(value,['confirm']);if(value.confirm!==true)error('PUBLIC_INVALID_INPUT');await repository.reactivateAccount();return {account:await status()};},
  };
}
