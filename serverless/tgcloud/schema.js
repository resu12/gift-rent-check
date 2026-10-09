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
