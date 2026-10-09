import { Component, lazy, Suspense, useState } from 'react';
import type { ReactNode } from 'react';
import App from '../App';
import { createCloudDashboardAdapter } from './cloudAdapter';
import { createCloudTransport } from './cloudTransport';
import type { TelegramServerless } from './transport';
import '../pricing.css';
import './cloud.css';

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
  const [adapter] = useState(() => {
    const transport = createCloudTransport((window.Telegram?.WebApp as { Serverless?: TelegramServerless } | undefined)?.Serverless);
    return createCloudDashboardAdapter(transport);
  });
  return <App adapter={adapter}
    walletControl={__TON_CONNECT_CONFIG__ ? data => <WalletConnectionBoundary><Suspense fallback={<button className="button secondary" disabled>Loading wallet…</button>}>
      <CloudWalletControl savedWallet={data?.wallet ?? null} dashboardReady={Boolean(data)} />
    </Suspense></WalletConnectionBoundary> : undefined} />;
}
