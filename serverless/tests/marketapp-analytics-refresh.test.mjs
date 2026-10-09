import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createMarketappLoginEngine} from '../tgcloud/lib/marketapp-login.js';
import {createMarketappSessionBox} from '../tgcloud/lib/marketapp-session-box.js';
import {createMarketappAnalyticsRefreshEngine, MarketappRefreshRequestError, marketappRefreshErrorResponse, parseMarketappSessionCookie, marketappAnalyticsUrl} from '../tgcloud/lib/marketapp-analytics-refresh.js';
import {syntheticAnalyticsPage, syntheticWallet as wallet, syntheticFriendly} from './fixtures/marketapp-analytics-page-fixture.mjs';

const ctx = {initData: {user: {id: 12345}}};
const challenge = 'synthetic-public-refresh-challenge';
const anonymousCookie = 'session=synthetic-anonymous-session';
const authenticatedCookie = 'session=synthetic-authenticated-session';
const anon = `<html><script>Wallet.init(${JSON.stringify({address: false, ton_proof: challenge, version: 2})});</script></html>`;
const AUTH = 'https://marketapp.org/auth/checkTonProofAuth/';
function response(url, text, headers = {}, options = {}) {
  const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {status: 200, url, body: {async *[Symbol.asyncIterator]() {yield Buffer.from(text);}}, ...options,
    headers: {get: key => values[key.toLowerCase()] ?? null}};
}
function setup({fetch: supplied, records = [{kind: 'settings', record: {wallet}}], sessionBox: suppliedBox} = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE marketapp_login_attempts(attempt_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,wallet TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,nonce_fingerprint TEXT,outcome_json TEXT);
    CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT PRIMARY KEY,wallet TEXT NOT NULL,captured_at TEXT NOT NULL,imported_at TEXT NOT NULL,raw_snapshot TEXT NOT NULL,normalized_json TEXT NOT NULL);`);
  const state = {version: 2, next_job_id: 3, job: null, attempts: [123], next_allowed_at: 999};
  database.prepare('INSERT INTO cloud_events VALUES(1,?,?,?,?,?,?,?)').run('seed', JSON.stringify(state), null, null, JSON.stringify(records), null, '2026-10-09T12:00:00Z');
  database.prepare('INSERT INTO personal_rental_analytics VALUES(?,?,?,?,?,?)').run('old-snapshot', wallet, '2026-10-08', '2026-10-08', 'synthetic saved snapshot', '{}');
  const db = {async get(sql, params = {}) {return database.prepare(sql).get(params) || null;},
    async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};},
    async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db), requests = [], box = suppliedBox || createMarketappSessionBox('11'.repeat(32));
  let at = Date.parse('2026-10-09T12:00:00Z');
  const request = async (url, options) => {
    requests.push({url, options});
    if (supplied) return supplied(url, options, {now: () => at, advance: ms => {at += ms;}});
    if (url === 'https://marketapp.org/' && options.method === 'GET') return response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie + '; Path=/; Secure; HttpOnly; SameSite=Lax'});
    if (url === AUTH && options.method === 'POST') return response(url, '{"verified":true}', {'Content-Type': 'application/json', 'Set-Cookie': authenticatedCookie + '; Path=/; Secure; HttpOnly'});
    if (options.method === 'GET' && [30, 365].some(days => url === marketappAnalyticsUrl(wallet, days))) {
      const days = url.includes('last365days') ? 365 : 30;
      return response(url, syntheticAnalyticsPage({periodDays: days, capturedAt: new Date(at).toISOString(), lastDate: new Date(at).toISOString().slice(0, 10)}).html, {'Content-Type': 'text/html'});
    }
    throw new Error('Unexpected mock route');
  };
  const engine = createMarketappAnalyticsRefreshEngine({repository, fetch: request, ownerTelegramId: 12345, clock: async () => at, sessionBox: box});
  return {database, repository, requests, engine, request, box, now: () => at, advance: ms => {at += ms;}};
}
function submission(start, at) {
  return {attempt_id: start.attempt_id, session_envelope: start.session_envelope,
    account: {address: syntheticFriendly(wallet), chain: '-239', walletStateInit: 'te6ccgEBAQEAAgAAAA==', publicKey: '11'.repeat(32)},
    device: {platform: 'android', appName: 'synthetic_wallet', appVersion: '1.2.3', maxProtocolVersion: 2,
      features: ['SendTransaction', {name: 'SendTransaction', maxMessages: 4, extraCurrencySupported: true, itemTypes: ['ton']}, {name: 'SignMessage', maxMessages: 4}, {name: 'SignData', types: ['text', 'binary', 'cell']}, {name: 'EmbeddedRequest'}]},
    proof: {timestamp: Math.floor(at / 1000), domain: {value: 'marketapp.org', lengthBytes: 13}, payload: start.challenge, signature: Buffer.alloc(64, 1).toString('base64')}};
}
const assertCode = (promise, code) => assert.rejects(promise, error => {
  const response = marketappRefreshErrorResponse(error);
  if (code === 'MARKETAPP_REFRESH_RATE_LIMIT') assert.equal(response.error.code, code);
  else assert.deepEqual(response, {error: {code}});
  return true;
});
const audit = t => JSON.parse(t.database.prepare('SELECT outcome_json FROM marketapp_login_attempts ORDER BY created_at DESC LIMIT 1').get().outcome_json);

test('rate limits project exact database-clock cooldown and hourly deadlines without provider requests', async () => {
  const t = setup(), began = t.now();
  const first = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days:30});
  await t.engine.cancelMarketappAnalyticsRefresh(ctx, {attempt_id:first.attempt_id});
  await assert.rejects(t.engine.startMarketappAnalyticsRefresh(ctx,{period_days:30}), error => {
    assert.deepEqual(marketappRefreshErrorResponse(error),{error:{code:'MARKETAPP_REFRESH_RATE_LIMIT',retry_at:new Date(began+60000).toISOString(),retry_after_seconds:60,reason:'cooldown'}});return true;
  });
  assert.equal(t.requests.length,1);
  for(let index=1;index<5;index++){t.advance(60000);await t.engine.startMarketappAnalyticsRefresh(ctx,{period_days:30});}
  await assert.rejects(t.engine.startMarketappAnalyticsRefresh(ctx,{period_days:30}),error=>{
    assert.deepEqual(marketappRefreshErrorResponse(error),{error:{code:'MARKETAPP_REFRESH_RATE_LIMIT',retry_at:new Date(began+3600000).toISOString(),retry_after_seconds:3360,reason:'hourly'}});return true;
  });
  assert.equal(t.requests.length,5);
  t.advance(3360000);assert.equal(await t.repository.marketappLoginRetry('12345',t.now(),{cooldown_ms:60000,hourly_attempts:5}),null);
  await t.engine.startMarketappAnalyticsRefresh(ctx,{period_days:30});assert.equal(t.requests.length,6);
  t.database.close();
});

test('rate-limit retry metadata is narrowly redacted and ignored for other failures',()=>{
  const valid={retry_at:'2026-10-09T12:01:00.000Z',retry_after_seconds:60,reason:'cooldown',cookie:'synthetic-private-cookie'};
  assert.deepEqual(marketappRefreshErrorResponse(new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT',valid)),{error:{code:'MARKETAPP_REFRESH_RATE_LIMIT',retry_at:valid.retry_at,retry_after_seconds:60,reason:'cooldown'}});
  for(const retry of [null,{...valid,retry_after_seconds:0},{...valid,retry_after_seconds:86401},{...valid,retry_after_seconds:'60'},{...valid,reason:'synthetic-private-message'},{...valid,retry_at:'invalid-private-date'}])assert.deepEqual(marketappRefreshErrorResponse(new MarketappRefreshRequestError('MARKETAPP_REFRESH_RATE_LIMIT',retry)),{error:{code:'MARKETAPP_REFRESH_RATE_LIMIT'}});
  assert.deepEqual(marketappRefreshErrorResponse(new MarketappRefreshRequestError('MARKETAPP_REFRESH_FAILED',valid)),{error:{code:'MARKETAPP_REFRESH_FAILED'}});
});

test('all refresh operations authorize before database, clock, decryption or provider access', async () => {
  let accesses = 0;
  const engine = createMarketappAnalyticsRefreshEngine({ownerTelegramId: 12345, repository: new Proxy({}, {get() {accesses++; return async () => {};}}),
    clock: async () => {accesses++;}, fetch: async () => {accesses++;}, sessionBox: {seal() {accesses++;}, open() {accesses++;}}});
  for (const name of ['startMarketappAnalyticsRefresh', 'finishMarketappAnalyticsRefresh', 'cancelMarketappAnalyticsRefresh']) {
    for (const unauthorized of [{}, {initData: {user: {id: 67890}}}]) await assertCode(engine[name](unauthorized, {}), 'MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED');
  }
  assert.equal(accesses, 0);
});

test('start binds an encrypted short-lived cookie to the owner, wallet, exact period and independent ID', async () => {
  const t = setup(), before = await t.repository.read(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 365});
  assert.equal(start.period_days, 365); assert.equal(start.wallet, wallet); assert.equal(start.domain, 'marketapp.org');
  assert.equal(start.challenge, challenge); assert.match(start.session_envelope, /^[0-9a-f]+$/); assert.ok(start.session_envelope.length <= 16500);
  assert.equal(Date.parse(start.expires_at) - t.now(), 300000);
  const opened = t.box.open(start.session_envelope);
  assert.deepEqual(opened, {version: 1, attempt_id: start.attempt_id, owner: '12345', wallet, period_days: 365, created_at: t.now(), expires_at: t.now() + 300000, cookie: anonymousCookie, challenge});
  const row = t.database.prepare('SELECT * FROM marketapp_login_attempts').get();
  assert.equal(row.state, 'issued');
  assert.deepEqual(audit(t), {version: 1, flow: 'analytics_refresh', state: 'awaiting_approval', stage: 'prepare', code: null,
    observed_at: new Date(t.now()).toISOString(), period_days: 365, authenticated: false, analytics_refreshed: false});
  assert.ok(!JSON.stringify(row).includes(anonymousCookie) && !JSON.stringify(row).includes(challenge) && !JSON.stringify(row).includes(start.session_envelope));
  assert.equal(t.requests.length, 1); assert.deepEqual(t.requests[0].options.headers, {Accept: 'text/html'});
  assert.equal(t.requests[0].options.redirect, 'manual'); assert.deepEqual(await t.repository.read(), before); t.database.close();
});

test('a verified proof performs exactly three fixed requests then saves immutable personal analytics for30or365days', async () => {
  for (const days of [30, 365]) {
    const t = setup(), before = await t.repository.read(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: days}), input = submission(start, t.now());
    const result = await t.engine.finishMarketappAnalyticsRefresh(ctx, input);
    assert.equal(result.authenticated, true); assert.equal(result.analytics_refreshed, true); assert.equal(result.snapshot.daily.length, days);
    assert.equal(result.snapshot.wallet, wallet); assert.equal(result.snapshot.currency, 'GRAM'); assert.equal(result.snapshot.summary.rent_volume, '3');
    assert.equal(result.snapshot.summary.rentals, 4); assert.match(result.snapshot.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(t.requests.map(row => [row.options.method, row.url]), [['GET', 'https://marketapp.org/'], ['POST', AUTH], ['GET', marketappAnalyticsUrl(wallet, days)]]);
    for (const row of t.requests) {assert.equal(row.options.redirect, 'manual'); assert.equal(row.options.timeout, 30000); assert.ok(!Object.hasOwn(row.options.headers, 'Authorization'));}
    assert.equal(t.requests[1].options.headers.Cookie, anonymousCookie); assert.equal(t.requests[2].options.headers.Cookie, authenticatedCookie);
    assert.equal(t.requests[1].options.headers.Origin, 'https://marketapp.org'); assert.equal(t.requests[1].options.headers.Referer, 'https://marketapp.org/');
    assert.deepEqual(JSON.parse(t.requests[1].options.body), {account: input.account, device: input.device, proof: input.proof, ref: null});
    const rows = t.database.prepare('SELECT * FROM personal_rental_analytics').all(); assert.equal(rows.length, 2);
    const persisted = JSON.stringify(rows) + JSON.stringify(t.database.prepare('SELECT * FROM marketapp_login_attempts').all());
    for (const privateValue of [challenge, anonymousCookie, authenticatedCookie, input.proof.signature, input.account.walletStateInit, 'synthetic-discarded-nonce', '<html>']) assert.ok(!persisted.includes(privateValue));
    assert.deepEqual(await t.repository.read(), before); assert.equal(t.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'consumed');
    const savedAudit = audit(t);
    assert.deepEqual(savedAudit, {version: 1, flow: 'analytics_refresh', state: 'saved', stage: 'complete', code: null,
      observed_at: new Date(t.now()).toISOString(), period_days: days, authenticated: true, analytics_refreshed: true,
      snapshot_fingerprint: result.snapshot.fingerprint});
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, input), 'MARKETAPP_REFRESH_EXPIRED'); assert.equal(t.requests.length, 3);
    assert.deepEqual(audit(t), savedAudit);
    const newRow = rows.find(row => row.fingerprint === result.snapshot.fingerprint);
    assert.equal(await t.repository.importPersonalAnalytics(result.snapshot, newRow.raw_snapshot, newRow.imported_at), false);
    assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 2); t.database.close();
  }
});

test('server-derived profile URLs canonicalize aliases and never accept arbitrary provider destinations', () => {
  const expected = `https://marketapp.org/user/${syntheticFriendly(wallet)}/?tab=analytics_rent&period_by=last30days&group_by=day`;
  assert.equal(marketappAnalyticsUrl(wallet, 30), expected);
  assert.equal(marketappAnalyticsUrl(syntheticFriendly(wallet, 0x51), 30), expected);
  assert.throws(() => marketappAnalyticsUrl(wallet, 90)); assert.throws(() => marketappAnalyticsUrl('https://evil.example/', 30));
});

