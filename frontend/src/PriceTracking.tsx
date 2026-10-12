import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icons';
import type { Gift, GiftPriceTrackingData, ObservedPriceChange, PriceTrackingComparison } from './data/types';
import { dateTime, formatAmount, formatPriceDifference, humanize, relativeTime } from './data/helpers';
import { hasTrackingWindow, latestPriceChanges, TRACKING_PERIODS, trackingAmount, trackingComparison, trackingCount, trackingDateRange, trackingWindowStatus } from './data/priceTracking';
import type { TrackingPeriod } from './data/priceTracking';
import './priceTracking.css';

function ComparePeriod({ days, onChange }: { days: TrackingPeriod; onChange: (days: TrackingPeriod) => void }) {
  return <div className="price-tracking-periods" role="group" aria-label="Price-change comparison period">
    {TRACKING_PERIODS.map(period => <button type="button" key={period} className={period === days ? 'active' : ''}
      aria-pressed={period === days} onClick={() => onChange(period)}>{period}d</button>)}
  </div>;
}

function ChangePrices({ change, compact = false }: { change: ObservedPriceChange; compact?: boolean }) {
  return <span className={compact ? 'price-tracking-change-rate' : 'gift-price-tracking-prices'}
    title={`${trackingAmount(change.from_price_per_day)} → ${trackingAmount(change.to_price_per_day)} GRAM/day`}>
    <span>{trackingAmount(change.from_price_per_day)}</span><Icon name="arrow" size={compact ? 14 : 18} />
    <strong>{trackingAmount(change.to_price_per_day)}</strong>
  </span>;
}

function ChangeSample({ comparison }: { comparison: PriceTrackingComparison | null }) {
  if (!comparison || !hasTrackingWindow(comparison)) return <span className="price-tracking-result waiting">{trackingWindowStatus(comparison)}</span>;
  return <span className="price-tracking-result" title="Saved rental records before → after the observed price change">
    <b>{trackingCount(comparison.before.recorded_rentals)} → {trackingCount(comparison.after.recorded_rentals)}</b> rentals
    {comparison.status !== 'ready' && <><br />{trackingWindowStatus(comparison)}</>}
  </span>;
}

const COMPARISON_NOTES: Record<string, string> = {
  'Only saved observations and eligible base GRAM rental records are included; coverage may be incomplete.':
    'Only saved price checks and base GRAM rentals are included. Coverage may be incomplete.',
  'Gift history does not establish wallet proceeds, net income, rental completion or a causal effect of changing a price.':
    'Volume is before fees, not verified wallet income. These records do not establish completed rentals or why performance changed.',
  'Equal-length before/after windows exclude the uncertain change interval; whole rental amounts and durations are assigned by rental start, not accrued revenue or occupancy.':
    'Equal periods omit uncertain gaps. Whole amounts and durations count at the rental start, not as accrued revenue or occupancy.',
  'Configured contract prices do not prove Marketapp listing visibility or the rate of an ongoing rental.':
    '',
  'TON configured-price observations could not be verified; Marketapp listing evidence is used when available.':
    'Contract prices could not be verified, so saved Marketapp listings are used when available.',
  'Unverified or conflicting price evidence interrupts the timeline; changes across those gaps are not inferred.':
    'Conflicting or unverified checks interrupt the timeline. Changes across those gaps are unknown.',
  'Ambiguous, malformed, extension, currency or amount records are excluded from the affected performance samples.':
    'Extensions, conflicting records and invalid amounts or currencies are excluded.',
  'No saved rental history is available for this gift; recorded zeroes do not establish actual rental activity.':
    'No rental history is saved for this gift. A recorded zero does not prove that it was never rented.',
  'Conflicting collection evidence prevents price tracking for this gift.':
    'Conflicting collection information prevents tracking this gift.',
  'Refresh saved prices to establish a baseline; the first observation is not a price change.':
    'The first price check establishes a baseline. Later checks can reveal changes.',
  'Changes were first observed between saved checks; the actual change time is unknown. TON configured prices and Marketapp listing prices are never combined.':
    '',
  'Performance uses only recorded, unambiguous GRAM rental starts. It is not wallet proceeds, net income, occupancy, or proof that a price change caused a result.':
    'Saved GRAM rental starts do not establish wallet income, occupancy or why performance changed.',
  'Before/after periods have equal elapsed lengths and exclude the unchecked price-change gap. Ready describes elapsed time, never complete history coverage.':
    'Equal periods omit unchecked gaps. A complete period does not mean complete rental history.',
  'Recorded volume uses whole reported rental payments and rental days sum full durations for starts in the period; neither is apportioned to the period.':
    'Whole payments and durations count at the rental start, not as accrued income.',
  'Invalid, conflicting or changed owner/contract evidence interrupts the timeline; the next valid observation starts a new baseline.':
    'Conflicting or unverified checks interrupt the timeline. The next valid price starts a new baseline.',
  'No verified TON configured-price observation was eligible; this timeline uses saved Marketapp listings.':
    'Contract prices could not be verified, so saved Marketapp listings are used.',
  'No saved rental history exists for this gift; zero recorded starts does not establish that it was never rented.':
    'No rental history is saved for this gift. A recorded zero does not prove that it was never rented.',
  'Some malformed history has no valid event date and cannot be assigned to a comparison period.':
    'Records without valid dates cannot be included in either comparison period.',
};

