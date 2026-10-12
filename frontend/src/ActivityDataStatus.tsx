import { useId } from 'react';
import { Icon } from './Icons';
import { dateTime } from './data/helpers';
import type { ActivityFreshnessRow } from './data/activityFreshness';
import { activityStatusPresentation, activityStatusTimestamp } from './data/activityStatusPresentation';
import type { ActivityStatusFeedback } from './data/activityStatusPresentation';
import './activityDataStatus.css';

export interface ActivityDataStatusProps {
  rows: ActivityFreshnessRow[];
  /** The page supplies a visible-page clock so saved timestamps age without requests. */
  now?: number;
  onAction?: (row: ActivityFreshnessRow) => void;
  actionLabel?: (row: ActivityFreshnessRow) => string;
  actionDisabled?: (row: ActivityFreshnessRow) => boolean;
  actionDisabledReason?: (row: ActivityFreshnessRow) => string | undefined;
  actionFeedback?: (row: ActivityFreshnessRow) => ActivityStatusFeedback | undefined;
}

function defaultActionLabel(row: ActivityFreshnessRow): string {
  if (row.id.startsWith('analytics-')) return 'View';
  return row.id === 'gifts' || row.id === 'prices' ? 'Refresh' : 'Update';
}

/** Compact saved evidence. Each stable row expands its own dates and explanation. */
export function ActivityDataStatus({ rows, now = Date.now(), onAction, actionLabel = defaultActionLabel, actionDisabled, actionDisabledReason, actionFeedback }: ActivityDataStatusProps) {
  const titleId = useId();
  return <section className="activity-data-status" aria-labelledby={titleId}>
    <header className="activity-data-status-heading"><h2 id={titleId}>Data status</h2></header>
    <ul className="activity-data-status-list">
      {rows.map(row => {
        const feedback = actionFeedback?.(row);
        const view = activityStatusPresentation(row, now, feedback);
        const label = actionLabel(row);
        const actionName = `${label} ${row.label.toLowerCase()}`;
        const disabled = view.pending || actionDisabled?.(row) === true;
        const suppliedReason = actionDisabledReason?.(row);
        const disabledReason = disabled && !view.pending && suppliedReason && suppliedReason !== view.notice?.message ? suppliedReason : undefined;
        const reasonId = `${titleId}-${row.id}-reason`, noticeId = `${titleId}-${row.id}-notice`;
        const updated = activityStatusTimestamp(row.updatedAt, now);
        const oldest = activityStatusTimestamp(row.oldestUpdatedAt, now);
        const scopedCheck = activityStatusTimestamp(row.checkPresentation?.checkedAt, now);
        const savedCheck = activityStatusTimestamp(row.checkedAt, now);
        return <li key={row.id} className={`activity-data-status-row ${view.tone}`}>
          <div className="activity-data-status-main">
            <details className="activity-data-status-row-details">
              <summary>
                <span className="activity-data-status-name">
                  <span className="activity-data-status-title">{row.label}</span>
                  <span className={`activity-data-status-state${view.pending ? ' pending' : ''}`} role={view.pending ? 'status' : undefined}>
                    <Icon name={view.pending ? 'refresh' : view.tone === 'fresh' ? 'check' : 'clock'} size={12} className={view.pending ? 'spinning' : undefined} />{view.status}
                  </span>
                </span>
                <span className="activity-data-status-meta">
                  <span className="activity-data-status-updated" aria-label={view.timeDescription}>
                    {view.timestamp ? <time dateTime={view.timestamp} title={dateTime(view.timestamp)}>{view.time}</time> : view.time}
                  </span>
                  {view.coverage && <span className={`activity-data-status-coverage${view.coverageWarning ? ' warning' : ''}`}><span aria-hidden="true"> · </span>{view.coverage}</span>}
                  <Icon name="chevron" size={13} className="activity-data-status-expand" /><span className="sr-only">Details</span>
                </span>
              </summary>
              <div className="activity-data-status-detail-content">
                <dl>
                  {row.coverage && <><dt>Coverage</dt><dd>{row.coverage}</dd></>}
                  {row.checkStatus && <><dt>Check summary</dt><dd>{row.checkStatus}</dd></>}
                  {scopedCheck ? <><dt>Scoped check started</dt><dd><time dateTime={scopedCheck}>{dateTime(scopedCheck)}</time></dd></>
                    : savedCheck && <><dt>Saved check evidence</dt><dd><time dateTime={savedCheck}>{dateTime(savedCheck)}</time></dd></>}
                  {updated && <><dt>Latest value observation</dt><dd><time dateTime={updated}>{dateTime(updated)}</time></dd></>}
                  {oldest && oldest !== updated && <><dt>Oldest value observation</dt><dd><time dateTime={oldest}>{dateTime(oldest)}</time></dd></>}
                </dl>
                {row.detail && <p>{row.detail}</p>}
                {feedback?.tone === 'pending' && <p>{feedback.message}</p>}
              </div>
            </details>
            {view.notice && <p className={`activity-data-status-feedback ${view.notice.tone}`} id={noticeId} role={view.notice.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
              <Icon name={view.notice.tone === 'success' ? 'check' : 'alert'} size={12} /><span>{view.notice.message}</span>
            </p>}
            {disabledReason && <p className="activity-data-status-disabled-reason" id={reasonId}>{disabledReason}</p>}
          </div>
          {onAction && <button type="button" className="activity-data-status-action" aria-label={actionName}
            aria-describedby={disabledReason ? reasonId : disabled && view.notice ? noticeId : undefined}
            title={suppliedReason || actionName} disabled={disabled} onClick={() => onAction(row)}>
            <Icon name={row.id.startsWith('analytics-') || label === 'Continue' ? 'arrow' : 'refresh'} size={17} />
            <span>{view.pending ? defaultActionLabel(row) : label}</span>
          </button>}
        </li>;
      })}
    </ul>
  </section>;
}
