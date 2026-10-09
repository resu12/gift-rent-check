import type { SyncPresentation } from './data/syncPresentation';
import './syncStatus.css';

export function SyncProgress({ progress, moving = false }: { progress: SyncPresentation['progress']; moving?: boolean }) {
  return <div className="sync-progress">
    <div className="sync-progress-label"><span>{progress.label}</span>{progress.percent !== null && <strong aria-hidden="true">{progress.percent}%</strong>}</div>
    <div className={`sync-progress-track${progress.indeterminate ? ' indeterminate' : ''}${moving ? ' moving' : ''}`}
      role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={progress.percent ?? undefined} aria-valuetext={progress.label}>
      <span style={progress.percent !== null ? { width: `${progress.percent}%` } : undefined} />
    </div>
  </div>;
}
