import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {normalizePersonalAnalytics, PERSONAL_ANALYTICS_MAX_BYTES} from '../tgcloud/lib/personal-analytics.js';
import {canonicalJSON} from '../tgcloud/lib/cloud-pricing-core.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';

const wallet = `0:${'11'.repeat(32)}`, otherWallet = `0:${'22'.repeat(32)}`;
const friendlyWallet = 'EQAREREREREREREREREREREREREREREREREREREREREREeYT';
function friendly(address, tag = 0x11) {
  const bytes = Buffer.concat([Buffer.from([tag, 0]), Buffer.from(address.slice(2), 'hex')]);
  let crc = 0; for (const byte of bytes) {crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  return Buffer.concat([bytes, Buffer.from([crc >> 8, crc & 255])]).toString('base64url');
}
const ctx = {initData: {user: {id: 12345}}};
const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
const chart = (key, series, unit) => ({key, spec_raw: JSON.stringify({categories: null, gran: 'day', kind: 'column', series, stacking: null, unit, x: dates})});
function fixture() {
  return {version: 1, source: 'marketapp_personal_rent_page', source_url: `https://marketapp.org/user/${friendlyWallet}/?tab=analytics_rent`, wallet,
    captured_at: '2026-10-03T14:00:00+02:00',
    summary: [
      {label: 'Rent volume', value: '3.2345', foot: '-4.0%', definition: 'Before fees'},
      {label: 'Rentals', value: '4', foot: '-2% 2 items'},
      {label: 'Price per day', value: '0.12'}, {label: 'Average duration', value: '4.8days'},
      {label: 'Extensions', value: '25%'}, {label: 'Spent on rent', value: '0', foot: '0 rentals'},
    ], charts: [
      chart('profile.rent.income', [{name: 'Rent volume', data: [1.2345, 2, 0]}], 'GRAM'),
      chart('profile.rent.rentals', [{name: 'New rentals', data: [1, 2.0, 0]}, {name: 'Extensions', data: [0, 1, 0]}], ''),
      chart('profile.rent.day_price', [{name: 'Price per day', data: [0.1, 0.14, null]}], 'GRAM'),
      chart('profile.rent.duration', [{name: 'Average duration', data: [2.2, 5, null]}], 'days'),
    ]};
}
const rawFixture = () => JSON.stringify(fixture());
const normalize = source => normalizePersonalAnalytics(JSON.stringify(source), wallet);
function changeChart(source, key, fn) {
  const entry = source.charts.find(row => row.key === key), spec = JSON.parse(entry.spec_raw);
  fn(spec); entry.spec_raw = JSON.stringify(spec); return source;
}

test('daily personal snapshot preserves exact monetary values, separate extensions and aggregate semantics', () => {
  const result = normalize(fixture());
  assert.equal(result.wallet, wallet); assert.equal(result.captured_at, '2026-10-03T12:00:00.000Z');
  assert.equal(result.volume_basis, 'gross_before_fees'); assert.equal(result.timezone, 'UTC');
  assert.deepEqual(result.summary, {rent_volume: '3.2345', rentals: 4, new_rentals: 3, extensions: 1, items: 2,
    price_per_day: '0.12', average_duration: '4.8', extension_percent: '25', spent_on_rent: '0', spending_rentals: 0});
  assert.deepEqual(result.daily[2], {date: dates[2], rent_volume: '0', new_rentals: 0, extensions: 0, rentals: 0});
  const {fingerprint, ...content} = result;
  assert.equal(fingerprint, createHash('sha256').update(canonicalJSON(content), 'utf8').digest('hex'));
  assert.equal(fingerprint, normalize(fixture()).fingerprint);
});

test('provider decimal lexemes remain exact above floating-point integer precision', () => {
  const source = fixture(); source.summary[0].value = '9007199254740993.0001';
  source.charts = [chart('profile.rent.income', [{name: 'Rent volume', data: [0, 0, 0]}], 'GRAM'), ...source.charts.slice(1)];
  source.charts[0].spec_raw = source.charts[0].spec_raw.replace('[0,0,0]', '[9007199254740993.0001,0,0]');
  assert.equal(normalize(source).summary.rent_volume, '9007199254740993.0001');
});

test('summary tiles reconcile provider rounding while preserving exact daily amounts', () => {
  const source = fixture(); source.summary[0].value = '3.23';
  assert.equal(normalize(source).summary.rent_volume, '3.23');
  assert.equal(normalize(source).daily[0].rent_volume, '1.2345');
  source.charts[0].spec_raw = source.charts[0].spec_raw.replace('1.2345', '1.235'); source.summary[0].value = '3.24';
  assert.equal(normalize(source).summary.rent_volume, '3.24');
  source.summary[0].value = '3.23'; assert.throws(() => normalize(source), /invalid/);
  source.summary[0].value = '3'; assert.throws(() => normalize(source), /invalid/);
});

test('conventional grouped summary numbers, dense footnotes and explicit unknowns match desktop parsing', () => {
  const source = fixture(); source.summary[0].value = '1,234.5'; source.summary[1].foot = '-10%1,234 items';
  source.charts[0].spec_raw = source.charts[0].spec_raw.replace('1.2345', '1232.5');
  assert.equal(normalize(source).summary.items, 1234);
  assert.equal(normalize(source).summary.rent_volume, '1234.5');
  for (const value of ['12,34.5', '0,001', '01.25', '1,2345']) {source.summary[0].value = value; assert.throws(() => normalize(source), /invalid/);}
  for (const unknown of ['', '—', '–', '-']) {const sample = fixture(); sample.summary[2].value = unknown; assert.equal(normalize(sample).summary.price_per_day, null);}
  const unknown = fixture(); unknown.cookie = 'a secret session'; assert.throws(() => normalize(unknown), /invalid/);
  const percent = fixture(); percent.summary[4].value = '100.0001%'; assert.throws(() => normalize(percent), /invalid/);
});

test('optional metrics preserve absence and explicit zero without averaging daily rates', () => {
  const source = fixture(); source.summary = source.summary.slice(0, 2); source.summary[1].foot = '';
  const result = normalize(source);
  assert.equal(result.summary.items, null); assert.equal(result.summary.price_per_day, null);
  assert.equal(result.summary.spent_on_rent, null); assert.equal(result.summary.spending_rentals, null);
  source.summary.push({label: 'Price per day', value: '—'});
  assert.equal(normalize(source).summary.price_per_day, null);
  source.summary.at(-1).value = null;
  source.summary[1].foot = null;
  assert.equal(normalize(source).summary.price_per_day, null);
  assert.equal(normalize(source).summary.items, null);
});

test('wallet-scoped sources reject alias checksum errors, testnet and unrelated or filtered pages', () => {
  const good = fixture(); good.wallet = wallet.toUpperCase();
  assert.equal(normalize(good).wallet, wallet);
  for (const url of [`https://example.com/user/${friendlyWallet}/?tab=analytics_rent`,
    `https://marketapp.org/user/${friendly(otherWallet)}/?tab=analytics_rent`,
    `https://marketapp.org/user/${friendlyWallet}/?tab=analytics_rent&collection=x`,
    `https://marketapp.org/user/${friendlyWallet}/?tab=analytics_rent&tab=analytics_rent`,
    `https://marketapp.org/user/${friendlyWallet}/?tab=analytics_rent#fragment`,
    `https://marketapp.org/user/${friendlyWallet}/?tab=analytics_rent&period_by=all`,
    `https://marketapp.org/user/${friendlyWallet}/?tab=analytics_rent&group_by=unknown`,
  ]) {const source = fixture(); source.source_url = url; assert.throws(() => normalize(source), /invalid/);}
  const source = fixture(); source.wallet = otherWallet; assert.throws(() => normalize(source), /different wallet/);
  source.wallet = 'not-an-address'; assert.throws(() => normalize(source), /invalid/);
  source.wallet = friendly(wallet, 0x91); assert.throws(() => normalize(source), /invalid/);
  source.wallet = friendlyWallet.slice(0, -1) + 'A'; assert.throws(() => normalize(source), /invalid/);
  source.wallet = friendly(wallet, 0x51); assert.equal(normalize(source).wallet, wallet);
});

test('bounded daily spans accept leap years and exponent values without truncating decimal evidence', () => {
  const source = fixture(); source.charts[0].spec_raw = source.charts[0].spec_raw.replace('1.2345', '12345e-4');
  assert.equal(normalize(source).daily[0].rent_volume, '1.2345');
  source.charts[1].spec_raw = source.charts[1].spec_raw.replace('[1,2,0]', '[1.00000,2e0,0]');
  assert.equal(normalize(source).summary.rentals, 4);
  for (const length of [366, 367]) {
    const first = Date.parse('2024-01-01T00:00:00Z'), days = Array.from({length}, (_, index) => new Date(first + index * 86400000).toISOString().slice(0, 10));
    const sample = fixture(); sample.captured_at = '2025-01-02T00:00:00Z'; sample.summary = [{label: 'Rent volume', value: '0'}, {label: 'Rentals', value: '0'}];
    sample.charts = [chart('profile.rent.income', [{name: 'Rent volume', data: days.map(() => 0)}], 'GRAM'), chart('profile.rent.rentals', [{name: 'New rentals', data: days.map(() => 0)}, {name: 'Extensions', data: days.map(() => 0)}], '')];
    for (const entry of sample.charts) {const spec = JSON.parse(entry.spec_raw); spec.x = days; entry.spec_raw = JSON.stringify(spec);}
    if (length === 366) assert.equal(normalize(sample).daily.length, 366);
    else assert.throws(() => normalize(sample), /invalid/);
  }
});

test('invalid charts, gaps, duplicates, fractional counts, negative and imprecise amounts fail closed', () => {
  const mutations = [
    source => changeChart(source, 'profile.rent.income', spec => {spec.gran = 'week';}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.unit = 'TON';}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.x[1] = '2026-10-03';}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.x[1] = '2026-02-30';}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.series[0].data[0] = -1;}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.series[0].data[0] = 0.12345;}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.series[0].data[0] = null;}),
    source => changeChart(source, 'profile.rent.income', spec => {spec.series[0].data[0] = '1.2345';}),
    source => changeChart(source, 'profile.rent.rentals', spec => {spec.series[0].data[0] = 1.5;}),
    source => changeChart(source, 'profile.rent.rentals', spec => {spec.series[0].data.pop();}),
    source => changeChart(source, 'profile.rent.duration', spec => {spec.x[0] = '2026-09-30';}),
    source => {source.summary[0].value = '4'; return source;},
    source => {source.summary[1].value = '5'; return source;},
    source => {source.charts.push(source.charts[0]); return source;},
    source => {source.captured_at = '2026-10-02T12:00:00Z'; return source;},
  ];
  for (const mutation of mutations) assert.throws(() => normalize(mutation(fixture())), /invalid/);
  assert.throws(() => normalizePersonalAnalytics(rawFixture().replace('"version":1', '"version":1,"version":1'), wallet), /invalid/);
  assert.throws(() => normalizePersonalAnalytics('x'.repeat(PERSONAL_ANALYTICS_MAX_BYTES + 1), wallet), /invalid/);
  assert.throws(() => normalizePersonalAnalytics('🦋'.repeat(70000), wallet), /invalid/);
});

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE TABLE personal_rental_analytics(fingerprint TEXT PRIMARY KEY,wallet TEXT NOT NULL,captured_at TEXT NOT NULL,imported_at TEXT NOT NULL,raw_snapshot TEXT NOT NULL,normalized_json TEXT NOT NULL);`);
  const db = {async get(sql, params = {}) {return database.prepare(sql).get(params) || null;},
    async run(sql, params = {}) {return {rowsAffected: Number(database.prepare(sql).run(params).changes)};},
    async all(sql, params = {}) {return database.prepare(sql).all(params);}};
  const repository = createCloudRepository(db); let requests = 0;
  const engine = createCloudEngine({repository, ownerTelegramId: 12345, marketappToken: 'fixture-secret', now: () => Date.parse('2026-10-04T00:00:00Z'), fetch: async () => {requests++; throw new Error('No network expected');}});
  return {database, repository, engine, requests: () => requests};
}
const seed = async engine => engine.importChunk(ctx, {import_id: 'analytics-settings', chunk_index: 0, records: [{kind: 'settings', key: 'wallet', observed_at: '2026-10-04T00:00:00Z', record: {wallet}}]});

function periodFixture(length, volume, capturedAt = '2026-10-03T12:00:00Z', owner = wallet) {
  const source = fixture(), last = Date.parse('2026-10-03T00:00:00Z');
  const days = Array.from({length}, (_, index) => new Date(last - (length - index - 1) * 86400000).toISOString().slice(0, 10));
  source.wallet = owner; source.source_url = `https://marketapp.org/user/${friendly(owner)}/?tab=analytics_rent`;
  source.captured_at = capturedAt; source.summary[0].value = volume;
  source.charts = [
    chart('profile.rent.income', [{name: 'Rent volume', data: days.map((_, index) => index ? 0 : Number(volume))}], 'GRAM'),
    chart('profile.rent.rentals', [{name: 'New rentals', data: days.map((_, index) => index ? 0 : 3)}, {name: 'Extensions', data: days.map((_, index) => index ? 0 : 1)}], ''),
  ];
  for (const entry of source.charts) {const spec = JSON.parse(entry.spec_raw); spec.x = days; entry.spec_raw = JSON.stringify(spec);}
  return source;
}

