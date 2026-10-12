import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icons';
import type { MarketappAnalyticsPeriod, MarketappAnalyticsRefreshAdapter } from '../data/types';
import { createMarketappAnalyticsRefreshController, marketappAnalyticsRefreshFailure, marketappRefreshRetryText } from './marketappAnalyticsRefreshFlow';
import type { MarketappAnalyticsRefreshView } from './marketappAnalyticsRefreshFlow';
import { marketappWalletFactory, openMarketappWallet } from './MarketappLoginTest';
import './marketappLoginTest.css';
import './marketappAnalyticsRefresh.css';

export default function MarketappAnalyticsRefresh({ transport, wallet, periodDays = 30, onImported, startupBusy = false, onBusyChange, onViewChange, showOutcome = true, variant = 'analytics' }: {
  transport: MarketappAnalyticsRefreshAdapter;
  wallet: string | null;
  periodDays?: MarketappAnalyticsPeriod;
  onImported: () => Promise<void>;
  startupBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onViewChange?: (view: MarketappAnalyticsRefreshView | null) => void;
  showOutcome?: boolean;
  variant?: 'analytics' | 'connection';
}) {
  const [view, setView] = useState<MarketappAnalyticsRefreshView>({ phase: 'idle' });
  const [more, setMore] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(false);
  const controller = useRef<ReturnType<typeof createMarketappAnalyticsRefreshController> | null>(null);
  const reload = useRef(onImported);
  const reportView = useRef(onViewChange);
  useEffect(() => { reload.current = onImported; }, [onImported]);
  useEffect(() => { reportView.current = onViewChange; }, [onViewChange]);
  useEffect(() => {
    let alive = true;
    const updateView = (next: MarketappAnalyticsRefreshView) => {
      if (!alive) return;
      setView(next); reportView.current?.(next);
    };
    const active = createMarketappAnalyticsRefreshController(transport, marketappWalletFactory(__TON_CONNECT_CONFIG__?.returnUrl, true), wallet,
      updateView, () => reload.current(), undefined, () => reload.current());
    controller.current = active; updateView({ phase: 'idle' }); setRememberLogin(false);
    const returned = () => { if (document.visibilityState === 'visible') void active.reconcile(); };
    document.addEventListener('visibilitychange', returned); window.addEventListener('focus', returned); window.addEventListener('pageshow', returned);
    const telegram = window.Telegram?.WebApp as { onEvent?: (event: string, callback: () => void) => void; offEvent?: (event: string, callback: () => void) => void } | undefined;
    let telegramListener = false;
    try { if (typeof telegram?.onEvent === 'function') { telegram.onEvent('activated', returned); telegramListener = true; } } catch { /* Browser focus/visibility recovery remains available. */ }
    void active.reconcile();
    return () => {
      document.removeEventListener('visibilitychange', returned); window.removeEventListener('focus', returned); window.removeEventListener('pageshow', returned);
      try { if (telegramListener && typeof telegram?.offEvent === 'function') telegram.offEvent('activated', returned); } catch { /* Listener cleanup does not change the backend login. */ }
      alive = false; active.dispose();
      if (controller.current === active) { controller.current = null; reportView.current?.(null); }
    };
  }, [transport, wallet]);
  const working = ['preparing', 'choosing', 'awaiting_approval', 'updating'].includes(view.phase);
  const manualBusy = working || ['reconciling', 'confirming', 'disconnecting'].includes(view.phase) || Boolean(view.statusChecking || view.loadingSaved);
  const busy = manualBusy || startupBusy;
  useEffect(() => { onBusyChange?.(manualBusy); return () => { onBusyChange?.(false); }; }, [manualBusy, onBusyChange]);
  const supportsRemembering = Boolean(view.session && transport.refreshSaved && transport.disconnectSession);
  const remembered = supportsRemembering && view.session?.remembered === true;
  const limited = Boolean(view.rateLimit && view.rateLimit.remainingSeconds > 0);
  const options = view.options || [];
  const preferred = options.filter(option => option.installed || /tonkeeper|mytonwallet|telegram|^wallet$/i.test(option.id + ' ' + option.name));
  const shown = more || !preferred.length ? options : preferred;
  const failure = marketappAnalyticsRefreshFailure(view.failure);
  const targetMatches = !view.periodDays || view.periodDays === periodDays;
  const showFailure = showOutcome || !view.periodDays;
  const connectionLabel = transport.getStatus && view.sessionReady !== true ? view.phase === 'failed' ? 'Unavailable' : 'Checking…' : remembered ? 'Connected' : 'Approval needed';
  const connectionView = variant === 'connection';
  const connectionExpired = remembered && Boolean(view.session?.expires_at && Date.parse(view.session.expires_at) <= Date.now());
  const start = () => { setMore(false); void controller.current?.start(periodDays, connectionView || rememberLogin); };
  const disconnect = () => { setRememberLogin(false); void controller.current?.disconnect(); };
  return <div className={`marketapp-login-test marketapp-analytics-refresh${connectionView ? ' marketapp-activity-connection activity-connection-row' : ''}`}>
    {connectionView ? <>
      <div className="activity-connection-heading"><Icon name={remembered && !connectionExpired ? 'check' : 'wallet'} size={20} /><h3>Marketapp login</h3><span className="connection-status">{connectionExpired ? 'Expired' : connectionLabel === 'Approval needed' ? 'Not connected' : connectionLabel}</span></div>
      <p className="activity-connection-note">Personal analytics & gift status.</p>
      {(!remembered || connectionExpired) && <p className="marketapp-login-consent marketapp-connection-approval">{!wallet ? 'Connect your wallet first.' : `Wallet approval saves your login and refreshes ${periodDays === 365 ? '1-year' : '30-day'} analytics.`}</p>}
      <div className="marketapp-activity-connection-actions">
        {remembered && !connectionExpired ? <button type="button" className="button secondary small" disabled={busy} onClick={disconnect}>{view.phase === 'disconnecting' ? 'Disconnecting…' : 'Disconnect Marketapp'}</button>
          : <button type="button" className="button secondary small" disabled={busy || limited || !wallet || view.sessionReady === false} onClick={start}><Icon name="wallet" size={16} />{working ? 'Connecting…' : connectionExpired ? 'Reconnect Marketapp' : 'Connect Marketapp'}</button>}
        {connectionExpired && <button type="button" className="text-button" disabled={busy} onClick={disconnect}>{view.phase === 'disconnecting' ? 'Disconnecting…' : 'Disconnect Marketapp'}</button>}
      </div>
      <details className="activity-access-details"><summary>Access details</summary><p className="marketapp-login-consent">Login is encrypted and remembered for up to 7 days. Disconnecting keeps saved data.</p></details>
      {startupBusy && !manualBusy && <p role="status">Analytics are refreshing. Connection actions will be available shortly.</p>}
    </> : <>
    <div className="marketapp-analytics-refresh-actions"><button type="button" className="button secondary small" aria-label={`Refresh ${periodDays === 365 ? '1-year' : '30-day'} rental analytics`} disabled={busy || limited || !wallet || view.sessionReady === false} onClick={start}><Icon name="refresh" size={16} className={view.phase === 'updating' ? 'spinning' : undefined} />{view.phase === 'updating' ? 'Refreshing…' : 'Refresh'}</button></div>
    <details className="marketapp-connection-options"><summary>Marketapp connection <span>{connectionLabel}</span></summary>
      {supportsRemembering ? remembered ? <div className="marketapp-remembered-login"><p className="marketapp-login-consent">Refresh uses your saved Marketapp login.</p><button type="button" className="text-button" disabled={busy} onClick={disconnect}>Disconnect</button></div>
        : <><p className="marketapp-login-consent">{rememberLogin ? 'Wallet approval required. Login will be remembered.' : 'Wallet approval required for each refresh.'}</p><div className="marketapp-remember-login"><label><input type="checkbox" checked={rememberLogin} disabled={busy} onChange={event => setRememberLogin(event.target.checked)} />Remember Marketapp login</label><small>Optional. Encrypted in your private backend for up to 7 days; otherwise used only for this refresh.</small></div></>
        : <p className="marketapp-login-consent">Wallet approval required. Login is used only for this refresh.</p>}
    </details>
    {!remembered && <p className="marketapp-login-consent">{rememberLogin ? 'Wallet approval required · login will be remembered.' : 'Wallet approval required.'}</p>}
    </>}
    {view.phase === 'disconnecting' && <p role="status">Disconnecting Marketapp…</p>}
    {view.phase === 'preparing' && <p role="status">Preparing wallet approval…</p>}
    {!onViewChange && (view.phase === 'reconciling' || view.statusChecking) && <p role="status">{connectionView ? 'Checking Marketapp connection…' : 'Checking refresh…'}</p>}
    {view.phase === 'confirming' && <p role="status">Finishing your last refresh…</p>}
    {targetMatches && view.phase === 'interrupted' && <p role="status">Approval interrupted. Try refreshing again.</p>}
    {view.phase === 'choosing' && <div className="marketapp-login-chooser"><span>Choose your wallet</span><div>{shown.map(option => <button type="button" className="button secondary small" key={option.id} onClick={() => { const url = controller.current?.choose(option.id); if (url) openMarketappWallet(url); }}>{option.name}{option.installed && <small>Installed</small>}</button>)}</div>{!more && shown.length < options.length && <button type="button" className="text-button" onClick={() => setMore(true)}>More wallets</button>}</div>}
    {view.phase === 'awaiting_approval' && <p role="status">Approve Marketapp login in your wallet.{view.launchUrl && <> <a href={view.launchUrl} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openMarketappWallet(view.launchUrl!); }}>Continue in wallet</a></>}</p>}
    {!onViewChange && view.phase === 'updating' && <p role="status">Updating {view.periodDays === 365 ? '1-year' : '30-day'} analytics…</p>}
    {showOutcome && targetMatches && view.phase === 'saved' && <>{!onViewChange && <p className="marketapp-analytics-refreshed" role="status"><Icon name="check" size={16} />{view.periodDays === 365 ? '1-year' : '30-day'} analytics saved.</p>}{view.failure === 'reload_failed' && <p role="alert">{failure.message} <small>({failure.code})</small></p>}</>}
    {view.phase === 'failed' && (view.rateLimit ? <div><p role="status">{view.rateLimit.reason === 'hourly' ? 'Hourly limit reached.' : 'Wait one minute between refreshes.'}</p><p role="timer" aria-live="off">{marketappRefreshRetryText(view.rateLimit.remainingSeconds)}</p></div>
      : showFailure && targetMatches && <div role="alert"><p className="marketapp-login-error">{failure.message} <small>({failure.code})</small></p><p className="marketapp-login-consent">Previously loaded figures remain visible.</p></div>)}
    {targetMatches && view.phase === 'cancelled' && <p role="status">Refresh cancelled. Check status before retrying.</p>}
    {targetMatches && view.phase === 'expired' && <p role="status">Wallet approval expired. Start a new refresh.</p>}
    {working && <button type="button" className="text-button" onClick={() => controller.current?.cancel()}>{connectionView ? 'Cancel connection' : 'Cancel refresh'}</button>}
    {transport.getStatus && targetMatches && !limited && ((showFailure && (view.phase === 'failed' || (view.phase === 'saved' && view.failure === 'reload_failed'))) || ['cancelled', 'expired', 'interrupted', 'confirming'].includes(view.phase)) && <button type="button" className="text-button" disabled={busy} onClick={() => { void controller.current?.reconcile(); }}>Check status</button>}
  </div>;
}
