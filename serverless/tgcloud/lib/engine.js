// Portable engine: all runtime I/O is injected by the Telegram endpoint adapter.
export const LIMITS = Object.freeze({max_pages: 100, page_size: 10, max_attempts: 4, request_interval_ms: 1000, lease_ms: 120000, max_response_bytes: 131072, max_document_bytes: 2097152});
const MARKET_URL = 'https://api.marketapp.org/v1/rent/gifts/';
const TERMINAL = new Set(['complete', 'failed', 'prototype_limit']);
const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => { let n = 0; for (const c of value) {const p = c.codePointAt(0); n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4;} return n; };
const initial = () => ({version: 1, current_run: null, provider_next_allowed_at: 0, runs: []});
const errorMessages = {CONFIGURATION: 'Configure the private Marketapp token before collecting.', ACTIVE_RUN: 'Stop or complete the current run before starting another.', INVALID_INPUT: 'Invalid collection address, page size, or run identifier.', RUN_NOT_FOUND: 'The requested run does not exist.', NOT_RESUMABLE: 'This run cannot resume. Start a fresh run.', STORAGE_LIMIT: 'The prototype storage limit was reached. Export or reset the test database before another run.', CONFLICT: 'Another request updated this run. Refresh its state and try again.'};

export function nanoAmounts(value) {
  if (typeof value !== 'string' || !/^\d{1,100}$/.test(value)) throw new Error('Invalid amount');
  const n = BigInt(value), whole = n / 1000000000n, fraction = String(n % 1000000000n).padStart(9, '0');
  const rounded = (n + 500000n) / 1000000n;
  return {price_nano: value, price_gram: `${whole}.${fraction}`, price_display: `${rounded / 1000n}.${String(rounded % 1000n).padStart(3, '0')}`};
}

function validAddress(value) {
  // Canonical raw mainnet identities or friendly TON addresses. Friendly CRC16 is
  // checked locally; names and arbitrary metadata never become a scope.
  if (typeof value !== 'string') return false;
  if (/^(?:0|-1):[0-9a-fA-F]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]{48}$/.test(value)) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const data = []; let acc = 0, bits = 0;
  for (const c of value) {acc = (acc << 6) | alphabet.indexOf(c); bits += 6; if (bits >= 8) {bits -= 8; data.push((acc >> bits) & 255);}}
  if (data.length !== 36 || ![0x11, 0x51].includes(data[0]) || ![0, 255].includes(data[1])) return false;
  let crc = 0;
  for (const byte of data.slice(0, 34)) {crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;}
  return data[34] === (crc >> 8) && data[35] === (crc & 255);
}

export function validatePage(raw, scope, observedAt) {
  const page = JSON.parse(raw);
  if (!page || typeof page !== 'object' || Array.isArray(page) || !Object.hasOwn(page, 'cursor') || !(page.cursor === null || typeof page.cursor === 'string') || !Array.isArray(page.items)) throw new Error('Invalid page');
  if (page.cursor !== null && page.cursor.length > 16384) throw new Error('Invalid cursor');
  if (page.cursor !== null) encodeURIComponent(page.cursor); // Reject invalid Unicode before committing a checkpoint.
  const listings = page.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['nft_address', 'nft_name', 'owner'].every(k => typeof item[k] === 'string') || !Array.isArray(item.attributes) || !Number.isSafeInteger(item.min_duration) || !Number.isSafeInteger(item.max_duration) || typeof item.discount_per_day !== 'number' || !Number.isFinite(item.discount_per_day) || !Object.hasOwn(item, 'listed_at') || !(item.listed_at === null || Number.isSafeInteger(item.listed_at))) throw new Error('Invalid listing');
    for (const attr of item.attributes) if (!attr || typeof attr.trait_type !== 'string' || !['string', 'number'].includes(typeof attr.value) || (typeof attr.value === 'number' && !Number.isFinite(attr.value))) throw new Error('Invalid attribute');
    const trait = name => {const value = item.attributes.find(a => a.trait_type.toLowerCase() === name)?.value; return value == null ? null : String(value);};
    return {nft_address: item.nft_address, name: item.nft_name, collection_address: scope, collection_source: scope ? 'collection_filtered_request' : null, ...nanoAmounts(item.price_per_day), observed_at: observedAt, model: trait('model'), backdrop: trait('backdrop'), units: 'GRAM/day', ownership_verified: false};
  });
  return {cursor: page.cursor, listings};
}

