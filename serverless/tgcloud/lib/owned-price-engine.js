import {canonicalAddress, instant, instantOrder} from './cloud-pricing-core.js';
import {decodePriceContract} from './ton-price-decoder.js';

// This ledger and checkpoint belong only to targeted TON price observations.
// Marketapp jobs, their pacing, portfolio membership and metadata are untouched.
export const OWNED_PRICE_LIMITS = Object.freeze({batch_size: 50, interval_ms: 1000, timeout_ms: 20000, lease_ms: 120000, invocation_attempts: 60, daily_attempts: 1000, duration_ms: 120000, retry_attempts: 3, response_bytes: 1048576});
export class OwnedPriceRequestError extends Error {}
const BASE = 'https://toncenter.com';
const ROUTES = Object.freeze({before: '/api/v3/nft/items', accounts: '/api/v3/accountStates', after: '/api/v3/nft/items'});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();
const address = value => {try {return canonicalAddress(value);} catch {return null;}};
const active = run => run?.state === 'running';
const byteSize = text => {let size = 0; for (const char of text) {const cp = char.codePointAt(0); size += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;} return size;};
const logicalTime = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const amount = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,36})$/.test(value) && BigInt(value) < (1n << 120n);
const supportedState = value => ['idle_rental_contract', 'rented', 'expired_pending_return'].includes(value);
const initial = () => ({version: 1, next_run_id: 1, run: null, history: [], sessions: [], attempts: [], next_allowed_at: 0});

function strictInput(input, keys) {
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key))) throw new OwnedPriceRequestError('Unsupported price-refresh input');
}
function summary(run) {
  if (!run) return null;
  return Object.fromEntries(['id', 'state', 'total', 'checked', 'updated', 'unresolved', 'reason', 'started_at', 'completed_at'].map(key => [key, run[key]]));
}
function scope(records) {
  const gifts = new Map(), collections = new Map(), conflicts = new Set(), settings = {};
  const remember = (nft, value) => {
    if (!nft || value === null || value === undefined || value === '') return;
    const collection = address(value);
    if (!collection) {conflicts.add(nft); return;}
    if (!collections.has(nft)) collections.set(nft, new Set());
    collections.get(nft).add(collection);
  };
  for (const envelope of records) {
    const row = envelope.record;
    if (!object(row)) continue;
    if (envelope.kind === 'settings') {Object.assign(settings, row); continue;}
    if (!['portfolio', 'metadata', 'ownership', 'listing', 'history'].includes(envelope.kind)) continue;
    let source = row.source_json ?? row.source ?? row;
    try {if (typeof source === 'string') source = JSON.parse(source);} catch {source = {};}
    const nft = address(row.nft_address || row.identity || source?.nft_address || source?.address || row.id);
    if (!nft) continue;
    remember(nft, row.collection_address);
    remember(nft, row.params?.collection_address);
    remember(nft, source?.collection_address);
    for (const value of [row.collection_addresses, row.collections]) if (Array.isArray(value)) for (const collection of value) remember(nft, collection);
    if (object(row.collection_evidence)) for (const values of Object.values(row.collection_evidence)) for (const value of Array.isArray(values) ? values : [values]) remember(nft, value);
    if (row.collection_conflict) conflicts.add(nft);
    if (envelope.kind === 'portfolio') {
      const observed = envelope.observed_at ?? row.observed_at ?? row.imported_at;
      const time = instant(observed) === null ? 0n : instantOrder(observed);
      if (!gifts.has(nft) || time >= gifts.get(nft).time) gifts.set(nft, {row, time});
    }
  }
  const wallet = address(settings.wallet ?? settings.wallet_address);
  const targets = [];
  for (const [nft, {row: gift}] of gifts) {
    const collection = address(gift.collection_address);
    if (gift.is_portfolio === true && collection && !conflicts.has(nft) && collections.get(nft)?.size === 1) targets.push({nft_address: nft, collection_address: collection});
  }
  targets.sort((a, b) => a.nft_address.localeCompare(b.nft_address));
  return {wallet, targets};
}

