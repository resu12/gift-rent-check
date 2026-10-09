import { useEffect, useId, useRef, useState } from 'react';
import { useTonConnectUI, useTonWallet } from '@tonconnect/ui-react';
import { Icon } from '../Icons';
import { observeWalletRestoration, shortWalletAddress, walletBinding } from './walletIdentity';
import './walletConnection.css';

export function WalletConnection({ savedWallet, dashboardReady = true }: {
  savedWallet: string | null;
  dashboardReady?: boolean;
}) {
  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();
  const [restored, setRestored] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const binding = walletBinding({ restored, account: wallet?.account ?? null, savedWallet, dashboardReady });
  const hasSession = restored && wallet !== null;
  const warning = ['different_wallet', 'unsupported_network', 'invalid_address'].includes(binding.state);
  const label = binding.state === 'restoring' ? 'Restoring wallet…'
    : binding.state === 'unsupported_network' ? 'Mainnet required'
      : binding.state === 'invalid_address' ? 'Check wallet'
        : binding.address ? shortWalletAddress(binding.address) : 'Connect wallet';

  // Wallet-side account changes and disconnections must replace the displayed session.
  useEffect(() => { setError(null); }, [wallet?.account.address, wallet?.account.chain]);
  useEffect(() => observeWalletRestoration(tonConnectUI.connectionRestored, restoreError => {
    setRestored(true);
    if (restoreError) { setError(restoreError); setExpanded(true); }
  }), [tonConnectUI]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setExpanded(false); toggleRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [expanded]);

  async function act(action: 'connect' | 'disconnect') {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setError(null);
    try {
      if (action === 'connect') { setExpanded(false); await tonConnectUI.openModal(); }
      else { await tonConnectUI.disconnect(); setExpanded(true); }
    } catch {
      setError(action === 'connect'
        ? 'The wallet chooser could not open. Try connecting again.'
        : 'The wallet could not disconnect. Try again.');
      setExpanded(true);
    } finally { pendingRef.current = false; setPending(null); }
  }

  return <div className={`wallet-connection${warning ? ' has-warning' : ''}`} ref={rootRef}>
    <div className="wallet-connection-controls">
      <button type="button" className="wallet-connection-main"
        disabled={!restored || pending !== null}
        aria-label={hasSession ? `${label}. Manage wallet connection` : label}
        aria-expanded={hasSession ? expanded : undefined}
        aria-controls={hasSession ? panelId : undefined}
        onClick={() => { if (hasSession) setExpanded(value => !value); else void act('connect'); }}>
        <Icon name="wallet" size={18}/>
        <span>{pending === 'disconnect' ? 'Disconnecting…' : label}
          {binding.state === 'different_wallet' && <small>Different wallet</small>}
        </span>
        {hasSession && <i className="wallet-connection-dot" aria-hidden="true"/>}
      </button>
      <button type="button" className="wallet-connection-toggle" ref={toggleRef}
        aria-label="Wallet connection details" aria-expanded={expanded} aria-controls={panelId}
        onClick={() => setExpanded(value => !value)}><Icon name="chevron" size={14}/></button>
    </div>
    {expanded && <section className="wallet-connection-panel" id={panelId} aria-label="Wallet connection">
      <div className="wallet-connection-heading"><strong>Wallet connection</strong>
        <button type="button" className="icon-button" aria-label="Close wallet details"
          onClick={() => { setExpanded(false); toggleRef.current?.focus(); }}><Icon name="close" size={17}/></button>
      </div>
      <div role="status" aria-live="polite" className={warning ? 'wallet-connection-warning' : ''}>
        {binding.state === 'restoring' && <p>Restoring your wallet connection…</p>}
        {binding.state === 'disconnected' && <p>No wallet connected. Choose a wallet and approve the connection in your wallet app.</p>}
        {binding.state === 'matching' && <p>Connected to your saved portfolio wallet.</p>}
        {binding.state === 'different_wallet' && <p>This wallet is different from your saved portfolio. Connecting does not switch or import portfolio data.</p>}
        {binding.state === 'loading_portfolio' && <p>Wallet connected. Loading the saved portfolio address…</p>}
        {binding.state === 'unknown_portfolio' && <p>Wallet connected. The saved portfolio address could not be verified. Your saved data is unchanged.</p>}
        {binding.state === 'unsupported_network' && <p>This connection is not on TON mainnet. Disconnect, switch your wallet to mainnet, and connect again.</p>}
        {binding.state === 'invalid_address' && <p>The wallet returned an invalid mainnet address. Disconnect and try connecting again.</p>}
      </div>
      {binding.address && <div className="wallet-connection-address"><span>Connected wallet</span><code>{binding.address}</code></div>}
      {savedWallet && <div className="wallet-connection-address"><span>Saved portfolio belongs to</span><code>{savedWallet}</code></div>}
      <p className="wallet-connection-note">Read-only connection. Disconnecting keeps your saved gifts and price updates. Telegram still controls access to this private dashboard.</p>
      {error && <p role="alert" className="wallet-connection-warning">{error}</p>}
      <button type="button" className="button secondary wallet-connection-action" disabled={!restored || pending !== null}
        onClick={() => { void act(hasSession ? 'disconnect' : 'connect'); }}>
        {pending === 'disconnect' ? 'Disconnecting…' : pending === 'connect' ? 'Opening wallet chooser…' : hasSession ? 'Disconnect wallet' : 'Connect wallet'}
      </button>
    </section>}
  </div>;
}
