import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CloudStorageFullError, createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {encodeCheckpoint} from '../tgcloud/lib/checkpoint-storage.js';

test('large imported chunks use bounded host reads and preserve records across sparse event sequences', async () => {
  const rows=Array.from({length:11},(_,i)=>({sequence:i*3+2,records_json:JSON.stringify([{kind:'listing',key:String(i),record:{source_json:'x'.repeat(230000)}}])}));
  const database=new DatabaseSync(':memory:');
  database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,records_json TEXT NOT NULL)');
  for(const row of rows) database.prepare('INSERT INTO cloud_events VALUES(?,?)').run(row.sequence,row.records_json);
  const calls=[];
  const repository=createCloudRepository({async get(){return null;},async all(sql,params){
    const limit=Number(/LIMIT (\d+)/.exec(sql)?.[1]);
    calls.push({after:params[':after'],limit});
    const batch=database.prepare(sql).all(params);
    assert.ok(batch.reduce((n,row)=>n+Buffer.byteLength(row.records_json),0)<=1048576,'each host result remains bounded by bytes as well as row count');
    return batch;
  }});
  const records=await repository.records();
  assert.deepEqual(records.map(record=>record.key),rows.map((_,i)=>String(i)));
  assert.deepEqual(calls.map(call=>call.after),[0,11,23,32]);
  assert.ok(calls.every(call=>call.limit===16));
  database.close();
});

test('an exact multiple of bounded chunks checks the following empty page',async()=>{
  let calls=0;
  const repository=createCloudRepository({async get(){return null;},async all(_sql,params){
    calls++;
    return params[':after']===0?Array.from({length:16},(_,i)=>({sequence:i+1,records_json:JSON.stringify([{key:String(i)}])})):[];
  }});
  assert.equal((await repository.records()).length,16);
  assert.equal(calls,2);
});

test('a legacy oversized first row advances alone and multibyte row budgets use UTF-8 bytes', async () => {
  const database = new DatabaseSync(':memory:'); database.exec('CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,records_json TEXT NOT NULL)');
  const rows = ['x'.repeat(1100000), '🦋'.repeat(140000), '🦋'.repeat(140000)].map((value, i) => ({sequence: i + 1, records_json: JSON.stringify([{key: String(i), value}])}));
  for (const row of rows) database.prepare('INSERT INTO cloud_events VALUES(?,?)').run(row.sequence, row.records_json);
  const batches = []; const repository = createCloudRepository({async get(){return null;},async all(sql, params) {const batch = database.prepare(sql).all(params); batches.push(batch.map(row => row.sequence)); return batch;}});
  assert.deepEqual((await repository.records()).map(row => row.key), ['0', '1', '2']);
  assert.deepEqual(batches, [[1], [2], [3], []]); database.close();
});

