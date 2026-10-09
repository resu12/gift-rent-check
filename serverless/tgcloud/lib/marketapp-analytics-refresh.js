// Explicit, owner-authorized website session refresh. Provider cookies, wallet
// proofs and HTML live only in memory or in a short-lived encrypted envelope.
// No Marketapp API token, retries, public history requests or raw HTML storage.
import {canonicalAddress} from './cloud-pricing-core.js';
import {configuredAnalyticsWallet, normalizePersonalAnalytics, utf8Bytes} from './personal-analytics.js';
import {parseMarketappChallenge, MARKETAPP_LOGIN_LIMITS, MARKETAPP_LOGIN_MANIFEST} from './marketapp-login.js';
import {extractMarketappAnalyticsPage} from './marketapp-analytics-page.js';
import {sha256} from './ton-price-decoder.js';

const HOME = 'https://marketapp.org/', AUTH = 'https://marketapp.org/auth/checkTonProofAuth/', DOMAIN = 'marketapp.org';
export const MARKETAPP_REFRESH_ERROR_CODES = Object.freeze(['MARKETAPP_REFRESH_FAILED', 'MARKETAPP_REFRESH_RATE_LIMIT', 'MARKETAPP_REFRESH_EXPIRED',
  'MARKETAPP_REFRESH_INVALID_INPUT', 'MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED', 'MARKETAPP_REFRESH_WALLET_REQUIRED', 'MARKETAPP_REFRESH_AUTH_REJECTED', 'MARKETAPP_REFRESH_PAGE_CHANGED']);
