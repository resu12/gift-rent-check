// Signed-in webpage snapshots only. This module never fetches Marketapp,
// accesses website sessions, or combines personal revenue with public history.
import {canonicalAddress, canonicalJSON} from './cloud-pricing-core.js';
import {sha256} from './ton-price-decoder.js';

export const PERSONAL_ANALYTICS_MAX_BYTES = 262144;
const DAY = 86400000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber);
const invalid = () => {throw new Error('The analytics snapshot is invalid. Export it again from the signed-in Marketapp rental analytics page.');};
class JsonNumber {constructor(text) {this.text = text;}}
export function utf8Bytes(text) {
  const bytes = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) invalid();
    if (code < 128) bytes.push(code);
    else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
    else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
    else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
  }
  return Uint8Array.from(bytes);
}

// Preserve numeric JSON lexemes before any floating-point conversion, and
// reject duplicate properties rather than accepting ambiguous evidence.
function parseExact(text) {
  if (typeof text !== 'string') invalid();
  let at = 0;
  const skip = () => {while (/[\t\r\n ]/.test(text[at] || 'x')) at++;};
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') {at += 2; continue;}
      if (text[at++] === '"') {try {return JSON.parse(text.slice(start, at));} catch {invalid();}}
    }
    invalid();
  }
  function value(depth = 0) {
    if (depth > 32) invalid();
    skip();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; const result = Object.create(null); skip();
      if (text[at] === '}') {at++; return result;}
      for (;;) {
        skip(); if (text[at] !== '"') invalid(); const key = string();
        if (Object.hasOwn(result, key)) invalid(); skip(); if (text[at++] !== ':') invalid();
        result[key] = value(depth + 1); skip(); const next = text[at++];
        if (next === '}') return result; if (next !== ',') invalid();
      }
    }
    if (text[at] === '[') {
      at++; const result = []; skip(); if (text[at] === ']') {at++; return result;}
      for (;;) {result.push(value(depth + 1)); skip(); const next = text[at++]; if (next === ']') return result; if (next !== ',') invalid();}
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, at)) {at += token.length; return result;}
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0];
    if (!token || token.length > 128) invalid(); at += token.length; return new JsonNumber(token);
  }
  const result = value(); skip(); if (at !== text.length) invalid(); return result;
}