test('private cloud imports are immutable, deduplicated and independent from collection ledger', async () => {
  const t = setup(); await seed(t.engine);
  const before = await t.repository.read();
  const result = await t.engine.importPersonalAnalytics(ctx, {snapshot: rawFixture()});
  const row = t.database.prepare('SELECT * FROM personal_rental_analytics').get();
  assert.equal(row.raw_snapshot, rawFixture()); assert.equal(JSON.parse(row.normalized_json).fingerprint, result.personal_analytics.fingerprint);
  await t.engine.importPersonalAnalytics(ctx, {snapshot: rawFixture()});
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 1);
  assert.deepEqual(await t.repository.read(), before); assert.equal(t.requests(), 0);
  const dashboard = await t.engine.getDashboard(ctx);
  assert.equal(dashboard.personal_analytics.fingerprint, result.personal_analytics.fingerprint);
  t.database.close();
});

test('latest capture wins over import order and wallet changes cannot show another wallet’s personal data', async () => {
  const t = setup(); await seed(t.engine);
  const newer = fixture(); newer.captured_at = '2026-10-03T16:00:00Z';
  const result = await t.engine.importPersonalAnalytics(ctx, {snapshot: JSON.stringify(newer)});
  await t.engine.importPersonalAnalytics(ctx, {snapshot: rawFixture()});
  assert.equal((await t.engine.getDashboard(ctx)).personal_analytics.fingerprint, result.personal_analytics.fingerprint);
  await t.engine.importChunk(ctx, {import_id: 'different-wallet', chunk_index: 0, records: [{kind: 'settings', key: 'wallet', observed_at: '2026-10-04T00:00:00Z', record: {wallet: otherWallet}}]});
  assert.equal((await t.engine.getDashboard(ctx)).personal_analytics, null);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 2);
  t.database.close();
});

