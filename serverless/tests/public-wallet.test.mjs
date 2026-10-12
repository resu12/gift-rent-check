import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, createPrivateKey, sign} from 'node:crypto';
import {createPublicWalletEngine, PUBLIC_WALLET_CODES, publicWalletStateInit, publicWalletProofDigest, verifyPublicWalletProof} from '../tgcloud/lib/public-wallet.js';
import {isValidEd25519Point} from '../tgcloud/lib/vendor/tweetnacl-secretbox.js';
import {portableModules} from './fixtures/portable-modules.mjs';
import {createPublicDatabase} from './fixtures/public-database.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/public-wallet-state-init.json', import.meta.url), 'utf8'));
const at = Date.parse('2026-10-10T12:00:00Z'), domain = 'gift.example.test', ctx = {initData: {user: {id: 12345}}};
// RFC 8032 test seed, never a real wallet credential.
const privateKey = createPrivateKey({key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8'});
const hash = bytes => createHash('sha256').update(bytes).digest();
function referenceDigest(wallet, proof) {
  const wc = Buffer.alloc(4), length = Buffer.alloc(4), timestamp = Buffer.alloc(8), domainBytes = Buffer.from(proof.domain.value);
  wc.writeInt32BE(Number(wallet.split(':')[0])); length.writeUInt32LE(domainBytes.length); timestamp.writeBigUInt64LE(BigInt(proof.timestamp));
  return hash(Buffer.concat([Buffer.from([255, 255]), Buffer.from('ton-connect'), hash(Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, Buffer.from(wallet.split(':')[1], 'hex'), length, domainBytes, timestamp, Buffer.from(proof.payload)]))]));
}
const challenge = (payload = 'a'.repeat(64)) => ({payload, domain, created_at: at, expires_at: at + 300000});
function proof(account, expected = challenge(), extra = {}) {
  const reply = {timestamp: at / 1000, domain: {lengthBytes: Buffer.byteLength(expected.domain), value: expected.domain}, payload: expected.payload, ...extra};
  return {...reply, signature: sign(null, referenceDigest(account.address, reply), privateKey).toString('base64')};
}

test('published V3R2/V4R2/V5R1 BOCs match independently generated @ton/core state-init hashes and keys', () => {
  for (const fixture of fixtures) {
    const identity = publicWalletStateInit(fixture.account);
    assert.equal(identity.wallet, fixture.account.address); assert.equal(identity.version, fixture.version);
    assert.equal(identity.codeHash, fixture.code_hash); assert.equal(PUBLIC_WALLET_CODES[fixture.code_hash].version, fixture.version);
    assert.equal(Buffer.from(identity.publicKey).toString('hex'), fixture.account.publicKey);
    const submitted = proof(fixture.account);
    assert.deepEqual(Buffer.from(publicWalletProofDigest(identity.wallet, submitted)), referenceDigest(identity.wallet, submitted));
    assert.equal(verifyPublicWalletProof(fixture.account, submitted, challenge(), at), identity.wallet);
    const {publicKey: ignored, ...withoutHint} = fixture.account;
    assert.equal(verifyPublicWalletProof(withoutHint, submitted, challenge(), at), identity.wallet);
  }
});

test('mainnet, state-init address/key, domain, time, nonce and signature must all agree', () => {
  const account = fixtures[1].account, good = proof(account), expected = challenge();
  const badAccounts = [{...account, chain: '-3'}, {...account, address: `0:${'12'.repeat(32)}`}, {...account, publicKey: '00'.repeat(32)}, {...account, walletStateInit: 'AAAA'}, {...account, arbitrary: true}];
  for (const bad of badAccounts) assert.throws(() => verifyPublicWalletProof(bad, good, expected, at), /PUBLIC_WALLET_INVALID_PROOF/);
  const badProofs = [{...good, domain: {...good.domain, value: 'attacker.test'}}, {...good, domain: {...good.domain, lengthBytes: 1}}, {...good, payload: 'b'.repeat(64)},
    {...good, timestamp: at / 1000 - 301}, {...good, timestamp: at / 1000 + 31}, {...good, signature: Buffer.alloc(64).toString('base64')}, {...good, extra: true}];
  for (const bad of badProofs) assert.throws(() => verifyPublicWalletProof(account, bad, expected, at), /PUBLIC_WALLET_INVALID_PROOF/);
  assert.throws(() => verifyPublicWalletProof(account, good, expected, at + 300000), /PUBLIC_WALLET_INVALID_PROOF/);
  assert.throws(() => verifyPublicWalletProof(account, good, {...expected, wallet: fixtures[0].account.address}, at), /PUBLIC_WALLET_INVALID_PROOF/);
  assert.throws(() => publicWalletStateInit(account, {}), /PUBLIC_WALLET_UNSUPPORTED/);
});

