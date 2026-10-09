// Extract inert evidence from the signed-in rental page. This module has no
// network, DOM, session, execution, or persistence capabilities. Wallet.init's
// address property is the identity used by Marketapp's public wallet bundle;
// every other initializer property (including its proof) is discarded.
import {canonicalAddress} from './cloud-pricing-core.js';
import {normalizePersonalAnalytics, utf8Bytes} from './personal-analytics.js';

export const MARKETAPP_ANALYTICS_PAGE_MAX_BYTES = 1048576;
export class MarketappAnalyticsPageError extends Error {
  constructor(reason) {
    super('The signed-in Marketapp analytics page could not be verified.');
    this.name = 'MarketappAnalyticsPageError';
    this.reason = reason;
  }
}
const fail = (reason = 'page_structure') => {throw new MarketappAnalyticsPageError(reason);};
const space = character => /[\t\n\f\r ]/.test(character || 'x');
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAW = new Set('script style textarea title iframe noscript xmp noembed noframes'.split(' '));
const LABELS = new Set(['Rent volume', 'Rentals', 'Price per day', 'Average duration', 'Extensions', 'Spent on rent']);
const CHARTS = new Set(['profile.rent.income', 'profile.rent.rentals', 'profile.rent.day_price', 'profile.rent.duration']);
// Marketapp also renders a duration histogram beside the daily series. Its
// categories describe rental lengths, not dates; it is never financial input
// for our saved daily statistics. Recognize this observed key explicitly.
const SUPPLEMENTARY_CHARTS = new Set(['profile.rent.durations']);
const ENTITIES = Object.freeze({amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003',
  copy: '\u00a9', reg: '\u00ae', times: '\u00d7', le: '\u2264', ge: '\u2265'});

// Decode exactly once, like getAttribute/textContent. Unknown or malformed
// character references in extracted evidence are rejected, not guessed.
function decode(text) {
  return text.replace(/&(?:#[^\s&<>;]*|[A-Za-z][A-Za-z0-9]*);?/g, entity => {
    if (!entity.endsWith(';')) fail();
    const name = entity.slice(1, -1);
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    const numeric = /^#(?:([0-9]+)|x([0-9a-f]+))$/i.exec(name);
    if (!numeric) fail();
    const code = Number.parseInt(numeric[1] || numeric[2], numeric[1] ? 10 : 16);
    if (!Number.isSafeInteger(code) || code < 32 && ![9, 10, 13].includes(code) || code === 127 ||
      code >= 0xd800 && code <= 0xdfff || code > 0x10ffff) fail();
    return String.fromCodePoint(code);
  });
}

// A small strict JSON reader for Wallet.init, with duplicate-key rejection.
// It deliberately accepts JSON only, never evaluates a JavaScript expression.
function initializerJSON(source) {
  if (source.length > 16384) fail('wallet_identity');
  let at = 0;
  const skip = () => {while (/[\t\r\n ]/.test(source[at] || 'x')) at++;};
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') {at += 2; continue;}
      if (source[at++] === '"') {
        try {return JSON.parse(source.slice(start, at));} catch {fail('wallet_identity');}
      }
    }
    fail('wallet_identity');
  }
  function value(depth = 0) {
    if (depth > 16) fail('wallet_identity'); skip();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; const result = Object.create(null); skip();
      if (source[at] === '}') {at++; return result;}
      for (;;) {
        skip(); if (source[at] !== '"') fail('wallet_identity'); const key = string();
        if (Object.hasOwn(result, key)) fail('wallet_identity'); skip();
        if (source[at++] !== ':') fail('wallet_identity'); result[key] = value(depth + 1); skip();
        const next = source[at++]; if (next === '}') return result; if (next !== ',') fail('wallet_identity');
      }
    }
    if (source[at] === '[') {
      at++; const result = []; skip(); if (source[at] === ']') {at++; return result;}
      for (;;) {result.push(value(depth + 1)); skip(); const next = source[at++]; if (next === ']') return result; if (next !== ',') fail('wallet_identity');}
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, at)) {at += token.length; return result;}
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0];
    if (!number || number.length > 128) fail('wallet_identity'); at += number.length;
    // Non-identity fields are discarded; their numbers need no interpretation.
    return null;
  }
  const result = value(); skip(); if (at !== source.length) fail('wallet_identity'); return result;
}

