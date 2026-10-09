import test from 'node:test';
import assert from 'node:assert/strict';
import {newCollectionSchedule, nextCollectionStream, commitCollectionTurn, validCollectionSchedule, collectionEfficiency} from '../tgcloud/lib/collection-schedule.js';

const make = () => {
  const streams = [{kind: 'collection', complete: false}, {kind: 'listing', scope: 'a', complete: false}, {kind: 'history', scope: 'a', complete: false}, {kind: 'listing', scope: 'b', complete: false}, {kind: 'history', scope: 'b', complete: false}];
  return {page_size: 100, streams, schedule: newCollectionSchedule(streams)};
};

test('round robin gives catalog priority then each collection a turn across kinds', () => {
  const job = make(); assert.deepEqual(job.schedule.order, [1, 3, 2, 4]); assert.equal(nextCollectionStream(job), 0);
  job.streams[0].complete = true; const turns = [];
  for (let i = 0; i < 8; i++) {const next = nextCollectionStream(job); turns.push(next); commitCollectionTurn(job, next);}
  assert.deepEqual(turns, [1, 3, 2, 4, 1, 3, 2, 4]); assert.equal(job.streams.every(s => s.complete), false);
});

test('completed cache scopes are skipped without changing the frozen order or counting pages', () => {
  const job = make(); job.streams[0].complete = true; job.streams[1].complete = job.streams[2].complete = true; job.streams[1].cache_source = {job_id: 1};
  assert.equal(nextCollectionStream(job), 3); commitCollectionTurn(job, 3); assert.equal(nextCollectionStream(job), 4);
  assert.deepEqual(job.schedule.order, [1, 3, 2, 4]); assert.equal(collectionEfficiency(job).collections_started, 1);
  job.streams[3].complete = job.streams[4].complete = true; assert.equal(nextCollectionStream(job), -1);
});

test('invalid schedule versions, pointers, duplicate indexes and edited order are rejected', () => {
  for (const overrides of [{version: 2}, {next_index: -1}, {next_index: 4}, {order: [1, 1, 2, 4]}, {order: [1, 2, 3, 4]}, {order: [1, 3, 2]}]) {const job = make(); Object.assign(job.schedule, overrides); assert.equal(validCollectionSchedule(job), false);}
  const old = make(); delete old.schedule; assert.equal(validCollectionSchedule(old), true); old.streams[0].complete = true; assert.equal(nextCollectionStream(old), 1); commitCollectionTurn(old, 1); assert.equal(nextCollectionStream(old), 1);
});
