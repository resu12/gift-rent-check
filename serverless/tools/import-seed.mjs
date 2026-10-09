// Administrative seed upload. Read/validate locally unless --approve-sha256 is
// explicitly supplied. Uses the pinned official CLI's credential/API helpers;
// it never reads .tgcloud files or logs private module source/record contents.
import {readFile, writeFile, realpath, lstat, rename, unlink} from 'node:fs/promises';
import {resolve, dirname, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {option, requireId, validateAuthenticatedDestination} from './destination.mjs';

const sha = body => createHash('sha256').update(body).digest('hex');
export function validateDestination(token, manifest, appId, env = process.env) {
  validateAuthenticatedDestination(token, appId, env);
  if (manifest.destination_app_id !== appId) throw new Error('The seed destination does not match the explicit Telegram app ID');
}

export async function readSeed(filename, appId) {
  requireId(appId, '--app-id');
  const path = await realpath(resolve(filename)), root = await realpath(dirname(path));
  const manifestBody = await readFile(path), approval_sha256 = sha(manifestBody);
  const manifest = JSON.parse(manifestBody.toString('utf8'));
  if (manifest.format !== 'marketapp-cloud-seed-v1' || !/^[a-f0-9]{64}$/.test(manifest.dataset_sha256)
      || manifest.destination_app_id !== appId || !Number.isSafeInteger(manifest.records) || manifest.records < 0
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || !Array.isArray(manifest.chunks) || manifest.chunks.length > 10000) throw new Error('Invalid seed manifest');
  let count = 0, bytes = 0;
  const seen = new Set(), chunks = [];
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (typeof chunk?.file !== 'string' || !/^chunk-\d{5}\.json$/.test(chunk.file) || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('Invalid chunk descriptor');
    const target = await realpath(resolve(root, chunk.file));
    if (!target.startsWith(root + sep) || seen.has(target)) throw new Error('Invalid chunk path');
    seen.add(target);
    const body = await readFile(target);
    if (body.length > 512000 || sha(body) !== chunk.sha256) throw new Error('Seed chunk changed after preview');
    const payload = JSON.parse(body.toString('utf8'));
    if (payload.import_id !== manifest.dataset_sha256 || payload.chunk_id !== String(index) || !Array.isArray(payload.records)
        || payload.records.length !== chunk.records || payload.records.length > 250) throw new Error('Invalid seed chunk');
    count += payload.records.length;
    bytes += body.length;
    chunks.push({file: chunk.file, payload});
  }
  if (count !== manifest.records || bytes !== manifest.bytes) throw new Error('Seed record or byte count mismatch');
  return {manifest, approval_sha256, chunks, root};
}

export function validateApproval(seed, approval) {
  if (approval !== seed.approval_sha256) throw new Error('Approval does not match the exact previewed manifest');
}

async function safeReceiptPath(seed) {
  if (await realpath(seed.root) !== seed.root) throw new Error('Seed directory changed after preview');
  const path = resolve(seed.root, 'upload-receipt.json');
  try {const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile()) throw new Error('Unsafe receipt path');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  return path;
}

export async function readReceipt(seed) {
  const empty = {dataset_sha256: seed.manifest.dataset_sha256, approval_sha256: seed.approval_sha256, completed: []};
  const path = await safeReceiptPath(seed), allowed = new Set(seed.chunks.map(chunk => chunk.file));
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.dataset_sha256 !== seed.manifest.dataset_sha256 || saved.approval_sha256 !== seed.approval_sha256 || !Array.isArray(saved.completed) || saved.completed.some(file => typeof file !== 'string' || !allowed.has(file)) || new Set(saved.completed).size !== saved.completed.length) return empty;
    return {...empty, completed: [...saved.completed]};
  } catch {return empty;}
}

export async function writeReceipt(seed, receipt) {
  const path = await safeReceiptPath(seed), temporary = resolve(seed.root, `.upload-receipt-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2), {flag: 'wx', mode: 0o600});
    await safeReceiptPath(seed);
    await rename(temporary, path);
  } finally {try {await unlink(temporary);} catch (error) {if (error.code !== 'ENOENT') throw error;}}
}

async function main() {
  const args = process.argv.slice(2);
  const getOption = name => option(args, name);
  const appId = requireId(getOption('--app-id'), '--app-id');
  const filename = getOption('--manifest');
  if (!filename) throw new Error('Pass --manifest path; approval is a separate --approve-sha256 value');
  const seed = await readSeed(filename, appId);
  const approval = getOption('--approve-sha256');
  if (!approval) {
    console.log(JSON.stringify({preview_only: true, portfolio_gifts: seed.manifest.portfolio_gifts,
      unresolved_gifts: seed.manifest.unresolved_gifts, records: seed.manifest.records,
      chunks: seed.chunks.length, bytes: seed.manifest.bytes, dataset_sha256: seed.manifest.dataset_sha256,
      approval_sha256: seed.approval_sha256, destination_app_id: seed.manifest.destination_app_id}));
    return;
  }
  validateApproval(seed, approval);
  const owner = requireId(getOption('--owner-id'), '--owner-id');
  process.env.TGCLOUD_DEBUG = '0';
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  const {resolveToken} = await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const {syncCapabilities} = await import('../node_modules/@tgcloud/cli/src/core/capabilities.js');
  const {scanFiles} = await import('../node_modules/@tgcloud/cli/src/core/scanner.js');
  const {readWd} = await import('../node_modules/@tgcloud/cli/src/core/workdir.js');
  const {pathToModule} = await import('../node_modules/@tgcloud/cli/src/core/snapshot.js');
  const {runFunction} = await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const token = await resolveToken();
  validateDestination(token, seed.manifest, appId);
  await syncCapabilities();
  const sources = Object.fromEntries(scanFiles().map(path => [pathToModule(path), readWd(path)]));
  const context = {initData: {user: {id: Number(owner)}}};
  let receipt = await readReceipt(seed);
  const done = new Set(receipt.completed);
  const maxChunks = Number(getOption('--max-chunks') || 50);
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 500) throw new Error('max-chunks must be 1–500');
  let sent = 0;
  for (const {file, payload} of seed.chunks) {
    if (done.has(file)) continue;
    if (sent >= maxChunks) break;
    const result = await runFunction(token, 'endpoints/importChunk', sources, payload, context);
    if (result.result?.error || result.result?.__error || !result.result || result.result.accepted !== true) throw new Error('Import was not acknowledged; safe to retry the same seed');
    done.add(file); sent += 1;
    receipt = {dataset_sha256: seed.manifest.dataset_sha256, approval_sha256: approval, completed: [...done], total_chunks: seed.chunks.length,
      finished: done.size === seed.chunks.length, updated_at: new Date().toISOString()};
    await writeReceipt(seed, receipt);
    if (sent % 10 === 0) console.log(`Seed chunks acknowledged: ${done.size}/${seed.chunks.length}`);
  }
  console.log(JSON.stringify({acknowledged_chunks: done.size, total_chunks: seed.chunks.length,
    finished: done.size === seed.chunks.length, provider_requests: 0}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {console.error('Seed import did not complete. No private data or credentials were logged. Keep the manifest and receipt; rerun the same approved seed to resume.'); process.exitCode = 1;});
}
