import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createMarketappRefreshStatusEngine, safeMarketappRefreshOutcome} from '../tgcloud/lib/marketapp-refresh-status.js';
import {marketappRefreshErrorResponse} from '../tgcloud/lib/marketapp-analytics-refresh.js';
import {configuredAnalyticsWallet, normalizePersonalAnalytics} from '../tgcloud/lib/personal-analytics.js';
import {syntheticAnalyticsPage, syntheticFriendly, syntheticWallet as wallet} from './fixtures/marketapp-analytics-page-fixture.mjs';

const owner = '12345', ctx = {initData: {user: {id: 12345}}}, base = Date.parse('2026-10-09T12:00:00Z');
const id = 'a'.repeat(64), otherWallet = `0:${'22'.repeat(32)}`;
const iso = offset => new Date(base + offset).toISOString();
const snapshotRaw = JSON.stringify(syntheticAnalyticsPage().snapshot), snapshot = normalizePersonalAnalytics(snapshotRaw, wallet), fingerprint = snapshot.fingerprint;
function outcome(state = 'awaiting_approval', offset = 0, extras = {}) {
  const stage = {awaiting_approval: 'prepare', updating: 'authenticate', saved: 'complete', failed: 'validate_analytics'}[state];
  return {version: 1, flow: 'analytics_refresh', state, stage, code: state === 'failed' ? 'MARKETAPP_REFRESH_PAGE_CHANGED' : null,
    observed_at: iso(offset), period_days: 30, authenticated: ['saved', 'failed'].includes(state), analytics_refreshed: state === 'saved',
    ...(state === 'saved' ? {snapshot_fingerprint: fingerprint} : {}), ...extras};
}
function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE marketapp_login_attempts(attempt_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,wallet TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,nonce_fingerprint TEXT,outcome_json TEXT);
    CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT PRIMARY KEY,wallet TEXT NOT NULL,captured_at TEXT NOT NULL,imported_at TEXT NOT NULL,raw_snapshot TEXT NOT NULL,normalized_json TEXT NOT NULL);`);
  const originalState = {version: 2, next_job_id: 7, attempts: [base], next_allowed_at: base + 5000};
  database.prepare('INSERT INTO cloud_events VALUES(1,?,?,?,?,?,?,?)').run('seed', JSON.stringify(originalState), null, null,
    JSON.stringify([{kind: 'settings', record: {wallet}}]), null, iso(0));
  let now = base, writes = 0;
  const db = {async get(sql, params = {}) {return database.prepare(sql).get(params) || null;},
    async all(sql, params = {}) {return database.prepare(sql).all(params);},
    async run(sql, params = {}) {writes++; return {rowsAffected: Number(database.prepare(sql).run(params).changes)};}};
  const repository = createCloudRepository(db);
  const engine = createMarketappRefreshStatusEngine({repository, ownerTelegramId: owner, clock: async () => now});
  const seedSnapshot = ({snapshotFingerprint = fingerprint, rowWallet = wallet, importedAt = iso(2000)} = {}) => {
    database.prepare('INSERT OR IGNORE INTO personal_rental_analytics VALUES(?,?,?,?,?,?)').run(snapshotFingerprint, rowWallet, snapshot.captured_at, importedAt, snapshotRaw, JSON.stringify(snapshot));
  };
  const seed = ({attemptId = id, rowOwner = owner, rowWallet = wallet, state = 'issued', created = base,
    expires = base + 300000, audit = null, withSnapshot = audit?.state === 'saved'} = {}) => {
    database.prepare('INSERT INTO marketapp_login_attempts VALUES(?,?,?,?,?,?,?,?)').run(attemptId, rowOwner, rowWallet, created, expires, state,
      'synthetic-private-nonce-fingerprint', typeof audit === 'string' ? audit : audit === null ? null : JSON.stringify(audit));
    if (withSnapshot) seedSnapshot({rowWallet});
  };
  return {database, repository, engine, seed, seedSnapshot, originalState, setNow(value) {now = value;}, get writes() {return writes;},
    read: () => engine.getMarketappAnalyticsRefreshStatus(ctx), stored: (attemptId = id) => database.prepare('SELECT outcome_json,state FROM marketapp_login_attempts WHERE attempt_id=?').get(attemptId)};
}

test('status authorizes and validates input before any database or clock access', async () => {
  let accesses = 0;
  const engine = createMarketappRefreshStatusEngine({ownerTelegramId: owner,
    repository: new Proxy({}, {get() {accesses++; return async () => {};}}), clock: async () => {accesses++; return base;}});
  for (const context of [undefined, {}, {initData: {user: {id: 7}}}]) {
    await assert.rejects(engine.getMarketappAnalyticsRefreshStatus(context), error => {
      assert.deepEqual(marketappRefreshErrorResponse(error), {error: {code: 'MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED'}}); return true;
    });
  }
  for (const input of [null, false, [], {cookie: 'synthetic-private-cookie'}, {attempt_id: id}]) {
    await assert.rejects(engine.getMarketappAnalyticsRefreshStatus(ctx, input), error => {
      assert.deepEqual(marketappRefreshErrorResponse(error), {error: {code: 'MARKETAPP_REFRESH_INVALID_INPUT'}}); return true;
    });
  }
  assert.equal(accesses, 0);
});

test('outcome accepts only bounded fixed metadata with coherent state and authentication flags', () => {
  for (const state of ['awaiting_approval', 'updating', 'saved', 'failed']) assert.deepEqual(safeMarketappRefreshOutcome(outcome(state)), outcome(state));
  const reason = outcome('failed', 0, {diagnostic_reason: 'analytics_shape'}); assert.deepEqual(safeMarketappRefreshOutcome(reason), reason);
  for (const edit of [{version: 2}, {flow: 'other'}, {state: 'consumed'}, {stage: 'raw-provider-message'}, {period_days: 90},
    {observed_at: '2026-02-30T00:00:00.000Z'}, {observed_at: '2026-10-09T12:00:00+00:00'}, {observed_at: 'not a timestamp'},
    {authenticated: 'true'}, {analytics_refreshed: 1}, {cookie: 'synthetic-cookie'}, {proof: 'synthetic-proof'}, {html: 'synthetic-html'},
    {wallet}, {code: 'SYNTHETIC_PRIVATE_ERROR'}, {diagnostic_reason: 'synthetic-cookie'}]) assert.equal(safeMarketappRefreshOutcome({...outcome('failed'), ...edit}), null);
  for (const edit of [{stage: 'save_snapshot'}, {authenticated: false}, {analytics_refreshed: false}, {code: 'MARKETAPP_REFRESH_FAILED'}])
    assert.equal(safeMarketappRefreshOutcome({...outcome('saved'), ...edit}), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('awaiting_approval', 0, {authenticated: true})), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('updating', 0, {stage: 'prepare'})), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('updating', 0, {stage: 'fetch_analytics', authenticated: false})), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('updating', 0, {diagnostic_reason: 'page_structure'})), null);
  for (const snapshot_fingerprint of [null, 'b'.repeat(63), 'B'.repeat(64), 'synthetic-private-content', [fingerprint],
    {toString: () => fingerprint, cookie: 'synthetic-private-cookie'}])
    assert.equal(safeMarketappRefreshOutcome({...outcome('saved'), snapshot_fingerprint}), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('updating', 0, {snapshot_fingerprint: fingerprint})), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('failed', 0, {snapshot_fingerprint: fingerprint})), null);
  assert.equal(safeMarketappRefreshOutcome(outcome('saved', 0, {snapshot_fingerprint: undefined})), null);
  assert.equal(safeMarketappRefreshOutcome(null), null); assert.equal(safeMarketappRefreshOutcome([]), null);
});

test('repository rejects private diagnostic fields before SQL and scopes writes to owner', async () => {
  const t = setup(); t.seed({state: 'consumed'});
  for (const field of ['cookie', 'proof', 'signature', 'account', 'message', 'html']) {
    await assert.rejects(t.repository.recordMarketappRefreshOutcome(id, owner, {...outcome('saved'), [field]: 'synthetic-private-value'}), /Invalid analytics-refresh diagnostic/);
  }
  assert.equal(t.writes, 0); assert.equal(t.stored().outcome_json, null);
  assert.equal(await t.repository.recordMarketappRefreshOutcome(id, 'other-owner', outcome('saved')), false);
  assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome('saved')), true);
  assert.equal(t.stored().outcome_json.includes('synthetic-private'), false); t.database.close();
});

test('issued, consumed and cancelled attempt states limit which audit writes are possible', async () => {
  for (const state of ['pending', 'issued', 'consumed', 'cancelled']) {
    const t = setup(); t.seed({state});
    for (const auditState of ['awaiting_approval', 'updating', 'saved', 'failed']) {
      t.database.prepare('UPDATE marketapp_login_attempts SET outcome_json=NULL WHERE attempt_id=?').run(id);
      const expected = auditState === 'awaiting_approval' ? state === 'issued' : ['updating', 'saved'].includes(auditState) ? state === 'consumed' : ['consumed', 'cancelled'].includes(state);
      assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome(auditState)), expected, `${state} / ${auditState}`);
    }
    t.database.close();
  }
});

test('progress audit writes advance by observation time and terminal outcomes cannot be overwritten', async () => {
  for (const terminal of ['saved', 'failed']) {
    const t = setup(); t.seed({audit: outcome()});
    assert.equal(await t.repository.consumeMarketappLoginAttempt(id, owner, wallet, base + 1000), true);
    assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome('updating', 1000)), true);
    assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome('updating', 999)), false);
    assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome(terminal, 2000)), true);
    const stored = t.stored().outcome_json;
    for (const later of ['saved', 'failed', 'updating']) assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome(later, 3000)), false);
    assert.equal(t.stored().outcome_json, stored); t.database.close();
  }
});

test('legacy proof diagnostics never become refresh status or accept refresh overwrites', async () => {
  const t = setup(); t.seed({state: 'consumed', audit: {compatible: true, checks: {}, finished_at: iso(0)}});
  t.seed({attemptId: 'b'.repeat(64), state: 'consumed', created: base + 1000, audit: null});
  assert.equal(await t.repository.recordMarketappRefreshOutcome(id, owner, outcome('saved')), false);
  assert.deepEqual(await t.read(), {attempt: null}); t.database.close();
});

test('status reveals only its fixed result projection and is separate from collection allowances', async () => {
  const t = setup(); t.seed({state: 'consumed', audit: outcome('failed', 0, {diagnostic_reason: 'analytics_shape'})});
  const before = JSON.stringify(t.database.prepare('SELECT * FROM marketapp_login_attempts').all());
  const result = await t.read();
  assert.deepEqual(result, {attempt: {attempt_id: id, state: 'failed', period_days: 30, updated_at: iso(0), error_code: 'MARKETAPP_REFRESH_PAGE_CHANGED'}});
  assert.equal(JSON.stringify(result).includes('nonce'), false); assert.equal(JSON.stringify(result).includes(wallet), false);
  assert.equal(JSON.stringify(result).includes('diagnostic_reason'), false); assert.equal(JSON.stringify(result).includes('authenticated'), false);
  assert.equal(JSON.stringify(result).includes('snapshot_fingerprint'), false);
  assert.equal(t.writes, 0); assert.equal(JSON.stringify(t.database.prepare('SELECT * FROM marketapp_login_attempts').all()), before);
  assert.deepEqual((await t.repository.read()).state, t.originalState); assert.equal(t.database.prepare('SELECT count(*) AS total FROM cloud_events').get().total, 1);
  t.database.close();
});

test('status isolates wallet and owner and ignores newer NULL/legacy/malformed diagnostics', async () => {
  const t = setup(); t.seed({state: 'consumed', audit: outcome('saved')});
  t.seed({attemptId: 'b'.repeat(64), rowOwner: 'other-owner', state: 'consumed', created: base + 1000, audit: outcome('failed', 1000)});
  t.seed({attemptId: 'c'.repeat(64), rowWallet: otherWallet, state: 'consumed', created: base + 2000, audit: outcome('failed', 2000)});
  t.seed({attemptId: 'd'.repeat(64), state: 'consumed', created: base + 3000, audit: null});
  t.seed({attemptId: 'e'.repeat(64), state: 'consumed', created: base + 4000, audit: {compatible: true}});
  t.seed({attemptId: 'f'.repeat(64), state: 'consumed', created: base + 5000, audit: 'invalid json synthetic private text'});
  assert.equal((await t.read()).attempt.attempt_id, id);
  t.database.prepare('UPDATE cloud_events SET records_json=?').run(JSON.stringify([{kind: 'settings', record: {wallet: otherWallet}}]));
  assert.equal((await t.read()).attempt.attempt_id, 'c'.repeat(64));
  t.database.prepare('UPDATE cloud_events SET records_json=?').run(JSON.stringify([{kind: 'settings', record: {wallet: 'invalid'}}]));
  assert.deepEqual(await t.read(), {attempt: null}); t.database.close();
});

test('malformed refresh metadata or attempt identifiers remain unknown rather than fabricated success', async () => {
  for (const audit of [{...outcome('saved'), cookie: 'synthetic private cookie'}, {...outcome('saved'), authenticated: false}, {...outcome('failed'), code: 'arbitrary provider text'}]) {
    const t = setup(); t.seed({state: 'consumed', audit}); assert.deepEqual(await t.read(), {attempt: null}); t.database.close();
  }
  const t = setup(); t.seed({attemptId: 'invalid-private-attempt', state: 'consumed', audit: outcome('saved')}); assert.deepEqual(await t.read(), {attempt: null}); t.database.close();
});

test('cancellation and exact expiry have distinct read-only status', async () => {
  const cancelled = setup(); cancelled.seed({audit: outcome()}); await cancelled.repository.cancelMarketappLoginAttempt(id, owner);
  const writes = cancelled.writes; cancelled.setNow(base + 300000);
  assert.equal((await cancelled.read()).attempt.state, 'cancelled'); assert.equal(cancelled.writes, writes); cancelled.database.close();
  const expired = setup(); expired.seed({audit: outcome()}); expired.setNow(base + 299999); assert.equal((await expired.read()).attempt.state, 'awaiting_approval');
  expired.setNow(base + 300000); assert.equal((await expired.read()).attempt.state, 'expired'); assert.equal(expired.writes, 0); expired.database.close();
});

test('consumption alone is updating evidence, never authentication or a completed analytics save', async () => {
  const t = setup(); t.seed({state: 'consumed', audit: outcome()});
  assert.equal((await t.read()).attempt.state, 'updating');
  t.setNow(base + 119999); assert.equal((await t.read()).attempt.state, 'updating');
  t.setNow(base + 120000); assert.equal((await t.read()).attempt.state, 'updating');
  t.setNow(base + 299999); assert.equal((await t.read()).attempt.state, 'updating');
  t.setNow(base + 300000); assert.deepEqual((await t.read()).attempt, {attempt_id: id, state: 'expired', period_days: 30, updated_at: iso(0)});
  assert.equal(JSON.parse(t.stored().outcome_json).state, 'awaiting_approval'); assert.equal(t.writes, 0); t.database.close();
});

test('a committed exact snapshot recovers the crash gap after import without a final success audit', async () => {
  for (const state of ['updating', 'failed', 'saved']) {
    const t = setup();
    const audit = state === 'saved' ? outcome('saved') : outcome(state, 1000, {stage: 'save_snapshot', authenticated: true, snapshot_fingerprint: fingerprint});
    t.seed({state: 'consumed', audit, withSnapshot: false});
    t.seedSnapshot({importedAt: iso(2000)}); t.setNow(base + 3600000);
    assert.deepEqual((await t.read()).attempt, {attempt_id: id, state: 'saved', period_days: 30, updated_at: iso(2000)});
    assert.equal(t.writes, 0); assert.equal(JSON.parse(t.stored().outcome_json).state, state);
    assert.equal(JSON.stringify(await t.read()).includes(fingerprint), false); t.database.close();
  }
});

test('a planned fingerprint without a matching wallet-scoped snapshot never proves a save', async () => {
  for (const wrong of [{snapshotFingerprint: 'b'.repeat(64)}, {rowWallet: otherWallet}]) {
    const t = setup(); t.seed({state: 'consumed', audit: outcome('updating', 1000, {stage: 'save_snapshot', authenticated: true, snapshot_fingerprint: fingerprint})});
    t.seedSnapshot(wrong); t.setNow(base + 1001);
    assert.equal((await t.read()).attempt.state, 'updating');
    t.setNow(base + 121000); assert.equal((await t.read()).attempt.state, 'failed'); t.database.close();
  }
  const missing = setup(); missing.seed({state: 'consumed', audit: outcome('saved'), withSnapshot: false});
  assert.equal((await missing.read()).attempt.error_code, 'MARKETAPP_REFRESH_FAILED'); missing.database.close();
});

test('malformed imported timestamps cannot recover a saved result from progress metadata', async () => {
  for (const importedAt of ['2026-10-09', '2026-10-09T12:00:00+00:00', '2026-02-30T00:00:00.000Z', 'invalid-private-value']) {
    const t = setup(); t.seed({state: 'consumed', audit: outcome('updating', 1000, {stage: 'save_snapshot', authenticated: true, snapshot_fingerprint: fingerprint})});
    t.seedSnapshot({importedAt}); t.setNow(base + 2000); assert.equal((await t.read()).attempt.state, 'updating'); t.database.close();
  }
});

test('stalled updates and expiry return generic failure without overwriting stored progress', async () => {
  const t = setup(); t.seed({state: 'consumed', audit: outcome('updating', 100000, {stage: 'fetch_analytics', authenticated: true})});
  t.setNow(base + 219999); assert.equal((await t.read()).attempt.state, 'updating');
  t.setNow(base + 220000); assert.equal((await t.read()).attempt.error_code, 'MARKETAPP_REFRESH_FAILED');
  assert.equal(JSON.parse(t.stored().outcome_json).state, 'updating');
  t.database.prepare('UPDATE marketapp_login_attempts SET expires_at=?').run(base + 100001); t.setNow(base + 100001);
  assert.equal((await t.read()).attempt.state, 'failed'); assert.equal(t.writes, 0); t.database.close();
});

test('terminal saved and failed states survive lease expiry without changing the allowance ledger', async () => {
  for (const state of ['saved', 'failed']) {
    const t = setup(); t.seed({state: 'consumed', audit: outcome(state)}); t.setNow(base + 3600000);
    assert.equal((await t.read()).attempt.state, state); assert.equal(t.writes, 0); t.database.close();
  }
});

test('invalid server clocks return a fixed error without exposing stored metadata', async () => {
  for (const at of [0, NaN, Infinity, 'synthetic-private-clock']) {
    const t = setup(); t.seed({audit: outcome()}); t.setNow(at);
    await assert.rejects(t.read(), error => {assert.deepEqual(marketappRefreshErrorResponse(error), {error: {code: 'MARKETAPP_REFRESH_FAILED'}}); return true;});
    t.database.close();
  }
});

test('wallet-only settings projection preserves timeline, alias precedence, explicit null and omitted fields', async () => {
  const t = setup(); let sequence = 1;
  const events = [
    [{kind: 'listing', record: {wallet: otherWallet, api_key: 'synthetic-secret', value: 'irrelevant'}},
      {kind: 'settings', record: {wallet_address: otherWallet, api_key: 'synthetic-secret'}}],
    [{kind: 'settings', record: {wallet: null}}],
    [{kind: 'settings', record: {wallet_address: null}}],
    [{kind: 'settings', record: {wallet_address: syntheticFriendly(wallet, 0x51)}}],
    [{kind: 'settings', record: {wallet: otherWallet}}, {kind: 'settings', record: {wallet}}],
    [{kind: 'history', record: {wallet: otherWallet}}, {kind: 'settings', record: {label: 'synthetic-private-label'}}],
    [{kind: 'settings', record: {wallet: false, wallet_address: otherWallet}}],
    [{kind: 'settings', record: {wallet: null}}],
    [{kind: 'settings', record: {}}],
    [{kind: 'settings', record: {wallet_address: 'invalid-address'}}],
    [{kind: 'settings', record: {wallet: otherWallet}}],
  ];
  const expected = [wallet, otherWallet, null, wallet, wallet, wallet, null, otherWallet, otherWallet, null, otherWallet];
  for (const [index, records] of events.entries()) {
    const next = ++sequence;
    t.database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(next, 'settings-' + next, JSON.stringify(t.originalState), null, null,
      JSON.stringify(records), null, iso(next));
    const full = await t.repository.records(), projected = await t.repository.analyticsWalletRecords();
    assert.equal(configuredAnalyticsWallet(projected), configuredAnalyticsWallet(full));
    assert.equal(configuredAnalyticsWallet(projected), expected[index]);
    for (const row of projected) {
      assert.deepEqual(Object.keys(row).sort(), ['kind', 'record']); assert.equal(row.kind, 'settings');
      assert.ok(Object.keys(row.record).every(key => ['wallet', 'wallet_address'].includes(key)));
    }
    assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
    assert.equal(JSON.stringify(projected).includes('synthetic-private-label'), false);
  }
  const projected = await t.repository.analyticsWalletRecords();
  assert.equal(Object.hasOwn(projected[1].record, 'wallet'), false);
  assert.equal(Object.hasOwn(projected[2].record, 'wallet'), true); assert.equal(projected[2].record.wallet, null);
  assert.equal(Object.hasOwn(projected[3].record, 'wallet_address'), true); assert.equal(projected[3].record.wallet_address, null);
  assert.deepEqual(projected[10].record, {}); t.database.close();
});

test('status uses the wallet projection without loading unrelated portfolio or comparison records', async () => {
  const t = setup(); t.seed({state: 'consumed', audit: outcome('saved')});
  t.database.prepare('INSERT INTO cloud_events VALUES(2,?,?,?,?,?,?,?)').run('irrelevant', JSON.stringify(t.originalState), null, null,
    JSON.stringify([{kind: 'listing', record: {api_key: 'synthetic-private-value', value: 'x'.repeat(100000)}}]), null, iso(1));
  t.repository.records = async () => {assert.fail('Status must not load all records');};
  assert.equal((await t.read()).attempt.state, 'saved'); assert.equal(t.writes, 0);
  assert.equal(JSON.stringify(await t.repository.analyticsWalletRecords()).includes('synthetic-private-value'), false); t.database.close();
});
