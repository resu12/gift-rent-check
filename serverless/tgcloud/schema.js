import {table, integer, text, index} from 'sdk/db';
export const collectorState = table('collector_state', {id: integer('id').primaryKey(), revision: integer('revision').notNull().default(0), document: text('document').notNull()});
// Append-only commits preserve the prototype table and publish page evidence,
// normalized records, and its next checkpoint in one SQLite statement.
export const cloudEvents = table('cloud_events', {
  sequence: integer('sequence').primaryKey(),
  eventKey: text('event_key').notNull(),
  stateJson: text('state_json').notNull(),
  jobId: integer('job_id'),
  jobJson: text('job_json'),
  recordsJson: text('records_json').notNull(),
  rawBody: text('raw_body'),
  observedAt: text('observed_at').notNull(),
}, t => ({jobIndex: index('cloud_events_job_idx').on(t.jobId), keyIndex: index('cloud_events_key_idx').on(t.eventKey)}));
// Additive, immutable personal snapshots stay separate from market collection,
// pricing records and request budgets. Raw bodies contain no website session.
export const personalRentalAnalytics = table('personal_rental_analytics', {
  fingerprint: text('fingerprint').primaryKey(),
  wallet: text('wallet').notNull(),
  capturedAt: text('captured_at').notNull(),
  importedAt: text('imported_at').notNull(),
  rawSnapshot: text('raw_snapshot').notNull(),
  normalizedJson: text('normalized_json').notNull(),
}, t => ({walletIndex: index('personal_rental_analytics_wallet_idx').on(t.wallet, t.capturedAt)}));
// One newest observation per UTC date survives rolling snapshot retention.
export const personalAnalyticsDaily = table('personal_analytics_daily', {
  rowId: text('row_id').primaryKey(), wallet: text('wallet').notNull(), date: text('date').notNull(),
  capturedAt: text('captured_at').notNull(), fingerprint: text('fingerprint').notNull(),
  rentVolume: text('rent_volume').notNull(), newRentals: integer('new_rentals').notNull(), extensions: integer('extensions').notNull(),
}, t => ({walletIndex: index('personal_analytics_daily_wallet_idx').on(t.wallet, t.date)}));
// Compact per-gift report intervals survive rolling report cleanup. Missing
// gifts in a later Top items table never erase an earlier observation.
export const personalAnalyticsItemReports = table('personal_analytics_item_reports', {
  rowId: text('row_id').primaryKey(), wallet: text('wallet').notNull(), itemKey: text('item_key').notNull(),
  periodStart: text('period_start').notNull(), periodEnd: text('period_end').notNull(),
  capturedAt: text('captured_at').notNull(), fingerprint: text('fingerprint').notNull(), itemJson: text('item_json').notNull(),
}, t => ({walletIndex: index('personal_analytics_items_wallet_idx').on(t.wallet, t.rowId)}));
export const personalAnalyticsCollectionReports = table('personal_analytics_collection_reports', {
  rowId: text('row_id').primaryKey(), wallet: text('wallet').notNull(), collectionKey: text('collection_key').notNull(),
  periodStart: text('period_start').notNull(), periodEnd: text('period_end').notNull(),
  capturedAt: text('captured_at').notNull(), fingerprint: text('fingerprint').notNull(), itemJson: text('item_json').notNull(),
}, t => ({walletIndex: index('personal_analytics_collections_wallet_idx').on(t.wallet, t.rowId)}));
// Short-lived compatibility/refresh attempts contain no cookie, account proof or
// signature. They remain independent of collection and personal snapshots.
export const marketappLoginAttempts = table('marketapp_login_attempts', {
  attemptId: text('attempt_id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  wallet: text('wallet').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  state: text('state').notNull(),
  nonceFingerprint: text('nonce_fingerprint'),
  // Fixed compatibility checks or refresh stages, observation times and an
  // internal snapshot link. Existing NULL outcomes are never inferred.
  outcomeJson: text('outcome_json'),
}, t => ({ownerIndex: index('marketapp_login_attempts_owner_idx').on(t.ownerId, t.createdAt)}));
// Private encrypted website login. Logout keeps this row and its nonce counter
// forever: deleting/resetting counters would risk nonce reuse after rotation.
export const marketappAnalyticsSessions = table('marketapp_analytics_sessions', {
  ownerId: text('owner_id').primaryKey(),
  generation: integer('generation').notNull().default(0),
  nonceCounter: integer('nonce_counter').notNull().default(0),
  cookieVersion: integer('cookie_version').notNull().default(0),
  wallet: text('wallet'),
  walletRevision: integer('wallet_revision'),
  ciphertext: text('ciphertext'),
  createdAt: integer('created_at'),
  expiresAt: integer('expires_at'),
});
// Website sessions share one durable lease per account across analytics and
// personal gifts. The tiny rolling request ledger survives logout/reconnect.
export const marketappWebsiteGates = table('marketapp_website_gates', {
  scopeKey: text('scope_key').primaryKey(), leaseId: text('lease_id'),
  leaseUntil: integer('lease_until').notNull().default(0), nextAllowedAt: integer('next_allowed_at').notNull().default(0),
});
export const marketappWebsiteRequests = table('marketapp_website_requests', {
  requestId: text('request_id').primaryKey(), scopeKey: text('scope_key').notNull(), attemptedAt: integer('attempted_at').notNull(),
}, t => ({scopeIndex:index('marketapp_website_requests_scope_idx').on(t.scopeKey,t.attemptedAt), timeIndex:index('marketapp_website_requests_time_idx').on(t.attemptedAt)}));
// Recoverable indexes over committed events keep page-session replay protection
// and old run results out of the frequently copied active checkpoint. These
// rows have no retention expiry; raw historical events remain unchanged.
export const ownedRefreshRuns = table('owned_refresh_runs', {
  runId: integer('run_id').primaryKey(),
  summaryJson: text('summary_json').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
});
export const ownedRefreshSessions = table('owned_refresh_sessions', {
  sessionId: text('session_id').primaryKey(),
  runId: integer('run_id').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
});
export const ownedRefreshIndex = table('owned_refresh_index', {
  id: integer('id').primaryKey(),
  sequence: integer('sequence').notNull().default(0),
});
// Replaceable projections are capped to 16 selections/16 MiB total, with
// 256 KiB content-addressed pieces. Financial source records stay immutable.
export const dashboardProjectionCache = table('dashboard_projection_cache', {
  selectionKey: text('selection_key').primaryKey(),
  recordsRevision: integer('records_revision').notNull(),
  timeBucket: integer('time_bucket').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
});

// Public mode uses additive tables only. A retained account tombstone fences
// in-flight work; credential/session nonce counters are never deleted or reset.
export const publicAccounts = table('public_accounts', {
  userId: text('user_id').primaryKey(),
  generation: integer('generation').notNull().default(0),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
  walletNonceCounter: integer('wallet_nonce_counter').notNull().default(0),
});
export const publicProviderCredentials = table('public_provider_credentials', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), provider: text('provider').notNull(),
  generation: integer('generation').notNull().default(0), nonceCounter: integer('nonce_counter').notNull().default(0),
  credentialVersion: integer('credential_version').notNull().default(0), ciphertext: text('ciphertext'),
  credentialFingerprint: text('credential_fingerprint'), createdAt: integer('created_at'), updatedAt: integer('updated_at'),
}, t => ({userIndex: index('public_credentials_user_idx').on(t.userId, t.provider)}));
// Preserved-owner API settings stay separate from public account provisioning.
// Clearing retains nonce/version counters and permanently disables bootstrap
// fallback for this owner until another encrypted key is explicitly saved.
export const privateProviderCredentials = table('private_provider_credentials', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), provider: text('provider').notNull(),
  generation: integer('generation').notNull().default(0), nonceCounter: integer('nonce_counter').notNull().default(0),
  credentialVersion: integer('credential_version').notNull().default(0), ciphertext: text('ciphertext'),
  credentialFingerprint: text('credential_fingerprint'), createdAt: integer('created_at'), updatedAt: integer('updated_at'),
});
// Provider/account-wide request ledgers survive credential replacement and
// account deletion. scope_key contains only a keyed digest or fixed scope.
export const publicProviderGates = table('public_provider_gates', {
  scopeKey: text('scope_key').primaryKey(), revision: integer('revision').notNull().default(0), document: text('document').notNull(),
});
export const publicCloudEvents = table('public_cloud_events', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), sequence: integer('sequence').notNull(),
  eventKey: text('event_key').notNull(), stateJson: text('state_json').notNull(), jobId: integer('job_id'),
  jobJson: text('job_json'), recordsJson: text('records_json').notNull(), rawBody: text('raw_body'), observedAt: text('observed_at').notNull(),
}, t => ({sequenceIndex: index('public_events_sequence_idx').on(t.userId, t.sequence),
  jobIndex: index('public_events_job_idx').on(t.userId, t.jobId), keyIndex: index('public_events_key_idx').on(t.userId, t.eventKey)}));
