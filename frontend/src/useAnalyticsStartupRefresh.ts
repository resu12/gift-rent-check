import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Dashboard, DashboardAdapter } from './data/types';
import { savedGiftRefreshEnabled, type OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';
import { createAnalyticsStartupGate } from './serverless/analyticsStartup';
import { canonicalMainnetAddress } from './serverless/walletIdentity';

/** Telegram page lifecycle owns analytics refresh independently of the selected tab. */
export function useAnalyticsStartupRefresh(adapter: DashboardAdapter, data: Dashboard | null, gifts: OwnedPriceRefreshDriver | null,
  reload: () => Promise<void>, manualBusy: boolean) {
  const latestReload = useRef(reload); latestReload.current = reload;
  const [gate] = useState(() => createAnalyticsStartupGate({
    refresh: (period, signal) => adapter.marketappAnalyticsRefresh!.refreshStartup!(period, signal),
    onSavedDataChanged: () => latestReload.current(), isHidden: () => document.hidden,
  }));
  const snapshot = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const effectGeneration = useRef(0);
  useEffect(() => {
    const generation = ++effectGeneration.current;
    const hide = () => gate.visibilityChanged(), leave = () => gate.interrupt();
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave);
      queueMicrotask(() => { if (effectGeneration.current === generation) gate.dispose(); });
    };
  }, [gate]);
  useEffect(() => {
    const update = () => {
      if (!data) { gate.giftsChanged(false); return; }
      const expected = savedGiftRefreshEnabled(adapter.mode, data?.capabilities) && Boolean(gifts);
      const status = gifts?.getSnapshot();
      gate.giftsChanged(!expected || Boolean(status && status.phase !== 'idle' && status.canRefresh === true));
    };
    // Gift startup effects run first. A microtask avoids treating initial idle as settled.
    update();
    let active = true; queueMicrotask(() => { if (active) update(); });
    const unsubscribe = gifts?.subscribe(update);
    return () => { active = false; unsubscribe?.(); };
  }, [adapter.mode, data?.capabilities, gifts, gate]);
  useEffect(() => {
    const wallet = canonicalMainnetAddress(data?.wallet);
    gate.dashboardLoaded(data ? {
      identity: `${wallet ?? data.wallet ?? ''}:${data.capabilities.account_generation ?? ''}:${data.capabilities.public_account === true}`,
      enabled: adapter.mode === 'serverless' && data.capabilities.marketapp_analytics_refresh === true && Boolean(wallet && adapter.marketappAnalyticsRefresh?.refreshStartup),
      periodDays: data.personal_analytics?.daily.length === 365 ? 365 : 30,
      capturedAt: data.personal_analytics?.captured_at,
    } : null);
  }, [adapter, data, gate]);
  useEffect(() => { gate.manualChanged(manualBusy); }, [gate, manualBusy]);
  return snapshot;
}
