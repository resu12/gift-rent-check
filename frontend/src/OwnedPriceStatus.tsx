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
  const details = <div className="owned-price-explanation">
    {source && <p>{source}</p>}
    <p>{single ? 'This checks only the selected gift’s configured price and rental status through TON.' : website ? 'This refreshes prices, rental status and expiry for your saved gifts. It does not collect comparison prices or discover new gifts.' : rentalStatus ? 'This checks rental status and daily prices for your known gifts through TON.' : 'This checks daily prices in known TON rental contracts.'}{!website && ' It does not scan Marketapp listings or rental history.'}</p>
    {status.run && <p>{format(status.run.checked)} of {format(status.run.total)} gifts checked · {format(status.run.updated)} prices updated{rentalStatus && status.run.status_updated !== undefined ? ` · ${format(status.run.status_updated)} statuses ${website ? 'observed' : 'verified'}` : ''} · {format(unresolved)} unresolved.</p>}
    <p>Previously saved data is kept when a check cannot be completed.{!website && ' Contract prices do not confirm that a gift is currently listed for rent.'}</p>
    {rentalStatus && <p>{!website && 'An idle contract does not confirm Marketapp availability. '}Conflicting or unverified status stays uncertain; expired rentals remain pending return.</p>}
    {(status.phase === 'partial' || status.phase === 'unavailable') && <p>Use the refresh icon in Pricing or My gifts to try another check.</p>}
    {view.rawReason && <p>Technical note: {view.rawReason}</p>}
  </div>;
  const message = status.error || (view.state === 'failed' ? `${check} unavailable. Use the refresh icon to retry.`
    : view.state === 'paused' ? view.rawReason === 'provider_wait' || view.rawReason === 'retry_wait' ? view.message : view.message.startsWith('Stopped.') ? `${check} stopped.` : `${check} paused. Use the refresh icon to retry.`
      : view.state === 'waiting' ? view.message
        : view.state === 'stopping' ? 'Finishing the current check…'
          : status.verification || (status.provider && view.progress.indeterminate) ? view.message : null);
  const content = <div className={`owned-price-status job-card sync-card sync-${view.state}${complete ? ' owned-price-complete' : ''}`}>
    {complete ? <details className="owned-price-details">
      <summary><span className="owned-price-result" role="status" aria-atomic="true"><strong>{single ? 'Selected gift' : rentalStatus ? 'Your gifts' : 'Your prices'}</strong><span> · {status.cacheHit ? 'Checked recently' : status.run?.total === 0 ? 'No gifts to check' : rentalStatus ? status.run?.status_updated !== undefined ? `${format(status.run.status_updated)} statuses checked` : 'Status unconfirmed' : status.run ? `${format(status.run.updated)} updated` : 'Checked'}</span>{unresolved > 0 && <span> · {format(unresolved)} unresolved</span>}</span><span className="owned-price-disclosure">Details</span></summary>
      {details}
    </details> : <>
      <div className="owned-price-heading"><strong>{view.title}</strong>{status.canStop && <button type="button" className="button small secondary" onClick={() => { void driver.stop(); }} aria-label={rentalStatus ? 'Stop checking your gifts' : 'Stop checking your gift prices'}>Stop</button>}</div>
      <SyncProgress progress={view.progress} moving={status.phase === 'checking' && view.state !== 'waiting' && view.state !== 'stopping'} />
      {message && <p className="sync-message" role="status">{message}</p>}
      <div className="owned-price-footer"><details className="owned-price-details"><summary>Details</summary>{details}</details>{unresolved > 0 && <span className="owned-price-unresolved" role="status">{format(unresolved)} unresolved</span>}</div>
    </>}
  </div>;
  return collapseSettled && status.phase !== 'checking'
    ? <details className="activity-refresh-history"><summary>Last gift check</summary>{content}</details> : content;
}
