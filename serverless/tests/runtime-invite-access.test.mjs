import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {streamedBody} from './fixtures/http-response.mjs';
import {syntheticAnalyticsPage, syntheticWallet} from './fixtures/marketapp-analytics-page-fixture.mjs';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {normalizePersonalAnalytics} from '../tgcloud/lib/personal-analytics.js';
import {publicReleaseConfig} from '../public-release-config.example.js';
import {installStorageAccounting, installCheckpointSourceAccounting} from '../tools/storage-accounting.mjs';
import {CloudStorageFullError} from '../tgcloud/lib/cloud-repository.js';
import {StorageCapacityError} from '../tgcloud/lib/storage-admission.js';
import {PrivateMarketappSettingsError} from '../tgcloud/lib/private-marketapp-settings.js';

const owner = 12345, invite = 678900002;
const user = id => ({initData: {user: {id}}});
const ownerToken = 'synthetic-private-owner-api-key';
const masterKey = 'ab'.repeat(32);
const address = number => `0:${number.toString(16).padStart(64, '0')}`;
const collection = address(42), gift = address(43);
const config = {...publicReleaseConfig, enabled: true, preservePrivateOwner: true,
  invitedUserIds: [String(invite)], openRegistration: false,
  origin: 'https://gift.example.test', privacyPolicyUrl: 'https://gift.example.test/privacy',
  termsUrl: 'https://gift.example.test/terms', storageEncryptionConfirmed: true,
  providerUseApproved: true, experimentalPersonalAnalytics: false};

// Link the actual runtime source, substituting only SDK capabilities and the
// ignored deployment secrets. Every other import is the real project module.
// This harness never reads private-config.js or private-refresh-key.js.
async function loadRuntime(db, fetch, releaseConfig = config) {
  const path = new URL('../tgcloud/lib/runtime.js', import.meta.url);
  let source = readFileSync(path, 'utf8');
  const declarations = [...source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g)];
  const parameters = [], values = [];
  class EndpointError extends Error {}
  for (const declaration of declarations) {
    const dependency = declaration[3];
    let exports;
    if (dependency === 'sdk') exports = {db, fetch, EndpointError};
    else if (dependency === './private-config.js') exports = {ownerTelegramId: owner, marketappToken: ownerToken};
    else if (dependency === './private-refresh-key.js') exports = {marketappRefreshKey: masterKey};
    else if (dependency === './public-release-config.js') exports = {publicReleaseConfig: releaseConfig};
    else {
      assert.match(dependency, /^\.\/[a-z0-9-]+\.js$/);
      assert.doesNotMatch(dependency, /private-config|private-refresh-key/);
      exports = await import(new URL(dependency, path));
    }
    for (const binding of declaration[1].split(',')) {
      const [imported, local = imported] = binding.trim().split(/\s+as\s+/);
      assert.match(imported, /^[A-Za-z_$][\w$]*$/);
      assert.match(local, /^[A-Za-z_$][\w$]*$/);
      assert.ok(Object.hasOwn(exports, imported), `${dependency}:${imported}`);
      parameters.push(local); values.push(exports[imported]);
    }
    source = source.replace(declaration[0], '');
  }
  const names = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  source = source.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const)\s)/g, '');
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m);
  const factory = vm.runInNewContext(`(function(${parameters.join(',')}) {\n'use strict';\n${source}\nreturn {${names.join(',')}};\n})`, {}, {filename: path.pathname});
  return {runtime: factory(...values), EndpointError};
}

