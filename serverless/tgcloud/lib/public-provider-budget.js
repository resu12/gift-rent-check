// One atomic ledger per provider. It survives key changes and account deletion.
import {hex, hmacSha256, keyBytes} from './public-credential-box.js';
import {utf8Bytes} from './personal-analytics.js';
const DAY = 86400000;
const MAX_TIME = 8640000000000000;
const MAX_ATTEMPTS = 5000;
const MAX_LEGACY_ATTEMPTS = 10000;
export class PublicProviderBudgetError extends Error {
  constructor(readyAt, reason = 'provider_wait') {super('PUBLIC_PROVIDER_WAIT'); this.code = 'PUBLIC_PROVIDER_WAIT'; this.readyAt = readyAt; this.next_allowed_at = readyAt; this.reason = reason;}
}
const positive = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => positive(value) && value <= MAX_TIME;
const cooldown = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const fingerprint = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const limits = value => {if (!positive(value) || value > 5000) throw new Error('Invalid public provider budget'); return value;};
export function createPublicProviderBudget({db, masterKey, config, clock, legacyProviderUsage = null}) {
  if (legacyProviderUsage !== null && typeof legacyProviderUsage !== 'function' || config.preservePrivateOwner === true && !legacyProviderUsage) throw new Error('Private provider usage unavailable');
  const key = keyBytes(masterKey);
  const actor = id => hex(hmacSha256(key, utf8Bytes(`public-budget-account-v1\0${id}`)));
  const cap = provider => provider === 'marketapp'
    ? {global:limits(config.globalMarketDailyAttempts), user:limits(config.perUserMarketDailyAttempts), credential:limits(config.perCredentialMarketDailyAttempts ?? config.perUserMarketDailyAttempts)}
    : {global:limits(config.globalTonDailyAttempts), user:limits(config.perUserTonDailyAttempts), credential:5000};
  const scope = provider => {if (!['marketapp','toncenter'].includes(provider)) throw new Error('Invalid public provider'); return `public-provider-v1:${provider}`;};
  const empty = () => ({version:1, attempts:[], next_allowed_at:0});
  async function read(provider, at) {
    const row = await db.get('SELECT revision,document FROM public_provider_gates WHERE scope_key=:scope', {':scope':scope(provider)});
    const value = row ? JSON.parse(row.document) : empty();
    const seed = value.private_owner_seed;
    if (value.version !== 1 || !Array.isArray(value.attempts) || value.attempts.length > 5001 || !cooldown(value.next_allowed_at) ||
        value.attempts.some(a => !a || !timestamp(a.at) || !fingerprint(a.actor) || !(a.credential === null || fingerprint(a.credential)) || typeof a.id !== 'string' || a.id.length > 200) ||
        seed !== undefined && (!seed || seed.version !== 1 || !fingerprint(seed.actor) || !(seed.credential === null || fingerprint(seed.credential)) || !timestamp(seed.at))) throw new Error('Public budget ledger unavailable');
    value.attempts = value.attempts.filter(a => a.at > at-DAY).sort((a,b)=>a.at-b.at);
    return {revision:row?.revision ?? null, value};
  }
  async function prepared(provider, at) {
    for (let i = 0; i < 24; i++) {
      const saved = await read(provider, at);
      if (!legacyProviderUsage || saved.value.private_owner_seed) return saved;
      const legacy = await legacyProviderUsage();
      if (!legacy || typeof legacy.userId !== 'string' || !/^[1-9]\d{0,19}$/.test(legacy.userId) ||
          !(legacy.credentialFingerprint === null || fingerprint(legacy.credentialFingerprint)) || !legacy.state || typeof legacy.state !== 'object') throw new Error('Private provider usage unavailable');
      // Import raw attempts: a private administrative reset must never give the
      // shared provider allowance a fresh budget. Missing TON state means the
      // owner has never run an owned-price check.
      const source = provider === 'marketapp' ? legacy.state : legacy.state.owned_prices ?? {attempts: [], next_allowed_at: 0};
      if (!Array.isArray(source.attempts) || source.attempts.length > MAX_LEGACY_ATTEMPTS ||
          source.attempts.some(value => !timestamp(value)) || !cooldown(source.next_allowed_at)) throw new Error('Private provider usage unavailable');
      const owner = actor(legacy.userId), credential = provider === 'marketapp' ? legacy.credentialFingerprint : null;
      const imported = source.attempts.filter(value => value > at - DAY).map((value, index) => ({at: value, actor: owner, credential, id: `private-seed:${provider}:${index}`}));
      const value = saved.value;
      // Keeping the latest 5000 is conservative for every allowed global cap.
      // No request can pass until all discarded (older) attempts have expired.
      value.attempts = [...value.attempts, ...imported].sort((a, b) => a.at - b.at).slice(-MAX_ATTEMPTS);
      value.next_allowed_at = Math.max(value.next_allowed_at, source.next_allowed_at);
      // This tombstone is permanent, including after attempts expire or a
      // public account is deleted. CAS makes concurrent seeding idempotent.
      value.private_owner_seed = {version: 1, actor: owner, credential, at};
      if (await commit(provider, saved.revision, value)) return {revision: saved.revision === null ? 1 : saved.revision + 1, value};
    }
    throw new PublicProviderBudgetError(at + 1000, 'provider_wait');
  }
  function available(value, provider, a, credential, at) {
    const c=cap(provider), mine=value.attempts.filter(x=>x.actor===a), shared=credential ? value.attempts.filter(x=>x.credential===credential) : [];
    const blockers=[];
    for(const [rows,limit,reason] of [[value.attempts,c.global,'global_limit'],[mine,c.user,'user_limit'],[shared,c.credential,'credential_limit']])
      if(rows.length>=limit)blockers.push({at:rows[rows.length-limit].at+DAY,reason});
    if(value.next_allowed_at>at)blockers.push({at:value.next_allowed_at,reason:'provider_wait'});
    return blockers.sort((a,b)=>b.at-a.at)[0] ?? null;
  }
  async function commit(provider, revision, value) {
    const params={':scope':scope(provider),':document':JSON.stringify(value)};
    if(revision===null)return (await db.run('INSERT OR IGNORE INTO public_provider_gates(scope_key,revision,document) VALUES(:scope,1,:document)',params)).rowsAffected===1;
    return (await db.run('UPDATE public_provider_gates SET revision=revision+1,document=:document WHERE scope_key=:scope AND revision=:revision',{...params,':revision':revision})).rowsAffected===1;
  }
  async function status(provider,userId,credential=null) {
    // A status probe reads up to 5,000 attempts on a cold dashboard request.
    // Derive its private identity once, not one HMAC for every ledger entry.
    const at=await clock(),{value}=await prepared(provider,at),c=cap(provider),a=actor(userId),mine=value.attempts.filter(x=>x.actor===a), shared=credential?value.attempts.filter(x=>x.credential===credential):[];
    const wait=available(value,provider,a,credential,at);
    return {used_24h:mine.length,remaining_24h:Math.max(0,Math.min(c.user-mine.length,c.global-value.attempts.length,credential?c.credential-shared.length:5000)),rolling_24h_attempts:c.user,
      available_at:wait ? new Date(wait.at).toISOString():null, reason:wait?.reason??null};
  }
  async function reserve(provider,userId,credential,id) {
    if(typeof id!=='string'||!id||id.length>200 || credential!==null&&!/^[0-9a-f]{64}$/.test(credential))throw new Error('Invalid public budget reservation');
    for(let i=0;i<24;i++) {
      const at=await clock(),{revision,value}=await prepared(provider,at),a=actor(userId);
      const wait=available(value,provider,a,credential,at);if(wait)throw new PublicProviderBudgetError(wait.at,wait.reason);
      value.attempts.push({at,actor:a,credential,id});value.next_allowed_at=at+1000;
      if(await commit(provider,revision,value))return;
    }
    throw new PublicProviderBudgetError(await clock()+1000,'provider_wait');
  }
  async function throttle(provider,response) {
    if(response?.status!==429)return;
    const raw=response.headers?.get?.('retry-after'),at=await clock();
    let delay=60000;
    if(typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw.trim()))delay=Math.ceil(Number(raw)*1000);
    else if(typeof raw==='string'&&Number.isFinite(Date.parse(raw)))delay=Math.max(0,Date.parse(raw)-at);
    if(!Number.isSafeInteger(delay)||delay<0||delay>31536000000)delay=60000;
    for(let i=0;i<24;i++){const {revision,value}=await prepared(provider,at);value.next_allowed_at=Math.max(value.next_allowed_at,at+delay);if(await commit(provider,revision,value))return;}
    throw new Error('Public throttle checkpoint unavailable');
  }
  return {status,reserve,throttle};
}

