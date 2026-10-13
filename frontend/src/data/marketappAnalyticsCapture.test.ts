import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { marketappAnalyticsBookmarklet, marketappAnalyticsCaptureScript } from './marketappAnalyticsCapture.ts';

interface TopItem {name: string; item_url: string; rentals: string; rented_days: string; volume: string; price_per_day: string}
interface CollectionItem {name: string; rentals: string; volume: string; price_per_day: string; url?: string;
  thumbnail_url?: string | null; thumbnail_text?: string; thumbnail_images?: number; average_duration?: string; share_volume?: string}
const sampleCollection = (): CollectionItem => ({name: 'Low Riders', rentals: '28', volume: '31.53', price_per_day: '0.22'});
const sampleItem = (): TopItem => ({name: 'Synthetic Gift #123', item_url: `/nft/${'B'.repeat(48)}/`, rentals: '2', rented_days: '12', volume: '1.50', price_per_day: '0.125'});
function runCapture({ gran = 'day', url = `https://marketapp.org/user/${'A'.repeat(48)}/?tab=analytics_rent`, loaded = true,
  chartKeys = ['profile.rent.income', 'profile.rent.rentals'], topItems = null, header = 'Top items', duplicate = false, malformed = false, noTable = false, emptyState = false,
  collections = null, collectionDuplicate = false, collectionMalformed = false, collectionNoTable = false, collectionEmptyState = false,
  collectionWide = false, collectionHeaders, collectionMetricLink = false, collectionMetricImage = false, collectionHeaderImage = false, collectionNameImage = false,
}: {gran?: string; url?: string; loaded?: boolean; chartKeys?: string[]; topItems?: TopItem[] | null; header?: string; duplicate?: boolean; malformed?: boolean; noTable?: boolean; emptyState?: boolean;
  collections?: CollectionItem[] | null; collectionDuplicate?: boolean; collectionMalformed?: boolean; collectionNoTable?: boolean; collectionEmptyState?: boolean;
  collectionWide?: boolean; collectionHeaders?: string[]; collectionMetricLink?: boolean; collectionMetricImage?: boolean; collectionHeaderImage?: boolean; collectionNameImage?: boolean} = {}) {
  const alerts: string[] = [], downloads: { filename: string; raw: string }[] = [];
  let serialized = '', clicked = false;
  const charts = chartKeys.map(key => ({ getAttribute: (attribute: string) => attribute === 'data-key' ? key : JSON.stringify({ gran, x: ['2026-01-01'], series: [] }) }));
  const tiles = [{ querySelector: (selector: string) => ({ textContent: selector === '.ma-an-tile-label' ? (loaded ? 'Rent volume' : '') : '1', getAttribute: () => 'Gross volume' }) }];
  const headings = [{textContent: header}];
  const cell = (textContent: string, tagName: string, item?: TopItem) => ({textContent, tagName, hasAttribute: () => false,
    getAttribute: (_name: string) => null as string | null,
    querySelector: (selector: string) => selector !== 'a' && malformed ? {} : null,
    querySelectorAll: () => item ? [{textContent: item.name, getAttribute: () => item.item_url}] : []});
  const rows = [{parentElement: {tagName: 'THEAD'}, children: ['Item', 'Rentals', 'Rented days', 'Volume', 'Price per day'].map(text => cell(text, 'TH'))},
    ...(topItems || []).map(item => ({parentElement: {tagName: 'TBODY'}, children: [cell(item.name, 'TD', item),
      ...[item.rentals, item.rented_days, item.volume, item.price_per_day].map(value => cell(value, 'TD'))]}))];
  if (emptyState) rows.splice(1, rows.length - 1, {parentElement: {tagName: 'TBODY'}, children: [{...cell('No rental data available', 'TD'), getAttribute: (name: string) => name === 'colspan' ? '5' : null}]});
  const tables = noTable ? [] : [{classList: {contains: (name: string) => name === 'tm-table'}, querySelectorAll: () => rows}];
  const block = {querySelectorAll: (selector: string) => selector === 'table' ? tables : headings};
  const blocks: {querySelectorAll: (selector: string) => unknown[]}[] = topItems ? duplicate ? [block, block] : [block] : [];
  if (collections) {
    const collectionCell = (text: string, tag: string, link?: {name:string;url?:string|null}, imageCount = 0) => {
      const links = link?.url ? [{textContent:link.name,getAttribute:()=>link.url}] : [], images = Array.from({length:imageCount},()=>({textContent:'',getAttribute:()=> 'https://images.example/thumbnail.webp'}));
      return {...cell(text, tag),
        querySelector: (selector: string) => collectionMalformed && selector.includes('script') ? {} :
          selector.split(',').includes('a') && links.length ? links[0] : selector.split(',').includes('img') && images.length ? images[0] : null,
        querySelectorAll: (selector: string) => selector === 'a' ? links : selector === 'img' ? images : []};
    };
    const headers=collectionHeaders??(collectionWide?['','Collection','Rentals','Volume','Price per day','Average duration','Share of volume']:['Collection','Rentals','Volume','Price per day']);
    const collectionRows = [{parentElement: {tagName: 'THEAD'}, children: headers.map((text,index) => collectionCell(text, 'TH',undefined,collectionHeaderImage&&index===0?1:0))},
      ...collections.map(item => {
        const url=item.url??(collectionWide?`/collection/${'C'.repeat(48)}/`:undefined);
        return {parentElement: {tagName: 'TBODY'}, children: [
          ...(collectionWide?[collectionCell(item.thumbnail_text??'','TD',{name:item.thumbnail_text??'',url:item.thumbnail_url===undefined?url:item.thumbnail_url},item.thumbnail_images??1)]:[]),
          collectionCell(item.name,'TD',{name:item.name,url},collectionNameImage?1:0),
          ...[item.rentals,item.volume,item.price_per_day,...(collectionWide?[item.average_duration??'5.45 days',item.share_volume??'22.8%']:[])].map((text,index)=>
            collectionCell(text,'TD',collectionMetricLink&&index===1?{name:text,url:'/'}:undefined,collectionMetricImage&&index===1?1:0))]};
      })];
    if (collectionEmptyState) collectionRows.splice(1, collectionRows.length - 1, {parentElement: {tagName: 'TBODY'}, children: [{...collectionCell('No data available', 'TD'), getAttribute: (name: string) => name === 'colspan' ? String(headers.length) : null}]});
    const collectionTables = collectionNoTable ? [] : [{classList: {contains: (name: string) => name === 'tm-table'}, querySelectorAll: () => collectionRows}];
    const collectionBlock = {querySelectorAll: (selector: string) => selector === 'table' ? collectionTables : [{textContent: 'By collection'}]};
    blocks.push(collectionBlock);
    if (collectionDuplicate) blocks.push(collectionBlock);
  }
  const anchor = { href: '', download: '', click: () => { clicked = true; downloads.push({ filename: anchor.download, raw: serialized }); }, remove: () => {} };
  class CaptureBlob { constructor(parts: string[]) { serialized = parts.join(''); } }
  class CaptureURL extends URL { static createObjectURL() { return 'blob:synthetic'; } static revokeObjectURL() {} }
  const context = {
    location: { href: url }, URL: CaptureURL, Blob: CaptureBlob, document: {
      querySelectorAll: (selector: string) => selector === '.js-ma-chart' ? charts : selector === '.ma-an-tile' ? tiles : selector === '.ma-an-tblock' ? blocks : [],
      createElement: () => anchor, body: { appendChild: () => {} },
    }, alert: (message: string) => alerts.push(message), setTimeout: (callback: () => void) => callback(),
  };
  vm.runInNewContext(marketappAnalyticsCaptureScript(), context);
  return { alerts, downloads, clicked };
}

