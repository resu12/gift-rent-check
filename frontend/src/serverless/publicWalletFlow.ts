import type { IStorage } from '@tonconnect/sdk';
import type { MarketappLoginProof } from '../data/types.ts';
import type { PublicAccountAdapter, PublicAccountStatus, PublicWalletAccount, PublicWalletChallenge } from './publicAccount.ts';
import { publicAccountError, readPublicAccount } from './publicAccount.ts';
import { canonicalMainnetAddress, TON_MAINNET } from './walletIdentity.ts';
import { safeWalletLaunchUrl } from './marketappLoginFlow.ts';

export interface PublicWalletOption { id: string; name: string; installed: boolean }
export interface PublicProofWallet { options: PublicWalletOption[]; connect(id: string): string | null; close(): Promise<void> }
export type PublicProofWalletFactory = (challenge: PublicWalletChallenge, signal: AbortSignal,
  approved: (account: PublicWalletAccount, proof: MarketappLoginProof) => void,
  ended: (phase: 'cancelled' | 'failed') => void) => Promise<PublicProofWallet>;
export interface PublicWalletView {
  phase: 'idle' | 'preparing' | 'choosing' | 'awaiting_approval' | 'checking' | 'verified' | 'failed' | 'cancelled' | 'expired';
  options?: PublicWalletOption[];
  launchUrl?: string | null;
  error?: string;
}

/** Disposable proof sessions never restore or persist the dashboard's wallet session. */
export function createPublicProofStorage(): IStorage & { clear(): void } {
  const entries = new Map<string, string>(); let closed = false;
  return { async getItem(key) { return closed ? null : entries.get(key) ?? null; },
    async setItem(key, value) { if (!closed) entries.set(key, value); },
    async removeItem(key) { entries.delete(key); }, clear() { closed = true; entries.clear(); } };
}

export function validPublicWalletChallenge(value: unknown, manifestUrl: string, pageOrigin: string, now: number): value is PublicWalletChallenge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const challenge = value as PublicWalletChallenge;
  let manifest: URL, origin: URL;
  try { manifest = new URL(manifestUrl); origin = new URL(pageOrigin); } catch { return false; }
  if (origin.protocol !== 'https:' || manifest.protocol !== 'https:' || manifest.origin !== origin.origin ||
      manifest.username || manifest.password || manifest.hash || manifest.search ||
      challenge.manifest_url !== manifest.href || challenge.domain !== origin.host ||
      !/^[a-f0-9]{64}$/.test(challenge.attempt_id) || typeof challenge.challenge !== 'string' ||
      !/^[\x21-\x7e]{16,2048}$/.test(challenge.challenge)) return false;
  const expiry = Date.parse(challenge.expires_at);
  return Number.isFinite(expiry) && expiry > now && expiry - now <= 300_000;
}

export function validPublicWalletProof(challenge: PublicWalletChallenge, account: PublicWalletAccount, proof: MarketappLoginProof, now: number): boolean {
  return Boolean(account && account.chain === TON_MAINNET && canonicalMainnetAddress(account.address) &&
    typeof account.walletStateInit === 'string' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(account.walletStateInit) && account.walletStateInit.length <= 32768 &&
    (account.publicKey === undefined || /^[a-fA-F0-9]{64}$/.test(account.publicKey)) &&
    proof && proof.domain && proof.domain.value === challenge.domain &&
    proof.domain.lengthBytes === new TextEncoder().encode(challenge.domain).length &&
    proof.payload === challenge.challenge && Number.isSafeInteger(proof.timestamp) &&
    proof.timestamp * 1000 <= now + 30_000 && proof.timestamp * 1000 >= now - 300_000 &&
    now < Date.parse(challenge.expires_at) && typeof proof.signature === 'string' &&
    /^[A-Za-z0-9+/_-]{85}[AQgw](?:==)?$/.test(proof.signature));
}

interface Attempt { active: boolean; checking: boolean; abort: AbortController; challenge?: PublicWalletChallenge; wallet?: PublicProofWallet; timer?: ReturnType<typeof setTimeout> }

