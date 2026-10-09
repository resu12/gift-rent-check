import { useSyncExternalStore } from 'react';
import type { OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';
import { presentOwnedPriceSync } from './data/syncPresentation';
import { SyncProgress } from './SyncProgress';
import './ownedPriceStatus.css';

export function OwnedPriceStatus({ driver }: { driver: OwnedPriceRefreshDriver }) {
  const status = useSyncExternalStore(driver.subscribe, driver.getSnapshot);
  if (status.phase === 'idle') return null;
  const view = presentOwnedPriceSync(status, { stopping: status.phase === 'checking' && !status.canStop });
  const complete = status.phase === 'complete';
  const format = (value: number) => value.toLocaleString('en-US');
  const unresolved = status.run?.unresolved ?? 0;
  const details = <div className="owned-price-explanation">
    <p>This checks daily prices in known TON rental contracts. It does not scan Marketapp listings or rental history.</p>
    {status.run && <p>{format(status.run.checked)} of {format(status.run.total)} gifts checked · {format(status.run.updated)} prices updated · {format(unresolved)} unresolved.</p>}
    <p>Previously saved prices are kept when a check cannot be completed. Contract prices do not confirm that a gift is currently listed for rent.</p>
    {(status.phase === 'partial' || status.phase === 'unavailable') && <p>Reopen the app to try another price check.</p>}
    {view.rawReason && <p>Technical note: {view.rawReason}</p>}
  </div>;
  const message = view.state === 'failed' ? 'Price check unavailable. Reopen the app to retry.'
    : view.state === 'paused' ? view.message.startsWith('Stopped.') ? 'Price check stopped.' : 'Price check paused. Reopen the app to retry.'
      : view.state === 'waiting' ? 'Waiting for the provider before retrying.'
        : view.state === 'stopping' ? 'Finishing the current check…' : null;
  return <div className={`owned-price-status job-card sync-card sync-${view.state}${complete ? ' owned-price-complete' : ''}`}>
    {complete ? <details className="owned-price-details">
      <summary><span className="owned-price-result" role="status" aria-atomic="true"><strong>Your prices</strong><span> · {status.run?.total === 0 ? 'No gifts to check' : status.run ? `${format(status.run.updated)} updated` : 'Checked'}</span>{unresolved > 0 && <span> · {format(unresolved)} unresolved</span>}</span><span className="owned-price-disclosure">Details</span></summary>
      {details}
    </details> : <>
      <div className="owned-price-heading"><strong>{view.title}</strong>{status.canStop && <button type="button" className="button small secondary" onClick={() => { void driver.stop(); }} aria-label="Stop checking your gift prices">Stop</button>}</div>
      <SyncProgress progress={view.progress} moving={status.phase === 'checking' && view.state !== 'waiting' && view.state !== 'stopping'} />
      {message && <p className="sync-message" role="status">{message}</p>}
      <div className="owned-price-footer"><details className="owned-price-details"><summary>Details</summary>{details}</details>{unresolved > 0 && <span className="owned-price-unresolved" role="status">{format(unresolved)} unresolved</span>}</div>
    </>}
  </div>;
}
