// Opt-in Telegram wallet ownership. Addresses alone never establish ownership.
import {canonicalAddress} from './cloud-pricing-core.js';
import {ordinaryBoc, Slice, sha256} from './ton-price-decoder.js';
import {utf8Bytes} from './personal-analytics.js';
import {verifyDetached, isValidEd25519Point} from './vendor/tweetnacl-secretbox.js';
import {hmacSha256, hex, keyBytes} from './public-credential-box.js';

export class PublicWalletError extends Error {
  constructor(code) {super(code); this.code = code;}
}
const fail = (code = 'PUBLIC_WALLET_INVALID_PROOF') => {throw new PublicWalletError(code);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, required = allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const concat = (...parts) => {const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0; for (const part of parts) {bytes.set(part, offset); offset += part.length;} return bytes;};
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(value, length) {
  if (typeof value !== 'string' || value.length > Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) fail();
  const body = value.replace(/-/g, '+').replace(/_/g, '/'), raw = body.replace(/=+$/, '');
  if (raw.length % 4 === 1 || body.length !== raw.length && (body.length % 4 || body.length - raw.length !== (4 - raw.length % 4) % 4)) fail();
  const result = new Uint8Array(Math.floor(raw.length * 6 / 8)); let accumulator = 0, bits = 0, position = 0;
  for (const char of raw) {accumulator = (accumulator << 6) | BASE64.indexOf(char); bits += 6; if (bits >= 8) {bits -= 8; result[position++] = (accumulator >>> bits) & 255;} accumulator &= (1 << bits) - 1;}
  if (accumulator || result.length !== length) fail();
  return result;
}
const fromHex = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
// TON standard wallet revisions only. Unknown/custom wallet code fails closed.
// Hashes and layouts: ton-blockchain/wallet-contract (V3/V4) and wallet-contract-v5.
export const PUBLIC_WALLET_CODES = Object.freeze({
  '84dafa449f98a6987789ba232358072bc0f76dc4524002a5d0918b9a75d2d599': Object.freeze({version: 'v3r2', keyOffset: 64, bits: 320}),
  'feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0': Object.freeze({version: 'v4r2', keyOffset: 64, bits: 321}),
  '20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f': Object.freeze({version: 'v5r1', keyOffset: 65, bits: 322}),
});

/** The address is the hash of the complete StateInit, and the key comes from
 * data under a pinned wallet code hash. A supplied publicKey is only a check. */
export function publicWalletStateInit(account, codes = PUBLIC_WALLET_CODES) {
  if (!keys(account, ['address', 'chain', 'walletStateInit', 'publicKey'], ['address', 'chain', 'walletStateInit']) || account.chain !== '-239' ||
      typeof account.walletStateInit !== 'string' || account.walletStateInit.length > 262144) fail();
  let wallet, root;
  try {wallet = canonicalAddress(account.address); root = ordinaryBoc(account.walletStateInit);} catch {fail();}
  if (hex(root.hash) !== wallet.split(':')[1] || root.bitLength !== 5 || root.refs.length !== 2) fail();
  const init = new Slice(root);
  // split_depth:none, special:none, code:ref, data:ref, library:empty.
  if (init.uint(5) !== 6) fail();
  const [code, data] = root.refs, layout = codes[hex(code.hash)];
  if (!layout || data.bitLength !== layout.bits) fail('PUBLIC_WALLET_UNSUPPORTED');
  const slice = new Slice(data);
  if (layout.version === 'v5r1' && slice.uint(1) !== 1) fail();
  slice.offset = layout.keyOffset;
  const publicKey = fromHex(slice.bigint(256).toString(16).padStart(64, '0'));
  if (!isValidEd25519Point(publicKey)) fail();
  if (layout.version === 'v3r2') {if (data.refs.length) fail();}
  else if (slice.uint(1) !== data.refs.length || data.refs.length > 1) fail();
  if (account.publicKey !== undefined && (typeof account.publicKey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(account.publicKey) || account.publicKey.toLowerCase() !== hex(publicKey))) fail();
  return {wallet, publicKey, codeHash: hex(code.hash), version: layout.version};
}

export function publicWalletProofDigest(wallet, proof) {
  const domain = utf8Bytes(proof.domain.value), addressBytes = fromHex(wallet.split(':')[1]);
  const prefix = new Uint8Array(4), size = new Uint8Array(4), timestamp = new Uint8Array(8);
  new DataView(prefix.buffer).setInt32(0, Number(wallet.split(':')[0]), false);
  new DataView(size.buffer).setUint32(0, domain.length, true);
  new DataView(timestamp.buffer).setBigUint64(0, BigInt(proof.timestamp), true);
  const message = concat(utf8Bytes('ton-proof-item-v2/'), prefix, addressBytes, size, domain, timestamp, utf8Bytes(proof.payload));
  return sha256(concat(new Uint8Array([255, 255]), utf8Bytes('ton-connect'), sha256(message)));
}

export function verifyPublicWalletProof(account, proof, challenge, at, codes = PUBLIC_WALLET_CODES) {
  if (!keys(proof, ['timestamp', 'domain', 'payload', 'signature']) || !keys(proof.domain, ['lengthBytes', 'value']) ||
      !Number.isSafeInteger(at) || !Number.isSafeInteger(proof.timestamp) || proof.timestamp <= 0 ||
      typeof proof.domain.value !== 'string' || proof.domain.value !== challenge.domain ||
      proof.domain.lengthBytes !== utf8Bytes(proof.domain.value).length || proof.payload !== challenge.payload ||
      !Number.isSafeInteger(challenge.created_at) || !Number.isSafeInteger(challenge.expires_at) || challenge.created_at > at ||
      at >= challenge.expires_at || challenge.expires_at - challenge.created_at > 300000 ||
      proof.timestamp < Math.floor(challenge.created_at / 1000) - 60 || proof.timestamp > Math.floor(at / 1000) + 30 ||
      proof.timestamp < Math.floor(at / 1000) - 300) fail();
  const identity = publicWalletStateInit(account, codes);
  if (challenge.wallet && identity.wallet !== canonicalAddress(challenge.wallet)) fail();
  const signature = base64(proof.signature, 64);
  let scalar = 0n; for (let i = 63; i >= 32; i--) scalar = scalar << 8n | BigInt(signature[i]);
  if (scalar >= (1n << 252n) + 27742317777372353535851937790883648493n || !isValidEd25519Point(signature.slice(0, 32)) ||
      !verifyDetached(publicWalletProofDigest(identity.wallet, proof), signature, identity.publicKey)) fail();
  return identity.wallet;
}

export function createPublicWalletEngine({repository, ownerTelegramId, enabled = false, challengeKey, domain, manifestUrl, clock = () => repository.clock()}) {
  let secret;
  const authorize = ctx => {
    const owner = String(ownerTelegramId ?? '');
    if (!enabled || !/^[1-9]\d{0,19}$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) fail('PUBLIC_ACCESS_DENIED');
    return owner;
  };
  function configuration() {
    if (!secret) {try {secret = keyBytes(challengeKey);} catch {fail('PUBLIC_WALLET_CONFIGURATION');}}
    const manifest = typeof manifestUrl === 'string' && /^https:\/\/([^/?#]+)\/(?:[^\s?#\\]*)$/.exec(manifestUrl);
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(domain) || !manifest || manifest[1] !== domain || manifestUrl.length > 2048) fail('PUBLIC_WALLET_CONFIGURATION');
  }
  async function now() {const at = await clock(); if (!Number.isSafeInteger(at) || at <= 0) fail('PUBLIC_WALLET_CONFIGURATION'); return at;}
  async function startWalletVerification(ctx, input = {}) {
    const owner = authorize(ctx); if (!keys(input, [], [])) fail('PUBLIC_WALLET_INVALID_INPUT'); configuration();
    const counter = await repository.reserveWalletChallengeNonce(owner), at = await now();
    if (!counter || !Number.isSafeInteger(counter.generation) || counter.generation < 0 || !Number.isSafeInteger(counter.counter) || counter.counter < 1 ||
        !Number.isSafeInteger(counter.wallet_disconnect_revision) || counter.wallet_disconnect_revision < 0) fail('PUBLIC_WALLET_CONFIGURATION');
    const payload = hex(hmacSha256(secret, utf8Bytes(`gift-rent-wallet-proof-v1\0${owner}\0${counter.generation}\0${counter.counter}\0${domain}`)));
    const attempt = {challenge_id: payload, payload, domain, created_at: at, expires_at: at + 300000, wallet_disconnect_revision: counter.wallet_disconnect_revision};
    if (!await repository.issueWalletChallenge(owner, attempt)) fail('PUBLIC_WALLET_RATE_LIMIT');
    return {attempt_id: payload, challenge: payload, manifest_url: manifestUrl, domain, expires_at: new Date(attempt.expires_at).toISOString()};
  }
  async function finishWalletVerification(ctx, input = {}) {
    const owner = authorize(ctx); if (!keys(input, ['attempt_id', 'account', 'proof']) || typeof input.attempt_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.attempt_id) ||
        !object(input.proof) || typeof input.proof.payload !== 'string' || input.proof.payload !== input.attempt_id) fail('PUBLIC_WALLET_INVALID_INPUT');
    configuration(); const at = await now();
    const challenge = await repository.consumeWalletChallenge(owner, input.attempt_id, input.proof.payload, at);
    if (!challenge) fail('PUBLIC_WALLET_EXPIRED');
    if (challenge.domain !== domain) fail('PUBLIC_WALLET_INVALID_PROOF');
    const wallet = verifyPublicWalletProof(input.account, input.proof, challenge, at);
    if (!await repository.bindVerifiedWallet(owner, wallet, at, input.attempt_id)) fail('PUBLIC_WALLET_BINDING_REJECTED');
    return {verified: true, wallet, wallet_verified_at: new Date(at).toISOString()};
  }
  return {startWalletVerification, finishWalletVerification};
}
