// Durable refresh results contain only fixed stage/status metadata. They never
// contain wallet proofs, website sessions, pages or financial values.
import {configuredAnalyticsWallet} from './personal-analytics.js';
import {MarketappRefreshRequestError} from './marketapp-analytics-refresh.js';

import {safeMarketappRefreshOutcome} from './marketapp-refresh-outcome.js';
export {safeMarketappRefreshOutcome} from './marketapp-refresh-outcome.js';

export function createMarketappRefreshStatusEngine({repository, ownerTelegramId, clock = () => repository.clock(), sessionStatus = null}) {
  return {
    async getMarketappAnalyticsRefreshStatus(ctx, input = {}) {
      const owner = String(ownerTelegramId ?? '');
      if (!/^[1-9]\d*$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_INVALID_INPUT');
      const connection = sessionStatus ? {session: await sessionStatus(ctx)} : {};
      const wallet = configuredAnalyticsWallet(await (typeof repository.analyticsWalletRecords === 'function'
        ? repository.analyticsWalletRecords() : repository.records()));
      if (!wallet) return {attempt: null, ...connection};
      const row = await repository.latestMarketappRefreshAttempt(owner, wallet);
      if (!row) return {attempt: null, ...connection};
      let outcome;
      try {outcome = safeMarketappRefreshOutcome(JSON.parse(row.outcome_json));} catch { /* Invalid metadata has no status. */ }
      if (!outcome || !/^[0-9a-f]{64}$/.test(row.attempt_id)) return {attempt: null, ...connection};
      const at = await clock();
      if (!Number.isSafeInteger(at) || at <= 0) throw new MarketappRefreshRequestError();
      const observed = Date.parse(outcome.observed_at);
      let state = outcome.state, code = outcome.code, updatedAt = outcome.observed_at;
      // Snapshot insertion may commit before the final audit update. Confirm
      // the exact planned snapshot rather than mistaking this crash gap for a
      // failed refresh or treating consumption as proof of success.
      if (outcome.snapshot_fingerprint && typeof row.saved_at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.saved_at) &&
          Number.isFinite(Date.parse(row.saved_at)) && new Date(row.saved_at).toISOString() === row.saved_at &&
          (outcome.state === 'saved' || Date.parse(row.saved_at) >= observed)) {
        state = 'saved'; code = null; updatedAt = row.saved_at;
      } else if (state === 'saved') {state = 'failed'; code = 'MARKETAPP_REFRESH_FAILED';}
      if (state === 'awaiting_approval') {
        if (row.state === 'cancelled') state = 'cancelled';
        else if (at >= row.expires_at) state = 'expired';
        // The proof was consumed but the process stopped before its next audit
        // write. Consumption alone never implies authentication or a save.
        else if (row.state === 'consumed') state = 'updating';
      }
      if (state === 'updating' && (at >= row.expires_at || outcome.state === 'updating' && at - observed >= 120000)) {
        state = 'failed'; code = 'MARKETAPP_REFRESH_FAILED';
      }
      return {attempt: {attempt_id: row.attempt_id, state, period_days: outcome.period_days,
        updated_at: updatedAt, ...(state === 'failed' ? {error_code: code} : {})}, ...connection};
    },
  };
}