test('canonical prime-subgroup points and canonical scalars reject weak keys and malleable signatures', () => {
  const encoded = hex => new Uint8Array(Buffer.from(hex, 'hex'));
  assert.equal(isValidEd25519Point(encoded(fixtures[0].account.publicKey)), true);
  for (const key of ['00'.repeat(32), `01${'00'.repeat(31)}`, `ec${'ff'.repeat(30)}7f`, `ed${'ff'.repeat(30)}7f`, `01${'00'.repeat(30)}80`]) assert.equal(isValidEd25519Point(encoded(key)), false);
  const account = fixtures[0].account, good = proof(account), bytes = Buffer.from(good.signature, 'base64');
  let scalar = 0n; for (let i = 63; i >= 32; i--) scalar = scalar << 8n | BigInt(bytes[i]);
  scalar += (1n << 252n) + 27742317777372353535851937790883648493n;
  for (let i = 32; i < 64; i++) {bytes[i] = Number(scalar & 255n); scalar >>= 8n;}
  assert.throws(() => verifyPublicWalletProof(account, {...good, signature: bytes.toString('base64')}, challenge(), at), /PUBLIC_WALLET_INVALID_PROOF/);
});

function setup(owner = 12345, extra = {}, engineFactory = createPublicWalletEngine) {
  let counter = 0, time = at; const challenges = new Map(), bindings = [], accesses = [];
  const repository = {
    clock: async () => time,
    async reserveWalletChallengeNonce(id) {accesses.push(['nonce', id]); return {generation: 0, counter: ++counter, wallet_disconnect_revision: 0};},
    async issueWalletChallenge(id, value) {accesses.push(['issue', id]); challenges.set(value.challenge_id, {...value, owner: id}); return true;},
    async consumeWalletChallenge(id, attempt, payload, now) {accesses.push(['consume', id]); const row = challenges.get(attempt); if (!row || row.owner !== id || row.payload !== payload || row.consumed || now >= row.expires_at) return null; row.consumed = true; return row;},
    async bindVerifiedWallet(id, wallet, observedAt, attempt) {accesses.push(['bind', id]); bindings.push({wallet, observedAt, attempt}); return true;},
  };
  return {engine: engineFactory({repository, ownerTelegramId: owner, enabled: true, challengeKey: '12'.repeat(32), domain, manifestUrl: `https://${domain}/tonconnect-manifest.json`, ...extra}), challenges, bindings, accesses, advance: ms => time += ms};
}

test('wallet proof verification and nonce issuance work in Telegram-like V8 without browser or Node globals', async () => {
  const portable = portableModules(), wallet = portable.load('public-wallet.js');
  assert.equal(portable.evaluate('[typeof URL,typeof URLSearchParams,typeof Buffer,typeof process,typeof require,typeof crypto,typeof setTimeout,typeof AbortController].join(",")'), Array(8).fill('undefined').join(','));
  for (const fixture of fixtures) assert.equal(wallet.verifyPublicWalletProof(fixture.account, proof(fixture.account), challenge(), at), fixture.account.address);
  const t = setup(12345, {}, wallet.createPublicWalletEngine), issued = await t.engine.startWalletVerification(ctx), account = fixtures[2].account;
  const result = await t.engine.finishWalletVerification(ctx, {attempt_id: issued.attempt_id, account, proof: proof(account, challenge(issued.challenge))});
  assert.equal(result.verified, true); assert.equal(t.bindings[0].wallet, account.address);
});