test('session cookies reject extra names, ambiguous count, wrong scope, controls and malformed expiry', () => {
  const at = Date.parse('2026-10-09T12:00:00Z');
  for (const header of [anonymousCookie, anonymousCookie + '; Path=/; Secure; HttpOnly; SameSite=None', anonymousCookie + '; Domain=.marketapp.org; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Max-Age=300']) assert.equal(parseMarketappSessionCookie(header, at), anonymousCookie);
  assert.equal(parseMarketappSessionCookie(null, at, false), null);
  for (const header of [null, 'other=synthetic', anonymousCookie + ', session=second', anonymousCookie + '; session=second', anonymousCookie + '; Path=/auth/',
    anonymousCookie + '; Domain=evil.example', anonymousCookie + '\r\nInjected: x', anonymousCookie + '; Path=/; path=/', anonymousCookie + '; Secure=yes',
    anonymousCookie + '; Expires=invalid', anonymousCookie + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT', anonymousCookie + '; Max-Age=0', anonymousCookie + '; Unknown=flag',
    'session=' + 'x'.repeat(4097), 'session="quoted"']) assert.throws(() => parseMarketappSessionCookie(header, at));
});

test('envelope tampering and owner/wallet/period/attempt boundary mismatches cannot reach authentication', async () => {
  const mutations = [session => {session.owner = '67890';}, session => {session.wallet = `0:${'22'.repeat(32)}`;},
    session => {session.period_days = 90;}, session => {session.period_days = 365;}, session => {session.attempt_id = '22'.repeat(32);},
    session => {session.expires_at++;}, session => {session.created_at++;}, session => {session.challenge = 'different-challenge';},
    session => {session.cookie = 'session=x; another=y';}, session => {session.secret = 'synthetic private extra';}];
  for (const mutate of mutations) {
    const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), input = submission(start, t.now());
    const session = t.box.open(start.session_envelope); mutate(session); input.session_envelope = t.box.seal(session);
    await assert.rejects(t.engine.finishMarketappAnalyticsRefresh(ctx, input)); assert.equal(t.requests.length, 1);
    assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
  }
  const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), input = submission(start, t.now());
  input.session_envelope = start.session_envelope.slice(0, -2) + (start.session_envelope.endsWith('00') ? '01' : '00');
  await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, input), 'MARKETAPP_REFRESH_INVALID_INPUT'); assert.equal(t.requests.length, 1); t.database.close();
});

