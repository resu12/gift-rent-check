import { useEffect, useRef, useState } from 'react';
import TonConnect, { CHAIN, UserRejectsError, WalletWrongNetworkError, isWalletInfoCurrentlyInjected, isWalletInfoRemote } from '@tonconnect/sdk';
import type { WalletInfo } from '@tonconnect/sdk';
import { Icon } from '../Icons';
import type { MarketappLoginTestAdapter } from '../data/types';
import { createMarketappLoginTestController, createMarketappMemoryStorage, marketappLoginFailureDetails, MarketappWalletFailure, marketappWalletLaunchUrl, safeWalletLaunchUrl } from './marketappLoginFlow';
import type { MarketappLoginView, MarketappWalletFactory } from './marketappLoginFlow';
import './marketappLoginTest.css';

export function marketappWalletFactory(returnUrl?: string, includeAccountState = false): MarketappWalletFactory {
  return async (challenge, signal, approved, ended) => {
    const storage = createMarketappMemoryStorage();
    const connector = new TonConnect({ manifestUrl: challenge.manifest_url, storage, analytics: { mode: 'off' },
      disableAutoPauseConnection: true, eventDispatcher: { async dispatchEvent() {}, async addEventListener() { return () => {}; } } });
    connector.setConnectionNetwork(CHAIN.MAINNET);
    let closed = false;
    const unsubscribe = connector.onStatusChange(wallet => {
      if (closed || signal.aborted || !wallet) return;
      const reply = wallet.connectItems?.tonProof;
      if (!reply || !('proof' in reply)) { ended('failed', 'proof_missing'); return; }
      const account = wallet.account;
      const device = wallet.device;
      approved({ address: account.address, chain: account.chain, ...(includeAccountState ? { walletStateInit: account.walletStateInit, ...(account.publicKey ? { publicKey: account.publicKey } : {}) } : {}) },
        { timestamp: reply.proof.timestamp, domain: { lengthBytes: reply.proof.domain.lengthBytes, value: reply.proof.domain.value }, payload: reply.proof.payload, signature: reply.proof.signature },
        includeAccountState ? { platform: device.platform, appName: device.appName, appVersion: device.appVersion, maxProtocolVersion: device.maxProtocolVersion, features: device.features } : undefined);
    }, error => { if (!closed && !signal.aborted) ended(error instanceof UserRejectsError ? 'cancelled' : 'failed', error instanceof WalletWrongNetworkError ? 'mainnet_required' : 'wallet_error'); });
    const close = async () => {
      if (closed) return;
      closed = true; signal.removeEventListener('abort', aborted);
      try { unsubscribe(); connector.pauseConnection(); } catch { /* Abort also closes this connector's opening flow. */ }
      finally { storage.clear(); }
      if (connector.connected) {
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 3000);
        try { await connector.disconnect({ signal: abort.signal }); } catch { /* Only this disposable connector is involved. */ }
        finally { clearTimeout(timer); storage.clear(); }
      }
    };
    const aborted = () => { void close(); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { await close(); throw new Error('Cancelled'); }
    try {
      const registry = await connector.getWallets();
      if (signal.aborted) { await close(); throw new Error('Cancelled'); }
      const wallets = registry.filter(wallet => isWalletInfoCurrentlyInjected(wallet) ||
        (isWalletInfoRemote(wallet) && safeWalletLaunchUrl(wallet.universalLink) && safeWalletLaunchUrl(wallet.bridgeUrl)));
      const byId = new Map<string, WalletInfo>();
      for (const wallet of wallets) {
        if (!byId.has(wallet.appName) || isWalletInfoCurrentlyInjected(wallet)) byId.set(wallet.appName, wallet);
      }
      const options = [...byId.values()].map(wallet => ({ id: wallet.appName, name: wallet.name, installed: isWalletInfoCurrentlyInjected(wallet) }))
        .sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
      return { options, close,
        connect(id) {
          const wallet = byId.get(id);
          if (closed || signal.aborted || !wallet) throw new MarketappWalletFailure('wallet_error');
          if (isWalletInfoCurrentlyInjected(wallet)) {
            try { connector.connect({ jsBridgeKey: wallet.jsBridgeKey }, { tonProof: challenge.challenge }, { signal, openingDeadlineMS: 30_000 }); }
            catch (error) { throw new MarketappWalletFailure(error instanceof WalletWrongNetworkError ? 'mainnet_required' : 'wallet_error'); }
            return null;
          }
          if (!isWalletInfoRemote(wallet)) throw new MarketappWalletFailure('wallet_error');
          let url: string;
          try { url = connector.connect({ bridgeUrl: wallet.bridgeUrl, universalLink: wallet.universalLink },
            { tonProof: challenge.challenge }, { signal, openingDeadlineMS: 30_000 }); }
          catch (error) { throw new MarketappWalletFailure(error instanceof WalletWrongNetworkError ? 'mainnet_required' : 'wallet_error'); }
          const launch = marketappWalletLaunchUrl(url, returnUrl);
          if (!launch) throw new MarketappWalletFailure('launch_invalid');
          return launch;
        },
      };
    } catch { await close(); throw new Error('Wallet chooser unavailable'); }
  };
}

