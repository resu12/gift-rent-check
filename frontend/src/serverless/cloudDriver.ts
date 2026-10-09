import type { Job } from '../data/types.ts';
import type { CloudTransport } from './cloudTransport.ts';

export function isCollecting(job: Job) { return job.state === 'running' || job.state === 'queued'; }
export function readJob(value: { job: Job }): Job {
  const job = value?.job;
  if (!job || !Number.isSafeInteger(job.id) || !['queued', 'running', 'partial', 'complete', 'failed'].includes(job.state)
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
}

/** Only explicit Start/Resume creates a driver; reads and reopening cannot do so. */
export class CloudCollectionDriver {
  private readonly options: DriverOptions;
  private readonly controller = new AbortController();
  private current: Job;
  private stopRequest: Promise<Job> | null = null;
  constructor(job: Job, options: DriverOptions) { this.current = job; this.options = options; }

  get jobId() { return this.current.id; }
  get interrupted() { return this.controller.signal.aborted; }
  interrupt() { this.controller.abort(); }

  async stop(): Promise<Job> {
    this.interrupt();
    if (!this.stopRequest) this.stopRequest = this.options.transport.call<{ job: Job }>('stopJob', { job_id: this.current.id })
      .then(value => { const job = readJob(value); this.current = job; this.options.onJob(job); return job; });
    return this.stopRequest;
  }

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
          await this.stop();
          this.options.onError('This collection reached its bounded session. Progress is saved; use Resume to continue.');
          return;
        }
        if (remaining > 0) { await wait(Math.min(remaining, 1000), this.controller.signal); continue; }
        calls += 1;
        // Do not cancel an in-flight mutation: its outcome must remain observable.
        const job = readJob(await this.options.transport.call<{ job: Job }>('stepJob', { job_id: this.current.id }));
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
      if (this.interrupted) {
        try {
          const { jobs } = await this.options.transport.call<{ jobs: Job[] }>('getJobs');
          const job = jobs.find(item => item.id === this.current.id);
          if (job) this.options.onJob(job);
        } catch { /* Normal UI reads offer a retry when connection returns. */ }
      }
    }
  }
}
