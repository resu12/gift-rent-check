import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { localAdapter } from './local.ts';
import type { Job, PricingSelection } from './types.ts';

const fixture = { id: 7, kind: 'rental_prices', state: 'queued' } as Job;

function mockRequests(context: TestContext) {
  const calls: { path: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ job: fixture }), { status: 200 });
  });
  return calls;
}

test('rental collection sends the chosen timeframe and retains local request authentication', async context => {
  const calls = mockRequests(context);
  const result = await localAdapter.startJob('rental_prices', 'local-csrf', { source: 'rentals', timeframe: '7d' });
  assert.deepEqual(result, fixture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/jobs');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(new Headers(calls[0].init.headers).get('X-Dashboard-CSRF'), 'local-csrf');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { kind: 'rental_prices', timeframe: '7d' });
});

test('custom listing and rental collection preserve the date window without forwarding display filters', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T12:00:00Z') });
  const calls = mockRequests(context);
  const selection: PricingSelection = { source: 'rentals', timeframe: 'custom', dateFrom: '2026-09-01', dateTo: '2026-09-30', backdrop: 'Black' };
  for (const kind of ['prices', 'rental_prices'] as const) {
    await localAdapter.startJob(kind, 'csrf', selection);
  }
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
    { kind: 'prices', timeframe: 'custom', date_from: '2026-09-01', date_to: '2026-09-30' },
    { kind: 'rental_prices', timeframe: 'custom', date_from: '2026-09-01', date_to: '2026-09-30' },
  ]);
});

test('resume preserves the saved window, generic collection has a window, and ownership refresh is unrelated', async context => {
  const calls = mockRequests(context);
  await localAdapter.resumeJob(7, 'csrf');
  await localAdapter.startJob('collect', 'csrf', { source: 'rentals', timeframe: '90d' });
  await localAdapter.startJob('refresh', 'csrf', { source: 'rentals', timeframe: 'custom', dateFrom: 'invalid' });
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
    { resume_job_id: 7 }, { kind: 'collect', timeframe: '90d' }, { kind: 'refresh' },
  ]);
});

test('invalid custom collection dates cannot start a network job', async context => {
  const calls = mockRequests(context);
  assert.throws(() => localAdapter.startJob('rental_prices', 'csrf', {
    source: 'rentals', timeframe: 'custom', dateFrom: '2026-02-30', dateTo: '2026-03-01',
  }), /valid start and end date/);
  assert.equal(calls.length, 0);
});

test('relative collection windows drop stale custom dates and unbounded windows cannot start', async context => {
  const calls = mockRequests(context);
  await localAdapter.startJob('rental_prices', 'csrf', { source: 'rentals', timeframe: '60d', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { kind: 'rental_prices', timeframe: '60d' });
  assert.throws(() => localAdapter.startJob('rental_prices', 'csrf', { source: 'rentals', timeframe: 'all' }), /at most 90 days/);
  assert.equal(calls.length, 1);
});

test('overlong custom ranges and historical scans older than 90 days are blocked before any request', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T12:00:00Z') });
  const calls = mockRequests(context);
  const selection: PricingSelection = { source: 'rentals', timeframe: 'custom', dateFrom: '2026-07-11', dateTo: '2026-10-09' };
  for (const kind of ['prices', 'rental_prices', 'collect'] as const) {
    assert.throws(() => localAdapter.startJob(kind, 'csrf', selection), /at most 90 days/);
  }
  const older = { ...selection, dateTo: '2026-10-08' };
  for (const kind of ['rental_prices', 'collect'] as const) {
    assert.throws(() => localAdapter.startJob(kind, 'csrf', older), /no earlier than 2026-07-12/);
  }
  assert.equal(calls.length, 0);
  await localAdapter.startJob('prices', 'csrf', older);
  assert.equal(calls.length, 1); // Current listing snapshots do not scan rental history.
  for (const kind of ['rental_prices', 'collect'] as const) {
    await localAdapter.startJob(kind, 'csrf', { ...selection, dateFrom: '2026-07-12' });
  }
  assert.equal(calls.length, 3);
});
