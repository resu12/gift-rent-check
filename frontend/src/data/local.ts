import type { Dashboard, DashboardAdapter, Job, JobKind, PricingSelection } from './types';
import { historyCollectionError, pricingQuery } from './pricingSelection.ts';

class ApiFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    let detail = `The local service returned ${response.status}.`;
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') detail = body.detail;
      else if (typeof body.error === 'string') detail = body.error;
    } catch { /* The service may be starting or unavailable. */ }
    throw new ApiFailure(detail, response.status);
  }
  return response.json() as Promise<T>;
}

type NewJobRequest = { kind: JobKind; timeframe?: PricingSelection['timeframe']; date_from?: string; date_to?: string };

async function postJob(body: NewJobRequest | { resume_job_id: number }, csrf: string): Promise<Job> {
  const result = await request<Job | { job: Job }>('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf },
    body: JSON.stringify(body),
  });
  return 'job' in result ? result.job : result;
}

// Hosting and authentication belong here. Components do not know whether data
// comes from the local Python service or a future authenticated host.
export const localAdapter: DashboardAdapter = {
  getDashboard: (selection, signal) => request<Dashboard>(`/api/dashboard?${pricingQuery(selection)}`, { signal }),
  getJobs: async (signal) => (await request<{ jobs: Job[] }>('/api/jobs', { signal })).jobs,
  startJob: (kind, csrf, selection) => {
    const body: NewJobRequest = { kind };
    if ((kind === 'prices' || kind === 'rental_prices' || kind === 'collect') && selection) {
      pricingQuery(selection); // Validate the same window used by saved-data views.
      if (kind !== 'prices') {
        const error = historyCollectionError(selection);
        if (error) throw new Error(error);
      }
      body.timeframe = selection.timeframe;
      if (selection.timeframe === 'custom') {
        body.date_from = selection.dateFrom;
        body.date_to = selection.dateTo;
      }
    }
    return postJob(body, csrf);
  },
  resumeJob: (id, csrf) => postJob({ resume_job_id: id }, csrf),
  stopJob: async (id, csrf) => (await request<{ job: Job }>(`/api/jobs/${id}/stop`, {
    method: 'POST',
    headers: { 'X-Dashboard-CSRF': csrf },
  })).job,
  exportUrl: (selection) => `/api/export.csv?${pricingQuery(selection)}`,
};
