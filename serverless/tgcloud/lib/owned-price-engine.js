import {canonicalAddress, instant, instantOrder} from './cloud-pricing-core.js';
import {decodePriceContract, CONTRACT_VARIANTS, MARKETAPP_OPERATOR} from './ton-price-decoder.js';
import {fetchBoundedResponse, BoundedResponseError, boundedRawEvidence} from './bounded-response.js';
import {withStorageReservation} from './storage-admission.js';

// This ledger and checkpoint belong only to targeted TON price/status observations.
// Marketapp jobs, their pacing, portfolio membership and metadata are untouched.
export const OWNED_PRICE_LIMITS = Object.freeze({batch_size: 50, interval_ms: 1000, timeout_ms: 20000, lease_ms: 120000, invocation_attempts: 60, daily_attempts: 1000, duration_ms: 120000, retry_attempts: 3, response_bytes: 1048576});
export class OwnedPriceRequestError extends Error {
  constructor(message, code = null) {super(message); this.code = code;}
}
export function ownedPriceErrorResponse(error) {
  return error instanceof OwnedPriceRequestError && ['OWNED_PRICE_BUSY', 'OWNED_PRICE_SCOPE_CHANGED', 'OWNED_PRICE_INVALID_TARGET'].includes(error.code)
    ? {error: {code: error.code}} : null;
}
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
const STATUS_VERSION = 'ton-owned-rental-status-v1';
const initial = () => ({version: 2, next_run_id: 1, run: null, previous_run: null, last_session: null, attempts: [], next_allowed_at: 0});

