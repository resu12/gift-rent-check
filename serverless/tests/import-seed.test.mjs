import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, symlink, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readSeed, validateApproval, validateDestination, readReceipt, writeReceipt} from '../tools/import-seed.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const dataset = 'a'.repeat(64), app = '54321';
async function fixture(t, count = 2) {
  const temporaryRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  await mkdir(temporaryRoot, {recursive: true});
  const parent = await mkdtemp(join(temporaryRoot, 'cloud-seed-test-')), root = join(parent, 'seed');
  await mkdir(root); t.after(() => rm(parent, {recursive: true, force: true}));
  const chunks = [], bodies = [];
  for (let index = 0; index < count; index++) {
    const file = `chunk-${String(index).padStart(5, '0')}.json`;
    const payload = {import_id: dataset, chunk_id: String(index), records: [{kind: 'portfolio', key: `gift:${index}`, observed_at: '2026-10-09T11:00:00Z', record: {nft_address: 'synthetic-' + index, is_portfolio: true}}]};
    const body = JSON.stringify(payload); await writeFile(join(root, file), body);
    bodies.push(body); chunks.push({file, sha256: sha(body), records: 1});
  }
  const manifest = {format: 'marketapp-cloud-seed-v1', destination_app_id: app, dataset_sha256: dataset, records: count, bytes: bodies.reduce((n, b) => n + Buffer.byteLength(b), 0), chunks};
  const path = join(root, 'manifest.json'); await writeFile(path, JSON.stringify(manifest));
  return {parent, root, path, manifest, bodies};
}

test('approval binds exact manifest bytes and therefore every referenced chunk hash', async t => {
  const f = await fixture(t), original = await readSeed(f.path, app);
  assert.equal(original.approval_sha256, sha(await readFile(f.path)));
  assert.notEqual(original.approval_sha256, dataset);
  validateApproval(original, original.approval_sha256);
  assert.throws(() => validateApproval(original, dataset), /exact previewed manifest/);
  const changed = JSON.parse(f.bodies[0]); changed.records[0].record.nft_address = 'different-synthetic-gift';
  const body = JSON.stringify(changed); await writeFile(join(f.root, f.manifest.chunks[0].file), body);
  f.manifest.chunks[0].sha256 = sha(body); f.manifest.bytes += Buffer.byteLength(body) - Buffer.byteLength(f.bodies[0]);
  await writeFile(f.path, JSON.stringify(f.manifest));
  const updated = await readSeed(f.path, app);
  assert.equal(updated.manifest.dataset_sha256, dataset); // Old weak approval would have accepted this.
  assert.throws(() => validateApproval(updated, original.approval_sha256));
});

test('chunk tampering, duplicate IDs, counts, byte totals and traversal paths are rejected', async t => {
  const f = await fixture(t);
  const mutate = async fn => {
    const m = structuredClone(f.manifest); await fn(m); await writeFile(f.path, JSON.stringify(m));
    await assert.rejects(readSeed(f.path, app));
  };
  await mutate(m => {m.chunks[0].sha256 = 'b'.repeat(64);});
  await mutate(m => {m.bytes++;});
  await mutate(m => {m.records++;});
  await mutate(m => {m.chunks[0].file = '../chunk-00000.json';});
  await mutate(async m => {
    const payload = JSON.parse(f.bodies[1]); payload.chunk_id = '0';
    const body = JSON.stringify(payload); await writeFile(join(f.root, m.chunks[1].file), body); m.chunks[1].sha256 = sha(body);
  });
});

test('explicit app, manifest destination and authenticated login must all match on official production transport', () => {
  validateDestination('app54321:synthetic_secret', {destination_app_id: app}, app, {});
  validateDestination('app54321:synthetic_secret', {destination_app_id: app}, app, {TG_CLOUD_API_URL: 'https://cloud.telegram.org', TGCLOUD_BETA: '0'});
  validateDestination('app65432:synthetic_secret', {destination_app_id: '65432'}, '65432', {});
  assert.throws(() => validateDestination('app42:synthetic_secret', {destination_app_id: app}, app, {}));
  assert.throws(() => validateDestination('app54321:synthetic_secret', {destination_app_id: '42'}, app, {}));
  assert.throws(() => validateDestination('app54321:synthetic_secret', {destination_app_id: app}, '42', {}));
  assert.throws(() => validateDestination('app54321:synthetic_secret', {destination_app_id: app}, undefined, {}));
  assert.throws(() => validateDestination('app54321:synthetic_secret', {destination_app_id: app}, app, {TG_CLOUD_API_URL: 'https://different.invalid'}));
  assert.throws(() => validateDestination('app54321:synthetic_secret', {destination_app_id: app}, app, {TGCLOUD_BETA: '1'}));
});

test('seed preview requires the exact explicit app; changing destination invalidates prior approval', async t => {
  const f = await fixture(t), original = await readSeed(f.path, app);
  await assert.rejects(readSeed(f.path));
  await assert.rejects(readSeed(f.path, '65432'));
  f.manifest.destination_app_id = '65432';
  await writeFile(f.path, JSON.stringify(f.manifest));
  await assert.rejects(readSeed(f.path, app));
  const moved = await readSeed(f.path, '65432');
  assert.throws(() => validateApproval(moved, original.approval_sha256));
  validateApproval(moved, moved.approval_sha256);
});

test('local mock seed preview rejects missing or mismatched app before starting its server', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--app-id', '65432']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/mock-server.mjs', import.meta.url)), ...args], {
      env: {...process.env, MOCK_SEED_MANIFEST: f.path, MOCK_PORT: '0'}, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--app-id|Invalid seed manifest/);
    assert.equal(result.stdout, '');
  }
});

test('receipts are atomic, replay only acknowledged chunks, and ignore corrupt or mismatched receipts', async t => {
  const f = await fixture(t), seed = await readSeed(f.path, app), receipt = await readReceipt(seed);
  assert.deepEqual(receipt.completed, []);
  receipt.completed.push(f.manifest.chunks[0].file);
  await writeReceipt(seed, receipt);
  assert.deepEqual((await readReceipt(seed)).completed, [f.manifest.chunks[0].file]);
  for (const corrupt of ['not json', JSON.stringify({...receipt, completed: ['not-a-chunk']}), JSON.stringify({...receipt, completed: [receipt.completed[0], receipt.completed[0]]}), JSON.stringify({...receipt, approval_sha256: dataset})]) {
    await writeFile(join(f.root, 'upload-receipt.json'), corrupt);
    assert.deepEqual((await readReceipt(seed)).completed, []);
  }
});

test('symlink chunks cannot escape seed directory and symlink receipts cannot redirect writes', async t => {
  const f = await fixture(t, 1), outside = join(f.parent, 'outside.json');
  await writeFile(outside, f.bodies[0]); await rm(join(f.root, f.manifest.chunks[0].file));
  try {await symlink(outside, join(f.root, f.manifest.chunks[0].file), 'file');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {t.skip('Creating symlinks is unavailable in this test environment'); return;} throw error;}
  await assert.rejects(readSeed(f.path, app), /chunk path/);
  await rm(join(f.root, f.manifest.chunks[0].file)); await writeFile(join(f.root, f.manifest.chunks[0].file), f.bodies[0]);
  const seed = await readSeed(f.path, app);
  await symlink(outside, join(f.root, 'upload-receipt.json'), 'file');
  await assert.rejects(readReceipt(seed), /Unsafe receipt path/);
  await assert.rejects(writeReceipt(seed, {completed: []}), /Unsafe receipt path/);
  assert.equal(await readFile(outside, 'utf8'), f.bodies[0]);
});
