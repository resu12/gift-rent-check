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

export function normalizePersonalAnalytics(raw, configuredWallet) {
  if (typeof raw !== 'string' || raw.length > PERSONAL_ANALYTICS_MAX_BYTES || utf8Bytes(raw).length > PERSONAL_ANALYTICS_MAX_BYTES) invalid();
  const source = parseExact(raw);
  if (!object(source) || !(source.version instanceof JsonNumber) || count(source.version) !== 1 || source.source !== 'marketapp_personal_rent_page') invalid();
  if (Object.keys(source).some(key => !['version', 'source', 'source_url', 'wallet', 'captured_at', 'summary', 'charts', 'tables'].includes(key))) invalid();
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
  const income = charts.get('profile.rent.income'), rentals = charts.get('profile.rent.rentals');
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
  const places = Math.max(2, (summary.get('Rent volume').value.trim().split('.')[1] || '').length);
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
      spent_on_rent: optionalDecimal(summary, 'Spent on rent'), spending_rentals: footCount(summary, 'Spent on rent', 'rentals')}, daily};
  const fingerprint = Array.from(sha256(utf8Bytes(canonicalJSON(normalized))), byte => byte.toString(16).padStart(2, '0')).join('');
  return {...normalized, fingerprint};
}

export function configuredAnalyticsWallet(records) {
  const settings = {};
  for (const row of records) if (row.kind === 'settings') Object.assign(settings, row.record);
  try {return canonicalAddress(settings.wallet ?? settings.wallet_address);} catch {return null;}
}
