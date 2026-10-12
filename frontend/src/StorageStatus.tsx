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
  const waitingMessage = view.waitingForProvider ? `Waiting for other updates to finish.${snapshot.continuation === 'waiting' && snapshot.pauseReason === 'provider' ? ' Cleanup resumes automatically.' : ''}` : null;
  const message = snapshot.error || waitingMessage
    || (snapshot.continuation === 'waiting' && snapshot.pauseReason === 'hidden' ? 'Return to this app to resume cleanup.' : null)
    || (status?.cleanup.state === 'blocked' ? 'Cleanup stopped. Saved data is retained. Try again.' : null)
    || (snapshot.bounded ? 'Progress saved. Continue cleanup to finish.' : null)
    || (view.status === 'paused' ? view.active ? 'New updates wait until cleanup makes enough room.' : 'New updates are paused. Clean up storage to continue.' : null)
    || (view.active ? 'Keep this app open while the check runs.' : null)
    || (view.status === 'warning' ? 'Clean up cached data to make room for updates.' : null);
  return <section className={`storage-status ${view.tone}`} aria-labelledby={titleId}>
    <div className="storage-status-main">
      <div className="storage-status-title"><Icon name="layers" size={18} /><h2 id={titleId}>Storage</h2>
        <span className="storage-status-state" role="status"><Icon name={view.active ? 'refresh' : view.status === 'healthy' ? 'check' : view.status === 'paused' ? 'alert' : 'clock'} size={13} className={view.active ? 'spinning' : undefined} />{view.status === 'warning' ? 'Cleanup suggested' : view.label}</span>
      </div>
      <div className="storage-status-usage">
        <span>{status?.estimated_bytes != null ? <><strong>{storageSize(status.estimated_bytes)}</strong> estimated{status.scope === 'account' ? ' for your account' : ' data'}</> : 'Usage not checked yet'}
          {view.progressPercent !== null ? <> · <span>{view.progressPercent}% of app safety budget</span></>
            : status && !status.inventory_complete && status.estimated_bytes !== null ? ' · check incomplete' : null}</span>
        {view.progressPercent !== null && <progress max="100" value={view.progressPercent} aria-label="Estimated usage of the application safety budget" />}
      </div>
      {progress && <div className="storage-cleanup-progress">
        <span>{storageCleanupStage(progress)}{progress.percent !== null && <> · {progress.percent}% of this stage</>}</span>
      </div>}
      {message && <p className="storage-status-message" role={snapshot.error ? 'alert' : undefined}>{message}</p>}
    </div>
    <button type="button" className="button small secondary storage-status-action" onClick={() => { void onClean(); }}
      disabled={view.actionDisabled} aria-label={view.active ? 'Storage maintenance in progress' : view.waitingForProvider ? 'Storage cleanup waiting for other updates' : snapshot.error ? 'Retry storage cleanup'
        : view.actionLabel === 'Continue cleanup' ? 'Continue storage cleanup' : 'Clean up storage now'} aria-busy={view.active}>
      <Icon name="refresh" size={14} />{view.actionLabel}
    </button>
    <details className="storage-status-details"><summary>Storage details</summary><div>
      <p>{checked ? <>Checked <time dateTime={checked}>{relativeTime(checked, now)}</time> · {dateTime(checked, true)}.</> : 'Storage check pending.'}</p>
      {snapshot.error && waitingMessage && <p>{waitingMessage}</p>}
      {view.status === 'paused' && <p>New updates wait for safe storage space. Saved data stays available.</p>}
      {status?.cleanup.state === 'blocked' && message !== 'Cleanup stopped. Saved data is retained. Try again.' && <p>Cleanup could not finish. Saved data is retained.</p>}
      {snapshot.bounded && <p>{snapshot.pauseReason === 'manual_limit'
        ? 'Cleanup reached the safety limit for a long run. Progress is saved.'
        : 'The automatic check reached its safety limit. Continue cleanup while this app stays open.'}</p>}
      {status?.scope === 'account' && <p>Usage shown is only for your account. The app manages shared capacity privately.</p>}
      {status?.budget_bytes != null && <p>App safety budget: {storageSize(status.budget_bytes)}. This is not a verified Telegram storage quota. Estimates exclude some database overhead.</p>}
      {status?.scope === 'account' && status.growth?.write_limit_bytes != null && <p>Your account allowance: {storageSize(status.growth.write_limit_bytes)}. This is an app limit, not a verified Telegram storage quota. Shared capacity and required free space can pause updates sooner.</p>}
      {status?.growth && <p>{storageGrowthSummary(status.growth, status.scope, now)}</p>}
      {status?.scope === 'app' && status.growth?.write_limit_bytes != null && <p>Updates pause at {storageSize(status.growth.write_limit_bytes)} to leave room for maintenance. Growth estimates exclude database overhead and cannot predict the platform limit.</p>}
      {status && !status.inventory_complete && <p>Inventory is incomplete. Usage estimates may increase as the check continues.</p>}
      {progress && <p>Stage {progress.stage_number} of {progress.stage_count}. Progress covers this stage, not time remaining. The freed amount changes only when removable data is found.</p>}
      {status?.cleanup.estimated_reclaimable_bytes !== null && status?.cleanup.estimated_reclaimable_bytes !== undefined &&
        <p>Estimated cleanup savings: {storageSize(status.cleanup.estimated_reclaimable_bytes)}.</p>}
      <p>{lastCleanup ? <>Last cleanup: <time dateTime={lastCleanup}>{dateTime(lastCleanup, true)}</time>.</> : 'No completed cleanup recorded yet.'}</p>
      {lastCleanup && status && status.cleanup.reclaimed_bytes > 0 && <p>Freed {storageSize(status.cleanup.reclaimed_bytes)}.</p>}
      <p>Cleanup removes disposable cache and exact duplicates. Rental records, analytics, prices and sync progress are retained. It uses no Marketapp or TON requests.</p>
    </div></details>
  </section>;
}
