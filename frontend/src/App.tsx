import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from './Icons';
import type { Dashboard, DashboardAdapter, DataRecord, Gift, Job, JobKind, JobStartOptions, PersonalRentalAnalyticsAllTime, PricingSelection } from './data/types';
import { dateTime, formatAmount, giftGroup, humanize, isActiveJob, relativeTime, safeExternalUrl, shorten } from './data/helpers';
import { filterInventoryGifts, latestEvidenceAt } from './data/inventory';
import { sortInventoryGifts, type InventorySort } from './data/inventorySort';
import { parseInventorySortPreference } from './data/inventorySortPreference';
import type { InventoryScope } from './data/inventory';
import type { GiftFilter, PricingFilters } from './data/helpers';
import { telegramBridge } from './data/telegram';
import { PricingControls, PricingDetails, PricingPage } from './Pricing';
import { DEFAULT_PRICING, historyCollectionError, pricingQuery, timeframeLabel } from './data/pricingSelection';
import { createDashboardPoller } from './data/dashboardPolling';
import { useProgressiveList } from './useProgressiveList';
import { ListFooter } from './ListFooter';
import { RentalCount, RentalHistoryDetails } from './RentalCount';
import { useOwnedPriceRefresh } from './useOwnedPriceRefresh';
import { useAnalyticsStartupRefresh } from './useAnalyticsStartupRefresh';
import { useComparisonStartupRefresh } from './useComparisonStartupRefresh';
import type { AnalyticsStartupSnapshot } from './serverless/analyticsStartup';
import type { AnalyticsReportSelection } from './data/analyticsReports';
import { publicAccountSettingsScope } from './serverless/publicAccount';
import { OwnedPriceStatus } from './OwnedPriceStatus';
import { GiftPriceRefreshButton } from './GiftPriceRefreshButton';
import { GiftImage } from './GiftImage';
import { QuickPriceActions } from './QuickPriceActions';
import { GiftPriceCheck } from './GiftPriceCheck';
import { savedGiftRefreshEnabled, type OwnedPriceRefreshDriver, type OwnedPriceSnapshot } from './data/ownedPriceRefresh';
import { giftSelectionContext, selectedDashboardGift } from './data/giftSelection';
import type { GiftSelection } from './data/giftSelection';
import { MarketappSettings } from './MarketappSettings';
import { deferredView } from './DeferredView';
import { localCollectionBlocker } from './data/marketappSettings';
import { canCollectComparisons, publicComparisonBlocker } from './data/comparisonAccess';
import type { ComparisonCollectionBlocker as CollectionBlocker } from './data/comparisonAccess';
import { SyncProgress } from './SyncProgress';
import { availableAgainMessage, compactJobMessage, marketappAvailableAt, presentJobSync } from './data/syncPresentation';
import { efficientRefreshSelection, presentCollectionEfficiency, presentResumeSupport, visibleDashboardJobs } from './data/collectionEfficiency';
import { activityJobGroups } from './data/activityHistory';
import { activityFreshnessRows, type ActivityFreshnessRow } from './data/activityFreshness';
import { activityComparisonActionLabel, activityComparisonRequestBlocker, activityComparisonResumeAvailability, resumableActivityComparisonJob } from './data/activityFreshnessActions';
import { comparisonActionFeedback, comparisonAllowanceFeedback, currentComparisonActionFeedback, type ComparisonActionState } from './data/activityComparisonFeedback';
import { useStorageMaintenance } from './useStorageMaintenance';
import { PullToRefresh } from './PullToRefresh';
import './interface.css';
import './activityConnections.css';

type Page = 'pricing' | 'overview' | 'gifts' | 'activity';
const noGiftRefresh: OwnedPriceSnapshot = { phase: 'idle', run: null, canStop: false, canRefresh: false };
const noGiftRefreshSubscription = () => () => {};
const noGiftRefreshSnapshot = () => noGiftRefresh;
const NAV: { id: Page; label: string; icon: 'overview' | 'gift' | 'pricing' | 'activity' }[] = [
  { id: 'pricing', label: 'Pricing', icon: 'pricing' },
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'gifts', label: 'My gifts', icon: 'gift' },
  { id: 'activity', label: 'Status', icon: 'activity' },
];
const FILTERS: { id: GiftFilter; label: string }[] = [
  { id: 'all', label: 'All gifts' }, { id: 'available', label: 'Available' }, { id: 'for_rent', label: 'Marketapp listings' },
  { id: 'rented', label: 'Rented' }, { id: 'direct', label: 'In wallet' },
  { id: 'idle', label: 'Idle contracts' }, { id: 'sale', label: 'For sale' }, { id: 'review', label: 'Needs review' },
];
const INVENTORY_SORTS: {value: InventorySort; label: string}[] = [
  { value: 'last_rented', label: 'Last rented · newest first' },
  { value: 'default', label: 'Original order' },
  { value: 'name_asc', label: 'Name · A–Z' },
  { value: 'price_desc', label: 'Price · highest first' },
  { value: 'price_asc', label: 'Price · lowest first' },
  { value: 'rental_ending', label: 'Rental ending · soonest first' },
];
const JOB_LABEL: Record<JobKind, string> = { refresh: 'Refresh gift status', discover: 'Discover wallet gifts', collect: 'Collect market listings', prices: 'Collect comparison prices', rental_prices: 'Collect actual rental prices' };
const PAGE_SIZE = 20;
const PublicAccountSetup = lazy(() => import('./serverless/PublicAccountSetup').then(module => ({default:module.PublicAccountSetup})));
const MarketappConnection = lazy(() => import('./serverless/MarketappAnalyticsRefresh'));
const PersonalAnalytics = deferredView(() => import('./PersonalAnalytics').then(module => ({ default: module.PersonalAnalytics })), 'analytics');
const GiftAllTimeAnalytics = deferredView(() => import('./GiftAllTimeAnalytics').then(module => ({ default: module.GiftAllTimeAnalytics })), 'rental statistics');
const GiftPriceTracking = deferredView(() => import('./PriceTracking').then(module => ({ default: module.GiftPriceTracking })), 'price history');
const PriceChangeOverview = deferredView(() => import('./PriceTracking').then(module => ({ default: module.PriceChangeOverview })), 'price changes');
const InventoryGrid = deferredView(() => import('./InventoryGrid').then(module => ({ default: module.InventoryGrid })), 'gifts');
const ActivityDataStatus = deferredView(() => import('./ActivityDataStatus').then(module => ({ default: module.ActivityDataStatus })), 'data status');
const StorageStatusCard = deferredView(() => import('./StorageStatus').then(module => ({ default: module.StorageStatusCard })), 'storage status');

function GiftDisplayControl({ view, onChange, label }: {
  view: 'grid' | 'detailed'; onChange: (view: 'grid' | 'detailed') => void; label: string;
}) {
  return <div className="pricing-view-toggle" role="group" aria-label={label}>
    <button type="button" className={view === 'grid' ? 'active' : ''} aria-pressed={view === 'grid'} onClick={() => onChange('grid')}><Icon name="overview" size={15} />Simple</button>
    <button type="button" className={view === 'detailed' ? 'active' : ''} aria-pressed={view === 'detailed'} onClick={() => onChange('detailed')}><Icon name="layers" size={15} />Detailed</button>
  </div>;
}

function useDashboard(adapter: DashboardAdapter, selection: PricingSelection) {
  const query = pricingQuery(selection);
  const activeQuery = useRef(query);
  activeQuery.current = query;
  const [snapshot, setSnapshot] = useState<{ data: Dashboard; query: string } | null>(null);
  const data = snapshot?.query === query ? snapshot.data : null;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const readError = useRef<string | null>(null);
  const getReadError = useCallback(() => readError.current, []);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [analyticsRead, setAnalyticsRead] = useState<{ query: string; scope: string | null; startedAt: string } | null>(null);
  const dashboardScope = useRef<string | null>(null);
  if (data) dashboardScope.current = giftSelectionContext(data);
  const session = useRef<{ query: string; poller: ReturnType<typeof createDashboardPoller> } | null>(null);
  // Query identity, rather than a newly allocated selection object, owns the
  // session. Jobs can finish after a selection change: their old callback is inert.
  const requestedSelection = useRef(selection);
  requestedSelection.current = selection;
  const reload = useCallback(async () => {
    if (activeQuery.current === query && session.current?.query === query) await session.current.poller.reload();
  }, [query]);
  const reloadGiftData = useCallback(async () => {
    if (activeQuery.current === query && session.current?.query === query) await session.current.poller.reloadDashboard();
  }, [query]);
  const reloadAnalytics = useCallback(async () => {
    const owner = session.current;
    if (activeQuery.current !== query || !owner || owner.query !== query)
      throw new Error('The dashboard changed before saved data could reload.');
    const scope = dashboardScope.current, startedAt = new Date().toISOString();
    await owner.poller.reloadDashboardChecked();
    if (activeQuery.current !== query || session.current !== owner || dashboardScope.current !== scope)
      throw new Error('The dashboard changed before saved data could reload.');
    setAnalyticsRead({ query, scope, startedAt });
  }, [query]);
  useEffect(() => {
    setLoading(true); setError(null); readError.current = null;
    const poller = createDashboardPoller(adapter, requestedSelection.current, {
      dashboard(dashboard) {
        if (activeQuery.current !== query) return;
        setSnapshot({ data: dashboard, query }); setLoadedAt(new Date().toISOString());
      },
      jobs(currentJobs) { if (activeQuery.current === query) setJobs(currentJobs); },
      loading(pending) { if (activeQuery.current === query) setLoading(pending); },
      error(problem) { if (activeQuery.current === query) { readError.current = problem; setError(problem); } },
    });
    session.current = { query, poller };
    void poller.reload();
    return () => {
      poller.dispose();
      if (session.current?.poller === poller) session.current = null;
    };
  }, [adapter, query]);
  const updateJob = useCallback((changed: Job) => {
    setJobs(current => current.some(job => job.id === changed.id)
      ? current.map(job => job.id === changed.id ? changed : job) : [...current, changed]);
  }, []);
  const analyticsReloadedAt = data && analyticsRead?.query === query && analyticsRead.scope === giftSelectionContext(data)
    ? analyticsRead.startedAt : null;
  return { data, jobs, loading: loading || (!data && !error), error, loadedAt, analyticsReloadedAt, reload, reloadGiftData, reloadAnalytics, getReadError, updateJob };
}

