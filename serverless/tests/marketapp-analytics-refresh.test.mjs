import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createMarketappLoginEngine} from '../tgcloud/lib/marketapp-login.js';
import {createMarketappSessionBox} from '../tgcloud/lib/marketapp-session-box.js';
import {createMarketappRememberedSessionBox} from '../tgcloud/lib/marketapp-remembered-session-box.js';
import {createMarketappRefreshStatusEngine} from '../tgcloud/lib/marketapp-refresh-status.js';
import {createMarketappAnalyticsRefreshEngine, MarketappRefreshRequestError, marketappRefreshErrorResponse, parseMarketappSessionCookie, marketappAnalyticsUrl} from '../tgcloud/lib/marketapp-analytics-refresh.js';
import {syntheticAnalyticsPage, syntheticWallet as wallet, syntheticFriendly, htmlAttribute} from './fixtures/marketapp-analytics-page-fixture.mjs';

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
function setup({fetch: supplied, records = [{kind: 'settings', record: {wallet}}], sessionBox: suppliedBox, combinedActivity = false, responseEdit = null} = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE marketapp_login_attempts(attempt_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,wallet TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,nonce_fingerprint TEXT,outcome_json TEXT);
    CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,nonce_counter INTEGER NOT NULL DEFAULT 0,cookie_version INTEGER NOT NULL DEFAULT 0,wallet TEXT,wallet_revision INTEGER,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE marketapp_website_gates(scope_key TEXT PRIMARY KEY,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_allowed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE marketapp_website_requests(request_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,attempted_at INTEGER NOT NULL);
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
    const edit = result => responseEdit ? responseEdit(url, options, result, {now: () => at, advance: ms => {at += ms;}}) : result;
    if (url === 'https://marketapp.org/' && options.method === 'GET') return edit(response(url, anon, {'Content-Type': 'text/html', 'Set-Cookie': anonymousCookie + '; Path=/; Secure; HttpOnly; SameSite=Lax'}));
    if (url === AUTH && options.method === 'POST') return edit(response(url, '{"verified":true}', {'Content-Type': 'application/json', 'Set-Cookie': authenticatedCookie + '; Path=/; Secure; HttpOnly'}));
    if (options.method === 'GET' && [30, 365].some(days => url === marketappAnalyticsUrl(wallet, days))) {
      const days = url.includes('last365days') ? 365 : 30;
      const page = syntheticAnalyticsPage({periodDays: days, combinedActivity, capturedAt: new Date(at).toISOString(), lastDate: new Date(at).toISOString().slice(0, 10)});
      if (combinedActivity) {
        const raw = page.snapshot.charts[0].spec_raw;
        page.html = page.html.replace('>3.00<', '>28<').replace(htmlAttribute(raw), htmlAttribute(raw.replace('"unit":"GRAM","data":[3,', '"unit":"GRAM","data":[27.9804,')));
      }
      return edit(response(url, page.html, {'Content-Type': 'text/html'}));
    }
    throw new Error('Unexpected mock route');
  };
  const rememberedSessionBox = createMarketappRememberedSessionBox('11'.repeat(32));
  const engine = createMarketappAnalyticsRefreshEngine({repository, fetch: request, ownerTelegramId: 12345, clock: async () => at, sessionBox: box, rememberedSessionBox,sleep:async milliseconds=>{at+=milliseconds;}});
  return {database, repository, requests, engine, request, box, rememberedSessionBox, now: () => at, advance: ms => {at += ms;}};
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
const sessionRow = t => t.database.prepare('SELECT * FROM marketapp_analytics_sessions WHERE owner_id=?').get('12345');
const snapshots = t => t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n;
async function remember(t, periodDays = 30) {
  const start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: periodDays, remember_login: true});
  return await t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now()));
}
function walletChange(t, nextWallet) {
  const sequence = t.database.prepare('SELECT MAX(sequence) AS sequence FROM cloud_events').get().sequence + 1;
  t.database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(sequence, `wallet-change-${sequence}`, '{}', null, null,
    JSON.stringify([{kind: 'settings', record: {wallet: nextWallet}}]), null, new Date(t.now()).toISOString());
}

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
  for (const name of ['startMarketappAnalyticsRefresh', 'finishMarketappAnalyticsRefresh', 'cancelMarketappAnalyticsRefresh',
    'refreshSavedMarketappAnalytics', 'refreshStartupMarketappAnalytics', 'disconnectMarketappAnalyticsSession', 'getMarketappAnalyticsSessionStatus']) {
    for (const unauthorized of [{}, {initData: {user: {id: 67890}}}]) await assertCode(engine[name](unauthorized, {}), 'MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED');
  }
  assert.equal(accesses, 0);
});

