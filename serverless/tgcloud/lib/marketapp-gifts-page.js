// Inert extraction of the observed signed-in My NFTs layout (11 October 2026).
// No network, HTML execution, cookies, persistence, ownership enrollment, or
// collection-name inference. A rental timer is display evidence, not an expiry.
import {canonicalAddress} from './cloud-pricing-core.js';
import {utf8Bytes} from './personal-analytics.js';
import {extractMarketappWalletIdentity} from './marketapp-analytics-page.js';

export const MARKETAPP_GIFTS_PAGE_MAX_BYTES = 1048576;
export const MARKETAPP_GIFTS_PAGE_SIZE = 100;
const RELATIVE = '/rent/?tab=my_nfts&sort_by=recently_touch&subtab=gifts&filter_by=any&view=grid';
const HEAD = 'https://marketapp.org' + RELATIVE;
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAW = new Set('script style textarea title iframe noscript xmp noembed noframes'.split(' '));
const ENTITIES = Object.freeze({amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003',
  copy: '\u00a9', reg: '\u00ae', times: '\u00d7', le: '\u2264', ge: '\u2265'});
export class MarketappGiftsPageError extends Error {
  constructor(reason = 'page_structure', authenticationInvalid = false, detail = null) {
    super('The signed-in Marketapp gifts page could not be verified.');
    this.name = 'MarketappGiftsPageError'; this.reason = reason;
    Object.defineProperty(this, 'authenticationInvalid', {value: authenticationInvalid});
    Object.defineProperty(this, 'detail', {value: detail});
  }
}
const fail = (reason = 'page_structure', auth = false, detail = null) => {throw new MarketappGiftsPageError(reason, auth, detail);};
const space = character => /[\t\n\f\r ]/.test(character || 'x');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function cursorValue(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) fail('pagination');
  return value;
}
export function marketappGiftsUrl(cursor = null) {
  if (cursor === null) return HEAD;
  const value = cursorValue(cursor);
  try {return HEAD + '&cursor=' + encodeURIComponent(value);} catch {fail('pagination');}
}
function decode(text) {
  return text.replace(/&(?:#[^\s&<>;]*|[A-Za-z][A-Za-z0-9]*);?/g, entity => {
    if (!entity.endsWith(';')) fail();
    const name = entity.slice(1, -1);
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    const numeric = /^#(?:([0-9]+)|x([0-9a-f]+))$/i.exec(name); if (!numeric) fail();
    const code = Number.parseInt(numeric[1] || numeric[2], numeric[1] ? 10 : 16);
    if (!Number.isSafeInteger(code) || code < 32 && ![9,10,13].includes(code) || code === 127 ||
      code >= 0xd800 && code <= 0xdfff || code > 0x10ffff) fail();
    return String.fromCodePoint(code);
  });
}
// Duplicate keys are rejected at every depth before any fields are trusted.
function exactJSON(source) {
  let at = 0;
  const skip = () => {while (space(source[at])) at++;};
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') {at += 2; continue;}
      if (source[at++] === '"') {try {return JSON.parse(source.slice(start, at));} catch {fail('response_shape');}}
    }
    fail('response_shape');
  }
  function value(depth = 0) {
    if (depth > 16) fail('response_shape'); skip();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; const result = Object.create(null); skip(); if (source[at] === '}') {at++; return result;}
      for (;;) {
        skip(); if (source[at] !== '"') fail('response_shape'); const key = string();
        if (Object.hasOwn(result, key) || Object.keys(result).length >= 100) fail('response_shape'); skip();
        if (source[at++] !== ':') fail('response_shape'); result[key] = value(depth + 1); skip();
        const next = source[at++]; if (next === '}') return result; if (next !== ',') fail('response_shape');
      }
    }
    if (source[at] === '[') {
      at++; const result = []; skip(); if (source[at] === ']') {at++; return result;}
      for (;;) {if (result.length >= 1000) fail('response_shape'); result.push(value(depth + 1)); skip(); const next = source[at++]; if (next === ']') return result; if (next !== ',') fail('response_shape');}
    }
    for (const [token, result] of [['true',true], ['false',false], ['null',null]]) {
      if (source.startsWith(token, at)) {at += token.length; return result;}
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0];
    if (!number || number.length > 128) fail('response_shape'); at += number.length;
    const result = Number(number); if (!Number.isFinite(result)) fail('response_shape'); return result;
  }
  const result = value(); skip(); if (at !== source.length) fail('response_shape'); return result;
}
function readTree(html) {
  const root = {tag: '#root', attrs: Object.create(null), children: [], inactive: false}, stack = [root];
  let at = 0, tokens = 0;
  while (at < html.length) {
    if (++tokens > 50000) fail();
    const parent = stack.at(-1);
    if (html[at] !== '<') {
      const end = html.indexOf('<', at), next = end < 0 ? html.length : end;
      parent.children.push({text: html.slice(at, next)}); at = next; continue;
    }
    if (html.startsWith('<!--', at)) {const end = html.indexOf('-->', at + 4); if (end < 0) fail(); at = end + 3; continue;}
    const doctype = /^<!doctype\s+html\s*>/i.exec(html.slice(at));
    if (doctype) {if (stack.length !== 1 || root.children.some(node => node.tag)) fail(); at += doctype[0].length; continue;}
    const close = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(html.slice(at));
    if (close) {if (stack.length <= 1 || stack.pop().tag !== close[1].toLowerCase()) fail(); at += close[0].length; continue;}
    const open = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(at)); if (!open) fail();
    const tag = open[1].toLowerCase(); at += open[0].length;
    const attrs = Object.create(null); let selfClosing = false, previousQuoted = false;
    for (;;) {
      let whitespace = false; while (space(html[at])) {at++; whitespace = true;}
      if (html[at] === '>') {at++; break;}
      if (html.startsWith('/>', at)) {at += 2; selfClosing = true; break;}
      if (!whitespace && !previousQuoted) fail();
      const name = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(html.slice(at))?.[0]; if (!name) fail(); at += name.length;
      const key = name.toLowerCase(); if (Object.hasOwn(attrs, key) || Object.keys(attrs).length >= 100) fail();
      const afterName = at; while (space(html[at])) at++;
      let value = ''; previousQuoted = false;
      if (html[at] === '=') {
        at++; while (space(html[at])) at++; const quote = html[at];
        if (quote === '"' || quote === "'") {const end = html.indexOf(quote, ++at); if (end < 0) fail(); value = html.slice(at, end); at = end + 1; previousQuoted = true;}
        else {const raw = /^[^\s"'=<>`]+/.exec(html.slice(at))?.[0]; if (!raw) fail(); value = raw; at += raw.length;}
      } else at = afterName;
      if (value.length > 262144) fail(); attrs[key] = value;
    }
    if (selfClosing && !VOID.has(tag) && !['svg','math'].includes(tag) && !stack.some(node => ['svg','math'].includes(node.tag))) fail();
    const node = {tag, attrs, children: [], inactive: parent.inactive || tag === 'template', parent}; parent.children.push(node);
    if (RAW.has(tag) && !selfClosing) {
      const pattern = new RegExp('</' + tag + '\\s*>', 'ig'); pattern.lastIndex = at; const closeRaw = pattern.exec(html); if (!closeRaw) fail();
      node.raw = html.slice(at, closeRaw.index); at = closeRaw.index + closeRaw[0].length; continue;
    }
    if (!VOID.has(tag) && !selfClosing) {stack.push(node); if (stack.length > 129) fail();}
  }
  if (stack.length !== 1) fail(); return root;
}
const attribute = (node, key) => Object.hasOwn(node.attrs, key) ? decode(node.attrs[key]) : null;
const classes = node => new Set((attribute(node, 'class') ?? '').split(/\s+/));
const hasClass = (node, name) => node.tag && !node.inactive && classes(node).has(name);
function descendants(node, predicate) {
  const result = [];
  function visit(parent) {for (const child of parent.children ?? []) {if (!child.tag || child.inactive) continue; if (predicate(child)) result.push(child); if (!RAW.has(child.tag)) visit(child);}}
  visit(node); return result;
}
function text(node) {
  let result = '';
  function visit(parent) {for (const child of parent.children ?? []) {
    if (child.text !== undefined) result += decode(child.text);
    else if (!child.inactive && !RAW.has(child.tag)) {
      const block = ['div','p','br','section','li'].includes(child.tag); if (block) result += ' ';
      visit(child); if (block) result += ' ';
    }
  }}
  visit(node); if (result.length > 4096) fail('gift_shape'); return result.trim().replace(/\s+/g, ' ');
}
function currentPage(root) {
  const declarations = [];
  for (const script of descendants(root, node => node.tag === 'script' && !Object.hasOwn(node.attrs, 'src') &&
    ['', 'text/javascript', 'application/javascript', 'module'].includes((attribute(node, 'type') ?? '').trim().toLowerCase()))) {
    const source = script.raw ?? ''; let at = 0;
    while (at < source.length) {
      if (source.startsWith('//', at)) {const end = source.indexOf('\n', at + 2); at = end < 0 ? source.length : end; continue;}
      if (source.startsWith('/*', at)) {const end = source.indexOf('*/', at + 2); if (end < 0) fail('page_scope'); at = end + 2; continue;}
      const quote = source[at];
      if (quote === '"' || quote === "'" || quote === '`') {
        at++; while (at < source.length && source[at] !== quote) {if (source[at] === '\\') at++; at++;}
        if (at >= source.length) fail('page_scope'); at++; continue;
      }
      const declaration = /^(?:var|let|const)\s+current_page\s*=\s*/.exec(source.slice(at));
      if (!declaration || at && /[\w$.]/.test(source[at - 1])) {at++; continue;}
      at += declaration[0].length; if (source[at] !== '"') fail('page_scope');
      const start = at++; while (at < source.length) {if (source[at] === '\\') {at += 2; continue;} if (source[at++] === '"') break;}
      let page; try {page = JSON.parse(source.slice(start, at));} catch {fail('page_scope');}
      while (space(source[at])) at++; if (source[at++] !== ';') fail('page_scope'); declarations.push(page);
      if (declarations.length > 1) fail('page_scope');
    }
  }
  if (declarations.length !== 1 || declarations[0] !== RELATIVE) fail('page_scope');
}
function canonical(value, reason = 'gift_identity') {try {return canonicalAddress(value);} catch {fail(reason);}}
function cardItem(card) {
  const nft = canonical(attribute(card, 'data-nft-address'));
  if (descendants(card, node => hasClass(node, 'js-grid-card')).length) fail('gift_shape', false, 'nested_card');
  const checkboxes = descendants(card, node => hasClass(node, 'checkbox-my-nft'));
  if (checkboxes.length !== 1) fail('gift_identity');
  const choices = descendants(checkboxes[0], node => Object.hasOwn(node.attrs, 'data-nft-address'));
  if (choices.length !== 1 || canonical(attribute(choices[0], 'data-nft-address')) !== nft) fail('gift_identity');
  const identifiers = descendants(card, node => Object.hasOwn(node.attrs, 'data-nft-address'));
  if (identifiers.some(node => canonical(attribute(node, 'data-nft-address')) !== nft)) fail('gift_identity');
  const links = descendants(card, node => hasClass(node, 'tm-grid-item-link'));
  if (links.length !== 1 || links[0].tag !== 'a') fail('gift_identity');
  const href = attribute(links[0], 'href'), match = /^\/nft\/([A-Za-z0-9_+\/-]{48})\/\?to=rent$/.exec(href ?? '');
  if (!match || canonical(match[1]) !== nft) fail('gift_identity');
  const statuses = descendants(card, node => {
    if (!hasClass(node, 'tm-grid-item-status')) return false;
    // An observed empty overlay reuses the selector without rental-state
    // classes. It is decorative and supplies no status evidence.
    if (!text(node) && !hasClass(node, 'tm-status-cian') && !hasClass(node, 'tm-status-unavail')) return false;
    // Marketapp reuses this class for an On sale badge in the separate sale
    // Price label. Only that exact secondary label is outside rental status.
    for (let parent = node.parent; parent && parent !== card; parent = parent.parent) {
      if (hasClass(parent, 'tm-grid-item-desc') && /^Price\b/.test(text(parent)) && /^On sale$/i.test(text(node))) return false;
    }
    return true;
  });
  if (statuses.length > 1) fail('gift_shape', false, {kind: 'ambiguous_status', counts: statuses.length,
    statuses: statuses.slice(0, 8).map(node => ({label: ['For Rent','Rented','On Sale','On sale',''].includes(text(node)) ? text(node) || 'empty' : 'other',
      cian: hasClass(node, 'tm-status-cian'), unavailable: hasClass(node, 'tm-status-unavail'),
      nested: statuses.some(other => {for (let parent = node.parent; parent && parent !== card; parent = parent.parent) if (parent === other) return true; return false;})}))});
  let rental_state = 'unknown', raw_status = null;
  if (statuses.length) {
    const status = statuses[0], label = text(status), style = classes(status);
    raw_status = label || null;
    if (style.has('tm-status-cian') && style.has('tm-status-unavail')) fail('gift_shape', false, 'conflicting_status');
    if (label === 'For Rent' && style.has('tm-status-cian')) rental_state = 'for_rent';
    else if (label === 'Rented' && style.has('tm-status-unavail')) rental_state = 'rented';
  }
  const labels = descendants(card, node => hasClass(node, 'tm-grid-item-desc') && /Per day/.test(text(node)));
  if (labels.length > 1) fail('price_layout');
  let price_per_day = null, currency = null;
  if (labels.length) {
    const label = labels[0]; if (text(label) !== 'Per day Min. price') fail('price_layout');
    const siblings = label.parent.children.filter(node => node.tag && !node.inactive), index = siblings.indexOf(label), values = siblings[index + 1];
    if (!values || !hasClass(values, 'tm-grid-item-values')) fail('price_layout');
    const fields = descendants(values, node => hasClass(node, 'tm-grid-item-value'));
    if (fields.length !== 2 || fields.some(node => node.parent !== values)) fail('price_layout');
    const first = fields[0], amount = text(first);
    if (hasClass(first, 'icon-ton') && amount) {
      if (!/^(?:0|[1-9]\d{0,35})(?:\.\d{1,9})?$/.test(amount)) fail('price_layout');
      price_per_day = amount; currency = 'GRAM';
    }
  }
  const timers = descendants(card, node => hasClass(node, 'tm-timer-wrap') && hasClass(node, 'js-timer-wrap'));
  if (timers.length > 1) fail('gift_shape', false, 'ambiguous_timer');
  const timer = timers.length ? text(timers[0]) : null;
  if (timer && timer.length > 64) fail('gift_shape', false, 'long_timer');
  const names = descendants(card, node => hasClass(node, 'tm-grid-item-name'));
  if (names.length > 1) fail('gift_shape', false, 'ambiguous_name');
  const name = names.length ? text(names[0]) : null;
  return {nft_address: nft, price_per_day, currency, rental_state, rental_until: null,
    rental_remaining_display: rental_state === 'rented' && timer ? timer : null, raw_role: 'my_nfts', raw_status, ...(name ? {name} : {})};
}
export function extractMarketappGiftsPage(body, options) {
  if (!object(options) || typeof options.continuation !== 'boolean' || typeof options.sourceUrl !== 'string') fail('request_parameters');
  const expected = canonical(options.wallet, 'request_parameters');
  if (options.continuation) {
    if (!options.sourceUrl.startsWith(HEAD + '&cursor=')) fail('request_parameters');
    let cursor; try {cursor = decodeURIComponent(options.sourceUrl.slice((HEAD + '&cursor=').length));} catch {fail('request_parameters');}
    if (marketappGiftsUrl(cursor) !== options.sourceUrl) fail('request_parameters');
  } else if (options.sourceUrl !== HEAD) fail('request_parameters');
  if (typeof body !== 'string' || body.length > MARKETAPP_GIFTS_PAGE_MAX_BYTES) fail();
  try {if (utf8Bytes(body).length > MARKETAPP_GIFTS_PAGE_MAX_BYTES) fail();} catch {fail();}
  let html = body, envelope = null;
  if (options.continuation) {
    envelope = exactJSON(body);
    if (!object(envelope) || Object.keys(envelope).some(key => !['h','has_more','next_cursor'].includes(key)) || typeof envelope.h !== 'string' || typeof envelope.has_more !== 'boolean') fail('response_shape');
    html = envelope.h;
  }
  const tree = readTree(html);
  if (!options.continuation) {
    let observed; try {observed = extractMarketappWalletIdentity(html);} catch (error) {fail('wallet_identity', error?.authenticationInvalid === true);}
    if (observed !== expected) fail('wallet_identity', true); currentPage(tree);
  } else if (descendants(tree, node => node.tag === 'script').length) fail('response_shape');
  const grids = descendants(tree, node => hasClass(node, 'tm-catalog-grid') && hasClass(node, 'js-table-tbody') && hasClass(node, 'js-table-wrapper'));
  if (grids.length > 1 || !options.continuation && grids.length !== 1) fail('page_structure');
  const allCards = descendants(tree, node => hasClass(node, 'js-grid-card'));
  const cards = descendants(grids[0] ?? tree, node => hasClass(node, 'js-grid-card'));
  if (allCards.length !== cards.length) fail('gift_shape', false, 'outside_catalog');
  if (cards.length > MARKETAPP_GIFTS_PAGE_SIZE) fail('gift_shape', false, 'card_bound');
  if (cards.some(node => node.tag !== 'div' || !hasClass(node, 'tm-grid-item'))) fail('gift_shape', false, 'invalid_card_markup');
  const items = cards.map(cardItem), identities = new Set(items.map(item => item.nft_address));
  if (identities.size !== items.length) fail('gift_identity');
  let hasMore, next;
  if (envelope) {hasMore = envelope.has_more; next = envelope.next_cursor ?? null;}
  else {
    const flag = attribute(grids[0], 'data-has-more'); if (!['true','false'].includes(flag)) fail('pagination');
    hasMore = flag === 'true'; next = attribute(grids[0], 'data-next-cursor');
  }
  if (hasMore) next = cursorValue(next);
  else {if (next !== null && next !== '') fail('pagination'); next = null;}
  if (envelope && grids.length) {
    const flag = attribute(grids[0], 'data-has-more'), suppliedCursor = attribute(grids[0], 'data-next-cursor');
    if (flag !== null && flag !== String(hasMore) || suppliedCursor !== null && suppliedCursor !== (next ?? '')) fail('pagination');
  }
  return {items, cursor: next, complete: !hasMore, page_size: MARKETAPP_GIFTS_PAGE_SIZE};
}
