import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketappResult, createMarketappLoginTestController, createMarketappMemoryStorage, isCompatibleMarketappResult, isSafeMarketappChallenge, MARKETAPP_MANIFEST, marketappLoginFailureDetails, MarketappWalletFailure, marketappWalletLaunchUrl, safeWalletLaunchUrl } from './marketappLoginFlow.ts';
import { decodeTelegramUrlParameters, encodeTelegramUrlParameters } from '@tonconnect/sdk';
import type { MarketappLoginFailureReason, MarketappLoginView, MarketappWalletFactory } from './marketappLoginFlow.ts';
import type { MarketappLoginAccount, MarketappLoginChallenge, MarketappLoginProof, MarketappLoginTestAdapter, MarketappLoginTestResult } from '../data/types.ts';
import { createLocalDashboardAdapter } from '../data/local.ts';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import type { CloudEndpoint } from './cloudTransport.ts';

const wallet = `0:${'12'.repeat(32)}`, now = Date.parse('2026-01-01T12:00:00Z'), id = 'a'.repeat(64);
const challenge = (): MarketappLoginChallenge => ({ attempt_id: id, challenge: 'synthetic-challenge', manifest_url: MARKETAPP_MANIFEST, expires_at: new Date(now + 300_000).toISOString(), wallet, domain: 'marketapp.org' });
const account: MarketappLoginAccount = { address: wallet, chain: '-239' };
const proof: MarketappLoginProof = { timestamp: now / 1000, domain: { lengthBytes: 13, value: 'marketapp.org' }, payload: 'synthetic-challenge', signature: 'synthetic-signature' };
const result = (): MarketappLoginTestResult => ({ attempt_id: id, compatible: true, checks: { wallet_matches: true, mainnet: true, domain_matches: true, challenge_matches: true, timestamp_fresh: true, signature_present: true }, signature_verified: false, authenticated: false, analytics_refreshed: false });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function setup(overrides: Partial<MarketappLoginTestAdapter> = {}, factoryOverride?: MarketappWalletFactory) {
  const views: MarketappLoginView[] = [], cancelled: string[] = [], finishes: string[] = [], callbacks: { approved: (account: MarketappLoginAccount, proof: MarketappLoginProof) => void; ended: (phase: 'cancelled' | 'failed', reason?: MarketappLoginFailureReason) => void; signal: AbortSignal }[] = [];
  let starts = 0, closes = 0, connects = 0, counter = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const transport: MarketappLoginTestAdapter = {
    async start() { starts++; return challenge(); },
    async finish(attempt) { finishes.push(attempt); return result(); },
    async cancel(attempt) { cancelled.push(attempt); }, ...overrides,
  };
  const factory: MarketappWalletFactory = async (_challenge, signal, approved, ended) => {
    callbacks.push({ approved, ended, signal });
    return { options: [{ id: 'tonkeeper', name: 'Synthetic wallet', installed: false }], connect() { connects++; return 'https://wallet.example/connect'; }, async close() { closes++; } };
  };
  const controller = createMarketappLoginTestController(transport, factoryOverride ?? factory, wallet, view => views.push(view), {
    now: () => now, timer(callback, delay) { const handle = ++counter; timers.set(handle, { callback, delay }); return handle as unknown as ReturnType<typeof setTimeout>; },
    clear(handle) { timers.delete(handle as unknown as number); },
  });
  return { controller, views, cancelled, finishes, callbacks, timers, get starts() { return starts; }, get closes() { return closes; }, get connects() { return connects; } };
}

test('isolated memory storage never reads another instance and rejects writes after cleanup', async () => {
  const first = createMarketappMemoryStorage(), second = createMarketappMemoryStorage();
  await first.setItem('ton-connect-storage', 'synthetic-proof-state');
  assert.equal(await first.getItem('ton-connect-storage'), 'synthetic-proof-state');
  assert.equal(await second.getItem('ton-connect-storage'), null);
  first.clear(); await first.setItem('ton-connect-storage', 'late-state');
  assert.equal(await first.getItem('ton-connect-storage'), null);
});