test('capture downloads only visible analytics definitions/chart specs, without session or network access', () => {
  const result = runCapture();
  assert.equal(result.alerts.length, 0); assert.equal(result.clicked, true);
  assert.match(result.downloads[0].filename, /^marketapp-rent-analytics-\d{4}-\d{2}-\d{2}\.json$/);
  const saved = JSON.parse(result.downloads[0].raw);
  assert.deepEqual(Object.keys(saved).sort(), ['by_collection', 'captured_at', 'charts', 'source', 'source_url', 'summary', 'top_items', 'version', 'wallet']);
  assert.equal(saved.summary[0].definition, 'Gross volume');
  assert.equal(saved.charts[0].key, 'profile.rent.income');
  assert.deepEqual(saved.top_items, {status: 'missing', items: []});
  assert.deepEqual(saved.by_collection, {status: 'missing', items: []});
  const script = marketappAnalyticsCaptureScript();
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage|fetch\(|XMLHttpRequest|GlobalEnv|Authorization|tonProof/);
  assert.ok(marketappAnalyticsBookmarklet().startsWith('javascript:('));
});

test('capture supports the observed combined daily activity chart without floating-point conversion', () => {
  const result = runCapture({chartKeys: ['profile.rent.activity']});
  assert.equal(result.alerts.length, 0); assert.equal(result.downloads.length, 1);
  for (const chartKeys of [['profile.rent.activity', 'profile.rent.income'], ['profile.rent.activity', 'profile.rent.rentals'],
    ['profile.rent.activity', 'profile.rent.activity'], ['profile.rent.income'], []]) {
    assert.equal(runCapture({chartKeys}).downloads.length, 0);
  }
});

