import {createPrivateCredentialBox, validMarketappApiKey} from './public-credential-box.js';

const MAX=Number.MAX_SAFE_INTEGER;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export class PrivateMarketappSettingsError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new PrivateMarketappSettingsError(code);};
// The preserved private owner uses a separate encrypted credential table,
// without creating a public account or changing the private event namespace.
export function createPrivateMarketappSettings({db,repository,ownerTelegramId,masterKey,bootstrapToken,clock=()=>repository.clock()}) {
  const owner=String(ownerTelegramId),box=createPrivateCredentialBox(masterKey),rowId=`private-owner-marketapp:${owner}`;
  const validOwner=/^[1-9]\d{0,15}$/.test(owner)&&Number.isSafeInteger(Number(owner));
  const authorize=ctx=>{const id=ctx?.initData?.user?.id;if(!validOwner||!['number','string'].includes(typeof id)||String(id)!==owner)fail('PRIVATE_ACCESS_DENIED');};
  const validate=(value,keys=[])=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('PRIVATE_INVALID_INPUT');};
  async function row(){return await db.get("SELECT * FROM private_provider_credentials WHERE row_id=:id AND user_id=:owner AND provider='marketapp'",{':id':rowId,':owner':owner});}
  async function capture() {
    const saved=await row();let token='';
    if(!saved||saved.credential_version===0)token=validMarketappApiKey(bootstrapToken)?bootstrapToken:'';
    else if(saved.ciphertext)try{token=box.open(saved.ciphertext,{user_id:owner,provider:'marketapp',account_generation:0,credential_generation:saved.generation,counter:saved.credential_version});}catch{fail('PRIVATE_KEY_INVALID');}
    return {token,fingerprint:token?box.fingerprint(token):null,fence:{row_id:rowId,user_id:owner,credential_version:saved?.credential_version??0},
      source:token?(saved?.credential_version>0?'encrypted_backend':'serverless_private'):'none',updated_at:saved?.updated_at?new Date(saved.updated_at).toISOString():null};
  }
  async function assertCurrent(fence) {
    const saved=await row();if((saved?.credential_version??0)!==fence.credential_version)fail('PRIVATE_KEY_CHANGED');
  }
  function busy(job,at,version) {
    if(job&&(job.private_credential_version??0)!==version)return false;
    return job&&(['queued','running'].includes(job.state)&&(!Number.isSafeInteger(job.invocation_deadline)||job.invocation_deadline>at)
      ||Number.isSafeInteger(job.lease_until)&&job.lease_until>at);
  }
  async function status(ctx,value={}) {
    authorize(ctx);validate(value);const saved=await capture(),{state}=await repository.read(),active=busy(state.job,await clock(),saved.fence.credential_version);
    return {configured:Boolean(saved.token),source:saved.source,updated_at:saved.updated_at,persistent_storage_available:true,
      network_enabled:true,can_manage:true,restart_required:false,...(active?{reason:'active_job'}:{})};
  }
  async function invalidate({allowActive=false,reason='credential_changed'}={}) {
    for(let i=0;i<16;i++) {
      const {revision,state}=await repository.read(),at=await clock(),currentVersion=(await row())?.credential_version??0;
      if(!allowActive&&busy(state.job,at,currentVersion))fail('PRIVATE_ACCOUNT_BUSY');
      state.market_cache={};state.history_coverage={};
      const job=state.job;
      if(job&&['queued','running','partial'].includes(job.state)){job.state='failed';job.reason=reason;job.lease=null;job.lease_until=0;job.updated_at=new Date(at).toISOString();}
      state.job=null;
      if(await repository.append(revision,{key:`private-key-change:${revision+1}`,state,job,records:[],observed_at:new Date(at).toISOString()}))return revision+1;
    }fail('PRIVATE_CONFLICT');
  }
  async function reserve() {
    await db.run("INSERT OR IGNORE INTO private_provider_credentials(row_id,user_id,provider,generation,nonce_counter,credential_version) VALUES(:id,:owner,'marketapp',0,0,0)",{':id':rowId,':owner':owner});
    for(let i=0;i<16;i++) {
      const saved=await row();if(!saved||!Number.isSafeInteger(saved.nonce_counter)||saved.nonce_counter<0||saved.nonce_counter>=MAX)fail('PRIVATE_CONFLICT');
      const counter=saved.nonce_counter+1;
      const result=await db.run("UPDATE private_provider_credentials SET nonce_counter=:counter WHERE row_id=:id AND user_id=:owner AND provider='marketapp' AND nonce_counter=:previous",{':counter':counter,':previous':saved.nonce_counter,':id':rowId,':owner':owner});
      if(result.rowsAffected===1)return {...saved,counter};
    }fail('PRIVATE_CONFLICT');
  }
  async function save(ctx,value={}) {
    authorize(ctx);validate(value,['api_key']);if(!validMarketappApiKey(value.api_key))fail('PRIVATE_KEY_INVALID');
    const checkpoint=await invalidate(),reserved=await reserve(),at=await clock();
    const ciphertext=box.seal({version:1,user_id:owner,provider:'marketapp',account_generation:0,credential_generation:reserved.generation,counter:reserved.counter,api_key:value.api_key});
    const result=await db.run(`UPDATE private_provider_credentials SET credential_version=:version,ciphertext=:ciphertext,credential_fingerprint=:fingerprint,created_at=:at,updated_at=:at
      WHERE row_id=:id AND user_id=:owner AND provider='marketapp' AND credential_version=:previous AND generation=:generation AND nonce_counter>=:version
      AND COALESCE((SELECT MAX(sequence) FROM cloud_events),0)=:checkpoint`,{':version':reserved.counter,':previous':reserved.credential_version,':generation':reserved.generation,
        ':ciphertext':ciphertext,':fingerprint':box.fingerprint(value.api_key),':at':at,':id':rowId,':owner':owner,':checkpoint':checkpoint});
    if(result.rowsAffected!==1)fail('PRIVATE_CONFLICT');return await status(ctx);
  }
  async function remove(ctx,value={}) {
    authorize(ctx);validate(value);let revoked=false;
    for(let i=0;i<16;i++) {
      const reserved=await reserve(),at=await clock();
      const result=await db.run(`UPDATE private_provider_credentials SET generation=generation+1,credential_version=:version,ciphertext=NULL,credential_fingerprint=NULL,created_at=NULL,updated_at=:at
        WHERE row_id=:id AND user_id=:owner AND provider='marketapp' AND credential_version=:previous AND generation=:generation AND nonce_counter>=:version AND generation<:max`,
        {':version':reserved.counter,':previous':reserved.credential_version,':generation':reserved.generation,':at':at,':id':rowId,':owner':owner,':max':MAX});
      if(result.rowsAffected===1){revoked=true;break;}
    }
    if(!revoked)fail('PRIVATE_CONFLICT');
    // Revocation is authoritative before the larger checkpoint. Full event
    // storage or a late response cannot keep a cleared key usable. Older jobs
    // are also projected as nonresumable by their credential version fence.
    try{await invalidate({allowActive:true,reason:'credential_removed'});}catch{}
    return await status(ctx);
  }
  return {capture,assertCurrent,getMarketappSettings:status,saveMarketappApiKey:save,removeMarketappApiKey:remove};
}
