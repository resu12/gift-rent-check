import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import type { Dashboard, DashboardAdapter, DataRecord, Gift, Job, JobKind, JobStartOptions, PricingSelection } from './data/types';
import { dateTime, filterGifts, formatAmount, giftGroup, humanize, isActiveJob, relativeTime, safeExternalUrl, shorten } from './data/helpers';
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
import { SyncProgress } from './SyncProgress';
import { presentJobSync } from './data/syncPresentation';
import { efficientRefreshSelection, presentCollectionEfficiency, visibleDashboardJobs } from './data/collectionEfficiency';

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

function JobCard({ job, onResume, onEfficient, disabled, onStop, stopping, stopDisabled }: {
  job: Job; onResume: (job: Job) => void; disabled: boolean;
  onEfficient: (job: Job) => void;
  onStop: (job: Job) => void; stopping: boolean; stopDisabled: boolean;
}) {
  const requiresResume = job.progress?.requires_resume === true;
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
  const metrics = [['pages', 'Pages read'], ['observations', 'Records saved'], ['streams_complete', 'Checks completed'], ['streams_total', 'Checks planned']] as const;
  return <article className={`job-card sync-card job-${job.state} sync-${view.state}`} aria-label={view.title}>
    <div className="sync-card-header">
      <span className={`job-symbol ${active && !isStopping && view.state !== 'waiting' ? 'spinning' : ''}`} aria-hidden="true"><Icon name={view.state === 'complete' ? 'check' : view.state === 'failed' ? 'alert' : active && !isStopping && view.state !== 'waiting' ? 'refresh' : 'clock'} /></span>
      <strong>{view.title}</strong><span className="sync-state">{view.stateLabel}</span>
    </div>
    <p className="sync-purpose">{view.objective}</p>
    <SyncProgress progress={view.progress} moving={active && !isStopping && view.state !== 'waiting'} />
    <p className="sync-message" role="status">{view.message}</p>
    {efficiency.sampled && <p className="sync-sampled">{efficiency.sampled}</p>}
    {view.cacheNote && <p className="sync-cache-note">{view.cacheNote}</p>}
    {efficiency.warning && <p className="sync-efficiency-warning">{efficiency.warning}</p>}
    <div className="sync-card-footer">
      <details className="sync-details"><summary>Details</summary><div>
        <p>Progress counts completed collections or gift checks, not time remaining. Collections can take different amounts of time.</p>
        {window && <p>Selected period: {windowLabel}.{window.window_from && <> From {dateTime(window.window_from)}{window.window_to ? ` to ${dateTime(window.window_to)}` : ''}.</>} Continue keeps this period.</p>}
        {budget && <div className="job-metrics"><span>Requests this session <b>{budget.invocation_used} / {budget.invocation_limit}</b></span><span>Last 24 hours <b>{budget.rolling_24h_used} / {budget.rolling_24h_limit}</b></span></div>}
        <div className="job-metrics">{metrics.map(([key, label]) => typeof job.progress?.[key] === 'number' ? <span key={key}>{label} <b>{String(job.progress[key])}</b></span> : null)}</div>
        {history && <p>History: {history.incremental_streams} incremental and {history.full_streams} full-window plans. Incremental checks reread {history.overlap_seconds / 3600} hours of overlap.</p>}
        {listing && listing.reused_streams > 0 && <p>{listing.reused_streams} listing groups use completed broader scans.</p>}
        {cache && cache.reused_streams > 0 && <p>{cache.reused_streams} scans use the Telegram cache, without new comparison requests.{cache.oldest_observed_at && <> Original observations from {dateTime(cache.oldest_observed_at)}.</>}</p>}
        {efficiency.pageSize && <p>Items per request: {efficiency.pageSize}. {job.progress.efficiency?.scheduling === 'round_robin' ? 'Collections are visited in turns so each can receive a first sample before deeper pages.' : 'This saved scan finishes one stream before moving to the next.'}</p>}
        {efficiency.legacy && <p>An efficient refresh creates a new scan using {efficiency.recommendedPageSize} items per request and the same period. Relative periods start from now; custom dates stay fixed. Existing records and the older scan are kept. No saved cursor is changed.</p>}
        {view.rawReason && <p>Saved status: {view.rawReason}</p>}
        <time dateTime={job.updated_at}>Updated {dateTime(job.updated_at, true)}{job.run_id != null ? ` · Run ${job.run_id}` : ''}</time>
      </div></details>
      <div className="sync-actions">
        {efficiency.legacy && <button className="button small primary" disabled={disabled || !efficiency.canStart} onClick={() => onEfficient(job)}>Start efficient refresh<Icon name="refresh" size={15} /></button>}
        {(job.state === 'partial' || requiresResume) && <button className="button small secondary" disabled={disabled} onClick={() => onResume(job)}>{efficiency.legacy ? 'Continue older scan' : view.actionLabel || 'Continue'}<Icon name="arrow" size={15} /></button>}
        {isActiveJob(job) && <button className="button small secondary" disabled={stopDisabled || isStopping} onClick={() => onStop(job)} aria-label={`Stop ${JOB_LABEL[job.kind] || humanize(job.kind)}`}>{isStopping ? 'Stopping…' : 'Stop'}</button>}
      </div>
    </div>
  </article>;
}

