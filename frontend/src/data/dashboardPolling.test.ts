import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardPoller } from './dashboardPolling.ts';
import type { PollingEnvironment } from './dashboardPolling.ts';
import type { Dashboard, DashboardAdapter, Job, PricingSelection } from './types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let turn = 0; turn < 16; turn += 1) await Promise.resolve(); }

function fakeClock() {
  let now = 0;
  let visible = true;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const environment: PollingEnvironment = {
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return () => { timers.delete(id); };
    },
    isVisible: () => visible,
  };
  return {
    environment,
    get timerCount() { return timers.size; },
    hide() { visible = false; },
    show() { visible = true; },
    async advance(milliseconds: number) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id); now = timer.at; timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const selection: PricingSelection = { source: 'listings', timeframe: '24h' };
const fixture = (revision: string) => ({ generated_at: revision } as Dashboard);
const job = (state: Job['state'], progress: Job['progress'] = {}) => ({ id: 1, state, progress } as Job);

function setup(options: { initialJobs?: Job[]; selection?: PricingSelection } = {}) {
  const clock = fakeClock();
  const reads: { selection: PricingSelection; signal: AbortSignal; result: ReturnType<typeof deferred<Dashboard>> }[] = [];
  const jobReads: AbortSignal[] = [];
  let currentJobs = options.initialJobs || [];
  let jobFailure: Error | null = null;
  const state = { dashboard: null as Dashboard | null, jobs: [] as Job[], loading: false, error: null as string | null };
  const published: Dashboard[] = [];
  const adapter: DashboardAdapter = {
    getDashboard(selected, signal) {
      const result = deferred<Dashboard>();
      reads.push({ selection: selected, signal: signal!, result });
      return result.promise;
    },
    async getJobs(signal) {
      jobReads.push(signal!);
      if (jobFailure) throw jobFailure;
      return currentJobs;
    },
    async startJob() { throw new Error('not used'); },
    async resumeJob() { throw new Error('not used'); },
    async stopJob() { throw new Error('not used'); },
    exportUrl() { return ''; },
  };
  const poller = createDashboardPoller(adapter, options.selection || selection, {
    dashboard(data) { state.dashboard = data; published.push(data); },
    jobs(jobs) { state.jobs = jobs; },
    loading(pending) { state.loading = pending; },
    error(message) { state.error = message; },
  }, clock.environment);
  return {
    clock, reads, jobReads, state, published, poller,
    setJobs(jobs: Job[]) { currentJobs = jobs; },
    failJobs(error: Error | null) { jobFailure = error; },
  };
}

test('slow dashboard responses remain useful during fast active-job polling', async () => {
  const run = setup({ initialJobs: [job('running')] });
  const initial = run.poller.reload();
  await flush();
  await run.clock.advance(10000);
  assert.equal(run.reads.length, 1, '2.5-second job polling must not launch overlapping dashboard reads');
  assert.equal(run.jobReads.length, 5, 'lightweight job progress still updates');
  run.reads[0].result.resolve(fixture('first'));
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'first', 'a slow result is not rejected by newer polling generations');
  assert.equal(run.reads.length, 2, 'job activation coalesces one trailing read');
  run.reads[1].result.resolve(fixture('second'));
  await initial;
  assert.equal(run.state.loading, false);
  await run.clock.advance(2500);
  assert.equal(run.reads.length, 3);
  await run.clock.advance(7500);
  assert.equal(run.reads.length, 3, 'next full poll waits until this request finishes');
  run.poller.dispose();
});

test('a job finishing during a dashboard read causes one trailing read of its final commit', async () => {
  const run = setup({ initialJobs: [job('running')] });
  void run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('initial'));
  await flush();
  run.reads[1].result.resolve(fixture('running'));
  await flush();
  await run.clock.advance(2500);
  assert.equal(run.reads.length, 3);
  run.setJobs([job('complete')]);
  await run.clock.advance(2500);
  assert.equal(run.state.jobs[0].state, 'complete', 'completion is visible without waiting for prices');
  assert.equal(run.reads.length, 3);
  run.reads[2].result.resolve(fixture('before-final-commit'));
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'before-final-commit');
  assert.equal(run.reads.length, 4);
  run.reads[3].result.resolve(fixture('after-final-commit'));
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'after-final-commit');
  assert.equal(run.state.loading, false);
  await run.clock.advance(14999);
  assert.equal(run.reads.length, 4, 'completed jobs return dashboard polling to the idle cadence');
  await run.clock.advance(1);
  assert.equal(run.reads.length, 5);
  run.poller.dispose();
});

for (const state of ['running', 'queued'] as const) {
  test(`a ${state} job waiting for resume starts at the idle cadence`, async () => {
    const run = setup({ initialJobs: [job(state, { requires_resume: true })] });
    const initial = run.poller.reload();
    await flush();
    run.reads[0].result.resolve(fixture('waiting'));
    await flush();
    assert.equal(run.reads.length, 1, 'a waiting job must not queue an activation read');
    await initial;
    assert.equal(run.state.loading, false);
    await run.clock.advance(14999);
    assert.equal(run.reads.length, 1);
    assert.equal(run.jobReads.length, 1, 'waiting job progress uses the idle cadence too');
    await run.clock.advance(1);
    assert.equal(run.reads.length, 2);
    assert.equal(run.jobReads.length, 2);
    run.poller.dispose();
  });
}

