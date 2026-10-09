import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDashboardAdapter } from './local.ts';

test('local analytics imports one raw snapshot with CSRF and same-origin credentials', async context => {
  const calls: { path: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ version: 1, summary: { rent_volume: '0.3' } }), { status: 200 });
  });
  const adapter = createLocalDashboardAdapter();
  const raw = '{"version":1,"source":"marketapp_personal_rent_page"}';
  const result = await adapter.personalAnalytics!.importSnapshot(raw, 'csrf-current');
  assert.equal(result.version, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/personal-analytics');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.body, raw);
  assert.equal(new Headers(calls[0].init.headers).get('X-Dashboard-CSRF'), 'csrf-current');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), null);
});

test('local imports reject missing CSRF and oversized UTF-8 input before any request', async context => {
  let count = 0;
  context.mock.method(globalThis, 'fetch', async () => { count++; return new Response('{}'); });
  const adapter = createLocalDashboardAdapter();
  await assert.rejects(adapter.personalAnalytics!.importSnapshot('{}', ''), /Reload/);
  await assert.rejects(adapter.personalAnalytics!.importSnapshot('é'.repeat(131073), 'csrf'), /256 KiB/);
  assert.equal(count, 0);
});

test('failed imports are not automatically resubmitted and expose the validation instruction', async context => {
  let count = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    count++;
    return new Response(JSON.stringify({ detail: 'Choose By day on Marketapp before saving.' }), { status: 422 });
  });
  const adapter = createLocalDashboardAdapter();
  await assert.rejects(adapter.personalAnalytics!.importSnapshot('{}', 'csrf'), /Choose By day/);
  assert.equal(count, 1);
});
