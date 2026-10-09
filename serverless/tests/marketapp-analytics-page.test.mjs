import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMarketappAnalyticsPage, MarketappAnalyticsPageError, MARKETAPP_ANALYTICS_PAGE_MAX_BYTES} from '../tgcloud/lib/marketapp-analytics-page.js';
import {normalizePersonalAnalytics} from '../tgcloud/lib/personal-analytics.js';
import {syntheticAnalyticsPage, syntheticFriendly, syntheticWallet, htmlAttribute} from './fixtures/marketapp-analytics-page-fixture.mjs';

const extract = source => extractMarketappAnalyticsPage(source.html, source.options);
function rejects(source, reason) {
  assert.throws(() => extract(source), error => {
    assert.ok(error instanceof MarketappAnalyticsPageError);
    if (reason) assert.equal(error.reason, reason);
    assert.equal(error.message, 'The signed-in Marketapp analytics page could not be verified.');
    return true;
  });
}
function editChart(source, key, edit) {
  const row = source.snapshot.charts.find(entry => entry.key === key), changed = edit(row.spec_raw);
  source.html = source.html.replace(htmlAttribute(row.spec_raw), htmlAttribute(changed));
  return source;
}

for (const periodDays of [30, 365]) test(`signed-in ${periodDays}-day evidence extracts into the existing exact normalizer`, () => {
  const source = syntheticAnalyticsPage({periodDays, optionalCharts: periodDays === 30});
  const result = extract(source), normalized = normalizePersonalAnalytics(JSON.stringify(result), syntheticWallet);
  assert.deepEqual(result, source.snapshot); assert.equal(normalized.daily.length, periodDays);
  assert.equal(normalized.period_end, '2026-10-09'); assert.equal(normalized.summary.rent_volume, '3');
  assert.equal(normalized.summary.rentals, 4); assert.equal(normalized.summary.spending_rentals, 0);
  assert.equal(normalized.volume_basis, 'gross_before_fees');
  assert.equal(JSON.stringify(result).includes('synthetic-discarded-nonce'), false);
});

test('mainnet raw, bounceable and nonbounceable aliases identify the same signed-in wallet', () => {
  for (const identity of [syntheticWallet.toUpperCase(), syntheticFriendly(), syntheticFriendly(syntheticWallet, 0x51)]) {
    const source = syntheticAnalyticsPage({identity}); source.options.wallet = syntheticFriendly(syntheticWallet, 0x51);
    assert.equal(extract(source).wallet, syntheticWallet);
  }
});

test('the observed rental-duration histogram is separate from daily rental statistics', () => {
  const source = syntheticAnalyticsPage(), without = syntheticAnalyticsPage({durationHistogram: false});
  assert.ok(source.html.includes('data-key="profile.rent.durations"'));
  assert.deepEqual(extract(source), extract(without));
  assert.equal(extract(source).charts.some(row => row.key === 'profile.rent.durations'), false);
  // Histogram categories and counts do not supply dates, prices or totals.
  source.html = source.html.replace('data-spec="{&quot;categories&quot;:[&quot;1 day&quot;', 'data-spec="{&quot;categories&quot;:[&quot;1000000 days&quot;');
  assert.deepEqual(extract(source), extract(without));
});

test('supplementary histogram recognition preserves duplicate, unknown and nesting rejection', () => {
  const source = syntheticAnalyticsPage();
  const histogram = source.html.match(/<div class="js-ma-chart" data-key="profile\.rent\.durations"[^>]+><\/div>/)[0];
  rejects({...source, html: source.html.replace(histogram, histogram + histogram)}, 'analytics_shape');
  rejects({...source, html: source.html.replace('data-key="profile.rent.durations"', 'data-key="profile.rent.unverified"')}, 'analytics_shape');
  rejects({...source, html: source.html.replace(histogram, histogram.replace('</div>', histogram + '</div>'))});
  rejects({...source, html: source.html.replace(histogram, '<div class="js-ma-chart" data-key="profile.rent.durations" data-spec=""></div>')}, 'analytics_shape');
});

