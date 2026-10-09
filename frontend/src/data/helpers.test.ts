import test from 'node:test';
import assert from 'node:assert/strict';
import { filterGifts, filterPricingGifts, formatAmount, formatPriceDifference, giftGroup, hasRecommendation, isExactBlack, priceDifference, pricingBasisLabel, relativeTime, safeExternalUrl, sortPricingGifts } from './helpers.ts';
import type { Gift } from './types.ts';
import { DEFAULT_PRICING, historyCollectionError, pricingQuery, selectTimeframe, sourceDefaults, timeframeLabel, TIMEFRAME_OPTIONS, validDateRange } from './pricingSelection.ts';
import { localAdapter } from './local.ts';

const base: Gift = {
  id: '1', nft_address: 'wallet:nft1', name: 'Electric Skull #6175', collection_name: 'Electric Skulls',
  collection_address: 'collection1', image_url: null, state: 'idle_rental_contract', display_state: 'Idle contract',
  ui_state: 'idle', category: 'portfolio', is_portfolio: true, automatic_membership: true,
  membership_sources: ['ton_verified'], verification_method: 'rental_contract', proof_badges: [],
  price_per_day: null, price_unit: null, price_source: null, rental_until: null, observed_at: null,
  market_observed_at: null, explorer_url: null, uncertainties: [],
};

test('search, collection and state filters compose without treating idle contracts as listed', () => {
  const gifts = [base, { ...base, id: '2', name: 'Timeless Book', collection_address: 'collection2', state: 'rented', ui_state: 'rented' }];
  assert.equal(giftGroup(base), 'idle');
  assert.deepEqual(filterGifts(gifts, ' skull ', 'idle', 'collection1'), [base]);
  assert.deepEqual(filterGifts(gifts, '', 'for_rent', ''), []);
  assert.equal(filterGifts(gifts, 'WALLET:NFT1', 'all', '').length, 2);
});

test('uncertain candidates and expired rental observations require review', () => {
  assert.equal(giftGroup({ ...base, category: 'unresolved', ui_state: 'rented' }), 'review');
  assert.equal(giftGroup({ ...base, state: 'expired_pending_return', ui_state: 'expired' }), 'review');
});

test('sales remain distinct from rent listings and a supported UI observation may establish listing visibility', () => {
  assert.equal(giftGroup({ ...base, state: 'listed_for_sale', ui_state: null }), 'sale');
  assert.equal(giftGroup({ ...base, state: 'unknown', ui_state: 'for_rent' }), 'for_rent');
});

test('monetary display rounds exactly to three places and unknown is not zero', () => {
  assert.equal(formatAmount('12345678901234567890.000000001'), '12,345,678,901,234,567,890.000');
  assert.equal(formatAmount('0.001000'), '0.001');
  assert.equal(formatAmount('0.1'), '0.100');
  assert.equal(formatAmount('0.086444'), '0.086');
  assert.equal(formatAmount('0.127817089'), '0.128');
  assert.equal(formatAmount('9.9995'), '10.000');
  assert.equal(formatAmount('-1.2345'), '-1.235');
  assert.equal(formatAmount('-0.0001'), '0.000');
  assert.equal(formatAmount('0'), '0.000');
  assert.equal(formatAmount(null), '—');
});

function pricedGift(id: string, current: string | null, suggested: string | null): Gift {
  const cohort = { mean: suggested, median: suggested, minimum: suggested, maximum: suggested, sample_count: 3,
    observed_from: null, observed_to: null, coverage: 'observed_sample' as const };
  return { ...base, id, price_per_day: current, price_unit: 'GRAM', pricing: {
    collection: cohort, model: cohort, model_black: cohort, recommended_price_per_day: suggested,
    unit: 'GRAM/day', basis: 'collection', confidence: 'low', reason: 'Observed sample', warnings: [],
  } };
}

test('price differences use exact decimal arithmetic, including exponent notation and zero prices', () => {
  assert.equal(priceDifference(pricedGift('increase', '0.170', '0.194')), '0.024');
  assert.equal(priceDifference(pricedGift('decrease', '0.194', '0.170')), '-0.024');
  assert.equal(priceDifference(pricedGift('large', '9007199254740993.000000001', '9007199254740993.000000003')), '0.000000002');
  assert.equal(priceDifference(pricedGift('exponent', '1e-9', '3E-9')), '0.000000002');
  assert.equal(priceDifference(pricedGift('zero', '0', '0.001')), '0.001');
  assert.equal(priceDifference(pricedGift('free', '0.001', '0')), '-0.001');
  assert.equal(priceDifference(pricedGift('equal', '0.170', '0.17')), '0');
});