test('proof, account and device validations occur before any provider proof POST', async () => {
  const mutations = [input => {input.account.address = `0:${'22'.repeat(32)}`;}, input => {input.account.chain = '-3';}, input => {delete input.account.publicKey;},
    input => {input.account.walletStateInit = 'x'.repeat(16385);}, input => {input.device.appName = 'bad\nname';}, input => {input.device.features.push({name: 'Unknown', secret: 'synthetic secret'});},
    input => {input.proof.domain.value = 'other.marketapp.org';}, input => {input.proof.domain.lengthBytes = 12;}, input => {input.proof.payload = 'different challenge';},
    input => {input.proof.timestamp -= 60;}, input => {input.proof.timestamp += 60;}, input => {input.proof.signature = 'invalid';}, input => {input.cookie = 'synthetic cookie';}];
  for (const mutate of mutations) {
    const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), input = submission(start, t.now()); mutate(input);
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, input), 'MARKETAPP_REFRESH_INVALID_INPUT');
    assert.equal(t.requests.length, 1); assert.equal(t.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'issued'); t.database.close();
  }
});

test('provider rejection, malformed verification and failed POST never retry or replace a saved snapshot', async () => {
  for (const auth of ['{"verified":false,"detail":"synthetic private error"}', '{"verified":"true"}', '{"verified":false,"verified":true}', '{"verified":false,"\\u0076erified":true}', '{"verified":true,"nested":{"key":1,"\\u006bey":2}}', '{"verified":true,"count":01}', '{"verified":true,"count":1e999}', 'malformed', null]) {
    const t = setup({fetch: async (url, options) => {
      if (url === 'https://marketapp.org/') return response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie});
      assert.equal(url, AUTH); assert.equal(options.method, 'POST');
      if (auth === null) throw new Error('synthetic private provider credential');
      return response(url, auth, {'Content-Type': 'application/json'});
    }}), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), input = submission(start, t.now());
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, input), auth === null ? 'MARKETAPP_REFRESH_FAILED' : 'MARKETAPP_REFRESH_AUTH_REJECTED');
    const failed = audit(t);
    assert.equal(failed.state, 'failed'); assert.equal(failed.stage, 'authenticate'); assert.equal(failed.authenticated, false); assert.equal(failed.analytics_refreshed, false);
    assert.equal(failed.code, auth === null ? 'MARKETAPP_REFRESH_FAILED' : 'MARKETAPP_REFRESH_AUTH_REJECTED');
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, input), 'MARKETAPP_REFRESH_EXPIRED');
    assert.deepEqual(audit(t), failed); assert.ok(!JSON.stringify(failed).includes('synthetic private'));
    assert.equal(t.requests.length, 2); assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
  }
});

