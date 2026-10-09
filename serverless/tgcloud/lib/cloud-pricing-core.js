// Portable exact arithmetic and identity helpers. No Node or runtime I/O.
const DAY = 86400000;
const PRESETS = Object.freeze({'24h': 1, '7d': 7, '30d': 30, '60d': 60, '90d': 90});
export function canonicalAddress(value) {
  if (typeof value !== 'string') throw new Error('Invalid TON address');
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(value);
  if (raw) {
    if (![0, -1].includes(Number(raw[1]))) throw new Error('Unsupported TON workchain');
    return `${Number(raw[1])}:${raw[2].toLowerCase()}`;
  }
  if (!/^[A-Za-z0-9_+/-]{48}$/.test(value)) throw new Error('Invalid TON address');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const data = []; let acc = 0, bits = 0;
  for (const char of value.replace(/-/g, '+').replace(/_/g, '/')) {
    acc = (acc << 6) | alphabet.indexOf(char); bits += 6;
    if (bits >= 8) {bits -= 8; data.push((acc >> bits) & 255);}
  }
  if (data.length !== 36 || ![0x11, 0x51].includes(data[0]) || ![0, 255].includes(data[1])) throw new Error('A mainnet TON address is required');
  let crc = 0;
  for (const byte of data.slice(0, 34)) {crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  if (data[34] !== (crc >> 8) || data[35] !== (crc & 255)) throw new Error('Invalid TON address checksum');
  return `${data[1] === 255 ? -1 : 0}:${data.slice(2, 34).map(n => n.toString(16).padStart(2, '0')).join('')}`;
}
export function addressKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {return canonicalAddress(value);} catch {return value;}
}
export const traitKey = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : null;
export function instant(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const n = Date.parse(value); return Number.isFinite(n) ? n : null;
}
// Milliseconds suffice for date windows, but observation ordering preserves the
// source's microseconds so two snapshots within one millisecond remain distinct.
export function instantOrder(value) {
  const ms = instant(value); if (ms === null) return null;
  const fractional = typeof value === 'string' ? /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1] || '' : '';
  return BigInt(Math.trunc(ms)) * 1000n + BigInt(fractional.padEnd(6, '0').slice(3, 6) || '0');
}
export const iso = n => new Date(n).toISOString();
function validDate(value) {return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && iso(Date.parse(value + 'T00:00:00Z')).slice(0, 10) === value;}
export function resolveCloudWindow(input = {}, now = Date.now(), {collectHistory = false} = {}) {
  const current = instant(now); if (current === null) throw new Error('Pricing time must include a timezone');
  const timeframe = input.timeframe ?? '30d';
  const dateFrom = input.date_from ?? input.dateFrom ?? null, dateTo = input.date_to ?? input.dateTo ?? null;
  let from, to = current;
  if (timeframe === 'custom') {
    if (!validDate(dateFrom) || !validDate(dateTo)) throw new Error('Custom dates must be valid YYYY-MM-DD dates');
    from = Date.parse(dateFrom + 'T00:00:00Z'); const end = Date.parse(dateTo + 'T00:00:00Z');
    if (from > end) throw new Error('Start date must not follow end date');
    if (from > current) throw new Error('Start date must not be in the future');
    if (end - from >= 90 * DAY) throw new Error('Custom timeframes support at most 90 inclusive UTC dates');
    if (collectHistory && from < Math.floor(current / DAY) * DAY - 89 * DAY) throw new Error('New rental-history collection must start within the last 90 UTC dates. Older saved data remains available to view.');
    to = Math.min(end + DAY - 1, current);
  } else {
    if (!Object.hasOwn(PRESETS, timeframe)) throw new Error('Dashboard timeframes are limited to 90 days; choose 30, 60, or 90 days');
    if (dateFrom !== null || dateTo !== null) throw new Error('Dates are only supported with the custom timeframe');
    from = current - PRESETS[timeframe] * DAY;
  }
  return {timeframe, date_from: dateFrom, date_to: dateTo, window_from: iso(from), window_to: iso(to), timezone: 'UTC'};
}
export function validateSavedCloudWindow(window) {
  const message = 'This saved history job has no supported bounded timeframe; start a fresh 30-day collection. Saved records are retained.';
  try {
    if (!window || window.timezone !== 'UTC') throw new Error();
    const from = instant(window.window_from), to = instant(window.window_to);
    if (from === null || to === null || from <= 0 || from > to || to - from > 90 * DAY) throw new Error();
    const expected = resolveCloudWindow(window, to);
    if (instant(expected.window_from) !== from || instant(expected.window_to) !== to) throw new Error();
    return window;
  } catch {throw new Error(message);}
}
function gcd(a, b) {a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) {[a, b] = [b, a % b];} return a || 1n;}
export function rational(n, d = 1n) {if (!d) throw new Error('Division by zero'); if (d < 0n) {n = -n; d = -d;} const g = gcd(n, d); return {n: n / g, d: d / g};}
export function decimal(value) {
  if (typeof value !== 'string' || value.length > 1100) throw new Error('Invalid monetary decimal');
  const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!m) throw new Error('Invalid monetary decimal');
  const fraction = m[3] ?? m[4] ?? '', exponent = Number(m[5] || '0') - fraction.length;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Unsupported monetary decimal scale');
  const n = BigInt((m[2] || '0') + fraction) * (m[1] === '-' ? -1n : 1n);
  return exponent >= 0 ? rational(n * 10n ** BigInt(exponent)) : rational(n, 10n ** BigInt(-exponent));
}
export const plus = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const multiply = (a, n, d = 1n) => rational(a.n * n, a.d * d);
export const compare = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
export function decimalText(value, places = 9) {
  const scale = 10n ** BigInt(places), positive = value.n >= 0n, n = positive ? value.n : -value.n;
  const rounded = (n * scale * 2n + value.d) / (value.d * 2n);
  const text = `${rounded / scale}.${String(rounded % scale).padStart(places, '0')}`.replace(/\.?0+$/, '');
  return `${!positive && rounded ? '-' : ''}${text || '0'}`;
}
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
