import { Component, lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import App from '../App';
import { createCloudDashboardAdapter } from './cloudAdapter';
import { createCloudTransport } from './cloudTransport';
import type { TelegramServerless } from './transport';
import { Icon } from '../Icons';
import { shortWalletAddress } from './walletIdentity';
import { scheduleWalletWarmup } from './deferredWallet';
import '../pricing.css';
import './cloud.css';

const CloudWalletControl = lazy(() => import('./CloudWalletControl').then(module => ({default: module.CloudWalletControl})));

// Isolate wallet bundle, SDK and storage failures from the saved dashboard.
class WalletConnectionBoundary extends Component<{children: ReactNode; activityTarget?: HTMLElement | null}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (this.state.failed) {
      const fallback = <div role="alert"><p>Wallet connection could not load. Your saved data is kept.</p><button type="button" className="button secondary" onClick={() => window.location.reload()}>Reload app</button></div>;
      return this.props.activityTarget ? createPortal(fallback, this.props.activityTarget) : fallback;
    }
    return this.props.children;
  }
}

function DeferredWalletControl({ savedWallet, activityTarget }: { savedWallet: string | null; activityTarget: HTMLElement | null }) {
  const [requested, setRequested] = useState(false);
  const [initiallyExpanded, setInitiallyExpanded] = useState(false);
  useEffect(() => {
    if (requested) return;
    if (activityTarget) { setRequested(true); return; }
    return scheduleWalletWarmup(() => setRequested(true), {
      hidden: () => document.hidden,
      visibilityChanged(callback) {
        document.addEventListener('visibilitychange', callback);
        return () => document.removeEventListener('visibilitychange', callback);
      },
      timer(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
      idle(callback) {
        if (typeof window.requestIdleCallback === 'function') {
          const idle = window.requestIdleCallback(callback, { timeout: 3000 });
          return () => window.cancelIdleCallback(idle);
        }
        const timer = setTimeout(callback, 500); return () => clearTimeout(timer);
      },
    });
  }, [requested, activityTarget]);
  if (!requested && !activityTarget) return <button type="button" className="wallet-chip" aria-label="Open wallet connection details"
    onClick={() => { setInitiallyExpanded(true); setRequested(true); }}>
    <span className="wallet-avatar"><Icon name="wallet" size={15} /></span>
    <span>{savedWallet ? `Saved: ${shortWalletAddress(savedWallet)}` : 'Wallet connection'}</span><Icon name="chevron" size={14} />
  </button>;
  return <WalletConnectionBoundary activityTarget={activityTarget}><Suspense fallback={activityTarget ? createPortal(<p role="status">Loading wallet connection…</p>, activityTarget) : <button className="button secondary" disabled>Loading wallet…</button>}>
    <CloudWalletControl savedWallet={savedWallet} dashboardReady initiallyExpanded={initiallyExpanded} activityTarget={activityTarget} />
  </Suspense></WalletConnectionBoundary>;
}

export default function CloudApp() {
  const [adapter] = useState(() => {
    const transport = createCloudTransport((window.Telegram?.WebApp as { Serverless?: TelegramServerless } | undefined)?.Serverless);
    return createCloudDashboardAdapter(transport);
  });
  return <App adapter={adapter}
    walletControl={__TON_CONNECT_CONFIG__ ? (data, activityTarget) => !data || data.capabilities.public_account ? null
      : <DeferredWalletControl savedWallet={data.wallet} activityTarget={activityTarget} /> : undefined} />;
}