test('unexpected redirects, cookie rotations and wrong-wallet/period pages cannot import analytics', async () => {
  for (const mode of ['auth_redirect', 'auth_wrong_url', 'auth_cookie_scope', 'page_redirect', 'page_cookie_scope', 'wrong_wallet', 'wrong_period', 'missing_analytics']) {
    const t = setup({fetch: async (url, options) => {
      if (url === 'https://marketapp.org/') return response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie});
      if (url === AUTH) return response(mode === 'auth_wrong_url' ? 'https://evil.example/' : url, '{"verified":true}', {'Content-Type': 'application/json', ...(mode === 'auth_cookie_scope' ? {'Set-Cookie': 'session=rotated; Domain=evil.example'} : {}), ...(mode === 'auth_redirect' ? {Location: 'https://evil.example/'} : {})}, mode === 'auth_redirect' ? {status: 307} : {});
      const page = mode === 'missing_analytics' ? '<html>No analytics</html>' : syntheticAnalyticsPage({identity: mode === 'wrong_wallet' ? `0:${'22'.repeat(32)}` : wallet, periodDays: mode === 'wrong_period' ? 365 : 30}).html;
      return response(url, page, {'Content-Type': 'text/html', ...(mode === 'page_cookie_scope' ? {'Set-Cookie': 'session=rotated; Path=/unrelated'} : {})}, mode === 'page_redirect' ? {status: 302} : {});
    }}), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30});
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), ['wrong_wallet', 'wrong_period', 'missing_analytics'].includes(mode) ? 'MARKETAPP_REFRESH_PAGE_CHANGED' : 'MARKETAPP_REFRESH_FAILED');
    assert.equal(t.requests.length, mode.startsWith('auth_') ? 2 : 3);
    assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
  }
});