export class MarketappRefreshRequestError extends Error {
  constructor(code = 'MARKETAPP_REFRESH_FAILED', retry = null) {
    const safe = MARKETAPP_REFRESH_ERROR_CODES.includes(code) ? code : 'MARKETAPP_REFRESH_FAILED';
    super('The private Marketapp analytics refresh could not be completed.');
    Object.defineProperty(this, 'code', {value: safe, enumerable: true});
    // Only fixed metadata is permitted; arbitrary provider data never enters
    // the Mini App error envelope. Duration is based on the database clock.
    if (safe === 'MARKETAPP_REFRESH_RATE_LIMIT' && object(retry) &&
        ['cooldown','hourly'].includes(retry.reason) && Number.isSafeInteger(retry.retry_after_seconds) &&
        retry.retry_after_seconds > 0 && retry.retry_after_seconds <= 86400 &&
        typeof retry.retry_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(retry.retry_at) &&
        Number.isFinite(Date.parse(retry.retry_at)) && new Date(retry.retry_at).toISOString() === retry.retry_at) {
      Object.defineProperty(this, 'retry', {value: {retry_at: retry.retry_at, retry_after_seconds: retry.retry_after_seconds, reason: retry.reason}});
    }
  }
}
export function marketappRefreshErrorResponse(error) {
  const known = error instanceof MarketappRefreshRequestError && MARKETAPP_REFRESH_ERROR_CODES.includes(error.code);
  return {error: {code: known ? error.code : 'MARKETAPP_REFRESH_FAILED', ...(known && error.retry ? error.retry : {})}};
}
const fail = code => {throw new MarketappRefreshRequestError(code);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const hash = text => Array.from(sha256(utf8Bytes(text)), byte => byte.toString(16).padStart(2, '0')).join('');
const identifier = input => {if (typeof input?.attempt_id !== 'string' || !/^[0-9a-f]{64}$/.test(input.attempt_id)) fail('MARKETAPP_REFRESH_INVALID_INPUT'); return input.attempt_id;};
const ascii = (value, length) => typeof value === 'string' && value.length > 0 && value.length <= length && /^[\x21-\x7e]+$/.test(value);

// Session cookies are never combined with other names or sent off this origin.
// A comma in Expires is allowed; a second cookie or ambiguous attribute is not.
export function parseMarketappSessionCookie(header, observedAt, required = true) {
  if (header === null || header === undefined || header === '') {if (required) fail(); return null;}
  if (typeof header !== 'string' || header.length > 8192 || !/^[\x20-\x7e]+$/.test(header) || /,\s*[!#$%&'*+\-.^_`|~A-Za-z0-9]+\s*=/.test(header)) fail();
  const parts = header.split(';'), pair = /^session=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096})$/.exec(parts.shift().trim());
  if (!pair) fail();
  const seen = new Set();
  for (const raw of parts) {
    const part = raw.trim(), equal = part.indexOf('='), name = (equal < 0 ? part : part.slice(0, equal)).toLowerCase(), value = equal < 0 ? null : part.slice(equal + 1).trim();
    if (!name || seen.has(name)) fail(); seen.add(name);
    if (['secure', 'httponly', 'partitioned'].includes(name)) {if (value !== null) fail();}
    else if (name === 'path') {if (value !== '/') fail();}
    else if (name === 'domain') {if (!['marketapp.org', '.marketapp.org'].includes(value?.toLowerCase())) fail();}
    else if (name === 'samesite') {if (!['lax', 'strict', 'none'].includes(value?.toLowerCase())) fail();}
    else if (name === 'max-age') {if (!/^[1-9]\d{0,9}$/.test(value || '') || !Number.isSafeInteger(Number(value))) fail();}
    else if (name === 'expires') {const time = Date.parse(value); if (!Number.isFinite(time) || time <= observedAt || new Date(time).toUTCString() !== value) fail();}
    else fail();
  }
  return `session=${pair[1]}`;
}

export function marketappAnalyticsUrl(wallet, periodDays) {
  const canonical = canonicalAddress(wallet);
  if (![30, 365].includes(periodDays)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
  const [workchain, address] = canonical.split(':'), bytes = [0x11, Number(workchain) === -1 ? 255 : 0, ...address.match(/../g).map(pair => parseInt(pair, 16))];
  let crc = 0; for (const byte of bytes) {crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  bytes.push(crc >> 8, crc & 255);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; let friendly = '';
  for (let i = 0; i < bytes.length; i += 3) {const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2]; friendly += alphabet[n >>> 18 & 63] + alphabet[n >>> 12 & 63] + alphabet[n >>> 6 & 63] + alphabet[n & 63];}
  return `https://marketapp.org/user/${friendly}/?tab=analytics_rent&period_by=last${periodDays}days&group_by=day`;
}

function decodeUtf8(bytes) {
  const output = [];
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]; let value = first, count = 0, minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {value = first & 31; count = 1; minimum = 128;}
    else if (first >= 0xe0 && first <= 0xef) {value = first & 15; count = 2; minimum = 2048;}
    else if (first >= 0xf0 && first <= 0xf4) {value = first & 7; count = 3; minimum = 65536;}
    else if (first > 127) fail();
    if (i + count > bytes.length) fail();
    for (let j = 0; j < count; j++) {const next = bytes[i++]; if ((next & 192) !== 128) fail(); value = value << 6 | next & 63;}
    if (value < minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) fail();
    output.push(String.fromCodePoint(value));
  }
  return output.join('');
}

