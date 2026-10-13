import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketappTopItem, PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime } from './types.ts';
import { giftAllTimeAnalytics, marketappItemUrl, marketappTopItems, sortTopItems } from './marketappTopItems.ts';
import { friendlyMainnetAddress } from '../serverless/walletIdentity.ts';
import { selectAnalyticsReport } from './analyticsReports.ts';

const wallet = `0:${'11'.repeat(32)}`, now = Date.parse('2026-10-14T00:00:00Z');
const item = (id = '22', change: Partial<MarketappTopItem> = {}): MarketappTopItem => {
  const nft = `0:${id.repeat(32)}`;
  return { item_key: nft, item_url: `https://marketapp.org/nft/${friendlyMainnetAddress(nft)}/`, name: `Gift #${id}`, rentals: 5, rented_days: '53', volume: '19.15', price_per_day: '0.36', ...change };
};
function report(days = 30): PersonalRentalAnalytics {
  return { version: 1, source: 'marketapp_personal_rent_page', source_url: 'https://marketapp.org/', wallet,
    captured_at: '2026-10-13T10:00:00Z', period_start: days === 365 ? '2025-10-14' : '2026-09-14', period_end: '2026-10-13', timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees',
    summary: {rent_volume:'20',rentals:6,new_rentals:5,extensions:1,items:1,price_per_day:null,average_duration:null,extension_percent:null,spent_on_rent:null,spending_rentals:null},
    daily: Array.from({ length: days }, () => ({ date: '2026-10-13', rent_volume: '0', new_rentals: 0, extensions: 0, rentals: 0 })),
    fingerprint: String(days), top_items: { status: 'available', scope: 'marketapp_top_items', items: [item()] } };
}
const historyItem = () => ({ ...item(), captured_at: '2026-10-13T10:00:00Z', coverage: { observed_days: 30, missing_days: 0, partial_days: 1,
  periods: [{ period_start: '2026-09-14', period_end: '2026-10-13', captured_at: '2026-10-13T10:00:00Z' }] } });
function allTime(): PersonalRentalAnalyticsAllTime { return { ...report(), source_url: null, report_kind: 'all_time', daily: [], coverage: {observed_days:30,missing_days:0,partial_days:1},
  top_items: { status: 'available', scope: 'saved_non_overlapping_reports', incomplete: true, items: [historyItem()] } }; }

test('selected 30-day and yearly figures come from their exact report, never from saved gift history', () => {
  const month = report(), year = report(365); year.top_items!.items = [item('22', { rentals: 76, rented_days: '231', volume: '83.57' })];
  assert.equal(marketappTopItems(selectAnalyticsReport([month, year], 30), wallet, now)?.items[0].rentals, 5);
  assert.equal(marketappTopItems(selectAnalyticsReport([month, year], 365), wallet, now)?.items[0].rentals, 76);
  assert.equal(marketappTopItems(selectAnalyticsReport([month], 365), wallet, now), null);
});

test('legacy reports and missing tables remain unknown while an explicitly empty table stays empty', () => {
  assert.equal(marketappTopItems({ ...report(), top_items: undefined }, wallet, now), null);
  assert.equal(marketappTopItems({ ...report(), top_items: {status:'missing',scope:'marketapp_top_items',items:[]} }, wallet, now), null);
  assert.deepEqual(marketappTopItems({ ...report(), top_items: {status:'available',scope:'marketapp_top_items',items:[]} }, wallet, now)?.items, []);
});

test('reports from another wallet, future captures and invalid dates never leak into the selected account', () => {
  assert.equal(marketappTopItems(report(), `0:${'33'.repeat(32)}`, now), null);
  assert.equal(marketappTopItems(report(), null, now), null);
  assert.equal(marketappTopItems({ ...report(), captured_at: '2027-10-13T00:00:00Z' }, wallet, now), null);
  assert.equal(marketappTopItems({ ...report(), period_start: '2026-02-30' }, wallet, now), null);
  assert.equal(marketappTopItems(report(), friendlyMainnetAddress(wallet), now)?.items[0].volume, '19.15');
});

test('all-time requires explicit saved report coverage and nonoverlapping intervals', () => {
  const history = allTime();
  assert.equal(marketappTopItems(history, wallet, now)?.scope, 'saved_non_overlapping_reports');
  assert.equal(marketappTopItems({ ...history, top_items: report().top_items }, wallet, now), null);
  history.top_items!.items[0].coverage!.periods.push({period_start:'2026-10-01',period_end:'2026-10-13',captured_at:'2026-10-13T10:00:00Z'});
  assert.equal(marketappTopItems(history, wallet, now), null);
});

