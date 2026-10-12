import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icons';
import type { MarketappSettingsAdapter, MarketappSettingsStatus } from './data/types';
import './marketappSettings.css';

const SOURCE_LABELS = { environment: 'Local environment or .env', secure_store: 'Windows Credential Manager', session: 'This desktop session', none: 'Not configured', serverless_private: 'Private server configuration', encrypted_backend: 'Encrypted in your Telegram backend' };

export function MarketappSettings({ settings, csrf, onChanged, close, inline = false, cloud = false }: {
  settings: MarketappSettingsAdapter; csrf: string; onChanged: () => void; close: () => void; inline?: boolean; cloud?: boolean;
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
  const [editing, setEditing] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const fieldId = useId(), helpId = useId(), titleId = useId();
  const clear = () => { setApiKey(''); if (input.current) input.current.value = ''; };
  const dismiss = () => { clear(); close(); };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const element = dialog.current, trigger = document.activeElement;
    element?.showModal();
    void settings.get(controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError(inline ? 'Could not load API key settings. Reload settings to retry.' : 'Could not load API key settings. Close and reopen to retry.'); });
    return () => {
      mounted.current = false; controller.abort();
      if (input.current) input.current.value = '';
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [settings, readVersion]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);

  const change = async (remove = false) => {
    if (!status || !status.can_manage && !(cloud && remove) || pending || !csrf && !cloud) return;
    const key = apiKey;
    clear(); setPending(true); setError(null); setMessage(null);
    try {
      const next = remove ? await settings.remove(csrf) : await settings.save(key, persist, csrf);
      if (mounted.current) {
        setStatus(next);
        if (!next.persistent_storage_available) setPersist(false);
        setMessage(remove ? 'API key cleared. Saved gifts and rental history are kept.' : cloud ? 'API key saved securely. Comparison updates can use it.' : `API key saved${next.source === 'secure_store' ? ' in Windows Credential Manager' : ' for this desktop session'}. Format accepted; not verified with Marketapp.`);
        setEditing(false);
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

  const content = <>
    {inline ? <div className="activity-connection-heading"><Icon name="shield" size={20} /><h3>Marketapp API key</h3><span className="connection-status">{status ? status.configured ? 'Key saved' : 'No key' : error ? 'Unavailable' : 'Checking…'}</span></div>
      : <div className="marketapp-settings-heading"><h2 id={titleId}>Marketapp API key</h2><button type="button" className="icon-button" autoFocus aria-label="Close API key settings" onClick={dismiss}><Icon name="close" size={20} /></button></div>}
    <p className={inline ? 'activity-connection-note' : 'marketapp-settings-intro'}>{inline ? 'Market comparisons & rental history.' : 'Used by this desktop service for Marketapp collection. Saving a key does not start a sync.'}</p>
    {error && <div role="alert"><p className="marketapp-settings-error">{error}</p>{inline && <button type="button" className="text-button" disabled={pending} onClick={() => { clear(); setEditing(false); setError(null); setReadVersion(value => value + 1); }}>Reload key settings</button>}</div>}
    {message && <p className="marketapp-settings-success" role="status">{message}</p>}
    {!inline && !status && !error && <p role="status">Loading settings…</p>}
    {status && <>
      {!inline && <div className="marketapp-settings-status"><span>{status.configured ? 'Key configured' : 'No API key'}</span><small>{SOURCE_LABELS[status.source]}</small></div>}
      {inline && <div className="activity-connection-actions"><button type="button" className="button secondary small" disabled={pending || !status.can_manage || status.reason === 'active_job'} aria-expanded={editing} aria-controls={`${fieldId}-editor`} onClick={() => { clear(); setMessage(null); setEditing(true); }}>{status.configured ? 'Change API key' : 'Add API key'}</button>{status.configured && <button type="button" className="text-button" disabled={pending || !status.can_manage && !cloud || !csrf && !cloud} onClick={() => { void change(true); }}>{pending ? 'Updating…' : 'Clear API key'}</button>}</div>}
      {status.source === 'environment' ? <p className="marketapp-settings-note">This key is managed by your local environment or .env file. Change it there and restart the desktop service.</p>
        : !status.can_manage || status.reason === 'active_job' ? <p className="marketapp-settings-note">{status.reason === 'active_job' ? 'Finish or stop the comparison update before changing the API key.' : cloud ? 'API key changes are temporarily unavailable. Reload settings to retry.' : 'API key changes are unavailable in this desktop session.'}</p>
          : (!inline || editing) && <form id={`${fieldId}-editor`} autoComplete="off" onSubmit={event => { event.preventDefault(); void change(); }}>
            <label className="marketapp-key-label" htmlFor={fieldId}>{status.configured ? 'New API key' : 'API key'}</label>
            <input ref={input} id={fieldId} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} required disabled={pending} aria-describedby={helpId} />
            {!cloud && <label className="marketapp-persist"><input type="checkbox" checked={persist} onChange={event => setPersist(event.target.checked)} disabled={pending || !status.persistent_storage_available} /><span>Remember on this computer</span></label>}
            <p id={helpId} className="marketapp-settings-note">{cloud ? 'Encrypted on the backend. Never stored in your browser. Saving does not start a sync.' : <>{status.persistent_storage_available ? 'Unchecked: use only until the desktop service stops. Checked: save in Windows Credential Manager.' : 'Secure Windows storage is unavailable. The key can be used only until the desktop service stops.'} The key is never saved in browser storage.</>}</p>
            <div className="marketapp-settings-actions"><button className="button primary" type="submit" disabled={pending || !apiKey.trim() || !csrf && !cloud}>{pending ? 'Updating…' : 'Save API key'}</button>{inline ? <button type="button" className="text-button" disabled={pending} onClick={() => { clear(); setEditing(false); }}>Cancel</button> : status.configured && <button type="button" className="button secondary" disabled={pending || !csrf} onClick={() => { void change(true); }}>Clear API key</button>}</div>
          </form>}
      {inline && !editing && <details className="activity-access-details"><summary>Access details</summary><p className="marketapp-settings-note">{SOURCE_LABELS[status.source]}. Saving a key does not start an update. Clearing it keeps saved gifts and history.</p></details>}
      {!status.network_enabled && <p className="marketapp-network-note">{cloud ? 'Comparison updates are temporarily unavailable. Saved data remains available.' : <>Collection is off. Restart the desktop service with <code>--allow-network</code> to enable Marketapp collection.{status.source === 'session' ? ' Enter your session-only key again after restarting.' : status.source === 'none' ? ' Restart before entering a session-only key, or remember the key securely first.' : ''}</>}</p>}
    </>}
  </>;
  return inline ? <section className="activity-connection-row activity-api-key">{content}</section>
    : <dialog ref={dialog} className="marketapp-settings-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>{content}</dialog>;
}
