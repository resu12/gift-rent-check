import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicWebsiteFetch} from '../tgcloud/lib/public-provider-budget.js';
import {marketappAnalyticsUrl} from '../tgcloud/lib/marketapp-analytics-refresh.js';
import {marketappGiftsUrl} from '../tgcloud/lib/marketapp-gifts-page.js';
const wallet='0:'+ '11'.repeat(32), other='0:'+ '22'.repeat(32),home='https://marketapp.org/';
function fixture() {
  const account={user_id:'42',status:'active',generation:3,wallet,wallet_revision:4,wallet_verified_at:100};
  const calls=[],repository={ensureAccount:async()=>{},publicAccount:async()=>account};
  let receive=async()=>({status:200});
  const request=createPublicWebsiteFetch({repository,userId:'42',wallet,accountGeneration:3,walletRevision:4,
    fetch:async(...args)=>{calls.push(args);return receive();}});
  return {account,calls,request,onFetch:fn=>receive=fn};
}
test('fixed own-wallet analytics, gifts and proof authentication preserve safe session cookies',async()=>{
  const f=fixture();
  await f.request(home,{method:'GET',headers:{Accept:'text/html'}});
  for(const url of [marketappAnalyticsUrl(wallet,30),marketappAnalyticsUrl(wallet,365),marketappGiftsUrl(),marketappGiftsUrl('saved&cursor/+')])
    await f.request(url,{method:'GET',headers:{Cookie:'session=a.b_c-d=+/:'},redirect:'follow'});
  await f.request(home+'auth/checkTonProofAuth/',{method:'POST',headers:{Cookie:'session=abc','Content-Type':'application/json',Origin:home.slice(0,-1),Referer:home},body:'{}'});
  assert.equal(f.calls.length,6);assert.ok(f.calls.every(([,options])=>options.redirect==='manual'));
});
test('reject unrelated wallet, origin, mutation, malformed cursor and credential headers before fetching',async()=>{
  const f=fixture(),get={method:'GET',headers:{Cookie:'session=abc'}};
  for(const url of [marketappAnalyticsUrl(other,30),home+'auth/logout/',home+'rent/',marketappGiftsUrl()+'&cursor=%ZZ',marketappGiftsUrl()+'&cursor=x&extra=1',home+'@evil.invalid/',home+'#fragment','https://evil.invalid/'])
    await assert.rejects(f.request(url,get));
  for(const headers of [{Cookie:'session=x; other=y'},{Cookie:'session=x',Authorization:'api-key'},[['Cookie','session=x'],['cookie','session=y']],{Cookie:'session=x',Origin:'https://evil.invalid'}])
    await assert.rejects(f.request(marketappGiftsUrl(),{method:'GET',headers}));
  await assert.rejects(f.request(home,get));
  await assert.rejects(f.request(marketappGiftsUrl(),{...get,body:'{}'}));
  await assert.rejects(f.request(home+'auth/checkTonProofAuth/',{...get,method:'POST',body:'{}'}));
  assert.equal(f.calls.length,0);
});
test('account deletion, generation changes and wallet revocation fence both sides of network await',async()=>{
  for(const change of [{status:'deleted'},{generation:4},{wallet:other},{wallet_revision:5},{wallet_verified_at:null},{user_id:'43'}]) {
    const before=fixture();Object.assign(before.account,change);
    await assert.rejects(before.request(home,{method:'GET'}),e=>e.code==='PUBLIC_WALLET_CHANGED');assert.equal(before.calls.length,0);
    const during=fixture();during.onFetch(async()=>{Object.assign(during.account,change);return {status:200};});
    await assert.rejects(during.request(home,{method:'GET'}),e=>e.code==='PUBLIC_WALLET_CHANGED');assert.equal(during.calls.length,1);
  }
});
