import type { PersonalRentalAnalytics } from './types.ts';
import type { AnalyticsStartupSnapshot } from '../serverless/analyticsStartup.ts';
import type { MarketappAnalyticsRefreshView } from '../serverless/marketappAnalyticsRefreshFlow.ts';

export interface AnalyticsFreshnessPresentation {
  tone: 'recent' | 'saved' | 'working' | 'warning' | 'empty';
  label: string;
  message?: string;
  needsReload?: boolean;
  /** Show terminal manual diagnostics only when they still describe this selected report. */
  manualNotice?: boolean;
}
export interface AnalyticsFreshnessOptions {
  now?: number;
  refreshable: boolean;
  startup?: AnalyticsStartupSnapshot;
  manual?: MarketappAnalyticsRefreshView | null;
  imported?: { days: number; capturedAt: string; fingerprint: string; loading: boolean; reloadFailed?: boolean };
}
const day = 86400000, recentWindow = 15 * 60000;
function dateTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : null;
}
function date(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}
const olderShown = (hasSnapshot: boolean): AnalyticsFreshnessPresentation => ({ tone: 'warning', label: hasSnapshot ? 'Older data shown' : 'Report not loaded',
  message: hasSnapshot ? 'The refresh finished, but this view still shows the previous report.' : 'The refresh finished, but the saved report has not loaded.', needsReload: true });

