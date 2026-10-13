import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {buildCloudDashboard} from '../tgcloud/lib/cloud-pricing.js';
import {SUPPORTED_CODE_HASH, MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';

const ctx = {initData: {user: {id: 123}}};
function fixture(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT,state_json TEXT,job_id INTEGER,job_json TEXT,records_json TEXT,raw_body TEXT,observed_at TEXT);
    CREATE TABLE collector_state(id INTEGER,document TEXT);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT,imported_at TEXT,wallet TEXT,captured_at TEXT,normalized_json TEXT,raw_snapshot TEXT);
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

test('gift rental statistics survive cached reads and invalidate the earlier dashboard projection format', async t => {
  const f = fixture(t), address = n => `0:${String(n).padStart(64, '0')}`;
  const wallet = address(1), nft = address(2), collection = address(3);
  await f.append([{kind: 'settings', record: {wallet}}, {kind: 'portfolio', record: {nft_address: nft, collection_address: collection, is_portfolio: true}},
    {kind: 'history', observed_at: '2026-10-10T12:00:15Z', record: {identity: nft, source_json: {
      address: nft, name: 'Saved gift', collection_address: collection, src: wallet, dst: address(4), ts: Date.parse('2025-01-01T12:00:00Z') / 1000,
      currency: 'GRAM', price: '0.45', price_nano: '450000000', duration: 259200, is_extend: false,
    }}}]);
  const first = await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'}), stats = first.gifts[0].rental_statistics;
  assert.equal(first.gifts[0].price_tracking.coverage, 'no_observations');
  assert.equal(stats.recorded_rentals, 1); assert.equal(stats.recorded_volume, '0.45'); assert.equal(stats.average_daily_rate, '0.15');
  const before = await f.repository.read();
  assert.deepEqual((await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'})).gifts[0].rental_statistics, stats);
  assert.equal(f.projections(), 1);
  // Simulate a cache from the previous deployment, which has no per-gift stats.
  const cached = f.database.prepare('SELECT * FROM dashboard_projection_cache').get(), snapshot = JSON.parse(cached.snapshot_json);
  delete snapshot.dashboard.gifts[0].rental_statistics;
  f.database.prepare('UPDATE dashboard_projection_cache SET selection_key=?,snapshot_json=? WHERE selection_key=?').run(
    cached.selection_key.replace('projection-v10-gift-rental-statistics', 'projection-v9-verified-rental-counts'), JSON.stringify(snapshot), cached.selection_key);
  assert.deepEqual((await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'})).gifts[0].rental_statistics, stats);
  assert.equal(f.projections(), 2);
  assert.deepEqual((await f.engine.getDashboard(ctx, {source: 'listings', timeframe: '24h'})).gifts[0].rental_statistics, stats);
  assert.equal((await f.repository.read()).revision, before.revision, 'projection reads do not write checkpoints or source data');
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
  assert.ok(f.database.prepare("SELECT selection_key FROM dashboard_projection_cache WHERE selection_key LIKE 'm:%'").all().every(row => row.selection_key.includes('projection-v10-gift-rental-statistics')));

  // A successful website refresh adds a new source baseline. Rebuilding or
  // caching that projection must keep the listing change and its own evidence.
  await f.append([{kind: 'personal_gift', observed_at: '2026-10-10T12:00:00Z', record: {
    provider: 'marketapp_website', semantics_version: 'marketapp-my-nfts-v1', scope: 'my_nfts',
    authenticated: true, ownership_verified: false, visible: true, wallet,
    nft_address: nft, collection_address: collection, rental_state: 'for_rent', rental_until: null,
    currency: 'GRAM', price_per_day: '0.2',
  }}]);
  const refreshed = await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'});
  const retained = refreshed.gifts.find(gift => gift.nft_address === nft).price_tracking;
  assert.equal(retained.source, 'Marketapp account');
  assert.equal(retained.baseline_price_per_day, '0.2');
  assert.equal(retained.change_count, 1);
  assert.deepEqual(retained.changes, tracking.changes);
  const cached = await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'});
  assert.deepEqual(cached.gifts.find(gift => gift.nft_address === nft).price_tracking, retained);
  const switched = await f.engine.getDashboard(ctx, {source: 'listings', timeframe: '7d'});
  assert.deepEqual(switched.gifts.find(gift => gift.nft_address === nft).price_tracking, retained);

  // Fresh contract evidence must invalidate the projection and survive cache
  // reuse while its payment history is still missing.
  const startedAt = '2026-10-06T12:00:15Z', start = Date.parse(startedAt) / 1000;
  const checkedAt = '2026-10-10T11:59:00Z', holder = address(5);
  await f.append([{kind: 'owned_status', observed_at: checkedAt, record: {
    provider: 'toncenter', semantics_version: 'ton-owned-rental-status-v1', nft_address: nft, nft,
    collection_address: collection, wallet, owner: wallet, observed_owner: holder, holding_contract: holder,
    verified: true, reason: 'verified_rental_status', rental_state: 'rented', role: 1, status: 1,
    renter: address(6), counterpart: address(7), rental_until: start + 30 * 86400, rental_until_unit: 'Unix seconds',
    rental_duration: 30 * 86400, rental_duration_unit: 'seconds', created_at: start, created_at_unit: 'Unix seconds',
    code_hash: SUPPORTED_CODE_HASH, data_hash: 'b'.repeat(64), code_hash_verified: true, data_hash_verified: true,
    decoder_version: 'fixture-v1', marketplace: MARKETAPP_OPERATOR, nft_last_transaction_lt: '100', account_last_transaction_lt: '99',
    checked_at: checkedAt, rechecked_at: checkedAt,
  }}]);
  const afterPeriod = dashboard => dashboard.gifts.find(gift => gift.nft_address === nft).price_tracking.changes[0].comparisons[0].after;
  const verified = afterPeriod(await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'}));
  assert.equal(verified.observed_rentals, 2); assert.equal(verified.verified_rentals_without_history, 1);
  assert.equal(verified.recorded_rentals, 1); assert.equal(verified.recorded_volume, '0.45');
  const projectionsBeforeCache = f.projections(), revisionBeforeCache = (await f.repository.read()).revision;
  assert.deepEqual(afterPeriod(await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'})), verified);
  assert.equal(f.projections(), projectionsBeforeCache);
  assert.equal((await f.repository.read()).revision, revisionBeforeCache);

  // Later payment history replaces the supplemental start, never double counts
  // it or leaves a stale pending-history badge in the cached projection.
  await f.append([{kind: 'history', observed_at: '2026-10-10T12:00:15Z', record: {identity: nft, source_json: {
    address: nft, name: 'Synthetic tracked gift', collection_address: collection, src: wallet, dst: address(6),
    ts: start, currency: 'GRAM', price: '4.5', price_nano: '4500000000', duration: 30 * 86400, is_extend: false, tx_hash: null,
  }}}]);
  const paid = afterPeriod(await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'}));
  assert.equal(paid.observed_rentals, 2); assert.equal(paid.verified_rentals_without_history, 0);
  assert.equal(paid.recorded_rentals, 2); assert.equal(paid.recorded_volume, '4.95');
  assert.deepEqual(afterPeriod(await f.engine.getDashboard(ctx, {source: 'rentals', timeframe: '30d'})), paid);
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

test('startup reuses an unchanged dated projection then the normal read recalculates the current window', async t => {
  const f = fixture(t); await f.append([{kind:'settings',record:{wallet:'legacy-owner'}}]);
  const original = await f.engine.getDashboard(ctx, {source:'rentals',timeframe:'30d'});
  f.advance(600000); f.reads.length = 0;
  const saved = await f.engine.getDashboard(ctx, {source:'rentals',timeframe:'30d',startup:true});
  assert.deepEqual(saved.startup_preview, {generated_at:original.generated_at});
  assert.equal(saved.update_token, undefined); assert.equal(f.projections(),1);
  assert.equal(f.reads.some(sql => sql.includes('WITH pending')),false);
  const current = await f.engine.getDashboard(ctx, {source:'rentals',timeframe:'30d'});
  assert.equal(current.startup_preview,undefined); assert.notEqual(current.generated_at,original.generated_at);
  assert.notEqual(current.update_token,original.update_token); assert.equal(f.projections(),2);
  assert.equal((await f.engine.getDashboard(ctx,{source:'rentals',timeframe:'30d',startup:true})).startup_preview,undefined);
  assert.equal(f.projections(),2);
});

test('startup never reuses a changed wallet, different selection, future cache or over-day-old projection', async t => {
  const f = fixture(t); await f.append([{kind:'settings',record:{wallet:'first-owner'}}]);
  await f.engine.getDashboard(ctx); f.advance(60000);
  await f.append([{kind:'settings',record:{wallet:'next-owner'}}]);
  const changed = await f.engine.getDashboard(ctx,{startup:true});
  assert.equal(changed.wallet,'next-owner'); assert.equal(changed.startup_preview,undefined);
  assert.equal((await f.engine.getDashboard(ctx,{source:'rentals',startup:true})).startup_preview,undefined);
  f.advance(86400001);
  assert.equal((await f.engine.getDashboard(ctx,{startup:true})).startup_preview,undefined);
  f.advance(-60000);
  assert.equal((await f.engine.getDashboard(ctx,{startup:true})).startup_preview,undefined);
  await assert.rejects(f.engine.getDashboard({}, {startup:true}),/Private access denied/);
  await assert.rejects(f.engine.getDashboard(ctx,{startup:'yes'}),/startup/);
});

test('startup advances precise rental expiry and totals without rewriting the saved projection', async t => {
  const f = fixture(t), at=Date.parse('2026-10-10T12:00:15Z');
  const original=await f.engine.getDashboard(ctx), key=JSON.stringify(['projection-v10-gift-rental-statistics','listings','30d',null,null,null]);
  const gift={id:'test',is_portfolio:true,state:'rented',ui_state:'rented',rental_until:new Date(at+60000).toISOString(),uncertainties:[]};
  await f.repository.saveDashboardSnapshot(key,0,Math.floor(at/60000),{dashboard:{...original,gifts:[gift],summary:{...original.summary,rented_count:1}},wallet_configured:false,analytics_wallet:null});
  f.advance(120000);
  const saved=await f.engine.getDashboard(ctx,{startup:true});
  assert.ok(saved.startup_preview); assert.equal(saved.gifts[0].state,'expired_pending_return'); assert.equal(saved.gifts[0].ui_state,null);
  assert.equal(saved.summary.rented_count,0); assert.equal(saved.summary.uncertain_count,1);
  const retained=await f.repository.dashboardSnapshot(key,0,Math.floor(at/60000));
  assert.equal(retained.dashboard.gifts[0].state,'rented'); assert.equal((await f.repository.read()).revision,0);
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