test('refresh starts share cooldown and rolling allowance with proof-only tests, cancellation cannot reset it', async () => {
  const t = setup(), proof = createMarketappLoginEngine({repository: t.repository, fetch: t.request, ownerTelegramId: 12345, clock: async () => t.now()});
  const start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30});
  await t.engine.cancelMarketappAnalyticsRefresh(ctx, {attempt_id: start.attempt_id});
  await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 365}), 'MARKETAPP_REFRESH_RATE_LIMIT');
  await assert.rejects(proof.startMarketappLoginTest(ctx), error => error.code === 'MARKETAPP_LOGIN_RATE_LIMIT');
  await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_EXPIRED');
  for (let i = 1; i < 5; i++) {t.advance(60000); await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30});}
  t.advance(60000); await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RATE_LIMIT');
  assert.equal(t.requests.length, 5); t.database.close();
});

test('atomic finish consumption allows only one authentication POST under concurrency', async () => {
  const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), input = submission(start, t.now());
  const results = await Promise.allSettled([t.engine.finishMarketappAnalyticsRefresh(ctx, input), t.engine.finishMarketappAnalyticsRefresh(ctx, input)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(t.requests.filter(row => row.options.method === 'POST').length, 1);
  assert.equal(t.requests.length, 3); assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 2); t.database.close();
});

