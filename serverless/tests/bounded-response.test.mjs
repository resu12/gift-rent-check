import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchBoundedResponse, boundedRawEvidence, utf8Size} from '../tgcloud/lib/bounded-response.js';

const url = 'https://api.marketapp.org/v1/collections/gifts/';
const options = {method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error'};
const encoded = text => new TextEncoder().encode(text);
const response = (body, length = null) => ({status: 200, url, headers: {get: name => name.toLowerCase() === 'content-length' ? length : null}, body});
const stream = chunks => ({async *[Symbol.asyncIterator]() {yield* chunks;}});
const read = fetch => fetchBoundedResponse(fetch, url, options, {maxBytes: 64, timeoutMs: 30});

test('streaming assembles split UTF-8 sequences and never calls unbounded text()', async () => {
  const bytes = encoded('Gift 😀 Black'), body = stream([bytes.slice(0, 7), bytes.slice(7)]);
  const result = await read(async () => ({...response(body), text() {throw new Error('Unbounded text reader');}}));
  assert.equal(result.body, 'Gift 😀 Black'); assert.equal(result.truncated, false);
});

test('oversized Content-Length is rejected before enumeration and cancels the body', async () => {
  let reads = 0, cancelled = 0;
  const body = {[Symbol.asyncIterator]() {reads++; throw new Error('Must not read');}, cancel() {cancelled++;}};
  await assert.rejects(read(async () => response(body, '999999999999999999999999999')), error => error.code === 'response_too_large' && error.body === '' && error.truncated);
  assert.equal(reads, 0); assert.equal(cancelled, 1);
});

test('a multibyte chunk crossing the byte limit stops reads, retains a safe prefix and cancels', async () => {
  let reads = 0, cancelled = 0;
  const chunks = [encoded('😀'), encoded('😀😀')];
  const body = {[Symbol.asyncIterator]() {return {async next() {return {done: false, value: chunks[reads++]};}, return() {cancelled++; return Promise.reject(new Error('Ignored cancellation'));}};}};
  await assert.rejects(fetchBoundedResponse(async () => response(body), url, options, {maxBytes: 5, timeoutMs: 30}), error => error.code === 'response_too_large' && error.body === '😀' && error.truncated);
  assert.equal(reads, 2); assert.equal(cancelled, 1);
});

test('invalid UTF-8, non-byte chunks, malformed lengths and text-only responses fail closed', async () => {
  for (const input of [response(stream([Uint8Array.of(0xc0, 0x80)])), response(stream([Uint8Array.of(0xed, 0xa0, 0x80)])),
    response(stream([encoded('ok'), Uint8Array.of(0xf0)])), response(stream(['text'])), response(stream([]), '1e3'),
    {status: 200, text() {throw new Error('Must not read');}}]) {
    await assert.rejects(read(async () => input), error => error.code === 'invalid_response');
  }
});

test('a header request ignoring AbortSignal releases at the independent deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let signal, resolve, began;
  const started = new Promise(done => {began = done;});
  const never = new Promise(done => {resolve = done;});
  const pending = read(async (_url, init) => {signal = init.signal; began(); return never;});
  await started; t.mock.timers.tick(30);
  await assert.rejects(pending, error => error.code === 'request_timeout' && error.response === null);
  assert.equal(signal.aborted, true);
  // A response arriving after timeout is cancelled, never consumed or returned.
  let cancelled = 0, reads = 0;
  resolve(response({cancel() {cancelled++;}, [Symbol.asyncIterator]() {reads++; return stream([])[Symbol.asyncIterator]();}}));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(cancelled, 1); assert.equal(reads, 0);
});

test('a stalled body ignoring AbortSignal and iterator.return cannot hold the deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let began, cancelled = 0, signal;
  const started = new Promise(done => {began = done;});
  const body = {[Symbol.asyncIterator]() {return {next() {began(); return new Promise(() => {});}, return() {cancelled++; return new Promise(() => {});}};}};
  const pending = read(async (_url, init) => {signal = init.signal; return response(body);});
  await started; t.mock.timers.tick(30);
  await assert.rejects(pending, error => error.code === 'request_timeout' && error.response.status === 200);
  assert.equal(signal.aborted, true); assert.ok(cancelled >= 1);
});

test('Telegram without timers still streams safely and rejects late headers and body evidence using trusted time', async () => {
  const timer = globalThis.setTimeout, clear = globalThis.clearTimeout, controller = globalThis.AbortController;
  let at = 1000, cancelled = 0;
  const late = delay => async () => {at += delay; return response({cancel() {cancelled++;}, [Symbol.asyncIterator]() {throw new Error('Late headers must not be read');}});};
  try {
    globalThis.setTimeout = undefined; globalThis.clearTimeout = undefined; globalThis.AbortController = undefined;
    const params = {maxBytes: 64, timeoutMs: 30, deadlineAt: 1030, clock: async () => at};
    await assert.rejects(fetchBoundedResponse(late(30), url, options, params), error => error.code === 'request_timeout');
    assert.equal(cancelled, 1);
    at = 1000;
    const body = {[Symbol.asyncIterator]() {return {async next() {at += 30; return {done: false, value: encoded('uncommitted')};}, return() {cancelled++;}};}};
    await assert.rejects(fetchBoundedResponse(async () => response(body), url, options, params), error => error.code === 'request_timeout' && error.body === '');
    at = 1000;
    const safe = await fetchBoundedResponse(async () => response(stream([encoded('saved')])), url, options, params);
    assert.equal(safe.body, 'saved');
  } finally {globalThis.setTimeout = timer; globalThis.clearTimeout = clear; globalThis.AbortController = controller;}
});

test('raw evidence is bounded after JSON escaping and never splits a Unicode scalar', () => {
  const raw = {status: 200, endpoint: '/v1/rent/gifts/', observed_at: '2026-10-10T09:00:00Z', failure: 'invalid_response',
    body: ('\0"\\😀').repeat(1000), truncated: false};
  const encoded = boundedRawEvidence(raw, 512), stored = JSON.parse(encoded);
  assert.ok(utf8Size(encoded) <= 512); assert.equal(stored.truncated, true); assert.ok(stored.body.length > 0);
  assert.equal(stored.failure, raw.failure); assert.equal(stored.body.includes('\ufffd'), false);
  assert.ok(raw.body.startsWith(stored.body));
});

test('oversized metadata is omitted rather than exceeding the evidence byte limit', () => {
  const raw = {status: 400, endpoint: '/v1/rent/gifts/', request_cursor: '😀'.repeat(10000), observed_at: '2026-10-10T09:00:00Z', failure: 'cursor_rejected', body: 'invalid', truncated: false};
  const result = boundedRawEvidence(raw, 256), stored = JSON.parse(result);
  assert.ok(utf8Size(result) <= 256); assert.equal(stored.evidence_metadata_omitted, true); assert.equal(stored.failure, 'cursor_rejected');
  assert.ok(utf8Size(boundedRawEvidence(raw, 1)) <= 1);
});
