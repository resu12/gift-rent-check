import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {decodePriceContract, CONTRACT_VARIANTS, SUPPORTED_CODE_HASH, OBSERVED_7F44_CODE_HASH} from '../tgcloud/lib/ton-price-decoder.js';

const publicPath = new URL('../../tests/fixtures/ton/', import.meta.url);
const read = name => readFileSync(new URL(name, publicPath), 'utf8').trim();
const cases = JSON.parse(readFileSync(new URL('fixtures/ton-price-parity.json', import.meta.url))).cases;
const accountFor = sample => ({...sample.account, code_boc: read(sample.code_fixture)});
const run = (sample = cases[0], change = {}, observed = sample.observed_at) => decodePriceContract({...accountFor(sample), ...change}, sample.nft, sample.wallet, observed);

for (const sample of cases) test(`Python parity: ${sample.name}`, () => {
  const actual = run(sample);
  for (const [field, expected] of Object.entries(sample.expected)) assert.deepEqual(actual[field], expected, field);
});

test('configured asking terms are separate from the ongoing rental rate', () => {
  assert.equal(run(cases[0]).configured_price_per_day_raw, '80000000');
  assert.equal(run(cases[0]).price_per_day_raw, '0');
  assert.equal(run(cases[1]).configured_price_per_day_raw, '100000000');
  assert.equal(run(cases[2]).configured_price_per_day_raw, '70000000');
  assert.equal(run(cases[3]).configured_price_per_day_raw, '350000000');
  assert.equal(run(cases.at(-1)).configured_price_per_day_raw, ((1n << 120n) - 1n).toString());
});

test('only the exact two immutable code pins are enabled', () => {
  assert.deepEqual(Object.keys(CONTRACT_VARIANTS).sort(), [SUPPORTED_CODE_HASH, OBSERVED_7F44_CODE_HASH].sort());
  assert.ok(Object.isFrozen(CONTRACT_VARIANTS));
  assert.notEqual(CONTRACT_VARIANTS[SUPPORTED_CODE_HASH], CONTRACT_VARIANTS[OBSERVED_7F44_CODE_HASH]);
  const alternate = run(cases[2], {code_hash: SUPPORTED_CODE_HASH});
  assert.equal(alternate.reason, 'boc_hash_mismatch');
  assert.equal(alternate.code_hash_verified, false);
  assert.equal(alternate.data_hash_verified, true);
  assert.equal(alternate.contract_variant, null);
  assert.equal(run(cases[0], {code_hash: '42c6cb85fc037291674a2c61a0dae6756df24f39b6ec8bca463b79fb7564d141'}).reason, 'unsupported_code_hash');
});

test('invalid account, hash, activation and observation fail without throwing', () => {
  for (const account of [null, [], {}, {address: 'bad'}]) assert.equal(decodePriceContract(account, cases[0].nft, cases[0].wallet, cases[0].observed_at).verified, false);
  for (const observed of ['not-a-date', '2026-10-08T14:40:00', '2026-02-30T00:00:00Z', '2026-10-08T24:00:00Z', '0000-10-08T00:00:00Z', null, 0]) assert.equal(run(cases[0], {}, observed).reason, 'invalid_account');
  for (const [change, reason] of [
    [{status: 'frozen'}, 'inactive_contract'], [{suspended: true}, 'inactive_contract'],
    [{code_hash: 'invalid'}, 'invalid_hash'], [{data_hash: '00'}, 'invalid_hash'],
    [{code_hash: '00'.repeat(32)}, 'unsupported_code_hash'], [{data_hash: '00'.repeat(32)}, 'boc_hash_mismatch'],
    [{code_boc: 'broken'}, 'invalid_contract_data'], [{data_boc: null}, 'invalid_contract_data'],
    [{data_boc: 'z'.repeat(524289)}, 'invalid_contract_data'],
  ]) {const actual = run(cases[0], change); assert.equal(actual.verified, false); assert.equal(actual.reason, reason);}
});

test('expiration preserves ownership evidence without claiming a return', () => {
  for (const sample of [cases[1], cases[3]]) {
    const result = run(sample, {}, '2030-01-01T00:00:00Z');
    assert.equal(result.verified, true); assert.equal(result.rental_state, 'expired_pending_return');
  }
});

test('unrecognized status remains unknown for the price collector to reject', () => {
  const actual = run(cases.find(sample => sample.name === 'unknown-status'));
  assert.equal(actual.verified, true); assert.equal(actual.rental_state, 'unknown');
});

// Audit the deployed sources in a V8-like context with no Node/Buffer/WebCrypto
// globals. Test-only access to internal primitives checks independent vectors.
const coreSource = readFileSync(new URL('../tgcloud/lib/cloud-pricing-core.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../tgcloud/lib/ton-price-decoder.js', import.meta.url), 'utf8');
const context = vm.createContext({});
const portable = vm.runInContext(`(() => {${coreSource.replace(/^export /gm, '')}\n${source.replace(/^import .*;$/gm, '').replace(/^export /gm, '')}\nreturn {decodePriceContract, sha256, crc32c, ordinaryBoc};})()`, context);

test('portable V8 context reproduces all public fixture evidence without host APIs', () => {
  assert.equal(vm.runInContext('[typeof Buffer, typeof process, typeof require, typeof crypto, typeof atob].join(",")', context), 'undefined,undefined,undefined,undefined,undefined');
  assert.match(source, /import \{canonicalAddress, instant\} from '\.\/cloud-pricing-core\.js'/);
  assert.equal((source.match(/^import /gm) || []).length, 1);
  for (const sample of cases) {
    const actual = portable.decodePriceContract(accountFor(sample), sample.nft, sample.wallet, sample.observed_at);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), run(sample));
  }
});

