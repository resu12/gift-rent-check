// Synthetic reproduction of the My NFTs markup observed on 11 October 2026.
// The observed head had 100 cards and has-more/cursor attributes; an AJAX JSON
// continuation contained 61 sibling cards and has_more:false. Addresses,
// names, amounts, cursors, and identities below are fictional. No sessions,
// proofs, cookies, or personal page captures are saved in this fixture.
import {syntheticFriendly, syntheticWallet, htmlAttribute} from './marketapp-analytics-page-fixture.mjs';
export {syntheticFriendly, syntheticWallet, htmlAttribute};
export const syntheticGiftAddress = index => `0:${(index + 32).toString(16).padStart(64, '0')}`;
export const syntheticCursor = 'synthetic-opaque+/=cursor';
const relative = '/rent/?tab=my_nfts&sort_by=recently_touch&subtab=gifts&filter_by=any&view=grid';
export function syntheticGiftCard({index = 0, nft = syntheticGiftAddress(index), state = index % 2 ? 'rented' : 'for_rent',
  price = '0.190', minimum = '0.100', sale = '900.5', timer = '1d6h', currencyClass = 'icon-ton'} = {}) {
  const address = syntheticFriendly(nft), label = state === 'rented' ? 'Rented' : state === 'for_rent' ? 'For Rent' : 'Unsupported custody';
  const style = state === 'rented' ? 'tm-status-unavail' : state === 'for_rent' ? 'tm-status-cian' : 'tm-status-warning';
  return `<div class="tm-grid-item js-grid-card" data-nft-address="${address}"><label class="checkbox-my-nft"><span class="icon-checkbox-empty" data-nft-address="${address}"></span></label><a class="tm-grid-item-link" href="/nft/${address}/?to=rent"><img src="https://example.invalid/synthetic.png" alt=""><div class="tm-grid-item-name">Synthetic Gift #${index}</div></a><div class="tm-grid-item-status ${style}">${label}</div>${state === 'rented' && timer !== null ? `<div class="tm-timer-wrap js-timer-wrap">${timer}</div>` : ''}<div class="tm-grid-item-desc pt-2"><div>Per day</div><div>Min. price</div></div><div class="tm-grid-item-values"><div class="tm-grid-item-value ${currencyClass}">${price ?? ''}</div><div class="tm-grid-item-value icon-ton">${minimum}</div></div><div class="tm-grid-item-desc">Price <span class="tm-grid-item-status tm-status-avail">On Sale</span></div><div class="tm-grid-item-values"><div class="tm-grid-item-value icon-ton">${sale}</div></div></div>`;
}
export function syntheticGiftsHead({count = 100, offset = 0, more = true, cursor = more ? syntheticCursor : null, wallet = syntheticWallet,
  identity = wallet, cardOptions = {}} = {}) {
  const cards = Array.from({length: count}, (_, index) => syntheticGiftCard({index: offset + index, ...cardOptions})).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>My NFTs</title></head><body><a class="active" href="/rent/?tab=my_nfts">My NFTs</a><div class="tm-catalog-grid js-table-tbody js-table-wrapper" data-has-more="${more}"${cursor === null ? '' : ` data-next-cursor="${htmlAttribute(cursor)}"`}>${cards}</div><script>var current_page = ${JSON.stringify(relative)}; Wallet.init(${JSON.stringify({address: identity, discarded: 'synthetic-nonce'})});</script></body></html>`;
  return {body: html, options: {wallet, sourceUrl: 'https://marketapp.org' + relative, continuation: false}};
}
export function syntheticGiftsContinuation({count = 61, offset = 100, more = false, cursor = more ? syntheticCursor + '-next' : null,
  requestCursor = syntheticCursor, wallet = syntheticWallet, cardOptions = {}} = {}) {
  const h = Array.from({length: count}, (_, index) => syntheticGiftCard({index: offset + index, ...cardOptions})).join('');
  return {body: JSON.stringify({h, has_more: more, ...(cursor === null ? {} : {next_cursor: cursor})}),
    options: {wallet, sourceUrl: 'https://marketapp.org' + relative + '&cursor=' + encodeURIComponent(requestCursor), continuation: true}};
}
