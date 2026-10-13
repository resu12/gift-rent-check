import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { PersonalAnalyticsChart } from './PersonalAnalyticsChart';
import { MarketappTopItems } from './MarketappTopItems';
import { MarketappCollections } from './MarketappCollections';
import type { DashboardAdapter, Gift, MarketappAnalyticsRefreshAdapter, MarketappLoginTestAdapter, PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime } from './data/types';
import { dateTime, formatAmount, relativeTime } from './data/helpers';
import { analyticsBarHeights, analyticsHistoryGrouping, analyticsPeriod, canImportPersonalAnalytics, groupPersonalAnalytics, personalAnalyticsSnapshots, personalAnalyticsUrl } from './data/personalAnalytics';
import { analyticsRefreshPeriod, analyticsReportDays, analyticsReportOptions, analyticsReportSelection, selectAnalyticsReport } from './data/analyticsReports';
import type { AnalyticsReportSelection } from './data/analyticsReports';
import { analyticsFreshnessPresentation } from './data/analyticsFreshness';
import type { AnalyticsGrouping } from './data/personalAnalytics';
import { marketappAnalyticsBookmarklet } from './data/marketappAnalyticsCapture';
import type { AnalyticsStartupSnapshot } from './serverless/analyticsStartup';
import type { MarketappAnalyticsRefreshView } from './serverless/marketappAnalyticsRefreshFlow';
import { canonicalMainnetAddress } from './serverless/walletIdentity';
import { ANALYTICS_CLOCK_SKEW_MS } from './data/analyticsClock';
import { useAnalyticsClock } from './useAnalyticsClock';
import { analyticsImages } from './data/analyticsImages';
import { analyticsReadLimitMessage } from './data/analyticsReadCoverage';
import './personalAnalytics.css';

const GROUPS: { id: AnalyticsGrouping; label: string }[] = [
  { id: 'day', label: 'Daily' }, { id: 'week', label: 'Weekly' }, { id: 'month', label: 'Monthly' },
  { id: 'year', label: 'Yearly' },
];
const FILE_LIMIT = 256 * 1024;
const MarketappLoginTest = lazy(() => import('./serverless/MarketappLoginTest'));
const MarketappAnalyticsRefresh = lazy(() => import('./serverless/MarketappAnalyticsRefresh'));

