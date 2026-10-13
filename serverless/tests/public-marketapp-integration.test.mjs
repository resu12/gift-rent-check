import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicRuntime} from '../tgcloud/lib/public-runtime.js';
import {publicReleaseConfig} from '../public-release-config.example.js';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {syntheticAnalyticsPage,syntheticWallet as wallet,syntheticFriendly} from './fixtures/marketapp-analytics-page-fixture.mjs';
import {syntheticGiftsHead,syntheticGiftAddress as nft} from './fixtures/marketapp-gifts-page-fixture.mjs';
import {installCompactOperationalStorage} from '../tools/compact-operational-storage.mjs';
import {installNormalizedRecordStorage} from '../tools/normalized-record-storage.mjs';
import {streamedBody} from './fixtures/http-response.mjs';

const collection='0:'+'44'.repeat(32),ctx=id=>({initData:{user:{id:Number(id)}}}),challenge='synthetic-public-account-challenge';
const config={...publicReleaseConfig,enabled:true,preservePrivateOwner:false,invitedUserIds:['101','202'],experimentalPersonalAnalytics:true,
  origin:'https://gift.example.test',privacyPolicyUrl:'https://gift.example.test/privacy',termsUrl:'https://gift.example.test/terms',storageEncryptionConfirmed:true,providerUseApproved:true};
function response(url,body,type='text/html',cookie=null){return {status:200,url,body:streamedBody(body),headers:{get:key=>({'content-type':type,'set-cookie':cookie}[key.toLowerCase()]??null)}};}
async function setup(t){
  const f=createPublicDatabase(t);await installCompactOperationalStorage(f.db);await installNormalizedRecordStorage(f.db);
  let at=Date.parse('2026-10-12T12:00:00Z'),auth=0,hook=null;const calls=[];
  const runtime=createPublicRuntime({db:f.db,config,masterKey:'ab'.repeat(32),clock:async()=>at,fetch:async(url,options)=>{
    calls.push({url,options});if(hook)await hook(url,options);
    if(url==='https://marketapp.org/')return response(url,`<script>Wallet.init(${JSON.stringify({address:false,ton_proof:challenge,version:2})});</script>`,'text/html','session=synthetic-anonymous; Path=/; Secure; HttpOnly');
    if(url==='https://marketapp.org/auth/checkTonProofAuth/')return response(url,'{"verified":true}','application/json',`session=synthetic-auth-${++auth}; Path=/; Secure; HttpOnly`);
    if(url.includes('tab=analytics_rent'))return response(url,syntheticAnalyticsPage({wallet,periodDays:url.includes('last365days')?365:30,lastDate:new Date(at).toISOString().slice(0,10),capturedAt:new Date(at).toISOString()}).html);
    if(url.includes('tab=my_nfts'))return response(url,syntheticGiftsHead({wallet,count:1,more:false,cardOptions:{state:'for_rent'}}).body);
    if(url.startsWith('https://toncenter.com'))return response(url,JSON.stringify({nft_items:[{address:nft(0),owner_address:wallet,collection_address:collection,init:true,last_transaction_lt:'1'}]}),'application/json');
    assert.fail('Unexpected provider route');
  }});
  for(const id of ['101','202']){const repo=f.repository(id),saved=await repo.read();await repo.append(saved.revision,{key:'wallet-bind:fixture',state:saved.state,observed_at:new Date(at).toISOString(),records:[
    {kind:'settings',record:{wallet,wallet_address:wallet,wallet_verified_at:new Date(at).toISOString(),wallet_verification:'ton_proof',wallet_disconnect_revision:0}},
    {kind:'portfolio',record:{nft_address:nft(0),collection_address:collection,is_portfolio:true}}]});}
  const invoke=(name,input={},id='101',group='analytics')=>runtime.invokeAnalytics(group,name,{account_generation:0,...input},ctx(id));
  const submission=start=>({attempt_id:start.attempt_id,session_envelope:start.session_envelope,
    account:{address:syntheticFriendly(wallet),chain:'-239',walletStateInit:'te6ccgEBAQEAAgAAAA==',publicKey:'11'.repeat(32)},
    device:{platform:'android',appName:'synthetic_wallet',appVersion:'1.2.3',maxProtocolVersion:2,features:['SendTransaction']},
    proof:{timestamp:Math.floor(at/1000),domain:{value:'marketapp.org',lengthBytes:13},payload:start.challenge,signature:Buffer.alloc(64,1).toString('base64')}});
  async function remember(id='101'){const start=await invoke('startMarketappAnalyticsRefresh',{period_days:30,remember_login:true},id);assert.ok(start.attempt_id,JSON.stringify(start));
    const result=await invoke('finishMarketappAnalyticsRefresh',submission(start),id);assert.equal(result.analytics_refreshed,true,JSON.stringify(result));return result;}
  return {...f,runtime,calls,invoke,submission,remember,advance:ms=>at+=ms,now:()=>at,setHook:value=>{hook=value;}};
}

