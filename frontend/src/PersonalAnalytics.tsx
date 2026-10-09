import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import type { DashboardAdapter, MarketappAnalyticsRefreshAdapter, MarketappLoginTestAdapter, PersonalRentalAnalytics } from './data/types';
import { dateTime, formatAmount } from './data/helpers';
import { analyticsBarHeights, analyticsDate, analyticsPeriod, analyticsReportingPeriod, canImportPersonalAnalytics, groupPersonalAnalytics, personalAnalyticsPeriodOptions, personalAnalyticsSnapshots, personalAnalyticsUrl, selectPersonalAnalyticsSnapshot } from './data/personalAnalytics';
import type { AnalyticsGrouping } from './data/personalAnalytics';
import { marketappAnalyticsBookmarklet } from './data/marketappAnalyticsCapture';
import './personalAnalytics.css';

const GROUPS: { id: AnalyticsGrouping; label: string }[] = [
  { id: 'day', label: 'Daily' }, { id: 'week', label: 'Weekly' }, { id: 'month', label: 'Monthly' },
  { id: 'year', label: 'By year' },
];
const FILE_LIMIT = 256 * 1024;
const MarketappLoginTest = lazy(() => import('./serverless/MarketappLoginTest'));
const MarketappAnalyticsRefresh = lazy(() => import('./serverless/MarketappAnalyticsRefresh'));