test('remembering is explicit envelope-bound consent and default refresh stores no website login', async () => {
  for (const rememberLogin of [undefined, false]) {
    const t = setup(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30, ...(rememberLogin === undefined ? {} : {remember_login: rememberLogin})});
    assert.equal(t.box.open(start.session_envelope).remember_login, false);
    await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, {...submission(start, t.now()), remember_login: true}), 'MARKETAPP_REFRESH_INVALID_INPUT');
    await t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now()));
    assert.equal(sessionRow(t).ciphertext, null); assert.equal(sessionRow(t).nonce_counter, 0);
    assert.deepEqual(await t.engine.getMarketappAnalyticsSessionStatus(ctx), {remembered: false, expires_at: null}); t.database.close();
  }
  const t = setup();
  for (const input of [{period_days: 30, remember_login: 'true'}, {period_days: 30, remember_login: 1}, {period_days: 30, cookie: 'private'}])
    await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, input), 'MARKETAPP_REFRESH_INVALID_INPUT');
  assert.equal(t.requests.length, 0); t.database.close();
});

test('approved login stores only ciphertext with a seven-day cap and supports either reporting period using one GET', async () => {
  const t = setup(), before = await t.repository.read(), first = await remember(t), stored = sessionRow(t);
  assert.equal(stored.expires_at - stored.created_at, 7 * 86400000); assert.equal(stored.nonce_counter, 1);
  const plaintext = t.rememberedSessionBox.open(stored.ciphertext);
  assert.equal(plaintext.cookie, authenticatedCookie); assert.equal(plaintext.wallet, wallet);
  const persisted = JSON.stringify(t.database.prepare('SELECT * FROM marketapp_analytics_sessions').all());
  for (const value of [anonymousCookie, authenticatedCookie, challenge, 'proof', 'signature', '<html>']) assert.equal(persisted.includes(value), false);
  assert.deepEqual(await t.engine.getMarketappAnalyticsSessionStatus(ctx), {remembered: true, expires_at: new Date(stored.expires_at).toISOString()});
  t.advance(60000);
  const result = await t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 365});
  assert.equal(result.authenticated, true); assert.equal(result.analytics_refreshed, true); assert.equal(result.snapshot.daily.length, 365);
  assert.notEqual(result.attempt_id, first.attempt_id); assert.match(result.attempt_id, /^[a-f0-9]{64}$/);
  assert.equal(t.requests.length, 4); assert.equal(t.requests[3].url, marketappAnalyticsUrl(wallet, 365));
  assert.equal(t.requests[3].options.method, 'GET'); assert.equal(t.requests[3].options.headers.Cookie, authenticatedCookie);
  assert.equal(t.requests[3].options.body, undefined); assert.equal(t.requests[3].options.headers.Authorization, undefined);
  assert.deepEqual(await t.repository.read(), before); assert.equal(sessionRow(t).expires_at, stored.expires_at);
  assert.equal(sessionRow(t).nonce_counter, 1); t.database.close();
});

test('provider Max-Age and Expires bound remembered lifetime at the earliest supplied deadline', async () => {
  const t = setup({responseEdit: (url, options, original, clock) => url === AUTH ? response(url, '{"verified":true}', {
    'Content-Type': 'application/json', 'Set-Cookie': `${authenticatedCookie}; Path=/; Max-Age=3600; Expires=${new Date(clock.now() + 1800000).toUTCString()}`}) : original});
  await remember(t); assert.equal(sessionRow(t).expires_at, t.now() + 1800000);
  t.advance(1800000); const requests = t.requests.length, count = snapshots(t);
  await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RECONNECT_REQUIRED');
  assert.equal(t.requests.length, requests); assert.equal(snapshots(t), count); assert.equal(sessionRow(t).ciphertext, null);
  assert.equal(sessionRow(t).nonce_counter, 1); assert.equal(sessionRow(t).generation, 1); t.database.close();
});

test('saved GET cookie rotation uses a fresh durable nonce and omission never lengthens lifetime', async () => {
  let rotate = false;
  const t = setup({responseEdit: (url, options, original) => rotate && url.includes('/user/') ? response(url,
    syntheticAnalyticsPage({capturedAt: new Date(t.now()).toISOString()}).html, {'Content-Type': 'text/html',
      'Set-Cookie': 'session=synthetic-rotated-session; Path=/; Max-Age=600'}) : original});
  await remember(t); const previous = sessionRow(t); t.advance(60000); rotate = true;
  await t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30});
  const changed = sessionRow(t), payload = t.rememberedSessionBox.open(changed.ciphertext);
  assert.equal(changed.nonce_counter, 2); assert.equal(changed.cookie_version, 2);
  assert.notEqual(changed.ciphertext.slice(2, 50), previous.ciphertext.slice(2, 50));
  assert.equal(payload.cookie, 'session=synthetic-rotated-session'); assert.equal(changed.expires_at, t.now() + 600000);
  assert.equal(changed.created_at, previous.created_at); t.advance(60000); rotate = false;
  await t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30});
  assert.equal(t.requests.at(-1).options.headers.Cookie, payload.cookie); assert.equal(sessionRow(t).expires_at, changed.expires_at);
  assert.equal(sessionRow(t).nonce_counter, 2); t.database.close();
});