/** Describe only the selected, displayed report. A login or another period's refresh proves nothing about these figures. */
export function analyticsFreshnessPresentation(snapshot: PersonalRentalAnalytics | null, selectedDays: number,
  options: AnalyticsFreshnessOptions): AnalyticsFreshnessPresentation {
  const now = options.now ?? Date.now(), clockValid = Number.isFinite(now), supported = options.refreshable && [30, 365].includes(selectedDays);
  const captured = snapshot ? dateTime(snapshot.captured_at) : null;
  const start = snapshot ? date(snapshot.period_start) : null, end = snapshot ? date(snapshot.period_end) : null;
  const valid = Boolean(snapshot && clockValid && captured !== null && captured <= now + 30000 && start !== null && end !== null &&
    start <= end && end <= Math.floor(captured / day) * day && Number.isSafeInteger(selectedDays) && selectedDays > 0 &&
    end - start === (selectedDays - 1) * day && Array.isArray(snapshot.daily) && snapshot.daily.length === selectedDays);
  const base: AnalyticsFreshnessPresentation = !snapshot ? { tone: 'empty', label: 'No saved report' }
    : !valid ? { tone: 'warning', label: 'Date unavailable', message: 'This report’s saved dates could not be confirmed.' }
      : supported && captured !== null && now - captured < recentWindow && snapshot.period_end === new Date(now).toISOString().slice(0, 10)
        ? { tone: 'recent', label: 'Recently refreshed' }
        : supported ? { tone: 'saved', label: 'Update available' } : { tone: 'saved', label: 'Saved report' };

  // Comparison is by selected period and committed capture time. Endpoint success alone must not turn older values green.
  const confirmation = (expected: string | undefined, loading: boolean, failed: boolean, fingerprint?: string): AnalyticsFreshnessPresentation | null => {
    const expectedTime = dateTime(expected);
    if (expectedTime !== null && clockValid && expectedTime <= now + 30000) {
      if (valid && captured !== null && (captured > expectedTime || captured === expectedTime && (!fingerprint || snapshot?.fingerprint === fingerprint))) return base;
      if (loading && !failed) return { tone: 'working', label: 'Loading refreshed report…', message: snapshot ? 'Previous figures remain visible.' : 'The report was saved and is loading.' };
      return olderShown(Boolean(snapshot));
    }
    if (loading) return { tone: 'working', label: 'Loading saved report…', message: snapshot ? 'Previous figures remain visible.' : 'Loading the saved report.' };
    if (failed) return { tone: 'warning', label: snapshot ? 'Saved data shown' : 'Report not loaded', message: 'The saved report could not be loaded.', needsReload: true };
    return null;
  };

  const manual = options.manual?.periodDays === selectedDays ? options.manual : undefined;
  const startup = options.startup?.periodDays === selectedDays ? options.startup : undefined;
  const imported = options.imported?.days === selectedDays ? options.imported : undefined;
  const working: AnalyticsFreshnessPresentation = { tone: 'working', label: 'Refreshing report…',
    message: snapshot ? 'Saved figures remain visible until the new report loads.' : 'Fetching this report from Marketapp.' };
  const outcomeTime = (value: string | undefined) => {
    const parsed = dateTime(value); return parsed !== null && clockValid && parsed <= now + 30000 ? parsed : null;
  };
  const manualTime = outcomeTime(manual?.capturedAt) ?? outcomeTime(manual?.outcomeAt);
  const startupTime = outcomeTime(startup?.capturedAt) ?? outcomeTime(startup?.outcomeAt);

  // Recovered terminal manual states may belong to yesterday. Actual in-flight work takes priority over those markers.
  if (manual && ['preparing', 'choosing', 'awaiting_approval'].includes(manual.phase)) return { tone: 'working', label: 'Wallet approval needed', message: 'Approve the login to refresh this report.' };
  if (manual && ['updating', 'confirming'].includes(manual.phase)) return working;
  if (manual?.phase === 'saved' && manual.loadingSaved) {
    const pending = confirmation(manual.capturedAt, true, manual.failure === 'reload_failed', manual.fingerprint) ?? working;
    return pending.needsReload ? { ...pending, manualNotice: true } : pending;
  }
  if (startup?.phase === 'updating') return working;
  if (startup && ['saved', 'fresh'].includes(startup.phase) && startup.busy) {
    const loading = confirmation(startup.capturedAt, true, Boolean(startup.reloadFailed));
    if (loading) return loading;
  }
  if (imported?.loading) return confirmation(imported.capturedAt, true, Boolean(imported.reloadFailed), imported.fingerprint) ?? working;

  let manualOutcome: AnalyticsFreshnessPresentation | null = null, startupOutcome: AnalyticsFreshnessPresentation | null = null;
  if (manual?.phase === 'saved') {
    manualOutcome = confirmation(manual.capturedAt, false, manual.failure === 'reload_failed', manual.fingerprint);
    if (!manual.capturedAt && manualTime !== null && valid && captured !== null && captured > manualTime) manualOutcome = null;
    if (manualOutcome?.needsReload) manualOutcome = { ...manualOutcome, manualNotice: true };
  } else if (manual?.phase === 'failed' && !(manualTime !== null && valid && captured !== null && captured > manualTime)) {
    manualOutcome = { tone: 'warning', label: snapshot ? 'Saved data shown' : 'No saved report', manualNotice: true,
      message: manual.failure === 'rate_limited' ? 'Refresh is temporarily paused. Try again when the allowance is available.'
        : manual.failure === 'storage_capacity' ? 'Updates are paused to protect saved data. Clean up storage from Status, then try again.'
        : manual.failure === 'result_unconfirmed' || manual.failure === 'status_unavailable' ? 'The refresh result could not be confirmed.'
          : 'The refresh did not finish. Try Refresh again.' };
  }
  if (startup) {
    if (startup.phase === 'saved' || startup.phase === 'fresh') startupOutcome = confirmation(startup.capturedAt, false, Boolean(startup.reloadFailed));
    if (startup.phase === 'limited') startupOutcome = { ...base, message: snapshot ? 'Automatic refresh is paused. Saved figures remain visible.' : 'Automatic refresh is paused. No saved report is available yet.' };
    if (startup.phase === 'busy') startupOutcome = { ...base, message: snapshot ? 'Another refresh is running. These are the saved figures.' : 'Another refresh is running. No saved report is available yet.' };
    if (startup.phase === 'unavailable' && !(startup.reason === 'refresh_failed' && startupTime !== null && valid && captured !== null && captured > startupTime)) {
      startupOutcome = { ...base,
        ...(startup.reason === 'refresh_failed' ? { tone: 'warning' as const,
          message: startup.storagePaused ? 'Updates are paused to protect saved data. Clean up storage from Status, then try again.' : 'Automatic refresh did not finish. Try Refresh again.' }
          : { message: startup.reason === 'no_login' ? 'Connect Marketapp to refresh this report.' : 'Save your wallet to refresh this report.' }) };
    }
  }
  // Confirmed capture times outrank undated recovered markers. Newer saved data clears an older failed attempt.
  const startupLater = Boolean(startupOutcome && startupTime !== null && (manualTime === null || startupTime > manualTime));
  const latest = manualOutcome && startupOutcome ? startupLater ? startupOutcome : manualOutcome : manualOutcome ?? startupOutcome;
  const latestTime = manualOutcome && startupOutcome ? startupLater ? startupTime : manualTime : manualOutcome ? manualTime : startupTime;
  const importedOutcome = imported ? confirmation(imported.capturedAt, false, Boolean(imported.reloadFailed), imported.fingerprint) : null;
  const importedTime = outcomeTime(imported?.capturedAt);
  const shown = importedOutcome && (latest === null || importedTime !== null && (latestTime === null || importedTime >= latestTime))
    ? importedOutcome : latest ?? importedOutcome ?? base;
  if (shown === base && options.startup?.periodDays !== selectedDays && options.startup?.busy && ['updating', 'saved', 'fresh'].includes(options.startup.phase)) {
    const updating = options.startup.periodDays === 365 ? '1-year' : '30-day', selected = selectedDays === 365 ? '1-year' : `${selectedDays}-day`;
    return { ...base, message: snapshot ? `Updating the ${updating} report. Your saved ${selected} figures are shown.`
      : `Updating the ${updating} report. This period has no saved report.` };
  }
  return shown;
}
