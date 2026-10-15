import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {runScheduler, SCHEDULER} from '../scheduler/worker.mjs';

const token = 'github_pat_synthetic_private_token';
const start = Date.parse('2026-10-15T12:22:00.000Z');
const enabled = {SCHEDULER_ENABLED: 'true', GITHUB_MONITORING_TOKEN: token};
const statuses = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const empty = () => Response.json({total_count: 0, workflow_runs: []});
const run = (values = {}) => ({id: 42, status: 'completed', event: 'workflow_dispatch', created_at: '2026-10-15T10:22:00Z', ...values});
const page = row => Response.json({total_count: 1, workflow_runs: [row]});
function fixture(handler = () => undefined, options = {}) {
  const calls = [], logs = [];
  const request = async (url, init) => {
    calls.push({url, init});
    return await handler(url, init, calls.length) ?? (init.method === 'POST' ? new Response(null, {status: 204}) : empty());
  };
  return {calls, logs, run: (env = enabled) => runScheduler(env, {fetch: request, now: () => start, emit: value => logs.push(value), ...options})};
}

test('scheduler defaults to disabled without reading a token or making a request', async () => {
  const f = fixture();
  for (const value of [undefined, false, true, 'false', 'TRUE', '1']) {
    const env = {SCHEDULER_ENABLED: value, get GITHUB_MONITORING_TOKEN() { throw Error('must not read'); }};
    assert.equal((await f.run(env)).state, 'disabled');
  }
  assert.equal(f.calls.length, 0);
});

test('enabled scheduler rejects missing, malformed or oversized credentials before requests', async () => {
  const f = fixture();
  for (const value of [undefined, '', 'tiny', token + '\n', ' '.repeat(30), 'x'.repeat(1025)]) {
    assert.equal((await f.run({...enabled, GITHUB_MONITORING_TOKEN: value})).reason, 'missing_token');
  }
  assert.equal(f.calls.length, 0);
});

test('one eligible tick checks all active statuses then dispatches only the fixed reviewed workflow', async () => {
  const f = fixture();
  const result = await f.run({...enabled, API_URL: 'https://example.invalid', GITHUB_REPOSITORY: 'other/repo', GITHUB_REF: 'other'});
  assert.equal(result.state, 'dispatched');
  assert.equal(result.reads, 6);
  assert.equal(result.dispatch_attempts, 1);
  assert.deepEqual(f.calls.map(call => call.url), [
    ...statuses.map(status => `${SCHEDULER.api}/runs?status=${status}&per_page=1`),
    `${SCHEDULER.api}/runs?event=workflow_dispatch&per_page=1`, `${SCHEDULER.api}/dispatches`,
  ]);
  for (const {url, init} of f.calls) {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(!url.includes(token));
  }
  assert.deepEqual(JSON.parse(f.calls.at(-1).init.body), {ref: 'main', inputs: {scheduled: true}});
  assert.equal(f.calls.at(-1).init.method, 'POST');
  assert.equal(f.logs.length, 1);
});

test('every active state, including an old approval wait, suppresses another dispatch', async () => {
  for (const [index, status] of statuses.entries()) {
    const f = fixture(url => new URL(url).searchParams.get('status') === status ? page(run({status, event: 'schedule', created_at: '2026-09-01T00:00:00Z'})) : undefined);
    assert.equal((await f.run()).state, 'busy');
    assert.equal(f.calls.length, index + 1);
    assert.ok(f.calls.every(call => call.init.method === 'GET'));
  }
});

test('an active list with more than one page suppresses dispatch without traversing history', async () => {
  const f = fixture(() => Response.json({total_count: 400, workflow_runs: [run({status: 'queued'})]}));
  assert.equal((await f.run()).state, 'busy');
  assert.equal(f.calls.length, 1);
});

test('capped GitHub counts preserve active-run and recent-dispatch suppression', async () => {
  for (const [index, status] of statuses.entries()) {
    const f = fixture(url => new URL(url).searchParams.get('status') === status
      ? Response.json({total_count: '2,500+', workflow_runs: [run({status})]}) : undefined);
    assert.equal((await f.run()).state, 'busy');
    assert.equal(f.calls.length, index + 1);
  }
  for (const [age, expected] of [[1000, 'recent_dispatch'], [SCHEDULER.duplicate_ms + 1, 'dispatched']]) {
    const f = fixture(url => new URL(url).searchParams.has('event')
      ? Response.json({total_count: '2,500+', workflow_runs: [run({created_at: new Date(start - age).toISOString()})]}) : undefined);
    assert.equal((await f.run()).state, expected);
    assert.equal(f.calls.filter(call => call.init.method === 'POST').length, expected === 'dispatched' ? 1 : 0);
  }
});

test('unknown capped counts and inconsistent capped pages still fail closed', async () => {
  for (const payload of [{workflow_runs: []}, {workflow_runs: [run({status: 'queued'})]}, {total_count: '2,500+', workflow_runs: []},
    {total_count: '2,500+', workflow_runs: [run({status: 'queued'}), run({status: 'queued', id: 43})]},
    ...['2500+', '2,500', '2,500++', '2,500+ private details', null, 1.5, -1, '1']
      .map(total_count => ({total_count, workflow_runs: [run({status: 'queued'})]}))]) {
    const f = fixture(() => Response.json(payload));
    assert.equal((await f.run()).reason, 'invalid_response');
    assert.equal(f.calls.length, 1);
  }
});

