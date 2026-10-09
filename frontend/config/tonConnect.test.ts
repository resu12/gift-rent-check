import test from 'node:test';
import assert from 'node:assert/strict';
import {tonConnectBuild} from './tonConnect.ts';

test('portable builds keep TON Connect disabled without a public app origin', () => {
  assert.equal(tonConnectBuild({}), null);
  assert.equal(tonConnectBuild({VITE_TONCONNECT_APP_URL: ''}), null);
});

test('configured builds produce a public manifest and optional Telegram return link', () => {
  const expected = {
    config: {manifestUrl: 'https://app12345.tgcloud.ai/tonconnect-manifest.json', returnUrl: 'https://t.me/example_bot?startapp'},
    manifest: {url: 'https://app12345.tgcloud.ai', name: 'Gift Rent Check', iconUrl: 'https://app12345.tgcloud.ai/wallet-icon.png'},
  };
  for (const origin of ['https://app12345.tgcloud.ai', 'https://app12345.tgcloud.ai/']) {
    assert.deepEqual(tonConnectBuild({VITE_TONCONNECT_APP_URL: origin, VITE_TELEGRAM_RETURN_URL: 'https://t.me/example_bot?startapp'}), expected);
  }
  assert.deepEqual(tonConnectBuild({VITE_TONCONNECT_APP_URL: 'https://example.org'})?.config, {manifestUrl: 'https://example.org/tonconnect-manifest.json'});
});

test('manifest origins cannot include credentials, redirects, non-HTTPS URLs, or app paths', () => {
  for (const origin of ['http://example.org', 'https://secret@example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org/?q=x', 'https://example.org/#x', '//example.org', 'not a URL', ' https://example.org', 'https://example.org\\path']) {
    assert.throws(() => tonConnectBuild({VITE_TONCONNECT_APP_URL: origin}), /VITE_TONCONNECT_APP_URL/);
  }
});

test('Telegram return links reject arbitrary sites, extra parameters and malformed bot links', () => {
  const env = {VITE_TONCONNECT_APP_URL: 'https://example.org'};
  for (const returnUrl of ['http://t.me/example_bot?startapp', 'https://other.invalid/example_bot?startapp', 'https://t.me.evil.invalid/example_bot?startapp', 'https://secret@t.me/example_bot?startapp', 'https://t.me:444/example_bot?startapp', 'https://t.me/example_bot', 'https://t.me/example_bot?startapp&url=evil', 'https://t.me/example_bot?startapp=x&startapp=y', 'https://t.me/example_bot?startapp#x', 'https://t.me/example_bot/path?startapp', 'https://t.me/example_user?startapp', 'https://t.me/example_bot?startapp=https://elsewhere.invalid', ' https://t.me/example_bot?startapp']) {
    assert.throws(() => tonConnectBuild({...env, VITE_TELEGRAM_RETURN_URL: returnUrl}), /VITE_TELEGRAM_RETURN_URL/);
  }
  assert.equal(tonConnectBuild({...env, VITE_TELEGRAM_RETURN_URL: 'https://t.me/example_bot?startapp=pricing_v1-2'})?.config.returnUrl, 'https://t.me/example_bot?startapp=pricing_v1-2');
});
