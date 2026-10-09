import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketappAnalyticsRefreshController, isSafeMarketappRefreshChallenge, isSafeMarketappRefreshResult, isSafeMarketappRefreshStatus, marketappAnalyticsRefreshFailure, marketappRefreshRetryText } from './marketappAnalyticsRefreshFlow.ts';
import type { MarketappAnalyticsRefreshView } from './marketappAnalyticsRefreshFlow.ts';
import { MARKETAPP_MANIFEST } from './marketappLoginFlow.ts';
import type { MarketappWalletFactory } from './marketappLoginFlow.ts';
import type { MarketappAnalyticsPeriod, MarketappAnalyticsRefreshAdapter, MarketappAnalyticsRefreshChallenge, MarketappAnalyticsRefreshResult, MarketappAnalyticsRefreshStatus, MarketappLoginAccount, MarketappLoginProof, MarketappWalletDevice, PersonalRentalAnalytics } from '../data/types.ts';
import { createCloudDashboardAdapter } from './cloudAdapter.ts';
import { createLocalDashboardAdapter } from '../data/local.ts';
import { CloudError } from './cloudTransport.ts';
import type { CloudEndpoint } from './cloudTransport.ts';

const wallet = `0:${'12'.repeat(32)}`, now = Date.parse('2026-01-01T12:00:00Z'), id = 'a'.repeat(64);
const account = { address: wallet, chain: '-239', walletStateInit: 'synthetic-state-init', publicKey: '55'.repeat(32) };
const proof: MarketappLoginProof = { timestamp: now / 1000, domain: { lengthBytes: 13, value: 'marketapp.org' }, payload: 'synthetic-nonce', signature: 'synthetic-signature' };
const device: MarketappWalletDevice = { platform: 'android', appName: 'synthetic-wallet', appVersion: '1.0', maxProtocolVersion: 2, features: [{ name: 'SendTransaction', maxMessages: 4 }] };
const challenge = (period_days: MarketappAnalyticsPeriod = 30): MarketappAnalyticsRefreshChallenge => ({ attempt_id: id, challenge: proof.payload,
  manifest_url: MARKETAPP_MANIFEST, expires_at: new Date(now + 300000).toISOString(), wallet, domain: 'marketapp.org', period_days, session_envelope: 'ab'.repeat(100) });
function snapshot(days: MarketappAnalyticsPeriod = 30): PersonalRentalAnalytics {
  const end = Date.parse('2026-01-01'), start = end - (days - 1) * 86400000;
  const daily = Array.from({ length: days }, (_, index) => ({ date: new Date(start + index * 86400000).toISOString().slice(0, 10), rent_volume: '0.1', new_rentals: 1, extensions: index % 2, rentals: 1 + index % 2 }));
  return { version: 1, source: 'marketapp_personal_rent_page', source_url: `https://marketapp.org/user/${wallet}/?tab=analytics_rent&period_by=last${days}days&group_by=day`,
    wallet, captured_at: new Date(now).toISOString(), period_start: daily[0].date, period_end: daily.at(-1)!.date, timezone: 'UTC', currency: 'GRAM', volume_basis: 'gross_before_fees', fingerprint: 'b'.repeat(64),
    summary: { rent_volume: days === 30 ? '3' : '36.5', rentals: days + Math.floor(days / 2), new_rentals: days, extensions: Math.floor(days / 2), items: 3,
      price_per_day: null, average_duration: null, extension_percent: null, spent_on_rent: '0', spending_rentals: 0 }, daily };
}
const result = (days: MarketappAnalyticsPeriod = 30): MarketappAnalyticsRefreshResult => ({ attempt_id: id, authenticated: true, analytics_refreshed: true, snapshot: snapshot(days) });
const status = (state: NonNullable<MarketappAnalyticsRefreshStatus['attempt']>['state'] = 'saved', error_code?: string): MarketappAnalyticsRefreshStatus => ({ attempt: { attempt_id: id, state, period_days: 30, updated_at: new Date(now).toISOString(), ...(error_code ? { error_code } : {}) } });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(overrides: Partial<MarketappAnalyticsRefreshAdapter> = {}, factoryOverride?: MarketappWalletFactory, savedReload?: () => Promise<void>) {
  const views: MarketappAnalyticsRefreshView[] = [], cancelled: string[] = [], finishes: unknown[] = [], saved: PersonalRentalAnalytics[] = [];
  const callbacks: { approved(account: MarketappLoginAccount, proof: MarketappLoginProof, device?: MarketappWalletDevice): void; ended: Parameters<MarketappWalletFactory>[3]; signal: AbortSignal }[] = [];
  const timers = new Map<number, { callback(): void; delay: number }>();
  let starts = 0, closes = 0, connects = 0, counter = 0, localNow = now, recovered = 0;
  const transport: MarketappAnalyticsRefreshAdapter = { async start(days) { starts++; return challenge(days); },
    async finish(request, account, proof, device) { finishes.push({ request, account, proof, device }); return result(request.period_days); },
    async cancel(attempt) { cancelled.push(attempt); }, ...overrides };
  const factory: MarketappWalletFactory = async (_request, signal, approved, ended) => {
    callbacks.push({ approved, ended, signal });
    return { options: [{ id: 'synthetic', name: 'Synthetic', installed: false }], connect() { connects++; return 'https://wallet.example/connect'; }, async close() { closes++; } };
  };
  const controller = createMarketappAnalyticsRefreshController(transport, factoryOverride ?? factory, wallet, view => views.push(view), async report => { saved.push(report); await savedReload?.(); },
    { now: () => localNow, timer(callback, delay) { const handle = ++counter; timers.set(handle, { callback, delay }); return handle as unknown as ReturnType<typeof setTimeout>; }, clear(handle) { timers.delete(handle as unknown as number); } }, async () => { recovered++; await savedReload?.(); });
  return { controller, views, callbacks, timers, cancelled, finishes, saved, advance(ms: number) { localNow += ms; }, get starts() { return starts; }, get closes() { return closes; }, get connects() { return connects; }, get recovered() { return recovered; } };
}

