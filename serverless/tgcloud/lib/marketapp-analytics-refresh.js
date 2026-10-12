// Explicit, owner-authorized website session refresh. Provider cookies, wallet
// proofs and HTML live only in memory or in a short-lived encrypted envelope.
// Optional remembered cookies use a separate private encrypted backend record;
// no Marketapp API token, proof reuse, retries or raw HTML storage.
import {canonicalAddress} from './cloud-pricing-core.js';
import {configuredAnalyticsWallet, normalizePersonalAnalytics, utf8Bytes} from './personal-analytics.js';
import {withStorageReservation} from './storage-admission.js';
import {parseMarketappChallenge, MARKETAPP_LOGIN_LIMITS, MARKETAPP_LOGIN_MANIFEST} from './marketapp-login.js';
import {extractMarketappAnalyticsPage} from './marketapp-analytics-page.js';
import {sha256} from './ton-price-decoder.js';
import {createMarketappWebsiteSession, MARKETAPP_REMEMBERED_SESSION_MAX_MS, MarketappWebsiteSessionError} from './marketapp-website-session.js';
import {safeMarketappRefreshOutcome, MARKETAPP_REFRESH_ERROR_CODES} from './marketapp-refresh-outcome.js';

const HOME = 'https://marketapp.org/', AUTH = 'https://marketapp.org/auth/checkTonProofAuth/', DOMAIN = 'marketapp.org';
export const MARKETAPP_STARTUP_ANALYTICS_INTERVAL_MS = 15 * 60000;
export {MARKETAPP_REMEMBERED_SESSION_MAX_MS} from './marketapp-website-session.js';
export {MARKETAPP_REFRESH_ERROR_CODES} from './marketapp-refresh-outcome.js';
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
export function parseMarketappSessionCookieMetadata(header, observedAt, required = true, allowDeleted = false) {
  if (header === null || header === undefined || header === '') {if (required) fail(); return null;}
  if (typeof header !== 'string' || header.length > 8192 || !/^[\x20-\x7e]+$/.test(header) || /,\s*[!#$%&'*+\-.^_`|~A-Za-z0-9]+\s*=/.test(header)) fail();
  const parts = header.split(';'), pair = /^session=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096})$/.exec(parts.shift().trim());
  if (!pair) fail();
  const seen = new Set(); let expires = null, deleted = false;
  for (const raw of parts) {
    const part = raw.trim(), equal = part.indexOf('='), name = (equal < 0 ? part : part.slice(0, equal)).toLowerCase(), value = equal < 0 ? null : part.slice(equal + 1).trim();
    if (!name || seen.has(name)) fail(); seen.add(name);
    if (['secure', 'httponly', 'partitioned'].includes(name)) {if (value !== null) fail();}
    else if (name === 'path') {if (value !== '/') fail();}
    else if (name === 'domain') {if (!['marketapp.org', '.marketapp.org'].includes(value?.toLowerCase())) fail();}
    else if (name === 'samesite') {if (!['lax', 'strict', 'none'].includes(value?.toLowerCase())) fail();}
    else if (name === 'max-age') {
      if (!/^-?(?:0|[1-9]\d{0,9})$/.test(value || '') || !Number.isSafeInteger(Number(value))) fail();
      const time = observedAt + Number(value) * 1000; if (!Number.isSafeInteger(time)) fail();
      expires = expires === null ? time : Math.min(expires, time); if (time <= observedAt) deleted = true;
    }
    else if (name === 'expires') {
      const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) fail();
      expires = expires === null ? time : Math.min(expires, time); if (time <= observedAt) deleted = true;
    }
    else fail();
  }
  if (!pair[1] && !deleted || deleted && !allowDeleted) fail();
  return {cookie: pair[1] ? `session=${pair[1]}` : null, expires_at: expires, deleted};
}
export function parseMarketappSessionCookie(header, observedAt, required = true) {
  return parseMarketappSessionCookieMetadata(header, observedAt, required)?.cookie ?? null;
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

export function createMarketappAnalyticsRefreshEngine({repository, fetch: request, ownerTelegramId, clock = () => repository.clock(), sessionBox, rememberedSessionBox,
  sleep = milliseconds => typeof setTimeout === 'function' ? new Promise(resolve => setTimeout(resolve,milliseconds)) : Promise.reject(new Error('Website pacing unavailable'))}) {
  const cap = MARKETAPP_LOGIN_LIMITS;
  const website=createMarketappWebsiteSession({repository,rememberedSessionBox,ownerTelegramId,clock});
  async function acquireWebsite(owner,id){
    // Older adapters are maintained for offline recovery and tests. Production
    // repositories implement the durable shared gate; never use an in-memory
    // mutex as a substitute for account serialization.
    if(typeof repository.acquireMarketappWebsiteLease!=='function')return null;
    const lease=await website.acquire(owner,id);
    if(!lease)throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT');
    return lease;
  }
  async function releaseWebsite(owner,lease){if(lease)try{await website.release(owner,lease);}catch{}}
  async function websiteRequest(owner,lease,id,expires,authentication=false){
    if(!lease)return;
    for(let attempts=0;attempts<2;attempts++){
      const reservation=await website.reserve(owner,lease,id,{authentication});if(reservation.allowed)return;
      const at=await now(),retryAt=Date.parse(reservation.retry_at);
      if(at>=expires||reservation.reason!=='cooldown'||!Number.isFinite(retryAt)||retryAt-at>1500||retryAt>=expires)
        throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT', {...reservation,reason:'cooldown'});
      try{await sleep(Math.max(1,retryAt-at));}catch{throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT', {...reservation,reason:'cooldown'});}
    }
    throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT');
  }
  const authorize = ctx => {const owner = String(ownerTelegramId ?? ''); if (!/^[1-9]\d*$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) fail('MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED'); return owner;};
  async function now() {let at; try {at = await clock();} catch {fail();} if (!Number.isSafeInteger(at) || at <= 0 || at > 8640000000000000 - cap.expiry_ms) fail(); return at;}
  async function walletRecords() {return await (typeof repository.analyticsWalletRecords === 'function' ? repository.analyticsWalletRecords() : repository.records());}
  async function savedWallet() {const wallet = configuredAnalyticsWallet(await walletRecords()); if (!wallet) fail('MARKETAPP_REFRESH_WALLET_REQUIRED'); return wallet;}
  async function fence(owner) {
    const value = await repository.marketappSessionFence(owner);
    if (!value || !['generation', 'wallet_revision', 'cookie_version'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) fail();
    return value;
  }
  async function current(owner, wallet, sessionFence, cookieVersion = null) {
    if (await savedWallet() !== wallet || !await repository.marketappSessionIsCurrent(owner, sessionFence, cookieVersion)) fail('MARKETAPP_REFRESH_EXPIRED');
  }
  async function reserve(attempt) {
    if (await repository.reserveMarketappLoginAttempt(attempt, cap)) return;
    let retry = null;
    try {if (typeof repository.marketappLoginRetry === 'function') retry = await repository.marketappLoginRetry(attempt.owner, await now(), cap);} catch {}
    throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT', retry);
  }
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
  async function fetchBounded(url, method, headers, body, expires, overall = null, bytesLimit = cap.response_bytes, savedLogin = false, traffic = null) {
    if(traffic)await websiteRequest(traffic.owner,traffic.lease,traffic.id,expires,traffic.authentication===true);
    const began = await now();
    if (began >= expires || overall !== null && (began < overall || began - overall >= 90000)) fail('MARKETAPP_REFRESH_EXPIRED');
    let controller = null, timer = null;
    try {
      if (typeof AbortController === 'function') controller = new AbortController();
      if (controller && typeof setTimeout === 'function') timer = setTimeout(() => controller.abort(), cap.timeout_ms);
      const response = await request(url, {method, headers, ...(body === undefined ? {} : {body}), redirect: 'manual', timeout: cap.timeout_ms, ...(controller ? {signal: controller.signal} : {})});
      const deadline = async () => {const at = await now(); if (at < began || at - began >= cap.timeout_ms || at >= expires || overall !== null && (at < overall || at - overall >= 90000) || controller?.signal.aborted) fail(); return at;};
      await deadline();
      if(traffic?.lease&&(response?.status===429||response?.status>=500&&response?.status<=599)){
        const at=await now(),header=response.headers?.get?.('Retry-After');let delay=1000;
        if(typeof header==='string'&&/^\d{1,5}$/.test(header.trim()))delay=Math.max(1000,Math.min(86400000,Number(header.trim())*1000));
        else if(typeof header==='string'&&Number.isFinite(Date.parse(header)))delay=Math.max(1000,Math.min(86400000,Date.parse(header)-at));
        await website.defer(traffic.owner,traffic.lease,at+delay);
        throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT',{reason:'cooldown',retry_at:new Date(at+delay).toISOString(),retry_after_seconds:Math.ceil(delay/1000)});
      }
      const location = response?.headers?.get?.('Location');
      if (savedLogin && ([401, 403].includes(response?.status) || [301, 302, 303, 307, 308].includes(response?.status) &&
          typeof location === 'string' && (location === HOME || /^(?:https:\/\/marketapp\.org)?\/(?:\?|$|auth\/|login(?:\/|\?|$))/.test(location)))) fail('MARKETAPP_REFRESH_RECONNECT_REQUIRED');
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
    authorize(ctx);
    return await withStorageReservation(repository,{kind:'analytics_login',responseBytes:262144,checkpoint:false},token=>startAdmitted(ctx,input,token));
  }
  async function startAdmitted(ctx,input,storageToken) {
    const owner = authorize(ctx);
    if (!keys(input, ['period_days', 'remember_login']) || ![30, 365].includes(input.period_days) ||
        input.remember_login !== undefined && typeof input.remember_login !== 'boolean') fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const wallet = await savedWallet(), created = await now(), expires = created + cap.expiry_ms;
    const sessionFence = await fence(owner); await current(owner, wallet, sessionFence);
    const id = hash(`marketapp-analytics-refresh-v1\0${owner}\0${wallet}\0${created}\0${input.period_days}`);
    await reserve({id, owner, wallet, created, expires});
    let lease=null;
    try {
      lease=await acquireWebsite(owner,`${id}_prepare`);
      if (await now() - created >= cap.timeout_ms) fail();
      const response = await fetchBounded(HOME, 'GET', {Accept: 'text/html'}, undefined, expires, created,cap.response_bytes,false,{owner,lease,id:`${id}_home`,authentication:true});
      let challenge; try {challenge = parseMarketappChallenge(response.body);} catch {fail('MARKETAPP_REFRESH_PAGE_CHANGED');}
      const cookie = parseMarketappSessionCookieMetadata(response.cookie, response.observedAt);
      await current(owner, wallet, sessionFence);
      const envelope = await sessionBox.seal({version: 1, attempt_id: id, owner, wallet, period_days: input.period_days, created_at: created, expires_at: expires,
        cookie: cookie.cookie, cookie_expires_at: cookie.expires_at, challenge, remember_login: input.remember_login === true,
        session_generation: sessionFence.generation, wallet_revision: sessionFence.wallet_revision, session_version: sessionFence.cookie_version});
      if (typeof envelope !== 'string' || envelope.length > 16500 || !/^(?:[0-9a-f]{2})+$/.test(envelope) || !await repository.issueMarketappLoginAttempt(id, owner, wallet, hash(challenge), await now())) fail();
      const done = await now(); if (done < created || done - created >= cap.timeout_ms || done >= expires) fail();
      await recordOutcome(id, owner, input.period_days, 'awaiting_approval', 'prepare');
      const recorded = await now(); if (recorded < created || recorded - created >= cap.timeout_ms || recorded >= expires) fail();
      return {attempt_id: id, challenge, manifest_url: MARKETAPP_LOGIN_MANIFEST, expires_at: new Date(expires).toISOString(), wallet, domain: DOMAIN, period_days: input.period_days, session_envelope: envelope};
    } catch (error) {
      try {await repository.cancelMarketappLoginAttempt(id, owner);} catch {}
      await recordFailure(id, owner, input.period_days, 'prepare', error, {}, created);
      if (error instanceof MarketappRefreshRequestError||error?.code==='STORAGE_CAPACITY_PAUSED') throw error; fail();
    }finally{await releaseWebsite(owner,lease);}
  }
  async function remembered(owner, wallet) {
    try{return await website.read(owner,wallet);}catch(error){if(error instanceof MarketappWebsiteSessionError)fail('MARKETAPP_REFRESH_EXPIRED');throw error;}
  }
  async function rememberCookie(owner, wallet, sessionFence, cookie, created, expires, expectedVersion) {
    try{return await website.remember(owner,wallet,sessionFence,cookie,created,expires,expectedVersion);}catch(error){if(error instanceof MarketappWebsiteSessionError)fail('MARKETAPP_REFRESH_EXPIRED');throw error;}
  }
  async function refreshPage({id, owner, wallet, periodDays, cookieState, expires, began, sessionFence, stored = null, rememberLogin = false, work,lease,storageToken=null}) {
    await current(owner, wallet, sessionFence, stored?.cookie_version ?? null);
    const sourceUrl = marketappAnalyticsUrl(wallet, periodDays);
    work.stage = 'fetch_analytics';
    await recordOutcome(id, owner, periodDays, 'updating', work.stage, {authenticated: true});
    const page = await fetchBounded(sourceUrl, 'GET', {Accept: 'text/html', Cookie: cookieState.cookie}, undefined, expires, began, cap.response_bytes, Boolean(stored),{owner,lease,id:`${id}_analytics`,authentication:!stored});
    const rotation = parseMarketappSessionCookieMetadata(page.cookie, page.observedAt, false, true);
    if (rotation?.deleted) fail(stored ? 'MARKETAPP_REFRESH_RECONNECT_REQUIRED' : 'MARKETAPP_REFRESH_AUTH_REJECTED');
    work.stage = 'validate_analytics';
    await recordOutcome(id, owner, periodDays, 'updating', work.stage, {authenticated: true});
    let raw, snapshot;
    try {
      raw = JSON.stringify(extractMarketappAnalyticsPage(page.body, {wallet, periodDays, capturedAt: new Date(page.observedAt).toISOString(), sourceUrl}));
      snapshot = normalizePersonalAnalytics(raw, wallet);
      if (snapshot.daily.length !== periodDays) {work.diagnosticReason = 'period_span'; fail('MARKETAPP_REFRESH_PAGE_CHANGED');}
    } catch (error) {
      work.diagnosticReason = ['page_structure', 'wallet_identity', 'request_parameters', 'analytics_shape', 'period_span'].includes(error?.reason) ? error.reason : work.diagnosticReason || 'analytics_shape';
      if (stored && error?.authenticationInvalid === true) fail('MARKETAPP_REFRESH_RECONNECT_REQUIRED');
      fail('MARKETAPP_REFRESH_PAGE_CHANGED');
    }
    await current(owner, wallet, sessionFence, stored?.cookie_version ?? null);
    const done = await now();
    if (done < began || done - began >= 90000 || done >= expires) fail('MARKETAPP_REFRESH_EXPIRED');
    work.stage = 'save_snapshot'; work.snapshotFingerprint = snapshot.fingerprint;
    await recordOutcome(id, owner, periodDays, 'updating', work.stage, {authenticated: true, snapshotFingerprint: work.snapshotFingerprint});
    await current(owner, wallet, sessionFence, stored?.cookie_version ?? null);
    let cookieVersion = stored?.cookie_version ?? null;
    if (rememberLogin || stored && rotation) {
      const created = stored?.created_at ?? page.observedAt;
      const expiry = stored ? Math.min(stored.expires_at, rotation.expires_at ?? stored.expires_at)
        : Math.min(created + MARKETAPP_REMEMBERED_SESSION_MAX_MS, (rotation ?? cookieState).expires_at ?? created + MARKETAPP_REMEMBERED_SESSION_MAX_MS);
      if (expiry <= await now()) fail(stored ? 'MARKETAPP_REFRESH_RECONNECT_REQUIRED' : 'MARKETAPP_REFRESH_AUTH_REJECTED');
      cookieVersion = await rememberCookie(owner, wallet, sessionFence, (rotation ?? cookieState).cookie, created, expiry, stored?.cookie_version ?? sessionFence.cookie_version);
    }
    // This INSERT is atomically conditioned on logout generation and wallet
    // revision. Checking them in JavaScript alone leaves a host-call race.
    await current(owner, wallet, sessionFence, cookieVersion);
    const importing = await now();
    if (importing < began || importing - began >= 90000 || importing >= expires) fail('MARKETAPP_REFRESH_EXPIRED');
    if (!await repository.importPersonalAnalyticsFenced(snapshot, raw, new Date(importing).toISOString(), owner, sessionFence, cookieVersion,storageToken)) fail('MARKETAPP_REFRESH_EXPIRED');
    work.analyticsRefreshed = true;
    try {await recordOutcome(id, owner, periodDays, 'saved', 'complete', {authenticated: true, analyticsRefreshed: true, snapshotFingerprint: work.snapshotFingerprint});} catch {}
    return {attempt_id: id, authenticated: true, analytics_refreshed: true, snapshot};
  }
  async function finish(ctx, input = {}) {
    authorize(ctx);
    return await withStorageReservation(repository,{kind:'analytics_refresh',responseBytes:262144,checkpoint:false},token=>finishAdmitted(ctx,input,token));
  }
  async function finishAdmitted(ctx,input,storageToken) {
    const owner = authorize(ctx); finishShape(input);
    const wallet = await savedWallet(); let session;
    try {session = await sessionBox.open(input.session_envelope);} catch {fail('MARKETAPP_REFRESH_INVALID_INPUT');}
    if (!keys(session, ['version', 'attempt_id', 'owner', 'wallet', 'period_days', 'created_at', 'expires_at', 'cookie', 'cookie_expires_at', 'challenge', 'remember_login', 'session_generation', 'wallet_revision', 'session_version']) || session.version !== 1 || session.attempt_id !== input.attempt_id || session.owner !== owner || session.wallet !== wallet || ![30, 365].includes(session.period_days) || !Number.isSafeInteger(session.created_at) || !Number.isSafeInteger(session.expires_at) || session.expires_at - session.created_at <= 0 || session.expires_at - session.created_at > cap.expiry_ms || !ascii(session.challenge, 2048) || !ascii(session.cookie, 4104) || !/^session=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session.cookie) || session.attempt_id !== hash(`marketapp-analytics-refresh-v1\0${owner}\0${wallet}\0${session.created_at}\0${session.period_days}`) ||
        typeof session.remember_login !== 'boolean' || !['session_generation', 'wallet_revision', 'session_version'].every(key => Number.isSafeInteger(session[key]) && session[key] >= 0) ||
        !(session.cookie_expires_at === null || Number.isSafeInteger(session.cookie_expires_at) && session.cookie_expires_at > session.created_at)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const sessionFence = {generation: session.session_generation, wallet_revision: session.wallet_revision, cookie_version: session.session_version};
    await current(owner, wallet, sessionFence);
    const attempt = await repository.marketappLoginAttempt(input.attempt_id, owner), began = await now();
    if (!attempt || attempt.state !== 'issued' || attempt.wallet !== wallet || attempt.created_at !== session.created_at || attempt.expires_at !== session.expires_at || attempt.nonce_fingerprint !== hash(session.challenge) || began < attempt.created_at || began >= attempt.expires_at) fail('MARKETAPP_REFRESH_EXPIRED');
    let address = null; try {address = canonicalAddress(input.account.address);} catch {}
    const timestamp = input.proof.timestamp * 1000;
    if (address !== wallet || input.account.chain !== '-239' || input.proof.domain.value !== DOMAIN || input.proof.domain.lengthBytes !== 13 || input.proof.payload !== session.challenge || !Number.isSafeInteger(timestamp) || timestamp < attempt.created_at - cap.clock_skew_ms || timestamp > began + cap.clock_skew_ms || began - timestamp > cap.expiry_ms) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const work = {stage: 'authenticate', authenticated: false, analyticsRefreshed: false, diagnosticReason: null, snapshotFingerprint: null};
    const lease=await acquireWebsite(owner,`${input.attempt_id}_finish`);
    if (!await repository.consumeMarketappLoginAttempt(input.attempt_id, owner, wallet, began)) {await releaseWebsite(owner,lease);fail('MARKETAPP_REFRESH_EXPIRED');}
    try {
      await recordOutcome(input.attempt_id, owner, session.period_days, 'updating', work.stage);
      // At most one provider proof submission. Never retry after consumption.
      const auth = await fetchBounded(AUTH, 'POST', {Accept: 'application/json', 'Content-Type': 'application/json', Cookie: session.cookie,
        Origin: 'https://marketapp.org', Referer: HOME}, JSON.stringify({account: input.account, device: input.device, proof: input.proof, ref: null}), session.expires_at, began, 65536,false,{owner,lease,id:`${input.attempt_id}_auth`,authentication:true});
      let result; try {result = parseAuthResponse(auth.body);} catch {fail('MARKETAPP_REFRESH_AUTH_REJECTED');}
      if (!object(result) || result.verified !== true) fail('MARKETAPP_REFRESH_AUTH_REJECTED');
      work.authenticated = true;
      const cookieState = parseMarketappSessionCookieMetadata(auth.cookie, auth.observedAt, false) || {cookie: session.cookie, expires_at: session.cookie_expires_at, deleted: false};
      return await refreshPage({id: input.attempt_id, owner, wallet, periodDays: session.period_days, cookieState, expires: session.expires_at,
        began, sessionFence, rememberLogin: session.remember_login, work,lease,storageToken});
    } catch (error) {
      await recordFailure(input.attempt_id, owner, session.period_days, work.stage, error, work, began);
      if (error instanceof MarketappRefreshRequestError||error?.code==='STORAGE_CAPACITY_PAUSED') throw error; fail();
    }finally{await releaseWebsite(owner,lease);}
  }
  async function refreshRemembered(owner, wallet, stored, periodDays, created, lease) {
    return await withStorageReservation(repository,{kind:'analytics_refresh',responseBytes:262144,checkpoint:false},token=>refreshRememberedAdmitted(owner,wallet,stored,periodDays,created,lease,token));
  }
  async function refreshRememberedAdmitted(owner,wallet,stored,periodDays,created,lease,storageToken) {
    const expires = Math.min(created + cap.expiry_ms, stored.value.expires_at);
    const id = hash(`marketapp-remembered-refresh-v1\0${owner}\0${wallet}\0${created}\0${periodDays}\0${stored.value.cookie_version}`);
    const work = {stage: 'fetch_analytics', authenticated: true, analyticsRefreshed: false, diagnosticReason: null, snapshotFingerprint: null};
    try {
      await reserve({id, owner, wallet, created, expires});
      if (!await repository.issueMarketappLoginAttempt(id, owner, wallet, hash(`remembered:${stored.value.cookie_version}`), await now()) ||
          !await repository.consumeMarketappLoginAttempt(id, owner, wallet, await now())) fail('MARKETAPP_REFRESH_EXPIRED');
      return await refreshPage({id, owner, wallet, periodDays, cookieState: {cookie: stored.value.cookie, expires_at: stored.value.expires_at},
        expires, began: created, sessionFence: stored.fence, stored: stored.value, work,lease,storageToken});
    } catch (error) {
      if (error?.code === 'MARKETAPP_REFRESH_RECONNECT_REQUIRED') await repository.clearMarketappSession(owner, stored.fence, stored.value.cookie_version);
      await recordFailure(id, owner, periodDays, work.stage, error, work, created);
      if (error instanceof MarketappRefreshRequestError||error?.code==='STORAGE_CAPACITY_PAUSED') throw error; fail();
    }
  }
  async function refreshSaved(ctx, input = {}) {
    const owner = authorize(ctx);
    if (!keys(input, ['period_days']) || ![30, 365].includes(input.period_days)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const wallet = await savedWallet(), stored = await remembered(owner, wallet);
    if (!stored) fail('MARKETAPP_REFRESH_RECONNECT_REQUIRED');
    const created = await now();
    const id = hash(`marketapp-remembered-refresh-v1\0${owner}\0${wallet}\0${created}\0${input.period_days}\0${stored.value.cookie_version}`);
    const lease = await acquireWebsite(owner, `${id}_saved`);
    try {return await refreshRemembered(owner, wallet, stored, input.period_days, created, lease);}
    finally {await releaseWebsite(owner, lease);}
  }
  async function startupGuard(owner, wallet, periodDays, at) {
    const row = await repository.latestMarketappRefreshAttempt(owner, wallet, periodDays);
    let outcome = null;
    try {outcome = safeMarketappRefreshOutcome(JSON.parse(row?.outcome_json));} catch {}
    const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value ? Date.parse(value) : null;
    const captured = instant(row?.snapshot_captured_at), saved = instant(row?.saved_at), observed = instant(outcome?.observed_at);
    // Only the exact validated provider snapshot linked to this audited
    // refresh qualifies as fresh. A browser import or optimistic status does
    // not. Recover the already-committed snapshot/final-audit crash gap too.
    if (row?.state === 'consumed' && Number.isSafeInteger(row.created_at) && row.created_at > 0 &&
        outcome?.period_days === periodDays && outcome.snapshot_fingerprint && ['save_snapshot', 'complete'].includes(outcome.stage) &&
        ['updating', 'saved'].includes(outcome.state) && captured !== null && saved !== null && observed !== null &&
        row.created_at <= captured && captured <= saved && saved <= at && observed <= at &&
        (outcome.state === 'saved' ? saved <= observed : observed <= saved) &&
        captured <= at && at - captured < MARKETAPP_STARTUP_ANALYTICS_INTERVAL_MS)
      return {state: 'fresh', period_days: periodDays, captured_at: row.snapshot_captured_at};
    const pending = await repository.pendingMarketappRefreshAttempt(owner, wallet, at);
    if (pending && Number.isSafeInteger(pending.expires_at) && pending.expires_at > at)
      return {state: 'busy', period_days: periodDays, reason: 'active_refresh', retry_at: new Date(pending.expires_at).toISOString()};
    // Failed refreshes and repeated reopens receive the same durable backoff.
    // Manual refresh remains subject only to its original rate limits.
    if (Number.isSafeInteger(row?.created_at) && row.created_at <= at && at - row.created_at < MARKETAPP_STARTUP_ANALYTICS_INTERVAL_MS)
      return {state: 'limited', period_days: periodDays, reason: 'cooldown', retry_at: new Date(row.created_at + MARKETAPP_STARTUP_ANALYTICS_INTERVAL_MS).toISOString()};
    const retry = await repository.marketappLoginRetry(owner, at, cap);
    if (retry) return {state: 'limited', period_days: periodDays, reason: retry.reason === 'hourly' ? 'request_limit' : 'cooldown', retry_at: retry.retry_at};
    return null;
  }
  async function refreshStartup(ctx, input = {}) {
    const owner = authorize(ctx);
    if (!keys(input, ['period_days']) || ![30, 365].includes(input.period_days)) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const periodDays = input.period_days;
    const unavailable = reason => ({state: 'unavailable', period_days: periodDays, reason});
    const wallet = configuredAnalyticsWallet(await walletRecords());
    if (!wallet) return unavailable('wallet_missing');
    let stored = await remembered(owner, wallet);
    if (!stored) return unavailable('no_login');
    let at = await now(), skip = await startupGuard(owner, wallet, periodDays, at);
    if (skip) return skip;
    // Production must have the durable cross-instance website lease. An old
    // recovery adapter cannot silently substitute an in-memory startup lock.
    if (typeof repository.acquireMarketappWebsiteLease !== 'function') return unavailable('refresh_failed');
    const id = hash(`marketapp-startup-analytics-v1\0${owner}\0${wallet}\0${at}\0${periodDays}`);
    const lease = await website.acquire(owner, `${id}_startup`);
    if (!lease) return {state: 'busy', period_days: periodDays, reason: 'website_busy'};
    try {
      // Another open may have saved/rotated/disconnected while this call was
      // acquiring its lease. Check both durable state and cookie fences again.
      stored = await remembered(owner, wallet);
      if (!stored) return unavailable('no_login');
      at = await now(); skip = await startupGuard(owner, wallet, periodDays, at);
      if (skip) return skip;
      const result = await refreshRemembered(owner, wallet, stored, periodDays, at, lease);
      return {state: 'saved', period_days: periodDays, captured_at: result.snapshot.captured_at};
    } catch (error) {
      if (error?.code === 'MARKETAPP_REFRESH_RECONNECT_REQUIRED' || error?.code === 'MARKETAPP_REFRESH_EXPIRED') return unavailable('no_login');
      if (error?.code === 'MARKETAPP_REFRESH_RATE_LIMIT') return {state: 'limited', period_days: periodDays,
        reason: error.retry?.reason === 'hourly' ? 'request_limit' : 'cooldown', ...(error.retry ? {retry_at: error.retry.retry_at} : {})};
      return unavailable('refresh_failed');
    } finally {await releaseWebsite(owner, lease);}
  }
  async function disconnect(ctx, input = {}) {
    const owner = authorize(ctx); if (!keys(input, [])) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    if (!await repository.clearMarketappSession(owner)) fail();
    return {disconnected: true};
  }
  async function sessionStatus(ctx, input = {}) {
    const owner = authorize(ctx); if (!keys(input, [])) fail('MARKETAPP_REFRESH_INVALID_INPUT');
    const wallet = configuredAnalyticsWallet(await walletRecords());
    const stored = await remembered(owner, wallet);
    return {remembered: Boolean(stored), expires_at: stored ? new Date(stored.value.expires_at).toISOString() : null};
  }
  async function cancel(ctx, input = {}) {const owner = authorize(ctx); if (!keys(input, ['attempt_id'])) fail('MARKETAPP_REFRESH_INVALID_INPUT'); const id = identifier(input); await repository.cancelMarketappLoginAttempt(id, owner); return {cancelled: true};}
  return {startMarketappAnalyticsRefresh: start, finishMarketappAnalyticsRefresh: finish, cancelMarketappAnalyticsRefresh: cancel,
    refreshSavedMarketappAnalytics: refreshSaved, refreshStartupMarketappAnalytics: refreshStartup,
    disconnectMarketappAnalyticsSession: disconnect, getMarketappAnalyticsSessionStatus: sessionStatus};
}
