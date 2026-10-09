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
const history = id => ({address: address(id), name: `Demo Low Rider #${id}`, collection_address: nftCollections.get(address(id)), src: wallet, dst: address(888), price: id % 4 === 1 ? '0.6' : '0.9', price_nano: id % 4 === 1 ? '600000000' : '900000000', currency: 'GRAM', ts: Math.floor(Date.now() / 1000) - id * 3600, duration: 259200, is_extend: false, tx_hash: `demo-${id}`});
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
      return {status: 429, url, headers: {get: name => name.toLowerCase() === 'retry-after' ? String(mockRetryAfter) : null}, text: async () => JSON.stringify({error: 'Synthetic provider cooldown'})};
    }
    page = parsed.pathname === '/v1/rent/gifts/' ? pagesFor(group.ids)[parsed.searchParams.get('cursor') || 'head']
      : {cursor: null, items: group.ids.slice(0, 3).map(history)};
  }
  return {status: 200, url, headers: {get: () => null}, text: async () => JSON.stringify(page)};
}});
// Synthetic UI fixture only. Cryptographic decoding is independently tested
// against pinned public BOCs; no mock provider can contact the Internet.
const fakeHolder = address(777);
const ownedPrices = createOwnedPriceEngine({repository: createCloudRepository(db), ownerTelegramId:42,
  decodeContract: (_account,nft,owner) => ({verified:true,reason:'verified_rental_owner',owner,nft,holding_contract:fakeHolder,rental_state:'idle_rental_contract',configured_price_per_day_raw:'390000000',code_hash_verified:true,data_hash_verified:true}),
  fetch:async(url,options)=>{
    if(!mockOwnedPrices||options.method!=='GET'||!url.startsWith('https://toncenter.com/api/v3/')) throw new Error('Unexpected mock TON request');
    tonAttempts++;
    await new Promise(done=>setTimeout(done,Number(process.env.MOCK_DELAY_MS||750)));
    const parsed=new URL(url), addresses=parsed.searchParams.getAll('address');
    const body=parsed.pathname==='/api/v3/nft/items'?{nft_items:addresses.map(address=>({address,init:true,owner_address:fakeHolder,collection_address:nftCollections.get(address)||collection,last_transaction_lt:'123'}))}
      :parsed.pathname==='/api/v3/accountStates'?{accounts:addresses.map(address=>({address,last_transaction_lt:'123'}))}:null;
    if(!body) throw new Error('Unexpected mock TON route');
    return {status:200,url,headers:{get:()=>null},text:async()=>JSON.stringify(body)};
  },
});
const ownedMethods={getOwnedPriceRefresh:'getStatus',startOwnedPriceRefresh:'start',stepOwnedPriceRefresh:'step',stopOwnedPriceRefresh:'stop'};
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
if (readOnlyPreview) {
  const localSeed = await readSeed(seedManifest, option(process.argv.slice(2), '--app-id'));
  for (const {payload} of localSeed.chunks) await engine.importChunk(context, payload);
} else if (!await createCloudRepository(db).event('import:demo-dashboard:0')) {
  await engine.importChunk(context, {import_id: 'demo-dashboard', chunk_index: 0, records: seed});
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
const bridge = `window.Telegram={WebApp:{ready(){},expand(){},colorScheme:'dark',Serverless:{call(name,input,callback){fetch('/mock-api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input||{})}).then(async r=>{const data=await r.json();if(!r.ok)callback({type:'ENDPOINT_ERROR',message:data.error});else callback(null,data);}).catch(()=>callback({message:'Mock service unavailable'}));}}}};`;
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'POST' && url.pathname.startsWith('/mock-api/')) {
      const method = url.pathname.slice('/mock-api/'.length);
      if (!['getDashboard', 'getJobs', 'startJob', 'stepJob', 'stopJob', 'resumeJob',...Object.keys(ownedMethods)].includes(method)) throw new Error('Unknown mock operation');
      if (readOnlyPreview && !['getDashboard', 'getJobs'].includes(method)) {
        response.writeHead(403, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify({error: 'Collection is disabled in the read-only seed preview'})); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of request) {size += chunk.length; if (size > 16384) throw new Error('Request too large'); chunks.push(chunk);}
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const state = Object.hasOwn(ownedMethods,method) ? await ownedPrices[ownedMethods[method]](context,input) : await engine[method](context,input);
      response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(state)); return;
    }
    if (request.method !== 'GET') {response.writeHead(405); response.end(); return;}
    if (url.pathname === '/mock-metrics') {response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({provider_attempts: providerAttempts,ton_attempts:tonAttempts})); return;}
    if (url.pathname === '/mock-telegram.js') {response.writeHead(200, {'Content-Type': 'text/javascript'}); response.end(bridge); return;}
    const filename = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!filename.startsWith(resolve(root) + sep)) throw new Error('Invalid path');
    let data = await readFile(filename);
    if (extname(filename) === '.html') data = Buffer.from(data.toString().replace(/https:\/\/telegram\.org\/js\/telegram-web-app\.js\?64/g, '/mock-telegram.js'));
    response.writeHead(200, {'Content-Type': types[extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store'}); response.end(data);
  } catch {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: 'Mock request failed'}));}
});
server.listen(port, '127.0.0.1', () => console.log(`${readOnlyPreview ? 'Read-only local seed preview' : 'Mock-only Telegram pricing dashboard'}: http://127.0.0.1:${port}/`));