function fixed(value, numeric = false, maxDigits = numeric ? 24 : 27, integral = false) {
  let text = value instanceof JsonNumber ? value.text : !numeric && typeof value === 'string' ? value.trim() : null;
  if (text === null) invalid();
  if (!(value instanceof JsonNumber)) {
    if (text.includes(',')) {
      if (!/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,4})?$/.test(text)) invalid();
      text = text.replaceAll(',', '');
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) invalid();
  }
  const parsed = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!parsed) invalid();
  const fraction = parsed[3] || '', exponent = Number(parsed[4] || 0) - fraction.length;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || (!integral && exponent < -4)) invalid();
  const coefficient = BigInt(parsed[2] + fraction);
  if (parsed[1] && coefficient !== 0n) invalid();
  const adjusted = coefficient === 0n ? 0 : String(coefficient).length - 1 + exponent;
  if (adjusted >= maxDigits) invalid();
  const scale = exponent + 4;
  if (scale >= 0) return coefficient * 10n ** BigInt(scale);
  const divisor = 10n ** BigInt(-scale);
  if (coefficient % divisor) invalid();
  return coefficient / divisor;
}
const money = value => `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`.replace(/\.?0+$/, '') || '0';
function count(value, numeric = true) {
  const scaled = fixed(value, numeric, 27, true);
  if (scaled % 10000n || scaled / 10000n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(scaled / 10000n);
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const instant = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) invalid();
  return instant;
}
function captureTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid();
  // Validate the calendar component separately; Date.parse normalizes invalid days.
  date(value.slice(0, 10));
  const instant = Date.parse(value); if (!Number.isFinite(instant)) invalid();
  return new Date(instant).toISOString();
}
function sourceUrl(value, wallet) {
  if (typeof value !== 'string' || value.length > 2048) invalid();
  const parsed = /^https:\/\/marketapp\.org\/user\/([A-Za-z0-9_+/-]{48})\/?(?:\?([^#]*))?$/.exec(value);
  if (!parsed) invalid();
  let sourceWallet; try {sourceWallet = canonicalAddress(parsed[1]);} catch {invalid();}
  if (sourceWallet !== wallet) invalid();
  const query = new Map();
  for (const entry of (parsed[2] || '').split('&').filter(Boolean)) {
    const parts = entry.split('='); if (parts.length !== 2) invalid();
    let key, field; try {key = decodeURIComponent(parts[0]); field = decodeURIComponent(parts[1]);} catch {invalid();}
    if (query.has(key)) invalid(); query.set(key, field);
  }
  if (query.get('tab') !== 'analytics_rent') invalid();
  for (const [key, field] of query) {
    if (!['tab', 'period_by', 'group_by'].includes(key)) invalid();
    if (key === 'period_by' && !/^last(?:7|14|30|60|90|180|365)days$/.test(field)) invalid();
    if (key === 'group_by' && !['auto', 'day', 'week', 'month'].includes(field)) invalid();
  }
  return value;
}
function summaryRows(rows) {
  if (!Array.isArray(rows) || rows.length > 30) invalid();
  const result = new Map();
  for (const row of rows) {
    if (!object(row) || typeof row.label !== 'string') invalid();
    if (!['Rent volume', 'Rentals', 'Price per day', 'Average duration', 'Extensions', 'Spent on rent'].includes(row.label)) continue;
    if (!(row.value === null || typeof row.value === 'string') || result.has(row.label)) invalid();
    if (row.foot !== undefined && row.foot !== null && typeof row.foot !== 'string') invalid();
    result.set(row.label, row);
  }
  if (!result.has('Rent volume') || !result.has('Rentals')) invalid();
  return result;
}
function optionalDecimal(rows, label, suffix = '') {
  const row = rows.get(label); if (!row || row.value === null || ['', '—', '–', '-'].includes(row.value.trim())) return null;
  let value = row.value.trim();
  if (suffix) value = value.replace(new RegExp('\\s*' + suffix + '$'), '').trim();
  return money(fixed(value));
}
function footCount(rows, label, unit) {
  const row = rows.get(label); if (!row || !row.foot || !row.foot.trim()) return null;
  const matches = [...row.foot.matchAll(new RegExp('(?<![\\d.,])(\\d+(?:,\\d{3})*)\\s+' + unit + '\\b', 'g'))];
  if (!matches.length) return null;
  if (matches.length !== 1) invalid();
  return count(matches[0][1], false);
}
function chart(spec, dates, names, unit) {
  if (!object(spec) || spec.gran !== 'day' || spec.unit !== unit || !Array.isArray(spec.x) || !Array.isArray(spec.series) || spec.series.length !== names.length) invalid();
  if (spec.categories !== undefined && spec.categories !== null) invalid();
  if (spec.x.length !== dates.length || spec.x.some((value, index) => value !== dates[index])) invalid();
  const series = new Map();
  for (const row of spec.series) {
    if (!object(row) || !names.includes(row.name) || series.has(row.name) || !Array.isArray(row.data) || row.data.length !== dates.length) invalid();
    if (row.unit !== undefined && row.unit !== unit) invalid(); series.set(row.name, row.data);
  }
  return series;
}

// Observed October 2026 layout: one daily activity chart supplies both counts
// and gross volume on separate axes. Keep its raw spec in the snapshot and
// project the exact parsed numeric lexemes only in memory. JSON.parse followed
// by JSON.stringify would round financial values before verification.
function activityCharts(spec) {
  const fields = ['categories', 'combo', 'gran', 'kind', 'series', 'stacking', 'unit', 'x'];
  if (!object(spec) || Object.keys(spec).some(key => !fields.includes(key)) || spec.categories !== null ||
      spec.combo !== true || spec.gran !== 'day' || spec.kind !== 'column' || spec.stacking !== 'normal' || spec.unit !== '' ||
      !Array.isArray(spec.x) || !Array.isArray(spec.series) || spec.series.length !== 3) invalid();
  const expected = new Map([['New rentals', {type: 'column', axis: 0, unit: ''}],
    ['Extensions', {type: 'column', axis: 0, unit: ''}], ['Rent volume', {type: 'line', axis: 1, unit: 'GRAM'}]]);
  const rows = new Map();
  for (const row of spec.series) {
    const shape = object(row) ? expected.get(row.name) : null;
    if (!shape || rows.has(row.name) || Object.keys(row).some(key => !['name', 'data', 'type', 'axis', 'unit', 'color', 'opacity'].includes(key)) ||
        row.type !== shape.type || row.unit !== shape.unit || !(row.axis instanceof JsonNumber) || count(row.axis) !== shape.axis ||
        !Array.isArray(row.data) || row.data.length !== spec.x.length) invalid();
    // Decorative fields cannot change the interpreted identity, unit or axis.
    if (row.color !== undefined && (!(row.color instanceof JsonNumber) || count(row.color) > 255)) invalid();
    if (row.opacity !== undefined && (!(row.opacity instanceof JsonNumber) || fixed(row.opacity, true) > 10000n)) invalid();
    rows.set(row.name, {name: row.name, data: row.data});
  }
  return {
    income: {gran: 'day', unit: 'GRAM', x: spec.x, series: [rows.get('Rent volume')]},
    rentals: {gran: 'day', unit: '', x: spec.x, series: [rows.get('New rentals'), rows.get('Extensions')]},
  };
}

const TOP_HEADERS = ['Item','Rentals','Rented days','Volume','Price per day'];
function topItem(value, normalized = false) {
  if (!object(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\u0000-\u001f\u007f]/.test(value.name)) invalid();
  const href = typeof value.item_url === 'string' && /^(?:https:\/\/marketapp\.org)?\/nft\/([A-Za-z0-9_+-]{48})\/?$/.exec(value.item_url);
  if (!href) invalid();
  let key; try {key = canonicalAddress(href[1]);} catch {invalid();}
  if (normalized && value.item_key !== key) invalid();
  const rentals = normalized ? value.rentals : count(value.rentals, false);
  if (!Number.isSafeInteger(rentals) || rentals < 0) invalid();
  return {item_key:key, name:value.name.trim(), item_url:`https://marketapp.org/nft/${href[1].replaceAll('+','-')}/`,
    rentals, rented_days:money(fixed(value.rented_days)), volume:money(fixed(value.volume)),
    price_per_day:value.price_per_day === null ? null : money(fixed(value.price_per_day))};
}
function topItems(value, normalized = false) {
  if (value === undefined) return {status:'missing',scope:'marketapp_top_items',items:[]};
  if (!object(value) || !['available','missing'].includes(value.status) || !Array.isArray(value.items) || value.items.length > 100
      || value.status === 'missing' && value.items.length) invalid();
  const items=value.items.map(row=>topItem(row,normalized));
  if(new Set(items.map(row=>row.item_key)).size!==items.length)invalid();
  return {status:value.status,scope:'marketapp_top_items',items};
}
function sourceTopItems(source) {
  const matches=Array.isArray(source.tables)?source.tables.filter(table=>object(table)&&Array.isArray(table.headers)
    && table.headers.length===TOP_HEADERS.length&&table.headers.every((label,index)=>label===TOP_HEADERS[index])):[];
  if(matches.length>1)invalid();
  let legacy;
  if(matches.length) {
    if(!Array.isArray(matches[0].rows)||matches[0].rows.length>100)invalid();
    legacy=topItems({status:'available',items:matches[0].rows.map(row=>{
      if(!object(row)||!Array.isArray(row.cells)||row.cells.length!==5||row.cells.some(value=>typeof value!=='string')
        || !Array.isArray(row.links)||row.links.length!==1||!object(row.links[0])||row.links[0].label!==row.cells[0])invalid();
      return {name:row.cells[0],item_url:row.links[0].url,rentals:row.cells[1],rented_days:row.cells[2],volume:row.cells[3],price_per_day:row.cells[4]};
    })});
  }
  const explicit=source.top_items===undefined?null:topItems(source.top_items);
  if(explicit&&legacy&&canonicalJSON(explicit)!==canonicalJSON(legacy))invalid();
  return explicit??legacy??topItems(undefined);
}

const COLLECTION_HEADERS = ['Collection','Rentals','Volume','Price per day'];
const COLLECTION_EXTENDED_HEADERS = ['','Collection','Rentals','Volume','Price per day','Average duration','Share of volume'];
function collectionItem(value, normalized = false) {
  if (!object(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\u0000-\u001f\u007f]/.test(value.name)) invalid();
  const name=value.name.trim().replace(/\s+/g,' '),key='name:'+name.toLowerCase();
  if(normalized&&value.collection_key!==key)invalid();
  const rentals=normalized?value.rentals:count(value.rentals,false);
  if(!Number.isSafeInteger(rentals)||rentals<0)invalid();
  return {collection_key:key,name,rentals,volume:money(fixed(value.volume)),
    price_per_day:value.price_per_day===null||typeof value.price_per_day==='string'&&['','—','–','-'].includes(value.price_per_day.trim())?null:money(fixed(value.price_per_day))};
}
function collectionItems(value,normalized=false) {
  if(value===undefined)return {status:'missing',scope:'marketapp_by_collection',items:[]};
  if(!object(value)||!['available','missing'].includes(value.status)||!Array.isArray(value.items)||value.items.length>200
    ||value.status==='missing'&&value.items.length)invalid();
  const items=value.items.map(row=>collectionItem(row,normalized));
  if(new Set(items.map(row=>row.collection_key)).size!==items.length)invalid();
  return {status:value.status,scope:'marketapp_by_collection',items};
}
function sourceCollections(source) {
  const matches=Array.isArray(source.tables)?source.tables.filter(table=>object(table)&&Array.isArray(table.headers)&&table.headers.includes('Collection')):[];
  if(matches.length>1)invalid();
  let legacy;
  if(matches.length) {
    const extended=matches[0].headers.length===7,headers=extended?COLLECTION_EXTENDED_HEADERS:COLLECTION_HEADERS;
    if(matches[0].headers.length!==headers.length||matches[0].headers.some((label,index)=>label!==headers[index])
      ||!Array.isArray(matches[0].rows)||matches[0].rows.length>200)invalid();
    legacy=collectionItems({status:'available',items:matches[0].rows.map(row=>{
      if(!object(row)||!Array.isArray(row.cells)||row.cells.length!==headers.length||row.cells.some(value=>typeof value!=='string')||!Array.isArray(row.links))invalid();
      const cells=extended?row.cells.slice(1,5):row.cells;
      if(extended) {
        if(row.cells[0]!==''||row.links.length!==2||row.links.some(link=>!object(link)||!validCollectionLink(link.url))
          ||row.links[0].label!==''||row.links[1].label!==cells[0]
          ||row.links[0].url.replace(/^https:\/\/marketapp\.org/,'')!==row.links[1].url.replace(/^https:\/\/marketapp\.org/,'')
          ||row.cells.slice(5).some(value=>value.length>200||/[\u0000-\u001f\u007f]/.test(value)))invalid();
      }else if(row.links.length>1||row.links.length&&(!object(row.links[0])||row.links[0].label!==cells[0]||!validCollectionLink(row.links[0].url)))invalid();
      return {name:cells[0],rentals:cells[1],volume:cells[2],price_per_day:cells[3]};
    })});
  }
  const explicit=source.by_collection===undefined?null:collectionItems(source.by_collection);
  if(explicit&&legacy&&canonicalJSON(explicit)!==canonicalJSON(legacy))invalid();
  return explicit??legacy??collectionItems(undefined);
}
function validCollectionLink(value) {
  return typeof value==='string'&&value.length<=2048&&!/[\\\u0000-\u0020\u007f]/.test(value)
    &&/^(?:https:\/\/marketapp\.org)?\/(?!\/)/.test(value);
}

export function normalizePersonalAnalytics(raw, configuredWallet) {
  if (typeof raw !== 'string' || raw.length > PERSONAL_ANALYTICS_MAX_BYTES || utf8Bytes(raw).length > PERSONAL_ANALYTICS_MAX_BYTES) invalid();
  const source = parseExact(raw);
  if (!object(source) || !(source.version instanceof JsonNumber) || count(source.version) !== 1 || source.source !== 'marketapp_personal_rent_page') invalid();
  if (Object.keys(source).some(key => !['version', 'source', 'source_url', 'wallet', 'captured_at', 'summary', 'charts', 'tables', 'top_items', 'by_collection'].includes(key))) invalid();
  let wallet, expected; try {wallet = canonicalAddress(source.wallet); expected = canonicalAddress(configuredWallet);} catch {invalid();}
  if (wallet !== expected) throw new Error('The analytics snapshot belongs to a different wallet. Export the configured wallet’s rental analytics.');
  const capturedAt = captureTime(source.captured_at), url = sourceUrl(source.source_url, wallet);
  const summary = summaryRows(source.summary);
  if (!Array.isArray(source.charts) || source.charts.length > 20) invalid();
  const charts = new Map();
  for (const entry of source.charts) {
    if (!object(entry) || typeof entry.key !== 'string' || typeof entry.spec_raw !== 'string' || charts.has(entry.key)) invalid();
    charts.set(entry.key, parseExact(entry.spec_raw));
  }
  const combined = charts.has('profile.rent.activity');
  if (combined && (charts.has('profile.rent.income') || charts.has('profile.rent.rentals'))) invalid();
  const projected = combined ? activityCharts(charts.get('profile.rent.activity')) : null;
  const income = projected?.income ?? charts.get('profile.rent.income'), rentals = projected?.rentals ?? charts.get('profile.rent.rentals');
  if (!object(income) || !Array.isArray(income.x) || income.x.length < 1 || income.x.length > 366) invalid();
  const dates = income.x;
  for (let index = 0; index < dates.length; index++) {
    const instant = date(dates[index]);
    if (index && instant !== date(dates[index - 1]) + DAY) invalid();
  }
  if (date(dates.at(-1)) > Date.parse(capturedAt)) invalid();
  const volumes = chart(income, dates, ['Rent volume'], 'GRAM').get('Rent volume');
  const counts = chart(rentals, dates, ['New rentals', 'Extensions'], '');
  for (const [key, names, unit] of [['profile.rent.day_price', ['Price per day'], 'GRAM'], ['profile.rent.duration', ['Average duration'], 'days']]) {
    if (!charts.has(key)) continue;
    for (const values of chart(charts.get(key), dates, names, unit).values()) for (const value of values) if (value !== null) fixed(value, true);
  }
  let volume = 0n, starts = 0, extensions = 0;
  const daily = dates.map((day, index) => {
    const amount = fixed(volumes[index], true), newRentals = count(counts.get('New rentals')[index]), extendsCount = count(counts.get('Extensions')[index]);
    volume += amount; starts += newRentals; extensions += extendsCount;
    if (!Number.isSafeInteger(starts + extensions) || !Number.isSafeInteger(newRentals + extendsCount)) invalid();
    return {date: day, rent_volume: money(amount), new_rentals: newRentals, extensions: extendsCount, rentals: newRentals + extendsCount};
  });
  const reportedVolume = fixed(summary.get('Rent volume').value);
  // This observed combined layout renders annual volume as a whole GRAM.
  // Reconcile at the precision actually displayed, with exact half-up rounding;
  // keep the legacy separate-chart minimum of two places unchanged.
  const places = Math.max(combined ? 0 : 2, (summary.get('Rent volume').value.trim().split('.')[1] || '').length);
  const quantum = 10n ** BigInt(4 - places);
  const roundedVolume = (volume + quantum / 2n) / quantum * quantum;
  if (reportedVolume !== roundedVolume || count(summary.get('Rentals').value, false) !== starts + extensions) invalid();
  const extensionPercent = optionalDecimal(summary, 'Extensions', '%');
  if (extensionPercent !== null && fixed(extensionPercent) > 1000000n) invalid();
  const normalized = {version: 1, source: source.source, source_url: url, wallet, captured_at: capturedAt,
    period_start: dates[0], period_end: dates.at(-1), timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees',
    summary: {rent_volume: money(reportedVolume), rentals: starts + extensions, new_rentals: starts, extensions,
      items: footCount(summary, 'Rentals', 'items'), price_per_day: optionalDecimal(summary, 'Price per day'),
      average_duration: optionalDecimal(summary, 'Average duration', 'days'), extension_percent: extensionPercent,
      spent_on_rent: optionalDecimal(summary, 'Spent on rent'), spending_rentals: footCount(summary, 'Spent on rent', 'rentals')}, daily,
    top_items:sourceTopItems(source),by_collection:sourceCollections(source)};
  const fingerprint = Array.from(sha256(utf8Bytes(canonicalJSON(normalized))), byte => byte.toString(16).padStart(2, '0')).join('');
  return {...normalized, fingerprint};
}

export function configuredAnalyticsWallet(records) {
  const settings = {};
  for (const row of records) if (row.kind === 'settings') Object.assign(settings, row.record);
  try {return canonicalAddress(settings.wallet ?? settings.wallet_address);} catch {return null;}
}

// Legacy captures already include the provider table in their raw export.
// Revalidate that export and every previously interpreted field before adding
// its table. Preserve the original snapshot identity and source body; this is
// a projection upgrade, not a new Marketapp observation or refresh timestamp.
export function upgradePersonalAnalyticsTopItems(row) {
  let saved;try{saved=typeof row.normalized_json==='string'?JSON.parse(row.normalized_json):row;}catch{return null;}
  if(!object(saved))return saved;
  if(saved.top_items!==undefined)try{saved={...saved,top_items:topItems(saved.top_items,true)};}catch{saved={...saved,top_items:topItems(undefined)};}
  if(saved.by_collection!==undefined)try{saved={...saved,by_collection:collectionItems(saved.by_collection,true)};}catch{saved={...saved,by_collection:collectionItems(undefined)};}
  if(saved.top_items?.status==='available'&&saved.by_collection?.status==='available')return saved;
  try {
    const normalized=normalizePersonalAnalytics(row.raw_snapshot,saved.wallet);
    const {fingerprint:oldFingerprint,top_items:oldItems,by_collection:oldCollections,...oldBase}=saved;
    const {fingerprint:newFingerprint,top_items:newItems,by_collection:newCollections,...newBase}=normalized;
    if(canonicalJSON(oldBase)===canonicalJSON(newBase))return {...saved,top_items:oldItems?.status==='available'?oldItems:newItems,
      by_collection:oldCollections?.status==='available'?oldCollections:newCollections};
  }catch{/* Keep the saved report if its legacy source cannot be proven. */}
  return saved;
}

const dailyTable = publicScope => publicScope ? 'public_personal_analytics_daily' : 'personal_analytics_daily';
const snapshotTable = publicScope => publicScope ? 'public_personal_rental_analytics' : 'personal_rental_analytics';
const itemReportTable = publicScope => publicScope ? 'public_personal_analytics_item_reports' : 'personal_analytics_item_reports';
const collectionReportTable = publicScope => publicScope ? 'public_personal_analytics_collection_reports' : 'personal_analytics_collection_reports';
// Reserved archive metadata, outside both real gift and collection key domains.
// It records an observed empty table without inventing a zero-valued item.
const EMPTY_REPORT_KEY='table:empty';
const EMPTY_REPORT_JSON='{"status":"available","items":[]}';
export const PERSONAL_ANALYTICS_DAILY_BYTES = "length(CAST(row_id AS BLOB))+length(CAST(wallet AS BLOB))+length(CAST(date AS BLOB))+length(CAST(captured_at AS BLOB))+length(CAST(fingerprint AS BLOB))+length(CAST(rent_volume AS BLOB))+length(CAST(new_rentals AS BLOB))+length(CAST(extensions AS BLOB))";
export const PERSONAL_ANALYTICS_ITEM_BYTES = "length(CAST(row_id AS BLOB))+length(CAST(wallet AS BLOB))+length(CAST(item_key AS BLOB))+length(CAST(period_start AS BLOB))+length(CAST(period_end AS BLOB))+length(CAST(captured_at AS BLOB))+length(CAST(fingerprint AS BLOB))+length(CAST(item_json AS BLOB))";
export const PERSONAL_ANALYTICS_COLLECTION_BYTES = "length(CAST(row_id AS BLOB))+length(CAST(wallet AS BLOB))+length(CAST(collection_key AS BLOB))+length(CAST(period_start AS BLOB))+length(CAST(period_end AS BLOB))+length(CAST(captured_at AS BLOB))+length(CAST(fingerprint AS BLOB))+length(CAST(item_json AS BLOB))";
const dailyTriggerName=(publicScope,event)=>`personal_analytics_daily_v1_${publicScope?'public':'private'}_${event}`;
const itemTriggerName=(publicScope,event)=>`personal_analytics_items_v1_${publicScope?'public':'private'}_${event}`;
const collectionTriggerName=(publicScope,event)=>`personal_analytics_collections_v1_${publicScope?'public':'private'}_${event}`;
const emptyItemTriggerName=(publicScope,event)=>`personal_analytics_empty_items_v1_${publicScope?'public':'private'}_${event}`;
const emptyCollectionTriggerName=(publicScope,event)=>`personal_analytics_empty_collections_v1_${publicScope?'public':'private'}_${event}`;
export function personalAnalyticsDailyReadySQL(publicScope=false) {
  const names=[dailyTriggerName,itemTriggerName,collectionTriggerName,emptyItemTriggerName,emptyCollectionTriggerName].flatMap(name=>['insert','old_update','update','delete'].map(event=>name(publicScope,event)));
  return `(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN(${names.map(name=>`'${name}'`).join(',')}))=20`;
}
export function personalAnalyticsSnapshotPreservedSQL(alias,publicScope=false) {
  if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(alias))throw new Error('Invalid analytics snapshot alias');
  const j=`${alias}.normalized_json`,start=`json_extract(${j},'$.period_start')`,end=`json_extract(${j},'$.period_end')`,length=`json_array_length(${j},'$.daily')`;
  const emptyPreserved=(table,key)=>`EXISTS(SELECT 1 FROM ${table} marker WHERE ${publicScope?`marker.user_id=${alias}.user_id AND `:''}marker.wallet=${alias}.wallet
    AND marker.${key}='${EMPTY_REPORT_KEY}' AND marker.item_json='${EMPTY_REPORT_JSON}' AND marker.period_start=${start} AND marker.period_end=${end}
    AND (marker.captured_at>${alias}.captured_at OR marker.captured_at=${alias}.captured_at AND marker.fingerprint>=${alias}.fingerprint))`;
  return `CASE WHEN json_valid(${j}) THEN (${length} BETWEEN 1 AND 366
    AND julianday(${end})-julianday(${start})+1=${length}
    AND (SELECT count(*) FROM ${dailyTable(publicScope)} day WHERE ${publicScope?`day.user_id=${alias}.user_id AND `:''}day.wallet=${alias}.wallet
      AND day.date>=${start} AND day.date<=${end}
      AND (day.captured_at>${alias}.captured_at OR day.captured_at=${alias}.captured_at AND day.fingerprint>=${alias}.fingerprint))=${length}
    AND json_type(${j},'$.top_items')='object' AND json_extract(${j},'$.top_items.status') IN('available','missing')
    AND (json_extract(${j},'$.top_items.status')='missing' OR (
      (json_array_length(${j},'$.top_items.items')>0 OR ${emptyPreserved(itemReportTable(publicScope),'item_key')}) AND
      (SELECT count(*) FROM ${itemReportTable(publicScope)} items WHERE ${publicScope?`items.user_id=${alias}.user_id AND `:''}items.wallet=${alias}.wallet
        AND items.period_start=${start} AND items.period_end=${end}
        AND (items.captured_at>${alias}.captured_at OR items.captured_at=${alias}.captured_at AND items.fingerprint>=${alias}.fingerprint)
        AND instr(json_extract(${j},'$.top_items.items'),'"item_key":"'||items.item_key||'"')>0)=json_array_length(${j},'$.top_items.items')))
    AND json_type(${j},'$.by_collection')='object' AND json_extract(${j},'$.by_collection.status') IN('available','missing')
    AND (json_extract(${j},'$.by_collection.status')='missing' OR (
      (json_array_length(${j},'$.by_collection.items')>0 OR ${emptyPreserved(collectionReportTable(publicScope),'collection_key')}) AND
      (SELECT count(*) FROM ${collectionReportTable(publicScope)} items WHERE ${publicScope?`items.user_id=${alias}.user_id AND `:''}items.wallet=${alias}.wallet
        AND items.period_start=${start} AND items.period_end=${end}
        AND (items.captured_at>${alias}.captured_at OR items.captured_at=${alias}.captured_at AND items.fingerprint>=${alias}.fingerprint)
        AND instr(json_extract(${j},'$.by_collection.items'),'"collection_key":'||json_quote(items.collection_key))>0)=json_array_length(${j},'$.by_collection.items')))) ELSE 0 END`;
}

// Execute only inside a trigger: the hosted database supports json_each there.
// The parent guarded snapshot statement and these upserts commit or roll back
// together. Absorb OLD before replacement/deletion, including legacy captures
// that predate installation, so pruning cannot erase an earlier observed date.
export function personalAnalyticsDailyTriggers({publicScope=false}={}) {
  const target=dailyTable(publicScope),table=snapshotTable(publicScope);
  const dailyTriggers = [['insert','AFTER INSERT','NEW'],['old_update','BEFORE UPDATE','OLD'],['update','AFTER UPDATE','NEW'],['delete','BEFORE DELETE','OLD']].map(([event,timing,row])=>{
    const name=dailyTriggerName(publicScope,event),j=`${row}.normalized_json`,get=field=>`json_extract(${j},'$.${field}')`,day=field=>`json_extract(d.value,'$.${field}')`;
    const recognized=`CASE WHEN json_valid(${j}) THEN json_type(${j},'$.daily')='array'
      AND json_array_length(${j},'$.daily') BETWEEN 1 AND 366 AND ${get('version')}=1
      AND ${get('source')}='marketapp_personal_rent_page' AND ${get('currency')}='GRAM' AND ${get('timezone')}='UTC'
      AND ${get('volume_basis')}='gross_before_fees' AND ${get('wallet')}=${row}.wallet
      AND ((length(${row}.wallet)=66 AND substr(${row}.wallet,1,2)='0:' AND substr(${row}.wallet,3) NOT GLOB '*[^0-9a-f]*')
        OR (length(${row}.wallet)=67 AND substr(${row}.wallet,1,3)='-1:' AND substr(${row}.wallet,4) NOT GLOB '*[^0-9a-f]*'))
      AND ${get('fingerprint')}=${row}.fingerprint AND ${get('captured_at')}=${row}.captured_at
      AND length(${row}.fingerprint)=64 AND ${row}.fingerprint NOT GLOB '*[^0-9a-f]*'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',${row}.captured_at)=${row}.captured_at
      AND julianday(${row}.captured_at)<=julianday(${row}.imported_at) ELSE 0 END`;
    const rowId=`${publicScope?`${row}.user_id||':'||`:''}${row}.wallet||':'||${day('date')}`;
    const integerPart=`CASE WHEN instr(${day('rent_volume')},'.')>0 THEN substr(${day('rent_volume')},1,instr(${day('rent_volume')},'.')-1) ELSE ${day('rent_volume')} END`;
    const validDay=`json_type(d.value,'$')='object' AND json_type(d.value,'$.date')='text'
      AND length(${day('date')})=10 AND strftime('%Y-%m-%d',${day('date')},'+0 days')=${day('date')}
      AND ${day('date')}<=substr(${row}.captured_at,1,10)
      AND json_type(d.value,'$.rent_volume')='text' AND length(${day('rent_volume')}) BETWEEN 1 AND 32
      AND ${day('rent_volume')} GLOB '[0-9]*' AND ${day('rent_volume')} NOT GLOB '*[^0-9.]*'
      AND length(${integerPart}) BETWEEN 1 AND 27 AND ((${integerPart})='0' OR (${integerPart}) GLOB '[1-9]*')
      AND length(${day('rent_volume')})-length(replace(${day('rent_volume')},'.',''))<=1
      AND (instr(${day('rent_volume')},'.')=0 OR length(${day('rent_volume')})-instr(${day('rent_volume')},'.') BETWEEN 1 AND 4)
      AND json_type(d.value,'$.new_rentals')='integer' AND ${day('new_rentals')} BETWEEN 0 AND 9007199254740991
      AND json_type(d.value,'$.extensions')='integer' AND ${day('extensions')} BETWEEN 0 AND 9007199254740991
      AND ${day('new_rentals')}<=9007199254740991-${day('extensions')}`;
    const validSnapshot=`CASE WHEN (${recognized}) THEN
      julianday(${get('period_end')})-julianday(${get('period_start')})+1=json_array_length(${j},'$.daily')
      AND NOT EXISTS(SELECT 1 FROM json_each(${j},'$.daily') d WHERE COALESCE(CASE WHEN d.type='object' THEN
        (${validDay}) AND ${day('date')}=date(${get('period_start')},'+'||d.key||' days') ELSE 0 END,0)=0) ELSE 0 END`;
    return {name,table,sql:`CREATE TRIGGER ${name} ${timing} ON ${table}
      WHEN ${validSnapshot}${publicScope?` AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=${row}.user_id AND status='active')`:''}
      BEGIN INSERT INTO ${target}(row_id,${publicScope?'user_id,':''}wallet,date,captured_at,fingerprint,rent_volume,new_rentals,extensions)
        SELECT ${rowId},${publicScope?`${row}.user_id,`:''}${row}.wallet,${day('date')},${row}.captured_at,${row}.fingerprint,
          ${day('rent_volume')},${day('new_rentals')},${day('extensions')} FROM json_each(${j},'$.daily') d WHERE ${validDay}
        ON CONFLICT(row_id) DO UPDATE SET captured_at=excluded.captured_at,fingerprint=excluded.fingerprint,
          rent_volume=excluded.rent_volume,new_rentals=excluded.new_rentals,extensions=excluded.extensions
        WHERE excluded.captured_at>${target}.captured_at OR excluded.captured_at=${target}.captured_at AND excluded.fingerprint>${target}.fingerprint;
      END`};
  });
  // Keep the original definitions unchanged so installation is additive and
  // an interrupted upgrade can resume without dropping existing archives.
  return [...dailyTriggers,...personalAnalyticsItemTriggers({publicScope}),...personalAnalyticsCollectionTriggers({publicScope}),
    ...personalAnalyticsItemTriggers({publicScope,empty:true}),...personalAnalyticsCollectionTriggers({publicScope,empty:true})];
}

function personalAnalyticsItemTriggers({publicScope=false,empty=false}={}) {
  const target=itemReportTable(publicScope),table=snapshotTable(publicScope);
  return [['insert','AFTER INSERT','NEW'],['old_update','BEFORE UPDATE','OLD'],['update','AFTER UPDATE','NEW'],['delete','BEFORE DELETE','OLD']].map(([event,timing,row])=>{
    const name=(empty?emptyItemTriggerName:itemTriggerName)(publicScope,event),j=`${row}.normalized_json`,get=field=>`json_extract(${j},'$.${field}')`,item=field=>`json_extract(d.value,'$.${field}')`;
    const address=field=>`(length(${field})=66 AND substr(${field},1,2)='0:' AND substr(${field},3) NOT GLOB '*[^0-9a-f]*'
      OR length(${field})=67 AND substr(${field},1,3)='-1:' AND substr(${field},4) NOT GLOB '*[^0-9a-f]*')`;
    const decimal=field=>{
      const integer=`CASE WHEN instr(${item(field)},'.')>0 THEN substr(${item(field)},1,instr(${item(field)},'.')-1) ELSE ${item(field)} END`;
      return `json_type(d.value,'$.${field}')='text' AND length(${item(field)}) BETWEEN 1 AND 32
      AND ${item(field)} GLOB '[0-9]*' AND ${item(field)} NOT GLOB '*[^0-9.]*'
      AND length(${integer}) BETWEEN 1 AND 27 AND ((${integer})='0' OR (${integer}) GLOB '[1-9]*')
      AND length(${item(field)})-length(replace(${item(field)},'.',''))<=1
      AND (instr(${item(field)},'.')=0 OR length(${item(field)})-instr(${item(field)},'.') BETWEEN 1 AND 4)`;};
    const validItem=`d.type='object' AND json_type(d.value,'$.item_key')='text' AND ${address(item('item_key'))}
      AND json_type(d.value,'$.name')='text' AND length(${item('name')}) BETWEEN 1 AND 200
      AND json_type(d.value,'$.item_url')='text' AND length(${item('item_url')})=75 AND substr(${item('item_url')},1,26)='https://marketapp.org/nft/'
      AND json_type(d.value,'$.rentals')='integer' AND ${item('rentals')} BETWEEN 0 AND 9007199254740991
      AND (${decimal('volume')}) AND (${decimal('rented_days')})
      AND (json_type(d.value,'$.price_per_day')='null' OR (${decimal('price_per_day')}))`;
    const recognized=`CASE WHEN json_valid(${j}) THEN ${get('version')}=1 AND ${get('source')}='marketapp_personal_rent_page'
      AND ${get('currency')}='GRAM' AND ${get('timezone')}='UTC' AND ${get('volume_basis')}='gross_before_fees'
      AND ${get('wallet')}=${row}.wallet AND ${address(`${row}.wallet`)}
      AND ${get('fingerprint')}=${row}.fingerprint AND ${get('captured_at')}=${row}.captured_at
      AND length(${row}.fingerprint)=64 AND ${row}.fingerprint NOT GLOB '*[^0-9a-f]*'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',${row}.captured_at)=${row}.captured_at
      AND julianday(${row}.captured_at)<=julianday(${row}.imported_at)
      AND strftime('%Y-%m-%d',${get('period_start')},'+0 days')=${get('period_start')}
      AND strftime('%Y-%m-%d',${get('period_end')},'+0 days')=${get('period_end')}
      AND julianday(${get('period_end')})-julianday(${get('period_start')}) BETWEEN 0 AND 365
      AND ${get('period_end')}<=substr(${row}.captured_at,1,10)
      AND ${get('top_items.status')}='available' AND ${get('top_items.scope')}='marketapp_top_items'
      AND json_type(${j},'$.top_items.items')='array' AND json_array_length(${j},'$.top_items.items')<=100
      AND NOT EXISTS(SELECT 1 FROM json_each(${j},'$.top_items.items') d WHERE COALESCE(CASE WHEN d.type='object' THEN (${validItem}) ELSE 0 END,0)=0)
      AND (SELECT count(DISTINCT json_extract(value,'$.item_key')) FROM json_each(${j},'$.top_items.items'))=json_array_length(${j},'$.top_items.items') ELSE 0 END`;
    const id=`${publicScope?`${row}.user_id||':'||`:''}${row}.wallet||':'||${item('item_key')}||':'||${get('period_start')}||':'||${get('period_end')}`;
    const selection=empty?`SELECT ${id.replace(item('item_key'),`'${EMPTY_REPORT_KEY}'`)},${publicScope?`${row}.user_id,`:''}${row}.wallet,'${EMPTY_REPORT_KEY}',${get('period_start')},${get('period_end')},${row}.captured_at,${row}.fingerprint,'${EMPTY_REPORT_JSON}' WHERE 1`
      :`SELECT ${id},${publicScope?`${row}.user_id,`:''}${row}.wallet,${item('item_key')},${get('period_start')},${get('period_end')},${row}.captured_at,${row}.fingerprint,d.value
          FROM json_each(${j},'$.top_items.items') d WHERE ${validItem}`;
    return {name,table,sql:`CREATE TRIGGER ${name} ${timing} ON ${table}
      WHEN ${empty?`CASE WHEN (${recognized}) THEN json_array_length(${j},'$.top_items.items')=0 ELSE 0 END`:recognized}${publicScope?` AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=${row}.user_id AND status='active')`:''}
      BEGIN INSERT INTO ${target}(row_id,${publicScope?'user_id,':''}wallet,item_key,period_start,period_end,captured_at,fingerprint,item_json)
        ${selection}
        ON CONFLICT(row_id) DO UPDATE SET captured_at=excluded.captured_at,fingerprint=excluded.fingerprint,item_json=excluded.item_json
        WHERE excluded.captured_at>${target}.captured_at OR excluded.captured_at=${target}.captured_at AND excluded.fingerprint>${target}.fingerprint;
      END`};
  });
}

