import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createMarketappSessionBox} from '../tgcloud/lib/marketapp-session-box.js';
const key = '12'.repeat(32);
const payload = {version:1,attempt_id:'a'.repeat(64),owner:'123',wallet:'0:'+'0'.repeat(64),period_days:30,created_at:100,expires_at:200,cookie:'session=synthetic-cookie',challenge:'synthetic-challenge'};
test('vendored cryptographic implementation matches the pinned upstream source checksum',()=>{
 const vendor = readFileSync(new URL('../tgcloud/lib/vendor/tweetnacl-secretbox.js',import.meta.url),'utf8');
 const start = vendor.indexOf('(function(nacl) {');
 const original = vendor.slice(start).replace('})(nacl);\nexport const secretbox = nacl.secretbox;', "})(typeof module !== 'undefined' && module.exports ? module.exports : (self.nacl = self.nacl || {}));");
 assert.equal(createHash('sha256').update(original).digest('hex'),'6bcd37a3b20dce913f82d4b23e4e2b661058b4b953df8a3f8c45d56ac4f72447');
});
test('encrypted session envelope round trip, secret is absent from output',()=>{
 const box=createMarketappSessionBox(key), envelope=box.seal(payload);
 assert.deepEqual(box.open(envelope),payload); assert.equal(envelope.includes(payload.cookie),false);
 assert.notEqual(envelope,box.seal({...payload,attempt_id:'b'.repeat(64)}));
});
test('authenticated encryption rejects tampering, wrong key, truncation and oversized data',()=>{
 const box=createMarketappSessionBox(key), envelope=box.seal(payload);
 for(const invalid of [envelope.slice(0,-2),envelope.slice(0,-2)+'ff',envelope.slice(0,20)+'ff'+envelope.slice(22),'02'+envelope.slice(2),envelope.toUpperCase(),'00'.repeat(9000)]) assert.throws(()=>box.open(invalid));
 assert.throws(()=>createMarketappSessionBox('13'.repeat(32)).open(envelope));
 assert.throws(()=>box.seal({...payload,cookie:'a'.repeat(9000)}));
 assert.throws(()=>createMarketappSessionBox('00'));
});
