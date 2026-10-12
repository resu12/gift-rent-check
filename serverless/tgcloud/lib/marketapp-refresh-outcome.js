// Fixed, validated analytics audit metadata. No sessions, proofs or revenue values.
export const MARKETAPP_REFRESH_ERROR_CODES = Object.freeze(['MARKETAPP_REFRESH_FAILED', 'MARKETAPP_REFRESH_RATE_LIMIT', 'MARKETAPP_REFRESH_EXPIRED', 'MARKETAPP_REFRESH_RECONNECT_REQUIRED',
  'MARKETAPP_REFRESH_INVALID_INPUT', 'MARKETAPP_REFRESH_PRIVATE_ACCESS_DENIED', 'MARKETAPP_REFRESH_WALLET_REQUIRED', 'MARKETAPP_REFRESH_AUTH_REJECTED', 'MARKETAPP_REFRESH_PAGE_CHANGED']);

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