function appendFailureFixture(t, failure) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,
    job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);`);
  const state = {version: 2, attempts: [1000, 2000], next_allowed_at: 9000, next_job_id: 10,
    job: {id: 9, state: 'running', lease: 'saved-market-lease', lease_until: 8000, streams: [{cursor: 'opaque /+=?&', complete: false}]},
    owned_prices: {version: 2, attempts: [3000], next_allowed_at: 4000, next_run_id: 45,
      run: {id: 44, wallet: 'saved-wallet', state: 'running', checked: 0, stage: 'before', lease: 'saved-owned-lease', lease_until: 7000,
        targets: [{nft_address: 'saved-nft', collection_address: 'saved-collection', unknown: null}], pending: []}}};
  database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(1, 'saved-reservation', JSON.stringify(state), 9,
    JSON.stringify(state.job), JSON.stringify([{kind: 'listing', record: {price_per_day: '170000001'}}]),
    JSON.stringify({body: 'saved-provider-evidence'}), '2026-10-10T12:00:00Z');
  const before = database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), writes = [];
  const db = {async get(sql, params = {}) {return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {return database.prepare(sql).all(params);},
    async run(sql) {writes.push(sql); throw failure;}};
  const repository = createCloudRepository(db), proposed = structuredClone(state);
  proposed.owned_prices.run.checked = 1; proposed.owned_prices.run.lease = null;
  const event = {key: 'failed-provider-outcome', state: proposed, job: null,
    records: [{kind: 'owned_price', record: {configured_price_per_day_raw: '170000001'}}],
    raw_body: JSON.stringify({body: 'new-provider-evidence'}), observed_at: '2026-10-10T12:00:01Z'};
  return {database, repository, state, before, writes, event};
}

test('a full-database outcome append without evictable cache retains its saved reservation and exposes only a fixed error', async t => {
  const privateDetail = 'synthetic_private_runtime_detail';
  for (const message of [`Sqlite query failed (commit) [13] database or disk is full ${privateDetail}`,
    `DATABASE OR DISK IS FULL ${privateDetail}`]) {
    const f = appendFailureFixture(t, Error(message));
    await assert.rejects(f.repository.append(1, f.event), error => {
      assert.ok(error instanceof CloudStorageFullError);
      assert.equal(error.message, 'Private storage is full. Saved data and progress are retained. Storage maintenance is needed before updating.');
      assert.ok(!error.message.includes(privateDetail));
      return true;
    });
    assert.equal(f.writes.length, 2, 'One cache eviction is attempted; an unsuccessful eviction cannot retry the append');
    assert.match(f.writes[0], /INSERT OR IGNORE INTO cloud_events/);
    assert.equal(f.writes[1], 'DELETE FROM dashboard_projection_cache');
    assert.deepEqual(databaseRows(f.database), f.before, 'No revision, evidence, attempts, lease or cursor advances after a failed commit');
    assert.deepEqual(await f.repository.read(), {revision: 1, state: f.state});
  }
});

function databaseRows(database) {return database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();}

test('unknown append errors retain their original identity and never trigger a speculative retry or storage rewrite', async t => {
  for (const failure of [Error('Database query timed out'), Error('database is locked'), Error('Storage is full but not a SQLite full-database result')]) {
    const f = appendFailureFixture(t, failure);
    await assert.rejects(f.repository.append(1, f.event), error => error === failure);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(databaseRows(f.database), f.before);
    assert.deepEqual(await f.repository.read(), {revision: 1, state: f.state});
  }
});

function sourceHintFixture(t, beforeWrite = null) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,
    job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER,cookie_version INTEGER,
      wallet TEXT,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE dashboard_projection_cache(selection_key TEXT PRIMARY KEY,records_revision INTEGER,time_bucket INTEGER,snapshot_json TEXT);`);
  const state = {version: 2, job: null, attempts: [1000], next_job_id: 1, owned_prices: {version: 2, attempts: [2000, 3000], next_run_id: 5,
    run: {id: 4, wallet: 'saved-wallet', targets: [{nft_address: 'saved-nft', collection_address: 'saved-collection', amount: '0.170000001', unknown: null}], checked: 1}}};
  const target = {sequence: 1, run_id: 4, wallet: 'saved-wallet', targets_json: JSON.stringify(state.owned_prices.run.targets)};
  const stripped = JSON.parse(encodeCheckpoint(state, null, 2, null, target));
  const own = {sequence: 2, owned_prices_json: JSON.stringify(stripped.owned_prices), target_sequence: 1};
  const insert = database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)');
  for (const [sequence, document] of [[1, JSON.stringify(state)], [2, JSON.stringify(stripped)], [3, encodeCheckpoint(state, null, 3, null, target, own)]])
    insert.run(sequence, `source-fixture:${sequence}`, document, null, null, '[]', null, '2026-10-10T12:00:00.000Z');
  database.prepare('INSERT INTO marketapp_analytics_sessions VALUES(?,?,?,?,?,?,?)').run('private-owner', 4, 3, 'saved-wallet', 'synthetic encrypted cookie', 1000, 2000000000000);
  const gets = [];
  const db = {async get(sql, params = {}) {gets.push(sql); return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {return database.prepare(sql).all(params);},
    async run(sql, params = {}) {beforeWrite?.(database, sql, params); return {rowsAffected: Number(database.prepare(sql).run(params).changes)};}};
  const repository = createCloudRepository(db);
  const event = {key: 'next-source-fixture', state, job: null, records: [], observed_at: '2026-10-10T12:00:01.000Z'};
  const stored = {value: {owner: 'private-owner', wallet: 'saved-wallet', cookie_version: 3}, fence: {generation: 4, wallet_revision: 0}};
  return {database, db, repository, state, event, stored, gets};
}

test('both append paths reuse read roots using primary keys and preserve session and CAS fences', async t => {
  for (const website of [false, true]) {
    const f = sourceHintFixture(t), priorRows = databaseRows(f.database);
    assert.deepEqual(await f.repository.read(), {revision: 3, state: f.state}); f.gets.length = 0;
    const append = (expected, event, stored = f.stored) => website
      ? f.repository.appendWebsite(expected, event, 'private-owner', stored) : f.repository.append(expected, event);
    assert.equal(await append(3, f.event), true);
    assert.equal(f.gets.length, 2); assert.ok(f.gets.every(sql => /WHERE sequence=:sequence/.test(sql)));
    assert.deepEqual(databaseRows(f.database).slice(0, 3), priorRows, 'Historical roots and evidence remain byte-identical');
    assert.deepEqual((await f.repository.read()).state, f.state);
    assert.equal(await append(3, {...f.event, key: 'stale-source-fixture'}), false);
    assert.equal(f.database.prepare('SELECT MAX(sequence) AS revision FROM cloud_events').get().revision, 4);
    if (website) {
      f.database.prepare('UPDATE marketapp_analytics_sessions SET generation=generation+1').run();
      assert.equal(await append(4, {...f.event, key: 'disconnected-source-fixture'}), false);
    }
  }
});

