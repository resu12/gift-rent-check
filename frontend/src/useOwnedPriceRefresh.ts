import { useEffect, useRef, useState } from 'react';
import type { Dashboard, DashboardAdapter } from './data/types';
import { createOwnedPriceStartupGate, OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';

// One key for this page opening, including React's development remount checks.
const pageSessionId = crypto.randomUUID();

/** Local and Telegram dashboards share the same start, hide, stop and reload rules. */
export function useOwnedPriceRefresh(adapter: DashboardAdapter, data: Dashboard | null, reload: () => Promise<void>) {
  const latestReload = useRef(reload);
  latestReload.current = reload;
  const [{ refresh, startup }] = useState(() => {
    const refresh = adapter.ownedPriceTransport ? new OwnedPriceRefreshDriver({
      transport: adapter.ownedPriceTransport,
      sessionId: pageSessionId,
      onSavedDataChanged: () => { void latestReload.current(); },
    }) : null;
    return { refresh, startup: refresh ? createOwnedPriceStartupGate(refresh, () => document.hidden) : null };
  });
  const effectGeneration = useRef(0);
  useEffect(() => {
    const generation = ++effectGeneration.current;
    const leave = () => { adapter.interrupt?.(); startup?.interrupt(); };
    const hide = () => { if (document.hidden) adapter.interrupt?.(); startup?.visibilityChanged(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', leave);
      // StrictMode immediately installs a new effect; a real unmount does not.
      queueMicrotask(() => { if (effectGeneration.current === generation) leave(); });
    };
  }, [adapter, startup]);
  useEffect(() => {
    // This runs after saved data is rendered. Polling and filter changes cannot
    // restart the once-per-opening gate, even when a previous check was paused.
    if (data) startup?.dashboardLoaded(data.capabilities.owned_price_refresh === true);
  }, [data, startup]);
  return refresh;
}
