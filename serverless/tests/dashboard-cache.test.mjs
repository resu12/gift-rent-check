import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';

const ctx = {initData: {user: {id: 123}}};
function fixture(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT,state_json TEXT,job_id INTEGER,job_json TEXT,records_json TEXT,raw_body TEXT,observed_at TEXT);
    CREATE TABLE collector_state(id INTEGER,document TEXT);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT,imported_at TEXT,wallet TEXT,captured_at TEXT,normalized_json TEXT);
    CREATE TABLE dashboard_projection_cache(selection_key TEXT PRIMARY KEY,records_revision INTEGER,time_bucket INTEGER,snapshot_json TEXT)`);
  const reads = [];
  const db = {async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};},
    async get(sql, params = {}) {reads.push(sql); return database.prepare(sql).get(params) ?? null;},
    async all(sql, params = {}) {reads.push(sql); return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db, {dashboardCache: true});
  let time = Date.parse('2026-10-10T12:00:15Z'), projections = 0;
  const engine = createCloudEngine({repository, ownerTelegramId: 123, marketappToken: 'fixture-secret', now: () => time,
    fetch: () => {throw Error('No provider request permitted');}, dashboard: (...args) => {projections++; return buildCloudDashboard(...args);}});
  const append = async (records = [], attempts = []) => {
    const {revision, state} = await repository.read(); state.attempts = attempts;
    assert.equal(await repository.append(revision, {key: `test:${revision + 1}`, state, records, observed_at: new Date(time).toISOString()}), true);
  };
  return {database, db, repository, engine, reads, append, advance: ms => {time += ms;}, projections: () => projections};
}

test('revision probes authorize first and never read normalized history or build projections', async t => {
  const f = fixture(t); await f.append([{kind: 'settings', record: {wallet: 'legacy-owner'}}]); f.reads.length = 0;
  await assert.rejects(f.engine.getDashboardRevision({}, {}), /Private access denied/); assert.equal(f.reads.length, 0);
  await assert.rejects(f.engine.getDashboardRevision(ctx, {source: 'listings'}), /must be empty/);
  const a = await f.engine.getDashboardRevision(ctx), b = await f.engine.getDashboardRevision(ctx);
  assert.equal(a.token, b.token); assert.equal(f.projections(), 0);
  assert.ok(f.reads.every(sql => !sql.includes('state_json') && !sql.includes('SELECT sequence,records_json')));
  await f.append(); assert.notEqual((await f.engine.getDashboardRevision(ctx)).token, a.token);
});

test('unchanged projections reuse cache while request budgets remain fresh', async t => {
  const f = fixture(t); await f.append([{kind: 'settings', record: {wallet: 'legacy-owner'}}]);
  const first = await f.engine.getDashboard(ctx, {source: 'rentals'});
  f.reads.length = 0;
  const second = await f.engine.getDashboard(ctx, {pricing_source: 'rentals'});
  assert.deepEqual(second, first); assert.equal(f.projections(), 1);
  assert.equal(f.reads.some(sql => sql.includes('WITH pending')), false);
  await f.append([], [Date.parse('2026-10-10T12:00:14Z')]);
  const budgetChanged = await f.engine.getDashboard(ctx, {source: 'rentals'});
  assert.equal(budgetChanged.capabilities.marketapp_limits.used_24h, 1);
  assert.notEqual(budgetChanged.update_token, first.update_token); assert.equal(f.projections(), 1);
});

test('price tracking survives cached dashboard reads without provider requests or checkpoint writes', async t => {
  const f = fixture(t), address = n => `0:${String(n).padStart(64, '0')}`;
  const wallet = address(1), nft = address(2), collection = address(3);
  const oldAt = '2026-10-02T12:00:15Z', newAt = '2026-10-03T12:00:15Z';
  const listing = price => ({nft_address: nft, nft_name: 'Synthetic tracked gift', owner: wallet, attributes: [], min_duration: 1, max_duration: 30, price_per_day: price, discount_per_day: 0, listed_at: null});
  await f.append([
    {kind: 'settings', record: {wallet}},
    {kind: 'portfolio', record: {nft_address: nft, collection_address: collection, is_portfolio: true}},
    ...[[oldAt, '100000000'], [newAt, '150000000']].map(([observed_at, price]) => ({kind: 'listing', observed_at, record: {identity: nft, source_json: listing(price), collection_address: collection, params: {collection_address: collection}}})),
    {kind: 'history', observed_at: '2026-10-10T12:00:15Z', record: {identity: nft, source_json: {address: nft, name: 'Synthetic tracked gift', collection_address: collection, src: wallet, dst: address(4), ts: Date.parse('2026-10-05T12:00:15Z') / 1000, currency: 'GRAM', price: '0.45', price_nano: '450000000', duration: 259200, is_extend: false, tx_hash: null}}},
  ]);
  const before = await f.repository.read();
  const first = await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'});
  const second = await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'});
  const tracking = first.gifts.find(gift => gift.nft_address === nft).price_tracking;
  assert.equal(tracking.change_count, 1);
  assert.equal(tracking.changes[0].from_price_per_day, '0.1');
  assert.equal(tracking.changes[0].to_price_per_day, '0.15');
  const comparison = tracking.changes[0].comparisons.find(window => window.days === 7);
  assert.equal(comparison.status, 'ready');
  assert.equal(comparison.after.recorded_rentals, 1);
  assert.equal(comparison.after.recorded_volume, '0.45');
  assert.deepEqual(second.gifts.find(gift => gift.nft_address === nft).price_tracking, tracking);
  assert.equal(f.projections(), 1);
  const otherSelection = await f.engine.getDashboard(ctx, {source: 'listings', timeframe: '7d', backdrop: 'Black'});
  assert.deepEqual(otherSelection.gifts.find(gift => gift.nft_address === nft).price_tracking, tracking);
  assert.equal((await f.repository.read()).revision, before.revision);
  assert.ok(f.database.prepare("SELECT selection_key FROM dashboard_projection_cache WHERE selection_key LIKE 'm:%'").all().every(row => row.selection_key.includes('projection-v7-verified-rental-start')));
});

test('data, time, selection and analytics changes invalidate the appropriate projection or token', async t => {
  const f = fixture(t); const first = await f.engine.getDashboard(ctx);
  await f.append([{kind: 'settings', record: {wallet: 'legacy-owner'}}]);
  const changed = await f.engine.getDashboard(ctx); assert.equal(changed.wallet, 'legacy-owner'); assert.equal(f.projections(), 2);
  assert.notEqual(changed.update_token, first.update_token);
  await f.engine.getDashboard(ctx, {backdrop: 'Black'}); assert.equal(f.projections(), 3);
  await assert.rejects(f.engine.getDashboard(ctx, {backdrop: 'Dark'}), /backdrop/); assert.equal(f.projections(), 3);
  f.advance(60000); const later = await f.engine.getDashboard(ctx); assert.equal(f.projections(), 4);
  assert.notEqual(later.update_token, changed.update_token);
  f.database.prepare('INSERT INTO personal_rental_analytics(fingerprint,imported_at) VALUES(?,?)').run('sample', '2026-10-10T12:01:15Z');
  assert.notEqual((await f.engine.getDashboardRevision(ctx)).token, later.update_token);
});

test('a commit during a full dashboard read is left visible to the next revision probe', async t => {
  const f = fixture(t); const read = f.repository.records.bind(f.repository); let once = true;
  f.repository.records = async until => {if (once) {once = false; await f.append([{kind: 'settings', record: {wallet: 'new-owner'}}]);} return read(until);};
  const beforeCommit = await f.engine.getDashboard(ctx);
  assert.equal(beforeCommit.wallet, null);
  assert.notEqual((await f.engine.getDashboardRevision(ctx)).token, beforeCommit.update_token);
  assert.equal((await f.engine.getDashboard(ctx)).wallet, 'new-owner');
});

test('derived cache corruption or write failure rebuilds the authoritative dashboard', async t => {
  const f = fixture(t); await f.engine.getDashboard(ctx);
  f.database.exec("UPDATE dashboard_projection_cache SET snapshot_json='invalid JSON'");
  f.repository.saveDashboardSnapshot = async () => {throw Error('Synthetic cache quota');};
  const rebuilt = await f.engine.getDashboard(ctx);
  assert.equal(rebuilt.summary.portfolio_count, 0); assert.equal(f.projections(), 2);
  assert.equal(typeof rebuilt.update_token, 'string');
});

test('derived cache bounds reads and selections, never replaces newer revisions with stale writers', async t => {
  const f = fixture(t), r = f.repository;
  await r.saveDashboardSnapshot('race', 2, 10, {value: 'new'});
  await r.saveDashboardSnapshot('race', 1, 11, {value: 'old'});
  assert.deepEqual(await r.dashboardSnapshot('race', 2, 10), {value: 'new'});
  for (let i = 0; i < 25; i++) await r.saveDashboardSnapshot(String(i), 3, 20 + i, {value: i});
  assert.equal(f.database.prepare("SELECT count(*) n FROM dashboard_projection_cache WHERE selection_key LIKE 'm:%'").get().n, 16);
  await r.saveDashboardSnapshot('huge', 4, 50, {text: '💎'.repeat(2200000)});
  assert.equal(await r.dashboardSnapshot('huge', 4, 50), null);
  f.database.prepare('INSERT INTO dashboard_projection_cache VALUES(?,?,?,?)').run('m:old-huge', 4, 50, JSON.stringify({text: 'x'.repeat(1048576)}));
  assert.equal(await r.dashboardSnapshot('old-huge', 4, 50), null);
});

test('large real-sized portfolios cache in bounded immutable pieces and interrupted writes remain misses', async t => {
  const f = fixture(t), r = f.repository;
  const snapshot = {text: '💎'.repeat(800000)};
  await r.saveDashboardSnapshot('portfolio', 1, 1, snapshot);
  assert.deepEqual(await r.dashboardSnapshot('portfolio', 1, 1), snapshot);
  assert.ok(f.database.prepare('SELECT MAX(length(CAST(snapshot_json AS BLOB))) bytes FROM dashboard_projection_cache').get().bytes <= 262144);
  f.database.exec("DELETE FROM dashboard_projection_cache WHERE selection_key LIKE 'p:%' AND selection_key LIKE '%:0'");
  assert.equal(await r.dashboardSnapshot('portfolio', 1, 1), null);
  for (let i = 0; i < 10; i++) await r.saveDashboardSnapshot('bounded:' + i, 2, i + 2, {text: String(i).repeat(2100000)});
  assert.ok(f.database.prepare('SELECT SUM(length(CAST(snapshot_json AS BLOB))) bytes FROM dashboard_projection_cache').get().bytes <= 16777216);
});

test('repeated interrupted writers retain strict byte and row bounds without publishing partial manifests', async t => {
  const f = fixture(t), execute = f.db.run;
  f.db.run = async (sql, params) => {
    if (params?.[':key']?.startsWith('m:')) throw Error('Crash before manifest');
    return execute(sql, params);
  };
  for (let i = 0; i < 25; i++) {
    await assert.rejects(f.repository.saveDashboardSnapshot('interrupted:' + i, i, i, {text: String(i).repeat(700000)}), /Crash/);
    const totals = f.database.prepare('SELECT count(*) rows,SUM(length(CAST(snapshot_json AS BLOB))) bytes FROM dashboard_projection_cache').get();
    assert.ok(totals.bytes <= 16777216 && totals.rows <= 2048);
    assert.equal(await f.repository.dashboardSnapshot('interrupted:' + i, i, i), null);
  }
});