test('analytics and personal gift refresh serialize through the same durable owner lease',async()=>{
  const t=setup();await remember(t);t.advance(60000);const before=t.requests.length;
  const lease=await t.repository.acquireMarketappWebsiteLease('12345','synthetic-gifts-operation',t.now());assert.ok(lease);
  await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx,{period_days:30}),'MARKETAPP_REFRESH_RATE_LIMIT');
  assert.equal(t.requests.length,before);assert.equal(sessionRow(t).cookie_version,1);
  await t.repository.releaseMarketappWebsiteLease('12345',lease);
  const result=await t.engine.refreshSavedMarketappAnalytics(ctx,{period_days:30});assert.equal(result.analytics_refreshed,true);
  assert.equal(t.requests.length,before+1);t.database.close();
});

test('provider Retry-After remains durable after failed analytics and blocks personal gifts without HTTP',async()=>{
  let throttle=false;
  const t=setup({responseEdit:(url,options,original)=>throttle&&url.includes('/user/')?response(url,'synthetic-private-error',{'Content-Type':'text/html','Retry-After':'120'},{status:429}):original});
  await remember(t);t.advance(60000);throttle=true;
  await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx,{period_days:30}),'MARKETAPP_REFRESH_RATE_LIMIT');
  const count=t.requests.length,lease=await t.repository.acquireMarketappWebsiteLease('12345','gift-retry',t.now());
  const denied=await t.repository.reserveMarketappWebsiteRequest('12345',lease,'gift-page',t.now());assert.equal(denied.retry_after_seconds,120);assert.equal(denied.allowed,false);
  assert.equal(t.requests.length,count);assert.equal((await t.engine.getMarketappAnalyticsSessionStatus(ctx)).remembered,true);
  const persisted=JSON.stringify(t.database.prepare('SELECT * FROM marketapp_website_gates').all());assert.equal(persisted.includes('synthetic-private-error'),false);t.database.close();
});

test('absent, expired, corrupted or owner/wallet-bound invalid sessions reconnect before consuming request budget', async () => {
  const absent = setup(); await assertCode(absent.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RECONNECT_REQUIRED');
  assert.equal(absent.requests.length, 0); assert.equal(absent.database.prepare('SELECT count(*) AS n FROM marketapp_login_attempts').get().n, 0); absent.database.close();
  for (const change of [t => t.advance(7 * 86400000), t => t.database.exec("UPDATE marketapp_analytics_sessions SET ciphertext='02ff'"),
    t => t.database.prepare('UPDATE marketapp_analytics_sessions SET wallet=?').run(`0:${'22'.repeat(32)}`),
    t => t.database.exec('UPDATE marketapp_analytics_sessions SET expires_at=expires_at+1')]) {
    const t = setup(); await remember(t); change(t); const count = snapshots(t);
    await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RECONNECT_REQUIRED');
    assert.equal(t.requests.length, 3); assert.equal(snapshots(t), count); assert.equal(sessionRow(t).ciphertext, null);
    assert.equal(sessionRow(t).nonce_counter, 1); t.database.close();
  }
});

test('remembered refreshes and wallet starts share the same cooldown and rolling hourly allowance', async () => {
  const t = setup(); await remember(t);
  await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RATE_LIMIT');
  for (let index = 1; index < 5; index++) {t.advance(60000); await t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: index % 2 ? 30 : 365});}
  t.advance(60000);
  await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30, remember_login: true}), 'MARKETAPP_REFRESH_RATE_LIMIT');
  await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RATE_LIMIT');
  assert.equal(t.requests.length, 7); await t.engine.disconnectMarketappAnalyticsSession(ctx);
  await assertCode(t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RATE_LIMIT'); t.database.close();
});

test('transient requests and changed analytics pages preserve a valid login and previous snapshots', async () => {
  for (const failure of ['network', 'http', 'page', 'missing_identity']) {
    let failNow = false;
    const t = setup({responseEdit: (url, options, original) => {
      if (!failNow || !url.includes('/user/')) return original;
      if (failure === 'network') throw new Error('synthetic-private-provider-error');
      if (failure === 'http') return {...original, status: 503};
      const page = syntheticAnalyticsPage().html;
      return response(url, failure === 'page' ? page.replace('profile.rent.income', 'profile.rent.unverified') : page.replace(/Wallet\.init\([^;]+;/, ''), {'Content-Type': 'text/html'});
    }});
    await remember(t); const stored = sessionRow(t), count = snapshots(t); t.advance(60000); failNow = true;
    await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), failure==='http'?'MARKETAPP_REFRESH_RATE_LIMIT':['page', 'missing_identity'].includes(failure) ? 'MARKETAPP_REFRESH_PAGE_CHANGED' : 'MARKETAPP_REFRESH_FAILED');
    assert.equal(sessionRow(t).ciphertext, stored.ciphertext); assert.equal(snapshots(t), count);
    assert.equal(await t.engine.getMarketappAnalyticsSessionStatus(ctx).then(result => result.remembered), true); t.database.close();
  }
});