test('invited login remembers only encrypted cookies and refreshes scoped analytics and gifts without an API key',async t=>{
  const f=await setup(t);await f.remember();
  const dashboard=await f.runtime.invokeCloud('getDashboard',{},ctx('101'));assert.equal(dashboard.capabilities.marketapp_analytics_refresh,true);assert.equal(dashboard.capabilities.marketapp_login_test,false);
  assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus')).remembered,true);
  assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus',{},'202')).remembered,false);
  const session=f.database.prepare('SELECT * FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101');assert.ok(session.ciphertext);assert.equal(session.ciphertext.includes('synthetic-auth'),false);
  f.advance(60001);assert.equal((await f.invoke('refreshSavedMarketappAnalytics',{period_days:365})).analytics_refreshed,true);
  f.advance(1001);const start=await f.runtime.invokeGiftRefresh('start',{session_id:'public-website-gift-page-001',account_generation:0},ctx('101'));assert.equal(start.provider,'marketapp_website',JSON.stringify(start));
  const done=await f.runtime.invokeGiftRefresh('step',{session_id:start.run.session_id,run_id:start.run.id,account_generation:0},ctx('101'));
  assert.equal(done.run?.state,'complete',JSON.stringify(done));assert.equal(done.run.updated,1);
  assert.equal((await f.repository('101').records()).filter(row=>row.kind==='personal_gift').length,1);
  assert.equal((await f.repository('202').records()).filter(row=>row.kind==='personal_gift').length,0);
  assert.equal((await f.runtime.invokeGiftRefresh('getStatus',{session_id:start.run.session_id},ctx('202'))).run,null);
  const persisted=JSON.stringify(f.database.prepare('SELECT state_json,records_json,raw_body FROM public_cloud_events').all());
  for(const secret of ['synthetic-auth','synthetic-anonymous','Wallet.init','<script','"signature":','"proof":'])assert.equal(persisted.includes(secret),false);
  assert.ok(f.calls.every(call=>call.options.headers?.Authorization===undefined));
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM marketapp_website_requests WHERE scope_key='public:101'").get().n,5);
});

test('public analytics allowlists and account generations fail before provider requests',async t=>{
  const f=await setup(t);
  for(const name of ['startMarketappAnalyticsRefresh','finishMarketappAnalyticsRefresh','cancelMarketappAnalyticsRefresh','refreshSavedMarketappAnalytics','refreshStartupMarketappAnalytics','disconnectMarketappAnalyticsSession','getMarketappAnalyticsSessionStatus']) {
    for(const generation of [undefined,1,-1,'0'])assert.equal((await f.runtime.invokeAnalytics('analytics',name,{account_generation:generation},ctx('101'))).error.code,'PUBLIC_ACCOUNT_CHANGED');
  }
  for(const [group,name] of [['analytics','constructor'],['analytics','toString'],['other','getMarketappAnalyticsSessionStatus'],['status','constructor']])assert.equal((await f.invoke(name,{},'101',group)).error.code,'PUBLIC_INVALID_INPUT');
  assert.equal((await f.invoke('startMarketappLoginTest',{},'101','login')).error.code,'PUBLIC_ANALYTICS_DISABLED');assert.equal(f.calls.length,0);
});