async function setup(t, {releaseConfig = {}, state = {}} = {}) {
  const fixture = createPublicDatabase(t), requests = [];
  const repository = createCloudRepository(fixture.db);
  const now = await repository.clock(), observed = new Date(now).toISOString();
  const checkpoint = {version: 2, next_job_id: 1, job: null, attempts: [], next_allowed_at: 0, ...state};
  assert.equal(await repository.append(0, {key: 'private-seed', state: checkpoint, job: null, raw_body: null, observed_at: observed, records: [
    {kind: 'settings', observed_at: observed, record: {wallet: syntheticWallet}},
    {kind: 'portfolio', observed_at: observed, record: {id: gift, nft_address: gift, name: 'Owner private gift', collection_address: collection, is_portfolio: true}},
  ]}), true);
  const raw = JSON.stringify(syntheticAnalyticsPage({capturedAt: observed}).snapshot);
  const analytics = normalizePersonalAnalytics(raw, syntheticWallet);
  await repository.importPersonalAnalytics(analytics, raw, observed);
  let accounting;do {accounting=await installStorageAccounting(fixture.db,{after:accounting?.after??0});}while(!accounting.complete);
  const loaded = await loadRuntime(fixture.db, async (url, options) => {
    requests.push({url, options});
    if (url === 'https://marketapp.org/') return {status: 200, url, headers: {get: name => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null},
      body: streamedBody('<html><script>Wallet.init({"address":false,"ton_proof":"synthetic-owner-challenge"});</script></html>')};
    if (url === 'https://api.marketapp.org/v1/collections/gifts/') return {status: 200, url, headers: {get: () => null},
      body: streamedBody(JSON.stringify([{address: collection, name: 'Synthetic collection', extra_data: {}}]))};
    throw new Error('Unexpected synthetic provider request');
  }, {...config, ...releaseConfig});
  fixture.queries.length = 0;
  return {...fixture, ...loaded, publicRepository: fixture.repository, repository, analytics, requests, now};
}

test('actual hybrid runtime preserves the private owner dashboard and gives the invite an empty isolated account', async t => {
  const f = await setup(t);
  const privateDashboard = await f.runtime.invokeCloud('getDashboard', {}, user(String(owner)));
  assert.equal(privateDashboard.summary.portfolio_count, 1);
  assert.equal(privateDashboard.gifts[0].id, gift);
  assert.equal(privateDashboard.gifts[0].name, 'Owner private gift');
  assert.equal(privateDashboard.wallet, syntheticWallet);
  assert.equal(privateDashboard.capabilities.public_account, undefined);
  assert.equal(privateDashboard.capabilities.marketapp_configured, true);
  assert.equal(privateDashboard.capabilities.marketapp_analytics_refresh, true);
  assert.deepEqual(privateDashboard.personal_analytics, f.analytics);
  assert.equal(privateDashboard.personal_analytics_snapshots[0].fingerprint, f.analytics.fingerprint);

  const publicDashboard = await f.runtime.invokeCloud('getDashboard', {}, user(invite));
  assert.equal(publicDashboard.summary.portfolio_count, 0);
  assert.equal(publicDashboard.gifts.length, 0);
  assert.equal(publicDashboard.wallet, null);
  assert.equal(publicDashboard.personal_analytics, null);
  assert.equal(publicDashboard.personal_analytics_snapshots.length, 0);
  assert.equal(publicDashboard.capabilities.public_account, true);
  assert.equal(publicDashboard.capabilities.public_onboarding, true);
  assert.equal(publicDashboard.capabilities.marketapp_configured, false);
  assert.equal(publicDashboard.capabilities.marketapp_analytics_refresh, false);
  const account = await f.runtime.invokePublicAccount('getPublicAccount', {}, user(String(invite)));
  assert.equal(account.account.marketapp_key.configured, false);
  assert.equal(account.account.wallet, null);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n, 1);
  assert.equal(f.database.prepare('SELECT user_id FROM public_accounts').get().user_id, String(invite));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_personal_rental_analytics').get().n, 0);
  assert.equal(f.requests.length, 0);
});