test('publication rechecks exact target and owned roots if they change after a hinted lookup', async t => {
  const mutateRoot = (database, sequence, change) => {
    const value = JSON.parse(database.prepare('SELECT state_json FROM cloud_events WHERE sequence=?').get(sequence).state_json);
    change(value); database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=?').run(JSON.stringify(value), sequence);
  };
  const races = [
    database => mutateRoot(database, 1, value => value.owned_prices.run.id++),
    database => mutateRoot(database, 1, value => value.owned_prices.run.wallet = 'another-wallet'),
    database => mutateRoot(database, 1, value => value.owned_prices.run.targets[0].amount = '0.170000002'),
    database => database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run('{malformed'),
    database => {const value = database.prepare('SELECT state_json FROM cloud_events WHERE sequence=1').get().state_json;
      database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run(value.replace('"wallet":', '"wallet":"duplicate-wallet","wallet":'));},
    database => database.prepare('DELETE FROM cloud_events WHERE sequence=1').run(),
    database => mutateRoot(database, 2, value => value.owned_prices.attempts.push(4444)),
    database => mutateRoot(database, 2, value => value.__checkpoint_owned_targets_sequence = 2),
    database => {const value = database.prepare('SELECT state_json FROM cloud_events WHERE sequence=2').get().state_json;
      database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=2').run(value.replace('"owned_prices":', '"owned_prices":{},"owned_prices":'));},
    database => database.prepare('DELETE FROM cloud_events WHERE sequence=2').run(),
  ];
  for (const website of [false, true]) for (const race of races) {
    const f = sourceHintFixture(t, database => race(database)); await f.repository.read();
    const result = website ? await f.repository.appendWebsite(3, f.event, 'private-owner', f.stored) : await f.repository.append(3, f.event);
    assert.equal(result, false, 'Concurrent source changes cannot publish a stale or invalid checkpoint reference');
    assert.equal(f.database.prepare('SELECT MAX(sequence) AS revision FROM cloud_events').get().revision, 3);
    assert.equal(f.database.prepare('SELECT count(*) AS events FROM cloud_events WHERE event_key=?').get(f.event.key).events, 0);
  }
});

const sqliteFull = () => Error('Sqlite query failed (commit) [13] database or disk is full synthetic-private-detail');
function cacheRecoveryFixture(t, {cache = true, failure = sqliteFull(), repeatFailure = null, onEvict = null, evictionFailure = null, evictionResult = null} = {}) {
  const f = sourceHintFixture(t);
  if (cache) for (const key of ['m:replaceable', 'p:replaceable:0']) f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run(key, 3, 1, 'derived dashboard projection');
  const beforeRows = databaseRows(f.database), beforeSessions = f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all();
  const inserts = [], evictions = [];
  const repository = createCloudRepository({...f.db, async run(sql, parameters = {}) {
    if (/^INSERT OR IGNORE INTO cloud_events/.test(sql)) {
      inserts.push({sql, parameters});
      if (inserts.length === 1) throw failure;
      if (repeatFailure) throw repeatFailure;
    }
    if (sql === 'DELETE FROM dashboard_projection_cache') {
      evictions.push(sql);
      if (evictionFailure) throw evictionFailure;
      onEvict?.(f.database);
      if (evictionResult) return evictionResult;
    }
    return await f.db.run(sql, parameters);
  }});
  const event = {...f.event, records: [{kind: 'history', record: {price: '0.170000001', price_nano: '170000001', tx_hash: null}}], raw_body: '{"provider":"retained-new-evidence"}'};
  return {...f, repository, beforeRows, beforeSessions, inserts, evictions, failure, event,
    async append(website) {
      await repository.read();
      return website ? await repository.appendWebsite(3, event, 'private-owner', f.stored) : await repository.append(3, event, 0);
    }};
}

test('both checkpoint append paths recover full storage by retrying only the identical fenced insert after cache eviction', async t => {
  for (const website of [false, true]) {
    const f = cacheRecoveryFixture(t); assert.equal(await f.append(website), true);
    assert.equal(f.inserts.length, 2); assert.equal(f.inserts[0].sql, f.inserts[1].sql);
    assert.strictEqual(f.inserts[0].parameters, f.inserts[1].parameters, 'No values, observation times or fences are recomputed');
    assert.deepEqual(f.evictions, ['DELETE FROM dashboard_projection_cache']);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n, 0);
    assert.deepEqual(databaseRows(f.database).slice(0, 3), f.beforeRows);
    assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.beforeSessions);
    const committed = f.database.prepare('SELECT * FROM cloud_events WHERE sequence=4').get();
    assert.equal(committed.raw_body, null); assert.equal(committed.records_json, JSON.stringify(f.event.records));
    assert.deepEqual((await f.repository.read()).state, f.state);
  }
});