function personalAnalyticsCollectionTriggers({publicScope=false,empty=false}={}) {
  const target=collectionReportTable(publicScope),table=snapshotTable(publicScope);
  return [['insert','AFTER INSERT','NEW'],['old_update','BEFORE UPDATE','OLD'],['update','AFTER UPDATE','NEW'],['delete','BEFORE DELETE','OLD']].map(([event,timing,row])=>{
    const name=(empty?emptyCollectionTriggerName:collectionTriggerName)(publicScope,event),j=`${row}.normalized_json`,get=field=>`json_extract(${j},'$.${field}')`,item=field=>`json_extract(d.value,'$.${field}')`;
    const address=field=>`(length(${field})=66 AND substr(${field},1,2)='0:' AND substr(${field},3) NOT GLOB '*[^0-9a-f]*'
      OR length(${field})=67 AND substr(${field},1,3)='-1:' AND substr(${field},4) NOT GLOB '*[^0-9a-f]*')`;
    const decimal=field=>{
      const integer=`CASE WHEN instr(${item(field)},'.')>0 THEN substr(${item(field)},1,instr(${item(field)},'.')-1) ELSE ${item(field)} END`;
      return `json_type(d.value,'$.${field}')='text' AND length(${item(field)}) BETWEEN 1 AND 32
      AND ${item(field)} GLOB '[0-9]*' AND ${item(field)} NOT GLOB '*[^0-9.]*'
      AND length(${integer}) BETWEEN 1 AND 27 AND ((${integer})='0' OR (${integer}) GLOB '[1-9]*')
      AND length(${item(field)})-length(replace(${item(field)},'.',''))<=1
      AND (instr(${item(field)},'.')=0 OR length(${item(field)})-instr(${item(field)},'.') BETWEEN 1 AND 4)`;};
    const validItem=`d.type='object' AND json_type(d.value,'$.collection_key')='text' AND length(${item('collection_key')}) BETWEEN 6 AND 405 AND substr(${item('collection_key')},1,5)='name:'
      AND json_type(d.value,'$.name')='text' AND length(${item('name')}) BETWEEN 1 AND 200
      AND json_type(d.value,'$.rentals')='integer' AND ${item('rentals')} BETWEEN 0 AND 9007199254740991
      AND (${decimal('volume')})
      AND (json_type(d.value,'$.price_per_day')='null' OR (${decimal('price_per_day')}))`;
    const recognized=`CASE WHEN json_valid(${j}) THEN ${get('version')}=1 AND ${get('source')}='marketapp_personal_rent_page'
      AND ${get('currency')}='GRAM' AND ${get('timezone')}='UTC' AND ${get('volume_basis')}='gross_before_fees'
      AND ${get('wallet')}=${row}.wallet AND ${address(`${row}.wallet`)}
      AND ${get('fingerprint')}=${row}.fingerprint AND ${get('captured_at')}=${row}.captured_at
      AND length(${row}.fingerprint)=64 AND ${row}.fingerprint NOT GLOB '*[^0-9a-f]*'
      AND strftime('%Y-%m-%dT%H:%M:%fZ',${row}.captured_at)=${row}.captured_at
      AND julianday(${row}.captured_at)<=julianday(${row}.imported_at)
      AND strftime('%Y-%m-%d',${get('period_start')},'+0 days')=${get('period_start')}
      AND strftime('%Y-%m-%d',${get('period_end')},'+0 days')=${get('period_end')}
      AND julianday(${get('period_end')})-julianday(${get('period_start')}) BETWEEN 0 AND 365
      AND ${get('period_end')}<=substr(${row}.captured_at,1,10)
      AND ${get('by_collection.status')}='available' AND ${get('by_collection.scope')}='marketapp_by_collection'
      AND json_type(${j},'$.by_collection.items')='array' AND json_array_length(${j},'$.by_collection.items')<=200
      AND NOT EXISTS(SELECT 1 FROM json_each(${j},'$.by_collection.items') d WHERE COALESCE(CASE WHEN d.type='object' THEN (${validItem}) ELSE 0 END,0)=0)
      AND (SELECT count(DISTINCT json_extract(value,'$.collection_key')) FROM json_each(${j},'$.by_collection.items'))=json_array_length(${j},'$.by_collection.items') ELSE 0 END`;
    const id=`${publicScope?`${row}.user_id||':'||`:''}${row}.wallet||':'||${item('collection_key')}||':'||${get('period_start')}||':'||${get('period_end')}`;
    const selection=empty?`SELECT ${id.replace(item('collection_key'),`'${EMPTY_REPORT_KEY}'`)},${publicScope?`${row}.user_id,`:''}${row}.wallet,'${EMPTY_REPORT_KEY}',${get('period_start')},${get('period_end')},${row}.captured_at,${row}.fingerprint,'${EMPTY_REPORT_JSON}' WHERE 1`
      :`SELECT ${id},${publicScope?`${row}.user_id,`:''}${row}.wallet,${item('collection_key')},${get('period_start')},${get('period_end')},${row}.captured_at,${row}.fingerprint,d.value
          FROM json_each(${j},'$.by_collection.items') d WHERE ${validItem}`;
    return {name,table,sql:`CREATE TRIGGER ${name} ${timing} ON ${table}
      WHEN ${empty?`CASE WHEN (${recognized}) THEN json_array_length(${j},'$.by_collection.items')=0 ELSE 0 END`:recognized}${publicScope?` AND EXISTS(SELECT 1 FROM public_accounts WHERE user_id=${row}.user_id AND status='active')`:''}
      BEGIN INSERT INTO ${target}(row_id,${publicScope?'user_id,':''}wallet,collection_key,period_start,period_end,captured_at,fingerprint,item_json)
        ${selection}
        ON CONFLICT(row_id) DO UPDATE SET captured_at=excluded.captured_at,fingerprint=excluded.fingerprint,item_json=excluded.item_json
        WHERE excluded.captured_at>${target}.captured_at OR excluded.captured_at=${target}.captured_at AND excluded.fingerprint>${target}.fingerprint;
      END`};
  });
}

