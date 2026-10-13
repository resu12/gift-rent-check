export interface WalletWarmupEnvironment {
  hidden(): boolean;
  visibilityChanged(callback: () => void): () => void;
  timer(callback: () => void, delay: number): () => void;
  idle(callback: () => void): () => void;
}

/** Give the saved gift view time to paint before warming the optional wallet SDK.
 * An explicit connection action cancels this schedule and loads it immediately. */
export function scheduleWalletWarmup(load: () => void, environment: WalletWarmupEnvironment): () => void {
  let disposed = false;
  let cancelTimer: (() => void) | undefined;
  let cancelIdle: (() => void) | undefined;
  const clear = () => { cancelTimer?.(); cancelIdle?.(); cancelTimer = cancelIdle = undefined; };
  const schedule = () => {
    clear();
    if (disposed || environment.hidden()) return;
    cancelTimer = environment.timer(() => {
      cancelTimer = undefined;
      if (disposed || environment.hidden()) return;
      cancelIdle = environment.idle(() => {
        cancelIdle = undefined;
        if (disposed || environment.hidden()) return;
        disposed = true; unlisten(); load();
      });
    }, 2000);
  };
  const unlisten = environment.visibilityChanged(schedule);
  schedule();
  return () => { disposed = true; clear(); unlisten(); };
}
