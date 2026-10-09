import type { Gift } from './data/types';
import { dateTime } from './data/helpers';

const HISTORY_NOTE = 'Counts confirmed rental starts in all saved Marketapp history. Coverage may be incomplete and rentals may predate your ownership. Extensions are excluded.';

export function RentalCount({ gift }: { gift: Gift }) {
  if (!gift.is_portfolio) return null;
  const history = gift.rental_history;
  const count = history?.recorded_count;
  return <span className="rental-count" title={history?.note || HISTORY_NOTE}>
    <span>Rentals</span>
    <b>{count == null ? 'Unknown' : count.toLocaleString()}</b>
    {count != null && <span className="rental-count-scope">recorded</span>}
  </span>;
}

export function RentalHistoryDetails({ gift }: { gift: Gift }) {
  if (!gift.is_portfolio) return null;
  const history = gift.rental_history;
  const count = history?.recorded_count;
  const excluded = Object.values(history?.excluded_counts || {}).reduce((sum, value) => sum + value, 0);
  return <section className="detail-section rental-history-details"><h3>Rental history</h3>
    <dl><div><dt>Recorded rental starts</dt><dd>{count == null ? 'Unknown' : count.toLocaleString()}</dd></div>
      {excluded > 0 && <div><dt>Excluded records</dt><dd>{excluded.toLocaleString()}</dd></div>}
    </dl>
    <p>{count == null ? 'Not enough saved history to count rentals.' : 'All saved history · coverage may be incomplete.'}</p>
    <details className="sync-details"><summary>History details</summary><div>
      <p>{history?.note || HISTORY_NOTE}</p>
      {(history?.first_rental_at || history?.last_rental_at || history?.observed_at) && <dl>
        {history?.first_rental_at && <div><dt>Earliest saved rental</dt><dd>{dateTime(history.first_rental_at)}</dd></div>}
        {history?.last_rental_at && <div><dt>Latest saved rental</dt><dd>{dateTime(history.last_rental_at)}</dd></div>}
        {history?.observed_at && <div><dt>History last observed</dt><dd>{dateTime(history.observed_at)}</dd></div>}
      </dl>}
      <p>Select <b>Actual rentals</b> and refresh to collect more history. Continue paused work from Activity.</p>
    </div></details>
  </section>;
}