export function personalAnalyticsDailyBackfill({publicScope=false,after='',limit=1}={}) {
  if(typeof after!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>8)throw new Error('Invalid analytics backfill page');
  const table=snapshotTable(publicScope),key=publicScope?'row_id':'fingerprint';
  return {sql:`UPDATE ${table} SET normalized_json=normalized_json WHERE ${key} IN
    (SELECT ${key} FROM ${table} WHERE ${key}>:after ORDER BY ${key} LIMIT :limit)`,parameters:{':after':after,':limit':limit}};
}

function dailyObservation(row,configuredWallet) {
  try {
    if(!object(row)||canonicalAddress(row.wallet)!==configuredWallet||typeof row.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(row.fingerprint))return null;
    const day=date(row.date),captured=captureTime(row.captured_at);
    if(row.captured_at!==captured||day>Date.parse(captured)||!Number.isSafeInteger(row.new_rentals)||row.new_rentals<0
      ||!Number.isSafeInteger(row.extensions)||row.extensions<0||!Number.isSafeInteger(row.new_rentals+row.extensions))return null;
    const amount=fixed(row.rent_volume);
    return {date:row.date,rent_volume:money(amount),new_rentals:row.new_rentals,extensions:row.extensions,
      rentals:row.new_rentals+row.extensions,captured_at:captured,partial:row.date===captured.slice(0,10),fingerprint:row.fingerprint,amount};
  }catch{return null;}
}

