import { useEffect, useRef, useState } from 'react';
import TonConnect, { CHAIN, UserRejectsError, isWalletInfoCurrentlyInjected, isWalletInfoRemote } from '@tonconnect/sdk';
import type { WalletInfo } from '@tonconnect/sdk';
import { Icon } from '../Icons';
import type { PublicAccountAdapter, PublicAccountStatus } from './publicAccount';
import { createPublicProofStorage, createPublicWalletController } from './publicWalletFlow';
import type { PublicProofWalletFactory, PublicWalletView } from './publicWalletFlow';
import { marketappWalletLaunchUrl, safeWalletLaunchUrl } from './marketappLoginFlow';

export function publicProofWalletFactory(returnUrl?: string): PublicProofWalletFactory {
  return async (challenge, signal, approved, ended) => {
    const storage = createPublicProofStorage();
    const connector = new TonConnect({ manifestUrl: challenge.manifest_url, storage, analytics: { mode: 'off' },
      disableAutoPauseConnection: true, eventDispatcher: { async dispatchEvent() {}, async addEventListener() { return () => {}; } } });
    connector.setConnectionNetwork(CHAIN.MAINNET);
    let closed = false;
    const unsubscribe = connector.onStatusChange(wallet => {
      if (closed || signal.aborted || !wallet) return;
      const reply = wallet.connectItems?.tonProof;
      if (!reply || !('proof' in reply)) { ended('failed'); return; }
      const account = wallet.account, proof = reply.proof;
      approved({ address: account.address, chain: account.chain, walletStateInit: account.walletStateInit,
        ...(account.publicKey ? { publicKey: account.publicKey } : {}) },
      { timestamp: proof.timestamp, domain: { lengthBytes: proof.domain.lengthBytes, value: proof.domain.value }, payload: proof.payload, signature: proof.signature });
    }, error => { if (!closed && !signal.aborted) ended(error instanceof UserRejectsError ? 'cancelled' : 'failed'); });
    const close = async () => {
      if (closed) return; closed = true; signal.removeEventListener('abort', aborted);
      try { unsubscribe(); connector.pauseConnection(); } catch { /* Local cleanup still runs. */ }
      storage.clear();
      if (connector.connected) {
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 3000);
        try { await connector.disconnect({ signal: abort.signal }); } catch { /* Disposable proof connection only. */ }
        finally { clearTimeout(timeout); storage.clear(); }
      }
    };
    const aborted = () => { void close(); }; signal.addEventListener('abort', aborted, { once: true });
    try {
      if (signal.aborted) throw new Error('Cancelled');
      const registry = await connector.getWallets();
      if (signal.aborted) throw new Error('Cancelled');
      const wallets = new Map<string, WalletInfo>();
      for (const wallet of registry) {
        if (isWalletInfoCurrentlyInjected(wallet) || (isWalletInfoRemote(wallet) && safeWalletLaunchUrl(wallet.universalLink) && safeWalletLaunchUrl(wallet.bridgeUrl))) {
          if (!wallets.has(wallet.appName) || isWalletInfoCurrentlyInjected(wallet)) wallets.set(wallet.appName, wallet);
        }
      }
      return { options: [...wallets.values()].map(wallet => ({ id: wallet.appName, name: wallet.name, installed: isWalletInfoCurrentlyInjected(wallet) }))
        .sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)), close,
        connect(id) {
          const wallet = wallets.get(id);
          if (closed || signal.aborted || !wallet) throw new Error('Wallet unavailable');
          if (isWalletInfoCurrentlyInjected(wallet)) {
            connector.connect({ jsBridgeKey: wallet.jsBridgeKey }, { tonProof: challenge.challenge }, { signal, openingDeadlineMS: 30_000 }); return null;
          }
          if (!isWalletInfoRemote(wallet)) throw new Error('Wallet unavailable');
          const url = connector.connect({ bridgeUrl: wallet.bridgeUrl, universalLink: wallet.universalLink }, { tonProof: challenge.challenge }, { signal, openingDeadlineMS: 30_000 });
          const launch = marketappWalletLaunchUrl(url, returnUrl); if (!launch) throw new Error('Invalid wallet link'); return launch;
        } };
    } catch { await close(); throw new Error('Wallet chooser unavailable'); }
  };
}

