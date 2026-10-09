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
export function syntheticAnalyticsPage({periodDays = 30, wallet = syntheticWallet, identity = wallet,
  lastDate = '2026-10-09', capturedAt = '2026-10-09T12:00:00Z', optionalCharts = true, durationHistogram = true} = {}) {
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
  const charts = [
    chart('profile.rent.income', [{name: 'Rent volume', data: numbers}], 'GRAM'),
    chart('profile.rent.rentals', [{name: 'New rentals', data: numbers}, {name: 'Extensions', data: numbers.map((_, index) => index === 0 ? 1 : 0)}], ''),
  ];
  if (optionalCharts) charts.push(
    chart('profile.rent.day_price', [{name: 'Price per day', data: numbers.map((_, index) => index === 0 ? 0.12 : null)}], 'GRAM'),
    chart('profile.rent.duration', [{name: 'Average duration', data: numbers.map((_, index) => index === 0 ? 4.8 : null)}], 'days'),
  );
  const sourceUrl = `https://marketapp.org/user/${syntheticFriendly(wallet)}/?tab=analytics_rent&period_by=last${periodDays}days&group_by=day`;
  const snapshot = {version: 1, source: 'marketapp_personal_rent_page', source_url: sourceUrl, wallet, captured_at: capturedAt, summary, charts};
  const histogram = durationHistogram ? `<div class="js-ma-chart" data-key="profile.rent.durations" data-spec="${htmlAttribute(JSON.stringify({categories: ['1 day', '2–7 days'], gran: 'day', kind: 'column', series: [{name: 'New rentals', data: [1, 2]}, {name: 'Extensions', data: [1, 0]}], stacking: 'normal', unit: ''}))}"></div>` : '';
  const content = summary.map(row => `<div class="ma-an-tile"><div class="ma-an-tile-label">${row.label}<span class="ma-an-info" data-bs-title="${htmlAttribute(row.definition)}"></span></div><div class="ma-an-tile-value"><span>${row.value}</span></div><div class="ma-an-tile-foot">${row.foot}</div></div>`).join('') +
    charts.map(row => `<div class="js-ma-chart" data-key="${row.key}" data-spec="${htmlAttribute(row.spec_raw)}"></div>`).join('') + histogram;
  const html = `<!DOCTYPE html><!DOCTYPE html><html><head><meta charset="utf-8"><title>Rental analytics</title></head><body><input disabled type="checkbox"><main>${content}</main><script>Wallet.init(${JSON.stringify({address: identity, ton_proof: 'synthetic-discarded-nonce'})});</script></body></html>`;
  return {html, options: {wallet, periodDays, capturedAt, sourceUrl}, snapshot};
}