test('price gaps stay unknown when amounts or daily currency comparisons are invalid', () => {
  for (const amount of [null, '', 'abc', 'NaN', 'Infinity', '-0.01', '1e', '0x10']) {
    assert.equal(priceDifference(pricedGift('bad-current', amount, '0.2')), null, `current ${amount}`);
    assert.equal(priceDifference(pricedGift('bad-suggestion', '0.2', amount)), null, `suggestion ${amount}`);
  }
  const valid = pricedGift('valid', '0.1', '0.2');
  assert.equal(priceDifference({ ...valid, price_unit: 'GRAM/day' }), '0.1');
  assert.equal(priceDifference({ ...valid, pricing: { ...valid.pricing!, unit: undefined } }), '0.1');
  for (const price_unit of [null, '', 'USD', 'GRAM/hour']) assert.equal(priceDifference({ ...valid, price_unit }), null);
  assert.equal(priceDifference({ ...valid, pricing: { ...valid.pricing!, unit: 'USD/day' } }), null);
  assert.equal(priceDifference({ ...valid, pricing: { ...valid.pricing!, daily_comparable: false } }), null);
  assert.equal(priceDifference({ ...valid, pricing: null }), null);
});

test('price gap display rounds half up to three places with a direction and no negative zero', () => {
  assert.equal(formatPriceDifference(null), '—');
  assert.equal(formatPriceDifference('0.024'), '+0.024');
  assert.equal(formatPriceDifference('-0.0245'), '-0.025');
  assert.equal(formatPriceDifference('0.0005'), '+0.001');
  assert.equal(formatPriceDifference('0.0001'), '0.000');
  assert.equal(formatPriceDifference('-0.0001'), '0.000');
  assert.equal(formatPriceDifference('0'), '0.000');
});

test('gap sorting supports absolute and directional order, stable ties, unknowns last and immutability', () => {
  const gifts = [pricedGift('unknown-first', null, '0.3'), pricedGift('increase', '0.1', '0.3'),
    pricedGift('decrease', '0.4', '0.2'), pricedGift('zero', '0', '0'),
    pricedGift('increase-tie', '0.2', '0.4'), pricedGift('unknown-last', '0.1', null)];
  const original = [...gifts];
  const ids = (items: Gift[]) => items.map(gift => gift.id);
  const defaults = sortPricingGifts(gifts, 'default');
  assert.notEqual(defaults, gifts);
  assert.deepEqual(defaults, gifts);
  assert.deepEqual(ids(sortPricingGifts(gifts, 'gap')), ['increase', 'decrease', 'increase-tie', 'zero', 'unknown-first', 'unknown-last']);
  assert.deepEqual(ids(sortPricingGifts(gifts, 'increase')), ['increase', 'increase-tie', 'zero', 'decrease', 'unknown-first', 'unknown-last']);
  assert.deepEqual(ids(sortPricingGifts(gifts, 'decrease')), ['decrease', 'zero', 'increase', 'increase-tie', 'unknown-first', 'unknown-last']);
  assert.deepEqual(gifts, original);
  assert.ok(sortPricingGifts(gifts, 'gap').every(gift => gifts.includes(gift)));
});

test('sorting uses full precision and preserves the selected collection and exact Black sample', () => {
  const smaller = { ...pricedGift('smaller', '0', '0.024100000000000001'), backdrop: 'Black' };
  const larger = { ...pricedGift('larger', '0', '0.024100000000000002'), backdrop: 'Black' };
  const nonBlack = { ...pricedGift('onyx', '0', '1'), backdrop: 'Onyx Black' };
  const anotherCollection = { ...larger, id: 'other-collection', collection_address: 'collection2' };
  const gifts = [smaller, nonBlack, larger, anotherCollection];
  const snapshot = structuredClone(gifts);
  assert.equal(formatPriceDifference(priceDifference(smaller)), formatPriceDifference(priceDifference(larger)));
  const filtered = filterPricingGifts(gifts, '', 'collection1', 'black');
  assert.deepEqual(sortPricingGifts(filtered, 'gap'), [larger, smaller]);
  assert.deepEqual(filtered, [smaller, larger]);
  assert.deepEqual(gifts, snapshot);
});

test('only safe HTTPS external links are rendered', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), undefined);
  assert.equal(safeExternalUrl('http://example.test'), undefined);
  assert.equal(safeExternalUrl('https://tonviewer.com/test'), 'https://tonviewer.com/test');
});

test('relative observation age uses the observation rather than page generation', () => {
  assert.equal(relativeTime('2026-10-08T10:00:00Z', Date.parse('2026-10-08T12:00:00Z')), '2h ago');
  assert.equal(relativeTime(null), 'No observation yet');
});

