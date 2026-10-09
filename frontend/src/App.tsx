import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import type { Dashboard, DashboardAdapter, DataRecord, Gift, Job, JobKind, JobStartOptions, PricingSelection } from './data/types';
import { dateTime, formatAmount, giftGroup, humanize, isActiveJob, relativeTime, safeExternalUrl, shorten } from './data/helpers';
import { filterInventoryGifts, latestEvidenceAt } from './data/inventory';
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
import { OwnedPriceStatus } from './OwnedPriceStatus';
import { MarketappSettings } from './MarketappSettings';
import { PersonalAnalytics } from './PersonalAnalytics';
import { localCollectionBlocker } from './data/marketappSettings';
import type { CollectionBlocker } from './data/marketappSettings';
import { SyncProgress } from './SyncProgress';
import { compactJobMessage, presentJobSync } from './data/syncPresentation';
import { efficientRefreshSelection, presentCollectionEfficiency, presentResumeSupport, visibleDashboardJobs } from './data/collectionEfficiency';
import './interface.css';

type Page = 'pricing' | 'overview' | 'gifts' | 'activity';
const NAV: { id: Page; label: string; icon: 'overview' | 'gift' | 'pricing' | 'activity' }[] = [
  { id: 'pricing', label: 'Pricing', icon: 'pricing' },
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'gifts', label: 'My gifts', icon: 'gift' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
];
const FILTERS: { id: GiftFilter; label: string }[] = [
  { id: 'all', label: 'All gifts' }, { id: 'for_rent', label: 'For rent' },
  { id: 'rented', label: 'Rented' }, { id: 'direct', label: 'In wallet' },
  { id: 'idle', label: 'Idle contracts' }, { id: 'sale', label: 'For sale' }, { id: 'review', label: 'Needs review' },
];
const JOB_LABEL: Record<JobKind, string> = { refresh: 'Refresh gift status', discover: 'Discover wallet gifts', collect: 'Collect market listings', prices: 'Collect comparison prices', rental_prices: 'Collect actual rental prices' };
const PAGE_SIZE = 20;

