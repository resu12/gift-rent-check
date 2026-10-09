import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const token = 'app54321:synthetic_cli_secret';
const otherToken = 'app65432:synthetic_other_secret';
const providerToken = 'synthetic_marketapp_secret';

function fixture(t) {
  const temporaryRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(temporaryRoot, {recursive: true});
  const root = mkdtempSync(join(temporaryRoot, 'deployment-guard-'));
  t.after(() => {assert.ok(resolve(root).startsWith(resolve(temporaryRoot) + sep)); rmSync(root, {recursive: true, force: true});});
  const project = join(root, 'serverless');
  for (const relative of ['tools', 'node_modules/@tgcloud/cli/src/core', 'node_modules/@tgcloud/cli/bin', 'tgcloud/lib', 'dist/assets', '.tgcloud']) mkdirSync(join(project, relative), {recursive: true});
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'node_modules/@tgcloud/cli/package.json'), '{"type":"module"}');
  for (const file of ['manage.mjs', 'destination.mjs', 'preflight.mjs']) writeFileSync(join(project, 'tools', file), readFileSync(new URL('../tools/' + file, import.meta.url)));
  writeFileSync(join(project, '.tgcloud/credentials'), JSON.stringify({token}));
  writeFileSync(join(project, 'dist/index.html'), '<script src="https://telegram.org/js/telegram-web-app.js?64"></script>');
  writeFileSync(join(project, 'tgcloud/lib/private-config.js'), `export const ownerTelegramId=42;export const marketappToken=${JSON.stringify(providerToken)};`);
  // A synthetic pinned-CLI boundary. All requests are represented by markers;
  // this project has neither a real token nor a network-capable CLI installed.
  writeFileSync(join(project, 'node_modules/@tgcloud/cli/src/core/credentials.js'), `
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
appendFileSync('calls.jsonl',JSON.stringify({stage:'credentials-import'})+'\\n');
export async function resolveToken() {
  const result=process.env.TGCLOUD_TOKEN||JSON.parse(readFileSync('.tgcloud/credentials','utf8')).token;
  if(process.env.TEST_ROTATE_SAVED) writeFileSync('.tgcloud/credentials',JSON.stringify({token:process.env.TEST_ROTATE_SAVED}));
  return result;
}`);
  writeFileSync(join(project, 'node_modules/@tgcloud/cli/bin/tgcloud.js'), `
import {appendFileSync,existsSync} from 'node:fs';
appendFileSync('calls.jsonl',JSON.stringify({stage:'cli',args:process.argv.slice(2),cwd:process.cwd(),
  token:process.env.TGCLOUD_TOKEN??null,api:process.env.TG_CLOUD_API_URL,beta:process.env.TGCLOUD_BETA,
  debug:process.env.TGCLOUD_DEBUG,stateDirectory:existsSync('.tgcloud')})+'\\n');
process.exitCode=Number(process.env.TEST_CLI_EXIT||0);
`);
  const baseEnv = {...process.env};
  for (const name of ['TGCLOUD_TOKEN', 'TG_CLOUD_API_URL', 'TGCLOUD_BETA', 'TGCLOUD_DEBUG', 'TEST_ROTATE_SAVED', 'TEST_CLI_EXIT', 'NODE_OPTIONS']) delete baseEnv[name];
  const run = (args, env = {}) => spawnSync(process.execPath, [join(project, 'tools/manage.mjs'), ...args], {cwd: root, env: {...baseEnv, ...env}, encoding: 'utf8', timeout: 10000});
  const calls = () => existsSync(join(project, 'calls.jsonl')) ? readFileSync(join(project, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return {root, project, run, calls};
}

function rejected(result) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const secret of [token, otherToken, providerToken]) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), 'Secrets must not enter guard output');
}

function removeSyntheticState(f) {
  const target = resolve(f.project, '.tgcloud');
  assert.ok(target.startsWith(resolve(f.root) + sep));
  rmSync(target, {recursive: true});
}

test('transport and argument guards run before CLI imports, even for login/status', t => {
  for (const action of ['login', 'status', 'publish', 'migrate-check', 'migrate-safe']) {
    const f = fixture(t);
    const args = ['--action', action, ...(action === 'login' ? [] : ['--app-id', '54321'])];
    for (const env of [{TG_CLOUD_API_URL: 'https://other.invalid'}, {TG_CLOUD_API_URL: 'https://cloud.telegram.org.evil.invalid'}, {TGCLOUD_BETA: '1'}]) rejected(f.run(args, env));
    assert.deepEqual(f.calls(), []);
  }
  const f = fixture(t);
  for (const args of [[], ['--action', 'publish'], ['--action', 'status', '--app-id', '0'], ['--action', 'publish', '--app-id', '54321', '--debug'], ['--action', 'publish', '--app-id', '54321', '--app-id', '65432']]) rejected(f.run(args));
  assert.deepEqual(f.calls(), []);
});

test('mismatched environment credentials cannot fall back to matching saved credentials', t => {
  for (const action of ['status', 'publish', 'migrate-check', 'migrate-safe']) {
    const f = fixture(t);
    const result = f.run(['--action', action, '--app-id', '54321'], {TGCLOUD_TOKEN: otherToken});
    rejected(result);
    assert.match(result.stderr, /credentials do not match/);
    assert.deepEqual(f.calls().map(c => c.stage), ['credentials-import']);
  }
});

