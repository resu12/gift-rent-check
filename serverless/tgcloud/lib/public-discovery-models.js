import {canonicalAddress} from './cloud-pricing-core.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => {throw new Error('Invalid discovery response');};
export function discoveryJson(text) {
  // Duplicate keys are ambiguous evidence. Large integer lexemes stay exact.
  if (typeof text !== 'string') invalid(); let at = 0;
  const skip = () => {while (/[\t\r\n ]/.test(text[at] || 'x')) at++;};
  function string() {const begin = at++; while (at < text.length) {if (text[at] === '\\') {at += 2; continue;} if (text[at++] === '"') return JSON.parse(text.slice(begin, at));} invalid();}
  function value(depth = 0) {
    if (depth > 32) invalid(); skip();
    if (text[at] === '"') return string();
    if (text[at] === '{') {at++; const result = Object.create(null); skip(); if (text[at] === '}') {at++; return result;}
      for (;;) {skip(); if (text[at] !== '"') invalid(); const key = string(); if (Object.hasOwn(result, key)) invalid(); skip(); if (text[at++] !== ':') invalid(); result[key] = value(depth + 1); skip(); const next = text[at++]; if (next === '}') return result; if (next !== ',') invalid();}}
    if (text[at] === '[') {at++; const result = []; skip(); if (text[at] === ']') {at++; return result;} for (;;) {result.push(value(depth + 1)); skip(); const next = text[at++]; if (next === ']') return result; if (next !== ',') invalid();}}
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(token, at)) {at += token.length; return result;}
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0]; if (!token || token.length > 128) invalid(); at += token.length;
    const result = Number(token); if (!Number.isFinite(result)) invalid(); return /^-?\d+$/.test(token) && !Number.isSafeInteger(result) ? token : result;
  }
  const result = value(); skip(); if (at !== text.length) invalid(); return result;
}
export function discoveryLogicalTime(value) {
  if (typeof value === 'number') {if (!Number.isSafeInteger(value) || value < 0) invalid(); value = String(value);}
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || BigInt(value) >= 1n << 64n) invalid();
  return BigInt(value).toString();
}
const optionalAddress = value => value === undefined || value === null || value === '' ? null : canonicalAddress(value);
export function discoveryCollection(item) {
  const direct = optionalAddress(item.collection_address), nested = optionalAddress(item.collection?.address);
  return {collection: direct || nested, conflict: Boolean(direct && nested && direct !== nested)};
}
export function parseDiscoveryTon(body, key, limit, requested = null) {
  const document = discoveryJson(body);
  if (!object(document) || !Array.isArray(document[key]) || document[key].length > limit) invalid();
  const found = new Set(), allowed = requested && new Set(requested);
  for (const item of document[key]) {
    if (!object(item)) invalid();
    const id = canonicalAddress(key === 'nft_transfers' ? item.nft_address : item.address);
    if (key !== 'nft_transfers' && (found.has(id) || allowed && !allowed.has(id))) invalid(); found.add(id);
    if (key === 'nft_items') {
      optionalAddress(item.owner_address); discoveryCollection(item);
      if (item.init !== undefined && item.init !== null && typeof item.init !== 'boolean' || item.content !== undefined && item.content !== null && !object(item.content) || item.collection !== undefined && item.collection !== null && !object(item.collection)) invalid();
      if (item.last_transaction_lt !== undefined && item.last_transaction_lt !== null) item.last_transaction_lt = discoveryLogicalTime(item.last_transaction_lt);
    } else if (key === 'nft_transfers') {
      optionalAddress(item.old_owner); optionalAddress(item.new_owner); optionalAddress(item.nft_collection);
      if (typeof item.transaction_aborted !== 'boolean') invalid(); item.transaction_lt = discoveryLogicalTime(item.transaction_lt);
    } else if (key === 'accounts') {
      if (typeof item.status !== 'string' || item.suspended !== undefined && item.suspended !== null && typeof item.suspended !== 'boolean') invalid();
      for (const field of ['code_hash', 'data_hash', 'code_boc', 'data_boc']) if (item[field] !== undefined && item[field] !== null && typeof item[field] !== 'string') invalid();
    } else invalid();
  }
  return document[key];
}
export function discoveryIdentity(item) {
  if (!item) return null;
  const collection = discoveryCollection(item);
  return JSON.stringify([optionalAddress(item.owner_address), item.last_transaction_lt ?? null, collection.collection, collection.conflict, item.init ?? null]);
}
