// Pure dashboard projection shared by cloud requests and parity tests. Every
// monetary calculation uses BigInt fractions; source strings stay unchanged.
import {canonicalAddress as strictAddress, addressKey as uncachedAddressKey, traitKey as uncachedTraitKey, instant as uncachedInstant, instantOrder as uncachedInstantOrder, iso, resolveCloudWindow, rational, decimal, plus, sumRationals, multiply, compare, decimalText, canonicalJSON} from './cloud-pricing-core.js';
import {CONTRACT_VARIANTS, MARKETAPP_OPERATOR} from './ton-price-decoder.js';
import {buildGiftPriceTracking} from './price-tracking.js';
import {isSupplementaryExpiryFailure} from './rental-expiry-check.js';
export {canonicalAddress, addressKey, resolveCloudWindow, validateSavedCloudWindow} from './cloud-pricing-core.js';

const DAY = 86400000;
const FIELDS = ['model', 'backdrop'];
const RENTAL_WARNINGS = [
  "Daily rate = reported full rental price × 86,400 / duration. Seconds and full-price semantics were cross-checked against Marketapp's UI; they are not guaranteed by the OpenAPI schema.",
  'Arithmetic mean per distinct rental record, excluding extensions with unverified incremental semantics. It is not weighted by rental duration and is not net income or evidence of rental completion.',
  'History has no traits: model and backdrop use saved structured NFT metadata, which may have been observed after the rental.',
  'Only saved history is covered. A timeframe selection does not fetch or establish complete market history. Missing or invalid records are excluded, not replaced with listing prices.',
  'Identical records count once. Ambiguous variants sharing NFT, timestamp and parties are excluded; transaction hashes alone do not identify unique events.',
  'Eligible rentals of your portfolio gifts, including the gift being compared, are included on the same terms as other rental records.',
];
const COUNT_NOTE = 'Distinct rental starts in all saved Marketapp history, independent of the pricing timeframe. Coverage may be incomplete; this is not a lifetime total or proof that these rentals occurred during your ownership. Extensions are excluded.';
const BLACK_NOTE = 'All comparison groups use only verified exact Black backdrops. Missing backdrop metadata is excluded. Collection + Black spans all models; no all-backdrop fallback is used.';

