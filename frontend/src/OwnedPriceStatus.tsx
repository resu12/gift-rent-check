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
  return <div className={`owned-price-status job-card sync-card sync-${view.state}${complete ? ' sync-compact' : ''}`}>
    <div className="sync-card-header"><strong>{view.title}</strong><span className="sync-state">{view.stateLabel}</span></div>
    {!complete && <><p className="sync-purpose">{view.objective}</p><SyncProgress progress={view.progress} moving={status.phase === 'checking' && view.state !== 'waiting' && view.state !== 'stopping'} /></>}
    <p className="sync-message" role="status">{view.message}</p>
    <div className="sync-card-footer">
      <details className="sync-details"><summary>Details</summary><div>
        <p>This checks daily prices in known TON rental contracts. It does not scan Marketapp listings or rental history.</p>
        {status.run && <p>{status.run.checked} of {status.run.total} gifts checked · {status.run.updated} prices updated · {status.run.unresolved} unresolved.</p>}
        <p>Contract prices do not confirm that a gift is currently listed for rent.</p>
        {view.rawReason && <p>Technical note: {view.rawReason}</p>}
      </div></details>
      {status.canStop && <div className="sync-actions"><button type="button" className="button small secondary" onClick={() => { void driver.stop(); }}>Stop</button></div>}
    </div>
  </div>;
}
