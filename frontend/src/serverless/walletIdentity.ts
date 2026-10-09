export const TON_MAINNET = '-239';

/** SDK restore failures are asynchronous, so a React error boundary cannot catch them. */
export function observeWalletRestoration(restoration: Promise<unknown>, onComplete: (error: string | null) => void): () => void {
  let active = true;
  void restoration.then(
    () => { if (active) onComplete(null); },
    () => { if (active) onComplete('Saved wallet connection could not be restored. Connect again.'); },
  );
  return () => { active = false; };
}

/** Canonical identity only: names and wallet app labels are never identity evidence. */
export function canonicalMainnetAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = /^(0|-1):([0-9a-fA-F]{64})$/.exec(value);
  if (raw) return `${raw[1]}:${raw[2].toLowerCase()}`;
  if (!/^[A-Za-z0-9_+/-]{48}$/.test(value)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  } catch { return null; }
  // Reject test-only flags and unknown address tags/workchains.
  if (bytes.length !== 36 || ![0x11, 0x51].includes(bytes[0]) || ![0, 255].includes(bytes[1])) return null;
  let crc = 0;
  for (const byte of bytes.slice(0, 34)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 255)) return null;
  return `${bytes[1] === 255 ? -1 : 0}:${Array.from(bytes.slice(2, 34), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function shortWalletAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 7)}…${address.slice(-6)}` : address;
}

export interface WalletAccountIdentity { address: string; chain: string }
export type WalletBinding =
  | { state: 'restoring' | 'disconnected' | 'unsupported_network' | 'invalid_address'; address: null }
  | { state: 'matching' | 'different_wallet' | 'loading_portfolio' | 'unknown_portfolio'; address: string };

/** A connection cannot replace the address associated with the saved dashboard. */
export function walletBinding({ restored, account, savedWallet, dashboardReady = true }: {
  restored: boolean;
  account: WalletAccountIdentity | null;
  savedWallet: string | null;
  dashboardReady?: boolean;
}): WalletBinding {
  if (!restored) return { state: 'restoring', address: null };
  if (!account) return { state: 'disconnected', address: null };
  if (account.chain !== TON_MAINNET) return { state: 'unsupported_network', address: null };
  const address = canonicalMainnetAddress(account.address);
  if (!address) return { state: 'invalid_address', address: null };
  if (!dashboardReady) return { state: 'loading_portfolio', address };
  const saved = canonicalMainnetAddress(savedWallet);
  if (!saved) return { state: 'unknown_portfolio', address };
  return { state: saved === address ? 'matching' : 'different_wallet', address };
}
