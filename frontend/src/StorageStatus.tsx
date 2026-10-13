import { useId } from 'react';
import { Icon } from './Icons';
import { dateTime, relativeTime } from './data/helpers';
import { presentStorage, storageCleanupStage, storageGrowthSummary, storageSize, type StorageMaintenanceSnapshot } from './data/storageMonitoring';
import './storageStatus.css';

export function StorageStatusCard({ snapshot, onClean, now = Date.now() }: {
  snapshot: StorageMaintenanceSnapshot; onClean: () => Promise<void>; now?: number;
}) {
  const titleId = useId();
  const view = presentStorage(snapshot, now), status = snapshot.status;
  const progress = status?.cleanup.state === 'running' || status?.cleanup.state === 'blocked' ? status.cleanup.progress : null;
  const checked = status?.checked_at && Date.parse(status.checked_at) <= now + 30000 ? status.checked_at : null;
  const lastCleanup = status?.cleanup.last_completed_at && Date.parse(status.cleanup.last_completed_at) <= now + 30000
    ? status.cleanup.last_completed_at : null;
  const waitingMessage = view.waitingForProvider ? `Other updates are running.${snapshot.continuation === 'waiting' && snapshot.pauseReason === 'provider' ? ' Cleanup will continue automatically.' : ''}` : null;
  const message = snapshot.error || waitingMessage
    || (snapshot.continuation === 'waiting' && snapshot.pauseReason === 'hidden' ? 'Return to this app to resume cleanup.' : null)
    || (status?.cleanup.state === 'blocked' ? 'Cleanup could not finish. Your saved data is kept. Try again.' : null)
    || (snapshot.bounded ? 'Cleanup paused. Choose Continue cleanup to finish.' : null)
    || (view.status === 'paused' ? view.active ? 'New updates wait until cleanup makes enough room.' : 'New updates are paused. Clean up storage to continue.' : null)
    || (view.active ? 'Keep the app open to finish.' : null)
    || (view.status === 'warning' ? 'Clean up to make room for updates.' : null);
  return <section className={`storage-status ${view.tone}`} aria-labelledby={titleId}>
    <div className="storage-status-main">
      <div className="storage-status-title"><Icon name="layers" size={18} /><h2 id={titleId}>Storage</h2>
        <span className="storage-status-state" role="status"><Icon name={view.active ? 'refresh' : view.status === 'healthy' ? 'check' : view.status === 'paused' ? 'alert' : 'clock'} size={13} className={view.active ? 'spinning' : undefined} />{view.status === 'warning' ? 'Cleanup suggested' : view.label}</span>
      </div>
      <div className="storage-status-usage">
        <span>{view.progressPercent !== null ? <><strong>{view.progressPercent}%</strong> of app storage budget used</>
          : status?.estimated_bytes != null ? <><strong>{storageSize(status.estimated_bytes)}</strong> estimated{!status.inventory_complete ? ' · check incomplete' : ''}</> : 'Usage not checked yet'}
          {checked && <span className="storage-status-checked"> · Checked <time dateTime={checked} title={dateTime(checked, true)}>{relativeTime(checked, now)}</time></span>}</span>
        {view.progressPercent !== null && <progress max="100" value={view.progressPercent} aria-label="Estimated usage of the application safety budget" />}
      </div>
      {progress && <div className="storage-cleanup-progress">
        <span>{storageCleanupStage(progress)} · Step {progress.stage_number} of {progress.stage_count}</span>
      </div>}
      {message && <p className="storage-status-message" role={snapshot.error ? 'alert' : undefined}>{message}</p>}
    </div>
    <button type="button" className="button small secondary storage-status-action" onClick={() => { void onClean(); }}
      disabled={view.actionDisabled} aria-label={view.active ? 'Storage maintenance in progress' : view.waitingForProvider ? 'Storage cleanup waiting for other updates' : snapshot.error ? 'Retry storage cleanup'
        : view.actionLabel === 'Continue cleanup' ? 'Continue storage cleanup' : 'Clean up storage now'} aria-busy={view.active}>
      <Icon name="refresh" size={14} />{view.actionLabel}
    </button>
    <details className="storage-status-details"><summary>Storage details</summary><div>
      <dl className="storage-status-facts">
        {status?.estimated_bytes != null && <><dt>Estimated data</dt><dd>{storageSize(status.estimated_bytes)}{status.scope === 'account' ? ' for your account' : ''}</dd></>}
        {status?.budget_bytes != null && <><dt>App storage budget</dt><dd>{storageSize(status.budget_bytes)}</dd></>}
        {status?.growth?.write_limit_bytes != null && <><dt>{status.scope === 'account' ? 'Account update limit' : 'Updates pause at'}</dt><dd>{storageSize(status.growth.write_limit_bytes)}</dd></>}
        {checked && <><dt>Last checked</dt><dd><time dateTime={checked}>{dateTime(checked, true)}</time></dd></>}
        <dt>Last cleanup</dt><dd>{lastCleanup ? <time dateTime={lastCleanup}>{dateTime(lastCleanup, true)}</time> : 'No completed cleanup yet'}</dd>
        {lastCleanup && status && status.cleanup.reclaimed_bytes > 0 && <><dt>Space freed</dt><dd>{storageSize(status.cleanup.reclaimed_bytes)}</dd></>}
        {status?.cleanup.estimated_reclaimable_bytes != null && <><dt>Estimated savings</dt><dd>{storageSize(status.cleanup.estimated_reclaimable_bytes)}</dd></>}
        {progress?.percent != null && <><dt>Current step</dt><dd>{progress.percent}% checked</dd></>}
      </dl>
      {snapshot.error && waitingMessage && <p>{waitingMessage}</p>}
      {view.status === 'paused' && <p>New updates wait for safe storage space. Saved data stays available.</p>}
      {status?.cleanup.state === 'blocked' && snapshot.error && <p>Cleanup could not finish. Saved data is kept.</p>}
      {snapshot.bounded && <p>{snapshot.pauseReason === 'manual_limit'
        ? 'This run reached its time or request limit. Progress is saved.'
        : 'The automatic check reached its request limit. Progress is saved.'}</p>}
      <p>Cleanup removes cached and duplicate data. Your gifts, prices, rental history, analytics and update progress are kept.</p>
      {status?.budget_bytes != null && <p>The budget is an app safety limit, not a confirmed Telegram quota. Estimates exclude some database overhead.{status.scope === 'account' ? ' Shared storage limits may pause updates sooner.' : ' Space is reserved for maintenance.'}</p>}
      {status?.growth && <p>{storageGrowthSummary(status.growth, status.scope, now)}</p>}
      {status && !status.inventory_complete && <p>Usage is still being checked and the estimate may increase.</p>}
    </div></details>
  </section>;
}
