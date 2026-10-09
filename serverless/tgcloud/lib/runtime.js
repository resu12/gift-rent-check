import {db, fetch, EndpointError} from 'sdk';
import {createEngine} from './engine.js';
import {createRepository} from './repository.js';
import {ownerTelegramId, marketappToken} from './private-config.js';
import {createCloudRepository} from './cloud-repository.js';
import {createCloudEngine, CloudRequestError} from './cloud-engine.js';
import {createOwnedPriceEngine, OwnedPriceRequestError} from './owned-price-engine.js';
import {createMarketappLoginEngine, marketappLoginErrorResponse} from './marketapp-login.js';
import {marketappRefreshKey} from './private-refresh-key.js';
import {createMarketappSessionBox} from './marketapp-session-box.js';
import {createMarketappAnalyticsRefreshEngine, marketappRefreshErrorResponse} from './marketapp-analytics-refresh.js';
import {createMarketappRefreshStatusEngine} from './marketapp-refresh-status.js';

const prototype = createEngine({repository: createRepository(db), fetch, ownerTelegramId, marketappToken});
const cloudRepository = createCloudRepository(db);
export const cloud = createCloudEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch, ownerTelegramId, marketappToken, ownedPriceRefresh: true});
export const ownedPrices = createOwnedPriceEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch, ownerTelegramId});
export const marketappLogin = createMarketappLoginEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch, ownerTelegramId});
export const marketappAnalytics = createMarketappAnalyticsRefreshEngine({repository: cloudRepository, clock: () => cloudRepository.clock(), fetch, ownerTelegramId, sessionBox: createMarketappSessionBox(marketappRefreshKey)});
const marketappRefreshStatus = createMarketappRefreshStatusEngine({repository: cloudRepository, ownerTelegramId, clock: () => cloudRepository.clock()});
// Preserve read-only access to prototype evidence. Provider collection now has
// one authoritative rate ledger; old entrypoints cannot bypass the new limits.
const upgraded = async ctx => {await prototype.getState(ctx); throw new EndpointError('The pricing dashboard replaced prototype collection. Refresh the Mini App and use its collection controls.');};
export const engine = {...prototype, startRun: upgraded, stepRun: upgraded, resumeRun: upgraded};
export async function invokeCloud(name, input, ctx) {
  try {return await cloud[name](ctx, input);}
  catch (error) {
    if (error instanceof CloudRequestError) throw new EndpointError(error.message);
    // Database/runtime details stay in private logs; provider errors never
    // arrive here because the collector translates them into saved job states.
    throw new Error('The private dashboard request could not be completed.');
  }
}
export async function invokeOwnedPrice(name, input, ctx) {
  try {return await ownedPrices[name](ctx, input);}
  catch (error) {
    if (error instanceof OwnedPriceRequestError) throw new EndpointError(error.message);
    throw new Error('The private rent-price check could not be completed.');
  }
}
export async function invokeMarketappLogin(name, input, ctx) {
  try {return await marketappLogin[name](ctx, input);}
  catch (error) {return marketappLoginErrorResponse(error);}
}
export async function invokeMarketappAnalytics(name, input, ctx) {
  try {return await marketappAnalytics[name](ctx, input);}
  catch (error) {return marketappRefreshErrorResponse(error);}
}
export async function invokeMarketappRefreshStatus(input, ctx) {
  try {return await marketappRefreshStatus.getMarketappAnalyticsRefreshStatus(ctx, input);}
  catch (error) {return marketappRefreshErrorResponse(error);}
}