test('definite logged-out, rejected, wrong-wallet or deleted-cookie responses clear only the matching saved login', async () => {
  for (const failure of ['unauthorized', 'forbidden', 'redirect', 'logged_out', 'wrong_wallet', 'deleted']) {
    let failNow = false;
    const t = setup({responseEdit: (url, options, original) => {
      if (!failNow || !url.includes('/user/')) return original;
      if (failure === 'unauthorized') return {...original, status: 401};
      if (failure === 'forbidden') return {...original, status: 403};
      if (failure === 'redirect') return response(url, '', {'Content-Type': 'text/html', Location: '/'}, {status: 302});
      if (failure === 'deleted') return response(url, syntheticAnalyticsPage().html, {'Content-Type': 'text/html', 'Set-Cookie': 'session=; Path=/; Max-Age=0'});
      return response(url, failure === 'logged_out' ? anon : syntheticAnalyticsPage({identity: `0:${'22'.repeat(32)}`}).html, {'Content-Type': 'text/html'});
    }});
    await remember(t); const count = snapshots(t); t.advance(60000); failNow = true;
    await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), 'MARKETAPP_REFRESH_RECONNECT_REQUIRED');
    assert.equal(sessionRow(t).ciphertext, null); assert.equal(sessionRow(t).nonce_counter, 1); assert.equal(snapshots(t), count);
    assert.deepEqual(await t.engine.getMarketappAnalyticsSessionStatus(ctx), {remembered: false, expires_at: null}); t.database.close();
  }
});

test('Disconnect fences saved and fresh in-flight refreshes without resurrecting ciphertext or importing results', async () => {
  for (const fresh of [false, true]) {
    let block = false, entered, release;
    const waiting = new Promise(resolve => {entered = resolve;});
    const resumed = new Promise(resolve => {release = resolve;});
    const t = setup({responseEdit: async (url, options, original) => {
      if (block && (fresh ? url === AUTH : url.includes('/user/'))) {entered(); await resumed;}
      return original;
    }});
    if (!fresh) {await remember(t); t.advance(60000);}
    const start = fresh ? await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30, remember_login: true}) : null;
    const count = snapshots(t); block = true;
    const operation = fresh ? t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())) : t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30});
    const rejected = assertCode(operation, 'MARKETAPP_REFRESH_EXPIRED');
    await waiting; assert.deepEqual(await t.engine.disconnectMarketappAnalyticsSession(ctx), {disconnected: true}); release(); await rejected;
    assert.equal(sessionRow(t).ciphertext, null); assert.equal(snapshots(t), count);
    assert.equal(sessionRow(t).generation, 1); t.database.close();
  }
});

test('the snapshot INSERT atomically fences Disconnect after JavaScript validation', async () => {
  const t = setup(); await remember(t); t.advance(60000); const count = snapshots(t);
  const original = t.repository.importPersonalAnalyticsFenced;
  t.repository.importPersonalAnalyticsFenced = async (...args) => {await t.engine.disconnectMarketappAnalyticsSession(ctx); return await original(...args);};
  await assertCode(t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 365}), 'MARKETAPP_REFRESH_EXPIRED');
  assert.equal(snapshots(t), count); assert.equal(sessionRow(t).ciphertext, null); t.database.close();
});

test('wallet changes and changes back invalidate remembered and pending proof bindings', async () => {
  for (const fresh of [false, true]) {
    const t = setup();
    const start = fresh ? await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 30, remember_login: true}) : null;
    if (!fresh) {await remember(t); t.advance(60000);}
    walletChange(t, `0:${'22'.repeat(32)}`); walletChange(t, wallet); const count = snapshots(t), requestCount = t.requests.length;
    await assertCode(fresh ? t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now()))
      : t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: 30}), fresh ? 'MARKETAPP_REFRESH_EXPIRED' : 'MARKETAPP_REFRESH_RECONNECT_REQUIRED');
    assert.equal(snapshots(t), count); assert.equal(t.requests.length, requestCount);
    if (!fresh) assert.equal(sessionRow(t).ciphertext, null); t.database.close();
  }
});

