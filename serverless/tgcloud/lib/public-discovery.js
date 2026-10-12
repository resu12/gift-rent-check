// Public beta discovery. One leased, bounded, allowlisted GET per step.
import {canonicalAddress, canonicalJSON} from './cloud-pricing-core.js';
import {DECODER_VERSION, decodePriceContract, CONTRACT_VARIANTS, MARKETAPP_OPERATOR, sha256} from './ton-price-decoder.js';
import {utf8Bytes} from './personal-analytics.js';
import {fetchBoundedResponse, boundedRawEvidence} from './bounded-response.js';
import {parseCloudPage} from './cloud-engine.js';
import {discoveryJson, discoveryCollection, discoveryIdentity, parseDiscoveryTon} from './public-discovery-models.js';
import {withStorageReservation} from './storage-admission.js';

export const PUBLIC_DISCOVERY_LIMITS = Object.freeze({page_size: 50, batch_size: 25, max_candidates: 1000, max_wallet_gifts: 250, max_pages: 50, max_enumeration_pages: 200,
  invocation_attempts: 60, daily_attempts: 1000, duration_ms: 120000, interval_ms: 1000, timeout_ms: 20000, lease_ms: 120000, retry_attempts: 3, response_bytes: 1048576});
export class PublicDiscoveryError extends Error {constructor(code) {super(code); this.code = code;}}
const fail = code => {throw new PublicDiscoveryError(code);};
const copy = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => new Date(value).toISOString();
const address = value => {try {return canonicalAddress(value);} catch {return null;}};
const active = job => job && ['queued', 'running'].includes(job.state);
const strict = (input, allowed) => {if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('PUBLIC_DISCOVERY_INVALID_INPUT');};
const safeText = value => typeof value === 'string' && value.length <= 512 ? value : null;
const safeImage = value => typeof value === 'string' && value.length <= 2048 && /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(value) && !/[\s\\<>"']/.test(value) ? value : null;
function minimalMetadata(item) {
  const content = item?.content || {};
  const attributes = Array.isArray(content.attributes) ? content.attributes.filter(attr => object(attr) &&
    typeof attr.trait_type === 'string' && /^(model|backdrop)$/i.test(attr.trait_type) && typeof attr.value === 'string' && attr.value.length <= 128).slice(0, 10) : [];
  return {name: safeText(content.name), image_url: safeImage(content.image), attributes};
}
function pending(job) {return Object.values(job.candidates).filter(row => row.state === 'pending').sort((a, b) => a.nft_address.localeCompare(b.nft_address));}
function chooseStage(job) {
  if (pending(job).length) {job.stage = 'before'; job.batch = pending(job).slice(0, job.batch_size).map(row => row.nft_address); return;}
  const choices = ['holdings', 'transfers'].filter(kind => !job.enumeration[kind].complete);
  if (choices.length) {job.stage = choices.includes(job.next_enumeration) ? job.next_enumeration : choices[0]; job.next_enumeration = job.stage === 'holdings' ? 'transfers' : 'holdings'; return;}
  job.stage = 'complete'; job.state = 'complete'; job.reason = null; job.enumeration_complete = true;
}
function plan(job) {
  if (job.stage === 'catalog') return {provider: 'marketapp', path: '/v1/collections/gifts/', params: {}, url: 'https://api.marketapp.org/v1/collections/gifts/'};
  let path, params;
  if (job.stage === 'holdings') {path = '/api/v3/nft/items'; params = {owner_address: job.wallet, include_on_sale: false, limit: job.page_size, offset: job.enumeration.holdings.offset};}
  else if (job.stage === 'transfers') {path = '/api/v3/nft/transfers'; params = {owner_address: job.wallet, sort: 'desc', limit: job.page_size, offset: job.enumeration.transfers.offset}; if (job.enumeration.transfers.end_lt !== null) params.end_lt = job.enumeration.transfers.end_lt;}
  else if (job.stage === 'before' || job.stage === 'after') {path = '/api/v3/nft/items'; params = {address: job.stage === 'after' ? job.pending.map(row => row.nft_address) : job.batch, limit: job.batch_size};}
  else if (job.stage === 'accounts') {path = '/api/v3/accountStates'; params = {address: [...new Set(job.pending.map(row => row.holding_contract).filter(Boolean))].sort(), include_boc: true};}
  else fail('PUBLIC_DISCOVERY_INVALID_CHECKPOINT');
  const query = []; for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) query.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
  return {provider: 'toncenter', path, params, url: `https://toncenter.com${path}?${query.join('&')}`};
}
function project(job, at, readonly = false) {
  const candidates = Object.values(job.candidates || {}), completed = candidates.filter(row => row.state === 'done').length;
  return {id: job.id, kind: 'discover', state: job.state === 'stopped' ? 'partial' : job.state, created_at: job.created_at, updated_at: job.updated_at, reason: job.reason,
    run_id: job.id, stop_requested: job.reason === 'stopped_by_you', resume_supported: !['candidate_limit', 'gift_limit', 'enumeration_page_limit', 'invalid_response', 'wallet_changed', 'decoder_changed'].includes(job.reason), collection_window: null,
    progress: {provider: job.stage === 'catalog' ? 'marketapp' : 'toncenter', pages: job.pages, observations: completed,
      candidates: candidates.length, verified: job.verified, unresolved: job.unresolved, enumeration_complete: job.enumeration_complete === true,
      next_allowed_at: Math.max(job.next_allowed_at || 0, job.lease_until || 0), server_time: at, lease_until: job.lease_until || 0,
      requires_resume: readonly && active(job) && (job.lease_until || 0) <= at,
      sync: {phase: job.state === 'complete' ? 'complete' : ['before', 'accounts', 'after'].includes(job.stage) ? 'verifying' : 'discovering', completed, total: job.enumeration_complete ? candidates.length : null, unit: 'gifts', current_collection: null, processed_items: candidates.length},
      discovery_limits: {max_candidates: job.max_candidates, max_wallet_gifts: job.max_wallet_gifts, max_enumeration_pages: job.max_enumeration_pages, page_size: job.page_size, batch_size: job.batch_size},
    }};
}