test('trusted deadlines reject expired attempts and slow reservation/provider work without further requests', async () => {
  const expired = setup(), start = await expired.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}); expired.advance(300000);
  await assertCode(expired.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, expired.now())), 'MARKETAPP_REFRESH_EXPIRED'); assert.equal(expired.requests.length, 1); expired.database.close();
  const reserved = setup(), reserve = reserved.repository.reserveMarketappLoginAttempt;
  reserved.repository.reserveMarketappLoginAttempt = async (...args) => {const result = await reserve(...args); reserved.advance(30000); return result;};
  await assertCode(reserved.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_FAILED'); assert.equal(reserved.requests.length, 0); reserved.database.close();
  const slow = setup({fetch: async (url, options, time) => {
    if (url === 'https://marketapp.org/') return response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie});
    time.advance(30000); return response(url, '{"verified":true}', {'Content-Type': 'application/json'});
  }}), pending = await slow.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30});
  await assertCode(slow.engine.finishMarketappAnalyticsRefresh(ctx, submission(pending, slow.now())), 'MARKETAPP_REFRESH_FAILED');
  assert.equal(slow.requests.length, 2); assert.equal(slow.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); slow.database.close();
});

test('missing cookie, excessive bodies and invalid session envelopes fail safely without credential leakage', async () => {
  for (const mode of ['missing_cookie', 'multiple_cookies', 'oversized_home', 'oversized_auth']) {
    const t = setup({fetch: async url => {
      if (url === 'https://marketapp.org/') return response(url, mode === 'oversized_home' ? 'x'.repeat(1048577) : anon, {'Content-Type': 'text/html', ...(mode === 'missing_cookie' ? {} : {'Set-Cookie': mode === 'multiple_cookies' ? anonymousCookie + ', session=second' : anonymousCookie})});
      return response(url, 'x'.repeat(65537), {'Content-Type': 'application/json'});
    }});
    if (mode === 'oversized_auth') {const start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}); await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_FAILED'); assert.equal(t.requests.length, 2);}
    else {await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_FAILED'); assert.equal(t.requests.length, 1);}
    assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
  }
  assert.deepEqual(marketappRefreshErrorResponse(new Error('synthetic-private-session')), {error: {code: 'MARKETAPP_REFRESH_FAILED'}});
  const t = setup(); await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 90, url: 'https://evil.example/'}), 'MARKETAPP_REFRESH_INVALID_INPUT'); assert.equal(t.requests.length, 0); t.database.close();
});