test('private dashboard read errors are classified without disclosing data or changing mutation failures',async t=>{
  const f=await setup(t,{releaseConfig:{enabled:false}}),get=f.db.get;
  const marker='synthetic-private-query-and-secret';
  for(const name of ['getDashboard','getDashboardRevision','getJobs']) {
    for(const [failure,expected] of [[Object.assign(Error(marker),{code:'SQLITE_BUSY'}),'READ_BUSY'],
      [Object.assign(Error(marker),{type:'DEADLINE_EXCEEDED'}),'READ_TIMEOUT'],
      [Object.assign(Error(marker),{code:'SQLITE_TOOBIG'}),'READ_LIMIT'],[Error(marker),'READ_FAILED'],
      [new CloudStorageFullError(),'STORAGE_FULL'],[new StorageCapacityError(),'STORAGE_CAPACITY_PAUSED'],
      [new PrivateMarketappSettingsError('PRIVATE_KEY_CHANGED'),'PRIVATE_KEY_CHANGED']]) {
      f.db.get=async()=>{throw failure;};
      assert.equal(JSON.stringify(await f.runtime.invokeCloud(name,{},user(owner))),JSON.stringify({error:{code:expected}}));
    }
  }
  f.db.get=async()=>{throw Object.assign(Error(marker),{code:'SQLITE_BUSY'});};
  await assert.rejects(f.runtime.invokeCloud('startJob',{kind:'prices'},user(owner)),error=>{
    assert.equal(error.message,'The private dashboard request could not be completed.');return true;
  });
  // Authorization remains an EndpointError, even while a storage read would fail.
  await assert.rejects(f.runtime.invokeCloud('getDashboard',{},user(999)),error=>error instanceof f.EndpointError&&error.message==='Private access denied');
  f.db.get=get;
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(owner))).gifts[0].id,gift);
  assert.equal(f.requests.length,0);
});

test('private hybrid read errors include cold shared-ledger preparation without losing known storage errors',async t=>{
  const f=await setup(t),get=f.db.get;
  f.db.get=async()=>{throw Object.assign(Error('private ledger details'),{code:'SQLITE_BUSY'});};
  assert.equal((await f.runtime.invokeCloud('getDashboard',{},user(owner))).error.code,'READ_BUSY');
  f.db.get=get;
  assert.equal((await f.runtime.invokeCloud('getJobs',{},user(owner))).jobs.length,0);
  assert.equal(f.requests.length,0);
});

test('uninvited and missing identities are denied by every wrapper before database or provider access', async t => {
  const f = await setup(t);
  const calls = [
    ctx => f.runtime.invokeCloud('getDashboard', {}, ctx),
    ctx => f.runtime.invokeCloud('getDashboardRevision', {}, ctx),
    ctx => f.runtime.invokeCloud('getJobs', {}, ctx),
    ctx => f.runtime.invokeCloud('startJob', {kind: 'prices'}, ctx),
    ctx => f.runtime.invokeCloud('importChunk', {}, ctx),
    ctx => f.runtime.invokeCloud('importPersonalAnalytics', {}, ctx),
    ctx => f.runtime.invokeOwnedPrice('getStatus', {}, ctx),
    ctx => f.runtime.invokeOwnedPrice('start', {}, ctx),
    ctx => f.runtime.invokeMarketappLogin('startMarketappLoginTest', {}, ctx),
    ctx => f.runtime.invokeMarketappAnalytics('startMarketappAnalyticsRefresh', {}, ctx),
    ctx => f.runtime.invokeMarketappRefreshStatus({}, ctx),
    ctx => f.runtime.invokePublicAccount('getPublicAccount', {}, ctx),
    ctx => f.runtime.invokePublicAccount('saveMarketappApiKey', {api_key: 'synthetic-other-user-key'}, ctx),
    ctx => f.runtime.invokePublicWallet('startWalletVerification', {}, ctx),
    ctx => f.runtime.invokeStorage('status', {}, ctx),
    ctx => f.runtime.invokeStorage('step', {manual:true}, ctx),
  ];
  for (const ctx of [user(67890), {}, undefined, {user: {id: owner}}, user('012345')]) {
    for (const call of calls) assert.equal((await call(ctx)).error.code, 'PUBLIC_ACCESS_DENIED');
  }
  assert.equal(f.queries.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n, 0);
});

test('storage monitoring is scoped, read-only and rejects spoofed owner controls',async t=>{
  const f=await setup(t);
  await f.runtime.invokeCloud('getDashboard',{},user(invite));
  f.queries.length=0;
  const a=await f.runtime.invokeStorage('status',{},user(owner)),b=await f.runtime.invokeStorage('status',{},user(invite));
  assert.equal(a.scope,'app');assert.equal(b.scope,'account');assert.equal(b.budget_bytes,null);
  assert.ok(a.estimated_bytes>b.estimated_bytes);assert.equal(b.cleanup.reclaimed_bytes,0);
  assert.equal(f.requests.length,0);assert.equal(f.queries.some(query=>query.method==='run'),false);
  const count=f.queries.length;
  assert.equal((await f.runtime.invokeStorage('step',{manual:true,isOwner:true},user(invite))).error.code,'PUBLIC_INVALID_INPUT');
  assert.equal((await f.runtime.invokeStorage('step',{manual:'yes'},user(owner))).error.code,'PUBLIC_INVALID_INPUT');
  assert.equal(f.queries.length,count);
  f.database.prepare("UPDATE public_accounts SET status='deleted' WHERE user_id=?").run(String(invite));
  assert.equal((await f.runtime.invokeStorage('step',{manual:true},user(invite))).error.code,'PUBLIC_ACCOUNT_DELETED');
});