// Reserve the complete possible daily growth before the atomic snapshot write.
// Existing dates can make this conservative; no unaccounted trigger growth can
// cross an account or service admission limit, including concurrent imports.
export function personalAnalyticsDailyReserve(snapshot,publicUserId=null) {
  let wallet;try{wallet=canonicalAddress(snapshot.wallet);}catch{return 0;}
  if(!Array.isArray(snapshot.daily)||snapshot.daily.length>366)return 0;
  let bytes=0;
  for(const table of [snapshot.top_items,snapshot.by_collection])if(table?.status==='available'&&Array.isArray(table.items)&&table.items.length===0) {
    const id=`${publicUserId===null?'':`${publicUserId}:`}${wallet}:${EMPTY_REPORT_KEY}:${snapshot.period_start}:${snapshot.period_end}`;
    bytes+=[id,...(publicUserId===null?[]:[String(publicUserId)]),wallet,EMPTY_REPORT_KEY,snapshot.period_start,snapshot.period_end,
      snapshot.captured_at,snapshot.fingerprint,EMPTY_REPORT_JSON].reduce((sum,text)=>sum+utf8Bytes(text).length,0);
  }
  for(const value of snapshot.daily) {
    const row={...value,wallet,captured_at:snapshot.captured_at,fingerprint:snapshot.fingerprint};
    if(!dailyObservation(row,wallet))continue;
    const id=`${publicUserId===null?'':`${publicUserId}:`}${wallet}:${row.date}`;
    bytes+=[id,...(publicUserId===null?[]:[String(publicUserId)]),wallet,row.date,row.captured_at,row.fingerprint,row.rent_volume,String(row.new_rentals),String(row.extensions)]
      .reduce((total,text)=>total+utf8Bytes(text).length,0);
  }
  if(snapshot.top_items?.status==='available')for(const value of snapshot.top_items.items??[]) {
    try {
      const item=topItem(value,true),id=`${publicUserId===null?'':`${publicUserId}:`}${wallet}:${item.item_key}:${snapshot.period_start}:${snapshot.period_end}`;
      // Account for the original JSON too: future additive item fields cannot
      // evade admission by being dropped from the validated projection.
      bytes+=[id,...(publicUserId===null?[]:[String(publicUserId)]),wallet,item.item_key,snapshot.period_start,snapshot.period_end,
        snapshot.captured_at,snapshot.fingerprint,JSON.stringify(value)].reduce((sum,text)=>sum+utf8Bytes(text).length,0);
    }catch{/* Invalid records are never archived. */}
  }
  if(snapshot.by_collection?.status==='available')for(const value of snapshot.by_collection.items??[]) {
    try {
      const item=collectionItem(value,true),id=`${publicUserId===null?'':`${publicUserId}:`}${wallet}:${item.collection_key}:${snapshot.period_start}:${snapshot.period_end}`;
      bytes+=[id,...(publicUserId===null?[]:[String(publicUserId)]),wallet,item.collection_key,snapshot.period_start,snapshot.period_end,
        snapshot.captured_at,snapshot.fingerprint,JSON.stringify(value)].reduce((sum,text)=>sum+utf8Bytes(text).length,0);
    }catch{/* Invalid collection rows are never archived. */}
  }
  return bytes;
}

