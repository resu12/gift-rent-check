import { useId, useMemo, useState } from 'react';
import type { PersonalRentalAnalyticsReport } from './data/types';
import { Icon } from './Icons';
import { AnalyticsThumbnail } from './AnalyticsThumbnail';
import { dateTime, formatAmount } from './data/helpers';
import { analyticsPeriod, analyticsReportingPeriod } from './data/personalAnalytics';
import { marketappItemUrl, marketappTopItems, sortTopItems, type TopItemSort } from './data/marketappTopItems';
import { canonicalMainnetAddress } from './serverless/walletIdentity';
import { analyticsReadLimitMessage } from './data/analyticsReadCoverage';
import './giftRentalStatistics.css';

export function MarketappTopItems({ report, wallet, now, images }: { report: PersonalRentalAnalyticsReport | null; wallet: string | null; now: number; images?: ReadonlyMap<string, string> }) {
  const titleId = useId(), searchId = useId(), sortId = useId();
  const [search, setSearch] = useState(''), [sort, setSort] = useState<TopItemSort>('volume'), [limit, setLimit] = useState(8);
  const top = useMemo(() => marketappTopItems(report, wallet, now), [report, wallet, now]);
  const rows = useMemo(() => sortTopItems(top?.items || [], search, sort), [top, search, sort]);
  const allTime = report && 'report_kind' in report && report.report_kind === 'all_time';
  const readLimitMessage = analyticsReadLimitMessage(report, 'items');
  return <section className="panel gift-rental-overview marketapp-top-items" aria-labelledby={titleId}>
    <div className="gift-rental-heading"><h2 id={titleId}><Icon name="gift" size={18} />By gift</h2>{report && <span>{analyticsReportingPeriod(report)}</span>}</div>
    <p className="gift-rental-caption">GRAM · before fees</p>
    {readLimitMessage && <p className="analytics-read-limit" role="status">{readLimitMessage}</p>}
    {top ? <>
      <p className="top-items-coverage">{allTime ? 'Partial history · coverage varies by gift' : 'Marketapp’s reported gifts only'}</p>
      {top.items.length > 0 && <div className="gift-rental-controls">
        <div className="gift-rental-search"><label className="sr-only" htmlFor={searchId}>Search Marketapp top items</label><Icon name="search" size={16} /><input id={searchId} type="search" placeholder="Find a gift…" value={search} onChange={event => { setSearch(event.target.value); setLimit(8); }} /></div>
        <label className="gift-rental-sort" htmlFor={sortId}><span className="sr-only">Sort gifts by</span><select id={sortId} value={sort} onChange={event => { setSort(event.target.value as TopItemSort); setLimit(8); }}>
          <option value="volume">Highest volume</option><option value="rentals">Most rentals</option><option value="days">Most rented days</option><option value="name">Gift name</option>
        </select></label>
      </div>}
      {rows.length > 0 ? <>
        <div className="gift-rental-columns" aria-hidden="true"><span>Gift</span><span>Rentals</span><span>Volume</span><span>Price / day</span></div>
        <ul className="gift-rental-list">{rows.slice(0, limit).map(item => <li key={item.item_key}><details className="top-item-detail">
          <summary className="gift-rental-row" aria-label={`${item.name}. ${item.rentals} rentals. ${item.rented_days} rented days. Volume ${item.volume} GRAM before fees. Price per day ${item.price_per_day === null ? 'unknown' : `${item.price_per_day} GRAM`}. Show report details.`}>
            <span className="gift-rental-identity"><AnalyticsThumbnail src={images?.get(canonicalMainnetAddress(item.item_key) || '')} kind="gift" label={`Picture of ${item.name}`} /><span><strong>{item.name}</strong>{allTime && item.coverage && <small>{item.coverage.observed_days.toLocaleString()} days saved{item.coverage.missing_days > 0 && <> · {item.coverage.missing_days.toLocaleString()} missing</>}{item.coverage.partial_days > 0 && <> · {item.coverage.partial_days.toLocaleString()} partial</>}</small>}</span><Icon name="chevron" size={14} /></span>
            <span className="gift-rental-metric"><small>Rentals</small><b>{item.rentals.toLocaleString()}</b></span>
            <span className="gift-rental-metric gift-rental-volume" title={`${item.volume} GRAM`}><small>Volume · GRAM</small><b>{formatAmount(item.volume, 1)}</b></span>
            <span className="gift-rental-metric"><small>Price / day</small><b>{formatAmount(item.price_per_day, 3)}</b></span>
          </summary>
          <div className="top-item-evidence"><dl><div><dt>Rented days</dt><dd>{item.rented_days}</dd></div><div><dt>Exact volume · GRAM</dt><dd>{item.volume}</dd></div></dl>
            {allTime && item.coverage ? <><p>Saved reports cover {item.coverage.observed_days.toLocaleString()} days{item.coverage.missing_days > 0 && ` · ${item.coverage.missing_days.toLocaleString()} days missing`}{item.coverage.partial_days > 0 && ` · ${item.coverage.partial_days} partial`}. This is not a complete lifetime total.</p><ul>{item.coverage.periods.map(period => <li key={period.period_start}>{analyticsPeriod(period.period_start, period.period_end)} UTC · captured {dateTime(period.captured_at)}</li>)}</ul></> : <p>{analyticsPeriod(report!.period_start, report!.period_end)} UTC · captured {dateTime(report!.captured_at)}.</p>}
            <a href={marketappItemUrl(item)!} target="_blank" rel="noopener noreferrer">Open gift in Marketapp <Icon name="external" size={14} /></a>
          </div>
        </details></li>)}</ul>
        <div className="gift-rental-footer"><span role="status">{Math.min(limit, rows.length)} / {rows.length} gifts</span>{rows.length > limit && <button type="button" className="button secondary small" onClick={() => setLimit(value => value + 8)}>Show more</button>}</div>
      </> : <p className="gift-rental-empty">{search.trim() ? 'No matching gifts.' : readLimitMessage ? 'No gift totals in this loaded history. Saved reports may exist outside this preview.' : 'No gifts reported for this period. Unreported totals remain unknown.'}</p>}
      <details className="gift-rental-method"><summary>Report details</summary><p>{allTime ? 'Marketapp’s Top items cover selected periods, not each day. Each gift uses non-overlapping reports; coverage may differ from the chart. Unreported gifts and missing periods remain unknown. Combined reports use volume divided by rented days for the daily price.' : 'Marketapp’s Top items for the selected period. Unreported gifts have unknown totals, not zero rentals.'}</p><p>Volume is before fees and royalties. Expand a gift for exact amounts and dates. Refresh analytics above to update the report.</p></details>
    </> : <p className="gift-rental-empty">{readLimitMessage ? 'No gift totals in this loaded history. Saved reports may exist outside this preview.' : 'Gift totals unavailable. Refresh analytics above to load them.'}</p>}
  </section>;
}
