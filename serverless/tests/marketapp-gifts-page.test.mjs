import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMarketappGiftsPage, marketappGiftsUrl, MarketappGiftsPageError, MARKETAPP_GIFTS_PAGE_MAX_BYTES} from '../tgcloud/lib/marketapp-gifts-page.js';
import {syntheticGiftsHead, syntheticGiftsContinuation, syntheticGiftCard, syntheticGiftAddress, syntheticFriendly, syntheticWallet, syntheticCursor} from './fixtures/marketapp-gifts-page-fixture.mjs';
const extract = page => extractMarketappGiftsPage(page.body, page.options);
function rejects(page, reason, auth = undefined) {
  assert.throws(() => extract(page), error => {
    assert.ok(error instanceof MarketappGiftsPageError); if (reason) assert.equal(error.reason, reason);
    if (auth !== undefined) assert.equal(error.authenticationInvalid, auth);
    assert.equal(error.message, 'The signed-in Marketapp gifts page could not be verified.'); return true;
  });
}
test('observed head and AJAX final shapes preserve asking prices and uncertain rounded timers', () => {
  const head = extract(syntheticGiftsHead()), final = extract(syntheticGiftsContinuation());
  assert.equal(head.items.length, 100); assert.equal(head.page_size, 100); assert.equal(head.cursor, syntheticCursor); assert.equal(head.complete, false);
  assert.equal(final.items.length, 61); assert.equal(final.cursor, null); assert.equal(final.complete, true);
  assert.deepEqual(head.items[1], {nft_address: syntheticGiftAddress(1), price_per_day: '0.190', currency: 'GRAM', rental_state: 'rented', rental_until: null,
    rental_remaining_display: '1d6h', raw_role: 'my_nfts', raw_status: 'Rented', name: 'Synthetic Gift #1'});
  assert.equal(head.items[0].rental_state, 'for_rent'); assert.equal(head.items[0].rental_remaining_display, null);
  assert.equal(JSON.stringify(head).includes('synthetic-nonce'), false);
  assert.equal(JSON.stringify(head).includes('900.5'), false, 'sale price is never the rental asking price');
});
test('money stays exact text and the first Per day value is distinct from minimum and sale prices', () => {
  for (const price of ['0', '0.000000001', '9007199254740993.123456789']) {
    const item = extract(syntheticGiftsHead({count: 1, cardOptions: {price, minimum: '88', sale: '10000'}})).items[0];
    assert.equal(item.price_per_day, price); assert.equal(item.currency, 'GRAM');
  }
  for (const price of ['1e-1', '-1', '1,000', '00.1', 'NaN', '0.0000000001', '1'.repeat(37)])
    rejects(syntheticGiftsHead({count: 1, cardOptions: {price}}), 'price_layout');
});
test('unknown status and missing or unsupported-currency price stay empty without invented idle status', () => {
  for (const cardOptions of [{state: 'unknown'}, {price: null}, {currencyClass: 'icon-other-currency'}]) {
    const item = extract(syntheticGiftsHead({count: 1, cardOptions})).items[0];
    if (cardOptions.state) {assert.equal(item.rental_state, 'unknown'); assert.equal(item.raw_status, 'Unsupported custody');}
    if (cardOptions.price === null || cardOptions.currencyClass) {assert.equal(item.price_per_day, null); assert.equal(item.currency, null);}
    assert.equal(item.rental_until, null);
  }
  const noPrice = syntheticGiftsHead({count: 1});
  noPrice.body = noPrice.body.replace(/<div class="tm-grid-item-desc pt-2">.*?<\/div><\/div><div class="tm-grid-item-values">.*?<\/div><\/div>/, '');
  assert.equal(extract(noPrice).items[0].price_per_day, null, 'sale-only prices are ignored');
});
test('request URL is fixed to owned gifts and opaque cursor survives exact encoding', () => {
  assert.equal(marketappGiftsUrl(), syntheticGiftsHead().options.sourceUrl);
  assert.ok(marketappGiftsUrl(syntheticCursor).endsWith('cursor=synthetic-opaque%2B%2F%3Dcursor'));
  for (const cursor of ['', undefined, 'space cursor', 'x'.repeat(2049), '\n', 123]) {
    if (cursor === undefined) continue; assert.throws(() => marketappGiftsUrl(cursor));
  }
  const base = syntheticGiftsHead({count: 1});
  for (const sourceUrl of [base.options.sourceUrl.replace('my_nfts', 'my_rented'), base.options.sourceUrl.replace('gifts', 'usernames'),
    base.options.sourceUrl + '&limit=100', base.options.sourceUrl + '#x', base.options.sourceUrl.replace('https:', 'http:'),
    base.options.sourceUrl.replace('marketapp.org', 'evil.example'), base.options.sourceUrl + '&view=grid'])
    rejects({...base, options: {...base.options, sourceUrl}}, 'request_parameters');
  const final = syntheticGiftsContinuation({count: 1});
  for (const sourceUrl of [base.options.sourceUrl, final.options.sourceUrl + '&limit=100', final.options.sourceUrl + '&cursor=other'])
    rejects({...final, options: {...final.options, sourceUrl}});
});
test('head wallet identity and explicit selected page must match; disconnected head is authentication failure', () => {
  rejects(syntheticGiftsHead({count: 1, identity: syntheticGiftAddress(44)}), 'wallet_identity', true);
  rejects(syntheticGiftsHead({count: 1, identity: false}), 'wallet_identity', true);
  const base = syntheticGiftsHead({count: 1});
  rejects({...base, body: base.body.replace('Wallet.init(', 'Other.init(')}, 'wallet_identity');
  rejects({...base, body: base.body.replace('var current_page =', 'var another_page =')}, 'page_scope');
  rejects({...base, body: base.body.replace('var current_page = "/rent/?tab=my_nfts', 'var current_page = "/rent/?tab=my_rented')}, 'page_scope');
  rejects({...base, body: base.body.replace('Wallet.init(', 'var current_page = "/rent/?tab=my_nfts"; Wallet.init(')}, 'page_scope');
  rejects({...base, body: base.body.replace('var current_page =', '// var current_page =')}, 'wallet_identity');
});
test('empty and short pages end only when documented has_more is false', () => {
  assert.equal(extract(syntheticGiftsHead({count: 0, more: false})).complete, true);
  assert.equal(extract(syntheticGiftsHead({count: 1, more: true})).complete, false);
  assert.equal(extract(syntheticGiftsContinuation({count: 0, more: true})).complete, false);
  assert.equal(extract(syntheticGiftsContinuation({count: 1, more: false})).complete, true);
  rejects(syntheticGiftsHead({count: 1, more: true, cursor: null}), 'pagination');
  rejects(syntheticGiftsHead({count: 1, more: false, cursor: syntheticCursor}), 'pagination');
  rejects(syntheticGiftsContinuation({count: 1, more: true, cursor: null}), 'pagination');
});
test('card, checkbox and link identities agree by canonical address and reject checksums or mismatch', () => {
  const base = syntheticGiftsHead({count: 1}), address = syntheticFriendly(syntheticGiftAddress(0));
  const alias = syntheticFriendly(syntheticGiftAddress(0), 0x51);
  assert.equal(extract({...base, body: base.body.replace(`data-nft-address="${address}"`, `data-nft-address="${alias}"`)}).items[0].nft_address, syntheticGiftAddress(0));
  rejects({...base, body: base.body.replace(`/nft/${address}/`, `/nft/${syntheticFriendly(syntheticGiftAddress(9))}/`)}, 'gift_identity');
  rejects({...base, body: base.body.replace(`data-nft-address="${address}"`, `data-nft-address="${address.slice(0, -1)}A"`)}, 'gift_identity');
  rejects({...base, body: base.body.replace('checkbox-my-nft', 'checkbox-rented')}, 'gift_identity');
  rejects({...base, body: base.body.replace('href="/nft/', 'href="https://evil.example/nft/')}, 'gift_identity');
  rejects({...base, body: base.body.replace('?to=rent', '?to=rent&price=0.001')});
});
test('duplicate or ambiguous HTML evidence and price layout are rejected before any partial records escape', () => {
  const base = syntheticGiftsHead({count: 1}), card = syntheticGiftCard();
  for (const body of [base.body.replace('data-has-more="true"', 'data-has-more="true" DATA-HAS-MORE="false"'),
    base.body.replace('class="tm-grid-item js-grid-card"', 'class="tm-grid-item js-grid-card" class="x"'),
    base.body.replace('<div class="tm-grid-item-values">', '<section class="tm-grid-item-values">'),
    base.body.replace('Per day</div><div>Min. price', 'Min. price</div><div>Per day'),
    base.body.replace('tm-status-cian', 'tm-status-cian tm-status-unavail'),
    base.body.replace('</body>', card + '</body>'),
    base.body.replace(card, card + card)]) rejects({...base, body});
  rejects(syntheticGiftsHead({count: 101}), 'gift_shape');
  const nested = base.body.replace('<a class="tm-grid-item-link"', card + '<a class="tm-grid-item-link"'); rejects({...base, body: nested}, 'gift_shape');
});
test('empty decorative overlay is separate from status evidence, but two meaningful states are ambiguous', () => {
  const base = syntheticGiftsHead({count: 1});
  const decorated = base.body.replace('<a class="tm-grid-item-link"', '<div class="tm-grid-item-status"></div><a class="tm-grid-item-link"');
  assert.equal(extract({...base, body: decorated}).items[0].rental_state, 'for_rent');
  const conflicting = base.body.replace('<a class="tm-grid-item-link"', '<div class="tm-grid-item-status tm-status-unavail">Rented</div><a class="tm-grid-item-link"');
  rejects({...base, body: conflicting}, 'gift_shape');
});
test('continuation JSON duplicate keys, malformed pagination and executable fragments are rejected', () => {
  const final = syntheticGiftsContinuation({count: 1});
  for (const body of [final.body.replace('"has_more":false', '"has_more":true,"has_more":false'),
    final.body.replace('"h":', '"h":"", "h":'), JSON.stringify({...JSON.parse(final.body), has_more: 'false'}),
    JSON.stringify({...JSON.parse(final.body), next_cursor: 'unconsumed'}),
    JSON.stringify({...JSON.parse(final.body), cookie: 'secret'}), final.body + '{}',
    JSON.stringify({...JSON.parse(final.body), h: '<script>Wallet.init({});</script>'}),
    JSON.stringify({...JSON.parse(final.body), h: '<div><span></div></span>'})]) rejects({...final, body});
});
test('comments, templates and raw script strings cannot supply cards, price, wallet or page selection', () => {
  const base = syntheticGiftsHead({count: 1}), card = syntheticGiftCard({index: 42});
  const body = base.body.replace('<body>', `<body><!--${card}--><template>${card}</template><script>const fake = ${JSON.stringify(card)};</script>`);
  assert.equal(extract({...base, body}).items.length, 1);
  const forged = base.body.replace(/var current_page = "[^"]+";/, `const fake = ${JSON.stringify('var current_page = "' + '/rent/?tab=my_nfts&sort_by=recently_touch&subtab=gifts&filter_by=any&view=grid' + '";')};`);
  rejects({...base, body: forged}, 'page_scope');
  const jsonForged = base.body.replace(`"address":"${syntheticWallet}"`, `"address":"${syntheticWallet}","address":"${syntheticWallet}"`);
  rejects({...base, body: jsonForged}, 'wallet_identity');
});
test('input byte bound, malformed entities and unexpected arguments fail with safe fixed diagnostics', () => {
  const base = syntheticGiftsHead({count: 1});
  rejects({...base, body: 'x'.repeat(MARKETAPP_GIFTS_PAGE_MAX_BYTES + 1)});
  rejects({...base, body: '€'.repeat(Math.floor(MARKETAPP_GIFTS_PAGE_MAX_BYTES / 3) + 1)});
  rejects({...base, body: base.body.replace('Synthetic Gift #0', 'Synthetic &madeup; Gift')}, 'page_structure');
  rejects({...base, options: {...base.options, continuation: 'false'}}, 'request_parameters');
  rejects({...base, options: {...base.options, wallet: 'opaque'}}, 'request_parameters');
});