test('storage progress opt-in works through both runtime routes without breaking older clients',async t=>{
  const f=await setup(t);await f.runtime.invokePublicAccount('getPublicAccount',{},user(invite));
  await installCheckpointSourceAccounting(f.db);
  const cleanup={state:'running',phase:8,after:1956,boundary:4958,tenant:null,reclaimed_bytes:16700000};
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.now,cleanup,
    accounts:{[String(invite)]:{generation:0,checked_at:f.now,cleanup:{...cleanup,phase:4,after:1,boundary:2,tenant:String(invite)}}}}));
  for(const [id,expected] of [[owner,{stage:'sync_history',stage_number:9,stage_count:16,percent:39}],
    [invite,{stage:'sync_history',stage_number:5,stage_count:7,percent:null}]]) {
    const old=await f.runtime.invokeStorage('status',{},user(id)),disabled=await f.runtime.invokeStorage('status',{progress:false},user(id)),
      current=await f.runtime.invokeStorage('status',{progress:true},user(id));
    assert.equal(Object.hasOwn(old.cleanup,'progress'),false);assert.equal(Object.hasOwn(disabled.cleanup,'progress'),false);
    assert.deepEqual(current.cleanup.progress,expected);
    const count=f.queries.length;
    for(const progress of [null,'true',1,[],{}])for(const method of ['status','step'])
      assert.equal((await f.runtime.invokeStorage(method,{progress},user(id))).error.code,'PUBLIC_INVALID_INPUT');
    assert.equal((await f.runtime.invokeStorage('status',{progress:true,manual:false},user(id))).error.code,'PUBLIC_INVALID_INPUT');
    assert.equal(f.queries.length,count);
  }
  // Advancing bounded local cleanup still includes the negotiated field on
  // both step response paths; no provider calls are part of maintenance.
  f.database.prepare('UPDATE service_storage_monitor SET document=? WHERE id=1').run(JSON.stringify({version:1,checked_at:f.now}));
  for(const id of [owner,invite]) {
    const result=await f.runtime.invokeStorage('step',{manual:true,progress:true},user(id));
    assert.equal(Object.hasOwn(result.cleanup,'progress'),true);
    assert.equal(result.cleanup.progress.stage,id===owner?'sync_history':'discovery');
    assert.equal(result.cleanup.progress.stage_number,id===owner?9:7);
    assert.equal(result.cleanup.state,id===owner?'running':'complete');
  }
  assert.equal(f.requests.length,0);
});

test('storage growth is independently negotiated and scoped through owner and invited runtime routes',async t=>{
  const f=await setup(t);await f.runtime.invokePublicAccount('getPublicAccount',{},user(invite));
  f.queries.length=0;
  for(const id of [owner,invite]) {
    for(const input of [{},{progress:true},{growth:false,progress:true}]) {
      const result=await f.runtime.invokeStorage('status',input,user(id));assert.equal(Object.hasOwn(result,'growth'),false);
    }
    const current=await f.runtime.invokeStorage('status',{growth:true},user(id));
    assert.equal(Object.hasOwn(current.cleanup,'progress'),false);assert.equal(current.growth.state,'collecting');
    assert.equal(current.growth.sample_count,0);assert.equal(current.growth.platform_quota_verified,false);
    assert.equal(current.growth.write_limit_bytes,id===owner?Math.ceil(512*1048576*.9):8*1048576);
    const count=f.queries.length;
    for(const growth of [null,'true',1,[],{}])for(const method of ['status','step'])
      assert.equal((await f.runtime.invokeStorage(method,{growth},user(id))).error.code,'PUBLIC_INVALID_INPUT');
    assert.equal(f.queries.length,count);
  }
  assert.equal(f.queries.some(query=>query.method==='run'),false);
  for(const id of [owner,invite]) {
    const result=await f.runtime.invokeStorage('step',{growth:true,progress:true},user(id));
    assert.equal(result.growth.sample_count,1);assert.equal(result.growth.state,'collecting');
  }
  assert.equal(f.requests.length,0);
});

