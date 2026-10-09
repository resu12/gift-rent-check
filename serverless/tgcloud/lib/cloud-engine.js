import {validatePage} from './engine.js';
import {buildCloudDashboard, resolveCloudWindow, validateSavedCloudWindow, addressKey} from './cloud-pricing.js';

export const CLOUD_LIMITS = Object.freeze({page_size: 10, invocation_attempts: 100, daily_attempts: 500, duration_ms: 300000, interval_ms: 1000, retry_attempts: 4, lease_ms: 120000, response_bytes: 1048576, import_bytes: 524288, import_records: 250});
export class CloudRequestError extends Error {}
const BASE = 'https://api.marketapp.org';
const ROUTES = Object.freeze({collection: '/v1/collections/gifts/', listing: '/v1/rent/gifts/', history: '/v1/rent/gifts/history/'});
const copy = value => JSON.parse(JSON.stringify(value));
const iso = ms => new Date(ms).toISOString();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const size = value => {let n = 0; for (const c of value) {const p = c.codePointAt(0); n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4;} return n;};
const canonicalJson = value => JSON.stringify(value, (_k, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const stableKey = value => addressKey(value);
const isActive = job => job && ['queued', 'running'].includes(job.state);
const messages = {
  stopped_by_you: 'Stopped by you. Resume continues the saved traversal.',
  invocation_limit: 'The 100-request invocation limit was reached. Resume when ready.',
  daily_limit: 'The rolling 24-hour request allowance was reached. Resume after its reset.',
  duration_limit: 'The five-minute collection allowance ended. Resume when ready.',
  retry_wait: 'Waiting for the provider retry deadline.',
  retry_exhausted: 'Provider retries were exhausted. Start a fresh collection.',
  authentication_failed: 'Marketapp rejected authentication. Check the private backend token.',
  invalid_response: 'Marketapp returned malformed data. The saved cursor was not advanced.',
  cursor_cycle: 'Marketapp repeated a cursor. Start a fresh collection.',
  cursor_rejected: 'Marketapp rejected the saved cursor. Start a fresh collection.',
  http_error: 'Marketapp returned a non-retryable error. Start a fresh collection.',
  unexpected_redirect: 'The provider response came from an unexpected URL.',
  response_too_large: 'The provider response exceeded the page safety limit.',
  invalid_retry_after: 'The provider returned an unsupported retry deadline.',
};

function validateHistory(item) {
  if (!object(item) || !['address', 'name', 'collection_address', 'src', 'dst', 'price', 'price_nano'].every(k => typeof item[k] === 'string') || !Number.isSafeInteger(item.ts) || !['GRAM', 'TON', 'USDT'].includes(item.currency)) throw new CloudRequestError('Invalid history');
  if (![item.price, item.price_nano].every(v => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))) throw new CloudRequestError('Invalid amount');
  if (Object.hasOwn(item, 'duration') && !Number.isSafeInteger(item.duration)) throw new CloudRequestError('Invalid duration');
  if (Object.hasOwn(item, 'is_extend') && typeof item.is_extend !== 'boolean') throw new CloudRequestError('Invalid extension flag');
  if (Object.hasOwn(item, 'tx_hash') && item.tx_hash !== null && typeof item.tx_hash !== 'string') throw new CloudRequestError('Invalid transaction hash');
}

export function parseCloudPage(kind, body, scope, observedAt, prefix) {
  const parsed = JSON.parse(body);
  if (kind === 'collection') {
    if (!Array.isArray(parsed) || parsed.some(item => !object(item) || typeof item.address !== 'string' || typeof item.name !== 'string' || !object(item.extra_data))) throw new CloudRequestError('Invalid catalog');
    for (const item of parsed) {
      for (const field of ['items', 'owners', 'on_sale_all', 'on_sale_onchain']) if (Object.hasOwn(item.extra_data, field) && item.extra_data[field] !== null && !Number.isSafeInteger(item.extra_data[field])) throw new CloudRequestError('Invalid collection statistics');
      for (const field of ['floor', 'rent_floor', 'volume7d', 'volume30d']) if (Object.hasOwn(item.extra_data, field) && item.extra_data[field] !== null && typeof item.extra_data[field] !== 'string') throw new CloudRequestError('Invalid collection statistics');
    }
    return {cursor: null, items: parsed, records: parsed.map((item, i) => ({kind: 'collection', key: `${prefix}:${i}`, observed_at: observedAt, record: {identity: item.address, source_json: item}}))};
  }
  if (!object(parsed) || !Object.hasOwn(parsed, 'cursor') || !(parsed.cursor === null || typeof parsed.cursor === 'string') || !Array.isArray(parsed.items) || parsed.items.length > 100) throw new CloudRequestError('Invalid page');
  if (parsed.cursor !== null) {if (parsed.cursor.length > 16384) throw new CloudRequestError('Invalid cursor'); encodeURIComponent(parsed.cursor);}
  if (kind === 'listing') validatePage(body, scope, observedAt);
  else parsed.items.forEach(validateHistory);
  return {...parsed, records: parsed.items.map((item, i) => ({kind, key: `${prefix}:${i}`, observed_at: observedAt, record: {
    identity: kind === 'listing' ? item.nft_address : item.address,
    source_json: item, params: scope ? {collection_address: scope} : {},
    collection_address: scope || item.collection_address || null,
    collection_evidence: scope ? {collection_filtered_request: [scope]} : {},
  }}))};
}

function scopedCollections(records) {
  const gifts = new Map();
  for (const row of records) if (row.kind === 'portfolio') gifts.set(stableKey(row.record.nft_address || row.record.id), row.record);
  const scopes = new Map(); let unresolved = 0;
  for (const gift of gifts.values()) {
    if (!gift.is_portfolio) continue;
    if (typeof gift.collection_address !== 'string' || !gift.collection_address || gift.collection_conflict) {unresolved++; continue;}
    scopes.set(stableKey(gift.collection_address), gift.collection_address);
  }
  return {scopes: [...scopes].sort(([a], [b]) => a.localeCompare(b)).map(([, original]) => original), unresolved};
}

export function createCloudEngine({repository, fetch: request, ownerTelegramId, marketappToken, now: localNow = () => Date.now(), clock = null, random = Math.random, limits = {}, dashboard = buildCloudDashboard, ownedPriceRefresh = false}) {
  const cap = {...CLOUD_LIMITS, ...limits};
  let observedTime = null;
  const now = () => clock ? observedTime ?? localNow() : localNow();
  async function refreshClock() {
    if (!clock) return;
    let value;
    try {value = await clock();} catch {throw new CloudRequestError('The trusted server clock is unavailable. No new provider request can start.');}
    if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) throw new CloudRequestError('The trusted server clock is unavailable. No new provider request can start.');
    observedTime = Math.max(observedTime ?? value, value);
  }
  const secret = typeof marketappToken === 'string' ? marketappToken : '';
  const redact = value => secret ? value.split(secret).join('[REDACTED]') : value;
  const authorize = ctx => {
    const allowed = String(ownerTelegramId ?? ''), observed = String(ctx?.initData?.user?.id ?? '');
    if (!/^[1-9]\d*$/.test(allowed) || observed !== allowed) throw new CloudRequestError('Private access denied');
  };
  const cleanAttempts = state => state.attempts = state.attempts.filter(at => at > now() - 86400000);
  const budget = state => {
    const used = state.attempts.filter(at => at > now() - 86400000);
    return {max_attempts: cap.invocation_attempts, rolling_24h_attempts: cap.daily_attempts, run_seconds: cap.duration_ms / 1000, requests_per_second: 1000 / cap.interval_ms, used_24h: used.length, remaining_24h: Math.max(0, cap.daily_attempts - used.length), resets_at: used.length ? iso(used[0] + 86400000) : null};
  };
  const project = (job, state, readonly = false) => ({
    id: job.id, kind: job.kind, state: job.state, created_at: job.created_at, updated_at: job.updated_at,
    reason: messages[job.reason] || job.reason || null, run_id: job.id, stop_requested: job.reason === 'stopped_by_you', collection_window: job.collection_window,
    progress: {
      provider: 'marketapp', pages: job.pages, observations: job.observations, streams_complete: job.streams.filter(s => s.complete).length, streams_total: job.streams.length,
      scopes: job.scopes.length, unresolved_collections: job.unresolved_collections, warnings: job.warnings,
      next_allowed_at: Math.max(state.next_allowed_at, job.lease_until || 0), server_time: now(),
      requires_resume: readonly && isActive(job) && (job.lease_until || 0) <= now(),
      marketapp_budget: {invocation_used: job.invocation_used, invocation_limit: cap.invocation_attempts, rolling_24h_used: budget(state).used_24h, rolling_24h_limit: cap.daily_attempts, resets_at: budget(state).resets_at, run_seconds: cap.duration_ms / 1000},
    },
  });
  async function mutate(change) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const {revision, state: saved} = await repository.read(), state = copy(saved);
      await refreshClock();
      cleanAttempts(state);
      const event = await change(state);
      if (event?.skip) return {state: saved, value: event.value};
      const payload = {key: event?.key || `event:${revision + 1}`, state, job: event?.job === false ? null : state.job, records: event?.records || [], raw_body: event?.raw_body ?? null, observed_at: iso(now())};
      if (await repository.append(revision, payload)) return {state, value: event?.value};
    }
    throw new CloudRequestError('Another request updated the saved state. Refresh and try again.');
  }
  const identify = input => {
    const id = input?.job_id ?? input?.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new CloudRequestError('Invalid job identifier');
    return id;
  };
  const find = (state, id) => {
    if (state.job?.id !== id) throw new CloudRequestError('This job is not the selected traversal. Resume it first.');
    return state.job;
  };
  const finish = (job, status, reason = null) => {job.state = status; job.reason = reason; job.lease = null; job.lease_until = 0; job.updated_at = iso(now());};
  const pauseBudget = (state, job) => {
    if (!isActive(job)) return false;
    const reason = state.attempts.length >= cap.daily_attempts ? 'daily_limit' : job.invocation_used >= cap.invocation_attempts ? 'invocation_limit' : now() >= job.invocation_deadline || state.next_allowed_at >= job.invocation_deadline ? 'duration_limit' : null;
    if (reason) {finish(job, 'partial', reason); return true;}
    return false;
  };
  async function getDashboard(ctx, input = {}) {
    authorize(ctx);
    await refreshClock();
    try {resolveCloudWindow(input, now());} catch (error) {throw new CloudRequestError(error.message);}
    const {state} = await repository.read(), records = await repository.records();
    await refreshClock();
    return dashboard(records, input, {now: now(), capabilities: {mode: 'serverless', network_enabled: true, marketapp_configured: Boolean(secret.trim()), ton_configured: false, owned_price_refresh: ownedPriceRefresh, wallet_configured: records.some(r => r.kind === 'settings' && r.record.wallet), csrf_token: '', marketapp_limits: budget(state), supported_jobs: ['prices', 'rental_prices', 'collect']}, jobs: (await repository.jobs()).map(j => project(j, state, true))});
  }
  async function getJobs(ctx) {
    authorize(ctx); const {state} = await repository.read();
    await refreshClock();
    return {jobs: (await repository.jobs()).map(j => project(j, state, true))};
  }
  async function startJob(ctx, input = {}) {
    authorize(ctx);
    await refreshClock();
    if (!secret.trim()) throw new CloudRequestError('Configure the private Marketapp token before collecting.');
    if (!['prices', 'rental_prices', 'collect'].includes(input.kind)) throw new CloudRequestError('This Telegram release supports listing and rental-price collection.');
    let window;
    try {window = resolveCloudWindow(input, now(), {collectHistory: input.kind !== 'prices'});} catch (error) {throw new CloudRequestError(error.message);}
    const {scopes, unresolved} = scopedCollections(await repository.records());
    if (!scopes.length) throw new CloudRequestError('Import your verified portfolio with collection addresses before collecting.');
    const result = await mutate(state => {
      if (isActive(state.job) || (state.job?.lease_until || 0) > now()) throw new CloudRequestError('Stop or complete the current collection before starting another.');
      const kinds = input.kind === 'prices' ? ['listing'] : input.kind === 'rental_prices' ? ['history'] : ['listing', 'history'];
      state.job = {id: state.next_job_id++, kind: input.kind, state: 'running', created_at: iso(now()), updated_at: iso(now()), reason: null,
        collection_window: window, scopes, unresolved_collections: unresolved, page_size: cap.page_size,
        streams: [{kind: 'collection', scope: null}, ...scopes.flatMap(scope => kinds.map(kind => ({kind, scope})))].map(s => ({...s, cursor: null, started: false, complete: false, cursors: [], retry: 0, pages: 0, last_timestamp: null, ordered: true})),
        pages: 0, observations: 0, warnings: [], invocation_used: 0, invocation_deadline: now() + cap.duration_ms, invocation: 1, lease: null, lease_until: 0};
      pauseBudget(state, state.job);
    });
    return {job: project(result.state.job, result.state)};
  }
  async function stopJob(ctx, input = {}) {
    authorize(ctx); const id = identify(input);
    const result = await mutate(state => {
      const job = find(state, id);
      if (!isActive(job)) return {skip: true};
      // Retain the request lease so Resume cannot overlap an in-flight request.
      job.state = 'partial'; job.reason = 'stopped_by_you'; job.updated_at = iso(now());
    });
    return {job: project(result.state.job, result.state)};
  }
  async function resumeJob(ctx, input = {}) {
    authorize(ctx); const id = identify(input);
    const result = await mutate(async state => {
      if (state.job?.id !== id && isActive(state.job)) throw new CloudRequestError('Stop the active collection before resuming another.');
      if ((state.job?.lease_until || 0) > now()) throw new CloudRequestError('A request is still in flight. Wait for its saved lease to expire.');
      // Load a non-current job inside each CAS attempt. A concurrent resume or
      // completion can change it between retries; never restore a stale cursor.
      const job = state.job?.id === id ? state.job : await repository.job(id);
      if (!job || !['partial', 'running', 'queued'].includes(job.state)) throw new CloudRequestError('This traversal cannot resume. Start a fresh collection.');
      try {validateSavedCloudWindow(job.collection_window);} catch (error) {throw new CloudRequestError(error.message);}
      // The stored window and stream parameters are immutable on Resume.
      for (const field of ['kind', 'timeframe', 'date_from', 'date_to', 'page_size']) if (Object.hasOwn(input, field)) throw new CloudRequestError('Resume uses the saved collection parameters.');
      job.state = 'running'; job.reason = null; job.updated_at = iso(now()); job.invocation++; job.invocation_used = 0; job.invocation_deadline = now() + cap.duration_ms; job.lease = null; job.lease_until = 0; state.job = job;
      pauseBudget(state, job);
    });
    return {job: project(result.state.job, result.state)};
  }
  function retryDeadline(response, retry) {
    const value = response?.headers?.get?.('Retry-After');
    let delay = 0;
    if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) delay = Math.ceil(Number(value) * 1000);
    else if (value) {const parsed = Date.parse(value); if (Number.isFinite(parsed)) delay = Math.max(0, parsed - now());}
    const deadline = now() + Math.max(delay, Math.min(30000, 1000 * 2 ** (retry - 1)) + Math.floor(random() * 250));
    return Number.isSafeInteger(deadline) && deadline <= 8640000000000000 ? deadline : null;
  }
  async function stepJob(ctx, input = {}) {
    authorize(ctx); const id = identify(input);
    await refreshClock();
    if (!secret.trim()) throw new CloudRequestError('Configure the private Marketapp token before collecting.');
    const lease = `${now()}:${Math.floor(random() * Number.MAX_SAFE_INTEGER)}`;
    const reserved = await mutate(state => {
      const job = find(state, id);
      if (!isActive(job) || job.lease_until > now()) return {skip: true};
      if (pauseBudget(state, job)) return {};
      if (state.next_allowed_at > now()) return {skip: true};
      const streamIndex = job.streams.findIndex(s => !s.complete);
      if (streamIndex < 0) {finish(job, 'complete'); return {};}
      const stream = job.streams[streamIndex];
      if (stream.retry >= cap.retry_attempts) {finish(job, 'failed', 'retry_exhausted'); return {};}
      job.lease = lease; job.lease_until = now() + cap.lease_ms; job.invocation_used++; stream.retry++; job.updated_at = iso(now()); state.attempts.push(now()); state.next_allowed_at = now() + cap.interval_ms;
      return {value: {job: copy(job), stream: copy(stream), streamIndex}};
    });
    if (!reserved.value) return {job: project(reserved.state.job, reserved.state)};
    const {job: requestJob, stream, streamIndex} = reserved.value;
    await refreshClock();
    if (now() >= requestJob.invocation_deadline || now() >= requestJob.lease_until) {
      const stopped = await mutate(state => {
        if (state.job?.id === id && state.job.lease === lease) finish(state.job, 'partial', 'duration_limit');
      });
      return {job: project(stopped.state.job, stopped.state)};
    }
    const query = [];
    if (stream.kind !== 'collection') {
      query.push(`limit=${requestJob.page_size}`, `${stream.kind === 'listing' ? 'sort_by=recently_touch' : 'order_by=new_to_old'}`);
      if (stream.scope) query.push(`collection_address=${encodeURIComponent(stream.scope)}`);
      if (stream.started && stream.cursor !== null) query.push(`cursor=${encodeURIComponent(stream.cursor)}`);
    }
    const url = `${BASE}${ROUTES[stream.kind]}${query.length ? `?${query.join('&')}` : ''}`;
    let response = null, body = '', failure = null, parsed = null;
    try {
      response = await request(url, {method: 'GET', headers: {Authorization: secret, Accept: 'application/json'}, redirect: 'error'});
      body = redact(await response.text());
      if (response.url && response.url !== url) failure = 'unexpected_redirect';
      else if (size(body) > cap.response_bytes) failure = 'response_too_large';
      else if ([401, 403].includes(response.status)) failure = 'authentication_failed';
      else if (response.status === 429 || [500, 502, 503, 504].includes(response.status)) failure = 'transient_http';
      else if (response.status < 200 || response.status >= 300) failure = response.status === 400 && stream.started ? 'cursor_rejected' : 'http_error';
    } catch {failure = 'network_error';}
    // Retry-After starts when the response was received, never at the request's
    // frozen V8 timestamp. Fresh SQL wall time also fences an expired lease.
    await refreshClock();
    if (!failure) {try {parsed = parseCloudPage(stream.kind, body, stream.scope, iso(now()), `${id}:${streamIndex}:${stream.pages}`);} catch {failure = 'invalid_response';}}
    let retryable = ['network_error', 'transient_http'].includes(failure), deadline = retryable ? retryDeadline(response, stream.retry) : null;
    if (retryable && deadline === null) {failure = 'invalid_retry_after'; retryable = false;}
    const outcome = await mutate(state => {
      const job = state.job;
      if (deadline !== null) state.next_allowed_at = Math.max(state.next_allowed_at, deadline);
      const raw = {status: response?.status ?? null, endpoint: ROUTES[stream.kind], request_cursor: stream.cursor, request_cursor_present: stream.started, observed_at: iso(now()), failure, body: body.slice(0, cap.response_bytes), truncated: body.length > cap.response_bytes};
      const event = {raw_body: JSON.stringify(raw)};
      if (!job || job.id !== id || !isActive(job) || job.lease !== lease || job.lease_until <= now()) {
        if (job?.lease === lease) {job.lease = null; job.lease_until = 0;}
        return event;
      }
      const current = job.streams[streamIndex];
      if (failure) {
        finish(job, retryable && current.retry < cap.retry_attempts ? 'running' : 'failed', retryable ? current.retry < cap.retry_attempts ? 'retry_wait' : 'retry_exhausted' : failure);
        pauseBudget(state, job); return event;
      }
      if (parsed.cursor !== null && current.cursors.includes(parsed.cursor)) {finish(job, 'failed', 'cursor_cycle'); return event;}
      current.started = true; current.cursor = parsed.cursor; current.complete = parsed.cursor === null; current.retry = 0; current.pages++;
      if (parsed.cursor !== null) current.cursors.push(parsed.cursor);
      if (current.kind === 'history') {
        const timestamps = parsed.items.map(item => item.ts);
        if (timestamps.some(ts => ts <= 0 || ts > 8640000000000) || timestamps.some((ts, i) => i > 0 && ts > timestamps[i - 1]) || (timestamps.length && current.last_timestamp !== null && timestamps[0] > current.last_timestamp)) current.ordered = false;
        if (!current.ordered && !job.warnings.includes('History ordering was not reliable; the date cutoff is disabled for this stream.')) job.warnings.push('History ordering was not reliable; the date cutoff is disabled for this stream.');
        if (timestamps.length) current.last_timestamp = timestamps[timestamps.length - 1];
        const since = Date.parse(job.collection_window.window_from) / 1000;
        if (timestamps.length && current.ordered && current.last_timestamp < since) {current.complete = true; current.completion_reason = 'timeframe_covered';}
      }
      job.pages++; job.observations += parsed.records.length;
      finish(job, job.streams.every(s => s.complete) ? 'complete' : 'running');
      pauseBudget(state, job);
      return {...event, records: parsed.records};
    });
    return {job: project(outcome.state.job, outcome.state)};
  }
  async function importChunk(ctx, input = {}) {
    authorize(ctx);
    const chunkIndex = input.chunk_index ?? (/^\d{1,8}$/.test(input.chunk_id || '') ? Number(input.chunk_id) : null);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.import_id || '') || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Array.isArray(input.records) || input.records.length > cap.import_records) throw new CloudRequestError('Invalid import chunk');
    const serialized = canonicalJson(input.records);
    if (size(serialized) > cap.import_bytes || (secret && serialized.includes(secret))) throw new CloudRequestError('Invalid or oversized import chunk');
    const kinds = new Set(['portfolio', 'listing', 'history', 'collection', 'attribute', 'ownership', 'metadata', 'settings']);
    for (const row of input.records) if (!object(row) || !kinds.has(row.kind) || typeof row.key !== 'string' || row.key.length > 512 || !object(row.record) || typeof row.observed_at !== 'string' || !Number.isFinite(Date.parse(row.observed_at))) throw new CloudRequestError('Invalid import record');
    const key = `import:${input.import_id}:${chunkIndex}`, previous = await repository.event(key);
    if (previous) {
      if (canonicalJson(previous) !== serialized) throw new CloudRequestError('This import chunk identifier already has different content.');
      return {accepted: true, imported: previous.length, already_committed: true};
    }
    try {
      await mutate(state => {
        if (isActive(state.job) || (state.job?.lease_until || 0) > now()) throw new CloudRequestError('Stop collection before importing portfolio evidence.');
        return {key, records: input.records, job: false};
      });
    } catch (error) {
      const concurrent = await repository.event(key);
      if (!concurrent || canonicalJson(concurrent) !== serialized) throw error;
      return {accepted: true, imported: concurrent.length, already_committed: true};
    }
    return {accepted: true, imported: input.records.length, already_committed: false};
  }
  return {getDashboard, getJobs, startJob, stepJob, stopJob, resumeJob, importChunk};
}
