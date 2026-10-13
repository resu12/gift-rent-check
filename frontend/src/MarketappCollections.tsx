import { useId, useMemo, useState } from 'react';
import type { PersonalRentalAnalyticsReport } from './data/types';
import { Icon } from './Icons';
import { AnalyticsThumbnail } from './AnalyticsThumbnail';
import { dateTime, formatAmount } from './data/helpers';
import { analyticsPeriod, analyticsReportingPeriod } from './data/personalAnalytics';
import { marketappCollections, sortCollectionAnalytics, type CollectionAnalyticsSort } from './data/marketappCollections';
import './giftRentalStatistics.css';

export function MarketappCollections({ report, wallet, now, images }: { report: PersonalRentalAnalyticsReport | null; wallet: string | null; now: number; images?: ReadonlyMap<string, string> }) {
  const titleId = useId(), searchId = useId(), sortId = useId();
  const [search, setSearch] = useState(''), [sort, setSort] = useState<CollectionAnalyticsSort>('volume'), [limit, setLimit] = useState(8);
  const collections = useMemo(() => marketappCollections(report, wallet, now), [report, wallet, now]);
  const rows = useMemo(() => sortCollectionAnalytics(collections?.items || [], search, sort), [collections, search, sort]);
  const allTime = report && 'report_kind' in report && report.report_kind === 'all_time';
  return <section className="panel gift-rental-overview marketapp-collections" aria-labelledby={titleId}>
    <div className="gift-rental-heading"><h2 id={titleId}><Icon name="layers" size={18} />By collection</h2>{report && <span>{analyticsReportingPeriod(report)}</span>}</div>
    <p className="gift-rental-caption">GRAM · before fees</p>
    {collections ? <>
      {allTime && <p className="top-items-coverage">Partial history · coverage varies by collection</p>}
      {collections.items.length > 0 && <div className="gift-rental-controls">
        <div className="gift-rental-search"><label className="sr-only" htmlFor={searchId}>Search rental collections</label><Icon name="search" size={16} /><input id={searchId} type="search" placeholder="Find a collection…" value={search} onChange={event => { setSearch(event.target.value); setLimit(8); }} /></div>
        <label className="gift-rental-sort" htmlFor={sortId}><span className="sr-only">Sort collections by</span><select id={sortId} value={sort} onChange={event => { setSort(event.target.value as CollectionAnalyticsSort); setLimit(8); }}>
          <option value="volume">Highest volume</option><option value="rentals">Most rentals</option><option value="name">Collection name</option>
        </select></label>
      </div>}
      {rows.length > 0 ? <>
        <div className="gift-rental-columns" aria-hidden="true"><span>Collection</span><span>Rentals</span><span>Volume</span><span>Price / day</span></div>
        <ul className="gift-rental-list">{rows.slice(0, limit).map(item => <li key={item.collection_key}><details className="top-item-detail">
          <summary className="gift-rental-row" aria-label={`${item.name}. ${item.rentals} rentals. Volume ${item.volume} GRAM before fees. Price per day ${item.price_per_day === null ? 'unknown' : `${item.price_per_day} GRAM`}. Show report details.`}>
            <span className="gift-rental-identity"><AnalyticsThumbnail src={images?.get(item.collection_key)} kind="collection" label={`Example gift from ${item.name}`} /><span><strong>{item.name}</strong>{allTime && item.coverage && <small>{item.coverage.observed_days.toLocaleString()} days saved{item.coverage.missing_days > 0 && <> · {item.coverage.missing_days.toLocaleString()} missing</>}{item.coverage.partial_days > 0 && <> · {item.coverage.partial_days.toLocaleString()} partial</>}</small>}</span><Icon name="chevron" size={14} /></span>
            <span className="gift-rental-metric"><small>Rentals</small><b>{item.rentals.toLocaleString()}</b></span>
            <span className="gift-rental-metric gift-rental-volume" title={`${item.volume} GRAM`}><small>Volume · GRAM</small><b>{formatAmount(item.volume, 1)}</b></span>
            <span className="gift-rental-metric"><small>Price / day</small><b>{formatAmount(item.price_per_day, 3)}</b></span>
          </summary>
          <div className="top-item-evidence"><p>Exact volume: <b>{item.volume} GRAM</b> · before fees and royalties.</p>
            {allTime && item.coverage ? <><p>Saved reports cover {item.coverage.observed_days.toLocaleString()} days{item.coverage.missing_days > 0 && ` · ${item.coverage.missing_days.toLocaleString()} days missing`}{item.coverage.partial_days > 0 && ` · ${item.coverage.partial_days} partial`}. This is not a complete lifetime total.</p><ul>{item.coverage.periods.map(period => <li key={period.period_start}>{analyticsPeriod(period.period_start, period.period_end)} UTC · captured {dateTime(period.captured_at)}</li>)}</ul>{item.coverage.periods.length > 1 && <p>Price per day is unavailable for combined reports: Marketapp does not supply rented days by collection.</p>}</> : <p>{analyticsPeriod(report!.period_start, report!.period_end)} UTC · captured {dateTime(report!.captured_at)}.</p>}
          </div>
        </details></li>)}</ul>
        <div className="gift-rental-footer"><span role="status">{Math.min(limit, rows.length)} / {rows.length} collections</span>{rows.length > limit && <button type="button" className="button secondary small" onClick={() => setLimit(value => value + 8)}>Show more</button>}</div>
      </> : <p className="gift-rental-empty">{search.trim() ? 'No matching collections.' : 'No collections reported for this period. Unreported totals remain unknown.'}</p>}
      <details className="gift-rental-method"><summary>Report details</summary><p>{allTime ? 'Each collection uses non-overlapping saved reports. Missing periods remain unknown. Combined reports have no daily price because Marketapp does not supply rented days by collection.' : 'Marketapp’s By collection totals for the selected period, independent of its limited Top items list.'}</p><p>Volume is before fees and royalties. Expand a collection for exact amounts and dates. Refresh analytics above to update the report.</p></details>
    </> : <p className="gift-rental-empty">Collection totals unavailable. Refresh analytics above to load them.</p>}
  </section>;
}
