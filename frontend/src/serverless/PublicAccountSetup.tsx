import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icons';
import type { DashboardAdapter, Job } from '../data/types';
import type { PublicAccountAdapter, PublicAccountStatus } from './publicAccount';
import { createPublicAccountReader, publicAccountError, publicAccountStep, validPublicApiKey, selectPublicDiscovery } from './publicAccount';
import { PublicWalletProof } from './PublicWalletProof';
import { shortWalletAddress } from './walletIdentity';
import './publicAccount.css';

type Action = 'save' | 'remove' | 'test' | 'disconnect' | 'delete' | 'reactivate' | 'discover' | 'resume';

export function PublicAccountSetup(props: {
  enabled: boolean;
  adapter: PublicAccountAdapter;
  accountScope?: string;
  dashboardAdapter?: DashboardAdapter;
  jobs?: Job[];
  portfolioCount?: number;
  variant?: 'setup' | 'connections';
  marketappConnection?: ReactNode;
  onChanged(): void;
  onExport?(): void;
  onClose?(): void;
}) {
  // A transient dashboard reload has no new scope. Keep the current editor until
  // a confirmed account change, then discard its old account and credentials.
  const scope = useRef(props.accountScope);
  if (props.accountScope !== undefined) scope.current = props.accountScope;
  return props.enabled ? <AccountSetup key={scope.current} {...props} /> : null;
}

