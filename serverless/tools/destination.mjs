// Explicit destination checks shared by administrative tools. These helpers do
// not read credentials, environment files, or make network requests.
const OFFICIAL_API = 'https://cloud.telegram.org';

export function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (args.lastIndexOf(name) !== index || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Supply one value for ${name}`);
  return args[index + 1];
}

export function requireId(value, flag) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value) throw new Error(`Supply ${flag} with a positive numeric Telegram ID`);
  return value;
}

export function validateAuthenticatedDestination(token, appId, env = process.env) {
  requireId(appId, '--app-id');
  const match = typeof token === 'string' ? /^app([1-9][0-9]*):[A-Za-z0-9_-]+$/.exec(token) : null;
  if (!match || match[0] !== token || match[1] !== appId) throw new Error('The saved login does not match the explicit Telegram app ID');
  if (env.TG_CLOUD_API_URL && env.TG_CLOUD_API_URL !== OFFICIAL_API) throw new Error('Administrative tools require the official Telegram cloud API');
  if (env.TGCLOUD_BETA && env.TGCLOUD_BETA !== '0') throw new Error('Administrative tools require the production Telegram app');
}