function walletInitializers(script) {
  if (!/\bWallet\s*\.\s*init\s*\(/.test(script)) return [];
  const values = [];
  let at = 0;
  while (at < script.length) {
    const character = script[at];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character; at++;
      while (at < script.length && script[at] !== quote) {if (script[at] === '\\') at++; at++;}
      if (at >= script.length) fail('wallet_identity'); at++; continue;
    }
    if (script.startsWith('//', at)) {at = script.indexOf('\n', at + 2); if (at < 0) break; continue;}
    if (script.startsWith('/*', at)) {const end = script.indexOf('*/', at + 2); if (end < 0) fail('wallet_identity'); at = end + 2; continue;}
    const match = /^Wallet\s*\.\s*init\s*\(/.exec(script.slice(at));
    if (!match || at && /[\w$.]/.test(script[at - 1])) {at++; continue;}
    at += match[0].length; while (space(script[at])) at++;
    if (script[at] !== '{') fail('wallet_identity');
    const start = at; let depth = 0, quoted = false;
    for (; at < script.length; at++) {
      const next = script[at];
      if (quoted) {if (next === '\\') at++; else if (next === '"') quoted = false; continue;}
      if (next === '"') {quoted = true; continue;}
      if (next === '{' || next === '[') depth++;
      if (next === '}' || next === ']') depth--;
      if (depth === 0) {at++; break;}
      if (depth < 0 || depth > 16 || at - start > 16384) fail('wallet_identity');
    }
    if (depth || quoted) fail('wallet_identity');
    const value = initializerJSON(script.slice(start, at)); while (space(script[at])) at++;
    if (script[at++] !== ')') fail('wallet_identity'); values.push(value);
    if (values.length > 1) fail('wallet_identity');
  }
  return values;
}

function readPage(html) {
  let at = 0, tokens = 0;
  const stack = [], summary = [], charts = [], identities = [];
  const labels = new Set(), chartKeys = new Set();
  const inactive = () => stack.some(entry => entry.tag === 'template');
  const activeTile = () => stack.findLast(entry => entry.tile)?.tile;
  const activeField = () => stack.findLast(entry => entry.field)?.field;
  function text(content) {
    const field = activeField();
    if (!inactive() && field) {
      field.text += decode(content); if (field.text.length > 4096) fail();
    }
  }
  function finish(entry) {
    if (entry.field) entry.field.tile[entry.field.name] = entry.field.text.trim();
    if (entry.tile) {
      const row = entry.tile;
      if (typeof row.label !== 'string' || typeof row.value !== 'string' || !LABELS.has(row.label) || labels.has(row.label)) fail('analytics_shape');
      labels.add(row.label); summary.push({label: row.label, value: row.value, foot: row.foot ?? '', definition: row.definition ?? ''});
      if (summary.length > 6) fail('analytics_shape');
    }
  }
  while (at < html.length) {
    if (++tokens > 50000) fail();
    if (html[at] !== '<') {const end = html.indexOf('<', at); text(html.slice(at, end < 0 ? html.length : end)); at = end < 0 ? html.length : end; continue;}
    if (html.startsWith('<!--', at)) {const end = html.indexOf('-->', at + 4); if (end < 0) fail(); at = end + 3; continue;}
    const doctype = /^<!doctype\s+html\s*>/i.exec(html.slice(at));
    if (doctype) {if (stack.length || summary.length || charts.length || identities.length) fail(); at += doctype[0].length; continue;}
    const closing = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>/.exec(html.slice(at));
    if (closing) {
      const tag = closing[1].toLowerCase(), entry = stack.pop();
      if (!entry || entry.tag !== tag) fail(); finish(entry); at += closing[0].length; continue;
    }
    const opening = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(at)); if (!opening) fail();
    const tag = opening[1].toLowerCase(); at += opening[0].length;
    const attributes = Object.create(null); let selfClosing = false, previousQuoted = false;
    for (;;) {
      let whitespace = false; while (space(html[at])) {whitespace = true; at++;}
      if (html[at] === '>') {at++; break;}
      if (html.startsWith('/>', at)) {selfClosing = true; at += 2; break;}
      // Marketapp's public minifier emits name="viewport"content="...".
      // A closing quote makes that next boundary deterministic; never apply
      // this allowance to unquoted values, boolean attributes, or tag names.
      if (!whitespace && !previousQuoted) fail();
      const name = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(html.slice(at))?.[0]; if (!name) fail(); at += name.length;
      const key = name.toLowerCase(); if (Object.hasOwn(attributes, key) || Object.keys(attributes).length >= 100) fail();
      const afterName = at; while (space(html[at])) at++;
      let value = ''; previousQuoted = false;
      if (html[at] === '=') {
        at++; while (space(html[at])) at++;
        const quote = html[at];
        if (quote === '"' || quote === "'") {const end = html.indexOf(quote, ++at); if (end < 0) fail(); value = html.slice(at, end); at = end + 1; previousQuoted = true;}
        else {const raw = /^[^\s"'=<>`]+/.exec(html.slice(at))?.[0]; if (!raw) fail(); value = raw; at += raw.length;}
      } else at = afterName;
      if (value.length > 262144) fail(); attributes[key] = value;
    }
    if (selfClosing && !VOID.has(tag) && !['svg', 'math'].includes(tag) && !stack.some(entry => ['svg', 'math'].includes(entry.tag))) fail();
    const entry = {tag};
    if (!inactive()) {
      const classes = new Set((attributes.class ? decode(attributes.class) : '').split(/\s+/));
      const tile = activeTile();
      if (classes.has('ma-an-tile')) {if (tile || activeField()) fail(); entry.tile = {seen: new Set()};}
      const fields = ['label', 'value', 'foot'].filter(name => classes.has('ma-an-tile-' + name));
      if (fields.length) {
        if (fields.length !== 1 || !tile || activeField() || tile.seen.has(fields[0]) || entry.tile) fail();
        tile.seen.add(fields[0]); entry.field = {name: fields[0], tile, text: ''};
      }
      if (classes.has('ma-an-info') && tile) {
        if (tile.seen.has('definition')) fail(); tile.seen.add('definition');
        tile.definition = decode(attributes['data-bs-title'] ?? ''); if (tile.definition.length > 4096) fail();
      }
      if (classes.has('js-ma-chart')) {
        if (tile || activeField() || stack.some(parent => parent.chart)) fail(); entry.chart = true;
        const key = decode(attributes['data-key'] ?? ''), spec_raw = decode(attributes['data-spec'] ?? '');
        if ((!CHARTS.has(key) && !SUPPLEMENTARY_CHARTS.has(key)) || !spec_raw || chartKeys.has(key)) fail('analytics_shape');
        chartKeys.add(key);
        if (CHARTS.has(key)) {charts.push({key, spec_raw}); if (charts.length > 4) fail('analytics_shape');}
      }
    }
    if (RAW.has(tag) && !selfClosing) {
      const endPattern = new RegExp('</' + tag + '\\s*>', 'ig'); endPattern.lastIndex = at;
      const closingRaw = endPattern.exec(html); if (!closingRaw) fail();
      const raw = html.slice(at, closingRaw.index);
      if (entry.field || entry.tile || entry.chart || activeField() && !['textarea', 'title'].includes(tag)) fail();
      if (tag === 'script' && !inactive() && !Object.hasOwn(attributes, 'src') &&
        ['', 'text/javascript', 'application/javascript', 'module'].includes(decode(attributes.type ?? '').trim().toLowerCase())) {
        identities.push(...walletInitializers(raw)); if (identities.length > 1) fail('wallet_identity');
      }
      // RCDATA text contributes to DOM textContent; executable/raw text cannot
      // supply financial fields or wallet identity through fake nested markup.
      if (['textarea', 'title'].includes(tag)) text(raw);
      at = closingRaw.index + closingRaw[0].length; continue;
    }
    if (VOID.has(tag) || selfClosing) finish(entry);
    else {stack.push(entry); if (stack.length > 128) fail();}
  }
  if (stack.length) fail();
  if (identities.length !== 1 || !identities[0] || typeof identities[0].address !== 'string') fail('wallet_identity');
  return {summary, charts, address: identities[0].address};
}

function checkOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('request_parameters');
  const {wallet, periodDays, capturedAt, sourceUrl} = options;
  if (![30, 365].includes(periodDays) || typeof capturedAt !== 'string' || typeof sourceUrl !== 'string' || sourceUrl.length > 2048) fail('request_parameters');
  let expected; try {expected = canonicalAddress(wallet);} catch {fail('request_parameters');}
  const match = /^https:\/\/marketapp\.org\/user\/([A-Za-z0-9_-]{48})\/\?([^#]+)$/.exec(sourceUrl);
  if (!match) fail('request_parameters');
  let pageWallet; try {pageWallet = canonicalAddress(match[1]);} catch {fail('request_parameters');}
  if (pageWallet !== expected) fail('wallet_identity');
  const pairs = match[2].split('&'), required = {tab: 'analytics_rent', group_by: 'day', period_by: 'last' + periodDays + 'days'};
  if (pairs.length !== 3) fail('request_parameters');
  const seen = new Set();
  for (const pair of pairs) {
    const entry = /^([^=]+)=([^=]+)$/.exec(pair);
    if (!entry || !Object.hasOwn(required, entry[1]) || required[entry[1]] !== entry[2] || seen.has(entry[1])) fail('request_parameters');
    seen.add(entry[1]);
  }
  return expected;
}

export function extractMarketappAnalyticsPage(html, options) {
  const expected = checkOptions(options);
  if (typeof html !== 'string' || html.length > MARKETAPP_ANALYTICS_PAGE_MAX_BYTES) fail('page_structure');
  try {if (utf8Bytes(html).length > MARKETAPP_ANALYTICS_PAGE_MAX_BYTES) fail('page_structure');} catch {fail('page_structure');}
  const {summary, charts, address} = readPage(html);
  let observed; try {observed = canonicalAddress(address);} catch {fail('wallet_identity');}
  if (observed !== expected) fail('wallet_identity');
  const snapshot = {version: 1, source: 'marketapp_personal_rent_page', source_url: options.sourceUrl,
    wallet: expected, captured_at: options.capturedAt, summary, charts};
  let normalized;
  try {normalized = normalizePersonalAnalytics(JSON.stringify(snapshot), expected);} catch {fail('analytics_shape');}
  if (normalized.daily.length !== options.periodDays || normalized.period_end !== normalized.captured_at.slice(0, 10)) fail('period_span');
  return snapshot;
}
