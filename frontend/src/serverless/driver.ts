import type { ServerlessAdapter, ServerlessState } from './transport.ts';

export type CollectionOutcome = 'complete' | 'stopped' | 'batch_limit' | 'cooldown' | 'attention';
export interface DriverOptions {
  adapter: ServerlessAdapter;
  onState(state: ServerlessState): void;
  onWait?(remainingMs: number): void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxPages?: number;
  maxCalls?: number;
  maxWaitMs?: number;
}

function interruptibleWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** One user action collects at most two pages. Reopening never starts a driver. */
export class BoundedCollectionDriver {
  private readonly options: DriverOptions;
  private readonly abort = new AbortController();
  private current: ServerlessState | null = null;
  private stopPromise: Promise<ServerlessState | null> | null = null;
  private active = false;

  constructor(options: DriverOptions) { this.options = options; }

  private publish(state: ServerlessState, force = false) {
    if (this.abort.signal.aborted && !force) return;
    this.current = state;
    this.options.onState(state);
  }

  private pause(): Promise<ServerlessState | null> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.current?.run || ['complete', 'failed', 'prototype_limit'].includes(this.current.run.status)) return Promise.resolve(this.current);
    this.stopPromise = this.options.adapter.call('stopRun', { run_id: this.current.run.id }).then(state => {
      this.publish(state, true);
      return state;
    });
    return this.stopPromise;
  }

  stop(): Promise<ServerlessState | null> {
    this.abort.abort();
    return this.pause();
  }

  async run(initial: () => Promise<ServerlessState>): Promise<CollectionOutcome> {
    if (this.active) throw new Error('A collection driver is already active');
    this.active = true;
    const now = this.options.now ?? Date.now;
    const wait = this.options.wait ?? interruptibleWait;
    try {
      const initialState = await initial();
      this.current = initialState;
      if (this.abort.signal.aborted) { await this.pause(); return 'stopped'; }
      this.publish(initialState);
      const startedAtPages = initialState.run?.pages_committed ?? 0;
      let calls = 0;
      let waitedMs = 0;
      let stepFinishedAfterStop = false;
      let serverOffset = initialState.server_time - now();
      while (!this.abort.signal.aborted) {
        const run = this.current!.run;
        if (!run) return 'attention';
        if (run.status === 'complete') return 'complete';
        if (['failed', 'prototype_limit', 'paused'].includes(run.status)) return 'attention';
        if (run.pages_committed - startedAtPages >= (this.options.maxPages ?? 2)) {
          await this.pause();
          return 'batch_limit';
        }
        if (calls >= (this.options.maxCalls ?? 8)) { await this.pause(); return 'attention'; }
        const remainingMs = Math.max(run.next_allowed_at || 0, run.lease_until || 0) - (now() + serverOffset);
        if (remainingMs > 0) {
          this.options.onWait?.(remainingMs);
          if (waitedMs + remainingMs > (this.options.maxWaitMs ?? 15000)) {
            await this.pause();
            return 'cooldown';
          }
          const slice = Math.min(remainingMs, 1000);
          waitedMs += slice;
          await wait(slice, this.abort.signal);
          continue;
        }
        this.options.onWait?.(0);
        calls += 1;
        const state = await this.options.adapter.call('stepRun', { run_id: run.id });
        if (this.abort.signal.aborted) { stepFinishedAfterStop = true; break; }
        this.publish(state);
        serverOffset = state.server_time - now();
      }
      await this.pause();
      // Stop can retain an HTTP lease until the outstanding request settles.
      // Its response may now be stale, so read durable state once to release the
      // visible lease without retrying the provider request or resuming work.
      if (stepFinishedAfterStop) this.publish(await this.options.adapter.call('getState'), true);
      return 'stopped';
    } finally {
      this.active = false;
      this.options.onWait?.(0);
    }
  }
}