test('challenge validation restricts provider identity, saved wallet, ASCII nonce and deadline', () => {
  assert.equal(isSafeMarketappChallenge(challenge(), wallet, now), true);
  for (const change of [{ manifest_url: 'https://evil.example/manifest.json' }, { domain: 'evil.example' }, { wallet: `0:${'34'.repeat(32)}` }, { challenge: 'contains space' }, { challenge: 'ü' }, { challenge: 'a'.repeat(2049) }, { expires_at: new Date(now).toISOString() }, { expires_at: new Date(now + 300_001).toISOString() }]) {
    assert.equal(isSafeMarketappChallenge({ ...challenge(), ...change } as MarketappLoginChallenge, wallet, now), false);
  }
});

test('a success never accepts mismatched checks or claims login, signature verification or refreshed analytics', () => {
  assert.equal(isCompatibleMarketappResult(result(), id), true);
  for (const key of Object.keys(result().checks) as (keyof MarketappLoginTestResult['checks'])[]) {
    assert.equal(isCompatibleMarketappResult({ ...result(), checks: { ...result().checks, [key]: false } }, id), false);
  }
  for (const change of [{ attempt_id: 'b'.repeat(64) }, { compatible: false }, { authenticated: true }, { analytics_refreshed: true }, { signature_verified: true }]) {
    assert.equal(isCompatibleMarketappResult({ ...result(), ...change } as MarketappLoginTestResult, id), false);
  }
});

const mismatches = [
  ['wallet_matches', 'wallet_mismatch', 'MC-WALLET'], ['mainnet', 'mainnet_required', 'MC-NETWORK'],
  ['domain_matches', 'domain_mismatch', 'MC-DOMAIN'], ['challenge_matches', 'challenge_mismatch', 'MC-CHALLENGE'],
  ['timestamp_fresh', 'timestamp_invalid', 'MC-TIME'], ['signature_present', 'signature_missing', 'MC-SIGNATURE'],
] as const;

test('validated false results produce a fixed diagnostic for each failed proof check', async () => {
  for (const [field, reason, code] of mismatches) {
    const rejected = { ...result(), compatible: false, checks: { ...result().checks, [field]: false } };
    assert.equal(classifyMarketappResult(rejected, id), reason);
    assert.equal(marketappLoginFailureDetails(reason).code, code);
    const h = setup({ finish: async () => rejected });
    await h.controller.start(); h.controller.choose('tonkeeper'); h.callbacks[0].approved(account, proof); await tick();
    assert.deepEqual(h.controller.view, { phase: 'failed', failure: reason });
    assert.equal(h.closes, 1); assert.equal(h.callbacks[0].signal.aborted, true);
    assert.deepEqual(h.cancelled, []); // A returned finish result has already consumed the attempt.
  }
  assert.equal(classifyMarketappResult({ ...result(), compatible: false, checks: { ...result().checks, wallet_matches: false, domain_matches: false } }, id), 'wallet_mismatch');
});

test('malformed or inconsistent results never masquerade as a specific proof mismatch', async () => {
  const rejected = { ...result(), compatible: false, checks: { ...result().checks, domain_matches: false } };
  for (const malformed of [null, [], { ...rejected, attempt_id: 'b'.repeat(64) }, { ...rejected, signature_verified: true },
    { ...rejected, authenticated: true }, { ...rejected, analytics_refreshed: true }, { ...rejected, compatible: true },
    { ...result(), compatible: false }, { ...rejected, checks: null }, { ...rejected, checks: [] },
    { ...rejected, checks: { ...rejected.checks, timestamp_fresh: 'false' } },
    { ...rejected, checks: { ...rejected.checks, mainnet: undefined } }]) {
    assert.equal(classifyMarketappResult(malformed, id), 'invalid_response');
  }
  const h = setup({ finish: async () => ({ ...rejected, compatible: true }) });
  await h.controller.start(); h.callbacks[0].approved(account, proof); await tick();
  assert.deepEqual(h.controller.view, { phase: 'failed', failure: 'invalid_response' });
});

