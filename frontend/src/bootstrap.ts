export interface TelegramSdkReadiness {
  available(): boolean;
  pageFinished(): boolean;
  listen(loaded: () => void, failed: () => void): () => void;
  timeout(callback: () => void): () => void;
}

/** The async SDK may finish before or after the entry module. Never create
 * the transport until its script has settled, including a cached-load race. */
export function waitForTelegramSdk(environment: TelegramSdkReadiness): Promise<void> {
  if (environment.available()) return Promise.resolve();
  if (environment.pageFinished()) return Promise.reject(new Error('Telegram could not load.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    let cancelTimeout: (() => void) | undefined;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      unlisten?.(); cancelTimeout?.();
      if (failed) reject(new Error('Telegram could not load.'));
      else resolve();
    };
    const loaded = () => finish(!environment.available());
    unlisten = environment.listen(loaded, () => finish(true));
    // Also support an environment that delivers an already-settled event while
    // installing its listener, without leaving a timer or listener behind.
    if (settled) { unlisten(); return; }
    cancelTimeout = environment.timeout(() => finish(true));
    if (settled) cancelTimeout();
    else if (environment.available() || environment.pageFinished()) loaded();
  });
}

/** Async scripts do not delay DOMContentLoaded, but they do delay window.load.
 * The latter reconciles a missed script event without rejecting a pending SDK
 * merely because the document was parsed. */
export function waitForTelegramSdkScript(environment: {
  script: EventTarget | null;
  page: EventTarget;
  available(): boolean;
  pageFinished(): boolean;
  timeout(callback: () => void): () => void;
}): Promise<void> {
  return waitForTelegramSdk({
    available: environment.available,
    pageFinished: () => !environment.script || environment.pageFinished(),
    timeout: environment.timeout,
    listen(loaded, failed) {
      environment.script?.addEventListener('load', loaded);
      environment.script?.addEventListener('error', failed);
      environment.page.addEventListener('load', loaded);
      return () => {
        environment.script?.removeEventListener('load', loaded);
        environment.script?.removeEventListener('error', failed);
        environment.page.removeEventListener('load', loaded);
      };
    },
  });
}
