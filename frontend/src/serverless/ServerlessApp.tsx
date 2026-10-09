import { useEffect, useRef, useState } from 'react';
import { formatAmount } from '../data/helpers';
import { BoundedCollectionDriver } from './driver';
import { createServerlessAdapter, PrototypeError, safeError } from './transport';
import type { ServerlessAdapter, ServerlessState, TelegramServerless } from './transport';
import './serverless.css';

const REASONS: Record<string, string> = {
  stopped_by_you: 'Progress saved. Continue when you are ready.',
  user_stopped: 'Progress saved. Continue when you are ready.',
  stopped: 'Progress saved. Continue when you are ready.',
  rate_limited: 'Marketapp asked us to wait before the next request.',
  retry: 'A temporary provider error delayed the next request.',
  authentication_failed: 'Marketapp rejected the server token. Update the private backend configuration and redeploy.',
  retry_wait: 'A temporary provider error delayed the next request.',
  page_limit: 'This prototype has reached its 100-page safety limit.',
  storage_limit: 'The prototype storage limit was reached. Preserve your test database before starting over.',
  cursor_cycle_start_fresh: 'Marketapp repeated a cursor. Start a fresh collection.',
  cursor_rejected_start_fresh: 'Marketapp rejected the saved cursor. Start a fresh collection.',
  retry_exhausted: 'The provider did not respond successfully after repeated attempts. Start a fresh collection later.',
  invalid_response: 'Marketapp returned an invalid page. Saved pages are intact; this collection cannot continue.',
  invalid_retry_after: 'Marketapp returned an invalid retry delay. Saved pages are intact; start a fresh collection later.',
  unexpected_redirect: 'Marketapp returned an unexpected redirect. Collection stopped without following it.',
  response_too_large: 'The provider response exceeded the prototype size limit. Saved pages are intact.',
  prototype_limit: 'This prototype has reached its 100-page safety limit.',
  cursor_cycle: 'Marketapp repeated a cursor. Start a fresh collection.',
};

