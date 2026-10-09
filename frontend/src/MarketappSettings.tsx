import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import type { MarketappSettingsAdapter, MarketappSettingsStatus } from './data/types';
import './marketappSettings.css';

const SOURCE_LABELS = { environment: 'Local environment or .env', secure_store: 'Windows Credential Manager', session: 'This desktop session', none: 'Not configured' };

export function MarketappSettings({ settings, csrf, onChanged, close }: {
  settings: MarketappSettingsAdapter; csrf: string; onChanged: () => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState<MarketappSettingsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [persist, setPersist] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const clear = () => { setApiKey(''); if (input.current) input.current.value = ''; };
  const dismiss = () => { clear(); close(); };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const element = dialog.current, trigger = document.activeElement;
    element?.showModal();
    void settings.get(controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load API key settings. Close and reopen to retry.'); });
    return () => {
      mounted.current = false; controller.abort();
      if (input.current) input.current.value = '';
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [settings]);

  const change = async (remove = false) => {
    if (!status?.can_manage || pending || !csrf) return;
    const key = apiKey;
    clear(); setPending(true); setError(null); setMessage(null);
    try {
      const next = remove ? await settings.remove(csrf) : await settings.save(key, persist, csrf);
      if (mounted.current) {
        setStatus(next);
        if (!next.persistent_storage_available) setPersist(false);
        setMessage(remove ? 'Local API key removed.' : `API key saved${next.source === 'secure_store' ? ' in Windows Credential Manager' : ' for this desktop session'}. Format accepted; not verified with Marketapp.`);
      }
      onChanged();
    } catch (problem) {
      if (mounted.current) {
        // The adapter exposes only fixed local errors, never server validation text.
        setError(problem instanceof Error ? problem.message : 'Could not confirm API key settings.');
        try { const next = await settings.get(); if (mounted.current) { setStatus(next); if (!next.persistent_storage_available) setPersist(false); } }
        catch { /* Leave the last public status visible; never repeat a mutation. */ }
      }
      onChanged();
    } finally { if (mounted.current) { clear(); setPending(false); } }
  };

  return <dialog ref={dialog} className="marketapp-settings-dialog" aria-labelledby="marketapp-settings-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
    <div className="marketapp-settings-heading"><h2 id="marketapp-settings-title">Marketapp API key</h2><button type="button" className="icon-button" autoFocus aria-label="Close API key settings" onClick={dismiss}><Icon name="close" size={20} /></button></div>
    <p className="marketapp-settings-intro">Used by this desktop service for Marketapp collection. Saving a key does not start a sync.</p>
    {error && <p className="marketapp-settings-error" role="alert">{error}</p>}
    {message && <p className="marketapp-settings-success" role="status">{message}</p>}
    {!status && !error && <p role="status">Loading settings…</p>}
    {status && <>
      <div className="marketapp-settings-status"><span>{status.configured ? 'Key configured' : 'No API key'}</span><small>{SOURCE_LABELS[status.source]}</small></div>
      {status.source === 'environment' ? <p className="marketapp-settings-note">This key is managed by your local environment or .env file. Change it there and restart the desktop service.</p>
        : !status.can_manage ? <p className="marketapp-settings-note">{status.reason === 'active_job' ? 'Finish or stop the active sync before changing the API key.' : 'API key changes are unavailable in this desktop session.'}</p>
          : <form autoComplete="off" onSubmit={event => { event.preventDefault(); void change(); }}>
            <label className="marketapp-key-label" htmlFor="marketapp-api-key">{status.configured ? 'Replace API key' : 'API key'}</label>
            <input ref={input} id="marketapp-api-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} required disabled={pending} aria-describedby="marketapp-key-storage" />
            <label className="marketapp-persist"><input type="checkbox" checked={persist} onChange={event => setPersist(event.target.checked)} disabled={pending || !status.persistent_storage_available} /><span>Remember on this computer</span></label>
            <p id="marketapp-key-storage" className="marketapp-settings-note">{status.persistent_storage_available ? 'Unchecked: use only until the desktop service stops. Checked: save in Windows Credential Manager.' : 'Secure Windows storage is unavailable. The key can be used only until the desktop service stops.'} The key is never saved in browser storage.</p>
            <div className="marketapp-settings-actions"><button className="button primary" type="submit" disabled={pending || !apiKey.trim() || !csrf}>{pending ? 'Updating…' : 'Save API key'}</button>{status.configured && <button type="button" className="button secondary" disabled={pending || !csrf} onClick={() => { void change(true); }}>Remove key</button>}</div>
          </form>}
      {!status.network_enabled && <p className="marketapp-network-note">Collection is off. Restart the desktop service with <code>--allow-network</code> to enable Marketapp collection.{status.source === 'session' ? ' Enter your session-only key again after restarting.' : status.source === 'none' ? ' Restart before entering a session-only key, or remember the key securely first.' : ''}</p>}
    </>}
  </dialog>;
}