function StateBadge({ gift }: { gift: Gift }) {
  return <span className={`state-badge ${giftGroup(gift)}`}><i />{gift.display_state || humanize(gift.ui_state || gift.state)}</span>;
}

function Price({ gift }: { gift: Gift }) {
  return <span className="price">{formatAmount(gift.price_per_day)}{gift.price_per_day != null && <span>{gift.price_unit || 'GRAM'}<small>/ day</small></span>}</span>;
}

function Empty({ title, children, icon = 'gift' }: { title: string; children: React.ReactNode; icon?: 'gift' | 'search' | 'activity' | 'alert' }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={30} /></span><h3>{title}</h3><p>{children}</p></div>;
}

function JobCard({ job, onResume, onEfficient, disabled, onStop, stopping, stopDisabled, blocker, onSetup }: {
  job: Job; onResume: (job: Job) => void; disabled: boolean;
  onEfficient: (job: Job) => void;
  onStop: (job: Job) => void; stopping: boolean; stopDisabled: boolean;
  blocker?: CollectionBlocker | null; onSetup?: () => void;
}) {
  const requiresResume = job.progress?.requires_resume === true;
  const pausedBlocker = job.state === 'partial' || requiresResume ? blocker : null;
  const active = isActiveJob(job) && !requiresResume;
  const isStopping = active && (stopping || job.stop_requested);
  const window = job.collection_window;
  const windowLabel = window ? timeframeLabel({ source: job.kind === 'rental_prices' ? 'rentals' : 'listings', timeframe: window.timeframe, dateFrom: window.date_from || undefined, dateTo: window.date_to || undefined }) : undefined;
  const view = presentJobSync(job, { stopping: isStopping, timeframeLabel: windowLabel });
  const budget = job.progress?.marketapp_budget as { invocation_used: number; invocation_limit: number; rolling_24h_used: number; rolling_24h_limit: number } | undefined;
  const history = job.progress?.history_refresh;
  const listing = job.progress?.listing_refresh;
  const cache = job.progress?.market_cache;
  const efficiency = presentCollectionEfficiency(job);
  const resume = presentResumeSupport(job);
  const resumeMessage = resume.blocked && job.state !== 'complete' ? resume.message : null;
  const metrics = [['pages', 'Pages read'], ['observations', 'Records saved'], ['streams_complete', 'Checks completed'], ['streams_total', 'Checks planned']] as const;
  return <article className={`job-card sync-card job-${job.state} sync-${view.state}`} aria-label={view.title}>
    <div className="sync-card-header">
      <span className={`job-symbol ${active && !isStopping && view.state !== 'waiting' ? 'spinning' : ''}`} aria-hidden="true"><Icon name={view.state === 'complete' ? 'check' : view.state === 'failed' ? 'alert' : active && !isStopping && view.state !== 'waiting' ? 'refresh' : 'clock'} /></span>
      <strong>{view.title}</strong><span className="sync-state">{view.stateLabel}</span>
    </div>
    <SyncProgress progress={view.progress} moving={active && !isStopping && view.state !== 'waiting'} />
    <p className={`sync-message${pausedBlocker ? ' sync-setup-blocker' : ''}`} role="status">{resumeMessage || pausedBlocker?.message || compactJobMessage(job, view)}</p>
    {resumeMessage && pausedBlocker && <p className="sync-message sync-setup-blocker">{pausedBlocker.message}</p>}
    {pausedBlocker?.setup && onSetup && <button className="button small secondary sync-setup-action" onClick={onSetup}>{pausedBlocker.actionLabel || 'Open API key setup'}<Icon name="shield" size={15} /></button>}
    {view.cacheNote && <p className="sync-cache-note">Cached comparisons · {cache?.oldest_observed_at ? <>oldest data {relativeTime(cache.oldest_observed_at)}</> : 'observation time unavailable'}</p>}
    {!resume.blocked && efficiency.warning && <p className="sync-efficiency-warning">Older scan · a faster refresh is available.</p>}
    <div className="sync-card-footer">
      <details className="sync-details"><summary>Details</summary><div>
        <p>{view.objective} {resumeMessage || pausedBlocker?.message || view.message}</p>
        {efficiency.sampled && <p>{efficiency.sampled}</p>}
        {view.cacheNote && <p>{view.cacheNote}</p>}
        {!resume.blocked && efficiency.warning && <p>{efficiency.warning}</p>}
        <p>Progress counts finished comparison checks, collections or gift checks. It does not estimate time remaining.</p>
        {window && !resume.blocked && <p>Selected period: {windowLabel}.{window.window_from && <> From {dateTime(window.window_from)}{window.window_to ? ` to ${dateTime(window.window_to)}` : ''}.</>} Continue keeps this period.</p>}
        {budget && <div className="job-metrics"><span>Requests this session <b>{budget.invocation_used} / {budget.invocation_limit}</b></span><span>Last 24 hours <b>{budget.rolling_24h_used} / {budget.rolling_24h_limit}</b></span></div>}
        {view.availableAt && <p>The time shown is when enough requests leave the rolling 24-hour window to continue. It assumes no additional requests. Continue starts a new batch; nothing starts automatically.</p>}
        <div className="job-metrics">{metrics.map(([key, label]) => typeof job.progress?.[key] === 'number' ? <span key={key}>{label} <b>{String(job.progress[key])}</b></span> : null)}</div>
        {history && <p>History: {history.incremental_streams} incremental and {history.full_streams} full-window plans. Incremental checks reread {history.overlap_seconds / 3600} hours of overlap.</p>}
        {listing && listing.reused_streams > 0 && <p>{listing.reused_streams} listing groups use completed broader scans.</p>}
        {cache && cache.reused_streams > 0 && <p>{cache.reused_streams} scans use the Telegram cache, without new comparison requests.{cache.oldest_observed_at && <> Original observations from {dateTime(cache.oldest_observed_at)}.</>}</p>}
        {efficiency.pageSize && <p>Items per request: {efficiency.pageSize}. {job.progress.efficiency?.scheduling === 'round_robin' ? 'Collections are visited in turns so each can receive a first sample before deeper pages.' : 'This saved scan finishes one stream before moving to the next.'}</p>}
        {efficiency.legacy && !resume.blocked && <p>An efficient refresh creates a new scan using {efficiency.recommendedPageSize} items per request and the same period. Relative periods start from now; custom dates stay fixed. Existing records and the older scan are kept. No saved cursor is changed.</p>}
        {view.rawReason && <p>Saved status: {view.rawReason}</p>}
        <time dateTime={job.updated_at}>Updated {dateTime(job.updated_at, true)}{job.run_id != null ? ` · Run ${job.run_id}` : ''}</time>
        {!resume.blocked && efficiency.legacy && (job.state === 'partial' || requiresResume) && <button className="button small secondary" disabled={disabled} onClick={() => onResume(job)}>Continue older scan<Icon name="arrow" size={15} /></button>}
      </div></details>
      <div className="sync-actions">
        {resume.actionLabel && <button className="button small primary" disabled={disabled || !resume.canStart} onClick={() => onEfficient(job)}>{resume.actionLabel}<Icon name="refresh" size={15} /></button>}
        {!resume.blocked && efficiency.legacy && <button className="button small primary" disabled={disabled || !efficiency.canStart} onClick={() => onEfficient(job)}>Start efficient refresh<Icon name="refresh" size={15} /></button>}
        {!resume.blocked && !efficiency.legacy && (job.state === 'partial' || requiresResume) && <button className="button small secondary" disabled={disabled} onClick={() => onResume(job)}>{view.actionLabel || 'Continue'}<Icon name="arrow" size={15} /></button>}
        {isActiveJob(job) && <button className="button small secondary" disabled={stopDisabled || isStopping} onClick={() => onStop(job)} aria-label={`Stop ${JOB_LABEL[job.kind] || humanize(job.kind)}`}>{isStopping ? 'Stopping…' : 'Stop'}</button>}
      </div>
    </div>
  </article>;
}