function createProjection() {
// Page overlaps repeat the same friendly addresses and observation timestamps
// thousands of times. Resolve them once within this synchronous projection.
// These maps are never shared between requests or retained by the returned data.
const identities = new Map(), instants = new Map(), orders = new Map(), traitNames = new Map();
const memo = (cache, value, resolve) => {
  if (typeof value !== 'string') return resolve(value);
  if (!cache.has(value)) cache.set(value, resolve(value));
  return cache.get(value);
};
const addressKey = value => memo(identities, value, uncachedAddressKey);
const instant = value => memo(instants, value, uncachedInstant);
const instantOrder = value => memo(orders, value, uncachedInstantOrder);
const traitKey = value => memo(traitNames, value, uncachedTraitKey);
const count = (map, key, n = 1) => {map[key] = (map[key] || 0) + n;};
const unique = list => [...new Set(list)];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const source = row => {const raw = row.source_json ?? row.source ?? row; return typeof raw === 'string' ? JSON.parse(raw) : raw;};
const stringFields = (item, fields) => fields.every(key => typeof item[key] === 'string');
const safeInteger = Number.isSafeInteger;
function validListing(item) {
  if (!object(item) || !stringFields(item, ['nft_address', 'nft_name', 'owner', 'price_per_day']) || !/^\d{1,1000}$/.test(item.price_per_day) || !Array.isArray(item.attributes) || !safeInteger(item.min_duration) || !safeInteger(item.max_duration) || typeof item.discount_per_day !== 'number' || !Number.isFinite(item.discount_per_day) || !Object.hasOwn(item, 'listed_at') || !(item.listed_at === null || safeInteger(item.listed_at))) return false;
  return item.attributes.every(a => object(a) && typeof a.trait_type === 'string' && (typeof a.value === 'string' || (typeof a.value === 'number' && Number.isFinite(a.value))));
}
function validHistory(item) {
  return object(item) && stringFields(item, ['address', 'name', 'collection_address', 'src', 'dst', 'price', 'price_nano']) && safeInteger(item.ts) && ['GRAM', 'TON', 'USDT'].includes(item.currency)
    && (!Object.hasOwn(item, 'tx_hash') || item.tx_hash === null || typeof item.tx_hash === 'string')
    && (!Object.hasOwn(item, 'is_extend') || typeof item.is_extend === 'boolean') && (!Object.hasOwn(item, 'duration') || safeInteger(item.duration));
}
function normalizedRecord(envelope) {
  const row = envelope.record ?? envelope.value ?? envelope;
  return {kind: envelope.kind, row, observed_at: envelope.observed_at ?? row.observed_at, key: envelope.key ?? envelope.id};
}
function rememberTraitObservation(values, field, observation, now) {
  const when = instant(observation.when);
  if (when === null || when > now) return;
  const previous = values[field];
  const order = instantOrder(observation.when), prior = previous.length ? instantOrder(previous[0].when) : null;
  // Every supported window selects the latest evidence at its trait clock.
  // The cutoff controls its freshness label, not which observation wins.
  // Retain all exact-time ties in insertion order for conflicts/provenance.
  if (prior === null || order > prior) values[field] = [observation];
  else if (order === prior) previous.push(observation);
}
function rememberTraits(evidence, nft, attributes, observedAt, origin, now) {
  if (!nft || attributes == null || instant(observedAt) === null) return;
  const parsed = {}; let malformed = !Array.isArray(attributes);
  if (!malformed) for (const attribute of attributes) {
    if (!object(attribute) || typeof attribute.trait_type !== 'string') {malformed = true; break;}
    const field = traitKey(attribute.trait_type);
    if (FIELDS.includes(field)) (parsed[field] ||= []).push(typeof attribute.value === 'string' && attribute.value.trim() ? attribute.value.trim().replace(/\s+/g, ' ') : null);
  }
  const values = evidence.get(nft) || {model: [], backdrop: []};
  for (const field of FIELDS) if (malformed || Object.hasOwn(parsed, field)) {
    const entries = parsed[field] || [];
    let error = malformed || entries.includes(null) ? 'malformed' : null;
    if (new Set(entries.map(traitKey)).size > 1) error = 'conflicting';
    rememberTraitObservation(values, field, {value: error ? null : entries[0] ?? null, error, source: origin, when: observedAt}, now);
  }
  evidence.set(nft, values);
}
function traitsFor(evidence, cutoff, now) {
  const result = {warnings: [], invalid: false}; const sources = [], times = [];
  for (const field of FIELDS) {
    const records = (evidence?.[field] || []).filter(r => instant(r.when) !== null && instant(r.when) <= now);
    const fresh = records.filter(r => instant(r.when) >= cutoff), pool = fresh.length ? fresh : records;
    const label = field[0].toUpperCase() + field.slice(1);
    if (!pool.length) {result[field] = null; result[field + '_fresh'] = false; result.warnings.push(`${label} is unknown.`); continue;}
    const order = pool.reduce((latest, r) => instantOrder(r.when) > latest ? instantOrder(r.when) : latest, instantOrder(pool[0].when));
    const selected = pool.filter(r => instantOrder(r.when) === order);
    const errors = selected.map(r => r.error).filter(Boolean), values = new Set(selected.map(r => traitKey(r.value)));
    const invalid = errors.length > 0 || values.size > 1, latest = instant(selected[0].when);
    result[field] = invalid ? null : selected.at(-1).value;
    result[field + '_fresh'] = !invalid && latest >= cutoff;
    sources.push(...selected.map(r => r.source).filter(Boolean)); times.push(...selected.map(r => r.when));
    if (invalid) {result.invalid = true; result.warnings.push(`${label} evidence is ${errors.includes('conflicting') || values.size > 1 ? 'conflicting' : 'malformed'}.`);}
    else if (latest < cutoff) result.warnings.push(`${label} evidence is older than the comparison freshness window.`);
  }
  result.source = unique(sources).sort().join('+') || null;
  result.observed_at = times.length ? times.sort((a, b) => instantOrder(a) < instantOrder(b) ? -1 : 1).at(-1) : null;
  return result;
}
function stats(peers, rentals = false) {
  const result = {mean: null, median: null, minimum: null, maximum: null, sample_count: peers.length, observed_from: null, observed_to: null, coverage: 'observed_sample'};
  if (rentals) Object.assign(result, {distinct_nft_count: new Set(peers.map(p => p.nft)).size, extension_count: 0, unknown_extension_count: 0, missing_hash_count: peers.filter(p => !p.tx_hash).length});
  if (!peers.length) return result;
  const prices = peers.map(p => p.price).sort(compare), middle = Math.floor(prices.length / 2);
  const sum = sumRationals(prices);
  const median = prices.length % 2 ? prices[middle] : multiply(plus(prices[middle - 1], prices[middle]), 1n, 2n);
  Object.assign(result, {mean: decimalText(multiply(sum, 1n, BigInt(prices.length))), median: decimalText(median, rentals ? 9 : 10), minimum: decimalText(prices[0]), maximum: decimalText(prices.at(-1)), observed_from: iso(Math.min(...peers.map(p => p.when))), observed_to: iso(Math.max(...peers.map(p => p.when)))});
  return result;
}
function eligibleSources(observations, metadata, cutoff, now) {
  const eligible = {collection: false, collection_black: false, model: false, model_black: false};
  for (const observation of observations) {
    if (!observation.valid || observation.when < cutoff || observation.when > now) continue;
    const filters = Object.fromEntries(['model', 'backdrop', 'symbol'].filter(k => observation.params[k] != null).map(k => [k, observation.params[k]]));
    if (Object.hasOwn(filters, 'symbol') || Object.values(filters).some(v => typeof v !== 'string' || !v.trim()) || Object.entries(filters).some(([k, v]) => traitKey(v) !== traitKey(metadata[k]))) continue;
    eligible.collection ||= !Object.keys(filters).length;
    eligible.collection_black ||= !Object.hasOwn(filters, 'model') && (!Object.hasOwn(filters, 'backdrop') || traitKey(filters.backdrop) === 'black');
    eligible.model ||= !Object.hasOwn(filters, 'backdrop');
    eligible.model_black ||= !Object.hasOwn(filters, 'backdrop') || traitKey(filters.backdrop) === 'black';
  }
  return eligible;
}
function createDataset(portfolioRecords, now, traitNow, rentalPricing = false) {
  const gifts = new Map(), listings = new Map(), listingHistory = new Map(), ownedPrices = new Map(), ownedStatuses = new Map(), personalGifts = new Map(), history = [], collections = new Map(), conflicts = new Set(), evidence = new Map(), names = new Map(), settings = {};
  const trackingNFTs = new Set();
  for (const envelope of portfolioRecords) if (envelope.kind === 'portfolio' || envelope.kind === 'gift') {
    const {row} = normalizedRecord(envelope), nft = addressKey(row?.nft_address);
    if (nft) trackingNFTs.add(nft);
  }
  const rememberCollection = (nft, collection) => {nft = addressKey(nft); collection = addressKey(collection); if (nft && collection) {if (!collections.has(nft)) collections.set(nft, new Set()); collections.get(nft).add(collection);}};
  function add(records) {
  for (const envelope of records) {
    const {kind, row, observed_at, key} = normalizedRecord(envelope);
    if (!object(row)) continue;
    if (kind === 'settings') {Object.assign(settings, row); continue;}
    if (kind === 'personal_gift') {
      const nft=addressKey(row.nft_address),when=instant(observed_at);
      if(nft&&when!==null&&when<=now) {
        if(!personalGifts.has(nft))personalGifts.set(nft,[]);
        personalGifts.get(nft).push({row,observed_at,when});
      }
      // An authenticated personal page supplies price/status observations, not
      // collection metadata, ownership proof, membership or market samples.
      continue;
    }
    if (kind === 'owned_status') {
      const nft = addressKey(row.nft_address), when = instant(observed_at);
      if (row.semantics_version === 'ton-owned-rental-status-v1' && nft && when !== null && when <= now) {
        if (!ownedStatuses.has(nft)) ownedStatuses.set(nft, []);
        ownedStatuses.get(nft).push({row, observed_at, when});
      }
      // Targeted status checks update neither collection/trait evidence nor
      // membership, and never enter the market comparison sample.
      continue;
    }
    if (kind === 'owned_price') {
      const nft = addressKey(row.nft_address), when = instant(observed_at);
      if (nft && when !== null && when <= now) {
        if (!ownedPrices.has(nft)) ownedPrices.set(nft, []);
        ownedPrices.get(nft).push({row, observed_at, when});
      }
      // Price-only observations cannot refresh traits, membership, collection
      // identity, marketplace visibility or comparison samples.
      continue;
    }
    if (kind === 'collection') {try {const item = source(row); names.set(addressKey(item.address ?? item.collection_address ?? row.identity), item.name);} catch {} continue;}
    if (kind === 'portfolio' || kind === 'gift') {
      const nft = addressKey(row.nft_address); if (!nft) continue;
      const previous = gifts.get(nft);
      // Imports are immutable. The newest imported row replaces its older
      // projection; membership stays independent of listing visibility.
      if (!previous || (instant(observed_at) ?? 0) >= (instant(previous.imported_at) ?? 0)) gifts.set(nft, {...row, id: nft, imported_at: observed_at ?? row.imported_at ?? null});
      rememberCollection(nft, row.collection_address);
      for (const collection of row.collection_addresses || []) rememberCollection(nft, collection);
      if (row.collection_conflict) conflicts.add(nft);
      continue;
    }
    if (kind === 'metadata' || kind === 'ownership') {
      const nft = addressKey(row.nft_address ?? row.identity); if (!nft) continue;
      rememberCollection(nft, row.collection_address);
      for (const collection of row.collections || row.collection_addresses || []) rememberCollection(nft, collection);
      if (row.collection_conflict) conflicts.add(nft);
      rememberTraits(evidence, nft, row.attributes, row.observed_at ?? observed_at, row.source || (kind === 'ownership' ? 'TON content' : 'Saved structured metadata'), traitNow);
      if (object(row.trait_evidence)) {
        const target = evidence.get(nft) || {model: [], backdrop: []};
        for (const field of FIELDS) for (const observation of row.trait_evidence[field] || []) if (object(observation)) rememberTraitObservation(target, field, {...observation}, traitNow);
        evidence.set(nft, target);
      }
      continue;
    }
    if (kind === 'listing') {
      let item = {}; try {item = source(row);} catch {}
      const nft = addressKey(row.identity ?? item.nft_address); if (!nft) continue;
      rememberCollection(nft, row.collection_address ?? row.params?.collection_address);
      if (object(row.collection_evidence)) for (const values of Object.values(row.collection_evidence)) for (const value of Array.isArray(values) ? values : [values]) rememberCollection(nft, value);
      if (row.collection_conflict) conflicts.add(nft);
      const valid = validListing(item) && addressKey(item.nft_address) === nft && addressKey(item.owner) !== null;
      const times = unique([...(row.occurrence_times || []), observed_at]).filter(t => instant(t) !== null).sort((a, b) => instantOrder(a) < instantOrder(b) ? -1 : 1);
      // Tracking needs every saved occurrence: retaining only the latest repeat
      // of each representation would lose earlier A -> B -> A price changes.
      if (trackingNFTs.has(nft)) {
        if (!listingHistory.has(nft)) listingHistory.set(nft, []);
        for (const time of times) listingHistory.get(nft).push({nft, source: item, valid, when: instant(time), observed_at: time, price: valid ? rational(BigInt(item.price_per_day), 1000000000n) : null});
      }
      // Repeated identical observations need at most these three timestamps:
      // latest overall (including future exclusion), latest at the comparison
      // instant, and latest now for the independent current asking price.
      const selected = times.length ? unique([times.at(-1), times.filter(t => instant(t) <= traitNow).at(-1), times.filter(t => instant(t) <= now).at(-1)]).filter(Boolean) : [observed_at];
      for (const time of selected) {
        if (valid) rememberTraits(evidence, nft, item.attributes, time, 'Marketapp listing', traitNow);
        // Rental comparisons use history prices. Other NFTs' listings still
        // supply all dated traits and collection/conflict evidence above, but
        // only displayed gifts need their asking-price snapshots and BigInts.
        if (rentalPricing && !trackingNFTs.has(nft)) continue;
        const entry = {nft, source: item, valid, when: instant(time), observed_at: time, price: valid ? rational(BigInt(item.price_per_day), 1000000000n) : null, params: row.params || {}};
        if (!listings.has(nft)) listings.set(nft, []); listings.get(nft).push(entry);
      }
      continue;
    }
    if (kind === 'history') {
      let item = null; try {item = source(row);} catch {}
      const nft = addressKey(row.identity ?? item?.address);
      rememberCollection(nft, item?.collection_address);
      const times = unique([...(row.occurrence_times || []), observed_at]).filter(t => instant(t) !== null && instant(t) <= now).sort((a, b) => instantOrder(a) < instantOrder(b) ? -1 : 1);
      history.push({item, nft, observed_at: times.at(-1) ?? observed_at, fingerprint: row.fingerprint, key});
    }
  }
  }
  return {add, data: {gifts, listings, listingHistory, ownedPrices, ownedStatuses, personalGifts, history, collections, conflicts, evidence, names, settings}};
}
function listingPeers(data, traits, cutoff, now, custom, backdrop, rejected) {
  const peers = [];
  for (const [nft, observations] of data.listings) {
    const dated = observations.filter(o => o.when !== null && (!custom || o.when <= now));
    if (!dated.length) {count(rejected, 'invalid_observation_time'); continue;}
    const latestOrder = dated.reduce((latest, o) => instantOrder(o.observed_at) > latest ? instantOrder(o.observed_at) : latest, instantOrder(dated[0].observed_at));
    const group = dated.filter(o => instantOrder(o.observed_at) === latestOrder), latest = group[0].when;
    if (latest > now || latest < cutoff) {count(rejected, latest > now ? 'future_listing' : 'stale_listing'); continue;}
    if (group.some(o => !o.valid)) {count(rejected, 'malformed_listing'); continue;}
    if (new Set(group.map(o => canonicalJSON([addressKey(o.source.owner), decimalText(o.price)]))).size > 1) {count(rejected, 'conflicting_latest_listing'); continue;}
    if (data.conflicts.has(nft) || (data.collections.get(nft)?.size || 0) > 1) {count(rejected, 'collection_conflict'); continue;}
    if (!data.collections.get(nft)?.size) {count(rejected, 'missing_collection'); continue;}
    const metadata = traits.get(nft) || traitsFor(null, cutoff, now);
    if (metadata.invalid) {count(rejected, 'invalid_or_conflicting_traits'); continue;}
    if (backdrop && traitKey(metadata.backdrop) !== 'black') {count(rejected, 'outside_backdrop_scope'); continue;}
    const eligible = eligibleSources(dated, metadata, cutoff, now);
    if (!Object.values(eligible).some(Boolean)) {count(rejected, 'ineligible_comparison_source'); continue;}
    peers.push({nft, collection: [...data.collections.get(nft)][0], price: group.at(-1).price, when: latest, eligible, model: traitKey(metadata.model), backdrop: traitKey(metadata.backdrop)});
  }
  return peers;
}
function historyGroups(data, now, {window, rentalPricing = false, wanted = null} = {}) {
  const groups = new Map(), rejected = {}, perGift = new Map(), observed = new Map(), seen = new Set();
  const reject = (nft, reason, amount = 1) => {count(rejected, reason, amount); if (!perGift.has(nft)) perGift.set(nft, {}); count(perGift.get(nft), reason, amount);};
  for (const row of data.history) {
    const observedAt = instant(row.observed_at), nft = row.nft;
    if (wanted && !wanted.has(nft)) continue;
    if (observedAt === null || observedAt > now) {if (rentalPricing) reject(nft, 'invalid_observation_time'); continue;}
    if (nft) observed.set(nft, Math.max(observed.get(nft) ?? -Infinity, observedAt));
    const item = row.item;
    // A replay must not multiply excluded counters or event weight. Page
    // occurrences remain in storage and do not become additional records.
    const representation = row.fingerprint || canonicalJSON(item);
    if (seen.has(representation)) continue; seen.add(representation);
    if (!validHistory(item) || addressKey(item.address) !== nft || item.ts <= 0 || item.ts > 253402300799 || (!rentalPricing && item.ts * 1000 > now) || !addressKey(item.collection_address) || !addressKey(item.src) || !addressKey(item.dst)) {reject(nft, 'malformed_history'); continue;}
    const when = item.ts * 1000;
    if (window && (when < instant(window.window_from) || when > instant(window.window_to))) {reject(nft, 'outside_timeframe'); continue;}
    if (rentalPricing && (data.conflicts.has(nft) || (data.collections.get(nft)?.size || 0) > 1)) {reject(nft, 'collection_conflict'); continue;}
    const normalized = {...item, address: nft, collection_address: addressKey(item.collection_address), src: addressKey(item.src), dst: addressKey(item.dst)};
    const fields = [nft, item.ts, normalized.src, normalized.dst]; if (rentalPricing) fields.push(item.is_extend ?? null);
    const eventKey = canonicalJSON(fields), entry = {item, nft, collection: normalized.collection_address, when};
    if (!groups.has(eventKey)) {groups.set(eventKey, entry); continue;}
    // Most event identities have a single variant. Keeping a second complete
    // JSON string as every Map key doubled the history projection's footprint.
    // Compare full normalized content only where identities actually collide;
    // unknown fields and friendly-address aliases retain their old semantics.
    const previous = groups.get(eventKey), variant = canonicalJSON(normalized);
    if (previous instanceof Map) {previous.set(variant, entry); continue;}
    const original = canonicalJSON({...previous.item, address: previous.nft, collection_address: previous.collection,
      src: addressKey(previous.item.src), dst: addressKey(previous.item.dst)});
    // Ambiguous groups retain the keyed representation so arbitrarily many
    // variants cannot turn this optimization into a quadratic comparison loop.
    groups.set(eventKey, variant === original ? entry : new Map([[original, previous], [variant, entry]]));
  }
  return {groups, rejected, perGift, observed, reject};
}
function rentalPeers(data, traits, window, now, backdrop) {
  const result = historyGroups(data, now, {window, rentalPricing: true}), peers = [];
  for (const variants of result.groups.values()) {
    const row = variants instanceof Map ? variants.values().next().value : variants, {item, nft, collection, when} = row;
    if (variants instanceof Map) {result.reject(nft, 'ambiguous_history_variants', variants.size); continue;}
    if (item.currency !== 'GRAM') {result.reject(nft, 'non_gram_currency'); continue;}
    if (item.is_extend !== false) {result.reject(nft, 'unverified_extension_semantics'); continue;}
    if (!safeInteger(item.duration) || item.duration <= 0) {result.reject(nft, 'missing_or_nonpositive_duration'); continue;}
    let price;
    try {
      const amount = decimal(item.price), nano = decimal(item.price_nano);
      if (amount.n < 0n || nano.n < 0n) throw new Error();
      if (compare(amount, multiply(nano, 1n, 1000000000n)) !== 0) {result.reject(nft, 'inconsistent_gram_amounts'); continue;}
      price = multiply(amount, 86400n, BigInt(item.duration));
    } catch {result.reject(nft, 'invalid_amount'); continue;}
    const metadata = traits.get(nft) || {};
    if (metadata.invalid) {result.reject(nft, 'invalid_or_conflicting_traits'); continue;}
    if (backdrop && traitKey(metadata.backdrop) !== 'black') {result.reject(nft, 'outside_backdrop_scope'); continue;}
    peers.push({nft, collection, when, price, model: traitKey(metadata.model), backdrop: traitKey(metadata.backdrop), tx_hash: item.tx_hash});
  }
  return {peers, rejected: result.rejected};
}
function rentalCounts(data, gifts, now) {
  // Portfolio counters only need owned gifts. Grouping the whole comparison
  // market again wastes substantial CPU and memory in a bounded cloud call.
  const wanted = new Set(gifts.filter(g => g.is_portfolio).map(g => addressKey(g.nft_address)));
  const result = historyGroups(data, now, {wanted}), accepted = new Map();
  for (const variants of result.groups.values()) {
    const {item, nft, when} = variants instanceof Map ? variants.values().next().value : variants;
    if (variants instanceof Map) {result.reject(nft, 'ambiguous_history_variants', variants.size); continue;}
    if (['action', 'event_type'].some(field => ['return', 'returned', 'cancel', 'cancelled', 'canceled', 'transfer'].includes(traitKey(item[field])))) result.reject(nft, 'non_rental_action');
    else if (item.is_extend === true) result.reject(nft, 'extensions');
    else if (item.is_extend !== false) result.reject(nft, 'unknown_extension_status');
    else {if (!accepted.has(nft)) accepted.set(nft, []); accepted.get(nft).push(when);}
  }
  for (const gift of gifts) {
    const nft = addressKey(gift.nft_address), member = gift.is_portfolio, times = member ? accepted.get(nft) || [] : [];
    const reasons = member ? result.perGift.get(nft) || {} : {}, observed = member ? result.observed.get(nft) : null;
    let note = COUNT_NOTE;
    if (!member) note = 'Portfolio membership is unresolved; an owned-gift rental count is not assigned.';
    else if (observed == null) note = 'No saved Marketapp rental history for this gift. This does not establish that it has never been rented.';
    else if (!times.length) note = 'No unambiguous rental starts could be counted in the saved history. ' + COUNT_NOTE;
    else if (Object.keys(reasons).length) note += ' Ambiguous or unsupported records are excluded.';
    gift.rental_history = {recorded_count: times.length || null, coverage: !member ? 'not_applicable' : observed != null ? 'partial' : 'no_history', note, observed_at: observed == null ? null : iso(observed), first_rental_at: times.length ? iso(Math.min(...times)) : null, last_rental_at: times.length ? iso(Math.max(...times)) : null, excluded_counts: reasons, semantics_version: 'marketapp-recorded-rental-starts-v1'};
  }
}
function refreshAsking(gift, observations, now) {
  // Seeded contract terms and dated UI evidence remain usable. A later listing
  // refresh supplies the base daily asking price, never a history payment.
  const valid = (observations || []).filter(o => o.valid && o.when !== null && o.when <= now);
  if (!valid.length) return;
  const order = valid.reduce((latest, o) => instantOrder(o.observed_at) > latest ? instantOrder(o.observed_at) : latest, instantOrder(valid[0].observed_at));
  const group = valid.filter(o => instantOrder(o.observed_at) === order);
  if (new Set(group.map(o => canonicalJSON([addressKey(o.source.owner), decimalText(o.price)]))).size > 1) {
    gift.uncertainties.push('Conflicting simultaneous Marketapp asking-price observations'); return;
  }
  const latest = group.at(-1), seed = instantOrder(gift.price_observed_at);
  if (seed === null || order >= seed) {
    gift.price_per_day = decimalText(latest.price); gift.price_unit = 'GRAM'; gift.price_source = 'Marketapp listing';
    gift.price_observed_at = latest.observed_at; gift.price_is_historical = false;
  }
  if ([gift.observed_at, ...(observations || []).map(o => o.observed_at)].some(time => instantOrder(time) !== null && instantOrder(time) > instantOrder(gift.price_observed_at))) {
    gift.price_is_historical = true;
    if (gift.price_source === 'Marketapp listing') gift.price_source = 'Historical Marketapp listing';
  }
  gift.last_listing_observed_at = latest.observed_at;
  if (!gift.name || gift.name === 'Unresolved gift') gift.name = latest.source.nft_name;
  if (['idle_rental_contract', 'unknown', 'held_directly'].includes(gift.state) && !gift.collection_conflict && latest.when >= (instant(gift.observed_at) ?? -Infinity) && latest.when >= (instant(gift.market_observed_at) ?? -Infinity)) {
    gift.ui_state = 'for_rent'; gift.display_state = 'For rent'; gift.market_observed_at = latest.observed_at;
    gift.proof_badges = unique([...gift.proof_badges, 'Marketapp listing observation']);
  }
}
function refreshOwnedAsking(gift, observations, wallet) {
  if (!gift.is_portfolio || !observations?.length) return;
  const valid = observations.filter(({row}) => row.verified === true
    && row.owner && addressKey(row.owner) === addressKey(wallet)
    && addressKey(row.collection_address) === addressKey(gift.collection_address)
    && !gift.collection_conflict && typeof row.configured_price_per_day_raw === 'string'
    && /^\d{1,120}$/.test(row.configured_price_per_day_raw));
  if (valid.length) {
    const order = valid.reduce((latest, o) => instantOrder(o.observed_at) > latest ? instantOrder(o.observed_at) : latest, instantOrder(valid[0].observed_at));
    const latest = valid.filter(o => instantOrder(o.observed_at) === order);
    if (new Set(latest.map(o => o.row.configured_price_per_day_raw)).size > 1) {
      gift.uncertainties.push('Conflicting simultaneous TON configured-price observations.');
    } else if (instantOrder(gift.price_observed_at) === null || order > instantOrder(gift.price_observed_at)) {
      const chosen = latest.at(-1);
      gift.price_per_day = decimalText(rational(BigInt(chosen.row.configured_price_per_day_raw), 1000000000n));
      gift.price_unit = 'GRAM'; gift.price_source = 'Observed contract terms';
      gift.price_observed_at = chosen.observed_at; gift.price_is_historical = false;
    }
  }
  const checkedTime = o => instant(o.row.checked_at) !== null ? o.row.checked_at : o.observed_at;
  const check = observations.reduce((latest, o) => instantOrder(checkedTime(o)) >= instantOrder(checkedTime(latest)) ? o : latest);
  gift.price_checked_at = checkedTime(check);
  gift.price_check_reason = check.row.reason;
  if (!valid.includes(check) && (instantOrder(gift.price_observed_at) === null || instantOrder(checkedTime(check)) >= instantOrder(gift.price_observed_at))) {
    gift.price_is_historical = gift.price_per_day !== null;
    gift.uncertainties.push('The latest TON rent-price check could not verify current configured terms; the previous dated price is retained.');
  }
  if (gift.price_source === 'Observed contract terms') gift.uncertainties.push('Configured rental-contract price; Marketapp listing visibility and counterpart settings propagation are not established.');
}
function eligiblePersonalGifts(gift, observations, wallet) {
  if(!gift.is_portfolio||gift.collection_conflict||!observations?.length)return [];
  const tonAddress=value=>{try{return strictAddress(value);}catch{return null;}};
  const owner=tonAddress(wallet),nft=tonAddress(gift.nft_address),collection=tonAddress(gift.collection_address);
  if(!owner||!nft||!collection)return [];
  return observations.filter(({row})=>row.provider==='marketapp_website'&&row.semantics_version==='marketapp-my-nfts-v1'
    &&row.scope==='my_nfts'&&row.authenticated===true&&row.ownership_verified===false&&row.visible===true
    &&tonAddress(row.wallet)===owner&&tonAddress(row.nft_address)===nft&&tonAddress(row.collection_address)===collection
    &&['for_rent','rented','unknown'].includes(row.rental_state)&&row.rental_until===null);
}
// For the two pinned Marketapp variants, rent helper 49 deploys the derived
// role-1 contract with created_at=NOW, duration=D and expiry=NOW+D. Extension
// helper 50 adds the same increment to duration and expiry, preserving identity.
// Consequently expiry-duration is the original rental start, including for
// older saved observations that did not retain created_at. This helper is only
// used after the full NFT/owner/holder/hash/stability checks below succeed.
function verifiedRentalStart(row, observedAt) {
  if (row.role !== 1 || row.status !== 1 || !['rented', 'expired_pending_return'].includes(row.rental_state)
      || !Object.hasOwn(CONTRACT_VARIANTS, row.code_hash) || row.rental_duration_unit !== 'seconds'
      || !safeInteger(row.rental_duration) || row.rental_duration <= 0 || row.rental_duration > 0xffffffff) return null;
  const start = row.rental_until - row.rental_duration;
  if (!safeInteger(start) || start <= 0 || start * 1000 > observedAt) return null;
  if (row.created_at !== undefined && ((row.created_at_unit !== undefined && row.created_at_unit !== 'Unix seconds')
      || !safeInteger(row.created_at) || row.created_at !== start)) return null;
  return iso(start * 1000);
}
function ownedStatusProof(gift, observation, owner, now) {
  const tonAddress = value => {try {return strictAddress(value);} catch {return null;}};
  const row = observation.row;
  const logicalTime = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
  const direct = row.rental_state === 'held_directly' && tonAddress(row.observed_owner) === owner;
  const contract = ['idle_rental_contract', 'rented', 'expired_pending_return'].includes(row.rental_state)
    && tonAddress(row.nft) === tonAddress(gift.nft_address)
    && tonAddress(row.holding_contract) && tonAddress(row.observed_owner) === tonAddress(row.holding_contract)
    && tonAddress(row.marketplace) === MARKETAPP_OPERATOR && Object.hasOwn(CONTRACT_VARIANTS, row.code_hash)
    && row.code_hash_verified === true && row.data_hash_verified === true && typeof row.data_hash === 'string' && /^[0-9a-f]{64}$/.test(row.data_hash)
    && logicalTime(row.account_last_transaction_lt) && typeof row.decoder_version === 'string' && row.decoder_version.length > 0
    && safeInteger(row.rental_until) && row.rental_until >= 0 && row.rental_until <= 253402300799 && row.rental_until_unit === 'Unix seconds'
    && (row.rental_state === 'idle_rental_contract' ? row.role === 0 && row.status === 0 && row.renter === null && row.rental_until === 0
      : row.role === 1 && row.status === 1 && tonAddress(row.renter) && tonAddress(row.counterpart) && row.rental_until > 0);
  const valid = row.verified === true && tonAddress(row.owner) === owner
    && tonAddress(row.nft_address) === tonAddress(gift.nft_address)
    && tonAddress(row.collection_address) && tonAddress(row.collection_address) === tonAddress(gift.collection_address)
    && logicalTime(row.nft_last_transaction_lt)
    && instant(row.rechecked_at) !== null && instant(row.rechecked_at) >= observation.when && instant(row.rechecked_at) <= now
    && (direct || contract);
  return {valid, direct};
}
function retainVerifiedRentalStart(gift, observations, wallet, now) {
  if (!gift.is_portfolio || gift.collection_conflict || !observations?.length) return;
  const tonAddress = value => {try {return strictAddress(value);} catch {return null;}};
  const owner = tonAddress(wallet);
  if (!owner || !tonAddress(gift.nft_address) || !tonAddress(gift.collection_address)) return;
  const groups = new Map();
  for (const observation of observations) {
    if (tonAddress(observation.row.wallet) !== owner) continue;
    const order = instantOrder(observation.observed_at);
    if (!groups.has(order)) groups.set(order, []);
    groups.get(order).push(observation);
  }
  let latestStart = null;
  for (const group of groups.values()) {
    // Every simultaneous observation must independently pass the complete
    // scope, holder, hash and NFT stability checks. Do not combine partial
    // evidence or pick a convenient variant from a conflicting timestamp.
    if (!group.every(observation => ownedStatusProof(gift, observation, owner, now).valid)) continue;
    const starts = group.map(observation => verifiedRentalStart(observation.row, observation.when));
    if (starts.includes(null) || new Set(starts).size !== 1) continue;
    if (latestStart === null || starts[0] > latestStart) latestStart = starts[0];
  }
  // This is dated evidence that a rental began, not proof that the same rental
  // is still active. New website snapshots may clear current expiry/start
  // fields without erasing a rental that was already independently verified.
  gift.last_verified_rental_started_at = latestStart;
  gift.last_verified_rental_start_source = latestStart ? 'verified_contract' : null;
}
function refreshOwnedStatus(gift, observations, wallet, now, personalObservations) {
  if (!gift.is_portfolio) return;
  const tonAddress = value => {try {return strictAddress(value);} catch {return null;}};
  const owner = tonAddress(wallet);
  if (!owner) return;
  if (gift.collection_conflict || !tonAddress(gift.collection_address) || !tonAddress(gift.nft_address)) {
    gift.status_is_historical = true; gift.status_check_reason = gift.collection_conflict ? 'collection_conflict' : 'unresolved_identity';
    gift.previous_rental_state = gift.state;
    gift.previous_status_observed_at = gift.status_observed_at ?? gift.ownership_observed_at ?? gift.observed_at ?? null;
    gift.state = 'unknown'; gift.display_state = 'Unknown'; gift.ui_state = null;
    gift.rental_until = null; gift.rental_until_unix_seconds = null;
    gift.uncertainties.push('Rental status was not refreshed because NFT or collection identity is unresolved.');
    return;
  }
  // The configured wallet is part of the frozen verification scope. Ignore
  // old observations from a different wallet rather than reassigning evidence.
  const personal=eligiblePersonalGifts(gift,personalObservations,wallet),expiryFailures=[];
  const selected = (observations || []).filter(o => {
    if(tonAddress(o.row.wallet)!==owner)return false;
    if(isSupplementaryExpiryFailure(o.row)&&tonAddress(o.row.nft_address)===tonAddress(gift.nft_address)
      &&tonAddress(o.row.collection_address)===tonAddress(gift.collection_address)) {
      const anchor=instantOrder(o.row.personal_status_observed_at);
      const matching=anchor===null?[]:personal.filter(web=>instantOrder(web.observed_at)===anchor);
      if(anchor!==null&&anchor<=instantOrder(o.observed_at)&&matching.length&&matching.every(web=>web.row.rental_state==='rented')) {
        expiryFailures.push(o);return false;
      }
    }
    return true;
  });
  if(expiryFailures.length) {
    const latest=expiryFailures.reduce((a,b)=>instantOrder(a.observed_at)>instantOrder(b.observed_at)?a:b);
    const failedOrder=instantOrder(latest.observed_at);
    if(selected.every(o=>instantOrder(o.observed_at)<failedOrder)&&personal.every(o=>instantOrder(o.observed_at)<=failedOrder)) {
      gift.rental_expiry_checked_at=latest.observed_at;gift.rental_expiry_check_reason=latest.row.reason;
      gift.uncertainties.push('The supplementary TON expiry check was unavailable; the Marketapp rental status keeps its original observation time.');
    }
  }
  if (!selected.length) return;
  const order = selected.reduce((latest, o) => instantOrder(o.observed_at) > latest ? instantOrder(o.observed_at) : latest, instantOrder(selected[0].observed_at));
  const latest = selected.filter(o => instantOrder(o.observed_at) === order), chosen = latest.at(-1), row = chosen.row;
  const seedTime = gift.status_observed_at ?? gift.ownership_observed_at ?? gift.observed_at;
  if (instant(seedTime) !== null && instant(seedTime) <= now && order < instantOrder(seedTime)) return;
  const conflict = new Set(latest.map(o => canonicalJSON([o.row.verified, o.row.rental_state, o.row.rental_until, o.row.owner, o.row.observed_owner, o.row.holding_contract, o.row.collection_address, o.row.reason]))).size > 1;
  const proof = ownedStatusProof(gift, chosen, owner, now), direct = proof.direct;
  const valid = !conflict && proof.valid;
  gift.status_checked_at = row.checked_at ?? chosen.observed_at;
  gift.status_observed_at = chosen.observed_at;
  gift.status_source = 'TON Center'; gift.status_check_reason = conflict ? 'conflicting_status_observations' : valid ? row.reason : row.verified === true ? 'invalid_status_evidence' : row.reason;
  gift.status_is_historical = !valid;
  // Preserve the previously displayed dated state while making uncertainty
  // explicit. The immutable source envelopes remain the historical record.
  gift.previous_rental_state = gift.state; gift.previous_status_observed_at = seedTime ?? null;
  if (!valid) {
    gift.state = 'unknown'; gift.display_state = 'Unknown'; gift.ui_state = null;
    gift.rental_until = null; gift.rental_until_unix_seconds = null;
    gift.uncertainties.push('The latest TON rental-status check could not verify the current state; previous dated ownership evidence is retained.');
    return;
  }
  let state = row.rental_state;
  if (state === 'rented' && row.rental_until * 1000 <= now) state = 'expired_pending_return';
  gift.state = state;
  gift.display_state = {held_directly: 'Held directly', idle_rental_contract: 'Idle rental contract', rented: 'Rented', expired_pending_return: 'Expired, pending return'}[state];
  gift.ownership_observed_at = chosen.observed_at;
  gift.rental_until_unix_seconds = row.rental_until ?? null;
  gift.rental_until = row.rental_until > 0 ? iso(row.rental_until * 1000) : null;
  const starts = latest.map(o => verifiedRentalStart(o.row, o.when));
  gift.current_rental_started_at = new Set(starts).size === 1 ? starts[0] : null;
  gift.current_rental_start_source = gift.current_rental_started_at ? 'verified_contract' : null;
  gift.holding_contract = row.holding_contract ?? null;
  gift.status_provenance = Object.fromEntries(['provider', 'wallet', 'nft_address', 'collection_address', 'observed_owner', 'holding_contract', 'owner', 'nft_last_transaction_lt', 'account_last_transaction_lt', 'code_hash', 'data_hash', 'code_hash_verified', 'data_hash_verified', 'decoder_version', 'contract_variant', 'storage_layout_version', 'marketplace', 'created_at', 'created_at_unit', 'role', 'status', 'rental_duration', 'rental_duration_unit', 'rental_until', 'rental_until_unit', 'renter', 'counterpart', 'semantics_version', 'rechecked_at'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  // TON idle state does not prove Marketapp listing visibility. Only a later
  // observed listing may retain For rent, and never for a direct/active rental.
  const newerListing = state === 'idle_rental_contract' && gift.ui_state === 'for_rent' && instantOrder(gift.market_observed_at) > order;
  gift.ui_state = newerListing ? 'for_rent' : state === 'rented' ? 'rented' : null;
  if (newerListing) gift.display_state = 'For rent';
  gift.proof_badges = unique([...gift.proof_badges, direct ? 'TON holder observation' : 'TON rental-status observation']);
  // Return only evidence validated during this projection. A portfolio seed
  // can contain old display fields and cannot establish a compatible expiry.
  return {order, state, rental_until: gift.rental_until, rental_until_unix_seconds: gift.rental_until_unix_seconds,
    current_rental_started_at: gift.current_rental_started_at, current_rental_start_source: gift.current_rental_start_source,
    provenance: gift.status_provenance};
}
function refreshPersonalGift(gift, observations, wallet, now, verifiedStatus) {
  const eligible=eligiblePersonalGifts(gift,observations,wallet);
  if(!eligible.length)return;
  const order=eligible.reduce((latest,o)=>instantOrder(o.observed_at)>latest?instantOrder(o.observed_at):latest,instantOrder(eligible[0].observed_at));
  const latest=eligible.filter(o=>instantOrder(o.observed_at)===order),chosen=latest.at(-1),row=chosen.row;
  const priceOf=o=>o.row.currency==='GRAM'&&typeof o.row.price_per_day==='string'
    &&/^(?:0|[1-9]\d{0,35})(?:\.\d{1,9})?$/.test(o.row.price_per_day)?decimalText(decimal(o.row.price_per_day)):null;
  const priceGroups=new Map();
  for(const observation of eligible) {const key=instantOrder(observation.observed_at);if(!priceGroups.has(key))priceGroups.set(key,[]);priceGroups.get(key).push(observation);}
  let validPrice=null;
  for(const [priceTime,group] of priceGroups) {
    const values=group.map(priceOf);
    if(values.every(price=>price!==null)&&new Set(values).size===1&&(!validPrice||priceTime>validPrice.order))validPrice={order:priceTime,observation:group.at(-1),price:values[0]};
  }
  const priceOrder=instantOrder(gift.price_observed_at);
  const checkedOrder=instantOrder(gift.price_checked_at),historicalCheck=gift.price_is_historical===true;
  if(validPrice&&(priceOrder===null||validPrice.order>=priceOrder)) {
    gift.price_per_day=validPrice.price;gift.price_unit='GRAM';gift.price_source='Marketapp account';
    gift.price_observed_at=validPrice.observation.observed_at;gift.price_is_historical=historicalCheck&&checkedOrder!==null&&checkedOrder>validPrice.order;
  }
  if((instantOrder(gift.price_observed_at)===null||order>=instantOrder(gift.price_observed_at))&&(checkedOrder===null||order>=checkedOrder)) {
    const prices=latest.map(priceOf);
    gift.price_checked_at=chosen.observed_at;
    if(prices.every(price=>price!==null)&&new Set(prices).size===1)gift.price_check_reason='observed_account_price';
    else {
      gift.price_is_historical=gift.price_per_day!==null;gift.price_checked_at=chosen.observed_at;
      gift.price_check_reason=new Set(prices).size>1?'conflicting_account_prices':'account_price_unavailable';
      gift.uncertainties.push('The latest Marketapp account observation has no unambiguous GRAM asking price; the previous dated price is retained.');
    }
  }
  const statusTime=gift.status_observed_at??gift.ownership_observed_at??gift.observed_at;
  const priorTimes=[statusTime,...(gift.ui_state==='for_rent'?[gift.market_observed_at]:[])].filter(value=>instant(value)!==null&&instant(value)<=now);
  const priorOrder=priorTimes.length?priorTimes.reduce((max,value)=>instantOrder(value)>max?instantOrder(value):max,instantOrder(priorTimes[0])):null;
  const conflict=new Set(latest.map(o=>o.row.rental_state)).size>1;
  const labels=latest.map(o=>o.row.rental_remaining_display);
  const remaining=!conflict&&row.rental_state==='rented'&&labels.every(label=>typeof label==='string'&&label.length>0&&label.length<=64
    &&label.trim()===label&&!/[\u0000-\u001f\u007f]/.test(label))&&new Set(labels).size===1?labels[0]:null;
  const showRemaining=()=>{if(remaining!==null){gift.rental_remaining_display=remaining;gift.rental_remaining_observed_at=chosen.observed_at;}};
  if(priorOrder!==null&&order<priorOrder) {
    // A later idle contract observation is compatible with earlier personal
    // listing visibility. Preserve its original website timestamp separately;
    // the TON check does not establish a fresh listing or a delisting.
    const marketOrder=instantOrder(gift.market_observed_at);
    if(!conflict&&row.rental_state==='for_rent'&&gift.state==='idle_rental_contract'
      &&gift.status_source==='TON Center'&&gift.status_is_historical===false
      &&(marketOrder===null||order>=marketOrder)) {
      gift.ui_state='for_rent';gift.display_state='For rent';gift.market_observed_at=chosen.observed_at;
      gift.visibility_source='Marketapp account';gift.visibility_observed_at=chosen.observed_at;gift.visibility_is_historical=true;
      gift.visibility_provenance=Object.fromEntries(['provider','wallet','nft_address','collection_address','semantics_version','scope','authenticated','ownership_verified','visible','rental_state'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
      gift.proof_badges=unique([...gift.proof_badges,'Marketapp account observation']);
      gift.uncertainties.push('Marketapp availability was observed earlier; the newer idle contract check does not confirm current listing visibility.');
    }
    // A later verified active rental can keep an earlier rounded account label
    // as dated display evidence. The precise TON expiry takes precedence.
    if(verifiedStatus?.state==='rented'&&verifiedStatus.order>order)showRemaining();
    return;
  }
  const tonState=gift.state==='idle_rental_contract'?'for_rent':gift.state;
  const providerConflict=gift.status_source==='TON Center'&&instantOrder(gift.status_observed_at)===order
    &&['rented','for_rent'].includes(row.rental_state)&&tonState!==row.rental_state;
  gift.previous_rental_state=gift.state;gift.previous_status_observed_at=statusTime??null;
  gift.previous_rental_until=gift.rental_until??null;gift.previous_rental_until_unix_seconds=gift.rental_until_unix_seconds??null;
  gift.previous_status_provenance=gift.status_provenance??null;
  gift.status_source='Marketapp account';gift.status_observed_at=chosen.observed_at;gift.status_checked_at=chosen.observed_at;
  gift.status_is_historical=conflict||providerConflict||row.rental_state==='unknown';
  gift.status_check_reason=conflict?'conflicting_account_status':providerConflict?'conflicting_provider_status':row.rental_state==='unknown'?'account_status_unknown':'observed_account_status';
  gift.status_provenance=Object.fromEntries(['provider','wallet','nft_address','collection_address','semantics_version','scope','authenticated','ownership_verified','visible','rental_state','rental_until','rental_remaining_display'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
  // Marketapp's rounded remaining-time label cannot establish an exact expiry.
  // Prior precise TON expiry stays dated evidence, not a current countdown.
  gift.rental_until=null;gift.rental_until_unix_seconds=null;
  gift.current_rental_started_at=null;gift.current_rental_start_source=null;
  if(conflict||providerConflict||row.rental_state==='unknown') {
    gift.state='unknown';gift.ui_state=null;gift.display_state='Unknown';
    gift.uncertainties.push(providerConflict?'Simultaneous TON and Marketapp account rental states conflict; current status is unresolved.':'The latest Marketapp account rental status is unresolved; previous dated evidence is retained.');
    return;
  }
  if(row.rental_state==='rented') {
    gift.state='rented';gift.ui_state='rented';gift.display_state='Rented';showRemaining();
    // Simultaneous matching observations do not invalidate the independently
    // verified exact TON expiry. Never borrow it from older or seeded fields.
    if(verifiedStatus?.state==='rented'&&verifiedStatus.order===order) {
      gift.rental_until=verifiedStatus.rental_until;gift.rental_until_unix_seconds=verifiedStatus.rental_until_unix_seconds;
      gift.current_rental_started_at=verifiedStatus.current_rental_started_at;gift.current_rental_start_source=verifiedStatus.current_rental_start_source;
      gift.rental_expiry_provenance=verifiedStatus.provenance;
    }
  }
  else {
    // Personal-page availability establishes observed listing visibility, not
    // current on-chain custody or a newly verified holding contract.
    gift.state=gift.state==='idle_rental_contract'?'idle_rental_contract':'unknown';gift.ui_state='for_rent';gift.display_state='For rent';
    gift.market_observed_at=chosen.observed_at;
  }
  gift.proof_badges=unique([...gift.proof_badges.filter(value=>value!=='TON rental-status observation'),'Marketapp account observation']);
}
function giftDefaults(row) {
  return {name: null, collection_name: null, collection_address: null, image_url: null, state: 'unknown', display_state: 'Unknown', ui_state: null, category: row.is_portfolio ? 'portfolio' : 'unresolved', is_portfolio: false, automatic_membership: false, membership_sources: [], verification_method: null, proof_badges: [], price_per_day: null, price_unit: null, price_source: null, rental_until: null, observed_at: null, market_observed_at: null, explorer_url: null, uncertainties: [], ...row, current_rental_started_at: null, current_rental_start_source: null, last_verified_rental_started_at: null, last_verified_rental_start_source: null, rental_remaining_display: null, rental_remaining_observed_at: null, rental_expiry_provenance: null, membership_sources: [...(row.membership_sources || [])], proof_badges: [...(row.proof_badges || [])], uncertainties: [...(row.uncertainties || [])]};
}
function createBuilder(portfolioRecords, input = {}, context = {}) {
  const now = instant(context.now ?? Date.now()); if (now === null) throw new Error('Pricing time must include a timezone');
  const selectedSource = input.pricing_source ?? input.source ?? 'listings', backdrop = input.pricing_backdrop ?? input.backdrop ?? null;
  if (!['listings', 'rentals'].includes(selectedSource)) throw new Error('Unknown pricing source');
  if (backdrop !== null && backdrop !== 'Black') throw new Error('Pricing backdrop must be Black or omitted');
  const window = resolveCloudWindow(input, now), rental = selectedSource === 'rentals';
  const traitNow = rental ? now : instant(window.window_to), cutoff = rental ? now - DAY : instant(window.window_from);
  let dataset = createDataset(portfolioRecords, now, traitNow, rental);
  return {
    add(records) {if (!dataset) throw new Error('The dashboard projection is already finished'); dataset.add(records);},
    finish() {
      if (!dataset) throw new Error('The dashboard projection is already finished');
      const data = dataset.data; dataset = null;
      return projectDashboard(data, {now, selectedSource, backdrop, window, rental, traitNow, cutoff, context});
    },
  };
}
function projectDashboard(data, {now, selectedSource, backdrop, window, rental, traitNow, cutoff, context}) {
  const traits = new Map();
  for (const [nft, evidence] of data.evidence) traits.set(nft, traitsFor(evidence, cutoff, traitNow));
  const gifts = [...data.gifts.values()].map(giftDefaults);
  const rejected = {}; let peers;
  if (rental) {const result = rentalPeers(data, traits, window, now, backdrop); peers = result.peers; Object.assign(rejected, result.rejected);}
  else peers = listingPeers(data, traits, cutoff, traitNow, window.timeframe === 'custom', backdrop, rejected);
  const metadata = {source: selectedSource, unit: 'GRAM/day', sample_unit: rental ? 'rental records' : 'peer NFTs', daily_comparable: true, time_basis: rental ? 'rental_event' : 'listing_observation', backdrop, ...window};
  if (rental) metadata.semantics_version = 'marketapp-rent-history-ui-v1';
  const warnings = rental ? [...RENTAL_WARNINGS] : ['No outliers removed; median and range show sample spread. No sale prices, historical payments or discount calculations used.'];
  if (backdrop) warnings.push(BLACK_NOTE);
  const collectionsIndex = new Map(), cohortCache = new Map();
  for (const peer of peers) {if (!collectionsIndex.has(peer.collection)) collectionsIndex.set(peer.collection, []); collectionsIndex.get(peer.collection).push(peer);}
  let recommended = 0;
  for (const gift of gifts) {
    const nft = addressKey(gift.nft_address), trait = traits.get(nft) || traitsFor(null, cutoff, traitNow);
    Object.assign(gift, {model: trait.model, backdrop: trait.backdrop, traits_source: trait.source, traits_observed_at: trait.observed_at, trait_uncertainties: [...trait.warnings]});
    const conflict = data.conflicts.has(nft) || (data.collections.get(nft)?.size || 0) > 1;
    const collection = conflict ? null : [...(data.collections.get(nft) || [])][0] || null;
    gift.collection_conflict = conflict;
    if (!gift.collection_name && collection) gift.collection_name = data.names.get(collection) || null;
    const model = traitKey(trait.model), comparable = collection ? collectionsIndex.get(collection) || [] : [];
    const cacheKey = canonicalJSON([collection, model]);
    if (!cohortCache.has(cacheKey)) {
      const matching = comparable.filter(p => model !== null && p.model === model);
      const collectionPeers = rental ? comparable : comparable.filter(p => p.eligible[backdrop ? 'collection_black' : 'collection']);
      const modelPeers = rental ? matching : matching.filter(p => p.eligible[backdrop ? 'model_black' : 'model']);
      const blackPeers = matching.filter(p => p.backdrop === 'black' && (rental || p.eligible.model_black));
      const collectionKey = canonicalJSON([collection]);
      if (!cohortCache.has(collectionKey)) cohortCache.set(collectionKey, stats(collectionPeers, rental));
      cohortCache.set(cacheKey, {collection: cohortCache.get(collectionKey), model: stats(modelPeers, rental), model_black: stats(blackPeers, rental)});
    }
    const pricing = {...cohortCache.get(cacheKey), recommended_price_per_day: null, basis: null, confidence: 'none', reason: rental ? 'Rental records from at least 3 distinct peer NFTs are required.' : 'At least 3 distinct fresh peer NFTs are required.', warnings: [...trait.warnings, ...(rental ? warnings : [])], ...metadata};
    if (!gift.is_portfolio) pricing.reason = 'Portfolio membership is unresolved; comparisons are shown without a recommendation.';
    else if (!collection) pricing.reason = conflict ? 'Collection evidence conflicts.' : 'Collection identity is unknown.';
    else if (backdrop && traitKey(trait.backdrop) !== 'black') pricing.reason = 'This gift has no valid saved evidence for the selected exact Black backdrop.';
    else {
      const expected = model && traitKey(trait.backdrop) === 'black' ? 'model_black' : model ? 'model' : 'collection', choices = [];
      // Identity traits remain usable as they age. Price/event windows still
      // apply independently; traitsFor rejects unknown or conflicting values.
      if (model) {if (traitKey(trait.backdrop) === 'black') choices.push('model_black'); if (!backdrop) choices.push('model');}
      choices.push('collection');
      for (const basis of choices) if (pricing[basis][rental ? 'distinct_nft_count' : 'sample_count'] >= 3) {
        const fallback = basis !== expected;
        Object.assign(pricing, {recommended_price_per_day: pricing[basis].mean, basis, confidence: !rental && pricing[basis].sample_count >= 10 && !fallback ? 'medium' : 'low'});
        if (rental) pricing.reason = `Mean observed daily rental rate for the ${basis.replace(/_/g, ' + ')} comparison.${fallback ? ' Using a broader group because more specific evidence is insufficient.' : ''}`;
        else pricing.reason = {model_black: 'Mean asking price for the same model and exact Black backdrop.', model: 'Mean asking price for the same model.', collection: 'Collection mean; a more specific eligible group has insufficient evidence.'}[basis];
        if (fallback) {
          if (!rental) pricing.reason = `The ${expected === 'model_black' ? 'same-model and exact Black' : 'same-model'} comparison has fewer than 3 eligible peers; using the ${basis === 'model' ? 'same-model' : 'collection'} mean.`;
          pricing.warnings.push("Broader averages may not capture this model or backdrop's price premium.");
        }
        if (backdrop && basis === 'collection') pricing.reason = `The same-model + Black group has fewer than 3 ${rental ? 'distinct' : 'eligible'} gifts or insufficient model evidence; using the collection + Black mean.`;
        recommended++; break;
      }
    }
    if (!rental) pricing.warnings.push('Observed asking-price sample; availability, rental income and full-market coverage are not established.');
    gift.pricing = pricing;
    refreshAsking(gift, data.listings.get(nft), now);
    refreshOwnedAsking(gift, data.ownedPrices.get(nft), data.settings.wallet ?? data.settings.wallet_address);
    retainVerifiedRentalStart(gift, data.ownedStatuses.get(nft), data.settings.wallet ?? data.settings.wallet_address, now);
    const verifiedStatus=refreshOwnedStatus(gift, data.ownedStatuses.get(nft), data.settings.wallet ?? data.settings.wallet_address, now, data.personalGifts.get(nft));
    refreshPersonalGift(gift, data.personalGifts.get(nft), data.settings.wallet ?? data.settings.wallet_address, now, verifiedStatus);
  }
  rentalCounts(data, gifts, now);
  const historyByGift = new Map(), trackedNFTs = new Set(gifts.filter(gift => gift.is_portfolio).map(gift => addressKey(gift.nft_address)));
  for (const row of data.history) {
    if (!trackedNFTs.has(row.nft)) continue;
    if (!historyByGift.has(row.nft)) historyByGift.set(row.nft, []);
    historyByGift.get(row.nft).push(row);
  }
  for (const gift of gifts) {
    const nft = addressKey(gift.nft_address);
    gift.price_tracking = buildGiftPriceTracking({gift, wallet: data.settings.wallet ?? data.settings.wallet_address, listings: data.listingHistory.get(nft), ownedPrices: data.ownedPrices.get(nft), personalGifts:data.personalGifts.get(nft), history: historyByGift.get(nft), now});
  }
  gifts.sort((a, b) => Number(!a.is_portfolio) - Number(!b.is_portfolio) || (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) || a.id.localeCompare(b.id));
  const portfolio = gifts.filter(g => g.is_portfolio), by = test => portfolio.filter(test).length;
  const summary = {portfolio_count: portfolio.length, automatic_count: by(g => g.automatic_membership), review_count: by(g => g.membership_sources.includes('local_review') && !g.automatic_membership), for_rent_count: by(g => g.ui_state === 'for_rent'), idle_count: by(g => g.state === 'idle_rental_contract'), rented_count: by(g => g.state === 'rented'), direct_count: by(g => g.state === 'held_directly'), sale_count: by(g => g.state === 'listed_for_sale'), unresolved_count: gifts.length - portfolio.length, uncertain_count: by(g => ['unknown', 'uncertain', 'expired_pending_return'].includes(g.state))};
  const portfolioKeys = new Set(portfolio.map(g => g.id));
  const activity = data.history.filter(h => h.item && portfolioKeys.has(h.nft) && instant(h.observed_at) !== null && instant(h.observed_at) <= now).map((h, index) => ({id: `history-${h.key ?? index}`, type: 'portfolio_gift_history', title: 'Portfolio gift history', nft_address: h.nft, name: data.gifts.get(h.nft)?.name, observed_at: h.observed_at, source: 'Marketapp', price: h.item.price, currency: h.item.currency, note: 'Gift history does not establish proceeds received by this wallet'})).sort((a, b) => instant(b.observed_at) - instant(a.observed_at)).slice(0, 100);
  const pricing = {...metadata, generated_at: iso(now), min_samples: 3, fresh_peer_count: new Set(peers.map(p => p.nft)).size, excluded_counts: rejected, recommended_count: recommended, coverage: 'observed_sample', methodology: rental ? 'Arithmetic mean of observed rental daily rates, one weight per unambiguous rental record; minimum three distinct peer NFTs for a recommendation.' : 'Latest fresh base daily asking price per distinct NFT; arithmetic means rounded to one nanoGRAM (half up). Collection averages require unfiltered occurrences; model averages exclude backdrop and symbol filters; Black averages exclude symbol filters. Exact Black only. Eligible portfolio and wallet-owned listings, including the gift being compared, are included on the same terms as other listings.', warnings};
  if (rental) pricing.rental_record_count = peers.length; else pricing.max_age_hours = String((traitNow - cutoff) / 3600000);
  return {wallet: data.settings.wallet ?? data.settings.wallet_address ?? null, generated_at: iso(now), summary, gifts, pricing, activity, runs: context.runs || {discovery: [], market: []}, coverage: {note: 'Portfolio membership is imported, dated evidence. Targeted TON checks refresh prices and rental status for known gifts; they do not discover gifts or establish Marketapp listing visibility. Each market observation has its own timestamp; saved coverage is a bounded sample.', enumeration_complete: false, pending_verification_count: gifts.filter(g => !g.is_portfolio).length, imported_gift_count: gifts.length, ...(context.coverage || {})}, review: {enabled: true, files: [], warnings: [], note: 'Imported local review annotations remain separate from automatic portfolio membership.'}, capabilities: context.capabilities || {network_enabled: false, marketapp_configured: false, ton_configured: false, wallet_configured: Boolean(data.settings.wallet), csrf_token: ''}};
}
return createBuilder;
}

// Seed membership before consuming pages: a portfolio row may follow its older
// listing/history observations. Each source page can then be released without
// dropping displayed gifts' asking prices or price-change timelines.
export function createCloudDashboardBuilder(portfolioRecords, input = {}, context = {}) {
  return createProjection()(portfolioRecords, input, context);
}
export function buildCloudDashboard(records, input = {}, context = {}) {
  const builder = createCloudDashboardBuilder(records, input, context);
  builder.add(records);
  return builder.finish();
}