test('Disconnect never resets the nonce counter; reconnect and rotations reserve new values', async () => {
  const t = setup(); await remember(t); const first = sessionRow(t);
  await t.engine.disconnectMarketappAnalyticsSession(ctx); await t.engine.disconnectMarketappAnalyticsSession(ctx);
  assert.equal(sessionRow(t).nonce_counter, 1); assert.equal(sessionRow(t).generation, 2); t.advance(60000);
  await remember(t); const next = sessionRow(t);
  assert.equal(next.nonce_counter, 2); assert.equal(next.cookie_version, 2); assert.equal(next.generation, 2);
  assert.notEqual(first.ciphertext.slice(2, 50), next.ciphertext.slice(2, 50)); t.database.close();
});

test('failed cookie CAS writes burn reserved nonces across Disconnect and wallet changes', async () => {
  for (const change of ['disconnect', 'wallet']) {
    const t = setup(), original = t.repository.storeMarketappSession;
    let reservedEnvelope;
    t.repository.storeMarketappSession = async (...args) => {
      reservedEnvelope = args[2].ciphertext;
      if (change === 'disconnect') await t.engine.disconnectMarketappAnalyticsSession(ctx);
      else walletChange(t, `0:${'22'.repeat(32)}`);
      return await original(...args);
    };
    await assertCode(remember(t), 'MARKETAPP_REFRESH_EXPIRED');
    assert.equal(sessionRow(t).ciphertext, null); assert.equal(sessionRow(t).nonce_counter, 1); assert.equal(snapshots(t), 1);
    t.repository.storeMarketappSession = original;
    if (change === 'wallet') walletChange(t, wallet);
    t.advance(60000); await remember(t);
    assert.equal(sessionRow(t).nonce_counter, 2);
    assert.notEqual(sessionRow(t).ciphertext.slice(2, 50), reservedEnvelope.slice(2, 50)); t.database.close();
  }
});

test('parallel nonce reservations are durable and unique before any ciphertext is stored', async () => {
  const t = setup(), sessionFence = await t.repository.marketappSessionFence('12345');
  const values = await Promise.all(Array.from({length: 4}, () => t.repository.reserveMarketappSessionNonce('12345', sessionFence.generation)));
  assert.deepEqual(values.sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(sessionRow(t).nonce_counter, 4); assert.equal(sessionRow(t).ciphertext, null);
  await remember(t); assert.equal(sessionRow(t).cookie_version, 5); t.database.close();
});

test('safe connection status is available without any refresh attempts and never returns ciphertext', async () => {
  const t = setup(), statusEngine = createMarketappRefreshStatusEngine({repository: t.repository, ownerTelegramId: 12345,
    clock: async () => t.now(), sessionStatus: context => t.engine.getMarketappAnalyticsSessionStatus(context)});
  assert.deepEqual(await statusEngine.getMarketappAnalyticsRefreshStatus(ctx), {attempt: null, session: {remembered: false, expires_at: null}});
  await remember(t); const result = await statusEngine.getMarketappAnalyticsRefreshStatus(ctx);
  assert.equal(result.session.remembered, true); assert.equal(result.session.expires_at, new Date(sessionRow(t).expires_at).toISOString());
  assert.deepEqual(Object.keys(result.session).sort(), ['expires_at', 'remembered']);
  for (const value of ['ciphertext', authenticatedCookie, challenge, 'cookie_version']) assert.equal(JSON.stringify(result).includes(value), false);
  t.database.close();
});

test('start binds an encrypted short-lived cookie to the owner, wallet, exact period and independent ID', async () => {
  const t = setup(), before = await t.repository.read(), start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 365});
  assert.equal(start.period_days, 365); assert.equal(start.wallet, wallet); assert.equal(start.domain, 'marketapp.org');
  assert.equal(start.challenge, challenge); assert.match(start.session_envelope, /^[0-9a-f]+$/); assert.ok(start.session_envelope.length <= 16500);
  assert.equal(Date.parse(start.expires_at) - t.now(), 300000);
  const opened = t.box.open(start.session_envelope);
  assert.deepEqual(opened, {version: 1, attempt_id: start.attempt_id, owner: '12345', wallet, period_days: 365, created_at: t.now(), expires_at: t.now() + 300000,
    cookie: anonymousCookie, cookie_expires_at: null, challenge, remember_login: false, session_generation: 0, wallet_revision: 1, session_version: 0});
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

test('combined activity with rounded annual summary follows the same authorized immutable refresh flow', async () => {
  for (const days of [30, 365]) {
    const t = setup({combinedActivity: true}), before = await t.repository.read();
    const start = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: days});
    const result = await t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now()));
    assert.equal(result.authenticated, true); assert.equal(result.analytics_refreshed, true);
    assert.equal(result.snapshot.daily.length, days); assert.equal(result.snapshot.summary.rent_volume, '28');
    assert.equal(result.snapshot.daily[0].rent_volume, '27.9804'); assert.equal(result.snapshot.summary.rentals, 4);
    assert.equal(t.requests.length, 3); assert.deepEqual(await t.repository.read(), before);
    const row = t.database.prepare('SELECT * FROM personal_rental_analytics WHERE fingerprint = ?').get(result.snapshot.fingerprint);
    const raw = JSON.parse(row.raw_snapshot);
    assert.ok(raw.charts.some(chart => chart.key === 'profile.rent.activity' && chart.spec_raw.includes('27.9804')));
    assert.equal(raw.summary[0].value, '28'); assert.equal(audit(t).state, 'saved');
    for (const value of [anonymousCookie, authenticatedCookie, challenge, 'synthetic-discarded-nonce', '<html>']) assert.equal(JSON.stringify(row).includes(value), false);
    t.database.close();
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
        else t.repository.analyticsWalletRecords = async () => [{kind: 'settings', record: {wallet: `0:${'22'.repeat(32)}`}}];
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
  t.repository.importPersonalAnalyticsFenced = async () => {throw new Error('synthetic private database credential with 999 rent_volume');};
  await assertCode(t.engine.finishMarketappAnalyticsRefresh(ctx, submission(start, t.now())), 'MARKETAPP_REFRESH_FAILED');
  const failed = audit(t); assert.equal(failed.state, 'failed'); assert.equal(failed.stage, 'save_snapshot'); assert.equal(failed.authenticated, true); assert.equal(failed.analytics_refreshed, false);
  assert.match(failed.snapshot_fingerprint, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(failed).includes('synthetic private'));
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1); t.database.close();
});

