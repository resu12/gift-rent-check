// Entirely synthetic public-layout fixtures. No actual wallet, login proof,
// cookie, analytics, or page capture belongs in this test helper.
export const syntheticWallet = `0:${'11'.repeat(32)}`;
export function syntheticFriendly(address = syntheticWallet, tag = 0x11) {
  const bytes = Buffer.concat([Buffer.from([tag, 0]), Buffer.from(address.slice(2), 'hex')]);
  let crc = 0;
  for (const byte of bytes) {crc ^= byte << 8; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  return Buffer.concat([bytes, Buffer.from([crc >> 8, crc & 255])]).toString('base64url');
}
export const htmlAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const syntheticTopItems = () => [{name: 'Synthetic Gift #123', item_url: `https://marketapp.org/nft/${syntheticFriendly(`0:${'22'.repeat(32)}`)}/`,
  rentals: '2', rented_days: '12', volume: '1.50', price_per_day: '0.125'}];
export function syntheticTopItemsTable(items = syntheticTopItems()) {
  const headers = ['Item', 'Rentals', 'Rented days', 'Volume', 'Price per day'];
  return '<div class="ma-an-tblock w-full"><div class="tm-section-header"><h2 class="tm-section-header-text">Top items</h2></div>' +
    '<div class="ma-an-tblock-hint">Your items with the biggest rent volume in the period</div><div class="table-responsive"><table class="table tm-table"><thead><tr>' +
    headers.map(label => `<th>${label}<span class="ma-an-info" data-bs-title="Displayed Marketapp definition"><i class="bi bi-info-circle"></i></span></th>`).join('') + '</tr></thead><tbody>' +
    items.map(item => '<tr><td><a class="table-cell" href="' + htmlAttribute(item.item_url.replace('https://marketapp.org', '')) + '"><div class="table-cell-value tm-value">' + htmlAttribute(item.name) + '</div></a></td>' +
      ['rentals', 'rented_days', 'volume', 'price_per_day'].map(key => `<td><div class="table-cell"><div class="table-cell-value-row"><div class="table-cell-value${['volume', 'price_per_day'].includes(key) ? ' tm-value icon-before icon-ton' : ''}">${htmlAttribute(item[key])}</div></div></div></td>`).join('') + '</tr>').join('') + '</tbody></table></div></div>';
}
export function syntheticAnalyticsPage({periodDays = 30, wallet = syntheticWallet, identity = wallet,
  lastDate = '2026-10-09', capturedAt = '2026-10-09T12:00:00Z', optionalCharts = true, durationHistogram = true, combinedActivity = false, topItems = null, collections = null} = {}) {
  const dates = Array.from({length: periodDays}, (_, index) => new Date(Date.parse(lastDate + 'T00:00:00Z') - (periodDays - 1 - index) * 86400000).toISOString().slice(0, 10));
  const numbers = Array.from({length: periodDays}, (_, index) => index === 0 ? 3 : 0);
  const chart = (key, series, unit) => ({key, spec_raw: JSON.stringify({categories: null, gran: 'day', kind: 'column', series, stacking: null, unit, x: dates})});
  const summary = [
    {label: 'Rent volume', value: '3.00', foot: '-5%', definition: 'Before fees'},
    {label: 'Rentals', value: '4', foot: '-2% 2 items', definition: 'Includes extensions'},
    {label: 'Price per day', value: '0.12', foot: '', definition: ''},
    {label: 'Average duration', value: '4.8 days', foot: '', definition: ''},
    {label: 'Extensions', value: '25%', foot: '', definition: ''},
    {label: 'Spent on rent', value: '0', foot: '0 rentals', definition: ''},
  ];
  const charts = combinedActivity ? [{key: 'profile.rent.activity', spec_raw: JSON.stringify({categories: null, combo: true, gran: 'day',
    kind: 'column', stacking: 'normal', unit: '', x: dates, series: [
      {axis: 0, color: 1, name: 'New rentals', type: 'column', unit: '', data: numbers},
      {axis: 0, color: 2, name: 'Extensions', type: 'column', unit: '', data: numbers.map((_, index) => index === 0 ? 1 : 0)},
      {axis: 1, color: 9, name: 'Rent volume', opacity: 0.85, type: 'line', unit: 'GRAM', data: numbers},
    ]})}] : [
    chart('profile.rent.income', [{name: 'Rent volume', data: numbers}], 'GRAM'),
    chart('profile.rent.rentals', [{name: 'New rentals', data: numbers}, {name: 'Extensions', data: numbers.map((_, index) => index === 0 ? 1 : 0)}], ''),
  ];
  if (optionalCharts) charts.push(
    chart('profile.rent.day_price', [{name: 'Price per day', data: numbers.map((_, index) => index === 0 ? 0.12 : null)}], 'GRAM'),
    chart('profile.rent.duration', [{name: 'Average duration', data: numbers.map((_, index) => index === 0 ? 4.8 : null)}], 'days'),
  );
  const sourceUrl = `https://marketapp.org/user/${syntheticFriendly(wallet)}/?tab=analytics_rent&period_by=last${periodDays}days&group_by=day`;
  const snapshot = {version: 1, source: 'marketapp_personal_rent_page', source_url: sourceUrl, wallet, captured_at: capturedAt, summary, charts,
    top_items: topItems === null ? {status: 'missing', items: []} : {status: 'available', items: topItems},
    by_collection: collections === null ? {status:'missing',items:[]} : {status:'available',items:collections}};
  const histogram = durationHistogram ? `<div class="js-ma-chart" data-key="profile.rent.durations" data-spec="${htmlAttribute(JSON.stringify({categories: ['1 day', '2–7 days'], gran: 'day', kind: 'column', series: [{name: 'New rentals', data: [1, 2]}, {name: 'Extensions', data: [1, 0]}], stacking: 'normal', unit: ''}))}"></div>` : '';
  const content = summary.map(row => `<div class="ma-an-tile"><div class="ma-an-tile-label">${row.label}<span class="ma-an-info" data-bs-title="${htmlAttribute(row.definition)}"></span></div><div class="ma-an-tile-value"><span>${row.value}</span></div><div class="ma-an-tile-foot">${row.foot}</div></div>`).join('') +
    charts.map(row => `<div class="js-ma-chart" data-key="${row.key}" data-spec="${htmlAttribute(row.spec_raw)}"></div>`).join('') + histogram + (topItems === null ? '' : syntheticTopItemsTable(topItems)) + (collections===null?'':syntheticCollectionsTable(collections));
  const html = `<!DOCTYPE html><!DOCTYPE html><html><head><meta charset="utf-8"><title>Rental analytics</title></head><body><input disabled type="checkbox"><main>${content}</main><script>Wallet.init(${JSON.stringify({address: identity, ton_proof: 'synthetic-discarded-nonce'})});</script></body></html>`;
  return {html, options: {wallet, periodDays, capturedAt, sourceUrl}, snapshot};
}

export const syntheticCollections = () => [{name:'Synthetic Collection',rentals:'4',volume:'3.00',price_per_day:'0.125'}];
export function syntheticCollectionsTable(items=syntheticCollections(),{extended=false}={}) {
  if(extended) {
    const href='/collection/'+syntheticFriendly(`0:${'33'.repeat(32)}`)+'/';
    const metric=value=>'<td><div class="table-cell"><div class="table-cell-value-row d-flex justify-content-end"><div class="table-cell-value">'+htmlAttribute(value)+'</div></div></div></td>';
    return '<div class="ma-an-tblock w-full"><div class="tm-section-header"><h2 class="tm-section-header-text">By collection</h2></div>'
      +'<div class="ma-an-tblock-hint">Rent volume of your items per collection in the period</div><div class="table-responsive"><table class="table tm-table tm-table-fixed-column"><thead><tr>'
      +'<th style="width: 1px;"></th><th>Collection</th><th class="text-end">Rentals</th><th class="text-end">Volume</th><th class="text-end">Price per day</th><th class="text-end">Average duration</th>'
      +'<th class="text-end">Share of volume <span class="ma-an-info" tabindex="0" data-bs-toggle="tooltip" data-bs-title="Share of your total rent volume"><i class="bi bi-info-circle"></i></span></th></tr></thead><tbody>'
      +items.map(item=>'<tr><td><a href="'+href+'"><img src="https://example.com/synthetic-collection.webp" class="tm-cell-thumb" style="position: static;" alt="" loading="lazy"></a></td>'
        +'<td style="max-width: 200px;"><a href="'+href+'" class="table-cell"><div class="table-cell-value tm-value">'+htmlAttribute(item.name)+'</div></a></td>'
        +['rentals','volume','price_per_day'].map(key=>metric(item[key])).join('')+metric('5.45 days')+metric('22.8%')+'</tr>').join('')
      +'</tbody></table></div></div>';
  }
  return '<div class="ma-an-tblock"><h2 class="tm-section-header-text">By collection</h2><table class="table tm-table"><thead><tr>'
    +['Collection','Rentals','Volume','Price per day'].map(name=>`<th>${name}</th>`).join('')+'</tr></thead><tbody>'
    +items.map(item=>'<tr>'+['name','rentals','volume','price_per_day'].map(key=>`<td><div class="table-cell-value">${htmlAttribute(item[key])}</div></td>`).join('')+'</tr>').join('')
    +'</tbody></table></div>';
}
