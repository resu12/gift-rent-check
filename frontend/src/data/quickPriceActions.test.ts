import test from 'node:test';
import assert from 'node:assert/strict';
import { copyRecommendedPrice, marketappGiftUrl, quickPriceState, recommendedPriceText } from './quickPriceActions.ts';
import { canonicalMainnetAddress, friendlyMainnetAddress } from '../serverless/walletIdentity.ts';
import { telegramBridge } from './telegram.ts';
import type { Gift, PriceCohort } from './types.ts';

const raw = `0:${'ab'.repeat(32)}`;
const cohort: PriceCohort = { sample_count: 3, distinct_nft_count: 3, mean: '0.1905', median: null, minimum: null, maximum: null,
  observed_from: null, observed_to: null, coverage: 'observed_sample' };
const gift: Gift = { id: 'gift-one', nft_address: raw, name: 'Test #1', collection_name: 'Test gifts', collection_address: null,
  image_url: null, state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio', is_portfolio: true,
  automatic_membership: true, membership_sources: ['ton_verified'], verification_method: 'rental_contract', proof_badges: [],
  price_per_day: '0.170', price_unit: 'GRAM', price_source: 'ton_contract', rental_until: null, observed_at: null,
  market_observed_at: null, explorer_url: 'https://untrusted.test/', uncertainties: [], pricing: { source: 'rentals',
    unit: 'GRAM/day', daily_comparable: true, collection: cohort, model: cohort, model_black: cohort,
    recommended_price_per_day: '0.1905', basis: 'model', confidence: 'low', reason: 'Observed peers', warnings: [] } };

test('copy price uses exact three-place half-up rounding without units or thousands grouping', () => {
  for (const [value, expected] of [['0.19', '0.190'], ['0.1904', '0.190'], ['0.1905', '0.191'], ['1000.9995', '1001.000'],
    ['9007199254740993.0104', '9007199254740993.010'], ['0000.0005', '0.001']]) assert.equal(recommendedPriceText(value), expected);
  for (const value of [null, undefined, '', 'NaN', 'Infinity', '-0.19', '0', '0.0004', '1e-3', '0.19 GRAM', '1,000.190', '.19', ' 0.19 ', '1'.repeat(2001)]) {
    assert.equal(recommendedPriceText(value), null, String(value));
  }
});

test('clipboard copies only a validated plain recommendation, and denial returns a manual-copy fallback signal', async () => {
  const calls: string[] = [];
  assert.equal(await copyRecommendedPrice('0.1905', { writeText: async value => { calls.push(value); } }), true);
  assert.deepEqual(calls, ['0.191']);
  assert.equal(await copyRecommendedPrice('0.190', undefined), false);
  assert.equal(await copyRecommendedPrice('0.190', { writeText: async () => { throw new Error('Permission denied'); } }), false);
  assert.equal(await copyRecommendedPrice('invalid', { writeText: async value => { calls.push(value); } }), false);
  assert.deepEqual(calls, ['0.191']);
});

test('Marketapp links use canonical mainnet NFT identity and a fixed rental route', () => {
  const friendly = friendlyMainnetAddress(raw)!;
  assert.equal(canonicalMainnetAddress(friendly), raw);
  assert.equal(marketappGiftUrl(raw.toUpperCase()), marketappGiftUrl(friendly));
  assert.equal(marketappGiftUrl(raw), `https://marketapp.org/nft/${friendly}/?to=rent`);
  const parsed = new URL(marketappGiftUrl(raw)!);
  assert.equal(parsed.origin, 'https://marketapp.org'); assert.equal(parsed.search, '?to=rent');
  const bytes = Uint8Array.from(atob(friendly.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  bytes[0] |= 0x40; // Valid nonbounceable mainnet aliases resolve to the same NFT.
  let crc = 0;
  for (const byte of bytes.slice(0, 34)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  bytes[34] = crc >> 8; bytes[35] = crc & 255;
  const nonbounceable = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(marketappGiftUrl(nonbounceable), marketappGiftUrl(raw));
  for (const invalid of ['legacy:nft', `https://marketapp.org/nft/${friendly}/`, raw + '/?api_key=secret', friendly.slice(0, -1) + (friendly.endsWith('A') ? 'B' : 'A'), `1:${'ab'.repeat(32)}`, 'kQ' + friendly.slice(2), null]) {
    assert.equal(marketappGiftUrl(invalid), null, String(invalid));
  }
});

test('actions preserve rented state and offer estimates only for portfolio gifts with a daily GRAM recommendation', () => {
  const before = structuredClone(gift);
  assert.equal(quickPriceState(gift).price, '0.191');
  assert.equal(quickPriceState(gift).url, marketappGiftUrl(raw));
  assert.equal(quickPriceState(gift).rangeWarning, null);
  for (const pricing of [{ ...gift.pricing!, unit: 'USD/day' }, { ...gift.pricing!, unit: undefined },
    { ...gift.pricing!, daily_comparable: false }, { ...gift.pricing!, recommended_price_per_day: null }]) {
    const state = quickPriceState({ ...gift, pricing });
    assert.equal(state.price, null); assert.ok(state.copyReason); assert.ok(state.url, 'Opening the valid gift remains available');
  }
  for (const candidate of [{ ...gift, is_portfolio: false }, { ...gift, category: 'unresolved' as const }]) {
    assert.equal(quickPriceState(candidate).eligible, false); assert.equal(quickPriceState(candidate).price, null); assert.equal(quickPriceState(candidate).url, null);
  }
  assert.deepEqual(gift, before, 'Copy/open eligibility never mutates prices or rental state');
});

test('documented price range warns without clamping the copied estimate', () => {
  for (const price of ['0.009', '1000000.001']) {
    const state = quickPriceState({ ...gift, pricing: { ...gift.pricing!, recommended_price_per_day: price } });
    assert.equal(state.price, price); assert.ok(state.rangeWarning);
  }
  for (const price of ['0.010', '1000000.000']) assert.equal(quickPriceState({ ...gift, pricing: { ...gift.pricing!, recommended_price_per_day: price } }).rangeWarning, null);
  assert.equal(quickPriceState({ ...gift, nft_address: 'legacy-nft' }).url, null);
  assert.equal(quickPriceState({ ...gift, nft_address: 'legacy-nft' }).price, '0.191');
});

test('Telegram openLink is optional, fixed-origin and safely falls back if unavailable or rejected', () => {
  const existing = globalThis.window;
  const opened: string[] = [];
  try {
    globalThis.window = { Telegram: { WebApp: { openLink: (url: string) => { opened.push(url); } } } } as unknown as Window & typeof globalThis;
    const url = marketappGiftUrl(raw)!;
    assert.equal(telegramBridge.openLink(url), true); assert.deepEqual(opened, [url]);
    for (const invalid of ['https://evil.test/', 'javascript:alert(1)', 'https://marketapp.org.evil.test/', 'https://user:pass@marketapp.org/']) assert.equal(telegramBridge.openLink(invalid), false);
    globalThis.window = { Telegram: { WebApp: { openLink: () => { throw new Error('Unavailable'); } } } } as unknown as Window & typeof globalThis;
    assert.equal(telegramBridge.openLink(url), false);
    globalThis.window = {} as Window & typeof globalThis;
    assert.equal(telegramBridge.openLink(url), false);
  } finally { globalThis.window = existing; }
});