test('the preserved owner cannot create a second account through account or proof endpoints', async t => {
  const f = await setup(t);
  for (const name of ['getPublicAccount', 'testMarketappApiKey', 'disconnectPublicWallet', 'deletePublicAccount', 'reactivatePublicAccount']) {
    assert.equal((await f.runtime.invokePublicAccount(name, {}, user(owner))).error.code, 'PUBLIC_ACCESS_DENIED');
  }
  for (const name of ['startWalletVerification', 'finishWalletVerification']) {
    assert.equal((await f.runtime.invokePublicWallet(name, {}, user(String(owner)))).error.code, 'PUBLIC_ACCESS_DENIED');
  }
  assert.equal(f.queries.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n, 0);
});

test('actual preserved-owner runtime supports encrypted API settings and durable clear without public enrollment',async t=>{
  const f=await setup(t),status=await f.runtime.invokeMarketappSettings('getMarketappSettings',{},user(owner));
  assert.equal(status.configured,true);assert.equal(status.source,'serverless_private');assert.equal(status.can_manage,true);
  assert.equal(f.requests.length,0);assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);
  const replacement='synthetic-private-ui-replacement-key';
  const saved=await f.runtime.invokePublicAccount('saveMarketappApiKey',{api_key:replacement},user(owner));assert.equal(saved.configured,true);assert.equal(saved.source,'encrypted_backend');
  assert.doesNotMatch(JSON.stringify(saved),new RegExp(replacement));
  const row=f.database.prepare('SELECT ciphertext,nonce_counter FROM private_provider_credentials').get();assert.ok(row.ciphertext);assert.doesNotMatch(row.ciphertext,new RegExp(replacement));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_provider_credentials').get().n,0);assert.equal(f.requests.length,0);
  const cleared=await f.runtime.invokePublicAccount('removeMarketappApiKey',{},user(owner));assert.equal(cleared.configured,false);assert.equal(cleared.source,'none');assert.equal(f.requests.length,0);
  const dashboard=await f.runtime.invokeCloud('getDashboard',{},user(owner));assert.equal(dashboard.capabilities.marketapp_configured,false);assert.equal(dashboard.summary.portfolio_count,1);assert.deepEqual(dashboard.personal_analytics,f.analytics);
  await assert.rejects(f.runtime.invokeCloud('startJob',{kind:'prices'},user(owner)),/Configure the private Marketapp token/);assert.equal(f.requests.length,0);
  const reloaded=await loadRuntime(f.db,async()=>{throw new Error('No request expected');});
  assert.equal((await reloaded.runtime.invokeMarketappSettings('getMarketappSettings',{},user(owner))).configured,false);
  assert.equal(f.database.prepare('SELECT ciphertext FROM private_provider_credentials').get().ciphertext,null);
  assert.ok(f.database.prepare('SELECT nonce_counter FROM private_provider_credentials').get().nonce_counter>row.nonce_counter);
});

test('actual private collection uses the changed key and settings actions preserve quota ledgers',async t=>{
  const f=await setup(t);
  await f.runtime.invokeCloud('getDashboard',{},user(owner));
  const ledgerBefore=f.database.prepare('SELECT scope_key,revision,document FROM public_provider_gates ORDER BY scope_key').all();
  const replacement='synthetic-private-ui-live-key';assert.equal((await f.runtime.invokePublicAccount('saveMarketappApiKey',{api_key:replacement},user(owner))).configured,true);
  assert.deepEqual(f.database.prepare('SELECT scope_key,revision,document FROM public_provider_gates ORDER BY scope_key').all(),ledgerBefore);
  const started=await f.runtime.invokeCloud('startJob',{kind:'prices'},user(owner));assert.ok(started.job);
  await f.runtime.invokeCloud('stepJob',{job_id:started.job.id},user(owner));assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.headers.Authorization,replacement);
  const status=await f.runtime.invokeMarketappSettings('getMarketappSettings',{},user(owner));assert.equal(status.can_manage,true);assert.equal(status.reason,'active_job');
  await f.runtime.invokeCloud('stopJob',{job_id:started.job.id},user(owner));
  const beforeClear=f.database.prepare('SELECT scope_key,revision,document FROM public_provider_gates ORDER BY scope_key').all();
  assert.equal((await f.runtime.invokePublicAccount('removeMarketappApiKey',{},user(owner))).configured,false);
  assert.deepEqual(f.database.prepare('SELECT scope_key,revision,document FROM public_provider_gates ORDER BY scope_key').all(),beforeClear);assert.equal(f.requests.length,1);
});

