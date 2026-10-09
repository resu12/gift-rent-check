import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {resolve, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('deployment preflight rejects secret and mock content without printing either', t => {
  const taskRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(taskRoot, {recursive: true});
  const directory = mkdtempSync(join(taskRoot, 'serverless-preflight-'));
  t.after(() => {assert.ok(resolve(directory).startsWith(resolve(taskRoot) + sep)); rmSync(directory, {recursive: true, force: true});});
  for (const relative of ['tools', 'tgcloud/lib', 'dist/assets']) mkdirSync(join(directory, relative), {recursive: true});
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'tools/preflight.mjs'), readFileSync(new URL('../tools/preflight.mjs', import.meta.url)));
  const fakeSecret = 'test-secret-not-real';
  writeFileSync(join(directory, 'tgcloud/lib/private-config.js'), `export const ownerTelegramId=42; export const marketappToken=${JSON.stringify(fakeSecret)};`);
  writeFileSync(join(directory, 'dist/index.html'), '<script src="https://telegram.org/js/telegram-web-app.js?64"></script>');
  const run = () => spawnSync(process.execPath, ['tools/preflight.mjs'], {cwd: directory, encoding: 'utf8'});
  assert.equal(run().status, 0);
  for (const invalid of [fakeSecret, 'mock-only-token', '/mock-api/']) {
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