test('startup validates its exact period before storage and never initiates wallet login', async () => {
  const t = setup();
  for (const input of [{}, null, {period_days: 90}, {period_days: '30'}, {period_days: 30, remember_login: true}, {period_days: 365, url: AUTH}])
    await assertCode(t.engine.refreshStartupMarketappAnalytics(ctx, input), 'MARKETAPP_REFRESH_INVALID_INPUT');
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'unavailable', period_days: 30, reason: 'no_login'});
  assert.equal(t.requests.length, 0); assert.equal(t.database.prepare('SELECT count(*) AS n FROM marketapp_login_attempts').get().n, 0);
  t.database.close();
  const absent = setup({records: []});
  assert.deepEqual(await absent.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 365}), {state: 'unavailable', period_days: 365, reason: 'wallet_missing'});
  assert.equal(absent.requests.length, 0); absent.database.close();
});

test('startup refresh skips a fresh linked provider snapshot, then performs only one remembered GET at 15 minutes', async () => {
  const t = setup(), first = await remember(t), attempts = t.database.prepare('SELECT count(*) AS n FROM marketapp_login_attempts').get().n;
  const fresh = {state: 'fresh', period_days: 30, captured_at: first.snapshot.captured_at};
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), fresh);
  t.advance(899999); assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), fresh);
  assert.equal(t.requests.length, 3); assert.equal(t.database.prepare('SELECT count(*) AS n FROM marketapp_login_attempts').get().n, attempts);
  t.advance(1); const result = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30});
  assert.deepEqual(result, {state: 'saved', period_days: 30, captured_at: new Date(t.now()).toISOString()});
  assert.equal(t.requests.length, 4); assert.equal(t.requests.at(-1).url, marketappAnalyticsUrl(wallet, 30));
  assert.equal(t.requests.at(-1).options.method, 'GET'); assert.equal(t.requests.at(-1).options.headers.Cookie, authenticatedCookie);
  assert.equal(t.requests.at(-1).options.headers.Authorization, undefined); assert.equal(t.requests.at(-1).options.body, undefined);
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {...result, state: 'fresh'});
  assert.equal(t.requests.length, 4); assert.equal(JSON.stringify(result).includes(authenticatedCookie), false); t.database.close();
});

test('startup freshness accepts final audits written after insertion using advancing database timestamps', async () => {
  const t = setup(), first = await remember(t);
  const row = t.database.prepare('SELECT attempt_id,outcome_json FROM marketapp_login_attempts WHERE attempt_id=?').get(first.attempt_id);
  const outcome = JSON.parse(row.outcome_json); t.advance(12); outcome.observed_at = new Date(t.now()).toISOString();
  t.database.prepare('UPDATE marketapp_login_attempts SET outcome_json=? WHERE attempt_id=?').run(JSON.stringify(outcome), row.attempt_id);
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'fresh', period_days: 30, captured_at: first.snapshot.captured_at});
  assert.equal(t.requests.length, 3); t.database.close();
});

