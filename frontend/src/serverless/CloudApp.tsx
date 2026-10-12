import { Component, lazy, Suspense, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import App from '../App';
import { createCloudDashboardAdapter } from './cloudAdapter';
import { createCloudTransport } from './cloudTransport';
import type { TelegramServerless } from './transport';
import '../pricing.css';
import './cloud.css';

const CloudWalletControl = lazy(() => import('./CloudWalletControl').then(module => ({default: module.CloudWalletControl})));

// Isolate wallet bundle, SDK and storage failures from the saved dashboard.
class WalletConnectionBoundary extends Component<{children: ReactNode; activityTarget?: HTMLElement | null}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (this.state.failed) {
      const fallback = <p role="status">Wallet connection unavailable. Reopen the app to retry.</p>;
      return this.props.activityTarget ? createPortal(fallback, this.props.activityTarget) : fallback;
    }
    return this.props.children;
  }
}

export default function CloudApp() {
  const [adapter] = useState(() => {
    const transport = createCloudTransport((window.Telegram?.WebApp as { Serverless?: TelegramServerless } | undefined)?.Serverless);
    return createCloudDashboardAdapter(transport);
  });
  return <App adapter={adapter}
    walletControl={__TON_CONNECT_CONFIG__ ? (data, activityTarget) => !data || data.capabilities.public_account ? null : <WalletConnectionBoundary activityTarget={activityTarget}><Suspense fallback={activityTarget ? createPortal(<p role="status">Loading wallet connection…</p>, activityTarget) : <button className="button secondary" disabled>Loading wallet…</button>}>
      <CloudWalletControl savedWallet={data?.wallet ?? null} dashboardReady={Boolean(data)} activityTarget={activityTarget} />
    </Suspense></WalletConnectionBoundary> : undefined} />;
}