export function PersonalAnalytics({ snapshot: latestSnapshot, snapshots: savedSnapshots, wallet, transport, csrf, onImported, cloud = false, marketappLoginTest, marketappAnalyticsRefresh }: {
  snapshot?: PersonalRentalAnalytics | null;
  snapshots?: PersonalRentalAnalytics[];
  wallet: string | null;
  transport?: DashboardAdapter['personalAnalytics'];
  csrf: string;
  onImported: () => Promise<void>;
  cloud?: boolean;
  marketappLoginTest?: MarketappLoginTestAdapter;
  marketappAnalyticsRefresh?: MarketappAnalyticsRefreshAdapter;
}) {
  const [periodSelection, setPeriodSelection] = useState<{ latest: string | null; selected: string | null }>({ latest: null, selected: null });
  const latestFingerprint = latestSnapshot?.fingerprint || null;
  const snapshots = useMemo(() => personalAnalyticsSnapshots(latestSnapshot, savedSnapshots), [latestSnapshot, savedSnapshots]);
  const periodOptions = useMemo(() => personalAnalyticsPeriodOptions(snapshots), [snapshots]);
  const snapshot = selectPersonalAnalyticsSnapshot(latestSnapshot, snapshots, periodSelection.latest === latestFingerprint ? periodSelection.selected : null);
  const [group, setGroup] = useState<AnalyticsGrouping>('day');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setGroup((snapshot?.daily.length || 0) > 90 ? 'week' : 'day'); }, [snapshot?.fingerprint]);
  const buckets = useMemo(() => snapshot ? groupPersonalAnalytics(snapshot, group) : [], [snapshot, group]);
  const heights = useMemo(() => analyticsBarHeights(buckets), [buckets]);
  const source = personalAnalyticsUrl(wallet, snapshot);
  const importAllowed = canImportPersonalAnalytics(cloud, csrf, Boolean(transport));
  const copyCode = async () => {
    setCopied(false);
    try { await navigator.clipboard.writeText(marketappAnalyticsBookmarklet()); setCopied(true); }
    catch { setError('Clipboard is unavailable. Copy the code from the field below.'); }
  };
  const importFile = async () => {
    if (!file || pending || !transport || !importAllowed) return;
    setError(null); setMessage(null); setPending(true);
    try {
      if (file.size > FILE_LIMIT) throw new Error('Choose an analytics JSON file smaller than 256 KB.');
      const raw = await file.text();
      await transport.importSnapshot(raw, csrf);
      if (mounted.current) {
        setFile(null); if (fileInput.current) fileInput.current.value = '';
        setMessage('Analytics saved.');
      }
      await onImported();
    } catch (problem) {
      if (mounted.current) setError(problem instanceof Error ? problem.message : 'Could not import analytics. Your saved snapshot is unchanged.');
    } finally { if (mounted.current) setPending(false); }
  };
  return <section className="panel personal-analytics" aria-labelledby="personal-analytics-title">
    <div className="personal-analytics-heading"><div><h2 id="personal-analytics-title">Rental income</h2>
      <p>{snapshot ? <><span>{analyticsPeriod(snapshot.period_start, snapshot.period_end)} UTC</span> · <span title={dateTime(snapshot.captured_at)}>Saved {dateTime(snapshot.captured_at, true)}</span></> : 'Your personal Marketapp analytics'}</p>
    </div><span className="personal-analytics-saved">{snapshot ? 'Saved snapshot' : 'Not imported'}</span></div>
    {snapshot ? <>
      <div className="personal-analytics-period">{snapshots.length > 1 ? <label htmlFor="personal-analytics-period">Reporting period</label> : <span>Reporting period</span>}
        {snapshots.length > 1 ? <select id="personal-analytics-period" value={snapshot.fingerprint} onChange={event => setPeriodSelection({ latest: latestFingerprint, selected: event.target.value })}>
          {periodOptions.map(period => <option key={period.fingerprint} value={period.fingerprint}>{period.label}</option>)}
        </select> : <strong>{analyticsReportingPeriod(snapshot)}</strong>}
      </div>
      <div className="personal-analytics-summary">
        <div><span>Volume <small>before fees</small></span><strong>{formatAmount(snapshot.summary.rent_volume)}<small>GRAM</small></strong></div>
        <div><span>Rentals <small>incl. extensions</small></span><strong>{snapshot.summary.rentals.toLocaleString()}</strong></div>
        <div><span>Rented items</span><strong>{snapshot.summary.items == null ? '—' : snapshot.summary.items.toLocaleString()}</strong></div>
      </div>
      <div className="personal-analytics-chart-heading"><h3>Rent volume <small>GRAM</small></h3><div className="personal-analytics-group-control"><span>Group chart by</span><div className="personal-analytics-groups" aria-label="Chart grouping">
        {GROUPS.map(item => <button type="button" key={item.id} className={group === item.id ? 'active' : ''} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}
      </div></div></div>
      <div className="personal-analytics-chart" role="img" aria-label={`${GROUPS.find(item => item.id === group)?.label} rental volume. Exact values are in Statistics below.`}>
        <div className="personal-analytics-bars" style={{ gap: buckets.length > 90 ? 0 : undefined }}>{buckets.map((bucket, index) => <div key={bucket.key} className={`personal-analytics-bar${bucket.partial ? ' partial' : ''}${bucket.volume === '0' ? ' zero' : ''}`} title={`${analyticsPeriod(bucket.start, bucket.end)}: ${formatAmount(bucket.volume)} GRAM, ${bucket.rentals} rentals${bucket.partial ? ' (partial period)' : ''}`}><span style={{ height: `${heights[index]}%` }} /></div>)}</div>
        {buckets.length > 0 && <div className="personal-analytics-axis"><span>{group === 'year' ? buckets[0].key.slice(0, 4) : analyticsDate(buckets[0].start)}</span>{(group !== 'year' || buckets.length > 1) && <span>{group === 'year' ? buckets[buckets.length - 1].key.slice(0, 4) : analyticsDate(buckets[buckets.length - 1].end)}</span>}</div>}
      </div>
      {buckets.some(bucket => bucket.partial) && <p className="personal-analytics-partial">{group === 'year' ? 'Partial year · saved dates only.' : 'Lighter bars are partial periods, including the capture day.'}</p>}
      <details className="personal-analytics-statistics"><summary>Statistics & details</summary><div>
        <div className="personal-analytics-facts"><span>Daily price <b>{formatAmount(snapshot.summary.price_per_day)} GRAM</b></span><span>Average duration <b>{snapshot.summary.average_duration ?? '—'} days</b></span><span>Extensions <b>{snapshot.summary.extensions.toLocaleString()} · {snapshot.summary.extension_percent ?? '—'}%</b></span><span>Spent on rent <b>{formatAmount(snapshot.summary.spent_on_rent)} GRAM</b></span></div>
        <p>Volume covers this saved period, before marketplace fees and royalties. Daily price is Marketapp’s duration-weighted average. This is separate from your current gift prices.</p>
        <div className="personal-analytics-table-wrap"><table><thead><tr><th scope="col">{group === 'week' ? 'Week (Mon–Sun)' : group === 'month' ? 'Month' : group === 'year' ? 'Year' : 'Day'} UTC</th><th scope="col">Volume</th><th scope="col">New</th><th scope="col">Extended</th><th scope="col">Total</th></tr></thead><tbody>{buckets.map(bucket => <tr key={bucket.key}><th scope="row">{group === 'year' && <>{bucket.key.slice(0, 4)} · </>}{analyticsPeriod(bucket.start, bucket.end)}{bucket.partial && <small>Partial</small>}</th><td>{formatAmount(bucket.volume)}</td><td>{bucket.newRentals}</td><td>{bucket.extensions}</td><td>{bucket.rentals}</td></tr>)}</tbody></table></div>
      </div></details>
    </> : <p className="personal-analytics-empty">{cloud && marketappAnalyticsRefresh ? 'Refresh or import' : 'Import'} your 30-day or 1-year Marketapp report to see personal rental totals.</p>}
    {error && <p className="personal-analytics-error" role="alert">{error}</p>}
    {message && <p className="personal-analytics-message" role="status">{message}</p>}
    {cloud && marketappAnalyticsRefresh ? <Suspense fallback={<p role="status">Loading analytics refresh…</p>}><MarketappAnalyticsRefresh transport={marketappAnalyticsRefresh} wallet={wallet} periodDays={snapshot?.daily.length === 365 ? 365 : 30} onImported={onImported} /></Suspense>
      : cloud && marketappLoginTest && <Suspense fallback={<p role="status">Loading connection test…</p>}><MarketappLoginTest transport={marketappLoginTest} wallet={wallet} /></Suspense>}
    <details className="personal-analytics-update"><summary>{cloud && marketappAnalyticsRefresh ? 'Import from browser' : snapshot ? 'Update analytics' : 'Import analytics'}</summary><div>
      <ol><li><a href={source} target="_blank" rel="noopener noreferrer">Open Marketapp analytics <Icon name="external" size={14} /></a> and sign in.</li><li>Select <b>all collections</b>, your period, and <b>By day</b>.</li><li>Run the capture bookmarklet on that page. It downloads a JSON snapshot.</li><li>Choose the JSON file below, then press Import.</li></ol>
      <div className="personal-analytics-export"><button type="button" className="button secondary small" onClick={() => { void copyCode(); }}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy bookmarklet'}</button><span role="status" aria-live="polite">{copied ? 'Bookmarklet copied.' : ''}</span></div>
      <details className="personal-analytics-code"><summary>How to run the bookmarklet</summary><p>On desktop, add a browser bookmark and replace its URL with this code. Open Marketapp analytics and click that bookmark. On mobile, use a browser that supports bookmarklets, or capture on desktop and transfer the JSON file.</p><textarea readOnly value={marketappAnalyticsBookmarklet()} aria-label="Marketapp analytics capture bookmarklet" spellCheck={false} /><p>The capture reads only the analytics shown on that page. It never reads login credentials or sends network requests.</p></details>
      {transport ? <div className="personal-analytics-import"><label htmlFor="personal-analytics-file">Analytics JSON <small>up to 256 KB</small></label><input ref={fileInput} id="personal-analytics-file" type="file" accept=".json,application/json" disabled={pending} onChange={event => { setFile(event.target.files?.[0] || null); setError(null); setMessage(null); }} /><p>{cloud ? 'Import sends this snapshot to your private Telegram dashboard.' : 'Import saves this snapshot in your desktop database.'}</p><button type="button" className="button primary small" disabled={!file || pending || !importAllowed} onClick={() => { void importFile(); }}>{pending ? 'Importing…' : 'Import snapshot'}</button></div> : <p>Analytics import is unavailable in this version.</p>}
    </div></details>
  </section>;
}
