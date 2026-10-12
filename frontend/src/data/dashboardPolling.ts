import type { Dashboard, DashboardAdapter, Job, PricingSelection } from './types.ts';

export interface PollingEnvironment {
  setTimer(callback: () => void, delay: number): () => void;
  isVisible(): boolean;
}

const browserEnvironment: PollingEnvironment = {
  setTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
  isVisible: () => !document.hidden,
};

interface PollCallbacks {
  dashboard(data: Dashboard): void;
  jobs(jobs: Job[]): void;
  loading(loading: boolean): void;
  error(message: string | null): void;
}

function pollingTask<T>(options: {
  read(signal: AbortSignal, force: boolean): Promise<T>;
  success(value: T): void;
  failure(problem: unknown): void;
  loading?(pending: boolean): void;
  interval(): number;
  environment: PollingEnvironment;
}) {
  const controller = new AbortController();
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let queuedForce = false;
  let cancelTimer: (() => void) | undefined;
  let failures = 0;

  function schedule() {
    if (controller.signal.aborted) return;
    cancelTimer = options.environment.setTimer(() => {
      cancelTimer = undefined;
      if (options.environment.isVisible()) void request();
      else schedule();
    }, Math.min(30000, options.interval() * 2 ** Math.min(failures, 4)));
  }

  function request(force = false): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    cancelTimer?.();
    cancelTimer = undefined;
    if (inFlight) {
      // A manual refresh or job completion during a read needs one trailing
      // read, but must never invalidate the useful response already underway.
      queued = true;
      queuedForce ||= force;
      return inFlight;
    }
    inFlight = (async () => {
      options.loading?.(true);
      let forceRead = force;
      do {
        queued = false;
        queuedForce = false;
        try {
          const value = await Promise.resolve().then(() => options.read(controller.signal, forceRead));
          if (!controller.signal.aborted) { failures = 0; options.success(value); }
        } catch (problem) {
          if (!controller.signal.aborted) { failures = Math.min(failures + 1, 4); options.failure(problem); }
        }
        forceRead = queuedForce;
      } while (queued && !controller.signal.aborted);
      if (!controller.signal.aborted) options.loading?.(false);
      inFlight = null;
      schedule();
    })();
    return inFlight;
  }

  return {
    request,
    dispose() {
      controller.abort();
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

/** One selection owns a cancellable session; request time never causes overlap. */
export function createDashboardPoller(
  adapter: DashboardAdapter,
  selection: PricingSelection,
  callbacks: PollCallbacks,
  environment: PollingEnvironment = browserEnvironment,
) {
  let active = false;
  let dashboardError: string | null = null;
  let jobsError: string | null = null;
  let loadedToken: string | null = null;
  const message = (problem: unknown) => problem instanceof Error ? problem.message : 'The local service could not be reached.';
  const reportError = () => callbacks.error(dashboardError || jobsError);
  const progressInterval = () => active ? 2500 : 15000;
  const dashboard = pollingTask({
    async read(signal, force) {
      // The token read contains no comparison records. A full response carries
      // its own token, so a commit during a slow read cannot be marked loaded.
      if (!force && loadedToken !== null && adapter.getUpdateToken) {
        const token = await adapter.getUpdateToken(signal);
        if (token === loadedToken) return null;
      }
      callbacks.loading(true);
      try { return await adapter.getDashboard(selection, signal); }
      finally { if (!signal.aborted) callbacks.loading(false); }
    },
    success(data) {
      dashboardError = null;
      if (data) {
        loadedToken = typeof data.update_token === 'string' && data.update_token ? data.update_token : null;
        callbacks.dashboard(data);
      }
      reportError();
    },
    failure(problem) { dashboardError = message(problem); reportError(); },
    // Rebuilding comparisons is more expensive than reading saved progress.
    // Manual reloads and the final collection commit still request immediately.
    interval: () => 15000,
    environment,
  });
  const jobs = pollingTask({
    read: signal => adapter.getJobs(signal),
    success(data) {
      const wasActive = active;
      active = data.some(job => (job.state === 'running' || job.state === 'queued') && job.progress?.requires_resume !== true);
      jobsError = null;
      callbacks.jobs(data);
      reportError();
      // Read once more after the final commit, even when it landed during a
      // slower dashboard response. Job status itself stays responsive meanwhile.
      if (wasActive !== active) void dashboard.request(wasActive && !active);
    },
    failure(problem) { jobsError = message(problem); reportError(); },
    interval: progressInterval,
    environment,
  });
  return {
    async reload() { await Promise.all([dashboard.request(true), jobs.request()]); },
    dispose() { dashboard.dispose(); jobs.dispose(); },
  };
}