test('public mode defaults closed and endpoint authorization precedes storage access', async () => {
  for (const overrides of [{enabled: false}, {}]) {
    const t = setup(12345, overrides);
    for (const context of [{}, {initData: {user: {id: 999}}}, ...(overrides.enabled === false ? [ctx] : [])]) {
      await assert.rejects(t.engine.startWalletVerification(context), /PUBLIC_ACCESS_DENIED/);
      await assert.rejects(t.engine.finishWalletVerification(context), /PUBLIC_ACCESS_DENIED/);
    }
    assert.equal(t.accesses.length, 0);
  }
});

test('single-use user-bound challenges bind verified wallet without storing proof material', async () => {
  const t = setup(), issued = await t.engine.startWalletVerification(ctx);
  assert.deepEqual(Object.keys(issued).sort(), ['attempt_id', 'challenge', 'domain', 'expires_at', 'manifest_url']);
  const account = fixtures[1].account, submitted = proof(account, challenge(issued.challenge));
  const result = await t.engine.finishWalletVerification(ctx, {attempt_id: issued.attempt_id, account, proof: submitted});
  assert.equal(result.verified, true); assert.equal(result.wallet, account.address); assert.equal(t.bindings.length, 1);
  assert.equal(t.bindings[0].observedAt, at);
  await assert.rejects(t.engine.finishWalletVerification(ctx, {attempt_id: issued.attempt_id, account, proof: submitted}), /PUBLIC_WALLET_EXPIRED/);
  for (const secret of [account.walletStateInit, account.publicKey, submitted.signature]) assert.equal(JSON.stringify([...t.challenges.values(), ...t.bindings]).includes(secret), false);
  const another = setup(54321), other = await another.engine.startWalletVerification({initData: {user: {id: 54321}}});
  assert.notEqual(other.challenge, issued.challenge);
  const fresh = await t.engine.startWalletVerification(ctx); assert.notEqual(fresh.challenge, issued.challenge);
});

test('bad signatures consume their attempt and expiration never binds a wallet', async () => {
  const t = setup(), issued = await t.engine.startWalletVerification(ctx), account = fixtures[0].account;
  const good = proof(account, challenge(issued.challenge));
  await assert.rejects(t.engine.finishWalletVerification(ctx, {attempt_id: issued.attempt_id, account, proof: {...good, signature: Buffer.alloc(64).toString('base64')}}), /PUBLIC_WALLET_INVALID_PROOF/);
  await assert.rejects(t.engine.finishWalletVerification(ctx, {attempt_id: issued.attempt_id, account, proof: good}), /PUBLIC_WALLET_EXPIRED/);
  const fresh = await t.engine.startWalletVerification(ctx); t.advance(300000);
  await assert.rejects(t.engine.finishWalletVerification(ctx, {attempt_id: fresh.attempt_id, account, proof: proof(account, challenge(fresh.challenge))}), /PUBLIC_WALLET_EXPIRED/);
  assert.equal(t.bindings.length, 0);
});

function databaseWallet(t) {
  const fixture = createPublicDatabase(t), repository = fixture.repository(12345);
  let time = at;
  const account = fixtures[1].account;
  const engine = createPublicWalletEngine({repository, ownerTelegramId: 12345, enabled: true,
    challengeKey: '12'.repeat(32), domain, manifestUrl: `https://${domain}/tonconnect-manifest.json`, clock: async () => time});
  const submission = issued => ({attempt_id: issued.attempt_id, account, proof: proof(account,
    {...challenge(issued.challenge), created_at: time, expires_at: time + 300000}, {timestamp: time / 1000})});
  return {...fixture, repository, engine, account, submission, advance: ms => time += ms};
}

