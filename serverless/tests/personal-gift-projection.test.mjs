import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {SUPPORTED_CODE_HASH,MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';

const address=n=>`0:${n.toString(16).padStart(64,'0')}`;
const wallet=address(1),nft=address(2),collection=address(3),holder=address(4);
const old='2026-10-11T10:00:00Z',recent='2026-10-11T11:00:00Z',later='2026-10-11T11:30:00Z',now=Date.parse('2026-10-11T12:00:00Z');
const expiry=now/1000+3600;
const seed=[{kind:'settings',record:{wallet}},{kind:'portfolio',observed_at:old,record:{nft_address:nft,collection_address:collection,
  is_portfolio:true,name:'Known gift',category:'portfolio',state:'rented',ui_state:'rented',display_state:'Rented',observed_at:old,
  ownership_observed_at:old,price_per_day:'0.35',price_unit:'GRAM',price_source:'Marketapp user view',price_observed_at:old,
  rental_until:new Date(expiry*1000).toISOString(),rental_until_unix_seconds:expiry,membership_sources:['ton_verified'],
  automatic_membership:true,verification_method:'supported_contract',holding_contract:holder}}];
const personal=(extra={},observed_at=recent)=>({kind:'personal_gift',observed_at,record:{nft_address:nft,collection_address:collection,wallet,
  provider:'marketapp_website',semantics_version:'marketapp-my-nfts-v1',scope:'my_nfts',authenticated:true,ownership_verified:false,
  price_per_day:'0.39',currency:'GRAM',rental_state:'rented',rental_until:null,rental_remaining_display:'1d 2h',visible:true,...extra}});
const ton=(extra={},observed_at=recent)=>({kind:'owned_status',observed_at,record:{nft_address:nft,collection_address:collection,wallet,
  provider:'toncenter',semantics_version:'ton-owned-rental-status-v1',verified:true,reason:'verified_rental_status',owner:wallet,nft,
  observed_owner:holder,holding_contract:holder,marketplace:MARKETAPP_OPERATOR,code_hash:SUPPORTED_CODE_HASH,data_hash:'b'.repeat(64),
  code_hash_verified:true,data_hash_verified:true,decoder_version:'fixture-v1',role:1,status:1,renter:address(5),counterpart:address(6),
  rental_state:'rented',rental_until:expiry,rental_until_unit:'Unix seconds',nft_last_transaction_lt:'100',account_last_transaction_lt:'99',
  checked_at:observed_at,rechecked_at:observed_at,...extra}});
const ownedPrice=(price='410000000',observed_at=later)=>({kind:'owned_price',observed_at,record:{nft_address:nft,collection_address:collection,
  owner:wallet,verified:true,configured_price_per_day_raw:price,checked_at:observed_at}});
const project=rows=>buildCloudDashboard(rows,{}, {now});
const gift=rows=>project([...seed,...rows]).gifts[0];

test('current contract rental start survives only simultaneous matching personal status or a newer verified TON status',()=>{
  const terms={rental_duration:172800,rental_duration_unit:'seconds'},expected=new Date((expiry-172800)*1000).toISOString();
  for(const rows of [[ton(terms),personal()],[personal(),ton(terms)],[personal({},old),ton(terms)]]) {
    const result=gift(rows);
    assert.equal(result.current_rental_started_at,expected);
    assert.equal(result.current_rental_start_source,'verified_contract');
  }
  for(const rows of [[ton(terms),personal({},later)],[ton(terms),personal({rental_state:'for_rent'})],
    [ton(terms),personal({rental_state:'unknown'})],[personal({current_rental_started_at:old,current_rental_start_source:'verified_contract'})]]) {
    const result=gift(rows);
    assert.equal(result.current_rental_started_at,null);
    assert.equal(result.current_rental_start_source,null);
  }
});

test('later website refresh keeps a verified rental-start fact while current exact start and expiry are cleared',()=>{
  const terms={rental_duration:172800,rental_duration_unit:'seconds'},expected=new Date((expiry-172800)*1000).toISOString();
  for(const change of [{rental_state:'rented'}, {rental_state:'for_rent'}, {rental_state:'unknown'}]) {
    const result=gift([ton(terms),personal(change,later)]);
    assert.equal(result.last_verified_rental_started_at,expected);
    assert.equal(result.last_verified_rental_start_source,'verified_contract');
    assert.equal(result.current_rental_started_at,null);
    assert.equal(result.current_rental_start_source,null);
    assert.equal(result.rental_until,null);
    assert.equal(result.rental_history.last_rental_at,null);
  }
  const websiteOnly=gift([personal({last_verified_rental_started_at:old,last_verified_rental_start_source:'verified_contract'})]);
  assert.equal(websiteOnly.last_verified_rental_started_at,null);
  assert.equal(websiteOnly.last_verified_rental_start_source,null);
});

test('account observation refreshes personal price/status without becoming market sample, traits, ownership or membership',()=>{
  const before=gift([]),after=gift([personal({attributes:[{trait_type:'Model',value:'Untrusted model'}]})]);
  assert.equal(after.price_per_day,'0.39');assert.equal(after.price_source,'Marketapp account');assert.equal(after.price_observed_at,recent);
  assert.equal(after.state,'rented');assert.equal(after.ui_state,'rented');assert.equal(after.status_source,'Marketapp account');
  assert.equal(after.status_is_historical,false);assert.equal(after.status_provenance.ownership_verified,false);
  assert.equal(after.status_provenance.rental_remaining_display,'1d 2h');assert.equal(after.rental_until,null);assert.equal(after.rental_until_unix_seconds,null);
  assert.equal(after.rental_remaining_display,'1d 2h');assert.equal(after.rental_remaining_observed_at,recent);
  assert.equal(after.previous_rental_until,before.rental_until);assert.equal(after.previous_rental_until_unix_seconds,expiry);
  for(const key of ['membership_sources','automatic_membership','verification_method','holding_contract','ownership_observed_at','observed_at','model','backdrop'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(after.pricing,before.pricing);assert.equal(project([...seed,personal()]).pricing.fresh_peer_count,0);
});
test('website-only gifts cannot enroll, discovery candidates stay unresolved and missing observations leave saved values intact',()=>{
  const missing=gift([]);assert.deepEqual(gift([personal({nft_address:address(99)})]),missing);
  assert.equal(project([seed[0],personal()]).gifts.length,0);
  const candidate=seed.map(row=>row.kind==='portfolio'?{...row,record:{...row.record,is_portfolio:false,automatic_membership:false,category:'unresolved'}}:row);
  const result=project([...candidate,personal()]);assert.equal(result.summary.portfolio_count,0);assert.equal(result.gifts[0].price_per_day,'0.35');
});
test('wrong-wallet, collection, origin, scope, authentication, expiry and future rows cannot update saved personal gifts',()=>{
  const before=gift([]);
  for(const change of [{wallet:address(99)},{collection_address:address(99)},{nft_address:'opaque-id'},{wallet:'opaque-wallet'},
    {provider:'marketapp_api'},{semantics_version:'unknown'},{scope:'my_rented'},{authenticated:false},{ownership_verified:true},{visible:false},
    {rental_until:expiry},{rental_state:'listed_for_sale'}])assert.deepEqual(gift([personal(change)]),before,JSON.stringify(change));
  assert.deepEqual(gift([personal({},'2030-01-01T00:00:00Z')]),before);
});
test('collection conflicts never gain current account status or change collection identity',()=>{
  const conflict={kind:'metadata',observed_at:old,record:{nft_address:nft,collection_address:address(99)}};
  const before=gift([conflict]),after=gift([conflict,personal()]);
  assert.equal(after.collection_conflict,true);assert.equal(after.collection_address,collection);assert.equal(after.is_portfolio,true);
  assert.deepEqual(after,before);
});
test('new website availability supersedes old rented label without inventing current TON ownership or expiry',()=>{
  const after=gift([personal({rental_state:'for_rent'})]);assert.equal(after.state,'unknown');assert.equal(after.ui_state,'for_rent');
  assert.equal(after.display_state,'For rent');assert.equal(after.market_observed_at,recent);assert.equal(after.ownership_observed_at,old);
  assert.equal(after.status_is_historical,false);assert.equal(after.previous_rental_state,'rented');assert.equal(after.rental_until,null);
  assert.equal(project([...seed,personal({rental_state:'for_rent'})]).summary.for_rent_count,1);
});
test('website unknown status clears current badge/expiry but retains prior dated evidence',()=>{
  const after=gift([personal({rental_state:'unknown'})]);assert.equal(after.state,'unknown');assert.equal(after.ui_state,null);
  assert.equal(after.status_is_historical,true);assert.equal(after.previous_rental_state,'rented');assert.equal(after.previous_status_observed_at,old);
  assert.equal(after.previous_rental_until_unix_seconds,expiry);assert.equal(after.rental_until_unix_seconds,null);assert.equal(after.price_per_day,'0.39');
});
test('missing, unsupported-currency or malformed price keeps historical value while valid status can update',()=>{
  for(const change of [{price_per_day:null,currency:null},{currency:'TON'},{currency:'USDT'},{price_per_day:0.39},{price_per_day:'NaN'},
    {price_per_day:'-1'},{price_per_day:'1e-9'},{price_per_day:'0.0000000001'}]) {
    const after=gift([personal({...change,rental_state:'for_rent'})]);assert.equal(after.price_per_day,'0.35');assert.equal(after.price_is_historical,true);
    assert.equal(after.price_observed_at,old);assert.equal(after.status_source,'Marketapp account');assert.equal(after.ui_state,'for_rent');
  }
  assert.equal(gift([personal({price_per_day:'0.000000001'})]).price_per_day,'0.000000001');
  assert.equal(gift([personal({price_per_day:'0'})]).price_per_day,'0');
});
test('simultaneous personal variants remain unresolved and identical replay never conflicts',()=>{
  const after=gift([personal(),personal({price_per_day:'0.4',rental_state:'for_rent'})]);
  assert.equal(after.state,'unknown');assert.equal(after.status_check_reason,'conflicting_account_status');assert.equal(after.price_per_day,'0.35');assert.equal(after.price_is_historical,true);
  const replay=gift([personal(),personal()]);assert.equal(replay.price_per_day,'0.39');assert.equal(replay.state,'rented');assert.equal(replay.status_is_historical,false);
});
test('newer TON observations win independently for asking price and status, regardless of envelope order',()=>{
  const idle=ton({rental_state:'idle_rental_contract',role:0,status:0,renter:null,counterpart:null,rental_until:0},later);
  for(const rows of [[personal(),ownedPrice(),idle],[idle,ownedPrice(),personal()]]) {
    const after=gift(rows);assert.equal(after.price_per_day,'0.41');assert.equal(after.price_source,'Observed contract terms');
    assert.equal(after.state,'idle_rental_contract');assert.equal(after.status_source,'TON Center');assert.equal(after.status_observed_at,later);
  }
  const after=gift([ownedPrice('410000000',old),ton({},old),personal({rental_state:'for_rent'})]);
  assert.equal(after.price_per_day,'0.39');assert.equal(after.status_source,'Marketapp account');assert.equal(after.ui_state,'for_rent');
});
test('contradictory simultaneous TON and account statuses are uncertain without a borrowed exact countdown',()=>{
  for(const [tonRow,webRow] of [[ton(),personal({rental_state:'for_rent'})],[ton({rental_state:'idle_rental_contract',role:0,status:0,renter:null,counterpart:null,rental_until:0}),personal()]]) {
    const after=gift([tonRow,webRow]);assert.equal(after.state,'unknown');assert.equal(after.ui_state,null);assert.equal(after.status_is_historical,true);
    assert.equal(after.status_check_reason,'conflicting_provider_status');assert.equal(after.rental_until,null);assert.equal(after.rental_until_unix_seconds,null);
    assert.match(after.uncertainties.join(' '),/TON and Marketapp/);
  }
  const consistent=gift([ton(),personal()]);assert.equal(consistent.state,'rented');assert.equal(consistent.status_is_historical,false);assert.equal(consistent.rental_until_unix_seconds,expiry);
});
test('simultaneous compatible rental observations retain only independently validated TON expiry in either order',()=>{
  for(const rows of [[ton(),personal()],[personal(),ton()]]) {
    const after=gift(rows);assert.equal(after.state,'rented');assert.equal(after.status_source,'Marketapp account');assert.equal(after.status_observed_at,recent);
    assert.equal(after.rental_until_unix_seconds,expiry);assert.equal(after.rental_until,new Date(expiry*1000).toISOString());
    assert.equal(after.rental_expiry_provenance.provider,'toncenter');assert.equal(after.rental_expiry_provenance.holding_contract,holder);
    assert.equal(after.rental_expiry_provenance.rental_until,expiry);assert.equal(after.status_provenance.rental_until,null);
    assert.equal(after.rental_remaining_display,'1d 2h');assert.equal(after.rental_remaining_observed_at,recent);
  }
});
test('simultaneous invalid or conflicting TON evidence cannot supply either a precise expiry or an account countdown',()=>{
  for(const change of [{verified:false,reason:'owner_mismatch'},{code_hash:'0'.repeat(64)},{code_hash_verified:false},{data_hash_verified:false},
    {holding_contract:address(99)},{owner:address(99)},{nft:address(99)},{role:0},{status:0},{renter:null},{rechecked_at:'invalid'},
    {rental_until_unit:'unknown'},{rental_until:now/1000},{rental_until:expiry+0.5}]) {
    const after=gift([ton(change),personal()]);assert.equal(after.rental_until,null,JSON.stringify(change));assert.equal(after.rental_until_unix_seconds,null,JSON.stringify(change));
    assert.equal(after.rental_expiry_provenance,null,JSON.stringify(change));assert.equal(after.rental_remaining_display,null,JSON.stringify(change));
    assert.equal(after.rental_remaining_observed_at,null,JSON.stringify(change));
  }
  const after=gift([ton(),ton({rental_until:expiry+1}),personal()]);
  assert.equal(after.state,'unknown');assert.equal(after.rental_until_unix_seconds,null);assert.equal(after.rental_remaining_display,null);
});
test('a newer account rental label invalidates older precise expiry without turning rounded text into an expiry',()=>{
  const after=gift([ton({},old),personal()]);assert.equal(after.state,'rented');assert.equal(after.status_source,'Marketapp account');
  assert.equal(after.rental_until,null);assert.equal(after.rental_until_unix_seconds,null);assert.equal(after.rental_expiry_provenance,null);
  assert.equal(after.previous_rental_until_unix_seconds,expiry);assert.equal(after.rental_remaining_display,'1d 2h');assert.equal(after.rental_remaining_observed_at,recent);
});
test('seeded TON source, matching timestamp and rounded fields never establish verified exact or rounded evidence',()=>{
  const forged=seed.map(row=>row.kind==='portfolio'?{...row,record:{...row.record,status_source:'TON Center',status_is_historical:false,
    status_observed_at:recent,rental_expiry_provenance:{provider:'toncenter'},rental_remaining_display:'30d',rental_remaining_observed_at:recent}}:row);
  const plain=project(forged).gifts[0];assert.equal(plain.rental_remaining_display,null);assert.equal(plain.rental_remaining_observed_at,null);assert.equal(plain.rental_expiry_provenance,null);
  const after=project([...forged,personal()]).gifts[0];assert.equal(after.state,'rented');assert.equal(after.rental_until,null);assert.equal(after.rental_until_unix_seconds,null);
  assert.equal(after.rental_expiry_provenance,null);assert.equal(after.rental_remaining_display,'1d 2h');
});
test('later incompatible TON statuses clear rounded account countdown evidence',()=>{
  for(const change of [{rental_state:'idle_rental_contract',role:0,status:0,renter:null,counterpart:null,rental_until:0},
    {rental_state:'held_directly',observed_owner:wallet},{rental_until:now/1000},{verified:false,reason:'owner_mismatch'}]) {
    const after=gift([personal(),ton(change,later)]);assert.equal(after.rental_remaining_display,null,JSON.stringify(change));
    assert.equal(after.rental_remaining_observed_at,null,JSON.stringify(change));
  }
  const compatible=gift([personal(),ton({},later)]);assert.equal(compatible.rental_until_unix_seconds,expiry);
  assert.equal(compatible.status_source,'TON Center');assert.equal(compatible.status_observed_at,later);
  assert.equal(compatible.rental_remaining_display,'1d 2h');assert.equal(compatible.rental_remaining_observed_at,recent);
});
test('rounded account labels require unambiguous current rented evidence and preserve the raw status provenance',()=>{
  for(const rows of [[personal({rental_state:'unknown'})],[personal({rental_state:'for_rent'})],
    [personal(),personal({rental_state:'for_rent'})],[personal({wallet:address(99)})],
    [personal(),personal({rental_remaining_display:'1d 3h'})],[personal({rental_remaining_display:null})],
    [personal({rental_remaining_display:' '})],[personal({rental_remaining_display:12})],
    [personal({rental_remaining_display:'x'.repeat(65)})],[personal({rental_remaining_display:'1d\n2h'})]]) {
    const after=gift(rows);assert.equal(after.rental_remaining_display,null);assert.equal(after.rental_remaining_observed_at,null);
  }
  const after=gift([personal(),personal({rental_remaining_display:'1d 3h'})]);assert.equal(after.state,'rented');assert.equal(after.status_provenance.rental_remaining_display,'1d 3h');
  assert.equal(after.rental_until,null);assert.equal(after.rental_until_unix_seconds,null);
});
test('latest representation is ordered with microsecond precision while prior account price remains dated historical evidence',()=>{
  const after=gift([personal({price_per_day:'0.39'},'2026-10-11T11:00:00.000001Z'),personal({price_per_day:null,currency:null,rental_state:'for_rent'},'2026-10-11T11:00:00.000002Z')]);
  assert.equal(after.price_per_day,'0.39');assert.equal(after.price_is_historical,true);assert.equal(after.ui_state,'for_rent');
  assert.equal(after.price_observed_at,'2026-10-11T11:00:00.000001Z');
  assert.equal(after.status_observed_at,'2026-10-11T11:00:00.000002Z');
});
test('an older valid account price cannot erase a newer failed TON check',()=>{
  const failed={kind:'owned_price',observed_at:later,record:{nft_address:nft,collection_address:collection,verified:false,reason:'owner_mismatch',checked_at:later}};
  const after=gift([personal(),failed]);assert.equal(after.price_per_day,'0.39');assert.equal(after.price_is_historical,true);
  assert.equal(after.price_checked_at,later);assert.equal(after.price_check_reason,'owner_mismatch');assert.equal(after.price_observed_at,recent);
});

test('later compatible TON idle status retains earlier website availability with its original date',()=>{
  const idle=ton({rental_state:'idle_rental_contract',role:0,status:0,renter:null,counterpart:null,rental_until:0},later);
  for(const rows of [[personal({rental_state:'for_rent',price_per_day:null,currency:null}),idle],[idle,personal({rental_state:'for_rent',price_per_day:null,currency:null})]]) {
    const after=gift(rows);assert.equal(after.state,'idle_rental_contract');assert.equal(after.ui_state,'for_rent');assert.equal(after.display_state,'For rent');
    assert.equal(after.status_source,'TON Center');assert.equal(after.status_observed_at,later);assert.equal(after.status_is_historical,false);
    assert.equal(after.ownership_observed_at,later);assert.equal(after.status_provenance.provider,'toncenter');
    assert.equal(after.market_observed_at,recent);assert.equal(after.visibility_observed_at,recent);assert.equal(after.visibility_is_historical,true);
    assert.equal(after.visibility_provenance.ownership_verified,false);assert.equal(after.rental_until,null);
    assert.equal(project([...seed,...rows]).summary.for_rent_count,1);
  }
  const failed=ton({verified:false,reason:'owner_mismatch'},later);
  for(const rows of [[personal({rental_state:'for_rent'}),failed],[personal({rental_state:'for_rent'}),ton({},later)]])assert.notEqual(gift(rows).ui_state,'for_rent');
  const conflicting=[personal({rental_state:'for_rent'}),personal(),idle];assert.notEqual(gift(conflicting).ui_state,'for_rent');
});

test('only a linked no-evidence supplementary expiry failure preserves a rented website observation',()=>{
  const failed=(extra={},observed_at=later)=>({kind:'owned_status',observed_at,record:{nft_address:nft,collection_address:collection,wallet,
    provider:'toncenter',semantics_version:'ton-owned-rental-status-v1',verified:false,reason:'retry_exhausted',rental_state:'unknown',
    check_purpose:'rental_expiry',personal_status_observed_at:recent,status_fallback_allowed:true,...extra}});
  for(const rows of [[personal(),failed()],[failed(),personal()],[personal(),failed({},recent)]]) {
    const after=gift(rows);assert.equal(after.state,'rented');assert.equal(after.ui_state,'rented');assert.equal(after.status_source,'Marketapp account');
    assert.equal(after.status_observed_at,recent);assert.equal(after.ownership_observed_at,old);assert.equal(after.rental_until,null);
    assert.equal(after.rental_expiry_check_reason,'retry_exhausted');assert.equal(after.status_is_historical,false);
  }
  for(const extra of [{check_purpose:undefined},{status_fallback_allowed:false},{personal_status_observed_at:old},
    {reason:'owner_mismatch'},{reason:'unsupported_code_hash'},{observed_owner:holder},{owner:wallet},{code_hash:SUPPORTED_CODE_HASH}]) {
    const after=gift([personal(),failed(extra)]);assert.equal(after.state,'unknown',JSON.stringify(extra));assert.equal(after.rental_expiry_check_reason,undefined);
  }
  const conflicting=gift([personal(),personal({rental_state:'for_rent'}),failed()]);assert.equal(conflicting.state,'unknown');
  const idle=ton({rental_state:'idle_rental_contract',role:0,status:0,renter:null,counterpart:null,rental_until:0},later);
  const newer=gift([personal(),failed({},'2026-10-11T11:45:00Z'),idle]);assert.equal(newer.state,'idle_rental_contract');assert.equal(newer.status_source,'TON Center');
  const recovered=gift([personal(),failed(),ton({},'2026-10-11T11:45:00Z')]);
  assert.equal(recovered.state,'rented');assert.equal(recovered.rental_until_unix_seconds,expiry);
  assert.equal(recovered.rental_expiry_check_reason,undefined);assert.doesNotMatch(recovered.uncertainties.join(' '),/supplementary TON expiry/);
});