test('missing proof and SDK failures are distinct and never submit proof or raw errors', async () => {
  for (const reason of ['proof_missing', 'wallet_error', 'mainnet_required'] as const) {
    const h = setup(); await h.controller.start(); h.callbacks[0].ended('failed', reason); await tick();
    assert.deepEqual(h.controller.view, { phase: 'failed', failure: reason });
    assert.equal(h.finishes.length, 0); assert.equal(h.closes, 1); assert.equal(h.callbacks[0].signal.aborted, true);
  }
  const secret = 'private-provider-text nonce=hidden signature=hidden address=hidden domain=hidden';
  for (const stage of ['start', 'finish'] as const) {
    const h = setup({ [stage]: async () => { throw Object.assign(new Error(secret), { code: secret }); } });
    if (stage === 'start') await h.controller.start();
    else { await h.controller.start(); h.callbacks[0].approved(account, proof); await tick(); }
    assert.equal(h.controller.view.failure, stage === 'start' ? 'start_transport' : 'finish_transport');
    assert.equal(JSON.stringify(h.views).includes(secret), false);
    const detail = marketappLoginFailureDetails(h.controller.view.failure);
    assert.equal(JSON.stringify(detail).includes(secret), false);
  }
  assert.equal(marketappLoginFailureDetails(secret as MarketappLoginFailureReason).code, 'MC-RESPONSE');
});

test('preparation, transport timeouts, invalid challenge and chooser failures have distinct safe diagnostics', async () => {
  const pending = deferred<MarketappLoginChallenge>(), timed = setup({ start: () => pending.promise });
  const started = timed.controller.start(); [...timed.timers.values()].find(timer => timer.delay === 45_000)!.callback();
  assert.deepEqual(timed.controller.view, { phase: 'failed', failure: 'preparing_timeout' });
  pending.resolve(challenge()); await started; await tick(); assert.equal(timed.callbacks.length, 0);
  for (const stage of ['start', 'finish'] as const) {
    const h = setup({ [stage]: async () => { throw Object.assign(new Error('Private transport text'), { code: 'TIMEOUT' }); } });
    if (stage === 'start') await h.controller.start();
    else { await h.controller.start(); h.callbacks[0].approved(account, proof); await tick(); }
    assert.equal(h.controller.view.failure, stage === 'start' ? 'preparing_timeout' : 'check_timeout');
  }
  const invalid = setup({ start: async () => ({ ...challenge(), domain: 'unexpected.invalid' } as unknown as MarketappLoginChallenge) });
  await invalid.controller.start(); assert.equal(invalid.controller.view.failure, 'invalid_challenge'); assert.equal(invalid.callbacks.length, 0);
  for (const factory of [async () => { throw new Error('Private wallet registry response'); }, async () => ({ options: [], connect: () => null, async close() {} })] as MarketappWalletFactory[]) {
    const h = setup({}, factory); await h.controller.start(); await tick();
    assert.equal(h.controller.view.failure, 'chooser_unavailable'); assert.deepEqual(h.cancelled, [id]);
  }
});

test('a limited retest preserves the earlier passed approval without storing proof', async () => {
  let starts = 0;
  const h = setup({ start: async () => { if (++starts > 1) throw Object.assign(new Error('Private rate-limit details'), { code: 'MARKETAPP_LOGIN_RATE_LIMIT' }); return challenge(); } });
  await h.controller.start(); h.callbacks[0].approved(account, proof); await tick();
  assert.deepEqual(h.controller.view, { phase: 'passed' });
  assert.equal(await h.controller.start(), false);
  assert.deepEqual(h.controller.view, { phase: 'passed', failure: 'rate_limited' });
  assert.equal(h.callbacks.length, 1); assert.equal(h.finishes.length, 1);
  assert.equal(marketappLoginFailureDetails('rate_limited').code, 'MC-LIMIT');
  assert.match(marketappLoginFailureDetails('rate_limited').message, /one minute.*five tests.*hour/);
  assert.equal(JSON.stringify(h.views).includes(proof.signature), false);
  assert.equal(JSON.stringify(h.views).includes('Private rate-limit details'), false);
});

