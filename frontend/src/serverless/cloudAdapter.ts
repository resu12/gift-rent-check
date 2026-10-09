import type { Dashboard, DashboardAdapter, Job, JobKind, PricingSelection } from '../data/types.ts';
import { historyCollectionError, pricingQuery } from '../data/pricingSelection.ts';
import { formatAmount } from '../data/helpers.ts';
import type { CloudTransport } from './cloudTransport.ts';
import { CloudCollectionDriver, isCollecting, readJob } from './cloudDriver.ts';

type Listener = (event: { job?: Job; error?: string; savedDataChanged?: boolean }) => void;
export const CLOUD_JOB_KINDS: JobKind[] = ['prices', 'rental_prices', 'collect'];

function selectionInput(selection: PricingSelection): Record<string, unknown> {
  return Object.fromEntries(new URLSearchParams(pricingQuery(selection)));
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export the displayed saved-data calculation, without an unauthenticated endpoint. */
export function dashboardCsv(data: Dashboard, selection: PricingSelection): string {
  const amount = (value: string | null | undefined) => value == null ? '' : formatAmount(value);
  const header = ['nft_address', 'name', 'collection_address', 'model', 'backdrop', 'asking_gram_per_day', 'suggested_gram_per_day', 'collection_mean', 'model_mean', 'model_black_mean', 'pricing_unit', 'pricing_source', 'timeframe', 'date_from', 'date_to', 'comparison_backdrop', 'recorded_rentals', 'rental_count_coverage', 'membership_sources', 'ownership_observed_at', 'price_observed_at', 'uncertainties'];
  const rows = data.gifts.filter(gift => gift.is_portfolio && (!selection.backdrop || gift.backdrop === selection.backdrop)).map(gift => [
    gift.nft_address, gift.name, gift.collection_address, gift.model, gift.backdrop, amount(gift.price_per_day),
    amount(gift.pricing?.recommended_price_per_day), amount(gift.pricing?.collection.mean), amount(gift.pricing?.model.mean),
    amount(gift.pricing?.model_black.mean), gift.pricing?.unit, selection.source, selection.timeframe, selection.dateFrom,
    selection.dateTo, selection.backdrop, gift.rental_history?.recorded_count, gift.rental_history?.coverage,
    gift.membership_sources.join('; '), gift.observed_at, gift.price_observed_at, gift.uncertainties.join('; '),
  ]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface CloudDashboardAdapter extends DashboardAdapter {
  interrupt(): void;
  savedDataChanged(): void;
}

export function createCloudDashboardAdapter(transport: CloudTransport, options: { onDashboardLoaded?(data: Dashboard): void } = {}): CloudDashboardAdapter {
  let driver: CloudCollectionDriver | null = null;
  let launching = false;
  let generation = 0;
  const listeners = new Set<Listener>();
  const emit = (event: { job?: Job; error?: string; savedDataChanged?: boolean }) => { for (const listener of listeners) listener(event); };
  const decorate = (job: Job): Job => ({ ...job, progress: { ...job.progress,
    requires_resume: isCollecting(job) && !(driver?.jobId === job.id && !driver.interrupted) && job.progress.requires_resume === true,
  } });

  async function launch(endpoint: 'startJob' | 'resumeJob', input: Record<string, unknown>) {
    if (launching || (driver && !driver.interrupted)) throw new Error('A collection is already running in this view. Stop it before starting another.');
    launching = true;
    const launchGeneration = generation;
    try {
      const job = readJob(await transport.call<{ job: Job }>(endpoint, input));
      if (generation !== launchGeneration) {
        const pausedView = { ...job, progress: { ...job.progress, requires_resume: isCollecting(job) } };
        emit({ job: pausedView });
        return pausedView;
      }
      if (isCollecting(job)) {
        const active = new CloudCollectionDriver(job, {
          transport,
          onJob: next => emit({ job: decorate(next) }),
          onError: error => emit({ error }),
        });
        driver = active;
        emit({ job: decorate(job) });
        void active.run().finally(() => { if (driver === active) driver = null; });
      }
      return decorate(job);
    } catch (error) {
      // The mutation may have committed. Reconcile status once, without retrying it.
      try { const { jobs } = await transport.call<{ jobs: Job[] }>('getJobs'); for (const job of jobs) emit({ job: decorate(job) }); } catch { /* UI read retry remains available. */ }
      throw error;
    } finally { launching = false; }
  }

  return {
    mode: 'serverless',
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    savedDataChanged() { emit({ savedDataChanged: true }); },
    interrupt() { generation += 1; driver?.interrupt(); },
    async getDashboard(selection, signal) {
      const data = await transport.call<Dashboard>('getDashboard', selectionInput(selection), signal);
      if (!Array.isArray(data.gifts) || !data.summary || !data.capabilities || !data.gifts.every(gift => gift && typeof gift.id === 'string' && Array.isArray(gift.uncertainties)))
        throw new Error('The server returned an unexpected dashboard. Reload saved data.');
      if (!signal?.aborted) options.onDashboardLoaded?.(data);
      return { ...data, capabilities: { ...data.capabilities, hosting: 'serverless', supported_jobs: CLOUD_JOB_KINDS } };
    },
    async getJobs(signal) {
      const response = await transport.call<{ jobs: Job[] }>('getJobs', {}, signal);
      if (!Array.isArray(response.jobs)) throw new Error('The server returned an unexpected collection list. Reload saved data.');
      return response.jobs.map(job => decorate(readJob({ job })));
    },
    startJob(kind, _csrf, selection) {
      if (!CLOUD_JOB_KINDS.includes(kind)) return Promise.reject(new Error('Wallet discovery and ownership refresh are not available in Telegram yet.'));
      const chosen = selection ?? { source: 'listings', timeframe: '30d' };
      pricingQuery(chosen);
      if (kind !== 'prices') { const error = historyCollectionError(chosen); if (error) return Promise.reject(new Error(error)); }
      return launch('startJob', { kind, timeframe: chosen.timeframe,
        ...(chosen.timeframe === 'custom' ? { date_from: chosen.dateFrom, date_to: chosen.dateTo } : {}),
      });
    },
    resumeJob(id) { return launch('resumeJob', { job_id: id }); },
    async stopJob(id) {
      if (driver?.jobId === id) return driver.stop();
      const job = readJob(await transport.call<{ job: Job }>('stopJob', { job_id: id })); emit({ job }); return job;
    },
    exportUrl: () => '',
    exportCsv(data, selection) {
      const url = URL.createObjectURL(new Blob([dashboardCsv(data, selection)], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `gift-pricing-${selection.source}-${selection.timeframe}.csv`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
  };
}