test('saved attempt status accepts only the fixed privacy-safe envelope and failure codes', () => {
  assert.equal(isSafeMarketappRefreshStatus({ attempt: null }), true);
  for (const state of ['awaiting_approval', 'updating', 'saved', 'expired', 'cancelled'] as const) assert.equal(isSafeMarketappRefreshStatus(status(state)), true);
  assert.equal(isSafeMarketappRefreshStatus(status('failed', 'MARKETAPP_REFRESH_PAGE_CHANGED')), true);
  for (const invalid of [null, [], {}, { attempt: null, private: 'cookie' }, { attempt: { ...status().attempt, session_envelope: 'private' } },
    { attempt: { ...status().attempt, period_days: '30' } }, { attempt: { ...status().attempt, state: { toString: () => 'saved' } } },
    { attempt: { ...status().attempt, updated_at: '2026-02-30T12:00:00Z' } }, status('failed'), status('failed', 'private-provider-message'),
    status('saved', 'MARKETAPP_REFRESH_FAILED')]) assert.equal(isSafeMarketappRefreshStatus(invalid), false);
});

test('remount reconciliation restores a visible failure without wallet or authentication requests', async () => {
  let reads = 0;
  const h = setup({ getStatus: async () => { reads++; return status('failed', 'MARKETAPP_REFRESH_PAGE_CHANGED'); } });
  assert.equal(await h.controller.reconcile(), true);
  assert.deepEqual(h.controller.view, { phase: 'failed', periodDays: 30, failure: 'page_changed' });
  assert.equal(marketappAnalyticsRefreshFailure(h.controller.view.failure).code, 'MA-PAGE');
  assert.equal(reads, 1); assert.equal(h.starts, 0); assert.equal(h.finishes.length, 0); assert.equal(h.callbacks.length, 0);
});

test('saved reconciliation reloads once and does not infer an outcome from a legacy null attempt', async () => {
  const h = setup({ getStatus: async () => status('saved') });
  await h.controller.reconcile(); await h.controller.reconcile(); assert.equal(h.recovered, 1); assert.equal(h.controller.view.phase, 'saved');
  assert.equal(h.starts, 0); assert.equal(h.finishes.length, 0);
  const legacy = setup({ getStatus: async () => ({ attempt: null }) }); await legacy.controller.reconcile();
  assert.deepEqual(legacy.controller.view, { phase: 'idle' }); assert.equal(legacy.recovered, 0);
});