test('first-test rate limits and expired server attempts remain distinct from transport failures', async () => {
  const limited = setup({ start: async () => { throw { code: 'MARKETAPP_LOGIN_RATE_LIMIT', message: 'Private server details' }; } });
  assert.equal(await limited.controller.start(), false);
  assert.deepEqual(limited.controller.view, { phase: 'failed', failure: 'rate_limited' });
  assert.equal(limited.callbacks.length, 0);
  const expired = setup({ finish: async () => { throw { code: 'MARKETAPP_LOGIN_EXPIRED', message: 'Private expiry details' }; } });
  await expired.controller.start(); expired.callbacks[0].approved(account, proof); await tick();
  assert.deepEqual(expired.controller.view, { phase: 'failed', failure: 'expired_test' });
  assert.equal(marketappLoginFailureDetails('expired_test').code, 'MC-EXPIRED');
  assert.equal(expired.closes, 1); assert.equal(expired.callbacks[0].signal.aborted, true);
});

test('expected private test errors render fixed codes without reflecting provider messages', async () => {
  for (const [code, reason] of [
    ['MARKETAPP_LOGIN_INVALID_INPUT', 'invalid_input'], ['MARKETAPP_LOGIN_PRIVATE_ACCESS_DENIED', 'access_denied'],
    ['MARKETAPP_LOGIN_WALLET_REQUIRED', 'wallet_required'], ['MARKETAPP_LOGIN_FAILED', 'server_failed'],
  ] as const) {
    const h = setup({ start: async () => { throw { code, message: 'Private nonce signature domain account' }; } });
    await h.controller.start(); assert.deepEqual(h.controller.view, { phase: 'failed', failure: reason });
    assert.equal(JSON.stringify(h.views).includes('Private nonce'), false);
    assert.equal(JSON.stringify(marketappLoginFailureDetails(reason)).includes('Private nonce'), false);
  }
});

test('unsafe launch and SDK connection exceptions remain fixed diagnostics without provider content', async () => {
  for (const [connect, reason] of [
    [() => 'javascript:private-provider-content', 'launch_invalid'],
    [() => { throw new Error('Private SDK signature nonce address'); }, 'wallet_error'],
    [() => { throw new MarketappWalletFailure('mainnet_required'); }, 'mainnet_required'],
  ] as const) {
    const h = setup({}, async () => ({ options: [{ id: 'synthetic', name: 'Synthetic', installed: false }], connect, async close() {} }));
    await h.controller.start(); assert.equal(h.controller.choose('synthetic'), null); await tick();
    assert.deepEqual(h.controller.view, { phase: 'failed', failure: reason });
    assert.equal(JSON.stringify(h.views).includes('private-provider-content'), false);
    assert.deepEqual(h.cancelled, [id]);
  }
});

test('explicit start and wallet choice run once; repeated approvals never replay proof', async () => {
  const h = setup(); assert.equal(h.starts, 0);
  const first = h.controller.start(); assert.equal(await h.controller.start(), false); assert.equal(await first, true);
  assert.equal(h.starts, 1); assert.equal(h.controller.view.phase, 'choosing');
  assert.equal(h.controller.choose('tonkeeper'), 'https://wallet.example/connect');
  assert.equal(h.controller.choose('tonkeeper'), null); assert.equal(h.connects, 1);
  h.callbacks[0].approved(account, proof); h.callbacks[0].approved(account, proof); await tick();
  assert.equal(h.finishes.length, 1); assert.equal(h.controller.view.phase, 'passed'); assert.equal(h.closes, 1);
  assert.ok(h.views.every(view => !JSON.stringify(view).includes('synthetic-challenge')));
});

