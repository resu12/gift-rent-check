import {secretbox} from './vendor/tweetnacl-secretbox.js';
import {sha256} from './ton-price-decoder.js';
import {utf8Bytes} from './personal-analytics.js';

const PURPOSE = 'marketapp-remembered-session-box-v1';
const FIELDS = ['version', 'owner', 'wallet', 'generation', 'wallet_revision', 'cookie_version', 'created_at', 'expires_at', 'cookie'];
const fail = () => {throw new Error('Invalid remembered Marketapp session');};
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
function unhex(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^(?:[a-f0-9]{2})+$/.test(value)) fail();
  return Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
}
function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== FIELDS.length ||
      Object.keys(payload).some(field => !FIELDS.includes(field)) || payload.version !== 1 ||
      typeof payload.owner !== 'string' || !/^[1-9]\d{0,19}$/.test(payload.owner) ||
      typeof payload.wallet !== 'string' || !/^(?:0|-1):[a-f0-9]{64}$/.test(payload.wallet) ||
      !Number.isSafeInteger(payload.generation) || payload.generation < 0 ||
      !Number.isSafeInteger(payload.wallet_revision) || payload.wallet_revision < 0 ||
      !Number.isSafeInteger(payload.cookie_version) || payload.cookie_version < 1 ||
      !Number.isSafeInteger(payload.created_at) || payload.created_at <= 0 ||
      !Number.isSafeInteger(payload.expires_at) || payload.expires_at <= payload.created_at || payload.expires_at > 8640000000000000 ||
      typeof payload.cookie !== 'string' || !/^session=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(payload.cookie)) fail();
  return payload;
}
function nonceFor(payload) {
  return sha256(utf8Bytes(`${PURPOSE}\0${payload.owner}\0${payload.wallet}\0${payload.cookie_version}`)).slice(0, 24);
}
function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

/** Separate encryption purpose from short-lived approval envelopes. Every seal
 * requires a newly committed owner counter, including rotations and failed CAS
 * writes. Logout retains that counter. Restore of an older database requires a
 * new master key before sealing again, since counter rollback can reuse nonces.
 * Only encrypted cookie metadata is durable; proofs and challenges are absent.
 */
export function createMarketappRememberedSessionBox(masterKeyHex) {
  const masterKey = unhex(masterKeyHex, 64);
  if (masterKey.length !== 32) fail();
  const prefix = utf8Bytes(`${PURPOSE}\0key\0`), material = new Uint8Array(prefix.length + masterKey.length);
  material.set(prefix); material.set(masterKey, prefix.length);
  const key = sha256(material);
  masterKey.fill(0); material.fill(0);
  return {
    seal(payload, reservedCounter) {
      validPayload(payload);
      if (!Number.isSafeInteger(reservedCounter) || reservedCounter < 1 || payload.cookie_version !== reservedCounter) fail();
      // Fixed field order makes the representation deterministic without
      // letting unexpected caller fields enter the private ciphertext.
      const bytes = utf8Bytes(JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, payload[field]]))));
      if (bytes.length > 8192) {bytes.fill(0); fail();}
      try {
        const nonce = nonceFor(payload);
        return `02${hex(nonce)}${hex(secretbox(bytes, nonce, key))}`;
      } finally {bytes.fill(0);}
    },
    open(envelope) {
      const bytes = unhex(envelope, 16500);
      if (bytes[0] !== 2 || bytes.length < 42) fail();
      const nonce = bytes.slice(1, 25), plaintext = secretbox.open(bytes.slice(25), nonce, key);
      if (!plaintext) fail();
      if (plaintext.length > 8192) {plaintext.fill(0); fail();}
      try {
        if (plaintext.some(byte => byte > 127)) fail();
        let payload;
        try {payload = JSON.parse(Array.from(plaintext, byte => String.fromCharCode(byte)).join(''));} catch {fail();}
        validPayload(payload);
        if (!sameBytes(nonce, nonceFor(payload))) fail();
        return payload;
      } finally {plaintext.fill(0);}
    },
  };
}
