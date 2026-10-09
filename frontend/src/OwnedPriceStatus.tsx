import { useSyncExternalStore } from 'react';
import { ownedPriceStatusText } from './data/ownedPriceRefresh';
import type { OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';
import './ownedPriceStatus.css';

export function OwnedPriceStatus({ driver }: { driver: OwnedPriceRefreshDriver }) {
  const status = useSyncExternalStore(driver.subscribe, driver.getSnapshot);
  if (status.phase === 'idle') return null;
  return <div className={`owned-price-status ${status.phase}`}>
    <span role="status" aria-live="polite">{ownedPriceStatusText(status)}</span>
    {status.canStop && <button type="button" className="text-button" onClick={() => { void driver.stop(); }}>Stop check</button>}
  </div>;
}
