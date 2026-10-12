import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';

const owner = '101', wallet = `0:${'11'.repeat(32)}`, at = '2026-10-11T12:00:00.000Z';
const snapshot = {fingerprint: 'ab'.repeat(32), wallet, captured_at: at, daily: [{date: '2026-10-11', rent_volume: '1.2'}]};
const full = () => Error('Sqlite query failed (commit) [13] database or disk is full');
function fixture(t, {cache = true, failure = full(), repeatFailure = null, onEvict = null, evictionFailure = null} = {}) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,records_json TEXT,raw_body TEXT,state_json TEXT);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT PRIMARY KEY,wallet TEXT,captured_at TEXT,imported_at TEXT,raw_snapshot TEXT,normalized_json TEXT);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER,cookie_version INTEGER,wallet TEXT,wallet_revision INTEGER,ciphertext TEXT);
    CREATE TABLE dashboard_projection_cache(selection_key TEXT PRIMARY KEY,records_revision INTEGER,time_bucket INTEGER,snapshot_json TEXT);`);
  database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?)').run(1, JSON.stringify([{kind: 'settings', record: {wallet}}]), 'retained source evidence', 'retained checkpoint');
  database.prepare('INSERT INTO personal_rental_analytics VALUES(?,?,?,?,?,?)').run('old', wallet, '2026-10-10T12:00:00.000Z', '2026-10-10T12:00:00.000Z', 'retained raw snapshot', '{}');
  database.prepare('INSERT INTO marketapp_analytics_sessions VALUES(?,?,?,?,?,?)').run(owner, 3, 5, wallet, 1, 'retained encrypted login');
  if (cache) for (const key of ['m:replaceable', 'p:replaceable:0']) database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run(key, 1, 1, 'derived projection');
  const inserts = [], evictions = [], before = {
    events: database.prepare('SELECT * FROM cloud_events').all(),
    snapshots: database.prepare('SELECT * FROM personal_rental_analytics').all(),
    sessions: database.prepare('SELECT * FROM marketapp_analytics_sessions').all(),
  };
  const db = {
    async get(sql, args = {}) {return database.prepare(sql).get(args) ?? null;},
    async run(sql, args = {}) {
      if (/^INSERT OR IGNORE INTO personal_rental_analytics/.test(sql)) {
        inserts.push({sql, args});
        if (inserts.length === 1) throw failure;
        if (repeatFailure) throw repeatFailure;
      }
      if (sql === 'DELETE FROM dashboard_projection_cache') {
        evictions.push(sql);
        if (evictionFailure) throw evictionFailure;
        if (onEvict) await onEvict(database);
      }
      return {rowsAffected: Number(database.prepare(sql).run(args).changes)};
    },
  };
  const repository = createCloudRepository(db);
  return {database, repository, before, inserts, evictions, failure,
    import: () => repository.importPersonalAnalyticsFenced(snapshot, 'validated new snapshot', at, owner, {generation: 3, wallet_revision: 1}, 5)};
}
function unchanged(f) {
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events').all(), f.before.events);
  assert.deepEqual(f.database.prepare('SELECT * FROM personal_rental_analytics WHERE fingerprint=\'old\'').all(), f.before.snapshots);
}

test('private analytics full-storage recovery evicts only derived cache and retries the identical fenced insert once', async t => {
  const f = fixture(t); assert.equal(await f.import(), true);
  assert.equal(f.inserts.length, 2); assert.equal(f.inserts[0].sql, f.inserts[1].sql);
  assert.strictEqual(f.inserts[0].args, f.inserts[1].args, 'The same immutable values and fence are retried');
  assert.deepEqual(f.evictions, ['DELETE FROM dashboard_projection_cache']);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 2);
  assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.before.sessions); unchanged(f);
});

test('storage-full recovery does not retry when the replaceable cache is empty', async t => {
  const f = fixture(t, {cache: false}); await assert.rejects(f.import(), error => error === f.failure);
  assert.equal(f.inserts.length, 1); assert.equal(f.evictions.length, 1);
  assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.before.sessions); unchanged(f);
});

test('a revoked logout, wallet or cookie fence during cache eviction prevents the retried snapshot insertion', async t => {
  for (const revoke of [
    database => database.prepare('UPDATE marketapp_analytics_sessions SET generation=generation+1').run(),
    database => database.prepare('UPDATE marketapp_analytics_sessions SET cookie_version=cookie_version+1').run(),
    database => database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?)').run(2, JSON.stringify([{kind: 'settings', record: {wallet: 'changed-wallet'}}]), null, '{}'),
  ]) {
    const f = fixture(t, {onEvict: revoke}); assert.equal(await f.import(), false);
    assert.equal(f.inserts.length, 2); assert.strictEqual(f.inserts[0].args, f.inserts[1].args);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1);
    assert.deepEqual(f.database.prepare('SELECT * FROM personal_rental_analytics').all(), f.before.snapshots);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n, 0);
  }
});

test('unrelated insert errors neither evict projections nor trigger any snapshot retry', async t => {
  for (const failure of [Error('database is locked'), Error('query timeout'), Error('Storage is full'), Error('no such table: personal_rental_analytics')]) {
    const f = fixture(t, {failure}); await assert.rejects(f.import(), error => error === failure);
    assert.equal(f.inserts.length, 1); assert.equal(f.evictions.length, 0);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n, 2);
    assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.before.sessions); unchanged(f);
  }
});

test('repeated storage-full errors fail after one retry without further cleanup or changes to source data', async t => {
  const repeated = full(), f = fixture(t, {repeatFailure: repeated}); await assert.rejects(f.import(), error => error === repeated);
  assert.equal(f.inserts.length, 2); assert.equal(f.evictions.length, 1);
  assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.before.sessions); unchanged(f);
});

test('an eviction failure preserves the original storage-full error and does not retry or remove source evidence', async t => {
  const f = fixture(t, {evictionFailure: Error('cache delete unavailable')}); await assert.rejects(f.import(), error => error === f.failure);
  assert.equal(f.inserts.length, 1); assert.equal(f.evictions.length, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n, 2);
  assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.before.sessions); unchanged(f);
});
