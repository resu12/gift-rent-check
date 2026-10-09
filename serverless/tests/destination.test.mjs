import test from 'node:test';
import assert from 'node:assert/strict';
import {option, requireId, validateAuthenticatedDestination} from '../tools/destination.mjs';

test('administrative IDs are explicit positive decimal safe integers', () => {
  assert.equal(requireId('54321', '--app-id'), '54321');
  assert.equal(requireId('12345', '--owner-id'), '12345');
  for (const value of [null, undefined, '', '0', '-1', '01', '54321 ', '54321\n', '1.5', '1e3', '9007199254740992', 54321]) {
    assert.throws(() => requireId(value, '--app-id'));
  }
});

test('value flags reject missing or duplicate arguments', () => {
  assert.equal(option(['--app-id', '54321'], '--app-id'), '54321');
  assert.equal(option([], '--app-id'), null);
  assert.throws(() => option(['--app-id'], '--app-id'));
  assert.throws(() => option(['--app-id', '--owner-id', '12345'], '--app-id'));
  assert.throws(() => option(['--app-id', '54321', '--app-id', '65432'], '--app-id'));
});

test('app authentication requires an exact complete token and official production endpoint', () => {
  const valid = 'app54321:synthetic_secret';
  validateAuthenticatedDestination(valid, '54321', {});
  validateAuthenticatedDestination(valid, '54321', {TG_CLOUD_API_URL: 'https://cloud.telegram.org', TGCLOUD_BETA: '0'});
  for (const token of [undefined, null, '', 'app65432:synthetic', 'app54321:', 'app054321:synthetic', 'app54321:synthetic:extra', 'prefix-app54321:synthetic', valid + '\n']) {
    assert.throws(() => validateAuthenticatedDestination(token, '54321', {}));
  }
  assert.throws(() => validateAuthenticatedDestination(valid, '54321', {TG_CLOUD_API_URL: 'https://cloud.telegram.org.evil.test'}));
  assert.throws(() => validateAuthenticatedDestination(valid, '54321', {TGCLOUD_BETA: '1'}));
});