test('saved reporting periods retain the latest 30-day capture and a separate 365-day capture', async () => {
  const t = setup(); await seed(t.engine); const before = await t.repository.read();
  const year = await t.engine.importPersonalAnalytics(ctx, {snapshot: JSON.stringify(periodFixture(365, '501.23', '2026-10-03T13:00:00Z'))});
  const recent = await t.engine.importPersonalAnalytics(ctx, {snapshot: JSON.stringify(periodFixture(30, '8.9', '2026-10-03T12:00:00Z'))});
  await t.engine.importPersonalAnalytics(ctx, {snapshot: JSON.stringify(periodFixture(30, '4.56', '2026-10-03T11:00:00Z'))});
  const snapshots = await t.repository.personalAnalyticsSnapshots(wallet);
  assert.deepEqual(snapshots.map(row => row.daily.length), [365, 30]);
  assert.deepEqual(snapshots.map(row => row.summary.rent_volume), ['501.23', '8.9']);
  assert.deepEqual(snapshots.map(row => row.fingerprint), [year.personal_analytics.fingerprint, recent.personal_analytics.fingerprint]);
  assert.equal((await t.repository.latestPersonalAnalytics(wallet)).fingerprint, year.personal_analytics.fingerprint);
  const dashboard = await t.engine.getDashboard(ctx);
  assert.deepEqual(dashboard.personal_analytics_snapshots, snapshots);
  assert.equal(dashboard.personal_analytics.fingerprint, year.personal_analytics.fingerprint);
  assert.deepEqual(await t.repository.read(), before); assert.equal(t.requests(), 0);
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 3, 'older captures remain retained');
  t.database.close();
});

