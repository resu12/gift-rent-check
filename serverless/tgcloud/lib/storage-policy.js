// An application safety budget, not a measurement of Telegram's physical quota.
// Payload accounting excludes SQLite pages, indexes and platform overhead.
const MiB = 1048576;
export const DEFAULT_PUBLIC_ACCOUNT_BYTES = 8 * MiB;
export const DEFAULT_STORAGE_POLICY = Object.freeze({budgetBytes: 512 * MiB, cleanupRatio: .75, warningRatio: .85,
  pauseRatio: .90, resumeRatio: .80, reserveBytes: 16 * MiB, leaseMs: 30000, inventoryFreshMs: 1800000,
  cleanupFreshMs: 21600000, batchRows: 25, duplicateWrites: 4, metadataRetentionMs: 172800000});
export function normalizeStoragePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_STORAGE_POLICY, key))) throw new Error('Invalid storage policy');
  const value = {...DEFAULT_STORAGE_POLICY, ...input};
  for (const key of ['budgetBytes','reserveBytes','leaseMs','inventoryFreshMs','cleanupFreshMs','batchRows','duplicateWrites','metadataRetentionMs'])
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error('Invalid storage policy');
  if (value.budgetBytes < 32 * MiB || value.budgetBytes > 1073741824 || value.reserveBytes >= value.budgetBytes / 4
      || value.batchRows > 100 || value.duplicateWrites > 4 || value.leaseMs < 1000 || value.leaseMs > 120000
      || value.metadataRetentionMs < 86400000 || value.metadataRetentionMs > 2592000000) throw new Error('Invalid storage policy');
  for (const key of ['cleanupRatio','warningRatio','pauseRatio','resumeRatio'])
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0 || value[key] >= 1) throw new Error('Invalid storage policy');
  if (!(value.cleanupRatio < value.resumeRatio && value.resumeRatio < value.warningRatio && value.warningRatio < value.pauseRatio)) throw new Error('Invalid storage policy');
  return Object.freeze(value);
}
export function utf8Size(value) {
  if (value === null || value === undefined) return 0;
  let length = 0;
  for (const char of String(value)) {const code = char.codePointAt(0); length += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;}
  return length;
}
const descriptor = (name, columns, tenant = null, scopeColumn = null) => Object.freeze({name, columns: Object.freeze(columns.split(' ')), tenant, scopeColumn});
// Fixed identifiers are shared by usage triggers, their bootstrap and monitoring.
// Credentials/tombstones are measured, but are NEVER maintenance deletion targets.
export const STORAGE_TABLES = Object.freeze([
  descriptor('collector_state', 'id revision document'),
  descriptor('cloud_events', 'sequence event_key state_json job_id job_json records_json raw_body observed_at'),
  descriptor('personal_rental_analytics', 'fingerprint wallet captured_at imported_at raw_snapshot normalized_json'),
  descriptor('marketapp_login_attempts', 'attempt_id owner_id wallet created_at expires_at state nonce_fingerprint outcome_json'),
  descriptor('marketapp_analytics_sessions', 'owner_id generation nonce_counter cookie_version wallet wallet_revision ciphertext created_at expires_at'),
  descriptor('marketapp_website_gates', 'scope_key lease_id lease_until next_allowed_at'),
  descriptor('marketapp_website_requests', 'request_id scope_key attempted_at'),
  descriptor('owned_refresh_runs', 'run_id summary_json source_sequence'),
  descriptor('owned_refresh_sessions', 'session_id run_id source_sequence'),
  descriptor('owned_refresh_index', 'id sequence'),
  descriptor('dashboard_projection_cache', 'selection_key records_revision time_bucket snapshot_json'),
  descriptor('private_provider_credentials', 'row_id user_id provider generation nonce_counter credential_version ciphertext credential_fingerprint created_at updated_at'),
  descriptor('public_provider_gates', 'scope_key revision document'),
  descriptor('public_accounts', 'user_id generation status created_at deleted_at wallet_nonce_counter', 'user_id'),
  descriptor('public_provider_credentials', 'row_id user_id provider generation nonce_counter credential_version ciphertext credential_fingerprint created_at updated_at', 'user_id'),
  descriptor('public_cloud_events', 'row_id user_id sequence event_key state_json job_id job_json records_json raw_body observed_at', 'user_id'),
  descriptor('public_personal_rental_analytics', 'row_id user_id fingerprint wallet captured_at imported_at raw_snapshot normalized_json', 'user_id'),
  descriptor('public_marketapp_login_attempts', 'row_id user_id attempt_id owner_id wallet created_at expires_at state nonce_fingerprint outcome_json', 'user_id'),
  descriptor('public_marketapp_analytics_sessions', 'owner_id generation nonce_counter cookie_version wallet wallet_revision ciphertext created_at expires_at', 'owner_id'),
  descriptor('public_owned_refresh_runs', 'row_id user_id run_id summary_json source_sequence', 'user_id'),
  descriptor('public_owned_refresh_sessions', 'row_id user_id session_id run_id source_sequence', 'user_id'),
  descriptor('public_owned_refresh_index', 'user_id sequence', 'user_id'),
  descriptor('public_dashboard_projection_cache', 'row_id user_id selection_key records_revision time_bucket snapshot_json', 'user_id'),
  descriptor('public_wallet_challenges', 'row_id user_id challenge_id generation payload domain wallet_disconnect_revision wallet created_at expires_at consumed_at', 'user_id'),
  descriptor('public_wallet_attempts', 'row_id user_id created_at', 'user_id'),
  descriptor('public_legacy_migrations', 'user_id boundary sequence status created_at generation source_snapshot_json', 'user_id'),
  descriptor('public_legacy_collector_state', 'user_id document', 'user_id'),
  descriptor('service_checkpoint_sources', 'row_id scope kind source_sequence', null, 'scope'),
  descriptor('service_record_payloads', 'payload_id scope document', null, 'scope'),
  descriptor('service_record_occurrences', 'occurrence_id scope sequence ordinal event_key observed_at payload_id envelope_json', null, 'scope'),
  descriptor('gift_refresh_runs', 'run_id summary_json source_sequence'),
]);
export function storageTableByteExpression(table, alias = '') {
  const entry = typeof table === 'string' ? STORAGE_TABLES.find(item => item.name === table) : table;
  if (!STORAGE_TABLES.includes(entry) || alias && !/^[A-Za-z_][A-Za-z_0-9]*\.$/.test(alias)) throw new Error('Invalid storage table');
  return entry.columns.map(column => `COALESCE(length(CAST(${alias}${column} AS BLOB)),0)`).join('+');
}
export function storagePaused(bytes, previouslyPaused, policy = DEFAULT_STORAGE_POLICY) {
  const limit = previouslyPaused ? policy.budgetBytes * policy.resumeRatio : policy.budgetBytes * policy.pauseRatio;
  return !Number.isSafeInteger(bytes) || bytes < 0 || bytes >= limit;
}
