import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketappCollection, PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime } from './types.ts';
import { marketappCollections, sortCollectionAnalytics } from './marketappCollections.ts';
import { friendlyMainnetAddress } from '../serverless/walletIdentity.ts';
import { selectAnalyticsReport } from './analyticsReports.ts';

const wallet = `0:${'11'.repeat(32)}`, now = Date.parse('2026-10-14T00:00:00Z');
const item = (name = 'Gift Collection', change: Partial<MarketappCollection> = {}): MarketappCollection => ({
  collection_key: `name:${name.trim().replace(/\s+/g, ' ').toLowerCase()}`, name, rentals: 12, volume: '24.15', price_per_day: '0.25', ...change,
});
function report(days = 30): PersonalRentalAnalytics {
  return { version: 1, source: 'marketapp_personal_rent_page', source_url: 'https://marketapp.org/', wallet,
    captured_at: '2026-10-13T10:00:00Z', period_start: days === 365 ? '2025-10-14' : '2026-09-14', period_end: '2026-10-13', timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees',
    summary: {rent_volume:'24.15',rentals:12,new_rentals:12,extensions:0,items:3,price_per_day:null,average_duration:null,extension_percent:null,spent_on_rent:null,spending_rentals:null},
    daily: Array.from({ length: days }, () => ({ date: '2026-10-13', rent_volume: '0', new_rentals: 0, extensions: 0, rentals: 0 })),
    fingerprint: String(days), by_collection: { status: 'available', scope: 'marketapp_by_collection', items: [item()] } };
}
function allTime(): PersonalRentalAnalyticsAllTime { return { ...report(), source_url: null, report_kind: 'all_time', daily: [], coverage: {observed_days:30,missing_days:0,partial_days:1},
  by_collection: { status: 'available', scope: 'saved_non_overlapping_reports', incomplete: true, items: [{...item(),captured_at:'2026-10-13T10:00:00Z',coverage:{observed_days:30,missing_days:0,partial_days:1,periods:[{period_start:'2026-09-14',period_end:'2026-10-13',captured_at:'2026-10-13T10:00:00Z'}]}}] } }; }

test('collections follow the selected provider report and never sum Top items or use another period', () => {
  const month = report(), year = report(365); year.by_collection!.items = [item('Gift Collection', { rentals: 76, volume: '90.35' })];
  month.top_items = {status:'available',scope:'marketapp_top_items',items:[]};
  assert.equal(marketappCollections(selectAnalyticsReport([month,year],30),wallet,now)?.items[0].volume, '24.15');
  assert.equal(marketappCollections(selectAnalyticsReport([month,year],365),wallet,now)?.items[0].rentals, 76);
  assert.equal(marketappCollections(selectAnalyticsReport([month],365),wallet,now), null);
  assert.equal(marketappCollections({...month,by_collection:undefined},wallet,now),null);
});

test('collection reports stay scoped to the connected wallet and accept equivalent friendly addresses', () => {
  assert.equal(marketappCollections(report(),`0:${'33'.repeat(32)}`,now), null);
  assert.equal(marketappCollections(report(),null,now), null);
  assert.equal(marketappCollections(report(),friendlyMainnetAddress(wallet),now)?.items.length, 1);
});

test('available empty collections differs from a missing table without inventing zero totals', () => {
  const copy=report(); copy.by_collection!.items=[];
  assert.deepEqual(marketappCollections(copy,wallet,now)?.items,[]);
  copy.by_collection!.status='missing'; assert.equal(marketappCollections(copy,wallet,now),null);
});

test('all-time collections require saved non-overlapping coverage and preserve unknown daily rates', () => {
  const history=allTime(); assert.equal(marketappCollections(history,wallet,now)?.items[0].volume,'24.15');
  assert.equal(marketappCollections({...history,by_collection:report().by_collection},wallet,now),null);
  const entry=history.by_collection!.items[0]; entry.price_per_day=null;
  assert.equal(marketappCollections(history,wallet,now)?.items[0].price_per_day,null);
  entry.coverage!.periods.push({period_start:'2026-10-01',period_end:'2026-10-13',captured_at:'2026-10-13T10:00:00Z'});
  assert.equal(marketappCollections(history,wallet,now),null);
});

test('collection names define their identity and duplicate or malformed provider rows fail closed', () => {
  for (const change of [{collection_key:'name:other'},{name:''},{name:'hidden\u0000name'},{rentals:-1},{rentals:1.5},{volume:'NaN'},{volume:'-1'},{price_per_day:'Infinity'}]) {
    const copy=report();copy.by_collection!.items=[item('Gift Collection',change)];assert.equal(marketappCollections(copy,wallet,now),null);
  }
  const duplicate=report();duplicate.by_collection!.items.push(item('gift collection'));
  assert.equal(marketappCollections(duplicate,wallet,now),null);
  const copy=report();copy.by_collection!.items=[item('  Gift  Collection  ')];assert.equal(marketappCollections(copy,wallet,now)?.items.length,1);
});

test('collection capture validation shares clock tolerance and recovers when time advances', () => {
  const copy=report(), captured=Date.parse(copy.captured_at), history=allTime();
  for (const selected of [copy,history]) {
    assert.equal(marketappCollections(selected,wallet,captured-5_000)?.items.length,1);
    assert.equal(marketappCollections(selected,wallet,captured-40_000),null);
    assert.equal(marketappCollections(selected,wallet,captured+20_000)?.items.length,1);
  }
  assert.equal(marketappCollections({...copy,period_start:'2026-02-30'},wallet,now),null);
  assert.equal(marketappCollections(copy,wallet,NaN),null);
});

test('collection sorting preserves decimal precision, supports natural names and does not mutate source', () => {
  const first=item('Collection 2',{volume:'9007199254740992.0001',rentals:2}),second=item('Collection 10',{volume:'9007199254740992.0002',rentals:10}), rows=[first,second], original=structuredClone(rows);
  assert.equal(sortCollectionAnalytics(rows,'','volume')[0],second);
  assert.equal(sortCollectionAnalytics(rows,'','rentals')[0],second);
  assert.equal(sortCollectionAnalytics(rows,'','name')[0],first);
  assert.deepEqual(sortCollectionAnalytics(rows,' 10 '),[second]);assert.deepEqual(rows,original);
});