/** A returned wallet connection is not ownership proof; only the server can verify it. */
export function createPublicWalletController(adapter: Pick<PublicAccountAdapter, 'startWallet' | 'finishWallet'>,
  factory: PublicProofWalletFactory, manifestUrl: string, pageOrigin: string,
  update: (view: PublicWalletView) => void, verified: (account: PublicAccountStatus) => void,
  clock = { now: () => Date.now(), timer: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) }) {
  let current: Attempt | null = null, disposed = false;
  let view: PublicWalletView = { phase: 'idle' };
  const emit = (next: PublicWalletView) => { view = next; if (!disposed) update(next); };
  const isCurrent = (attempt: Attempt) => !disposed && current === attempt && attempt.active;
  const close = (attempt: Attempt) => {
    attempt.active = false; attempt.abort.abort(); if (attempt.timer !== undefined) clock.clear(attempt.timer);
    if (current === attempt) current = null;
    if (attempt.wallet) void attempt.wallet.close().catch(() => undefined);
    attempt.wallet = undefined; attempt.challenge = undefined;
  };
  const end = (attempt: Attempt, phase: 'failed' | 'cancelled' | 'expired', error?: string) => {
    if (!isCurrent(attempt)) return; close(attempt); emit({ phase, ...(error ? { error } : {}) });
  };
  async function approved(attempt: Attempt, account: PublicWalletAccount, proof: MarketappLoginProof) {
    if (!isCurrent(attempt) || !attempt.challenge || attempt.checking) return;
    if (!validPublicWalletProof(attempt.challenge, account, proof, clock.now())) {
      end(attempt, 'failed', 'The wallet did not return the requested mainnet approval. Connect again.'); return;
    }
    attempt.checking = true; emit({ phase: 'checking' });
    try {
      const result = readPublicAccount(await adapter.finishWallet(attempt.challenge.attempt_id, account, proof, attempt.abort.signal));
      if (!isCurrent(attempt)) return;
      if (result.wallet?.address !== canonicalMainnetAddress(account.address)) {
        end(attempt, 'failed', 'The approved wallet could not be confirmed. Reload account settings.'); return;
      }
      close(attempt); emit({ phase: 'verified' }); verified(result);
    } catch (error) { end(attempt, 'failed', publicAccountError(error)); }
  }
  return { get view() { return view; },
    async start() {
      if (disposed || current) return false;
      const attempt: Attempt = { active: true, checking: false, abort: new AbortController() }; current = attempt; emit({ phase: 'preparing' });
      try {
        attempt.timer = clock.timer(() => end(attempt, 'failed', 'Wallet approval could not be prepared in time. Try again.'), 45_000);
        const challenge = await adapter.startWallet(attempt.abort.signal);
        if (!isCurrent(attempt)) return false;
        if (!validPublicWalletChallenge(challenge, manifestUrl, pageOrigin, clock.now())) {
          end(attempt, 'failed', 'A safe wallet approval could not be prepared. Reopen the app.'); return false;
        }
        attempt.challenge = challenge; clock.clear(attempt.timer);
        attempt.timer = clock.timer(() => end(attempt, 'expired'), Date.parse(challenge.expires_at) - clock.now());
        const wallet = await factory(challenge, attempt.abort.signal, (account, proof) => { void approved(attempt, account, proof); }, phase => end(attempt, phase));
        if (!isCurrent(attempt)) { void wallet.close().catch(() => undefined); return false; }
        attempt.wallet = wallet;
        if (!wallet.options.length) { end(attempt, 'failed', 'No compatible wallet is available. Try again.'); return false; }
        if (attempt.checking) return true;
        emit({ phase: 'choosing', options: wallet.options }); return true;
      } catch (error) { end(attempt, 'failed', publicAccountError(error)); return false; }
    },
    choose(id: string) {
      const attempt = current;
      if (!attempt || !isCurrent(attempt) || !attempt.wallet || view.phase !== 'choosing') return null;
      try {
        emit({ phase: 'awaiting_approval' }); const link = attempt.wallet.connect(id);
        if (!isCurrent(attempt)) return null;
        const launch = link === null ? null : safeWalletLaunchUrl(link);
        if (link !== null && !launch) { end(attempt, 'failed', 'A safe wallet link could not be opened.'); return null; }
        if (!attempt.checking) emit({ phase: 'awaiting_approval', launchUrl: launch }); return launch;
      } catch { end(attempt, 'failed', 'The wallet chooser could not complete this approval. Try again.'); return null; }
    },
    cancel() { if (current) end(current, 'cancelled'); },
    dispose() { disposed = true; if (current) close(current); },
  };
}