function featureShape(feature) {
  if (feature === 'SendTransaction') return true;
  if (!object(feature)) return false;
  if (['SendTransaction', 'SignMessage'].includes(feature.name)) return keys(feature, ['name', 'maxMessages', 'extraCurrencySupported', 'itemTypes']) && Number.isSafeInteger(feature.maxMessages) && feature.maxMessages >= 1 && feature.maxMessages <= 255 &&
    (feature.extraCurrencySupported === undefined || typeof feature.extraCurrencySupported === 'boolean') &&
    (feature.itemTypes === undefined || Array.isArray(feature.itemTypes) && feature.itemTypes.length <= 16 && feature.itemTypes.every(value => ascii(value, 64)));
  if (feature.name === 'SignData') return keys(feature, ['name', 'types']) && Array.isArray(feature.types) && feature.types.length >= 1 && feature.types.length <= 3 && feature.types.every(type => ['text', 'binary', 'cell'].includes(type));
  return feature.name === 'EmbeddedRequest' && keys(feature, ['name']);
}
function finishShape(input) {
  if (!keys(input, ['attempt_id', 'session_envelope', 'account', 'device', 'proof'])) fail('MARKETAPP_REFRESH_INVALID_INPUT'); identifier(input);
  if (typeof input.session_envelope !== 'string' || input.session_envelope.length > 16500 || !/^(?:[0-9a-f]{2})+$/.test(input.session_envelope)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
  const account = input.account, device = input.device, proof = input.proof;
  if (!keys(account, ['address', 'chain', 'walletStateInit', 'publicKey']) || !ascii(account.address, 80) || !ascii(account.chain, 16) || !ascii(account.walletStateInit, 16384) || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(account.walletStateInit) || typeof account.publicKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(account.publicKey) ||
      !keys(device, ['platform', 'appName', 'appVersion', 'maxProtocolVersion', 'features']) || !['iphone', 'ipad', 'android', 'windows', 'mac', 'linux', 'browser'].includes(device.platform) || !ascii(device.appName, 64) || !ascii(device.appVersion, 64) || !Number.isSafeInteger(device.maxProtocolVersion) || device.maxProtocolVersion < 2 || device.maxProtocolVersion > 10 || !Array.isArray(device.features) || device.features.length > 16 || !device.features.every(featureShape) ||
      !keys(proof, ['timestamp', 'domain', 'payload', 'signature']) || !Number.isSafeInteger(proof.timestamp) || proof.timestamp < 0 || proof.timestamp > 8640000000000 || !keys(proof.domain, ['lengthBytes', 'value']) || !Number.isSafeInteger(proof.domain.lengthBytes) || proof.domain.lengthBytes < 0 || proof.domain.lengthBytes > 255 || !ascii(proof.domain.value, 255) || !ascii(proof.payload, 2048) || typeof proof.signature !== 'string' || !/^(?:[A-Za-z0-9+/]{85}[AQgw]==|[A-Za-z0-9_-]{85}[AQgw](?:==)?)$/.test(proof.signature)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
}

// Decode JSON keys before checking uniqueness. JSON.parse alone would accept
// ambiguous escaped duplicates such as verified and \u0076erified.
function parseAuthResponse(source) {
  let at = 0;
  const reject = () => fail('MARKETAPP_REFRESH_AUTH_REJECTED');
  const skip = () => {while (/[\t\r\n ]/.test(source[at] || 'x')) at++;};
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') {at += 2; continue;}
      if (source[at++] === '"') {try {return JSON.parse(source.slice(start, at));} catch {reject();}}
    }
    reject();
  }
  function value(depth = 0) {
    if (depth > 16) reject(); skip();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; const result = Object.create(null); skip(); if (source[at] === '}') {at++; return result;}
      for (;;) {
        skip(); if (source[at] !== '"') reject(); const key = string();
        if (Object.hasOwn(result, key)) reject(); skip(); if (source[at++] !== ':') reject(); result[key] = value(depth + 1); skip();
        const next = source[at++]; if (next === '}') return result; if (next !== ',') reject();
      }
    }
    if (source[at] === '[') {
      at++; const result = []; skip(); if (source[at] === ']') {at++; return result;}
      for (;;) {result.push(value(depth + 1)); skip(); const next = source[at++]; if (next === ']') return result; if (next !== ',') reject();}
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) if (source.startsWith(token, at)) {at += token.length; return result;}
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0];
    if (!number || number.length > 128 || !Number.isFinite(Number(number))) reject(); at += number.length; return Number(number);
  }
  const parsed = value(); skip(); if (at !== source.length) reject(); return parsed;
}

