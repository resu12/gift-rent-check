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

function setup(options: { initialJobs?: Job[]; selection?: PricingSelection; revisions?: boolean; startup?: () => Promise<Dashboard> } = {}) {
  const clock = fakeClock();
  const reads: { selection: PricingSelection; signal: AbortSignal; result: ReturnType<typeof deferred<Dashboard>> }[] = [];
  const jobReads: AbortSignal[] = [];
  let currentJobs = options.initialJobs || [];
  let jobFailure: Error | null = null;
  let currentToken = 'v1';
  let tokenFailure: Error | null = null;
  const tokenReads: AbortSignal[] = [];
  const state = { dashboard: null as Dashboard | null, jobs: [] as Job[], loading: false, error: null as string | null };
  const published: Dashboard[] = [];
  const adapter: DashboardAdapter = {
    ...(options.startup ? {getStartupDashboard: options.startup} : {}),
    ...(options.revisions ? { async getUpdateToken(signal?: AbortSignal) {
      tokenReads.push(signal!);
      if (tokenFailure) throw tokenFailure;
      return currentToken;
    } } : {}),
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
    clock, reads, jobReads, tokenReads, state, published, poller,
    setJobs(jobs: Job[]) { currentJobs = jobs; },
    failJobs(error: Error | null) { jobFailure = error; },
    setToken(token: string) { currentToken = token; },
    failToken(error: Error | null) { tokenFailure = error; },
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
  await run.clock.advance(14999);
  assert.equal(run.reads.length, 2, 'active scans do not rebuild the full dashboard every progress poll');
  await run.clock.advance(1);
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
  await run.clock.advance(15000);
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
  await run.clock.advance(15000);
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
  assert.equal(run.jobReads.length, 8);
  await run.clock.advance(1);
  assert.equal(run.reads.length, 5);
  assert.equal(run.jobReads.length, 9);
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
  assert.equal(run.reads.length, 2, 'job progress resumes at 2.5 seconds without rebuilding comparison data');
  assert.equal(run.jobReads.length, 3);
  await run.clock.advance(12500);
  assert.equal(run.reads.length, 3);
  assert.equal(run.jobReads.length, 8);
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
  await run.clock.advance(30000);
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
  await run.clock.advance(30000);
  run.reads[1].result.resolve(fixture('available'));
  await flush();
  assert.equal(run.published.at(-1)?.generated_at, 'available');
  assert.equal(run.state.error, null);
  assert.equal(run.state.loading, false);
  run.poller.dispose();
});

const snapshot = (token: string) => ({ ...fixture(token), update_token: token });

test('unchanged idle polls read only revision and progress without rebuilding the dashboard', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(snapshot('v1'));
  await initial;
  await run.clock.advance(60000);
  assert.equal(run.reads.length, 1);
  assert.equal(run.tokenReads.length, 4);
  assert.equal(run.jobReads.length, 5);
  assert.equal(run.published.length, 1);
  assert.equal(run.state.loading, false);
  run.setToken('v2');
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 2);
  run.reads[1].result.resolve(snapshot('v2'));
  await flush();
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 2);
  assert.equal(run.state.dashboard?.update_token, 'v2');
  run.poller.dispose();
});

test('active jobs still poll progress quickly while unchanged comparisons are reused', async () => {
  const run = setup({ revisions: true, initialJobs: [job('running')] });
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(snapshot('v1'));
  await initial;
  await run.clock.advance(10000);
  assert.equal(run.jobReads.length, 5);
  assert.equal(run.reads.length, 1);
  assert.equal(run.tokenReads.length, 1, 'the activation probe is followed by the slower dashboard cadence');
  run.setJobs([job('complete')]);
  run.setToken('v2');
  await run.clock.advance(2500);
  assert.equal(run.state.jobs[0].state, 'complete');
  assert.equal(run.reads.length, 2);
  run.reads[1].result.resolve(snapshot('v2'));
  await flush();
  assert.equal(run.state.dashboard?.update_token, 'v2');
  run.poller.dispose();
});

test('a collection settling forces one final dashboard read even when its revision token is unchanged', async () => {
  const run = setup({ revisions: true, initialJobs: [job('running')] });
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(snapshot('v1'));
  await initial;
  run.setJobs([job('complete')]);
  await run.clock.advance(2500);
  assert.equal(run.reads.length, 2, 'completion reloads the final successful source evidence');
  run.reads[1].result.resolve({ ...snapshot('v1'), generated_at: 'final-evidence' });
  await flush();
  assert.equal(run.state.dashboard?.generated_at, 'final-evidence');
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 2, 'subsequent idle polls still reuse unchanged comparisons');
  run.poller.dispose();
});