function shortAddress(value: string) { return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function observedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ServerlessApp({ adapter: providedAdapter }: { adapter?: ServerlessAdapter }) {
  const [state, setState] = useState<ServerlessState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [collection, setCollection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [waitMs, setWaitMs] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [needsReload, setNeedsReload] = useState(false);
  const driver = useRef<BoundedCollectionDriver | null>(null);
  const action = useRef(false);
  const stateReceivedAt = useRef(Date.now());
  const adapter = useRef<ServerlessAdapter | null>(null);
  const mounted = useRef(true);
  if (!adapter.current) {
    const app = window.Telegram?.WebApp as { Serverless?: TelegramServerless } | undefined;
    adapter.current = providedAdapter ?? createServerlessAdapter(app?.Serverless);
  }

  function receive(next: ServerlessState) {
    if (!mounted.current) return;
    stateReceivedAt.current = Date.now();
    setState(next);
  }

  async function reload() {
    if (action.current) return;
    action.current = true;
    setLoading(true);
    setError(null);
    try {
      receive(await adapter.current!.call('getState'));
      setNeedsReload(false);
    } catch (err) { setError(safeError(err)); }
    finally { action.current = false; setLoading(false); }
  }

  useEffect(() => {
    mounted.current = true;
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    void reload();
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(timer); };
    // Opening the app reads durable state; it never starts or resumes collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function collect(fresh: boolean) {
    if (action.current || driver.current) return;
    action.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const currentDriver = new BoundedCollectionDriver({ adapter: adapter.current!, onState: receive, onWait: setWaitMs });
    driver.current = currentDriver;
    try {
      const outcome = await currentDriver.run(async () => {
        if (fresh) return adapter.current!.call('startRun', { ...(collection.trim() ? { collection_address: collection.trim() } : {}) });
        const saved = await adapter.current!.call('getState');
        if (!saved.run) return saved;
        if (saved.run.status === 'paused' || saved.run.status === 'running') {
          return adapter.current!.call('resumeRun', { run_id: saved.run.id });
        }
        return saved;
      });
      const descriptions = {
        complete: 'Traversal completed. These are observations collected over time.',
        stopped: 'Stopped. Saved pages will be kept for your next visit.',
        batch_limit: 'Two pages saved. Continue for the next two pages whenever you are ready.',
        cooldown: 'Progress saved. Wait for the provider cooldown before continuing.',
        attention: 'Collection paused. Review the saved status before continuing.',
      };
      setMessage(descriptions[outcome]);
    } catch (err) {
      if (err instanceof PrototypeError && err.state) receive(err.state);
      setError(safeError(err));
      setNeedsReload(true);
    } finally {
      driver.current = null;
      action.current = false;
      setBusy(false);
      setStopping(false);
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      if (driver.current) await driver.current.stop();
      else if (state?.run) {
        receive(await adapter.current!.call('stopRun', { run_id: state.run.id }));
        setMessage('Stopped. Saved pages will be kept for your next visit.');
      }
    } catch (err) { setError(safeError(err)); setNeedsReload(true); }
    finally { if (!driver.current) setStopping(false); }
  }

  const run = state?.run;
  const serverNow = state ? state.server_time + clock - stateReceivedAt.current : clock;
  const cooldownSeconds = Math.max(0, Math.ceil(((run?.next_allowed_at ?? 0) - serverNow) / 1000));
  const leaseSeconds = run ? Math.max(0, Math.ceil((run.lease_until - serverNow) / 1000)) : 0;
  const canContinue = !!run && ['paused', 'ready', 'running'].includes(run.status) && leaseSeconds === 0;
  const canStart = !run || ['paused', 'complete', 'failed', 'prototype_limit'].includes(run.status);
  const canStop = busy || !!run && ['running', 'ready'].includes(run.status);
  const controlsDisabled = loading || busy || stopping || needsReload || leaseSeconds > 0 || !state?.configured;
  const status = busy ? stopping ? 'Stopping' : waitMs > 0 ? 'Waiting' : 'Collecting' : run?.status.replace('_', ' ') ?? 'Ready to start';

  return <div className="tg-prototype">
    <header className="tg-header">
      <div className="tg-brand"><span aria-hidden="true">◈</span> Giftfolio<span className="tg-brand-dot">.</span></div>
      <span className={`tg-access ${state ? 'verified' : ''}`}><i />{state ? 'Private access verified' : loading ? 'Connecting to Telegram' : 'Telegram access required'}</span>
    </header>
    <main id="main" className="tg-main">
      <div className="tg-page-heading">
        <p className="eyebrow">TELEGRAM SERVERLESS · PRIVATE PROTOTYPE</p>
        <h1>Your first cloud collection.</h1>
        <p>Save a small sample of Marketapp rental listings directly to your private Telegram database.</p>
      </div>
      {error && <div role="alert" className="tg-alert"><strong>Collection needs attention</strong><p>{error}</p></div>}
      {state && !state.configured && <div role="status" className="tg-alert"><strong>Server setup is incomplete</strong><p>Add the Marketapp API token to the private backend configuration and redeploy. Credentials are never entered in this dashboard.</p></div>}
      {!state ? <section className="panel tg-connect"><span className="tg-cloud" aria-hidden="true">◇</span><h2>{loading ? 'Verifying private access…' : 'Open Giftfolio in Telegram'}</h2><p>This prototype uses Telegram’s authenticated Serverless connection. Open it from your private bot to view saved listings.</p><button className="button secondary" disabled={loading} onClick={() => void reload()}>{loading ? 'Connecting…' : 'Try connection again'}</button></section> : <>
        <section className="panel tg-control-panel" aria-labelledby="collection-heading">
          <div className="tg-panel-heading"><div><p className="eyebrow">BOUNDED COLLECTION</p><h2 id="collection-heading">Market rental listings</h2></div><span className={`tg-status ${busy ? 'active' : ''}`}>{status}</span></div>
          <p className="tg-description">Collect up to 2 pages per click, with {state.limits.page_size} listings per page. Saved progress survives closing the app.</p>
          <label className="tg-field"><span>Collection address <small>optional</small></span><input value={collection} onChange={event => setCollection(event.target.value)} placeholder="All collections, or paste a TON collection address" disabled={!canStart || controlsDisabled} autoComplete="off" spellCheck={false} /></label>
          {run?.collection_address && <p className="tg-scope">Saved scope: <code title={run.collection_address}>{shortAddress(run.collection_address)}</code></p>}
          <div className="tg-actions">
            {canContinue && <button className="button primary" disabled={controlsDisabled || cooldownSeconds > 0} onClick={() => void collect(false)}>Continue 2 pages</button>}
            <button className={`button ${run ? 'secondary' : 'primary'}`} disabled={controlsDisabled || !canStart || cooldownSeconds > 0} onClick={() => void collect(true)}>{run ? 'Start new collection' : 'Collect 2 pages'}</button>
            {canStop && <button className="button tg-stop" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop'}</button>}
            <button className="button secondary tg-reload" disabled={loading || busy || stopping} onClick={() => void reload()}>{loading ? 'Loading…' : 'Reload saved data'}</button>
          </div>
          <div className="tg-feedback" role="status" aria-live="polite">{leaseSeconds > 0 ? 'A request may still be finishing. Reload saved data to check before continuing.' : busy && waitMs > 0 ? `Next request in ${Math.ceil(waitMs / 1000)}s. Stop is available while waiting.` : cooldownSeconds > 0 ? `Provider cooldown: ${cooldownSeconds}s remaining. Your progress is saved.` : message || (run?.reason ? REASONS[run.reason] || 'Review the saved collection status. Reload or start a fresh collection if it cannot continue.' : 'Read-only collection. Listing prices are never changed.')}</div>
          <div className="tg-stats"><div><strong>{run?.pages_committed ?? 0}<small> / {state.limits.max_pages}</small></strong><span>Pages saved</span></div><div><strong>{run?.items_seen ?? 0}</strong><span>Listing observations</span></div><div><strong>{new Set(state.listings.map(item => item.nft_address)).size}</strong><span>Distinct NFT addresses</span></div></div>
        </section>
        <div className="tg-note"><span aria-hidden="true">ⓘ</span><p>Collection advances while this Mini App is open. Closing it stops further requests; a request already sent may still finish and save its page. Reopen and reload to see the committed progress.</p></div>
        <section className="panel tg-listings" aria-labelledby="listings-heading"><div className="tg-panel-heading"><div><p className="eyebrow">SAVED OBSERVATIONS</p><h2 id="listings-heading">Market listing sample</h2></div><span className="tg-count">{state.listings.length} observations</span></div><p className="tg-table-note">These are public market listings, not your portfolio. Asking prices are rounded to 3 decimals. Overlapping pages may include repeat observations.</p>
          {state.listings.length ? <div className="tg-table-scroll"><table><thead><tr><th>Gift & traits</th><th>Asking price <small>GRAM / day</small></th><th>Observed</th></tr></thead><tbody>{state.listings.map((item, index) => <tr key={`${run?.id}:${index}`}><td><strong>{item.name || 'Unnamed gift'}</strong><span className="tg-address" title={item.nft_address}>{shortAddress(item.nft_address)}</span>{(item.model || item.backdrop) && <div className="tg-traits">{item.model && <span>{item.model}</span>}{item.backdrop && <span>{item.backdrop}</span>}</div>}</td><td className="tg-price">{formatAmount(item.price_gram)}</td><td><time dateTime={item.observed_at}>{observedTime(item.observed_at)}</time></td></tr>)}</tbody></table></div> : <div className="tg-empty"><span aria-hidden="true">▤</span><h3>No saved listings yet</h3><p>Collect two pages to check the Telegram connection, private storage, and resumable progress.</p></div>}
        </section>
      </>}
      <footer className="tg-footer"><span>Giftfolio · Read-only prototype</span><span>{state ? `Telegram account ${state.user.id}` : 'Private account access only'}</span></footer>
    </main>
  </div>;
}