export function PersonalAnalytics({ snapshot: latestSnapshot, snapshots: savedSnapshots, allTime, wallet, gifts = [], transport, csrf, onImported, cloud = false, marketappLoginTest, marketappAnalyticsRefresh, analyticsStartup, onAnalyticsBusy, initialPeriodDays }: {
  snapshot?: PersonalRentalAnalytics | null;
  snapshots?: PersonalRentalAnalytics[];
  allTime?: PersonalRentalAnalyticsAllTime | null;
  wallet: string | null;
  gifts?: readonly Gift[];
  transport?: DashboardAdapter['personalAnalytics'];
  csrf: string;
  onImported: () => Promise<void>;
  cloud?: boolean;
  marketappLoginTest?: MarketappLoginTestAdapter;
  marketappAnalyticsRefresh?: MarketappAnalyticsRefreshAdapter;
  analyticsStartup?: AnalyticsStartupSnapshot;
  onAnalyticsBusy?: (busy: boolean) => void;
  initialPeriodDays?: AnalyticsReportSelection;
}) {
  const walletIdentity = canonicalMainnetAddress(wallet) || wallet;
  const images = useMemo(() => analyticsImages(gifts), [gifts]);
  const identity = useRef(walletIdentity); identity.current = walletIdentity;
  const mounted = useRef(true);
  const [periodSelection, setPeriodSelection] = useState<{ wallet: string | null; days: AnalyticsReportSelection } | null>(() =>
    initialPeriodDays === 'all_time' || typeof initialPeriodDays === 'number' && Number.isSafeInteger(initialPeriodDays) && initialPeriodDays > 0 && initialPeriodDays <= 366
      ? { wallet: walletIdentity, days: initialPeriodDays! } : null);
  const [manualRefreshView, setManualRefreshView] = useState<MarketappAnalyticsRefreshView | null>(null);
  const [importView, setImportView] = useState<{ days: number; capturedAt: string; fingerprint: string; loading: boolean; reloadFailed?: boolean; outcomeAt: string } | null>(null);
  const [historyReloadedAt, setHistoryReloadedAt] = useState<string | null>(null);
  const reloadHistory = useCallback(async () => {
    const savedIdentity = identity.current;
    await onImported();
    if (mounted.current && identity.current === savedIdentity) {
      const loaded = Date.now();
      setHistoryReloadedAt(new Date(loaded).toISOString()); setNow(loaded);
      setImportView(previous => previous ? { ...previous, loading: false, reloadFailed: false } : null);
      setError(null);
    }
  }, [onImported]);
  const refreshEnabled = Boolean(cloud && marketappAnalyticsRefresh);
  const snapshots = useMemo(() => personalAnalyticsSnapshots(latestSnapshot, savedSnapshots), [latestSnapshot, savedSnapshots]);
  const periodOptions = useMemo(() => analyticsReportOptions(snapshots, refreshEnabled, allTime), [snapshots, refreshEnabled, allTime]);
  const selectedDays = analyticsReportDays(snapshots, walletIdentity, periodSelection);
  const snapshot = selectAnalyticsReport(snapshots, selectedDays, allTime);
  const savedHistory = selectedDays === 'all_time';
  const readLimitMessage = analyticsReadLimitMessage(snapshot, 'daily');
  const providerPeriod = analyticsRefreshPeriod(selectedDays);
  const refreshable = refreshEnabled && providerPeriod !== null;
  const [now, setNow] = useAnalyticsClock();
  const [group, setGroup] = useState<AnalyticsGrouping>('day');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setManualRefreshView(null); setImportView(null); setHistoryReloadedAt(null); setMessage(null); setError(null); setPending(false); setReloading(false); setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }, [walletIdentity]);
  useEffect(() => { setNow(Date.now()); }, [snapshot?.captured_at, manualRefreshView?.capturedAt, analyticsStartup?.capturedAt, analyticsStartup?.reloadedAt]);
  useEffect(() => {
    const loaded = Date.parse(analyticsStartup?.reloadedAt || '');
    if (importView?.reloadFailed && Number.isFinite(loaded) && loaded <= Date.now() + ANALYTICS_CLOCK_SKEW_MS && loaded >= Date.parse(importView.outcomeAt)) {
      setImportView(previous => previous ? { ...previous, reloadFailed: false } : null);
      setError(null);
    }
  }, [analyticsStartup?.reloadedAt, importView]);
  useEffect(() => { setGroup(selectedDays === 'all_time' ? 'month' : selectedDays > 90 ? 'week' : 'day'); }, [selectedDays]);
  const renderGroup = useMemo(() => analyticsHistoryGrouping(snapshot, group), [snapshot, group]);
  const availableGroups = useMemo(() => new Set(GROUPS.filter(item => analyticsHistoryGrouping(snapshot, item.id) === item.id).map(item => item.id)), [snapshot]);
  const buckets = useMemo(() => snapshot ? groupPersonalAnalytics(snapshot, renderGroup) : [], [snapshot, renderGroup]);
  const heights = useMemo(() => analyticsBarHeights(buckets), [buckets]);
  const source = personalAnalyticsUrl(wallet, snapshot);
  const importAllowed = canImportPersonalAnalytics(cloud, csrf, Boolean(transport));
  const manualBusy = Boolean(manualRefreshView?.loadingSaved || manualRefreshView?.statusChecking ||
    ['preparing', 'choosing', 'awaiting_approval', 'updating', 'reconciling', 'confirming', 'disconnecting'].includes(manualRefreshView?.phase || ''));
  const freshness = analyticsFreshnessPresentation(snapshot, selectedDays, { now, refreshable,
    startup: refreshEnabled ? analyticsStartup : undefined, manual: manualRefreshView, imported: importView ?? undefined, historyReloadedAt });
  const captured = snapshot ? Date.parse(snapshot.captured_at) : NaN;
  const captureValid = Number.isFinite(captured) && captured <= now + ANALYTICS_CLOCK_SKEW_MS;
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    onAnalyticsBusy?.(manualBusy || pending || reloading);
    return () => { onAnalyticsBusy?.(false); };
  }, [manualBusy, pending, reloading, onAnalyticsBusy]);
  const reloadReport = async () => {
    if (reloading || pending || manualBusy || analyticsStartup?.busy) return;
    const savedIdentity = identity.current;
    setReloading(true); setError(null);
    try { await reloadHistory(); }
    catch { if (mounted.current && identity.current === savedIdentity) setError('Could not reload saved data. The previously loaded figures remain visible.'); }
    finally { if (mounted.current && identity.current === savedIdentity) setReloading(false); }
  };
  const copyCode = async () => {
    setCopied(false);
    try { await navigator.clipboard.writeText(marketappAnalyticsBookmarklet()); setCopied(true); }
    catch { setError('Clipboard is unavailable. Copy the code from the field below.'); }
  };
  const importFile = async () => {
    if (!file || pending || reloading || manualBusy || analyticsStartup?.busy || !transport || !importAllowed) return;
    const savedIdentity = identity.current;
    let saved = false;
    setError(null); setMessage(null); setPending(true); setHistoryReloadedAt(null);
    try {
      if (file.size > FILE_LIMIT) throw new Error('Choose an analytics JSON file smaller than 256 KB.');
      const raw = await file.text();
      if (!mounted.current || identity.current !== savedIdentity) return;
      const imported = await transport.importSnapshot(raw, csrf);
      saved = true;
      if (mounted.current && identity.current === savedIdentity) {
        setFile(null); if (fileInput.current) fileInput.current.value = '';
        setPeriodSelection({ wallet: savedIdentity, days: savedHistory ? 'all_time' : imported.daily.length });
        setImportView({ days: imported.daily.length, capturedAt: imported.captured_at, fingerprint: imported.fingerprint, loading: true, outcomeAt: new Date().toISOString() });
        setMessage('Report saved. Loading the saved figures…');
      }
      if (!mounted.current || identity.current !== savedIdentity) return;
      await reloadHistory();
      if (mounted.current && identity.current === savedIdentity) {
        setImportView(previous => previous ? { ...previous, loading: false } : null);
        setMessage('Report imported. Capture time is shown above.');
      }
    } catch (problem) {
      if (mounted.current && identity.current === savedIdentity) {
        if (saved) {
          setImportView(previous => previous ? { ...previous, loading: false, reloadFailed: true } : null);
          setMessage(null); setError('Report saved, but this view could not reload it. Reload saved data to see the imported figures.');
        } else setError(problem instanceof Error ? problem.message : 'Could not import analytics. Previously loaded figures remain visible.');
      }
    } finally { if (mounted.current && identity.current === savedIdentity) setPending(false); }
  };
  return <><section className="panel personal-analytics" aria-labelledby="personal-analytics-title">
    <div className="personal-analytics-heading"><div><h2 id="personal-analytics-title">Rental analytics</h2></div>{periodOptions.length > 0 && <div className="personal-analytics-period">
      <label className="sr-only" htmlFor="personal-analytics-period">Report period</label>
      <select id="personal-analytics-period" value={selectedDays} disabled={pending || manualBusy} onChange={event => {
        const selection = analyticsReportSelection(event.target.value);
        if (selection !== null) setPeriodSelection({ wallet: walletIdentity, days: selection }); setNow(Date.now()); setMessage(null);
      }}>
        {periodOptions.map(period => <option key={period.days} value={period.days}>{period.days === 'all_time' ? 'All time' : period.label}</option>)}
      </select>
    </div>}</div>
    <div className={`personal-analytics-freshness-panel ${freshness.tone}`}>
      <div className="personal-analytics-report-status" role="status" aria-live="polite">
        <strong><Icon name={freshness.tone === 'working' ? 'refresh' : freshness.tone === 'recent' ? 'check' : freshness.tone === 'warning' ? 'alert' : 'clock'} size={15} className={freshness.tone === 'working' ? 'spinning' : undefined} />{freshness.label}</strong>
        {snapshot && captureValid && <span title={dateTime(snapshot.captured_at)}>{savedHistory ? 'Latest capture' : 'Captured'} <time dateTime={snapshot.captured_at}>{relativeTime(snapshot.captured_at, now)}</time></span>}
        {freshness.message && <p>{freshness.message}</p>}
      </div>
      {freshness.needsReload && <button type="button" className="text-button personal-analytics-reload" disabled={reloading || pending || manualBusy || analyticsStartup?.busy} onClick={() => { void reloadReport(); }}>{reloading ? 'Reloading…' : 'Reload saved data'}</button>}
      {refreshable && marketappAnalyticsRefresh ? <Suspense fallback={<p role="status">Loading refresh…</p>}><MarketappAnalyticsRefresh transport={marketappAnalyticsRefresh} wallet={wallet} periodDays={providerPeriod!} onImported={reloadHistory} startupBusy={analyticsStartup?.busy === true || pending || reloading} onViewChange={setManualRefreshView} showOutcome={freshness.manualNotice === true} savedHistory={savedHistory} /></Suspense> : null}
    </div>
    {snapshot ? <>
      {readLimitMessage && <p className="analytics-read-limit" role="status">{readLimitMessage}</p>}
      <div className="personal-analytics-summary">
        <div><span>Rent volume <small>before fees</small></span><strong>{formatAmount(snapshot.summary.rent_volume, 1)}<small>GRAM</small></strong></div>
        <div><span>Rentals <small>incl. extensions</small></span><strong>{snapshot.summary.rentals.toLocaleString()}</strong>{!savedHistory && <small>{snapshot.summary.items == null ? 'Gift count unavailable' : `${snapshot.summary.items.toLocaleString()} ${snapshot.summary.items === 1 ? 'gift' : 'gifts'}`}</small>}</div>
      </div>
      {savedHistory && allTime && <p className="personal-analytics-coverage" title="All time combines deduplicated saved daily reports. It does not establish rental revenue before the earliest saved date, during missing days, or after the latest capture.">{allTime.coverage.observed_days.toLocaleString()} days saved{allTime.coverage.missing_days > 0 && <> · {allTime.coverage.missing_days.toLocaleString()} days missing</>}{allTime.coverage.partial_days > 0 && <> · {allTime.coverage.partial_days.toLocaleString()} partial</>}</p>}
      <div className="personal-analytics-chart-heading"><h3>Volume <small>GRAM</small></h3><div className="personal-analytics-group-control"><div className="personal-analytics-groups" role="group" aria-label="Chart grouping">
        {GROUPS.map(item => <button type="button" key={item.id} className={renderGroup === item.id ? 'active' : ''} aria-pressed={renderGroup === item.id} disabled={!availableGroups.has(item.id)} title={!availableGroups.has(item.id) ? 'Choose a wider grouping for this long saved history.' : undefined} onClick={() => setGroup(item.id)}>{item.label}</button>)}
      </div></div></div>
      <PersonalAnalyticsChart key={`${snapshot.fingerprint}:${renderGroup}`} buckets={buckets} heights={heights} group={renderGroup}
        label={GROUPS.find(item => item.id === renderGroup)?.label || 'Daily'} interactive={cloud} />
      {buckets.some(bucket => bucket.partial) && <p className="personal-analytics-partial">Light bars: partial {renderGroup === 'year' ? 'years' : 'periods'}.{savedHistory && buckets.some(bucket => bucket.gap) && ' Hatched gaps: missing intervals.'}</p>}
      <details className="personal-analytics-statistics"><summary>More statistics</summary><div>
        <div className="personal-analytics-facts">{savedHistory ? <><span>New rentals <b>{snapshot.summary.new_rentals.toLocaleString()}</b></span><span>Extensions <b>{snapshot.summary.extensions.toLocaleString()}</b></span></> : <><span>Daily price <b>{formatAmount(snapshot.summary.price_per_day)} GRAM</b></span><span>Average duration <b>{snapshot.summary.average_duration ?? '—'} days</b></span><span>Extensions <b>{snapshot.summary.extensions.toLocaleString()} · {snapshot.summary.extension_percent ?? '—'}%</b></span><span>Spent on rent <b>{formatAmount(snapshot.summary.spent_on_rent)} GRAM</b></span></>}</div>
        <dl className="personal-analytics-report-details"><div><dt>Saved dates · UTC</dt><dd>{analyticsPeriod(snapshot.period_start, snapshot.period_end)}</dd></div><div><dt>{savedHistory ? 'Latest included capture' : 'Captured'}</dt><dd>{dateTime(snapshot.captured_at)}</dd></div></dl>
        <p>{savedHistory ? `All time combines saved days, not a complete lifetime total. Overlapping dates count once; missing days remain unknown. ${readLimitMessage ? 'This preview includes only the loaded days. Refresh updates saved reports; it does not remove this display limit.' : 'Refresh adds the annual report and keeps earlier saved days.'}` : 'Today may be incomplete. Daily price is Marketapp’s duration-weighted average.'} Volume is before fees and royalties.</p>
        <div className="personal-analytics-table-wrap"><table><thead><tr><th scope="col">{renderGroup === 'week' ? 'Week (Mon–Sun)' : renderGroup === 'month' ? 'Month' : renderGroup === 'year' ? 'Year' : 'Day'} UTC</th><th scope="col">Volume</th><th scope="col">New</th><th scope="col">Extended</th><th scope="col">Total</th></tr></thead><tbody>{buckets.map(bucket => <tr key={bucket.key}><th scope="row">{renderGroup === 'year' && !bucket.gap && <>{bucket.key.slice(0, 4)} · </>}{analyticsPeriod(bucket.start, bucket.end)}{bucket.partial && <small>{bucket.gap ? 'No saved data' : 'Partial'}</small>}</th><td>{formatAmount(bucket.volume, 1)}</td><td>{bucket.newRentals ?? '—'}</td><td>{bucket.extensions ?? '—'}</td><td>{bucket.rentals ?? '—'}</td></tr>)}</tbody></table></div>
      </div></details>
    </> : <p className="personal-analytics-empty">{refreshable ? 'Refresh to load your rental totals.' : 'Import a Marketapp report to see your rental totals.'}</p>}
    {error && <p className="personal-analytics-error" role="alert">{error}</p>}
    {message && <p className="personal-analytics-message" role="status">{message}</p>}
    {!refreshEnabled && cloud && marketappLoginTest && <Suspense fallback={<p role="status">Loading connection test…</p>}><MarketappLoginTest transport={marketappLoginTest} wallet={wallet} /></Suspense>}
    <details className="personal-analytics-update"><summary>{cloud && marketappAnalyticsRefresh ? 'Import from browser' : snapshot ? 'Update analytics' : 'Import analytics'}</summary><div>
      <ol><li><a href={source} target="_blank" rel="noopener noreferrer">Open Marketapp analytics <Icon name="external" size={14} /></a> and sign in.</li><li>Select <b>all collections</b>, your period, and <b>By day</b>.</li><li>Run the capture bookmarklet on that page. It downloads a JSON snapshot.</li><li>Choose the JSON file below, then press Import.</li></ol>
      <div className="personal-analytics-export"><button type="button" className="button secondary small" onClick={() => { void copyCode(); }}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy bookmarklet'}</button><span role="status" aria-live="polite">{copied ? 'Bookmarklet copied.' : ''}</span></div>
      <details className="personal-analytics-code"><summary>How to run the bookmarklet</summary><p>On desktop, add a browser bookmark and replace its URL with this code. Open Marketapp analytics and click that bookmark. On mobile, use a browser that supports bookmarklets, or capture on desktop and transfer the JSON file.</p><textarea readOnly value={marketappAnalyticsBookmarklet()} aria-label="Marketapp analytics capture bookmarklet" spellCheck={false} /><p>The capture reads only the analytics shown on that page. It never reads login credentials or sends network requests.</p></details>
      {transport ? <div className="personal-analytics-import"><label htmlFor="personal-analytics-file">Analytics JSON <small>up to 256 KB</small></label><input ref={fileInput} id="personal-analytics-file" type="file" accept=".json,application/json" disabled={pending || reloading} onChange={event => { setFile(event.target.files?.[0] || null); setError(null); setMessage(null); }} /><p>{cloud ? 'Import sends this snapshot to your private Telegram dashboard.' : 'Import saves this snapshot in your desktop database.'}</p><button type="button" className="button primary small" disabled={!file || pending || reloading || manualBusy || analyticsStartup?.busy || !importAllowed} onClick={() => { void importFile(); }}>{pending ? 'Importing…' : 'Import snapshot'}</button></div> : <p>Analytics import is unavailable in this version.</p>}
    </div></details>
  </section>{snapshot && <><MarketappTopItems key={`gifts:${walletIdentity}:${selectedDays}`} report={snapshot} wallet={wallet} now={now} images={images.gifts} /><MarketappCollections key={`collections:${walletIdentity}:${selectedDays}`} report={snapshot} wallet={wallet} now={now} images={images.collections} /></>}</>;
}
