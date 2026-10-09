// Compatibility experiment only: anonymous public GET and metadata comparison.
// No website authentication, cookies, proof persistence or provider API token.
import {canonicalAddress} from './cloud-pricing-core.js';
import {configuredAnalyticsWallet, utf8Bytes} from './personal-analytics.js';
import {sha256} from './ton-price-decoder.js';

export const MARKETAPP_LOGIN_LIMITS = Object.freeze({response_bytes: 1048576, initializer_bytes: 16384,
  challenge_bytes: 2048, timeout_ms: 30000, expiry_ms: 300000, cooldown_ms: 60000, hourly_attempts: 5, clock_skew_ms: 30000});
export const MARKETAPP_LOGIN_MANIFEST = 'https://marketapp.org/static/tonconnect-manifest.org.json';
const PAGE = 'https://marketapp.org/', DOMAIN = 'marketapp.org';
export const MARKETAPP_LOGIN_ERROR_CODES = Object.freeze(['MARKETAPP_LOGIN_FAILED', 'MARKETAPP_LOGIN_RATE_LIMIT',
  'MARKETAPP_LOGIN_EXPIRED', 'MARKETAPP_LOGIN_INVALID_INPUT', 'MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED', 'MARKETAPP_LOGIN_WALLET_REQUIRED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => Array.from(sha256(utf8Bytes(value)), byte => byte.toString(16).padStart(2, '0')).join('');
const safeError = () => new MarketappLoginRequestError('The Marketapp connection test could not be completed. Try again later.');
export class MarketappLoginRequestError extends Error {
  constructor(message, code = 'MARKETAPP_LOGIN_FAILED') {
    super(message);
    Object.defineProperty(this, 'code', {value: MARKETAPP_LOGIN_ERROR_CODES.includes(code) ? code : 'MARKETAPP_LOGIN_FAILED', enumerable: true});
  }
}
// Successful SDK responses preserve this safe machine-readable envelope. No
// error message/stack or provider/input value enters the Mini App response.
export function marketappLoginErrorResponse(error) {
  return {error: {code: error instanceof MarketappLoginRequestError && MARKETAPP_LOGIN_ERROR_CODES.includes(error.code) ? error.code : 'MARKETAPP_LOGIN_FAILED'}};
}
const invalid = () => {throw new MarketappLoginRequestError('The connection test response is invalid. Start a new test.', 'MARKETAPP_LOGIN_INVALID_INPUT');};
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

export function parseMarketappChallenge(html, limits = MARKETAPP_LOGIN_LIMITS) {
  if (typeof html !== 'string' || utf8Bytes(html).length > limits.response_bytes) invalid();
  const matches = [...html.matchAll(/\bWallet\s*\.\s*init\s*\(/g)];
  if (matches.length !== 1) invalid();
  let start = matches[0].index + matches[0][0].length;
  while (/\s/.test(html[start] || 'x')) start++;
  if (html[start] !== '{') invalid();
  let depth = 0, quoted = false, escaped = false, end = start;
  for (; end < html.length && end - start <= limits.initializer_bytes; end++) {
    const character = html[end];
    if (quoted) {if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false;}
    else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {if (++depth > 16) invalid();}
    else if (character === '}' || character === ']') {if (--depth === 0) {end++; break;}}
  }
  if (depth || quoted || end - start > limits.initializer_bytes) invalid();
  const raw = html.slice(start, end);
  if (utf8Bytes(raw).length > limits.initializer_bytes || (raw.match(/"ton_proof"\s*:/g) || []).length !== 1) invalid();
  let after = end; while (/\s/.test(html[after] || 'x')) after++;
  if (html[after] !== ')') invalid();
  let initializer; try {initializer = JSON.parse(raw);} catch {invalid();}
  const challenge = initializer?.ton_proof;
  if (!object(initializer) || typeof challenge !== 'string' || !challenge.length || challenge.length > limits.challenge_bytes || !/^[\x21-\x7e]+$/.test(challenge)) invalid();
  return challenge;
}

function decodeUtf8(bytes) {
  const output = [];
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]; let value = first, count = 0, minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {value = first & 31; count = 1; minimum = 128;}
    else if (first >= 0xe0 && first <= 0xef) {value = first & 15; count = 2; minimum = 2048;}
    else if (first >= 0xf0 && first <= 0xf4) {value = first & 7; count = 3; minimum = 65536;}
    else if (first > 127) invalid();
    if (i + count > bytes.length) invalid();
    for (let j = 0; j < count; j++) {const next = bytes[i++]; if ((next & 192) !== 128) invalid(); value = value << 6 | next & 63;}
    if (value < minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) invalid();
    output.push(String.fromCodePoint(value));
  }
  return output.join('');
}

function identifier(input, allowed) {
  if (!keys(input, allowed) || typeof input.attempt_id !== 'string' || !/^[0-9a-f]{64}$/.test(input.attempt_id)) invalid();
  return input.attempt_id;
}
function proofShape(input) {
  identifier(input, ['attempt_id', 'account', 'proof']);
  const account = input.account, proof = input.proof;
  if (!keys(account, ['address', 'chain', 'walletStateInit', 'publicKey']) || typeof account.address !== 'string' || account.address.length > 80 || typeof account.chain !== 'string' || account.chain.length > 16 ||
      account.walletStateInit !== undefined && (typeof account.walletStateInit !== 'string' || account.walletStateInit.length > 16384) ||
      account.publicKey !== undefined && (typeof account.publicKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(account.publicKey)) ||
      !keys(proof, ['timestamp', 'domain', 'payload', 'signature']) || !Number.isSafeInteger(proof.timestamp) || proof.timestamp < 0 || proof.timestamp > 8640000000000 ||
      !keys(proof.domain, ['lengthBytes', 'value']) || !Number.isSafeInteger(proof.domain.lengthBytes) || proof.domain.lengthBytes < 0 || proof.domain.lengthBytes > 255 || typeof proof.domain.value !== 'string' || proof.domain.value.length > 255 ||
      typeof proof.payload !== 'string' || !proof.payload.length || proof.payload.length > MARKETAPP_LOGIN_LIMITS.challenge_bytes || !/^[\x21-\x7e]+$/.test(proof.payload) ||
      typeof proof.signature !== 'string' || proof.signature.length > 128) invalid();
}

export function createMarketappLoginEngine({repository, fetch: request, ownerTelegramId, clock = () => repository.clock(), limits = {}}) {
  const cap = {...MARKETAPP_LOGIN_LIMITS, ...limits};
  if (Object.keys(cap).some(key => !Number.isSafeInteger(cap[key]) || cap[key] <= 0) || cap.expiry_ms > MARKETAPP_LOGIN_LIMITS.expiry_ms || cap.timeout_ms > MARKETAPP_LOGIN_LIMITS.timeout_ms || cap.response_bytes > MARKETAPP_LOGIN_LIMITS.response_bytes || cap.hourly_attempts > MARKETAPP_LOGIN_LIMITS.hourly_attempts || cap.cooldown_ms < MARKETAPP_LOGIN_LIMITS.cooldown_ms || cap.clock_skew_ms > MARKETAPP_LOGIN_LIMITS.clock_skew_ms) throw new Error('Unsafe connection-test limits');
  const authorize = ctx => {const owner = String(ownerTelegramId ?? ''); if (!/^[1-9]\d*$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) throw new MarketappLoginRequestError('Private access denied', 'MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED'); return owner;};
  async function now() {let value; try {value = await clock();} catch {throw safeError();} if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000 - cap.expiry_ms) throw safeError(); return value;}
  async function savedWallet() {const wallet = configuredAnalyticsWallet(await repository.records()); if (!wallet) throw new MarketappLoginRequestError('Configure a mainnet wallet before testing Marketapp connection.', 'MARKETAPP_LOGIN_WALLET_REQUIRED'); return wallet;}
  async function start(ctx, input = {}) {
    const owner = authorize(ctx); if (!keys(input, [])) invalid();
    const wallet = await savedWallet(), began = await now(), expires = began + cap.expiry_ms;
    // This opaque ID is not a credential. Private owner checks protect all use.
    const id = hash(`marketapp-proof-test-v1\0${owner}\0${wallet}\0${began}`);
    if (!await repository.reserveMarketappLoginAttempt({id, owner, wallet, created: began, expires}, cap)) throw new MarketappLoginRequestError('Please wait before starting another Marketapp connection test. At most five tests are allowed per hour.', 'MARKETAPP_LOGIN_RATE_LIMIT');
    let controller = null, timer = null;
    try {
      const reservedAt = await now();
      if (reservedAt < began || reservedAt - began >= cap.timeout_ms || reservedAt >= expires) throw safeError();
      if (typeof AbortController === 'function') controller = new AbortController();
      if (controller && typeof setTimeout === 'function') timer = setTimeout(() => controller.abort(), cap.timeout_ms);
      const response = await request(PAGE, {method: 'GET', headers: {Accept: 'text/html'}, redirect: 'manual', timeout: cap.timeout_ms, ...(controller ? {signal: controller.signal} : {})});
      const withinDeadline = async () => {const at = await now(); if (at < began || at - began >= cap.timeout_ms || at >= expires || controller?.signal.aborted) throw safeError(); return at;};
      await withinDeadline();
      if (response?.status !== 200 || response.url !== PAGE || response.redirected === true) throw safeError();
      const length = response.headers?.get?.('Content-Length'), contentType = response.headers?.get?.('Content-Type');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > cap.response_bytes) || typeof contentType !== 'string' || !/^text\/html(?:\s*;|$)/i.test(contentType)) throw safeError();
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw safeError();
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        if (!(chunk instanceof Uint8Array) || (total += chunk.length) > cap.response_bytes) throw safeError();
        chunks.push(chunk); await withinDeadline();
      }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      const challenge = parseMarketappChallenge(decodeUtf8(bytes), cap), issuedAt = await withinDeadline();
      if (!await repository.issueMarketappLoginAttempt(id, owner, wallet, hash(challenge), issuedAt)) throw safeError();
      await withinDeadline();
      return {attempt_id: id, challenge, manifest_url: MARKETAPP_LOGIN_MANIFEST, expires_at: new Date(expires).toISOString(), wallet, domain: DOMAIN};
    } catch {
      try {await repository.cancelMarketappLoginAttempt(id, owner);} catch {}
      throw safeError();
    } finally {if (timer !== null) clearTimeout(timer);}
  }
  async function finish(ctx, input = {}) {
    const owner = authorize(ctx); proofShape(input);
    const wallet = await savedWallet();
    const attempt = await repository.marketappLoginAttempt(input.attempt_id, owner);
    let at = await now();
    if (!attempt || attempt.state !== 'issued' || attempt.wallet !== wallet || at < attempt.created_at || at >= attempt.expires_at || !await repository.consumeMarketappLoginAttempt(input.attempt_id, owner, wallet, at)) throw new MarketappLoginRequestError('This connection test expired or was already used. Start a new test.', 'MARKETAPP_LOGIN_EXPIRED');
    at = await now();
    if (at < attempt.created_at || at >= attempt.expires_at) throw new MarketappLoginRequestError('This connection test expired or was already used. Start a new test.', 'MARKETAPP_LOGIN_EXPIRED');
    let address = null; try {address = canonicalAddress(input.account.address);} catch {}
    const timestamp = input.proof.timestamp * 1000;
    const checks = {wallet_matches: address === wallet, mainnet: input.account.chain === '-239' && address !== null,
      domain_matches: input.proof.domain.value === DOMAIN && input.proof.domain.lengthBytes === utf8Bytes(DOMAIN).length,
      challenge_matches: hash(input.proof.payload) === attempt.nonce_fingerprint,
      timestamp_fresh: Number.isSafeInteger(timestamp) && timestamp >= attempt.created_at - cap.clock_skew_ms && timestamp <= at + cap.clock_skew_ms && at - timestamp <= cap.expiry_ms,
      signature_present: /^(?:[A-Za-z0-9+/]{85}[AQgw]==|[A-Za-z0-9_-]{85}[AQgw](?:==)?)$/.test(input.proof.signature)};
    const compatible = Object.values(checks).every(Boolean);
    if (!await repository.recordMarketappLoginOutcome(input.attempt_id, owner, {compatible, checks, finished_at: new Date(at).toISOString()})) throw safeError();
    return {attempt_id: input.attempt_id, compatible, checks,
      signature_verified: false, authenticated: false, analytics_refreshed: false};
  }
  async function cancel(ctx, input = {}) {const owner = authorize(ctx); const id = identifier(input, ['attempt_id']); await repository.cancelMarketappLoginAttempt(id, owner); return {cancelled: true};}
  return {startMarketappLoginTest: start, finishMarketappLoginTest: finish, cancelMarketappLoginTest: cancel};
}