test('disconnect atomically rejects pending approvals without resetting challenge cooldowns or portfolio identity', async t => {
  const f = databaseWallet(t), initial = await f.engine.startWalletVerification(ctx);
  await f.engine.finishWalletVerification(ctx, f.submission(initial));
  const generation = (await f.repository.ensureAccount()).generation;
  f.advance(61000);
  const pending = await f.engine.startWalletVerification(ctx), submitted = f.submission(pending);
  assert.equal(await f.repository.disconnectWallet(), true);
  await assert.rejects(f.engine.finishWalletVerification(ctx, submitted), /PUBLIC_WALLET_EXPIRED/);
  const disconnected = await f.repository.publicAccount();
  assert.equal(disconnected.generation, generation);
  assert.equal(disconnected.wallet, f.account.address);
  assert.equal(disconnected.wallet_verified_at, null);
  assert.ok(disconnected.wallet_disconnect_revision > 0);
  assert.equal(await f.repository.bindVerifiedWallet('12345', f.account.address, at, initial.attempt_id), false,
    'replaying a completed old binding cannot undo disconnect');
  await assert.rejects(f.engine.startWalletVerification(ctx), /PUBLIC_WALLET_RATE_LIMIT/);
  f.advance(61000);
  const fresh = await f.engine.startWalletVerification(ctx);
  assert.equal((await f.engine.finishWalletVerification(ctx, f.submission(fresh))).verified, true);
  assert.equal((await f.repository.publicAccount()).wallet_disconnect_revision, disconnected.wallet_disconnect_revision,
    'new bindings carry the disconnect fence forward');
});

test('disconnect between consuming an approval and committing its binding prevents late reactivation', async t => {
  const f = databaseWallet(t), initial = await f.engine.startWalletVerification(ctx);
  await f.engine.finishWalletVerification(ctx, f.submission(initial));
  f.advance(61000);
  const pending = await f.engine.startWalletVerification(ctx), bind = f.repository.bindVerifiedWallet;
  f.repository.bindVerifiedWallet = async (...args) => {
    assert.equal(await f.repository.disconnectWallet(), true);
    return bind(...args);
  };
  await assert.rejects(f.engine.finishWalletVerification(ctx, f.submission(pending)), /PUBLIC_WALLET_BINDING_REJECTED/);
  assert.equal((await f.repository.publicAccount()).wallet_verified_at, null);
  const row = f.database.prepare('SELECT consumed_at FROM public_wallet_challenges WHERE challenge_id=?').get(pending.attempt_id);
  assert.ok(row.consumed_at, 'the approval was consumed before the disconnect');
});

test('disconnect immediately before a binding INSERT fences the commit in SQLite', async t => {
  const f = databaseWallet(t), initial = await f.engine.startWalletVerification(ctx);
  await f.engine.finishWalletVerification(ctx, f.submission(initial));
  f.advance(61000);
  const pending = await f.engine.startWalletVerification(ctx), run = f.db.run;
  let raced = false;
  f.db.run = async (sql, params) => {
    if (!raced && sql.startsWith('INSERT OR IGNORE INTO public_cloud_events') && params[':challenge'] === pending.attempt_id) {
      raced = true;
      assert.equal(await f.repository.disconnectWallet(), true);
    }
    return run(sql, params);
  };
  await assert.rejects(f.engine.finishWalletVerification(ctx, f.submission(pending)), /PUBLIC_WALLET_BINDING_REJECTED/);
  assert.equal(raced, true);
  assert.equal(await f.repository.event(`wallet-bind:${pending.attempt_id}`), null);
  assert.equal((await f.repository.publicAccount()).wallet_verified_at, null);
});

test('a challenge reserved before disconnect cannot be issued afterwards, even with the same clock value', async t => {
  const f = databaseWallet(t), initial = await f.engine.startWalletVerification(ctx);
  await f.engine.finishWalletVerification(ctx, f.submission(initial));
  f.advance(61000);
  const reserve = f.repository.reserveWalletChallengeNonce;
  f.repository.reserveWalletChallengeNonce = async (...args) => {
    const counter = await reserve(...args);
    assert.equal(await f.repository.disconnectWallet(), true);
    return counter;
  };
  await assert.rejects(f.engine.startWalletVerification(ctx), /PUBLIC_WALLET_RATE_LIMIT/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM public_wallet_challenges').get().count, 1);
  assert.equal((await f.repository.publicAccount()).wallet_verified_at, null);
});
