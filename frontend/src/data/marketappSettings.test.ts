import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDashboardAdapter } from './local.ts';
import { localCollectionBlocker } from './marketappSettings.ts';
import type { Capabilities } from './types.ts';

const endpoint = '/api/settings/marketapp';
const secret = 'marketapp-secret-DO-NOT-ECHO?token=private&scope=all';
const status = {
  configured: true,
  source: 'session' as const,
  persistent_storage_available: false,
  network_enabled: true,
  can_manage: true,
  restart_required: false,
};

type RequestCall = { path: string; init: RequestInit };

function settings() {
  const adapter = createLocalDashboardAdapter();
  assert.ok(adapter.marketappSettings, 'The local adapter exposes Marketapp settings.');
  return adapter.marketappSettings;
}

function mockRequests(context: TestContext, respond: (call: RequestCall) => Response | Promise<Response>) {
  const calls: RequestCall[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit = {}) => {
    const call = { path, init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

async function sanitizedFailure(operation: Promise<unknown>): Promise<string> {
  let message = '';
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.trim(), 'A failure includes a useful fixed message.');
    assert.equal(error.message.includes(secret), false);
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(String(error.cause ?? '').includes(secret), false);
    message = error.message;
    return true;
  });
  return message;
}

test('Marketapp status reads use the fixed local endpoint and preserve the caller abort signal', async context => {
  const calls = mockRequests(context, () => new Response(JSON.stringify(status)));
  const controller = new AbortController();
  assert.deepEqual(await settings().get(controller.signal), status);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, endpoint);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false);
});

test('every supported Marketapp source returns only status fields', async context => {
  let response: Record<string, unknown> = status;
  const calls = mockRequests(context, () => new Response(JSON.stringify(response)));
  const capability = settings();
  for (const source of ['environment', 'secure_store', 'session', 'none'] as const) {
    const expected = {
      ...status,
      configured: source !== 'none',
      source,
      can_manage: source !== 'environment',
      persistent_storage_available: source === 'secure_store',
      network_enabled: source !== 'none',
    };
    response = { ...expected, api_key: secret, token: secret, debug: { authorization: secret } };
    const result = await capability.get();
    assert.deepEqual(result, expected);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(calls.length, 4);
});

test('save and remove send CSRF once and keep the key only in the POST JSON body', async context => {
  const calls = mockRequests(context, () => new Response(JSON.stringify({ ...status, api_key: secret })));
  const capability = settings();
  assert.deepEqual(await capability.save(secret, false, 'save-session-csrf'), status);
  assert.deepEqual(await capability.save(secret, true, 'save-persistent-csrf'), status);
  assert.deepEqual(await capability.remove('remove-csrf'), status);
  assert.deepEqual(calls.map(({ path, init }) => [path, init.method, init.credentials, init.cache]), [
    [endpoint, 'POST', 'same-origin', 'no-store'],
    [endpoint, 'POST', 'same-origin', 'no-store'],
    [endpoint, 'DELETE', 'same-origin', 'no-store'],
  ]);
  assert.deepEqual(calls.map(({ init }) => new Headers(init.headers).get('X-Dashboard-CSRF')),
    ['save-session-csrf', 'save-persistent-csrf', 'remove-csrf']);
  assert.deepEqual(calls.slice(0, 2).map(({ init }) => JSON.parse(String(init.body))), [
    { api_key: secret, persist: false },
    { api_key: secret, persist: true },
  ]);
  assert.ok(calls.slice(0, 2).every(({ init }) => new Headers(init.headers).get('Content-Type') === 'application/json'));
  for (const { path, init } of calls) {
    assert.equal(path.includes(secret), false);
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.equal(JSON.stringify([...new Headers(init.headers)]).includes(secret), false);
  }
  assert.equal(calls[2].init.body, undefined);
});

test('settings mutations require CSRF before sending the key or deleting configuration', async context => {
  const calls = mockRequests(context, () => new Response(JSON.stringify(status)));
  const capability = settings();
  await sanitizedFailure(capability.save(secret, false, ''));
  await sanitizedFailure(capability.remove(''));
  assert.equal(calls.length, 0);
});

test('only known status reason codes survive and arbitrary reason text is discarded', async context => {
  let reason: unknown;
  const calls = mockRequests(context, () => new Response(JSON.stringify({ ...status, reason })));
  const capability = settings();
  for (reason of ['external_configuration', 'active_job', 'secure_store_unavailable']) {
    assert.deepEqual(await capability.get(), { ...status, reason });
  }
  for (reason of [secret, '', null, 1, { message: secret }]) {
    assert.deepEqual(await capability.get(), status);
  }
  assert.equal(calls.length, 8);
});

test('malformed successful status responses fail safely without coercing flags or sources', async context => {
  let body: unknown;
  const calls = mockRequests(context, () => new Response(JSON.stringify(body)));
  const capability = settings();
  const malformed: unknown[] = [null, [], {}, secret,
    { ...status, configured: 'true' },
    { ...status, source: secret },
    { ...status, persistent_storage_available: 1 },
    { ...status, network_enabled: 'false' },
    { ...status, can_manage: null },
    { ...status, restart_required: 'false' },
    ...Object.keys(status).map(key => ({ ...status, [key]: undefined })),
  ];
  const messages: string[] = [];
  for (body of malformed) messages.push(await sanitizedFailure(capability.get()));
  assert.equal(new Set(messages).size, 1, 'Invalid payloads use a fixed failure message.');
  assert.equal(calls.length, malformed.length);
});

test('invalid JSON cannot expose the response text or repeat a settings mutation', async context => {
  const calls = mockRequests(context, () => new Response(`not JSON: ${secret}`));
  const capability = settings();
  await sanitizedFailure(capability.get());
  await sanitizedFailure(capability.save(secret, false, 'csrf'));
  await sanitizedFailure(capability.remove('csrf'));
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'POST', 'DELETE']);
});

