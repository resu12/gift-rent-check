import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {encodeCheckpoint, decodeCheckpoint, createCheckpointStorage} from '../tgcloud/lib/checkpoint-storage.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {giftRefreshSessionKey} from '../tgcloud/lib/gift-refresh-storage.js';

const marker = '__checkpoint_gift_state_sequence';
const date = '2026-10-11T12:00:00.000Z';
const gift = (id = 19) => ({version: 1, next_run_id: id + 1, run: {id, wallet: 'saved-wallet', state: 'complete',
  targets: [{nft_address: 'saved-nft', collection_address: 'saved-collection', label: 'Gift 🦋', unknown: null}],
  results: {'saved-nft': {checked: true, price: true, status: false, exact_amount: '170000001', unknown: null}},
  ton_targets: ['saved-nft'], cursor: 'opaque /+=?&', checked: 1, status_updated: 0, started_at: date, check_started_at: date,
  completed_at: date, deadline: 12345, inflight: null}, last_complete: {id, captured_at: 1234, check_started_at: date}});
const state = value => ({version: 2, next_job_id: 8, attempts: [1000, 2000], next_allowed_at: 3000,
  job: {id: 7, state: 'partial', streams: [{cursor: 'saved-provider-cursor', complete: false}]}, gift_refresh: value});