test('awaiting approval reconciliation keeps an active challenge and shows an interrupted remount without polling', async () => {
  const h = setup({ getStatus: async () => status('awaiting_approval') });
  await h.controller.start(30); h.controller.choose('synthetic'); await h.controller.reconcile();
  assert.equal(h.controller.view.phase, 'awaiting_approval'); assert.equal(h.controller.view.launchUrl, 'https://wallet.example/connect');
  assert.equal(h.callbacks[0].signal.aborted, false); assert.equal(h.closes, 0); assert.equal(h.finishes.length, 0);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false); h.controller.dispose();
  const reopened = setup({ getStatus: async () => status('awaiting_approval') }); await reopened.controller.reconcile();
  assert.deepEqual(reopened.controller.view, { phase: 'interrupted', periodDays: 30 }); assert.equal(reopened.timers.size, 0); assert.equal(reopened.starts, 0);
});

test('an updating marker is polled read-only until its terminal failure is visible', async () => {
  let reads = 0;
  const h = setup({ getStatus: async () => ++reads === 1 ? status('updating') : status('failed', 'MARKETAPP_REFRESH_AUTH_REJECTED') });
  await h.controller.reconcile(); assert.equal(h.controller.view.phase, 'confirming'); assert.equal(await h.controller.start(30), false);
  const poll = [...h.timers.entries()].find(([, timer]) => timer.delay === 5000)!; h.timers.delete(poll[0]); h.advance(5000); poll[1].callback(); await tick();
  assert.equal(h.controller.view.failure, 'auth_rejected'); assert.equal(reads, 2); assert.equal(h.starts, 0); assert.equal(h.finishes.length, 0);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
});

test('status errors, malformed responses and lost read replies cannot disappear silently', async () => {
  for (const getStatus of [async () => { throw new Error('Private cookie envelope proof'); }, async () => ({ attempt: { private: 'cookie' } })] as unknown as NonNullable<MarketappAnalyticsRefreshAdapter['getStatus']>[]) {
    const h = setup({ getStatus }); assert.equal(await h.controller.reconcile(), false); assert.equal(h.controller.view.failure, 'status_unavailable');
    assert.equal(JSON.stringify(h.views).includes('Private cookie'), false);
  }
  const pending = deferred<MarketappAnalyticsRefreshStatus>(), h = setup({ getStatus: () => pending.promise }); const reading = h.controller.reconcile();
  [...h.timers.values()].find(timer => timer.delay === 15000)!.callback(); assert.equal(h.controller.view.failure, 'status_unavailable');
  pending.resolve(status('saved')); await reading; assert.equal(h.recovered, 0); assert.equal(h.controller.view.failure, 'status_unavailable');
});

test('a dashboard reload rejection remains a visible saved-but-reload-needed result', async () => {
  const h = setup({}, undefined, async () => { throw new Error('Private dashboard transport details'); });
  await h.controller.start(30); h.callbacks[0].approved(account, proof, device); await tick(); await tick();
  assert.deepEqual(h.controller.view, { phase: 'saved', periodDays: 30, failure: 'reload_failed' });
  assert.equal(marketappAnalyticsRefreshFailure(h.controller.view.failure).code, 'MA-RELOAD');
  assert.equal(JSON.stringify(h.views).includes('Private dashboard'), false);
});

test('late status reads cannot overwrite a new explicit refresh and disposal stops recovery polling', async () => {
  const pending = deferred<MarketappAnalyticsRefreshStatus>(), h = setup({ getStatus: () => pending.promise }); const reading = h.controller.reconcile();
  await h.controller.start(365); pending.resolve(status('failed', 'MARKETAPP_REFRESH_FAILED')); await reading;
  assert.equal(h.controller.view.phase, 'choosing'); assert.equal(h.controller.view.periodDays, 365); assert.equal(h.callbacks[0].signal.aborted, false);
  h.controller.dispose();
  const recovery = setup({ getStatus: async () => status('updating') }); await recovery.controller.reconcile();
  const poll = [...recovery.timers.values()].find(timer => timer.delay === 5000)!.callback, count = recovery.views.length;
  recovery.controller.dispose(); poll(); await tick(); assert.equal(recovery.views.length, count); assert.equal(recovery.timers.size, 0);
});