function useDashboard(adapter: DashboardAdapter, selection: PricingSelection) {
  const query = pricingQuery(selection);
  const activeQuery = useRef(query);
  activeQuery.current = query;
  const [snapshot, setSnapshot] = useState<{ data: Dashboard; query: string } | null>(null);
  const data = snapshot?.query === query ? snapshot.data : null;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const session = useRef<{ query: string; poller: ReturnType<typeof createDashboardPoller> } | null>(null);
  // Query identity, rather than a newly allocated selection object, owns the
  // session. Jobs can finish after a selection change: their old callback is inert.
  const requestedSelection = useRef(selection);
  requestedSelection.current = selection;
  const reload = useCallback(async () => {
    if (activeQuery.current === query && session.current?.query === query) await session.current.poller.reload();
  }, [query]);
  useEffect(() => {
    setLoading(true); setError(null);
    const poller = createDashboardPoller(adapter, requestedSelection.current, {
      dashboard(dashboard) {
        if (activeQuery.current !== query) return;
        setSnapshot({ data: dashboard, query }); setLoadedAt(new Date().toISOString());
      },
      jobs(currentJobs) { if (activeQuery.current === query) setJobs(currentJobs); },
      loading(pending) { if (activeQuery.current === query) setLoading(pending); },
      error(problem) { if (activeQuery.current === query) setError(problem); },
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
  return { data, jobs, loading: loading || (!data && !error), error, loadedAt, reload, updateJob };
}

function GiftImage({ gift, large = false }: { gift: Gift; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [gift.image_url]);
  const url = safeExternalUrl(gift.image_url);
  return <div className={`gift-image ${large ? 'large' : ''}`}>
    {url && !failed
      ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span className="gift-placeholder" aria-label="No gift image"><Icon name="gift" size={large ? 56 : 23} />{large && <span>No image available</span>}</span>}
  </div>;
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
    {pausedBlocker?.setup && onSetup && <button className="button small secondary sync-setup-action" onClick={onSetup}>Open API key setup<Icon name="shield" size={15} /></button>}
    {view.cacheNote && <p className="sync-cache-note">Cached comparisons · {cache?.oldest_observed_at ? <>oldest data {relativeTime(cache.oldest_observed_at)}</> : 'observation time unavailable'}</p>}
    {!resume.blocked && efficiency.warning && <p className="sync-efficiency-warning">Older scan · {efficiency.pageSize} items/request. New scans use {efficiency.recommendedPageSize}.</p>}
    <div className="sync-card-footer">
      <details className="sync-details"><summary>Details</summary><div>
        <p>{view.objective} {resumeMessage || pausedBlocker?.message || view.message}</p>
        {efficiency.sampled && <p>{efficiency.sampled}</p>}
        {view.cacheNote && <p>{view.cacheNote}</p>}
        {!resume.blocked && efficiency.warning && <p>{efficiency.warning}</p>}
        <p>Progress counts finished comparison checks, collections or gift checks. It does not estimate time remaining.</p>
        {window && !resume.blocked && <p>Selected period: {windowLabel}.{window.window_from && <> From {dateTime(window.window_from)}{window.window_to ? ` to ${dateTime(window.window_to)}` : ''}.</>} Continue keeps this period.</p>}
        {budget && <div className="job-metrics"><span>Requests this session <b>{budget.invocation_used} / {budget.invocation_limit}</b></span><span>Last 24 hours <b>{budget.rolling_24h_used} / {budget.rolling_24h_limit}</b></span></div>}
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

function GiftTable({ gifts, onSelect }: { gifts: Gift[]; onSelect: (gift: Gift) => void }) {
  return <div className="table-scroll"><table className="gift-table inventory-table"><thead><tr><th>Gift</th><th>Saved status</th><th>Daily price</th><th>Observed</th><th><span className="sr-only">Details</span></th></tr></thead>
    <tbody>{gifts.map(gift => <tr key={gift.id}><td><button className="gift-name-button" onClick={() => onSelect(gift)}><GiftImage gift={gift} /><span><strong>{gift.name || 'Unnamed gift'}</strong><small>{gift.collection_name || shorten(gift.collection_address)}{!gift.is_portfolio && <span className="candidate-label"> · Candidate</span>}</small><RentalCount gift={gift} /></span></button></td>
      <td><StateBadge gift={gift} /></td><td><Price gift={gift} />{gift.price_is_historical && <small className="saved-price-label">Saved price</small>}</td>
      <td><span className="observation" title={dateTime(gift.observed_at)}>{relativeTime(gift.observed_at)}</span></td><td><button className="icon-button" aria-label={`View ${gift.name || 'gift'} details`} onClick={() => onSelect(gift)}><Icon name="chevron" size={17} /></button></td>
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
  const historyError = selection.source === 'rentals' ? historyCollectionError(selection) : null;
  return <>
    {historyError && <div className="notice error" role="alert"><Icon name="alert" size={18} /><p>{historyError}</p></div>}
    <details className="sync-limit-details"><summary>Update limits & details</summary><div>
      {limits && <p>{limits.remaining_24h} of {limits.rolling_24h_attempts} requests remain in the last 24 hours. Each start or continuation allows up to {limits.max_attempts} requests and {limits.run_seconds / 60} minutes, at {limits.requests_per_second} request/s. Retries count.</p>}
      <p>{selection.source === 'rentals' ? `Checks actual rentals for ${timeframeLabel(selection).toLowerCase()}. Completed history is reused with a 48-hour overlap; a requested update after seven days rechecks the full period.` : 'Checks current asking prices. Past listing prices come from previously saved observations.'}</p>
      <p>Changing filters reads saved data. Continue keeps the original period. No prices are changed on Marketapp.</p>
      {data.capabilities.ownership_note && <p>{data.capabilities.ownership_note} Keep Telegram open while updating; Continue resumes saved progress.</p>}
    </div></details>
  </>;
}

function Overview({ data, adapter, reload, onFilter, onSelect }: { data: Dashboard; adapter: DashboardAdapter; reload: () => Promise<void>; onFilter: (filter: GiftFilter, scope?: InventoryScope) => void; onSelect: (gift: Gift) => void }) {
  const summary = data.summary;
  const featured = [...data.gifts].filter(gift => gift.is_portfolio).sort((a, b) => (b.observed_at || '').localeCompare(a.observed_at || '')).slice(0, 4);
  const count = (filter: GiftFilter) => data.gifts.filter(gift => gift.is_portfolio && giftGroup(gift) === filter).length;
  const groups = [
    { label: 'For rent', value: count('for_rent'), color: 'teal', filter: 'for_rent' as GiftFilter },
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
    <PersonalAnalytics snapshot={data.personal_analytics} snapshots={data.personal_analytics_snapshots} wallet={data.wallet} transport={adapter.personalAnalytics} csrf={data.capabilities.csrf_token} onImported={reload} cloud={adapter.mode === 'serverless'} marketappLoginTest={adapter.mode === 'serverless' && data.capabilities.marketapp_login_test ? adapter.marketappLoginTest : undefined} marketappAnalyticsRefresh={adapter.mode === 'serverless' && data.capabilities.marketapp_analytics_refresh ? adapter.marketappAnalyticsRefresh : undefined} />
    <section className="stats-grid" aria-label="Portfolio summary">
      <StatCard label="Your gifts" value={summary.portfolio_count} subtitle="Saved portfolio" icon="gift" tone="neutral" onClick={() => onFilter('all')} />
      <StatCard label="For rent" value={summary.for_rent_count} subtitle="Saved listings" icon="arrow" tone="teal" onClick={() => onFilter('for_rent')} />
      <StatCard label="Rented" value={summary.rented_count} subtitle="Saved contract status" icon="clock" tone="blue" onClick={() => onFilter('rented')} />
      <StatCard label="Needs review" value={portfolioReview + candidateReview} subtitle={`${portfolioReview} gifts · ${candidateReview} candidates`} icon="alert" tone="amber" onClick={() => onFilter('review', 'all')} />
    </section>
    <div className="overview-columns"><section className="panel inventory-panel"><div className="section-heading"><h2>Recently checked</h2><button className="text-button" onClick={() => onFilter('all')}>View all <Icon name="arrow" size={17} /></button></div>
      {featured.length ? <div className="featured-grid">{featured.map(gift => <button className="featured-gift" key={gift.id} onClick={() => onSelect(gift)}><GiftImage gift={gift} large /><div className="featured-info"><strong>{gift.name || 'Unnamed gift'}</strong><StateBadge gift={gift} /></div></button>)}</div> : <Empty title="No gifts yet">{data.capabilities.hosting === 'serverless' ? 'Import your saved portfolio to get started.' : 'Import a portfolio or discover your wallet to get started.'}</Empty>}
    </section><section className="panel distribution-panel"><div className="section-heading"><h2>Portfolio status</h2><Icon name="layers" size={20} /></div>
      <div className="distribution-bar" aria-label="Observed portfolio status distribution">{groups.map(group => <span className={group.color} key={group.label} style={{ flex: group.value }} title={`${group.label}: ${group.value}`} />)}{total === 0 && <span className="slate" style={{ flex: 1 }} />}</div>
      <div className="mix-legend">{groups.length ? groups.map(group => <button key={group.label} onClick={() => onFilter(group.filter)}><span><i className={group.color} />{group.label}</span><b>{group.value.toLocaleString()}</b></button>) : <p>No classified observations yet.</p>}</div>
      <p className="fine-print"><Icon name="clock" size={14} />States come from observations at different times.</p>
    </section></div>
    <Coverage data={data} />
  </>;
}

function Activity({ records, jobs, onResume, onEfficient, disabled, onStop, stoppingJobs, stopDisabled, blocker, onSetup }: {
  records: DataRecord[]; jobs: Job[]; onResume: (job: Job) => void; onEfficient: (job: Job) => void; disabled: boolean;
  onStop: (job: Job) => void; stoppingJobs: Set<number>; stopDisabled: boolean;
  blocker?: CollectionBlocker | null; onSetup?: () => void;
}) {
  return <div className="activity-layout"><section className="panel"><div className="section-heading"><h2>Sync history</h2><span className="count-label">{jobs.length}</span></div>
    {jobs.length ? <div className="jobs-list">{[...jobs].sort((a, b) => b.id - a.id).map(job => {
      const card = <JobCard job={job} onResume={onResume} onEfficient={onEfficient} disabled={disabled} onStop={onStop} stopping={stoppingJobs.has(job.id)} stopDisabled={stopDisabled} blocker={blocker} onSetup={onSetup} />;
      const view = presentJobSync(job);
      return job.state === 'complete' ? <details key={job.id} className="completed-sync"><summary><Icon name="check" size={17} /><strong>{view.title}</strong><span>{view.progress.label}</span><time dateTime={job.updated_at}>{dateTime(job.updated_at, true)}</time></summary>{card}</details> : <div key={job.id}>{card}</div>;
    })}</div> : <Empty title="No sync jobs yet" icon="activity">Refreshes will appear here.</Empty>}
  </section><details className="panel observations-disclosure"><summary>Recent observations <span>{records.length}</span></summary>
    {records.length ? <div className="activity-list">{records.slice(0, 30).map((record, index) => {
      const title = stringField(record, 'title', 'message', 'kind', 'type') || 'Observation recorded';
      const identity = stringField(record, 'name') || shorten(stringField(record, 'nft_address'), 10);
      const detail = stringField(record, 'description', 'detail') || (stringField(record, 'reason') ? humanize(stringField(record, 'reason')) : null);
      const time = stringField(record, 'observed_at', 'created_at', 'timestamp', 'at');
      return <article className="activity-item" key={String(record.id ?? index)}><span className="activity-dot" /><div><strong>{identity}</strong><p>{humanize(title)}{detail && detail !== title ? ` · ${detail}` : ''}</p><time title={dateTime(time)}>{dateTime(time, true)}</time></div></article>;
    })}</div> : <Empty title="No recent observations" icon="activity">Gift and rental evidence will appear here once it has been collected.</Empty>}
  </details></div>;
}

function stringField(record: DataRecord, ...keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
  return null;
}

function GiftDetails({ gift, selection, close }: { gift: Gift; selection: PricingSelection; close: () => void }) {
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
      <PricingDetails gift={gift} selection={selection} />
      <RentalHistoryDetails gift={gift} />
      <details className="detail-section detail-disclosure"><summary>Ownership evidence</summary><div className="proof-badges">{gift.proof_badges.length ? gift.proof_badges.map(badge => <span key={badge}><Icon name="shield" size={14} />{humanize(badge)}</span>) : <span><Icon name="layers" size={14} />{gift.is_portfolio ? 'Declared portfolio membership' : 'Unverified candidate'}</span>}</div>
        <dl><div><dt>Verification</dt><dd>{gift.verification_method ? humanize(gift.verification_method) : 'Not established'}</dd></div><div><dt>Membership source</dt><dd>{gift.membership_sources.map(humanize).join(', ') || 'Not established'}</dd></div><div><dt>TON observation</dt><dd>{dateTime(gift.observed_at)}</dd></div><div><dt>Market observation</dt><dd>{dateTime(gift.market_observed_at)}</dd></div><div><dt>Asking price observation</dt><dd>{dateTime(gift.price_observed_at)}{gift.price_is_historical ? " · saved historical price" : ""}</dd></div>{gift.rental_until != null && <div><dt>Rental expiry</dt><dd>{dateTime(gift.rental_until)}</dd></div>}{gift.reviewed_at && <div><dt>Local review</dt><dd>{dateTime(gift.reviewed_at)}{gift.review_stale ? ' · stale' : ''}</dd></div>}{gift.reason && <div><dt>Verification result</dt><dd>{humanize(gift.reason)}</dd></div>}</dl>
      </details>
      <details className="detail-section detail-disclosure"><summary>Addresses</summary><label className="address-label">NFT address</label><div className="address-box"><code>{gift.nft_address}</code><button className="icon-button" aria-label="Copy NFT address" onClick={() => { void navigator.clipboard?.writeText(gift.nft_address).then(() => setCopied(true)).catch(() => setCopied(false)); }}><Icon name={copied ? 'check' : 'copy'} size={17} /></button></div><span className="sr-only" aria-live="polite">{copied ? 'NFT address copied' : ''}</span><label className="address-label">Collection address</label><div className="address-box"><code>{gift.collection_address || 'Not established'}</code></div></details>
      {gift.uncertainties.length > 0 && <details className="uncertainty-box"><summary><Icon name="alert" size={16} />Uncertainty · {gift.uncertainties.length} {gift.uncertainties.length === 1 ? 'note' : 'notes'}</summary><ul>{gift.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      {explorer && <a className="button secondary external-link" href={explorer} target="_blank" rel="noopener noreferrer">Open in TON explorer<Icon name="external" size={16} /></a>}
    </div>
  </dialog>;
}

export default function App({ adapter, walletControl }: {
  adapter: DashboardAdapter;
  walletControl?: (dashboard: Dashboard | null) => React.ReactNode;
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
  const [pricingSelection, setPricingSelection] = useState<PricingSelection>(DEFAULT_PRICING);
  const [pricingFilters, setPricingFilters] = useState<PricingFilters>({ search: '', collection: '', filter: 'all', sort: 'increase' });
  const { data, jobs, loading, error, loadedAt, reload, updateJob } = useDashboard(adapter, pricingSelection);
  const ownedPriceRefresh = useOwnedPriceRefresh(adapter, data, reload);
  const [page, setPage] = useState<Page>('pricing');
  const mainRef = useRef<HTMLElement>(null);
  const [inventoryScope, setInventoryScope] = useState<InventoryScope>('portfolio');
  const [selected, setSelected] = useState<Gift | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<GiftFilter>('all');
  const [collection, setCollection] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [stoppingJobs, setStoppingJobs] = useState<Set<number>>(() => new Set());
  const stopRequests = useRef(new Set<number>());
  const [jobError, setJobError] = useState<string | null>(null);
  const [syncMenu, setSyncMenu] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const settings = !cloud ? adapter.marketappSettings : undefined;
  const openApiSettings = settings ? () => setApiSettingsOpen(true) : undefined;
  const closeApiSettings = useCallback(() => setApiSettingsOpen(false), []);
  const collectionBlocker = !cloud ? localCollectionBlocker(data?.capabilities) || (error ? { message: 'Reload saved data before continuing the sync.', setup: false } : null) : null;
  const simplePricing = page === 'pricing' && pricingView === 'grid';
  const activeJobs = jobs.filter(job => isActiveJob(job) && job.progress?.requires_resume !== true);
  const visibleJobs = visibleDashboardJobs(jobs);
  const busy = submitting || activeJobs.length > 0;
  const closeDetails = useCallback(() => setSelected(null), []);
  const changePricing = (next: PricingSelection) => { setSelected(null); setPricingSelection(next); };
  const priceJob: JobKind = pricingSelection.source === 'rentals' ? 'rental_prices' : 'prices';
  useEffect(() => telegramBridge.ready(), []);
  useEffect(() => adapter.subscribe?.(event => {
    if (event.job) updateJob(event.job);
    if (event.error) setJobError(event.error);
    if (event.savedDataChanged) void reload();
  }), [adapter, updateJob, reload]);
  useEffect(() => {
    setStoppingJobs(current => {
      const retained = new Set([...current].filter(id => jobs.some(job => job.id === id && isActiveJob(job))));
      return retained.size === current.size ? current : retained;
    });
  }, [jobs]);
  useEffect(() => {
    if (selected && data) {
      const fresh = data.gifts.find(gift => gift.id === selected.id);
      if (fresh) setSelected(fresh);
    }
  }, [data]); // Keep an open drawer current after a completed local sync.
  const filtered = useMemo(() => filterInventoryGifts(data?.gifts || [], search, filter, collection, inventoryScope), [data, search, filter, collection, inventoryScope]);
  const giftList = useProgressiveList(filtered.length, PAGE_SIZE,
    JSON.stringify([search, filter, collection, inventoryScope]), page === 'gifts' && Boolean(data));
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
  const canSync = Boolean(data?.capabilities.network_enabled && (cloud ? data.gifts.some(gift => gift.is_portfolio && gift.collection_address) : data.capabilities.wallet_configured) && data.capabilities.marketapp_configured && !error);
  const launch = async (kind: JobKind, job?: Job, options?: JobStartOptions, selection = pricingSelection) => {
    if (!data || busy || !canSync) return;
    setSubmitting(true); setJobError(null); setSyncMenu(false);
    try {
      const changed = job ? await adapter.resumeJob(job.id, data.capabilities.csrf_token)
        : await adapter.startJob(kind, data.capabilities.csrf_token, selection, options);
      updateJob(changed);
      await reload();
    } catch (problem) { setJobError(problem instanceof Error ? problem.message : 'The sync could not be started.'); }
    finally { setSubmitting(false); }
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
    stopRequests.current.add(job.id);
    setStoppingJobs(current => new Set(current).add(job.id));
    setJobError(null);
    try {
      updateJob(await adapter.stopJob(job.id, data.capabilities.csrf_token));
      void reload();
    } catch (problem) {
      setStoppingJobs(current => { const next = new Set(current); next.delete(job.id); return next; });
      setJobError(problem instanceof Error ? problem.message : 'The sync could not be stopped.');
    } finally { stopRequests.current.delete(job.id); }
  };
  const onStop = (job: Job) => { void stop(job); };
  const navigate = (next: Page) => {
    setPage(next); setSyncMenu(false); setRefreshOpen(false);
    requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: 'instant' }); mainRef.current?.focus({ preventScroll: true }); });
  };
  const goFilter = (value: GiftFilter, scope: InventoryScope = 'portfolio') => { setFilter(value); setInventoryScope(scope); navigate('gifts'); setSearch(''); setCollection(''); };
  const nav = <>{NAV.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><Icon name={item.icon} size={20} /><span>{item.label}</span>{item.id === 'gifts' && data && <b>{data.summary.portfolio_count}</b>}</button>)}</>;

  const jobCards = visibleJobs.length > 0 && <div className="active-jobs">{visibleJobs.slice(0, 1).map(job => <JobCard key={job.id} job={job} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stopping={stoppingJobs.has(job.id)} stopDisabled={!data} blocker={collectionBlocker} onSetup={openApiSettings} />)}{visibleJobs.length > 1 && <button className="text-button other-syncs" onClick={() => navigate('activity')}>{visibleJobs.length - 1} more updates · View activity<Icon name="arrow" size={14} /></button>}</div>;
  const viewControl = <div className="pricing-view-toggle" role="group" aria-label="Gift display"><button type="button" className={simplePricing ? 'active' : ''} aria-pressed={simplePricing} onClick={() => changePricingView('grid')}><Icon name="overview" size={15} />Simple</button><button type="button" className={!simplePricing ? 'active' : ''} aria-pressed={!simplePricing} onClick={() => changePricingView('detailed')}><Icon name="layers" size={15} />Detailed</button></div>;

  const headingActions = <div className="heading-actions"><a className="button secondary export-button" href={data && !adapter.exportCsv ? adapter.exportUrl(pricingSelection) : undefined} role={adapter.exportCsv ? 'button' : undefined} onClick={event => { if (adapter.exportCsv && data) { event.preventDefault(); adapter.exportCsv(data, pricingSelection); } }} onKeyDown={event => { if (adapter.exportCsv && data && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); adapter.exportCsv(data, pricingSelection); } }} aria-disabled={!data} tabIndex={data ? 0 : -1}><Icon name="download" size={16} />Export</a><div className="sync-control"><button className="button primary" onClick={() => { void launch(priceJob); }} disabled={!canSync || busy} title={!canSync ? cloud ? 'Configure the private server token and import your portfolio to collect comparison prices.' : 'Configure your wallet and local Marketapp API token, and enable network collection to sync.' : pricingSelection.source === 'rentals' ? 'Collect recorded rentals for your gift collections' : 'Collect observed asking prices for your gift collections'}><Icon name={busy ? 'refresh' : 'pricing'} size={17} className={busy ? 'spinning' : ''} />{busy ? 'Sync in progress' : simplePricing ? 'Refresh prices' : pricingSelection.source === 'rentals' ? 'Collect actual rentals' : 'Collect comparison prices'}</button><button className="button primary sync-more" disabled={!canSync || busy} aria-label="More sync options" aria-expanded={syncMenu} onClick={() => setSyncMenu(!syncMenu)}><span>⌄</span></button>{syncMenu && <div className="sync-menu">{cloud && <button onClick={() => { void launch(priceJob, undefined, { forceRefresh: true }); }}><Icon name="refresh" size={18} /><span><strong>Force fresh comparison data</strong><small>Bypass the 60-minute comparison cache. Request limits still apply.</small></span></button>}{supportsJob('refresh') && <button onClick={() => { void launch('refresh'); }}><Icon name="refresh" size={18} /><span><strong>Refresh gift status</strong><small>Update ownership, traits and configured asking prices</small></span></button>}{supportsJob('discover') && <button onClick={() => { void launch('discover'); }} disabled={!data?.capabilities.marketapp_configured}><Icon name="discover" size={18} /><span><strong>Discover wallet gifts</strong><small>Search holdings and transfer history</small></span></button>}<button onClick={() => { void launch('collect'); }} disabled={!data?.capabilities.marketapp_configured}><Icon name="layers" size={18} /><span><strong>Collect market listings</strong><small>{cloud ? 'Refresh public listings and bounded rental history' : 'Read public listings; rented-gift prices use Refresh gift status'}</small></span></button></div>}</div></div>;

  return <div className={`app-shell${cloud ? ' cloud' : ''}${simplePricing ? ' simple-pricing' : ''}`}><a href="#main" className="skip-link">Skip to dashboard</a>
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('pricing'); }} aria-label="Gift Rent Check pricing"><span className="brand-symbol"><Icon name="gift" size={24} /></span><span>Gift Rent<br />Check</span></a><div className="workspace-label"><span />PRIVATE DASHBOARD</div><nav aria-label="Main navigation">{nav}</nav>
      <div className="sidebar-bottom"><div className="network-label"><span className="network-dot" />TON mainnet<Icon name="shield" size={15} /></div><span className="local-label"><i />{cloud ? 'TELEGRAM' : 'DESKTOP'} · READ ONLY</span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">Workspace <span>/</span> <strong>{NAV.find(item => item.id === page)?.label}</strong></span><div className="topbar-right">{settings && <button className="button secondary marketapp-settings-button" onClick={openApiSettings}>API key</button>}<span className="read-only-indicator"><Icon name="shield" size={14} />Read only</span>{walletControl ? walletControl(data) : <div className="wallet-chip" title={data?.wallet || 'No wallet configured'}><span className="wallet-avatar"><Icon name="wallet" size={15} /></span><span>{data?.wallet ? shorten(data.wallet) : 'Wallet not configured'}</span><span className={`connection-dot ${error ? 'offline' : ''}`} /></div>}</div></header>
      <main id="main" ref={mainRef} tabIndex={-1} aria-label={NAV.find(item => item.id === page)?.label}>
      <div className={page === 'pricing' ? 'sr-only' : 'page-heading concise-heading'}><h1>{NAV.find(item => item.id === page)?.label}</h1>
      </div>
      {page === 'pricing' && <PricingControls selection={pricingSelection} onChange={changePricing} loading={loading} compact />}
      {ownedPriceRefresh && <OwnedPriceStatus driver={ownedPriceRefresh} />}
      {settings && data && !data.capabilities.marketapp_configured && <div className="notice info marketapp-setup-notice"><Icon name="shield" size={18} /><div><strong>Add your Marketapp API key</strong><p>{collectionBlocker?.message} Saved data remains available.</p></div><button className="button secondary" onClick={openApiSettings}>Open API key setup</button></div>}
      {data && <details className="grid-collection-settings data-actions" open={refreshOpen} onToggle={event => { setRefreshOpen(event.currentTarget.open); if (!event.currentTarget.open) setSyncMenu(false); }}>
        <summary>Refresh & export</summary>
        {refreshOpen && <div className="grid-collection-content">{headingActions}<CollectionLimits data={data} selection={pricingSelection} />{cloud && <p>Keep Telegram open while updating.</p>}<button className="text-button" onClick={() => navigate('activity')}>View activity <Icon name="arrow" size={14} /></button></div>}
      </details>}
      {error && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Could not load updates</strong><p>{data ? 'Showing your last saved data.' : cloud ? 'Reopen the Mini App or try again.' : 'Start the desktop service, then retry.'}</p><details><summary>Details</summary><p>{error}{loadedAt ? ` Last loaded ${dateTime(loadedAt)}.` : ''}</p></details></div><button className="text-button" onClick={() => { void reload(); }}>Retry<Icon name="refresh" size={15} /></button></div>}
      {jobError && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Sync action failed</strong><p>{jobError}</p></div><button className="icon-button" aria-label="Dismiss sync error" onClick={() => setJobError(null)}><Icon name="close" size={17} /></button></div>}
      {data && !data.capabilities.network_enabled && refreshOpen && <div className="notice info"><Icon name="shield" size={18} /><div><strong>Saved data</strong><p>{data.capabilities.owned_price_refresh ? 'Marketapp sync is off. Your gift prices can still update through TON.' : 'Sync is off. Browsing and export remain available.'}</p></div></div>}
      {!cloud && data && data.capabilities.network_enabled && !data.capabilities.wallet_configured && <div className="notice info"><Icon name="wallet" size={19} /><div><strong>Connect the dashboard to your wallet</strong><p>Set your wallet address in the local configuration, then restart the dashboard. No wallet connection or signing is needed.</p></div></div>}
      {cloud && data && data.capabilities.network_enabled && data.capabilities.wallet_configured && !data.capabilities.marketapp_configured && <div className="notice info"><Icon name="layers" size={18} /><div><strong>{cloud ? 'A Marketapp API token is required on Telegram' : 'A local Marketapp API token is required to sync'}</strong><p>{cloud ? 'Configure the private backend token before collecting. Saved data remains available.' : 'Configure the token locally so refresh and discovery can check the eligible collection catalog. Sync and resume stay disabled until it is configured; saved data remains available.'}</p></div></div>}
      {reviewWarnings.length > 0 && <div className="notice error"><Icon name="alert" size={18} /><div><strong>Some review evidence could not be loaded</strong>{reviewWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
      {page !== 'activity' && jobCards}
      {loading && !data ? <div className="loading-state" role="status"><div className="loading-cards">{[0, 1, 2, 3].map(key => <div className="skeleton" key={key} />)}</div><div className="skeleton loading-panel" /><p>Reading your saved collection…</p></div> : data ? <>
        {page !== 'pricing' && <div className="observation-caption"><span className="tiny-dot" /><span title={dateTime(latestEvidence)}>Latest observation {relativeTime(latestEvidence)}</span></div>}
        {page === 'pricing' && <PricingPage data={data} selection={pricingSelection} onSelectionChange={changePricing} filters={pricingFilters} onFiltersChange={setPricingFilters} onSelect={setSelected} renderImage={gift => <GiftImage gift={gift} />} collectPrices={() => { void launch(priceJob); }} disabled={!canSync || busy} viewMode={pricingView} viewControl={viewControl} />}
        {page === 'overview' && <Overview data={data} adapter={adapter} reload={reload} onFilter={goFilter} onSelect={setSelected} />}
        {page === 'gifts' && <section className="panel gifts-panel">
          <div className="inventory-scope" role="group" aria-label="Gift membership">
            {(['portfolio', 'candidates', 'all'] as const).map(scope => <button key={scope} aria-pressed={inventoryScope === scope} className={inventoryScope === scope ? 'active' : ''} onClick={() => setInventoryScope(scope)}>{scope === 'portfolio' ? 'Your gifts' : scope === 'candidates' ? 'Candidates' : 'All'} <b>{data.gifts.filter(gift => scope === 'all' || (scope === 'portfolio' ? gift.is_portfolio : !gift.is_portfolio)).length}</b></button>)}
          </div>
          <div className="filter-toolbar inventory-filters"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Search gifts" placeholder="Search gifts…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={15} /></button>}</label><label className="collection-filter"><span className="sr-only">Filter by collection</span><select value={collection} onChange={event => setCollection(event.target.value)}><option value="">All collections</option>{collections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="collection-filter"><span className="sr-only">Filter gifts by state</span><select value={filter} onChange={event => setFilter(event.target.value as GiftFilter)}>{FILTERS.map(option => <option key={option.id} value={option.id}>{option.id === 'all' ? 'All statuses' : option.label}</option>)}</select></label></div>
          {filtered.length ? <GiftTable gifts={filtered.slice(0, giftList.visibleCount)} onSelect={setSelected} /> : <Empty title={data.gifts.length ? 'No matching gifts' : 'No gifts yet'} icon={data.gifts.length ? 'search' : 'gift'}>{data.gifts.length ? <>Try another filter.<button className="button secondary" onClick={() => { setSearch(''); setCollection(''); setFilter('all'); setInventoryScope('portfolio'); }}>Reset filters</button></> : cloud ? 'Import your saved portfolio to add gifts here.' : 'Import a portfolio or discover your wallet to add gifts.'}</Empty>}
          <ListFooter {...giftList} total={filtered.length} noun={inventoryScope === 'candidates' ? 'candidates' : 'gifts'} />
        </section>}
        {page === 'activity' && <Activity records={data.activity || []} jobs={jobs} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stoppingJobs={stoppingJobs} stopDisabled={!data} blocker={collectionBlocker} onSetup={openApiSettings} />}
      </> : !loading && !error && <Empty title="No saved data yet" icon="alert">{cloud ? 'Open this Mini App from your bot to load the portfolio.' : 'Start the dashboard service to load your portfolio.'}</Empty>}
      <footer className="page-footer"><span><Icon name="shield" size={14} />Read-only · no price changes</span><span>TON & Marketapp</span></footer>
      </main>
    </div><nav className="mobile-nav" aria-label="Mobile navigation">{nav}</nav>
    {apiSettingsOpen && settings && <MarketappSettings settings={settings} csrf={data?.capabilities.csrf_token || ''} onChanged={() => { void reload(); }} close={closeApiSettings} />}
    {selected && data && <GiftDetails key={selected.id} gift={selected} selection={pricingSelection} close={closeDetails} />}
  </div>;
}