test('pricing includes portfolio gifts only and composes model search with collection and exact Black', () => {
  const black = { ...base, model: 'Big Brother', backdrop: 'Black' };
  const lowerCase = { ...black, id: '2', backdrop: 'black' };
  const unresolved = { ...black, id: '3', is_portfolio: false, category: 'unresolved' as const };
  assert.equal(isExactBlack(black), true);
  assert.equal(isExactBlack(lowerCase), false);
  assert.deepEqual(filterPricingGifts([black, lowerCase, unresolved], 'big brother', 'collection1', 'black'), [black]);
  assert.equal(filterPricingGifts([black, lowerCase, unresolved], '', '', 'all').length, 2);
  assert.deepEqual(filterPricingGifts([black], '', 'different-collection', 'all'), []);
});

test('missing recommendation remains unknown and a supplied zero price is not treated as absent', () => {
  const cohort = { mean: null, median: null, minimum: null, maximum: null, sample_count: 0,
    observed_from: null, observed_to: null, coverage: 'observed_sample' as const };
  const gift = { ...base, pricing: { collection: cohort, model: cohort, model_black: cohort,
    recommended_price_per_day: null, basis: null, confidence: 'none' as const, reason: 'Not enough samples', warnings: [] } };
  assert.equal(hasRecommendation(gift), false);
  assert.equal(hasRecommendation({ ...gift, pricing: { ...gift.pricing, recommended_price_per_day: '0' } }), true);
  assert.deepEqual(filterPricingGifts([gift], '', '', 'missing'), [gift]);
  assert.equal(pricingBasisLabel('model_black'), 'Same model + Black');
  assert.equal(pricingBasisLabel(null), 'Not enough samples');
  assert.equal(hasRecommendation({ ...gift, pricing: { ...gift.pricing, daily_comparable: false, recommended_price_per_day: '0.1' } }), false);
});

test('switching either source resets to 30 days without carrying custom bounds', () => {
  assert.deepEqual(DEFAULT_PRICING, { source: 'rentals', timeframe: '30d' });
  assert.deepEqual(sourceDefaults('rentals'), { source: 'rentals', timeframe: '30d' });
  assert.deepEqual(sourceDefaults('listings'), { source: 'listings', timeframe: '30d' });
  assert.equal(pricingQuery({ source: 'rentals', timeframe: '7d', dateFrom: '2026-01-01', dateTo: '2026-01-02' }), 'pricing_source=rentals&timeframe=7d');
});

test('custom dates reject impossible or reversed dates, and include both calendar endpoints', () => {
  assert.equal(validDateRange('2026-02-29', '2026-03-01'), false);
  assert.equal(validDateRange('2026-10-09', '2026-10-08'), false);
  assert.equal(validDateRange('', '2026-10-08'), false);
  assert.equal(validDateRange('2024-02-29', '2024-02-29'), true);
  const selection = { source: 'rentals' as const, timeframe: 'custom' as const, dateFrom: '2026-10-01', dateTo: '2026-10-08' };
  assert.equal(pricingQuery(selection), 'pricing_source=rentals&timeframe=custom&date_from=2026-10-01&date_to=2026-10-08');
  assert.match(timeframeLabel(selection), /UTC, inclusive/);
  assert.throws(() => pricingQuery({ ...selection, dateFrom: '' }), /valid start and end/);
});

test('selectable presets include 60 days and cannot request all history', () => {
  const presets = ['24h', '7d', '30d', '60d', '90d'] as const;
  assert.equal(new Set(presets.map(timeframe => pricingQuery({ source: 'rentals', timeframe }))).size, presets.length);
  assert.equal(timeframeLabel({ source: 'rentals', timeframe: '60d' }), 'Last 60 days');
  assert.deepEqual(TIMEFRAME_OPTIONS.map(option => option.value), [...presets, 'custom']);
  assert.equal(timeframeLabel({ source: 'rentals', timeframe: 'all' }), 'All saved history (legacy)');
  assert.throws(() => pricingQuery({ source: 'rentals', timeframe: 'all' }), /at most 90 days/);
});

test('custom saved-data windows accept exactly 90 inclusive UTC days and reject 91', () => {
  const selection = { source: 'rentals' as const, timeframe: 'custom' as const, dateFrom: '2026-01-01', dateTo: '2026-03-31' };
  assert.equal(validDateRange(selection.dateFrom, selection.dateTo), true);
  assert.equal(validDateRange(selection.dateFrom, '2026-04-01'), false);
  assert.equal(validDateRange('2024-01-01', '2024-03-30'), true);
  assert.equal(validDateRange('2024-01-01', '2024-03-31'), false);
  assert.match(pricingQuery(selection), /date_from=2026-01-01&date_to=2026-03-31/);
  assert.throws(() => pricingQuery({ ...selection, dateTo: '2026-04-01' }), /at most 90 days/);
});

