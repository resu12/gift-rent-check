import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Dashboard, DashboardAdapter, PricingSelection } from './data/types';
import { savedGiftRefreshEnabled, type OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';
import { createComparisonStartupGate } from './serverless/comparisonsStartup';
import type { AnalyticsStartupSnapshot } from './serverless/analyticsStartup';
import { canonicalMainnetAddress } from './serverless/walletIdentity';

/** Telegram lifecycle checks the initial pricing selection once, independent of tabs. */
export function useComparisonStartupRefresh(adapter: DashboardAdapter, data: Dashboard | null, selection: PricingSelection,
  gifts: OwnedPriceRefreshDriver | null, analytics: AnalyticsStartupSnapshot, manualBusy: boolean, jobsBusy: boolean) {
  const [gate] = useState(() => createComparisonStartupGate({
    refresh: (chosen, signal) => adapter.startupComparisonRefresh!(chosen, signal), isHidden: () => document.hidden,
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
      const expected = savedGiftRefreshEnabled(adapter.mode, data.capabilities) && Boolean(gifts);
      const status = gifts?.getSnapshot();
      gate.giftsChanged(!expected || Boolean(status && status.phase !== 'idle' && status.canRefresh === true));
    };
    update();
    let active = true; queueMicrotask(() => { if (active) update(); });
    const unsubscribe = gifts?.subscribe(update);
    return () => { active = false; unsubscribe?.(); };
  }, [adapter.mode, data?.capabilities, gifts, gate]);
  useEffect(() => {
    const wallet = canonicalMainnetAddress(data?.wallet);
    gate.dashboardLoaded(data ? {
      identity: `${wallet ?? data.wallet ?? ''}:${data.capabilities.account_generation ?? ''}:${data.capabilities.public_account === true}`,
      enabled: adapter.mode === 'serverless' && data.capabilities.startup_comparison_refresh === true &&
        data.capabilities.network_enabled && data.capabilities.marketapp_configured && data.capabilities.wallet_configured &&
        data.summary.portfolio_count > 0 && Boolean(wallet && adapter.startupComparisonRefresh),
      selection,
    } : null);
  }, [adapter, data, selection, gate]);
  useEffect(() => {
    const expected = data?.capabilities.marketapp_analytics_refresh === true && Boolean(adapter.marketappAnalyticsRefresh?.refreshStartup && canonicalMainnetAddress(data.wallet));
    gate.analyticsChanged(Boolean(data) && !analytics.busy && (!expected || !['idle', 'waiting', 'updating'].includes(analytics.phase)));
  }, [adapter, data, gate, analytics]);
  useEffect(() => { gate.manualChanged(manualBusy); }, [gate, manualBusy]);
  useEffect(() => { gate.jobsChanged(jobsBusy); }, [gate, jobsBusy]);
  return { snapshot, manualAction: gate.manualAction };
}