test('start failures retain only fixed preparation diagnostics and never invent authentication', async () => {
  const t = setup({fetch: async url => response(url, '<html>synthetic private page without challenge</html>', {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie})});
  await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_PAGE_CHANGED');
  assert.equal(t.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'cancelled');
  assert.deepEqual(audit(t), {version: 1, flow: 'analytics_refresh', state: 'failed', stage: 'prepare', code: 'MARKETAPP_REFRESH_PAGE_CHANGED',
    observed_at: new Date(t.now()).toISOString(), period_days: 30, authenticated: false, analytics_refreshed: false});
  assert.equal(t.requests.length, 1); t.database.close();
});

test('page incompatibility retains provider-authenticated state and a fixed parser reason without financial or private data', async () => {
  const t = setup({fetch: async url => {
    if (url === 'https://marketapp.org/') return response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie});
    if (url === AUTH) return response(url, '{"verified":true}', {'Content-Type': 'application/json', 'Set-Cookie': authenticatedCookie});
    return response(url, '<html>synthetic private analytics schema has changed</html>', {'Content-Type': 'text/html'});
  }}), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 365});
  await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_PAGE_CHANGED');
  const failed = audit(t);
  assert.equal(failed.state, 'failed'); assert.equal(failed.stage, 'validate_analytics'); assert.equal(failed.code, 'MARKETAPP_REFRESH_PAGE_CHANGED');
  assert.equal(failed.authenticated, true); assert.equal(failed.analytics_refreshed, false); assert.equal(failed.period_days, 365);
  assert.ok(['page_structure', 'wallet_identity', 'request_parameters', 'analytics_shape', 'period_span'].includes(failed.diagnostic_reason));
  for (const secret of [challenge, anonymousCookie, authenticatedCookie, '<html>', 'synthetic private', wallet, 'rent_volume']) assert.ok(!JSON.stringify(failed).includes(secret));
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
});

