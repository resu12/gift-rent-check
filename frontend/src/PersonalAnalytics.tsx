import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { PersonalAnalyticsChart } from './PersonalAnalyticsChart';
import type { DashboardAdapter, MarketappAnalyticsRefreshAdapter, MarketappLoginTestAdapter, PersonalRentalAnalytics } from './data/types';
import { dateTime, formatAmount, relativeTime } from './data/helpers';
import { analyticsBarHeights, analyticsPeriod, canImportPersonalAnalytics, groupPersonalAnalytics, personalAnalyticsSnapshots, personalAnalyticsUrl } from './data/personalAnalytics';
import { analyticsReportDays, analyticsReportOptions, selectAnalyticsReport } from './data/analyticsReports';
import { analyticsFreshnessPresentation } from './data/analyticsFreshness';
import type { AnalyticsGrouping } from './data/personalAnalytics';
import { marketappAnalyticsBookmarklet } from './data/marketappAnalyticsCapture';
import type { AnalyticsStartupSnapshot } from './serverless/analyticsStartup';
import type { MarketappAnalyticsRefreshView } from './serverless/marketappAnalyticsRefreshFlow';
import { canonicalMainnetAddress } from './serverless/walletIdentity';
import './personalAnalytics.css';

const GROUPS: { id: AnalyticsGrouping; label: string }[] = [
  { id: 'day', label: 'Daily' }, { id: 'week', label: 'Weekly' }, { id: 'month', label: 'Monthly' },
  { id: 'year', label: 'Yearly' },
];
const FILE_LIMIT = 256 * 1024;
const MarketappLoginTest = lazy(() => import('./serverless/MarketappLoginTest'));
const MarketappAnalyticsRefresh = lazy(() => import('./serverless/MarketappAnalyticsRefresh'));