test('provider error bodies are ignored and failed settings mutations are never resubmitted', async context => {
  let responseBody = '';
  let responseStatus = 403;
  const responses: Response[] = [];
  const calls = mockRequests(context, () => {
    const response = new Response(responseBody, { status: responseStatus });
    responses.push(response);
    return response;
  });
  const capability = settings();
  for (responseStatus of [403, 409, 413, 422, 503]) {
    for (const operation of [
      () => capability.get(),
      () => capability.save(secret, false, 'csrf'),
      () => capability.remove('csrf'),
    ]) {
      const previousCalls = calls.length;
      responseBody = JSON.stringify({ detail: secret, error: secret, api_key: secret });
      const first = await sanitizedFailure(operation());
      assert.equal(calls.length, previousCalls + 1);
      responseBody = 'a different upstream error';
      const second = await sanitizedFailure(operation());
      assert.equal(calls.length, previousCalls + 2);
      assert.equal(first, second, 'The failure message is independent of provider text.');
    }
  }
  assert.deepEqual(calls.map(({ init }) => init.method),
    Array.from({ length: 5 }, () => ['GET', 'GET', 'POST', 'POST', 'DELETE', 'DELETE']).flat());
  assert.ok(responses.every(response => !response.bodyUsed), 'Provider failure bodies are not read.');
});

test('network errors are replaced with fixed safe errors and never trigger a mutation retry', async context => {
  let networkMessage = secret;
  const calls = mockRequests(context, () => { throw new TypeError(networkMessage); });
  const capability = settings();
  for (const operation of [
    () => capability.get(),
    () => capability.save(secret, true, 'csrf'),
    () => capability.remove('csrf'),
  ]) {
    networkMessage = secret;
    const first = await sanitizedFailure(operation());
    networkMessage = 'different raw network details';
    const second = await sanitizedFailure(operation());
    assert.equal(first, second, 'The failure message is independent of raw network details.');
  }
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'GET', 'POST', 'POST', 'DELETE', 'DELETE']);
});

const configuredCapabilities: Capabilities = {
  network_enabled: true,
  marketapp_configured: true,
  ton_configured: true,
  wallet_configured: true,
  csrf_token: 'local-csrf',
};

test('a paused collection with a missing Marketapp key offers key setup with network on or off', () => {
  for (const network_enabled of [true, false]) {
    const blocker = localCollectionBlocker({ ...configuredCapabilities, marketapp_configured: false, network_enabled });
    assert.ok(blocker);
    assert.equal(blocker.setup, true);
    assert.match(blocker.message, /Marketapp API key/);
    if (!network_enabled) assert.match(blocker.message, /restart.*--allow-network/i);
  }
});

test('a configured key with collection networking off calls for a service restart', () => {
  const blocker = localCollectionBlocker({ ...configuredCapabilities, network_enabled: false });
  assert.ok(blocker);
  assert.equal(blocker.setup, false);
  assert.match(blocker.message, /restart.*--allow-network/i);
});

test('collection with a key and networking still explains a missing wallet', () => {
  const blocker = localCollectionBlocker({ ...configuredCapabilities, wallet_configured: false });
  assert.ok(blocker);
  assert.equal(blocker.setup, false);
  assert.match(blocker.message, /wallet address/i);
});

test('complete and absent collection capabilities do not show a settings blocker', () => {
  assert.equal(localCollectionBlocker(configuredCapabilities), null);
  assert.equal(localCollectionBlocker(undefined), null);
});