function GiftTable({ gifts, onSelect, quickActions = false }: { gifts: Gift[]; onSelect: (gift: Gift) => void; quickActions?: boolean }) {
  return <div className="table-scroll"><table className="gift-table inventory-table"><thead><tr><th>Gift</th><th>Saved status</th><th>Daily price</th><th>Observed</th><th><span className="sr-only">Details</span></th></tr></thead>
    <tbody>{gifts.map(gift => <tr key={gift.id}><td><button className="gift-name-button" onClick={() => onSelect(gift)}><GiftImage gift={gift} /><span><strong>{gift.name || 'Unnamed gift'}</strong><small>{gift.collection_name || shorten(gift.collection_address)}{!gift.is_portfolio && <span className="candidate-label"> · Candidate</span>}</small><RentalCount gift={gift} /></span></button></td>
      <td><StateBadge gift={gift} /></td><td><Price gift={gift} />{gift.price_is_historical && <small className="saved-price-label">Saved price</small>}</td>
      <td><span className="observation" title={dateTime(gift.status_observed_at ?? gift.observed_at)}>{relativeTime(gift.status_observed_at ?? gift.observed_at)}</span></td><td><div className="gift-row-actions"><QuickPriceActions gift={gift} enabled={quickActions} /><button className="icon-button" aria-label={`View ${gift.name || 'gift'} details`} onClick={() => onSelect(gift)}><Icon name="chevron" size={17} /></button></div></td>
    </tr>)}</tbody></table></div>;
}

function StatCard({ label, value, subtitle, icon, tone, onClick }: { label: string; value: number; subtitle: string; icon: 'gift' | 'arrow' | 'clock' | 'alert'; tone: string; onClick: () => void }) {
  return <button className={`stat-card ${tone}`} onClick={onClick}><div className="stat-heading"><span>{label}</span><Icon name={icon} size={19} /></div><strong>{value.toLocaleString()}</strong><div className="stat-foot"><span>{subtitle}</span><Icon name="arrow" size={15} /></div></button>;
}

function Coverage({ data }: { data: Dashboard }) {
  const coverage = data.coverage || {};
  const label = typeof coverage.note === 'string' ? coverage.note : typeof coverage.coverage_note === 'string' ? coverage.coverage_note : 'Each gift reflects its last saved observation. A completed scan is not an instantaneous market snapshot.';
  const facts = Object.entries(coverage).filter(([key, value]) => !['note', 'coverage_note'].includes(key) && (typeof value === 'number' || typeof value === 'boolean')).slice(0, 4);
  return <details className="coverage-disclosure"><summary>Coverage details</summary><div className="coverage-card"><p>{label}</p>{facts.length > 0 && <div className="coverage-facts">{facts.map(([key, value]) => <span key={key}>{humanize(key)} <b>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</b></span>)}</div>}</div></details>;
}

function CollectionLimits({ data, selection }: { data: Dashboard; selection: PricingSelection }) {
  const limits = data.capabilities.marketapp_limits;
  const availableAt = marketappAvailableAt(limits?.provider_allowance_blocked ? 1 : limits?.used_24h, limits?.provider_allowance_blocked ? 1 : limits?.rolling_24h_attempts, limits?.available_at);
  const historyError = selection.source === 'rentals' ? historyCollectionError(selection) : null;
  return <>
    {historyError && <div className="notice error" role="alert"><Icon name="alert" size={18} /><p>{historyError}</p></div>}
    {availableAt && <p className="sync-available-at" role="status">{availableAgainMessage(availableAt)}</p>}
    <details className="sync-limit-details"><summary>Update limits & details</summary><div>
      {limits && <p>{limits.remaining_24h} of {limits.rolling_24h_attempts} requests remain in the last 24 hours. Each start or continuation allows up to {limits.max_attempts} requests and {limits.run_seconds / 60} minutes, at {limits.requests_per_second} request/s. Retries count.</p>}
      {data.capabilities.public_account && <p>Requests are limited for your account and API key, and across the service. Another user may use part of the shared allowance.</p>}
      <p>{selection.source === 'rentals' ? `Checks actual rentals for ${timeframeLabel(selection).toLowerCase()}. Completed history is reused with a 48-hour overlap; a requested update after seven days rechecks the full period.` : 'Checks current asking prices. Past listing prices come from previously saved observations.'}</p>
      <p>Changing filters reads saved data. Continue keeps the original period. No prices are changed on Marketapp.</p>
      {data.capabilities.ownership_note && <p>{data.capabilities.ownership_note} Keep Telegram open while updating; Continue resumes saved progress.</p>}
    </div></details>
  </>;
}

function Overview({ data, adapter, reload, onFilter, onSelect, analyticsStartup, onAnalyticsBusy, initialAnalyticsDays }: { data: Dashboard; adapter: DashboardAdapter; reload: () => Promise<void>; onFilter: (filter: GiftFilter, scope?: InventoryScope) => void; onSelect: (gift: Gift) => void; analyticsStartup: AnalyticsStartupSnapshot; onAnalyticsBusy: (busy: boolean) => void; initialAnalyticsDays?: AnalyticsReportSelection }) {
  const summary = data.summary;
  const featured = [...data.gifts].filter(gift => gift.is_portfolio).sort((a, b) => (b.observed_at || '').localeCompare(a.observed_at || '')).slice(0, 4);
  const count = (filter: GiftFilter) => filterInventoryGifts(data.gifts, '', filter, '', 'portfolio').length;
  const groups = [
    { label: 'Marketapp listings', value: count('for_rent'), color: 'teal', filter: 'for_rent' as GiftFilter },
    { label: 'Rented', value: count('rented'), color: 'blue', filter: 'rented' as GiftFilter },
    { label: 'In wallet', value: count('direct'), color: 'violet', filter: 'direct' as GiftFilter },
    { label: 'Idle contracts', value: count('idle'), color: 'slate', filter: 'idle' as GiftFilter },
    { label: 'For sale', value: count('sale'), color: 'pink', filter: 'sale' as GiftFilter },
    { label: 'Needs review', value: count('review'), color: 'amber', filter: 'review' as GiftFilter },
  ].filter(group => group.value > 0);
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  const portfolioReview = data.gifts.filter(gift => gift.is_portfolio && giftGroup(gift) === 'review').length;
  const candidateReview = data.gifts.filter(gift => !gift.is_portfolio && giftGroup(gift) === 'review').length;
  return <>
    <PersonalAnalytics key={`${giftSelectionContext(data)}:${data.capabilities.wallet_configured}`} snapshot={data.personal_analytics} snapshots={data.personal_analytics_snapshots} allTime={data.personal_analytics_all_time} wallet={data.wallet} gifts={data.gifts} transport={adapter.personalAnalytics} csrf={data.capabilities.csrf_token} onImported={reload} cloud={adapter.mode === 'serverless'} marketappLoginTest={adapter.mode === 'serverless' && data.capabilities.marketapp_login_test ? adapter.marketappLoginTest : undefined} marketappAnalyticsRefresh={adapter.mode === 'serverless' && data.capabilities.marketapp_analytics_refresh ? adapter.marketappAnalyticsRefresh : undefined} analyticsStartup={analyticsStartup} onAnalyticsBusy={onAnalyticsBusy} initialPeriodDays={initialAnalyticsDays} />
    <section className="stats-grid" aria-label="Portfolio summary">
      <StatCard label="Your gifts" value={summary.portfolio_count} subtitle="Saved portfolio" icon="gift" tone="neutral" onClick={() => onFilter('all')} />
      <StatCard label="Available" value={count('available')} subtitle="Listings + verified idle contracts" icon="arrow" tone="teal" onClick={() => onFilter('available')} />
      <StatCard label="Rented" value={summary.rented_count} subtitle="Saved contract status" icon="clock" tone="blue" onClick={() => onFilter('rented')} />
      <StatCard label="Needs review" value={portfolioReview + candidateReview} subtitle={`${portfolioReview} gifts · ${candidateReview} candidates`} icon="alert" tone="amber" onClick={() => onFilter('review', 'all')} />
    </section>
    <PriceChangeOverview gifts={data.gifts} onSelect={onSelect} />
    <details className="portfolio-disclosure"><summary>Portfolio details</summary><div className="overview-columns"><section className="panel inventory-panel"><div className="section-heading"><h2>Recently checked</h2><button className="text-button" onClick={() => onFilter('all')}>View all <Icon name="arrow" size={17} /></button></div>
      {featured.length ? <div className="featured-grid">{featured.map(gift => <button className="featured-gift" key={gift.id} onClick={() => onSelect(gift)}><GiftImage gift={gift} large /><div className="featured-info"><strong>{gift.name || 'Unnamed gift'}</strong><StateBadge gift={gift} /></div></button>)}</div> : <Empty title="No gifts yet">{data.capabilities.hosting === 'serverless' ? data.capabilities.public_account ? 'Open Status to connect your wallet and find your gifts.' : 'Import a portfolio to add your gifts.' : 'Import a portfolio or discover your wallet to get started.'}</Empty>}
    </section><section className="panel distribution-panel"><div className="section-heading"><h2>Portfolio status</h2><Icon name="layers" size={20} /></div>
      <div className="distribution-bar" aria-label="Observed portfolio status distribution">{groups.map(group => <span className={group.color} key={group.label} style={{ flex: group.value }} title={`${group.label}: ${group.value}`} />)}{total === 0 && <span className="slate" style={{ flex: 1 }} />}</div>
      <div className="mix-legend">{groups.length ? groups.map(group => <button key={group.label} onClick={() => onFilter(group.filter)}><span><i className={group.color} />{group.label}</span><b>{group.value.toLocaleString()}</b></button>) : <p>No classified observations yet.</p>}</div>
      <p className="fine-print"><Icon name="clock" size={14} />States come from observations at different times.</p>
    </section></div></details>
    <Coverage data={data} />
  </>;
}

