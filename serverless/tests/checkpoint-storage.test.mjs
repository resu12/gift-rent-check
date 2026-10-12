import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {encodeCheckpoint, decodeCheckpoint, createCheckpointStorage} from '../tgcloud/lib/checkpoint-storage.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createOwnedPriceEngine} from '../tgcloud/lib/owned-price-engine.js';
import {streamedBody} from './fixtures/http-response.mjs';

const marker = '__checkpoint_job_sequence';
const targetMarker = '__checkpoint_owned_targets_sequence';
const ownedMarker = '__checkpoint_owned_state_sequence';
const job = (id = 7) => ({id, state: 'partial', reason: 'invocation_limit', streams: [{cursor: 'opaque /+=?&', complete: false}],
  collection_window: {timeframe: '30d', date_from: null, date_to: null}, price: '0.170000001', unknown: null});
const state = value => ({version: 2, next_job_id: 8, attempts: [1000, 2000], next_allowed_at: 3000, job: value, history_coverage: {scope: {full_scan_at: '2026-10-10T12:00:00Z'}}});

function fixture(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER,document TEXT);
    CREATE TABLE owned_refresh_runs(run_id INTEGER PRIMARY KEY,summary_json TEXT NOT NULL,source_sequence INTEGER NOT NULL);
    CREATE TABLE owned_refresh_sessions(session_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,source_sequence INTEGER NOT NULL);
    CREATE TABLE owned_refresh_index(id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL);`);
  const db = {async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};},
    async get(sql, params = {}) {return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db);
  function legacy(sequence, saved = state(job()), savedJob = saved.job, records = []) {
    database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(sequence, `fixture:${sequence}`, JSON.stringify(saved), savedJob?.id ?? null,
      savedJob === undefined ? null : JSON.stringify(savedJob), JSON.stringify(records), JSON.stringify({cursor: `raw-${sequence}`, price: '0.170000001'}), '2026-10-10T12:00:00Z');
  }
  return {database, db, repository, storage: createCheckpointStorage(db), legacy};
}

test('checkpoint encoding round-trips exact matching jobs without mutating caller objects or monetary text', () => {
  const logical = state(job()), saved = structuredClone(logical);
  const encoded = encodeCheckpoint(logical, logical.job, 42), representation = JSON.parse(encoded);
  assert.equal(Object.hasOwn(representation, 'job'), false); assert.equal(representation[marker], 42);
  assert.deepEqual(logical, saved);
  assert.deepEqual(decodeCheckpoint({sequence: 42, state_json: encoded, job_id: 7, job_json: JSON.stringify(logical.job)}), saved);
  assert.equal(saved.job.price, '0.170000001'); assert.equal(Object.hasOwn(saved.job, 'unknown'), true);
  assert.equal(Object.hasOwn(saved.job, 'absent'), false);
});

test('missing, null and mismatched jobs keep their original logical representation', () => {
  const missing = state(job()); delete missing.job;
  for (const [logical, separate] of [[missing, job()], [state(null), null], [state(job()), null], [state(job()), {...job(), state: 'running'}]]) {
    const encoded = encodeCheckpoint(logical, separate, 1);
    assert.equal(Object.hasOwn(JSON.parse(encoded), marker), false);
    assert.deepEqual(decodeCheckpoint({sequence: 1, state_json: encoded, job_id: separate?.id ?? null, job_json: separate ? JSON.stringify(separate) : null}), logical);
  }
});

test('reserved markers, invalid states and corrupt cross-row references fail closed', () => {
  for (const value of [null, [], 'value', 1, {...state(job()), [marker]: null}, {...state(job()), [marker]: 1}]) {
    assert.throws(() => encodeCheckpoint(value, job(), 1), /checkpoint/);
  }
  for (const sequence of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => encodeCheckpoint(state(job()), job(), sequence), /sequence/);
  const encoded = encodeCheckpoint(state(job()), job(), 1);
  for (const row of [
    {sequence: 2, state_json: encoded, job_id: 7, job_json: JSON.stringify(job())},
    {sequence: 1, state_json: encoded, job_id: 8, job_json: JSON.stringify(job())},
    {sequence: 1, state_json: encoded, job_id: 7, job_json: null},
    {sequence: 1, state_json: encoded, job_id: 7, job_json: '{'},
    {sequence: 1, state_json: encoded, job_id: 7, job_json: '[]'},
    {sequence: 1, state_json: JSON.stringify({...JSON.parse(encoded), job: job()}), job_id: 7, job_json: JSON.stringify(job())},
    {sequence: 1, state_json: 'null', job_id: null, job_json: null},
  ]) assert.throws(() => decodeCheckpoint(row));
});

test('invalid job identities cannot create a checkpoint reference that its decoder rejects', () => {
  for (const invalid of [{}, {id: 0}, {id: -1}, {id: '7'}, {id: 1.5}, {id: Number.MAX_SAFE_INTEGER + 1}]) {
    const encoded = encodeCheckpoint(state(invalid), invalid, 1);
    assert.equal(Object.hasOwn(JSON.parse(encoded), marker), false);
    assert.deepEqual(decodeCheckpoint({sequence: 1, state_json: encoded}), state(invalid));
  }
});

test('a TON checkpoint may reference an earlier immutable matching job and still decode exactly', () => {
  const logical = state(job()), prior = {sequence: 3, job_id: 7, job_json: JSON.stringify(job())};
  const encoded = encodeCheckpoint(logical, null, 10, prior);
  assert.equal(JSON.parse(encoded)[marker], 3);
  const row = {sequence: 10, state_json: encoded, job_id: null, job_json: null};
  assert.deepEqual(decodeCheckpoint(row, prior), logical);
  assert.throws(() => decodeCheckpoint(row), /reference/);
  assert.throws(() => decodeCheckpoint(row, {...prior, sequence: 4}), /reference/);
  assert.throws(() => decodeCheckpoint(row, {...prior, job_json: null}), /reference/);
  const different = state({...job(), reason: 'changed'});
  assert.equal(Object.hasOwn(JSON.parse(encodeCheckpoint(different, null, 10, prior)), marker), false);
  for (const invalid of [{...prior, sequence: 10}, {...prior, sequence: 11}, {...prior, sequence: 0}, {...prior, job_id: 8}, {...prior, job_json: '{'}]) {
    assert.throws(() => encodeCheckpoint(logical, null, 10, invalid));
  }
});

test('repository cross-row references survive compaction, preserve source history and fence stale appenders', async t => {
  const f = fixture(t); f.legacy(1); f.legacy(2);
  const original = await f.repository.read(), owned = {...original.state, owned_prices: {version: 2, run: null, attempts: [], next_allowed_at: 0}};
  assert.equal(await f.repository.append(2, {key: 'owned-checkpoint-copy', state: owned, job: null, records: [], observed_at: '2026-10-10T12:00:01Z'}), true);
  const row = f.database.prepare('SELECT * FROM cloud_events WHERE sequence=3').get();
  assert.equal(JSON.parse(row.state_json)[marker], 2); assert.equal(row.job_id, null); assert.equal(row.job_json, null);
  assert.deepEqual((await f.repository.read()).state, owned);
  assert.equal(await f.repository.compactCheckpointJobs(3), 2);
  assert.deepEqual((await f.repository.read()).state, owned);
  assert.deepEqual(await f.repository.job(7), job()); assert.deepEqual(await f.repository.jobs(), [job()]);
  assert.equal(await f.repository.append(2, {key: 'stale-owned-copy', state: owned, job: null, records: [], observed_at: '2026-10-10T12:00:01Z'}), false);
  assert.equal(await f.repository.append(3, {key: 'next-owned-copy', state: owned, job: null, records: [], observed_at: '2026-10-10T12:00:02Z'}), true);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=4').get().state_json)[marker], 2, 'reference points straight to immutable job_json, not a reference chain');
  assert.deepEqual((await f.repository.read()).state, owned);
});

test('repository falls back to a full checkpoint when no exact immutable job matches', async t => {
  const f = fixture(t); f.legacy(1);
  const saved = await f.repository.read(); saved.state.job.reason = 'new-local-change';
  assert.equal(await f.repository.append(1, {key: 'unmatched-owned-copy', state: saved.state, job: null, records: [], observed_at: '2026-10-10T12:00:01Z'}), true);
  const row = f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get();
  assert.equal(Object.hasOwn(JSON.parse(row.state_json), marker), false);
  assert.deepEqual((await f.repository.read()).state, saved.state);
});

test('bounded compaction preserves full logical checkpoints, financial evidence, job history and the latest row', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 6; i++) f.legacy(i, state(job()), job(), [{kind: 'history', record: {price: '0.170000001', price_nano: '170000001', currency: 'GRAM', tx_hash: null}}]);
  const rows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), decoded = rows.map(row => decodeCheckpoint(row));
  const before = await f.repository.checkpointStorageStats(); assert.equal(before.compactable, 6); assert.ok(before.duplicate_job_bytes > 0);
  assert.equal(await f.repository.compactCheckpointJobs(6, 2), 2);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events WHERE state_json LIKE ?').get(`%${marker}%`).n, 2);
  assert.equal(await f.repository.compactCheckpointJobs(6, 100), 3);
  assert.equal(await f.repository.compactCheckpointJobs(6, 100), 0);
  const afterRows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.deepEqual(afterRows.map(row => decodeCheckpoint(row)), decoded);
  assert.deepEqual(afterRows[5], rows[5], 'latest state and reservation remain byte-identical');
  for (let i = 0; i < rows.length; i++) for (const key of ['sequence', 'event_key', 'job_id', 'job_json', 'records_json', 'raw_body', 'observed_at']) assert.equal(afterRows[i][key], rows[i][key]);
  assert.deepEqual(await f.repository.job(7), job()); assert.deepEqual(await f.repository.jobs(), [job()]);
  assert.equal((await f.repository.records()).length, 6);
  assert.ok((await f.repository.checkpointStorageStats()).state_bytes < before.state_bytes);
});

test('historical inline jobs without their own job column reuse exact earlier immutable columns losslessly', async t => {
  const f = fixture(t), original = state(job()); f.legacy(1, original);
  for (let sequence = 2; sequence <= 8; sequence++) f.legacy(sequence, {...original, attempts: [sequence], next_allowed_at: sequence * 1000}, null,
    [{kind: 'history', record: {price: '0.170000001', price_nano: '170000001', tx_hash: null, variant: sequence}}]);
  f.database.prepare('UPDATE cloud_events SET job_json=NULL WHERE sequence>1').run();
  const before = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), decoded = before.map(row => decodeCheckpoint(row));
  let after = 0, rewritten = 0;
  for (let call = 0; call < 10; call++) {
    const page = await createCheckpointStorage(f.db).compactCheckpointJobsPage({boundary: 8, after, limit: 100});
    assert.ok(page.rewritten <= 4); rewritten += page.rewritten; after = page.after;
    if (page.complete) break;
  }
  assert.equal(rewritten, 7);
  const rows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.deepEqual(rows.at(-1), before.at(-1), 'Latest saved leases and cursors remain byte-identical');
  for (let index = 0; index < rows.length; index++) {
    assert.deepEqual(await logicalRow(f, rows[index]), decoded[index]);
    for (const key of ['sequence', 'event_key', 'job_id', 'job_json', 'records_json', 'raw_body', 'observed_at']) assert.equal(rows[index][key], before[index][key]);
    if (index > 0 && index < rows.length - 1) assert.equal(JSON.parse(rows[index].state_json)[marker], 1);
  }
  assert.equal(JSON.parse(rows[0].state_json)[marker], 1, 'Source state can itself be compacted because its immutable job column remains');
  assert.deepEqual((await f.repository.read()).state, decoded.at(-1));
  assert.deepEqual(await f.repository.job(7), job()); assert.deepEqual(await f.repository.jobs(), [job()]);
});

test('earlier job source reuse rejects mismatched, malformed, duplicate-key and future sources and preserves boundaries', async t => {
  const f = fixture(t), original = state(job());
  f.legacy(1, original, {...job(), reason: 'different'});
  f.legacy(2, state(null), job()); f.database.prepare('UPDATE cloud_events SET job_id=8 WHERE sequence=2').run();
  f.legacy(3, state(null), job()); f.database.prepare('UPDATE cloud_events SET job_json=? WHERE sequence=3').run('{bad');
  f.legacy(4, state(null), job()); f.database.prepare('UPDATE cloud_events SET job_json=? WHERE sequence=4').run(JSON.stringify(job()).replace('"id":7', '"id":8,"id":7'));
  f.legacy(5, original, null); f.legacy(6, original, job());
  f.legacy(7, original, null); f.legacy(8, original, null); f.legacy(9, original, null);
  f.database.prepare('UPDATE cloud_events SET job_json=NULL WHERE sequence IN (5,7,8,9)').run();
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=7').run(JSON.stringify(original).replace('"job":', '"job":{},"job":'));
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=8').run(JSON.stringify(original).replace('"id":7', '"id":8,"id":7'));
  const before = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  let after = 0;
  for (let call = 0; call < 8; call++) {
    const page = await createCheckpointStorage(f.db).compactCheckpointJobsPage({boundary: 8, after, limit: 4}); after = page.after;
    if (page.complete) break;
  }
  const rows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.deepEqual(rows[4], before[4], 'The identical column at a future sequence cannot qualify');
  for (const index of [0, 1, 2, 3, 6, 7, 8]) assert.deepEqual(rows[index], before[index]);
  assert.equal(JSON.parse(rows[5].state_json)[marker], 6);
});

test('job reuse publication atomically rechecks source and target identity/content and current head', async t => {
  const races = [
    db => db.prepare('UPDATE cloud_events SET job_json=? WHERE sequence=1').run(JSON.stringify({...job(), reason: 'changed-source'})),
    db => db.prepare('UPDATE cloud_events SET job_id=8 WHERE sequence=1').run(),
    db => db.prepare('UPDATE cloud_events SET job_json=? WHERE sequence=1').run(JSON.stringify(job()).replace('"id":7', '"id":8,"id":7')),
    db => db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=2').run(JSON.stringify(state({...job(), reason: 'changed-target'}))),
    db => db.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=2').run(JSON.stringify(state(job())).replace('"job":', '"job":{},"job":')),
    db => db.prepare('DELETE FROM cloud_events WHERE sequence=3').run(),
  ];
  for (const race of races) {
    const f = fixture(t); f.legacy(1, state(null), job()); f.legacy(2, state(job()), null); f.legacy(3, state(job()), null);
    f.database.prepare('UPDATE cloud_events SET job_json=NULL WHERE sequence>1').run();
    const storage = createCheckpointStorage({...f.db, async run(sql, params) {race(f.database); return await f.db.run(sql, params);}});
    const page = await storage.compactCheckpointJobsPage({boundary: 3, limit: 4});
    assert.equal(page.rewritten, 0); assert.equal(Object.hasOwn(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=2').get().state_json), marker), false);
  }
});

test('job partition budgets advance over unmatched jobs, use the job index and bound returned payloads', async t => {
  const f = fixture(t); f.database.exec('CREATE INDEX cloud_events_job_idx ON cloud_events(job_id)');
  for (let sequence = 1; sequence <= 12; sequence++) f.legacy(sequence, state(job(sequence)), null);
  f.legacy(13, state(null), job(20));
  for (let sequence = 14; sequence <= 40; sequence++) f.legacy(sequence, state(job(20)), null);
  f.database.prepare('UPDATE cloud_events SET job_json=NULL WHERE sequence<>13').run();
  const queries = [], plans = [];
  const db = {...f.db, async get(sql, params) {
    if (sql.includes('job_id=:id')) {queries.push(sql); plans.push(...f.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(row => row.detail));}
    return await f.db.get(sql, params);
  }, async all(sql, params) {
    const rows = await f.db.all(sql, params); assert.ok(rows.length <= 25);
    assert.ok(rows.reduce((total, row) => total + Buffer.byteLength(row.job_json), 0) <= 524288); return rows;
  }};
  let after = 0, total = 0;
  for (let call = 0; call < 30; call++) {
    queries.length = 0;
    const page = await createCheckpointStorage(db).compactCheckpointJobsPage({boundary: 40, after, limit: 100});
    assert.ok(queries.length <= 4); assert.ok(page.rewritten <= 4);
    assert.ok(page.complete || page.after > after, 'Even unmatched jobs make resumable progress'); after = page.after; total += page.rewritten;
    if (page.complete) break;
  }
  assert.equal(total, 26); assert.ok(plans.every(plan => /SEARCH cloud_events USING INDEX cloud_events_job_idx/.test(plan)));
  for (const input of [{}, {boundary: 0}, {boundary: 40, after: -1}, {boundary: 40, after: 41}, {boundary: 40, limit: 0}, {boundary: 40, extra: true}])
    await assert.rejects(f.storage.compactCheckpointJobsPage(input), /partition/);
});

test('large copied jobs are compacted in bounded host pages while unique pending evidence stays intact', async t => {
  const f = fixture(t), large = {...job(), scope_names: {collection: 'x'.repeat(47900)}};
  f.legacy(1, state(null), large);
  for (let sequence = 2; sequence <= 30; sequence++) f.legacy(sequence, {...state(large), owned_prices: {run: {pending: [{account_evidence: 'y'.repeat(96000), variant: sequence}]}}}, null);
  f.database.prepare('UPDATE cloud_events SET job_json=NULL WHERE sequence>1').run();
  const before = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), bytes = before.reduce((total, row) => total + row.state_json.length, 0);
  const batches = [];
  const db = {...f.db, async all(sql, params) {
    const rows = await f.db.all(sql, params); const bytes = rows.reduce((total, row) => total + Buffer.byteLength(row.job_json), 0);
    assert.ok(bytes <= 524288); batches.push(rows.length); return rows;
  }};
  let after = 0, count = 0;
  for (let call = 0; call < 15; call++) {
    const page = await createCheckpointStorage(db).compactCheckpointJobsPage({boundary: 30, after, limit: 4});
    after = page.after; count += page.rewritten; if (page.complete) break;
  }
  assert.equal(count, 28); assert.ok(batches.every(size => size <= 10));
  const rows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.ok(bytes - rows.reduce((total, row) => total + row.state_json.length, 0) > 1300000);
  for (let index = 0; index < rows.length; index++) {
    assert.deepEqual(await logicalRow(f, rows[index]), JSON.parse(before[index].state_json));
    for (const key of ['job_id', 'job_json', 'raw_body', 'records_json', 'observed_at', 'event_key']) assert.equal(rows[index][key], before[index][key]);
  }
  assert.deepEqual(rows.at(-1), before.at(-1));
});

test('compaction excludes mismatches, existing markers, malformed data and unsafe legacy job IDs', async t => {
  const f = fixture(t);
  f.legacy(1, state(job()), {...job(), reason: 'different'});
  f.legacy(2, state(null), null);
  const missing = state(job()); delete missing.job; f.legacy(3, missing, job());
  f.legacy(4, {...state(job()), [marker]: null}, job());
  f.legacy(5, state(job(Number.MAX_SAFE_INTEGER + 1)), job(Number.MAX_SAFE_INTEGER + 1));
  f.legacy(6, state(job()), job());
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=6').run('{broken');
  f.legacy(7, state(job()), job());
  f.database.prepare('UPDATE cloud_events SET state_json=?,job_json=? WHERE sequence=7').run('{"job":{"id":7},"job":{"id":8}}', '{"id":7}');
  f.legacy(8, state(job()), job());
  const select = 'SELECT sequence,event_key,state_json,CAST(job_id AS TEXT) AS job_id,job_json,records_json,raw_body,observed_at FROM cloud_events ORDER BY sequence';
  const before = f.database.prepare(select).all();
  assert.equal(await f.repository.compactCheckpointJobs(8), 0);
  assert.deepEqual(f.database.prepare(select).all(), before);
  for (const [boundary, limit] of [[0, 1], [8, 0], [8, 101], [1.5, 1]]) await assert.rejects(f.repository.compactCheckpointJobs(boundary, limit), /bound/);
});

test('lossless compaction does not advance CAS revisions or change a resumed saved cursor and request ledger', async t => {
  const f = fixture(t); f.legacy(1); f.legacy(2); f.legacy(3);
  const saved = await f.repository.read();
  assert.equal(await f.repository.compactCheckpointJobs(saved.revision), 2);
  assert.deepEqual(await f.repository.read(), saved);
  const resumed = structuredClone(saved.state); resumed.job.state = 'running'; resumed.job.reason = null;
  assert.equal(await f.repository.append(saved.revision, {key: 'resume-after-compaction', state: resumed, job: resumed.job, records: [], observed_at: '2026-10-10T12:01:00Z'}), true);
  assert.equal(await f.repository.append(saved.revision, {key: 'stale-resume', state: resumed, job: resumed.job, records: [], observed_at: '2026-10-10T12:01:00Z'}), false);
  const current = await f.repository.read(); assert.deepEqual(current.state, resumed); assert.equal(current.revision, saved.revision + 1);
  assert.equal(current.state.job.streams[0].cursor, 'opaque /+=?&'); assert.deepEqual(current.state.attempts, [1000, 2000]);
  const row = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence DESC LIMIT 1').get();
  assert.equal(JSON.parse(row.state_json)[marker], row.sequence);
});

test('v1 ownership archive rebuild and new targeted steps coexist with compacted Marketapp checkpoints', async t => {
  const f = fixture(t), nft = `0:${'22'.repeat(32)}`, wallet = `0:${'11'.repeat(32)}`, collection = `0:${'33'.repeat(32)}`;
  const at = '2026-10-10T12:00:00Z', archived = {id: 1, state: 'complete', total: 0, checked: 0, updated: 0, unresolved: 0, reason: null, started_at: at, completed_at: at};
  const own = {version: 1, next_run_id: 3, run: {...archived, id: 2}, history: [archived],
    sessions: [{id: 'legacy-checkpoint-session', run_id: 1}], attempts: [], next_allowed_at: 0};
  const original = {...state(job()), owned_prices: own}, records = [
    {kind: 'settings', record: {wallet}}, {kind: 'portfolio', observed_at: at, record: {nft_address: nft, collection_address: collection, is_portfolio: true}},
  ];
  f.legacy(1, original, original.job, records); f.legacy(2, original, original.job); f.legacy(3, original, original.job);
  assert.equal(await f.repository.compactCheckpointJobs(3), 2);
  await f.repository.syncOwnedRefreshArchive();
  assert.equal(await f.repository.ownedRefreshSession('legacy-checkpoint-session'), 1);
  assert.deepEqual(await f.repository.ownedRefreshRun(1), archived);
  let time = Date.parse(at), requests = 0;
  const engine = createOwnedPriceEngine({repository: f.repository, ownerTelegramId: 123, now: () => time,
    fetch: async () => {requests++; return {status: 200, headers: {get: () => null}, body: streamedBody(JSON.stringify({nft_items: [
      {address: nft, owner_address: wallet, collection_address: collection, init: true, last_transaction_lt: '100'},
    ]}))};}});
  const ctx = {initData: {user: {id: 123}}};
  const started = await engine.start(ctx, {session_id: 'new-checkpoint-session'}); assert.equal(started.run.id, 3);
  await engine.step(ctx, {run_id: 3}); time += 1000;
  const finished = await engine.step(ctx, {run_id: 3}); assert.equal(finished.run.state, 'complete'); assert.equal(finished.run.status_updated, 1);
  assert.deepEqual((await f.repository.read()).state.job, original.job);
  assert.equal((await engine.start(ctx, {session_id: 'legacy-checkpoint-session'})).run.id, 1);
  assert.equal(requests, 2);
  assert.deepEqual(await f.repository.job(7), original.job);
});

const ownedState = (runId = 3, wallet = '0:wallet', targets = [{nft_address: '0:nft', collection_address: '0:collection', price: '0.170000001', unknown: null}]) => ({
  ...state(job()), owned_prices: {version: 2, next_run_id: runId + 1, attempts: [1000, 2000], next_allowed_at: 3000,
    run: {id: runId, wallet, targets, pending: [{reason: null}], state: 'running', total: targets.length, checked: 0, updated: 0,
      unresolved: 0, deadline: 4000, lease: 'owned-lease', lease_until: 5000, stage: 'before', offset: 0, attempts: 1},
    last_session: {id: 'target-checkpoint-session', run_id: runId}},
});
const targetSource = (saved, sequence = 1) => ({sequence, run_id: saved.owned_prices.run.id, wallet: saved.owned_prices.run.wallet,
  targets_json: JSON.stringify(saved.owned_prices.run.targets)});
const ownedSource = (saved, sequence = 1, target_sequence = null) => ({sequence, owned_prices_json: JSON.stringify(saved.owned_prices), target_sequence});

async function logicalRow(f, row) {
  const physical = JSON.parse(row.state_json);
  const own = Object.hasOwn(physical, ownedMarker) ? await f.storage.ownedStateSource(physical[ownedMarker]) : null;
  const targets = own?.target_sequence ?? physical[targetMarker];
  const source = physical[marker] ? f.database.prepare('SELECT sequence,job_id,job_json FROM cloud_events WHERE sequence=?').get(physical[marker]) : row;
  return decodeCheckpoint(row, source, targets ? await f.storage.ownedTargetSource(targets) : null, own);
}

test('whole owned-state codec preserves every ledger, lease, missing field and exact amount without mutation', () => {
  const logical = ownedState(), before = structuredClone(logical), source = ownedSource(logical);
  const encoded = encodeCheckpoint(logical, job(), 2, null, null, source), physical = JSON.parse(encoded);
  assert.equal(physical[ownedMarker], 1); assert.equal(Object.hasOwn(physical, 'owned_prices'), false);
  assert.deepEqual(decodeCheckpoint({sequence: 2, state_json: encoded, job_id: 7, job_json: JSON.stringify(job())}, undefined, null, source), logical);
  assert.deepEqual(logical, before);
  const targets = targetSource(logical), stripped = structuredClone(logical); delete stripped.owned_prices.run.targets;
  const ownWithTargets = ownedSource(stripped, 2, 1), combined = encodeCheckpoint(logical, null, 3, null, targets, ownWithTargets);
  assert.equal(Object.hasOwn(JSON.parse(combined), targetMarker), false);
  assert.deepEqual(decodeCheckpoint({sequence: 3, state_json: combined}, undefined, targets, ownWithTargets), logical);
  for (const own of [null, undefined, [], 5, 'opaque']) {
    const saved = {...state(null), ...(own === undefined ? {} : {owned_prices: own})};
    assert.deepEqual(decodeCheckpoint({sequence: 1, state_json: encodeCheckpoint(saved, null, 1)}), saved);
  }
});

test('whole owned-state references fail closed on corrupt, mismatched, cyclic or mixed physical sources', () => {
  const logical = ownedState(), source = ownedSource(logical), encoded = encodeCheckpoint(logical, null, 2, null, null, source), row = {sequence: 2, state_json: encoded};
  for (const invalid of [null, {...source, sequence: 0}, {...source, sequence: 2}, {...source, sequence: 3}, {...source, sequence: 1.5},
    {...source, target_sequence: 1}, {...source, target_sequence: '1'}, {...source, owned_prices_json: '{}bad'},
    {...source, owned_prices_json: 'null'}, {...source, owned_prices_json: '[]'}, {...source, owned_prices_json: null}]) {
    assert.throws(() => decodeCheckpoint(row, undefined, null, invalid));
    if (invalid) assert.throws(() => encodeCheckpoint(logical, null, 2, null, null, invalid));
  }
  const absent = {...source}; delete absent.target_sequence;
  assert.throws(() => decodeCheckpoint(row, undefined, null, absent));
  assert.throws(() => encodeCheckpoint(logical, null, 2, null, null, ownedSource({...logical, owned_prices: {...logical.owned_prices, next_allowed_at: 99}})), /does not match/);
  for (const extra of [{owned_prices: logical.owned_prices}, {[targetMarker]: 1}, {[ownedMarker]: 0}, {[ownedMarker]: 2}, {[ownedMarker]: '1'}])
    assert.throws(() => decodeCheckpoint({...row, state_json: JSON.stringify({...JSON.parse(encoded), ...extra})}, undefined, null, source));
  assert.throws(() => encodeCheckpoint({...logical, [ownedMarker]: null}, null, 2), /storage marker/);
});

test('repository deduplicates unchanged owned state through permanent inline sources and resolves target markers first', async t => {
  const f = fixture(t), logical = ownedState(); f.legacy(1, logical);
  for (let sequence = 2; sequence <= 4; sequence++) {
    assert.equal(await f.repository.append(sequence - 1, {key: `owned-state:${sequence}`, state: logical, job: job(), records: [], observed_at: '2026-10-10T12:00:01Z'}), true);
    assert.deepEqual((await f.repository.read()).state, logical);
  }
  const row2 = f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get();
  assert.equal(JSON.parse(row2.state_json)[targetMarker], 1);
  for (const sequence of [3, 4]) {
    const row = f.database.prepare('SELECT * FROM cloud_events WHERE sequence=?').get(sequence);
    assert.equal(JSON.parse(row.state_json)[ownedMarker], 2);
    assert.equal(await f.storage.ownedStateSource(sequence), null, 'Sources cannot be reference chains');
  }
  assert.equal(await f.repository.compactCheckpointOwnedTargets(4), 0, 'A referenced whole-state source stays physically immutable');
  assert.equal(await f.repository.compactCheckpointOwnedStates(4), 0);
  assert.deepEqual((await f.repository.read()).state, logical);
  const changed = structuredClone(logical); changed.owned_prices.attempts.push(8888);
  assert.equal(await f.repository.append(4, {key: 'owned-state:changed', state: changed, job: job(), records: [], observed_at: '2026-10-10T12:00:02Z'}), true);
  assert.equal(Object.hasOwn(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=5').get().state_json), ownedMarker), false);
  assert.deepEqual((await f.repository.read()).state, changed);
  assert.equal(await f.repository.append(4, {key: 'owned-state:stale', state: logical, records: [], observed_at: '2026-10-10T12:00:02Z'}), false);
});

test('whole-state maintenance keeps historical checkpoints, immutable financial columns, source roots and latest bytes', async t => {
  const f = fixture(t), logical = ownedState();
  logical.owned_prices.attempts = Array.from({length: 999}, (_, i) => 1791648000000 + i);
  const records = [{kind: 'history', record: {price: '0.170000001', price_nano: '170000001', currency: 'GRAM', tx_hash: null}}];
  for (let i = 1; i <= 30; i++) f.legacy(i, {...logical, attempts: [i]}, logical.job, records);
  const beforeRows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), before = await f.storage.ownedStateStorageStats();
  assert.equal(before.owned_state_compactable, 28); assert.ok(before.duplicate_owned_state_bytes > 350000);
  assert.equal(await f.storage.compactCheckpointOwnedStates(30, 2), 2);
  assert.equal(await f.storage.compactCheckpointOwnedStates(30, 100), 26);
  assert.equal(await f.storage.compactCheckpointOwnedStates(30, 100), 0);
  const afterRows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.deepEqual(afterRows.at(-1), beforeRows.at(-1)); assert.deepEqual(afterRows[0], beforeRows[0]);
  for (let i = 0; i < afterRows.length; i++) {
    assert.deepEqual(await logicalRow(f, afterRows[i]), JSON.parse(beforeRows[i].state_json));
    for (const key of ['sequence', 'event_key', 'job_id', 'job_json', 'records_json', 'raw_body', 'observed_at']) assert.equal(afterRows[i][key], beforeRows[i][key]);
    if (i > 0 && i < 29) assert.equal(JSON.parse(afterRows[i].state_json)[ownedMarker], 1);
  }
  assert.equal((await f.storage.ownedStateStorageStats()).owned_state_compactable, 0);
  assert.equal((await f.repository.records()).length, 30); assert.deepEqual((await f.repository.read()).state, {...logical, attempts: [30]});
  for (const [boundary, limit] of [[0, 1], [30, 0], [30, 101], [1.5, 1]]) await assert.rejects(f.storage.compactCheckpointOwnedStates(boundary, limit), /bound/);
});

test('whole-state maintenance excludes malformed roots, duplicate keys, explicit markers and target-source rows', async t => {
  const f = fixture(t), logical = ownedState();
  f.legacy(1, logical); f.legacy(2, logical); f.legacy(3, logical);
  const duplicates = ['{"owned_prices":{},"owned_prices":{}}', '{broken',
    JSON.stringify({...logical, [ownedMarker]: null}), JSON.stringify({...logical, [targetMarker]: null}),
    JSON.stringify({...logical, owned_prices: null})];
  for (let i = 0; i < duplicates.length; i++) {f.legacy(4 + i, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=?').run(duplicates[i], 4 + i);}
  f.legacy(9, logical);
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=3').run(encodeCheckpoint(logical, logical.job, 3, null, targetSource(logical, 2)));
  const before = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.equal(await f.storage.compactCheckpointOwnedStates(9), 0, 'The only matching copy is used by a target reference');
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), before);
  assert.equal(await f.storage.ownedStateSource(3) !== null, true);
});

test('archive reconstruction resolves whole owned-state references including legacy arrays and repeated run summaries', async t => {
  const f = fixture(t), at = '2026-10-10T12:00:00Z';
  const summary = {id: 1, state: 'complete', total: 0, checked: 0, updated: 0, unresolved: 0, started_at: at, completed_at: at};
  const first = {...state(job()), owned_prices: {version: 1, run: {...summary, id: 2}, history: [summary],
    sessions: [{id: 'legacy-owned-state-session', run_id: 1}], attempts: [1000], next_allowed_at: 3000}};
  for (let i = 1; i <= 5; i++) f.legacy(i, first);
  assert.equal(await f.storage.compactCheckpointOwnedStates(5), 3);
  await f.repository.syncOwnedRefreshArchive();
  assert.equal(await f.repository.ownedRefreshSession('legacy-owned-state-session'), 1);
  assert.deepEqual(await f.repository.ownedRefreshRun(1), summary);
  const second = {...state(job()), owned_prices: {version: 2, run: {...summary, id: 2, state: 'partial'}, previous_run: summary,
    last_session: {id: 'whole-owned-state-session', run_id: 2}, attempts: [2000], next_allowed_at: 4000}};
  assert.equal(await f.repository.append(5, {key: 'owned-price:summary-1', state: second, records: [], observed_at: at}), true);
  await f.repository.syncOwnedRefreshArchive();
  const changed = structuredClone(second); changed.owned_prices.run.state = 'complete';
  assert.equal(await f.repository.append(6, {key: 'owned-price:summary-2', state: changed, records: [], observed_at: at}), true);
  await f.repository.syncOwnedRefreshArchive(); assert.equal((await f.repository.ownedRefreshRun(2)).state, 'complete');
  assert.equal(await f.repository.append(7, {key: 'owned-price:summary-reverted', state: second, records: [], observed_at: at}), true);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=8').get().state_json)[ownedMarker], 6);
  await f.repository.syncOwnedRefreshArchive(); assert.equal((await f.repository.ownedRefreshRun(2)).state, 'partial');
  assert.equal(await f.repository.ownedRefreshSession('whole-owned-state-session'), 2);
  assert.equal(f.database.prepare('SELECT source_sequence FROM owned_refresh_runs WHERE run_id=2').get().source_sequence, 8);
});

test('atomic maintenance protects a new source reference committed after candidate selection', async t => {
  for (const kind of ['owned', 'targets']) {
    const f = fixture(t), logical = ownedState(); for (let i = 1; i <= 3; i++) f.legacy(i, logical);
    let inserted = false;
    const storage = createCheckpointStorage({...f.db, async run(sql, params) {
      if (sql.includes('UPDATE cloud_events SET state_json') && !inserted) {
        inserted = true;
        f.legacy(4, JSON.parse(encodeCheckpoint(logical, logical.job, 4, null, null, ownedSource(logical, 2))), logical.job);
      }
      assert.match(sql, /protected_checkpoint_sources AS MATERIALIZED/);
      return await f.db.run(sql, params);
    }});
    const row2 = f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get();
    assert.equal(await (kind === 'owned' ? storage.compactCheckpointOwnedStates(3) : storage.compactCheckpointOwnedTargets(3)), 0);
    assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events WHERE sequence=2').get(), row2, 'The concurrent source remains immutable');
    assert.deepEqual((await f.repository.read()).state, logical);
  }
});

test('whole-state source and maintenance result buffers remain bounded with large historical ledgers', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 90; i++) {
    const logical = ownedState(Math.ceil(i / 10)); logical.owned_prices.attempts = Array.from({length: 999}, (_, n) => 1791648000000 + n);
    logical.owned_prices.run.pending = [{reason: null, evidence: 'x'.repeat(85000)}]; f.legacy(i, logical);
  }
  const results = [], db = {...f.db, async all(sql, params) {
    const rows = await f.db.all(sql, params);
    if (sql.includes('AS owned_source')) {assert.match(sql, /LIMIT 8193/); assert.ok(rows.length <= 8193); return rows;}
    assert.match(sql, /LIMIT 25/); assert.match(sql, /total_bytes<=524288/);
    const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.owned_prices_json), 0);
    assert.ok(bytes <= 524288 || rows.length === 1); assert.ok(rows.length <= 25); results.push(bytes); return rows;
  }, async run(sql, params) {
    assert.ok(Object.keys(params).length <= 201); assert.match(sql, /protected_checkpoint_sources AS MATERIALIZED/);
    assert.ok(Object.keys(params).filter(key => /^:sequence\d+$/.test(key)).length <= 4, 'Each physical publication stays within the hosted query limit');
    return await f.db.run(sql, params);
  }};
  const storage = createCheckpointStorage(db); assert.equal((await storage.ownedStateStorageStats()).owned_state_compactable, 80);
  let changed = 0; for (;;) {const count = await storage.compactCheckpointOwnedStates(90, 7); changed += count; if (!count) break;}
  assert.equal(changed, 80); assert.ok(results.length > 10);
  assert.equal((await storage.ownedStateStorageStats()).owned_state_compactable, 0);
  for (let group = 0; group < 9; group++) assert.ok(await storage.ownedStateSource(group * 10 + 1));
});

test('partitioned owned-state statistics and rewrites cap host work and resume across fresh repository instances', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 160; i++) f.legacy(i, ownedState(Math.ceil(i / 4)));
  let after = 0, duplicateBytes = 0, duplicates = 0, completed = false;
  function boundedStorage() {
    let lookups = 0, pages = 0, updates = 0;
    return createCheckpointStorage({...f.db, async get(sql, params) {
      if (sql.includes('AS owned_prices_json')) {lookups++; assert.ok(lookups <= 4, 'A server invocation performs at most four full source lookups');}
      return await f.db.get(sql, params);
    }, async all(sql, params) {
      if (sql.includes('AS owned_bytes')) {pages++; assert.ok(pages <= 2, 'A server invocation inspects at most two bounded data pages');}
      return await f.db.all(sql, params);
    }, async run(sql, params) {updates++; assert.ok(updates <= 1, 'One atomic rewrite per invocation'); return await f.db.run(sql, params);}});
  }
  let calls = 0;
  while (!completed) {
    const result = await boundedStorage().ownedStateStorageStatsPage({boundary: 160, after}); calls++;
    assert.equal(result.boundary, 160); assert.ok(result.after > after || result.complete); after = result.after; completed = result.complete;
    duplicateBytes += result.duplicate_owned_state_bytes; duplicates += result.owned_state_compactable;
  }
  assert.ok(calls >= 10); const full = await f.storage.ownedStateStorageStats();
  assert.equal(duplicates, 119); assert.equal(duplicates, full.owned_state_compactable); assert.equal(duplicateBytes, full.duplicate_owned_state_bytes);
  const before = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  after = 0; completed = false; let rewritten = 0;
  while (!completed) {
    const result = await boundedStorage().compactCheckpointOwnedStatesPage({boundary: 160, after, limit: 7});
    assert.ok(result.rewritten <= 4, 'Hosted-safe rewrite cap applies even when a larger valid limit is requested'); assert.ok(result.after > after || result.complete); after = result.after; completed = result.complete; rewritten += result.rewritten;
  }
  assert.equal(rewritten, 119); const rows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  for (let i = 0; i < rows.length; i++) assert.deepEqual(await logicalRow(f, rows[i]), JSON.parse(before[i].state_json));
  assert.deepEqual(rows.at(-1), before.at(-1)); assert.equal((await f.storage.ownedStateStorageStats()).owned_state_compactable, 0);
  for (const input of [{after: -1}, {boundary: 161}, {after: 161, boundary: 160}, {after: '0'}, {extra: true}])
    await assert.rejects(boundedStorage().ownedStateStorageStatsPage(input), /partition/);
  for (const input of [null, {}, {boundary: 0}, {boundary: 160, limit: 0}, {boundary: 160, limit: 101}])
    await assert.rejects(boundedStorage().compactCheckpointOwnedStatesPage(input), /partition/);
});

test('archive predecessor/source lookups use primary keys without materializing historical state documents', async t => {
  const f = fixture(t), original = ownedState(); original.padding = 'x'.repeat(85000);
  for (let i = 1; i <= 120; i++) f.legacy(i, original);
  const changed = structuredClone(original); changed.owned_prices.run.state = 'complete'; f.legacy(121, changed);
  f.database.prepare('INSERT INTO owned_refresh_index VALUES(1,117)').run();
  const plans = [];
  const repository = createCloudRepository({...f.db, async all(sql, params) {
    if (sql.includes('LEFT JOIN cloud_events p ON')) {
      assert.doesNotMatch(sql, /LEFT JOIN resolved|pending AS/);
      plans.push(...f.database.prepare('EXPLAIN QUERY PLAN ' + sql).all(params).map(row => row.detail));
      const rows = await f.db.all(sql, params);
      assert.ok(rows.every(row => !Object.hasOwn(row, 'state_json')), 'Only fixed-size projection fields leave SQLite');
      assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 10000); return rows;
    }
    return await f.db.all(sql, params);
  }});
  await repository.syncOwnedRefreshArchive();
  assert.ok(plans.length); assert.doesNotMatch(plans.join('\n'), /MATERIALIZE|SCAN (?:p|ps|s)\b/);
  for (const alias of ['p', 'ps', 's']) assert.match(plans.join('\n'), new RegExp(`SEARCH ${alias} USING INTEGER PRIMARY KEY`));
  assert.equal((await repository.ownedRefreshRun(3)).state, 'complete');
  assert.equal(f.database.prepare('SELECT sequence FROM owned_refresh_index WHERE id=1').get().sequence, 121);
});

test('hosted owned-state Page defaults and large requested limits publish at most four rows atomically', async t => {
  for (const limit of [undefined, 8, 25, 100]) {
    const f = fixture(t), logical = ownedState(); for (let i = 1; i <= 20; i++) f.legacy(i, logical);
    const result = await f.storage.compactCheckpointOwnedStatesPage({boundary: 20, ...(limit === undefined ? {} : {limit})});
    assert.equal(result.rewritten, 4); assert.equal(result.after, 5); assert.equal(result.complete, false);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events WHERE state_json LIKE ?').get(`%${ownedMarker}%`).n, 4);
    assert.deepEqual((await f.repository.read()).state, logical);
  }
});

test('owned-target codec restores an exact array alongside either Marketapp job representation', () => {
  for (const marketJob of [null, job()]) {
    const logical = ownedState(), before = structuredClone(logical), targets = targetSource(logical);
    const encoded = encodeCheckpoint(logical, marketJob, 2, null, targets), stored = JSON.parse(encoded);
    assert.equal(stored[targetMarker], 1); assert.equal(Object.hasOwn(stored.owned_prices.run, 'targets'), false);
    assert.deepEqual(logical, before, 'Serialization never removes caller targets');
    const row = {sequence: 2, state_json: encoded, job_id: marketJob?.id ?? null, job_json: marketJob ? JSON.stringify(marketJob) : null};
    assert.deepEqual(decodeCheckpoint(row, row, targets), before);
    assert.equal(before.owned_prices.run.targets[0].price, '0.170000001');
    assert.equal(Object.hasOwn(before.owned_prices.run.targets[0], 'unknown'), true);
    assert.equal(Object.hasOwn(before.owned_prices.run.targets[0], 'absent'), false);
  }
  const empty = ownedState(3, null, []), source = targetSource(empty);
  assert.deepEqual(decodeCheckpoint({sequence: 2, state_json: encodeCheckpoint(empty, null, 2, null, source)}, undefined, source), empty);
});

test('owned-target codec rejects corrupt, changed, current, future and incomplete sources', () => {
  const logical = ownedState(), source = targetSource(logical), encoded = encodeCheckpoint(logical, null, 2, null, source);
  const row = {sequence: 2, state_json: encoded};
  for (const invalid of [null, {...source, sequence: 0}, {...source, sequence: 2}, {...source, sequence: 3}, {...source, sequence: 1.5},
    {...source, run_id: 4}, {...source, wallet: 'changed'}, {...source, targets_json: null}, {...source, targets_json: '{}'},
    {...source, targets_json: '{broken'}, {...source, targets_json: 'null'}]) {
    assert.throws(() => decodeCheckpoint(row, undefined, invalid));
    if (invalid) assert.throws(() => encodeCheckpoint(logical, null, 2, null, invalid));
  }
  assert.throws(() => encodeCheckpoint(logical, null, 2, null, {...source, targets_json: '[{"different":true}]'}), /does not match/);
  const noWallet = {...source}; delete noWallet.wallet;
  assert.throws(() => decodeCheckpoint(row, undefined, noWallet));
  for (const value of [null, 0, -1, 1.5, 2, 3, '1']) {
    assert.throws(() => decodeCheckpoint({...row, state_json: JSON.stringify({...JSON.parse(encoded), [targetMarker]: value})}, undefined, source));
  }
  assert.throws(() => decodeCheckpoint({...row, state_json: JSON.stringify({...JSON.parse(encoded), owned_prices: logical.owned_prices})}, undefined, source), /reference/);
  assert.throws(() => encodeCheckpoint({...logical, [targetMarker]: 1}, null, 2), /storage marker/);
  const missing = structuredClone(logical); delete missing.owned_prices.run.wallet;
  assert.throws(() => encodeCheckpoint(missing, null, 2, null, source));
});

test('missing, null and tiny owned-target runs avoid source scans and storage expansion', async () => {
  const storage = createCheckpointStorage({async get() {throw new Error('Unexpected source scan');}});
  for (const run of [undefined, null, {}, {id: 1, wallet: null, targets: []}, {id: 1, targets: [{nft_address: 'nft'}]},
    {id: 1, wallet: 'wallet', targets: [{nft_address: 'nft'}]}]) assert.equal(await storage.findOwnedTargetSource(run, 2), null);
});

test('owned-target storage matches the earliest exact inline run and wallet and never returns marked sources', async t => {
  const f = fixture(t), original = ownedState();
  f.legacy(1, original); f.legacy(2, original); f.legacy(3, ownedState(4)); f.legacy(4, ownedState(3, 'another-wallet'));
  f.legacy(5, ownedState(3, '0:wallet', [...original.owned_prices.run.targets].reverse().concat({nft_address: 'changed'})));
  f.legacy(6, original);
  assert.deepEqual({...await f.storage.ownedTargetSource(1)}, targetSource(original));
  assert.equal((await f.storage.findOwnedTargetSource(original.owned_prices.run, 7)).sequence, 1);
  assert.equal(await f.storage.findOwnedTargetSource(original.owned_prices.run, 1), null);
  assert.equal((await f.storage.findOwnedTargetSource(ownedState(4).owned_prices.run, 7)).sequence, 3);
  assert.equal((await f.storage.findOwnedTargetSource(ownedState(3, 'another-wallet').owned_prices.run, 7)).sequence, 4);
  assert.equal(await f.storage.findOwnedTargetSource({...original.owned_prices.run, targets: [{different: true}]}, 7), null);
  assert.equal(await f.storage.compactCheckpointOwnedTargets(6, 1), 1);
  assert.equal(await f.storage.ownedTargetSource(2), null, 'A reference can never become another reference source');
  assert.equal((await f.storage.findOwnedTargetSource(original.owned_prices.run, 7)).sequence, 1);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=2').get().state_json)[targetMarker], 1);
});

test('validated source hints reuse exact inline roots with primary-key reads instead of historical scans', async t => {
  const f = fixture(t), logical = ownedState(); f.legacy(1, logical); f.legacy(2, logical);
  const queries = [], plans = [];
  const storage = createCheckpointStorage({async get(sql, params) {
    queries.push(sql); plans.push(...f.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map(row => row.detail));
    return await f.db.get(sql, params);
  }});
  assert.equal((await storage.findOwnedTargetSource(logical.owned_prices.run, 3, 2)).sequence, 2);
  assert.equal((await storage.findOwnedStateSource(logical.owned_prices, 3, null, 2)).sequence, 2);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(sql => /WHERE sequence=:sequence/.test(sql) && !/sequence<:before/.test(sql)));
  assert.ok(plans.every(plan => /SEARCH cloud_events USING INTEGER PRIMARY KEY/.test(plan)));
});

test('missing, invalid, malformed, chained or changed source hints fall back to exact historical roots', async t => {
  const f = fixture(t), logical = ownedState(); f.legacy(1, logical);
  const variants = [ownedState(4), ownedState(3, 'changed-wallet'), ownedState(3, '0:wallet', [{nft_address: 'changed-nft', padding: 'x'.repeat(100)}])];
  const ledger = structuredClone(logical); ledger.owned_prices.attempts.push(7777); variants.push(ledger);
  variants.forEach((value, i) => f.legacy(i + 2, value));
  f.legacy(6, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=6').run('{malformed');
  f.legacy(7, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=7').run(JSON.stringify(logical).replace('"owned_prices":', '"owned_prices":{},"owned_prices":'));
  f.legacy(8, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=8').run(encodeCheckpoint(logical, null, 8, null, targetSource(logical)));
  f.legacy(9, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=9').run(encodeCheckpoint(logical, null, 9, null, null, ownedSource(logical)));
  const calls = [], storage = createCheckpointStorage({async get(sql, params) {calls.push(sql); return await f.db.get(sql, params);}});
  // Different owned ledgers preserve the same target array, so the target hint
  // at row 5 remains safe even though it cannot stand in for the owned state.
  for (const sequence of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, '1']) {
    calls.length = 0;
    assert.equal((await storage.findOwnedTargetSource(logical.owned_prices.run, 11, sequence)).sequence, 1);
    assert.ok(calls.some(sql => /sequence<:before/.test(sql)), `target fallback for ${sequence}`);
  }
  for (const sequence of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, '1']) {
    calls.length = 0;
    assert.equal((await storage.findOwnedStateSource(logical.owned_prices, 11, null, sequence)).sequence, 1);
    assert.ok(calls.some(sql => /sequence<:before/.test(sql)), `owned fallback for ${sequence}`);
  }
  const changed = structuredClone(logical); changed.owned_prices.run.targets.push({nft_address: 'new-nft'});
  assert.equal(await storage.findOwnedTargetSource(changed.owned_prices.run, 11, 1), null);
  assert.equal(await storage.findOwnedStateSource(changed.owned_prices, 11, null, 1), null);
});

test('owned-state source hints must also match the exact physical target source identity', async t => {
  const f = fixture(t), logical = ownedState(); f.legacy(1, logical); f.legacy(2, logical);
  f.legacy(3, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=3').run(encodeCheckpoint(logical, null, 3, null, targetSource(logical, 1)));
  f.legacy(4, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=4').run(encodeCheckpoint(logical, null, 4, null, targetSource(logical, 2)));
  assert.equal((await f.storage.findOwnedStateSource(logical.owned_prices, 5, targetSource(logical, 1), 4)).sequence, 3);
  assert.equal((await f.storage.findOwnedStateSource(logical.owned_prices, 5, targetSource(logical, 2), 3)).sequence, 4);
});

test('repository keeps validated source hints across Marketapp pages without rescanning an unchanged owned ledger', async t => {
  const f = fixture(t), logical = ownedState(); f.legacy(1, logical);
  for (let sequence = 2; sequence <= 3; sequence++) assert.equal(await f.repository.append(sequence - 1,
    {key: `source-bootstrap:${sequence}`, state: logical, job: logical.job, records: [], observed_at: '2026-10-10T12:00:01Z'}), true);
  const historical = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), queries = [];
  const repository = createCloudRepository({...f.db, async get(sql, params) {queries.push(sql); return await f.db.get(sql, params);}});
  const saved = await repository.read(); assert.deepEqual(saved.state, logical); queries.length = 0;
  for (let expected = 3; expected <= 5; expected++) {
    const next = {...logical, job: {...logical.job, reason: `market-page-${expected}`}};
    assert.equal(await repository.append(expected, {key: `market-page:${expected}`, state: next, job: next.job, records: [], observed_at: '2026-10-10T12:00:02Z'}), true);
  }
  assert.equal(queries.length, 6, 'Each append rechecks the target and owned root by sequence');
  assert.ok(queries.every(sql => /WHERE sequence=:sequence/.test(sql) && !/sequence<:before/.test(sql)));
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events WHERE sequence<=3 ORDER BY sequence').all(), historical);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=6').get().state_json)[ownedMarker], 2);
  assert.deepEqual((await repository.read()).state.owned_prices, logical.owned_prices);
  queries.length = 0;
  assert.equal(await repository.append(3, {key: 'stale-source-hint', state: logical, job: logical.job, records: [], observed_at: '2026-10-10T12:00:03Z'}), false);
  assert.ok(queries.some(sql => /sequence<:before/.test(sql)), 'A stale expected revision cannot reuse hints from a different revision');
});

test('repository target references survive CAS conflicts and same-run target changes without source chains', async t => {
  const f = fixture(t), logical = ownedState(); f.legacy(1, logical);
  const changedStage = structuredClone(logical); changedStage.owned_prices.run.stage = 'accounts';
  const append = (expected, key, saved) => f.repository.append(expected, {key, state: saved, job: saved.job, records: [], observed_at: '2026-10-10T12:00:01Z'});
  assert.equal(await append(1, 'target-stage', changedStage), true);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=2').get().state_json)[targetMarker], 1);
  assert.deepEqual((await f.repository.read()).state, changedStage);
  assert.equal(await append(1, 'stale-target-stage', logical), false);
  const changedTargets = structuredClone(changedStage); changedTargets.owned_prices.run.targets.push({nft_address: 'new-nft', extra: null});
  assert.equal(await append(2, 'different-frozen-targets', changedTargets), true);
  assert.equal(Object.hasOwn(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=3').get().state_json), targetMarker), false);
  assert.deepEqual((await f.repository.read()).state, changedTargets);
  assert.equal(await append(3, 'same-new-frozen-targets', changedTargets), true);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=4').get().state_json)[targetMarker], 3);
  assert.equal(await f.storage.compactCheckpointOwnedTargets(4), 0, 'Referenced arrays never become new sources and roots stay inline');
  assert.deepEqual((await f.repository.read()).state, changedTargets);
  assert.deepEqual((await f.storage.ownedTargetSource(1)).targets_json, JSON.stringify(logical.owned_prices.run.targets));
});

test('owned-target compaction preserves every historical logical field and immutable financial column', async t => {
  const f = fixture(t), logical = ownedState(3, null, [{nft_address: '🦋', price: '0.170000001', nullable: null}, {nft_address: 'second'}]);
  for (let i = 1; i <= 6; i++) f.legacy(i, {...logical, owned_prices: {...logical.owned_prices, run: {...logical.owned_prices.run, checked: i}}}, logical.job,
    [{kind: 'history', record: {price: '0.170000001', price_nano: '170000001', unknown: null}}]);
  const rows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), before = rows.map(row => decodeCheckpoint(row));
  const stats = await f.storage.ownedTargetStorageStats(); assert.equal(stats.target_compactable, 4); assert.ok(stats.duplicate_target_bytes > 0);
  assert.equal(await f.storage.compactCheckpointOwnedTargets(6, 2), 2);
  assert.equal(await f.storage.compactCheckpointOwnedTargets(6, 100), 2);
  assert.equal(await f.storage.compactCheckpointOwnedTargets(6, 100), 0);
  const after = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  const restored = [];
  for (const row of after) {
    const reference = JSON.parse(row.state_json)[targetMarker];
    restored.push(decodeCheckpoint(row, row, reference ? await f.storage.ownedTargetSource(reference) : null));
    for (const key of ['sequence', 'event_key', 'job_id', 'job_json', 'records_json', 'raw_body', 'observed_at']) assert.equal(row[key], rows[row.sequence - 1][key]);
  }
  assert.deepEqual(restored, before); assert.deepEqual(after[0], rows[0], 'Earliest immutable inline source stays byte-identical');
  assert.deepEqual(after[5], rows[5], 'Latest checkpoint, reservations and leases stay byte-identical');
  assert.equal((await f.storage.ownedTargetStorageStats()).target_compactable, 0);
  assert.ok(after.reduce((n, row) => n + row.state_json.length, 0) < rows.reduce((n, row) => n + row.state_json.length, 0));
  await f.repository.syncOwnedRefreshArchive();
  assert.equal(await f.repository.ownedRefreshSession('target-checkpoint-session'), 3);
  assert.equal((await f.repository.ownedRefreshRun(3)).checked, 6, 'Direct SQL summary projection still reads compacted runs');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM owned_refresh_runs').get().n, 1);
});

test('owned-target compaction skips malformed identities, duplicate keys and changed arrays', async t => {
  const f = fixture(t), logical = ownedState();
  f.legacy(1, logical);
  const variants = [ownedState(4), ownedState(3, 'changed'), ownedState(3, '0:wallet', [{nft_address: 'different'}])];
  const missing = ownedState(); delete missing.owned_prices.run.wallet; variants.push(missing);
  const unsafe = ownedState(Number.MAX_SAFE_INTEGER + 1); variants.push(unsafe);
  const nullTargets = ownedState(); nullTargets.owned_prices.run.targets = null; variants.push(nullTargets);
  const marked = {...ownedState(), [targetMarker]: 1}; variants.push(marked);
  variants.forEach((saved, i) => f.legacy(i + 2, saved));
  f.legacy(9, logical); f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=9').run('{broken');
  f.legacy(10, logical);
  const duplicateRun = JSON.stringify(logical).replace('"run":{', '"run":{},"run":{');
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=10').run(duplicateRun);
  f.legacy(11, logical);
  const duplicateWallet = JSON.stringify(logical).replace('"wallet":"0:wallet"', '"wallet":"0:wallet","wallet":"changed"');
  f.database.prepare('UPDATE cloud_events SET state_json=? WHERE sequence=11').run(duplicateWallet);
  f.legacy(12, logical);
  const originalRows = f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all();
  assert.equal(await f.storage.compactCheckpointOwnedTargets(12), 0);
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(), originalRows);
  for (const [boundary, limit] of [[0, 1], [1.5, 1], [12, 0], [12, 101]]) await assert.rejects(f.storage.compactCheckpointOwnedTargets(boundary, limit), /bound/);
});

test('legacy ownership archives and target references coexist with Marketapp job compaction', async t => {
  const f = fixture(t), logical = ownedState(), archived = {id: 2, state: 'complete', total: 0, checked: 0, updated: 0, unresolved: 0};
  logical.owned_prices.version = 1; logical.owned_prices.history = [archived];
  logical.owned_prices.sessions = [{id: 'legacy-target-ref-session', run_id: 2}];
  for (let i = 1; i <= 4; i++) f.legacy(i, logical);
  assert.equal(await f.storage.compactCheckpointOwnedTargets(4), 2);
  assert.equal(await f.repository.compactCheckpointJobs(4), 3);
  for (const row of f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all()) {
    const stored = JSON.parse(row.state_json), source = stored[targetMarker] ? await f.storage.ownedTargetSource(stored[targetMarker]) : null;
    assert.deepEqual(decodeCheckpoint(row, row, source), logical);
  }
  await f.repository.syncOwnedRefreshArchive();
  assert.equal(await f.repository.ownedRefreshSession('legacy-target-ref-session'), 2);
  assert.deepEqual(await f.repository.ownedRefreshRun(2), archived);
  assert.equal((await f.repository.ownedRefreshRun(3)).total, 1);
});

test('realistic target history uses bounded SQL pages, a limited root cache and atomic bounded updates', async t => {
  const f = fixture(t), targets = Array.from({length: 161}, (_, index) => ({nft_address: `0:${String(index).padStart(64, '0')}`,
    collection_address: `0:${'a'.repeat(64)}`}));
  // At production row sizes this spans multiple 512 KiB host pages and enough
  // run variants to evict roots from the fixed-size in-memory source cache.
  for (let i = 1; i <= 120; i++) f.legacy(i, {...ownedState(Math.ceil(i / 10), '0:wallet', targets), padding: 'x'.repeat(85000)});
  const batchBytes = [], plans = [], writes = [];
  const db = {...f.db, async all(sql, params) {
    assert.doesNotMatch(sql, /GROUP BY/i, 'SQL must not group the entire historical target payload');
    if (sql.includes('AS owned_source')) {
      assert.match(sql, /LIMIT 8193/); const rows = await f.db.all(sql, params);
      assert.ok(rows.length <= 8193); assert.ok(rows.every(row => row.owned_source === null || Number.isSafeInteger(row.owned_source)));
      assert.ok(rows.every(row => row.target_source === null || Number.isSafeInteger(row.target_source))); return rows;
    }
    assert.match(sql, /LIMIT 25/); assert.match(sql, /total_bytes<=524288/);
    const rows = await f.db.all(sql, params), bytes = rows.reduce((n, row) => n + Buffer.byteLength(row.targets_json), 0);
    assert.ok(bytes <= 524288 || rows.length === 1, `bounded target result: ${bytes} bytes`);
    assert.ok(rows.length <= 25); batchBytes.push(bytes);
    if (!plans.length) plans.push(...f.database.prepare('EXPLAIN QUERY PLAN ' + sql).all(params).map(row => row.detail));
    return rows;
  }, async run(sql, params) {
    assert.ok(Object.keys(params).length <= 201, 'Atomic publication stays below the SQLite parameter floor');
    writes.push(sql); return await f.db.run(sql, params);
  }};
  const storage = createCheckpointStorage(db), stats = await storage.ownedTargetStorageStats();
  assert.equal(stats.target_compactable, 107); assert.ok(batchBytes.length > 5);
  assert.doesNotMatch(plans.join('\n'), /MATERIALIZE roots|MATERIALIZE inline_targets/);
  let rewritten = 0;
  for (;;) {const count = await storage.compactCheckpointOwnedTargets(120, 7); rewritten += count; if (!count) break;}
  assert.equal(rewritten, 107); assert.ok(writes.length > 10);
  assert.equal((await storage.ownedTargetStorageStats()).target_compactable, 0);
  for (let run = 1; run <= 12; run++) assert.ok(await storage.ownedTargetSource(10 * run - 9), 'Every earliest frozen array remains inline');
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM cloud_events WHERE sequence=120').get().state_json)[targetMarker], undefined);
});