test('pure SHA-256 agrees with independent crypto vectors across block boundaries', () => {
  const inputs = [new Uint8Array(), new TextEncoder().encode('abc'), new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')];
  for (const length of [1, 55, 56, 63, 64, 65, 127, 128, 1000]) inputs.push(Uint8Array.from({length}, (_, i) => (i * 137) & 255));
  for (const bytes of inputs) assert.equal(Buffer.from(portable.sha256(bytes)).toString('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(portable.crc32c(new TextEncoder().encode('123456789')), 0xe3069283);
});

function bytes() {return Buffer.from(cases[0].account.data_boc, 'base64');}
function header(input) {
  const size = input[4] & 7, offsets = input[5];
  const count = input.readUIntBE(6, size), roots = input.readUIntBE(6 + size, size);
  const totalAt = 6 + 3 * size, rootAt = totalAt + offsets;
  return {size, offsets, count, roots, totalAt, rootAt, start: rootAt + roots * size};
}
function withCRC(input) {
  const body = Buffer.from(input); body[4] |= 64;
  const crc = Buffer.alloc(4); crc.writeUInt32LE(portable.crc32c(body));
  return Buffer.concat([body, crc]);
}
const fromBoc = input => run(cases[0], {data_boc: input.toString('base64')});

test('CRC32C is checked and valid checksummed BOCs remain accepted', () => {
  const valid = withCRC(bytes()); assert.equal(fromBoc(valid).verified, true);
  const crcDamage = Buffer.from(valid); crcDamage[crcDamage.length - 1] ^= 1;
  assert.equal(fromBoc(crcDamage).reason, 'invalid_contract_data');
  const dataDamage = Buffer.from(valid); dataDamage[header(dataDamage).start + 2] ^= 1;
  assert.equal(fromBoc(dataDamage).reason, 'invalid_contract_data');
});

test('hash hex/base64url and BOC hex/base64url formats preserve verification', () => {
  const original = accountFor(cases[0]);
  const hash = value => Buffer.from(value, 'base64').toString('hex').toUpperCase();
  assert.equal(run(cases[0], {code_hash: hash(original.code_hash), data_hash: hash(original.data_hash)}).verified, true);
  assert.equal(run(cases[0], {data_boc: bytes().toString('hex')}).verified, true);
  assert.equal(run(cases[0], {data_boc: bytes().toString('base64url')}).verified, true);
});

test('indexed BOC offsets must point to the exact end of each cell', () => {
  const original = bytes(), h = header(original); let pos = h.start;
  const index = Buffer.alloc(h.count * h.offsets);
  for (let i = 0; i < h.count; i++) {
    const refs = original[pos], descriptor = original[pos + 1];
    pos += 2 + Math.ceil(descriptor / 2) + refs * h.size;
    index.writeUIntBE(pos - h.start, i * h.offsets, h.offsets);
  }
  const prefix = Buffer.from(original.subarray(0, h.start)); prefix[4] |= 128;
  const indexed = Buffer.concat([prefix, index, original.subarray(h.start)]);
  assert.equal(fromBoc(indexed).verified, true);
  indexed[h.start + h.offsets - 1] ^= 1;
  assert.equal(fromBoc(indexed).reason, 'invalid_contract_data');
});

test('structural BOC corruptions never reach verified data', () => {
  const original = bytes(), h = header(original);
  const corruptions = [
    ['magic', b => {b[0] ^= 1;}], ['flags', b => {b[4] |= 8;}], ['cache', b => {b[4] |= 32;}],
    ['zero-index-width', b => {b[4] &= 248;}], ['offset-width', b => {b[5] = 9;}],
    ['two-roots', b => {b.writeUIntBE(2, 6 + h.size, h.size);}], ['absent', b => {b.writeUIntBE(1, 6 + h.size * 2, h.size);}],
    ['bad-root', b => {b.writeUIntBE(h.count, h.rootAt, h.size);}],
    ['exotic-root', b => {b[h.start] |= 8;}], ['level-root', b => {b[h.start] |= 32;}],
    ['stored-hashes', b => {b[h.start] |= 16;}], ['fifth-ref', b => {b[h.start] = 5;}],
    ['self-ref', b => {b[h.start + 34] = 0;}], ['missing-ref', b => {b[h.start + 34] = h.count;}],
    ['exotic-child', b => {b[h.start + 38] |= 8;}],
    ['zero-top-up', b => {const child = h.start + 38, len = Math.ceil(b[child + 1] / 2); b[child + 1] |= 1; b[child + 1 + len] = 0;}],
    ['aligned-top-up', b => {const child = h.start + 38, len = Math.ceil(b[child + 1] / 2); b[child + 1] |= 1; b[child + 1 + len] = 128;}],
  ];
  for (const [label, mutate] of corruptions) {const bad = Buffer.from(original); mutate(bad); assert.equal(fromBoc(bad).reason, 'invalid_contract_data', label);}
  for (const bad of [original.subarray(0, -1), Buffer.concat([original, Buffer.from([0])])]) assert.equal(fromBoc(bad).reason, 'invalid_contract_data');
});

test('ordinary data root hash is independently recomputed, not an indexer assertion', () => {
  const input = bytes(), h = header(input); input[h.start + 2] ^= 1;
  const result = fromBoc(input);
  assert.equal(result.reason, 'boc_hash_mismatch'); assert.equal(result.code_hash_verified, true); assert.equal(result.data_hash_verified, false);
  const counterfeit = run(cases[0], {code_boc: bytes().toString('base64')});
  assert.equal(counterfeit.reason, 'boc_hash_mismatch'); assert.equal(counterfeit.code_hash_verified, false);
});