export function createPublicDiscoveryEngine({repository, fetch: request, ownerTelegramId, marketappToken, enabled = false,
  clock = () => repository.clock(), decodeContract = decodePriceContract, limits = {}}) {
  const cap = {...PUBLIC_DISCOVERY_LIMITS};
  for (const [key, value] of Object.entries(limits)) {if (!Object.hasOwn(cap, key) || !Number.isSafeInteger(value) || value <= 0 || value > cap[key]) fail('PUBLIC_DISCOVERY_CONFIGURATION'); cap[key] = value;}
  if (cap.interval_ms < 1000 || cap.lease_ms <= cap.timeout_ms) fail('PUBLIC_DISCOVERY_CONFIGURATION');
  const secret = typeof marketappToken === 'string' ? marketappToken : '';
  const authorize = ctx => {const owner = String(ownerTelegramId ?? ''); if (!enabled || !/^[1-9]\d{0,19}$/.test(owner) || String(ctx?.initData?.user?.id ?? '') !== owner) fail('PUBLIC_ACCESS_DENIED');};
  async function now() {const at = await clock(); if (!Number.isSafeInteger(at) || at <= 0) fail('PUBLIC_DISCOVERY_CLOCK'); return at;}
  const identify = input => {const id = input.job_id ?? input.id; if (!Number.isSafeInteger(id) || id <= 0) fail('PUBLIC_DISCOVERY_INVALID_INPUT'); return id;};
  const find = (state, id) => {if (state.job?.kind !== 'discover' || state.job.id !== id) fail('PUBLIC_DISCOVERY_NOT_FOUND'); return state.job;};
  async function mutate(change,storageToken=null,storageControl=false) {
    for (let turn = 0; turn < 16; turn++) {
      const {revision, state: saved} = await repository.read(), state = copy(saved), at = await now();
      const event = await change(state, at, revision);
      if (event?.skip) return {state: saved, value: event.value, at};
      if (await repository.append(revision, {key: event?.key || `discovery:${revision + 1}`, state, job: state.job,
        records: event?.records || [], raw_body: event?.raw_body ?? null, observed_at: iso(at),
        storage_token:storageToken,storage_control:storageControl})) return {state, value: event?.value, at};
    }
    fail('CONFLICT');
  }
  function finish(job, state, reason, at) {job.state = state; job.reason = reason; job.updated_at = iso(at); job.lease = null; job.lease_until = 0;}
  function pause(state, job, at) {
    state.discovery_attempts ||= []; state.discovery_attempts = state.discovery_attempts.filter(time => time > at - 86400000);
    const reason = state.discovery_attempts.length >= cap.daily_attempts ? 'daily_limit' : job.invocation_used >= cap.invocation_attempts ? 'invocation_limit' : at >= job.invocation_deadline ? 'duration_limit' : job.invocation_pages >= cap.max_pages ? 'page_limit' : null;
    if (reason) finish(job, 'partial', reason, at); return Boolean(reason);
  }
  async function settings() {
    const records = await repository.records(), saved = {}, gifts = new Map();
    for (const envelope of records) {
      if (envelope.kind === 'settings') Object.assign(saved, envelope.record);
      if (envelope.kind === 'portfolio') {const nft = address(envelope.record?.nft_address); if (nft) gifts.set(nft, envelope.record);}
    }
    if (!address(saved.wallet) || saved.wallet_verification !== 'ton_proof' || typeof saved.wallet_verified_at !== 'string' || !Number.isFinite(Date.parse(saved.wallet_verified_at))) fail('PUBLIC_WALLET_REQUIRED');
    return {wallet: address(saved.wallet), gifts};
  }
  async function configuredWallet() {
    const records = typeof repository.analyticsWalletRecords === 'function' ? await repository.analyticsWalletRecords() : await repository.records();
    const saved = {}; for (const envelope of records) if (envelope.kind === 'settings') Object.assign(saved, envelope.record);
    if (!address(saved.wallet) || saved.wallet_verification !== 'ton_proof' || typeof saved.wallet_verified_at !== 'string' || !Number.isFinite(Date.parse(saved.wallet_verified_at))) fail('PUBLIC_WALLET_REQUIRED');
    return {wallet: address(saved.wallet)};
  }
  function validCheckpoint(job) {
    if (job.decoder_version !== DECODER_VERSION) fail('PUBLIC_DISCOVERY_DECODER_CHANGED');
    if (!address(job.wallet) || job.wallet !== address(job.wallet) || !Number.isSafeInteger(job.page_size) || job.page_size < 1 || job.page_size > cap.page_size || !Number.isSafeInteger(job.batch_size) || job.batch_size < 1 || job.batch_size > cap.batch_size ||
        !object(job.candidates) || Object.keys(job.candidates).length > cap.max_candidates || !Array.isArray(job.catalog) || job.catalog.some(value => address(value) !== value) ||
        !object(job.enumeration) || !['holdings', 'transfers'].every(kind => object(job.enumeration[kind]) && Number.isSafeInteger(job.enumeration[kind].offset) && job.enumeration[kind].offset >= 0)) fail('PUBLIC_DISCOVERY_INVALID_CHECKPOINT');
  }
  async function startJob(ctx, input = {}) {
    authorize(ctx); strict(input, ['kind']); if (input.kind !== 'discover') fail('PUBLIC_DISCOVERY_INVALID_INPUT'); if (!secret.trim()) fail('PUBLIC_KEY_REQUIRED');
    const {wallet, gifts} = await settings();
    if(typeof repository.compactCompletedDiscoveryCheckpoints==='function')await repository.compactCompletedDiscoveryCheckpoints(25);
    const result = await mutate((state, at) => {
      if (active(state.job)) {if (state.job.kind === 'discover' && state.job.wallet === wallet) return {skip: true}; fail('ACTIVE_JOB');}
      if ((state.job?.lease_until || 0) > at) fail('LEASE_ACTIVE');
      const candidates = Object.create(null);
      for (const [nft, gift] of gifts) if (gift.is_portfolio) candidates[nft] = {nft_address: nft, collection_addresses: gift.collection_address ? [address(gift.collection_address)].filter(Boolean) : [], sources: ['previously_verified'], state: 'pending', prior: gift};
      if (Object.keys(candidates).length > cap.max_wallet_gifts) fail('PUBLIC_DISCOVERY_GIFT_LIMIT');
      state.next_job_id ||= 1;
      state.job = {id: state.next_job_id++, kind: 'discover', state: 'running', reason: null, created_at: iso(at), updated_at: iso(at), wallet,
        decoder_version: DECODER_VERSION, catalog: [], stage: 'catalog', enumeration: {holdings: {offset: 0, complete: false, seen_pages: []}, transfers: {offset: 0, end_lt: null, upper_lt: null, complete: false, seen_pages: []}}, next_enumeration: 'holdings',
        page_size: cap.page_size, batch_size: cap.batch_size, max_candidates: cap.max_candidates, max_wallet_gifts: cap.max_wallet_gifts, max_enumeration_pages: cap.max_enumeration_pages,
        candidates, batch: [], pending: [], verified: 0, unresolved: 0, portfolio_count: Object.keys(candidates).length, pages: 0, enumeration_complete: false,
        invocation_used: 0, invocation_pages: 0, invocation_deadline: at + cap.duration_ms, retry: 0, next_allowed_at: 0, lease: null, lease_until: 0};
      return {};
    });
    return {job: project(result.state.job, result.at)};
  }
  function addCandidates(job, additions) {
    const fresh = new Set(additions.filter(row => !Object.hasOwn(job.candidates, row.nft_address)).map(row => row.nft_address));
    if (Object.keys(job.candidates).length + fresh.size > job.max_candidates) return false;
    for (const added of additions) {
      const row = job.candidates[added.nft_address] ||= {nft_address: added.nft_address, collection_addresses: [], sources: [], state: 'pending'};
      const collection = address(added.collection_address);
      if (added.collection_conflict) row.collection_conflict = true;
      if (collection && !row.collection_addresses.includes(collection)) {row.collection_addresses.push(collection); if (row.state === 'done' && row.collection_addresses.length > 1) {row.state = 'pending'; row.rechecking_conflict = true;}}
      if (!row.sources.includes(added.source)) row.sources.push(added.source);
    }
    return true;
  }
  function observations(job, results, at) {
    const records = [];
    const newMembers = results.filter(result => result.verified && !job.candidates[result.nft_address].prior?.is_portfolio).length;
    if (job.portfolio_count + newMembers > job.max_wallet_gifts) {finish(job, 'partial', 'gift_limit', at); return null;}
    for (const result of results) {
      const candidate = job.candidates[result.nft_address], observedAt = result.observed_at || iso(at);
      const metadata = result.metadata || {}, evidence = {...result}; delete evidence.metadata;
      records.push({kind: 'ownership', key: `discovery-ownership:${job.id}:${result.nft_address}:${job.pages}`, observed_at: observedAt, record: {...evidence, wallet_address: job.wallet, decoder_version: DECODER_VERSION, provider: 'toncenter', collection_addresses: candidate.collection_addresses, collection_conflict: result.reason === 'collection_conflict', attributes: metadata.attributes || []}});
      const statusTime = result.contract_observed_at || result.nft_observed_at || observedAt;
      records.push({kind: 'owned_status', key: `discovery-status:${job.id}:${result.nft_address}:${job.pages}`, observed_at: statusTime,
        record: {...evidence, wallet: job.wallet, owner: result.verified ? job.wallet : result.owner ?? null, observed_owner: result.holding_contract || (result.verified ? job.wallet : null),
          provider: 'toncenter', decoder_version: DECODER_VERSION, semantics_version: 'ton-owned-rental-status-v1', checked_at: iso(at), rechecked_at: result.nft_rechecked_at || null,
          rental_until_unit: 'Unix seconds', rental_duration_unit: 'seconds'}});
      if (result.verified && typeof result.configured_price_per_day_raw === 'string' && /^\d{1,37}$/.test(result.configured_price_per_day_raw) && BigInt(result.configured_price_per_day_raw) < 1n << 120n) {
        records.push({kind: 'owned_price', key: `discovery-price:${job.id}:${result.nft_address}:${job.pages}`, observed_at: result.contract_observed_at,
          record: {...evidence, owner: job.wallet, checked_at: iso(at), rechecked_at: result.nft_rechecked_at, configured_price_per_day_raw_unit: 'nanoGRAM'}});
      }
      const verified = result.verified === true, member = verified || candidate.prior?.is_portfolio === true;
      if (verified && !candidate.prior?.is_portfolio) job.portfolio_count++;
      const gift = {...(candidate.prior || {}), nft_address: result.nft_address, collection_address: result.collection_address || candidate.prior?.collection_address || null,
        name: metadata.name || candidate.prior?.name || null, image_url: metadata.image_url || candidate.prior?.image_url || null,
        is_portfolio: member, automatic_membership: member, membership_sources: member ? ['verified_ton'] : [],
        verification_method: verified ? result.ownership_type === 'direct' ? 'direct_owner_match' : 'verified_rental_owner' : candidate.prior?.verification_method || null,
        category: member ? 'portfolio' : 'unresolved', state: verified ? result.rental_state : 'unknown', ui_state: null,
        status_is_historical: !verified, status_observed_at: statusTime, observed_at: observedAt, collection_conflict: result.reason === 'collection_conflict',
        uncertainties: verified ? [] : [result.reason], proof_badges: verified ? ['TON ownership verified'] : []};
      records.push({kind: 'portfolio', key: `discovery-portfolio:${job.id}:${result.nft_address}:${job.pages}`, observed_at: observedAt, record: gift});
      if (verified) candidate.prior = {nft_address: gift.nft_address, collection_address: gift.collection_address, is_portfolio: true, name: gift.name, image_url: gift.image_url, verification_method: gift.verification_method};
      if (candidate.state !== 'done') {candidate.state = 'done'; if (verified) job.verified++; else job.unresolved++;}
    }
    return records;
  }
  function beforeRows(job, items, at) {
    const map = new Map(items.map(item => [address(item.address), item])), results = [], rental = [];
    for (const nft of job.batch) {
      const item = map.get(nft), candidate = job.candidates[nft], current = item ? discoveryCollection(item) : {collection: null};
      const base = {nft_address: nft, collection_address: current.collection, verified: false, rental_state: 'unknown', observed_at: iso(at), metadata: minimalMetadata(item)};
      const holder = address(item?.owner_address);
      if (!item) base.reason = 'item_not_found';
      else if (candidate.collection_conflict || current.conflict || candidate.collection_addresses.some(value => value !== current.collection)) base.reason = 'collection_conflict';
      else if (!current.collection) base.reason = 'missing_collection';
      else if (!job.catalog.includes(current.collection)) base.reason = 'unsupported_collection';
      else if (item.init !== true || item.last_transaction_lt === undefined || item.last_transaction_lt === null || !holder) base.reason = 'invalid_nft_state';
      else if (holder === job.wallet) {rental.push({...base, verified: true, reason: 'direct_owner_match', rental_state: 'held_directly', ownership_type: 'direct', nft_last_transaction_lt: item.last_transaction_lt,
        nft_identity: discoveryIdentity(item), nft_observed_at: iso(at)}); continue;}
      else {rental.push({...base, holding_contract: holder, nft_last_transaction_lt: item.last_transaction_lt, nft_identity: discoveryIdentity(item), nft_observed_at: iso(at)}); continue;}
      results.push(base);
    }
    return {results, rental};
  }
  function contractRows(job, accounts, at) {
    const map = new Map(accounts.map(row => [address(row.address), row]));
    return job.pending.map(row => {
      if (row.ownership_type === 'direct') return row;
      const account = map.get(row.holding_contract), decoded = account ? decodeContract(account, row.nft_address, job.wallet, iso(at)) : {verified: false, reason: 'holding_account_not_found'};
      const trusted = decoded?.verified === true && address(decoded.owner) === job.wallet && address(decoded.nft) === row.nft_address && address(decoded.holding_contract) === row.holding_contract &&
        address(decoded.marketplace) === MARKETAPP_OPERATOR && Object.hasOwn(CONTRACT_VARIANTS, decoded.code_hash) && decoded.code_hash_verified === true && decoded.data_hash_verified === true && /^[a-f0-9]{64}$/.test(decoded.data_hash || '');
      const verified = trusted && ['idle_rental_contract', 'rented', 'expired_pending_return'].includes(decoded.rental_state);
      const contract = {}; for (const field of ['owner', 'nft', 'marketplace', 'code_hash', 'data_hash', 'code_hash_verified', 'data_hash_verified', 'rental_state', 'role', 'status', 'rental_until', 'rental_duration', 'renter', 'counterpart', 'configured_price_per_day_raw', 'contract_variant', 'storage_layout_version', 'account_last_transaction_lt']) if (['string', 'number', 'boolean'].includes(typeof decoded?.[field]) || decoded?.[field] === null) contract[field] = decoded[field];
      return {...row, ...contract, verified, reason: verified ? 'verified_rental_owner' : safeText(decoded?.reason) || 'unverified_contract', rental_state: verified ? decoded.rental_state : 'unknown', ownership_type: 'rental', contract_observed_at: iso(at)};
    });
  }
  async function stepJob(ctx,input={}) {
    authorize(ctx);strict(input,['job_id','id']);identify(input);
    return withStorageReservation(repository,{kind:'discovery',responseBytes:cap.response_bytes},
      token=>stepReserved(ctx,input,token));
  }
  async function stepReserved(ctx, input = {},storageToken=null) {
    authorize(ctx); strict(input, ['job_id', 'id']); const id = identify(input), configured = await configuredWallet();
    const reserved = await mutate((state, at, revision) => {
      const job = find(state, id); validCheckpoint(job);
      if (job.wallet !== configured.wallet) {finish(job, 'failed', 'wallet_changed', at); return {};}
      if (!active(job)) return {skip: true};
      if (job.lease_until > at) fail('LEASE_ACTIVE');
      if (pause(state, job, at) || job.next_allowed_at > at) return job.state === 'running' ? {skip: true} : {};
      if (['holdings', 'transfers'].includes(job.stage) && job.pages >= job.max_enumeration_pages) {finish(job, 'partial', 'enumeration_page_limit', at); return {};}
      if (job.retry >= cap.retry_attempts) {finish(job, 'failed', 'retry_exhausted', at); return {};}
      const requestPlan = plan(job); job.lease = `discovery:${id}:${revision + 1}`; job.lease_until = at + cap.lease_ms; job.invocation_used++; job.retry++;
      state.discovery_attempts.push(at); job.next_allowed_at = at + cap.interval_ms;
      return {value: {lease: job.lease, job: copy(job), requestPlan}};
    },storageToken);
    if (!reserved.value) return {job: project(reserved.state.job, reserved.at)};
    const {lease, job: frozen, requestPlan} = reserved.value;
    let response = null, body = '', error = null, providerError = null;
    const began = await now();
    try {
      const guarded = async (...args) => {try {return await request(...args);} catch (failure) {if (typeof failure?.code === 'string' && failure.code.startsWith('PUBLIC_PROVIDER_')) providerError = failure; throw failure;}};
      const received = await fetchBoundedResponse(guarded, requestPlan.url, {method: 'GET', headers: requestPlan.provider === 'marketapp' ? {Authorization: secret, Accept: 'application/json'} : {Accept: 'application/json'}, redirect: 'error'}, {maxBytes: cap.response_bytes, timeoutMs: cap.timeout_ms, clock: now, deadlineAt: began + cap.timeout_ms});
      response = received.response; body = received.body;
    } catch (failure) {error = providerError || failure; response = failure.response || null; body = failure.body || '';}
    const result = await mutate((state, at) => {
      const job = find(state, id);
      if (!active(job) || job.lease !== lease) return {skip: true};
      const raw = {provider: requestPlan.provider, endpoint: requestPlan.path, params: requestPlan.params, status: response?.status ?? null, body: secret ? body.split(secret).join('[REDACTED]') : body, observed_at: iso(at)};
      const event = {raw_body: boundedRawEvidence(raw, cap.response_bytes)};
      if (error?.code?.startsWith('PUBLIC_PROVIDER_')) {
        // A denied shared reservation made no HTTP attempt. Undo only this
        // still-current local reservation; actual failed HTTP calls still count.
        job.invocation_used--; job.retry--; const reservedIndex = state.discovery_attempts.lastIndexOf(reserved.at); if (reservedIndex >= 0) state.discovery_attempts.splice(reservedIndex, 1);
        const readyAt = Number.isSafeInteger(error.readyAt) ? error.readyAt : error.next_allowed_at;
        job.next_allowed_at = Math.max(job.next_allowed_at, Number.isSafeInteger(readyAt) ? readyAt : at + 60000);
        const waiting = error.reason === 'provider_wait' && job.next_allowed_at < job.invocation_deadline && at < frozen.lease_until;
        finish(job, waiting ? 'running' : 'partial', waiting ? 'retry_wait' : 'daily_limit', at); return event;
      }
      if (at >= frozen.lease_until || at >= frozen.invocation_deadline) {finish(job, 'partial', 'duration_limit', at); return event;}
      if (error || response.status === 429 || response.status >= 500) {
        let delay = Math.min(30000, 1000 * 2 ** (job.retry - 1)); const retryAfter = response?.headers?.get?.('Retry-After');
        if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) delay = Math.max(delay, Math.min(86400000, Number(retryAfter) * 1000));
        job.next_allowed_at = at + delay; finish(job, job.retry < cap.retry_attempts ? 'running' : 'failed', job.retry < cap.retry_attempts ? 'retry_wait' : 'retry_exhausted', at); return event;
      }
      if (response.status !== 200) {finish(job, 'failed', response.status === 401 || response.status === 403 ? 'authentication_failed' : 'http_error', at); return event;}
      try {
        let records = [];
        if (frozen.stage === 'catalog') {
          discoveryJson(body); const parsed = parseCloudPage('collection', body, null, iso(at), `discovery-catalog:${id}`);
          if (!parsed.items.length || parsed.items.length > 1000) throw new Error();
          const catalog = parsed.items.map(item => canonicalAddress(item.address)); if (new Set(catalog).size !== catalog.length) throw new Error();
          job.catalog = catalog.sort(); records = parsed.records; chooseStage(job);
        } else if (frozen.stage === 'holdings' || frozen.stage === 'transfers') {
          const kind = frozen.stage, items = parseDiscoveryTon(body, kind === 'holdings' ? 'nft_items' : 'nft_transfers', job.page_size), checkpoint = job.enumeration[kind];
          const digest = items.length ? Array.from(sha256(utf8Bytes(canonicalJSON(items))), byte => byte.toString(16).padStart(2, '0')).join('') : null;
          if (digest && checkpoint.seen_pages.includes(digest)) throw new Error('Repeated discovery page');
          const additions = [];
          if (kind === 'holdings') for (const item of items) {const collection = discoveryCollection(item); additions.push({nft_address: canonicalAddress(item.address), collection_address: collection.collection, collection_conflict: collection.conflict, source: 'holdings'});}
          else {
            const times = items.map(item => BigInt(item.transaction_lt));
            if (times.some((time, index) => index > 0 && time > times[index - 1]) || times.length && checkpoint.end_lt !== null && times[0] > BigInt(checkpoint.end_lt)) throw new Error();
            for (const item of items) if (!item.transaction_aborted && [address(item.old_owner), address(item.new_owner)].includes(job.wallet)) additions.push({nft_address: canonicalAddress(item.nft_address), collection_address: address(item.nft_collection), source: 'transfer'});
          }
          if (!addCandidates(job, additions)) {finish(job, 'partial', 'candidate_limit', at); return event;}
          if (digest) checkpoint.seen_pages.push(digest);
          if (kind === 'transfers' && items.length && checkpoint.upper_lt === null) checkpoint.upper_lt = items[0].transaction_lt;
          if (!items.length) checkpoint.complete = true;
          else if (kind === 'holdings') checkpoint.offset += items.length;
          else {const times = items.map(item => item.transaction_lt), end = times.at(-1), offset = times.filter(time => time === end).length + (end === checkpoint.end_lt ? checkpoint.offset : 0); checkpoint.end_lt = end; checkpoint.offset = offset;}
          job.invocation_pages++; job.pages++; chooseStage(job);
        } else if (frozen.stage === 'before') {
          const items = parseDiscoveryTon(body, 'nft_items', job.batch_size, job.batch), checked = beforeRows(job, items, at);
          records = observations(job, checked.results, at); if (records === null) return event;
          job.pending = checked.rental; if (job.pending.length) job.stage = job.pending.some(row => row.holding_contract) ? 'accounts' : 'after'; else {job.batch = []; chooseStage(job);}
        } else if (frozen.stage === 'accounts') {
          const holders = [...new Set(job.pending.map(row => row.holding_contract).filter(Boolean))], accounts = parseDiscoveryTon(body, 'accounts', job.batch_size, holders);
          job.pending = contractRows(job, accounts, at); job.stage = 'after';
        } else if (frozen.stage === 'after') {
          const items = parseDiscoveryTon(body, 'nft_items', job.batch_size, job.pending.map(row => row.nft_address)), map = new Map(items.map(item => [address(item.address), item]));
          const checked = job.pending.map(row => {const after = map.get(row.nft_address), result = {...row, observed_at: iso(at), nft_rechecked_at: iso(at)}; delete result.nft_identity;
            if (discoveryIdentity(after) !== row.nft_identity) {result.verified = false; result.reason = 'changed_during_verification'; result.rental_state = 'unknown';} return result;});
          records = observations(job, checked, at); if (records === null) return event;
          job.pending = []; job.batch = []; chooseStage(job);
        } else throw new Error();
        job.retry = 0; job.lease = null; job.lease_until = 0; job.updated_at = iso(at); if (job.state === 'running') {job.reason = null; pause(state, job, at);}
        return {...event, records};
      } catch {finish(job, 'failed', 'invalid_response', at); return event;}
    },storageToken);
    return {job: project(result.state.job, result.at)};
  }
  async function resumeJob(ctx, input = {}) {
    authorize(ctx); strict(input, ['job_id', 'id']); const id = identify(input), configured = await configuredWallet();
    const result = await mutate((state, at) => {const job = find(state, id); validCheckpoint(job);
      if (job.wallet !== configured.wallet) fail('PUBLIC_DISCOVERY_WALLET_CHANGED');
      if (job.lease_until > at) fail('LEASE_ACTIVE');
      if (job.state === 'complete') return {skip: true};
      if (!['running', 'partial', 'stopped'].includes(job.state) || ['candidate_limit', 'gift_limit', 'enumeration_page_limit'].includes(job.reason)) fail('PUBLIC_DISCOVERY_NOT_RESUMABLE');
      job.invocation_used = 0; job.invocation_pages = 0; job.invocation_deadline = at + cap.duration_ms; finish(job, 'running', null, at); pause(state, job, at); return {};
    }); return {job: project(result.state.job, result.at)};
  }
  async function stopJob(ctx, input = {}) {
    authorize(ctx); strict(input, ['job_id', 'id']); const id = identify(input);
    const result = await mutate((state, at) => {const job = find(state, id); if (!active(job)) return {skip: true}; finish(job, 'partial', 'stopped_by_you', at); return {};},null,true); return {job: project(result.state.job, result.at)};
  }
  async function getJobs(ctx) {authorize(ctx); const at = await now(), jobs = await repository.jobs(); return {jobs: jobs.filter(job => job.kind === 'discover').map(job => project(job, at, true))};}
  return {startJob, stepJob, resumeJob, stopJob, getJobs};
}
