import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard, DashboardAdapter } from './data/types';
import { createOwnedPriceReloadScheduler, createOwnedPriceStartupGate, OwnedPriceRefreshDriver, savedGiftRefreshEnabled } from './data/ownedPriceRefresh';
import { canonicalMainnetAddress } from './serverless/walletIdentity';

// One key for this page opening, including React's development remount checks.
const pageSessionId = crypto.randomUUID();

/** Local and Telegram dashboards share the same start, hide, stop and reload rules. */
export function useOwnedPriceRefresh(adapter: DashboardAdapter, data: Dashboard | null, reloadDashboard: () => Promise<void>) {
  const enabled = savedGiftRefreshEnabled(adapter.mode, data?.capabilities);
  // Await only saved gift data; a slow collection-progress request must not
  // hold the scheduler open and postpone a later gift commit.
  const latestReload = useRef(reloadDashboard);
  latestReload.current = reloadDashboard;
  const [{ driver, startup, reloadScheduler }] = useState(() => {
    const reloadScheduler = createOwnedPriceReloadScheduler({ reload: () => latestReload.current(), isHidden: () => document.hidden });
    const driver = adapter.ownedPriceTransport ? new OwnedPriceRefreshDriver({
      transport: adapter.ownedPriceTransport,
      sessionId: pageSessionId,
      onSavedDataChanged: update => reloadScheduler.notify(update),
    }) : null;
    return { driver, reloadScheduler, startup: driver ? createOwnedPriceStartupGate(driver, () => document.hidden,
      adapter.mode === 'serverless' ? { reopenAfterMs: 300000 } : {}) : null };
  });
  const effectGeneration = useRef(0);
  useEffect(() => {
    const generation = ++effectGeneration.current;
    // A restored Telegram WebView may be hours old. A long absence can start
    // a fresh check only after a confirmed completion; interrupted work stays paused.
    const leave = () => { reloadScheduler.pause(); adapter.interrupt?.(); startup?.interrupt(); };
    const hide = () => {
      if (document.hidden) { reloadScheduler.pause(); adapter.interrupt?.(); }
      else void reloadScheduler.flush().catch(() => undefined);
      startup?.visibilityChanged();
    };
    const show = () => { void reloadScheduler.flush().catch(() => undefined); startup?.visibilityChanged(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', show);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', show);
      // StrictMode immediately installs a new effect; a real unmount does not.
      queueMicrotask(() => { if (effectGeneration.current === generation) { leave(); startup?.dispose(); reloadScheduler.dispose(); } });
    };
  }, [adapter, startup, reloadScheduler]);
  const savedScope = useRef<string | null>(null);
  useEffect(() => {
    // This runs after saved data is rendered. Polling and filter changes cannot
    // restart the once-per-opening gate, even when a previous check was paused.
    if (data) {
      const scope = `${canonicalMainnetAddress(data.wallet) ?? data.wallet ?? ''}:${data.capabilities.account_generation ?? ''}:${adapter.mode === 'serverless' ? data.capabilities.wallet_configured : ''}`;
      if (savedScope.current !== null && savedScope.current !== scope) reloadScheduler.cancel();
      savedScope.current = scope;
      driver?.setContext(data.wallet, data.capabilities.account_generation, adapter.mode === 'serverless' ? data.capabilities.wallet_configured : undefined);
      startup?.dashboardLoaded(enabled && !data.startup_preview);
    } else startup?.dashboardLoaded(false);
  }, [adapter.mode, data, enabled, driver, startup, reloadScheduler]);
  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !driver || !startup) return;
    await startup.manualRefresh(() => driver.refresh(), enabled);
    await reloadScheduler.flush();
  }, [enabled, driver, startup, reloadScheduler]);
  const refreshGift = useCallback(async (nftAddress: string): Promise<void> => {
    if (adapter.mode !== 'serverless' || data?.capabilities.owned_price_refresh_single !== true || !driver || !startup)
      throw new Error('Individual gift checks are not available in this app.');
    await startup.manualRefresh(() => driver.refreshGift(nftAddress), enabled);
    await reloadScheduler.flush();
  }, [adapter.mode, data?.capabilities.owned_price_refresh_single, driver, startup, reloadScheduler]);
  return { driver, refresh, refreshGift };
}