export function PersonalAnalytics({ snapshot: latestSnapshot, snapshots: savedSnapshots, wallet, transport, csrf, onImported, cloud = false, marketappLoginTest, marketappAnalyticsRefresh, analyticsStartup, onAnalyticsBusy, initialPeriodDays }: {
  snapshot?: PersonalRentalAnalytics | null;
  snapshots?: PersonalRentalAnalytics[];
  wallet: string | null;
  transport?: DashboardAdapter['personalAnalytics'];
  csrf: string;
  onImported: () => Promise<void>;
  cloud?: boolean;
  marketappLoginTest?: MarketappLoginTestAdapter;
  marketappAnalyticsRefresh?: MarketappAnalyticsRefreshAdapter;
  analyticsStartup?: AnalyticsStartupSnapshot;
  onAnalyticsBusy?: (busy: boolean) => void;
  initialPeriodDays?: number;
}) {
  const walletIdentity = canonicalMainnetAddress(wallet) || wallet;
  const identity = useRef(walletIdentity); identity.current = walletIdentity;
  const [periodSelection, setPeriodSelection] = useState<{ wallet: string | null; days: number } | null>(() =>
    Number.isSafeInteger(initialPeriodDays) && initialPeriodDays! > 0 && initialPeriodDays! <= 366
      ? { wallet: walletIdentity, days: initialPeriodDays! } : null);
  const [manualRefreshView, setManualRefreshView] = useState<MarketappAnalyticsRefreshView | null>(null);
  const [importView, setImportView] = useState<{ days: number; capturedAt: string; fingerprint: string; loading: boolean; reloadFailed?: boolean } | null>(null);
  const refreshEnabled = Boolean(cloud && marketappAnalyticsRefresh);
  const snapshots = useMemo(() => personalAnalyticsSnapshots(latestSnapshot, savedSnapshots), [latestSnapshot, savedSnapshots]);
  const periodOptions = useMemo(() => analyticsReportOptions(snapshots, refreshEnabled), [snapshots, refreshEnabled]);
  const selectedDays = analyticsReportDays(snapshots, walletIdentity, periodSelection);
  const snapshot = selectAnalyticsReport(snapshots, selectedDays);
  const refreshable = refreshEnabled && (selectedDays === 30 || selectedDays === 365);
  const [now, setNow] = useState(Date.now);
  const [group, setGroup] = useState<AnalyticsGrouping>('day');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    const timer = window.setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update); window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); };
  }, []);
  useEffect(() => {
    setManualRefreshView(null); setImportView(null); setMessage(null); setError(null); setPending(false); setReloading(false); setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }, [walletIdentity]);
  useEffect(() => { setNow(Date.now()); }, [snapshot?.captured_at, manualRefreshView?.capturedAt, analyticsStartup?.capturedAt]);
  useEffect(() => { setGroup(selectedDays > 90 ? 'week' : 'day'); }, [selectedDays]);
  const buckets = useMemo(() => snapshot ? groupPersonalAnalytics(snapshot, group) : [], [snapshot, group]);
  const heights = useMemo(() => analyticsBarHeights(buckets), [buckets]);
  const source = personalAnalyticsUrl(wallet, snapshot);
  const importAllowed = canImportPersonalAnalytics(cloud, csrf, Boolean(transport));
  const manualBusy = Boolean(manualRefreshView?.loadingSaved || manualRefreshView?.statusChecking ||
    ['preparing', 'choosing', 'awaiting_approval', 'updating', 'reconciling', 'confirming', 'disconnecting'].includes(manualRefreshView?.phase || ''));
  const freshness = analyticsFreshnessPresentation(snapshot, selectedDays, { now, refreshable,
    startup: refreshEnabled ? analyticsStartup : undefined, manual: manualRefreshView, imported: importView ?? undefined });
  const captured = snapshot ? Date.parse(snapshot.captured_at) : NaN;
  const captureValid = Number.isFinite(captured) && captured <= now + 30_000;
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    onAnalyticsBusy?.(manualBusy || pending || reloading);
    return () => { onAnalyticsBusy?.(false); };
  }, [manualBusy, pending, reloading, onAnalyticsBusy]);
  const reloadReport = async () => {
    if (reloading) return;
    const savedIdentity = identity.current;
    setReloading(true); setError(null);
    try { await onImported(); }
    catch { if (mounted.current && identity.current === savedIdentity) setError('Could not reload saved data. The previously loaded figures remain visible.'); }
    finally { if (mounted.current && identity.current === savedIdentity) setReloading(false); }
  };
  const copyCode = async () => {
    setCopied(false);
    try { await navigator.clipboard.writeText(marketappAnalyticsBookmarklet()); setCopied(true); }
    catch { setError('Clipboard is unavailable. Copy the code from the field below.'); }
  };
  const importFile = async () => {
    if (!file || pending || manualBusy || analyticsStartup?.busy || !transport || !importAllowed) return;
    const savedIdentity = identity.current;
    let saved = false;
    setError(null); setMessage(null); setPending(true);
    try {
      if (file.size > FILE_LIMIT) throw new Error('Choose an analytics JSON file smaller than 256 KB.');
      const raw = await file.text();
      if (!mounted.current || identity.current !== savedIdentity) return;
      const imported = await transport.importSnapshot(raw, csrf);
      saved = true;
      if (mounted.current && identity.current === savedIdentity) {
        setFile(null); if (fileInput.current) fileInput.current.value = '';
        setPeriodSelection({ wallet: savedIdentity, days: imported.daily.length });
        setImportView({ days: imported.daily.length, capturedAt: imported.captured_at, fingerprint: imported.fingerprint, loading: true });
        setMessage('Report saved. Loading the saved figures…');
      }
      if (!mounted.current || identity.current !== savedIdentity) return;
      await onImported();
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
  return <section className="panel personal-analytics" aria-labelledby="personal-analytics-title">
    <div className="personal-analytics-heading"><div><h2 id="personal-analytics-title">Rental analytics</h2>
      <p>{snapshot ? <span>{analyticsPeriod(snapshot.period_start, snapshot.period_end)} UTC</span> : 'Your personal Marketapp analytics'}</p>
    </div>{periodOptions.length > 0 && <div className="personal-analytics-period">
      <label htmlFor="personal-analytics-period">Report period</label>
      <select id="personal-analytics-period" value={selectedDays} disabled={pending || manualBusy} onChange={event => {
        setPeriodSelection({ wallet: walletIdentity, days: Number(event.target.value) }); setNow(Date.now()); setMessage(null);
      }}>
        {periodOptions.map(period => <option key={period.days} value={period.days}>{period.label}{period.saved ? '' : ' · Not saved'}</option>)}
      </select>
    </div>}</div>
    <div className={`personal-analytics-freshness-panel ${freshness.tone}`}>
      <div className="personal-analytics-report-status" role="status" aria-live="polite">
        <strong><Icon name={freshness.tone === 'working' ? 'refresh' : freshness.tone === 'recent' ? 'check' : freshness.tone === 'warning' ? 'alert' : 'clock'} size={15} className={freshness.tone === 'working' ? 'spinning' : undefined} />{freshness.label}</strong>
        {snapshot && captureValid && <span title={dateTime(snapshot.captured_at)}>Captured <time dateTime={snapshot.captured_at}>{relativeTime(snapshot.captured_at, now)}</time></span>}
        {freshness.message && <p>{freshness.message}</p>}
      </div>
      {freshness.needsReload && <button type="button" className="text-button personal-analytics-reload" disabled={reloading} onClick={() => { void reloadReport(); }}>{reloading ? 'Reloading…' : 'Reload saved data'}</button>}
      {refreshable && marketappAnalyticsRefresh ? <Suspense fallback={<p role="status">Loading refresh…</p>}><MarketappAnalyticsRefresh transport={marketappAnalyticsRefresh} wallet={wallet} periodDays={selectedDays as 30 | 365} onImported={onImported} startupBusy={analyticsStartup?.busy === true || pending || reloading} onViewChange={setManualRefreshView} showOutcome={freshness.manualNotice === true} /></Suspense> : null}
    </div>
    {snapshot ? <>
      <div className="personal-analytics-summary">
        <div><span>Rent volume <small>before fees</small></span><strong>{formatAmount(snapshot.summary.rent_volume, 1)}<small>GRAM</small></strong></div>
        <div><span>Rentals <small>incl. extensions</small></span><strong>{snapshot.summary.rentals.toLocaleString()}</strong><small>{snapshot.summary.items == null ? 'Gift count unavailable' : `${snapshot.summary.items.toLocaleString()} ${snapshot.summary.items === 1 ? 'gift' : 'gifts'}`}</small></div>
      </div>
      <div className="personal-analytics-chart-heading"><h3>Volume <small>GRAM</small></h3><div className="personal-analytics-group-control"><div className="personal-analytics-groups" role="group" aria-label="Chart grouping">
        {GROUPS.map(item => <button type="button" key={item.id} className={group === item.id ? 'active' : ''} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}
      </div></div></div>
      <PersonalAnalyticsChart key={`${snapshot.fingerprint}:${group}`} buckets={buckets} heights={heights} group={group}
        label={GROUPS.find(item => item.id === group)?.label || 'Daily'} interactive={cloud} />
      {buckets.some(bucket => bucket.partial) && <p className="personal-analytics-partial">Light bars: partial {group === 'year' ? 'years' : 'periods'}.</p>}
      <details className="personal-analytics-statistics"><summary>More statistics</summary><div>
        <div className="personal-analytics-facts"><span>Daily price <b>{formatAmount(snapshot.summary.price_per_day)} GRAM</b></span><span>Average duration <b>{snapshot.summary.average_duration ?? '—'} days</b></span><span>Extensions <b>{snapshot.summary.extensions.toLocaleString()} · {snapshot.summary.extension_percent ?? '—'}%</b></span><span>Spent on rent <b>{formatAmount(snapshot.summary.spent_on_rent)} GRAM</b></span></div>
        <p>Captured {dateTime(snapshot.captured_at)}. These are saved figures; today may still be incomplete. Volume is before marketplace fees and royalties. Daily price is Marketapp’s duration-weighted average.</p>
        <div className="personal-analytics-table-wrap"><table><thead><tr><th scope="col">{group === 'week' ? 'Week (Mon–Sun)' : group === 'month' ? 'Month' : group === 'year' ? 'Year' : 'Day'} UTC</th><th scope="col">Volume</th><th scope="col">New</th><th scope="col">Extended</th><th scope="col">Total</th></tr></thead><tbody>{buckets.map(bucket => <tr key={bucket.key}><th scope="row">{group === 'year' && <>{bucket.key.slice(0, 4)} · </>}{analyticsPeriod(bucket.start, bucket.end)}{bucket.partial && <small>Partial</small>}</th><td>{formatAmount(bucket.volume, 1)}</td><td>{bucket.newRentals}</td><td>{bucket.extensions}</td><td>{bucket.rentals}</td></tr>)}</tbody></table></div>
      </div></details>
    </> : <p className="personal-analytics-empty">{refreshable ? 'Press Refresh to load this reporting period.' : 'Import your Marketapp report to see your rental totals.'}</p>}
    {error && <p className="personal-analytics-error" role="alert">{error}</p>}
    {message && <p className="personal-analytics-message" role="status">{message}</p>}
    {!refreshEnabled && cloud && marketappLoginTest && <Suspense fallback={<p role="status">Loading connection test…</p>}><MarketappLoginTest transport={marketappLoginTest} wallet={wallet} /></Suspense>}
    <details className="personal-analytics-update"><summary>{cloud && marketappAnalyticsRefresh ? 'Import from browser' : snapshot ? 'Update analytics' : 'Import analytics'}</summary><div>
      <ol><li><a href={source} target="_blank" rel="noopener noreferrer">Open Marketapp analytics <Icon name="external" size={14} /></a> and sign in.</li><li>Select <b>all collections</b>, your period, and <b>By day</b>.</li><li>Run the capture bookmarklet on that page. It downloads a JSON snapshot.</li><li>Choose the JSON file below, then press Import.</li></ol>
      <div className="personal-analytics-export"><button type="button" className="button secondary small" onClick={() => { void copyCode(); }}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy bookmarklet'}</button><span role="status" aria-live="polite">{copied ? 'Bookmarklet copied.' : ''}</span></div>
      <details className="personal-analytics-code"><summary>How to run the bookmarklet</summary><p>On desktop, add a browser bookmark and replace its URL with this code. Open Marketapp analytics and click that bookmark. On mobile, use a browser that supports bookmarklets, or capture on desktop and transfer the JSON file.</p><textarea readOnly value={marketappAnalyticsBookmarklet()} aria-label="Marketapp analytics capture bookmarklet" spellCheck={false} /><p>The capture reads only the analytics shown on that page. It never reads login credentials or sends network requests.</p></details>
      {transport ? <div className="personal-analytics-import"><label htmlFor="personal-analytics-file">Analytics JSON <small>up to 256 KB</small></label><input ref={fileInput} id="personal-analytics-file" type="file" accept=".json,application/json" disabled={pending} onChange={event => { setFile(event.target.files?.[0] || null); setError(null); setMessage(null); }} /><p>{cloud ? 'Import sends this snapshot to your private Telegram dashboard.' : 'Import saves this snapshot in your desktop database.'}</p><button type="button" className="button primary small" disabled={!file || pending || manualBusy || analyticsStartup?.busy || !importAllowed} onClick={() => { void importFile(); }}>{pending ? 'Importing…' : 'Import snapshot'}</button></div> : <p>Analytics import is unavailable in this version.</p>}
    </div></details>
  </section>;
}
