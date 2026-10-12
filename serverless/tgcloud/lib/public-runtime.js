import {createPublicRepository,verifiedTelegramUserId,PublicAccountError,PublicCredentialChangedError} from './public-repository.js';
import {createPublicCredentialBox,hex,hmacSha256,keyBytes} from './public-credential-box.js';
import {utf8Bytes} from './personal-analytics.js';
import {createPublicProviderBudget,createPublicProviderFetch} from './public-provider-budget.js';
import {createPublicAccountEngine,openPublicMarketappKey,PublicRequestError} from './public-account.js';
import {createPublicWalletEngine} from './public-wallet.js';
import {createPublicDiscoveryEngine} from './public-discovery.js';
import {createCloudEngine,CloudRequestError} from './cloud-engine.js';
import {CloudStorageFullError} from './cloud-repository.js';
import {createOwnedPriceEngine,ownedGiftScope,ownedPriceErrorResponse} from './owned-price-engine.js';
import {createMarketappLoginEngine} from './marketapp-login.js';
import {createMarketappAnalyticsRefreshEngine} from './marketapp-analytics-refresh.js';
import {createMarketappRefreshStatusEngine} from './marketapp-refresh-status.js';
import {createMarketappSessionBox} from './marketapp-session-box.js';
import {createMarketappRememberedSessionBox} from './marketapp-remembered-session-box.js';
import {buildCloudDashboard} from './cloud-pricing.js';
import {StorageCapacityError} from './storage-admission.js';
import {cloudReadErrorResponse} from './bounded-response.js';