test('cancel and user decline abort only the test and never submit an approval', async () => {
  const h = setup(); await h.controller.start(); h.controller.choose('tonkeeper'); h.controller.cancel(); await tick();
  assert.equal(h.controller.view.phase, 'cancelled'); assert.equal(h.callbacks[0].signal.aborted, true); assert.equal(h.closes, 1); assert.deepEqual(h.cancelled, [id]);
  h.callbacks[0].approved(account, proof); await tick(); assert.equal(h.finishes.length, 0);
  await h.controller.start(); h.callbacks[1].ended('cancelled'); await tick();
  assert.equal(h.controller.view.phase, 'cancelled'); assert.equal(h.finishes.length, 0);
});

test('unmount suppresses late start and finish results, with bounded remote cancellation', async () => {
  const pending = deferred<MarketappLoginChallenge>(), h = setup({ start: () => pending.promise });
  const started = h.controller.start(); h.controller.dispose(); const count = h.views.length;
  pending.resolve(challenge()); await started; await tick();
  assert.equal(h.views.length, count); assert.deepEqual(h.cancelled, [id]); assert.equal(await h.controller.start(), false);
  const finished = deferred<MarketappLoginTestResult>(), second = setup({ finish: () => finished.promise });
  await second.controller.start(); second.controller.choose('tonkeeper'); second.callbacks[0].approved(account, proof); second.controller.dispose();
  const emitted = second.views.length; finished.resolve(result()); await tick(); assert.equal(second.views.length, emitted);
});

test('a cancelled previous attempt cannot overwrite a fresh chooser', async () => {
  const finished = deferred<MarketappLoginTestResult>(), h = setup({ finish: () => finished.promise });
  await h.controller.start(); h.controller.choose('tonkeeper'); h.callbacks[0].approved(account, proof); h.controller.cancel();
  await h.controller.start(); assert.equal(h.controller.view.phase, 'choosing');
  finished.resolve(result()); h.callbacks[0].ended('failed'); await tick();
  assert.equal(h.controller.view.phase, 'choosing'); assert.equal(h.callbacks[1].signal.aborted, false);
  h.controller.dispose();
});

test('expiry closes test resources and invalid challenge never creates a wallet session', async () => {
  const h = setup(); await h.controller.start();
  const expiry = [...h.timers.values()].find(timer => timer.delay === 300_000)!; expiry.callback(); await tick();
  assert.equal(h.controller.view.phase, 'expired'); assert.equal(h.callbacks[0].signal.aborted, true); assert.equal(h.closes, 1);
  const invalid = setup({ start: async () => ({ ...challenge(), manifest_url: 'https://evil.example/' }) });
  assert.equal(await invalid.controller.start(), false); assert.equal(invalid.callbacks.length, 0); assert.equal(invalid.controller.view.phase, 'failed');
});

test('only HTTPS wallet launch links are accepted and desktop has no login-test capability', () => {
  assert.equal(safeWalletLaunchUrl('https://wallet.example/connect?r=synthetic'), 'https://wallet.example/connect?r=synthetic');
  for (const url of ['javascript:alert(1)', 'http://wallet.example', 'https://user:secret@wallet.example/']) assert.equal(safeWalletLaunchUrl(url), null);
  assert.equal(createLocalDashboardAdapter().marketappLoginTest, undefined);
});

test('Telegram return links preserve SDK-encoded connect parameters and target only the configured bot', () => {
  const original = new URLSearchParams({ v: '2', id: 'synthetic-id', r: JSON.stringify({ items: [{ name: 'ton_proof', payload: 'synthetic-challenge' }] }), trace_id: 'synthetic-trace' });
  const launch = `https://t.me/wallet/start?startapp=tonconnect-${encodeTelegramUrlParameters(original.toString())}`;
  const returnUrl = 'https://t.me/synthetic_bot?startapp';
  const returned = new URL(marketappWalletLaunchUrl(launch, returnUrl)!);
  const decoded = new URLSearchParams(decodeTelegramUrlParameters(returned.searchParams.get('startapp')!.slice('tonconnect-'.length)));
  for (const key of ['v', 'id', 'r', 'trace_id']) assert.equal(decoded.get(key), original.get(key));
  assert.equal(decoded.get('ret'), 'https://t.me/synthetic_bot?startapp');
  assert.equal(new URL(marketappWalletLaunchUrl('https://wallet.example/connect?r=synthetic', returnUrl)!).searchParams.get('ret'), returnUrl);
  for (const target of ['https://evil.example/', 'javascript:alert(1)', 'https://t.me/not_a_miniapp', 'https://t.me/synthetic_bot?startapp&unexpected=1']) {
    assert.equal(marketappWalletLaunchUrl(launch, target), null);
  }
});