test('cross-account approvals cannot authorize analytics even when both accounts use the same wallet',async t=>{
  const f=await setup(t),start=await f.invoke('startMarketappAnalyticsRefresh',{period_days:30,remember_login:true});
  const response=await f.invoke('finishMarketappAnalyticsRefresh',f.submission(start),'202');assert.ok(response.error);assert.equal(f.calls.length,1);
  assert.equal((await f.invoke('finishMarketappAnalyticsRefresh',f.submission(start))).analytics_refreshed,true);
  f.advance(1001);await f.remember('202');
  const rows=f.database.prepare('SELECT owner_id,nonce_counter,ciphertext FROM public_marketapp_analytics_sessions ORDER BY owner_id').all();assert.equal(rows.length,2);
  assert.equal(rows[0].nonce_counter,1);assert.equal(rows[1].nonce_counter,1);assert.notEqual(rows[0].ciphertext,rows[1].ciphertext);
  await f.invoke('disconnectMarketappAnalyticsSession');assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus')).remembered,false);assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus',{},'202')).remembered,true);
  assert.equal(f.database.prepare('SELECT nonce_counter FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101').nonce_counter,1);
});

test('logout during a website gift response fences all late personal observations',async t=>{
  const f=await setup(t);await f.remember();f.advance(1001);
  const start=await f.runtime.invokeGiftRefresh('start',{session_id:'public-website-logout-during-request',account_generation:0},ctx('101'));
  f.setHook(async url=>{if(url.includes('tab=my_nfts')){f.setHook(null);assert.equal((await f.invoke('disconnectMarketappAnalyticsSession')).disconnected,true);}});
  await f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},ctx('101'));
  assert.equal((await f.repository('101').records()).filter(row=>row.kind==='personal_gift').length,0);
  assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus')).remembered,false);
});

test('website evidence INSERT atomically rejects logout after all in-memory checks',async t=>{
  const f=await setup(t);await f.remember();f.advance(1001);
  const start=await f.runtime.invokeGiftRefresh('start',{session_id:'public-website-final-cas-fence',account_generation:0},ctx('101'));
  const run=f.db.run;let revoked=false;
  f.db.run=async(sql,parameters)=>{
    if(!revoked&&sql.includes('INSERT OR IGNORE INTO public_cloud_events')&&parameters?.[':website_generation']!==null&&parameters?.[':website_generation']!==undefined){
      revoked=true;await f.repository('101').clearMarketappSession('101');
    }
    return run(sql,parameters);
  };
  await f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},ctx('101'));
  assert.equal(revoked,true);assert.equal((await f.repository('101').records()).filter(row=>row.kind==='personal_gift').length,0);
  assert.equal(f.database.prepare('SELECT ciphertext FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101').ciphertext,null);
});

test('a delayed Marketapp disconnect cannot revoke a session established after wallet rebind',async t=>{
  const f=await setup(t);await f.remember();const run=f.db.run;let rebound=false,newCiphertext;
  f.db.run=async(sql,parameters)=>{
    if(!rebound&&sql.startsWith('UPDATE public_marketapp_analytics_sessions SET generation=generation+1')){
      rebound=true;const repo=f.repository('101'),saved=await repo.read();
      await repo.append(saved.revision,{key:'wallet-bind:fixture-rebound',state:saved.state,observed_at:new Date(f.now()).toISOString(),records:[
        {kind:'settings',record:{wallet,wallet_address:wallet,wallet_verified_at:new Date(f.now()).toISOString(),wallet_verification:'ton_proof',wallet_disconnect_revision:0}}]});
      f.advance(60001);await f.remember();newCiphertext=f.database.prepare('SELECT ciphertext FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101').ciphertext;
    }
    return run(sql,parameters);
  };
  const result=await f.invoke('disconnectMarketappAnalyticsSession');assert.equal(rebound,true);assert.ok(result.error);assert.notEqual(result.disconnected,true);
  assert.equal(f.database.prepare('SELECT ciphertext FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101').ciphertext,newCiphertext);
  assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus')).remembered,true);
});

