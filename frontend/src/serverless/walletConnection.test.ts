import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMainnetAddress, observeWalletRestoration, shortWalletAddress, TON_MAINNET, walletBinding } from './walletIdentity.ts';

const raw = `0:${'ab'.repeat(32)}`;
const other = `0:${'cd'.repeat(32)}`;
const account = { address: raw, chain: TON_MAINNET };

function friendly(address: string, { bounceable = true, testnet = false, urlSafe = true } = {}) {
  const [workchain, hex] = address.split(':');
  const bytes = Uint8Array.from([ (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0), Number(workchain) & 255,
    ...Buffer.from(hex, 'hex') ]);
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let n = 0; n < 8; n++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 65535;
  }
  return Buffer.from([...bytes, crc >> 8, crc & 255]).toString(urlSafe ? 'base64url' : 'base64');
}

test('wallet identity compares raw and both TON friendly mainnet aliases', () => {
  for (const address of [raw.toUpperCase(), friendly(raw), friendly(raw, { bounceable: false }), friendly(raw, { urlSafe: false })]) {
    assert.equal(canonicalMainnetAddress(address), raw);
    assert.deepEqual(walletBinding({ restored: true, account: { ...account, address }, savedWallet: friendly(raw) }), { state: 'matching', address: raw });
  }
  const masterchain = `-1:${'fe'.repeat(32)}`;
  assert.equal(canonicalMainnetAddress(friendly(masterchain)), masterchain);
  // Independent published zero-address encoding protects against a shared CRC helper mistake.
  assert.equal(canonicalMainnetAddress('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'), `0:${'0'.repeat(64)}`);
});

test('invalid checksums, test-only flags, unsupported workchains and opaque identifiers never match', () => {
  const valid = friendly(raw);
  for (const invalid of [valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A'), friendly(raw, { testnet: true }),
    `1:${'ab'.repeat(32)}`, 'gift-1', raw + ' ', '0:abcd', null, 123]) {
    assert.equal(canonicalMainnetAddress(invalid), null, String(invalid));
  }
  assert.equal(walletBinding({ restored: true, account, savedWallet: 'legacy-gift' }).state, 'unknown_portfolio');
  assert.equal(walletBinding({ restored: true, account: { ...account, address: 'bad' }, savedWallet: 'bad' }).state, 'invalid_address');
});

test('restoration, cancellation and wallet-side disconnect do not invent a connected wallet', () => {
  assert.equal(walletBinding({ restored: false, account: null, savedWallet: raw }).state, 'restoring');
  assert.equal(walletBinding({ restored: false, account, savedWallet: raw }).state, 'restoring');
  assert.equal(walletBinding({ restored: true, account: null, savedWallet: raw }).state, 'disconnected');
  assert.equal(walletBinding({ restored: true, account, savedWallet: raw }).state, 'matching');
  assert.equal(walletBinding({ restored: true, account: null, savedWallet: raw }).state, 'disconnected');
});

test('an account change changes connection identity while leaving saved portfolio identity untouched', () => {
  const input = Object.freeze({ restored: true, account: Object.freeze({ address: other, chain: TON_MAINNET }), savedWallet: raw });
  assert.deepEqual(walletBinding(input), { state: 'different_wallet', address: other });
  assert.equal(input.savedWallet, raw);
  assert.equal(walletBinding({ ...input, account }).state, 'matching');
});

test('mainnet chain is mandatory even when the wallet provides a matching raw address', () => {
  for (const chain of ['-3', '', 'mainnet', '0']) {
    assert.deepEqual(walletBinding({ restored: true, account: { ...account, chain }, savedWallet: raw }), { state: 'unsupported_network', address: null });
  }
  assert.equal(walletBinding({ restored: true, account: { address: friendly(raw, { testnet: true }), chain: TON_MAINNET }, savedWallet: raw }).state, 'invalid_address');
});

test('saved dashboard loading or unavailable metadata remains explicitly unverified', () => {
  assert.equal(walletBinding({ restored: true, account, savedWallet: null, dashboardReady: false }).state, 'loading_portfolio');
  assert.equal(walletBinding({ restored: true, account, savedWallet: null }).state, 'unknown_portfolio');
  assert.equal(walletBinding({ restored: true, account, savedWallet: raw, dashboardReady: false }).state, 'loading_portfolio');
  assert.equal(shortWalletAddress(raw), '0:ababa…ababab');
  assert.equal(shortWalletAddress('short'), 'short');
});

test('a rejected SDK restoration settles the control and exposes a generic reconnect error', async () => {
  const results: (string | null)[] = [];
  observeWalletRestoration(Promise.reject(new Error('Untrusted provider diagnostics')), error => results.push(error));
  await Promise.resolve();
  assert.equal(results.length, 1);
  assert.equal(results[0], 'Saved wallet connection could not be restored. Connect again.');
  // Completion is independent of whether a connection existed: both permit a fresh connect.
  for (const restored of [true, false]) {
    observeWalletRestoration(Promise.resolve(restored), error => results.push(error));
    await Promise.resolve();
    assert.equal(results.at(-1), null);
  }
});

test('restoration completion after unmount cannot change the wallet control', async () => {
  let finish!: (value: unknown) => void;
  const restoration = new Promise(resolve => { finish = resolve; });
  let called = false;
  const cancel = observeWalletRestoration(restoration, () => { called = true; });
  cancel();
  finish(true);
  await Promise.resolve();
  assert.equal(called, false);
});