export function createMarketappAnalyticsRefreshEngine({repository, fetch: request, ownerTelegramId, clock = () => repository.clock(), sessionBox}) {
  const cap = MARKETAPP_LOGIN_LIMITS;
  const authorize = ctx => {const owner = String(ownerTelegramId ?? ''); if (!/^[1-9]\d*$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) fail('MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED'); return owner;};
  async function now() {let at; try {at = await clock();} catch {fail();} if (!Number.isSafeInteger(at) || at <= 0 || at > 8640000000000000 - cap.expiry_ms) fail(); return at;}
  async function savedWallet() {const wallet = configuredAnalyticsWallet(await repository.records()); if (!wallet) fail('MARKETAPP_REFRESH_WALLET_REQUIRED'); return wallet;}
  async function recordOutcome(id, owner, periodDays, state, stage, {code = null, authenticated = false, analyticsRefreshed = false, diagnosticReason = null, snapshotFingerprint = null} = {}, observedAt = null) {
    const outcome = {version: 1, flow: 'analytics_refresh', state, stage, code, observed_at: new Date(observedAt ?? await now()).toISOString(),
      period_days: periodDays, authenticated, analytics_refreshed: analyticsRefreshed};
    if (diagnosticReason !== null && state === 'failed' && stage === 'validate_analytics' && ['page_structure', 'wallet_identity', 'request_parameters', 'analytics_shape', 'period_span'].includes(diagnosticReason)) outcome.diagnostic_reason = diagnosticReason;
    if (typeof snapshotFingerprint === 'string' && /^[0-9a-f]{64}$/.test(snapshotFingerprint) && (stage === 'save_snapshot' || state === 'saved' && stage === 'complete')) outcome.snapshot_fingerprint = snapshotFingerprint;
    if (!await repository.recordMarketappRefreshOutcome(id, owner, outcome)) fail();
  }
  async function recordFailure(id, owner, periodDays, stage, error, {authenticated = false, analyticsRefreshed = false, diagnosticReason = null, snapshotFingerprint = null} = {}, fallbackTime) {
    // Diagnosing a failed host call must never serialize its message. Audit is
    // best effort only on failure; provider stages require successful writes.
    let at = fallbackTime; try {at = await now();} catch {}
    try {await recordOutcome(id, owner, periodDays, 'failed', stage, {code: marketappRefreshErrorResponse(error).error.code, authenticated, analyticsRefreshed, diagnosticReason, snapshotFingerprint}, at);} catch {}
  }
  async function fetchBounded(url, method, headers, body, expires, overall = null, bytesLimit = cap.response_bytes) {
    const began = await now();
    if (began >= expires || overall !== null && (began < overall || began - overall >= 90000)) fail('MARKETAPP_REFRESH_EXPIRED');
    let controller = null, timer = null;
    try {
      if (typeof AbortController === 'function') controller = new AbortController();
      if (controller && typeof setTimeout === 'function') timer = setTimeout(() => controller.abort(), cap.timeout_ms);
      const response = await request(url, {method, headers, ...(body === undefined ? {} : {body}), redirect: 'manual', timeout: cap.timeout_ms, ...(controller ? {signal: controller.signal} : {})});
      const deadline = async () => {const at = await now(); if (at < began || at - began >= cap.timeout_ms || at >= expires || overall !== null && (at < overall || at - overall >= 90000) || controller?.signal.aborted) fail(); return at;};
      await deadline();
      if (response?.status !== 200 || response.url !== url || response.redirected === true || response.headers?.get?.('Location')) fail();
      const length = response.headers?.get?.('Content-Length'), type = response.headers?.get?.('Content-Type');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > bytesLimit) || typeof type !== 'string' || !(method === 'POST' ? /^application\/json(?:\s*;|$)/i : /^text\/html(?:\s*;|$)/i).test(type) || !response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail();
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {if (!(chunk instanceof Uint8Array) || (total += chunk.length) > bytesLimit) fail(); chunks.push(chunk); await deadline();}
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      return {body: decodeUtf8(bytes), cookie: response.headers?.get?.('Set-Cookie') ?? null, observedAt: await deadline()};
    } catch (error) {if (error instanceof MarketappRefreshRequestError) throw error; fail();}
    finally {if (timer !== null) clearTimeout(timer);}
  }
  async function start(ctx, input = {}) {
    const owner = authorize(ctx);
    if (!keys(input, ['period_days']) || ![30, 365].includes(input.period_days)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const wallet = await savedWallet(), created = await now(), expires = created + cap.expiry_ms;
    const id = hash(`marketapp-analytics-refresh-v1\0${owner}\0${wallet}\0${created}\0${input.period_days}`);
    if (!await repository.reserveMarketappLoginAttempt({id, owner, wallet, created, expires}, cap)) {
      let retry = null;
      try {if (typeof repository.marketappLoginRetry === 'function') retry = await repository.marketappLoginRetry(owner, await now(), cap);} catch { /* Generic limit remains safe when the retry read fails. */ }
      throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT', retry);
    }
    try {
      if (await now() - created >= cap.timeout_ms) fail();
      const response = await fetchBounded(HOME, 'GET', {Accept: 'text/html'}, undefined, expires, created);
      let challenge; try {challenge = parseMarketappChallenge(response.body);} catch {fail('MARKETAPP_REFRESH_PAGE_CHANGED');}
      const cookie = parseMarketappSessionCookie(response.cookie, response.observedAt);
      const envelope = await sessionBox.seal({version: 1, attempt_id: id, owner, wallet, period_days: input.period_days, created_at: created, expires_at: expires, cookie, challenge});
      if (typeof envelope !== 'string' || envelope.length > 16500 || !/^(?:[0-9a-f]{2})+$/.test(envelope) || !await repository.issueMarketappLoginAttempt(id, owner, wallet, hash(challenge), await now())) fail();
      const done = await now(); if (done < created || done - created >= cap.timeout_ms || done >= expires) fail();
      await recordOutcome(id, owner, input.period_days, 'awaiting_approval', 'prepare');
      const recorded = await now(); if (recorded < created || recorded - created >= cap.timeout_ms || recorded >= expires) fail();
      return {attempt_id: id, challenge, manifest_url: MARKETAPP_LOGIN_MANIFEST, expires_at: new Date(expires).toISOString(), wallet, domain: DOMAIN, period_days: input.period_days, session_envelope: envelope};
    } catch (error) {
      try {await repository.cancelMarketappLoginAttempt(id, owner);} catch {}
      await recordFailure(id, owner, input.period_days, 'prepare', error, {}, created);
      if (error instanceof MarketappRefreshRequestError) throw error; fail();
    }
  }
  async function finish(ctx, input = {}) {
    const owner = authorize(ctx); finishShape(input);
    const wallet = await savedWallet(); let session;
    try {session = await sessionBox.open(input.session_envelope);} catch {fail('MARKETAPP_REFRESH_INVALID_INPUT');}
    if (!keys(session, ['version', 'attempt_id', 'owner', 'wallet', 'period_days', 'created_at', 'expires_at', 'cookie', 'challenge']) || session.version !== 1 || session.attempt_id !== input.attempt_id || session.owner !== owner || session.wallet !== wallet || ![30, 365].includes(session.period_days) || !Number.isSafeInteger(session.created_at) || !Number.isSafeInteger(session.expires_at) || session.expires_at - session.created_at <= 0 || session.expires_at - session.created_at > cap.expiry_ms || !ascii(session.challenge, 2048) || !ascii(session.cookie, 4104) || !/^session=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session.cookie) || session.attempt_id !== hash(`marketapp-analytics-refresh-v1\0${owner}\0${wallet}\0${session.created_at}\0${session.period_days}`)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const attempt = await repository.marketappLoginAttempt(input.attempt_id, owner), began = await now();
    if (!attempt || attempt.state !== 'issued' || attempt.wallet !== wallet || attempt.created_at !== session.created_at || attempt.expires_at !== session.expires_at || attempt.nonce_fingerprint !== hash(session.challenge) || began < attempt.created_at || began >= attempt.expires_at) fail('MARKETAPP_REFRESH_EXPIRED');
    let address = null; try {address = canonicalAddress(input.account.address);} catch {}
    const timestamp = input.proof.timestamp * 1000;
    if (address !== wallet || input.account.chain !== '-239' || input.proof.domain.value !== DOMAIN || input.proof.domain.lengthBytes !== 13 || input.proof.payload !== session.challenge || !Number.isSafeInteger(timestamp) || timestamp < attempt.created_at - cap.clock_skew_ms || timestamp > began + cap.clock_skew_ms || began - timestamp > cap.expiry_ms) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    if (!await repository.consumeMarketappLoginAttempt(input.attempt_id, owner, wallet, began)) fail('MARKETAPP_REFRESH_EXPIRED');
    let stage = 'authenticate', authenticated = false, analyticsRefreshed = false, diagnosticReason = null, snapshotFingerprint = null;
    try {
      await recordOutcome(input.attempt_id, owner, session.period_days, 'updating', stage);
      // At most one provider proof submission. Never retry after consumption.
      const auth = await fetchBounded(AUTH, 'POST', {Accept: 'application/json', 'Content-Type': 'application/json', Cookie: session.cookie,
        Origin: 'https://marketapp.org', Referer: HOME}, JSON.stringify({account: input.account, device: input.device, proof: input.proof, ref: null}), session.expires_at, began, 65536);
      let result; try {result = parseAuthResponse(auth.body);} catch {fail('MARKETAPP_REFRESH_AUTH_REJECTED');}
      if (!object(result) || result.verified !== true) fail('MARKETAPP_REFRESH_AUTH_REJECTED');
      authenticated = true;
      const cookie = parseMarketappSessionCookie(auth.cookie, auth.observedAt, false) || session.cookie;
      const sourceUrl = marketappAnalyticsUrl(wallet, session.period_days);
      stage = 'fetch_analytics';
      await recordOutcome(input.attempt_id, owner, session.period_days, 'updating', stage, {authenticated});
      const page = await fetchBounded(sourceUrl, 'GET', {Accept: 'text/html', Cookie: cookie}, undefined, session.expires_at, began);
      parseMarketappSessionCookie(page.cookie, page.observedAt, false);
      stage = 'validate_analytics';
      await recordOutcome(input.attempt_id, owner, session.period_days, 'updating', stage, {authenticated});
      let raw, snapshot;
      try {
        raw = JSON.stringify(extractMarketappAnalyticsPage(page.body, {wallet, periodDays: session.period_days, capturedAt: new Date(page.observedAt).toISOString(), sourceUrl}));
        snapshot = normalizePersonalAnalytics(raw, wallet);
        if (snapshot.daily.length !== session.period_days) {diagnosticReason = 'period_span'; fail('MARKETAPP_REFRESH_PAGE_CHANGED');}
      } catch (error) {
        diagnosticReason = ['page_structure', 'wallet_identity', 'request_parameters', 'analytics_shape', 'period_span'].includes(error?.reason) ? error.reason : diagnosticReason || 'analytics_shape';
        fail('MARKETAPP_REFRESH_PAGE_CHANGED');
      }
      if (await savedWallet() !== wallet) fail('MARKETAPP_REFRESH_EXPIRED');
      const done = await now();
      if (done < began || done - began >= 90000 || done >= session.expires_at) fail('MARKETAPP_REFRESH_EXPIRED');
      stage = 'save_snapshot';
      snapshotFingerprint = snapshot.fingerprint;
      await recordOutcome(input.attempt_id, owner, session.period_days, 'updating', stage, {authenticated, snapshotFingerprint});
      // The diagnostic write may consume time. Fence the actual immutable
      // import with the same saved-wallet and trusted-clock bounds again.
      if (await savedWallet() !== wallet) fail('MARKETAPP_REFRESH_EXPIRED');
      const importing = await now();
      if (importing < began || importing - began >= 90000 || importing >= session.expires_at) fail('MARKETAPP_REFRESH_EXPIRED');
      await repository.importPersonalAnalytics(snapshot, raw, new Date(importing).toISOString());
      analyticsRefreshed = true;
      // Import is already committed. A diagnostic write failure cannot undo
      // it or truthfully turn this successful refresh into a failed result.
      try {await recordOutcome(input.attempt_id, owner, session.period_days, 'saved', 'complete', {authenticated, analyticsRefreshed, snapshotFingerprint});} catch {}
      return {attempt_id: input.attempt_id, authenticated: true, analytics_refreshed: true, snapshot};
    } catch (error) {
      await recordFailure(input.attempt_id, owner, session.period_days, stage, error, {authenticated, analyticsRefreshed, diagnosticReason, snapshotFingerprint}, began);
      if (error instanceof MarketappRefreshRequestError) throw error; fail();
    }
  }
  async function cancel(ctx, input = {}) {const owner = authorize(ctx); if (!keys(input, ['attempt_id'])) fail('MARKETAPP_REFRESH_INVALID_INPUT'); const id = identifier(input); await repository.cancelMarketappLoginAttempt(id, owner); return {cancelled: true};}
  return {startMarketappAnalyticsRefresh: start, finishMarketappAnalyticsRefresh: finish, cancelMarketappAnalyticsRefresh: cancel};
}
