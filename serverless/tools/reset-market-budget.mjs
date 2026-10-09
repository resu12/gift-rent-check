// Explicit, private, one-off administrative action; never published as an endpoint.
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {option, requireId, validateAuthenticatedDestination} from './destination.mjs';

export function todayResetWindow(now, timeZone = 'Europe/Berlin') {
  if (!Number.isSafeInteger(now) || now <= 0 || timeZone !== 'Europe/Berlin') throw new Error('Invalid reset clock or timezone');
  const format = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
  const date = format.format(now);
  let low = now, high = now + 26 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    if (format.format(middle) === date) low = middle; else high = middle;
  }
  return {local_date: date, time_zone: timeZone, expires_at: high};
}

export const RESET_SOURCE = `
import getJobs from '../endpoints/getJobs.js';
import {createCloudRepository} from '../lib/cloud-repository.js';
import {applyMarketBudgetReset} from '../lib/market-budget.js';
import {db} from 'sdk';
export default async function(input,ctx) {
 await getJobs({},ctx);
 const repository=createCloudRepository(db);
 if(input.inspect===true)return {server_time:await repository.clock()};
 return applyMarketBudgetReset(repository,input);
}
`;

async function main() {
  const args = process.argv.slice(2);
  const appId = requireId(option(args, '--app-id'), '--app-id');
  const ownerId = requireId(option(args, '--owner-id'), '--owner-id');
  const id = option(args, '--reset-id');
  if (!args.includes('--confirm-reset-today') || !/^[a-zA-Z0-9-]{8,80}$/.test(id || '')) throw new Error('Explicit confirmation and stable --reset-id are required');
  process.env.TGCLOUD_DEBUG = '0';
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  const {resolveToken} = await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const token = await resolveToken();
  validateAuthenticatedDestination(token, appId);
  const {getFiles, runFunction} = await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  const deployed = await getFiles(token);
  if (typeof deployed.canonical_modules['lib/market-budget'] !== 'string') throw new Error('Deploy the allowance reset support first');
  const sources = {...deployed.canonical_modules, 'endpoints/adminResetMarketBudget': RESET_SOURCE};
  const context = {initData: {user: {id: Number(ownerId)}}};
  const inspected = await runFunction(token, 'endpoints/adminResetMarketBudget', sources, {inspect: true}, context);
  const window = todayResetWindow(inspected.result?.server_time);
  const result = await runFunction(token, 'endpoints/adminResetMarketBudget', sources, {id, ...window}, context);
  if (result.result?.reset !== true || result.result.reset_id !== id) throw new Error('Reset outcome unconfirmed; retry only with the same reset ID');
  console.log(JSON.stringify(result.result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {console.error('Allowance reset not confirmed. Check saved state; retry only with the same reset ID.'); process.exitCode = 1;});
}