// Reject duplicate and out-of-scope identities, rather than picking whichever
// occurrence happens to be last. A missing row is an unresolved observation.
function parseResponse(body, stage, requested) {
  const parsed = JSON.parse(body), key = stage === 'accounts' ? 'accounts' : 'nft_items';
  if (!object(parsed) || !Array.isArray(parsed[key]) || parsed[key].length > requested.length) throw new Error('Invalid TON response');
  const allowed = new Set(requested), rows = new Map();
  for (const item of parsed[key]) {
    const id = object(item) && address(item.address);
    if (!id || !allowed.has(id) || rows.has(id)) throw new Error('Unexpected TON identity');
    rows.set(id, item);
  }
  return rows;
}
function nftEvidence(item, target, wallet) {
  if (!item) return {reason: 'nft_missing'};
  const holder = address(item.owner_address), collection = address(item.collection_address);
  if (collection !== target.collection_address) return {reason: 'collection_mismatch'};
  if (item.init !== true || !holder || !logicalTime(item.last_transaction_lt)) return {reason: 'invalid_nft_state'};
  if (holder === wallet) return {reason: 'held_directly', observed_owner: holder, nft_last_transaction_lt: item.last_transaction_lt};
  return {holding_contract: holder, nft_last_transaction_lt: item.last_transaction_lt};
}
function requestPlan(run, batchSize) {
  const targets = run.targets.slice(run.offset, run.offset + batchSize);
  const addresses = run.stage === 'accounts' ? [...new Set(run.pending.filter(row => !row.reason).map(row => row.holding_contract))] : targets.map(row => row.nft_address);
  if (!Object.hasOwn(ROUTES, run.stage) || !addresses.length || addresses.length > batchSize || addresses.some(value => address(value) !== value)) throw new OwnedPriceRequestError('Invalid saved price-refresh checkpoint');
  const query = addresses.map(value => `address=${encodeURIComponent(value)}`);
  query.push(run.stage === 'accounts' ? 'include_boc=true' : `limit=${batchSize}`);
  return {stage: run.stage, targets, addresses, url: BASE + ROUTES[run.stage] + '?' + query.join('&')};
}