test('a running job waiting for resume reads its final commit and returns to idle polling', async () => {
  const run = setup({ initialJobs: [job('running')] });
  void run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('initial'));
  await flush();
  run.reads[1].result.resolve(fixture('running'));
  await flush();
  await run.clock.advance(2500);
  assert.equal(run.reads.length, 3);
  run.setJobs([job('running', { requires_resume: true })]);
  await run.clock.advance(2500);
  assert.equal(run.state.jobs[0].progress.requires_resume, true);
  assert.equal(run.reads.length, 3, 'the final read waits for the pending dashboard response');
  run.reads[2].result.resolve(fixture('before-pause-commit'));
  await flush();
  assert.equal(run.reads.length, 4, 'waiting for resume triggers one trailing read');
  run.reads[3].result.resolve(fixture('after-pause-commit'));
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'after-pause-commit');
  assert.equal(run.state.loading, false);
  await run.clock.advance(14999);
  assert.equal(run.reads.length, 4);
  assert.equal(run.jobReads.length, 3);
  await run.clock.advance(1);
  assert.equal(run.reads.length, 5);
  assert.equal(run.jobReads.length, 4);
  run.poller.dispose();
});

test('a waiting job resuming work restores responsive dashboard and progress polling', async () => {
  const run = setup({ initialJobs: [job('running', { requires_resume: true })] });
  void run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('waiting'));
  await flush();
  assert.equal(run.reads.length, 1);
  run.setJobs([job('running', { requires_resume: false })]);
  await run.clock.advance(15000);
  assert.equal(run.state.jobs[0].progress.requires_resume, false);
  assert.equal(run.reads.length, 2, 'resuming work requests a fresh dashboard');
  run.reads[1].result.resolve(fixture('resumed'));
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'resumed');
  await run.clock.advance(2499);
  assert.equal(run.reads.length, 2);
  assert.equal(run.jobReads.length, 2);
  await run.clock.advance(1);
  assert.equal(run.reads.length, 3);
  assert.equal(run.jobReads.length, 3);
  run.poller.dispose();
});

test('manual refreshes coalesce, retain the snapshot, and recover after a failed read', async () => {
  const run = setup();
  void run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('saved'));
  await flush();
  const refresh = run.poller.reload();
  const repeated = run.poller.reload();
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'saved');
  assert.equal(run.state.loading, true);
  assert.equal(run.reads.length, 2);
  run.reads[1].result.resolve(fixture('intermediate'));
  await flush();
  assert.equal(run.reads.length, 3);
  run.reads[2].result.reject(new Error('Read failed'));
  await Promise.all([refresh, repeated]);
  assert.equal(run.state.dashboard?.generated_at, 'intermediate');
  assert.equal(run.state.error, 'Read failed');
  assert.equal(run.state.loading, false);
  const retry = run.poller.reload();
  await flush();
  run.reads[3].result.resolve(fixture('recovered'));
  await retry;
  assert.equal(run.state.error, null);
  assert.equal(run.state.loading, false);
  assert.equal(run.state.dashboard?.generated_at, 'recovered');
  run.poller.dispose();
});

test('switching selection disposes old requests and reload callbacks, even if abort is ignored', async () => {
  const old = setup();
  const oldReload = old.poller.reload;
  const oldRead = oldReload();
  await flush();
  old.poller.dispose();
  assert.equal(old.reads[0].signal.aborted, true);
  assert.equal(old.jobReads[0].aborted, true);
  const next = setup({ selection: { source: 'rentals', timeframe: '30d', backdrop: 'Black' } });
  const nextRead = next.poller.reload();
  await flush();
  next.reads[0].result.resolve(fixture('black-rentals'));
  await nextRead;
  old.reads[0].result.resolve(fixture('stale-listings'));
  await oldRead;
  await oldReload();
  await old.clock.advance(60000);
  assert.equal(old.published.length, 0);
  assert.equal(old.reads.length, 1);
  assert.equal(old.clock.timerCount, 0);
  assert.deepEqual(next.reads[0].selection, { source: 'rentals', timeframe: '30d', backdrop: 'Black' });
  assert.equal(next.state.dashboard?.generated_at, 'black-rentals');
  next.poller.dispose();
});

test('dashboard data loads independently when the jobs endpoint fails', async () => {
  const run = setup();
  run.failJobs(new Error('Jobs unavailable'));
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('saved-prices'));
  await initial;
  assert.equal(run.state.dashboard?.generated_at, 'saved-prices');
  assert.equal(run.state.loading, false);
  assert.equal(run.state.error, 'Jobs unavailable');
  run.failJobs(null);
  await run.clock.advance(15000);
  assert.equal(run.state.error, null);
  assert.equal(run.state.dashboard?.generated_at, 'saved-prices');
  run.poller.dispose();
});

test('hidden pages postpone scheduled reads while explicit reloads remain available', async () => {
  const run = setup();
  void run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('initial'));
  await flush();
  run.clock.hide();
  await run.clock.advance(45000);
  assert.equal(run.reads.length, 1);
  assert.equal(run.jobReads.length, 1);
  const manual = run.poller.reload();
  await flush();
  assert.equal(run.reads.length, 2);
  run.reads[1].result.resolve(fixture('manual'));
  await manual;
  run.clock.show();
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 3);
  run.poller.dispose();
});

test('initial read errors stop loading and scheduled polls can recover', async () => {
  const run = setup();
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.reject(new Error('Database busy'));
  await initial;
  assert.equal(run.state.dashboard, null);
  assert.equal(run.state.loading, false);
  assert.equal(run.state.error, 'Database busy');
  await run.clock.advance(15000);
  run.reads[1].result.resolve(fixture('available'));
  await flush();
  assert.equal(run.published.at(-1)?.generated_at, 'available');
  assert.equal(run.state.error, null);
  assert.equal(run.state.loading, false);
  run.poller.dispose();
});
