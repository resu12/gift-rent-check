/** Small clock differences must not hide a report the server just saved. */
export const ANALYTICS_CLOCK_SKEW_MS = 30_000;

export function validAnalyticsCapture(value: unknown, now: number): boolean {
  return typeof value === 'string' && Number.isFinite(now) && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= now + ANALYTICS_CLOCK_SKEW_MS;
}

export interface AnalyticsClockEnvironment {
  now: () => number;
  visible: () => boolean;
  onVisibility: (callback: () => void) => () => void;
  onFocus: (callback: () => void) => () => void;
  everyMinute: (callback: () => void) => () => void;
}

/** Recheck saved evidence as time passes or the app returns; no provider requests. */
export function watchAnalyticsClock(update: (now: number) => void, environment: AnalyticsClockEnvironment): () => void {
  let cancelTimer: (() => void) | undefined;
  const tick = () => { if (environment.visible()) update(environment.now()); };
  const visibility = () => {
    cancelTimer?.(); cancelTimer = undefined;
    if (environment.visible()) { tick(); cancelTimer = environment.everyMinute(tick); }
  };
  const removeVisibility = environment.onVisibility(visibility), removeFocus = environment.onFocus(tick);
  visibility();
  return () => { cancelTimer?.(); removeVisibility(); removeFocus(); };
}