test('a revision committed during a slow full response is loaded on the next check', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload();
  await flush();
  run.setToken('v2');
  run.reads[0].result.resolve(snapshot('v1'));
  await initial;
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 2, 'the response token cannot consume a newer server commit');
  run.reads[1].result.resolve(snapshot('v2'));
  await flush();
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 2);
  run.poller.dispose();
});

test('manual and mutation reloads bypass unchanged revisions and coalesce into one trailing read', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(snapshot('v1'));
  await initial;
  const mutation = run.poller.reload();
  await flush();
  const manual = run.poller.reload();
  await flush();
  assert.equal(run.reads.length, 2);
  run.reads[1].result.resolve(snapshot('v1'));
  await flush();
  assert.equal(run.reads.length, 3);
  run.reads[2].result.resolve(snapshot('v1'));
  await Promise.all([mutation, manual]);
  assert.equal(run.tokenReads.length, 0);
  assert.equal(run.state.loading, false);
  run.poller.dispose();
});

test('revision failures preserve saved prices and later lightweight checks recover', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(snapshot('v1'));
  await initial;
  run.failToken(new Error('Revision unavailable'));
  await run.clock.advance(15000);
  assert.equal(run.state.error, 'Revision unavailable');
  assert.equal(run.state.dashboard?.update_token, 'v1');
  assert.equal(run.state.loading, false);
  run.failToken(null);
  await run.clock.advance(30000);
  assert.equal(run.state.error, null);
  assert.equal(run.reads.length, 1);
  run.poller.dispose();
});

test('a legacy full response without a revision keeps refreshing safely', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload();
  await flush();
  run.reads[0].result.resolve(fixture('legacy'));
  await initial;
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 2);
  assert.equal(run.tokenReads.length, 0);
  run.poller.dispose();
});

test('continuously changing comparison data rebuilds at most once per fifteen seconds while progress stays responsive', async () => {
  const run = setup({ revisions: true, initialJobs: [job('running')] });
  const initial = run.poller.reload();
  await flush(); run.reads[0].result.resolve(snapshot('v1')); await initial;
  let resolvedReads = 1;
  for (let tick = 1; tick <= 24; tick++) {
    const token = `page-${tick}`;
    run.setToken(token);
    await run.clock.advance(2500);
    assert.equal(run.reads.length, 1 + Math.floor(tick / 6));
    if (run.reads.length > resolvedReads) {
      run.reads[resolvedReads++].result.resolve(snapshot(token));
      await flush();
    }
  }
  assert.equal(run.jobReads.length, 25, 'progress still checks every 2.5 seconds');
  assert.equal(run.reads.length, 5, 'one initial response plus four periodic dashboard rebuilds');
  assert.equal(run.state.error, null);
  run.poller.dispose();
});

test('failed progress reads back off independently to thirty seconds and recover to the fast cadence', async () => {
  const run = setup({ revisions: true, initialJobs: [job('running')] });
  const initial = run.poller.reload();
  await flush(); run.reads[0].result.resolve(snapshot('v1')); await initial;
  run.failJobs(new Error('Progress temporarily unavailable'));
  await run.clock.advance(2500);
  assert.equal(run.jobReads.length, 2);
  for (const delay of [5000, 10000, 20000, 30000, 30000]) {
    const before: number = run.jobReads.length;
    await run.clock.advance(delay - 1);
    assert.equal(run.jobReads.length, before, 'failed progress reads do not hammer the service');
    await run.clock.advance(1);
    assert.equal(run.jobReads.length, before + 1);
    assert.equal(run.state.error, 'Progress temporarily unavailable', 'successful dashboard probes do not hide the progress failure');
  }
  assert.ok(run.tokenReads.length >= 6, 'the dashboard schedule is independent of failed progress reads');
  assert.equal(run.reads.length, 1, 'unchanged saved data is retained');
  run.failJobs(null);
  const beforeRecovery = run.jobReads.length;
  await run.clock.advance(30000);
  assert.equal(run.jobReads.length, beforeRecovery + 1);
  assert.equal(run.state.error, null);
  await run.clock.advance(2499);
  assert.equal(run.jobReads.length, beforeRecovery + 1);
  await run.clock.advance(1);
  assert.equal(run.jobReads.length, beforeRecovery + 2);
  run.poller.dispose();
});