test('recovery polling is bounded and an unresolved result stays visible for manual status checks', async () => {
  let reads = 0;
  const h = setup({ getStatus: async () => { reads++; return status('updating'); } });
  await h.controller.reconcile();
  for (;;) {
    const poll = [...h.timers.entries()].find(([, timer]) => timer.delay === 5000);
    if (!poll) break;
    h.timers.delete(poll[0]); h.advance(5000); poll[1].callback(); await tick();
  }
  assert.equal(reads, 24); assert.equal(h.controller.view.failure, 'result_unconfirmed');
  assert.equal(h.starts, 0); assert.equal(h.finishes.length, 0); assert.equal(h.callbacks.length, 0);
});

test('refresh challenges freeze period, wallet, provider identity and a bounded opaque envelope', () => {
  assert.equal(isSafeMarketappRefreshChallenge(challenge(), wallet, 30, now), true);
  for (const changed of [{ period_days: 365 }, { session_envelope: '' }, { session_envelope: 'abc' }, { session_envelope: 'z'.repeat(20) },
    { session_envelope: 'ab'.repeat(8251) }, { wallet: `0:${'34'.repeat(32)}` }, { manifest_url: 'https://unexpected.example/' }, { expires_at: new Date(now).toISOString() }]) {
    assert.equal(isSafeMarketappRefreshChallenge({ ...challenge(), ...changed }, wallet, 30, now), false);
  }
});

test('refresh result source and capture dates cannot alter the selected scope or reporting boundary', () => {
  const good = result();
  assert.equal(isSafeMarketappRefreshResult(good, challenge(), now), true);
  for (const url of [
    good.snapshot.source_url + '#', good.snapshot.source_url + '#private', good.snapshot.source_url + '&tab=analytics_rent',
    good.snapshot.source_url + '&collection=unrelated', good.snapshot.source_url.replace('group_by=day', 'group_by=month'),
    good.snapshot.source_url.replace('last30days', 'last365days'), good.snapshot.source_url.replace('tab=analytics_rent', 'tab=analytics_sale'),
    good.snapshot.source_url.replace('&group_by=day', ''),
  ]) assert.equal(isSafeMarketappRefreshResult({ ...good, snapshot: { ...good.snapshot, source_url: url } }, challenge(), now), false);
  for (const captured_at of [new Date(now - 1).toISOString(), new Date(now + 30001).toISOString(), '2026-01-01T12:00:00+00:00', '2026-01-01 12:00:00Z', '2026-02-30T12:00:00Z']) {
    assert.equal(isSafeMarketappRefreshResult({ ...good, snapshot: { ...good.snapshot, captured_at } }, challenge(), now), false);
  }
  const wrongDay = { ...good.snapshot, captured_at: '2026-01-02T00:00:00Z' };
  assert.equal(isSafeMarketappRefreshResult({ ...good, snapshot: wrongDay }, challenge(), Date.parse(wrongDay.captured_at)), false);
});

test('success requires exact true flags, matching attempt/wallet and the selected normalized reporting period', () => {
  for (const days of [30, 365] as const) assert.equal(isSafeMarketappRefreshResult(result(days), challenge(days)), true);
  const good = result();
  for (const invalid of [null, [], { ...good, attempt_id: 'c'.repeat(64) }, { ...good, authenticated: false }, { ...good, analytics_refreshed: false },
    { ...good, authenticated: 'true' }, { ...good, unexpected: 'private session data' }, { ...good, snapshot: null }, { ...good, snapshot: snapshot(365) },
    { ...good, snapshot: { ...good.snapshot, wallet: `0:${'34'.repeat(32)}` } }, { ...good, snapshot: { ...good.snapshot, period_start: '2026-99-99' } },
    { ...good, snapshot: { ...good.snapshot, source_url: 'https://unexpected.example/user/' + wallet + '/' } },
    { ...good, snapshot: { ...good.snapshot, summary: { ...good.snapshot.summary, rentals: 0 } } },
    { ...good, snapshot: { ...good.snapshot, daily: [...good.snapshot.daily].reverse() } }]) {
    assert.equal(isSafeMarketappRefreshResult(invalid, challenge()), false);
  }
});