function GiftTable({ gifts, onSelect }: { gifts: Gift[]; onSelect: (gift: Gift) => void }) {
  return <div className="table-scroll"><table className="gift-table"><thead><tr><th>Gift</th><th>Status</th><th>Observed daily price</th><th>Ownership evidence</th><th>Last observed</th><th><span className="sr-only">Details</span></th></tr></thead>
    <tbody>{gifts.map(gift => <tr key={gift.id}><td><button className="gift-name-button" onClick={() => onSelect(gift)}><GiftImage gift={gift} /><span><strong>{gift.name || 'Unnamed gift'}</strong><small>{gift.collection_name || shorten(gift.collection_address)}</small><RentalCount gift={gift} /></span></button></td>
      <td><StateBadge gift={gift} /></td><td><Price gift={gift} /></td>
      <td><span className={`evidence-label ${gift.automatic_membership ? 'verified' : ''}`}><Icon name={gift.automatic_membership ? 'shield' : 'layers'} size={15} />{gift.verification_method ? humanize(gift.verification_method) : gift.automatic_membership ? 'Verified on TON' : gift.is_portfolio ? 'Declared portfolio' : 'Needs verification'}</span></td>
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
  return <div className="coverage-card"><span className="coverage-icon"><Icon name="shield" size={22} /></span><div><h3>Evidence, with context</h3><p>{label}</p>{facts.length > 0 && <div className="coverage-facts">{facts.map(([key, value]) => <span key={key}>{humanize(key)} <b>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</b></span>)}</div>}</div><span className="read-only-tag">READ ONLY</span></div>;
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
    </div></details>
  </>;
}

function Overview({ data, onFilter, onSelect }: { data: Dashboard; onFilter: (filter: GiftFilter) => void; onSelect: (gift: Gift) => void }) {
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
  return <>
    <section className="stats-grid" aria-label="Portfolio summary">
      <StatCard label="Portfolio gifts" value={summary.portfolio_count} subtitle={`${summary.automatic_count} automatic · ${summary.review_count} reviewed`} icon="gift" tone="neutral" onClick={() => onFilter('all')} />
      <StatCard label="For rent" value={summary.for_rent_count} subtitle="Observed market listings" icon="arrow" tone="teal" onClick={() => onFilter('for_rent')} />
      <StatCard label="Observed rented" value={summary.rented_count} subtitle="From saved contract state" icon="clock" tone="blue" onClick={() => onFilter('rented')} />
      <StatCard label="Needs review" value={data.gifts.filter(gift => giftGroup(gift) === 'review').length} subtitle="Uncertain or incomplete evidence" icon="alert" tone="amber" onClick={() => onFilter('review')} />
    </section>
    <div className="overview-columns"><section className="panel inventory-panel"><div className="section-heading"><div><span className="eyebrow">INVENTORY</span><h2>Recently observed</h2></div><button className="text-button" onClick={() => onFilter('all')}>View all gifts <Icon name="arrow" size={17} /></button></div>
      {featured.length ? <div className="featured-grid">{featured.map(gift => <button className="featured-gift" key={gift.id} onClick={() => onSelect(gift)}><GiftImage gift={gift} large /><div className="featured-info"><small>{gift.collection_name || 'Collection unresolved'}</small><strong>{gift.name || 'Unnamed gift'}</strong><StateBadge gift={gift} /></div></button>)}</div> : <Empty title="Your portfolio starts here">Refresh your known gifts or discover a wallet to build a view of its collection.</Empty>}
    </section><section className="panel distribution-panel"><div className="section-heading"><div><span className="eyebrow">AT A GLANCE</span><h2>Portfolio mix</h2></div><Icon name="layers" size={20} /></div>
      <div className="mix-total"><strong>{summary.portfolio_count.toLocaleString()}</strong><span>gifts in your portfolio</span></div>
      <div className="distribution-bar" aria-label="Observed portfolio status distribution">{groups.map(group => <span className={group.color} key={group.label} style={{ flex: group.value }} title={`${group.label}: ${group.value}`} />)}{total === 0 && <span className="slate" style={{ flex: 1 }} />}</div>
      <div className="mix-legend">{groups.length ? groups.map(group => <button key={group.label} onClick={() => onFilter(group.filter)}><span><i className={group.color} />{group.label}</span><b>{group.value.toLocaleString()}</b></button>) : <p>No classified observations yet.</p>}</div>
      <p className="fine-print"><Icon name="clock" size={14} />States come from observations at different times.</p>
    </section></div>
    <Coverage data={data} />
  </>;
}

function Activity({ records, jobs, onResume, onEfficient, disabled, onStop, stoppingJobs, stopDisabled }: {
  records: DataRecord[]; jobs: Job[]; onResume: (job: Job) => void; onEfficient: (job: Job) => void; disabled: boolean;
  onStop: (job: Job) => void; stoppingJobs: Set<number>; stopDisabled: boolean;
}) {
  return <div className="activity-layout"><section className="panel"><div className="section-heading"><div><span className="eyebrow">COLLECTION ACTIVITY</span><h2>Sync history</h2></div><span className="count-label">{jobs.length} jobs</span></div>
    {jobs.length ? <div className="jobs-list">{[...jobs].sort((a, b) => b.id - a.id).map(job => <JobCard key={job.id} job={job} onResume={onResume} onEfficient={onEfficient} disabled={disabled} onStop={onStop} stopping={stoppingJobs.has(job.id)} stopDisabled={stopDisabled} />)}</div> : <Empty title="No sync jobs yet" icon="activity">Manual refresh jobs will appear here.</Empty>}
  </section><section className="panel"><div className="section-heading"><div><span className="eyebrow">SAVED EVIDENCE</span><h2>Recent observations</h2></div></div>
    {records.length ? <div className="activity-list">{records.slice(0, 30).map((record, index) => {
      const title = stringField(record, 'title', 'message', 'kind', 'type') || 'Observation recorded';
      const identity = stringField(record, 'name') || shorten(stringField(record, 'nft_address'), 10);
      const detail = stringField(record, 'description', 'detail') || (stringField(record, 'reason') ? humanize(stringField(record, 'reason')) : null);
      const time = stringField(record, 'observed_at', 'created_at', 'timestamp', 'at');
      return <article className="activity-item" key={String(record.id ?? index)}><span className="activity-dot" /><div><strong>{identity}</strong><p>{humanize(title)}{detail && detail !== title ? ` · ${detail}` : ''}</p><time title={dateTime(time)}>{dateTime(time, true)}</time></div></article>;
    })}</div> : <Empty title="No recent observations" icon="activity">Gift and rental evidence will appear here once it has been collected.</Empty>}
  </section></div>;
}

function stringField(record: DataRecord, ...keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
  return null;
}

function GiftDetails({ gift, selection, close }: { gift: Gift; selection: PricingSelection; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { ref.current?.showModal(); return telegramBridge.back(close); }, [close]);
  const explorer = safeExternalUrl(gift.explorer_url);
  return <dialog ref={ref} className="detail-dialog" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="gift-detail-title">
    <div className="drawer-content"><div className="drawer-top"><span className="eyebrow">GIFT DETAILS</span><button className="icon-button" autoFocus aria-label="Close gift details" onClick={close}><Icon name="close" /></button></div>
      <div className="detail-art"><GiftImage gift={gift} large /></div><div className="detail-title"><p>{gift.collection_name || 'Collection unresolved'}</p><h2 id="gift-detail-title">{gift.name || 'Unnamed gift'}</h2><StateBadge gift={gift} /></div>
      <div className="detail-price"><div><span>Observed daily price</span><Price gift={gift} /></div><Icon name="layers" size={27} /></div>
      {gift.price_source && <p className="detail-source">Source: {humanize(gift.price_source)}. This is an observation, not a price recommendation.</p>}
      <PricingDetails gift={gift} selection={selection} />
      <RentalHistoryDetails gift={gift} />
      <section className="detail-section"><h3>Ownership evidence</h3><div className="proof-badges">{gift.proof_badges.length ? gift.proof_badges.map(badge => <span key={badge}><Icon name="shield" size={14} />{humanize(badge)}</span>) : <span><Icon name="layers" size={14} />{gift.is_portfolio ? 'Declared portfolio membership' : 'Unverified candidate'}</span>}</div>
        <dl><div><dt>Verification</dt><dd>{gift.verification_method ? humanize(gift.verification_method) : 'Not established'}</dd></div><div><dt>Membership source</dt><dd>{gift.membership_sources.map(humanize).join(', ') || 'Not established'}</dd></div><div><dt>TON observation</dt><dd>{dateTime(gift.observed_at)}</dd></div><div><dt>Market observation</dt><dd>{dateTime(gift.market_observed_at)}</dd></div><div><dt>Asking price observation</dt><dd>{dateTime(gift.price_observed_at)}{gift.price_is_historical ? " · saved historical price" : ""}</dd></div>{gift.rental_until != null && <div><dt>Rental expiry</dt><dd>{dateTime(gift.rental_until)}</dd></div>}{gift.reviewed_at && <div><dt>Local review</dt><dd>{dateTime(gift.reviewed_at)}{gift.review_stale ? ' · stale' : ''}</dd></div>}{gift.reason && <div><dt>Verification result</dt><dd>{humanize(gift.reason)}</dd></div>}</dl>
      </section>
      <section className="detail-section"><h3>On-chain identity</h3><label className="address-label">NFT address</label><div className="address-box"><code>{gift.nft_address}</code><button className="icon-button" aria-label="Copy NFT address" onClick={() => { void navigator.clipboard?.writeText(gift.nft_address).then(() => setCopied(true)).catch(() => setCopied(false)); }}><Icon name={copied ? 'check' : 'copy'} size={17} /></button></div><span className="sr-only" aria-live="polite">{copied ? 'NFT address copied' : ''}</span><label className="address-label">Collection address</label><div className="address-box"><code>{gift.collection_address || 'Not established'}</code></div></section>
      {gift.uncertainties.length > 0 && <section className="uncertainty-box"><h3><Icon name="alert" size={16} />What is still uncertain</h3><ul>{gift.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
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
  const filtered = useMemo(() => filterGifts(data?.gifts || [], search, filter, collection), [data, search, filter, collection]);
  const giftList = useProgressiveList(filtered.length, PAGE_SIZE,
    JSON.stringify([search, filter, collection]), page === 'gifts' && Boolean(data));
  const collections = useMemo(() => {
    const values = new Map<string, string>();
    for (const gift of data?.gifts || []) {
      const key = gift.collection_address || gift.collection_name;
      if (key) values.set(key, gift.collection_name || shorten(key));
    }
    return [...values].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const latestEvidence = useMemo(() => (data?.gifts || []).flatMap(gift => [gift.observed_at, gift.market_observed_at])
    .filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null, [data]);
  const reviewWarnings = data && !Array.isArray(data.review) && Array.isArray(data.review.warnings)
    ? data.review.warnings.filter((value): value is string => typeof value === 'string') : [];
  const supportsJob = (kind: JobKind) => !data?.capabilities.supported_jobs || data.capabilities.supported_jobs.includes(kind);
  const canSync = Boolean(data?.capabilities.network_enabled && (cloud ? data.gifts.some(gift => gift.is_portfolio && gift.collection_address) : data.capabilities.wallet_configured) && data.capabilities.marketapp_configured && !error);
  const launch = async (kind: JobKind, job?: Job, options?: JobStartOptions, selection = pricingSelection) => {
    if (!data || busy) return;
    setSubmitting(true); setJobError(null); setSyncMenu(false);
    try {
      const changed = job ? await adapter.resumeJob(job.id, data.capabilities.csrf_token)
        : await adapter.startJob(kind, data.capabilities.csrf_token, selection, options);
      updateJob(changed);
      await reload();
    } catch (problem) { setJobError(problem instanceof Error ? problem.message : 'The sync could not be started.'); }
    finally { setSubmitting(false); }
  };
  const onResume = (job: Job) => { void launch(job.kind, job); };
  const onEfficient = (job: Job) => {
    if (!presentCollectionEfficiency(job).canStart || busy || !canSync) return;
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
  const goFilter = (value: GiftFilter) => { setFilter(value); setPage('gifts'); setSearch(''); setCollection(''); };
  const nav = <>{NAV.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><Icon name={item.icon} size={20} /><span>{item.label}</span>{item.id === 'gifts' && data && <b>{data.summary.portfolio_count}</b>}</button>)}</>;

  const jobCards = visibleJobs.length > 0 && <div className="active-jobs">{visibleJobs.map(job => <JobCard key={job.id} job={job} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stopping={stoppingJobs.has(job.id)} stopDisabled={!data} />)}</div>;

  const headingActions = <div className="heading-actions"><a className="button secondary export-button" href={data && !adapter.exportCsv ? adapter.exportUrl(pricingSelection) : undefined} role={adapter.exportCsv ? 'button' : undefined} onClick={event => { if (adapter.exportCsv && data) { event.preventDefault(); adapter.exportCsv(data, pricingSelection); } }} onKeyDown={event => { if (adapter.exportCsv && data && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); adapter.exportCsv(data, pricingSelection); } }} aria-disabled={!data} tabIndex={data ? 0 : -1}><Icon name="download" size={16} />Export</a><div className="sync-control"><button className="button primary" onClick={() => { void launch(priceJob); }} disabled={!canSync || busy} title={!canSync ? cloud ? 'Configure the private server token and import your portfolio to collect comparison prices.' : 'Configure your wallet and local Marketapp API token, and enable network collection to sync.' : pricingSelection.source === 'rentals' ? 'Collect recorded rentals for your gift collections' : 'Collect observed asking prices for your gift collections'}><Icon name={busy ? 'refresh' : 'pricing'} size={17} className={busy ? 'spinning' : ''} />{busy ? 'Sync in progress' : simplePricing ? 'Refresh prices' : pricingSelection.source === 'rentals' ? 'Collect actual rentals' : 'Collect comparison prices'}</button><button className="button primary sync-more" disabled={!canSync || busy} aria-label="More sync options" aria-expanded={syncMenu} onClick={() => setSyncMenu(!syncMenu)}><span>⌄</span></button>{syncMenu && <div className="sync-menu">{cloud && <button onClick={() => { void launch(priceJob, undefined, { forceRefresh: true }); }}><Icon name="refresh" size={18} /><span><strong>Force fresh comparison data</strong><small>Bypass the 60-minute comparison cache. Request limits still apply.</small></span></button>}{supportsJob('refresh') && <button onClick={() => { void launch('refresh'); }}><Icon name="refresh" size={18} /><span><strong>Refresh gift status</strong><small>Update ownership, traits and configured asking prices</small></span></button>}{supportsJob('discover') && <button onClick={() => { void launch('discover'); }} disabled={!data?.capabilities.marketapp_configured}><Icon name="discover" size={18} /><span><strong>Discover wallet gifts</strong><small>Search holdings and transfer history</small></span></button>}<button onClick={() => { void launch('collect'); }} disabled={!data?.capabilities.marketapp_configured}><Icon name="layers" size={18} /><span><strong>Collect market listings</strong><small>{cloud ? 'Refresh public listings and bounded rental history' : 'Read public listings; rented-gift prices use Refresh gift status'}</small></span></button></div>}</div></div>;

  return <div className={`app-shell${cloud ? ' cloud' : ''}${simplePricing ? ' simple-pricing' : ''}`}><a href="#main" className="skip-link">Skip to dashboard</a>
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); setPage('pricing'); }} aria-label="Giftfolio pricing"><span className="brand-symbol"><Icon name="gift" size={24} /></span><span>giftfolio<span className="brand-dot">.</span></span></a><div className="workspace-label"><span />PERSONAL WORKSPACE</div><nav aria-label="Main navigation">{nav}</nav>
      <div className="sidebar-bottom"><div className="network-label"><span className="network-dot" />TON mainnet<Icon name="shield" size={15} /></div><p>Your collection.<br />A clearer view.</p><span className="local-label"><i />{cloud ? 'TELEGRAM · PRIVATE' : 'LOCAL & PRIVATE'}</span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">Workspace <span>/</span> <strong>{NAV.find(item => item.id === page)?.label}</strong></span><div className="topbar-right"><span className="read-only-indicator"><Icon name="shield" size={14} />Read only</span>{walletControl ? walletControl(data) : <div className="wallet-chip" title={data?.wallet || 'No wallet configured'}><span className="wallet-avatar"><Icon name="wallet" size={15} /></span><span>{data?.wallet ? shorten(data.wallet) : 'Wallet not configured'}</span><span className={`connection-dot ${error ? 'offline' : ''}`} /></div>}</div></header>
      <main id="main">
      {page === 'pricing' && <div className="pricing-view-bar"><span>View</span><div className="pricing-view-toggle" role="group" aria-label="Gift display"><button type="button" className={simplePricing ? 'active' : ''} aria-pressed={simplePricing} onClick={() => changePricingView('grid')}><Icon name="overview" size={15} />Simple</button><button type="button" className={!simplePricing ? 'active' : ''} aria-pressed={!simplePricing} onClick={() => changePricingView('detailed')}><Icon name="layers" size={15} />Detailed</button></div></div>}
      <div className="page-heading"><div><span className="eyebrow">{page === 'pricing' ? 'RENTAL PRICE INTELLIGENCE' : 'YOUR PERSONAL COLLECTION'}</span><h1>{page === 'pricing' ? 'A clearer price for every gift.' : page === 'overview' ? 'Your gifts, in view.' : page === 'gifts' ? 'A place for every gift.' : 'Every observation, recorded.'}</h1><p>{page === 'pricing' ? 'Compare listing prices or actual rental records by collection, model, and exact Black backdrop.' : page === 'overview' ? 'Wallet ownership and rental observations, together in one place.' : page === 'gifts' ? 'Explore your portfolio and the evidence behind each gift.' : 'Follow your syncs and inspect the saved evidence as it arrives.'}</p></div>
        {!simplePricing && headingActions}
      </div>
      {page === 'pricing' && <PricingControls selection={pricingSelection} onChange={changePricing} loading={loading} compact={simplePricing} />}
      {ownedPriceRefresh && <OwnedPriceStatus driver={ownedPriceRefresh} />}
      {page === 'pricing' && data && (simplePricing ? <details className="grid-collection-settings" open={refreshOpen} onToggle={event => { setRefreshOpen(event.currentTarget.open); if (!event.currentTarget.open) setSyncMenu(false); }}>
        <summary>Refresh data</summary>
        {refreshOpen && <div className="grid-collection-content">{headingActions}<CollectionLimits data={data} selection={pricingSelection} />{cloud && <p>Keep Telegram open while updating.</p>}<button className="text-button" onClick={() => setPage('activity')}>Open collection activity <Icon name="arrow" size={14} /></button></div>}
      </details> : <CollectionLimits data={data} selection={pricingSelection} />)}
      {error && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>{cloud ? 'Telegram data could not be loaded' : data ? 'Showing saved data · local service unavailable' : 'The local service is unavailable'}</strong><p>{error}{loadedAt ? ` Last loaded ${dateTime(loadedAt)}.` : cloud ? ' Reopen the Mini App from your private bot and try again.' : ' Start the dashboard service and try again.'}</p></div><button className="text-button" onClick={() => { void reload(); }}>Retry<Icon name="refresh" size={15} /></button></div>}
      {jobError && <div className="notice error" role="alert"><Icon name="alert" size={19} /><div><strong>Sync action failed</strong><p>{jobError}</p></div><button className="icon-button" aria-label="Dismiss sync error" onClick={() => setJobError(null)}><Icon name="close" size={17} /></button></div>}
      {data && !data.capabilities.network_enabled && (!simplePricing || refreshOpen) && <div className="notice info"><Icon name="shield" size={18} /><div><strong>Browsing saved observations</strong><p>{data.capabilities.owned_price_refresh ? 'Marketapp collection is disabled. Your known gifts’ contract prices can still refresh through TON.' : 'Network collection is disabled for this dashboard. You can still inspect and export your local data.'}</p></div>{!data.capabilities.owned_price_refresh && <span className="quiet-pill">OFFLINE MODE</span>}</div>}
      {!cloud && data && data.capabilities.network_enabled && !data.capabilities.wallet_configured && <div className="notice info"><Icon name="wallet" size={19} /><div><strong>Connect the dashboard to your wallet</strong><p>Set your wallet address in the local configuration, then restart the dashboard. No wallet connection or signing is needed.</p></div></div>}
      {data && data.capabilities.network_enabled && data.capabilities.wallet_configured && !data.capabilities.marketapp_configured && <div className="notice info"><Icon name="layers" size={18} /><div><strong>{cloud ? 'A Marketapp API token is required on Telegram' : 'A local Marketapp API token is required to sync'}</strong><p>{cloud ? 'Configure the private backend token before collecting. Saved data remains available.' : 'Configure the token locally so refresh and discovery can check the eligible collection catalog. Sync and resume stay disabled until it is configured; saved data remains available.'}</p></div></div>}
      {cloud && data && !simplePricing && <details className="cloud-note"><summary>Keep the app open while collecting <span>· private portfolio</span></summary><p>{data.capabilities.ownership_note || 'Portfolio membership and ownership evidence were imported from your saved wallet scan. Telegram refreshes market prices; it does not yet discover new gifts or recheck rental contract ownership.'} Closing or hiding the Mini App interrupts collection; Continue resumes saved progress. Opening the app and changing filters use saved data only.</p></details>}
      {reviewWarnings.length > 0 && <div className="notice error"><Icon name="alert" size={18} /><div><strong>Some review evidence could not be loaded</strong>{reviewWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
      {page !== 'activity' && jobCards}
      {loading && !data ? <div className="loading-state" role="status"><div className="loading-cards">{[0, 1, 2, 3].map(key => <div className="skeleton" key={key} />)}</div><div className="skeleton loading-panel" /><p>Reading your saved collection…</p></div> : data ? <>
        {!simplePricing && <div className="observation-caption"><span className="tiny-dot" />{cloud ? 'Telegram saved-data view' : 'Local database view'}<span className="caption-divider">·</span><span title={dateTime(latestEvidence)}>Latest evidence {relativeTime(latestEvidence)}</span><span className="caption-divider">·</span><span>Generated {dateTime(data.generated_at, true)}</span></div>}
        {page === 'pricing' && <PricingPage data={data} selection={pricingSelection} onSelectionChange={changePricing} filters={pricingFilters} onFiltersChange={setPricingFilters} onSelect={setSelected} renderImage={gift => <GiftImage gift={gift} />} collectPrices={() => { void launch(priceJob); }} disabled={!canSync || busy} viewMode={pricingView} />}
        {page === 'overview' && <Overview data={data} onFilter={goFilter} onSelect={setSelected} />}
        {page === 'gifts' && <section className="panel gifts-panel"><div className="section-heading"><div><span className="eyebrow">GIFT INVENTORY</span><h2>Gifts and candidates <span className="heading-count">{data.gifts.length}</span></h2></div></div><div className="filter-toolbar"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Search gifts" placeholder="Search gift, collection or address…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><Icon name="close" size={15} /></button>}</label><label className="collection-filter"><span className="sr-only">Filter by collection</span><select value={collection} onChange={event => setCollection(event.target.value)}><option value="">All collections</option>{collections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div><div className="filter-tabs" aria-label="Filter gifts by state">{FILTERS.map(option => <button className={filter === option.id ? 'active' : ''} aria-pressed={filter === option.id} key={option.id} onClick={() => setFilter(option.id)}>{option.label}</button>)}</div>
          {filtered.length ? <GiftTable gifts={filtered.slice(0, giftList.visibleCount)} onSelect={setSelected} /> : <Empty title={data.gifts.length ? 'No gifts match this view' : 'No gifts to show yet'} icon={data.gifts.length ? 'search' : 'gift'}>{data.gifts.length ? 'Try a different search, collection, or status filter.' : 'Discover your wallet or import a portfolio to get started.'}</Empty>}
          <ListFooter {...giftList} total={filtered.length} />
        </section>}
        {page === 'activity' && <Activity records={data.activity || []} jobs={jobs} onResume={onResume} onEfficient={onEfficient} disabled={busy || !canSync} onStop={onStop} stoppingJobs={stoppingJobs} stopDisabled={!data} />}
      </> : !loading && <Empty title="Your dashboard is waiting" icon="alert">{cloud ? 'Open this Mini App from the private bot to load your saved portfolio.' : 'Start the local dashboard service to inspect your saved portfolio. Your data stays on this device.'}</Empty>}
      <footer className="page-footer"><span><Icon name="shield" size={14} />Price guidance only. No transactions or automatic price changes.</span><span>Powered by TON & Marketapp data</span></footer>
      </main>
    </div><nav className="mobile-nav" aria-label="Mobile navigation">{nav}</nav>
    {selected && data && <GiftDetails key={selected.id} gift={selected} selection={pricingSelection} close={closeDetails} />}
  </div>;
}
