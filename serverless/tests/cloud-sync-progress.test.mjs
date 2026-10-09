import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudSyncProgress} from '../tgcloud/lib/cloud-engine.js';

const scope = `0:${'ab'.repeat(32)}`, other = `0:${'cd'.repeat(32)}`;
const stream = (kind, scope = null, complete = false, extra = {}) => ({kind, scope, complete, ...extra});
const job = (streams, extra = {}) => ({streams, market_observations: 0, scope_names: {[scope]: 'Low Riders', [other]: 'Timeless Books'}, ...extra});

test('a collection completes only after all its listing and rental streams complete', () => {
  const value = job([stream('collection', null, true), stream('listing', scope), stream('history', scope), stream('listing', other), stream('history', other)]);
  assert.deepEqual(cloudSyncProgress(value), {phase: 'listings', completed: 0, total: 2, unit: 'collections', current_collection: 'Low Riders', processed_items: 0});
  value.streams[1].complete = true;
  assert.equal(cloudSyncProgress(value).phase, 'rentals');
  assert.equal(cloudSyncProgress(value).completed, 0);
  value.streams[2].complete = true;
  assert.deepEqual(cloudSyncProgress(value), {phase: 'listings', completed: 1, total: 2, unit: 'collections', current_collection: 'Timeless Books', processed_items: 0});
  value.streams[3].complete = value.streams[4].complete = true;
  assert.deepEqual(cloudSyncProgress(value), {phase: 'complete', completed: 2, total: 2, unit: 'collections', current_collection: null, processed_items: 0});
});

test('all cached scopes remain at zero while the catalog is still pending', () => {
  const value = job([stream('collection'), stream('listing', scope, true, {completion_reason: 'shared_market_cache'}), stream('history', scope, true, {completion_reason: 'shared_market_cache'})]);
  assert.deepEqual(cloudSyncProgress(value), {phase: 'preparing', completed: 0, total: 1, unit: 'collections', current_collection: null, processed_items: 0});
  value.streams[0].complete = true;
  assert.equal(cloudSyncProgress(value).phase, 'complete');
  assert.equal(cloudSyncProgress(value).completed, 1);
});

test('pages and retries do not create a percentage before a collection is complete', () => {
  const value = job([stream('collection', null, true), stream('history', scope, false, {pages: 100, retry: 3})], {market_observations: 4500});
  assert.deepEqual(cloudSyncProgress(value), {phase: 'rentals', completed: 0, total: 1, unit: 'collections', current_collection: 'Low Riders', processed_items: 4500});
});

test('legacy jobs have accurate collection progress without inventing names or counting catalog rows', () => {
  const value = {streams: [stream('collection', null, true), stream('listing', scope), stream('listing', other, true)], observations: 99};
  assert.deepEqual(cloudSyncProgress(value), {phase: 'listings', completed: 1, total: 2, unit: 'collections', current_collection: null, processed_items: 0});
});

test('unfiltered work has no known collection denominator and empty completed work stays explicit', () => {
  assert.deepEqual(cloudSyncProgress(job([stream('collection', null, true), stream('listing')])),
    {phase: 'listings', completed: 0, total: null, unit: 'collections', current_collection: null, processed_items: 0});
  assert.deepEqual(cloudSyncProgress(job([stream('collection', null, true)])),
    {phase: 'complete', completed: 0, total: 0, unit: 'collections', current_collection: null, processed_items: 0});
});

test('a blank saved name does not fall back to a wallet or collection address', () => {
  assert.equal(cloudSyncProgress(job([stream('listing', scope)], {scope_names: {[scope]: '   '}})).current_collection, null);
});