test('private settings routing rejects foreign callers without database access and leaves invited key enrollment isolated',async t=>{
  const f=await setup(t);f.queries.length=0;
  for(const id of [invite,67890])for(const name of ['getMarketappSettings','saveMarketappApiKey','removeMarketappApiKey'])assert.equal((await f.runtime.invokeMarketappSettings(name,{},user(id))).error.code,'PUBLIC_ACCESS_DENIED');
  assert.equal(f.queries.length,0);assert.equal(f.requests.length,0);
  const enrolled=await f.runtime.invokePublicAccount('saveMarketappApiKey',{api_key:'synthetic-invited-ui-api-key'},user(invite));assert.equal(enrolled.account.marketapp_key.configured,true);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM private_provider_credentials').get().n,0);assert.equal(f.requests.length,0);
});

test('invited analytics remains disabled after wallet verification while owner website engines remain available', async t => {
  const f = await setup(t);
  const publicRepository = f.publicRepository(String(invite));
  await publicRepository.ensureAccount();
  const saved = await publicRepository.read();
  assert.equal(await publicRepository.append(saved.revision, {key: 'wallet-bind:synthetic-verified', state: saved.state,
    records: [{kind: 'settings', record: {wallet: address(44), wallet_verified_at: new Date(f.now).toISOString(), wallet_verification: 'ton_proof'}}],
    observed_at: new Date(f.now).toISOString()}), true);
  f.queries.length = 0;
  for (const call of [
    () => f.runtime.invokeMarketappLogin('startMarketappLoginTest', {}, user(invite)),
    () => f.runtime.invokeMarketappAnalytics('startMarketappAnalyticsRefresh', {period_days: 30}, user(invite)),
    () => f.runtime.invokeMarketappRefreshStatus({}, user(invite)),
  ]) assert.equal((await call()).error.code, 'PUBLIC_ANALYTICS_DISABLED');
  assert.ok(f.queries.every(({sql}) => !/\b(?:marketapp_login_attempts|marketapp_analytics_sessions|personal_rental_analytics)\b/.test(sql)));
  assert.equal(f.requests.length, 0);

  const session = await f.runtime.invokeMarketappAnalytics('getMarketappAnalyticsSessionStatus', {}, user(owner));
  assert.equal(session.remembered, false);
  const status = await f.runtime.invokeMarketappRefreshStatus({}, user(String(owner)));
  assert.equal(status.attempt, null);
  assert.equal(status.session.remembered, false);
  const login = await f.runtime.invokeMarketappLogin('startMarketappLoginTest', {}, user(owner));
  assert.equal(login.challenge, 'synthetic-owner-challenge');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://marketapp.org/');
  assert.equal(f.requests[0].options.headers.Authorization, undefined);
  assert.equal(f.database.prepare('SELECT owner_id FROM marketapp_login_attempts').get().owner_id, String(owner));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_marketapp_login_attempts').get().n, 0);
});

test('prototype endpoints remain owner-only and all historical collection entrypoints stay disabled', async t => {
  const f = await setup(t);
  for (const ctx of [user(invite), user(67890), {}, undefined]) {
    for (const name of ['getState', 'startRun', 'stepRun', 'resumeRun', 'stopRun']) {
      await assert.rejects(f.runtime.engine[name](ctx, {}), /Private access denied/);
    }
  }
  assert.equal(f.queries.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.runtime.engine.getState(user(owner))).user.id, String(owner));
  for (const name of ['startRun', 'stepRun', 'resumeRun']) {
    await assert.rejects(f.runtime.engine[name](user(owner), {}), /pricing dashboard replaced prototype collection/);
  }
  assert.equal(f.requests.length, 0);
});

