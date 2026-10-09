// Read-only decoder for the two independently pinned Marketapp code variants.
// A deliberately bounded ordinary-cell BOC implementation: no Node builtins,
// Buffer, WebCrypto, dynamic imports, npm dependencies, network or VM execution.
// Format: https://github.com/ton-blockchain/ton/blob/master/crypto/tl/boc.tlb
// Hash representation: https://docs.ton.org/foundations/serialization/cells
// SHA-256 is implemented directly from FIPS 180-4 (no third-party source copied).
import {canonicalAddress, instant} from './cloud-pricing-core.js';

export const DECODER_VERSION = 'marketapp-rental-registry-v2';
export const STORAGE_LAYOUT_VERSION = 'marketapp-four-refs-two-fees-v1';
export const MARKETAPP_OPERATOR = '0:9a9cb80adfbd1662f5108766d73355ac2c03304fda1d25a479670e34efcd72b3';
export const SUPPORTED_CODE_HASH = 'f3b93b1d262f709aff1ec25ae39141a7ecdd8c8a29b87a2b6bb1cdab4aec714a';
export const OBSERVED_7F44_CODE_HASH = '7f44beadf4911724268d7008c490be627f203047fea4d3276b51bdfd55bf23fc';
export const CONTRACT_VARIANTS = Object.freeze({
  [SUPPORTED_CODE_HASH]: 'marketapp-observed-f3b93b1d-v1',
  [OBSERVED_7F44_CODE_HASH]: 'marketapp-observed-7f44bead-v1',
});
const MAX_BOC_BYTES = 262144, MAX_CELLS = 4096;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fail = () => {throw new Error('Invalid ordinary TON BOC or storage');};

function base64Bytes(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BOC_BYTES / 3) * 4) fail();
  const text = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail();
  const body = text.replace(/=+$/, '');
  if (body.length % 4 === 1 || (body.length !== text.length && (text.length % 4 || text.length - body.length !== (4 - body.length % 4) % 4))) fail();
  const bytes = new Uint8Array(Math.floor(body.length * 6 / 8));
  let acc = 0, bits = 0, pos = 0;
  for (const ch of body) {
    acc = (acc << 6) | BASE64.indexOf(ch); bits += 6;
    if (bits >= 8) {bits -= 8; bytes[pos++] = (acc >>> bits) & 255;}
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) fail();
  return bytes;
}
function hashHex(value) {
  if (typeof value !== 'string') fail();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  const bytes = base64Bytes(value);
  if (bytes.length !== 32) fail();
  return hex(bytes);
}

// Standard SHA-256 round constants and initial state, per FIPS 180-4 section 4.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const ror = (n, bits) => (n >>> bits) | (n << (32 - bits));
export function sha256(bytes) {
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes); data[bytes.length] = 128;
  const view = new DataView(data.buffer), bitLength = bytes.length * 8;
  view.setUint32(data.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(data.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      j = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a,b,c,d,e,f,g,j].forEach((n, i) => {h[i] = (h[i] + n) >>> 0;});
  }
  const result = new Uint8Array(32), output = new DataView(result.buffer);
  h.forEach((n, i) => output.setUint32(i * 4, n));
  return result;
}
function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (~crc) >>> 0;
}