export function buildPersonalAnalyticsAllTime(rows,configuredWallet,now=Date.now(),itemReports=[],collectionReports=[]) {
  let wallet;try{wallet=canonicalAddress(configuredWallet);}catch{return null;}
  const days=new Map();
  for(const row of rows) {
    const value=dailyObservation(row,wallet);if(!value||Date.parse(value.captured_at)>now)continue;
    const prior=days.get(value.date);
    if(!prior||value.captured_at>prior.captured_at||value.captured_at===prior.captured_at&&value.fingerprint>prior.fingerprint)days.set(value.date,value);
  }
  if(!days.size)return null;
  let amount=0n,starts=0n,extensions=0n,captured='';
  const daily=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(({amount:volume,fingerprint,...row})=>{
    amount+=volume;starts+=BigInt(row.new_rentals);extensions+=BigInt(row.extensions);if(row.captured_at>captured)captured=row.captured_at;return row;
  });
  if(starts+extensions>BigInt(Number.MAX_SAFE_INTEGER))return null;
  const first=daily[0].date,last=daily.at(-1).date;
  const report={version:1,report_kind:'all_time',source:'marketapp_personal_rent_page',source_url:null,wallet,captured_at:captured,
    period_start:first,period_end:last,timezone:'UTC',currency:'GRAM',volume_basis:'gross_before_fees',
    summary:{rent_volume:money(amount),rentals:Number(starts+extensions),new_rentals:Number(starts),extensions:Number(extensions),
      items:null,price_per_day:null,average_duration:null,extension_percent:null,spent_on_rent:null,spending_rentals:null},daily,
    coverage:{observed_days:daily.length,missing_days:(date(last)-date(first))/DAY+1-daily.length,partial_days:daily.filter(row=>row.partial).length},
    top_items:buildPersonalAnalyticsItemsAllTime(itemReports,wallet,now,{period_start:first,period_end:last}),
    by_collection:buildPersonalAnalyticsCollectionsAllTime(collectionReports,wallet,now,{period_start:first,period_end:last})};
  return {...report,fingerprint:Array.from(sha256(utf8Bytes(canonicalJSON(report))),byte=>byte.toString(16).padStart(2,'0')).join('')};
}