export const publicPersonalRentalAnalytics = table('public_personal_rental_analytics', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), fingerprint: text('fingerprint').notNull(),
  wallet: text('wallet').notNull(), capturedAt: text('captured_at').notNull(), importedAt: text('imported_at').notNull(),
  rawSnapshot: text('raw_snapshot').notNull(), normalizedJson: text('normalized_json').notNull(),
}, t => ({walletIndex: index('public_analytics_wallet_idx').on(t.userId, t.wallet, t.capturedAt)}));
export const publicPersonalAnalyticsDaily = table('public_personal_analytics_daily', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), wallet: text('wallet').notNull(), date: text('date').notNull(),
  capturedAt: text('captured_at').notNull(), fingerprint: text('fingerprint').notNull(),
  rentVolume: text('rent_volume').notNull(), newRentals: integer('new_rentals').notNull(), extensions: integer('extensions').notNull(),
}, t => ({walletIndex: index('public_analytics_daily_wallet_idx').on(t.userId, t.wallet, t.date)}));
export const publicPersonalAnalyticsItemReports = table('public_personal_analytics_item_reports', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), wallet: text('wallet').notNull(), itemKey: text('item_key').notNull(),
  periodStart: text('period_start').notNull(), periodEnd: text('period_end').notNull(),
  capturedAt: text('captured_at').notNull(), fingerprint: text('fingerprint').notNull(), itemJson: text('item_json').notNull(),
}, t => ({walletIndex: index('public_analytics_items_wallet_idx').on(t.userId, t.wallet, t.rowId)}));
export const publicPersonalAnalyticsCollectionReports = table('public_personal_analytics_collection_reports', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), wallet: text('wallet').notNull(), collectionKey: text('collection_key').notNull(),
  periodStart: text('period_start').notNull(), periodEnd: text('period_end').notNull(),
  capturedAt: text('captured_at').notNull(), fingerprint: text('fingerprint').notNull(), itemJson: text('item_json').notNull(),
}, t => ({walletIndex: index('public_analytics_collections_wallet_idx').on(t.userId, t.wallet, t.rowId)}));
export const publicMarketappLoginAttempts = table('public_marketapp_login_attempts', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), attemptId: text('attempt_id').notNull(),
  ownerId: text('owner_id').notNull(), wallet: text('wallet').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), state: text('state').notNull(), nonceFingerprint: text('nonce_fingerprint'), outcomeJson: text('outcome_json'),
}, t => ({ownerIndex: index('public_login_owner_idx').on(t.userId, t.createdAt)}));
export const publicMarketappAnalyticsSessions = table('public_marketapp_analytics_sessions', {
  ownerId: text('owner_id').primaryKey(), generation: integer('generation').notNull().default(0),
  nonceCounter: integer('nonce_counter').notNull().default(0), cookieVersion: integer('cookie_version').notNull().default(0),
  wallet: text('wallet'), walletRevision: integer('wallet_revision'), ciphertext: text('ciphertext'), createdAt: integer('created_at'), expiresAt: integer('expires_at'),
});
export const publicOwnedRefreshRuns = table('public_owned_refresh_runs', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), runId: integer('run_id').notNull(),
  summaryJson: text('summary_json').notNull(), sourceSequence: integer('source_sequence').notNull(),
}, t => ({runIndex: index('public_owned_runs_idx').on(t.userId, t.runId)}));
export const publicOwnedRefreshSessions = table('public_owned_refresh_sessions', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), sessionId: text('session_id').notNull(),
  runId: integer('run_id').notNull(), sourceSequence: integer('source_sequence').notNull(),
}, t => ({sessionIndex: index('public_owned_sessions_idx').on(t.userId, t.sessionId)}));
export const publicOwnedRefreshIndex = table('public_owned_refresh_index', {
  userId: text('user_id').primaryKey(), sequence: integer('sequence').notNull().default(0),
});
export const publicDashboardProjectionCache = table('public_dashboard_projection_cache', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), selectionKey: text('selection_key').notNull(),
  recordsRevision: integer('records_revision').notNull(), timeBucket: integer('time_bucket').notNull(), snapshotJson: text('snapshot_json').notNull(),
}, t => ({selectionIndex: index('public_cache_selection_idx').on(t.userId, t.selectionKey)}));
export const publicWalletChallenges = table('public_wallet_challenges', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), challengeId: text('challenge_id').notNull(),
  generation: integer('generation').notNull(), payload: text('payload').notNull(), domain: text('domain').notNull(),
  walletDisconnectRevision: integer('wallet_disconnect_revision').notNull().default(0),
  wallet: text('wallet'), createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(), consumedAt: integer('consumed_at'),
}, t => ({challengeIndex: index('public_wallet_challenges_idx').on(t.userId, t.challengeId)}));
export const publicWalletAttempts = table('public_wallet_attempts', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), createdAt: integer('created_at').notNull(),
}, t => ({attemptIndex: index('public_wallet_attempts_idx').on(t.userId, t.createdAt)}));
export const publicLegacyMigrations = table('public_legacy_migrations', {
  userId: text('user_id').primaryKey(), boundary: integer('boundary').notNull(), sequence: integer('sequence').notNull().default(0),
  status: text('status').notNull(), createdAt: integer('created_at').notNull(),
  generation: integer('generation'), sourceSnapshotJson: text('source_snapshot_json'),
});
export const publicLegacyCollectorState = table('public_legacy_collector_state', {
  userId: text('user_id').primaryKey(), document: text('document').notNull(),
});
// Tiny service metadata stays separate from source evidence. Byte counters are
// maintained by atomic SQLite triggers installed by the guarded owner tool.
// Zero initialized_at means collection must wait for accounting bootstrap.
export const serviceStorageUsage = table('service_storage_usage', {
  id: integer('id').primaryKey(), totalBytes: integer('total_bytes').notNull().default(0),
  initializedAt: integer('initialized_at').notNull().default(0),
});
export const serviceStorageScopeUsage = table('service_storage_scope_usage', {
  scope: text('scope').primaryKey(), totalBytes: integer('total_bytes').notNull().default(0),
  initializedAt: integer('initialized_at').notNull().default(0),
});
export const serviceStorageMonitor = table('service_storage_monitor', {
  id: integer('id').primaryKey(), document: text('document').notNull().default('{}'),
  leaseId: text('lease_id'), leaseUntil: integer('lease_until').notNull().default(0),
});
export const serviceStorageReservations = table('service_storage_reservations', {
  token: text('token').primaryKey(), scope: text('scope').notNull(), bytes: integer('bytes').notNull(),
  expiresAt: integer('expires_at').notNull(), kind: text('kind').notNull(),
}, t => ({expiryIndex: index('service_storage_reservations_expiry_idx').on(t.expiresAt),
  scopeIndex: index('service_storage_reservations_scope_idx').on(t.scope, t.expiresAt)}));