export function createEngine({repository, fetch: request, ownerTelegramId, marketappToken, now = () => Date.now(), random = Math.random, limits = {}}) {
  const cap = {...LIMITS, ...limits};
  const secret = typeof marketappToken === 'string' ? marketappToken : '';
  const redact = value => secret ? value.split(secret).join('[REDACTED]') : value;
  const configured = Boolean(secret.trim());
  function authorize(ctx) {
    const allowed = String(ownerTelegramId ?? '');
    const observed = ctx?.initData?.user?.id;
    if (!/^[1-9]\d*$/.test(allowed) || observed == null || !/^[1-9]\d*$/.test(String(observed)) || String(observed) !== allowed) throw new Error('Private access denied');
    return String(observed);
  }
  async function read() {const found = await repository.read(); return found || {revision: 0, document: initial()};}
  async function mutate(fn) {
    for (let i = 0; i < 12; i++) {
      const saved = await read(), document = clone(saved.document), result = fn(document);
      if (result?.skip) return {document: saved.document, result};
      if (bytes(JSON.stringify(document)) > cap.max_document_bytes) return {document: saved.document, result: {error: 'STORAGE_LIMIT'}};
      if (await repository.compareAndSet(saved.revision, document)) return {document, result};
    }
    return {document: (await read()).document, result: {error: 'CONFLICT'}};
  }
  function current(document) {return document.runs.find(r => r.id === document.current_run) || null;}
  function project(document, user, error = null) {
    const r = current(document);
    const state = {authorized: true, user: {id: user}, server_time: now(), configured, limits: {max_pages: cap.max_pages, page_size: cap.page_size, max_attempts: cap.max_attempts, request_interval_ms: cap.request_interval_ms}, run: null, listings: []};
    if (r) {
      state.run = {id: r.id, status: r.status, pages_committed: r.pages.length, items_seen: r.pages.reduce((n, p) => n + p.listings.length, 0), next_allowed_at: Math.max(document.provider_next_allowed_at, r.next_allowed_at, r.lease_until), lease_until: r.lease_until, reason: r.reason, has_more: !r.traversal_complete, page_size: r.page_size, collection_address: r.collection_address, attempts: r.attempts};
      state.listings = r.pages.flatMap(p => p.listings);
    }
    if (error) state.error = {code: error, message: errorMessages[error] || 'The request could not be completed.'};
    return state;
  }
  function finish(document, r, status, reason) {r.status = status; r.reason = reason; r.lease = null; r.lease_until = 0; r.updated_at = now();}
  const safeInput = input => input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const findInput = (document, input) => document.runs.find(r => r.id === input.run_id && r.id === document.current_run);

  async function getState(ctx) {const user = authorize(ctx); return project((await read()).document, user);}
  async function startRun(ctx, supplied) {
    const user = authorize(ctx), input = safeInput(supplied);
    if (!configured) return project((await read()).document, user, 'CONFIGURATION');
    if (input.collection_address != null && typeof input.collection_address !== 'string') return project((await read()).document, user, 'INVALID_INPUT');
    const size = input.page_size ?? cap.page_size, scope = input.collection_address?.trim() || null;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100 || (scope !== null && !validAddress(scope))) return project((await read()).document, user, 'INVALID_INPUT');
    const id = `${now()}-${Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
    const result = await mutate(document => {
      const active = current(document);
      if (active && (active.status === 'ready' || active.status === 'running' || active.lease_until > now())) return {skip: true, error: 'ACTIVE_RUN'};
      const runId = `${id}-${document.runs.length + 1}`;
      const r = {id: runId, status: 'ready', reason: null, created_at: now(), updated_at: now(), page_size: size, collection_address: scope, cursor: null, started: false, traversal_complete: false, seen_cursors: [], pages: [], invalid_responses: [], attempts: 0, retry_attempt: 0, next_allowed_at: 0, lease: null, lease_until: 0};
      document.runs.push(r); document.current_run = runId;
    });
    return project(result.document, user, result.result?.error);
  }
  async function stopRun(ctx, supplied) {
    const user = authorize(ctx), input = safeInput(supplied);
    const result = await mutate(document => {const r = findInput(document, input); if (!r) return {skip: true, error: 'RUN_NOT_FOUND'}; if (TERMINAL.has(r.status) || r.status === 'paused') return {skip: true}; r.status = 'paused'; r.reason = 'stopped_by_you'; r.updated_at = now();});
    return project(result.document, user, result.result?.error);
  }
  async function resumeRun(ctx, supplied) {
    const user = authorize(ctx), input = safeInput(supplied);
    const result = await mutate(document => {
      const r = findInput(document, input);
      if (!r) return {skip: true, error: 'RUN_NOT_FOUND'};
      if ((input.page_size !== undefined && input.page_size !== r.page_size) || (input.collection_address !== undefined && input.collection_address !== r.collection_address)) return {skip: true, error: 'INVALID_INPUT'};
      if (r.status === 'ready') return {skip: true};
      if (r.status !== 'paused' && !(r.status === 'running' && r.lease_until <= now())) return {skip: true, error: 'NOT_RESUMABLE'};
      // A stopped request may still be in flight. Preserve its lease until it
      // returns or expires; a resumed browser must not launch a second request.
      r.status = 'ready'; r.reason = null; r.updated_at = now();
      if (r.lease_until <= now()) {r.lease = null; r.lease_until = 0;}
    });
    return project(result.document, user, result.result?.error);
  }
  function retryDelay(response, count) {
    const raw = response?.headers?.get?.('Retry-After');
    let server = 0;
    if (raw && /^\d+(?:\.\d+)?$/.test(raw.trim())) server = Math.ceil(Number(raw) * 1000);
    else if (raw) {const date = Date.parse(raw); if (Number.isFinite(date)) server = Math.max(0, date - now());}
    const delay = Math.max(server, Math.min(30000, 1000 * (2 ** (count - 1))) + Math.floor(random() * 250));
    return Number.isSafeInteger(now() + delay) && now() + delay <= 8640000000000000 ? delay : null;
  }
  async function stepRun(ctx, supplied) {
    const user = authorize(ctx), input = safeInput(supplied);
    if (!configured) return project((await read()).document, user, 'CONFIGURATION');
    const lease = `${now()}-${Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
    const reservation = await mutate(document => {
      const r = findInput(document, input);
      if (!r) return {skip: true, error: 'RUN_NOT_FOUND'};
      if (r.status !== 'ready' || Math.max(document.provider_next_allowed_at, r.next_allowed_at, r.lease_until) > now()) return {skip: true};
      if (r.retry_attempt >= cap.max_attempts) {finish(document, r, 'failed', 'retry_exhausted'); return {skip: false};}
      r.status = 'running'; r.lease = lease; r.lease_until = now() + cap.lease_ms; r.attempts += 1; r.retry_attempt += 1; document.provider_next_allowed_at = now() + cap.request_interval_ms;
      return {request: clone(r)};
    });
    if (!reservation.result?.request) return project(reservation.document, user, reservation.result?.error);
    const reserved = reservation.result.request;
    const query = [`limit=${reserved.page_size}`, 'sort_by=recently_touch'];
    if (reserved.collection_address !== null) query.push(`collection_address=${encodeURIComponent(reserved.collection_address)}`);
    if (reserved.started && reserved.cursor !== null) query.push(`cursor=${encodeURIComponent(reserved.cursor)}`);
    let response = null, body = '', failure = null, parsed = null;
    try {
      response = await request(`${MARKET_URL}?${query.join('&')}`, {method: 'GET', headers: {Authorization: secret, Accept: 'application/json'}, redirect: 'error'});
      body = redact(await response.text());
      if (response.url && response.url !== `${MARKET_URL}?${query.join('&')}`) failure = 'unexpected_redirect';
      else if (bytes(body) > cap.max_response_bytes) failure = 'response_too_large';
      else if ([401, 403].includes(response.status)) failure = 'authentication_failed';
      else if (response.status === 429 || [500, 502, 503, 504].includes(response.status)) failure = 'transient_http';
      else if (response.status < 200 || response.status >= 300) failure = response.status === 400 && reserved.started ? 'cursor_rejected_start_fresh' : 'http_error';
      else {try {parsed = validatePage(body, reserved.collection_address, new Date(now()).toISOString());} catch {failure = 'invalid_response';}}
    } catch {failure = 'network_error';}
    let retryable = ['network_error', 'transient_http'].includes(failure);
    const delay = retryable ? retryDelay(response, reserved.retry_attempt) : null;
    if (retryable && delay === null) {retryable = false; failure = 'invalid_retry_after';}
    const deadline = retryable ? now() + delay : null;
    const outcome = await mutate(document => {
      const r = findInput(document, input);
      // Throttling belongs to the provider, even if Stop invalidated this page.
      if (deadline !== null) document.provider_next_allowed_at = Math.max(document.provider_next_allowed_at, deadline);
      // Stop, resume, lease takeover, and an expired worker cannot publish a page.
      if (!r || r.status !== 'running' || r.lease !== lease || r.lease_until <= now()) {
        if (r?.lease === lease) {r.lease = null; r.lease_until = 0;}
        return {};
      }
      if (failure) {
        r.invalid_responses.push({observed_at: new Date(now()).toISOString(), status: response?.status ?? null, reason: failure, raw_body: body.slice(0, 16384), truncated: body.length > 16384});
        if (retryable) {document.provider_next_allowed_at = Math.max(document.provider_next_allowed_at, deadline); r.next_allowed_at = deadline;}
        finish(document, r, retryable && r.retry_attempt < cap.max_attempts ? 'ready' : 'failed', retryable ? (r.retry_attempt < cap.max_attempts ? 'retry_wait' : 'retry_exhausted') : failure);
        return {};
      }
      if (parsed.cursor !== null && r.seen_cursors.includes(parsed.cursor)) {
        r.invalid_responses.push({observed_at: new Date(now()).toISOString(), status: response.status, reason: 'cursor_cycle', raw_body: body.slice(0, 16384), truncated: body.length > 16384});
        finish(document, r, 'failed', 'cursor_cycle_start_fresh'); return {};
      }
      const page = {observed_at: new Date(now()).toISOString(), request_cursor: r.started ? r.cursor : null, request_cursor_present: r.started && r.cursor !== null, raw_body: body, listings: parsed.listings, next_cursor: parsed.cursor};
      // Preflight before the one atomic CAS: never store a next cursor without
      // its raw body and normalized observations, even at a storage boundary.
      const proposed = clone(document), target = current(proposed);
      target.pages.push(page);
      if (bytes(JSON.stringify(proposed)) + 98304 > cap.max_document_bytes) {finish(document, r, 'prototype_limit', 'storage_limit'); return {};}
      r.pages.push(page); r.cursor = parsed.cursor; r.started = true; r.retry_attempt = 0; r.next_allowed_at = 0;
      if (parsed.cursor !== null) r.seen_cursors.push(parsed.cursor);
      r.traversal_complete = parsed.cursor === null;
      finish(document, r, r.traversal_complete ? 'complete' : r.pages.length >= cap.max_pages ? 'prototype_limit' : 'ready', !r.traversal_complete && r.pages.length >= cap.max_pages ? 'page_limit' : null);
      return {};
    });
    return project(outcome.document, user, outcome.result?.error);
  }
  return {getState, startRun, stepRun, stopRun, resumeRun};
}