test('mismatched or malformed saved credentials stop before CLI/preflight execution', t => {
  for (const saved of [otherToken, token + '\n', '']) {
    const f = fixture(t);
    writeFileSync(join(f.project, '.tgcloud/credentials'), JSON.stringify({token: saved}));
    rejected(f.run(['--action', 'publish', '--app-id', '54321']));
    assert.deepEqual(f.calls().map(c => c.stage), ['credentials-import']);
  }
});

test('valid operations pin credentials and production transport and preserve targeted CLI arguments', t => {
  const expected = {status: ['status'], publish: ['push', 'tgcloud/schema.js', 'tgcloud/lib/', 'tgcloud/endpoints/', 'dist/'], 'migrate-check': ['migrate', '--dry-run'], 'migrate-safe': ['migrate', '--safe']};
  for (const [action, args] of Object.entries(expected)) {
    const f = fixture(t);
    const result = f.run(['--action', action, '--app-id', '54321'], {TGCLOUD_DEBUG: '1', TEST_ROTATE_SAVED: otherToken});
    assert.equal(result.status, 0, result.stderr);
    const call = f.calls().find(c => c.stage === 'cli');
    assert.deepEqual(call, {stage: 'cli', args, cwd: f.project, token, api: 'https://cloud.telegram.org', beta: '0', debug: '0', stateDirectory: true});
    assert.equal(JSON.parse(readFileSync(join(f.project, '.tgcloud/credentials'), 'utf8')).token, otherToken);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  }
});

test('publication still blocks secrets in the static bundle and propagates CLI failures', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'dist/assets/app.js'), providerToken);
  rejected(f.run(['--action', 'publish', '--app-id', '54321']));
  assert.equal(f.calls().some(c => c.stage === 'cli'), false);
  writeFileSync(join(f.project, 'dist/assets/app.js'), '// safe');
  assert.equal(f.run(['--action', 'publish', '--app-id', '54321'], {TEST_CLI_EXIT: '7'}).status, 7);
});

test('publication passes its guarded app ID to the TON Connect manifest check', t => {
  const f = fixture(t);
  const path = join(f.project, 'dist/tonconnect-manifest.json');
  const manifest = {url: 'https://app65432.tgcloud.ai', name: 'Gift Rent Check', iconUrl: 'https://app65432.tgcloud.ai/wallet-icon.png'};
  writeFileSync(join(f.project, 'dist/wallet-icon.png'), readFileSync(new URL('../../frontend/public/wallet-icon.png', import.meta.url)));
  writeFileSync(path, JSON.stringify(manifest));
  rejected(f.run(['--action', 'publish', '--app-id', '54321']));
  assert.equal(f.calls().some(c => c.stage === 'cli'), false);
  writeFileSync(path, JSON.stringify({...manifest, url: 'https://app54321.tgcloud.ai', iconUrl: 'https://app54321.tgcloud.ai/wallet-icon.png'}));
  assert.equal(f.run(['--action', 'publish', '--app-id', '54321']).status, 0);
  assert.equal(f.calls().filter(c => c.stage === 'cli').length, 1);
});

test('login rejects environment tokens and passes interactive control to the official CLI', t => {
  const f = fixture(t);
  rejected(f.run(['--action', 'login'], {TGCLOUD_TOKEN: token}));
  assert.deepEqual(f.calls(), []);
  removeSyntheticState(f);
  mkdirSync(join(f.root, '.tgcloud')); // An unrelated ancestor must not become the CLI root.
  const result = f.run(['--action', 'login'], {TGCLOUD_DEBUG: 'true'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [{stage: 'cli', args: ['login'], cwd: f.project, token: null, api: 'https://cloud.telegram.org', beta: '0', debug: '0', stateDirectory: true}]);
});

test('environment-token deployments establish a local state root instead of selecting an ancestor', t => {
  const f = fixture(t);
  removeSyntheticState(f);
  mkdirSync(join(f.root, '.tgcloud'));
  const result = f.run(['--action', 'status', '--app-id', '54321'], {TGCLOUD_TOKEN: token});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().find(c => c.stage === 'cli').stateDirectory, true);
});

test('a redirected state directory is rejected before starting the CLI', t => {
  const f = fixture(t);
  removeSyntheticState(f);
  const elsewhere = join(f.root, 'unrelated-state');
  mkdirSync(elsewhere);
  try {symlinkSync(elsewhere, join(f.project, '.tgcloud'), 'dir');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {t.skip('Directory symlinks unavailable'); return;} throw error;}
  rejected(f.run(['--action', 'status', '--app-id', '54321'], {TGCLOUD_TOKEN: token}));
  assert.equal(f.calls().some(c => c.stage === 'cli'), false);
});

test('package entrypoints and PowerShell wrappers route through the same guard', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  for (const [name, action] of Object.entries({status: 'status', login: 'login', push: 'publish', 'migrate:check': 'migrate-check', 'migrate:safe': 'migrate-safe'})) assert.equal(scripts[name], `node tools/manage.mjs --action ${action}`);
  const publish = readFileSync(new URL('../../scripts/publish-serverless.ps1', import.meta.url), 'utf8');
  const login = readFileSync(new URL('../../scripts/login-serverless.ps1', import.meta.url), 'utf8');
  assert.match(publish, /'tools\/manage\.mjs' --action \$Action --app-id \$AppId/);
  assert.match(login, /'tools\/manage\.mjs' --action login/);
  for (const source of [publish, login]) assert.ok(!source.includes('bin/tgcloud.js'));
});