test('refresh starts only on explicit action and submits one full approval before reloading once', async () => {
  const h = setup(); assert.equal(h.starts, 0);
  const starting = h.controller.start(365); assert.equal(await h.controller.start(30), false); assert.equal(await starting, true);
  assert.equal(h.controller.view.periodDays, 365); assert.equal(h.controller.choose('synthetic'), 'https://wallet.example/connect');
  assert.equal(h.controller.choose('synthetic'), null); assert.equal(h.connects, 1);
  h.callbacks[0].approved(account, proof, device); h.callbacks[0].approved(account, proof, device); await tick();
  assert.deepEqual(h.controller.view, { phase: 'saved', periodDays: 365 }); assert.equal(h.finishes.length, 1); assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].daily.length, 365); assert.equal(h.closes, 1); assert.deepEqual(h.cancelled, []);
  const visible = JSON.stringify(h.views);
  for (const secret of [challenge().session_envelope, proof.payload, proof.signature, account.walletStateInit, account.publicKey, device.appName]) assert.equal(visible.includes(secret), false);
});

test('missing public account evidence, wrong account and testnet approval never reach provider login', async () => {
  for (const [approvedAccount, approvedDevice, reason] of [
    [{ ...account, walletStateInit: undefined }, device, 'account_data_missing'], [account, undefined, 'account_data_missing'],
    [{ ...account, publicKey: 'not-a-public-key' }, device, 'account_data_missing'], [{ ...account, publicKey: undefined }, device, 'account_data_missing'],
    [{ ...account, address: `0:${'34'.repeat(32)}` }, device, 'account_mismatch'], [{ ...account, chain: '-3' }, device, 'wrong_network'],
  ] as const) {
    const h = setup(); await h.controller.start(30); h.callbacks[0].approved(approvedAccount, proof, approvedDevice); await tick();
    assert.equal(h.controller.view.failure, reason); assert.equal(h.finishes.length, 0); assert.equal(h.saved.length, 0); assert.equal(h.closes, 1);
  }
});

test('safe backend errors preserve previous analytics and never reflect provider text', async () => {
  const failures = [
    ['MARKETAPP_REFRESH_FAILED', 'update_failed'], ['MARKETAPP_REFRESH_RATE_LIMIT', 'rate_limited'], ['MARKETAPP_REFRESH_EXPIRED', 'expired'],
    ['MARKETAPP_REFRESH_INVALID_INPUT', 'invalid_input'], ['MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED', 'access_denied'],
    ['MARKETAPP_REFRESH_WALLET_REQUIRED', 'wallet_required'], ['MARKETAPP_REFRESH_AUTH_REJECTED', 'auth_rejected'], ['MARKETAPP_REFRESH_PAGE_CHANGED', 'page_changed'],
  ] as const;
  for (const [code, reason] of failures) {
    const h = setup({ finish: async () => { throw { code, message: 'Private cookies nonce signature state-init' }; } });
    await h.controller.start(30); h.callbacks[0].approved(account, proof, device); await tick();
    assert.equal(h.controller.view.failure, reason); assert.equal(h.saved.length, 0); assert.equal(h.closes, 1);
    assert.equal(JSON.stringify(h.views).includes('Private cookies'), false); assert.equal(marketappAnalyticsRefreshFailure(reason).message.includes('Private cookies'), false);
  }
});

test('server rate duration drives a local countdown despite a different absolute server clock', async () => {
  let requests = 0;
  const serverError = new CloudError('MARKETAPP_REFRESH_RATE_LIMIT', 'Fixed rate limit', { retry_at: '2030-01-01T12:00:42.000Z', retry_after_seconds: 42, reason: 'hourly' });
  const h = setup({ start: async () => { requests++; throw serverError; } });
  await h.controller.start(30);
  assert.deepEqual(h.controller.view.rateLimit, { deadline: now + 42000, remainingSeconds: 42, reason: 'hourly' });
  assert.equal(marketappRefreshRetryText(h.controller.view.rateLimit!.remainingSeconds), 'Try again in 42s');
  assert.equal(await h.controller.start(365), false); assert.equal(requests, 1);
  const tickLimit = () => { const timer = [...h.timers.entries()].find(([, value]) => value.delay <= 1000)!; h.timers.delete(timer[0]); timer[1].callback(); };
  h.advance(1000); tickLimit(); assert.equal(h.controller.view.rateLimit!.remainingSeconds, 41);
  h.advance(41000); tickLimit(); assert.deepEqual(h.controller.view, { phase: 'ready', periodDays: 30 });
  assert.equal(requests, 1); assert.equal(h.callbacks.length, 0); assert.equal(h.saved.length, 0);
  assert.equal(await h.controller.start(365), false); assert.equal(requests, 2, 'only the explicit action sends the next request');
  h.controller.dispose();
});