test('a fresh effect-owned controller remains usable after StrictMode cleans up the prior instance', async () => {
  const first = setup(); first.controller.dispose(); assert.equal(await first.controller.start(), false);
  const second = setup(); assert.equal(await second.controller.start(), true);
  second.controller.choose('tonkeeper'); second.callbacks[0].approved(account, proof); await tick();
  assert.equal(second.controller.view.phase, 'passed'); assert.equal(first.starts, 0);
});

test('default browser timers retain their global receiver instead of binding to the clock object', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let scheduled = 0, cleared = 0;
  globalThis.setTimeout = (function (this: unknown, callback: () => void, delay?: number) {
    assert.equal(this, globalThis); scheduled++; return originalSet(callback, delay);
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (function (this: unknown, handle: ReturnType<typeof setTimeout>) {
    assert.equal(this, globalThis); cleared++; originalClear(handle);
  }) as typeof globalThis.clearTimeout;
  try {
    const controller = createMarketappLoginTestController({ async start() { throw new Error('Synthetic failure'); }, async finish() { return result(); }, async cancel() {} },
      async () => { throw new Error('Must not create a wallet'); }, wallet, () => {});
    assert.equal(await controller.start(), false); assert.equal(controller.view.phase, 'failed');
    assert.equal(scheduled, 1); assert.equal(cleared, 1); controller.dispose();
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('timer scheduling failure releases the attempt, and zero-valued handles are cleared', async () => {
  let fail = true, created = 0;
  const cleared: number[] = [];
  const controller = createMarketappLoginTestController({ async start() { return challenge(); }, async finish() { return result(); }, async cancel() {} },
    async () => { created++; return { options: [{ id: 'synthetic', name: 'Synthetic', installed: false }], connect: () => null, async close() {} }; }, wallet, () => {},
    { now: () => now, timer() { if (fail) throw new Error('Synthetic timer failure'); return 0 as unknown as ReturnType<typeof setTimeout>; }, clear(handle) { cleared.push(handle as unknown as number); } });
  assert.equal(await controller.start(), false); assert.equal(controller.view.phase, 'failed'); assert.equal(created, 0);
  fail = false; assert.equal(await controller.start(), true); assert.equal(created, 1); controller.cancel(); await tick();
  assert.ok(cleared.every(handle => handle === 0)); assert.ok(cleared.length >= 2); controller.dispose();
});

test('cloud adapter uses only test endpoints and minimal account/proof fields', async () => {
  const calls: { endpoint: CloudEndpoint; input: Record<string, unknown> }[] = [];
  const adapter = createCloudDashboardAdapter({ async call<T>(endpoint: CloudEndpoint, input: Record<string, unknown> = {}) {
    calls.push({ endpoint, input }); return (endpoint === 'startMarketappLoginTest' ? challenge() : endpoint === 'finishMarketappLoginTest' ? result() : { cancelled: true }) as T;
  } });
  await adapter.marketappLoginTest!.start(); await adapter.marketappLoginTest!.finish(id, account, proof); await adapter.marketappLoginTest!.cancel(id);
  assert.deepEqual(calls.map(call => call.endpoint), ['startMarketappLoginTest', 'finishMarketappLoginTest', 'cancelMarketappLoginTest']);
  assert.deepEqual(Object.keys(calls[1].input).sort(), ['account', 'attempt_id', 'proof']);
  assert.deepEqual(Object.keys(calls[1].input.account as object).sort(), ['address', 'chain']);
});