test('checkpoint recovery does not retry with an empty, failed or unconfirmed cache eviction', async t => {
  for (const website of [false, true]) for (const options of [
    {cache: false}, {evictionFailure: Error('synthetic cache deletion failure')},
    ...[{rowsAffected: 0}, {rowsAffected: -1}, {rowsAffected: 0.5}, {rowsAffected: '2'}, {rowsAffected: Number.MAX_SAFE_INTEGER + 1}, {}].map(evictionResult => ({evictionResult})),
  ]) {
    const f = cacheRecoveryFixture(t, options);
    await assert.rejects(f.append(website), error => error instanceof CloudStorageFullError && !error.message.includes('synthetic'));
    assert.equal(f.inserts.length, 1); assert.equal(f.evictions.length, 1);
    assert.deepEqual(databaseRows(f.database), f.beforeRows);
    assert.deepEqual(f.database.prepare('SELECT * FROM marketapp_analytics_sessions').all(), f.beforeSessions);
  }
});

test('checkpoint recovery stops after a repeated full error and preserves unrelated error identity', async t => {
  for (const website of [false, true]) {
    const f = cacheRecoveryFixture(t, {repeatFailure: sqliteFull()});
    await assert.rejects(f.append(website), error => error instanceof CloudStorageFullError && !error.message.includes('synthetic'));
    assert.equal(f.inserts.length, 2); assert.equal(f.evictions.length, 1); assert.deepEqual(databaseRows(f.database), f.beforeRows);
    for (const failure of [Error('database is locked'), Error('query timeout'), Error('storage is full'), Error('no such table: cloud_events')]) {
      const first = cacheRecoveryFixture(t, {failure}); await assert.rejects(first.append(website), error => error === failure);
      assert.equal(first.inserts.length, 1); assert.equal(first.evictions.length, 0); assert.deepEqual(databaseRows(first.database), first.beforeRows);
      const second = cacheRecoveryFixture(t, {repeatFailure: failure}); await assert.rejects(second.append(website), error => error === failure);
      assert.equal(second.inserts.length, 2); assert.equal(second.evictions.length, 1); assert.deepEqual(databaseRows(second.database), second.beforeRows);
    }
  }
});

test('identical retry reevaluates concurrent CAS, wallet, session and immutable source fences', async t => {
  const changeRoot = (database, sequence, change) => {
    const value = JSON.parse(database.prepare('SELECT state_json FROM cloud_events WHERE sequence=?').get(sequence).state_json);
    change(value); database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=?').run(JSON.stringify(value), sequence);
  };
  const races = [
    database => database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(4, 'concurrent-event', '{}', null, null, '[]', null, '2026-10-10T12:00:00.000Z'),
    database => database.prepare('UPDATE cloud_events SET records_json=? WHERE sequence=1').run(JSON.stringify([{kind: 'settings', record: {wallet: 'new-wallet'}}])),
    database => changeRoot(database, 1, value => value.owned_prices.run.wallet = 'new-wallet'),
    database => changeRoot(database, 1, value => value.owned_prices.run.targets[0].amount = '0.170000002'),
    database => changeRoot(database, 2, value => value.owned_prices.attempts.push(5555)),
    database => changeRoot(database, 2, value => value.__checkpoint_owned_targets_sequence = 2),
  ];
  for (const website of [false, true]) for (const onEvict of [...races, ...(website ? [
    database => database.prepare('UPDATE marketapp_analytics_sessions SET generation=generation+1').run(),
    database => database.prepare('UPDATE marketapp_analytics_sessions SET cookie_version=cookie_version+1').run(),
    database => database.prepare('UPDATE marketapp_analytics_sessions SET wallet=?').run('new-wallet'),
    database => database.prepare('UPDATE marketapp_analytics_sessions SET ciphertext=NULL').run(),
    database => database.prepare('UPDATE marketapp_analytics_sessions SET expires_at=?').run(Date.parse('2026-10-10T12:00:01.000Z')),
  ] : [])]) {
    const f = cacheRecoveryFixture(t, {onEvict}); assert.equal(await f.append(website), false);
    assert.equal(f.inserts.length, 2); assert.equal(f.evictions.length, 1);
    assert.strictEqual(f.inserts[0].parameters, f.inserts[1].parameters);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events WHERE event_key=?').get(f.event.key).n, 0);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM dashboard_projection_cache').get().n, 0);
  }
});
