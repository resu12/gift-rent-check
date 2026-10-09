import type { Dashboard, DashboardAdapter, Job, JobKind, PricingSelection, MarketappSettingsAdapter } from './types';
import { marketappSettingsError, publicMarketappSettings } from './marketappSettings.ts';
import { historyCollectionError, pricingQuery } from './pricingSelection.ts';
import type { OwnedPriceEndpoint, OwnedPriceTransport } from './ownedPriceRefresh.ts';

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

const OWNED_PRICE_ROUTES: Record<OwnedPriceEndpoint, string> = {
  getOwnedPriceRefresh: '/api/owned-prices',
  startOwnedPriceRefresh: '/api/owned-prices/start',
  stepOwnedPriceRefresh: '/api/owned-prices/step',
  stopOwnedPriceRefresh: '/api/owned-prices/stop',
};

// Each mounted adapter owns its latest CSRF value. Hosting and authentication
// stay outside the shared price driver and components.
export function createLocalDashboardAdapter(): DashboardAdapter & { ownedPriceTransport: OwnedPriceTransport } {
  let csrf = '';
  const settingsRequest = async (method: 'GET' | 'POST' | 'DELETE', token = '', input?: { api_key: string; persist: boolean }, signal?: AbortSignal) => {
    if (method !== 'GET' && !token) throw new Error('Reload the dashboard before changing API key settings.');
    let response: Response;
    try {
      response = await fetch('/api/settings/marketapp', {
        method, credentials: 'same-origin', cache: 'no-store', signal,
        ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': token } }),
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
    } catch { throw new Error(marketappSettingsError()); }
    // Do not read server error messages: validation output may contain a secret.
    if (!response.ok) throw new Error(marketappSettingsError(response.status));
    try { return publicMarketappSettings(await response.json()); }
    catch { throw new Error('API key settings returned an invalid response.'); }
  };
  const marketappSettings: MarketappSettingsAdapter = {
    get: signal => settingsRequest('GET', '', undefined, signal),
    save: (apiKey, persist, token) => settingsRequest('POST', token, { api_key: apiKey, persist }),
    remove: token => settingsRequest('DELETE', token),
  };
  const ownedPriceTransport: OwnedPriceTransport = {
    async call<T>(endpoint: OwnedPriceEndpoint, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      const path = OWNED_PRICE_ROUTES[endpoint];
      if (!Object.hasOwn(OWNED_PRICE_ROUTES, endpoint)) throw new Error('Unsupported rent price operation.');
      const read = endpoint === 'getOwnedPriceRefresh';
      if (!read && !csrf) throw new Error('Reload saved data before checking rent prices.');
      // Match the cloud transport deadline. A timed-out mutation is reconciled
      // by the shared driver, never automatically sent a second time.
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timeout = setTimeout(cancel, 45000);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        return await request<T>(path, {
          method: read ? 'GET' : 'POST',
          signal: controller.signal,
          ...(read ? {} : { headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(input) }),
        });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
  return {
    mode: 'local',
    marketappSettings,
    personalAnalytics: {
      async importSnapshot(raw, token) {
        if (!token) throw new Error('Reload the dashboard before importing analytics.');
        if (new TextEncoder().encode(raw).byteLength > 262144) throw new Error('The analytics snapshot must be no larger than 256 KiB.');
        return request('/api/personal-analytics', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': token }, body: raw,
        });
      },
    },
    ownedPriceTransport,
    async getDashboard(selection, signal) {
      const data = await request<Dashboard>(`/api/dashboard?${pricingQuery(selection)}`, { signal });
      if (!signal?.aborted) csrf = data.capabilities?.csrf_token ?? '';
      return data;
    },
    getJobs: async (signal) => (await request<{ jobs: Job[] }>('/api/jobs', { signal })).jobs,
    startJob: (kind, csrf, selection, options) => {
      if (options?.forceRefresh) throw new Error('Force refresh of the Telegram comparison cache is available in Telegram only.');
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
}
