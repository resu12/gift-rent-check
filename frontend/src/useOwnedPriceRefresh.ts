import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard, DashboardAdapter } from './data/types';
import { createOwnedPriceStartupGate, OwnedPriceRefreshDriver, savedGiftRefreshEnabled } from './data/ownedPriceRefresh';

// One key for this page opening, including React's development remount checks.
const pageSessionId = crypto.randomUUID();

/** Local and Telegram dashboards share the same start, hide, stop and reload rules. */
export function useOwnedPriceRefresh(adapter: DashboardAdapter, data: Dashboard | null, reload: () => Promise<void>) {
  const enabled = savedGiftRefreshEnabled(adapter.mode, data?.capabilities);
  const latestReload = useRef(reload);
  latestReload.current = reload;
  const [{ driver, startup }] = useState(() => {
    const driver = adapter.ownedPriceTransport ? new OwnedPriceRefreshDriver({
      transport: adapter.ownedPriceTransport,
      sessionId: pageSessionId,
      onSavedDataChanged: () => { void latestReload.current(); },
    }) : null;
    return { driver, startup: driver ? createOwnedPriceStartupGate(driver, () => document.hidden,
      adapter.mode === 'serverless' ? { reopenAfterMs: 300000 } : {}) : null };
  });
  const effectGeneration = useRef(0);
  useEffect(() => {
    const generation = ++effectGeneration.current;
    // A restored Telegram WebView may be hours old. A long absence can start
    // a fresh check only after a confirmed completion; interrupted work stays paused.
    const leave = () => { adapter.interrupt?.(); startup?.interrupt(); };
    const hide = () => { if (document.hidden) adapter.interrupt?.(); startup?.visibilityChanged(); };
    const show = () => startup?.visibilityChanged();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', show);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', show);
      // StrictMode immediately installs a new effect; a real unmount does not.
      queueMicrotask(() => { if (effectGeneration.current === generation) { leave(); startup?.dispose(); } });
    };
  }, [adapter, startup]);
  useEffect(() => {
    // This runs after saved data is rendered. Polling and filter changes cannot
    // restart the once-per-opening gate, even when a previous check was paused.
    if (data) {
      driver?.setContext(data.wallet, data.capabilities.account_generation, adapter.mode === 'serverless' ? data.capabilities.wallet_configured : undefined);
      startup?.dashboardLoaded(enabled);
    } else startup?.dashboardLoaded(false);
  }, [adapter.mode, data, enabled, driver, startup]);
  const refresh = useCallback((): Promise<void> => {
    if (!enabled || !driver || !startup) return Promise.resolve();
    return startup.manualRefresh(() => driver.refresh());
  }, [enabled, driver, startup]);
  const refreshGift = useCallback((nftAddress: string): Promise<void> => {
    if (adapter.mode !== 'serverless' || data?.capabilities.owned_price_refresh_single !== true || !driver || !startup)
      return Promise.reject(new Error('Individual gift checks are not available in this app.'));
    return startup.manualRefresh(() => driver.refreshGift(nftAddress));
  }, [adapter.mode, data?.capabilities.owned_price_refresh_single, driver, startup]);
  return { driver, refresh, refreshGift };
}
