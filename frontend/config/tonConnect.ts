export interface TonConnectConfig {
  manifestUrl: string;
  returnUrl?: `https://${string}`;
}

export interface TonConnectBuild {
  config: TonConnectConfig;
  manifest: {url: string; name: string; iconUrl: string};
}

/** These are public build settings. They must never contain provider credentials. */
export function tonConnectBuild(env: Record<string, string | undefined>): TonConnectBuild | null {
  const suppliedOrigin = env.VITE_TONCONNECT_APP_URL;
  if (!suppliedOrigin) return null;
  let app: URL;
  try { app = new URL(suppliedOrigin); }
  catch { throw new Error('VITE_TONCONNECT_APP_URL must be an HTTPS origin.'); }
  if (suppliedOrigin !== suppliedOrigin.trim() || app.protocol !== 'https:' || app.username || app.password ||
      app.pathname !== '/' || suppliedOrigin.includes('?') || suppliedOrigin.includes('#') || suppliedOrigin.includes('\\')) {
    throw new Error('VITE_TONCONNECT_APP_URL must be an HTTPS origin without a path, credentials, query, or fragment.');
  }

  let returnUrl: `https://${string}` | undefined;
  if (env.VITE_TELEGRAM_RETURN_URL) {
    const suppliedReturn = env.VITE_TELEGRAM_RETURN_URL;
    let destination: URL;
    try { destination = new URL(suppliedReturn); }
    catch { throw new Error('VITE_TELEGRAM_RETURN_URL must be a Telegram bot Mini App link.'); }
    const parameters = [...destination.searchParams.entries()];
    if (suppliedReturn !== suppliedReturn.trim() || destination.protocol !== 'https:' ||
        destination.hostname !== 't.me' || destination.port || destination.username || destination.password ||
        destination.hash || suppliedReturn.includes('\\') ||
        !/^\/[a-z][a-z0-9_]{1,28}bot$/i.test(destination.pathname) || parameters.length !== 1 ||
        parameters[0][0] !== 'startapp' || !/^[a-z0-9_-]{0,512}$/i.test(parameters[0][1])) {
      throw new Error('VITE_TELEGRAM_RETURN_URL must use https://t.me/YOUR_BOT?startapp with an optional startapp value.');
    }
    returnUrl = destination.href as `https://${string}`;
  }

  return {
    config: {manifestUrl: `${app.origin}/tonconnect-manifest.json`, ...(returnUrl ? {returnUrl} : {})},
    manifest: {url: app.origin, name: 'Gift Rent Check', iconUrl: `${app.origin}/wallet-icon.png`},
  };
}