test('cooldown and missing metadata use clear distinct states; disposal suppresses late countdowns', async () => {
  const h = setup({ start: async () => { throw new CloudError('MARKETAPP_REFRESH_RATE_LIMIT', 'Fixed', { retry_at: '2026-01-01T12:01:00Z', retry_after_seconds: 60, reason: 'cooldown' }); } });
  await h.controller.start(30); assert.equal(h.controller.view.rateLimit!.reason, 'cooldown');
  assert.equal(marketappRefreshRetryText(60), 'Try again in ~1m'); assert.equal(marketappRefreshRetryText(61), 'Try again in ~2m');
  const callback = [...h.timers.values()][0].callback, count = h.views.length;
  h.controller.dispose(); h.advance(60000); callback(); assert.equal(h.views.length, count); assert.equal(h.timers.size, 0);
  const fallback = setup({ start: async () => { throw { code: 'MARKETAPP_REFRESH_RATE_LIMIT', retryAfterSeconds: 60, retryAt: 'private text', limitReason: 'hourly' }; } });
  await fallback.controller.start(30); assert.equal(fallback.controller.view.failure, 'rate_limited'); assert.equal(fallback.controller.view.rateLimit, undefined);
  assert.equal(JSON.stringify(fallback.views).includes('private text'), false);
});

test('invalid successful response never reports saved or reloads the dashboard', async () => {
  const h = setup({ finish: async () => ({ ...result(), authenticated: false }) as unknown as MarketappAnalyticsRefreshResult });
  await h.controller.start(30); h.callbacks[0].approved(account, proof, device); await tick();
  assert.equal(h.controller.view.failure, 'invalid_response'); assert.equal(h.saved.length, 0); assert.equal(h.closes, 1);
});

test('cancel, wallet decline and unmount abort only the disposable refresh', async () => {
  const h = setup(); await h.controller.start(30); h.controller.cancel(); await tick();
  assert.equal(h.controller.view.phase, 'cancelled'); assert.equal(h.callbacks[0].signal.aborted, true); assert.equal(h.closes, 1);
  h.callbacks[0].approved(account, proof, device); await tick(); assert.equal(h.finishes.length, 0);
  await h.controller.start(30); h.callbacks[1].ended('cancelled'); await tick(); assert.equal(h.controller.view.phase, 'cancelled');
  await h.controller.start(30); const count = h.views.length; h.controller.dispose(); h.callbacks[2].approved(account, proof, device); await tick();
  assert.equal(h.views.length, count); assert.equal(h.finishes.length, 0); assert.equal(await h.controller.start(30), false);
});

test('late start and finish responses never overwrite a new refresh or trigger a stale reload', async () => {
  const pendingStart = deferred<MarketappAnalyticsRefreshChallenge>(), first = setup({ start: () => pendingStart.promise });
  const started = first.controller.start(30); first.controller.dispose(); const views = first.views.length;
  pendingStart.resolve(challenge()); await started; await tick(); assert.equal(first.views.length, views); assert.deepEqual(first.cancelled, [id]);
  const pendingFinish = deferred<MarketappAnalyticsRefreshResult>(), h = setup({ finish: () => pendingFinish.promise });
  await h.controller.start(30); h.callbacks[0].approved(account, proof, device); h.controller.cancel(); await h.controller.start(365);
  pendingFinish.resolve(result()); h.callbacks[0].ended('failed', 'wallet_error'); await tick();
  assert.equal(h.controller.view.phase, 'choosing'); assert.equal(h.controller.view.periodDays, 365); assert.equal(h.saved.length, 0); assert.equal(h.callbacks[1].signal.aborted, false);
  h.controller.dispose();
});

