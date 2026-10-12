export interface PullRefreshState {
  phase: 'idle' | 'pulling' | 'armed' | 'refreshing' | 'notice';
  distance: number;
  message?: string;
}
export interface PullPoint { id: number; x: number; y: number }

/** Touch gestures start at the top; they never turn a normal scroll into a refresh. */
export function createPullToRefresh(options: {
  allowed(): boolean;
  atTop(): boolean;
  refresh(): Promise<string>;
  changed(state: PullRefreshState): void;
}) {
  let origin: PullPoint | null = null;
  let state: PullRefreshState = { phase: 'idle', distance: 0 };
  let running = false;
  let disposed = false;
  let epoch = 0;
  const publish = (next: PullRefreshState) => { state = next; if (!disposed) options.changed(next); };
  const cancel = () => { origin = null; if (!running) publish({ phase: 'idle', distance: 0 }); };
  const valid = (point: PullPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
  return {
    start(points: PullPoint[], excluded = false) {
      if (disposed || running) return;
      cancel();
      if (!excluded && points.length === 1 && valid(points[0]) && options.allowed() && options.atTop()) origin = points[0];
    },
    move(points: PullPoint[]): boolean {
      if (disposed || !origin || running) return false;
      if (points.length !== 1 || points[0].id !== origin.id || !valid(points[0]) || !options.allowed() || !options.atTop()) { cancel(); return false; }
      const dx = Math.abs(points[0].x - origin.x), dy = points[0].y - origin.y;
      if (dy < -6 || (dx > 8 && dx >= Math.max(0, dy))) { cancel(); return false; }
      if (dy < 8) { publish({ phase: 'idle', distance: 0 }); return false; }
      const distance = Math.min(76, dy * .5);
      publish({ phase: dy >= 112 ? 'armed' : 'pulling', distance });
      return true;
    },
    async end() {
      const ready = origin && state.phase === 'armed' && options.allowed() && options.atTop();
      origin = null;
      if (disposed || running) return;
      if (!ready) { cancel(); return; }
      running = true;
      const current = epoch;
      publish({ phase: 'refreshing', distance: 54 });
      let message: string;
      try { message = await options.refresh(); }
      catch { message = 'Refresh could not finish. Try again or check Status.'; }
      finally { running = false; }
      if (!disposed && current === epoch) publish({ phase: 'notice', distance: 54, message });
      else if (!disposed) publish({ phase: 'idle', distance: 0 });
    },
    cancel,
    // Hide or account/tab changes cancel the gesture and fence late UI feedback.
    reset() { epoch++; origin = null; publish({ phase: 'idle', distance: 0 }); },
    dismiss() { if (!running) cancel(); },
    dispose() { disposed = true; epoch++; origin = null; },
  };
}
