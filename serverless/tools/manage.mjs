// Guarded entrypoint for the pinned CLI. Validate before importing CLI modules:
// its API URL is captured at import time and even status can make requests.
import {existsSync, lstatSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {option, requireId, validateAuthenticatedDestination, validateServerlessEnvironment} from './destination.mjs';

const commands = {
  status: ['status'],
  publish: ['push', 'tgcloud/schema.js', 'tgcloud/lib/', 'tgcloud/endpoints/', 'dist/'],
  'migrate-check': ['migrate', '--dry-run'],
  'migrate-safe': ['migrate', '--safe'],
  login: ['login'],
};
const project = fileURLToPath(new URL('../', import.meta.url));

function run(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], {cwd: project, env, stdio: 'inherit'});
  if (result.error || result.signal || result.status === null) throw new Error('The Serverless command was interrupted or could not start.');
  return result.status;
}

async function main() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--action', '--app-id'].includes(args[i])) throw new Error('Use --action and --app-id; extra CLI arguments are not forwarded.');
  }
  const action = option(args, '--action');
  if (!Object.hasOwn(commands, action)) throw new Error('Choose status, publish, migrate-check, migrate-safe, or login.');
  validateServerlessEnvironment();
  const appId = action === 'login' ? null : requireId(option(args, '--app-id'), '--app-id');
  if (action === 'login' && option(args, '--app-id') !== null) throw new Error('Login uses the token entered at its prompt. Supply --app-id when publishing or inspecting the app.');
  if (action === 'login' && process.env.TGCLOUD_TOKEN) throw new Error('Unset TGCLOUD_TOKEN before interactive login so the entered token also selects the snapshot.');

  process.env.TGCLOUD_DEBUG = '0';
  process.chdir(project);
  const cli = join(project, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
  if (!existsSync(cli)) throw new Error('Install the locked serverless dependencies first.');
  const env = {...process.env, TGCLOUD_DEBUG: '0', TG_CLOUD_API_URL: 'https://cloud.telegram.org', TGCLOUD_BETA: '0'};
  if (action === 'login') {
    delete env.TGCLOUD_TOKEN;
  } else {
    const {resolveToken} = await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
    const token = await resolveToken();
    validateAuthenticatedDestination(token, appId);
    // Pin the validated value: the child must not re-read a changed saved login.
    env.TGCLOUD_TOKEN = token;
  }

  if (action === 'publish') {
    if (!existsSync(join(project, 'dist/index.html'))) throw new Error('Build with scripts/build-serverless.ps1 first.');
    const status = run(join(project, 'tools/preflight.mjs'), [], env);
    if (status !== 0) return status;
  }
  // Prevent the CLI from finding a different project's .tgcloud in an ancestor.
  const stateDirectory = join(project, '.tgcloud');
  try {
    const state = lstatSync(stateDirectory);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('The local .tgcloud path must be an ordinary directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(stateDirectory);
  }
  return run(cli, commands[action], env);
}

main().then(status => {process.exitCode = status;}).catch(error => {
  // Only local guard messages are printed; do not echo provider error bodies.
  const safeMessages = [
    'Administrative tools require the official Telegram cloud API',
    'Administrative tools require the production Telegram app',
    'Supply --app-id with a positive numeric Telegram ID',
    'The CLI credentials do not match the explicit Telegram app ID',
    'Unset TGCLOUD_TOKEN before interactive login so the entered token also selects the snapshot.',
    'Login uses the token entered at its prompt. Supply --app-id when publishing or inspecting the app.',
    'Use --action and --app-id; extra CLI arguments are not forwarded.',
    'Choose status, publish, migrate-check, migrate-safe, or login.',
    'Install the locked serverless dependencies first.',
    'Build with scripts/build-serverless.ps1 first.',
    'The local .tgcloud path must be an ordinary directory.',
    'The Serverless command was interrupted or could not start.',
  ];
  console.error(safeMessages.includes(error?.message) ? error.message : 'Serverless command stopped before completion. No credentials were logged by the guard.');
  process.exitCode = 1;
});
