import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import App from '../App';
import { createCloudDashboardAdapter } from './cloudAdapter';
import { createCloudTransport } from './cloudTransport';
import type { TelegramServerless } from './transport';
import { createOwnedPriceStartupGate, OwnedPriceRefreshDriver } from './ownedPriceRefresh';
import { OwnedPriceStatus } from './OwnedPriceStatus';
import '../pricing.css';
import './cloud.css';

// One key for this page opening, including React's development remount checks.
const pageSessionId = crypto.randomUUID();
const CloudWalletControl = lazy(() => import('./CloudWalletControl').then(module => ({default: module.CloudWalletControl})));

// Isolate wallet bundle, SDK and storage failures from the saved dashboard.
class WalletConnectionBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (this.state.failed) return <span className="wallet-chip" role="status" title="Reload the app to retry. Saved portfolio is still available.">Wallet connection unavailable</span>;
    return this.props.children;
  }
}

export default function CloudApp() {
  const [{ adapter, refresh, startup }] = useState(() => {
    const transport = createCloudTransport((window.Telegram?.WebApp as { Serverless?: TelegramServerless } | undefined)?.Serverless);
    const adapter = createCloudDashboardAdapter(transport, {
      onDashboardLoaded: data => {
        startup.dashboardLoaded(data.capabilities.owned_price_refresh === true);
      },
    });
    const refresh = new OwnedPriceRefreshDriver({ transport, sessionId: pageSessionId, onSavedDataChanged: () => adapter.savedDataChanged() });
    const startup = createOwnedPriceStartupGate(refresh, () => document.hidden);
    return { adapter, refresh, startup };
  });
  const effectGeneration = useRef(0);
  useEffect(() => {
    const generation = ++effectGeneration.current;
    const leave = () => { adapter.interrupt(); startup.interrupt(); };
    const hide = () => { if (document.hidden) adapter.interrupt(); startup.visibilityChanged(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave);
      // StrictMode immediately installs a new effect; a real unmount does not.
      queueMicrotask(() => { if (effectGeneration.current === generation) leave(); });
    };
  }, [adapter, startup]);
  return <App adapter={adapter} ownedPriceStatus={<OwnedPriceStatus driver={refresh} />}
    walletControl={__TON_CONNECT_CONFIG__ ? data => <WalletConnectionBoundary><Suspense fallback={<button className="button secondary" disabled>Loading wallet…</button>}>
      <CloudWalletControl savedWallet={data?.wallet ?? null} dashboardReady={Boolean(data)} />
    </Suspense></WalletConnectionBoundary> : undefined} />;
}