// Monotonic source pins avoid repeatedly reading historical JSON to discover
// reference roots. These tiny safety records are retained during cleanup.
export const serviceCheckpointSources = table('service_checkpoint_sources', {
  rowId: text('row_id').primaryKey(), scope: text('scope').notNull(), kind: text('kind').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
}, t => ({sourceIndex: index('service_checkpoint_sources_lookup_idx').on(t.scope, t.kind, t.sourceSequence)}));
export const serviceCheckpointSourceScans = table('service_checkpoint_source_scans', {
  scope: text('scope').primaryKey(), afterSequence: integer('after_sequence').notNull().default(0),
  boundarySequence: integer('boundary_sequence').notNull().default(0), initializedAt: integer('initialized_at').notNull().default(0),
});
// Compact storage keeps a full market fact once and immutable dated references
// to it. Scope is private or public:<user>; IDs also fence account generations.
export const serviceRecordPayloads = table('service_record_payloads', {
  payloadId: text('payload_id').primaryKey(), scope: text('scope').notNull(), document: text('document').notNull(),
}, t => ({scopeIndex: index('service_record_payloads_scope_idx').on(t.scope)}));
export const serviceRecordOccurrences = table('service_record_occurrences', {
  occurrenceId: text('occurrence_id').primaryKey(), scope: text('scope').notNull(), sequence: integer('sequence').notNull(),
  ordinal: integer('ordinal').notNull(), eventKey: text('event_key').notNull(), observedAt: text('observed_at'),
  payloadId: text('payload_id').notNull(), envelopeJson: text('envelope_json').notNull(),
}, t => ({sequenceIndex: index('service_record_occurrences_sequence_idx').on(t.scope, t.sequence, t.ordinal),
  payloadIndex: index('service_record_occurrences_payload_idx').on(t.payloadId),
  eventIndex: index('service_record_occurrences_event_idx').on(t.scope, t.eventKey)}));
// Disposable event selectors, never a copy of financial or portfolio data.
// Administrative installation adds seek indexes only after bounded backfill.
export const serviceRecordInlineEvents = table('service_record_inline_events', {
  rowId: text('row_id').primaryKey(), scope: text('scope').notNull(), generation: integer('generation').notNull(),
  sequence: integer('sequence').notNull(), hasSeed: integer('has_seed').notNull(),
});
export const giftRefreshRuns = table('gift_refresh_runs', {
  runId: integer('run_id').primaryKey(), summaryJson: text('summary_json').notNull(), sourceSequence: integer('source_sequence').notNull(),
});
export const publicGiftRefreshRuns = table('public_gift_refresh_runs', {
  rowId: text('row_id').primaryKey(), userId: text('user_id').notNull(), runId: integer('run_id').notNull(),
  summaryJson: text('summary_json').notNull(), sourceSequence: integer('source_sequence').notNull(),
}, t => ({runIndex: index('public_gift_runs_idx').on(t.userId, t.runId)}));