export function createOwnedPriceEngine({repository, fetch: request, ownerTelegramId, now: localNow = () => Date.now(), clock = null, decodeContract = decodePriceContract, limits = {}}) {
  const cap = {...OWNED_PRICE_LIMITS};
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(cap, key) || !Number.isSafeInteger(value) || value <= 0 || (key !== 'lease_ms' && key !== 'interval_ms' && value > cap[key])) throw new OwnedPriceRequestError('Invalid price-refresh limit');
    cap[key] = value;
  }
  if (cap.interval_ms < 1000 || cap.lease_ms < cap.timeout_ms + 1) throw new OwnedPriceRequestError('Unsafe price-refresh pacing');
  let observedTime = null;
  const now = () => clock ? observedTime ?? localNow() : localNow();
  const authorize = ctx => {
    const allowed = String(ownerTelegramId ?? '');
    if (!/^[1-9]\d*$/.test(allowed) || String(ctx?.initData?.user?.id ?? '') !== allowed) throw new OwnedPriceRequestError('Private access denied');
  };
  async function refreshClock() {
    let value;
    try {value = clock ? await clock() : localNow();} catch {throw new OwnedPriceRequestError('The trusted server clock is unavailable. No TON request can start.');}
    if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) throw new OwnedPriceRequestError('The trusted server clock is unavailable. No TON request can start.');
    observedTime = Math.max(observedTime ?? value, value);
  }
  const finish = (run, state, reason = null, keepLease = false) => {
    run.state = state; run.reason = reason; run.completed_at = iso(now());
    if (!keepLease) {run.lease = null; run.lease_until = 0;}
  };
  const budget = (own, run) => {
    if (!active(run)) return false;
    const reason = now() >= run.deadline || own.next_allowed_at >= run.deadline ? 'duration_limit' : own.attempts.length >= cap.daily_attempts ? 'daily_limit' : run.attempts >= cap.invocation_attempts ? 'invocation_limit' : null;
    if (reason) {finish(run, 'partial', reason, run.lease_until > now()); return true;}
    return false;
  };
  function project(own, selected = own.run) {
    let run = summary(selected);
    if (active(selected) && now() >= selected.deadline) run = {...run, state: 'partial', reason: 'duration_limit', completed_at: iso(selected.deadline)};
    return {run, next_allowed_at: Math.max(own.next_allowed_at, own.run?.lease_until || 0), server_time: now()};
  }
  async function mutate(change) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const {revision, state: saved} = await repository.read();
      await refreshClock();
      const state = copy(saved), own = state.owned_prices || (state.owned_prices = initial());
      own.attempts = own.attempts.filter(at => at > now() - 86400000);
      const result = await change(own, revision);
      if (result?.skip) return {own, value: result.value};
      if (await repository.append(revision, {key: `owned-price:${revision + 1}`, state, job: null, records: result?.records || [], raw_body: result?.raw_body ?? null, observed_at: iso(now())})) return {own, value: result?.value};
    }
    throw new OwnedPriceRequestError('Another request updated saved state. Reload the saved refresh status.');
  }
  function identify(input) {
    strictInput(input, ['run_id']);
    if (!Number.isSafeInteger(input.run_id) || input.run_id <= 0) throw new OwnedPriceRequestError('Invalid price-refresh identifier');
    return input.run_id;
  }
  const find = (own, id) => own.run?.id === id ? own.run : own.history.find(run => run.id === id);
  const unresolved = (row, reason) => ({nft_address: row.nft_address, collection_address: row.collection_address, verified: false, reason, ...(row.holding_contract ? {holding_contract: row.holding_contract} : {}), ...(row.observed_owner ? {observed_owner: row.observed_owner} : {})});
  function observations(run, rows) {
    // Rechecking an NFT proves holder stability, not that the earlier contract
    // terms were observed again. Keep price recency at the account-read time.
    return rows.map((record, index) => ({kind: 'owned_price', key: `owned-price:${run.id}:${run.offset + index}`,
      observed_at: record.verified ? record.contract_observed_at : iso(now()),
      record: {...record, checked_at: iso(now()), ...(record.verified ? {rechecked_at: iso(now())} : {})}}));
  }
  function commitBatch(run, rows) {
    const records = observations(run, rows);
    run.checked += rows.length; run.updated += rows.filter(row => row.verified === true).length; run.unresolved += rows.filter(row => row.verified !== true).length;
    run.offset += rows.length; run.pending = []; run.stage = 'before'; run.stage_attempts = 0;
    if (run.offset >= run.total) finish(run, 'complete');
    return records;
  }
  async function getStatus(ctx) {
    authorize(ctx); await refreshClock();
    const {state} = await repository.read();
    return project(state.owned_prices || initial());
  }
  async function start(ctx, input = {}) {
    authorize(ctx); strictInput(input, ['session_id']);
    if (typeof input.session_id !== 'string' || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.session_id)) throw new OwnedPriceRequestError('Invalid page-session identifier');
    const result = await mutate(async own => {
      const previous = own.sessions.find(session => session.id === input.session_id);
      if (previous) return {skip: true, value: previous.run_id};
      if (active(own.run) && now() >= own.run.deadline) finish(own.run, 'partial', 'duration_limit', own.run.lease_until > now());
      if (active(own.run) || own.run?.lease_until > now()) {
        own.sessions.push({id: input.session_id, run_id: own.run.id});
        return {value: own.run.id};
      }
      const frozen = scope(await repository.records());
      await refreshClock();
      if (own.run) own.history.push(summary(own.run));
      const run = own.run = {id: own.next_run_id++, state: 'running', total: frozen.targets.length, checked: 0, updated: 0, unresolved: 0, reason: null,
        started_at: iso(now()), completed_at: null, wallet: frozen.wallet, targets: frozen.targets, offset: 0, stage: 'before', stage_attempts: 0, pending: [], attempts: 0, deadline: now() + cap.duration_ms, lease: null, lease_until: 0};
      own.sessions.push({id: input.session_id, run_id: run.id});
      if (!run.wallet) finish(run, 'partial', 'wallet_not_configured');
      else if (!run.total) finish(run, 'complete', 'no_known_portfolio');
      else budget(own, run);
      return {value: run.id};
    });
    return project(result.own, find(result.own, result.value));
  }
  async function stop(ctx, input = {}) {
    authorize(ctx); const id = identify(input);
    const result = await mutate(own => {
      const run = find(own, id);
      if (!run) throw new OwnedPriceRequestError('Unknown price-refresh run');
      if (!active(run)) return {skip: true};
      finish(run, 'partial', 'stopped_by_you', run.lease_until > now());
      return {};
    });
    return project(result.own, find(result.own, id));
  }
  function retryDeadline(response, attempts) {
    const value = response?.headers?.get?.('Retry-After');
    let delay = 0;
    if (value !== null && value !== undefined && value !== '') {
      if (typeof value !== 'string') return null;
      if (/^\d+(?:\.\d+)?$/.test(value.trim())) delay = Math.ceil(Number(value.trim()) * 1000);
      else {const date = Date.parse(value); if (!Number.isFinite(date)) return null; delay = Math.max(0, date - now());}
    }
    const deadline = now() + Math.max(delay, Math.min(30000, 1000 * 2 ** (attempts - 1)));
    return Number.isSafeInteger(deadline) && deadline <= 8640000000000000 ? deadline : null;
  }
  async function step(ctx, input = {}) {
    authorize(ctx); const id = identify(input);
    const reserved = await mutate((own, revision) => {
      const run = find(own, id);
      if (!run) throw new OwnedPriceRequestError('Unknown price-refresh run');
      if (!active(run) || run.lease_until > now()) return {skip: true};
      if (budget(own, run)) return {};
      if (own.next_allowed_at > now()) return {skip: true};
      if (run.stage_attempts >= cap.retry_attempts) {finish(run, 'failed', 'retry_exhausted'); return {};}
      const plan = requestPlan(run, cap.batch_size);
      run.lease = `owned-price:${id}:${revision + 1}`; run.lease_until = now() + cap.lease_ms; run.stage_attempts++; run.attempts++;
      own.attempts.push(now()); own.next_allowed_at = now() + cap.interval_ms;
      return {value: {plan, run: copy(run), began: now()}};
    });
    if (!reserved.value) return project(reserved.own, find(reserved.own, id));
    const {plan, run: snapshot, began} = reserved.value;
    await refreshClock();
    if (now() >= snapshot.deadline || now() >= snapshot.lease_until) {
      const result = await mutate(own => {if (own.run?.lease === snapshot.lease) finish(own.run, 'partial', 'duration_limit');});
      return project(result.own, find(result.own, id));
    }
    let response = null, body = '', failure = null, parsed = null, timer = null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      if (controller && typeof setTimeout === 'function') timer = setTimeout(() => controller.abort(), cap.timeout_ms);
      response = await request(plan.url, {method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error', timeout: cap.timeout_ms, ...(controller ? {signal: controller.signal} : {})});
      body = await response.text();
      if (typeof body !== 'string') failure = 'invalid_response';
      else if (response.url && response.url !== plan.url || response.redirected === true) failure = 'unexpected_redirect';
      else if (byteSize(body) > cap.response_bytes) failure = 'response_too_large';
      else if (!Number.isInteger(response.status)) failure = 'invalid_response';
      else if (response.status === 429 || [500, 502, 503, 504].includes(response.status)) failure = 'transient_http';
      else if (response.status < 200 || response.status >= 300) failure = 'http_error';
    } catch {failure = controller?.signal.aborted ? 'request_timeout' : 'network_error';}
    finally {if (timer !== null) clearTimeout(timer);}
    await refreshClock();
    if (now() - began >= cap.timeout_ms) failure = 'request_timeout';
    if (!failure) {try {parsed = parseResponse(body, plan.stage, plan.addresses);} catch {failure = 'invalid_response';}}
    let retryable = ['transient_http', 'network_error', 'request_timeout'].includes(failure);
    const retryAt = retryable ? retryDeadline(response, snapshot.stage_attempts) : null;
    if (retryable && retryAt === null) {retryable = false; failure = 'invalid_retry_after';}
    // Decode only the bounded account batch. Keep the raw response as evidence,
    // but carry no BOC blobs into every subsequent checkpoint document.
    let decoded = null;
    if (!failure && plan.stage === 'accounts') {
      decoded = [];
      for (const row of snapshot.pending) {
        if (row.reason) {decoded.push(row); continue;}
        const account = parsed.get(row.holding_contract);
        let result;
        try {result = !account ? {verified: false, reason: 'account_missing'} : !logicalTime(account.last_transaction_lt) ? {verified: false, reason: 'invalid_account_state'} : await decodeContract(account, row.nft_address, snapshot.wallet, iso(now()));} catch {result = {verified: false, reason: 'invalid_contract_data'};}
        let reason = typeof result?.reason === 'string' && result.reason.length <= 160 ? result.reason : 'unverified_contract';
        if (result?.verified === true) reason = !supportedState(result.rental_state) ? 'unsupported_rental_state' : !amount(result.configured_price_per_day_raw) ? 'invalid_configured_price' : address(result.owner) !== snapshot.wallet ? 'owner_mismatch' : address(result.nft) !== row.nft_address ? 'nft_mismatch' : address(result.holding_contract) !== row.holding_contract ? 'holder_mismatch' : result.code_hash_verified !== true || result.data_hash_verified !== true ? 'unverified_contract_hashes' : null;
        const verified = result?.verified === true && reason === null;
        const evidence = {verified, reason: verified ? 'verified_contract_price' : reason};
        for (const key of ['code_hash', 'data_hash', 'decoder_version', 'contract_variant', 'storage_layout_version', 'rental_state', 'account_last_transaction_lt', 'code_hash_verified', 'data_hash_verified', 'marketplace', 'role', 'status', 'counterpart']) if (['string', 'boolean', 'number'].includes(typeof result?.[key])) evidence[key] = result[key];
        if (result?.counterpart === null) evidence.counterpart = null;
        if (verified) {evidence.owner = snapshot.wallet; evidence.configured_price_per_day_raw = result.configured_price_per_day_raw; evidence.contract_observed_at = iso(now());}
        decoded.push({...row, decoded: evidence});
      }
    }
    const outcome = await mutate(own => {
      if (retryAt !== null) own.next_allowed_at = Math.max(own.next_allowed_at, retryAt);
      const run = own.run;
      const event = {raw_body: JSON.stringify({provider: 'toncenter', endpoint: ROUTES[plan.stage], addresses: plan.addresses, stage: plan.stage, status: response?.status ?? null, failure, body: typeof body === 'string' && byteSize(body) <= cap.response_bytes ? body : null, truncated: typeof body === 'string' && byteSize(body) > cap.response_bytes, observed_at: iso(now())})};
      if (!run || run.id !== id || run.lease !== snapshot.lease) return event;
      const leaseExpired = run.lease_until <= now();
      run.lease = null; run.lease_until = 0;
      if (!active(run)) return event;
      if (now() >= run.deadline || leaseExpired) {finish(run, 'partial', leaseExpired ? 'request_lease_expired' : 'duration_limit'); return event;}
      if (failure) {
        if (retryable && run.stage_attempts < cap.retry_attempts) {run.reason = 'retry_wait'; budget(own, run); return event;}
        event.records = commitBatch(run, plan.targets.map(row => unresolved(row, retryable ? 'retry_exhausted' : failure)));
        finish(run, 'failed', retryable ? 'retry_exhausted' : failure); return event;
      }
      run.reason = null; run.stage_attempts = 0;
      if (plan.stage === 'before') {
        run.pending = plan.targets.map(row => ({...row, ...nftEvidence(parsed.get(row.nft_address), row, run.wallet)}));
        if (run.pending.some(row => !row.reason)) run.stage = 'accounts';
        else event.records = commitBatch(run, run.pending.map(row => unresolved(row, row.reason)));
      } else if (plan.stage === 'accounts') {run.pending = decoded; run.stage = 'after';}
      else {
        const rows = run.pending.map(row => {
          if (row.reason) return unresolved(row, row.reason);
          const after = nftEvidence(parsed.get(row.nft_address), row, run.wallet);
          if (after.reason) return unresolved(row, after.reason);
          if (after.holding_contract !== row.holding_contract || after.nft_last_transaction_lt !== row.nft_last_transaction_lt) return unresolved(row, 'nft_changed_during_refresh');
          return {...unresolved(row, row.decoded.reason), ...row.decoded, nft_last_transaction_lt: row.nft_last_transaction_lt};
        });
        event.records = commitBatch(run, rows);
      }
      budget(own, run); return event;
    });
    return project(outcome.own, find(outcome.own, id));
  }
  return {getStatus, start, step, stop};
}
