import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icons';
import type { MarketappAnalyticsPeriod, MarketappAnalyticsRefreshAdapter } from '../data/types';
import { createMarketappAnalyticsRefreshController, marketappAnalyticsRefreshFailure, marketappRefreshRetryText } from './marketappAnalyticsRefreshFlow';
import type { MarketappAnalyticsRefreshView } from './marketappAnalyticsRefreshFlow';
import { marketappWalletFactory, openMarketappWallet } from './MarketappLoginTest';
import './marketappLoginTest.css';
import './marketappAnalyticsRefresh.css';

export default function MarketappAnalyticsRefresh({ transport, wallet, periodDays: selectedPeriod = 30, onImported }: {
  transport: MarketappAnalyticsRefreshAdapter;
  wallet: string | null;
  periodDays?: MarketappAnalyticsPeriod;
  onImported: () => Promise<void>;
}) {
  const [periodDays, setPeriodDays] = useState<MarketappAnalyticsPeriod>(selectedPeriod);
  const [view, setView] = useState<MarketappAnalyticsRefreshView>({ phase: 'idle' });
  const [more, setMore] = useState(false);
  const controller = useRef<ReturnType<typeof createMarketappAnalyticsRefreshController> | null>(null);
  const reload = useRef(onImported);
  useEffect(() => { reload.current = onImported; }, [onImported]);
  useEffect(() => { setPeriodDays(selectedPeriod); }, [selectedPeriod]);
  useEffect(() => {
    const active = createMarketappAnalyticsRefreshController(transport, marketappWalletFactory(__TON_CONNECT_CONFIG__?.returnUrl, true), wallet,
      setView, () => reload.current(), undefined, () => reload.current());
    controller.current = active; setView({ phase: 'idle' });
    const returned = () => { if (document.visibilityState === 'visible') void active.reconcile(); };
    document.addEventListener('visibilitychange', returned); window.addEventListener('focus', returned); window.addEventListener('pageshow', returned);
    const telegram = window.Telegram?.WebApp as { onEvent?: (event: string, callback: () => void) => void; offEvent?: (event: string, callback: () => void) => void } | undefined;
    let telegramListener = false;
    try { if (typeof telegram?.onEvent === 'function') { telegram.onEvent('activated', returned); telegramListener = true; } } catch { /* Browser focus/visibility recovery remains available. */ }
    void active.reconcile();
    return () => {
      document.removeEventListener('visibilitychange', returned); window.removeEventListener('focus', returned); window.removeEventListener('pageshow', returned);
      try { if (telegramListener && typeof telegram?.offEvent === 'function') telegram.offEvent('activated', returned); } catch { /* No persistent session is involved. */ }
      active.dispose(); if (controller.current === active) controller.current = null;
    };
  }, [transport, wallet]);
  const working = ['preparing', 'choosing', 'awaiting_approval', 'updating'].includes(view.phase);
  const busy = working || ['reconciling', 'confirming'].includes(view.phase) || Boolean(view.statusChecking);
  const limited = Boolean(view.rateLimit && view.rateLimit.remainingSeconds > 0);
  const options = view.options || [];
  const preferred = options.filter(option => option.installed || /tonkeeper|mytonwallet|telegram|^wallet$/i.test(option.id + ' ' + option.name));
  const shown = more || !preferred.length ? options : preferred;
  const failure = marketappAnalyticsRefreshFailure(view.failure);
  return <div className="marketapp-login-test marketapp-analytics-refresh">
    <div className="marketapp-analytics-refresh-actions"><label htmlFor="marketapp-refresh-period">Refresh period<select id="marketapp-refresh-period" value={periodDays} disabled={busy} onChange={event => setPeriodDays(Number(event.target.value) as MarketappAnalyticsPeriod)}><option value={30}>Last 30 days</option><option value={365}>Last 1 year</option></select></label>
      <button type="button" className="button secondary small" disabled={busy || limited || !wallet} onClick={() => { setMore(false); void controller.current?.start(periodDays); }}><Icon name="refresh" size={16} />Refresh analytics</button></div>
    <p className="marketapp-login-consent">Wallet approval required · login is used only for this refresh.</p>
    {view.phase === 'preparing' && <p role="status">Preparing wallet approval…</p>}
    {(view.phase === 'reconciling' || view.statusChecking) && <p role="status">Checking saved refresh status…</p>}
    {view.phase === 'confirming' && <p role="status">The last refresh is still finishing. Checking its result…</p>}
    {view.phase === 'interrupted' && <p role="status">Wallet approval was interrupted. Start a new refresh when ready.</p>}
    {view.phase === 'choosing' && <div className="marketapp-login-chooser"><span>Choose your wallet</span><div>{shown.map(option => <button type="button" className="button secondary small" key={option.id} onClick={() => { const url = controller.current?.choose(option.id); if (url) openMarketappWallet(url); }}>{option.name}{option.installed && <small>Installed</small>}</button>)}</div>{!more && shown.length < options.length && <button type="button" className="text-button" onClick={() => setMore(true)}>More wallets</button>}</div>}
    {view.phase === 'awaiting_approval' && <p role="status">Approve Marketapp login in your wallet.{view.launchUrl && <> <a href={view.launchUrl} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openMarketappWallet(view.launchUrl!); }}>Continue in wallet</a></>}</p>}
    {view.phase === 'updating' && <p role="status">Updating {view.periodDays === 365 ? '1-year' : '30-day'} analytics…</p>}
    {view.phase === 'saved' && <><p className="marketapp-analytics-refreshed" role="status"><Icon name="check" size={16} />{view.periodDays === 365 ? '1-year' : '30-day'} analytics saved.</p>{view.failure === 'reload_failed' && <p role="alert">{failure.message} <small>({failure.code})</small></p>}</>}
    {view.phase === 'ready' && <p role="status">Ready to refresh.</p>}
    {view.phase === 'failed' && (view.rateLimit ? <div><p role="status">{view.rateLimit.reason === 'hourly' ? 'Hourly limit reached.' : 'Wait one minute between approvals.'}</p><p role="timer" aria-live="off">{marketappRefreshRetryText(view.rateLimit.remainingSeconds)}</p></div>
      : <div role="alert"><p className="marketapp-login-error">{failure.message} <small>({failure.code})</small></p><p className="marketapp-login-consent">Previous analytics stay visible.</p></div>)}
    {view.phase === 'cancelled' && <p role="status">Refresh cancelled. Previous analytics stay visible; reload saved data before trying again.</p>}
    {view.phase === 'expired' && <p role="status">Wallet approval expired. Start a new refresh.</p>}
    {working && <button type="button" className="text-button" onClick={() => controller.current?.cancel()}>Cancel refresh</button>}
    {transport.getStatus && !limited && ['failed', 'cancelled', 'expired', 'interrupted', 'confirming', 'saved'].includes(view.phase) && <button type="button" className="text-button" disabled={Boolean(view.statusChecking)} onClick={() => { void controller.current?.reconcile(); }}>Check status</button>}
  </div>;
}
