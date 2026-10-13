import { useId, useMemo, useState } from 'react';
import type { Gift, GiftRentalStatistics as Statistics } from './data/types';
import { Icon } from './Icons';
import { dateTime, humanize, safeExternalUrl } from './data/helpers';
import { giftRentalAmount, giftRentalStatistics, rentalStatisticsRows, type GiftRentalSort } from './data/giftRentalStatistics';
import './giftRentalStatistics.css';

const NOTE = 'Saved rental starts and GRAM payments only. Coverage may be incomplete and rentals may predate your ownership. Volume is before fees, not verified wallet income. Extensions are excluded.';
const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString();
const pending = (stats: Statistics | null) => (stats?.verified_rentals_without_history ?? 0) > 0;

export function GiftRentalOverview({ gifts, onSelect, onStatus }: { gifts: Gift[]; onSelect(gift: Gift): void; onStatus(): void }) {
  const titleId = useId(), searchId = useId(), sortId = useId();
  const [query, setQuery] = useState(''), [sort, setSort] = useState<GiftRentalSort>('volume'), [limit, setLimit] = useState(8);
  const rows = useMemo(() => rentalStatisticsRows(gifts, query, sort), [gifts, query, sort]);
  const known = rows.filter(row => row.stats).length;
  const hasMore = rows.length > limit;
  return <section className="panel gift-rental-overview" aria-labelledby={titleId}>
    <div className="gift-rental-heading"><h2 id={titleId}><Icon name="gift" size={18} />Gift rental history</h2><span>Saved records</span></div>
    <p className="gift-rental-caption">GRAM · before fees</p>
    <div className="gift-rental-controls">
      <div className="gift-rental-search"><label className="sr-only" htmlFor={searchId}>Search rental statistics by gift</label><Icon name="search" size={16} />
        <input id={searchId} type="search" placeholder="Find a gift…" value={query} onChange={event => { setQuery(event.target.value); setLimit(8); }} /></div>
      <label className="gift-rental-sort" htmlFor={sortId}><span className="sr-only">Sort gifts by</span><select id={sortId} value={sort} onChange={event => { setSort(event.target.value as GiftRentalSort); setLimit(8); }}>
        <option value="volume">Highest volume</option><option value="rentals">Most rentals</option><option value="recent">Last rented</option><option value="name">Gift name</option>
      </select></label>
    </div>
    {rows.length > 0 ? <>
      <div className="gift-rental-columns" aria-hidden="true"><span>Gift</span><span>Rentals</span><span>Volume</span><span>Avg. / day</span></div>
      <ul className="gift-rental-list">{rows.slice(0, limit).map(({ gift, stats }) => {
        const image = safeExternalUrl(gift.image_url);
        const accessibleSummary = `${gift.name || 'Gift'}. Rentals: ${stats?.observed_rentals ?? 'unknown'}. Recorded volume: ${stats?.recorded_volume == null ? 'unknown' : `${giftRentalAmount(stats.recorded_volume)} GRAM before fees`}. Average daily rate: ${stats?.average_daily_rate == null ? 'unknown' : `${giftRentalAmount(stats.average_daily_rate, 3)} GRAM`}. Last rented: ${stats?.last_rental_at ? dateTime(stats.last_rental_at) : 'unknown'}.${pending(stats) ? ' Payment history pending.' : ''} Open gift details.`;
        return <li key={gift.id}><button type="button" className="gift-rental-row" onClick={() => onSelect(gift)} aria-label={accessibleSummary}>
          <span className="gift-rental-identity"><span className="gift-rental-avatar"><Icon name="gift" size={22} />{image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</span>
            <span><strong>{gift.name || 'Unnamed gift'}</strong>{(!stats || pending(stats)) && <small>{stats ? 'Payment history pending' : gift.collection_conflict ? 'Collection needs review' : 'No saved rental data'}</small>}</span></span>
          <span className="gift-rental-metric"><small>Rentals</small><b>{count(stats?.observed_rentals)}</b></span>
          <span className="gift-rental-metric gift-rental-volume"><small>Volume · GRAM</small><b>{giftRentalAmount(stats?.recorded_volume)}</b></span>
          <span className="gift-rental-metric"><small>Avg. / day</small><b>{giftRentalAmount(stats?.average_daily_rate, 3)}</b></span>
        </button></li>;
      })}</ul>
      <div className="gift-rental-footer"><span role="status">{Math.min(limit, rows.length)} / {rows.length} gifts · {known} with history</span>
        {hasMore && <button type="button" className="button secondary small" onClick={() => setLimit(value => value + 8)}>Show more</button>}</div>
    </> : <p className="gift-rental-empty">{query.trim() ? 'No matching gifts.' : 'Load your portfolio to see gift history.'}</p>}
    <details className="gift-rental-method"><summary>About saved history</summary><p>{NOTE}</p>
      <p>Rentals include verified TON starts when available. Repeated checks of the same start count once; a pending payment is never treated as zero. Average daily rate uses recorded amounts and full rental durations. Missing data shows —.</p>
      <p>Personal analytics is a separate wallet report, so its totals may differ from this gift history.</p></details>
    <button type="button" className="text-button gift-rental-update" onClick={onStatus}>Update history <Icon name="arrow" size={14} /></button>
  </section>;
}

export function GiftRentalStatisticsDetails({ gift }: { gift: Gift }) {
  const stats = giftRentalStatistics(gift);
  const exclusions = Object.entries(gift.rental_statistics?.excluded_counts || {}).filter(([, value]) => Number.isSafeInteger(value) && value > 0);
  return <details className="detail-section detail-disclosure rental-history-details"><summary>Saved market history{stats && <> · {count(stats.observed_rentals)} observed</>}</summary>
    <dl><div><dt>Observed rentals</dt><dd>{count(stats?.observed_rentals)}</dd></div>
      <div><dt>In payment history</dt><dd>{count(stats?.recorded_rentals)}</dd></div>
      <div><dt>Recorded volume · GRAM</dt><dd>{giftRentalAmount(stats?.recorded_volume)}</dd></div>
      <div><dt>Average daily rate · GRAM/day</dt><dd>{giftRentalAmount(stats?.average_daily_rate, 3)}</dd></div>
      <div><dt>Recorded rental days</dt><dd>{giftRentalAmount(stats?.rental_days)}</dd></div>
      {stats?.first_rental_at && <div><dt>Earliest saved rental</dt><dd>{dateTime(stats.first_rental_at)}</dd></div>}
      {stats?.last_rental_at && <div><dt>Latest saved rental</dt><dd>{dateTime(stats.last_rental_at)}</dd></div>}
      {stats?.observed_at && <div><dt>Evidence last observed</dt><dd>{dateTime(stats.observed_at)}</dd></div>}
    </dl>
    {!stats && <p>Rental totals unknown. No eligible history is saved for this gift.</p>}
    {pending(stats) && <p>{count(stats!.verified_rentals_without_history)} verified rental starts have pending payment history. Their amounts are not included.</p>}
    <details className="gift-rental-method"><summary>How these totals are calculated</summary><p>{NOTE}</p><p>Whole payments and durations count at the rental start, not as occupancy or accrued income.</p></details>
    {exclusions.length > 0 && <details><summary>Excluded records</summary><ul>{exclusions.map(([reason, value]) => <li key={reason}>{humanize(reason)}: {value.toLocaleString()}</li>)}</ul></details>}
    <p>Update <b>Actual rental averages</b> in Status to collect more saved history for your gift collections.</p>
  </details>;
}