function strictInput(input, keys) {
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key))) throw new OwnedPriceRequestError('Unsupported price-refresh input');
}
function summary(run) {
  if (!run) return null;
  return Object.fromEntries(['id', 'state', 'total', 'checked', 'updated', 'unresolved', 'status_updated', 'status_unresolved', 'reason', 'started_at', 'completed_at', 'scope', 'nft_address', 'wallet', 'session_id'].filter(key => run[key] !== undefined).map(key => [key, run[key]]));
}
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{16,160}$/.test(value);
const runScope = run => run?.scope ?? 'portfolio';
function scopeBuilder(wanted = null) {
  const gifts = new Map(), collections = new Map(), conflicts = new Set(), settings = {};
  const remember = (nft, value) => {
    if (!nft || value === null || value === undefined || value === '') return;
    const collection = address(value);
    if (!collection) {conflicts.add(nft); return;}
    if (!collections.has(nft)) collections.set(nft, new Set());
    // More than one collection already makes the identity ineligible. Retain
    // that conflict without accumulating unrelated historical identities.
    if (collections.get(nft).size < 2) collections.get(nft).add(collection);
  };
  function add(records) {
  for (const envelope of records) {
    const row = envelope.record;
    if (!object(row)) continue;
    if (envelope.kind === 'settings') {Object.assign(settings, row); continue;}
    if (!['portfolio', 'metadata', 'ownership', 'listing', 'history'].includes(envelope.kind)) continue;
    let source = row.source_json ?? row.source ?? row;
    try {if (typeof source === 'string') source = JSON.parse(source);} catch {source = {};}
    const nft = address(row.nft_address || row.identity || source?.nft_address || source?.address || row.id);
    if (!nft || wanted && !wanted.has(nft)) continue;
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
  }
  function finish() {
  const wallet = address(settings.wallet ?? settings.wallet_address);
  const targets = [];
  for (const [nft, {row: gift}] of gifts) {
    const collection = address(gift.collection_address);
    if (gift.is_portfolio === true && collection && !conflicts.has(nft) && collections.get(nft)?.size === 1) targets.push({nft_address: nft, collection_address: collection});
  }
  targets.sort((a, b) => a.nft_address.localeCompare(b.nft_address));
  return {wallet, targets};
  }
  return {add, finish};
}

export function ownedGiftScope(records) {const builder=scopeBuilder();builder.add(records);return builder.finish();}

// SQL only narrows candidate envelopes; canonical identity and all collection
// conflict decisions remain in the existing scope validator. Extract short
// identity fields once per record instead of scanning every event body once
// per owned NFT. Source-only legacy rows are always retained for JS parsing.
export function ownedScopeRecordFilter(identities) {
  if (!Array.isArray(identities)) throw new Error('Invalid owned scope identities');
  const values=[...new Set(identities.map(value=>{const key=address(value);if(!key)throw new Error('Invalid owned scope identity');return key;}))];
  if (!values.length) return {sql:'0',parameters:{}};
  if (values.length>256) return {sql:'1',parameters:{}};
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',parameters={},keys=[];
  for (const [index,value] of values.entries()) {
    const hex=value.split(':')[1],bytes=[0,0,...hex.match(/../g).map(pair=>parseInt(pair,16))];
    let encoded='',acc=0,bits=0;
    for (const byte of bytes) {acc=(acc<<8)|byte;bits+=8;while(bits>=6){bits-=6;encoded+=alphabet[(acc>>bits)&63];}}
    // Middle Base64 characters are independent of tag/workchain/checksum.
    // Matching them is conservative; canonical validation still runs later.
    parameters[`:scope_raw_${index}`]=hex;parameters[`:scope_friendly_${index}`]=encoded.slice(4,44);
    keys.push(`:scope_raw_${index}`,`:scope_friendly_${index}`);
  }
  // NULLIF mirrors JavaScript's empty-string/false/zero fallthrough. Do not
  // interpret nested source JSON here: SQLite and JSON.parse differ for
  // duplicate keys and maximum nesting. Source-only rows conservatively pass
  // through to the original validator, as do non-JSON event envelopes.
  const sql=`CASE WHEN json_valid(records_json) THEN CASE WHEN json_type(records_json)='array' THEN EXISTS (
    WITH scope_rows AS (SELECT json_extract(value,'$.record') AS record FROM json_each(records_json)
      WHERE CASE WHEN type='object' THEN json_extract(value,'$.kind') IN ('metadata','ownership','listing','history') AND json_type(value,'$.record')='object' ELSE 0 END),
    scope_ids AS (SELECT COALESCE(NULLIF(NULLIF(json_extract(record,'$.nft_address'),''),0),NULLIF(NULLIF(json_extract(record,'$.identity'),''),0)) AS identity FROM scope_rows)
    SELECT 1 FROM scope_ids WHERE identity IS NULL OR typeof(identity)='text' AND
      CASE WHEN instr(identity,':')>0 THEN lower(substr(identity,instr(identity,':')+1))
      ELSE replace(replace(substr(identity,5,40),'-','+'),'_','/') END IN (${keys.join(',')}) LIMIT 1
  ) ELSE 1 END ELSE 1 END`;
  return {sql,parameters};
}

export async function readOwnedGiftScope(repository, revision) {
  if (!Number.isSafeInteger(revision) || revision<0) throw new Error('Invalid owned scope revision');
  if (!repository.dashboardSeedRecords || !repository.visitRecords) return ownedGiftScope(await repository.records(revision));
  const seeds=await repository.dashboardSeedRecords(revision),wanted=new Set(ownedGiftScope(seeds).targets.map(row=>row.nft_address));
  const builder=scopeBuilder(wanted);builder.add(seeds);
  if (wanted.size) {
    const visit=repository.visitOwnedScopeRecords
      ? visitor=>repository.visitOwnedScopeRecords(revision,[...wanted],visitor)
      : visitor=>repository.visitRecords(revision,visitor);
    await visit(page=>builder.add(page.filter(row=>!['settings','portfolio'].includes(row?.kind))));
  }
  return builder.finish();
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
function contractIdentityReason(result, row, wallet) {
  if (result?.verified !== true) return typeof result?.reason === 'string' && result.reason.length <= 160 ? result.reason : 'unverified_contract';
  if (address(result.owner) !== wallet) return 'owner_mismatch';
  if (address(result.nft) !== row.nft_address) return 'nft_mismatch';
  if (address(result.holding_contract) !== row.holding_contract) return 'holder_mismatch';
  if (address(result.marketplace) !== MARKETAPP_OPERATOR) return 'operator_mismatch';
  if (!Object.hasOwn(CONTRACT_VARIANTS, result.code_hash)) return 'unsupported_code_hash';
  if (result.code_hash_verified !== true || result.data_hash_verified !== true || typeof result.data_hash !== 'string' || !/^[0-9a-f]{64}$/.test(result.data_hash)) return 'unverified_contract_hashes';
  return null;
}
function contractStatus(result, row, wallet, observedAt, identityReason) {
  const status = {verified: false, reason: identityReason || 'unsupported_rental_state', rental_state: 'unknown',
    observed_owner: row.holding_contract, holding_contract: row.holding_contract, nft_last_transaction_lt: row.nft_last_transaction_lt,
    status_observed_at: observedAt};
  for (const key of ['code_hash', 'data_hash', 'decoder_version', 'contract_variant', 'storage_layout_version', 'account_last_transaction_lt', 'code_hash_verified', 'data_hash_verified', 'marketplace', 'owner', 'nft', 'created_at', 'role', 'status', 'rental_duration', 'rental_until', 'renter', 'counterpart']) {
    if (['string', 'boolean', 'number'].includes(typeof result?.[key]) || result?.[key] === null) status[key] = result[key];
  }
  status.rental_until_unit = 'Unix seconds'; status.rental_duration_unit = 'seconds';
  if (status.created_at !== undefined) status.created_at_unit = 'Unix seconds';
  if (identityReason) return status;
  const expiry = result.rental_until;
  if (!Number.isSafeInteger(expiry) || expiry < 0 || expiry > 253402300799) {status.reason = 'invalid_rental_expiry'; return status;}
  if (result.rental_state === 'idle_rental_contract' && result.role === 0 && result.status === 0 && result.renter === null && expiry === 0) status.rental_state = 'idle_rental_contract';
  else if (['rented', 'expired_pending_return'].includes(result.rental_state) && result.role === 1 && result.status === 1 && address(result.renter) && address(result.counterpart) && expiry > 0) status.rental_state = expiry > Date.parse(observedAt) / 1000 ? 'rented' : 'expired_pending_return';
  else return status;
  status.verified = true; status.reason = 'verified_rental_status'; status.owner = wallet;
  return status;
}
function requestPlan(run, batchSize) {
  const targets = run.targets.slice(run.offset, run.offset + batchSize);
  const addresses = run.stage === 'accounts' ? [...new Set(run.pending.filter(row => !row.reason).map(row => row.holding_contract))] : targets.map(row => row.nft_address);
  if (!Object.hasOwn(ROUTES, run.stage) || !addresses.length || addresses.length > batchSize || addresses.some(value => address(value) !== value)) throw new OwnedPriceRequestError('Invalid saved price-refresh checkpoint');
  const query = addresses.map(value => `address=${encodeURIComponent(value)}`);
  query.push(run.stage === 'accounts' ? 'include_boc=true' : `limit=${batchSize}`);
  return {stage: run.stage, targets, addresses, url: BASE + ROUTES[run.stage] + '?' + query.join('&')};
}

export function createOwnedPriceEngine({repository, fetch: request, ownerTelegramId, now: localNow = () => Date.now(), clock = null, decodeContract = decodePriceContract, limits = {}, targetAddresses = null}) {
  // A trusted caller may narrow the existing portfolio. It cannot supply new
  // membership; the public endpoint never accepts this constructor option.
  const selectedTargets = targetAddresses === null ? null : new Set(targetAddresses.map(address));
  if (selectedTargets?.has(null)) throw new OwnedPriceRequestError('Invalid internal gift scope');
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
  async function mutate(change,storageToken=null) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const {revision, state: saved} = await repository.read();
      await refreshClock();
      const state = copy(saved), own = state.owned_prices || (state.owned_prices = initial());
      if (own.version !== 2 || Array.isArray(own.history) || Array.isArray(own.sessions)) {
        // Commit the recoverable indexes before removing legacy replay arrays
        // from hot state. If indexing fails, no compact event is appended.
        await repository.syncOwnedRefreshArchive();
        own.version = 2; delete own.history; delete own.sessions;
      }
      own.attempts = own.attempts.filter(at => at > now() - 86400000);
      const result = await change(own, revision, state);
      if (result?.skip) return {own, value: result.value};
      if (await repository.append(revision, {key: `owned-price:${revision + 1}`, state, job: null, records: result?.records || [], raw_body: result?.raw_body ?? null, observed_at: iso(now()),storage_token:storageToken})) return {own, value: result?.value};
    }
    throw new OwnedPriceRequestError('Another request updated saved state. Reload the saved refresh status.');
  }
  function identify(input) {
    strictInput(input, ['run_id']);
    if (!Number.isSafeInteger(input.run_id) || input.run_id <= 0) throw new OwnedPriceRequestError('Invalid price-refresh identifier');
    return input.run_id;
  }
  const find = async (own, id) => own.run?.id === id ? own.run : await repository.ownedRefreshRun(id);
  const unresolved = (row, reason) => ({nft_address: row.nft_address, collection_address: row.collection_address, verified: false, reason, ...(row.holding_contract ? {holding_contract: row.holding_contract} : {}), ...(row.observed_owner ? {observed_owner: row.observed_owner} : {})});
  function observations(run, rows) {
    // Rechecking an NFT proves holder stability, not that the earlier contract
    // terms were observed again. Keep price recency at the account-read time.
    return rows.flatMap((row, index) => {
      const {owned_status, ...record} = row;
      const result = [{kind: 'owned_price', key: `owned-price:${run.id}:${run.offset + index}`,
        observed_at: record.verified ? record.contract_observed_at : iso(now()),
        record: {...record, checked_at: iso(now()), ...(record.verified ? {rechecked_at: iso(now())} : {})}}];
      // An old, in-flight price-only checkpoint cannot gain status semantics
      // simply because deployment changed between its stages.
      if (run.status_refresh_version === STATUS_VERSION) {
        const status = owned_status || {verified: false, reason: record.reason, rental_state: 'unknown'};
        result.push({kind: 'owned_status', key: `owned-status:${run.id}:${run.offset + index}`,
          observed_at: status.verified ? status.status_observed_at : iso(now()),
          record: {nft_address: record.nft_address, collection_address: record.collection_address, wallet: run.wallet,
            provider: 'toncenter', semantics_version: STATUS_VERSION, ...status, checked_at: iso(now()),
            ...(status.verified ? {rechecked_at: iso(now())} : {})}});
      }
      return result;
    });
  }
  function commitBatch(run, rows) {
    const records = observations(run, rows);
    run.checked += rows.length; run.updated += rows.filter(row => row.verified === true).length; run.unresolved += rows.filter(row => row.verified !== true).length;
    if (run.status_refresh_version === STATUS_VERSION) {
      run.status_updated += rows.filter(row => row.owned_status?.verified === true).length;
      run.status_unresolved += rows.filter(row => row.owned_status?.verified !== true).length;
    }
    run.offset += rows.length; run.pending = []; run.stage = 'before'; run.stage_attempts = 0;
    if (run.offset >= run.total) finish(run, 'complete');
    return records;
  }
  async function getStatus(ctx, input = {}) {
    authorize(ctx); strictInput(input, ['session_id']);
    if (Object.hasOwn(input, 'session_id') && !sessionId(input.session_id)) throw new OwnedPriceRequestError('Invalid page-session identifier');
    await refreshClock();
    const {state} = await repository.read();
    const own = state.owned_prices || initial();
    if (!Object.hasOwn(input, 'session_id')) return project(own);
    const id = await repository.ownedRefreshSession(input.session_id);
    return project(own, id === null ? null : await find(own, id));
  }
  async function start(ctx, input = {}) {
    authorize(ctx); strictInput(input, ['session_id', 'nft_address']);
    if (!sessionId(input.session_id)) throw new OwnedPriceRequestError('Invalid page-session identifier');
    const requested = Object.hasOwn(input, 'nft_address') ? address(input.nft_address) : null;
    if (Object.hasOwn(input, 'nft_address') && !requested) throw new OwnedPriceRequestError('This gift cannot be checked.', 'OWNED_PRICE_INVALID_TARGET');
    const requestedScope = requested ? 'gift' : 'portfolio';
    const result = await mutate(async (own, revision, state) => {
      const personal = state.gift_refresh?.run;
      if (personal?.state === 'running' && personal.stage === 'website' && personal.deadline > now()) {
        throw new OwnedPriceRequestError('A personal gift refresh is already running.', 'OWNED_PRICE_BUSY');
      }
      const previous = await repository.ownedRefreshSession(input.session_id);
      // Scope is bound to the original committed session. A stale browser may
      // replay it, but cannot reinterpret it as another gift or wallet check.
      let frozen;
      if (requested || previous !== null) {frozen = await readOwnedGiftScope(repository,revision); await refreshClock();}
      if (previous !== null) {
        const original = await find(own, previous);
        if (!original || runScope(original) !== requestedScope || (requested && original.nft_address !== requested)
          || (Object.hasOwn(original, 'scope') && original.wallet !== frozen.wallet)
          || selectedTargets && (original.targets?.length !== selectedTargets.size || original.targets.some(target => !selectedTargets.has(target.nft_address)))) {
          throw new OwnedPriceRequestError('This check belongs to another gift or wallet. Start a new check.', 'OWNED_PRICE_SCOPE_CHANGED');
        }
        return {skip: true, value: previous};
      }
      if (requested && (!frozen.wallet || !frozen.targets.some(target => target.nft_address === requested))) {
        throw new OwnedPriceRequestError('This gift is not eligible for a saved-wallet check.', 'OWNED_PRICE_INVALID_TARGET');
      }
      if (active(own.run) && now() >= own.run.deadline) finish(own.run, 'partial', 'duration_limit', own.run.lease_until > now());
      if (active(own.run) || own.run?.lease_until > now()) {
        if (selectedTargets && (own.run.targets.length !== selectedTargets.size || own.run.targets.some(target => !selectedTargets.has(target.nft_address)))) throw new OwnedPriceRequestError('A different gift check is already running.', 'OWNED_PRICE_BUSY');
        // A targeted action must observe the post-edit state, not join a check
        // whose evidence may already have been read before the manual edit.
        if (requested || runScope(own.run) === 'gift') throw new OwnedPriceRequestError('A gift check is already running. Wait for it to finish.', 'OWNED_PRICE_BUSY');
        own.last_session = {id: input.session_id, run_id: own.run.id};
        return {value: own.run.id};
      }
      frozen ??= await readOwnedGiftScope(repository,revision);
      if (requested && selectedTargets && !selectedTargets.has(requested)) throw new OwnedPriceRequestError('The gift is outside this check.', 'OWNED_PRICE_INVALID_TARGET');
      if (selectedTargets) frozen = {...frozen, targets: frozen.targets.filter(target => selectedTargets.has(target.nft_address))};
      await refreshClock();
      if (own.run) own.previous_run = summary(own.run);
      const targets = requested ? frozen.targets.filter(target => target.nft_address === requested) : frozen.targets;
      const run = own.run = {id: own.next_run_id++, state: 'running', total: targets.length, checked: 0, updated: 0, unresolved: 0, status_updated: 0, status_unresolved: 0, status_refresh_version: STATUS_VERSION, reason: null,
        scope: requestedScope, nft_address: requested, session_id: input.session_id,
        started_at: iso(now()), completed_at: null, wallet: frozen.wallet, targets, offset: 0, stage: 'before', stage_attempts: 0, pending: [], attempts: 0, deadline: now() + cap.duration_ms, lease: null, lease_until: 0};
      own.last_session = {id: input.session_id, run_id: run.id};
      if (!run.wallet) finish(run, 'partial', 'wallet_not_configured');
      else if (!run.total) finish(run, 'complete', 'no_known_portfolio');
      else budget(own, run);
      return {value: run.id};
    });
    return project(result.own, await find(result.own, result.value));
  }
  async function stop(ctx, input = {}) {
    authorize(ctx); const id = identify(input);
    const result = await mutate(async own => {
      const run = await find(own, id);
      if (!run) throw new OwnedPriceRequestError('Unknown price-refresh run');
      if (!active(run)) return {skip: true};
      finish(run, 'partial', 'stopped_by_you', run.lease_until > now());
      return {};
    });
    return project(result.own, await find(result.own, id));
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
    authorize(ctx);identify(input);
    return await withStorageReservation(repository,{kind:'ton_gifts',responseBytes:cap.response_bytes},token=>stepAdmitted(ctx,input,token));
  }
  async function stepAdmitted(ctx,input,storageToken) {
    const admitted=change=>mutate(change,storageToken);
    authorize(ctx); const id = identify(input);
    const reserved = await admitted(async (own, revision) => {
      const run = await find(own, id);
      if (!run) throw new OwnedPriceRequestError('Unknown price-refresh run');
      if (!active(run) || run.lease_until > now()) return {skip: true};
      if (runScope(run) === 'gift') {
        if (run.total !== 1 || run.targets?.length !== 1 || address(run.nft_address) !== run.nft_address
          || run.targets[0].nft_address !== run.nft_address || address(run.wallet) !== run.wallet || !sessionId(run.session_id)) {
          throw new OwnedPriceRequestError('Invalid saved gift-check checkpoint');
        }
      }
      if (budget(own, run)) return {};
      if (own.next_allowed_at > now()) return {skip: true};
      if (run.stage_attempts >= cap.retry_attempts) {finish(run, 'failed', 'retry_exhausted'); return {};}
      const plan = requestPlan(run, cap.batch_size);
      run.lease = `owned-price:${id}:${revision + 1}`; run.lease_until = now() + cap.lease_ms; run.stage_attempts++; run.attempts++;
      own.attempts.push(now()); own.next_allowed_at = now() + cap.interval_ms;
      return {value: {plan, run: copy(run), began: now()}};
    });
    if (!reserved.value) return project(reserved.own, await find(reserved.own, id));
    const {plan, run: snapshot, began} = reserved.value;
    await refreshClock();
    if (now() >= snapshot.deadline || now() >= snapshot.lease_until) {
      const result = await admitted(own => {if (own.run?.lease === snapshot.lease) finish(own.run, 'partial', 'duration_limit');});
      return project(result.own, await find(result.own, id));
    }
    let response = null, body = '', failure = null, parsed = null, bodyTruncated = false, providerWait = null;
    const requestBegan = now(), timeoutMs = Math.min(cap.timeout_ms, snapshot.deadline - requestBegan, snapshot.lease_until - requestBegan);
    try {
      const received = await fetchBoundedResponse(request, plan.url, {method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error'}, {maxBytes: cap.response_bytes, timeoutMs, deadlineAt: requestBegan + timeoutMs, clock: async () => {await refreshClock(); return now();}});
      response = received.response; body = received.body;
      if (response.url && response.url !== plan.url || response.redirected === true) failure = 'unexpected_redirect';
      else if (byteSize(body) > cap.response_bytes) failure = 'response_too_large';
      else if (!Number.isInteger(response.status)) failure = 'invalid_response';
      else if (response.status === 429 || [500, 502, 503, 504].includes(response.status)) failure = 'transient_http';
      else if (response.status < 200 || response.status >= 300) failure = 'http_error';
    } catch (error) {
      if (error?.code === 'PUBLIC_PROVIDER_WAIT') {providerWait = error; failure = 'provider_wait';}
      else if (error instanceof BoundedResponseError) {failure = error.code; response = error.response; body = error.body; bodyTruncated = error.truncated;}
      else failure = 'network_error';
    }
    await refreshClock();
    if (now() - began >= timeoutMs) failure = 'request_timeout';
    if (!failure) {try {parsed = parseResponse(body, plan.stage, plan.addresses);} catch {failure = 'invalid_response';}}
    let retryable = ['transient_http', 'network_error', 'request_timeout'].includes(failure);
    const retryAt = retryable ? retryDeadline(response, snapshot.stage_attempts) : null;
    if (retryable && retryAt === null) {retryable = false; failure = 'invalid_retry_after';}
    // Decode only the bounded account batch. Carry verified fields rather than
    // BOC blobs into subsequent checkpoints; repositories discard raw bodies.
    let decoded = null;
    if (!failure && plan.stage === 'accounts') {
      decoded = [];
      for (const row of snapshot.pending) {
        if (row.reason) {decoded.push(row); continue;}
        const account = parsed.get(row.holding_contract);
        let result;
        try {result = !account ? {verified: false, reason: 'account_missing'} : !logicalTime(account.last_transaction_lt) ? {verified: false, reason: 'invalid_account_state'} : account.status !== 'active' || account.suspended === true ? {verified: false, reason: 'inactive_contract'} : await decodeContract(account, row.nft_address, snapshot.wallet, iso(now()));} catch {result = {verified: false, reason: 'invalid_contract_data'};}
        const identityReason = contractIdentityReason(result, row, snapshot.wallet);
        const statusEvidence = contractStatus(result, row, snapshot.wallet, iso(now()), identityReason);
        const reason = identityReason || (!supportedState(result.rental_state) ? 'unsupported_rental_state' : !amount(result.configured_price_per_day_raw) ? 'invalid_configured_price' : null);
        const verified = result?.verified === true && reason === null;
        const evidence = {verified, reason: verified ? 'verified_contract_price' : reason};
        for (const key of ['code_hash', 'data_hash', 'decoder_version', 'contract_variant', 'storage_layout_version', 'rental_state', 'account_last_transaction_lt', 'code_hash_verified', 'data_hash_verified', 'marketplace', 'role', 'status', 'counterpart']) if (['string', 'boolean', 'number'].includes(typeof result?.[key])) evidence[key] = result[key];
        if (result?.counterpart === null) evidence.counterpart = null;
        if (verified) {evidence.owner = snapshot.wallet; evidence.configured_price_per_day_raw = result.configured_price_per_day_raw; evidence.contract_observed_at = iso(now());}
        decoded.push({...row, decoded: evidence, owned_status: statusEvidence});
      }
    }
    const outcome = await admitted(own => {
      if (retryAt !== null) own.next_allowed_at = Math.max(own.next_allowed_at, retryAt);
      const run = own.run;
      const raw = {provider: 'toncenter', endpoint: ROUTES[plan.stage], addresses: plan.addresses, stage: plan.stage, status: response?.status ?? null, failure, body, truncated: bodyTruncated, observed_at: iso(now())};
      // This bounded marker preserves provider/control classification only.
      // Its discarded body's JSON escaping does not limit a valid TON page.
      const event = {raw_body: boundedRawEvidence(raw, cap.response_bytes)};
      if (!run || run.id !== id || run.lease !== snapshot.lease) return event;
      const leaseExpired = run.lease_until <= now();
      run.lease = null; run.lease_until = 0;
      if (!active(run)) return event;
      if (providerWait) {
        const index = own.attempts.lastIndexOf(began); if (index >= 0) own.attempts.splice(index, 1);
        run.attempts--; run.stage_attempts--;
        own.next_allowed_at = Math.max(own.next_allowed_at, providerWait.readyAt);
        finish(run, providerWait.reason === 'provider_wait' && own.next_allowed_at < run.deadline ? 'running' : 'partial', 'provider_wait');
        return {raw_body: null};
      }
      if (now() >= run.deadline || leaseExpired) {finish(run, 'partial', leaseExpired ? 'request_lease_expired' : 'duration_limit'); return event;}
      if (failure) {
        if (retryable && run.stage_attempts < cap.retry_attempts) {run.reason = 'retry_wait'; budget(own, run); return event;}
        event.records = commitBatch(run, plan.targets.map(row => unresolved(row, retryable ? 'retry_exhausted' : failure)));
        finish(run, 'failed', retryable ? 'retry_exhausted' : failure); return event;
      }
      run.reason = null; run.stage_attempts = 0;
      if (plan.stage === 'before') {
        run.pending = plan.targets.map(row => ({...row, ...nftEvidence(parsed.get(row.nft_address), row, run.wallet), nft_observed_at: iso(now())}));
        if (run.pending.some(row => !row.reason)) run.stage = 'accounts';
        else if (run.status_refresh_version === STATUS_VERSION && run.pending.some(row => row.reason === 'held_directly')) run.stage = 'after';
        else event.records = commitBatch(run, run.pending.map(row => unresolved(row, row.reason)));
      } else if (plan.stage === 'accounts') {run.pending = decoded; run.stage = 'after';}
      else {
        const rows = run.pending.map(row => {
          if (row.reason && (row.reason !== 'held_directly' || run.status_refresh_version !== STATUS_VERSION)) return unresolved(row, row.reason);
          const after = nftEvidence(parsed.get(row.nft_address), row, run.wallet);
          if (row.reason === 'held_directly') {
            if (after.reason !== 'held_directly' || after.nft_last_transaction_lt !== row.nft_last_transaction_lt) return unresolved(row, 'nft_changed_during_refresh');
            return {...unresolved(row, 'held_directly'), owned_status: {verified: true, reason: 'held_directly', rental_state: 'held_directly',
              observed_owner: run.wallet, owner: run.wallet, nft_last_transaction_lt: row.nft_last_transaction_lt,
              status_observed_at: row.nft_observed_at, rental_until: null, rental_until_unit: 'Unix seconds'}};
          }
          if (after.reason) return unresolved(row, after.reason);
          if (after.holding_contract !== row.holding_contract || after.nft_last_transaction_lt !== row.nft_last_transaction_lt) return unresolved(row, 'nft_changed_during_refresh');
          return {...unresolved(row, row.decoded.reason), ...row.decoded, nft_last_transaction_lt: row.nft_last_transaction_lt, ...(row.owned_status ? {owned_status: row.owned_status} : {})};
        });
        event.records = commitBatch(run, rows);
      }
      budget(own, run); return event;
    });
    return project(outcome.own, await find(outcome.own, id));
  }
  return {getStatus, start, step, stop};
}