function AccountSetup({ adapter, dashboardAdapter, jobs = [], portfolioCount = 0, variant = 'setup', marketappConnection, onChanged, onExport, onClose }: Parameters<typeof PublicAccountSetup>[0]) {
  const [account, setAccount] = useState<PublicAccountStatus | null>(null);
  const [key, setKey] = useState('');
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [startingAgain, setStartingAgain] = useState(false);
  const [discovery, setDiscovery] = useState<Job | null>(null);
  const mounted = useRef(true), acting = useRef(false), requestGeneration = useRef(0);
  const reader = useMemo(() => createPublicAccountReader(adapter,
    value => { setAccount(value); setError(null); }, problem => setError(publicAccountError(problem))), [adapter]);
  const keyInput = useRef<HTMLInputElement>(null);
  const keyId = useId(), keyHelpId = useId(), deleteId = useId();
  const clearKey = () => { setKey(''); if (keyInput.current) keyInput.current.value = ''; };
  const step = publicAccountStep(account);
  const liveDiscovery = !account?.deleted && discovery && ['queued', 'running'].includes(discovery.state) && discovery.progress.requires_resume !== true;
  const busy = pending !== null || Boolean(liveDiscovery);

  useEffect(() => {
    mounted.current = true; acting.current = false;
    setAccount(null); setPending(null); setError(null); setNotice(null);
    clearKey(); setKeyEditorOpen(false); void reader.reload();
    return () => { mounted.current = false; requestGeneration.current++; reader.invalidate(); if (keyInput.current) keyInput.current.value = ''; };
  }, [reader]);
  useEffect(() => { clearKey(); setKeyEditorOpen(false); }, [account?.account_generation, account?.wallet?.address, account?.deleted]);
  useEffect(() => {
    setDiscovery(current => selectPublicDiscovery(account, jobs, current));
  }, [jobs, account]);
  useEffect(() => dashboardAdapter?.subscribe?.(event => {
    if (event.job?.kind === 'discover' && event.job.account_generation === account?.account_generation) setDiscovery(event.job);
    if (event.savedDataChanged && !acting.current) void reader.reload();
  }), [reader, dashboardAdapter, account?.account_generation]);

  async function reload() {
    setError(null); await reader.reload();
  }
  async function act(action: Action) {
    if (!account || acting.current || (busy && action !== 'delete' && action !== 'remove')) return;
    if (action === 'save' && !validPublicApiKey(key)) { clearKey(); setError('Paste your Marketapp API key without spaces.'); return; }
    if (action === 'delete' && deleteText !== 'DELETE') return;
    if (action === 'reactivate' && (!startingAgain || account.pending_cleanup)) return;
    const suppliedKey = key; clearKey(); acting.current = true; reader.invalidate();
    const generation = ++requestGeneration.current; setPending(action); setError(null); setNotice(null);
    const current = () => mounted.current && generation === requestGeneration.current;
    try {
      if (action === 'discover' || action === 'resume') {
        const job = action === 'resume' && discovery ? await adapter.resumeDiscovery(discovery.id, discovery.account_generation) : await adapter.startDiscovery();
        if (current()) setDiscovery(job);
      } else if (action === 'test') {
        const check = await adapter.testKey();
        if (current()) {
          setAccount(check.account); setNotice(check.status === 'valid' ? 'Marketapp accepted your API key.'
            : check.status === 'invalid' ? 'Marketapp did not accept this key. Replace it and check again.' : 'The key could not be checked right now. Try again later.');
        }
      } else {
        if (action === 'delete' || action === 'remove') dashboardAdapter?.interrupt?.();
        const next = action === 'reactivate' ? await adapter.reactivate() : action === 'save' ? await adapter.saveKey(suppliedKey)
          : action === 'remove' ? await adapter.removeKey()
            : action === 'disconnect' ? await adapter.disconnectWallet() : await adapter.deleteAccount();
        if (current()) {
          setAccount(next); setNotice(action === 'reactivate' ? 'A new empty account is ready.' : action === 'save' ? 'API key saved securely. Use Check key to test it.'
            : action === 'remove' ? 'API key removed.' : action === 'disconnect' ? 'Wallet disconnected.' : next.pending_cleanup ? 'Account access is disabled. Saved storage is being cleared.' : 'Your saved account data was deleted.');
          if (action === 'delete') { setDiscovery(null); setDeleting(false); setDeleteText(''); }
          if (action === 'reactivate') { setDiscovery(null); setStartingAgain(false); }
          if (action === 'save' || action === 'remove') setKeyEditorOpen(false);
        }
      }
      if (current()) onChanged();
    } catch (problem) {
      if (current()) {
        setError(publicAccountError(problem));
        // A mutation may have committed. Reconcile once without repeating it.
        try { const next = await adapter.get(); if (current()) setAccount(next); } catch { /* Explicit read retry remains available. */ }
        onChanged();
      }
    } finally { if (current()) { acting.current = false; clearKey(); setPending(null); } }
  }

  const sync = discovery?.progress.sync;
  const percent = sync && sync.total && sync.total > 0 ? Math.min(100, Math.max(0, Math.floor(sync.completed / sync.total * 100))) : null;
  const mayResume = discovery && discovery.resume_supported !== false && ['queued', 'running', 'partial'].includes(discovery.state) && !liveDiscovery;
  return <section className={`public-account-setup${variant === 'connections' ? ' public-account-connections' : ''}`} aria-labelledby={`${keyId}-title`}>
    <header><div><h2 id={`${keyId}-title`}>{variant === 'connections' ? 'Connections' : portfolioCount ? 'Your account' : 'Set up Gift Rent Check'}</h2>
      {variant !== 'connections' && <p>Your Telegram account keeps your wallet, API key, and portfolio separate.</p>}</div>
      {variant !== 'connections' && onClose && <button type="button" className="icon-button" aria-label="Close account settings" onClick={() => { clearKey(); onClose(); }}><Icon name="close" size={20} /></button>}</header>
    {error && <div className="public-account-error" role="alert"><p>{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => { void reload(); }}>Reload settings</button></div>}
    {notice && <p role="status" className="public-account-notice">{notice}</p>}
    {step === 'loading' && !error && <p role="status">Loading your account…</p>}
    {account?.deleted && <div className="public-account-step"><h3>{account.pending_cleanup ? 'Clearing your saved account data' : 'Your saved account data was deleted'}</h3>
      <p className="public-account-note">{account.pending_cleanup ? 'Saved storage is being cleared. Reload settings before starting again.' : 'Your wallet and NFTs are unchanged. You can create a new empty account when ready.'}</p>
      {account.pending_cleanup ? <button type="button" className="button secondary" disabled={busy} onClick={() => { void reload(); }}>Reload settings</button>
        : !startingAgain ? <button type="button" className="button primary" disabled={busy} onClick={() => setStartingAgain(true)}>Start again</button>
          : <div><p>Create a new empty account? You will need to verify your wallet and add your API key again.</p><div className="public-account-actions">
            <button type="button" className="button primary" disabled={busy} onClick={() => { void act('reactivate'); }}>{pending === 'reactivate' ? 'Creating…' : 'Create new account'}</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setStartingAgain(false)}>Cancel</button></div></div>}</div>}
    {account && !account.deleted && <>
      <div className="public-account-step"><div className="public-account-step-heading"><Icon name={account.wallet ? 'check' : 'wallet'} size={20} /><h3>Wallet</h3>
        <span>{account.wallet ? 'Verified' : 'Not connected'}</span></div>
        <p className="public-account-note">Verify the wallet that holds your gifts. Marketapp login is a separate approval below.</p>
        {account.wallet ? <div className="public-account-wallet"><code>{shortWalletAddress(account.wallet.address)}</code>
          <button type="button" className="button secondary small" disabled={busy} onClick={() => { void act('disconnect'); }}>{pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect wallet'}</button></div>
          : <PublicWalletProof adapter={adapter} disabled={busy} onVerified={next => { if (!mounted.current) return; reader.invalidate(); setAccount(next); setError(null); setNotice('Wallet verified.'); onChanged(); }} />}
      </div>
      {marketappConnection}
      <div className="public-account-step"><div className="public-account-step-heading"><Icon name={account.marketapp_key.configured ? 'check' : 'shield'} size={20} /><h3>Marketapp API key</h3><span>{account.marketapp_key.configured ? 'Saved securely' : 'Not added'}</span></div>
        <p className="public-account-note">Your own API key is used for market comparisons and rental history. It does not sign in to your personal Marketapp account.</p>
        <div className="public-account-actions">
          <button type="button" className="button secondary small" disabled={busy || (!account.wallet && !account.marketapp_key.configured)} aria-expanded={keyEditorOpen} aria-controls={`${keyId}-editor`} onClick={() => { clearKey(); setKeyEditorOpen(true); }}>
            {account.marketapp_key.configured ? 'Change API key' : 'Add API key'}</button>
          {account.marketapp_key.configured && <button type="button" className="button secondary small" disabled={pending !== null} onClick={() => { clearKey(); setKeyEditorOpen(false); void act('remove'); }}>{pending === 'remove' ? 'Clearing…' : 'Clear API key'}</button>}
        </div>
        {(account.wallet || account.marketapp_key.configured) ? <>
          {keyEditorOpen && <form id={`${keyId}-editor`} className="public-account-key-editor" autoComplete="off" onSubmit={event => { event.preventDefault(); void act('save'); }}>
            <label htmlFor={keyId}>{account.marketapp_key.configured ? 'New Marketapp API key' : 'Your Marketapp API key'}</label>
            <div className="public-account-key-row"><input ref={keyInput} id={keyId} type="password" value={key} onChange={event => setKey(event.target.value)}
              autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} disabled={busy} required aria-describedby={keyHelpId} />
              <button type="submit" className="button primary" disabled={busy || !key}>{pending === 'save' ? 'Saving…' : 'Save key'}</button></div>
            <p id={keyHelpId} className="public-account-note">Encrypted on the backend. Never saved in browser storage. Saving does not start a sync.</p>
            <button type="button" className="text-button" disabled={pending !== null} onClick={() => { clearKey(); setKeyEditorOpen(false); }}>Cancel</button>
          </form>}
          {account.marketapp_key.configured && <div className="public-account-key-check"><button type="button" className="text-button" disabled={busy} onClick={() => { void act('test'); }}>{pending === 'test' ? 'Checking…' : 'Check key'}</button>{variant === 'connections' ? <details className="activity-access-details"><summary>Access details</summary><p>Clearing the key keeps saved gifts and history. Saving does not start an update.</p></details> : <small>Clearing the key keeps your saved gifts and history.</small>}</div>}
        </> : <p className="public-account-note">Connect and verify your wallet before adding a key.</p>}
      </div>
      {step === 'ready' && <details className="public-account-discovery-options" open={!portfolioCount || Boolean(liveDiscovery)}><summary><Icon name="discover" size={18} />Gift discovery<span>{portfolioCount > 0 ? `${portfolioCount} saved` : 'Get started'}</span></summary><div className="public-account-step"><div className="public-account-step-heading"><h3>Your gifts</h3></div>
        <p className="public-account-note">Find gifts in supported collections and verify their current holder. Progress is saved; keep this app open while checking.</p>
        {discovery && <div className="public-account-discovery" role="status" aria-live="polite"><div><strong>{discovery.state === 'complete' ? 'Gift discovery complete' : liveDiscovery ? 'Finding your gifts…' : discovery.state === 'failed' ? 'Gift discovery needs attention' : discovery.resume_supported === false ? 'Gift discovery reached a safety limit' : 'Gift discovery paused'}</strong>{percent !== null && <span>{percent}%</span>}</div>
          {percent !== null ? <progress value={percent} max={100} aria-label="Gift discovery progress" /> : liveDiscovery && <progress aria-label="Finding gifts" />}
          {sync && <small>{sync.completed}{sync.total == null ? '' : ` of ${sync.total}`} {sync.unit} checked</small>}</div>}
        <button type="button" className="button primary" disabled={busy} onClick={() => { void act(mayResume ? 'resume' : 'discover'); }}><Icon name="discover" size={18} />
          {pending === 'discover' || pending === 'resume' ? 'Starting…' : liveDiscovery ? 'Checking gifts…' : mayResume ? 'Continue discovery' : portfolioCount ? 'Discover new gifts' : 'Discover my gifts'}</button>
      </div></details>}
      <details className="public-account-privacy"><summary>Data & privacy</summary>
        <p className="public-account-note">Your API key, remembered Marketapp login and personal records belong to this Telegram account. Clearing the API key stops API-based collection. Disconnect Marketapp separately to stop personal-page refreshes. Deleting account data removes saved records and cancels pending work.</p>
        <div className="public-account-actions">{onExport && <button type="button" className="button secondary small" disabled={busy || !portfolioCount} onClick={onExport}><Icon name="download" size={16} />Export saved gifts</button>}
          <button type="button" className="text-button public-account-delete" disabled={pending !== null} onClick={() => setDeleting(true)}>Delete my data</button></div>
        {deleting && <div className="public-account-delete-confirm" role="group" aria-labelledby={`${deleteId}-title`}><strong id={`${deleteId}-title`}>Delete this account’s saved data?</strong>
          <p>This removes your key, remembered Marketapp login, wallet link, portfolio, analytics, and saved progress. It does not affect your wallet or NFTs.</p>
          <label htmlFor={deleteId}>Type DELETE to confirm</label><input id={deleteId} value={deleteText} onChange={event => setDeleteText(event.target.value)} autoComplete="off" spellCheck={false} disabled={pending !== null} />
          <div className="public-account-actions"><button type="button" className="button secondary" disabled={pending !== null || deleteText !== 'DELETE'} onClick={() => { void act('delete'); }}>{pending === 'delete' ? 'Deleting…' : 'Delete my data'}</button>
            <button type="button" className="text-button" disabled={pending !== null} onClick={() => { setDeleting(false); setDeleteText(''); }}>Cancel</button></div></div>}
      </details>
    </>}
    {(account?.privacy_policy_url || account?.terms_url) && <footer className="public-account-policy-links" aria-label="Account policies">
      {account.privacy_policy_url && <a href={account.privacy_policy_url} target="_blank" rel="noopener noreferrer">Privacy</a>}
      {account.terms_url && <a href={account.terms_url} target="_blank" rel="noopener noreferrer">Terms</a>}
    </footer>}
  </section>;
}