export function buildPersonalAnalyticsItemsAllTime(rows,configuredWallet,now=Date.now(),range=null) {
  const empty={status:'missing',scope:'saved_non_overlapping_reports',incomplete:true,items:[]};
  let wallet;try{wallet=canonicalAddress(configuredWallet);}catch{return empty;}
  const groups=new Map();let observedEmpty=false;
  for(const row of rows)try {
    if(!object(row)||row.wallet!==wallet||!/^[0-9a-f]{64}$/.test(row.fingerprint))continue;
    const captured=captureTime(row.captured_at),start=date(row.period_start),end=date(row.period_end);
    if(captured!==row.captured_at||Date.parse(captured)>now||end>Date.parse(captured)||end<start||end-start>365*DAY)continue;
    if(range&&(start<date(range.period_start)||end>date(range.period_end)))continue;
    if(row.item_key===EMPTY_REPORT_KEY&&row.item_json===EMPTY_REPORT_JSON){observedEmpty=true;continue;}
    const item=topItem(typeof row.item_json==='string'?JSON.parse(row.item_json):row.item,true);
    if(row.item_key!==undefined&&row.item_key!==item.item_key)continue;
    let reports=groups.get(item.item_key);if(!reports)groups.set(item.item_key,reports=new Map());
    const key=`${row.period_start}:${row.period_end}`,prior=reports.get(key);
    if(!prior||captured>prior.captured_at||captured===prior.captured_at&&row.fingerprint>prior.fingerprint)
      reports.set(key,{...row,item,captured_at:captured,start,end,days:(end-start)/DAY+1});
  }catch{/* Corrupt legacy data is unknown, not a zero payment. */}
  const items=[];
  for(const reports of groups.values()) {
    const ordered=[...reports.values()].sort((a,b)=>a.end-b.end||a.start-b.start||a.fingerprint.localeCompare(b.fingerprint));
    // Persistent back-pointers avoid copying every selected interval into
    // every DP state as the permanent archive grows.
    const dp=[{days:0,recency:0n,node:null}];
    const path=node=>{const result=[];while(node){result.push(ordered[node.index]);node=node.previous;}return result.reverse();};
    for(let index=0;index<ordered.length;index++) {
      const report=ordered[index];let low=0,high=index;
      while(low<high){const mid=(low+high)>>1;if(ordered[mid].end<report.start)low=mid+1;else high=mid;}
      const base=dp[low],selected={days:base.days+report.days,recency:base.recency+BigInt(Date.parse(report.captured_at))*BigInt(report.days),
        node:{index,previous:base.node}},previous=dp[index];
      const better=selected.days>previous.days||selected.days===previous.days&&(selected.recency>previous.recency||selected.recency===previous.recency
        &&path(selected.node).map(row=>row.fingerprint).join('')>path(previous.node).map(row=>row.fingerprint).join(''));
      dp.push(better?selected:previous);
    }
    const chosen=dp.at(-1),selected=path(chosen.node);let volume=0n,days=0n,rentals=0n;
    for(const report of selected){volume+=fixed(report.item.volume);days+=fixed(report.item.rented_days);rentals+=BigInt(report.item.rentals);}
    if(rentals>BigInt(Number.MAX_SAFE_INTEGER))continue;
    const latest=[...selected].sort((a,b)=>b.captured_at.localeCompare(a.captured_at)||b.fingerprint.localeCompare(a.fingerprint))[0];
    const first=range?.period_start??selected[0].period_start,last=range?.period_end??selected.at(-1).period_end;
    items.push({...latest.item,rentals:Number(rentals),volume:money(volume),rented_days:money(days),
      price_per_day:selected.length===1?latest.item.price_per_day:days?money((volume*10000n+days/2n)/days):null,captured_at:latest.captured_at,
      coverage:{observed_days:chosen.days,missing_days:(date(last)-date(first))/DAY+1-chosen.days,
        partial_days:selected.filter(row=>row.period_end===row.captured_at.slice(0,10)).length,
        periods:selected.map(row=>({period_start:row.period_start,period_end:row.period_end,captured_at:row.captured_at}))}});
  }
  items.sort((a,b)=>{const difference=fixed(b.volume,false,40)-fixed(a.volume,false,40);return difference>0n?1:difference<0n?-1:a.item_key.localeCompare(b.item_key);});
  return {...empty,status:items.length||observedEmpty?'available':'missing',items};
}