test('chart numerical lexemes stay exact through attribute decoding and serialization', () => {
  const source = syntheticAnalyticsPage(); source.html = source.html.replace('>3.00<', '>9007199254740993.0001<');
  editChart(source, 'profile.rent.income', spec => spec.replace('"data":[3,', '"data":[9007199254740993.0001,'));
  const result = extract(source);
  assert.ok(result.charts[0].spec_raw.includes('9007199254740993.0001'));
  assert.equal(normalizePersonalAnalytics(JSON.stringify(result), syntheticWallet).daily[0].rent_volume, '9007199254740993.0001');
});

test('textContent-style nested spans, numeric entities, whitespace and SVG icons retain visible tile text', () => {
  const source = syntheticAnalyticsPage();
  source.html = source.html.replace('>3.00<', '>&#51;.&#x30;0<').replace('>4.8 days<', '>4.8&nbsp;days<')
    .replace('Before fees', 'Before fees &amp; royalties').replace('Rent volume<span', ' <b>Rent</b> volume<svg><path d="M0 0"/></svg><span');
  const result = extract(source);
  assert.equal(result.summary[0].value, '3.00'); assert.equal(result.summary[0].label, 'Rent volume');
  assert.equal(result.summary[0].definition, 'Before fees & royalties'); assert.equal(result.summary[3].value, '4.8\u00a0days');
});

test('public minifier adjacent quoted attributes retain unambiguous boundaries', () => {
  const source = syntheticAnalyticsPage();
  source.html = source.html.replace('<meta charset="utf-8">', '<meta name="viewport"content="width=device-width">')
    .replaceAll(' data-key=', 'data-key=').replaceAll(' data-spec=', 'data-spec=');
  assert.equal(extract(source).charts.length, 4);
  source.html = source.html.replace('data-key="profile.rent.income"', 'data-key="profile.rent.income"DATA-KEY="duplicate"'); rejects(source, 'page_structure');
});

test('comments, strings, external scripts and inactive template contents cannot supply identity or charts', () => {
  const source = syntheticAnalyticsPage();
  for (const options of [undefined, null, false, [], {}]) rejects({...source, options}, 'request_parameters');
  const fake = '<div class="js-ma-chart" data-key="wrong" data-spec="bad"></div>';
  source.html = source.html.replace('<main>', `<main><!-- ${fake} --><template>${fake}<script>Wallet.init({"address":false});</script></template><style>.fake { content: '${fake}'; }</style><script src="/external.js">Wallet.init({"address":false});</script><script>const regex=/'/;</script><script>const text='Wallet.init({"address":false})'; /* Wallet.init({"address":false}) */ // Wallet.init({"address":false})\n</script>`);
  assert.equal(extract(source).charts.length, 4);
});

test('empty optional figures stay unknown and explicit spending zero stays zero', () => {
  const source = syntheticAnalyticsPage(); source.html = source.html.replace('>0.12<', '>&mdash;<').replace('>4.8 days<', '><');
  const normalized = normalizePersonalAnalytics(JSON.stringify(extract(source)), syntheticWallet);
  assert.equal(normalized.summary.price_per_day, null); assert.equal(normalized.summary.average_duration, null);
  assert.equal(normalized.summary.spent_on_rent, '0');
});

