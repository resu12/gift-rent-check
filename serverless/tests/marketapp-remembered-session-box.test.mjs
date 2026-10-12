import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createMarketappRememberedSessionBox} from '../tgcloud/lib/marketapp-remembered-session-box.js';
import {createMarketappSessionBox} from '../tgcloud/lib/marketapp-session-box.js';
import {secretbox} from '../tgcloud/lib/vendor/tweetnacl-secretbox.js';

const master = '12'.repeat(32), wallet = `0:${'11'.repeat(32)}`;
const payload = {version: 1, owner: '12345', wallet, generation: 0, wallet_revision: 9, cookie_version: 1,
  created_at: 1791547200000, expires_at: 1791633600000, cookie: 'session=synthetic-remembered-cookie'};
const PURPOSE = 'marketapp-remembered-session-box-v1';
const derivedKey = createHash('sha256').update(Buffer.concat([Buffer.from(`${PURPOSE}\0key\0`), Buffer.from(master, 'hex')])).digest();
const nonce = value => createHash('sha256').update(`${PURPOSE}\0${value.owner}\0${value.wallet}\0${value.cookie_version}`).digest().subarray(0, 24);
function authenticatedFixture(value, chosenNonce = nonce(value)) {
  return `02${chosenNonce.toString('hex')}${Buffer.from(secretbox(Buffer.from(JSON.stringify(value)), chosenNonce, derivedKey)).toString('hex')}`;
}

test('remembered cookie encrypts under a separate key and nonce purpose with exact payload binding', () => {
  const box = createMarketappRememberedSessionBox(master), envelope = box.seal(payload, 1), bytes = Buffer.from(envelope, 'hex');
  assert.deepEqual(box.open(envelope), payload);
  assert.equal(envelope.includes(payload.cookie), false);
  assert.equal(bytes[0], 2); assert.deepEqual(bytes.subarray(1, 25), nonce(payload));
  assert.deepEqual(Buffer.from(secretbox.open(bytes.subarray(25), bytes.subarray(1, 25), derivedKey)), Buffer.from(JSON.stringify(payload)));
  assert.equal(secretbox.open(bytes.subarray(25), bytes.subarray(1, 25), Buffer.from(master, 'hex')), null);
  assert.throws(() => createMarketappSessionBox(master).open(envelope));
  const old = createMarketappSessionBox(master).seal({attempt_id: 'a'.repeat(64), challenge: 'synthetic-challenge', cookie: payload.cookie});
  assert.throws(() => box.open(old));
});

test('each reserved counter changes the nonce, including cookie rotations, epoch changes and owner/wallet scopes', () => {
  const box = createMarketappRememberedSessionBox(master), first = box.seal(payload, 1);
  for (const value of [
    {...payload, cookie_version: 2, cookie: 'session=synthetic-rotated-cookie'},
    {...payload, cookie_version: 3, generation: 1},
    {...payload, cookie_version: 4, wallet_revision: 10},
    {...payload, owner: '67890'},
    {...payload, wallet: `-1:${'22'.repeat(32)}`},
  ]) {
    const envelope = box.seal(value, value.cookie_version);
    assert.notEqual(envelope.slice(2, 50), first.slice(2, 50)); assert.deepEqual(box.open(envelope), value);
  }
  for (const counter of [undefined, null, 0, -1, 2, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => box.seal(payload, counter));
});

test('tampering, nonce rebinding, wrong keys, malformed payloads and unsupported envelopes are rejected', () => {
  const box = createMarketappRememberedSessionBox(master), envelope = box.seal(payload, 1);
  for (const invalid of [envelope.slice(0, -2), envelope.slice(0, -2) + 'ff', envelope.slice(0, 20) + 'ff' + envelope.slice(22),
    '01' + envelope.slice(2), envelope.toUpperCase(), '00'.repeat(9000), '', null]) assert.throws(() => box.open(invalid));
  assert.throws(() => createMarketappRememberedSessionBox('13'.repeat(32)).open(envelope));
  assert.throws(() => box.open(authenticatedFixture(payload, Buffer.alloc(24, 1))));
  assert.throws(() => box.open(authenticatedFixture({...payload, cookie_version: 2}, nonce(payload))));
  for (const edit of [{version: 2}, {owner: '0'}, {owner: '12x'}, {wallet: `0:${'AA'.repeat(32)}`},
    {wallet: `1:${'11'.repeat(32)}`}, {generation: -1}, {wallet_revision: 1.5}, {cookie_version: 0},
    {created_at: 0}, {expires_at: payload.created_at}, {expires_at: Number.MAX_SAFE_INTEGER},
    {cookie: 'session=synthetic-cookie;other=x'}, {cookie: 'session='}, {cookie: 'session=é'},
    {cookie: `session=${'a'.repeat(4097)}`}, {proof: 'synthetic-proof'}, {challenge: 'synthetic-challenge'}]) {
    const value = {...payload, ...edit};
    assert.throws(() => box.seal(value, value.cookie_version)); assert.throws(() => box.open(authenticatedFixture(value)));
  }
  for (const invalid of [null, [], {}, {...payload, owner: undefined}]) assert.throws(() => box.seal(invalid, 1));
  for (const key of ['', '00', 'AA'.repeat(32), '00'.repeat(33)]) assert.throws(() => createMarketappRememberedSessionBox(key));
});

test('fixed error messages never reveal a session or arbitrary provider input', () => {
  const box = createMarketappRememberedSessionBox(master), secret = 'synthetic-provider-private-value';
  for (const action of [() => box.open(secret), () => box.seal({...payload, cookie: `session=${secret};extra=x`}, 1)]) {
    assert.throws(action, error => error.message === 'Invalid remembered Marketapp session' && !error.message.includes(secret));
  }
});