function Activity({ records, jobs, onResume, onEfficient, disabled, onStop, stoppingJobs, stopDisabled, blocker, onSetup, view, giftCheck }: {
  records: DataRecord[]; jobs: Job[]; onResume: (job: Job) => void; onEfficient: (job: Job) => void; disabled: boolean;
  onStop: (job: Job) => void; stoppingJobs: Set<number>; stopDisabled: boolean;
  blocker?: CollectionBlocker | null; onSetup?: () => void;
  view: 'progress' | 'history'; giftCheck?: ReactNode;
}) {
  const { current, previous } = activityJobGroups(jobs);
  const inProgress = (job: Job) => ['preparing', 'running', 'waiting', 'stopping'].includes(presentJobSync(job).state);
  const active = current.filter(inProgress);
  const history = [...current.filter(job => !inProgress(job)), ...previous];
  const renderJob = (job: Job) => <JobCard job={job} onResume={onResume} onEfficient={onEfficient} disabled={disabled} onStop={onStop} stopping={stoppingJobs.has(job.id)} stopDisabled={stopDisabled} blocker={blocker} onSetup={onSetup} />;
  if (view === 'progress') return active.length ? <section className="panel status-active-updates" aria-label="Updates in progress"><div className="jobs-list">{active.map(job => <div key={job.id}>{renderJob(job)}</div>)}</div></section> : null;
  if (!history.length && !records.length && !giftCheck) return null;
  return <details className="panel status-update-history"><summary>Update history<Icon name="clock" size={17} /></summary>
    {giftCheck}
    {history.length > 0 && <div className="jobs-list">{history.map(job => {
      const view = presentJobSync(job);
      return <details key={job.id} className={`completed-sync history-sync history-${view.state}`}><summary><Icon name={view.state === 'complete' ? 'check' : view.state === 'failed' ? 'alert' : 'clock'} size={17} /><strong>{view.title}</strong><span className="history-state">{view.stateLabel}</span><time dateTime={job.updated_at}>{dateTime(job.updated_at, true)}</time></summary>{renderJob(job)}</details>;
    })}</div>}
    {records.length > 0 && <details className="observations-disclosure"><summary>Recent observations <span>{records.length}</span></summary>
    <div className="activity-list">{records.slice(0, 30).map((record, index) => {
      const title = stringField(record, 'title', 'message', 'kind', 'type') || 'Observation recorded';
      const identity = stringField(record, 'name') || shorten(stringField(record, 'nft_address'), 10);
      const detail = stringField(record, 'description', 'detail') || (stringField(record, 'reason') ? humanize(stringField(record, 'reason')) : null);
      const time = stringField(record, 'observed_at', 'created_at', 'timestamp', 'at');
      return <article className="activity-item" key={String(record.id ?? index)}><span className="activity-dot" /><div><strong>{identity}</strong><p>{humanize(title)}{detail && detail !== title ? ` · ${detail}` : ''}</p><time title={dateTime(time)}>{dateTime(time, true)}</time></div></article>;
    })}</div>
    </details>}
  </details>;
}

function stringField(record: DataRecord, ...keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
  return null;
}

