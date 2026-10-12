import type { Job } from '../data/types.ts';
import type { CloudTransport } from './cloudTransport.ts';

export function isCollecting(job: Job) { return job.state === 'running' || job.state === 'queued'; }
export function readJob(value: { job: Job }): Job {
  const job = value?.job;
  if (!job || !Number.isSafeInteger(job.id) || !['queued', 'running', 'partial', 'complete', 'failed'].includes(job.state)
    || (job.account_generation !== undefined && (!Number.isSafeInteger(job.account_generation) || job.account_generation < 0))
    || !job.progress || typeof job.progress !== 'object') throw new Error('The server returned an unexpected collection status. Reload saved data.');
  return job;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

interface DriverOptions {
  transport: CloudTransport;
  onJob(job: Job): void;
  onError(message: string): void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxCalls?: number;
  maxDurationMs?: number;
  /** Automatic batches leave durable limits to the server instead of recording a user Stop. */
  boundAction?: 'stop' | 'interrupt';
  /** A stopped local driver can still have one server request finishing. */
  onInterrupted?(job: Job): void;
  /** Delayed saved-status reads belong only to the still-visible account view. */
  canReconcile?(): boolean;
}

/** Only an accepted Start/Resume or bounded startup result creates a driver. */
export class CloudCollectionDriver {
  private readonly options: DriverOptions;
  private readonly controller = new AbortController();
  private current: Job;
  private stopRequest: Promise<Job> | null = null;
  private reconciliation: AbortController | null = null;
  constructor(job: Job, options: DriverOptions) { this.current = job; this.options = options; }

  get jobId() { return this.current.id; }
  get accountGeneration() { return this.current.account_generation; }
  get interrupted() { return this.controller.signal.aborted; }
  interrupt() {
    this.reconciliation?.abort();
    if (this.interrupted) return;
    this.controller.abort();
    this.options.onInterrupted?.(this.current);
  }

  async stop(): Promise<Job> {
    this.interrupt();
    if (!this.stopRequest) this.stopRequest = this.options.transport.call<{ job: Job }>('stopJob', this.identity())
      .then(value => {
        const job = readJob(value);
        if (job.id !== this.current.id || job.account_generation !== this.current.account_generation) throw new Error('This account changed. Reload saved data before continuing.');
        this.current = job; this.options.onJob(job); return job;
      });
    return this.stopRequest;
  }

  private identity() { return { job_id: this.current.id,
    ...(this.current.account_generation !== undefined ? { account_generation: this.current.account_generation } : {}) }; }

  async run(): Promise<void> {
    const now = this.options.now ?? Date.now;
    const wait = this.options.wait ?? delay;
    const deadline = now() + (this.options.maxDurationMs ?? 300000);
    let calls = 0;
    let serverOffset = Number(this.current.progress.server_time ?? now()) - now();
    try {
      while (!this.interrupted && isCollecting(this.current)) {
        const waitUntil = Math.max(Number(this.current.progress.next_allowed_at || 0), Number(this.current.progress.lease_until || 0));
        const remaining = waitUntil - (now() + serverOffset);
        if (calls >= (this.options.maxCalls ?? 105) || now() >= deadline || remaining > deadline - now()) {
          if (this.options.boundAction === 'interrupt') { this.interrupt(); return; }
          await this.stop();
          this.options.onError('This collection reached its bounded session. Progress is saved; use Resume to continue.');
          return;
        }
        if (remaining > 0) { await wait(Math.min(remaining, 1000), this.controller.signal); continue; }
        calls += 1;
        // Do not cancel an in-flight mutation: its outcome must remain observable.
        const job = readJob(await this.options.transport.call<{ job: Job }>('stepJob', this.identity()));
        if (job.id !== this.current.id || job.account_generation !== this.current.account_generation) throw new Error('This account changed. Reload saved data before continuing.');
        if (this.interrupted) break;
        this.current = job;
        serverOffset = Number(job.progress.server_time ?? now()) - now();
        this.options.onJob(job);
      }
    } catch (error) {
      this.interrupt();
      this.options.onError(error instanceof Error ? error.message : 'Collection stopped. Check saved progress before continuing.');
    } finally {
      // A timeout, closed view or concurrent Stop may leave a committed page.
      // Reconcile once using a read only endpoint, never a repeated step.
      if (this.interrupted) await this.reconcile(wait);
    }
  }

  private async reconcile(wait: (ms: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController(); this.reconciliation = controller;
    const allowed = () => !controller.signal.aborted && this.options.canReconcile?.() !== false;
    const saved = async (): Promise<Job | null> => {
      if (!allowed()) return null;
      const { jobs } = await this.options.transport.call<{ jobs: Job[] }>('getJobs', {}, controller.signal);
      if (!allowed() || !Array.isArray(jobs)) return null;
      const found = jobs.find(item => item.id === this.current.id && item.account_generation === this.current.account_generation);
      if (!found) return null;
      const job = readJob({ job: found });
      this.current = job; this.options.onJob(job); return job;
    };
    try {
      // Read the uncertain mutation once, without repeating it. A live lease
      // may outlast the transport timeout, so one later read confirms its end.
      const job = await saved();
      if (!job || !allowed() || !isCollecting(job)) return;
      const lease = job.progress.lease_until, serverTime = job.progress.server_time;
      if (typeof lease !== 'number' || !Number.isSafeInteger(lease) || typeof serverTime !== 'number' || !Number.isSafeInteger(serverTime)) return;
      const remaining = lease - serverTime;
      if (remaining <= 0 || remaining > 120000) return;
      let delayLeft = Math.min(remaining + 1, 120000);
      // Count bounded timer durations so a device clock correction cannot
      // extend this saved-only confirmation beyond the lease allowance.
      while (!controller.signal.aborted && allowed() && delayLeft > 0) {
        const duration = Math.min(delayLeft, 1000);
        await wait(duration, controller.signal); delayLeft -= duration;
      }
      if (!controller.signal.aborted && allowed()) await saved();
    } catch { /* Normal UI reads offer a retry when connection returns. */ }
    finally { this.reconciliation = null; }
  }
}
