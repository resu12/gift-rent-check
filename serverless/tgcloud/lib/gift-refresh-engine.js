// Personal-account observations are deliberately separate from market samples,
// ownership proof and enrollment. Cookies/HTML never enter cloud_events.
import {readOwnedGiftScope, createOwnedPriceEngine, OwnedPriceRequestError} from './owned-price-engine.js';
import {createMarketappWebsiteSession} from './marketapp-website-session.js';
import {parseMarketappSessionCookieMetadata} from './marketapp-analytics-refresh.js';
import {extractMarketappGiftsPage, marketappGiftsUrl, MarketappGiftsPageError} from './marketapp-gifts-page.js';
import {fetchBoundedResponse, BoundedResponseError} from './bounded-response.js';
import {giftRefreshSessionKey} from './gift-refresh-storage.js';
import {sha256} from './ton-price-decoder.js';
import {utf8Bytes} from './personal-analytics.js';
import {isOperationalStatusFailure} from './rental-expiry-check.js';
import {withStorageReservation} from './storage-admission.js';

export const GIFT_REFRESH_LIMITS = Object.freeze({attempts:20, duration_ms:120000, timeout_ms:30000, retries:2, cache_ms:300000});
const copy = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => Array.from(sha256(utf8Bytes(value)), b => b.toString(16).padStart(2,'0')).join('');
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{16,160}$/.test(value);
const initial = () => ({version:1,next_run_id:1,run:null,last_complete:null});
const signature = scope => hash(JSON.stringify(scope));
const running = run => run?.state === 'running';
const fail = (message,code=null) => {throw new OwnedPriceRequestError(message,code);};
function strict(input,keys) {if (!object(input) || Object.keys(input).some(key=>!keys.includes(key))) fail('Unsupported personal gift refresh input');}
function counts(run) {
  const rows = Object.values(run.results);
  run.checked = rows.filter(row=>row.checked).length;
  run.updated = rows.filter(row=>row.price).length;
  run.status_updated = rows.filter(row=>row.status).length;
  run.unresolved = run.checked-run.updated; run.status_unresolved = run.checked-run.status_updated;
}
function summary(run,session=null) {
  if (!run) return null;
  const result = Object.fromEntries(['id','scope','wallet','session_id','state','total','checked','updated','unresolved','status_updated','status_unresolved','reason','started_at','completed_at'].map(key=>[key,run[key]]));
  if (Object.hasOwn(run,'scope_signature')) result.scope_signature=typeof run.scope_signature==='string'&&/^[0-9a-f]{64}$/.test(run.scope_signature)?run.scope_signature:null;
  if (Object.hasOwn(run,'check_started_at')) {
    const value=run.check_started_at,parsed=typeof value==='string'?Date.parse(value):NaN;
    result.check_started_at=Number.isFinite(parsed)&&parsed>=0&&iso(parsed)===value?value:null;
  }
  if (session) result.session_id=session;
  return result;
}

