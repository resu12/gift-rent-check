import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTonConnectSdkLogging} from './tonConnectPrivacy.ts';

const sdkPath = '/node_modules/@tonconnect/sdk/lib/esm/index.mjs';
const source = `const tonConnectSdkVersion = "4.0.2";
function logDebug(...args) {console.debug('[TON_CONNECT_SDK]', ...args);}
export function receive(walletMessage) {
  logDebug('Wallet message received:', walletMessage);
  console.error(walletMessage); console.warn(walletMessage);
  return walletMessage.proof;
}`;

test('SDK diagnostics are removed while wallet-proof handling and exports survive', async () => {
  const result = await stripTonConnectSdkLogging(source, sdkPath);
  assert.ok(result);
  assert.doesNotMatch(result.code, /console|TON_CONNECT_SDK/);
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString('base64')}`);
  const proof = {signature: 'synthetic-sensitive-value'};
  assert.equal(module.receive({proof}), proof);
  assert.ok(await stripTonConnectSdkLogging(source, sdkPath.replaceAll('/', '\\') + '?v=1'));
});

test('only the reviewed SDK entry is transformed; SDK upgrades fail closed', async () => {
  assert.equal(await stripTonConnectSdkLogging('console.error("app");', '/src/App.tsx'), null);
  for (const changed of [source.replace('4.0.2', '4.0.3'), source.replace('Wallet message received:', 'Changed diagnostics:')]) {
    await assert.rejects(stripTonConnectSdkLogging(changed, sdkPath), /SDK changed/);
  }
});

test('installed pinned SDK has no console diagnostics after the production transform', async () => {
  const installed = await readFile(new URL('../node_modules/@tonconnect/sdk/lib/esm/index.mjs', import.meta.url), 'utf8');
  const result = await stripTonConnectSdkLogging(installed, sdkPath);
  assert.ok(result);
  assert.doesNotMatch(result.code, /\bconsole\s*(?:\.|\[)/);
  assert.match(result.code, /manifestUrl/);
  assert.match(result.code, /ton_proof/);
  assert.match(result.code, /export\s*\{/);
});