test('recent manual or scheduler dispatches suppress duplicate delivery, including clock disagreement', async () => {
  for (const offset of [-SCHEDULER.duplicate_ms, -1000, 0, 60000]) {
    const f = fixture(url => new URL(url).searchParams.has('event') ? page(run({created_at: new Date(start + offset).toISOString()})) : undefined);
    assert.equal((await f.run()).state, 'recent_dispatch');
    assert.equal(f.calls.length, 6);
  }
  const f = fixture(url => new URL(url).searchParams.has('event') ? page(run({created_at: new Date(start - SCHEDULER.duplicate_ms - 1).toISOString()})) : undefined);
  assert.equal((await f.run()).state, 'dispatched');
});

test('malformed or incomplete run lists fail closed', async () => {
  const malformed = [null, [], {}, {total_count: 1, workflow_runs: []}, {total_count: 0, workflow_runs: [run()]},
    {total_count: -1, workflow_runs: []}, {total_count: '1', workflow_runs: []},
    ...[run({id: 0}), run({status: 'unknown'}), run({status: 'completed'}), run({created_at: 'yesterday'}), run({event: null})]
      .map(row => ({total_count: 1, workflow_runs: [row]}))];
  for (const payload of malformed) {
    const f = fixture(() => Response.json(payload));
    assert.equal((await f.run()).reason, 'invalid_response');
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(url => new URL(url).searchParams.has('event') ? page(run({event: 'push'})) : undefined);
  assert.equal((await f.run()).reason, 'invalid_response');
  assert.equal(f.calls.length, 6);
});

test('unexpected status, redirects and rate limits stop before dispatch without reading upstream errors', async () => {
  for (const [status, headers, reason] of [[401, {}, 'api_rejected'], [403, {}, 'api_rejected'],
    [403, {'X-RateLimit-Remaining': '0'}, 'rate_limited'], [403, {'Retry-After': '60'}, 'rate_limited'],
    [429, {}, 'rate_limited'], [500, {}, 'api_rejected'], [302, {Location: 'https://example.invalid'}, 'redirect_blocked']]) {
    const f = fixture(() => new Response(token, {status, headers}));
    assert.equal((await f.run()).reason, reason);
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(f.logs).includes(token));
  }
});

test('JSON bodies are checked by type, advertised size and streamed size', async () => {
  for (const response of [new Response('{}'), new Response('{invalid', {headers: {'Content-Type': 'application/json'}}),
    new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': String(SCHEDULER.response_bytes + 1)}}),
    new Response(' '.repeat(SCHEDULER.response_bytes + 1), {headers: {'Content-Type': 'application/json'}})]) {
    const f = fixture(() => response);
    assert.equal((await f.run()).state, 'blocked');
    assert.equal(f.calls.length, 1);
  }
  let cancelled = false;
  const oversized = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(SCHEDULER.response_bytes + 1)); }, cancel() { cancelled = true; }});
  const f = fixture(() => new Response(oversized, {headers: {'Content-Type': 'application/json'}}));
  assert.equal((await f.run()).reason, 'response_too_large');
  assert.equal(cancelled, true);
});

test('request deadlines stop a stalled response and never dispatch afterward', async () => {
  let signal;
  const f = fixture((_url, init) => { signal = init.signal; return new Promise(() => {}); }, {timeoutMs: 5});
  assert.equal((await f.run()).reason, 'api_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.length, 1);
  let cancelled = false;
  const body = fixture(() => new Response(new ReadableStream({start() {}, cancel() { cancelled = true; }}), {headers: {'Content-Type': 'application/json'}}), {timeoutMs: 5});
  assert.equal((await body.run()).reason, 'api_timeout');
  assert.equal(body.calls.length, 1);
  assert.equal(cancelled, true);
});

test('a late timed-out response cannot continue to workflow dispatch', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }), {timeoutMs: 5});
  assert.equal((await f.run()).reason, 'api_timeout');
  release(empty());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
});

test('uncertain or rejected dispatch is never retried and never exposes server errors', async () => {
  for (const behavior of ['network', 'timeout', 500, 401, 422, 302, 429]) {
    const f = fixture((_url, init) => {
      if (init.method !== 'POST') return;
      if (behavior === 'network') throw Error(`${token} private upstream details`);
      if (behavior === 'timeout') return new Promise(() => {});
      return new Response(token, {status: behavior});
    }, {timeoutMs: 5});
    const result = await f.run();
    assert.equal(result.state, 'blocked');
    assert.equal(result.dispatch_attempts, 1);
    assert.equal(f.calls.length, 7);
    assert.ok(!JSON.stringify(f.logs).includes(token));
    assert.ok(!JSON.stringify(f.logs).includes('private upstream'));
    if (['network', 'timeout', 500].includes(behavior)) assert.equal(result.reason, 'dispatch_unknown');
  }
});

test('run metadata and secrets never enter the structured summary', async () => {
  const f = fixture(url => new URL(url).searchParams.has('event') ? page(run({private_field: token, repository: {private: token}})) : undefined);
  const result = await f.run();
  assert.deepEqual(result, {event: 'cloud-monitoring-scheduler', at: '2026-10-15T12:22:00.000Z', state: 'dispatched', reads: 6, dispatch_attempts: 1});
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('worker exposes no HTTP trigger and deployment is disabled until explicitly configured', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await worker.fetch(new Request('https://example.invalid/run', {method}), enabled);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  }
  const config = JSON.parse(readFileSync(new URL('../scheduler/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.vars.SCHEDULER_ENABLED, 'false');
  assert.deepEqual(config.triggers.crons, [SCHEDULER.cron]);
  assert.equal(config.main, 'worker.mjs');
  assert.equal(config.account_id, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.vars.GITHUB_MONITORING_TOKEN, undefined);
  assert.equal(config.vars.TGCLOUD_TOKEN, undefined);
});
