// Synthetic dashboard containing repeated comparison windows, statistics,
// provenance and sorting values. No personal data or provider requests.
export function wireDashboardFixture(count=161) {
  const at='2026-10-12T06:00:00.123456Z',wallet='0:'+ 'a'.repeat(64),collection='0:'+'b'.repeat(64);
  const stats={average:'0.142019',median:'0.130000',min:'0.040000',max:'0.830000',count:555,distinct_gifts:131,
    first_observed_at:'2026-09-12T06:00:00Z',last_observed_at:at,sample_level:'large',low_sample:false,currency:'GRAM',
    timeframe:'30d',window_from:'2026-09-12T06:00:00Z',window_to:at,collection_address:collection,model:'Golden heart',backdrop:'Black'};
  const provenance={verified:true,owner:wallet,collection_address:collection,observed_at:at,status_observed_at:at,
    source:'marketapp_personal_gifts',rental_state:'rented',rental_until:1792123400,price_per_day:'0.140000',
    source_revision:2349,wallet_scope_revision:1034,contract_variant:'pinned_marketapp_rental',code_hash:'e'.repeat(64),
    data_hash:'f'.repeat(64),code_hash_verified:true,data_hash_verified:true,nft_last_transaction_lt:'67291103000009'};
  const gifts=Array.from({length:count},(_,index)=>({
    nft_address:'0:'+index.toString(16).padStart(64,'0'),collection_address:collection,collection:'Timeless Book',name:`Timeless Book #${index}`,
    number:index,model:'Golden heart',backdrop:'Black',symbol:'星✨',is_portfolio:true,is_rented:index%3===0,
    current_price:'0.140000',recommended_price:'0.142019',price_sort_value:0.142019,current_price_sort_value:0.14,
    recommendation_delta:'0.002019',rental_until:'2026-10-16T06:43:20Z',status_provenance:provenance,previous_status_provenance:provenance,
    pricing:{collection:stats,exact_model:stats,model_backdrop:stats,collection_backdrop:stats,
      selected:{source:'collection_backdrop',price:'0.142019',sample_level:'large',stats},
      window:{timeframe:'30d',from:'2026-09-12T06:00:00Z',to:at}},
    price_tracking:{price_changes:Array.from({length:4},(_,i)=>({observed_at:at,old_price:'0.120000',new_price:'0.140000',
      before:{rentals:4,volume:'2.123456789',days:7,coverage:'partial'},after:{rentals:7,volume:'3.500000000',days:7,coverage:'partial'},
      source:'ton_owned_prices',index:i})),status:'observed'},
    image_url:`https://example.invalid/gifts/timelessbook-${index}.webp`,metadata_observed_at:at,
  }));
  return {revision:2400,saved_at:at,wallet,gifts,jobs:[],analytics:{period:'1y',captured_at:at,volume:'590.000000000',
    rentals:1002,days:Array.from({length:365},(_,day)=>({day,volume:'1.234567890',rentals:3,partial:day===364}))},
    data_status:{gifts:{checked:count,total:count,checked_at:at,complete:true},prices:{checked:count,total:count,checked_at:at,complete:true}},
    error:null};
}
