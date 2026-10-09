import {transformWithEsbuild} from 'vite';
import type {Plugin} from 'vite';

/** The pinned SDK logs decrypted wallet replies, including authentication proofs.
 * Remove SDK diagnostics at build time, without replacing the browser's console
 * or changing the SDK used by the desktop build. Re-review on SDK upgrades.
 */
export async function stripTonConnectSdkLogging(source: string, id: string) {
  const path = id.split('?', 1)[0].replaceAll('\\', '/');
  if (!path.endsWith('/@tonconnect/sdk/lib/esm/index.mjs')) return null;
  if (!/const tonConnectSdkVersion = ["']4\.0\.2["'];/.test(source) ||
      !source.includes("logDebug('Wallet message received:', walletMessage)")) {
    throw new Error('TON Connect SDK changed. Review proof redaction before building Telegram.');
  }
  const result = await transformWithEsbuild(source, id, {
    loader: 'js', target: 'es2022', drop: ['console'], sourcemap: false,
  });
  if (/\bconsole\s*(?:\.|\[)/.test(result.code)) {
    throw new Error('TON Connect SDK diagnostics could not be removed.');
  }
  return {code: result.code, map: null};
}

export function tonConnectPrivacyPlugin(): Plugin {
  return {
    name: 'telegram-ton-connect-proof-redaction',
    enforce: 'pre',
    transform(source, id) {return stripTonConnectSdkLogging(source, id);},
  };
}