test('startup freshness is period scoped and browser imports do not impersonate a successful provider refresh', async () => {
  const t = setup(); await remember(t); t.advance(60000);
  const page = syntheticAnalyticsPage({periodDays: 365, capturedAt: new Date(t.now()).toISOString()});
  const raw = JSON.stringify(page.snapshot);
  const snapshot = (await import('../tgcloud/lib/personal-analytics.js')).normalizePersonalAnalytics(raw, wallet);
  await t.repository.importPersonalAnalytics(snapshot, raw, new Date(t.now()).toISOString());
  const result = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 365});
  assert.equal(result.state, 'saved'); assert.equal(result.period_days, 365); assert.equal(t.requests.length, 4);
  assert.equal(t.requests.at(-1).url, marketappAnalyticsUrl(wallet, 365));
  assert.equal((await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30})).state, 'fresh'); assert.equal(t.requests.length, 4); t.database.close();
});

test('startup recovers a committed provider snapshot when its final success audit was lost', async () => {
  const t = setup(); await remember(t); t.advance(900000);
  const record = t.repository.recordMarketappRefreshOutcome;
  t.repository.recordMarketappRefreshOutcome = async (...args) => args[2].state === 'saved' ? false : record(...args);
  const first = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 365}); assert.equal(first.state, 'saved');
  assert.equal(audit(t).state, 'updating'); assert.equal(audit(t).stage, 'save_snapshot');
  t.advance(10); assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 365}), {...first, state: 'fresh'});
  assert.equal(t.requests.length, 4); t.database.close();
});

test('failed startup refreshes retain saved data and receive durable 15-minute reopen backoff', async () => {
  let failing = false;
  const t = setup({responseEdit: (url, options, original) => {if (failing && url.includes('/user/')) throw new Error('private synthetic cookie and financial values'); return original;}});
  await remember(t); t.advance(900000); const count = snapshots(t), failedAt = t.now(); failing = true;
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'unavailable', period_days: 30, reason: 'refresh_failed'});
  assert.equal(snapshots(t), count); assert.equal(t.requests.length, 4); assert.equal((await t.engine.getMarketappAnalyticsSessionStatus(ctx)).remembered, true);
  t.advance(300000);
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'limited', period_days: 30, reason: 'cooldown', retry_at: new Date(failedAt + 900000).toISOString()});
  assert.equal(t.requests.length, 4); failing = false; t.advance(600000);
  assert.equal((await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30})).state, 'saved'); assert.equal(t.requests.length, 5); t.database.close();
});

test('startup reservation crash gap retains its 15-minute backoff after the unfinished attempt expires', async () => {
  const t = setup(); await remember(t); t.advance(900000);
  const created = t.now(), expires = created + 300000;
  assert.equal(await t.repository.reserveMarketappLoginAttempt({id: 'cd'.repeat(32), owner: '12345', wallet, created, expires}, {cooldown_ms: 60000, hourly_attempts: 5}), true);
  t.advance(300001);
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'limited', period_days: 30, reason: 'cooldown', retry_at: new Date(created + 900000).toISOString()});
  assert.equal(t.requests.length, 3); t.advance(599999);
  assert.equal((await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30})).state, 'saved'); assert.equal(t.requests.length, 4); t.database.close();
});

test('startup keeps pending manual wallet approval and a busy personal-gifts lease intact without HTTP', async () => {
  const t = setup(); await remember(t); t.advance(900000);
  const pending = await t.engine.startMarketappAnalyticsRefresh(ctx, {period_days: 365}); const before = t.requests.length;
  const busy = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30});
  assert.equal(busy.state, 'busy'); assert.equal(busy.reason, 'active_refresh'); assert.equal(t.requests.length, before);
  assert.equal((await t.repository.marketappLoginAttempt(pending.attempt_id, '12345')).state, 'issued');
  await t.engine.cancelMarketappAnalyticsRefresh(ctx, {attempt_id: pending.attempt_id}); t.advance(900000);
  const lease = await t.repository.acquireMarketappWebsiteLease('12345', 'personal-gifts', t.now());
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'busy', period_days: 30, reason: 'website_busy'});
  assert.equal(t.requests.length, before); assert.equal(t.database.prepare("SELECT lease_id FROM marketapp_website_gates WHERE scope_key='private:12345'").get().lease_id, lease.id);
  await t.repository.releaseMarketappWebsiteLease('12345', lease); t.database.close();
});

test('two concurrent startup instances issue a single provider GET and the next open sees the saved snapshot', async () => {
  let block = false, entered, release;
  const waiting = new Promise(resolve => {entered = resolve;}), resumed = new Promise(resolve => {release = resolve;});
  const t = setup({responseEdit: async (url, options, original) => {if (block && url.includes('/user/')) {entered(); await resumed;} return original;}});
  await remember(t); t.advance(900000); block = true;
  const second = createMarketappAnalyticsRefreshEngine({repository: t.repository, fetch: t.request, ownerTelegramId: 12345,
    clock: async () => t.now(), sessionBox: t.box, rememberedSessionBox: t.rememberedSessionBox});
  const first = t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}); await waiting;
  assert.equal((await second.refreshStartupMarketappAnalytics(ctx, {period_days: 30})).state, 'busy'); assert.equal(t.requests.length, 4);
  release(); const result = await first; assert.equal(result.state, 'saved');
  assert.deepEqual(await second.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {...result, state: 'fresh'}); assert.equal(t.requests.length, 4); t.database.close();
});