test('capture retains exact Top items values, identity and explicit empty tables', () => {
  const item = sampleItem(); item.volume = '9007199254740993.0001';
  const result = runCapture({topItems: [item]});
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(JSON.parse(result.downloads[0].raw).top_items, {status: 'available', items: [{...item, item_url: 'https://marketapp.org' + item.item_url}]});
  assert.deepEqual(JSON.parse(runCapture({topItems: []}).downloads[0].raw).top_items, {status: 'available', items: []});
  assert.deepEqual(JSON.parse(runCapture({topItems: [sampleItem()], header: 'Unrelated statistics'}).downloads[0].raw).top_items, {status: 'missing', items: []});
  for (const options of [{noTable: true}, {emptyState: true}]) {
    assert.deepEqual(JSON.parse(runCapture({topItems: [sampleItem()], ...options}).downloads[0].raw).top_items, {status: 'missing', items: []});
  }
});

test('capture keeps independent collection totals and exact amounts alongside Top items', () => {
  const collection = {...sampleCollection(), volume: '9007199254740993.0001'};
  const result = runCapture({topItems: [sampleItem()], collections: [collection]});
  assert.deepEqual(result.alerts, []);
  const saved = JSON.parse(result.downloads[0].raw);
  assert.deepEqual(saved.by_collection, {status: 'available', items: [collection]});
  assert.equal(saved.top_items.items.length, 1);
  assert.deepEqual(JSON.parse(runCapture({collections: []}).downloads[0].raw).by_collection, {status: 'available', items: []});
});

test('collection capture supports plain names or verified Marketapp links without retaining links', () => {
  for (const url of ['/gifts/lowriders/', 'https://marketapp.org/gifts/lowriders/']) {
    const result = runCapture({collections: [{...sampleCollection(), url}]});
    assert.deepEqual(result.alerts, []);
    assert.deepEqual(JSON.parse(result.downloads[0].raw).by_collection.items, [sampleCollection()]);
  }
  for (const options of [{collectionNoTable: true}, {collectionEmptyState: true}]) {
    assert.deepEqual(JSON.parse(runCapture({collections: [sampleCollection()], ...options}).downloads[0].raw).by_collection, {status: 'missing', items: []});
  }
});

