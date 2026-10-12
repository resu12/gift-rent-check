// An unavailable supplementary lookup is not contrary rental-state evidence.
// Only the trusted gift-refresh wrapper can attach the matching website date.
const REQUEST_FAILURES = new Set(['retry_exhausted', 'network_error', 'request_timeout', 'transient_http',
  'http_error', 'unexpected_redirect', 'invalid_response', 'response_too_large', 'invalid_retry_after']);
const IDENTITY_FIELDS = ['owner', 'observed_owner', 'holding_contract', 'nft_last_transaction_lt',
  'account_last_transaction_lt', 'code_hash', 'data_hash', 'marketplace', 'role', 'status', 'renter', 'counterpart'];

export function isOperationalStatusFailure(row) {
  return row?.verified === false && row.rental_state === 'unknown' && REQUEST_FAILURES.has(row.reason)
    && IDENTITY_FIELDS.every(key => row[key] === null || row[key] === undefined);
}

export function isSupplementaryExpiryFailure(row) {
  return row?.check_purpose === 'rental_expiry' && row.status_fallback_allowed === true
    && typeof row.personal_status_observed_at === 'string' && isOperationalStatusFailure(row);
}