test('full dashboard failures back off without delaying job progress or replacing saved values', async () => {
  const run = setup({ revisions: true, initialJobs: [job('running')] });
  const initial = run.poller.reload();
  await flush(); run.reads[0].result.resolve(snapshot('v1')); await initial;
  run.setToken('v2');
  await run.clock.advance(15000);
  run.reads[1].result.reject(new Error('Dashboard temporarily unavailable'));
  await flush();
  assert.equal(run.state.dashboard?.update_token, 'v1');
  assert.equal(run.state.error, 'Dashboard temporarily unavailable');
  await run.clock.advance(29999);
  assert.equal(run.reads.length, 2);
  assert.equal(run.state.error, 'Dashboard temporarily unavailable', 'successful progress cannot hide a failed dashboard refresh');
  assert.ok(run.jobReads.length >= 18);
  await run.clock.advance(1);
  assert.equal(run.reads.length, 3);
  run.reads[2].result.resolve(snapshot('v2'));
  await flush();
  assert.equal(run.state.error, null);
  run.setToken('v3');
  await run.clock.advance(15000);
  assert.equal(run.reads.length, 4, 'successful reads restore the normal dashboard cadence');
  run.poller.dispose();
});

test('manual Retry and a final collection commit bypass a failed dashboard backoff', async () => {
  for (const trigger of ['manual', 'complete'] as const) {
    const run = setup({ revisions: true, initialJobs: [job('running')] });
    const initial = run.poller.reload();
    await flush(); run.reads[0].result.resolve(snapshot('v1')); await initial;
    run.setToken('v2');
    await run.clock.advance(15000);
    run.reads[1].result.reject(new Error('Dashboard temporarily unavailable'));
    await flush();
    let retry: Promise<void> | undefined;
    if (trigger === 'manual') { retry = run.poller.reload(); await flush(); }
    else { run.setJobs([job('complete')]); await run.clock.advance(2500); }
    assert.equal(run.reads.length, 3, `${trigger} requests fresh saved data before the backoff ends`);
    run.reads[2].result.resolve(snapshot('v2'));
    await retry; await flush();
    assert.equal(run.state.error, null);
    assert.equal(run.state.dashboard?.update_token, 'v2');
    run.poller.dispose();
  }
});

test('checked analytics reload rejects a failed dashboard read and can recover with unchanged capture dates', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload(); await flush();
  run.reads[0].result.resolve(snapshot('unchanged-capture')); await initial;
  const failed = assert.rejects(run.poller.reloadDashboardChecked(), /Could not reload saved dashboard data/);
  await flush(); run.reads[1].result.reject(new Error('Read failed')); await failed;
  assert.equal(run.state.dashboard?.generated_at, 'unchanged-capture');
  const recovery = run.poller.reloadDashboardChecked(); await flush();
  run.reads[2].result.resolve(snapshot('unchanged-capture')); await recovery;
  assert.equal(run.state.error, null);
  assert.equal(run.tokenReads.length, 0, 'confirmation forces a complete dashboard read');
  run.poller.dispose();
});

test('checked analytics reload accepts saved data even when the independent jobs read fails', async () => {
  const run = setup(); run.failJobs(new Error('Jobs unavailable'));
  const checked = run.poller.reloadDashboardChecked(); await flush();
  run.reads[0].result.resolve(fixture('saved-history')); await checked;
  assert.equal(run.state.dashboard?.generated_at, 'saved-history');
  assert.equal(run.state.error, 'Jobs unavailable', 'the separate jobs failure remains visible');
  run.poller.dispose();
});

test('checked analytics reload rejects a failed trailing read despite the preceding response succeeding', async () => {
  const run = setup({ revisions: true });
  const inFlight = run.poller.reload(); await flush();
  const failed = assert.rejects(run.poller.reloadDashboardChecked(), /Could not reload saved dashboard data/);
  run.reads[0].result.resolve(snapshot('before-import')); await flush();
  assert.equal(run.reads.length, 2);
  run.reads[1].result.reject(new Error('Imported history read failed'));
  await Promise.all([inFlight, failed]);
  assert.equal(run.state.dashboard?.generated_at, 'before-import');
  run.poller.dispose();
});

test('a queued unchanged-revision probe cannot acknowledge a failed checked full read', async () => {
  const run = setup({ revisions: true });
  const initial = run.poller.reload(); await flush();
  const failed = assert.rejects(run.poller.reloadDashboardChecked(), /Could not reload saved dashboard data/);
  run.reads[0].result.resolve(snapshot('v1')); await flush();
  run.setJobs([job('running')]);
  await run.clock.advance(15000); // Job activation queues a lightweight dashboard probe.
  run.reads[1].result.reject(new Error('History unavailable')); await Promise.all([initial, failed]);
  assert.equal(run.tokenReads.length, 1);
  assert.equal(run.state.dashboard?.update_token, 'v1');
  run.poller.dispose();
});