function openWallet(url: string) {
  const safe = safeWalletLaunchUrl(url); if (!safe) return;
  const telegram = window.Telegram?.WebApp as ({ openLink?: (url: string) => void; openTelegramLink?: (url: string) => void }) | undefined;
  try {
    if (new URL(safe).hostname === 't.me' && telegram?.openTelegramLink) telegram.openTelegramLink(safe);
    else if (telegram?.openLink) telegram.openLink(safe);
    else window.open(safe, '_blank', 'noopener,noreferrer');
  } catch { /* The continuation link remains visible. */ }
}

export function PublicWalletProof({ adapter, onVerified, disabled = false }: {
  adapter: PublicAccountAdapter; onVerified: (account: PublicAccountStatus) => void; disabled?: boolean;
}) {
  const [view, setView] = useState<PublicWalletView>({ phase: 'idle' });
  const [more, setMore] = useState(false);
  const controller = useRef<ReturnType<typeof createPublicWalletController> | null>(null);
  const verified = useRef(onVerified); verified.current = onVerified;
  const config = __TON_CONNECT_CONFIG__;
  useEffect(() => {
    if (!config) return;
    const active = createPublicWalletController(adapter, publicProofWalletFactory(config.returnUrl), config.manifestUrl, window.location.origin,
      setView, account => verified.current(account));
    controller.current = active;
    return () => { active.dispose(); if (controller.current === active) controller.current = null; };
  }, [adapter, config]);
  const busy = ['preparing', 'choosing', 'awaiting_approval', 'checking'].includes(view.phase);
  const options = view.options ?? [];
  const preferred = options.filter(option => option.installed || /tonkeeper|mytonwallet|telegram|^wallet$/i.test(option.id + ' ' + option.name));
  const shown = more || !preferred.length ? options : preferred;
  return <div className="public-wallet-proof">
    <button type="button" className="button primary" disabled={disabled || busy || !config}
      onClick={() => { setMore(false); void controller.current?.start(); }}><Icon name="wallet" size={18} />Connect and verify wallet</button>
    {!config && <p role="alert">Wallet verification is not configured for this app.</p>}
    {view.phase === 'idle' && <p className="public-account-note">Approve a login proof in your wallet. No transaction is requested.</p>}
    {view.phase === 'preparing' && <p role="status">Preparing wallet approval…</p>}
    {view.phase === 'choosing' && <div className="public-account-wallets"><span>Choose your wallet</span><div>{shown.map(option =>
      <button type="button" className="button secondary small" key={option.id} onClick={() => { const link = controller.current?.choose(option.id); if (link) openWallet(link); }}>{option.name}</button>)}</div>
      {!more && shown.length < options.length && <button type="button" className="text-button" onClick={() => setMore(true)}>More wallets</button>}</div>}
    {view.phase === 'awaiting_approval' && <p role="status">Approve in your wallet.{view.launchUrl && <> <a href={view.launchUrl} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openWallet(view.launchUrl!); }}>Continue in wallet</a></>}</p>}
    {view.phase === 'checking' && <p role="status">Verifying wallet ownership…</p>}
    {view.phase === 'verified' && <p role="status">Wallet verified.</p>}
    {view.phase === 'failed' && <p role="alert" className="public-account-error">{view.error ?? 'Wallet approval could not be verified. Try again.'}</p>}
    {view.phase === 'expired' && <p role="status">Approval expired. Connect again.</p>}
    {view.phase === 'cancelled' && <p role="status">Wallet approval cancelled.</p>}
    {busy && <button type="button" className="text-button" onClick={() => controller.current?.cancel()}>Cancel</button>}
  </div>;
}