function ordinaryBoc(value) {
  if (typeof value !== 'string' || value.length > MAX_BOC_BYTES * 2) fail();
  const text = value.trim();
  const bytes = /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0
    ? Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16)) : base64Bytes(text);
  if (bytes.length < 11 || bytes.length > MAX_BOC_BYTES) fail();
  let pos = 0;
  function uint(size) {
    if (pos + size > bytes.length) fail();
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[pos++];
    if (!Number.isSafeInteger(value)) fail();
    return value;
  }
  if (uint(4) !== 0xb5ee9c72) fail();
  const flags = uint(1), size = flags & 7, offsetSize = uint(1);
  const indexed = Boolean(flags & 128), crc = Boolean(flags & 64);
  // Only the current BOC format with complete, ordinary level-zero cells is
  // needed for these pinned contracts. Cache/absent/exotic cells fail closed.
  if ((flags & 56) || size < 1 || size > 4 || offsetSize < 1 || offsetSize > 8) fail();
  const count = uint(size), roots = uint(size), absent = uint(size), total = uint(offsetSize);
  if (count < 1 || count > MAX_CELLS || roots !== 1 || absent !== 0 || total < count * 2 || total > MAX_BOC_BYTES) fail();
  const root = uint(size);
  if (root >= count) fail();
  const index = indexed ? Array.from({length: count}, () => uint(offsetSize)) : null;
  const start = pos, end = start + total;
  if (end + (crc ? 4 : 0) !== bytes.length) fail();
  if (crc && crc32c(bytes.subarray(0, end)) !== new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0, true)) fail();
  const cells = [];
  for (let ci = 0; ci < count; ci++) {
    if (pos + 2 > end) fail();
    const refsCount = uint(1), descriptor = uint(1), dataLength = Math.ceil(descriptor / 2);
    // d1 is exactly the reference count for ordinary level-zero, no-hash cells.
    if (refsCount > 4 || pos + dataLength + refsCount * size > end) fail();
    const data = bytes.slice(pos, pos + dataLength); pos += dataLength;
    let bitLength = dataLength * 8;
    if (descriptor & 1) {
      const last = data[data.length - 1];
      if (!last) fail();
      let padding = 0;
      while (((last >>> padding) & 1) === 0) padding++;
      if (padding === 7) fail(); // would encode an aligned byte as unaligned
      bitLength -= padding + 1;
    }
    if (bitLength > 1023) fail();
    const refs = Array.from({length: refsCount}, () => uint(size));
    if (refs.some(ref => ref <= ci || ref >= count)) fail();
    if (index && index[ci] !== pos - start) fail();
    cells.push({data, bitLength, refs, descriptor, hash: null, depth: 0});
  }
  if (pos !== end) fail();
  const seen = new Set(), todo = [root];
  while (todo.length) {
    const i = todo.pop();
    if (!seen.has(i)) {seen.add(i); todo.push(...cells[i].refs);}
  }
  if (seen.size !== count) fail();
  for (let i = count - 1; i >= 0; i--) {
    const cell = cells[i]; cell.refs = cell.refs.map(ref => cells[ref]);
    cell.depth = cell.refs.length ? Math.max(...cell.refs.map(ref => ref.depth)) + 1 : 0;
    if (cell.depth >= 1024) fail();
    const repr = new Uint8Array(2 + cell.data.length + cell.refs.length * 34);
    repr[0] = cell.refs.length; repr[1] = cell.descriptor; repr.set(cell.data, 2);
    let p = 2 + cell.data.length;
    for (const ref of cell.refs) {repr[p++] = ref.depth >>> 8; repr[p++] = ref.depth & 255;}
    for (const ref of cell.refs) {repr.set(ref.hash, p); p += 32;}
    cell.hash = sha256(repr);
  }
  return cells[root];
}

class Slice {
  constructor(cell) {this.cell = cell; this.offset = 0;}
  bigint(bits) {
    if (this.offset + bits > this.cell.bitLength) fail();
    let value = 0n;
    for (let i = 0; i < bits; i++) {
      value = (value << 1n) | BigInt((this.cell.data[this.offset >>> 3] >>> (7 - (this.offset & 7))) & 1);
      this.offset++;
    }
    return value;
  }
  uint(bits) {
    const value = this.bigint(bits);
    // Timestamp fields cannot silently lose precision in a JavaScript number.
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(value);
  }
  coins() {return this.bigint(this.uint(4) * 8).toString();}
  address(nullable = false) {
    const kind = this.uint(2);
    if (kind === 0 && nullable) return null;
    if (kind !== 2 || this.uint(1) !== 0) fail();
    const workchain = this.uint(8), value = this.bigint(256).toString(16).padStart(64, '0');
    return canonicalAddress(`${workchain > 127 ? workchain - 256 : workchain}:${value}`);
  }
  finished() {if (this.offset !== this.cell.bitLength || this.cell.refs.length) fail();}
}

function observationTime(value) {
  if (typeof value !== 'string' || value.length > 100) fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail();
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) fail();
  const parsed = instant(value);
  if (parsed === null) fail();
  return parsed;
}