test('collection capture recognizes the observed seven-column table and keeps only its correct financial columns', () => {
  const collection={...sampleCollection(),volume:'9007199254740993.0001'};
  const result=runCapture({collectionWide:true,collections:[{...collection,average_duration:'5.45 days',share_volume:'22.8%'}]});
  assert.deepEqual(result.alerts,[]);
  const saved=JSON.parse(result.downloads[0].raw);
  assert.deepEqual(saved.by_collection,{status:'available',items:[collection]});
  assert.deepEqual(Object.keys(saved.by_collection.items[0]).sort(),['name','price_per_day','rentals','volume']);
  assert.doesNotMatch(result.downloads[0].raw,/thumbnail\.webp|images\.example|5\.45 days|22\.8%|thumbnail_url/);
  const href=`/collection/${'C'.repeat(48)}/`;
  assert.deepEqual(runCapture({collectionWide:true,collections:[{...sampleCollection(),url:'https://marketapp.org'+href,thumbnail_url:href}]}).alerts,[]);
  assert.deepEqual(JSON.parse(runCapture({collectionWide:true,collections:[]}).downloads[0].raw).by_collection,{status:'available',items:[]});
  assert.deepEqual(JSON.parse(runCapture({collectionWide:true,collections:[sampleCollection()],collectionEmptyState:true}).downloads[0].raw).by_collection,{status:'missing',items:[]});
});

test('seven-column capture rejects mismatched thumbnail identities, misleading media and changed headers', () => {
  const href=`/collection/${'D'.repeat(48)}/`;
  for(const options of [
    {collections:[{...sampleCollection(),thumbnail_url:href}]},
    {collections:[{...sampleCollection(),thumbnail_url:'https://evil.test'+href}]},
    {collections:[{...sampleCollection(),thumbnail_url:null}]},
    {collections:[{...sampleCollection(),url:''}]},
    {collections:[{...sampleCollection(),thumbnail_text:'Different collection'}]},
    {collections:[{...sampleCollection(),thumbnail_images:0}]},
    {collections:[{...sampleCollection(),thumbnail_images:2}]},
    {collectionMetricLink:true},{collectionMetricImage:true},{collectionHeaderImage:true},{collectionNameImage:true},
    {collectionHeaders:['','Collection','Volume','Rentals','Price per day','Average duration','Share of volume']},
    {collectionHeaders:['Image','Collection','Rentals','Volume','Price per day','Average duration','Share of volume']},
    {collectionHeaders:['','Collection','Rentals','Volume','Price per day','Share of volume']},
  ]) {
    const result=runCapture({collectionWide:true,collections:[sampleCollection()],...options});
    assert.equal(result.downloads.length,0,JSON.stringify(options));assert.equal(result.alerts.length,1);
  }
});

test('collection capture rejects ambiguity, executable content, foreign links and oversized tables', () => {
  for (const options of [{collectionDuplicate: true}, {collectionMalformed: true},
    {collections: [sampleCollection(), {...sampleCollection(), name: ' low  riders '}]},
    {collections: Array.from({length: 201}, (_, index) => ({...sampleCollection(), name: 'Collection ' + index}))},
    ...['javascript:alert(1)', '//evil.test/', '/\\evil.test/', 'https://marketapp.org.evil.test/', 'https://user@marketapp.org/'].map(url => ({collections: [{...sampleCollection(), url}]}))]) {
    const result = runCapture({collections: [sampleCollection()], ...options});
    assert.equal(result.downloads.length, 0); assert.equal(result.alerts.length, 1);
  }
});

test('capture rejects ambiguous, executable or excessive Top items evidence', () => {
  for (const options of [{duplicate: true}, {malformed: true}, {topItems: [sampleItem(), sampleItem()]},
    {topItems: Array.from({length: 101}, sampleItem)}, {topItems: [{...sampleItem(), item_url: 'https://evil.invalid/nft/' + 'B'.repeat(48) + '/'}]},
    {topItems: [{...sampleItem(), item_url: sampleItem().item_url + '?different=1'}]}]) {
    const result = runCapture({topItems: [sampleItem()], ...options});
    assert.equal(result.downloads.length, 0); assert.equal(result.alerts.length, 1);
  }
});

test('capture refuses other origins, non-analytics tabs, filtered collections and non-daily grouping', () => {
  for (const options of [{ url: 'https://evil.test/' }, { url: `https://marketapp.org/user/${'A'.repeat(48)}/?tab=analytics_rent&collection_ids[]=1` }, { gran: 'week' }, { gran: 'month' }, { loaded: false }]) {
    const result = runCapture(options);
    assert.equal(result.downloads.length, 0); assert.equal(result.alerts.length, 1);
  }
});
