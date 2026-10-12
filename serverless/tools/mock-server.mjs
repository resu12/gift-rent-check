// Local QA only. This file is outside tgcloud/ and dist/, so it is not deployed.
// No production credentials, Telegram network calls, or Marketapp traffic.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createCloudEngine} from '../tgcloud/lib/cloud-engine.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
import {createOwnedPriceEngine} from '../tgcloud/lib/owned-price-engine.js';
import {MARKETAPP_OPERATOR} from '../tgcloud/lib/ton-price-decoder.js';
import {readSeed} from './import-seed.mjs';
import {option} from './destination.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.MOCK_PORT || 8766);
// An explicit seed path enables a read-only personal-data preview. Always keep
// its imported copy in memory, even if a synthetic-test MOCK_DB is configured.
const seedManifest = process.env.MOCK_SEED_MANIFEST;
const readOnlyPreview = Boolean(seedManifest);
const mockOwnedPrices = process.env.MOCK_OWNED_PRICES === '1' && !readOnlyPreview;
// Optional synthetic progress fixtures; seed previews remain unchanged.
const collectionCount = readOnlyPreview ? 1 : Number(process.env.MOCK_COLLECTIONS || 1);
const mockRetryAfter = readOnlyPreview ? 0 : Number(process.env.MOCK_RETRY_AFTER_SECONDS || 0);
if (!Number.isSafeInteger(collectionCount) || collectionCount < 1 || collectionCount > 10) throw new Error('MOCK_COLLECTIONS must be an integer from 1 to 10');
if (!Number.isSafeInteger(mockRetryAfter) || mockRetryAfter < 0 || mockRetryAfter > 60) throw new Error('MOCK_RETRY_AFTER_SECONDS must be an integer from 0 to 60');
const database = new DatabaseSync(readOnlyPreview ? ':memory:' : (process.env.MOCK_DB || ':memory:'));
database.exec('CREATE TABLE IF NOT EXISTS cloud_events (sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL)');
database.exec('CREATE TABLE IF NOT EXISTS collector_state (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,document TEXT NOT NULL)');
database.exec('CREATE TABLE IF NOT EXISTS personal_rental_analytics (fingerprint TEXT PRIMARY KEY,wallet TEXT,captured_at TEXT,imported_at TEXT,raw_snapshot TEXT,normalized_json TEXT)');
database.exec('CREATE TABLE IF NOT EXISTS owned_refresh_runs (run_id INTEGER PRIMARY KEY,summary_json TEXT NOT NULL,source_sequence INTEGER NOT NULL)');
database.exec('CREATE TABLE IF NOT EXISTS owned_refresh_sessions (session_id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,source_sequence INTEGER NOT NULL)');
database.exec('CREATE TABLE IF NOT EXISTS owned_refresh_index (id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL)');
const db = {
  async run(sql, parameters = {}) {const result = database.prepare(sql).run(parameters); return {rowsAffected: Number(result.changes)};},
  async get(sql, parameters = {}) {return database.prepare(sql).get(parameters) || null;},
  async all(sql, parameters = {}) {return database.prepare(sql).all(parameters);},
};
const address = id => `0:${String(id).padStart(64, '0')}`;
const collection = address(100);
const groups = Array.from({length: collectionCount}, (_, i) => ({
  collection: address(100 + i), name: i === 0 ? 'Demo Low Riders' : `Demo Low Riders ${i + 1}`,
  ids: [1, 2, 3, 4].map(id => i * 4 + id),
}));
const nftCollections = new Map(groups.flatMap(group => group.ids.map(id => [address(id), group.collection])));
const wallet = address(999);
const observed = new Date().toISOString();
const item = (id, amount) => ({nft_address: address(id), nft_name: `Demo Low Rider #${id}`, owner: wallet, attributes: [{trait_type: 'Model', value: 'Sample model'}, {trait_type: 'Backdrop', value: id % 4 === 0 ? 'Onyx' : 'Black'}], min_duration: 1, max_duration: 30, price_per_day: amount, discount_per_day: 0, listed_at: null});
const pagesFor = ids => ({
  head: {cursor: 'page-2', items: [item(ids[0], '390000000'), item(ids[1], '125500000')]},
  'page-2': {cursor: 'page-3', items: [item(ids[2], '170000000')]},
  'page-3': {cursor: null, items: [item(ids[3], '50000000')]},
});
let providerAttempts = 0, tonAttempts = 0, mockRetrySent = false;
const startupCalls = [], endpointCalls = [];
const history = id => ({address: address(id), name: `Demo Low Rider #${id}`, collection_address: nftCollections.get(address(id)), src: wallet, dst: address(888), price: id % 4 === 1 ? '0.6' : '0.9', price_nano: id % 4 === 1 ? '600000000' : '900000000', currency: 'GRAM', ts: Math.floor(Date.now() / 1000) - id * 3600, duration: 259200, is_extend: false, tx_hash: `demo-${id}`});
const streamedBody = value => ({async *[Symbol.asyncIterator]() {yield new TextEncoder().encode(JSON.stringify(value));}});
const engine = createCloudEngine({repository: createCloudRepository(db), ownerTelegramId: 42, marketappToken: 'mock-only-token', ownedPriceRefresh: mockOwnedPrices, limits: {invocation_attempts: Number(process.env.MOCK_ATTEMPTS || 100)}, fetch: async (url, options) => {
  if (readOnlyPreview) throw new Error('Collection is disabled in the read-only seed preview');
  if (options.method !== 'GET' || !url.startsWith('https://api.marketapp.org/')) throw new Error('Unexpected mock request');
  providerAttempts++;
  await new Promise(done => setTimeout(done, Number(process.env.MOCK_DELAY_MS || 750)));
  const parsed = new URL(url);
  let page;
  if (parsed.pathname === '/v1/collections/gifts/') page = groups.map(group => ({address: group.collection, name: group.name, extra_data: {}}));
  else {
    if (!['/v1/rent/gifts/', '/v1/rent/gifts/history/'].includes(parsed.pathname)) throw new Error('Unexpected mock route');
    const group = groups.find(group => group.collection === parsed.searchParams.get('collection_address'));
    if (!group) throw new Error('Unexpected mock collection');
    if (mockRetryAfter && !mockRetrySent) {
      mockRetrySent = true;
      return {status: 429, url, headers: {get: name => name.toLowerCase() === 'retry-after' ? String(mockRetryAfter) : null}, body: streamedBody({error: 'Synthetic provider cooldown'})};
    }
    page = parsed.pathname === '/v1/rent/gifts/' ? pagesFor(group.ids)[parsed.searchParams.get('cursor') || 'head']
      : {cursor: null, items: group.ids.slice(0, 3).map(history)};
  }
  return {status: 200, url, headers: {get: () => null}, body: streamedBody(page)};
}});
// Synthetic UI fixture only. Cryptographic decoding is independently tested
// against pinned public BOCs; no mock provider can contact the Internet.
const fakeHolder = address(777);
const ownedPrices = createOwnedPriceEngine({repository: createCloudRepository(db), ownerTelegramId:42,
  decodeContract: (_account,nft,owner) => ({verified:true,reason:'verified_rental_owner',owner,nft,holding_contract:fakeHolder,
    rental_state:'idle_rental_contract',configured_price_per_day_raw:'390000000',
    code_hash:'f3b93b1d262f709aff1ec25ae39141a7ecdd8c8a29b87a2b6bb1cdab4aec714a',data_hash:'ab'.repeat(32),
    code_hash_verified:true,data_hash_verified:true,decoder_version:'synthetic-ui-only-v1',account_last_transaction_lt:'123',
    marketplace:MARKETAPP_OPERATOR,role:0,status:0,renter:null,counterpart:null,rental_until:0}),
  fetch:async(url,options)=>{
    if(!mockOwnedPrices||options.method!=='GET'||!url.startsWith('https://toncenter.com/api/v3/')) throw new Error('Unexpected mock TON request');
    tonAttempts++;
    await new Promise(done=>setTimeout(done,Number(process.env.MOCK_DELAY_MS||750)));
    const parsed=new URL(url), addresses=parsed.searchParams.getAll('address');
    const body=parsed.pathname==='/api/v3/nft/items'?{nft_items:addresses.map(address=>({address,init:true,owner_address:fakeHolder,collection_address:nftCollections.get(address)||collection,last_transaction_lt:'123'}))}
      :parsed.pathname==='/api/v3/accountStates'?{accounts:addresses.map(address=>({address,status:'active',last_transaction_lt:'123'}))}:null;
    if(!body) throw new Error('Unexpected mock TON route');
    return {status:200,url,headers:{get:()=>null},body:streamedBody(body)};
  },
});
const ownedMethods={getOwnedPriceRefresh:'getStatus',startOwnedPriceRefresh:'start',stepOwnedPriceRefresh:'step',stopOwnedPriceRefresh:'stop'};
const giftMethods={getGiftRefresh:'getStatus',startGiftRefresh:'start',stepGiftRefresh:'step',stopGiftRefresh:'stop'};
async function invokeMockGiftRefresh(method,input) {
  const operation=giftMethods[method],session=input.session_id;
  if (['step','stop'].includes(operation)&&await createCloudRepository(db).ownedRefreshSession(session)!==input.run_id) throw new Error('Invalid mock refresh session');
  const args=operation==='start'?{session_id:session}:['step','stop'].includes(operation)?{run_id:input.run_id}:input;
  const result=await ownedPrices[operation](context,args);
  return {...result,provider:'toncenter',fallback_reason:'website_disabled',...(result.run?{run:{...result.run,session_id:session??result.run.session_id}}:{})};
}
const context = {initData: {user: {id: 42}}};
const seed = [
  {kind: 'settings', key: 'demo-settings', observed_at: observed, record: {wallet}},
  ...groups.flatMap(group => group.ids.flatMap(id => {
    const listing = item(id, id % 4 === 1 ? '390000000' : '170000000');
    return [
      {kind: 'portfolio', key: `demo-gift-${id}`, observed_at: observed, record: {nft_address: address(id), name: listing.nft_name, collection_address: group.collection, collection_name: group.name, is_portfolio: true, automatic_membership: true, membership_sources: ['ton_verified'], verification_method: 'imported_ton_evidence', observed_at: observed, state: id % 4 === 2 ? 'rented' : 'idle_rental_contract', display_state: id % 4 === 2 ? 'Rented (imported)' : 'For rent (observed)', ui_state: id % 4 === 2 ? null : 'for_rent', image_url: null, uncertainties: ['Synthetic fixture for local UI verification.']}},
      {kind: 'listing', key: `demo-listing-${id}`, observed_at: observed, record: {identity: address(id), source_json: listing, params: {collection_address: group.collection}, collection_address: group.collection}},
      {kind: 'history', key: `demo-history-${id}`, observed_at: observed, record: {identity: address(id), source_json: history(id)}},
    ];
  })),
];
// A known synthetic expiry makes the countdown visible without provider calls.
if (!readOnlyPreview && process.env.MOCK_RENTAL_COUNTDOWN === '1') {
  for (const row of seed) if (row.kind === 'portfolio' && row.record.state === 'rented') {
    row.record.rental_until_unix_seconds = Math.floor(Date.now() / 1000) + 6 * 86400 + 23 * 3600;
  }
}
// Price-history preview uses only synthetic observations and rental events.
// It cannot alter a personal seed or cause a provider request.
if (!readOnlyPreview && process.env.MOCK_PRICE_TRACKING === '1') {
  const ago = days => new Date(Date.now() - days * 86400000).toISOString();
  seed.push(
    ...[17, 12].map(days => ({kind: 'listing', key: `demo-tracking-listing-${days}`, observed_at: ago(days), record: {identity: address(1), source_json: item(1, '300000000'), params: {collection_address: collection}, collection_address: collection}})),
    {kind: 'listing', key: 'demo-tracking-listing-10', observed_at: ago(10), record: {identity: address(1), source_json: item(1, '390000000'), params: {collection_address: collection}, collection_address: collection}},
    ...[14, 13, 8, 6, 4].map(days => ({kind: 'history', key: `demo-tracking-history-${days}`, observed_at: observed, record: {identity: address(1), source_json: {...history(1), ts: Math.floor(Date.now() / 1000) - days * 86400, tx_hash: `demo-price-history-${days}`, price: days > 10 ? '0.9' : '1.17', price_nano: days > 10 ? '900000000' : '1170000000'}}})),
  );
}
if (readOnlyPreview) {
  const localSeed = await readSeed(seedManifest, option(process.argv.slice(2), '--app-id'));
  for (const {payload} of localSeed.chunks) await engine.importChunk(context, payload);
} else if (!await createCloudRepository(db).event('import:demo-dashboard:0')) {
  await engine.importChunk(context, {import_id: 'demo-dashboard', chunk_index: 0, records: seed});
}
// Optional public synthetic analytics; personal read-only seeds are untouched.
if (!readOnlyPreview && process.env.MOCK_PERSONAL_ANALYTICS === '1') {
  const bytes = Buffer.concat([Buffer.from([0x11, 0]), Buffer.from(wallet.slice(2), 'hex')]);
  let crc = 0;
  for (const byte of bytes) {crc ^= byte << 8; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  const friendly = Buffer.concat([bytes, Buffer.from([crc >> 8, crc & 255])]).toString('base64url');
  const dates = Array.from({length: 30}, (_, index) => new Date(Date.parse(observed.slice(0, 10)) - (29 - index) * 86400000).toISOString().slice(0, 10));
  const chart = (key, series, unit) => ({key, spec_raw: JSON.stringify({categories: null, gran: 'day', kind: 'column', series, stacking: null, unit, x: dates})});
  await engine.importPersonalAnalytics(context, {snapshot: JSON.stringify({
    version: 1, source: 'marketapp_personal_rent_page', wallet,
    source_url: `https://marketapp.org/user/${friendly}/?tab=analytics_rent`, captured_at: observed,
    summary: [{label: 'Rent volume', value: '9', definition: 'Before fees'}, {label: 'Rentals', value: '30', foot: '3 items'},
      {label: 'Price per day', value: '0.1'}, {label: 'Average duration', value: '3 days'},
      {label: 'Extensions', value: '0%'}, {label: 'Spent on rent', value: '0', foot: '0 rentals'}],
    charts: [chart('profile.rent.income', [{name: 'Rent volume', data: dates.map(() => 0.3)}], 'GRAM'),
      chart('profile.rent.rentals', [{name: 'New rentals', data: dates.map(() => 1)}, {name: 'Extensions', data: dates.map(() => 0)}], ''),
      chart('profile.rent.day_price', [{name: 'Price per day', data: dates.map(() => 0.1)}], 'GRAM'),
      chart('profile.rent.duration', [{name: 'Average duration', data: dates.map(() => 3)}], 'days')],
  })});
}
// Optional in-memory checkpoint for verifying collapsed waiting-job controls.
// startJob only saves a checkpoint; no step/provider request is performed.
if (readOnlyPreview && process.env.MOCK_SAVED_JOB === '1') {
  await engine.startJob(context, {kind: 'rental_prices', timeframe: '30d'});
}
// Synthetic legacy checkpoint for testing the explicit efficient-refresh action.
if (!readOnlyPreview && process.env.MOCK_LEGACY_JOB === '1') {
  await engine.startJob(context, {kind: 'prices', timeframe: '30d'});
  const repository = createCloudRepository(db), {revision, state} = await repository.read();
  state.job.page_size = 10; state.job.state = 'partial'; state.job.reason = 'daily_limit';
  delete state.job.schedule; delete state.job.market_cache_version;
  await repository.append(revision, {key: 'mock:legacy-job', state, job: state.job, records: [], observed_at: new Date().toISOString()});
}
if (!readOnlyPreview && process.env.MOCK_COMPLETED_JOB === '1') {
  await engine.startJob(context, {kind: 'rental_prices', timeframe: '30d'});
  const repository = createCloudRepository(db), {revision, state} = await repository.read();
  state.job.state = 'complete'; state.job.reason = null;
  for (const stream of state.job.streams) stream.state = 'complete';
  await repository.append(revision, {key: 'mock:completed-job', state, job: state.job, records: [], observed_at: observed});
}
// The screenshot regression: several saved pauses and one current scan.
// Only getJobs is projected; no provider steps are performed for these fixtures.
let syncHistoryFixture = null;
if (!readOnlyPreview && process.env.MOCK_SYNC_HISTORY === '1') {
  const base = {kind: 'prices', created_at: observed, updated_at: observed, stop_requested: false,
    collection_window: {timeframe: '30d', window_from: null, window_to: null},
    progress: {provider: 'marketapp', streams_total: 46, efficiency: {page_size: 100, recommended_page_size: 100}}};
  syncHistoryFixture = [
    {id: 5, state: 'running', completed: 8, reason: null},
    {id: 4, state: 'partial', completed: 9, reason: 'invocation_limit'},
    {id: 3, state: 'partial', completed: 18, reason: 'daily_limit'},
    {id: 2, state: 'failed', completed: 4, reason: 'network_error'},
    {id: 1, state: 'complete', completed: 46, reason: null},
  ].map(({completed, ...job}) => ({...base, ...job, run_id: job.id, progress: {...base.progress,
    pages: completed * 2, observations: completed * 100, streams_complete: completed, requires_resume: false,
    sync: {phase: 'listings', unit: 'checks', completed, total: 46, current_collection: 'Demo collection', processed_items: completed * 100}}}));
}
const bridge = `window.Telegram={WebApp:{ready(){},expand(){},colorScheme:'dark',Serverless:{call(name,input,callback){fetch('/mock-api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input||{})}).then(async r=>{const data=await r.json();if(!r.ok)callback({type:'ENDPOINT_ERROR',message:data.error});else callback(null,data);}).catch(()=>callback({message:'Mock service unavailable'}));}}}};`;
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'POST' && url.pathname.startsWith('/mock-api/')) {
      const method = url.pathname.slice('/mock-api/'.length);
      endpointCalls.push(method);
      if (method === 'getMarketappAnalyticsRefreshStatus') {
        response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify({attempt: null, session: {remembered: false, expires_at: null}})); return;
      }
      if (method === 'getJobs' && syncHistoryFixture) {
        response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify({jobs: syncHistoryFixture})); return;
      }
      if (!['getDashboard', 'getDashboardRevision', 'getJobs', 'startJob', 'stepJob', 'stopJob', 'resumeJob', 'refreshStartupComparisons', 'refreshStartupMarketappAnalytics',...Object.keys(ownedMethods),...Object.keys(giftMethods)].includes(method)) throw new Error('Unknown mock operation');
      if (readOnlyPreview && !['getDashboard', 'getDashboardRevision', 'getJobs'].includes(method)) {
        response.writeHead(403, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify({error: 'Collection is disabled in the read-only seed preview'})); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of request) {size += chunk.length; if (size > 16384) throw new Error('Request too large'); chunks.push(chunk);}
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (method === 'refreshStartupMarketappAnalytics') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || ![30, 365].includes(input.period_days)) throw new Error('Invalid mock analytics period');
        startupCalls.push({method, period_days: input.period_days});
        response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify({state: 'unavailable', reason: 'no_login', period_days: input.period_days})); return;
      }
      if (method === 'refreshStartupComparisons') startupCalls.push({method, kind: input.kind, timeframe: input.timeframe});
      const state = Object.hasOwn(giftMethods,method)?await invokeMockGiftRefresh(method,input):Object.hasOwn(ownedMethods,method) ? await ownedPrices[ownedMethods[method]](context,input) : await engine[method](context,input);
      if (readOnlyPreview && method === 'getDashboard') state.capabilities = {...state.capabilities,
        network_enabled: false, startup_comparison_refresh: false, marketapp_login_test: false, marketapp_analytics_refresh: false,
        owned_price_refresh: false, owned_price_refresh_single: false, owned_status_refresh: false, personal_gift_refresh: false};
      response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(state)); return;
    }
    if (request.method !== 'GET') {response.writeHead(405); response.end(); return;}
    if (url.pathname === '/mock-metrics') {response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({provider_attempts: providerAttempts,ton_attempts:tonAttempts,startup_calls:startupCalls,endpoint_calls:endpointCalls})); return;}
    if (url.pathname === '/mock-telegram.js') {response.writeHead(200, {'Content-Type': 'text/javascript'}); response.end(bridge); return;}
    const filename = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!filename.startsWith(resolve(root) + sep)) throw new Error('Invalid path');
    let data = await readFile(filename);
    if (extname(filename) === '.html') data = Buffer.from(data.toString().replace(/https:\/\/telegram\.org\/js\/telegram-web-app\.js\?64/g, '/mock-telegram.js'));
    response.writeHead(200, {'Content-Type': types[extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store'}); response.end(data);
  } catch {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: 'Mock request failed'}));}
});
server.listen(port, '127.0.0.1', () => console.log(`${readOnlyPreview ? 'Read-only local seed preview' : 'Mock-only Telegram pricing dashboard'}: http://127.0.0.1:${port}/`));
