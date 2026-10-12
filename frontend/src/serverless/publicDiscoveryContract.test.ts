import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { readJob } from './cloudDriver.ts';
import type { CloudEndpoint, CloudTransport } from './cloudTransport.ts';
import type { Job } from '../data/types.ts';

// Exercise the actual backend projection and frontend parser together. Import by
// URL so this shared-contract test does not become a browser bundle dependency.
const moduleUrl = new URL('../../../serverless/tgcloud/lib/public-discovery.js', import.meta.url);
const { createPublicDiscoveryEngine } = await import(moduleUrl.href);
const at = Date.parse('2026-10-10T12:00:00Z');
const ctx = { initData: { user: { id: 12345 } } };

function setup(state = 'running') {
  let revision = 0;
  let saved = { version: 2, next_job_id: 8, attempts: [], next_allowed_at: 0, job: {
    id: 7, kind: 'discover', state, reason: state === 'stopped' ? 'stopped_by_you' : null,
    created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString(), candidates: {},
    stage: 'holdings', pages: 1, verified: 0, unresolved: 0, lease: null, lease_until: 0,
    max_candidates: 1000, max_wallet_gifts: 250, max_enumeration_pages: 200, page_size: 50, batch_size: 25,
  } };
  const repository = {
    clock: async () => at,
    read: async () => ({ revision, state: structuredClone(saved) }),
    append: async (expected: number, event: { state: typeof saved }) => {
      assert.equal(expected, revision); saved = structuredClone(event.state); revision++; return true;
    },
    jobs: async () => [structuredClone(saved.job)],
  };
  const engine = createPublicDiscoveryEngine({ repository, enabled: true, ownerTelegramId: 12345,
    fetch: async () => { assert.fail('Stopping and reading discovery must not call a provider.'); } });
  const transport: CloudTransport = { async call<T>(name: CloudEndpoint, input: Record<string, unknown> = {}) {
    if (name === 'getJobs') return await engine.getJobs(ctx) as T;
    if (name === 'stopJob') return await engine.stopJob(ctx, input) as T;
    assert.fail(`Unexpected endpoint: ${name}`);
  } };
  return { adapter: createCloudDashboardAdapter(transport), engine, state: () => saved };
}

test('stopping public discovery returns a resumable shared job state and subsequent activity polling succeeds', async () => {
  const fixture = setup();
  const stopped = await fixture.adapter.stopJob(7, '');
  assert.equal(stopped.state, 'partial');
  assert.equal(stopped.stop_requested, true);
  assert.equal(stopped.resume_supported, true);
  assert.equal(fixture.state().job.state, 'partial');
  const jobs = await fixture.adapter.getJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'partial');
  assert.equal(jobs[0].id, stopped.id);
  assert.equal(jobs[0].resume_supported, true);
});

test('legacy stopped discovery snapshots normalize before the frontend job parser and activity adapter', async () => {
  const fixture = setup('stopped');
  const response = await fixture.engine.getJobs(ctx);
  const parsed = readJob({ job: response.jobs[0] as Job });
  assert.equal(parsed.state, 'partial');
  assert.equal(parsed.reason, 'stopped_by_you');
  assert.equal(parsed.stop_requested, true);
  assert.equal(parsed.resume_supported, true);
  const jobs = await fixture.adapter.getJobs();
  assert.equal(jobs[0].state, 'partial');
  assert.equal(fixture.state().job.state, 'stopped', 'read-only normalization preserves the saved evidence');
});
