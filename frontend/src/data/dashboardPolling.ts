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
  let disposed = false, dashboardReads = 0, fullReadSucceeded = false;
  let startupRead = true;
  const pendingChecks = new Set<() => void>();
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
      try {
        if (startupRead && adapter.getStartupDashboard) {
          startupRead = false;
          const saved = await adapter.getStartupDashboard(selection, signal);
          if (signal.aborted) return null;
          if (!saved.startup_preview) return saved;
          // Paint saved data before the expensive rebuild, without consuming
          // its token or acknowledging a mutation with a preview response.
          callbacks.dashboard(saved);
        }
        startupRead = false;
        const current = await adapter.getDashboard(selection, signal);
        if (current.startup_preview) throw new Error('The current view could not be confirmed. Your saved view is kept. Try again.');
        return current;
      }
      finally { if (!signal.aborted) callbacks.loading(false); }
    },
    success(data) {
      dashboardError = null;
      if (data) {
        dashboardReads++; fullReadSucceeded = true;
        loadedToken = typeof data.update_token === 'string' && data.update_token ? data.update_token : null;
        callbacks.dashboard(data);
      }
      reportError();
    },
    failure(problem) { fullReadSucceeded = false; dashboardError = message(problem); reportError(); },
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
    /** Gift commits must not wait for the independent collection-progress read. */
    reloadDashboard() { return dashboard.request(true); },
    /** Mutations need confirmation that their full saved-data read actually succeeded. */
    async reloadDashboardChecked() {
      if (disposed) throw new Error('The dashboard changed before saved data could reload.');
      const before = dashboardReads;
      let cancel!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('The dashboard changed before saved data could reload.'));
        pendingChecks.add(cancel);
      });
      try {
        await Promise.race([Promise.all([dashboard.request(true), jobs.request()]), interrupted]);
        // A successful jobs request, revision-only probe, or earlier response in
        // a coalesced request must not acknowledge a failed final full read.
        if (disposed || !fullReadSucceeded || dashboardError !== null || dashboardReads === before)
          throw new Error('Could not reload saved dashboard data.');
      } finally { pendingChecks.delete(cancel); }
    },
    dispose() {
      disposed = true; dashboard.dispose(); jobs.dispose();
      for (const cancel of pendingChecks) cancel();
      pendingChecks.clear();
    },
  };
}
