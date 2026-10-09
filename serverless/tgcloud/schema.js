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