test('disposing rejects checked analytics reads immediately even if the adapter ignores abort', async () => {
  const run = setup();
  const interrupted = assert.rejects(run.poller.reloadDashboardChecked(), /dashboard changed/);
  await flush(); run.poller.dispose(); await interrupted;
  await assert.rejects(run.poller.reloadDashboardChecked(), /dashboard changed/);
  run.reads[0].result.resolve(fixture('late-history')); await flush();
  assert.equal(run.published.length, 0);
  assert.equal(run.clock.timerCount, 0);
});


test('startup publishes saved data before rebuilding but only the full read consumes the update token', async () => {
  const saved = {...fixture('saved'), startup_preview:{generated_at:'2026-10-13T00:00:00Z'},update_token:'v1'};
  let startups=0;
  const f=setup({revisions:true,startup:async()=>{startups++;return saved;}});
  const initial=f.poller.reload(); await flush();
  assert.equal(f.state.dashboard,saved); assert.equal(f.state.loading,true); assert.equal(f.reads.length,1);
  f.reads[0].result.resolve({...fixture('current'),update_token:'v1'}); await initial;
  assert.equal(f.state.dashboard!.generated_at,'current'); assert.equal(f.state.loading,false);
  await f.clock.advance(15000); assert.equal(f.reads.length,1); assert.equal(startups,1);
  f.poller.dispose();
});

test('a current startup response avoids the second full read', async () => {
  const f=setup({startup:async()=>fixture('current')});
  await f.poller.reload(); assert.equal(f.reads.length,0); assert.equal(f.state.dashboard!.generated_at,'current');
  f.poller.dispose();
});

test('dashboard-only reloads force saved data without hiding independent jobs errors', async () => {
  const f = setup({ revisions: true });
  const initial = f.poller.reload(); await flush();
  f.reads[0].result.resolve({ ...fixture('initial'), update_token: 'v1' }); await initial;
  f.failJobs(new Error('Progress temporarily unavailable'));
  const failedProgress = f.poller.reload(); await flush();
  f.reads[1].result.resolve({ ...fixture('before commit'), update_token: 'v1' }); await failedProgress;
  const jobsBefore = f.jobReads.length;
  const committed = f.poller.reloadDashboard(); await flush();
  assert.equal(f.reads.length, 3, 'a commit forces saved-data loading despite an unchanged revision');
  f.reads[2].result.resolve({ ...fixture('after commit'), update_token: 'v1' }); await committed;
  assert.equal(f.state.dashboard!.generated_at, 'after commit');
  assert.equal(f.state.error, 'Progress temporarily unavailable');
  assert.equal(f.jobReads.length, jobsBefore, 'job polling remains independent');
  f.poller.dispose();
});

test('failed revalidation preserves the preview and cannot acknowledge a checked mutation reload', async () => {
  const saved={...fixture('saved'),startup_preview:{generated_at:'2026-10-13T00:00:00Z'}};
  const f=setup({startup:async()=>saved});
  const checked=assert.rejects(f.poller.reloadDashboardChecked(),/Could not reload/); await flush();
  f.reads[0].result.reject(new Error('Read unavailable')); await checked;
  assert.equal(f.state.dashboard,saved); assert.equal(f.state.error,'Read unavailable');
  const retry=f.poller.reloadDashboardChecked(); await flush();
  f.reads[1].result.resolve(fixture('current')); await retry;
  assert.equal(f.state.dashboard!.generated_at,'current'); assert.equal(f.state.error,null);
  f.poller.dispose();
});

test('disposing during a startup read cannot publish that account or launch a follow-up read', async () => {
  const pending=deferred<Dashboard>(),f=setup({startup:()=>pending.promise});
  const initial=f.poller.reload(); await flush(); f.poller.dispose();
  pending.resolve({...fixture('old-account'),startup_preview:{generated_at:'2026-10-13T00:00:00Z'}}); await initial;
  assert.equal(f.state.dashboard,null); assert.equal(f.reads.length,0);
});


test('an unexpected preview from the normal endpoint never confirms a checked full read', async () => {
  const saved={...fixture('saved'),startup_preview:{generated_at:'2026-10-13T00:00:00Z'}};
  const f=setup({startup:async()=>saved});
  const checked=assert.rejects(f.poller.reloadDashboardChecked(),/Could not reload/);await flush();
  f.reads[0].result.resolve(saved);await checked;
  assert.equal(f.state.dashboard,saved);assert.match(f.state.error!,/could not be confirmed/);
  f.poller.dispose();
});
