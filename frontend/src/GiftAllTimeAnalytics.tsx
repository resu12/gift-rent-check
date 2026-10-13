import { useId, useMemo } from 'react';
import type { Gift, PersonalRentalAnalyticsAllTime } from './data/types';
import { dateTime, formatAmount, relativeTime } from './data/helpers';
import { analyticsPeriod } from './data/personalAnalytics';
import { giftAllTimeAnalytics } from './data/marketappTopItems';
import { useAnalyticsClock } from './useAnalyticsClock';
import './giftRentalStatistics.css';

export function GiftAllTimeAnalytics({ gift, report, wallet }: {
  gift: Gift; report?: PersonalRentalAnalyticsAllTime | null; wallet: string | null;
}) {
  const titleId = useId();
  const [now] = useAnalyticsClock();
  const item = useMemo(() => giftAllTimeAnalytics(gift, report, wallet, now), [gift.nft_address, report, wallet, now]);
  return <section className="detail-section gift-all-time" aria-labelledby={titleId}>
    <h3 id={titleId}>All time rentals</h3>
    {item && item.coverage ? <>
      <dl className="gift-all-time-metrics">
        <div><dt>Rentals</dt><dd>{item.rentals.toLocaleString()}</dd></div>
        <div><dt>Volume · GRAM <small>before fees</small></dt><dd title={`${item.volume} GRAM before fees`}>{formatAmount(item.volume, 1)}</dd></div>
      </dl>
      <p className="gift-all-time-coverage">Partial history · {item.coverage.observed_days.toLocaleString()} days saved{item.coverage.missing_days > 0 && <> · {item.coverage.missing_days.toLocaleString()} missing</>}{item.coverage.partial_days > 0 && <> · {item.coverage.partial_days.toLocaleString()} partial</>}</p>
      <p className="gift-all-time-capture" title={dateTime(item.captured_at)}>Latest report <time dateTime={item.captured_at}>{relativeTime(item.captured_at, now)}</time></p>
      <details className="gift-all-time-evidence"><summary>Report details</summary>
        <dl><div><dt>Rented days</dt><dd>{item.rented_days}</dd></div><div><dt>Price / day · GRAM</dt><dd>{formatAmount(item.price_per_day, 3)}</dd></div><div><dt>Exact volume · GRAM</dt><dd>{item.volume}</dd></div><div><dt>Latest capture</dt><dd>{dateTime(item.captured_at)}</dd></div></dl>
        <p>Marketapp reports only; missing history remains unknown. Volume is before fees and royalties.</p>
        <ul>{item.coverage.periods.map(period => <li key={period.period_start}>{analyticsPeriod(period.period_start, period.period_end)} UTC<span>Captured {dateTime(period.captured_at)}</span></li>)}</ul>
        <p>Overlapping reports count once. Combined reports use volume divided by rented days for the daily price. Refresh analytics in Overview to add history.</p>
      </details>
    </> : <div className="gift-all-time-empty"><p>Rental totals unknown. No analytics saved for this gift.</p><details className="gift-all-time-evidence"><summary>How to update</summary><p>Refresh analytics in Overview. Gifts absent from Marketapp’s Top items keep unknown totals.</p></details></div>}
  </section>;
}
