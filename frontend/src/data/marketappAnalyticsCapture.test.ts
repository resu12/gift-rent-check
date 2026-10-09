import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { marketappAnalyticsBookmarklet, marketappAnalyticsCaptureScript } from './marketappAnalyticsCapture.ts';

function runCapture({ gran = 'day', url = `https://marketapp.org/user/${'A'.repeat(48)}/?tab=analytics_rent`, loaded = true } = {}) {
  const alerts: string[] = [], downloads: { filename: string; raw: string }[] = [];
  let serialized = '', clicked = false;
  const charts = ['profile.rent.income', 'profile.rent.rentals'].map(key => ({ getAttribute: (attribute: string) => attribute === 'data-key' ? key : JSON.stringify({ gran, x: ['2026-01-01'], series: [] }) }));
  const tiles = [{ querySelector: (selector: string) => ({ textContent: selector === '.ma-an-tile-label' ? (loaded ? 'Rent volume' : '') : '1', getAttribute: () => 'Gross volume' }) }];
  const anchor = { href: '', download: '', click: () => { clicked = true; downloads.push({ filename: anchor.download, raw: serialized }); }, remove: () => {} };
  class CaptureBlob { constructor(parts: string[]) { serialized = parts.join(''); } }
  class CaptureURL extends URL { static createObjectURL() { return 'blob:synthetic'; } static revokeObjectURL() {} }
  const context = {
    location: { href: url }, URL: CaptureURL, Blob: CaptureBlob, document: {
      querySelectorAll: (selector: string) => selector === '.js-ma-chart' ? charts : selector === '.ma-an-tile' ? tiles : [],
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
  assert.deepEqual(Object.keys(saved).sort(), ['captured_at', 'charts', 'source', 'source_url', 'summary', 'version', 'wallet']);
  assert.equal(saved.summary[0].definition, 'Gross volume');
  assert.equal(saved.charts[0].key, 'profile.rent.income');
  const script = marketappAnalyticsCaptureScript();
  assert.doesNotMatch(script, /document\.cookie|localStorage|sessionStorage|fetch\(|XMLHttpRequest|GlobalEnv|Authorization|tonProof/);
  assert.ok(marketappAnalyticsBookmarklet().startsWith('javascript:('));
});

test('capture refuses other origins, non-analytics tabs, filtered collections and non-daily grouping', () => {
  for (const options of [{ url: 'https://evil.test/' }, { url: `https://marketapp.org/user/${'A'.repeat(48)}/?tab=analytics_rent&collection_ids[]=1` }, { gran: 'week' }, { gran: 'month' }, { loaded: false }]) {
    const result = runCapture(options);
    assert.equal(result.downloads.length, 0); assert.equal(result.alerts.length, 1);
  }
});