test('unsafe or identity-mismatched item links are rejected and duplicates are not added', () => {
  for (const item_url of ['javascript:alert(1)', 'https://evil.test/nft/x/', item('33').item_url, `${item().item_url}?redirect=bad`]) assert.equal(marketappItemUrl(item('22', {item_url})), null);
  const copy = report(); copy.top_items!.items.push(item());
  assert.equal(marketappTopItems(copy, wallet, now), null);
});

test('invalid numeric data fails closed and unknown daily prices remain unknown', () => {
  for (const changes of [{rentals:-1},{rentals:1.5},{volume:'Infinity'},{volume:'-1'},{rented_days:'1e6'},{price_per_day:'NaN'}]) {
    const copy = report(); copy.top_items!.items = [item('22', changes)]; assert.equal(marketappTopItems(copy, wallet, now), null);
  }
  const copy = report(); copy.top_items!.items = [item('22', {price_per_day:null})]; assert.equal(marketappTopItems(copy, wallet, now)?.items[0].price_per_day, null);
});

test('search and sorting preserve exact report values, including figures beyond float precision', () => {
  const first = item('22', {name:'Gift #2',volume:'9007199254740992.0001',rented_days:'2',rentals:1}), second = item('33', {name:'Gift #10',volume:'9007199254740992.0002',rented_days:'10',rentals:5});
  const rows=[first,second], original=structuredClone(rows);
  for (const sort of ['volume','rentals','days'] as const) assert.equal(sortTopItems(rows,'',sort)[0], second);
  assert.equal(sortTopItems(rows,'','name')[0], first); assert.deepEqual(sortTopItems(rows,' #10 '),[second]); assert.deepEqual(rows,original);
});

test('gift details match raw or friendly NFT identity and never use the gift name or database id', () => {
  const history = allTime(), entry = { ...historyItem(), ...item('ab') };
  history.top_items!.items = [entry];
  for (const nft_address of [entry.item_key, entry.item_key.toUpperCase(), friendlyMainnetAddress(entry.item_key)!]) {
    assert.equal(giftAllTimeAnalytics({nft_address}, history, wallet, now), entry);
  }
  const sameName = {nft_address:item('33').item_key, name:entry.name, id:entry.item_key};
  assert.equal(giftAllTimeAnalytics(sameName, history, wallet, now), null);
  assert.equal(giftAllTimeAnalytics({nft_address:'invalid'}, history, wallet, now), null);
});

test('gift details only use All time for the current wallet, regardless of available period reports', () => {
  const gift = {nft_address:item().item_key};
  assert.equal(giftAllTimeAnalytics(gift, report(), wallet, now), null);
  assert.equal(giftAllTimeAnalytics(gift, report(365), wallet, now), null);
  assert.equal(giftAllTimeAnalytics(gift, allTime(), `0:${'44'.repeat(32)}`, now), null);
  assert.equal(giftAllTimeAnalytics(gift, allTime(), null, now), null);
  assert.equal(giftAllTimeAnalytics(gift, allTime(), friendlyMainnetAddress(wallet), now)?.rentals, 5);
});

test('missing gift analytics stays unknown and updated reports replace the values in open details', () => {
  const gift = {nft_address:item().item_key}, history = allTime();
  assert.equal(giftAllTimeAnalytics(gift, null, wallet, now), null);
  assert.equal(giftAllTimeAnalytics(gift, {...history,top_items:undefined}, wallet, now), null);
  assert.equal(giftAllTimeAnalytics({nft_address:item('33').item_key}, history, wallet, now), null);
  const refreshed = structuredClone(history); refreshed.top_items!.items[0].rentals = 6;
  assert.equal(giftAllTimeAnalytics(gift, history, wallet, now)?.rentals, 5);
  assert.equal(giftAllTimeAnalytics(gift, refreshed, wallet, now)?.rentals, 6);
  refreshed.top_items!.items = [];
  assert.equal(giftAllTimeAnalytics(gift, refreshed, wallet, now), null);
});

test('fresh period and gift reports tolerate a device five seconds behind and revalidate as the clock catches up', () => {
  const month = report(), history = allTime(), gift = { nft_address: item().item_key };
  const captured = Date.parse(month.captured_at), slightlyBehind = captured - 5_000;
  assert.equal(marketappTopItems(month, wallet, slightlyBehind)?.items[0].rentals, 5);
  assert.equal(giftAllTimeAnalytics(gift, history, wallet, slightlyBehind)?.rentals, 5);
  const farBehind = captured - 40_000;
  assert.equal(marketappTopItems(month, wallet, farBehind), null);
  assert.equal(giftAllTimeAnalytics(gift, history, wallet, farBehind), null);
  assert.equal(marketappTopItems(month, wallet, farBehind + 60_000)?.items[0].rentals, 5);
  assert.equal(giftAllTimeAnalytics(gift, history, wallet, farBehind + 60_000)?.rentals, 5);
});