function ComparisonDetails({ tracking, change, comparison }: {
  tracking: GiftPriceTrackingData; change?: ObservedPriceChange; comparison: PriceTrackingComparison | null;
}) {
  const excluded = comparison ? [...new Set([
    ...Object.keys(comparison.before.excluded_counts), ...Object.keys(comparison.after.excluded_counts),
  ])].sort().filter(reason => (comparison.before.excluded_counts[reason] || 0) > 0 || (comparison.after.excluded_counts[reason] || 0) > 0) : [];
  const notes = [...new Set(tracking.warnings.map(warning => COMPARISON_NOTES[warning] ?? warning).filter(Boolean))];
  return <details className="price-tracking-details"><summary>Comparison details</summary>
    <dl className="price-tracking-metadata">
      <div><dt>Price source</dt><dd>{tracking.source || 'No saved price'}</dd></div>
      {change && <><div><dt>Old price last seen</dt><dd>{dateTime(change.previous_observed_at)}</dd></div>
        <div><dt>New price first seen</dt><dd>{dateTime(change.observed_at)}</dd></div></>}
      <div><dt>Latest price check</dt><dd>{dateTime(tracking.last_observed_at)}</dd></div>
      {comparison && hasTrackingWindow(comparison) && <><div><dt>Before · UTC</dt><dd>{trackingDateRange(comparison.before.window_from, comparison.before.window_to)}</dd></div>
        <div><dt>After · UTC</dt><dd>{trackingDateRange(comparison.after.window_from, comparison.after.window_to)}</dd></div></>}
    </dl>
    <p className="price-tracking-method">Dates show first observed prices, not exact edit times. Contract prices are preferred; sources are never mixed. Contract prices do not prove listing visibility or the rate of an ongoing rental. Daily rates are weighted by rental duration.</p>
    {excluded.length > 0 && <div className="price-tracking-exclusions"><h5>Excluded records</h5>
      <table aria-label="Excluded rental records in each comparison period"><thead><tr><th scope="col">Reason</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
        <tbody>{excluded.map(reason => <tr key={reason}><th scope="row">{humanize(reason)}</th><td>{trackingCount(comparison?.before.excluded_counts[reason] || 0)}</td><td>{trackingCount(comparison?.after.excluded_counts[reason] || 0)}</td></tr>)}</tbody>
      </table>
    </div>}
    {(tracking.changes.length > 0 || tracking.baseline_price_per_day != null) && <div className="gift-price-tracking-history"><h5>Saved price history{tracking.change_count > 0 && <> · {tracking.change_count} {tracking.change_count === 1 ? 'change' : 'changes'}</>}</h5>
      <ol>{tracking.changes.map(item => <li key={item.id}><time dateTime={item.observed_at} title={dateTime(item.observed_at)}>{dateTime(item.observed_at, true)}</time><strong>{trackingAmount(item.to_price_per_day)}<small>GRAM/day</small></strong></li>)}
        {tracking.baseline_price_per_day != null && <li><time dateTime={tracking.baseline_observed_at || undefined} title={dateTime(tracking.baseline_observed_at)}>Baseline · {dateTime(tracking.baseline_observed_at, true)}</time><strong>{trackingAmount(tracking.baseline_price_per_day)}<small>GRAM/day</small></strong></li>}
      </ol>{tracking.change_count > tracking.changes.length && <p className="price-tracking-saved-cue">Latest {tracking.changes.length} changes and first baseline shown.</p>}
    </div>}
    {notes.length > 0 && <ul className="price-tracking-notes">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </details>;
}

export function PriceChangeOverview({ gifts, onSelect }: { gifts: Gift[]; onSelect: (gift: Gift) => void }) {
  const [days, setDays] = useState<TrackingPeriod>(7);
  const changes = useMemo(() => latestPriceChanges(gifts), [gifts]);
  const tracked = gifts.some(gift => gift.is_portfolio && gift.price_tracking?.coverage === 'observed_sample');
  return <section className="panel price-tracking-overview" aria-labelledby="price-tracking-title">
    <div className="price-tracking-heading"><h2 id="price-tracking-title"><Icon name="pricing" size={18} />Price changes</h2>
      {changes.length > 0 && <ComparePeriod days={days} onChange={setDays} />}
    </div>
    {changes.length > 0 ? <ul className="price-tracking-list">{changes.map(({ gift, change }) => <li key={`${gift.id}:${change.id}`}>
      <button type="button" className="price-tracking-change" onClick={() => onSelect(gift)}
        aria-label={`View price change and rental performance for ${gift.name || 'gift'}`}>
        <strong className="price-tracking-change-name">{gift.name || 'Unnamed gift'}</strong><ChangePrices change={change} compact />
        <time className="price-tracking-change-cue" dateTime={change.observed_at} title={dateTime(change.observed_at)}>{relativeTime(change.observed_at)}</time>
        <ChangeSample comparison={trackingComparison(change, days)} />
      </button>
    </li>)}</ul> : <p className="price-tracking-empty">{tracked ? 'No price changes observed yet.' : 'Refresh gift prices to start tracking.'}</p>}
    {changes.length > 0 && <p className="price-tracking-saved-cue">GRAM/day · saved rentals before → after</p>}
  </section>;
}

function ComparisonTable({ comparison }: { comparison: PriceTrackingComparison | null }) {
  if (!comparison) return <p className="gift-price-tracking-coverage">Comparison unavailable.</p>;
  if (!hasTrackingWindow(comparison)) return <p className="gift-price-tracking-coverage">{comparison.status === 'partial'
    ? 'Price checks interrupted this interval. No verified comparison is available.'
    : 'Waiting for time after this price check.'}</p>;
  return <div className="gift-price-tracking-performance">
    {comparison.status !== 'ready' && <p className="gift-price-tracking-coverage">{comparison.status === 'partial' && 'Limited interval · '}{trackingWindowStatus(comparison)}</p>}
    <table aria-label="Recorded gift rental performance before and after the observed price change">
      <thead><tr><th scope="col">Saved rentals</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>
        <tr><th scope="row">Rentals</th><td>{trackingCount(comparison.before.recorded_rentals)}</td><td>{trackingCount(comparison.after.recorded_rentals)}</td></tr>
        <tr><th scope="row">Volume <small>GRAM · before fees</small></th><td>{trackingAmount(comparison.before.recorded_volume, 1)}</td><td>{trackingAmount(comparison.after.recorded_volume, 1)}</td></tr>
        <tr><th scope="row">Daily rate <small>GRAM/day</small></th><td>{trackingAmount(comparison.before.average_daily_rate)}</td><td>{trackingAmount(comparison.after.average_daily_rate)}</td></tr>
      </tbody>
    </table>
  </div>;
}

function changePercent(value: string | null): string | null {
  if (typeof value !== 'string' || value.length > 2000 || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const rounded = formatAmount(value, 1);
  return `${!value.startsWith('-') && /[1-9]/.test(value) && rounded !== '0.0' ? '+' : ''}${rounded}%`;
}

export function GiftPriceTracking({ gift }: { gift: Gift }) {
  const tracking = gift.price_tracking;
  const [days, setDays] = useState<TrackingPeriod>(7);
  const [changeId, setChangeId] = useState<string | null>(null);
  useEffect(() => { setDays(7); setChangeId(null); }, [gift.id]);
  if (!tracking) return null;
  const change = tracking.changes.find(item => item.id === changeId) || tracking.changes[0];
  const comparison = change ? trackingComparison(change, days) : null;
  const percent = change ? changePercent(change.percent_change) : null;
  return <details className="detail-section gift-price-tracking"><summary>Price changes & performance</summary>
    <div className="gift-price-tracking-body">
      {change ? <>
        <div className="gift-price-tracking-header"><h4>Before & after</h4><ComparePeriod days={days} onChange={setDays} /></div>
        {tracking.changes.length > 1 && <label className="gift-price-tracking-change-select"><span className="sr-only">Observed price change</span><select aria-label="Observed price change" value={change.id} onChange={event => setChangeId(event.target.value)}>
          {tracking.changes.map(item => <option key={item.id} value={item.id}>{dateTime(item.observed_at, true)} · {trackingAmount(item.from_price_per_day)} → {trackingAmount(item.to_price_per_day)}</option>)}
        </select></label>}
        <div className="gift-price-tracking-source">
          <div className="gift-price-tracking-source-title"><span>Asking price · GRAM/day</span><span>{formatPriceDifference(change.delta_per_day)}{percent && <> · {percent}</>}</span></div>
          <ChangePrices change={change} />
          <p className="gift-price-tracking-price-cue"><time dateTime={change.observed_at} title={dateTime(change.observed_at)}>Seen {dateTime(change.observed_at, true)}</time></p>
          <ComparisonTable comparison={comparison} />
        </div>
      </> : <p className="price-tracking-empty">{tracking.baseline_price_per_day != null ? <>Baseline <strong>{trackingAmount(tracking.baseline_price_per_day)} GRAM/day</strong> · no change observed yet.</> : 'Refresh gift prices to start tracking.'}</p>}
      <ComparisonDetails tracking={tracking} change={change} comparison={comparison} />
    </div>
  </details>;
}