export function openMarketappWallet(url: string) {
  const link = safeWalletLaunchUrl(url);
  if (!link) return;
  const telegram = window.Telegram?.WebApp as ({ openLink?: (url: string) => void; openTelegramLink?: (url: string) => void }) | undefined;
  try {
    if (new URL(link).hostname === 't.me' && telegram?.openTelegramLink) telegram.openTelegramLink(link);
    else if (telegram?.openLink) telegram.openLink(link);
    else window.open(link, '_blank', 'noopener,noreferrer');
  } catch { /* The visible continuation link remains available. */ }
}

export default function MarketappLoginTest({ transport, wallet }: { transport: MarketappLoginTestAdapter; wallet: string | null }) {
  const [view, setView] = useState<MarketappLoginView>({ phase: 'idle' });
  const [more, setMore] = useState(false);
  const controller = useRef<ReturnType<typeof createMarketappLoginTestController> | null>(null);
  useEffect(() => {
    const active = createMarketappLoginTestController(transport, marketappWalletFactory(__TON_CONNECT_CONFIG__?.returnUrl), wallet, setView);
    controller.current = active; setView({ phase: 'idle' });
    return () => { active.dispose(); if (controller.current === active) controller.current = null; };
  }, [transport, wallet]);
  const busy = ['preparing', 'choosing', 'awaiting_approval', 'checking'].includes(view.phase);
  const options = view.options || [];
  const preferred = options.filter(option => option.installed || /tonkeeper|mytonwallet|telegram|^wallet$/i.test(option.id + ' ' + option.name));
  const shown = more || !preferred.length ? options : preferred;
  const failure = marketappLoginFailureDetails(view.failure);
  return <div className="marketapp-login-test">
    <div className="marketapp-login-test-heading"><button type="button" className="button secondary small" disabled={busy || !wallet} onClick={() => { setMore(false); void controller.current?.start(); }}><Icon name="wallet" size={16} />{view.phase === 'passed' ? 'Test connection again' : 'Connect Marketapp'}</button><span>Connection test only · analytics stay unchanged.</span></div>
    {!busy && view.phase !== 'passed' && <p className="marketapp-login-consent">Approve a Marketapp login proof in your wallet. This does not request a transaction.</p>}
    {view.phase === 'preparing' && <p role="status">Preparing wallet approval…</p>}
    {view.phase === 'choosing' && <div className="marketapp-login-chooser"><span>Choose your wallet</span><div>{shown.map(option => <button type="button" className="button secondary small" key={option.id} onClick={() => { const url = controller.current?.choose(option.id); if (url) openMarketappWallet(url); }}>{option.name}{option.installed && <small>Installed</small>}</button>)}</div>{!more && shown.length < options.length && <button type="button" className="text-button" onClick={() => setMore(true)}>More wallets</button>}</div>}
    {view.phase === 'awaiting_approval' && <p role="status">Approve the connection in your wallet.{view.launchUrl && <> <a href={view.launchUrl} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openMarketappWallet(view.launchUrl!); }}>Continue in wallet</a></>}</p>}
    {view.phase === 'checking' && <p role="status">Wallet approval received · checking compatibility…</p>}
    {view.phase === 'passed' && <div className="marketapp-login-result" role="status"><strong>Wallet approval received</strong><p>Marketapp login and analytics refresh have not been tested. The signature was received, not verified.</p>{view.failure === 'rate_limited' && <p className="marketapp-login-consent">{failure.message} Your previous approval is unchanged. <small>({failure.code})</small></p>}</div>}
    {view.phase === 'failed' && <div role="alert"><p className="marketapp-login-error">{failure.message} <small>({failure.code})</small></p><p className="marketapp-login-consent">Analytics stay unchanged.{view.failure !== 'rate_limited' && ' Try a new test after a minute.'}</p></div>}
    {view.phase === 'cancelled' && <p role="status">Connection test cancelled.</p>}
    {view.phase === 'expired' && <p role="status">Wallet approval expired. Start a new connection test.</p>}
    {busy && <button type="button" className="text-button" onClick={() => controller.current?.cancel()}>Cancel test</button>}
  </div>;
}
