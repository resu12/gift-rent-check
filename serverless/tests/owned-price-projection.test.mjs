import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';

const address = n => `0:${n.toString(16).padStart(64, '0')}`;
const wallet = address(1), nft = address(2), collection = address(3);
const old = '2026-10-09T10:00:00Z', recent = '2026-10-09T11:00:00Z', now = Date.parse('2026-10-09T12:00:00Z');
const seed = [
  {kind:'settings',record:{wallet}},
  {kind:'portfolio',observed_at:old,record:{nft_address:nft,collection_address:collection,is_portfolio:true,state:'rented',display_state:'Rented',observed_at:old,price_observed_at:old,price_per_day:'0.35',price_source:'Marketapp user view',price_unit:'GRAM',membership_sources:['ton_verified']}},
  ...[2,4,5].map(id => ({kind:'listing',observed_at:old,record:{identity:address(id),collection_address:collection,source_json:{nft_address:address(id),nft_name:`Gift ${id}`,owner:wallet,price_per_day:'350000000',attributes:[],min_duration:1,max_duration:30,discount_per_day:0,listed_at:null}}})),
];
const observation = (extra = {}, observed_at = recent) => ({kind:'owned_price',observed_at,record:{nft_address:nft,collection_address:collection,owner:wallet,verified:true,reason:'verified_rental_owner',configured_price_per_day_raw:'390000000',price_per_day_raw:'170000000',...extra}});
const view = rows => buildCloudDashboard(rows,{source:'listings'},{now});

test('a configured TON asking price changes only current price evidence, not ownership or comparison samples', () => {
  const before = view(seed), after = view([...seed,observation()]);
  const gift = after.gifts[0];
  assert.equal(gift.price_per_day,'0.39');
  assert.equal(gift.price_source,'Observed contract terms');
  assert.equal(gift.price_observed_at,recent);
  assert.equal(gift.price_is_historical,false);
  for (const key of ['state','display_state','ui_state','observed_at','market_observed_at','membership_sources','automatic_membership','verification_method']) assert.deepEqual(gift[key],before.gifts[0][key],key);
  assert.deepEqual(gift.pricing,before.gifts[0].pricing);
  assert.deepEqual(after.summary,before.summary);
  assert.match(gift.uncertainties.join(' '),/visibility/);
});

test('failed checks retain the last verified dated amount without substituting the active rental rate', () => {
  const gift = view([...seed,observation(),observation({verified:false,reason:'holder_changed',configured_price_per_day_raw:null},'2026-10-09T11:30:00Z')]).gifts[0];
  assert.equal(gift.price_per_day,'0.39'); assert.equal(gift.price_observed_at,recent);
  assert.equal(gift.price_is_historical,true); assert.equal(gift.price_check_reason,'holder_changed');
  const missing = view([...seed,observation({configured_price_per_day_raw:undefined})]).gifts[0];
  assert.equal(missing.price_per_day,'0.35');
});

test('wrong wallet, collection, unverified observations and unresolved gifts cannot receive TON prices', () => {
  for (const extra of [{owner:address(99)},{collection_address:address(99)},{verified:false},{configured_price_per_day_raw:'NaN'}]) {
    assert.equal(view([...seed,observation(extra)]).gifts[0].price_per_day,'0.35');
  }
  const rows = seed.map(r => r.kind==='portfolio'?{...r,record:{...r.record,is_portfolio:false}}:r);
  assert.equal(view([...rows,observation()]).gifts[0].price_per_day,'0.35');
});

test('zero and huge configured prices retain exact decimals; future observations are ignored', () => {
  assert.equal(view([...seed,observation({configured_price_per_day_raw:'0'})]).gifts[0].price_per_day,'0');
  assert.equal(view([...seed,observation({configured_price_per_day_raw:'100000000000000000000000123'})]).gifts[0].price_per_day,'100000000000000000.000000123');
  assert.equal(view([...seed,observation({},'2026-10-10T12:00:00Z')]).gifts[0].price_per_day,'0.35');
});

test('a later holder recheck cannot promote an older contract price over newer listing evidence', () => {
  const newerListing = structuredClone(seed.find(r => r.kind==='listing'));
  newerListing.observed_at = '2026-10-09T11:15:00Z';
  newerListing.record.source_json.price_per_day = '410000000';
  const gift = view([...seed,newerListing,observation({checked_at:'2026-10-09T11:30:00Z'})]).gifts[0];
  assert.equal(gift.price_per_day,'0.41'); assert.equal(gift.price_source,'Marketapp listing');
  assert.equal(gift.price_observed_at,newerListing.observed_at);
  assert.equal(gift.price_checked_at,'2026-10-09T11:30:00Z');
});