export function publicProviderForRequest(url, options = {}) {
  if(options.method !== 'GET'||typeof url!=='string')throw new Error('Public provider route is not allowed');
  const market=/^https:\/\/api\.marketapp\.org(\/v1\/rent\/gifts\/(?:history\/)?|\/v1\/collections\/gifts\/|\/v1\/collections\/[^/?#]+\/attributes\/)(?:\?[^#]*)?$/.test(url);
  const ton=/^https:\/\/toncenter\.com\/api\/v3\/(nft\/items|nft\/transfers|accountStates)(?:\?[^#]*)?$/.test(url);
  if(!market&&!ton)throw new Error('Public provider route is not allowed');
  const headers=options.headers??{};
  const names=typeof headers.keys==='function' ? Array.from(headers.keys()) : Array.isArray(headers) ? headers.map(entry=>entry[0]) : Object.keys(headers);
  if(names.some(name=>typeof name !== 'string'))throw new Error('Provider headers are not allowed');
  if(ton&&names.some(name=>['authorization','cookie','x-api-key'].includes(name.toLowerCase())))throw new Error('Provider credentials cannot cross origins');
  if(market&&names.some(name=>['x-api-key','cookie'].includes(name.toLowerCase())))throw new Error('Provider credentials cannot cross origins');
  return market?'marketapp':'toncenter';
}

export function createPublicProviderFetch({fetch, budget, repository, userId, credentialFingerprint=null}) {
  let counter=0;
  return async (url, options={}) => {
    const provider=publicProviderForRequest(url,options);
    await repository.ensureAccount();
    const generation=await repository.accountGeneration(),{revision}=await repository.read();
    await budget.reserve(provider,userId,provider==='marketapp'?credentialFingerprint:null,`${generation}:${revision}:${++counter}`);
    // Recheck after the global CAS; deletion may have fenced this request.
    await repository.ensureAccount();
    const response=await fetch(url,{...options,redirect:'error'});
    await budget.throttle(provider,response);
    return response;
  };
}