export function createGiftRefreshEngine({repository,fetch:request,tonFetch=request,ownerTelegramId,rememberedSessionBox,
  clock=()=>repository.clock(),decodeContract,limits={}}) {
  const cap={...GIFT_REFRESH_LIMITS};
  for (const [key,value] of Object.entries(limits)) {
    if (!Object.hasOwn(cap,key)||!Number.isSafeInteger(value)||value<=0||value>cap[key]) fail('Invalid gift refresh limits'); cap[key]=value;
  }
  let at=0;
  const website=createMarketappWebsiteSession({repository,rememberedSessionBox,ownerTelegramId,clock});
  const owner=String(ownerTelegramId);
  const scopeRevision=()=>repository.giftScopeRevision();
  function authorize(ctx) {if (!/^[1-9]\d*$/.test(owner)||String(ctx?.initData?.user?.id??'')!==owner) fail('Private access denied');}
  async function tick() {
    const value=await clock(); if (!Number.isSafeInteger(value)||value<=0||value>8640000000000000-cap.cache_ms) fail('The trusted server clock is unavailable');
    return at=Math.max(at,value);
  }
  function finish(state,run,result,reason=null) {
    run.state=result; run.reason=reason; run.completed_at=iso(at); run.inflight=null; counts(run);
    if (result==='complete') state.gift_refresh.last_complete={...summary(run),provider:run.provider,scope_signature:run.scope_signature,captured_at:at};
  }
  function bounded(state,run) {
    if (running(run)&&at>=run.deadline) {finish(state,run,'partial','duration_limit');return true;}
    return false;
  }
  async function mutate(change,session=null,storageToken=null) {
    for (let i=0;i<16;i++) {
      const saved=await repository.read(); await tick(); const state=copy(saved.state);
      state.gift_refresh??=initial();
      const result=await change(state.gift_refresh,state,saved.revision)??{};
      if (result.skip) return {state,value:result.value};
      const run=state.gift_refresh.run;
      const event={key:result.key??`gift-refresh:${run?.id??0}:${saved.revision+1}`,state,job:null,records:result.records??[],raw_body:result.raw_body??null,observed_at:iso(at),storage_token:storageToken};
      if (result.website) await website.current(owner,run.wallet,result.website);
      if (!result.unfenced&&run?.wallet_fence!==undefined&&(await repository.marketappSessionFence(owner)).wallet_revision!==run.wallet_fence) fail('The saved wallet changed. Start a new check.','OWNED_PRICE_SCOPE_CHANGED');
      const committed=result.website ? await repository.appendWebsite(saved.revision,event,owner,result.website) : await repository.append(saved.revision,event,result.unfenced?null:run?.wallet_fence??null);
      if (committed) return {state,value:result.value};
      // A changed login must abort; it is not a reason to retry authoritative data
      // through the ordinary (unfenced) append path.
      if (result.website) await website.current(owner,run.wallet,result.website);
    }
    fail('Another request updated gift refresh state. Reload saved data.');
  }
  async function find(state,id) {return state.gift_refresh?.run?.id===id?state.gift_refresh.run:await repository.giftRefreshRun(id);}
  function project(state,run,session=null) {
    const projected=running(run)&&at>=run.deadline?{...run,state:'partial',reason:'duration_limit',completed_at:iso(run.deadline)}:run;
    // Website coverage is not completion: missing fields and rental expiry may
    // still require TON checks. Expose that bounded second stage independently
    // of the saved observation counts, using only this run's exact TON session.
    const candidate=state.owned_prices?.run;
    const inner=run?.stage==='ton'&&candidate&&Number.isSafeInteger(run.ton_run_id)&&sessionId(run.ton_session_id)&&candidate.id===run.ton_run_id&&candidate.session_id===run.ton_session_id?candidate:null;
    const verification=running(projected)&&['website','ton'].includes(run.stage)?{
      stage:run.stage,
      checked:run.stage==='ton'?inner?.checked??0:run.checked,
      total:run.stage==='ton'?run.ton_targets?.length??0:run.total,
      waiting:run.stage==='ton'?Boolean(inner&&['provider_wait','retry_wait'].includes(inner.reason)&&state.owned_prices.next_allowed_at>at):Boolean(run.page_attempts>0&&run.next_allowed_at>at&&!run.inflight),
    }:null;
    return {run:summary(projected,session),next_allowed_at:Math.max(run?.next_allowed_at??0,run?.inflight?.until??0,inner?Math.max(state.owned_prices.next_allowed_at??0,inner.lease_until??0):0),server_time:at,
      ...(verification?{verification}:{}),
      ...(run?{provider:run.provider,cache_hit:run.cache_hit===true,...(run.fallback_reason?{fallback_reason:run.fallback_reason}:{})}: {})};
  }
  async function identify(input) {
    strict(input,['run_id','session_id']);
    if (!sessionId(input.session_id)||!Number.isSafeInteger(input.run_id)||input.run_id<=0||await repository.giftRefreshSession(input.session_id)!==input.run_id) fail('This refresh belongs to another page session. Reload saved data.','OWNED_PRICE_SCOPE_CHANGED');
    return input.run_id;
  }
  async function getStatus(ctx,input={}) {
    authorize(ctx); strict(input,['session_id']); if (input.session_id!==undefined&&!sessionId(input.session_id)) fail('Invalid page-session identifier');
    const saved=await repository.read();await tick();
    const id=input.session_id?await repository.giftRefreshSession(input.session_id):saved.state.gift_refresh?.run?.id;
    return project(saved.state,id?await find(saved.state,id):null,input.session_id);
  }
  async function release(run) {if (run?.website_lease) try {await website.release(owner,run.website_lease);} catch { /* lease expires; no cookie retained */ }}
  async function releaseUnclaimedLease(lease) {
    if (!lease) return;
    try {
      // Acquisition precedes the checkpoint CAS. Stop, a competing update or
      // an append failure can prevent that checkpoint from taking ownership.
      // An append may also succeed before reporting an error, so inspect the
      // durable owner before releasing this newly acquired lease.
      const claimed=(await repository.read()).state.gift_refresh?.run?.website_lease;
      if (claimed?.id===lease.id&&claimed.expires_at===lease.expires_at) return;
      await website.release(owner,lease);
    } catch { /* uncertain ownership stays fenced until the lease expires */ }
  }
  async function start(ctx,input={}) {
    authorize(ctx);strict(input,['session_id','automatic']);
    if (!sessionId(input.session_id)||input.automatic!==undefined&&typeof input.automatic!=='boolean') fail('Invalid page-session identifier');
    let sourceRevision=await scopeRevision();
    let scope=await readOwnedGiftScope(repository,sourceRevision);
    const afterScope=await scopeRevision();
    if (afterScope!==sourceRevision) {sourceRevision=afterScope;scope=await readOwnedGiftScope(repository,sourceRevision);if(await scopeRevision()!==sourceRevision)fail('The gift portfolio is changing. Try again.','OWNED_PRICE_BUSY');}
    await tick();
    let stored=null; const hadSession=scope.wallet?await repository.marketappSession(owner):null;
    if (scope.wallet) stored=await website.read(owner,scope.wallet);
    const walletFence=(await repository.marketappSessionFence(owner)).wallet_revision;
    const scopeSignature=signature(scope);
    let oldLease;
    const outcome=await mutate(async(gifts,state)=>{
      const previous=await repository.giftRefreshSession(input.session_id);
      if (previous!==null) {
        const original=await find(state,previous);
        if (!original||original.wallet!==scope.wallet) fail('This refresh belongs to another wallet. Start a new check.','OWNED_PRICE_SCOPE_CHANGED');
        return {skip:true,value:previous};
      }
      const existing=gifts.run;
      if (running(existing)&&at<existing.deadline) {
        if (existing.wallet!==scope.wallet) fail('A different wallet check is running.','OWNED_PRICE_BUSY');
        return {value:existing.id,key:giftRefreshSessionKey(input.session_id),records:[{kind:'gift_refresh_binding',record:{session_id:input.session_id,run_id:existing.id}}]};
      }
      if (existing?.inflight?.until>at) fail('A gift request is still finishing.','OWNED_PRICE_BUSY');
      const ton=state.owned_prices?.run;
      if (ton?.state==='running'&&ton.deadline>at||ton?.lease_until>at) fail('A gift check is already running.','OWNED_PRICE_BUSY');
      oldLease=existing;
      const cached=gifts.last_complete;
      const cacheHit=input.automatic===true&&cached&&cached.scope_signature===scopeSignature&&at-cached.captured_at>=0&&at-cached.captured_at<cap.cache_ms&&
        (cached.provider!=='marketapp_website'||stored!==null);
      const run=gifts.run={id:gifts.next_run_id++,scope:'portfolio',session_id:input.session_id,wallet:scope.wallet,targets:scope.targets,scope_signature:scopeSignature,
        state:'running',total:scope.targets.length,checked:0,updated:0,unresolved:0,status_updated:0,status_unresolved:0,results:{},reason:null,wallet_fence:walletFence,scope_revision:sourceRevision,
        started_at:iso(at),check_started_at:iso(at),completed_at:null,deadline:at+cap.duration_ms,provider:stored?'marketapp_website':'toncenter',stage:stored?'website':'ton',
        fallback_reason:stored?null:hadSession?'login_expired':'no_login',cache_hit:false,attempts:0,page_attempts:0,pages:0,cursor:null,seen_cursors:[],
        next_allowed_at:0,website_lease:null,inflight:null,session_fence:stored?{generation:stored.fence.generation,wallet_revision:stored.fence.wallet_revision}:null,
        ton_targets:stored?null:scope.targets.map(row=>row.nft_address),ton_run_id:null,ton_session_id:'gifts_'+hash(input.session_id).slice(0,48)};
      if (cacheHit) {
        for (const key of ['checked','updated','unresolved','status_updated','status_unresolved','provider']) run[key]=cached[key];
        run.check_started_at=cached.check_started_at??cached.started_at;
        run.state='complete';run.completed_at=iso(at);run.cache_hit=true;run.reason=null;run.fallback_reason=null;
      } else if (!run.wallet) finish(state,run,'partial','wallet_not_configured');
      else if (!run.total) finish(state,run,'complete','no_known_portfolio');
      return {value:run.id,key:giftRefreshSessionKey(input.session_id),records:[{kind:'gift_refresh_binding',record:{session_id:input.session_id,run_id:run.id}}]};
    });
    await release(oldLease);
    return project(outcome.state,await find(outcome.state,outcome.value),input.session_id);
  }
  async function scopeCurrent(run) {
    if ((await repository.marketappSessionFence(owner)).wallet_revision!==run.wallet_fence) fail('The saved wallet changed. Start a new check.','OWNED_PRICE_SCOPE_CHANGED');
    const revision=await scopeRevision();if(revision===run.scope_revision)return;
    const current=await readOwnedGiftScope(repository,revision);
    if (current.wallet!==run.wallet||run.targets.some(target=>!current.targets.some(row=>row.nft_address===target.nft_address&&row.collection_address===target.collection_address))) fail('The saved wallet or gift scope changed. Start a new check.','OWNED_PRICE_SCOPE_CHANGED');
  }
  async function fallback(id,reason,storageToken=null) {
    let old;
    const result=await mutate((gifts,state)=>{
      const run=gifts.run;if(run?.id!==id||!running(run))return{skip:true};
      old=copy(run);run.stage='ton';run.inflight=null;run.next_allowed_at=0;run.fallback_reason=reason;
      if (!run.pages) run.provider='toncenter';
      run.ton_targets=run.targets.filter(row=>!run.results[row.nft_address]?.price||!run.results[row.nft_address]?.status||run.results[row.nft_address]?.needs_expiry).map(row=>row.nft_address);
      if (!run.ton_targets.length) finish(state,run,'complete');
      else if (bounded(state,run)||run.attempts>=cap.attempts) finish(state,run,'partial',at>=run.deadline?'duration_limit':'invocation_limit');
    },null,storageToken);
    await release(old);return result;
  }
  async function stop(ctx,input={}) {
    authorize(ctx);const id=await identify(input);let old;
    const result=await mutate((gifts,state)=>{
      if(gifts.run?.id!==id||!running(gifts.run))return{skip:true};
      old=copy(gifts.run);finish(state,gifts.run,'partial','stopped_by_you');
      // Preserve a live HTTP fence until its deadline; its late response will
      // be discarded and a new session cannot overlap it.
      gifts.run.inflight=old.inflight;
      if(old.stage==='ton'&&state.owned_prices?.run?.session_id===old.ton_session_id) {
        state.owned_prices.run.state='partial';state.owned_prices.run.reason='stopped_by_you';state.owned_prices.run.completed_at=iso(at);
      }
      return {unfenced:true};
    });
    if (!old?.inflight || old.inflight.until<=at) await release(old);
    return project(result.state,await find(result.state,id),input.session_id);
  }
  // The existing TON engine retains its ledger, holder recheck and decoder.
  // Its evidence and the wrapper checkpoint are committed in the same event.
  function tonEngine(run) {
    const remaining=Math.max(1,cap.attempts-run.attempts),duration=Math.max(1,run.deadline-at);
    const proxy={...repository,append:async(expected,event)=>{
      const wrapper=event.state.gift_refresh?.run,inner=event.state.owned_prices?.run;
      if (wrapper?.id!==run.id||wrapper.stage!=='ton'||!running(wrapper)||inner?.session_id!==run.ton_session_id) return false;
      if (inner.wallet!==wrapper.wallet) fail('The saved wallet changed. Start a new check.','OWNED_PRICE_SCOPE_CHANGED');
      await scopeCurrent(wrapper);
      if ((await repository.marketappSessionFence(owner)).wallet_revision!==wrapper.wallet_fence) fail('The saved wallet changed. Start a new check.','OWNED_PRICE_SCOPE_CHANGED');
      // Scope loading during inner Start must not extend the original refresh
      // deadline. Both stages share the same bounded provider-request window.
      inner.deadline=Math.min(inner.deadline,wrapper.deadline);
      wrapper.ton_run_id=inner.id;
      event.records=event.records.filter(envelope=>envelope.kind!=='owned_price'||!wrapper.results[envelope.record.nft_address]?.website_price);
      // Keep adverse evidence from earlier verification stages even if a later
      // HTTP failure replaces the batch with bare request-failure envelopes.
      for (const pending of inner.pending??[]) {
        const result=wrapper.results[pending.nft_address];
        if (result?.needs_expiry&&(pending.reason||pending.owned_status?.verified===false)) {
          result.expiry_unsafe_reason=pending.reason??pending.owned_status.reason;
        }
      }
      for (const envelope of event.records) {
        if (!['owned_price','owned_status'].includes(envelope.kind)) continue;
        const row=envelope.record,id=row.nft_address;if (!wrapper.ton_targets.includes(id)) return false;
        const result=wrapper.results[id]??={checked:true,price:false,status:false};result.checked=true;
        if (envelope.kind==='owned_price') result.price=row.verified===true;
        else {
          const supplementary=result.needs_expiry&&result.website_status_observed_at;
          if (supplementary) {
            row.check_purpose='rental_expiry';row.personal_status_observed_at=result.website_status_observed_at;
            row.status_fallback_allowed=!result.expiry_unsafe_reason&&isOperationalStatusFailure(row);
          }
          if (!row.status_fallback_allowed) result.status=row.verified===true;
          result.needs_expiry=false;
        }
      }
      counts(wrapper);
      if (inner.state!=='running') finish(event.state,wrapper,inner.state==='complete'?'complete':inner.state,inner.reason);
      event.key=`gift-refresh:${run.id}:${expected+1}`;
      return repository.append(expected,event,wrapper.wallet_fence);
    }};
    // Limits are frozen relative to the original wrapper, rather than renewed
    // with each step (inner attempts count cumulatively).
    return createOwnedPriceEngine({repository:proxy,fetch:tonFetch,ownerTelegramId,clock,decodeContract,targetAddresses:run.ton_targets,
      limits:{invocation_attempts:remaining,duration_ms:Math.min(120000,duration)}});
  }
  async function tonStep(ctx,run,input) {
    await tick();if (at>=run.deadline||run.attempts>=cap.attempts) {
      const ended=await mutate((gifts,state)=>{if(gifts.run?.id===run.id&&running(gifts.run))finish(state,gifts.run,'partial',at>=run.deadline?'duration_limit':'invocation_limit');});
      return project(ended.state,await find(ended.state,run.id),input.session_id);
    }
    const engine=tonEngine(run);
    if (!run.ton_run_id) await engine.start(ctx,{session_id:run.ton_session_id});
    else await engine.step(ctx,{run_id:run.ton_run_id});
    const saved=await repository.read();await tick();return project(saved.state,await find(saved.state,run.id),input.session_id);
  }
  async function step(ctx,input={}) {
    authorize(ctx);const id=await identify(input);
    const saved=await repository.read();await tick();let run=await find(saved.state,id);
    if (!run) fail('Unknown personal gift refresh');
    if (!running(run)) return project(saved.state,run,input.session_id);
    await scopeCurrent(run);await tick();
    if (at>=run.deadline||run.stage==='website'&&run.deadline-at<1000) {const ended=await mutate((gifts,state)=>{if(gifts.run?.id===id)finish(state,gifts.run,'partial','duration_limit');});await release(run);return project(ended.state,await find(ended.state,id),input.session_id);}
    if (run.stage==='ton') return tonStep(ctx,run,input);
    if (run.inflight?.until>at||run.next_allowed_at>at) return project(saved.state,run,input.session_id);
    return await withStorageReservation(repository,{kind:'website_gifts'},token=>websiteStep(input,id,saved,run,token));
  }
  async function websiteStep(input,id,saved,run,storageToken) {
    const admitted=change=>mutate(change,null,storageToken);
    let stored=await website.read(owner,run.wallet);
    if (!stored||stored.fence.generation!==run.session_fence?.generation||stored.fence.wallet_revision!==run.session_fence?.wallet_revision) {
      const result=await fallback(id,stored?'no_login':'login_expired',storageToken);return project(result.state,await find(result.state,id),input.session_id);
    }
    let lease=run.website_lease,newLease=null;
    if (!lease||lease.expires_at<=at) newLease=lease=await website.acquire(owner,'gifts_'+hash(run.session_id),{durationMs:Math.max(1,Math.min(150000,run.deadline-at))});
    if (!lease) return {...project(saved.state,run,input.session_id),next_allowed_at:at+1000};
    let reserved;
    try {
      reserved=await admitted((gifts,state,revision)=>{
        const current=gifts.run;
        if(current?.id!==id||!running(current)||current.stage!=='website'||current.inflight?.until>at||current.next_allowed_at>at)return{skip:true};
        if (bounded(state,current)) return {};
        if(current.attempts>=cap.attempts||current.page_attempts>=cap.retries)return {value:{fallback:true}};
        current.website_lease=lease;current.inflight={id:'gifts_'+id+'_'+(revision+1),until:current.deadline,request_deadline:Math.min(current.deadline,at+cap.timeout_ms)};
        return {value:copy(current)};
      });
    } catch(error) {await releaseUnclaimedLease(newLease);throw error;}
    if (!reserved.value||reserved.value.fallback) await releaseUnclaimedLease(newLease);
    if (reserved.value?.fallback) {const result=await fallback(id,'website_unavailable',storageToken);return project(result.state,await find(result.state,id),input.session_id);}
    if (!reserved.value) return project(reserved.state,await find(reserved.state,id),input.session_id);
    const snapshot=reserved.value;
    const allowance=await website.reserve(owner,lease,snapshot.inflight.id);
    if (!allowance.allowed) {
      if (allowance.reason==='daily') {const result=await fallback(id,'request_limit',storageToken);return project(result.state,await find(result.state,id),input.session_id);}
      const result=await admitted(gifts=>{if(gifts.run?.inflight?.id!==snapshot.inflight.id)return{skip:true};gifts.run.inflight=null;gifts.run.next_allowed_at=Date.parse(allowance.retry_at)||at+1000;});
      return project(result.state,await find(result.state,id),input.session_id);
    }
    const attempted=await admitted(gifts=>{if(gifts.run?.inflight?.id!==snapshot.inflight.id||!running(gifts.run))return{skip:true};gifts.run.attempts++;gifts.run.page_attempts++;return{value:true};});
    if (!attempted.value) return project(attempted.state,await find(attempted.state,id),input.session_id);
    try {await website.current(owner,run.wallet,stored);await tick();}
    catch {const result=await fallback(id,'login_expired',storageToken);return project(result.state,await find(result.state,id),input.session_id);}
    let page=null,response=null,failure=null,retryAt=null;
    const url=marketappGiftsUrl(snapshot.cursor);
    try {
      const received=await fetchBoundedResponse(request,url,{method:'GET',redirect:'manual',headers:{Cookie:stored.value.cookie,Accept:snapshot.cursor?'application/json':'text/html',...(snapshot.cursor?{'X-Requested-With':'XMLHttpRequest'}:{})}},
        {maxBytes:1048576,timeoutMs:Math.max(1,Math.min(cap.timeout_ms,snapshot.inflight.request_deadline-at)),deadlineAt:Math.min(snapshot.inflight.request_deadline,stored.value.expires_at),clock:tick});
      response=received.response;await tick();
      if(response.redirected||response.url&&response.url!==url) failure='website_unavailable';
      else if ([401,403].includes(response.status)||response.status>=300&&response.status<400) {failure='login_expired';await website.invalidate(owner,stored);}
      else if(response.status===429||[500,502,503,504].includes(response.status)) {
        failure='transient';const header=response.headers?.get?.('Retry-After');let delay=1000*2**snapshot.page_attempts;
        if(header) {if(/^\d+(?:\.\d+)?$/.test(header))delay=Math.max(delay,Math.ceil(Number(header)*1000));else {const date=Date.parse(header);if(!Number.isFinite(date))failure='website_unavailable';else delay=Math.max(delay,date-at);}}
        retryAt=at+delay;if(!Number.isSafeInteger(retryAt)||retryAt>8640000000000000) {failure='website_unavailable';retryAt=null;}
      } else if(response.status!==200) failure='website_unavailable';
      else {
        const type=response.headers?.get?.('Content-Type')?.split(';')[0]?.trim().toLowerCase();
        if(type!==(snapshot.cursor?'application/json':'text/html')) failure='unsupported_response';
        else page=extractMarketappGiftsPage(received.body,{wallet:snapshot.wallet,sourceUrl:url,continuation:snapshot.cursor!==null});
        if(page) {
          const latest=(await repository.read()).state.gift_refresh?.run;
          if(latest?.id===id&&running(latest)&&latest.inflight?.id===snapshot.inflight.id) stored=await website.rotate(owner,run.wallet,stored,parseMarketappSessionCookieMetadata(response.headers?.get?.('Set-Cookie'),at,false,true));
          else page=null;
        }
      }
    } catch(error) {
      failure=error instanceof MarketappGiftsPageError?'unsupported_response':error instanceof BoundedResponseError&&['network_error','request_timeout'].includes(error.code)?'transient':'website_unavailable';
      if(error?.authenticationInvalid) {failure='login_expired';await website.invalidate(owner,stored);}
    }
    await tick();
    if(failure==='transient') {retryAt??=at+1000*2**snapshot.page_attempts;await website.defer(owner,lease,retryAt);}
    if(page&&(page.cursor!==null&&(page.cursor===snapshot.cursor||snapshot.seen_cursors.includes(page.cursor)))) {page=null;failure='unsupported_response';}
    if(page) await scopeCurrent(snapshot);
    const observed=iso(at),targets=new Map(snapshot.targets.map(row=>[row.nft_address,row]));
    const result=await admitted((gifts,state)=>{
      const current=gifts.run;
      if(current?.id!==id||!running(current)||current.inflight?.id!==snapshot.inflight.id)return{skip:true};
      current.inflight=null;
      if(at>=current.deadline) {finish(state,current,'partial','duration_limit');return{};}
      if(!page) {
        if(failure==='transient'&&current.page_attempts<cap.retries&&retryAt<current.deadline&&current.attempts<cap.attempts) {current.next_allowed_at=retryAt;return{};}
        return{value:{fallback:failure==='transient'?'website_unavailable':failure??'website_unavailable'}};
      }
      const records=[];let newItems=0;
      for(const [index,item] of page.items.entries()) {
        const target=targets.get(item.nft_address);if(!target)continue;
        if(!current.results[item.nft_address])newItems++;
        current.results[item.nft_address]={checked:true,price:item.price_per_day!==null&&item.currency==='GRAM',website_price:item.price_per_day!==null&&item.currency==='GRAM',
          status:['for_rent','rented'].includes(item.rental_state),needs_expiry:item.rental_state==='rented',
          ...(item.rental_state==='rented'?{website_status_observed_at:observed}:{})};
        const {name,...evidence}=item;
        records.push({kind:'personal_gift',key:`personal-gift:${id}:${current.pages}:${index}`,observed_at:observed,record:{...evidence,collection_address:target.collection_address,wallet:current.wallet,
          provider:'marketapp_website',semantics_version:'marketapp-my-nfts-v1',scope:'my_nfts',authenticated:true,ownership_verified:false,visible:true}});
      }
      // A changed cursor with an overlapping page is legitimate. An identical
      // page with a fresh cursor indicates a stalled traversal, not completion.
      const fingerprint=hash(JSON.stringify(page.items));
      if(!newItems&&page.cursor!==null&&fingerprint===current.last_page_fingerprint)return{value:{fallback:'unsupported_response'}};
      current.last_page_fingerprint=fingerprint;current.pages++;current.page_attempts=0;current.cursor=page.cursor;
      if(snapshot.cursor!==null)current.seen_cursors.push(snapshot.cursor);counts(current);current.next_allowed_at=at+1000;
      if(page.complete) {
        current.stage='ton';current.next_allowed_at=0;
        current.ton_targets=current.targets.filter(row=>!current.results[row.nft_address]?.price||!current.results[row.nft_address]?.status||current.results[row.nft_address]?.needs_expiry).map(row=>row.nft_address);
        if(!current.ton_targets.length)finish(state,current,'complete');
      }
      return {website:stored,records,raw_body:JSON.stringify({provider:'marketapp_website',scope:'my_nfts',wallet:current.wallet,observed_at:observed,page:current.pages,items:records.map(row=>row.record),complete:page.complete})};
    });
    let final=result;
    if(result.value?.fallback)final=await fallback(id,result.value.fallback,storageToken);
    if(final.state.gift_refresh.run?.stage==='ton'||!running(final.state.gift_refresh.run))await release(snapshot);
    return project(final.state,await find(final.state,id),input.session_id);
  }
  return {getStatus,start,step,stop};
}