const fail=code=>{throw new PublicRequestError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validatePublicReleaseConfig(config) {
  if(config?.enabled!==true)fail('PUBLIC_MODE_DISABLED');
  if(Object.hasOwn(config,'preservePrivateOwner')&&typeof config.preservePrivateOwner!=='boolean')fail('PUBLIC_CONFIGURATION');
  if(typeof config.origin!=='string'||!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(config.origin)||config.storageEncryptionConfirmed!==true||config.providerUseApproved!==true)fail('PUBLIC_CONFIGURATION');
  for(const field of ['privacyPolicyUrl','termsUrl'])if(typeof config[field]!=='string'||config[field].length>2048||!/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s#]*)?$/.test(config[field]))fail('PUBLIC_CONFIGURATION');
  if(typeof config.openRegistration!=='boolean'||typeof config.experimentalPersonalAnalytics!=='boolean'||!Array.isArray(config.invitedUserIds)||config.invitedUserIds.length>100||config.invitedUserIds.some(id=>! /^[1-9][0-9]{0,15}$/.test(String(id)))||(!config.openRegistration&&!config.invitedUserIds.length)||
    !Number.isSafeInteger(config.maxAccounts)||config.maxAccounts<1||config.maxAccounts>100)fail('PUBLIC_CONFIGURATION');
  for(const field of ['globalMarketDailyAttempts','globalTonDailyAttempts','perUserMarketDailyAttempts','perUserTonDailyAttempts'])if(!Number.isSafeInteger(config[field])||config[field]<1||config[field]>5000)fail('PUBLIC_CONFIGURATION');
  if(config.perUserTonDailyAttempts>1000)fail('PUBLIC_CONFIGURATION');
  if(!Number.isSafeInteger(config.maxWalletGifts)||config.maxWalletGifts<1||config.maxWalletGifts>250||!Number.isSafeInteger(config.maxDiscoveryCandidates)||config.maxDiscoveryCandidates<1||config.maxDiscoveryCandidates>1000)fail('PUBLIC_CONFIGURATION');
  return config;
}
export function createPublicRuntime({db,fetch,config,masterKey,clock=null,legacyProviderUsage=null,storageAdmission=null,storageMaintenance=null}) {
  const box=createPublicCredentialBox(masterKey);
  const sessionKey=hex(hmacSha256(keyBytes(masterKey),utf8Bytes('gift-rent-public-analytics-key-v1')));
  async function environment(ctx) {
    validatePublicReleaseConfig(config);
    let user;try{user=verifiedTelegramUserId(ctx);}catch{fail('PUBLIC_ACCESS_DENIED');}
    if(!config.openRegistration&&!config.invitedUserIds.map(String).includes(user))fail('PUBLIC_ACCESS_DENIED');
    const repo=createPublicRepository(db,user,{dashboardCache:true,maxAccounts:config.maxAccounts,storageAdmission:storageAdmission?.forScope(`public:${user}`)});
    const trustedClock=clock??(()=>repo.clock());
    let account=await repo.publicAccount();if(!account){try{await repo.ensureAccount();}catch{fail('PUBLIC_ACCOUNT_LIMIT');}account=await repo.publicAccount();}
    if(account.status==='active'&&account.generation!==await repo.accountGeneration())fail('PUBLIC_ACCOUNT_CHANGED');
    const budget=createPublicProviderBudget({db,masterKey,config,clock:trustedClock,legacyProviderUsage});
    const row=account.status==='active'?await repo.credentialStatus('marketapp'):null;
    const providerFetch=createPublicProviderFetch({fetch,budget,repository:repo,userId:user,credentialFingerprint:row?.credential_fingerprint??null});
    const accountEngine=createPublicAccountEngine({repository:repo,box,fetch:providerFetch,clock:trustedClock});
    return {user,repo,account,row,budget,providerFetch,accountEngine,clock:trustedClock,progressBudgets:{}};
  }
  const safe = async (work,readOperation=null) => {
    try{return await work();}catch(error){
      const ownedPriceError=ownedPriceErrorResponse(error);if(ownedPriceError)return ownedPriceError;
      if(error instanceof StorageCapacityError)return {error:{code:error.code}};
      if(error instanceof CloudStorageFullError)return {error:{code:'STORAGE_FULL'}};
      if(error instanceof PublicCredentialChangedError)return {error:{code:'PUBLIC_KEY_CHANGED'}};
      if(error instanceof PublicAccountError)return {error:{code:'PUBLIC_ACCOUNT_DELETED'}};
      if(typeof error?.code==='string'&&/^(PUBLIC_[A-Z_]+|STORAGE_FULL|CONFLICT|ACTIVE_JOB|LEASE_ACTIVE)$/.test(error.code))return {error:{code:error.code,
        ...(Number.isSafeInteger(error.readyAt)?{available_at:new Date(error.readyAt).toISOString()}: {})}};
      if(!(error instanceof CloudRequestError)) {
        const readFailure=cloudReadErrorResponse(readOperation,error);if(readFailure)return readFailure;
      }
      return {error:{code:'PUBLIC_REQUEST_FAILED'}};
    }
  };
  const walletRequired=e=>{if(!e.account.wallet||!e.account.wallet_verified_at)fail('PUBLIC_WALLET_REQUIRED');};
  const activeRequired=e=>{if(e.account.status!=='active')fail('PUBLIC_ACCOUNT_DELETED');};
  function accountInput(e,input) {
    if(!object(input)||!Number.isSafeInteger(input.account_generation)||input.account_generation!==e.account.generation)fail('PUBLIC_ACCOUNT_CHANGED');
    const {account_generation,...value}=input;return value;
  }
  function fenced(e, bindWallet = false) {
    if(!e.row?.ciphertext)fail('PUBLIC_KEY_REQUIRED');
    let token;try {token=openPublicMarketappKey(box,e.row,e.user,e.account.generation);}catch{fail('PUBLIC_KEY_INVALID');}
    const repo=createPublicRepository(db,e.user,{dashboardCache:true,maxAccounts:config.maxAccounts,storageAdmission:storageAdmission?.forScope(`public:${e.user}`),accountGenerationFence:e.account.generation,
      ...(bindWallet?{walletFence:{revision:e.account.wallet_revision}}:{}),credentialFence:{provider:'marketapp',credential_version:e.row.credential_version,fingerprint:e.row.credential_fingerprint}});
    return {repo,token,fetch:createPublicProviderFetch({fetch,budget:e.budget,repository:repo,userId:e.user,credentialFingerprint:e.row.credential_fingerprint})};
  }
  function cloud(e,repository=e.repo,request=e.providerFetch,token=e.row?.ciphertext?'configured-key':'') {return createCloudEngine({repository,fetch:request,ownerTelegramId:e.user,marketappToken:token,clock:e.clock,
    limits:{daily_attempts:config.perUserMarketDailyAttempts},ownedPriceRefresh:Boolean(e.account.wallet),startupIdentity:{account_generation:e.account.generation,wallet_revision:e.account.wallet_revision},
    providerStatus:()=>e.budget.status('marketapp',e.user,e.row?.credential_fingerprint??null)});}
  function discovery(e,repository=e.repo,request=e.providerFetch,token=''){return createPublicDiscoveryEngine({enabled:true,repository,fetch:request,ownerTelegramId:e.user,marketappToken:token,clock:e.clock,
    limits:{max_candidates:config.maxDiscoveryCandidates,max_wallet_gifts:config.maxWalletGifts,daily_attempts:config.perUserTonDailyAttempts}});}
  async function providerProgress(e,result) {
    const job=result?.job;if(!job)return result;
    job.account_generation=e.account.generation;
    const provider=job.progress?.provider==='toncenter'?'toncenter':'marketapp';
    const status=e.progressBudgets[provider]??=await e.budget.status(provider,e.user,provider==='marketapp'?e.row?.credential_fingerprint??null:null);
    const blocked=status.remaining_24h===0;
    const budget={...(job.progress.marketapp_budget??{}),rolling_24h_used:status.used_24h,rolling_24h_limit:status.rolling_24h_attempts,
      remaining_24h:status.remaining_24h,available_at:blocked?status.available_at:null,provider_allowance_blocked:blocked};
    job.progress.provider_budget=budget;
    if(provider==='marketapp')job.progress.marketapp_budget=budget;
    if(job.state==='partial'&&blocked)job.reason='The daily provider allowance was reached. Your progress is saved.';
    return result;
  }
  const accountPolicies=async(e,result)=>result?.account?{...result,account:{...result.account,account_generation:(await e.repo.publicAccount()).generation,privacy_policy_url:config.privacyPolicyUrl,terms_url:config.termsUrl}}:result;
  async function invokeAccount(name,input,ctx) {return safe(async()=>{const e=await environment(ctx);if(typeof e.accountEngine[name]!=='function')fail('PUBLIC_INVALID_INPUT');return accountPolicies(e,await e.accountEngine[name](ctx,input));});}
  async function invokeWallet(name,input,ctx) {return safe(async()=>{const e=await environment(ctx);activeRequired(e);
    const engine=createPublicWalletEngine({repository:e.repo,ownerTelegramId:e.user,enabled:true,challengeKey:masterKey,domain:config.origin.slice(8),manifestUrl:`${config.origin}/tonconnect-manifest.json`,clock:e.clock});
    if(!['startWalletVerification','finishWalletVerification'].includes(name))fail('PUBLIC_INVALID_INPUT');
    const result=await engine[name](ctx,input);return name==='finishWalletVerification'?accountPolicies(e,await e.accountEngine.getPublicAccount(ctx,{})):result;
  });}
  async function invokeCloud(name,input={},ctx) {return safe(async()=>{const e=await environment(ctx);
    if(e.account.status!=='active'&&name==='getJobs')return {jobs:[]};
    if(e.account.status!=='active'&&name==='getDashboardRevision')return {token:`deleted:${e.account.generation}:${e.account.status}`};
    if(name==='getDashboard'&&e.account.status!=='active') {
      const dashboard=buildCloudDashboard([],input,{now:await e.clock()});dashboard.update_token=`deleted:${e.account.generation}:${e.account.status}`;dashboard.capabilities={mode:'serverless',network_enabled:false,public_account:true,account_generation:e.account.generation,supported_jobs:[],marketapp_configured:false,wallet_configured:false,csrf_token:''};return dashboard;
    }
    activeRequired(e);
    if(name==='importChunk')fail('PUBLIC_ACCESS_DENIED'); // Browser callers cannot forge verified portfolio evidence.
    if(name==='getDashboard') {
      const result=await cloud(e).getDashboard(ctx,input),limits=await e.budget.status('marketapp',e.user,e.row?.credential_fingerprint??null);
      result.update_token=`public:${e.account.generation}:${result.update_token}`;
      const ownedRefresh=Boolean(e.account.wallet&&result.gifts?.some(gift=>gift.is_portfolio===true));
      result.capabilities={...result.capabilities,...{public_account:true,account_generation:e.account.generation,public_onboarding:!(e.account.wallet_verified_at&&e.row?.ciphertext),wallet_configured:Boolean(e.account.wallet_verified_at),
        owned_price_refresh:ownedRefresh,owned_price_refresh_single:ownedRefresh,owned_status_refresh:ownedRefresh,personal_gift_refresh:ownedRefresh,
        marketapp_login_test:config.experimentalPersonalAnalytics===true,marketapp_analytics_refresh:config.experimentalPersonalAnalytics===true,
        supported_jobs:['discover','prices','rental_prices','collect'],marketapp_limits:{...result.capabilities.marketapp_limits,...limits,provider_allowance_blocked:limits.remaining_24h===0}}};
      result.coverage.note='Wallet discovery and provider checks are bounded, dated observations. Historical transfers are candidates until current ownership is verified. Rental-contract availability does not prove Marketapp listing visibility.';
      return result;
    }
    if(name==='getDashboardRevision'){const result=await cloud(e).getDashboardRevision(ctx,input);return {...result,token:`public:${e.account.generation}:${result.token}`};}
    if(name==='getJobs') {
      const market=cloud(e,{...e.repo,jobs:async()=> (await e.repo.jobs()).filter(job=>job.kind!=='discover')});
      const jobs=[...(await market.getJobs(ctx)).jobs,...(await discovery(e).getJobs(ctx)).jobs].sort((a,b)=>b.id-a.id);
      for(const job of jobs)await providerProgress(e,{job});return {jobs};
    }
    if(name==='importPersonalAnalytics'){walletRequired(e);return cloud(e).importPersonalAnalytics(ctx,input);}
    if(!['startJob','stepJob','resumeJob','stopJob','refreshStartupComparisons'].includes(name))fail('PUBLIC_INVALID_INPUT');
    input=accountInput(e,input);
    walletRequired(e);
    const prior=['startJob','refreshStartupComparisons'].includes(name)?null:await e.repo.job(input.job_id??input.id),kind=input.kind??prior?.kind;
    if(name==='stopJob')return providerProgress(e,await (kind==='discover'?discovery(e).stopJob(ctx,input):cloud(e).stopJob(ctx,input)));
    if(name==='refreshStartupComparisons'&&!e.row?.ciphertext)return {state:'unavailable',reason:'key_missing'};
    const {repo,fetch:request,token}=fenced(e,name==='refreshStartupComparisons'||Boolean(prior?.startup_comparisons));const engine=kind==='discover'?discovery(e,repo,request,token):cloud(e,repo,request,token);
    return providerProgress(e,await engine[name](ctx,input));
  },name);}
  async function invokeOwnedPrice(name,input,ctx,personalRefresh=false) {return safe(async()=>{const e=await environment(ctx);activeRequired(e);
    // Only the account's retained, previously bound portfolio wallet can be
    // checked. This grants no discovery, enrollment, analytics or API jobs.
    if(!e.account.wallet)fail('PUBLIC_WALLET_REQUIRED');
    if(!['getStatus','start','step','stop'].includes(name))fail('PUBLIC_INVALID_INPUT');
    if(name!=='getStatus')input=accountInput(e,input);
    const repository=createPublicRepository(db,e.user,{dashboardCache:true,maxAccounts:config.maxAccounts,storageAdmission:storageAdmission?.forScope(`public:${e.user}`),accountGenerationFence:e.account.generation,walletFence:{revision:e.account.wallet_revision}});
    if(name==='start'||name==='step') {
      const {state}=await repository.read(),run=state.owned_prices?.run;
      if(run?.state==='running'&&run.public_wallet_revision!==undefined&&run.public_wallet_revision!==e.account.wallet_revision)fail('PUBLIC_WALLET_CHANGED');
    }
    const providerFetch=createPublicProviderFetch({fetch,budget:e.budget,repository,userId:e.user});
    const engine=createOwnedPriceEngine({repository,fetch:providerFetch,ownerTelegramId:e.user,clock:e.clock,
      limits:{daily_attempts:config.perUserTonDailyAttempts,...(personalRefresh?{invocation_attempts:20}:{})}});
    const result=await engine[name](ctx,input);if(result.run)result.run.account_generation=e.account.generation;return result;
  });}
  async function cachedOwnedPortfolio(e,input,ctx) {
    // Bind another automatic page launch to an unchanged completed check.
    // Neither the run's completion time nor its evidence is renewed.
    if(!input.session_id||Object.hasOwn(input,'nft_address')||!e.account.wallet)return null;
    accountInput(e,input);
    const repository=createPublicRepository(db,e.user,{dashboardCache:true,maxAccounts:config.maxAccounts,storageAdmission:storageAdmission?.forScope(`public:${e.user}`),accountGenerationFence:e.account.generation,walletFence:{revision:e.account.wallet_revision}});
    for(let attempt=0;attempt<16;attempt++) {
      if(await repository.ownedRefreshSession(input.session_id)!==null)return null;
      const saved=await repository.read(),run=saved.state.owned_prices?.run,scope=ownedGiftScope(await repository.records()),at=await e.clock();
      if(!Number.isSafeInteger(at)||at<=0)fail('PUBLIC_REQUEST_FAILED');
      const completed=Date.parse(run?.completed_at);
      if(run?.state!=='complete'||run.scope!=='portfolio'||run.status_refresh_version!=='ton-owned-rental-status-v1'
        ||run.public_wallet_revision!==e.account.wallet_revision||!Number.isFinite(completed)||at<completed||at-completed>=300000
        ||run.lease_until>at||run.pending?.length||run.wallet!==scope.wallet||!scope.wallet
        ||JSON.stringify(run.targets)!==JSON.stringify(scope.targets))return null;
      const state=JSON.parse(JSON.stringify(saved.state));state.owned_prices.last_session={id:input.session_id,run_id:run.id};
      const committed=await repository.append(saved.revision,{key:`owned-price:${run.id}:cache:${saved.revision+1}`,state,
        records:[],raw_body:null,observed_at:new Date(at).toISOString()});
      if(!committed)continue;
      const result=await createOwnedPriceEngine({repository,fetch:e.providerFetch,ownerTelegramId:e.user,clock:e.clock,
        limits:{daily_attempts:config.perUserTonDailyAttempts}}).getStatus(ctx,{session_id:input.session_id});
      if(result.run){result.run.session_id=input.session_id;result.run.account_generation=e.account.generation;}
      return {...result,cache_hit:true};
    }
    fail('CONFLICT');
  }
  // Personal website gift refresh is initially disabled for invited accounts.
  // They retain the same bounded TON-only fallback and scoped controls.
  async function invokeGiftRefresh(name,input={},ctx) {return safe(async()=>{
    if(!object(input)||!['getStatus','start','step','stop'].includes(name))fail('PUBLIC_INVALID_INPUT');
    const {automatic,...forwarded}=input;
    if(Object.hasOwn(input,'automatic')&&(name!=='start'||typeof automatic!=='boolean'))fail('PUBLIC_INVALID_INPUT');
    const session=input.session_id;
    if(session!==undefined&&(typeof session!=='string'||!/^[A-Za-z0-9._:-]{16,160}$/.test(session)))fail('PUBLIC_INVALID_INPUT');
    const e=await environment(ctx);activeRequired(e);
    if(name==='step'||name==='stop') {
      accountInput(e,input);
      if(!session||!Number.isSafeInteger(input.run_id)||input.run_id<1)fail('PUBLIC_INVALID_INPUT');
      if(await e.repo.ownedRefreshSession(session)!==input.run_id)return {error:{code:'OWNED_PRICE_SCOPE_CHANGED'}};
      delete forwarded.session_id;
    }
    // Cache only the exact automatic portfolio operation. Unknown fields must
    // still reach the strict engine validator, never become a cached success.
    const cacheAllowed=name==='start'&&automatic===true&&Object.keys(forwarded).every(key=>['session_id','account_generation'].includes(key));
    const cached=cacheAllowed?await cachedOwnedPortfolio(e,forwarded,ctx):null;
    const result=cached??await invokeOwnedPrice(name,forwarded,ctx,true);if(result.error)return result;
    if(result.run&&session&&await e.repo.ownedRefreshSession(session)===result.run.id)result.run.session_id=session;
    return {...result,provider:'toncenter',fallback_reason:'website_disabled'};
  });}
  async function invokeAnalytics(group,name,input,ctx) {return safe(async()=>{const e=await environment(ctx);activeRequired(e);walletRequired(e);
    if(config.experimentalPersonalAnalytics!==true)fail('PUBLIC_ANALYTICS_DISABLED');
    // Website login has a separate purpose key and account-scoped nonce/fence;
    // Marketapp API keys never authenticate the website session.
    const analytics=createMarketappAnalyticsRefreshEngine({repository:e.repo,fetch,ownerTelegramId:e.user,clock:e.clock,
      sessionBox:createMarketappSessionBox(sessionKey),rememberedSessionBox:createMarketappRememberedSessionBox(sessionKey)});
    if(group==='status')return createMarketappRefreshStatusEngine({repository:e.repo,ownerTelegramId:e.user,clock:e.clock,sessionStatus:context=>analytics.getMarketappAnalyticsSessionStatus(context)}).getMarketappAnalyticsRefreshStatus(ctx,input);
    const engine=group==='login'?createMarketappLoginEngine({repository:e.repo,fetch,ownerTelegramId:e.user,clock:e.clock}):analytics;
    if(typeof engine[name]!=='function')fail('PUBLIC_INVALID_INPUT');return engine[name](ctx,input);
  });}
  async function invokeStorage(name,input={},ctx) {return safe(async()=>{
    validatePublicReleaseConfig(config);
    let user;try{user=verifiedTelegramUserId(ctx);}catch{fail('PUBLIC_ACCESS_DENIED');}
    if(!config.openRegistration&&!config.invitedUserIds.map(String).includes(user))fail('PUBLIC_ACCESS_DENIED');
    if(!storageMaintenance||!object(input)||!['status','step'].includes(name)||Object.keys(input).some(key=>!['manual','progress','growth'].includes(key))
        ||Object.hasOwn(input,'manual')&&(name!=='step'||typeof input.manual!=='boolean')
        ||Object.hasOwn(input,'progress')&&typeof input.progress!=='boolean'
        ||Object.hasOwn(input,'growth')&&typeof input.growth!=='boolean')fail('PUBLIC_INVALID_INPUT');
    const account=await db.get('SELECT status,generation FROM public_accounts WHERE user_id=:user',{':user':user});
    if(account?.status!=='active')fail('PUBLIC_ACCOUNT_DELETED');
    const caller={userId:user,isOwner:false,accountGeneration:account.generation,progress:input.progress===true,growth:input.growth===true};
    return name==='status'?storageMaintenance.status(caller):storageMaintenance.step({...caller,manual:input.manual===true});
  });}
  return {invokeAccount,invokeWallet,invokeCloud,invokeOwnedPrice,invokeGiftRefresh,invokeAnalytics,invokeStorage};
}
