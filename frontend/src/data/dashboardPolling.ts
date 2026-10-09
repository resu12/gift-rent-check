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
  read(signal: AbortSignal): Promise<T>;
  success(value: T): void;
  failure(problem: unknown): void;
  loading?(pending: boolean): void;
  interval(): number;
  environment: PollingEnvironment;
}) {
  const controller = new AbortController();
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let cancelTimer: (() => void) | undefined;

  function schedule() {
    if (controller.signal.aborted) return;
    cancelTimer = options.environment.setTimer(() => {
      cancelTimer = undefined;
      if (options.environment.isVisible()) void request();
      else schedule();
    }, options.interval());
  }

  function request(): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    cancelTimer?.();
    cancelTimer = undefined;
    if (inFlight) {
      // A manual refresh or job completion during a read needs one trailing
      // read, but must never invalidate the useful response already underway.
      queued = true;
      return inFlight;
    }
    inFlight = (async () => {
      options.loading?.(true);
      do {
        queued = false;
        try {
          const value = await Promise.resolve().then(() => options.read(controller.signal));
          if (!controller.signal.aborted) options.success(value);
        } catch (problem) {
          if (!controller.signal.aborted) options.failure(problem);
        }
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
  const message = (problem: unknown) => problem instanceof Error ? problem.message : 'The local service could not be reached.';
  const reportError = () => callbacks.error(dashboardError || jobsError);
  const interval = () => active ? 2500 : 15000;
  const dashboard = pollingTask({
    read: signal => adapter.getDashboard(selection, signal),
    success(data) {
      dashboardError = null;
      callbacks.dashboard(data);
      reportError();
    },
    failure(problem) { dashboardError = message(problem); reportError(); },
    loading: callbacks.loading,
    interval,
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
      if (wasActive !== active) void dashboard.request();
    },
    failure(problem) { jobsError = message(problem); reportError(); },
    interval,
    environment,
  });
  return {
    async reload() { await Promise.all([dashboard.request(), jobs.request()]); },
    dispose() { dashboard.dispose(); jobs.dispose(); },
  };
}