function fixture(t, {beforeWrite = null} = {}) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,state_json TEXT NOT NULL,
    job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,document TEXT);
    CREATE TABLE marketapp_analytics_sessions(owner_id TEXT PRIMARY KEY,generation INTEGER,cookie_version INTEGER,
      wallet TEXT,ciphertext TEXT,created_at INTEGER,expires_at INTEGER);`);
  const queries = [];
  const db = {
    async get(sql, params = {}) {queries.push({kind: 'get', sql}); return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {const rows = database.prepare(sql).all(params); queries.push({kind: 'all', sql, rows}); return rows;},
    async run(sql, params = {}) {beforeWrite?.(database, sql, params); queries.push({kind: 'run', sql}); return {rowsAffected: Number(database.prepare(sql).run(params).changes)};},
  };
  const repository = createCloudRepository(db), storage = createCheckpointStorage(db);
  function legacy(sequence, logical = state(gift()), key = `fixture:${sequence}`) {
    database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(sequence, key, JSON.stringify(logical), logical.job?.id ?? null,
      logical.job ? JSON.stringify(logical.job) : null, JSON.stringify([{kind: 'history', record: {exact_amount: '170000001', unknown: null}}]),
      '{"synthetic_provider_evidence":"retained"}', date);
  }
  const rows = () => database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  const source = sequence => ({sequence, gift_refresh_json: JSON.stringify(gift())});
  return {database, db, repository, storage, legacy, rows, queries, source};
}

test('whole gift state codec restores clocks, targets, results and missing values without mutation', () => {
  const logical = state(gift()), before = structuredClone(logical), source = {sequence: 2, gift_refresh_json: JSON.stringify(logical.gift_refresh)};
  const encoded = encodeCheckpoint(logical, logical.job, 5, null, null, null, source);
  const row = {sequence: 5, state_json: encoded, job_id: 7, job_json: JSON.stringify(logical.job)};
  assert.equal(JSON.parse(encoded)[marker], 2); assert.equal(Object.hasOwn(JSON.parse(encoded), 'gift_refresh'), false);
  assert.deepEqual(decodeCheckpoint(row, row, null, null, source), before); assert.deepEqual(logical, before);
  assert.equal(Object.hasOwn(before.gift_refresh.run, 'absent'), false);
});

test('gift codec rejects mismatched, absent, same-row, future, malformed and mixed references', () => {
  const logical = state(gift()), source = {sequence: 2, gift_refresh_json: JSON.stringify(logical.gift_refresh)};
  const encoded = encodeCheckpoint(logical, null, 5, null, null, null, source), row = {sequence: 5, state_json: encoded};
  for (const changed of [null, {...source, sequence: 5}, {...source, sequence: 6}, {...source, sequence: 0},
    {...source, gift_refresh_json: '[]'}, {...source, gift_refresh_json: 'null'}, {...source, gift_refresh_json: '{'},
    {...source, gift_refresh_json: JSON.stringify({...gift(), next_run_id: 999})}]) {
    if (changed) assert.throws(() => encodeCheckpoint(logical, null, 5, null, null, null, changed));
    if (!changed || changed.sequence !== 2 || !['string'].includes(typeof changed.gift_refresh_json) || ['[]','null','{'].includes(changed.gift_refresh_json))
      assert.throws(() => decodeCheckpoint(row, row, null, null, changed));
  }
  assert.throws(() => decodeCheckpoint({...row, state_json: JSON.stringify({...JSON.parse(encoded), gift_refresh: gift()})}, row, null, null, source));
  assert.throws(() => encodeCheckpoint({...logical, [marker]: 2}, null, 5));
  for (const value of [null, undefined, []]) {
    const saved = state(value); if (value === undefined) delete saved.gift_refresh;
    assert.deepEqual(decodeCheckpoint({sequence: 1, state_json: encodeCheckpoint(saved, null, 1)}), saved);
  }
});

test('both private append paths reference exact immutable gift roots and retain CAS and login fences', async t => {
  for (const website of [false, true]) {
    const f = fixture(t); f.legacy(1); const logical = state(gift());
    f.database.prepare('INSERT INTO marketapp_analytics_sessions VALUES(?,?,?,?,?,?,?)').run('42', 2, 3, 'saved-wallet', 'synthetic-encrypted-cookie', 0, 9999999999999);
    const stored = {value: {owner: '42', wallet: 'saved-wallet', cookie_version: 3}, fence: {generation: 2, wallet_revision: 0}};
    const event = {key: 'new-comparison-checkpoint', state: logical, job: logical.job, records: [], observed_at: date};
    await f.repository.read(); f.queries.length = 0;
    assert.equal(website ? await f.repository.appendWebsite(1, event, '42', stored) : await f.repository.append(1, event, 0), true);
    const row = f.rows()[1]; assert.equal(JSON.parse(row.state_json)[marker], 1);
    assert.deepEqual((await f.repository.read()).state, logical);
    assert.ok(f.queries.some(query => query.kind === 'get' && /sequence=:sequence/.test(query.sql) && /gift_refresh/.test(query.sql)), 'Validated read hints reuse the root by primary key');
    assert.equal(website ? await f.repository.appendWebsite(1, {...event, key: 'stale'}, '42', stored) : await f.repository.append(1, {...event, key: 'stale'}, 0), false);
    if (website) assert.equal(await f.repository.appendWebsite(2, {...event, key: 'wrong-session'}, '42', {...stored, fence: {...stored.fence, generation: 999}}), false);
    const changed = structuredClone(logical); changed.gift_refresh.run.results['saved-nft'].status = true;
    assert.equal(await f.repository.append(2, {...event, key: 'changed-gift-evidence', state: changed}), true);
    assert.equal(Object.hasOwn(JSON.parse(f.rows()[2].state_json), marker), false);
    assert.deepEqual((await f.repository.read()).state, changed);
  }
});

test('append source publication rejects deleted, marked, changed or malformed roots after lookup', async t => {
  const races = [
    db => db.prepare('DELETE FROM cloud_events WHERE sequence=1').run(),
    db => db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run(JSON.stringify({[marker]: 999})),
    db => {const saved = state(gift()); saved.gift_refresh.run.wallet = 'changed-wallet'; db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run(JSON.stringify(saved));},
    db => db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=1').run('{'),
  ];
  for (const race of races) {
    let fired = false;
    const f = fixture(t, {beforeWrite: (db, sql) => {if (!fired && /^INSERT OR IGNORE INTO cloud_events/.test(sql)) {fired = true; race(db);}}});
    f.legacy(1); f.legacy(2, {...state(gift()), gift_refresh: {...gift(), unknown: 'unique second checkpoint'}});
    assert.equal(await f.repository.append(2, {key: 'new', state: state(gift()), job: state(gift()).job, records: [], observed_at: date}), false);
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM cloud_events WHERE event_key=?').get('new').count, 0);
  }
});

test('gift compaction preserves every reconstructed checkpoint, raw evidence, replay bindings and latest bytes', async t => {
  const f = fixture(t), session = 'saved-browser-session';
  for (let sequence = 1; sequence <= 15; sequence++) f.legacy(sequence, {...state(gift()), attempts: [sequence]}, `gift-refresh:${sequence}`);
  const binding = [{record: {session_id: session, run_id: 19}}];
  f.database.prepare('UPDATE cloud_events SET event_key=?,records_json=? WHERE sequence=1').run(giftRefreshSessionKey(session), JSON.stringify(binding));
  const before = f.rows(), head = await f.repository.read();
  let after = 0, complete = false, rewritten = 0;
  while (!complete) {const result = await createCheckpointStorage(f.db).compactCheckpointGiftStatesPage({boundary: 15, after, limit: 4}); after = result.after; complete = result.complete; rewritten += result.rewritten;}
  assert.equal(rewritten, 13); const resultRows = f.rows();
  assert.equal(resultRows[0].state_json, before[0].state_json); assert.equal(resultRows[14].state_json, before[14].state_json);
  for (let index = 0; index < before.length; index++) {
    const physical = JSON.parse(resultRows[index].state_json), source = physical[marker] ? await f.storage.giftStateSource(physical[marker]) : null;
    assert.deepEqual(decodeCheckpoint(resultRows[index], resultRows[index], null, null, source), JSON.parse(before[index].state_json));
    for (const column of ['sequence','event_key','job_id','job_json','records_json','raw_body','observed_at']) assert.equal(resultRows[index][column], before[index][column]);
  }
  assert.deepEqual(await f.repository.read(), head);
  assert.equal(await f.repository.giftRefreshSession(session), 19);
  assert.deepEqual(await f.repository.giftRefreshRun(19), gift().run);
  assert.ok(resultRows.slice(1, 14).every(row => JSON.parse(row.state_json)[marker] === 1), 'All references remain one hop');
});

test('existing gift source roots, malformed parent keys and changed states cannot be compacted', async t => {
  const f = fixture(t); f.legacy(1); f.legacy(2); f.legacy(3, state(gift(20))); f.legacy(4); f.legacy(5);
  const first = f.rows()[0].state_json;
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=2').run(JSON.stringify({...state(gift()), [marker]: 1, gift_refresh: undefined}));
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=4').run(first.replace('"gift_refresh":', '"gift_refresh":{},"gift_refresh":'));
  const before = f.rows();
  const result = await f.storage.compactCheckpointGiftStatesPage({boundary: 5, after: 0});
  assert.equal(result.rewritten, 0); assert.deepEqual(f.rows(), before);
  assert.deepEqual({...await f.storage.findGiftStateSource(gift(), 6, 2)}, f.source(1), 'A marked hint falls back to an inline root');
});

test('historical gift lookup restores referenced runs without accepting chains or unrelated events', async t => {
  const f = fixture(t); f.legacy(1, state(gift()), 'gift-refresh:1');
  f.legacy(2, {...state(gift()), gift_refresh: undefined, [marker]: 1}, 'gift-refresh:2');
  f.legacy(3, state(gift(20)), 'gift-refresh:3');
  assert.deepEqual(await f.repository.giftRefreshRun(19), gift().run);
  f.legacy(4, {...state(gift()), gift_refresh: undefined, [marker]: 2}, 'gift-refresh:4');
  await assert.rejects(f.repository.read(), /gift-state/);
  f.legacy(5, state(gift(99)), 'collector:5');
  assert.deepEqual(await f.repository.giftRefreshRun(19), gift().run); assert.equal(await f.repository.giftRefreshRun(99), null);
});

test('gift partition publication protects a root referenced after candidate selection', async t => {
  let fired = false;
  const f = fixture(t, {beforeWrite: (db, sql) => {
    if (!fired && /UPDATE cloud_events SET state_json/.test(sql)) {
      fired = true;
      db.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(5, 'gift-refresh:concurrent', JSON.stringify({...state(gift()), gift_refresh: undefined, [marker]: 2}), null, null, '[]', null, date);
    }
  }});
  for (let sequence = 1; sequence <= 4; sequence++) f.legacy(sequence);
  const before = f.rows()[1].state_json;
  const result = await f.storage.compactCheckpointGiftStatesPage({boundary: 4, after: 0, limit: 4});
  assert.equal(result.rewritten, 1); assert.equal(f.rows()[1].state_json, before); assert.deepEqual((await f.repository.read()).state, state(gift()));
});

test('gift statistics and maintenance bound lookup, mutation count, multibyte payloads and continuation', async t => {
  const f = fixture(t), large = gift(); large.run.targets[0].label = '🦋'.repeat(42000);
  for (let sequence = 1; sequence <= 30; sequence++) f.legacy(sequence, {...state(large), attempts: [sequence]});
  const first = await f.storage.giftStateStorageStatsPage({});
  assert.equal(first.complete, false); assert.ok(first.after > 0); assert.ok(first.gift_state_compactable > 0);
  assert.ok(f.queries.filter(query => query.kind === 'all').every(query => query.rows.length <= 25 && query.rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.gift_refresh_json || ''), 0) <= 524288));
  const result = await f.storage.compactCheckpointGiftStatesPage({boundary: 30, after: 0, limit: 100});
  assert.ok(result.rewritten <= 4); assert.equal(result.complete, false);
  for (const input of [{boundary: 31}, {boundary: -1}, {boundary: 30, after: 31}, {boundary: 30, limit: 0}, {boundary: 30, limit: 101}, {boundary: 30, unknown: true}])
    await assert.rejects(f.storage.compactCheckpointGiftStatesPage(input));
});