test('account deletion during analytics response prevents snapshots and credentials reaching a reactivated account',async t=>{
  const f=await setup(t);await f.remember();f.advance(60001);
  const before=f.database.prepare('SELECT nonce_counter FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101').nonce_counter;
  f.setHook(async url=>{
    if(url.includes('tab=analytics_rent')){
      f.setHook(null);const repo=f.repository('101');let result=await repo.deleteAccountData();while(result.pending_cleanup)result=await repo.processAccountDeletion();await repo.reactivateAccount();
    }
  });
  const result=await f.invoke('refreshSavedMarketappAnalytics',{period_days:365});assert.ok(result.error);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_personal_rental_analytics WHERE user_id=?').get('101').n,0);
  const session=f.database.prepare('SELECT nonce_counter,ciphertext FROM public_marketapp_analytics_sessions WHERE owner_id=?').get('101');assert.equal(session.ciphertext,null);assert.ok(session.nonce_counter>=before);
  assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus')).error.code,'PUBLIC_WALLET_REQUIRED');
});

for(const stage of ['insert','replace'])test(`manual analytics ${stage} atomically rejects a wallet disconnect after validation`,async t=>{
  const f=await setup(t),snapshot=()=>JSON.stringify(syntheticAnalyticsPage({wallet,periodDays:30,lastDate:new Date(f.now()).toISOString().slice(0,10),capturedAt:new Date(f.now()).toISOString()}).snapshot);
  let before=[];
  if(stage==='replace'){
    const saved=await f.runtime.invokeCloud('importPersonalAnalytics',{snapshot:snapshot(),account_generation:0},ctx('101'));assert.ok(saved.personal_analytics,JSON.stringify(saved));
    before=f.database.prepare('SELECT * FROM public_personal_rental_analytics WHERE user_id=?').all('101');f.advance(1001);
  }
  const run=f.db.run;let disconnected=false;
  f.db.run=async(sql,parameters)=>{
    const match=stage==='insert'?sql.startsWith('INSERT OR IGNORE INTO public_personal_rental_analytics'):sql.includes('UPDATE OR IGNORE public_personal_rental_analytics');
    if(!disconnected&&match){disconnected=true;assert.equal((await f.runtime.invokeAccount('disconnectPublicWallet',{},ctx('101'))).account.wallet,null);}
    return run(sql,parameters);
  };
  const result=await f.runtime.invokeCloud('importPersonalAnalytics',{snapshot:snapshot(),account_generation:0},ctx('101'));
  assert.equal(disconnected,true);assert.equal(result.error?.code,'PUBLIC_WALLET_CHANGED');
  assert.deepEqual(f.database.prepare('SELECT * FROM public_personal_rental_analytics WHERE user_id=?').all('101'),before);assert.equal(f.calls.length,0);
});