function GiftDetails({ gift, selection, close, allTime, wallet, quickActions = false, driver, onCheck, checkDisabledReason }: {
  gift: Gift; selection: PricingSelection; close: () => void; quickActions?: boolean;
  allTime?: PersonalRentalAnalyticsAllTime | null; wallet: string | null;
  driver?: OwnedPriceRefreshDriver | null; onCheck?: (nft: string) => Promise<void>; checkDisabledReason?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const dialog = ref.current, trigger = document.activeElement;
    dialog?.showModal();
    const removeBack = telegramBridge.back(close);
    return () => { removeBack(); dialog?.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, [close]);
  const explorer = safeExternalUrl(gift.explorer_url);
  return <dialog ref={ref} className="detail-dialog" onCancel={close} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }} aria-labelledby="gift-detail-title">
    <div className="drawer-content"><div className="drawer-top"><span>Gift details</span><button className="icon-button" autoFocus aria-label="Close gift details" onClick={close}><Icon name="close" /></button></div>
      <div className="detail-hero"><div className="detail-art"><GiftImage gift={gift} large /></div><div className="detail-title"><p>{gift.collection_name || 'Collection unresolved'}</p><h2 id="gift-detail-title">{gift.name || 'Unnamed gift'}</h2><StateBadge gift={gift} />{!gift.is_portfolio && <span className="candidate-label">Candidate · ownership unverified</span>}</div></div>
      <PricingDetails gift={gift} selection={selection} quickActions={quickActions} />
      {quickActions && gift.is_portfolio && gift.category !== 'unresolved' && <section className="detail-section gift-price-actions" aria-label="Quick price actions">
        <QuickPriceActions gift={gift} enabled labelled />
        {driver && onCheck && <GiftPriceCheck gift={gift} driver={driver} onCheck={onCheck} disabledReason={checkDisabledReason} />}
        <details className="detail-disclosure"><summary>How to change the price</summary><p>Tap the recommended price to copy it, open Marketapp, paste it into the gift’s price settings and confirm there. Return here and check this gift to read the configured contract price.</p><p>Checking does not confirm Marketapp listing visibility. For a rented gift, a new asking price does not change an existing rental payment.</p></details>
      </section>}
      <GiftAllTimeAnalytics gift={gift} report={allTime} wallet={wallet} />
      <RentalHistoryDetails gift={gift} />
      <GiftPriceTracking gift={gift} />
      <details className="detail-section detail-disclosure"><summary>Ownership evidence</summary><div className="proof-badges">{gift.proof_badges.length ? gift.proof_badges.map(badge => <span key={badge}><Icon name="shield" size={14} />{humanize(badge)}</span>) : <span><Icon name="layers" size={14} />{gift.is_portfolio ? 'Declared portfolio membership' : 'Unverified candidate'}</span>}</div>
        <dl><div><dt>Verification</dt><dd>{gift.verification_method ? humanize(gift.verification_method) : 'Not established'}</dd></div><div><dt>Membership source</dt><dd>{gift.membership_sources.map(humanize).join(', ') || 'Not established'}</dd></div><div><dt>TON observation</dt><dd>{dateTime(gift.observed_at)}</dd></div>{gift.status_observed_at && <div><dt>Rental status check</dt><dd>{dateTime(gift.status_observed_at)}{gift.status_is_historical ? " · current status unverified" : ""}</dd></div>}<div><dt>Market observation</dt><dd>{dateTime(gift.market_observed_at)}</dd></div><div><dt>Asking price observation</dt><dd>{dateTime(gift.price_observed_at)}{gift.price_is_historical ? " · saved historical price" : ""}</dd></div>{gift.rental_until != null && <div><dt>Rental expiry</dt><dd>{dateTime(gift.rental_until)}</dd></div>}{gift.reviewed_at && <div><dt>Local review</dt><dd>{dateTime(gift.reviewed_at)}{gift.review_stale ? ' · stale' : ''}</dd></div>}{gift.reason && <div><dt>Verification result</dt><dd>{humanize(gift.reason)}</dd></div>}</dl>
      </details>
      <details className="detail-section detail-disclosure"><summary>Addresses</summary><label className="address-label">NFT address</label><div className="address-box"><code>{gift.nft_address}</code><button className="icon-button" aria-label="Copy NFT address" onClick={() => { void navigator.clipboard?.writeText(gift.nft_address).then(() => setCopied(true)).catch(() => setCopied(false)); }}><Icon name={copied ? 'check' : 'copy'} size={17} /></button></div><span className="sr-only" aria-live="polite">{copied ? 'NFT address copied' : ''}</span><label className="address-label">Collection address</label><div className="address-box"><code>{gift.collection_address || 'Not established'}</code></div></details>
      {gift.uncertainties.length > 0 && <details className="uncertainty-box"><summary><Icon name="alert" size={16} />Uncertainty · {gift.uncertainties.length} {gift.uncertainties.length === 1 ? 'note' : 'notes'}</summary><ul>{gift.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      {explorer && <a className="button secondary external-link" href={explorer} target="_blank" rel="noopener noreferrer">Open in TON explorer<Icon name="external" size={16} /></a>}
    </div>
  </dialog>;
}

export default function App({ adapter, walletControl }: {
  adapter: DashboardAdapter;
  walletControl?: (dashboard: Dashboard | null, activityTarget: HTMLElement | null) => React.ReactNode;
}) {
  const cloud = adapter.mode === 'serverless';
  const viewPreferenceKey = `giftfolio.${cloud ? 'telegram' : 'local'}.pricing-view`;
  const [pricingView, setPricingView] = useState<'grid' | 'detailed'>(() => {
    try {
      const saved = localStorage.getItem(viewPreferenceKey);
      if (saved === 'grid' || saved === 'detailed') return saved;
    } catch { /* View selection still works when browser storage is unavailable. */ }
    return 'grid';
  });
  const changePricingView = (next: 'grid' | 'detailed') => {
    setPricingView(next);
    try { localStorage.setItem(viewPreferenceKey, next); } catch { /* Optional preference only. */ }
  };
  const inventoryViewPreferenceKey = `giftfolio.${cloud ? 'telegram' : 'local'}.inventory-view`;
  const [inventoryView, setInventoryView] = useState<'grid' | 'detailed'>(() => {
    try {
      const saved = localStorage.getItem(inventoryViewPreferenceKey);
      if (saved === 'grid' || saved === 'detailed') return saved;
    } catch { /* Display preferences are optional. */ }
    return 'grid';
  });
  const changeInventoryView = (next: 'grid' | 'detailed') => {
    setInventoryView(next);
    try { localStorage.setItem(inventoryViewPreferenceKey, next); } catch { /* Display preferences are optional. */ }
  };
  const inventorySortPreferenceKey = `giftfolio.${cloud ? 'telegram' : 'local'}.inventory-sort-v2`;
  const [inventorySort, setInventorySort] = useState<InventorySort>(() => {
    try {
      return parseInventorySortPreference(localStorage.getItem(inventorySortPreferenceKey));
    } catch { /* Sorting remains available without browser storage. */ }
    return 'last_rented';
  });
  const changeInventorySort = (next: InventorySort) => {
    if (!INVENTORY_SORTS.some(option => option.value === next)) return;
    setInventorySort(next);
    try { localStorage.setItem(inventorySortPreferenceKey, next); } catch { /* Optional preference only. */ }
  };
  const [pricingSelection, setPricingSelection] = useState<PricingSelection>(DEFAULT_PRICING);
  const [pricingFilters, setPricingFilters] = useState<PricingFilters>({ search: '', collection: '', filter: 'all', sort: 'increase' });
  const { data, jobs, loading, error, loadedAt, analyticsReloadedAt, reload, reloadGiftData, reloadAnalytics, getReadError, updateJob } = useDashboard(adapter, pricingSelection);
  const { driver: ownedPriceRefresh, refresh: refreshGiftPrices, refreshGift: refreshOneGift } = useOwnedPriceRefresh(adapter, data, reloadGiftData);
  const giftRefreshStatus = useSyncExternalStore(ownedPriceRefresh?.subscribe ?? noGiftRefreshSubscription,
    ownedPriceRefresh?.getSnapshot ?? noGiftRefreshSnapshot, noGiftRefreshSnapshot);
  const [analyticsManualBusy, setAnalyticsManualBusy] = useState(false);
  const analyticsStartup = useAnalyticsStartupRefresh(adapter, data?.startup_preview ? null : data, ownedPriceRefresh, reloadAnalytics, analyticsManualBusy);
  const [page, setPage] = useState<Page>('pricing');
  const [activityNow, setActivityNow] = useState(Date.now);
  useEffect(() => {
    if (page !== 'activity') return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (!document.hidden) {
        setActivityNow(Date.now());
        timer = setInterval(() => setActivityNow(Date.now()), 60000);
      }
    };
    visible(); document.addEventListener('visibilitychange', visible);
    return () => { if (timer !== undefined) clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [page]);
  const mainRef = useRef<HTMLElement>(null);
  const [inventoryScope, setInventoryScope] = useState<InventoryScope>('portfolio');
  const [selected, setSelected] = useState<GiftSelection | null>(null);
  const selectionContext = giftSelectionContext(data);
  const [analyticsTarget, setAnalyticsTarget] = useState<{ context: string; days: AnalyticsReportSelection } | null>(null);
  const selectGift = (gift: Gift) => setSelected({ id: gift.id, context: selectionContext });
  const selectedGift = selectedDashboardGift(data, selected);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<GiftFilter>('all');
  const [collection, setCollection] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [stoppingJobs, setStoppingJobs] = useState<Set<number>>(() => new Set());
  const stopRequests = useRef(new Set<number>());
  const [jobError, setJobError] = useState<string | null>(null);
  const [comparisonAction, setComparisonAction] = useState<ComparisonActionState | null>(null);
  const actionLaunching = useRef(false);
  const [syncMenu, setSyncMenu] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [publicAccountOpen, setPublicAccountOpen] = useState(false);
  const [activityWalletTarget, setActivityWalletTarget] = useState<HTMLDivElement | null>(null);
  const publicAccount = cloud && data?.capabilities.public_account === true ? adapter.publicAccount : undefined;
  const needsPublicSetup = Boolean(publicAccount && (!data?.capabilities.wallet_configured || !data?.capabilities.marketapp_configured || !data?.summary.portfolio_count));
  const settings = !publicAccount ? adapter.marketappSettings : undefined;
  const openApiSettings = settings ? () => cloud ? navigate('activity') : setApiSettingsOpen(true) : undefined;
  const closeApiSettings = useCallback(() => setApiSettingsOpen(false), []);
  const openCollectionSettings = publicAccount ? () => setPublicAccountOpen(true) : openApiSettings;
  const collectionBlocker = cloud ? publicComparisonBlocker(data?.capabilities)
    : localCollectionBlocker(data?.capabilities) || (error ? { message: 'Reload saved data before continuing the sync.', setup: false } : null);
  const simplePricing = page === 'pricing' && pricingView === 'grid';
  const activeJobs = jobs.filter(job => isActiveJob(job) && job.progress?.requires_resume !== true);
  const comparisonsStartup = useComparisonStartupRefresh(adapter, data?.startup_preview ? null : data, pricingSelection, ownedPriceRefresh, analyticsStartup,
    submitting || analyticsManualBusy, activeJobs.length > 0);
  const currentSyncIds = new Set(activityJobGroups(jobs).current.map(job => job.id));
  const visibleJobs = visibleDashboardJobs(jobs.filter(job => job.state === 'complete' || currentSyncIds.has(job.id)));
  const comparisonRequestBlocker = activityComparisonRequestBlocker(jobs, data?.capabilities.account_generation);
  const busy = submitting || activeJobs.length > 0 || comparisonsStartup.snapshot.busy || Boolean(comparisonRequestBlocker);
  const storageMaintenance = useStorageMaintenance(adapter, data, busy || analyticsManualBusy || analyticsStartup.busy ||
    giftRefreshStatus.phase === 'checking');
  const closeDetails = useCallback(() => setSelected(null), []);
  const changePricing = (next: PricingSelection) => { setSelected(null); setPricingSelection(next); };
  const priceJob: JobKind = pricingSelection.source === 'rentals' ? 'rental_prices' : 'prices';
  useEffect(() => telegramBridge.ready(), []);
  useEffect(() => adapter.subscribe?.(event => {
    if (event.job) updateJob(event.job);
    if (event.job) setComparisonAction(current => current?.jobId === event.job!.id
      ? { ...current, feedback: comparisonActionFeedback(event.job!) } : current);
    if (event.error) {
      setJobError(event.error);
    }
    if (event.savedDataChanged) void reload();
  }), [adapter, updateJob, reload]);
  useEffect(() => {
    setStoppingJobs(current => {
      const retained = new Set([...current].filter(id => jobs.some(job => job.id === id && isActiveJob(job))));
      return retained.size === current.size ? current : retained;
    });
  }, [jobs]);
  useEffect(() => {
    if (selected && data && !selectedDashboardGift(data, selected)) setSelected(null);
  }, [data, selected]); // Never carry a drawer into another wallet or account.
  const filtered = useMemo(() => sortInventoryGifts(filterInventoryGifts(data?.gifts || [], search, filter, collection, inventoryScope), inventorySort), [data, search, filter, collection, inventoryScope, inventorySort]);
  const giftList = useProgressiveList(filtered.length, PAGE_SIZE,
    JSON.stringify([search, filter, collection, inventoryScope, inventorySort]), page === 'gifts' && Boolean(data));
  const collections = useMemo(() => {
    const values = new Map<string, string>();
    for (const gift of data?.gifts || []) {
      const key = gift.collection_address || gift.collection_name;
      if (key) values.set(key, gift.collection_name || shorten(key));
    }
    return [...values].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const latestEvidence = useMemo(() => latestEvidenceAt(data?.gifts || []), [data]);
  const reviewWarnings = data && !Array.isArray(data.review) && Array.isArray(data.review.warnings)
    ? data.review.warnings.filter((value): value is string => typeof value === 'string') : [];
  const supportsJob = (kind: JobKind) => !data?.capabilities.supported_jobs || data.capabilities.supported_jobs.includes(kind);
  const comparisonActionContext = `${selectionContext}:${pricingQuery(pricingSelection)}`;
  const comparisonAllowance = comparisonAllowanceFeedback(jobs, data?.capabilities, data?.capabilities.account_generation);
  const canSync = canCollectComparisons(data, cloud, Boolean(error)) && !comparisonAllowance;
  const launch = async (kind: JobKind, job?: Job, options?: JobStartOptions, selection = pricingSelection, activityRowId?: 'listings' | 'rentals') => {
    if (!data || busy || !canSync || actionLaunching.current || comparisonAllowance) return;
    if (job && ['prices', 'rental_prices', 'collect'].includes(job.kind) && !activityComparisonResumeAvailability(job).canResume) return;
    const rowId = activityRowId ?? (kind === 'prices' ? 'listings' : kind === 'rental_prices' ? 'rentals' : null);
    actionLaunching.current = true;
    if (rowId) setComparisonAction({ context: comparisonActionContext, rowId,
      feedback: { tone: 'pending', message: job ? 'Continuing saved scan…' : 'Starting update…' } });
    comparisonsStartup.manualAction();
    setSubmitting(true); setJobError(null); setSyncMenu(false);
    try {
      const changed = job ? await adapter.resumeJob(job.id, data.capabilities.csrf_token, job.account_generation)
        : await adapter.startJob(kind, data.capabilities.csrf_token, selection, options);
      if (rowId) setComparisonAction({ context: comparisonActionContext, rowId, jobId: changed.id, feedback: comparisonActionFeedback(changed) });
      updateJob(changed);
      await reload();
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : 'The sync could not be started.';
      setJobError(message);
      if (rowId) setComparisonAction({ context: comparisonActionContext, rowId, feedback: { tone: 'error', message } });
    }
    finally { actionLaunching.current = false; setSubmitting(false); }
  };
  const onResume = (job: Job) => { if (job.resume_supported !== false) void launch(job.kind, job); };
  const onEfficient = (job: Job) => {
    if (!(presentResumeSupport(job).canStart || (job.resume_supported !== false && presentCollectionEfficiency(job).canStart)) || busy || !canSync) return;
    try { void launch(job.kind, undefined, undefined, efficientRefreshSelection(job, pricingSelection)); }
    catch (problem) { setJobError(problem instanceof Error ? problem.message : 'Choose a recent period before starting a new refresh.'); }
  };
  const stop = async (job: Job) => {
    // Stopping must remain available while collection is busy. The ref also
    // prevents repeated clicks before React has rendered the disabled button.
    if (!data || !isActiveJob(job) || job.stop_requested || stoppingJobs.has(job.id) || stopRequests.current.has(job.id)) return;
    comparisonsStartup.manualAction();
    stopRequests.current.add(job.id);
    setStoppingJobs(current => new Set(current).add(job.id));
    setJobError(null);
    try {
      updateJob(await adapter.stopJob(job.id, data.capabilities.csrf_token, job.account_generation));
      void reload();
    } catch (problem) {
      setStoppingJobs(current => { const next = new Set(current); next.delete(job.id); return next; });
      setJobError(problem instanceof Error ? problem.message : 'The sync could not be stopped.');
    } finally { stopRequests.current.delete(job.id); }
  };
  const onStop = (job: Job) => { void stop(job); };
  const navigate = (next: Page) => {
    // A Status → View period applies to that visit, not later normal visits.
    if (next !== 'overview') setAnalyticsTarget(null);
    setPage(next); setSyncMenu(false); setRefreshOpen(false);
    requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: 'instant' }); mainRef.current?.focus({ preventScroll: true }); });
  };
  const goFilter = (value: GiftFilter, scope: InventoryScope = 'portfolio') => { setFilter(value); setInventoryScope(scope); navigate('gifts'); setSearch(''); setCollection(''); };
  const nav = <>{NAV.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><Icon name={item.icon} size={20} /><span>{item.label}</span>{item.id === 'gifts' && data && <b>{data.summary.portfolio_count}</b>}</button>)}</>;

  const jobCards = visibleJobs.length > 0 && <div className="active-jobs">{visibleJobs.slice(0, 1).map(job => <JobCard key={job.id} job={job} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stopping={stoppingJobs.has(job.id)} stopDisabled={!data} blocker={collectionBlocker} onSetup={openCollectionSettings} />)}{visibleJobs.length > 1 && <button className="text-button other-syncs" onClick={() => navigate('activity')}>{visibleJobs.length - 1} more updates · View status<Icon name="arrow" size={14} /></button>}</div>;
  const priceRefreshDisabledReason = !data ? 'Load your saved gifts before refreshing prices.'
    : error ? 'Reload saved data before refreshing prices.'
      : !savedGiftRefreshEnabled(adapter.mode, data.capabilities) ? 'Price checks are disabled for this dashboard.'
        : !data.capabilities.wallet_configured && !(cloud && data.capabilities.personal_gift_refresh) ? 'Configure your portfolio wallet before refreshing prices.'
          : !data.gifts.some(gift => gift.is_portfolio) ? 'Discover or import your gifts before refreshing prices.' : undefined;
  const rentalStatusRefresh = cloud && (data?.capabilities.owned_status_refresh === true || data?.capabilities.personal_gift_refresh === true);
  const pullContext = `${page}:${selectionContext}:${pricingQuery(pricingSelection)}`;
  const latestPullContext = useRef(pullContext); latestPullContext.current = pullContext;
  const canPullGifts = !priceRefreshDisabledReason && Boolean(ownedPriceRefresh) && giftRefreshStatus.canRefresh === true
    && !busy && !analyticsManualBusy && !analyticsStartup.busy && !storageMaintenance.snapshot.busy
    && storageMaintenance.snapshot.continuation !== 'scheduled';
  const pullRefresh = async (): Promise<string> => {
    if (document.hidden) return '';
    if (canPullGifts) {
      comparisonsStartup.manualAction();
      await refreshGiftPrices();
      if (latestPullContext.current !== pullContext || document.hidden) return '';
      await reload();
      if (getReadError()) return 'Could not reload saved data. Try again or check Details.';
      const result = ownedPriceRefresh!.getSnapshot();
      return result.phase === 'complete' ? result.cacheHit ? 'Your gifts were checked recently.' : 'Gift check complete.'
        : 'Gift check incomplete. See Status for details.';
    }
    await reload();
    return getReadError() ? 'Could not reload saved data. Try again or check Details.' : 'Saved data reloaded.';
  };
  const giftPriceRefreshButton = <GiftPriceRefreshButton driver={ownedPriceRefresh} onRefresh={refreshGiftPrices} disabledReason={priceRefreshDisabledReason} rentalStatus={rentalStatusRefresh} />;
  const viewControl = <div className="gift-section-actions">{giftPriceRefreshButton}<GiftDisplayControl view={pricingView} onChange={changePricingView} label="Pricing gift display" /></div>;
  const connectionChanged = () => { comparisonsStartup.manualAction(); void reload(); };
  const marketappConnection = cloud && data?.capabilities.marketapp_analytics_refresh && adapter.marketappAnalyticsRefresh
    ? <Suspense fallback={<p role="status">Loading Marketapp connection…</p>}><MarketappConnection key={`${selectionContext}:${data.capabilities.wallet_configured}`} variant="connection" transport={adapter.marketappAnalyticsRefresh} wallet={data.wallet} onImported={async () => { comparisonsStartup.manualAction(); await reloadAnalytics(); }} startupBusy={analyticsStartup?.busy === true} onBusyChange={setAnalyticsManualBusy} /></Suspense>
    : <section className="activity-connection-row"><div className="activity-connection-heading"><Icon name="wallet" size={20} /><h3>Marketapp login</h3><span className="connection-status">{publicAccount && !data?.capabilities.wallet_configured ? 'Verify wallet first' : 'Not available'}</span></div><p className="activity-connection-note">{publicAccount && !data?.capabilities.wallet_configured ? 'Verify your wallet above to connect your personal Marketapp account.' : cloud ? 'Personal Marketapp login is not enabled for this account. Wallet and API key updates remain available.' : 'Personal Marketapp login is available in the Telegram app.'}</p><button type="button" className="button secondary small" disabled>Connect Marketapp</button></section>;
  const activityClock = Math.max(activityNow, Date.now());
  const freshnessRows = page === 'activity' && data ? activityFreshnessRows(data, jobs, { now: activityClock, giftRefresh: giftRefreshStatus,
    analyticsStartup, analyticsReloadedAt }).map(row => ({ ...row,
    updating: row.updating || (row.id === 'gifts' || row.id === 'prices') && giftRefreshStatus.phase === 'checking',
  })) : [];
  const activityResumeJob = (row: ActivityFreshnessRow) => row.id === 'listings' || row.id === 'rentals'
    ? resumableActivityComparisonJob(row.id, jobs, pricingSelection, data?.capabilities.account_generation) : null;
  const activityRequestAvailability = (row: ActivityFreshnessRow) => {
    if (row.id !== 'listings' && row.id !== 'rentals') return null;
    const saved = activityResumeJob(row);
    return comparisonRequestBlocker || (saved ? activityComparisonResumeAvailability(saved) : null);
  };
  const activityActionLabel = (row: ActivityFreshnessRow) => row.id.startsWith('analytics-') ? 'View'
    : row.id === 'gifts' || row.id === 'prices' ? 'Refresh'
      : submitting && comparisonAction?.context === comparisonActionContext && comparisonAction.rowId === row.id ? 'Starting…'
        : activityComparisonActionLabel(row.id === 'rentals' ? 'rentals' : 'listings', jobs, pricingSelection, data?.capabilities.account_generation);
  const activityActionFeedback = (row: ActivityFreshnessRow) => {
    if (row.id !== 'listings' && row.id !== 'rentals') return undefined;
    return currentComparisonActionFeedback(comparisonAction, comparisonActionContext, row.id, jobs,
      data?.capabilities.account_generation, activityClock) ?? comparisonAllowance ?? undefined;
  };
  const refreshActivityRow = (row: ActivityFreshnessRow) => {
    if (row.id === 'gifts' || row.id === 'prices') { comparisonsStartup.manualAction(); void refreshGiftPrices(); }
    else if (row.id === 'listings' || row.id === 'rentals') {
      if (activityRequestAvailability(row)?.canResume === false) return;
      const saved = activityResumeJob(row);
      if (saved) { void launch(saved.kind, saved, undefined, pricingSelection, row.id); return; }
      const source = row.id === 'rentals' ? 'rentals' : 'listings';
      void launch(source === 'rentals' ? 'rental_prices' : 'prices', undefined, undefined, { ...pricingSelection, source });
    } else {
      if (row.analyticsSelection === undefined) return;
      setAnalyticsTarget({ context: selectionContext, days: row.analyticsSelection });
      navigate('overview');
    }
  };
  const activityActionDisabled = (row: ActivityFreshnessRow) => row.id === 'gifts' || row.id === 'prices'
    ? Boolean(priceRefreshDisabledReason) || !ownedPriceRefresh || !giftRefreshStatus.canRefresh
    : row.id === 'listings' || row.id === 'rentals' ? busy || !canSync || Boolean(comparisonAllowance) || activityRequestAvailability(row)?.canResume === false : false;

  const headingActions = <div className="heading-actions"><a className="button secondary export-button" href={data && !adapter.exportCsv ? adapter.exportUrl(pricingSelection) : undefined} role={adapter.exportCsv ? 'button' : undefined} onClick={event => { if (adapter.exportCsv && data) { event.preventDefault(); adapter.exportCsv(data, pricingSelection); } }} onKeyDown={event => { if (adapter.exportCsv && data && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); adapter.exportCsv(data, pricingSelection); } }} aria-disabled={!data} tabIndex={data ? 0 : -1}><Icon name="download" size={16} />Export</a><div className="sync-control"><button className="button primary" onClick={() => { void launch(priceJob); }} disabled={!canSync || busy} title={!canSync ? collectionBlocker?.message || (publicAccount ? 'Discover your gifts before collecting comparison prices.' : cloud ? 'Configure the private server token and import your portfolio to collect comparison prices.' : 'Configure your wallet and local Marketapp API token, and enable network collection to sync.') : pricingSelection.source === 'rentals' ? 'Collect recorded rentals for your gift collections' : 'Collect observed asking prices for your gift collections'}><Icon name={busy ? 'refresh' : 'pricing'} size={17} className={busy ? 'spinning' : ''} />{busy ? 'Updating comparisons…' : 'Update comparisons'}</button><button className="button primary sync-more" disabled={!canSync || busy} aria-label="More sync options" aria-expanded={syncMenu} onClick={() => setSyncMenu(!syncMenu)}><span>⌄</span></button>{syncMenu && <div className="sync-menu">{rentalStatusRefresh && <GiftPriceRefreshButton driver={ownedPriceRefresh} onRefresh={() => { setSyncMenu(false); return refreshGiftPrices(); }} disabledReason={priceRefreshDisabledReason} rentalStatus display="menu" />}{cloud && <button disabled={!canSync || busy} onClick={() => { void launch(priceJob, undefined, { forceRefresh: true }); }}><Icon name="refresh" size={18} /><span><strong>Refresh comparisons now</strong><small>Skip cached comparisons. Request limits still apply.</small></span></button>}{supportsJob('refresh') && <button disabled={!canSync || busy} onClick={() => { void launch('refresh'); }}><Icon name="refresh" size={18} /><span><strong>Update gift details</strong><small>Check ownership, traits, prices and rental status</small></span></button>}{supportsJob('discover') && <button onClick={() => { void launch('discover'); }} disabled={!canSync || busy}><Icon name="discover" size={18} /><span><strong>Find new gifts</strong><small>Search your wallet and transfer history</small></span></button>}<button onClick={() => { void launch('collect'); }} disabled={!canSync || busy}><Icon name="layers" size={18} /><span><strong>Update listings &amp; rentals</strong><small>{cloud ? 'Update listings and rental comparisons together' : 'Update public market listings and rental history'}</small></span></button></div>}</div></div>;

  return <div className={`app-shell${cloud ? ' cloud' : ''}${simplePricing ? ' simple-pricing' : ''}`}><a href="#main" className="skip-link">Skip to dashboard</a>
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('pricing'); }} aria-label="Gift Rent Check pricing"><span className="brand-symbol"><Icon name="gift" size={24} /></span><span>Gift Rent<br />Check</span></a><div className="workspace-label"><span />{publicAccount ? 'YOUR DASHBOARD' : 'PRIVATE DASHBOARD'}</div><nav aria-label="Main navigation">{nav}</nav>
      <div className="sidebar-bottom"><div className="network-label"><span className="network-dot" />TON mainnet<Icon name="shield" size={15} /></div><span className="local-label"><i />{cloud ? 'TELEGRAM' : 'DESKTOP'} · READ ONLY</span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb"><strong>{NAV.find(item => item.id === page)?.label}</strong></span><div className="topbar-right">{publicAccount && page !== 'activity' && <button className="button secondary" onClick={() => navigate('activity')}><Icon name="wallet" size={16} />Connections</button>}{settings && !cloud && page !== 'activity' && <button className="button secondary marketapp-settings-button" onClick={openApiSettings}>API key</button>}<span className="read-only-indicator"><Icon name="shield" size={14} />Read only</span>{walletControl ? walletControl(data, activityWalletTarget) : <div className="wallet-chip" title={data?.wallet || 'No wallet configured'}><span className="wallet-avatar"><Icon name="wallet" size={15} /></span><span>{data?.wallet ? shorten(data.wallet) : 'Wallet not configured'}</span></div>}</div></header>
      <main id="main" ref={mainRef} tabIndex={-1} aria-label={NAV.find(item => item.id === page)?.label}>
      {cloud && <PullToRefresh surface={mainRef} context={pullContext} subject={canPullGifts ? 'gifts' : 'saved data'} refresh={pullRefresh} />}
      <div className={page === 'pricing' || page === 'gifts' ? 'sr-only' : 'page-heading concise-heading'}><h1>{NAV.find(item => item.id === page)?.label}</h1>
      </div>
      {data?.startup_preview && <p className="startup-saved-view" role="status"><Icon name="clock" size={14} />{error ? 'Showing your saved view. Use Retry to check for updates.' : 'Showing your saved view while checking for updates…'}</p>}
      {page === 'activity' && jobError && !(data && comparisonAction?.context === comparisonActionContext && comparisonAction.feedback.tone === 'error' && comparisonAction.feedback.message === jobError && freshnessRows.some(row => row.id === comparisonAction.rowId)) && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Sync action failed</strong><p>{jobError}</p></div><button className="icon-button" aria-label="Dismiss sync error" onClick={() => setJobError(null)}><Icon name="close" size={17} /></button></div>}
      {page === 'activity' && error && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Could not load updates</strong><p>Reload saved data before continuing.</p></div><button className="text-button" onClick={() => { void reload(); }}>Retry<Icon name="refresh" size={15} /></button></div>}
      {page === 'activity' && data && <ActivityDataStatus rows={freshnessRows} now={activityClock} onAction={refreshActivityRow} actionLabel={activityActionLabel} actionDisabled={activityActionDisabled} actionDisabledReason={row => row.id === 'gifts' || row.id === 'prices' ? priceRefreshDisabledReason : row.id === 'listings' || row.id === 'rentals' ? activeJobs.length > 0 || submitting ? 'Another update is running.' : activityRequestAvailability(row)?.reason || comparisonAllowance?.message || collectionBlocker?.message || undefined : undefined} actionFeedback={activityActionFeedback} />}
      {page === 'activity' && ownedPriceRefresh && giftRefreshStatus.phase !== 'idle' && giftRefreshStatus.phase !== 'complete' && <OwnedPriceStatus driver={ownedPriceRefresh} rentalStatus={rentalStatusRefresh} />}
      {page === 'activity' && data && <Activity records={data.activity || []} jobs={jobs} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stoppingJobs={stoppingJobs} stopDisabled={!data} blocker={collectionBlocker} onSetup={openCollectionSettings} view="progress" />}
      {publicAccount && (page === 'activity' || needsPublicSetup || publicAccountOpen) && <Suspense fallback={<p role="status">Loading account settings…</p>}><PublicAccountSetup enabled accountScope={publicAccountSettingsScope(data)} variant={page === 'activity' ? 'connections' : 'setup'} marketappConnection={marketappConnection} adapter={publicAccount} dashboardAdapter={adapter} jobs={jobs} portfolioCount={data?.summary.portfolio_count ?? 0} onChanged={connectionChanged} onClose={needsPublicSetup ? undefined : () => setPublicAccountOpen(false)} onExport={() => {
        if (!data) return;
        const blob = new Blob([JSON.stringify({version:1,exported_at:new Date().toISOString(),dashboard:data,jobs},null,2)],{type:'application/json'});
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href=url;link.download='gift-rent-check-account.json';link.click();URL.revokeObjectURL(url);
      }} /></Suspense>}
      {page === 'activity' && !publicAccount && <section className="activity-connections" aria-labelledby="activity-connections-title"><h2 id="activity-connections-title">Connections</h2>
        {cloud && walletControl ? <div className="activity-wallet-slot" ref={setActivityWalletTarget} /> : <section className="activity-connection-row"><div className="activity-connection-heading"><Icon name="wallet" size={20} /><h3>Wallet</h3><span className="connection-status">{data?.wallet ? 'Saved address' : 'Not configured'}</span></div><p className="activity-connection-note">{data?.wallet ? `Portfolio: ${shorten(data.wallet)}` : 'Configure your portfolio wallet in the desktop service.'}</p></section>}
        {marketappConnection}
        {settings && data ? <MarketappSettings key={`${Boolean(activeJobs.length)}:${data.capabilities.marketapp_configured}`} settings={settings} csrf={data.capabilities.csrf_token || ''} onChanged={connectionChanged} close={() => undefined} inline cloud={cloud} /> : <section className="activity-connection-row"><div className="activity-connection-heading"><Icon name="shield" size={20} /><h3>Marketapp API key</h3></div><p className="activity-connection-note">{loading ? 'Loading key settings…' : 'Reload saved data to manage your API key.'}</p></section>}
      </section>}
      {page === 'pricing' && <PricingControls selection={pricingSelection} onChange={changePricing} loading={loading} compact />}
      {page === 'activity' && cloud && adapter.storageMaintenance && <StorageStatusCard snapshot={storageMaintenance.snapshot} onClean={storageMaintenance.cleanNow} now={activityClock} />}
      {page === 'pricing' && settings && data && !data.capabilities.marketapp_configured && <div className="notice info marketapp-setup-notice"><Icon name="shield" size={18} /><div><strong>Add your Marketapp API key</strong><p>{collectionBlocker?.message} Saved data remains available.</p></div><button className="button secondary" onClick={openApiSettings}>Open API key setup</button></div>}
      {data && (page === 'pricing' || page === 'activity') && <details className="grid-collection-settings data-actions" open={refreshOpen} onToggle={event => { setRefreshOpen(event.currentTarget.open); if (!event.currentTarget.open) setSyncMenu(false); }}>
        <summary>{page === 'activity' ? 'More tools & export' : 'Refresh & export'}</summary>
        {refreshOpen && <div className="grid-collection-content">{headingActions}<CollectionLimits data={data} selection={pricingSelection} />{cloud && <p>Keep Telegram open while updating.</p>}{page === 'pricing' && <>{ownedPriceRefresh && <OwnedPriceStatus driver={ownedPriceRefresh} rentalStatus={rentalStatusRefresh} />}{jobCards}<button className="text-button" onClick={() => navigate('activity')}>View status <Icon name="arrow" size={14} /></button></>}</div>}
      </details>}
      {page !== 'activity' && error && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Could not load updates</strong><p>{data ? 'Showing your last saved data.' : cloud ? 'Reopen the Mini App or try again.' : 'Start the desktop service, then retry.'}</p><details><summary>Details</summary><p>{error}{loadedAt ? ` Last loaded ${dateTime(loadedAt)}.` : ''}</p></details></div><button className="text-button" onClick={() => { void reload(); }}>Retry<Icon name="refresh" size={15} /></button></div>}
      {page !== 'activity' && jobError && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Sync action failed</strong><p>{jobError}</p></div><button className="icon-button" aria-label="Dismiss sync error" onClick={() => setJobError(null)}><Icon name="close" size={17} /></button></div>}
      {data && !data.capabilities.network_enabled && refreshOpen && <div className="notice info"><Icon name="shield" size={18} /><div><strong>Saved data</strong><p>{savedGiftRefreshEnabled(adapter.mode, data.capabilities) ? rentalStatusRefresh ? 'Comparison sync is off. Your gifts can still refresh through Marketapp login or TON.' : 'Marketapp sync is off. Your gift prices can still update through TON.' : 'Sync is off. Browsing and export remain available.'}</p></div></div>}
      {!cloud && data && data.capabilities.network_enabled && !data.capabilities.wallet_configured && <div className="notice info"><Icon name="wallet" size={19} /><div><strong>Connect the dashboard to your wallet</strong><p>Set your wallet address in the local configuration, then restart the dashboard. No wallet connection or signing is needed.</p></div></div>}
      {reviewWarnings.length > 0 && <div className="notice error"><Icon name="alert" size={18} /><div><strong>Some review evidence could not be loaded</strong><details><summary>Details</summary>{reviewWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</details></div></div>}
      {loading && !data ? <div className="loading-state" role="status"><div className="loading-cards">{[0, 1, 2, 3].map(key => <div className="skeleton" key={key} />)}</div><div className="skeleton loading-panel" /><p>Reading your saved collection…</p></div> : data ? <>
        {page === 'gifts' && <div className="observation-caption"><span className="tiny-dot" /><span title={`Latest saved gift evidence: ${dateTime(latestEvidence)}. Individual checks may be older.`}>Gift data updated {relativeTime(latestEvidence)}</span></div>}
        {page === 'pricing' && <PricingPage key={selectionContext} data={data} selection={pricingSelection} onSelectionChange={changePricing} filters={pricingFilters} onFiltersChange={setPricingFilters} onSelect={selectGift} renderImage={gift => <GiftImage gift={gift} />} collectPrices={() => { void launch(priceJob); }} disabled={!canSync || busy} viewMode={pricingView} viewControl={viewControl} quickActions={cloud} />}
        {page === 'overview' && <Overview data={data} adapter={adapter} reload={reloadAnalytics} onFilter={goFilter} onSelect={selectGift} analyticsStartup={analyticsStartup} onAnalyticsBusy={setAnalyticsManualBusy} initialAnalyticsDays={analyticsTarget?.context === selectionContext ? analyticsTarget.days : undefined} />}
        {page === 'gifts' && <section className="panel gifts-panel">
          <div className="section-heading inventory-heading"><div><h2>{inventoryScope === 'portfolio' ? 'My gifts' : inventoryScope === 'candidates' ? 'Candidates' : 'All gifts'} <span className="heading-count">{filtered.length}</span></h2><span className="inventory-unit-caption">GRAM / day unless noted</span></div><div className="gift-section-actions">{giftPriceRefreshButton}<GiftDisplayControl view={inventoryView} onChange={changeInventoryView} label="My gifts display" /></div></div>
          <div className="filter-toolbar inventory-filters"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Search gifts" placeholder="Search gifts…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={15} /></button>}</label></div>
          <div className="inventory-filter-row">
            <div className="inventory-quick-filters" role="group" aria-label="Gift status">{(['all', 'available', 'rented'] as const).map(value => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'available' ? 'Available' : 'Rented'}</button>)}</div>
            <label className="inventory-sort"><span>Sort by</span><select aria-label="Sort gifts by" aria-describedby={inventorySort === 'last_rented' || inventorySort === 'rental_ending' ? 'inventory-sort-note' : undefined} value={inventorySort} onChange={event => changeInventorySort(event.target.value as InventorySort)}>{INVENTORY_SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <details className="inventory-advanced"><summary>Filters{(collection || filter !== 'all' || inventoryScope !== 'portfolio') && <span className="filter-count" aria-label="Active filters">{Number(Boolean(collection)) + Number(filter !== 'all') + Number(inventoryScope !== 'portfolio')}</span>}</summary><div>
              <label><span>Collection</span><select aria-label="Filter by collection" value={collection} onChange={event => setCollection(event.target.value)}><option value="">All collections</option>{collections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <label><span>Status</span><select aria-label="Filter gifts by state" value={filter} onChange={event => setFilter(event.target.value as GiftFilter)}>{FILTERS.map(option => <option key={option.id} value={option.id}>{option.id === 'all' ? 'All statuses' : option.label}</option>)}</select></label>
              <label><span>Include</span><select aria-label="Gift membership" value={inventoryScope} onChange={event => setInventoryScope(event.target.value as InventoryScope)}>{(['portfolio', 'candidates', 'all'] as const).map(scope => <option key={scope} value={scope}>{scope === 'portfolio' ? 'My gifts' : scope === 'candidates' ? 'Unverified candidates' : 'Gifts and candidates'}</option>)}</select></label>
              {(collection || filter !== 'all' || inventoryScope !== 'portfolio') && <button type="button" className="text-button filter-reset" onClick={() => { setCollection(''); setFilter('all'); setInventoryScope('portfolio'); }}>Reset filters</button>}
            </div></details>
          </div>
          {(inventorySort === 'last_rented' || inventorySort === 'rental_ending') && <p className="sr-only" id="inventory-sort-note">{inventorySort === 'last_rented' ? 'Newest known rental starts first. Missing dates appear last.' : 'Known rental end times first. Missing or unverified times appear last.'}</p>}
          {filtered.length ? inventoryView === 'grid' ? <InventoryGrid key={selectionContext} gifts={filtered.slice(0, giftList.visibleCount)} onSelect={selectGift} renderImage={gift => <GiftImage gift={gift} />} quickActions={cloud} /> : <GiftTable key={selectionContext} gifts={filtered.slice(0, giftList.visibleCount)} onSelect={selectGift} quickActions={cloud} /> : <Empty title={data.gifts.length ? 'No matching gifts' : 'No gifts yet'} icon={data.gifts.length ? 'search' : 'gift'}>{data.gifts.length ? <>Try another filter.<button className="button secondary" onClick={() => { setSearch(''); setCollection(''); setFilter('all'); setInventoryScope('portfolio'); }}>Reset filters</button></> : cloud ? data.capabilities.public_account ? 'Open Status to connect your wallet and find your gifts.' : 'Import a portfolio to add your gifts.' : 'Import a portfolio or discover your wallet to add gifts.'}</Empty>}
          <ListFooter {...giftList} total={filtered.length} noun={inventoryScope === 'candidates' ? 'candidates' : 'gifts'} />
        </section>}
        {page === 'activity' && <Activity records={data.activity || []} jobs={jobs} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stoppingJobs={stoppingJobs} stopDisabled={!data} blocker={collectionBlocker} onSetup={openCollectionSettings} view="history" giftCheck={ownedPriceRefresh && giftRefreshStatus.phase === 'complete' ? <OwnedPriceStatus driver={ownedPriceRefresh} rentalStatus={rentalStatusRefresh} /> : undefined} />}
      </> : !loading && !error && <Empty title="No saved data yet" icon="alert">{cloud ? 'Open this Mini App from your bot to load the portfolio.' : 'Start the dashboard service to load your portfolio.'}</Empty>}
      </main>
    </div><nav className="mobile-nav" aria-label="Mobile navigation">{nav}</nav>
    {apiSettingsOpen && settings && <MarketappSettings settings={settings} csrf={data?.capabilities.csrf_token || ''} onChanged={connectionChanged} close={closeApiSettings} />}
    {selectedGift && data && <GiftDetails key={`${selectionContext}:${selectedGift.id}`} gift={selectedGift} selection={pricingSelection} close={closeDetails} allTime={data.personal_analytics_all_time} wallet={data.wallet} quickActions={cloud}
      driver={cloud && data.capabilities.owned_price_refresh_single ? ownedPriceRefresh : null}
      onCheck={async nft => { await refreshOneGift(nft); await reload(); }} checkDisabledReason={priceRefreshDisabledReason} />}
  </div>;
}