test('a duplicate finish cannot poison the active worker or overwrite its eventual saved outcome', async () => {
  let release, reached;
  const paused = new Promise(resolve => {release = resolve;}), posted = new Promise(resolve => {reached = resolve;});
  const t = setup({fetch: async url => {
    if (url === 'https://marketapp.org/') return response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie});
    if (url === AUTH) {reached(); await paused; return response(url, '{"verified":true}', {'Content-Type': 'application/json'});}
    return response(url, syntheticAnalyticsPage().html, {'Content-Type': 'text/html'});
  }}), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), input = submission(start, t.now());
  const genuine = t.engine.finishMarketappAnalyticsRefresh(ctx, input);
  await posted;
  try {
    const activeAudit = audit(t); assert.equal(activeAudit.state, 'updating'); assert.equal(activeAudit.stage, 'authenticate');
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, input), 'MARKETAPP_REFRESH_EXPIRED');
    assert.deepEqual(audit(t), activeAudit);
    const invalid = {...input, proof: {...input.proof, payload: 'synthetic invalid payload'}};
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, invalid), 'MARKETAPP_REFRESH_INVALID_INPUT');
    assert.deepEqual(audit(t), activeAudit);
  } finally {release();}
  const result = await genuine;
  assert.equal(result.analytics_refreshed, true); assert.equal(audit(t).state, 'saved');
  assert.equal(t.requests.filter(row => row.options.method === 'POST').length, 1); t.database.close();
});

test('progress audit must commit before provider stages or import may proceed', async () => {
  for (const deniedStage of ['authenticate', 'fetch_analytics', 'validate_analytics', 'save_snapshot']) {
    const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), record = t.repository.recordMarketappRefreshOutcome;
    t.repository.recordMarketappRefreshOutcome = async (...args) => args[2].state === 'updating' && args[2].stage === deniedStage ? false : record(...args);
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_FAILED');
    const failed = audit(t); assert.equal(failed.state, 'failed'); assert.equal(failed.stage, deniedStage);
    assert.equal(failed.authenticated, deniedStage !== 'authenticate'); assert.equal(failed.analytics_refreshed, false);
    assert.equal(t.requests.length, deniedStage === 'authenticate' ? 1 : deniedStage === 'fetch_analytics' ? 2 : 3);
    assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
  }
});

test('a failed final audit cannot turn an already committed snapshot into a failed refresh', async () => {
  const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), record = t.repository.recordMarketappRefreshOutcome;
  t.repository.recordMarketappRefreshOutcome = async (...args) => args[2].state === 'saved' ? false : record(...args);
  const result = await t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now()));
  assert.equal(result.authenticated, true); assert.equal(result.analytics_refreshed, true);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 2);
  const pendingAudit = audit(t); assert.equal(pendingAudit.state, 'updating'); assert.equal(pendingAudit.stage, 'save_snapshot');
  assert.equal(pendingAudit.snapshot_fingerprint, result.snapshot.fingerprint);
  await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_EXPIRED');
  assert.deepEqual(audit(t), pendingAudit); t.database.close();
});

test('deadline and wallet fences remain effective after a slow pre-import diagnostic write', async () => {
  for (const mode of ['deadline', 'wallet']) {
    const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), record = t.repository.recordMarketappRefreshOutcome;
    t.repository.recordMarketappRefreshOutcome = async (...args) => {
      const result = await record(...args);
      if (args[2].state === 'updating' && args[2].stage === 'save_snapshot') {
        if (mode === 'deadline') t.advance(90000);
        else t.repository.records = async () => [{kind: 'settings', record: {wallet: `0:${'22'.repeat(32)}`}}];
      }
      return result;
    };
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_EXPIRED');
    const failed = audit(t); assert.equal(failed.state, 'failed'); assert.equal(failed.stage, 'save_snapshot'); assert.equal(failed.analytics_refreshed, false);
    assert.match(failed.snapshot_fingerprint, /^[0-9a-f]{64}$/); assert.equal(t.requests.length, 3);
    assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
  }
});

test('snapshot storage failures retain bounded diagnostics without database error text', async () => {
  const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30});
  t.repository.importPersonalAnalytics = async () => {throw new Error('synthetic private database credential with 999 rent_volume');};
  await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_FAILED');
  const failed = audit(t); assert.equal(failed.state, 'failed'); assert.equal(failed.stage, 'save_snapshot'); assert.equal(failed.authenticated, true); assert.equal(failed.analytics_refreshed, false);
  assert.match(failed.snapshot_fingerprint, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(failed).includes('synthetic private'));
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
});