export function buildPersonalAnalyticsCollectionsAllTime(rows,configuredWallet,now=Date.now(),range=null) {
  const empty={status:'missing',scope:'saved_non_overlapping_reports',incomplete:true,items:[]};
  let wallet;try{wallet=canonicalAddress(configuredWallet);}catch{return empty;}
  const groups=new Map();let observedEmpty=false;
  for(const row of rows)try {
    if(!object(row)||row.wallet!==wallet||!/^[0-9a-f]{64}$/.test(row.fingerprint))continue;
    const captured=captureTime(row.captured_at),start=date(row.period_start),end=date(row.period_end);
    if(captured!==row.captured_at||Date.parse(captured)>now||end>Date.parse(captured)||end<start||end-start>365*DAY)continue;
    if(range&&(start<date(range.period_start)||end>date(range.period_end)))continue;
    if(row.collection_key===EMPTY_REPORT_KEY&&row.item_json===EMPTY_REPORT_JSON){observedEmpty=true;continue;}
    const item=collectionItem(typeof row.item_json==='string'?JSON.parse(row.item_json):row.item,true);
    if(row.collection_key!==undefined&&row.collection_key!==item.collection_key)continue;
    let reports=groups.get(item.collection_key);if(!reports)groups.set(item.collection_key,reports=new Map());
    const key=`${row.period_start}:${row.period_end}`,prior=reports.get(key);
    if(!prior||captured>prior.captured_at||captured===prior.captured_at&&row.fingerprint>prior.fingerprint)
      reports.set(key,{...row,item,captured_at:captured,start,end,days:(end-start)/DAY+1});
  }catch{/* Corrupt legacy data is unknown, not a zero payment. */}
  const items=[];
  for(const reports of groups.values()) {
    const ordered=[...reports.values()].sort((a,b)=>a.end-b.end||a.start-b.start||a.fingerprint.localeCompare(b.fingerprint));
    // Persistent back-pointers avoid copying every selected interval into
    // every DP state as the permanent archive grows.
    const dp=[{days:0,recency:0n,node:null}];
    const path=node=>{const result=[];while(node){result.push(ordered[node.index]);node=node.previous;}return result.reverse();};
    for(let index=0;index<ordered.length;index++) {
      const report=ordered[index];let low=0,high=index;
      while(low<high){const mid=(low+high)>>1;if(ordered[mid].end<report.start)low=mid+1;else high=mid;}
      const base=dp[low],selected={days:base.days+report.days,recency:base.recency+BigInt(Date.parse(report.captured_at))*BigInt(report.days),
        node:{index,previous:base.node}},previous=dp[index];
      const better=selected.days>previous.days||selected.days===previous.days&&(selected.recency>previous.recency||selected.recency===previous.recency
        &&path(selected.node).map(row=>row.fingerprint).join('')>path(previous.node).map(row=>row.fingerprint).join(''));
      dp.push(better?selected:previous);
    }
    const chosen=dp.at(-1),selected=path(chosen.node);let volume=0n,rentals=0n;
    for(const report of selected){volume+=fixed(report.item.volume);rentals+=BigInt(report.item.rentals);}
    if(rentals>BigInt(Number.MAX_SAFE_INTEGER))continue;
    const latest=[...selected].sort((a,b)=>b.captured_at.localeCompare(a.captured_at)||b.fingerprint.localeCompare(a.fingerprint))[0];
    const first=range?.period_start??selected[0].period_start,last=range?.period_end??selected.at(-1).period_end;
    items.push({...latest.item,rentals:Number(rentals),volume:money(volume),
      price_per_day:selected.length===1?latest.item.price_per_day:null,captured_at:latest.captured_at,
      coverage:{observed_days:chosen.days,missing_days:(date(last)-date(first))/DAY+1-chosen.days,
        partial_days:selected.filter(row=>row.period_end===row.captured_at.slice(0,10)).length,
        periods:selected.map(row=>({period_start:row.period_start,period_end:row.period_end,captured_at:row.captured_at}))}});
  }
  items.sort((a,b)=>{const difference=fixed(b.volume,false,40)-fixed(a.volume,false,40);return difference>0n?1:difference<0n?-1:a.collection_key.localeCompare(b.collection_key);});
  return {...empty,status:items.length||observedEmpty?'available':'missing',items};
}
