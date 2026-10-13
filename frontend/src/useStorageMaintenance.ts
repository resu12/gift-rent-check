import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Dashboard, DashboardAdapter } from './data/types';
import { createStorageMaintenanceController } from './data/storageMonitoring';
import { canonicalMainnetAddress } from './serverless/walletIdentity';

/** Starts after saved data loads and is independent of the selected tab. */
export function useStorageMaintenance(adapter: DashboardAdapter, data: Dashboard | null, providerBusy: boolean) {
  const controller = useMemo(() => createStorageMaintenanceController({
    adapter: { get: signal => adapter.storageMaintenance!.get(signal), step: manual => adapter.storageMaintenance!.step(manual) },
    isHidden: () => document.hidden,
  }), [adapter]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const lifetime = useRef(0);
  const mountedController = useRef(controller);
  useEffect(() => {
    mountedController.current = controller;
    const generation = ++lifetime.current;
    const visibility = () => controller.visibilityChanged();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      queueMicrotask(() => { if (mountedController.current !== controller || lifetime.current === generation) controller.dispose(); });
    };
  }, [controller]);
  useEffect(() => {
    controller.context(adapter.mode === 'serverless' && adapter.storageMaintenance && data
      ? `${canonicalMainnetAddress(data.wallet) ?? data.wallet ?? ''}:${data.capabilities.public_account === true}:${data.capabilities.account_generation ?? ''}` : null);
  }, [controller, adapter, data?.wallet, data?.capabilities.public_account, data?.capabilities.account_generation, Boolean(data)]);
  useEffect(() => { controller.providerBusy(providerBusy || Boolean(data?.startup_preview)); }, [controller, providerBusy, Boolean(data?.startup_preview)]);
  return { snapshot, cleanNow: controller.cleanNow, checkNow: controller.checkNow };
}