test('new history collection allows the latest 90 UTC calendar days while older saved windows remain readable', () => {
  const now = new Date('2026-10-09T23:59:59Z');
  const boundary = { source: 'rentals' as const, timeframe: 'custom' as const, dateFrom: '2026-07-12', dateTo: '2026-10-09' };
  assert.equal(historyCollectionError(boundary, now), null);
  const older = { ...boundary, dateFrom: '2026-07-11', dateTo: '2026-10-08' };
  assert.match(pricingQuery(older), /date_from=2026-07-11/);
  assert.match(historyCollectionError(older, now) || '', /no earlier than 2026-07-12/);
  assert.equal(historyCollectionError(boundary, new Date('2026-10-09T00:00:00Z')), null);
  assert.match(historyCollectionError(boundary, new Date('2026-10-10T00:00:00Z')) || '', /no earlier than 2026-07-13/);
});

test('Black comparison scope changes query identity and survives source and timeframe changes', () => {
  const selection = { source: 'rentals' as const, timeframe: '30d' as const, backdrop: 'Black' as const };
  assert.equal(pricingQuery(selection), 'pricing_source=rentals&timeframe=30d&pricing_backdrop=Black');
  assert.notEqual(pricingQuery(selection), pricingQuery({ ...selection, backdrop: undefined }));
  assert.deepEqual(sourceDefaults('listings', selection.backdrop), { source: 'listings', timeframe: '30d', backdrop: 'Black' });
  const custom = selectTimeframe(selection, 'custom', '2026-10-08');
  assert.deepEqual(custom, { ...selection, timeframe: 'custom', dateFrom: '2026-10-08', dateTo: '2026-10-08' });
  assert.deepEqual(selectTimeframe(custom, '7d', '2026-10-08'), { ...selection, timeframe: '7d' });
  assert.equal(pricingBasisLabel('collection', 'Black'), 'Collection + Black');
  assert.equal(pricingBasisLabel('model', 'Black'), 'Exact model + Black');
  assert.equal(pricingBasisLabel('model_black', 'Black'), 'Exact model + Black');
});

test('dashboard and CSV adapter use the identical source and timeframe, and forward cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ gifts: [], pricing: { source: 'rentals' } }), { status: 200 });
  };
  try {
    const selection = { source: 'rentals' as const, timeframe: 'custom' as const, dateFrom: '2026-10-01', dateTo: '2026-10-08', backdrop: 'Black' as const };
    await localAdapter.getDashboard(selection, controller.signal);
    assert.equal(requests[0].url.split('?')[1], localAdapter.exportUrl(selection).split('?')[1]);
    assert.equal(new URLSearchParams(requests[0].url.split('?')[1]).get('pricing_backdrop'), 'Black');
    assert.equal(requests[0].init?.signal, controller.signal);
    assert.equal(requests[0].init?.cache, 'no-store');
    assert.equal(requests[0].init?.credentials, 'same-origin');
  } finally { globalThis.fetch = originalFetch; }
});

test('actual-rentals collection uses its own job kind and keeps credentials in the CSRF header', async () => {
  const originalFetch = globalThis.fetch;
  let submitted: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { submitted = init; return new Response(JSON.stringify({ id: 1, kind: 'rental_prices' }), { status: 200 }); };
  try {
    await localAdapter.startJob('rental_prices', 'local-csrf');
    assert.deepEqual(JSON.parse(String(submitted?.body)), { kind: 'rental_prices' });
    assert.equal(submitted?.method, 'POST');
    assert.equal((submitted?.headers as Record<string, string>)['X-Dashboard-CSRF'], 'local-csrf');
  } finally { globalThis.fetch = originalFetch; }
});

test('stopping targets the existing job with POST and same-origin CSRF authentication', async () => {
  const originalFetch = globalThis.fetch;
  const stopped = { id: 42, state: 'running', stop_requested: true };
  let requestedUrl = '';
  let submitted: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input); submitted = init;
    return new Response(JSON.stringify({ job: stopped }), { status: 200 });
  };
  try {
    assert.deepEqual(await localAdapter.stopJob(42, 'stop-csrf'), stopped);
    assert.equal(requestedUrl, '/api/jobs/42/stop');
    assert.equal(submitted?.method, 'POST');
    assert.equal((submitted?.headers as Record<string, string>)['X-Dashboard-CSRF'], 'stop-csrf');
    assert.equal(submitted?.credentials, 'same-origin');
    assert.equal(submitted?.cache, 'no-store');
    assert.equal(submitted?.body, undefined);
    assert.equal(requestedUrl.includes('stop-csrf'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('a rejected stop exposes the service error without treating it as accepted', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'Refresh the dashboard before stopping this job.' }), { status: 403 });
  try {
    await assert.rejects(localAdapter.stopJob(42, 'expired-csrf'), {
      message: 'Refresh the dashboard before stopping this job.', status: 403,
    });
  } finally { globalThis.fetch = originalFetch; }
});