test('period options are wallet-scoped and capped at eight newest daily lengths with bounded SQL results', async () => {
  const t = setup(); await seed(t.engine);
  for (let length = 1; length <= 10; length++) {
    await t.engine.importPersonalAnalytics(ctx, {snapshot: JSON.stringify(periodFixture(length, '1.2', `2026-10-03T12:00:${String(length).padStart(2, '0')}Z`))});
  }
  const different = normalizePersonalAnalytics(JSON.stringify(periodFixture(365, '9.8', '2026-10-03T14:00:00Z', otherWallet)), otherWallet);
  await t.repository.importPersonalAnalytics(different, 'synthetic other-wallet capture', '2026-10-04T00:00:00Z');
  const options = await t.repository.personalAnalyticsSnapshots(wallet);
  assert.deepEqual(options.map(row => row.daily.length), [10, 9, 8, 7, 6, 5, 4, 3]);
  assert.ok(options.every(row => row.wallet === wallet));
  assert.deepEqual((await t.repository.personalAnalyticsSnapshots(otherWallet)).map(row => row.daily.length), [365]);
  assert.deepEqual(await t.repository.personalAnalyticsSnapshots(`0:${'33'.repeat(32)}`), []);
  assert.equal(t.requests(), 0); t.database.close();
});

test('period reads skip malformed, empty and oversized stored representations without exposing another wallet', async () => {
  const t = setup(); await seed(t.engine);
  await t.engine.importPersonalAnalytics(ctx, {snapshot: rawFixture()});
  const insert = t.database.prepare('INSERT INTO personal_rental_analytics VALUES(?,?,?,?,?,?)');
  for (const [key, normalized] of [['bad', '{malformed'], ['empty', '{"daily":[]}'], ['oversized', JSON.stringify({daily: [{}], padding: 'x'.repeat(131072)})]]) {
    insert.run(key, wallet, '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z', 'invalid fixture', normalized);
  }
  assert.equal((await t.repository.personalAnalyticsSnapshots(wallet)).length, 1);
  assert.equal(t.requests(), 0); t.database.close();
});

