import {secretbox} from './vendor/tweetnacl-secretbox.js';
import {sha256} from './ton-price-decoder.js';
import {utf8Bytes} from './personal-analytics.js';

export const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function keyBytes(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Credential encryption is unavailable');
  return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
}
export function hmacSha256(key, message) {
  const material = key.length > 64 ? sha256(key) : key;
  const inner = new Uint8Array(64 + message.length), outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) {inner[i] = (material[i] || 0) ^ 0x36; outer[i] = (material[i] || 0) ^ 0x5c;}
  inner.set(message, 64); outer.set(sha256(inner), 64);
  const result = sha256(outer); inner.fill(0); outer.fill(0); return result;
}
const PUBLIC_PURPOSE = 'gift-rent-check-public-api-key-v1';
const PRIVATE_PURPOSE = 'gift-rent-check-private-api-key-v1';
const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const safeCounter = value => Number.isSafeInteger(value) && value >= 0;
export function validMarketappApiKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{12,512}$/.test(value);
}
function createCredentialBox(masterKeyHex,purpose) {
  const master = keyBytes(masterKeyHex);
  const cipherKey = hmacSha256(master, utf8Bytes(`${purpose}\0encryption`));
  // Quota identity deliberately spans both stores, while encryption keys and
  // nonces are separated so independent counters cannot reuse a secretbox pair.
  const fingerprintKey = hmacSha256(master, utf8Bytes(`${PUBLIC_PURPOSE}\0fingerprint`)); master.fill(0);
  const nonceFor = payload => sha256(utf8Bytes(`${purpose}\0${payload.user_id}\0${payload.counter}`)).slice(0, 24);
  function validate(payload) {
    if (!payload || Object.keys(payload).sort().join(',') !== 'account_generation,api_key,counter,credential_generation,provider,user_id,version' ||
        payload.version !== 1 || !validId(payload.user_id) || payload.provider !== 'marketapp' || !safeCounter(payload.account_generation) ||
        !safeCounter(payload.credential_generation) || !safeCounter(payload.counter) || payload.counter < 1 || !validMarketappApiKey(payload.api_key)) throw new Error('Invalid saved API key');
  }
  return {
    fingerprint(token) {if (!validMarketappApiKey(token)) throw new Error('Invalid API key format'); return hex(hmacSha256(fingerprintKey, utf8Bytes(token)));},
    seal(payload) {
      validate(payload); const nonce = nonceFor(payload), bytes = utf8Bytes(JSON.stringify(payload));
      try {return `01${hex(nonce)}${hex(secretbox(bytes, nonce, cipherKey))}`;} finally {bytes.fill(0);}
    },
    open(ciphertext, expected) {
      if (typeof ciphertext !== 'string' || ciphertext.length > 4096 || !/^(?:[a-f0-9]{2})+$/.test(ciphertext)) throw new Error('Invalid saved API key');
      const bytes = Uint8Array.from(ciphertext.match(/../g), part => parseInt(part, 16));
      if (bytes[0] !== 1 || bytes.length < 42) throw new Error('Invalid saved API key');
      const nonce = bytes.slice(1, 25), plaintext = secretbox.open(bytes.slice(25), nonce, cipherKey);
      if (!plaintext || plaintext.length > 2048) throw new Error('Invalid saved API key');
      try {
        if (plaintext.some(byte => byte > 127)) throw new Error('Invalid saved API key');
        const payload = JSON.parse(Array.from(plaintext, byte => String.fromCharCode(byte)).join('')); validate(payload);
        let difference = 0; const calculated = nonceFor(payload);
        for (let i = 0; i < 24; i++) difference |= nonce[i] ^ calculated[i];
        if (difference || ['user_id', 'provider', 'account_generation', 'credential_generation', 'counter'].some(field => payload[field] !== expected[field])) throw new Error('Invalid saved API key');
        return payload.api_key;
      } catch {throw new Error('Invalid saved API key');} finally {plaintext.fill(0);}
    },
  };
}
export const createPublicCredentialBox=masterKeyHex=>createCredentialBox(masterKeyHex,PUBLIC_PURPOSE);
export const createPrivateCredentialBox=masterKeyHex=>createCredentialBox(masterKeyHex,PRIVATE_PURPOSE);