test('expiry stops unapproved work while the submitted refresh receives its own bounded 120-second deadline', async () => {
  const expired = setup(); await expired.controller.start(30); [...expired.timers.values()].find(timer => timer.delay === 300000)!.callback(); await tick();
  assert.equal(expired.controller.view.phase, 'expired'); assert.equal(expired.finishes.length, 0); assert.equal(expired.closes, 1);
  const pending = deferred<MarketappAnalyticsRefreshResult>(), h = setup({ finish: () => pending.promise });
  await h.controller.start(30); h.callbacks[0].approved(account, proof, device);
  assert.equal(h.controller.view.phase, 'updating'); assert.equal([...h.timers.values()].some(timer => timer.delay === 300000), false);
  [...h.timers.values()].find(timer => timer.delay === 120000)!.callback(); await tick();
  assert.equal(h.controller.view.failure, 'updating_timeout'); assert.equal(h.closes, 1); assert.equal(h.callbacks[0].signal.aborted, true);
  pending.resolve(result()); await tick(); assert.equal(h.saved.length, 0); assert.equal(h.finishes.length, 0); // Override tracks the one pending call separately.
});

test('invalid preparation, empty chooser and proof-missing paths release state without importing', async () => {
  const invalid = setup({ start: async () => ({ ...challenge(), session_envelope: 'not-an-envelope' }) });
  await invalid.controller.start(30); assert.equal(invalid.controller.view.failure, 'invalid_challenge'); assert.equal(invalid.callbacks.length, 0);
  const empty = setup({}, async () => ({ options: [], connect: () => null, async close() {} }));
  await empty.controller.start(30); assert.equal(empty.controller.view.failure, 'chooser_unavailable'); assert.equal(empty.saved.length, 0);
  const missing = setup(); await missing.controller.start(30); missing.callbacks[0].ended('failed', 'proof_missing'); await tick();
  assert.equal(missing.controller.view.failure, 'proof_missing'); assert.equal(missing.finishes.length, 0);
});

test('StrictMode cleanup permits a fresh effect-owned controller and desktop has no refresh adapter', async () => {
  const first = setup(); first.controller.dispose(); assert.equal(await first.controller.start(30), false);
  const second = setup(); await second.controller.start(30); second.callbacks[0].approved(account, proof, device); await tick();
  assert.equal(second.controller.view.phase, 'saved'); assert.equal(first.starts, 0);
  assert.equal(createLocalDashboardAdapter().marketappAnalyticsRefresh, undefined);
});

test('cloud refresh adapter sends only selected period, explicit evidence and opaque envelope to its own routes', async () => {
  const calls: { endpoint: CloudEndpoint; input: Record<string, unknown> }[] = [];
  const adapter = createCloudDashboardAdapter({ async call<T>(endpoint: CloudEndpoint, input: Record<string, unknown> = {}) {
    calls.push({ endpoint, input }); return (endpoint === 'startMarketappAnalyticsRefresh' ? challenge(365) : endpoint === 'finishMarketappAnalyticsRefresh' ? result(365) : endpoint === 'getMarketappAnalyticsRefreshStatus' ? { attempt: null } : { cancelled: true }) as T;
  } });
  assert.equal(calls.length, 0);
  const issued = await adapter.marketappAnalyticsRefresh!.start(365);
  await adapter.marketappAnalyticsRefresh!.finish(issued, { ...account, extra: 'discard' } as typeof account, proof, { ...device, extra: 'discard' } as typeof device);
  await adapter.marketappAnalyticsRefresh!.cancel(id);
  assert.deepEqual(await adapter.marketappAnalyticsRefresh!.getStatus!(), { attempt: null });
  assert.deepEqual(calls.map(call => call.endpoint), ['startMarketappAnalyticsRefresh', 'finishMarketappAnalyticsRefresh', 'cancelMarketappAnalyticsRefresh', 'getMarketappAnalyticsRefreshStatus']);
  assert.deepEqual(calls[0].input, { period_days: 365 });
  assert.deepEqual(Object.keys(calls[1].input).sort(), ['account', 'attempt_id', 'device', 'proof', 'session_envelope']);
  assert.deepEqual(calls[1].input.account, account); assert.deepEqual(calls[1].input.device, device);
  assert.deepEqual(calls[2].input, { attempt_id: id });
  assert.deepEqual(calls[3].input, {});
});
