import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {resolve, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

function fixture(t) {
  const taskRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(taskRoot, {recursive: true});
  const directory = mkdtempSync(join(taskRoot, 'serverless-preflight-'));
  t.after(() => {assert.ok(resolve(directory).startsWith(resolve(taskRoot) + sep)); rmSync(directory, {recursive: true, force: true});});
  for (const relative of ['tools', 'tgcloud/lib', 'dist/assets']) mkdirSync(join(directory, relative), {recursive: true});
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'tools/preflight.mjs'), readFileSync(new URL('../tools/preflight.mjs', import.meta.url)));
  const fakeSecret = 'test-secret-not-real';
  const fakeRefreshKey = 'ab'.repeat(32);
  writeFileSync(join(directory, 'tgcloud/lib/private-config.js'), `export const ownerTelegramId=42; export const marketappToken=${JSON.stringify(fakeSecret)};`);
  writeFileSync(join(directory, 'tgcloud/lib/private-refresh-key.js'), `export const marketappRefreshKey=${JSON.stringify(fakeRefreshKey)};`);
  writeFileSync(join(directory, 'dist/index.html'), '<script src="https://telegram.org/js/telegram-web-app.js?64"></script>');
  const run = (args = []) => spawnSync(process.execPath, ['tools/preflight.mjs', ...args], {cwd: directory, encoding: 'utf8'});
  return {directory, run, fakeSecret, fakeRefreshKey};
}

test('deployment preflight rejects secret and mock content without printing either', t => {
  const {directory, run, fakeSecret, fakeRefreshKey} = fixture(t);
  assert.equal(run().status, 0);
  for (const invalid of [fakeSecret, fakeRefreshKey, 'mock-only-token', '/mock-api/']) {
    writeFileSync(join(directory, 'dist/assets/app.js'), `const bad=${JSON.stringify(invalid)}`);
    const result = run();
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(invalid));
    assert.ok(!result.stderr.includes(invalid));
  }
  writeFileSync(join(directory, 'dist/assets/app.js'), '//safe');
  writeFileSync(join(directory, 'tgcloud/lib/private-config.js'), "export const ownerTelegramId=null; export const marketappToken='';");
  assert.equal(run().status, 1);
});

test('a TON Connect manifest requires the explicit matching app and its public PNG', t => {
  const {directory, run} = fixture(t);
  const path = join(directory, 'dist/tonconnect-manifest.json');
  const valid = {url: 'https://app54321.tgcloud.ai', name: 'Gift Rent Check', iconUrl: 'https://app54321.tgcloud.ai/wallet-icon.png'};
  writeFileSync(path, JSON.stringify(valid));
  assert.equal(run().status, 1);
  assert.equal(run(['--app-id', '54321']).status, 1, 'missing icon must block publication');
  writeFileSync(join(directory, 'dist/wallet-icon.png'), readFileSync(new URL('../../frontend/public/wallet-icon.png', import.meta.url)));
  assert.equal(run(['--app-id', '54321']).status, 0);
  for (const args of [[], ['--app-id', '65432'], ['--app-id', '0'], ['--app-id', '54321', '--app-id', '54321']]) assert.equal(run(args).status, 1);
  for (const invalid of [{...valid, url: 'https://app65432.tgcloud.ai'}, {...valid, iconUrl: 'https://unrelated.invalid/icon.png'}, {...valid, name: 'Another app'}, {...valid, termsOfUseUrl: 'https://unreviewed.invalid'}, null]) {
    writeFileSync(path, JSON.stringify(invalid));
    assert.equal(run(['--app-id', '54321']).status, 1);
  }
  writeFileSync(path, '{broken');
  assert.equal(run(['--app-id', '54321']).status, 1);
  writeFileSync(path, JSON.stringify(valid));
  writeFileSync(join(directory, 'dist/wallet-icon.png'), '<svg>not a PNG</svg>');
  assert.equal(run(['--app-id', '54321']).status, 1);
});
