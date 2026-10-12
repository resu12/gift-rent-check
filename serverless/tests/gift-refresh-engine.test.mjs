import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createGiftRefreshEngine} from '../tgcloud/lib/gift-refresh-engine.js';
import {createMarketappWebsiteSession} from '../tgcloud/lib/marketapp-website-session.js';
import {createMarketappRememberedSessionBox} from '../tgcloud/lib/marketapp-remembered-session-box.js';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {SUPPORTED_CODE_HASH,MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';
import {syntheticGiftsHead,syntheticGiftsContinuation,syntheticGiftAddress as nft,syntheticWallet as wallet,syntheticCursor} from './fixtures/marketapp-gifts-page-fixture.mjs';
import {streamedBody} from './fixtures/http-response.mjs';
const owner='12345',ctx={initData:{user:{id:12345}}},collection=`0:${'44'.repeat(32)}`;
const cookie='session=synthetic-private-website-cookie',bodySecret='synthetic-private-page-body-do-not-store';
const holder=nftAddress=>`0:${(BigInt('0x'+nftAddress.split(':')[1])+1000n).toString(16).padStart(64,'0')}`;
function response(url,body,{status=200,type='text/html',headers={},...rest}={}){
  const values=Object.fromEntries(Object.entries({'Content-Type':type,...headers}).map(([key,value])=>[key.toLowerCase(),value]));
  return {url,status,headers:{get:key=>values[key.toLowerCase()]??null},body:streamedBody(typeof body==='string'?body:JSON.stringify(body)),...rest};
}
function fixture(t,{count=2,remembered=true,pages=[],limits={},fetchEdit=null,tonEdit=null,decodeEdit=null}={}){
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE owned_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT NOT NULL,source_sequence INTEGER NOT NULL);
    CREATE TABLE owned_refresh_sessions(session_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,source_sequence INTEGER NOT NULL);
    CREATE TABLE owned_refresh_index(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,nonce_counter INTEGER NOT NULL DEFAULT 0,cookie_version INTEGER NOT NULL DEFAULT 0,wallet TEXT,wallet_revision INTEGER,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE marketapp_website_gates(scope_key TEXT PRIMARY KEY,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_allowed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE marketapp_website_requests(request_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,attempted_at INTEGER NOT NULL);`);
  const db={async get(sql,params={}){return database.prepare(sql).get(params)||null;},async all(sql,params={}){return database.prepare(sql).all(params);},async run(sql,params={}){return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  let at=Date.parse('2026-10-11T12:00:00.000Z');const requests=[],tonRequests=[],repository=createCloudRepository(db),box=createMarketappRememberedSessionBox('11'.repeat(32));
  const session=createMarketappWebsiteSession({repository,rememberedSessionBox:box,ownerTelegramId:owner,clock:async()=>at});
  const records=[{kind:'settings',record:{wallet}},...Array.from({length:count},(_,index)=>({kind:'portfolio',key:nft(index),observed_at:new Date(at).toISOString(),record:{nft_address:nft(index),collection_address:collection,is_portfolio:true,membership_sources:['csv']}}))];
  database.prepare('INSERT INTO cloud_events VALUES(1,?,?,?,?,?,?,?)').run('seed',JSON.stringify({version:2,next_job_id:1,job:null,attempts:[],next_allowed_at:0}),null,null,JSON.stringify(records),null,new Date(at).toISOString());
  const fetch=async(url,options)=>{requests.push({url,options,at});if(fetchEdit)return fetchEdit(url,options,{now:()=>at,advance:ms=>at+=ms});const page=pages.shift();if(!page)throw new Error(bodySecret);if(page instanceof Error)throw page;return response(url,page.body??page,{type:options.headers.Accept,headers:page.headers??{},status:page.status??200});};
  const tonFetch=async(url,options)=>{
    tonRequests.push({url,options,at});if(tonEdit)return tonEdit(url,options,{now:()=>at,advance:ms=>at+=ms});
    const uri=new URL(url),ids=uri.searchParams.getAll('address');
    const body=uri.pathname==='/api/v3/accountStates'?{accounts:ids.map(id=>({address:id,status:'active',last_transaction_lt:'99',code_boc:'synthetic-code',data_boc:'synthetic-data'}))}:{nft_items:ids.map(id=>({address:id,collection_address:collection,owner_address:holder(id),init:true,last_transaction_lt:'100'}))};
    return response(url,body,{type:'application/json'});
  };
  const decodeContract=(_account,target)=>({verified:true,owner:wallet,nft:target,holding_contract:holder(target),marketplace:MARKETAPP_OPERATOR,code_hash:SUPPORTED_CODE_HASH,data_hash:'b'.repeat(64),code_hash_verified:true,data_hash_verified:true,decoder_version:'synthetic-test-v1',account_last_transaction_lt:'99',configured_price_per_day_raw:'170000000',price_per_day_raw:'170000000',rental_state:'rented',role:1,status:1,renter:nft(9990),counterpart:nft(9991),rental_until:Math.floor(at/1000)+7200,rental_duration:86400});
  const engine=createGiftRefreshEngine({repository,fetch,tonFetch,ownerTelegramId:owner,rememberedSessionBox:box,clock:async()=>at,
    decodeContract:decodeEdit?(_account,target)=>decodeEdit(decodeContract(_account,target),target):decodeContract,limits});
  const ready=(async()=>{if(remembered){const fence=await repository.marketappSessionFence(owner);await session.remember(owner,wallet,fence,cookie,at,at+86400000,fence.cookie_version);}})();
  return {engine,repository,database,requests,tonRequests,session,ready,now:()=>at,advance:ms=>at+=ms,clock:async()=>at,records:()=>repository.records()};
}
async function begin(f,id='synthetic-personal-session-1',extra={}){await f.ready;return f.engine.start(ctx,{session_id:id,...extra});}
async function next(f,started){return await f.engine.step(ctx,{run_id:started.run.id,session_id:started.run.session_id});}
async function complete(f,started,max=80){let state=started;for(let i=0;i<max&&state.run.state==='running';i++){state=await next(f,state);f.advance(1000);}assert.notEqual(state.run.state,'running','mock workflow must settle within its saved budget');return state;}
const head=(options={})=>syntheticGiftsHead({count:1,more:true,...options,cardOptions:{state:'for_rent',...options.cardOptions}});
const tail=(options={})=>syntheticGiftsContinuation({count:1,offset:1,...options,cardOptions:{state:'for_rent',...options.cardOptions}});

test('two verified personal pages refresh only existing gifts without enrollment or market sample pollution',async t=>{
  const f=fixture(t,{pages:[head(),tail({count:2})]}),started=await begin(f);assert.equal(started.provider,'marketapp_website');
  const expectedSignature=createHash('sha256').update(JSON.stringify({wallet,targets:[0,1].map(index=>({nft_address:nft(index),collection_address:collection})).sort((a,b)=>a.nft_address.localeCompare(b.nft_address))})).digest('hex');
  assert.equal(started.run.scope_signature,expectedSignature,'summary exposes the frozen exact identities using the existing scope hash');
  const done=await complete(f,started);assert.equal(done.run.state,'complete');assert.equal(done.run.total,2);assert.equal(done.run.updated,2);assert.equal(done.run.status_updated,2);
  assert.equal(done.run.scope_signature,expectedSignature);
  assert.equal(f.requests.length,2);assert.equal(f.tonRequests.length,0);
  assert.ok(f.requests.every(value=>value.options.method==='GET'&&value.options.headers.Cookie===cookie&&new URL(value.url).origin==='https://marketapp.org'));
  assert.equal(f.requests[0].options.headers.Authorization,undefined);assert.equal(f.requests[1].options.headers['X-Requested-With'],'XMLHttpRequest');
  const saved=await f.records();assert.equal(saved.filter(row=>row.kind==='portfolio').length,2);assert.equal(saved.filter(row=>row.kind==='personal_gift').length,2);assert.equal(saved.filter(row=>['listing','history','ownership'].includes(row.kind)).length,0);
  assert.ok(saved.filter(row=>row.kind==='personal_gift').every(row=>row.record.ownership_verified===false&&row.record.collection_address===collection));
  const dashboard=buildCloudDashboard(saved,{}, {now:f.now()});assert.equal(dashboard.gifts.length,2);assert.ok(dashboard.gifts.every(gift=>gift.price_per_day==='0.19'&&gift.price_source==='Marketapp account'));
  const persisted=JSON.stringify(f.database.prepare('SELECT state_json,records_json,raw_body FROM cloud_events').all());
  for(const sensitive of [cookie,'Wallet.init','js-grid-card','synthetic-nonce','<html','<script'])assert.equal(persisted.includes(sensitive),false);
  assert.equal(JSON.stringify(done).includes(cookie),false);
});

test('page sessions replay and join exactly once while automatic openings cache and manual refresh bypasses cache',async t=>{
  const f=fixture(t,{pages:[head(),tail(),head(),tail()]}),first=await begin(f);const initial=await next(f,first);
  const joined=await f.engine.start(ctx,{session_id:'synthetic-joined-session-2',automatic:true});assert.equal(joined.run.id,first.run.id);assert.equal(joined.run.session_id,'synthetic-joined-session-2');
  f.advance(1000);const done=await complete(f,initial);assert.equal(done.run.state,'complete');const before=f.requests.length;
  assert.equal(done.run.check_started_at,first.run.started_at);
  assert.equal((await f.engine.start(ctx,{session_id:first.run.session_id})).run.id,first.run.id);
  const cached=await f.engine.start(ctx,{session_id:'synthetic-cached-session-3',automatic:true});assert.equal(cached.run.state,'complete');assert.equal(cached.cache_hit,true);assert.equal(cached.run.checked,2);assert.equal(f.requests.length,before);
  assert.equal(cached.run.check_started_at,done.run.check_started_at,'the source check date is not renewed by a cache copy');
  assert.equal(cached.run.scope_signature,done.run.scope_signature);
  assert.notEqual(cached.run.started_at,cached.run.check_started_at,'lifecycle and actual source dates are independent');
  f.advance(60000);
  const recached=await f.engine.start(ctx,{session_id:'synthetic-cached-session-5',automatic:true});
  assert.equal(recached.cache_hit,true);assert.equal(recached.run.check_started_at,first.run.started_at);
  assert.equal(recached.run.scope_signature,first.run.scope_signature);
  assert.notEqual(recached.run.started_at,cached.run.started_at);assert.equal(f.requests.length,before);assert.equal(f.tonRequests.length,0);
  const manual=await f.engine.start(ctx,{session_id:'synthetic-manual-session-4'});assert.equal(manual.run.state,'running');assert.equal(manual.cache_hit,false);assert.notEqual(manual.run.id,cached.run.id);
  assert.equal(manual.run.check_started_at,manual.run.started_at);assert.notEqual(manual.run.check_started_at,first.run.started_at);
  await complete(f,manual);assert.equal(f.requests.length,before+2);
  assert.equal((await f.engine.getStatus(ctx,{session_id:first.run.session_id})).run.id,first.run.id);assert.equal((await f.engine.getStatus(ctx,{session_id:'synthetic-never-used-session'})).run,null);
});

test('failed continuation preserves its committed cursor and gift observations then checks only the unresolved subset on TON',async t=>{
  const f=fixture(t,{pages:[head(),{body:JSON.stringify({h:`<p>${bodySecret}</p>`,has_more:'wrong'})}]}),started=await begin(f);
  const first=await next(f,started),savedBefore=await f.repository.read();assert.equal(savedBefore.state.gift_refresh.run.pages,1);assert.equal(savedBefore.state.gift_refresh.run.cursor,syntheticCursor);
  f.advance(1000);const partial=await next(f,first),savedAfter=await f.repository.read();assert.equal(savedAfter.state.gift_refresh.run.pages,1);assert.equal(savedAfter.state.gift_refresh.run.cursor,syntheticCursor);assert.equal(savedAfter.state.gift_refresh.run.stage,'ton');
  assert.equal(partial.fallback_reason,'unsupported_response');assert.deepEqual(savedAfter.state.gift_refresh.run.ton_targets,[nft(1)]);
  const done=await complete(f,partial);assert.equal(done.run.state,'complete');assert.equal(done.run.updated,2);assert.equal(done.run.status_updated,2);
  assert.equal(f.tonRequests.length,3);assert.deepEqual(f.tonRequests.filter(value=>new URL(value.url).pathname==='/api/v3/nft/items').map(value=>new URL(value.url).searchParams.getAll('address')),[[nft(1)],[nft(1)]]);
  const persisted=JSON.stringify(f.database.prepare('SELECT state_json,records_json,raw_body FROM cloud_events').all());assert.equal(persisted.includes(bodySecret),false);assert.equal(persisted.includes(cookie),false);
  const records=await f.records();assert.equal(records.filter(row=>row.kind==='personal_gift').length,1);assert.equal(records.filter(row=>row.kind==='owned_price').length,1);
});

test('without remembered login TON refreshes the saved portfolio without an active wallet connection or website call',async t=>{
  const f=fixture(t,{remembered:false}),started=await begin(f);assert.equal(started.provider,'toncenter');assert.equal(started.fallback_reason,'no_login');
  const done=await complete(f,started);assert.equal(done.run.state,'complete');assert.equal(done.run.updated,2);assert.equal(done.run.status_updated,2);assert.equal(f.requests.length,0);assert.equal(f.tonRequests.length,3);
  const records=await f.records();assert.equal(records.filter(row=>row.kind==='portfolio').length,2);assert.equal(records.filter(row=>row.kind==='owned_status').length,2);
});

test('rented personal gifts receive targeted TON expiry without replacing their personal asking prices',async t=>{
  const f=fixture(t,{pages:[syntheticGiftsHead({count:2,more:false})]}),started=await begin(f);
  assert.deepEqual(started.verification,{stage:'website',checked:0,total:2,waiting:false});
  const web=await next(f,started);
  assert.equal(web.run.checked,2,'all website gifts have been read but expiry still needs checking');
  assert.equal(web.run.state,'running');
  assert.deepEqual(web.verification,{stage:'ton',checked:0,total:1,waiting:false});
  const done=await complete(f,web);
  assert.equal(done.verification,undefined,'terminal results do not claim a live verification stage');
  assert.equal(done.run.state,'complete');assert.equal(f.requests.length,1);assert.equal(f.tonRequests.length,3);
  assert.deepEqual(f.tonRequests.filter(value=>new URL(value.url).pathname==='/api/v3/nft/items').map(value=>new URL(value.url).searchParams.getAll('address')),[[nft(1)],[nft(1)]]);
  const records=await f.records();assert.equal(records.filter(row=>row.kind==='owned_price').length,0,'website prices must not be replaced by configured contract terms');
  assert.equal(records.filter(row=>row.kind==='owned_status').length,1);
  const dashboard=buildCloudDashboard(records,{}, {now:f.now()}),rented=dashboard.gifts.find(gift=>gift.id===nft(1)||gift.nft_address===nft(1));assert.ok(rented);assert.equal(rented.price_source,'Marketapp account');assert.equal(rented.state,'rented');assert.equal(typeof rented.rental_until_unix_seconds,'number');
});

test('supplemental progress advances by committed TON batches independently of website coverage',async t=>{
  const f=fixture(t,{count:51,pages:[syntheticGiftsHead({count:51,more:false,cardOptions:{state:'rented'}})]});
  let result=await next(f,await begin(f));
  assert.equal(result.run.checked,51);
  for(let step=0;step<4;step++) {result=await next(f,result);f.advance(1000);}
  assert.equal(result.run.state,'running');assert.equal(result.run.checked,51);
  assert.deepEqual(result.verification,{stage:'ton',checked:50,total:51,waiting:false});
  const status=await f.engine.getStatus(ctx,{session_id:result.run.session_id});
  assert.deepEqual(status.verification,result.verification);
  const done=await complete(f,result);assert.equal(done.run.state,'complete');
});

test('TON cooldown is visible while retryable and settles when it exceeds the original deadline',async t=>{
  for(const delay of [5000,180000]) {
    const f=fixture(t,{count:1,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'rented'}})],tonEdit:async(_url,_options,time)=>{
      throw Object.assign(new Error('Provider asked us to wait'),{code:'PUBLIC_PROVIDER_WAIT',reason:'provider_wait',readyAt:time.now()+delay});
    }});
    let result=await next(f,await begin(f));
    result=await next(f,result); // Establish the TON run.
    result=await next(f,result); // Receive provider cooldown, no successful batch.
    assert.equal(result.run.checked,1);assert.equal(result.run.updated,1,'website prices remain saved');
    if(delay<120000) {
      assert.equal(result.run.state,'running');
      assert.deepEqual(result.verification,{stage:'ton',checked:0,total:1,waiting:true});
      assert.equal(result.next_allowed_at,f.now()+delay);
      const before=f.tonRequests.length;await next(f,result);assert.equal(f.tonRequests.length,before,'pacing prevents another provider request');
    } else {
      assert.equal(result.run.state,'partial');assert.equal(result.run.reason,'provider_wait');
      assert.equal(result.verification,undefined);
    }
  }
});

test('unrelated TON sessions cannot supply progress or waits for a personal gift refresh',async t=>{
  const f=fixture(t,{count:1,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'rented'}})]});
  let result=await next(f,await begin(f));result=await next(f,result);
  const saved=await f.repository.read();saved.state.owned_prices.run.session_id='synthetic-other-ton-session';
  saved.state.owned_prices.run.checked=1;saved.state.owned_prices.run.reason='provider_wait';saved.state.owned_prices.next_allowed_at=f.now()+60000;
  await f.repository.append(saved.revision,{key:'unrelated-ton-session',state:saved.state,job:null,records:[],observed_at:new Date(f.now()).toISOString()});
  const status=await f.engine.getStatus(ctx,{session_id:result.run.session_id});
  assert.deepEqual(status.verification,{stage:'ton',checked:0,total:1,waiting:false});assert.equal(status.next_allowed_at,0);
  f.advance(120000);assert.equal((await f.engine.getStatus(ctx,{session_id:result.run.session_id})).verification,undefined);
});

test('TON setup time cannot extend the original website refresh deadline',async t=>{
  const f=fixture(t,{count:1,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'rented'}})]});
  const web=await next(f,await begin(f));
  const before=f.now(),records=f.repository.dashboardSeedRecords;
  f.repository.dashboardSeedRecords=async(...args)=>{f.advance(3000);return records(...args);};
  await next(f,web);
  assert.ok(f.now()>=before+3000,'the scope read must actually consume setup time');
  const {state}=await f.repository.read();
  assert.equal(state.owned_prices.run.deadline,state.gift_refresh.run.deadline);
});

test('archived gift summaries remain readable after operational runs are reset',async t=>{
  const f=fixture(t,{count:1,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'rented'}})]});
  const done=await complete(f,await begin(f)),saved=await f.repository.read();
  const archived={...done.run,provider:'marketapp_website',stage:'ton'};
  saved.state.gift_refresh.run=null;saved.state.owned_prices.run=null;
  await f.repository.append(saved.revision,{key:'reset-operational-runs',state:saved.state,job:null,records:[],observed_at:new Date(f.now()).toISOString()});
  f.repository.giftRefreshRun=async id=>id===done.run.id?archived:null;
  const status=await f.engine.getStatus(ctx,{session_id:done.run.session_id});
  assert.equal(status.run.state,'complete');assert.equal(status.verification,undefined);assert.equal(status.next_allowed_at,0);
});

for(const failedStage of ['before','accounts','after'])for(const failure of ['network','malformed']) {
  test(`supplementary ${failedStage} ${failure} failure keeps fresh Marketapp Rented status and an unknown countdown`,async t=>{
    let stage='before';
    const f=fixture(t,{count:1,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'rented'}})],tonEdit:async(url)=>{
      const uri=new URL(url),ids=uri.searchParams.getAll('address'),current=uri.pathname==='/api/v3/accountStates'?'accounts':stage;
      if(current===failedStage) {if(failure==='network')throw new Error(bodySecret);return response(url,'{malformed',{type:'application/json'});}
      const body=current==='accounts'?{accounts:ids.map(id=>({address:id,status:'active',last_transaction_lt:'99',code_boc:'synthetic-code',data_boc:'synthetic-data'}))}
        :{nft_items:ids.map(id=>({address:id,collection_address:collection,owner_address:holder(id),init:true,last_transaction_lt:'100'}))};
      stage=current==='before'?'accounts':'after';return response(url,body,{type:'application/json'});
    }});
    const started=await begin(f),web=await next(f,started),before=buildCloudDashboard(await f.records(),{}, {now:f.now()}).gifts[0];
    assert.equal(before.state,'rented');f.advance(1000);const done=await complete(f,web),rows=await f.records();
    const after=buildCloudDashboard(rows,{}, {now:f.now()}).gifts[0];
    assert.equal(done.run.status_updated,1);assert.equal(done.run.status_unresolved,0);
    assert.equal(after.state,'rented');assert.equal(after.ui_state,'rented');assert.equal(after.status_source,'Marketapp account');
    assert.equal(after.status_observed_at,before.status_observed_at);assert.equal(after.ownership_observed_at,before.ownership_observed_at);
    assert.equal(after.rental_until,null);assert.equal(after.rental_until_unix_seconds,null);
    assert.equal(after.rental_expiry_check_reason,failure==='network'?'retry_exhausted':'invalid_response');
    assert.match(after.uncertainties.join(' '),/supplementary TON expiry/);
    const evidence=rows.find(row=>row.kind==='owned_status').record;
    assert.equal(evidence.verified,false);assert.equal(evidence.status_fallback_allowed,true);
    assert.equal(evidence.personal_status_observed_at,before.status_observed_at);
    assert.equal(rows.filter(row=>row.kind==='portfolio').length,1);assert.equal(f.requests.length,1);
  });
}

test('supplementary ownership mismatches stay unresolved, including a later recheck failure',async t=>{
  for(const recheckFails of [false,true]) {
    let itemRequests=0;
    const f=fixture(t,{count:1,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'rented'}})],
      decodeEdit:decoded=>({...decoded,owner:nft(999)}),tonEdit:async(url)=>{
        const uri=new URL(url),ids=uri.searchParams.getAll('address'),accounts=uri.pathname==='/api/v3/accountStates';
        if(!accounts&&++itemRequests>1&&recheckFails)throw new Error(bodySecret);
        return response(url,accounts?{accounts:ids.map(id=>({address:id,status:'active',last_transaction_lt:'99',code_boc:'synthetic-code',data_boc:'synthetic-data'}))}
          :{nft_items:ids.map(id=>({address:id,collection_address:collection,owner_address:holder(id),init:true,last_transaction_lt:'100'}))},{type:'application/json'});
      }});
    await complete(f,await begin(f));const rows=await f.records(),after=buildCloudDashboard(rows,{}, {now:f.now()}).gifts[0];
    assert.equal(after.state,'unknown');assert.equal(after.ui_state,null);assert.equal(after.rental_until_unix_seconds,null);
    assert.equal(rows.find(row=>row.kind==='owned_status').record.status_fallback_allowed,false);
    assert.equal(after.rental_expiry_check_reason,undefined);
  }
});

test('website and fallback share the original attempt and duration budget',async t=>{
  const f=fixture(t,{count:401,pages:[syntheticGiftsHead({count:1,more:false,cardOptions:{state:'for_rent'}})]}),started=await begin(f),done=await complete(f,started);
  assert.equal(done.run.state,'partial');assert.equal(done.run.reason,'invocation_limit');assert.ok(f.requests.length+f.tonRequests.length<=20);assert.equal(f.requests.length+f.tonRequests.length,20);
  const expired=fixture(t,{pages:[head()],limits:{duration_ms:2000}}),run=await begin(expired);expired.advance(2000);
  const stopped=await next(expired,run);assert.equal(stopped.run.state,'partial');assert.equal(stopped.run.reason,'duration_limit');assert.equal(expired.requests.length,0);assert.equal(expired.tonRequests.length,0);
});

test('less than one second left finishes safely rather than attempting an invalid website lease',async t=>{
  const f=fixture(t,{pages:[head()],limits:{duration_ms:2000}}),started=await begin(f);f.advance(1500);
  const done=await next(f,started);assert.equal(done.run.state,'partial');assert.equal(done.run.reason,'duration_limit');assert.equal(f.requests.length,0);
});

test('wrong account, arbitrary input and other browser session cannot reach either provider',async t=>{
  const f=fixture(t),started=await begin(f);
  for(const method of ['start','getStatus','step','stop'])await assert.rejects(f.engine[method]({initData:{user:{id:99999}}},{}),/Private access denied/);
  for(const extra of [{wallet},{nft_address:nft(0)},{provider:'toncenter'},{url:'https://example.invalid'}])await assert.rejects(f.engine.start(ctx,{session_id:'synthetic-invalid-input',...extra}),/Unsupported/);
  await assert.rejects(f.engine.step(ctx,{run_id:started.run.id,session_id:'synthetic-unrelated-session'}),error=>error.code==='OWNED_PRICE_SCOPE_CHANGED');assert.equal(f.requests.length,0);assert.equal(f.tonRequests.length,0);
});

test('an expired remembered cookie falls back without exposing encrypted session state or prompting for a wallet',async t=>{
  const f=fixture(t);await f.ready;f.advance(86400000);const started=await begin(f),done=await complete(f,started);assert.equal(started.provider,'toncenter');assert.equal(started.fallback_reason,'login_expired');assert.equal(done.run.state,'complete');assert.equal(f.requests.length,0);
  assert.equal(f.database.prepare('SELECT ciphertext FROM marketapp_analytics_sessions WHERE owner_id=?').get(owner).ciphertext,null);assert.equal(JSON.stringify(done).includes(cookie),false);
});

test('a two-day Retry-After is retained for website traffic while this bounded job falls back to TON',async t=>{
  const f=fixture(t,{pages:[{body:bodySecret,status:429,headers:{'Retry-After':'172800'}}]}),started=await begin(f);
  const fallback=await next(f,started);assert.equal(fallback.fallback_reason,'website_unavailable');
  const gates=f.database.prepare("SELECT next_allowed_at FROM marketapp_website_gates WHERE scope_key='service'").get();assert.equal(gates.next_allowed_at,f.now()+172800000);
  const done=await complete(f,fallback);assert.equal(done.run.state,'complete');assert.equal(f.requests.length,1);assert.equal(f.tonRequests.length,3);
  const gate=await f.repository.acquireMarketappWebsiteLease(owner,'synthetic-after-throttle',f.now());
  const blocked=await f.repository.reserveMarketappWebsiteRequest(owner,gate,'synthetic-request-after-throttle',f.now());assert.equal(blocked.allowed,false);assert.ok(blocked.retry_after_seconds>171000);
  assert.equal(JSON.stringify(f.database.prepare('SELECT raw_body,state_json FROM cloud_events').all()).includes(bodySecret),false);
});

test('a timerless stalled provider cannot overlap another request after its 30-second validation timeout',async t=>{
  let resolveRequest;const waiting=new Promise(resolve=>resolveRequest=resolve);
  const f=fixture(t,{fetchEdit:async()=>waiting}),started=await begin(f);
  const globals={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,AbortController:globalThis.AbortController};
  try{
    globalThis.setTimeout=undefined;globalThis.clearTimeout=undefined;globalThis.AbortController=undefined;
    const pending=next(f,started);while(!f.requests.length)await new Promise(resolve=>setImmediate(resolve));
    f.advance(31000);const second=await next(f,started);assert.equal(second.run.state,'running');assert.equal(f.requests.length,1);assert.equal(f.tonRequests.length,0);
    assert.equal(second.next_allowed_at,Date.parse(started.run.started_at)+120000);
    const stopped=await f.engine.stop(ctx,{run_id:started.run.id,session_id:started.run.session_id});assert.equal(stopped.run.state,'partial');
    await assert.rejects(f.engine.start(ctx,{session_id:'synthetic-start-during-stall'}),error=>error.code==='OWNED_PRICE_BUSY');
    resolveRequest(response(f.requests[0].url,head().body));const settled=await pending;assert.equal(settled.run.state,'partial');assert.equal((await f.records()).filter(row=>row.kind==='personal_gift').length,0);
  }finally{Object.assign(globalThis,globals);resolveRequest?.(response('https://marketapp.org/',bodySecret));}
});

test('wallet changes before TON fallback starts reject without accessing either provider or enrolling another wallet',async t=>{
  const f=fixture(t,{remembered:false}),started=await begin(f),saved=await f.repository.read(),changed=`0:${'99'.repeat(32)}`;
  await f.repository.append(saved.revision,{key:'wallet-change',state:saved.state,records:[{kind:'settings',record:{wallet:changed}}],observed_at:new Date(f.now()).toISOString()});
  await assert.rejects(next(f,started),error=>error.code==='OWNED_PRICE_SCOPE_CHANGED');assert.equal(f.requests.length,0);assert.equal(f.tonRequests.length,0);
  assert.equal((await f.records()).filter(row=>row.kind==='portfolio').length,2);
});

test('wallet changes and restores during an in-flight TON check discard its authoritative evidence',async t=>{
  let resolveRequest;const waiting=new Promise(resolve=>resolveRequest=resolve);
  const f=fixture(t,{remembered:false,tonEdit:async()=>waiting}),started=await begin(f),innerStarted=await next(f,started);
  const pending=next(f,innerStarted);while(!f.tonRequests.length)await new Promise(resolve=>setImmediate(resolve));
  let saved=await f.repository.read();await f.repository.append(saved.revision,{key:'wallet-change-during-ton',state:saved.state,records:[{kind:'settings',record:{wallet:`0:${'99'.repeat(32)}`}}],observed_at:new Date(f.now()).toISOString()});
  saved=await f.repository.read();await f.repository.append(saved.revision,{key:'wallet-restore-during-ton',state:saved.state,records:[{kind:'settings',record:{wallet}}],observed_at:new Date(f.now()).toISOString()});
  assert.ok((await f.repository.marketappSessionFence(owner)).wallet_revision>(await f.repository.read()).state.gift_refresh.run.wallet_fence);
  resolveRequest(response(f.tonRequests[0].url,{nft_items:[0,1].map(index=>({address:nft(index),collection_address:collection,owner_address:holder(nft(index)),init:true,last_transaction_lt:'100'}))},{type:'application/json'}));
  await assert.rejects(pending,error=>error.code==='OWNED_PRICE_SCOPE_CHANGED'||/saved wallet|scope changed/.test(error.message));
  const records=await f.records();assert.equal(records.filter(row=>['owned_price','owned_status'].includes(row.kind)).length,0);assert.equal(f.tonRequests.length,1);
  await assert.rejects(next(f,innerStarted),error=>error.code==='OWNED_PRICE_SCOPE_CHANGED');assert.equal(f.tonRequests.length,1);
});
