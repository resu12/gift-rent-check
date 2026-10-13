import { useSyncExternalStore } from 'react';
import { giftRefreshSourceText, type OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';
import { presentOwnedPriceSync } from './data/syncPresentation';
import { SyncProgress } from './SyncProgress';
import './ownedPriceStatus.css';

export function OwnedPriceStatus({ driver, rentalStatus = false, collapseSettled = false }: { driver: OwnedPriceRefreshDriver; rentalStatus?: boolean; collapseSettled?: boolean }) {
  const status = useSyncExternalStore(driver.subscribe, driver.getSnapshot);
  if (status.phase === 'idle') return null;
  const single = status.run?.scope === 'gift';
  const view = presentOwnedPriceSync(status, { stopping: status.phase === 'checking' && !status.canStop, rentalStatus });
  const complete = status.phase === 'complete';
  const format = (value: number) => value.toLocaleString('en-US');
  const unresolved = rentalStatus ? status.run?.status_unresolved ?? 0 : status.run?.unresolved ?? 0;
  const check = rentalStatus ? 'Gift check' : 'Price check';
  const website = status.provider === 'marketapp_website';
  const source = giftRefreshSourceText(status);
  const unresolvedLabel = rentalStatus ? 'unconfirmed' : 'prices unavailable';
  const details = <div className="owned-price-explanation">
    {status.run && <dl className="owned-price-facts">
      <div><dt>Gifts checked</dt><dd>{format(status.run.checked)} / {format(status.run.total)}</dd></div>
      <div><dt>Prices updated</dt><dd>{format(status.run.updated)}</dd></div>
      {rentalStatus && status.run.status_updated !== undefined && <div><dt>Rental statuses {website ? 'observed' : 'verified'}</dt><dd>{format(status.run.status_updated)}</dd></div>}
      {unresolved > 0 && <div><dt>{rentalStatus ? 'Still unconfirmed' : 'Prices unavailable'}</dt><dd>{format(unresolved)}</dd></div>}
    </dl>}
    {source && <p>{source}</p>}
    <p>{single ? 'Checks this gift’s price and rental status.' : 'Checks saved gifts. Comparison prices and new gift discovery update separately.'} Saved data is kept when a check cannot finish.</p>
    {!website && <p>A contract price does not confirm that the gift is listed on Marketapp.</p>}
    {rentalStatus && <p>Unverified statuses stay unconfirmed. Expired rentals remain pending return.</p>}
    {(status.phase === 'partial' || status.phase === 'unavailable') && <p>Choose Refresh in Status, Pricing or My gifts to try again.</p>}
  </div>;
  const message = status.error || (view.state === 'failed' ? `${check} unavailable. Use the refresh icon to retry.`
    : view.state === 'paused' ? view.rawReason === 'provider_wait' || view.rawReason === 'retry_wait' ? view.message : view.message.startsWith('Stopped.') ? `${check} stopped.` : `${check} paused. Use the refresh icon to retry.`
      : view.state === 'waiting' ? view.message
        : view.state === 'stopping' ? 'Finishing the current check…'
          : status.verification || (status.provider && view.progress.indeterminate) ? view.message : null);
  const content = <div className={`owned-price-status job-card sync-card sync-${view.state}${complete ? ' owned-price-complete' : ''}`}>
    {complete ? <details className="owned-price-details">
      <summary><span className="owned-price-result" role="status" aria-atomic="true"><strong>{single ? 'Selected gift' : rentalStatus ? 'Your gifts' : 'Your prices'}</strong><span> · {status.cacheHit ? 'Checked recently' : status.run?.total === 0 ? 'No gifts to check' : 'Check complete'}</span>{unresolved > 0 && <span className="owned-price-result-warning"> · {format(unresolved)} {unresolvedLabel}</span>}</span><span className="owned-price-disclosure">Details</span></summary>
      {details}
    </details> : <>
      <div className="owned-price-heading"><strong>{view.title}</strong>{status.canStop && <button type="button" className="button small secondary" onClick={() => { void driver.stop(); }} aria-label={rentalStatus ? 'Stop checking your gifts' : 'Stop checking your gift prices'}>Stop</button>}</div>
      <SyncProgress progress={view.progress} moving={status.phase === 'checking' && view.state !== 'waiting' && view.state !== 'stopping'} />
      {message && message !== view.progress.label && <p className="sync-message" role="status">{message}</p>}
      <div className="owned-price-footer"><details className="owned-price-details"><summary>Details</summary>{details}</details>{unresolved > 0 && <span className="owned-price-unresolved" role="status">{format(unresolved)} {unresolvedLabel}</span>}</div>
    </>}
  </div>;
  return collapseSettled && status.phase !== 'checking'
    ? <details className="activity-refresh-history"><summary>Last gift check</summary>{content}</details> : content;
}