test('missing, false, wrong, testnet and checksum-invalid signed-in identities are rejected', () => {
  for (const identity of [false, null, {}, `0:${'22'.repeat(32)}`, syntheticFriendly(syntheticWallet, 0x91), syntheticFriendly().slice(0, -1) + 'A']) {
    rejects(syntheticAnalyticsPage({identity}), 'wallet_identity');
  }
  const absent = syntheticAnalyticsPage(); absent.html = absent.html.replace(/Wallet\.init\([^;]+;/, ''); rejects(absent, 'wallet_identity');
  const missing = syntheticAnalyticsPage(); missing.html = missing.html.replace('"address":', '"different":'); rejects(missing, 'wallet_identity');
});

test('duplicate initializers and duplicate JSON identity keys are ambiguous and rejected', () => {
  const repeated = syntheticAnalyticsPage(); repeated.html = repeated.html.replace('</body>', `<script>Wallet.init({"address":"${syntheticWallet}"});</script></body>`); rejects(repeated, 'wallet_identity');
  for (const duplicate of ['address', '\\u0061ddress']) {
    const source = syntheticAnalyticsPage(); source.html = source.html.replace('"address":', `"${duplicate}":"${syntheticWallet}","address":`); rejects(source, 'wallet_identity');
  }
});

test('Wallet.init must be inert bounded JSON with one argument, never executable expressions', () => {
  for (const replacement of [`Wallet.init({address:"${syntheticWallet}"})`, `Wallet.init({"address":window.wallet})`,
    `Wallet.init({"address":"${syntheticWallet}"},true)`, `Wallet.init(JSON.parse("{}"))`,
    `Wallet.init({"address":"${syntheticWallet}","a":${'['.repeat(18)}0${']'.repeat(18)}})`]) {
    const source = syntheticAnalyticsPage(); source.html = source.html.replace(/Wallet\.init\([^;]+\)/, replacement); rejects(source, 'wallet_identity');
  }
});

test('only exact requested daily 30/365 windows on this wallet rental route are accepted', () => {
  const source = syntheticAnalyticsPage();
  for (const periodDays of [7, '30', 90, null]) rejects({...source, options: {...source.options, periodDays}}, 'request_parameters');
  for (const sourceUrl of [source.options.sourceUrl.replace('marketapp.org', 'example.org'), source.options.sourceUrl + '#fragment',
    source.options.sourceUrl + '&collection=x', source.options.sourceUrl.replace('group_by=day', 'group_by=auto'),
    source.options.sourceUrl.replace('period_by=last30days', 'period_by=last365days'), source.options.sourceUrl + '&tab=analytics_rent',
    source.options.sourceUrl.replace('&group_by=day', ''), source.options.sourceUrl.replace('https://', 'http://'),
    source.options.sourceUrl.replace('https://', 'https://attacker@')]) rejects({...source, options: {...source.options, sourceUrl}}, 'request_parameters');
  const otherUrl = source.options.sourceUrl.replace(syntheticFriendly(), syntheticFriendly(`0:${'22'.repeat(32)}`));
  rejects({...source, options: {...source.options, sourceUrl: otherUrl}}, 'wallet_identity');
  const shorter = syntheticAnalyticsPage({periodDays: 29}); shorter.options.periodDays = 30; shorter.options.sourceUrl = shorter.options.sourceUrl.replace('last29days', 'last30days'); rejects(shorter, 'period_span');
  const annual = syntheticAnalyticsPage({periodDays: 365}); annual.options.periodDays = 30; annual.options.sourceUrl = annual.options.sourceUrl.replace('last365days', 'last30days'); rejects(annual, 'period_span');
  const stale = syntheticAnalyticsPage({lastDate: '2026-10-08'}); rejects(stale, 'period_span');
  const offset = syntheticAnalyticsPage({capturedAt: '2026-10-10T01:00:00+02:00'}); assert.equal(extract(offset).charts.length, 4);
});

test('the established normalizer rejects mismatched totals, charts, units, days and time', () => {
  const edits = [source => {source.html = source.html.replace('>3.00<', '>4.00<');},
    source => editChart(source, 'profile.rent.income', raw => raw.replace('"GRAM"', '"TON"')),
    source => editChart(source, 'profile.rent.income', raw => raw.replace('"gran":"day"', '"gran":"month"')),
    source => editChart(source, 'profile.rent.rentals', raw => raw.replace('2026-09-10', '2026-09-09')),
    source => editChart(source, 'profile.rent.income', raw => raw.replace('"data":[3,', '"data":[null,')),
    source => {source.options.capturedAt = '2026-10-08T12:00:00Z';}, source => {source.options.capturedAt = '2026-02-30T12:00:00Z';}];
  for (const edit of edits) {const source = syntheticAnalyticsPage(); edit(source); rejects(source, 'analytics_shape');}
});

test('missing or duplicated financial selectors cannot be silently substituted', () => {
  for (const edit of [html => html.replace('ma-an-tile-label', 'other-label'), html => html.replace('ma-an-tile-value', 'other-value'),
    html => html.replace('ma-an-tile-label', 'ma-an-tile-label ma-an-tile-value'),
    html => html.replace('Rentals<span', 'Rent volume<span'), html => html.replace('profile.rent.rentals', 'profile.rent.income'),
    html => html.replace('profile.rent.rentals', 'profile.sales.rentals'),
    html => html.replace('class="ma-an-tile-value"', 'class="ma-an-tile-value" CLASS="extra"'),
    html => html.replace('<span>3.00</span>', '<span>3.00<span class="ma-an-tile-value">3.00</span></span>'),
    html => html.replace('<span>3.00</span>', '<span>3.00<script>const x=0;</script></span>')]) {
    const source = syntheticAnalyticsPage(); source.html = edit(source.html); rejects(source);
  }
});

test('ambiguous or malformed HTML is rejected without browser recovery heuristics', () => {
  for (const edit of [html => html.replace('</main>', '</section>'), html => html.replace('data-key="profile.rent.income"', 'data-key="profile.rent.income'),
    html => html.replace('<main>', '<main/>'), html => html.replace('</html>', ''), html => html.replace('<main>', '<!-- missing close <main>'),
    html => html.replace('<main>', '<!DOCTYPE html SYSTEM "external"><main>'), html => html.replace('<main>', '<main><div>').replace('</main>', '</main></div>')]) {
    const source = syntheticAnalyticsPage(); source.html = edit(source.html); rejects(source, 'page_structure');
  }
});

test('entity processing is single-pass and rejects unknown, invalid and unterminated references', () => {
  for (const replacement of ['&doesnotexist;', '&#0;', '&#xD800;', '&#x110000;', '&#3x;', '&quot']) {
    const source = syntheticAnalyticsPage(); source.html = source.html.replace('>3.00<', `>${replacement}<`); rejects(source, 'page_structure');
  }
  const twice = syntheticAnalyticsPage(); twice.html = twice.html.replaceAll('&quot;', '&amp;quot;'); rejects(twice, 'analytics_shape');
});

test('bounded bytes, nesting, initializer and token count fail with fixed safe diagnostics', () => {
  const source = syntheticAnalyticsPage();
  rejects({...source, html: ' '.repeat(MARKETAPP_ANALYTICS_PAGE_MAX_BYTES + 1)}, 'page_structure');
  rejects({...source, html: 'é'.repeat(MARKETAPP_ANALYTICS_PAGE_MAX_BYTES / 2 + 1)}, 'page_structure');
  rejects({...source, html: source.html.replace('<main>', '<main>' + '<div>'.repeat(130)).replace('</main>', '</div>'.repeat(130) + '</main>')}, 'page_structure');
  rejects({...source, html: source.html.replace('<main>', '<main>' + '<br>'.repeat(50000))}, 'page_structure');
  rejects({...source, html: source.html.replace('synthetic-discarded-nonce', 'x'.repeat(17000))}, 'wallet_identity');
  rejects({...source, html: source.html + '\ud800'}, 'page_structure');
  const privateMarker = 'never-return-this-proof-cookie';
  const broken = {...source, html: source.html.replace('"address":', `"address":"${privateMarker}","address":`)};
  try {extract(broken); assert.fail();} catch (error) {
    assert.equal(JSON.stringify(error).includes(privateMarker), false); assert.equal(error.stack.includes(privateMarker), false);
    assert.deepEqual(Object.keys(error).sort(), ['name', 'reason']);
  }
});
