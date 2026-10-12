import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createPublicCredentialBox, hex, hmacSha256, validMarketappApiKey} from '../tgcloud/lib/public-credential-box.js';
const key = '12'.repeat(32), token = 'test-private-key-123456';
const payload = {version:1,user_id:'42',provider:'marketapp',account_generation:1,credential_generation:0,counter:1,api_key:token};
test('HMAC matches independent Node crypto for short, long and binary keys', () => {
  for (const length of [0, 20, 64, 131]) {
    const secret = new Uint8Array(length).fill(0xaa), message = new TextEncoder().encode('public account fingerprint');
    assert.equal(hex(hmacSha256(secret, message)), createHmac('sha256', secret).update(message).digest('hex'));
  }
});
test('API keys are encrypted and bound to user, generation, provider and reserved counter', () => {
  const box=createPublicCredentialBox(key), ciphertext=box.seal(payload);
  assert.ok(!ciphertext.includes(token)); assert.equal(box.open(ciphertext,payload),token);
  for (const field of ['user_id','provider','account_generation','credential_generation','counter']) {
    const expected={...payload,[field]:typeof payload[field]==='number'?payload[field]+1:'different'};
    assert.throws(()=>box.open(ciphertext,expected),/Invalid saved API key/);
  }
  assert.throws(()=>createPublicCredentialBox('13'.repeat(32)).open(ciphertext,payload));
  const changed=ciphertext.slice(0,-2)+(ciphertext.endsWith('00')?'01':'00'); assert.throws(()=>box.open(changed,payload));
  assert.notEqual(ciphertext,box.seal({...payload,counter:2}));
  assert.notEqual(ciphertext,box.seal({...payload,user_id:'43'}));
});
test('fingerprints are stable, secret-keyed and never raw token text',()=>{
  const box=createPublicCredentialBox(key), fingerprint=box.fingerprint(token);
  assert.match(fingerprint,/^[a-f0-9]{64}$/); assert.equal(fingerprint,box.fingerprint(token));
  assert.notEqual(fingerprint,createPublicCredentialBox('13'.repeat(32)).fingerprint(token));
  for(const invalid of ['', 'short', 'Bearer key-123456', 'key-123456\r\nAuthorization: stolen', 'x'.repeat(513)]) assert.equal(validMarketappApiKey(invalid),false);
});
