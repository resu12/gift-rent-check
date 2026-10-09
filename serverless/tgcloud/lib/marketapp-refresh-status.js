// Durable refresh results contain only fixed stage/status metadata. They never
// contain wallet proofs, website sessions, pages or financial values.
import {configuredAnalyticsWallet} from './personal-analytics.js';
import {MARKETAPP_REFRESH_ERROR_CODES, MarketappRefreshRequestError} from './marketapp-analytics-refresh.js';

const STATES = new Set(['awaiting_approval', 'updating', 'saved', 'failed']);
const STAGES = new Set(['prepare', 'authenticate', 'fetch_analytics', 'validate_analytics', 'save_snapshot', 'complete']);
const REASONS = new Set(['page_structure', 'wallet_identity', 'request_parameters', 'analytics_shape', 'period_span']);
const FIELDS = ['version', 'flow', 'state', 'stage', 'code', 'observed_at', 'period_days', 'authenticated', 'analytics_refreshed', 'diagnostic_reason', 'snapshot_fingerprint'];
export function safeMarketappRefreshOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key)) ||
      value.version !== 1 || value.flow !== 'analytics_refresh' || !STATES.has(value.state) || !STAGES.has(value.stage) ||
      ![30, 365].includes(value.period_days) || typeof value.authenticated !== 'boolean' || typeof value.analytics_refreshed !== 'boolean' ||
      typeof value.observed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observed_at) ||
      !Number.isFinite(Date.parse(value.observed_at)) || new Date(value.observed_at).toISOString() !== value.observed_at ||
      (value.state === 'failed' ? !MARKETAPP_REFRESH_ERROR_CODES.includes(value.code) : value.code !== null) ||
      (value.state === 'saved' ? value.stage !== 'complete' || !value.authenticated || !value.analytics_refreshed : value.analytics_refreshed || value.stage === 'complete') ||
      (value.state === 'awaiting_approval' && (value.stage !== 'prepare' || value.authenticated)) ||
      (value.state === 'updating' && value.stage === 'prepare') ||
      (value.stage === 'prepare' && value.authenticated) ||
      (['fetch_analytics', 'validate_analytics', 'save_snapshot'].includes(value.stage) && !value.authenticated) ||
      (value.snapshot_fingerprint !== undefined && (!['save_snapshot', 'complete'].includes(value.stage) ||
        typeof value.snapshot_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.snapshot_fingerprint))) ||
      (value.state === 'saved' && value.snapshot_fingerprint === undefined) ||
      (value.diagnostic_reason !== undefined && (value.state !== 'failed' || value.stage !== 'validate_analytics' || !REASONS.has(value.diagnostic_reason)))) return null;
  return Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

export function createMarketappRefreshStatusEngine({repository, ownerTelegramId, clock = () => repository.clock()}) {
  return {
    async getMarketappAnalyticsRefreshStatus(ctx, input = {}) {
      const owner = String(ownerTelegramId ?? '');
      if (!/^[1-9]\d*$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new MarketappRefreshRequestError('MARKETAPP_REFRESH_INVALID_INPUT');
      const wallet = configuredAnalyticsWallet(await (typeof repository.analyticsWalletRecords === 'function'
        ? repository.analyticsWalletRecords() : repository.records()));
      if (!wallet) return {attempt: null};
      const row = await repository.latestMarketappRefreshAttempt(owner, wallet);
      if (!row) return {attempt: null};
      let outcome;
      try {outcome = safeMarketappRefreshOutcome(JSON.parse(row.outcome_json));} catch { /* Invalid metadata has no status. */ }
      if (!outcome || !/^[0-9a-f]{64}$/.test(row.attempt_id)) return {attempt: null};
      const at = await clock();
      if (!Number.isSafeInteger(at) || at <= 0) throw new MarketappRefreshRequestError();
      const observed = Date.parse(outcome.observed_at);
      let state = outcome.state, code = outcome.code, updatedAt = outcome.observed_at;
      // Snapshot insertion may commit before the final audit update. Confirm
      // the exact planned snapshot rather than mistaking this crash gap for a
      // failed refresh or treating consumption as proof of success.
      if (outcome.snapshot_fingerprint && typeof row.saved_at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.saved_at) &&
          Number.isFinite(Date.parse(row.saved_at)) && new Date(row.saved_at).toISOString() === row.saved_at) {
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
        updated_at: updatedAt, ...(state === 'failed' ? {error_code: code} : {})}};
    },
  };
}
