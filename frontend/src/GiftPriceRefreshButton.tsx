import { useSyncExternalStore } from 'react';
import { Icon } from './Icons';
import type { OwnedPriceRefreshDriver, OwnedPriceSnapshot } from './data/ownedPriceRefresh';

const unavailable: OwnedPriceSnapshot = { phase: 'idle', run: null, canStop: false, canRefresh: false };
const subscribeUnavailable = () => () => {};
const unavailableSnapshot = () => unavailable;

export function GiftPriceRefreshButton({ driver, onRefresh, disabledReason, rentalStatus = false, display = 'icon' }: {
  driver: OwnedPriceRefreshDriver | null;
  onRefresh: () => Promise<void>;
  disabledReason?: string;
  rentalStatus?: boolean;
  display?: 'icon' | 'menu';
}) {
  const status = useSyncExternalStore(driver?.subscribe ?? subscribeUnavailable, driver?.getSnapshot ?? unavailableSnapshot);
  const checking = !status.canRefresh && status.phase !== 'idle';
  const disabled = !driver || Boolean(disabledReason) || !status.canRefresh;
  const subject = rentalStatus ? 'gift prices and rental status' : 'gift prices';
  const label = `${checking ? 'Checking' : 'Refresh'} ${subject}`;
  return <button type="button" className={display === 'icon' ? 'icon-button gift-price-refresh' : undefined} aria-label={label}
    aria-busy={checking} disabled={disabled}
    title={disabledReason || (rentalStatus ? 'Refresh your saved gifts through Marketapp login, with TON checks as fallback' : 'Check daily prices for your discovered gifts through TON')}
    onClick={() => { void onRefresh(); }}>
    <Icon name="refresh" size={19} className={checking ? 'spinning' : ''} />
    {display === 'menu' && <span><strong>{rentalStatus ? 'Refresh gift prices & status' : 'Refresh gift prices'}</strong><small>{rentalStatus ? 'Marketapp login or TON · saved gifts only' : 'Check known gifts through TON'}</small></span>}
  </button>;
}
