import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicProofStorage, createPublicWalletController, validPublicWalletChallenge, validPublicWalletProof } from './publicWalletFlow.ts';
import type { PublicProofWalletFactory, PublicWalletView } from './publicWalletFlow.ts';
import type { PublicAccountAdapter, PublicAccountStatus, PublicWalletChallenge } from './publicAccount.ts';
import type { MarketappLoginProof } from '../data/types.ts';

const address = `0:${'12'.repeat(32)}`, now = Date.parse('2026-10-10T12:00:00.000Z');
const manifest = 'https://app.example/tonconnect-manifest.json';
const challenge = (): PublicWalletChallenge => ({ attempt_id: 'a'.repeat(64), challenge: 'synthetic-single-use-nonce', manifest_url: manifest, domain: 'app.example', expires_at: new Date(now + 300000).toISOString() });
const account = { address, chain: '-239', walletStateInit: 'c3ludGhldGlj', publicKey: '12'.repeat(32) };
const proof = (): MarketappLoginProof => ({ timestamp: now / 1000, domain: { lengthBytes: 11, value: 'app.example' }, payload: challenge().challenge, signature: 'A'.repeat(86) + '==' });
const status = (): PublicAccountStatus => ({ public_mode: true, wallet: { address, verified_at: new Date(now).toISOString() }, marketapp_key: { configured: false, updated_at: null }, onboarding_complete: false });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(overrides: Partial<Pick<PublicAccountAdapter, 'startWallet' | 'finishWallet'>> = {}, customFactory?: PublicProofWalletFactory) {
  const views: PublicWalletView[] = [], verified: PublicAccountStatus[] = [], finishes: unknown[] = [];
  const callbacks: { approved: Parameters<PublicProofWalletFactory>[2]; ended: Parameters<PublicProofWalletFactory>[3]; signal: AbortSignal }[] = [];
  let closes = 0, starts = 0, count = 0;
  const timers = new Map<number, () => void>();
  const adapter = { async startWallet() { starts++; return challenge(); }, async finishWallet(...input: unknown[]) { finishes.push(input); return status(); }, ...overrides };
  const factory: PublicProofWalletFactory = async (_challenge, signal, approved, ended) => {
    callbacks.push({ signal, approved, ended });
    return { options: [{ id: 'wallet', name: 'Synthetic wallet', installed: false }], connect() { return 'https://wallet.example/connect'; }, async close() { closes++; } };
  };
  const controller = createPublicWalletController(adapter, customFactory ?? factory, manifest, 'https://app.example', view => views.push(view), value => verified.push(value), {
    now: () => now, timer(callback) { const id = ++count; timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    clear(id) { timers.delete(id as unknown as number); },
  });
  return { controller, views, verified, finishes, callbacks, timers, get closes() { return closes; }, get starts() { return starts; } };
}

test('public proof storage stays isolated, is never persistent, and cannot be revived after disposal', async () => {
  const a = createPublicProofStorage(), b = createPublicProofStorage();
  await a.setItem('session', 'synthetic'); assert.equal(await a.getItem('session'), 'synthetic'); assert.equal(await b.getItem('session'), null);
  a.clear(); await a.setItem('session', 'late'); assert.equal(await a.getItem('session'), null);
});

test('wallet challenges must target this app’s own HTTPS origin and exact configured manifest', () => {
  assert.equal(validPublicWalletChallenge(challenge(), manifest, 'https://app.example', now), true);
  for (const change of [{ domain: 'marketapp.org' }, { manifest_url: 'https://marketapp.org/tonconnect-manifest.json' }, { attempt_id: 'wrong' },
    { challenge: 'too short' }, { challenge: 'x'.repeat(2049) }, { challenge: 'ü'.repeat(30) }, { expires_at: new Date(now).toISOString() }, { expires_at: new Date(now + 300001).toISOString() }])
    assert.equal(validPublicWalletChallenge({ ...challenge(), ...change }, manifest, 'https://app.example', now), false);
  for (const invalidManifest of ['http://app.example/tonconnect-manifest.json', 'https://foreign.example/tonconnect-manifest.json', manifest + '#x', manifest + '?x', 'https://user:password@app.example/tonconnect-manifest.json'])
    assert.equal(validPublicWalletChallenge(challenge(), invalidManifest, 'https://app.example', now), false);
  assert.equal(validPublicWalletChallenge(challenge(), manifest, 'http://app.example', now), false);
});

test('proof structure rejects missing state, testnet, domain, nonce, time, and signature mismatches before submission', () => {
  assert.equal(validPublicWalletProof(challenge(), account, proof(), now), true);
  assert.equal(validPublicWalletProof(challenge(), account, { ...proof(), signature: proof().signature.slice(0, -2) }, now), true);
  for (const change of [{ chain: '-3' }, { address: 'invalid' }, { walletStateInit: '' }, { walletStateInit: 'x'.repeat(32769) }, { publicKey: 'invalid' }])
    assert.equal(validPublicWalletProof(challenge(), { ...account, ...change }, proof(), now), false);
  for (const change of [{ domain: { lengthBytes: 13, value: 'marketapp.org' } }, { domain: { lengthBytes: 12, value: 'app.example' } },
    { payload: 'other-nonce' }, { timestamp: now / 1000 - 301 }, { timestamp: now / 1000 + 31 }, { signature: 'invalid' },
    { signature: 'A'.repeat(85) + 'B==' }])
    assert.equal(validPublicWalletProof(challenge(), account, { ...proof(), ...change }, now), false);
});

test('successful wallet verification requires a matching server-verified account and consumes one finish only', async () => {
  const h = setup(); await h.controller.start(); assert.equal(h.controller.view.phase, 'choosing');
  assert.equal(h.controller.choose('wallet'), 'https://wallet.example/connect');
  h.callbacks[0].approved(account, proof()); h.callbacks[0].approved(account, proof()); await tick();
  assert.equal(h.finishes.length, 1); assert.equal(h.controller.view.phase, 'verified'); assert.deepEqual(h.verified, [status()]);
  assert.equal(h.closes, 1); assert.equal(h.callbacks[0].signal.aborted, true); assert.equal(h.timers.size, 0);
});

test('connected wallets alone or mismatched backend identities never complete onboarding', async () => {
  for (const result of [{ ...status(), wallet: null }, { ...status(), wallet: { address: `0:${'34'.repeat(32)}`, verified_at: new Date(now).toISOString() } }, { ...status(), wallet: { address, verified_at: null } }]) {
    const h = setup({ finishWallet: async () => result as PublicAccountStatus }); await h.controller.start(); h.controller.choose('wallet');
    h.callbacks[0].approved(account, proof()); await tick(); assert.equal(h.controller.view.phase, 'failed'); assert.equal(h.verified.length, 0);
  }
  const missing = setup(); await missing.controller.start(); missing.callbacks[0].approved({ ...account, walletStateInit: '' }, proof()); await tick();
  assert.equal(missing.finishes.length, 0); assert.equal(missing.controller.view.phase, 'failed');
});

test('single active attempt, expiry, cancellation and disposal prevent late approvals from enrolling wallets', async () => {
  const h = setup(); await h.controller.start(); assert.equal(await h.controller.start(), false); assert.equal(h.starts, 1);
  h.controller.cancel(); h.callbacks[0].approved(account, proof()); await tick(); assert.equal(h.finishes.length, 0); assert.equal(h.controller.view.phase, 'cancelled');
  await h.controller.start(); [...h.timers.values()][0](); h.callbacks[1].approved(account, proof()); await tick();
  assert.equal(h.controller.view.phase, 'expired'); assert.equal(h.finishes.length, 0);
  await h.controller.start(); h.controller.dispose(); h.callbacks[2].approved(account, proof()); await tick(); assert.equal(h.finishes.length, 0); assert.equal(h.timers.size, 0);
});

test('late finish after cancellation is ignored and failures expose only fixed copy', async () => {
  const later = deferred<PublicAccountStatus>(), h = setup({ finishWallet: () => later.promise });
  await h.controller.start(); h.controller.choose('wallet'); h.callbacks[0].approved(account, proof());
  h.controller.cancel(); later.resolve(status()); await tick(); assert.equal(h.verified.length, 0); assert.equal(h.controller.view.phase, 'cancelled');
  const rejected = setup({ finishWallet: async () => { throw { code: 'WALLET_PROOF_INVALID', message: 'private nonce signature' }; } });
  await rejected.controller.start(); rejected.callbacks[0].approved(account, proof()); await tick();
  assert.equal(rejected.controller.view.phase, 'failed'); assert.equal(rejected.controller.view.error?.includes('private'), false); assert.equal(rejected.finishes.length, 0);
});

test('invalid challenges and unsafe chooser links never launch an external wallet', async () => {
  let factories = 0;
  const bad = setup({ startWallet: async () => ({ ...challenge(), domain: 'foreign.example' }) }, async () => { factories++; throw new Error('Should not run'); });
  await bad.controller.start(); assert.equal(factories, 0); assert.equal(bad.controller.view.phase, 'failed');
  const unsafe = setup({}, async () => ({ options: [{ id: 'wallet', name: 'Synthetic', installed: true }], connect() { return 'javascript:alert(1)'; }, async close() {} }));
  await unsafe.controller.start(); assert.equal(unsafe.controller.choose('wallet'), null); assert.equal(unsafe.controller.view.phase, 'failed');
});