// Only account-snapshot evidence is verified here. The caller MUST also check
// the NFT's current holder and collection, then recheck its owner and LT after
// the account read. Verified ownership alone does not prove marketplace listing.
export function decodePriceContract(account, nft, wallet, observedAt) {
  const result = {
    verified: false, reason: 'invalid_account', rental_state: 'unknown',
    decoder_version: DECODER_VERSION, observed_at: observedAt,
    contract_variant: null, storage_layout_version: null,
    holding_contract: null, code_hash: null, data_hash: null,
    code_hash_verified: false, data_hash_verified: false,
    account_last_transaction_lt: null, owner: null, nft: null, marketplace: null,
    created_at: null, role: null, status: null, rental_duration: null,
    rental_until: null, price_per_day_raw: null, configured_price_per_day_raw: null,
    renter: null, counterpart: null,
  };
  if (!account || typeof account !== 'object' || Array.isArray(account)) return result;
  let expectedNft, expectedOwner, observed;
  try {
    expectedNft = canonicalAddress(nft); expectedOwner = canonicalAddress(wallet);
    result.holding_contract = canonicalAddress(account.address);
    result.account_last_transaction_lt = account.last_transaction_lt ?? null;
    observed = observationTime(observedAt);
  } catch {return result;}
  if (account.status !== 'active' || account.suspended === true) {result.reason = 'inactive_contract'; return result;}
  try {result.code_hash = hashHex(account.code_hash); result.data_hash = hashHex(account.data_hash);}
  catch {result.reason = 'invalid_hash'; return result;}
  const variant = CONTRACT_VARIANTS[result.code_hash];
  if (!variant) {result.reason = 'unsupported_code_hash'; return result;}
  try {
    const code = ordinaryBoc(account.code_boc), data = ordinaryBoc(account.data_boc);
    result.code_hash_verified = hex(code.hash) === result.code_hash;
    result.data_hash_verified = hex(data.hash) === result.data_hash;
    if (!result.code_hash_verified || !result.data_hash_verified) {result.reason = 'boc_hash_mismatch'; return result;}
    result.contract_variant = variant; result.storage_layout_version = STORAGE_LAYOUT_VERSION;
    if (data.bitLength !== 256 || data.refs.length !== 4 || data.refs.some(cell => cell.refs.length)) fail();
    const identity = new Slice(data.refs[0]);
    result.owner = identity.address(); result.nft = identity.address(); result.marketplace = identity.address();
    result.created_at = identity.uint(64); result.role = identity.uint(2); identity.finished();
    if (![0, 1].includes(result.role)) fail();
    const state = new Slice(data.refs[1]);
    result.status = state.uint(3); result.rental_duration = state.uint(32); result.rental_until = state.uint(64);
    result.price_per_day_raw = state.coins(); result.renter = state.address(true); result.counterpart = state.address(true); state.finished();
    const settings = new Slice(data.refs[2]);
    result.auto_relist = Boolean(settings.uint(1)); result.min_duration_raw = settings.uint(32); result.max_duration_raw = settings.uint(32);
    result.configured_price_per_day_raw = settings.coins(); result.discount_per_day_raw = settings.uint(32);
    result.discount_denominator_raw = settings.uint(32); result.max_discount_raw = settings.uint(32); result.sale_price_raw = settings.coins(); settings.finished();
    const fees = new Slice(data.refs[3]);
    result.fee_recipient = fees.address(); result.fee_numerator_raw = fees.uint(32); result.fee_denominator_raw = fees.uint(32);
    result.extra_fee_recipient = fees.address(); result.extra_fee_numerator_raw = fees.uint(32); result.extra_fee_denominator_raw = fees.uint(32); fees.finished();
  } catch {result.reason = 'invalid_contract_data'; return result;}
  for (const [field, expected, reason] of [['owner', expectedOwner, 'owner_mismatch'], ['nft', expectedNft, 'nft_mismatch'], ['marketplace', MARKETAPP_OPERATOR, 'operator_mismatch']]) {
    if (result[field] !== expected) {result.reason = reason; return result;}
  }
  result.verified = true; result.reason = 'verified_rental_owner';
  if (result.role === 0 && result.status === 0 && result.renter === null && result.rental_until === 0) result.rental_state = 'idle_rental_contract';
  else if (result.role === 1 && result.status === 1 && result.renter !== null && result.counterpart !== null && result.rental_until > 0) result.rental_state = result.rental_until > observed / 1000 ? 'rented' : 'expired_pending_return';
  return result;
}
