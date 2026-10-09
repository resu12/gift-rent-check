import {addressKey} from './cloud-pricing-core.js';

export const COLLECTION_SCHEDULE_VERSION = 1;

export function newCollectionSchedule(streams) {
  const groups = new Map();
  streams.forEach((stream, index) => {
    if (stream.kind === 'collection') return;
    const scope = addressKey(stream.scope);
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(index);
  });
  // Visit every collection before a second kind/page from the same collection.
  const order = [], rounds = Math.max(0, ...[...groups.values()].map(indexes => indexes.length));
  for (let round = 0; round < rounds; round++) for (const indexes of groups.values()) if (round < indexes.length) order.push(indexes[round]);
  return {version: COLLECTION_SCHEDULE_VERSION, mode: 'round_robin', order, next_index: 0};
}

export function validCollectionSchedule(job) {
  if (!Object.hasOwn(job, 'schedule')) return true; // Saved legacy traversal.
  const schedule = job.schedule;
  if (!schedule || schedule.version !== COLLECTION_SCHEDULE_VERSION || schedule.mode !== 'round_robin' || !Array.isArray(schedule.order)
    || !Number.isSafeInteger(schedule.next_index) || schedule.next_index < 0 || schedule.next_index >= Math.max(1, schedule.order.length)) return false;
  const expected = newCollectionSchedule(job.streams).order;
  return expected.length === schedule.order.length && schedule.order.every((index, position) => index === expected[position]);
}

export function nextCollectionStream(job) {
  // Read-only progress can still describe a malformed job. Mutations validate
  // its schedule before making a request, rather than silently replacing it.
  if (!job.schedule || !validCollectionSchedule(job)) return job.streams.findIndex(stream => !stream.complete);
  const catalog = job.streams.findIndex(stream => stream.kind === 'collection' && !stream.complete);
  if (catalog >= 0) return catalog;
  const {order, next_index: next} = job.schedule;
  for (let offset = 0; offset < order.length; offset++) {
    const index = order[(next + offset) % order.length];
    if (!job.streams[index].complete) return index;
  }
  return -1;
}

export function commitCollectionTurn(job, streamIndex) {
  if (!job.schedule || job.streams[streamIndex].kind === 'collection') return;
  const position = job.schedule.order.indexOf(streamIndex);
  job.schedule.next_index = (position + 1) % job.schedule.order.length;
}

export function collectionEfficiency(job) {
  const groups = new Map();
  for (const stream of job.streams) {
    if (stream.kind === 'collection') continue;
    const key = addressKey(stream.scope);
    if (!groups.has(key)) groups.set(key, false);
    if (stream.started || stream.cache_source) groups.set(key, true);
  }
  return {
    page_size: job.page_size, recommended_page_size: 100,
    scheduling: job.schedule?.mode === 'round_robin' ? 'round_robin' : 'sequential',
    collections_started: [...groups.values()].filter(Boolean).length, collections_total: groups.size,
  };
}
