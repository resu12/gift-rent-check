import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldUsePublicAccount} from '../tgcloud/lib/public-routing.js';
import {portableModules} from './fixtures/portable-modules.mjs';

const context = id => ({initData: {user: {id}}});
const hybrid = {enabled: true, preservePrivateOwner: true};

test('disabled public mode keeps the owner-gated private routes', () => {
  for (const config of [undefined, {}, {enabled: false}, {enabled: false, preservePrivateOwner: true}]) {
    for (const ctx of [undefined, context(12345), context(67890)]) {
      assert.equal(shouldUsePublicAccount(config, 12345, ctx), false);
    }
  }
});

test('global public mode keeps its existing routing for every caller', () => {
  for (const config of [{enabled: true}, {enabled: true, preservePrivateOwner: false}]) {
    for (const ctx of [undefined, context(12345), context(67890)]) {
      assert.equal(shouldUsePublicAccount(config, 12345, ctx), true);
    }
  }
});

test('hybrid mode preserves the exact verified owner for numeric and string IDs', () => {
  for (const owner of [12345, '12345', 678900002, '678900002', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(shouldUsePublicAccount(hybrid, owner, context(Number(owner))), false);
    assert.equal(shouldUsePublicAccount(hybrid, owner, context(String(owner))), false);
    assert.equal(shouldUsePublicAccount(hybrid, owner, context(67890)), true);
  }
});

test('missing, malformed, unsafe, or client-supplied identities enter public authorization', () => {
  const malformed = [undefined, null, '', '0', 0, -1, 123.45, NaN, Infinity, '012345', ' 12345', '12345 ', '1e4', '9007199254740992', 9007199254740992, true, {}, {toString: () => '12345'}];
  for (const id of malformed) {
    assert.equal(shouldUsePublicAccount(hybrid, 12345, context(id)), true);
    assert.equal(shouldUsePublicAccount(hybrid, id, context(12345)), true);
    assert.equal(shouldUsePublicAccount(hybrid, id, context(id)), true);
  }
  for (const ctx of [undefined, {}, {user: {id: 12345}}, {input: {user_id: 12345}}, {initData: {user_id: 12345}}]) {
    assert.equal(shouldUsePublicAccount(hybrid, 12345, ctx), true);
  }
});

test('routing works in the deployed bare V8 module environment', () => {
  const route = portableModules().load('public-routing.js').shouldUsePublicAccount;
  assert.equal(route(hybrid, 12345, context('12345')), false);
  assert.equal(route(hybrid, 12345, context(67890)), true);
  assert.equal(route(hybrid, null, context(12345)), true);
});
