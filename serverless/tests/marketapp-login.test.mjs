import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createMarketappLoginEngine, parseMarketappChallenge, marketappLoginErrorResponse, MarketappLoginRequestError, MARKETAPP_LOGIN_LIMITS, MARKETAPP_LOGIN_MANIFEST} from '../tgcloud/lib/marketapp-login.js';

const ctx = {initData: {user: {id: 12345}}}, wallet = `0:${'11'.repeat(32)}`;
const alias = 'EQAREREREREREREREREREREREREREREREREREREREREREeYT';
const otherWallet = `0:${'22'.repeat(32)}`;
const challenge = 'synthetic-public-marketapp-challenge';
const html = nonce => `<html><script>Wallet.init(${JSON.stringify({address: false, ton_proof: nonce, version: 2, platform: 'web'})});</script></html>`;
const body = text => ({async *[Symbol.asyncIterator]() {yield Buffer.from(text, 'utf8');}});
function response(text = html(challenge), options = {}) {
  const headers = {'Content-Type': 'text/html; charset=utf-8', ...options.headers};
  return {status: 200, url: 'https://marketapp.org/', body: body(text), ...options, headers: {get: key => headers[key] ?? null}};
}
function setup({fetch: supplied, records = [{kind: 'settings', record: {wallet}}], legacyLoginSchema = false} = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE marketapp_login_attempts(attempt_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,wallet TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,nonce_fingerprint TEXT${legacyLoginSchema ? '' : ',outcome_json TEXT'});
    CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT PRIMARY KEY,wallet TEXT NOT NULL,captured_at TEXT NOT NULL,imported_at TEXT NOT NULL,raw_snapshot TEXT NOT NULL,normalized_json TEXT NOT NULL);`);
  const state = {version: 2, next_job_id: 7, job: {id: 6}, attempts: [123], next_allowed_at: 999};
  database.prepare('INSERT INTO cloud_events VALUES(1,?,?,?,?,?,?,?)').run('seed', JSON.stringify(state), null, null, JSON.stringify(records), null, '2026-10-09T12:00:00Z');
  database.prepare('INSERT INTO personal_rental_analytics VALUES(?,?,?,?,?,?)').run('saved', wallet, '2026-10-09', '2026-10-09', 'synthetic snapshot', '{}');
  const db = {async get(sql, params = {}) {return database.prepare(sql).get(params) || null;},
    async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};},
    async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db), requests = []; let at = Date.parse('2026-10-09T12:00:00Z');
  const engine = createMarketappLoginEngine({repository, ownerTelegramId: 12345, clock: async () => at,
    fetch: async (url, options) => {requests.push({url, options}); return supplied ? supplied(url, options) : response();}});
  return {database, repository, engine, requests, now: () => at, advance: ms => {at += ms;}};
}
function submission(start, at, edits = {}) {
  return {attempt_id: start.attempt_id, account: {address: alias, chain: '-239', walletStateInit: 'synthetic-public-wallet-state', publicKey: '11'.repeat(32)},
    proof: {timestamp: Math.floor(at / 1000), domain: {lengthBytes: 13, value: 'marketapp.org'}, payload: start.challenge, signature: Buffer.alloc(64, 1).toString('base64')}, ...edits};
}

test('the public wallet initializer is parsed as bounded JSON, never JavaScript', () => {
  assert.equal(parseMarketappChallenge(html(challenge)), challenge);
  assert.equal(parseMarketappChallenge('Wallet . init ( {"ton_proof":"safe"} )'), 'safe');
  for (const malformed of [html(''), html('with a space'), html('x'.repeat(2049)), 'Wallet.init({ton_proof: "synthetic"})',
    'Wallet.init({"ton_proof":"a","ton_proof":"b"})', 'Wallet.init({"ton_proof":"a"});Wallet.init({"ton_proof":"b"})',
    'Wallet.init({"ton_proof":"a"}, attack())', 'Wallet.init({"ton_proof":"a"',
    `Wallet.init({"ton_proof":"safe","padding":"${'x'.repeat(16384)}"})`, '<html>No initializer</html>',
    'Wallet.init({"ton_proof":123})', 'Wallet.init({"ton_proof":"\u0000"})']) assert.throws(() => parseMarketappChallenge(malformed));
});

test('owner authorization precedes database, clock and network for every endpoint', async () => {
  let accesses = 0;
  const engine = createMarketappLoginEngine({ownerTelegramId: 12345, repository: new Proxy({}, {get() {accesses++; return async () => {};}}),
    clock: async () => {accesses++;}, fetch: async () => {accesses++;}});
  for (const unauthorized of [{}, {initData: {user: {id: 67890}}}]) {
    for (const name of ['startMarketappLoginTest', 'finishMarketappLoginTest', 'cancelMarketappLoginTest']) await assert.rejects(engine[name](unauthorized, {}), /Private access denied/);
  }
  assert.equal(accesses, 0);
});

test('start performs one anonymous GET and persists only scoped expiring metadata', async () => {
  const t = setup(); const before = await t.repository.read();
  const start = await t.engine.startMarketappLoginTest(ctx);
  assert.match(start.attempt_id, /^[0-9a-f]{64}$/); assert.equal(start.challenge, challenge);
  assert.equal(start.manifest_url, MARKETAPP_LOGIN_MANIFEST); assert.equal(start.wallet, wallet);
  assert.equal(start.domain, 'marketapp.org'); assert.equal(Date.parse(start.expires_at) - t.now(), 300000);
  assert.equal(t.requests.length, 1); const request = t.requests[0];
  assert.equal(request.url, 'https://marketapp.org/'); assert.equal(request.options.method, 'GET'); assert.equal(request.options.redirect, 'manual');
  assert.deepEqual(request.options.headers, {Accept: 'text/html'}); assert.equal(request.options.timeout, 30000);
  const row = t.database.prepare('SELECT * FROM marketapp_login_attempts').get();
  assert.equal(row.state, 'issued'); assert.equal(row.owner_id, '12345'); assert.equal(row.wallet, wallet);
  assert.equal(row.nonce_fingerprint, createHash('sha256').update(challenge).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(challenge)); assert.deepEqual(await t.repository.read(), before);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1);
  t.database.close();
});

test('matching wallet-proof metadata is single use and expressly unauthenticated', async () => {
  const t = setup(); const before = await t.repository.read(); const start = await t.engine.startMarketappLoginTest(ctx);
  const input = submission(start, t.now()), result = await t.engine.finishMarketappLoginTest(ctx, input);
  assert.equal(result.compatible, true); assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.signature_verified, false); assert.equal(result.authenticated, false); assert.equal(result.analytics_refreshed, false);
  assert.ok(!JSON.stringify(result).includes(challenge)); assert.ok(!JSON.stringify(result).includes(input.proof.signature));
  assert.ok(!JSON.stringify(t.database.prepare('SELECT * FROM marketapp_login_attempts').get()).includes(input.account.walletStateInit));
  const audit = JSON.parse(t.database.prepare('SELECT outcome_json FROM marketapp_login_attempts').get().outcome_json);
  assert.deepEqual(audit, {compatible: true, checks: result.checks, finished_at: new Date(t.now()).toISOString()});
  assert.deepEqual(Object.keys(audit), ['compatible', 'checks', 'finished_at']);
  await assert.rejects(t.engine.finishMarketappLoginTest(ctx, input), /expired or was already used/);
  assert.equal(t.requests.length, 1); assert.deepEqual(await t.repository.read(), before); t.database.close();
});

test('concurrent finishes cannot both consume the same attempt', async () => {
  const t = setup(), start = await t.engine.startMarketappLoginTest(ctx), input = submission(start, t.now());
  const results = await Promise.allSettled([t.engine.finishMarketappLoginTest(ctx, input), t.engine.finishMarketappLoginTest(ctx, input)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1); t.database.close();
});

test('mismatched identity, chain, nonce, domain, timestamp and signature never establish compatibility', async () => {
  const mutations = [
    [input => {input.account.address = otherWallet;}, 'wallet_matches'],
    [input => {input.account.address = alias.slice(0, -1) + 'A';}, 'wallet_matches'],
    [input => {input.account.chain = '-3';}, 'mainnet'],
    [input => {input.proof.payload = 'different-synthetic-challenge';}, 'challenge_matches'],
    [input => {input.proof.domain.value = 'evil.marketapp.org';}, 'domain_matches'],
    [input => {input.proof.domain.lengthBytes = 12;}, 'domain_matches'],
    [input => {input.proof.timestamp -= 60;}, 'timestamp_fresh'],
    [input => {input.proof.timestamp += 60;}, 'timestamp_fresh'],
    [input => {input.proof.signature = 'not-a-signature';}, 'signature_present'],
    [input => {input.proof.signature = 'z'.repeat(86) + '==';}, 'signature_present'],
  ];
  for (const [mutate, check] of mutations) {
    const t = setup(), start = await t.engine.startMarketappLoginTest(ctx), input = submission(start, t.now()); mutate(input);
    const result = await t.engine.finishMarketappLoginTest(ctx, input);
    assert.equal(result.compatible, false); assert.equal(result.checks[check], false); assert.equal(result.signature_verified, false);
    const audit = JSON.parse(t.database.prepare('SELECT outcome_json FROM marketapp_login_attempts').get().outcome_json);
    assert.equal(audit.compatible, false); assert.equal(audit.checks[check], false);
    assert.deepEqual(audit.checks, result.checks);
    await assert.rejects(t.engine.finishMarketappLoginTest(ctx, input), /already used/); t.database.close();
  }
});

test('expires at the exact boundary and a changed saved wallet cannot finish an older attempt', async () => {
  const t = setup(), start = await t.engine.startMarketappLoginTest(ctx);
  t.advance(MARKETAPP_LOGIN_LIMITS.expiry_ms);
  await assert.rejects(t.engine.finishMarketappLoginTest(ctx, submission(start, t.now())), /expired/); t.database.close();
  const changed = setup(), previous = await changed.engine.startMarketappLoginTest(ctx);
  changed.database.prepare('UPDATE cloud_events SET records_json=?').run(JSON.stringify([{kind: 'settings', record: {wallet: otherWallet}}]));
  await assert.rejects(changed.engine.finishMarketappLoginTest(ctx, submission(previous, changed.now())), /expired/); changed.database.close();
});

test('cancellation is owner-scoped, idempotent and does not restore the request allowance', async () => {
  const t = setup(), start = await t.engine.startMarketappLoginTest(ctx);
  await t.repository.cancelMarketappLoginAttempt(start.attempt_id, '67890');
  assert.equal(t.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'issued');
  assert.deepEqual(await t.engine.cancelMarketappLoginTest(ctx, {attempt_id: start.attempt_id}), {cancelled: true});
  await t.engine.cancelMarketappLoginTest(ctx, {attempt_id: start.attempt_id});
  await assert.rejects(t.engine.finishMarketappLoginTest(ctx, submission(start, t.now())), /already used/);
  await assert.rejects(t.engine.startMarketappLoginTest(ctx), /wait/); assert.equal(t.requests.length, 1); t.database.close();
});

test('atomic reservations enforce cooldown and five attempts per rolling hour, including failures', async () => {
  const t = setup({fetch: async () => {throw new Error('synthetic provider secret');}});
  for (let i = 0; i < 5; i++) {await assert.rejects(t.engine.startMarketappLoginTest(ctx), /could not be completed/); t.advance(60000);}
  await assert.rejects(t.engine.startMarketappLoginTest(ctx), /five tests/); assert.equal(t.requests.length, 5);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM marketapp_login_attempts').get().n, 5);
  t.advance(3600000); await assert.rejects(t.engine.startMarketappLoginTest(ctx), /could not be completed/); assert.equal(t.requests.length, 6);
  t.database.close();
  const concurrent = setup(); const results = await Promise.allSettled([concurrent.engine.startMarketappLoginTest(ctx), concurrent.engine.startMarketappLoginTest(ctx)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(concurrent.requests.length, 1); concurrent.database.close();
});

test('rate limits and expiry retain fixed safe machine-readable codes without another provider request', async () => {
  const t = setup(), start = await t.engine.startMarketappLoginTest(ctx);
  await assert.rejects(t.engine.startMarketappLoginTest(ctx), error => {
    assert.equal(error.code, 'MARKETAPP_LOGIN_RATE_LIMIT');
    assert.deepEqual(marketappLoginErrorResponse(error), {error: {code: 'MARKETAPP_LOGIN_RATE_LIMIT'}}); return true;
  });
  assert.equal(t.requests.length, 1); t.advance(300000);
  await assert.rejects(t.engine.finishMarketappLoginTest(ctx, submission(start, t.now())), error => {
    assert.equal(error.code, 'MARKETAPP_LOGIN_EXPIRED');
    assert.deepEqual(marketappLoginErrorResponse(error), {error: {code: 'MARKETAPP_LOGIN_EXPIRED'}}); return true;
  });
  assert.equal(t.requests.length, 1); t.database.close();
});

test('public error envelopes whitelist codes and never mirror provider secrets, raw inputs or messages', async () => {
  const secret = 'synthetic-private-provider-input';
  for (const error of [new Error(secret), {code: secret, message: secret}, new MarketappLoginRequestError(secret, secret)]) {
    assert.deepEqual(marketappLoginErrorResponse(error), {error: {code: 'MARKETAPP_LOGIN_FAILED'}});
    assert.ok(!JSON.stringify(marketappLoginErrorResponse(error)).includes(secret));
  }
  const t = setup({fetch: async () => {throw new Error(secret);}});
  await assert.rejects(t.engine.startMarketappLoginTest(ctx), error => {
    assert.deepEqual(marketappLoginErrorResponse(error), {error: {code: 'MARKETAPP_LOGIN_FAILED'}}); return true;
  });
  await assert.rejects(t.engine.startMarketappLoginTest({}, {}), error => {
    assert.deepEqual(marketappLoginErrorResponse(error), {error: {code: 'MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED'}}); return true;
  });
  await assert.rejects(t.engine.cancelMarketappLoginTest(ctx, {attempt_id: secret}), error => {
    assert.deepEqual(marketappLoginErrorResponse(error), {error: {code: 'MARKETAPP_LOGIN_INVALID_INPUT'}}); return true;
  });
  assert.equal(t.requests.length, 1); t.database.close();
});

test('redirects, non-HTML, excessive or malformed bodies fail without revealing provider content', async () => {
  const failures = [response('synthetic provider secret', {status: 307}), response(html(challenge), {url: 'https://evil.example/'}),
    response(html(challenge), {redirected: true}), response(html(challenge), {headers: {'Content-Type': 'application/json'}}),
    response(html(challenge), {headers: {'Content-Length': '1048577'}}), response('synthetic provider secret'),
    response('x'.repeat(1048577)), response(html(challenge), {body: {async *[Symbol.asyncIterator]() {yield Uint8Array.from([0xc0, 0x80]);}}}),
    response(html(challenge), {body: undefined}), response(html(challenge), {body: {async *[Symbol.asyncIterator]() {yield 'unbounded string';}}}),
  ];
  for (const item of failures) {
    const t = setup({fetch: async () => item});
    await assert.rejects(t.engine.startMarketappLoginTest(ctx), error => error.message === 'The Marketapp connection test could not be completed. Try again later.');
    assert.equal(t.database.prepare('SELECT state,nonce_fingerprint FROM marketapp_login_attempts').get().state, 'cancelled');
    assert.equal(t.database.prepare('SELECT nonce_fingerprint FROM marketapp_login_attempts').get().nonce_fingerprint, null);
    assert.equal(t.requests.length, 1); t.database.close();
  }
});

test('trusted elapsed time rejects a slow provider and rejects unavailable clock before GET', async () => {
  let t; t = setup({fetch: async () => {t.advance(30000); return response();}});
  await assert.rejects(t.engine.startMarketappLoginTest(ctx), /could not be completed/); assert.equal(t.requests.length, 1);
  assert.equal(t.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'cancelled'); t.database.close();
  const safe = setup(); let calls = 0;
  const engine = createMarketappLoginEngine({repository: safe.repository, ownerTelegramId: 12345, clock: async () => {throw new Error('synthetic clock secret');}, fetch: async () => {calls++;}});
  await assert.rejects(engine.startMarketappLoginTest(ctx), /could not be completed/); assert.equal(calls, 0);
  assert.equal(safe.database.prepare('SELECT count(*) AS n FROM marketapp_login_attempts').get().n, 0); safe.database.close();
});

test('slow reservations cannot start HTTP and late issuance or consumption cannot produce success', async () => {
  const reserved = setup(), reserve = reserved.repository.reserveMarketappLoginAttempt;
  reserved.repository.reserveMarketappLoginAttempt = async (...args) => {const result = await reserve(...args); reserved.advance(30000); return result;};
  await assert.rejects(reserved.engine.startMarketappLoginTest(ctx), /could not be completed/);
  assert.equal(reserved.requests.length, 0); reserved.database.close();
  const issued = setup(), issue = issued.repository.issueMarketappLoginAttempt;
  issued.repository.issueMarketappLoginAttempt = async (...args) => {const result = await issue(...args); issued.advance(30000); return result;};
  await assert.rejects(issued.engine.startMarketappLoginTest(ctx), /could not be completed/);
  assert.equal(issued.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'cancelled'); issued.database.close();
  const consumed = setup(), start = await consumed.engine.startMarketappLoginTest(ctx), consume = consumed.repository.consumeMarketappLoginAttempt;
  consumed.repository.consumeMarketappLoginAttempt = async (...args) => {const result = await consume(...args); consumed.advance(300000); return result;};
  await assert.rejects(consumed.engine.finishMarketappLoginTest(ctx, submission(start, consumed.now())), /expired/);
  assert.equal(consumed.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'consumed'); consumed.database.close();
});

test('the nullable diagnostic migration preserves populated attempts and never infers their old outcome', async () => {
  const t = setup({legacyLoginSchema: true}); const baseline = await t.repository.read();
  const rows = [
    ['11'.repeat(32), '12345', wallet, 1, 300001, 'consumed', '22'.repeat(32)],
    ['33'.repeat(32), '12345', wallet, 2, 300002, 'cancelled', null],
  ];
  const insert = t.database.prepare('INSERT INTO marketapp_login_attempts VALUES(?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(...row);
  t.database.exec('ALTER TABLE marketapp_login_attempts ADD COLUMN outcome_json TEXT');
  const after = t.database.prepare('SELECT * FROM marketapp_login_attempts ORDER BY created_at').all();
  assert.deepEqual(after.map(row => Object.values(row).slice(0, 7)), rows);
  assert.ok(after.every(row => row.outcome_json === null));
  assert.deepEqual(await t.repository.read(), baseline);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1);
  assert.equal(t.requests.length, 0); t.database.close();
});

test('diagnostics accept only the fixed boolean projection, owner scope and a single consumed write', async () => {
  const t = setup(), start = await t.engine.startMarketappLoginTest(ctx);
  const checks = {wallet_matches: true, mainnet: true, domain_matches: true, challenge_matches: true, timestamp_fresh: true, signature_present: true};
  const valid = {compatible: true, checks, finished_at: new Date(t.now()).toISOString()};
  assert.equal(await t.repository.recordMarketappLoginOutcome(start.attempt_id, '12345', valid), false, 'issued attempts cannot receive an outcome');
  for (const invalid of [{...valid, payload: challenge}, {...valid, checks: {...checks, signature: 'synthetic signature'}},
    {...valid, checks: {...checks, mainnet: 'true'}}, {...valid, compatible: false}, {...valid, finished_at: 'synthetic private timestamp'},
    {...valid, finished_at: 'x'.repeat(10000)}]) await assert.rejects(t.repository.recordMarketappLoginOutcome(start.attempt_id, '12345', invalid), error => error.message === 'Invalid connection-test diagnostic');
  const result = await t.engine.finishMarketappLoginTest(ctx, submission(start, t.now()));
  const persisted = t.database.prepare('SELECT outcome_json FROM marketapp_login_attempts').get().outcome_json;
  assert.equal(await t.repository.recordMarketappLoginOutcome(start.attempt_id, '67890', valid), false);
  assert.equal(await t.repository.recordMarketappLoginOutcome(start.attempt_id, '12345', valid), false);
  await assert.rejects(t.engine.finishMarketappLoginTest(ctx, submission(start, t.now())), /already used/);
  assert.equal(t.database.prepare('SELECT outcome_json FROM marketapp_login_attempts').get().outcome_json, persisted);
  assert.equal(JSON.parse(persisted).compatible, result.compatible); assert.ok(persisted.length < 512);
  assert.ok(!persisted.includes(challenge) && !persisted.includes(alias) && !persisted.includes(wallet) && !persisted.includes('marketapp.org'));
  assert.equal(t.requests.length, 1); t.database.close();
});

test('invalid, cancelled, expired and pre-check consumed failures keep diagnostics unknown', async () => {
  for (const mode of ['invalid', 'cancelled', 'expired', 'late_consumption']) {
    const t = setup(), start = await t.engine.startMarketappLoginTest(ctx), input = submission(start, t.now());
    if (mode === 'invalid') input.proof.payload = 'x'.repeat(2049);
    if (mode === 'cancelled') await t.engine.cancelMarketappLoginTest(ctx, {attempt_id: start.attempt_id});
    if (mode === 'expired') t.advance(300000);
    if (mode === 'late_consumption') {const consume = t.repository.consumeMarketappLoginAttempt; t.repository.consumeMarketappLoginAttempt = async (...args) => {const result = await consume(...args); t.advance(300000); return result;};}
    await assert.rejects(t.engine.finishMarketappLoginTest(ctx, input), error => error.message.length < 256 && !error.message.includes(input.proof.payload));
    assert.equal(t.database.prepare('SELECT outcome_json FROM marketapp_login_attempts').get().outcome_json, null);
    assert.equal(t.requests.length, 1); t.database.close();
  }
});

test('invalid and oversized inputs do not fetch or persist raw proof, cookie or session fields', async () => {
  const t = setup();
  await assert.rejects(t.engine.startMarketappLoginTest(ctx, {cookie: 'synthetic private cookie'}), /invalid/);
  assert.equal(t.requests.length, 0);
  const start = await t.engine.startMarketappLoginTest(ctx), good = submission(start, t.now());
  for (const input of [{...good, cookie: 'synthetic private cookie'}, {...good, proof: {...good.proof, signature: 'x'.repeat(129)}},
    {...good, proof: {...good.proof, payload: 'x'.repeat(2049)}}, {...good, account: {...good.account, walletStateInit: 'x'.repeat(16385)}},
    {...good, proof: {...good.proof, timestamp: 1.5}}, {...good, account: {...good.account, device: {}}},
    {...good, attempt_id: 'not-an-id'}]) await assert.rejects(t.engine.finishMarketappLoginTest(ctx, input), error => !error.message.includes('synthetic private cookie') && /invalid/.test(error.message));
  assert.equal(t.requests.length, 1); assert.equal(t.database.prepare('SELECT state FROM marketapp_login_attempts').get().state, 'issued');
  assert.equal((await t.engine.finishMarketappLoginTest(ctx, good)).compatible, true); t.database.close();
  const missing = setup({records: []}); await assert.rejects(missing.engine.startMarketappLoginTest(ctx), /mainnet wallet/); assert.equal(missing.requests.length, 0); missing.database.close();
});