test('completed gift refresh replay and archive lookup stay isolated after newer refreshes and deletion',async t=>{
  const f=await setup(t);await f.remember();f.advance(1001);
  async function gift(session){const start=await f.runtime.invokeGiftRefresh('start',{session_id:session,account_generation:0},ctx('101'));
    return f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:session,account_generation:0},ctx('101'));}
  const first=await gift('public-website-archive-first-page');f.advance(1001);const second=await gift('public-website-archive-second-page');assert.ok(second.run.id>first.run.id);
  const replay=await f.runtime.invokeGiftRefresh('getStatus',{session_id:first.run.session_id},ctx('101'));assert.equal(replay.run.state,'complete');assert.equal(replay.run.id,first.run.id);
  assert.equal((await f.runtime.invokeGiftRefresh('getStatus',{session_id:first.run.session_id},ctx('202'))).run,null);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_gift_refresh_runs WHERE user_id=?').get('101').n,2);
  const repo=f.repository('101');let result=await repo.deleteAccountData();while(result.pending_cleanup)result=await repo.processAccountDeletion();
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_gift_refresh_runs WHERE user_id=?').get('101').n,0);
});

test('active website gift refresh reports account busy while API-key revocation remains available',async t=>{
  const f=await setup(t);assert.equal((await f.runtime.invokeAccount('saveMarketappApiKey',{api_key:'synthetic-own-key'},ctx('101'))).account.marketapp_key.configured,true);
  await f.remember();f.advance(1001);
  const start=await f.runtime.invokeGiftRefresh('start',{session_id:'public-website-account-mutation-busy',account_generation:0},ctx('101'));
  const requests=f.calls.length;
  for(const [name,input] of [['saveMarketappApiKey',{api_key:'synthetic-own-key'}],['testMarketappApiKey',{}],['disconnectPublicWallet',{}]])
    assert.equal((await f.runtime.invokeAccount(name,input,ctx('101'))).error.code,'PUBLIC_ACCOUNT_BUSY');
  assert.equal(f.calls.length,requests);
  assert.equal((await f.runtime.invokeAccount('removeMarketappApiKey',{},ctx('101'))).account.marketapp_key.configured,false);
  const done=await f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},ctx('101'));
  assert.equal(done.run.state,'complete');assert.equal(done.run.updated,1);
});

test('feature-enabled accounts without remembered login use bounded TON fallback, including after wallet disconnect',async t=>{
  const f=await setup(t);assert.equal((await f.runtime.invokeAccount('disconnectPublicWallet',{},ctx('101'))).account.wallet,null);
  const start=await f.runtime.invokeGiftRefresh('start',{session_id:'public-website-disconnected-fallback',account_generation:0},ctx('101'));assert.equal(start.provider,'toncenter',JSON.stringify(start));
  const step=await f.runtime.invokeGiftRefresh('step',{run_id:start.run.id,session_id:start.run.session_id,account_generation:0},ctx('101'));assert.ok(step.run,JSON.stringify(step));
  assert.ok(f.calls.every(call=>call.url.startsWith('https://toncenter.com')));
  assert.equal((await f.invoke('getMarketappAnalyticsSessionStatus')).error.code,'PUBLIC_WALLET_REQUIRED');
});

test('shared-engine automatic cache cannot cross a wallet disconnect boundary',async t=>{
  const f=await setup(t);let result=await f.runtime.invokeGiftRefresh('start',{session_id:'public-shared-cache-before-disconnect',account_generation:0},ctx('101'));
  for(let i=0;i<10&&result.run.state==='running';i++){
    f.advance(1001);result=await f.runtime.invokeGiftRefresh('step',{run_id:result.run.id,session_id:result.run.session_id,account_generation:0},ctx('101'));
  }
  assert.equal(result.run.state,'complete',JSON.stringify(result));
  const cached=await f.runtime.invokeGiftRefresh('start',{session_id:'public-shared-cache-same-wallet-revision',automatic:true,account_generation:0},ctx('101'));
  assert.equal(cached.cache_hit,true);
  assert.equal((await f.runtime.invokeAccount('disconnectPublicWallet',{},ctx('101'))).account.wallet,null);
  const fresh=await f.runtime.invokeGiftRefresh('start',{session_id:'public-shared-cache-after-disconnect',automatic:true,account_generation:0},ctx('101'));
  assert.equal(fresh.cache_hit,false);assert.equal(fresh.run.state,'running');
});