test('the dashboard authorizes before reading personal reporting periods', async () => {
  let reads = 0, requests = 0;
  const engine = createCloudEngine({ownerTelegramId: 12345, marketappToken: 'fixture-secret',
    repository: {read: async () => {reads++;}, records: async () => {reads++;}, personalAnalyticsSnapshots: async () => {reads++;}},
    fetch: async () => {requests++;}});
  for (const unauthorized of [{}, {initData: {user: {id: 54321}}}]) await assert.rejects(engine.getDashboard(unauthorized), /Private access denied/);
  assert.equal(reads, 0); assert.equal(requests, 0);
});

test('authorization and bounded input precede all storage; errors never repeat snapshot or credentials', async () => {
  let reads = 0;
  const engine = createCloudEngine({repository: {records: async () => {reads++; return []; }}, ownerTelegramId: 12345, marketappToken: 'fixture-secret'});
  await assert.rejects(engine.importPersonalAnalytics({}, {snapshot: rawFixture()}), /Private access denied/);
  await assert.rejects(engine.importPersonalAnalytics(ctx, {snapshot: 'x'.repeat(PERSONAL_ANALYTICS_MAX_BYTES + 1)}), /invalid or exceeds/);
  await assert.rejects(engine.importPersonalAnalytics(ctx, {snapshot: 'fixture-secret'}), error => !error.message.includes('fixture-secret'));
  assert.equal(reads, 0);
  await assert.rejects(engine.importPersonalAnalytics(ctx, {snapshot: rawFixture()}), /mainnet wallet/);
  const t = setup(); await seed(t.engine); const wrong = fixture(); wrong.wallet = otherWallet;
  await assert.rejects(t.engine.importPersonalAnalytics(ctx, {snapshot: JSON.stringify(wrong)}), /different wallet/);
  await assert.rejects(t.engine.importPersonalAnalytics(ctx, {snapshot: '{invalid private input'}), error => !error.message.includes('private input'));
  assert.equal(t.database.prepare('SELECT count(*) AS n FROM personal_rental_analytics').get().n, 0); t.database.close();
});