test('runtime seeds private raw provider usage and cooldowns once without HTTP or migrating private records', async t => {
  const at = Date.now();
  const state = {attempts: [at - 10000, at - 5000], next_allowed_at: at + 60000,
    marketapp_budget_reset: {id: 'synthetic-reset', excluded_attempts: [at - 10000, at - 5000]},
    owned_prices: {version: 2, next_run_id: 1, run: null, previous_run: null, last_session: null, attempts: [at - 3000], next_allowed_at: at + 30000}};
  const f = await setup(t, {state});
  const before = await f.repository.read();
  await f.runtime.invokeCloud('getDashboard', {}, user(owner));
  const gates = () => f.database.prepare('SELECT scope_key,document FROM public_provider_gates ORDER BY scope_key').all().map(row => ({scope: row.scope_key, ...JSON.parse(row.document)}));
  const initial = gates();
  assert.equal(initial.length, 2);
  assert.equal(initial.find(row => row.scope.endsWith(':marketapp')).attempts.length, 2);
  assert.equal(initial.find(row => row.scope.endsWith(':toncenter')).attempts.length, 1);
  assert.equal(initial.find(row => row.scope.endsWith(':marketapp')).next_allowed_at, state.next_allowed_at);
  assert.equal(initial.find(row => row.scope.endsWith(':toncenter')).next_allowed_at, state.owned_prices.next_allowed_at);
  assert.ok(initial.every(row => row.private_owner_seed.version === 1));
  const second = await loadRuntime(f.db, async () => {throw new Error('Read-only restart must not fetch');});
  await second.runtime.invokeCloud('getDashboard', {}, user(owner));
  const invited = await second.runtime.invokeCloud('getDashboard', {}, user(invite));
  assert.equal(invited.capabilities.marketapp_limits.remaining_24h, 498);
  assert.deepEqual(gates(), initial);
  assert.deepEqual(await f.repository.read(), before);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n, 0);
  assert.equal(f.requests.length, 0);
});

test('the actual owner collection and invited key check share the inherited service allowance', async t => {
  const f = await setup(t, {releaseConfig: {globalMarketDailyAttempts: 1}, state: {attempts: [Date.now() - 60000]}});
  const started = await f.runtime.invokeCloud('startJob', {kind: 'prices'}, user(owner));
  assert.equal(started.job.state, 'running');
  const step = await f.runtime.invokeCloud('stepJob', {job_id: started.job.id}, user(owner));
  assert.equal(step.job.state, 'partial');
  assert.match(step.job.reason, /provider allowance/i);
  const saved = await f.runtime.invokePublicAccount('saveMarketappApiKey', {api_key: 'synthetic-invited-user-api-key'}, user(invite));
  assert.equal(saved.account.marketapp_key.configured, true);
  const checked = await f.runtime.invokePublicAccount('testMarketappApiKey', {}, user(invite));
  assert.equal(checked.error.code, 'PUBLIC_PROVIDER_WAIT');
  assert.equal(f.requests.length, 0);
  const ledger = JSON.parse(f.database.prepare("SELECT document FROM public_provider_gates WHERE scope_key='public-provider-v1:marketapp'").get().document);
  assert.equal(ledger.attempts.length, 1);
});

test('the first private collection request seeds before reservation and counts exactly once in each ledger', async t => {
  const f = await setup(t);
  const started = await f.runtime.invokeCloud('startJob', {kind: 'prices'}, user(owner));
  const stepped = await f.runtime.invokeCloud('stepJob', {job_id: started.job.id}, user(owner));
  assert.equal(stepped.job.state, 'running');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.marketapp.org/v1/collections/gifts/');
  assert.equal(f.requests[0].options.headers.Authorization, ownerToken);
  const ledger = JSON.parse(f.database.prepare("SELECT document FROM public_provider_gates WHERE scope_key='public-provider-v1:marketapp'").get().document);
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0].id.startsWith('private:'), true);
  assert.equal((await f.repository.read()).state.attempts.length, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_provider_credentials').get().n, 0);
});
