import type { Dashboard, DashboardAdapter, Job, JobKind, PricingSelection, PersonalRentalAnalytics, MarketappLoginChallenge, MarketappLoginTestResult, MarketappAnalyticsRefreshChallenge, MarketappAnalyticsRefreshResult, MarketappAnalyticsRefreshStatus, MarketappAnalyticsStartupResult, ComparisonStartupResult } from '../data/types.ts';
import { historyCollectionError, pricingQuery } from '../data/pricingSelection.ts';
import { formatAmount } from '../data/helpers.ts';
import type { CloudTransport } from './cloudTransport.ts';
import { CloudCollectionDriver, isCollecting, readJob } from './cloudDriver.ts';
import { readPublicAccount, readPublicApiKeyCheck, validPublicApiKey } from './publicAccount.ts';
import type { PublicWalletChallenge } from './publicAccount.ts';
import type { OwnedPriceEndpoint } from '../data/ownedPriceRefresh.ts';
import { readComparisonStartupResult } from './comparisonsStartup.ts';
import { canonicalMainnetAddress } from './walletIdentity.ts';
import { publicMarketappSettings } from '../data/marketappSettings.ts';
import { readStorageStatus } from '../data/storageMonitoring.ts';
import { DASHBOARD_WIRE_FORMAT, decodeDashboardWire } from './dashboardWire.ts';

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
  let publicMode = false;
  let accountGeneration: number | undefined;
  let comparisonScope: string | undefined;
  let startupDriver: CloudCollectionDriver | null = null;
  const interruptedJobs = new Set<string>();
  const latestJobs = new Map<string, Job>();
  const jobViewLimit = 32;
  const jobIdentity = (job: Job) => `${comparisonScope ?? 'unloaded'}:${job.account_generation ?? 'private'}:${job.id}`;
  const clearJobViews = () => { latestJobs.clear(); interruptedJobs.clear(); };
  const rememberJob = (identity: string, job: Job) => {
    const seen = latestJobs.get(identity);
    const seenAt = seen ? Date.parse(seen.updated_at) : NaN, incomingAt = Date.parse(job.updated_at);
    const seenServerTime = seen?.progress.server_time, incomingServerTime = job.progress.server_time;
    // Step replies and status polling run independently. A delayed saved read
    // must not undo a newer committed page or revive a completed collection.
    const older = seen && ((seen.state === 'complete' || seen.state === 'failed') && job.state !== 'complete' && job.state !== 'failed'
      || seenAt > incomingAt || seenAt === incomingAt
      && typeof seenServerTime === 'number' && typeof incomingServerTime === 'number' && seenServerTime > incomingServerTime);
    const latest = older ? seen : job;
    latestJobs.delete(identity); latestJobs.set(identity, latest);
    while (latestJobs.size > jobViewLimit) {
      const localIdentity = driver ? `${comparisonScope ?? 'unloaded'}:${driver.accountGeneration ?? 'private'}:${driver.jobId}` : null;
      const keys = [...latestJobs.keys()];
      const oldest = keys.find(key => key !== localIdentity && !interruptedJobs.has(key)) ?? keys.find(key => key !== localIdentity)!;
      latestJobs.delete(oldest); interruptedJobs.delete(oldest);
    }
    return latest;
  };
  const visible = () => typeof document === 'undefined' || !document.hidden;
  const observeAccount = (value: number | undefined) => {
    if (!Number.isSafeInteger(value) || (value ?? -1) < 0) throw new Error('Reload account settings before continuing.');
    if (accountGeneration !== undefined && (value === undefined || value < accountGeneration)) throw new Error('This account changed. Reload saved data before continuing.');
    if (accountGeneration !== undefined && accountGeneration !== value) { generation += 1; clearJobViews(); driver?.interrupt(); }
    accountGeneration = value;
  };
  const accountInput = (input: Record<string, unknown>, savedGeneration: number | undefined) => {
    if (!publicMode) return input;
    if (!Number.isSafeInteger(savedGeneration) || (savedGeneration ?? -1) < 0) throw new Error('Reload account settings before continuing.');
    return { ...input, account_generation: savedGeneration };
  };
  const listeners = new Set<Listener>();
  const emit = (event: { job?: Job; error?: string; savedDataChanged?: boolean }) => {
    if (publicMode && event.job && event.job.account_generation !== accountGeneration) return;
    for (const listener of listeners) listener(event);
  };
  const decorate = (job: Job): Job => {
    if (publicMode && job.account_generation !== accountGeneration) throw new Error('This account changed. Reload saved data before continuing.');
    const identity = jobIdentity(job);
    job = rememberJob(identity, job);
    const interrupted = interruptedJobs.has(identity) && isCollecting(job);
    if (!isCollecting(job)) interruptedJobs.delete(identity);
    const localActive = driver?.jobId === job.id && driver.accountGeneration === job.account_generation && !driver.interrupted;
    return { ...job, progress: { ...job.progress,
      requires_resume: isCollecting(job) && !localActive && job.progress.requires_resume === true,
      ...(interrupted ? { client_interrupted: true } : {}),
    } };
  };
  const interrupted = (job: Job) => {
    const identity = jobIdentity(job), seen = latestJobs.get(identity);
    // Polling may already have observed a commit whose step reply timed out.
    // Preserve that evidence while the following status read confirms its end.
    const latest = seen && Date.parse(seen.updated_at) >= Date.parse(job.updated_at) ? seen : job;
    interruptedJobs.add(identity);
    emit({ job: decorate(isCollecting(latest) ? { ...latest, progress: { ...latest.progress, requires_resume: false } } : latest) });
  };
  const acceptAccount = (account: ReturnType<typeof readPublicAccount>) => {
    if (publicMode !== account.public_mode) clearJobViews();
    publicMode = account.public_mode; observeAccount(account.account_generation); return account;
  };

  async function launch(endpoint: 'startJob' | 'resumeJob', input: Record<string, unknown>) {
    if (launching || (driver && !driver.interrupted)) throw new Error('A collection is already running in this view. Stop it before starting another.');
    launching = true;
    const launchGeneration = generation;
    try {
      const job = readJob(await transport.call<{ job: Job }>(endpoint, input));
      if (publicMode && job.account_generation !== input.account_generation) throw new Error('This account changed. Reload saved data before continuing.');
      if (publicMode && job.account_generation !== accountGeneration) throw new Error('This account changed. Reload saved data before continuing.');
      if (generation !== launchGeneration) {
        const pausedView = { ...job, progress: { ...job.progress, requires_resume: isCollecting(job) } };
        emit({ job: pausedView });
        return pausedView;
      }
      if (isCollecting(job)) {
        driver?.interrupt();
        interruptedJobs.delete(jobIdentity(job));
        const current = () => generation === launchGeneration;
        const active: CloudCollectionDriver = new CloudCollectionDriver(job, {
          transport,
          onJob: next => { if (current()) emit({ job: decorate(next) }); },
          onError: error => { if (current()) emit({ error }); },
          onInterrupted: next => { if (current()) interrupted(next); },
          canReconcile: () => current() && driver === active && visible(),
        });
        driver = active;
        emit({ job: decorate(job) });
        void active.run().finally(() => {
          if (driver === active) driver = null;
          // A completed or paused invocation can have saved comparison coverage
          // after the last dashboard read. Publish that final evidence promptly.
          if (current()) emit({ savedDataChanged: true });
        });
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
    storageMaintenance: {
      async get(signal) {
        const requestGeneration = generation;
        const result = readStorageStatus(await transport.call('getStorageStatus', { progress: true, growth: true }, signal));
        if (generation !== requestGeneration) throw new Error('This account changed. Reload saved data before continuing.');
        if (publicMode && result.scope !== 'account') throw new Error('Storage status could not be confirmed.');
        return result;
      },
      async step(manual = false) {
        const requestGeneration = generation;
        const result = readStorageStatus(await transport.call('stepStorageMaintenance', { manual, progress: true, growth: true }));
        if (generation !== requestGeneration) throw new Error('This account changed. Reload saved data before continuing.');
        if (publicMode && result.scope !== 'account') throw new Error('Storage status could not be confirmed.');
        return result;
      },
    },
    marketappSettings: {
      async get(signal) { return publicMarketappSettings(await transport.call('getMarketappSettings', {}, signal)); },
      async save(apiKey) {
        if (!validPublicApiKey(apiKey)) throw new Error('Paste your Marketapp API key without spaces.');
        const status = publicMarketappSettings(await transport.call('saveMarketappApiKey', { api_key: apiKey }));
        generation += 1; clearJobViews(); driver?.interrupt(); emit({ savedDataChanged: true }); return status;
      },
      async remove() {
        const status = publicMarketappSettings(await transport.call('removeMarketappApiKey', {}));
        generation += 1; clearJobViews(); driver?.interrupt(); emit({ savedDataChanged: true }); return status;
      },
    },
    publicAccount: {
      async get(signal) {
        const account = readPublicAccount(await transport.call('getPublicAccount', {}, signal));
        return acceptAccount(account);
      },
      async saveKey(apiKey, signal) {
        if (!validPublicApiKey(apiKey)) throw new Error('The API key format could not be accepted.');
        const account = readPublicAccount(await transport.call('saveMarketappApiKey', { api_key: apiKey }, signal));
        emit({ savedDataChanged: true }); return acceptAccount(account);
      },
      async removeKey(signal) {
        const account = readPublicAccount(await transport.call('removeMarketappApiKey', {}, signal));
        emit({ savedDataChanged: true }); return acceptAccount(account);
      },
      async testKey(signal) { return readPublicApiKeyCheck(await transport.call('testMarketappApiKey', {}, signal)); },
      startWallet(signal) { return transport.call<PublicWalletChallenge>('startWalletVerification', {}, signal); },
      async finishWallet(attempt_id, account, proof, signal) {
        const next = readPublicAccount(await transport.call('finishWalletVerification', { attempt_id,
          account: { address: account.address, chain: account.chain, walletStateInit: account.walletStateInit,
            ...(account.publicKey ? { publicKey: account.publicKey } : {}) },
          proof: { timestamp: proof.timestamp, domain: { lengthBytes: proof.domain.lengthBytes, value: proof.domain.value }, payload: proof.payload, signature: proof.signature },
        }, signal));
        emit({ savedDataChanged: true }); return acceptAccount(next);
      },
      async disconnectWallet(signal) {
        generation += 1; clearJobViews(); driver?.interrupt();
        const account = readPublicAccount(await transport.call('disconnectPublicWallet', {}, signal));
        emit({ savedDataChanged: true }); return acceptAccount(account);
      },
      async deleteAccount(signal) {
        generation += 1; clearJobViews(); driver?.interrupt();
        const account = readPublicAccount(await transport.call('deletePublicAccount', { confirm: true }, signal));
        emit({ savedDataChanged: true }); return acceptAccount(account);
      },
      async reactivate(signal) {
        const account = readPublicAccount(await transport.call('reactivatePublicAccount', { confirm: true }, signal));
        emit({ savedDataChanged: true }); return acceptAccount(account);
      },
      startDiscovery() {
        if (!publicMode) return Promise.reject(new Error('Public accounts are not enabled in this app.'));
        return launch('startJob', accountInput({ kind: 'discover' }, accountGeneration));
      },
      resumeDiscovery(id, savedGeneration) { return launch('resumeJob', accountInput({ job_id: id }, savedGeneration)); },
    },
    marketappLoginTest: {
      start(signal) { return transport.call<MarketappLoginChallenge>('startMarketappLoginTest', {}, signal); },
      finish(attempt_id, account, proof, signal) { return transport.call<MarketappLoginTestResult>('finishMarketappLoginTest', { attempt_id, account, proof }, signal); },
      async cancel(attempt_id, signal) { await transport.call('cancelMarketappLoginTest', { attempt_id }, signal); },
    },
    marketappAnalyticsRefresh: {
      getStatus(signal) { return transport.call<MarketappAnalyticsRefreshStatus>('getMarketappAnalyticsRefreshStatus', {}, signal); },
      refreshStartup(period_days, signal) { return transport.call<MarketappAnalyticsStartupResult>('refreshStartupMarketappAnalytics', { period_days }, signal); },
      start(period_days, signal, rememberLogin = false) { return transport.call<MarketappAnalyticsRefreshChallenge>('startMarketappAnalyticsRefresh', { period_days, ...(rememberLogin ? { remember_login: true } : {}) }, signal); },
      refreshSaved(period_days, signal) { return transport.call<MarketappAnalyticsRefreshResult>('refreshSavedMarketappAnalytics', { period_days }, signal); },
      disconnectSession(signal) { return transport.call<{ disconnected: true }>('disconnectMarketappAnalyticsSession', {}, signal); },
      finish(challenge, account, proof, device, signal) {
        return transport.call<MarketappAnalyticsRefreshResult>('finishMarketappAnalyticsRefresh', {
          attempt_id: challenge.attempt_id, session_envelope: challenge.session_envelope,
          account: { address: account.address, chain: account.chain, walletStateInit: account.walletStateInit, ...(account.publicKey ? { publicKey: account.publicKey } : {}) },
          device: { platform: device.platform, appName: device.appName, appVersion: device.appVersion, maxProtocolVersion: device.maxProtocolVersion, features: device.features },
          proof: { timestamp: proof.timestamp, domain: { lengthBytes: proof.domain.lengthBytes, value: proof.domain.value }, payload: proof.payload, signature: proof.signature },
        }, signal);
      },
      async cancel(attempt_id, signal) { await transport.call('cancelMarketappAnalyticsRefresh', { attempt_id }, signal); },
    },
    async startupComparisonRefresh(selection, signal) {
      if (signal?.aborted) throw new DOMException('Refresh cancelled', 'AbortError');
      if (launching || (driver && !driver.interrupted)) return { state: 'busy', reason: 'active_job' };
      pricingQuery(selection);
      if (selection.source === 'rentals') {
        const error = historyCollectionError(selection); if (error) return { state: 'unavailable', reason: 'failed' };
      }
      launching = true;
      const requestGeneration = generation, savedScope = comparisonScope;
      const kind = selection.source === 'rentals' ? 'rental_prices' : 'prices';
      const input = accountInput({ kind, timeframe: selection.timeframe,
        ...(selection.timeframe === 'custom' ? { date_from: selection.dateFrom, date_to: selection.dateTo } : {}),
      }, accountGeneration);
      try {
        // Do not cancel a mutation in flight: its result must remain observable.
        const response = readComparisonStartupResult(await transport.call<ComparisonStartupResult>('refreshStartupComparisons', input));
        if (generation !== requestGeneration || comparisonScope !== savedScope) throw new Error('This account changed. Reload saved data before continuing.');
        if (response.state !== 'started') return response;
        const job = response.job!;
        if (job.kind !== kind || (publicMode && (job.account_generation !== input.account_generation || job.account_generation !== accountGeneration)))
          throw new Error('This account changed. Reload saved data before continuing.');
        if (signal?.aborted) {
          const paused = { ...job, progress: { ...job.progress, requires_resume: true } };
          emit({ job: paused });
          // Read durable progress once, without repeating the startup mutation.
          try { const { jobs } = await transport.call<{ jobs: Job[] }>('getJobs');
            if (generation === requestGeneration && comparisonScope === savedScope)
              for (const saved of jobs) emit({ job: decorate(readJob({ job: saved })) });
          } catch { /* The normal saved-data read remains available. */ }
          return { ...response, job: paused };
        }
        const current = () => generation === requestGeneration && comparisonScope === savedScope;
        driver?.interrupt();
        interruptedJobs.delete(jobIdentity(job));
        const active: CloudCollectionDriver = new CloudCollectionDriver(job, {
          transport, maxCalls: 25, maxDurationMs: 60000, boundAction: 'interrupt',
          onJob: next => { if (current()) emit({ job: decorate(next) }); },
          // Automatic limits/errors preserve saved data without a generic error banner.
          onError: () => {},
          onInterrupted: next => { if (current()) interrupted(next); },
          canReconcile: () => current() && driver === active && visible(),
        });
        const interrupt = () => active.interrupt();
        signal?.addEventListener('abort', interrupt, { once: true });
        driver = active; startupDriver = active;
        emit({ job: decorate(job) });
        void active.run().finally(() => {
          signal?.removeEventListener('abort', interrupt);
          if (driver === active) driver = null;
          if (startupDriver === active) startupDriver = null;
          if (current()) emit({ savedDataChanged: true });
        });
        return { ...response, job: decorate(job) };
      } catch (error) {
        // Reconcile an uncertain mutation once; startup never retries it.
        if (generation === requestGeneration && comparisonScope === savedScope) {
          try { const { jobs } = await transport.call<{ jobs: Job[] }>('getJobs');
            if (generation === requestGeneration && comparisonScope === savedScope)
              for (const job of jobs) emit({ job: decorate(readJob({ job })) });
          } catch { /* Saved data stays visible. */ }
        }
        throw error;
      } finally { launching = false; }
    },
    ownedPriceTransport: {
      portfolioRefresh: true,
      async call<T>(endpoint: OwnedPriceEndpoint, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
        const requestGeneration = generation;
        const mutation = endpoint !== 'getOwnedPriceRefresh' && endpoint !== 'getGiftRefresh';
        const savedGeneration = endpoint === 'startOwnedPriceRefresh' || endpoint === 'startGiftRefresh' ? accountGeneration : input.account_generation as number | undefined;
        const sent = mutation ? accountInput(input, savedGeneration) : input;
        let result: T;
        try { result = await transport.call<T>(endpoint, sent, signal); }
        catch (error) {
          if (generation !== requestGeneration) throw new Error('This account changed. Reload saved data before continuing.');
          throw error;
        }
        if (generation !== requestGeneration) throw new Error('This account changed. Reload saved data before continuing.');
        const run = (result as { run?: { account_generation?: number } } | null)?.run;
        if (publicMode && run && (run.account_generation !== accountGeneration || (mutation && run.account_generation !== sent.account_generation)))
          throw new Error('This account changed. Reload saved data before continuing.');
        return result;
      },
    },
    personalAnalytics: {
      async importSnapshot(raw, _csrf) {
        if (new TextEncoder().encode(raw).length > 262144) throw new Error('The analytics snapshot exceeds 256 KiB.');
        const response = await transport.call<{ personal_analytics: PersonalRentalAnalytics }>('importPersonalAnalytics', { snapshot: raw });
        if (!response.personal_analytics || response.personal_analytics.version !== 1 || !Array.isArray(response.personal_analytics.daily)) throw new Error('The server returned an unexpected analytics snapshot. Reload saved data.');
        emit({ savedDataChanged: true });
        return response.personal_analytics;
      },
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    savedDataChanged() { emit({ savedDataChanged: true }); },
    interrupt() { driver?.interrupt(); generation += 1; },
    async getDashboard(selection, signal) {
      const response = await transport.call<Dashboard & { encoding?: string }>('getDashboard', {
        ...selectionInput(selection), response_format: DASHBOARD_WIRE_FORMAT,
      }, signal);
      let data: Dashboard;
      try { data = response.encoding === DASHBOARD_WIRE_FORMAT ? decodeDashboardWire(response) as Dashboard : response; }
      catch { throw new Error('The server returned an unexpected dashboard. Reload saved data.'); }
      if (!data || typeof data !== 'object' || !Array.isArray(data.gifts) || !data.summary || !data.capabilities || !data.gifts.every(gift => gift && typeof gift.id === 'string' && Array.isArray(gift.uncertainties)))
        throw new Error('The server returned an unexpected dashboard. Reload saved data.');
      publicMode = data.capabilities.public_account === true;
      if (publicMode) observeAccount(data.capabilities.account_generation);
      const nextScope = `${canonicalMainnetAddress(data.wallet) ?? data.wallet ?? ''}:${publicMode}:${accountGeneration ?? ''}`;
      if (comparisonScope !== nextScope) clearJobViews();
      if (comparisonScope !== undefined && comparisonScope !== nextScope) { generation += 1; startupDriver?.interrupt(); }
      comparisonScope = nextScope;
      if (!signal?.aborted) options.onDashboardLoaded?.(data);
      return { ...data, capabilities: { ...data.capabilities, hosting: 'serverless',
        supported_jobs: publicMode ? [...CLOUD_JOB_KINDS, 'discover'] : CLOUD_JOB_KINDS } };
    },
    async getUpdateToken(signal) {
      const response = await transport.call<{ token: string }>('getDashboardRevision', {}, signal);
      if (typeof response.token !== 'string' || !response.token || response.token.length > 1024)
        throw new Error('The server returned an unexpected dashboard revision. Reload saved data.');
      return response.token;
    },
    async getJobs(signal) {
      const response = await transport.call<{ jobs: Job[] }>('getJobs', {}, signal);
      if (!Array.isArray(response.jobs)) throw new Error('The server returned an unexpected collection list. Reload saved data.');
      return response.jobs.map(job => decorate(readJob({ job })));
    },
    startJob(kind, _csrf, selection, options) {
      if (kind === 'discover' && publicMode) return launch('startJob', accountInput({ kind: 'discover' }, accountGeneration));
      if (!CLOUD_JOB_KINDS.includes(kind)) return Promise.reject(new Error('Wallet discovery and ownership refresh are not available in Telegram yet.'));
      const chosen = selection ?? { source: 'listings', timeframe: '30d' };
      if (options?.forceRefresh !== undefined && typeof options.forceRefresh !== 'boolean') return Promise.reject(new Error('Force refresh must be enabled or disabled.'));
      pricingQuery(chosen);
      if (kind !== 'prices') { const error = historyCollectionError(chosen); if (error) return Promise.reject(new Error(error)); }
      return launch('startJob', accountInput({ kind, timeframe: chosen.timeframe,
        ...(options?.forceRefresh === true ? { force_refresh: true } : {}),
        ...(chosen.timeframe === 'custom' ? { date_from: chosen.dateFrom, date_to: chosen.dateTo } : {}),
      }, accountGeneration));
    },
    resumeJob(id, _csrf, savedGeneration) { return launch('resumeJob', accountInput({ job_id: id }, savedGeneration)); },
    async stopJob(id, _csrf, savedGeneration) {
      const expectedGeneration = savedGeneration;
      if (driver?.jobId === id && driver.accountGeneration === expectedGeneration) return driver.stop();
      const job = readJob(await transport.call<{ job: Job }>('stopJob', accountInput({ job_id: id }, expectedGeneration)));
      if (publicMode && job.account_generation !== expectedGeneration) throw new Error('This account changed. Reload saved data before continuing.');
      const current = decorate(job); emit({ job: current }); return current;
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