test('startup preserves the original rolling five-attempt allowance and honors provider Retry-After', async () => {
  let throttle = false;
  const t = setup({responseEdit: (url, options, original) => throttle && url.includes('/user/') ? response(url, 'private throttle text', {'Content-Type': 'text/html', 'Retry-After': '3600'}, {status: 429}) : original});
  await remember(t);
  for (let i = 0; i < 4; i++) {t.advance(60000); await t.engine.refreshSavedMarketappAnalytics(ctx, {period_days: i % 2 ? 365 : 30});}
  t.advance(900000); const before = t.requests.length;
  const limited = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30});
  assert.equal(limited.state, 'limited'); assert.equal(limited.reason, 'request_limit'); assert.equal(t.requests.length, before);
  t.advance(3600000); throttle = true; const throttleAt = t.now();
  assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'limited', period_days: 30, reason: 'cooldown', retry_at: new Date(throttleAt + 3600000).toISOString()});
  assert.equal(t.requests.length, before + 1); t.advance(900000);
  const retry = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}); assert.equal(retry.state, 'limited');
  assert.equal(retry.retry_at, new Date(throttleAt + 3600000).toISOString()); assert.equal(t.requests.length, before + 1); t.database.close();
});

test('expired and rejected startup logins return a safe no-login result without prompting or deleting analytics', async () => {
  for (const failure of ['expired', 'rejected']) {
    let rejected = false;
    const t = setup({responseEdit: (url, options, original) => rejected && url.includes('/user/') ? {...original, status: 401} : original});
    await remember(t); const count = snapshots(t);
    t.advance(failure === 'expired' ? 7 * 86400000 : 900000); rejected = failure === 'rejected';
    assert.deepEqual(await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30}), {state: 'unavailable', period_days: 30, reason: 'no_login'});
    assert.equal(t.requests.length, failure === 'expired' ? 3 : 4); assert.equal(snapshots(t), count);
    assert.equal(sessionRow(t).ciphertext, null); t.database.close();
  }
});

test('Disconnect during startup fetch fences insertion and returns a safe result with previous analytics retained', async () => {
  let block = false, entered, release;
  const waiting = new Promise(resolve => {entered = resolve;}), resumed = new Promise(resolve => {release = resolve;});
  const t = setup({responseEdit: async (url, options, original) => {if (block && url.includes('/user/')) {entered(); await resumed;} return original;}});
  await remember(t); t.advance(900000); const count = snapshots(t); block = true;
  const first = t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 365}); await waiting;
  await t.engine.disconnectMarketappAnalyticsSession(ctx); release();
  assert.deepEqual(await first, {state: 'unavailable', period_days: 365, reason: 'no_login'});
  assert.equal(snapshots(t), count); assert.equal(sessionRow(t).ciphertext, null); assert.equal(t.requests.length, 4); t.database.close();
});

test('startup never treats a missing linked snapshot or future capture as fresh success', async () => {
  for (const mode of ['missing', 'future', 'wrong_state']) {
    const t = setup(), first = await remember(t); t.advance(900000);
    if (mode === 'missing') t.database.prepare('DELETE FROM personal_rental_analytics WHERE fingerprint=?').run(first.snapshot.fingerprint);
    else if (mode === 'future') t.database.prepare('UPDATE personal_rental_analytics SET captured_at=? WHERE fingerprint=?').run(new Date(t.now() + 60000).toISOString(), first.snapshot.fingerprint);
    else t.database.prepare("UPDATE marketapp_login_attempts SET state='cancelled' WHERE attempt_id=?").run(first.attempt_id);
    assert.equal((await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 30})).state, 'saved');
    assert.equal(t.requests.length, 4); t.database.close();
  }
});

test('startup respects the shared website daily allowance without any provider request', async () => {
  const t = setup(); await remember(t); t.advance(900000);
  const attempted = t.now() - 5000;
  const insert = t.database.prepare('INSERT INTO marketapp_website_requests VALUES(?,?,?)');
  for (let i = 0; i < 100; i++) insert.run(`synthetic-daily-${i}`, 'private:12345', attempted);
  const result = await t.engine.refreshStartupMarketappAnalytics(ctx, {period_days: 365});
  assert.equal(result.state, 'limited'); assert.equal(result.retry_at, new Date(attempted + 86400000).toISOString());
  assert.equal(t.requests.length, 3); assert.equal(snapshots(t), 2);
  assert.equal(t.database.prepare("SELECT lease_id FROM marketapp_website_gates WHERE scope_key='private:12345'").get().lease_id, null); t.database.close();
});
