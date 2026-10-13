// Read-only projections of saved asking prices and recorded gift rentals.
// An observation brackets a detected price change; it is not its execution time.
import {canonicalAddress, addressKey, instant, instantOrder, iso, rational, decimal, decimalText, plus, multiply, compare, canonicalJSON} from './cloud-pricing-core.js';
import {CONTRACT_VARIANTS, MARKETAPP_OPERATOR} from './ton-price-decoder.js';

const DAY_MICROS = 86400000000n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unit = 'GRAM/day';
const tonAddress = value => {try {return canonicalAddress(value);} catch {return null;}};
const instantText = order => {
  const fraction = (order % 1000000n + 1000000n) % 1000000n;
  const milliseconds = (order - fraction) / 1000n, fractional = String(fraction).padStart(6, '0');
  return iso(Number(milliseconds)).replace(/\.\d{3}Z$/, `.${fractional}Z`);
};
function exactMonetaryText(value) {
  // Monetary inputs are base-ten decimals, so a reduced sum's denominator has
  // only factors 2 and 5. Retain its terminating scale instead of rounding the
  // saved payment sum to the nano precision used for derived rates.
  let denominator = value.d, twos = 0, fives = 0;
  while (denominator % 2n === 0n && twos < 1000) {denominator /= 2n; twos++;}
  while (denominator % 5n === 0n && fives < 1000) {denominator /= 5n; fives++;}
  if (denominator !== 1n) throw new Error('Nonterminating monetary total');
  return decimalText(value, Math.max(twos, fives));
}

export function observedPriceChanges(points) {
  const dated = points.filter(point => instantOrder(point.observed_at) !== null).sort((a, b) => instantOrder(a.observed_at) < instantOrder(b.observed_at) ? -1 : instantOrder(a.observed_at) > instantOrder(b.observed_at) ? 1 : 0);
  const groups = new Map();
  for (const point of dated) {
    const time = String(instantOrder(point.observed_at));
    if (!groups.has(time)) groups.set(time, []);
    groups.get(time).push(point);
  }
  let previous = null, observationCount = 0, latest = null, baseline = null, resetPending = false, continuityFloor = null;
  const changes = [], barriers = [];
  for (const group of groups.values()) {
    // A failed check, changed owner/contract, or simultaneous conflict breaks
    // continuity. A later successful check establishes a fresh baseline.
    const signatures = new Set(group.map(point => canonicalJSON([point.scope ?? null, point.price ? decimalText(point.price) : null])));
    if (group.some(point => !point.price || !point.scope) || signatures.size !== 1) {barriers.push({at_order: instantOrder(group[0].observed_at), ceiling_order: previous ? instantOrder(previous.observed_at) : null}); previous = null; resetPending = true; continuityFloor = null; continue;}
    const point = group.at(-1);
    observationCount++; latest = point; baseline ||= point;
    if (resetPending) {continuityFloor = instantOrder(point.observed_at); resetPending = false;}
    if (previous && previous.scope !== point.scope) {barriers.push({at_order: instantOrder(point.observed_at), ceiling_order: instantOrder(previous.observed_at)}); continuityFloor = instantOrder(point.observed_at);}
    if (previous && previous.scope === point.scope && compare(previous.price, point.price) !== 0) changes.push({previous, current: point, continuity_floor: continuityFloor});
    previous = point;
  }
  return {changes, observation_count: observationCount, latest, baseline, barriers, barrier_count: barriers.length};
}

// The normalized rows carry source JSON intact. Canonical identities and full
// representations prevent page overlaps and repeated transaction hashes from
// fabricating extra rentals. Price and duration failures affect metrics only.
export function recordedGiftRentals(rows, nft, now, collection = null) {
  const groups = new Map(), seen = new Map(), reasons = {}, rejected = [], accepted = [];
  let observed = null;
  const reject = (reason, when = null, count = 1) => {reasons[reason] = (reasons[reason] || 0) + count; rejected.push({reason, when, count});};
  for (const row of rows) {
    if (addressKey(row.nft) !== nft || instant(row.observed_at) === null || instant(row.observed_at) > now) continue;
    observed = Math.max(observed ?? -Infinity, instant(row.observed_at));
    const item = row.item, representation = canonicalJSON(item);
    // Imported fingerprint fields are linkage evidence, not trusted content
    // identity. A shared fingerprint must never conceal a changed variant.
    if (seen.has(representation)) {const capture = seen.get(representation); capture.observed_at = Math.max(capture.observed_at, instant(row.observed_at)); continue;}
    const capture = {observed_at: instant(row.observed_at)};
    seen.set(representation, capture);
    const dated = Number.isSafeInteger(item?.ts) && item.ts > 0 && item.ts <= 253402300799 ? item.ts * 1000 : null;
    if (!object(item) || addressKey(item.address) !== nft || dated === null || dated > now || !addressKey(item.collection_address) || !addressKey(item.src) || !addressKey(item.dst) || typeof item.name !== 'string' || typeof item.price !== 'string' || typeof item.price_nano !== 'string' || !['GRAM', 'TON', 'USDT'].includes(item.currency) || (Object.hasOwn(item, 'duration') && !Number.isSafeInteger(item.duration)) || (Object.hasOwn(item, 'is_extend') && typeof item.is_extend !== 'boolean') || (Object.hasOwn(item, 'tx_hash') && item.tx_hash !== null && typeof item.tx_hash !== 'string')) {reject('malformed_history', dated); continue;}
    const normalized = {...item, address: nft, collection_address: addressKey(item.collection_address), src: addressKey(item.src), dst: addressKey(item.dst)};
    const key = canonicalJSON([nft, item.ts, normalized.src, normalized.dst]);
    if (!groups.has(key)) groups.set(key, new Map());
    const variants = groups.get(key), signature = canonicalJSON(normalized), previous = variants.get(signature);
    if (previous) {
      previous.capture.observed_at = Math.max(previous.capture.observed_at, capture.observed_at);
      seen.set(representation, previous.capture);
    } else variants.set(signature, {item, when: item.ts * 1000, capture});
  }
  for (const variants of groups.values()) {
    if (variants.size !== 1) {reject('ambiguous_history_variants', variants.values().next().value.when, variants.size); continue;}
    const row = variants.values().next().value, {item} = row;
    if (collection !== null && addressKey(item.collection_address) !== collection) {reject('collection_mismatch', row.when); continue;}
    if (['action', 'event_type'].some(key => typeof item[key] === 'string' && ['return', 'returned', 'cancel', 'cancelled', 'canceled', 'transfer'].includes(item[key].trim().toLowerCase()))) {reject('non_rental_action', row.when); continue;}
    if (item.is_extend !== false) {reject(item.is_extend === true ? 'extensions' : 'unknown_extension_status', row.when); continue;}
    let amount = null, daily = null;
    if (item.currency !== 'GRAM') {reject('non_gram_currency', row.when); continue;}
    else try {
      const value = decimal(item.price), nano = decimal(item.price_nano);
      if (value.n < 0n || nano.n < 0n) throw new Error();
      if (compare(value, multiply(nano, 1n, 1000000000n)) !== 0) reject('inconsistent_gram_amounts', row.when);
      else amount = value;
    } catch {reject('invalid_amount', row.when);}
    if (!Number.isSafeInteger(item.duration) || item.duration <= 0) reject('missing_or_nonpositive_duration', row.when);
    else if (amount) daily = multiply(amount, 86400n, BigInt(item.duration));
    if (amount && daily) accepted.push({...row, amount, daily});
  }
  const acceptedObserved = accepted.reduce((latest, row) => Math.max(latest ?? -Infinity, row.capture.observed_at), null);
  return {rows: accepted, rejected, observed_at: observed === null ? null : iso(observed), accepted_observed_at: acceptedObserved === null ? null : iso(acceptedObserved), excluded_counts: reasons};
}

// One validated rental sample supplies both independent dashboard projections.
// TON evidence supplements start counts only; it never invents payment data.
export function prepareGiftRentalFacts({gift, history = [], verifiedRentalStarts = [], verifiedRentalObservedAt = null, now}) {
  const rental = recordedGiftRentals(history, addressKey(gift.nft_address), now, addressKey(gift.collection_address));
  const recordedStarts = new Set(rental.rows.map(row => row.when));
  const verifiedStarts = [...new Set(verifiedRentalStarts.map(instant).filter(when => when !== null && when > 0 && when <= now))];
  rental.verified_starts_without_history = verifiedStarts.filter(when => !recordedStarts.has(when));
  const verifiedObserved = instant(verifiedRentalObservedAt);
  rental.verified_observed_at = verifiedStarts.length && verifiedObserved !== null && verifiedObserved <= now ? iso(verifiedObserved) : null;
  return rental;
}

export function buildGiftRentalStatistics({gift, history = [], verifiedRentalStarts = [], verifiedRentalObservedAt = null, rentalFacts = null, now}) {
  const result = {version: 1, semantics_version: 'saved-gift-rental-statistics-v1', coverage: 'not_applicable', observed_at: null,
    first_rental_at: null, last_rental_at: null, observed_rentals: null, recorded_rentals: null, verified_rentals_without_history: null,
    recorded_volume: null, average_daily_rate: null, rental_days: null, excluded_counts: {}};
  if (!gift.is_portfolio || gift.collection_conflict || !addressKey(gift.nft_address) || !addressKey(gift.collection_address)) return result;
  const rental = rentalFacts ?? prepareGiftRentalFacts({gift, history, verifiedRentalStarts, verifiedRentalObservedAt, now});
  const starts = [...new Set([...rental.rows.map(row => row.when), ...rental.verified_starts_without_history])].sort((a, b) => a - b);
  result.coverage = starts.length ? 'partial' : 'no_history';
  result.excluded_counts = {...rental.excluded_counts};
  if (!starts.length) return result;
  const observed = [rental.accepted_observed_at, rental.verified_observed_at].map(instant).filter(value => value !== null);
  result.observed_at = observed.length ? iso(Math.max(...observed)) : null;
  result.first_rental_at = iso(starts[0]); result.last_rental_at = iso(starts.at(-1));
  result.observed_rentals = starts.length;
  result.verified_rentals_without_history = rental.verified_starts_without_history.length;
  if (rental.rows.length) {
    const total = rental.rows.reduce((sum, row) => plus(sum, row.amount), rational(0n));
    const seconds = rental.rows.reduce((duration, row) => duration + BigInt(row.item.duration), 0n);
    result.recorded_rentals = rental.rows.length;
    result.recorded_volume = exactMonetaryText(total);
    result.rental_days = decimalText(rational(seconds, 86400n));
    result.average_daily_rate = decimalText(multiply(total, 86400n, seconds));
  }
  return result;
}

function periodStats(history, from, to) {
  const result = {window_from: instantText(from), window_to: instantText(to), recorded_rentals: null, observed_rentals: null, verified_rentals_without_history: null, recorded_volume: null, average_daily_rate: null, rental_days: null, excluded_counts: {}, coverage: 'observed_sample'};
  if (to <= from) return result;
  const inside = when => when !== null && BigInt(when) * 1000n >= from && BigInt(when) * 1000n < to;
  const rows = history.rows.filter(row => inside(row.when));
  for (const row of history.rejected) if (inside(row.when)) result.excluded_counts[row.reason] = (result.excluded_counts[row.reason] || 0) + row.count;
  result.recorded_rentals = rows.length;
  result.verified_rentals_without_history=history.verified_starts_without_history.filter(inside).length;
  result.observed_rentals=new Set(rows.map(row=>row.when)).size+result.verified_rentals_without_history;
  const total = rows.reduce((sum, row) => plus(sum, row.amount), rational(0n)), seconds = rows.reduce((duration, row) => duration + BigInt(row.item.duration), 0n);
  result.recorded_volume = exactMonetaryText(total);
  result.rental_days = decimalText(rational(seconds, 86400n));
  if (seconds) result.average_daily_rate = decimalText(multiply(total, 86400n, seconds));
  return result;
}

function comparisons(history, series, index, now) {
  const {changes, barriers} = series;
  const change = changes[index], firstNew = instantOrder(change.current.observed_at), lastOld = instantOrder(change.previous.observed_at);
  const prior = index > 0 ? instantOrder(changes[index - 1].current.observed_at) : null;
  const next = index + 1 < changes.length ? instantOrder(changes[index + 1].previous.observed_at) : null;
  const beforeFloors = [prior, change.continuity_floor].filter(value => value !== null);
  const beforeFloor = beforeFloors.length ? beforeFloors.reduce((latest, value) => value > latest ? value : latest) : null;
  // A failed read only establishes uncertainty by that time. End at the last
  // successful price observation before it, excluding the unchecked gap.
  const barrier = barriers.find(value => value.at_order > firstNew)?.ceiling_order ?? null;
  const afterCeilings = [next, barrier].filter(value => value !== null);
  const afterCeiling = afterCeilings.length ? afterCeilings.reduce((earliest, value) => value < earliest ? value : earliest) : null;
  const beforeCap = beforeFloor === null ? null : lastOld - beforeFloor, afterCap = afterCeiling === null ? null : afterCeiling - firstNew;
  const elapsed = now > firstNew ? now - firstNew : 0n;
  return [7, 14, 30].map(days => {
    const wanted = BigInt(days) * DAY_MICROS;
    const limits = [wanted, elapsed, ...(beforeCap === null ? [] : [beforeCap]), ...(afterCap === null ? [] : [afterCap])];
    const length = limits.reduce((minimum, value) => value < minimum ? value : minimum, wanted);
    const duration = length > 0n ? length : 0n;
    const structural = (beforeCap !== null && beforeCap < wanted) || (afterCap !== null && afterCap < wanted);
    return {days, status: structural ? 'partial' : duration === wanted ? 'ready' : 'pending', comparable_days: decimalText(rational(duration, DAY_MICROS)), before: periodStats(history, lastOld - duration, lastOld), after: periodStats(history, firstNew, firstNew + duration)};
  });
}

export function buildGiftPriceTracking({gift, wallet, listings = [], ownedPrices = [], personalGifts = [], history = [], verifiedRentalStarts = [], rentalFacts = null, now}) {
  const nft = addressKey(gift.nft_address), warnings = [
    'Changes were first observed between saved checks; the actual change time is unknown. Each source has its own timeline; Marketapp account, TON configured and Marketapp listing prices are never compared across sources.',
    'Rental counts combine saved history and independently verified TON starts, deduplicated by gift and start time. Volume and rates use only unambiguous GRAM payment history; verified starts alone do not establish payment amounts.',
    'Before/after periods have equal elapsed lengths and exclude the unchecked price-change gap. Ready describes elapsed time, never complete history coverage.',
    'Recorded volume uses whole reported rental payments and rental days sum full durations for starts in the period; neither is apportioned to the period.',
  ];
  const result = {version: 1, semantics_version: 'observed-price-performance-v1', source: null, unit, observation_count: 0, change_count: 0, last_observed_at: null, baseline_price_per_day: null, baseline_observed_at: null, coverage: 'no_observations', changes: [], warnings};
  if (!gift.is_portfolio || gift.collection_conflict || !nft) return result;
  const owner = tonAddress(wallet), tonNFT = tonAddress(gift.nft_address), collection = addressKey(gift.collection_address), tonCollection = tonAddress(gift.collection_address);
  const ton = ownedPrices.filter(point => point.when <= now && [point.row.wallet, point.row.wallet_address].every(value => value == null || tonAddress(value) === owner)).map(point => {
    const row = point.row, scope = tonAddress(row.holding_contract);
    const provenance = row.code_hash_verified !== false && row.data_hash_verified !== false
      && (row.code_hash == null || Object.hasOwn(CONTRACT_VARIANTS, row.code_hash))
      && (row.data_hash == null || typeof row.data_hash === 'string' && /^[0-9a-f]{64}$/.test(row.data_hash))
      && (row.marketplace == null || tonAddress(row.marketplace) === MARKETAPP_OPERATOR)
      && (row.currency == null || row.currency === 'GRAM') && (row.price_unit == null || row.price_unit === 'nanoGRAM/day')
      && (row.rental_state == null || ['idle_rental_contract', 'rented', 'expired_pending_return'].includes(row.rental_state))
      && (row.nft == null || tonAddress(row.nft) === tonNFT)
      && (row.observed_owner == null || tonAddress(row.observed_owner) === scope);
    const valid = provenance && row.verified === true && owner !== null && tonAddress(row.owner) === owner && tonNFT !== null && tonAddress(row.nft_address) === tonNFT && tonCollection !== null && tonAddress(row.collection_address) === tonCollection && scope !== null && typeof row.configured_price_per_day_raw === 'string' && /^\d{1,120}$/.test(row.configured_price_per_day_raw);
    return {observed_at: point.observed_at, scope, price: valid ? rational(BigInt(row.configured_price_per_day_raw), 1000000000n) : null};
  });
  const market = listings.filter(point => point.when !== null && point.when <= now).map(point => ({observed_at: point.observed_at, scope: addressKey(point.source?.owner), price: point.valid ? point.price : null}));
  const account=personalGifts.filter(point=>instant(point.observed_at)!==null&&instant(point.observed_at)<=now&&owner!==null&&tonNFT!==null&&tonCollection!==null
    &&point.row?.provider==='marketapp_website'&&point.row.semantics_version==='marketapp-my-nfts-v1'&&point.row.scope==='my_nfts'
    &&point.row.authenticated===true&&point.row.ownership_verified===false&&point.row.visible===true
    &&tonAddress(point.row.wallet)===owner&&tonAddress(point.row.nft_address)===tonNFT&&tonAddress(point.row.collection_address)===tonCollection
    &&['for_rent','rented','unknown'].includes(point.row.rental_state)&&point.row.rental_until===null).map(point=>({
      observed_at:point.observed_at,scope:owner,
      price:point.row.currency==='GRAM'&&typeof point.row.price_per_day==='string'&&/^(?:0|[1-9]\d{0,35})(?:\.\d{1,9})?$/.test(point.row.price_per_day)?decimal(point.row.price_per_day):null,
    }));
  const timelines = [
    {source: 'Marketapp account', series: observedPriceChanges(account)},
    {source: 'TON contract', series: observedPriceChanges(ton)},
    {source: 'Marketapp listing', series: observedPriceChanges(market)},
  ];
  const preferred = timelines.find(timeline => timeline.series.observation_count);
  if (!preferred) return result;
  const {source, series} = preferred;
  // A newly connected source may have only a baseline. Keep prior changes
  // from every independent timeline instead of replacing them with an empty
  // preferred timeline. At most five candidates per source can reach the
  // global latest five; keep original indexes for their performance bounds.
  const candidates = timelines.flatMap((timeline, priority) => timeline.series.changes.slice(-5).map((change, localIndex) => ({
    ...timeline, priority, change,
    index: timeline.series.changes.length - Math.min(5, timeline.series.changes.length) + localIndex,
    order: instantOrder(change.current.observed_at),
  })));
  candidates.sort((a, b) => a.order > b.order ? -1 : a.order < b.order ? 1 : a.priority - b.priority);
  const selected = candidates.slice(0, 5), displayedSources = new Set([source, ...selected.map(value => value.source)]);
  for (const timeline of timelines) if (displayedSources.has(timeline.source) && timeline.series.barrier_count)
    warnings.push(`${timeline.source}: invalid, conflicting or changed owner/contract evidence interrupts this timeline; the next valid observation starts a new baseline.`);
  if(displayedSources.has('Marketapp account'))warnings.push('Account asking prices are authenticated personal-page observations; they do not establish on-chain ownership or completed price changes.');
  if (displayedSources.has('Marketapp listing')&&ton.length && !timelines[1].series.observation_count) warnings.push('No verified TON configured-price observation was eligible; listing changes use saved Marketapp listings.');
  const rental = rentalFacts ?? prepareGiftRentalFacts({gift, history, verifiedRentalStarts, now});
  // These dates come from the dashboard's full NFT/owner/holder/hash/stability
  // validator, never from seeded display fields or a website Rented label.
  // An extension preserves its original start. Later history for that exact
  // start replaces the supplemental count without estimating any payment.
  if (rental.observed_at === null) warnings.push('No saved rental history exists for this gift; zero recorded starts does not establish that it was never rented.');
  if (rental.rejected.some(row => row.when === null)) warnings.push('Some malformed history has no valid event date and cannot be assigned to a comparison period.');
  Object.assign(result, {source, observation_count: series.observation_count, change_count: timelines.reduce((total, timeline) => total + timeline.series.changes.length, 0), last_observed_at: instantText(instantOrder(series.latest.observed_at)), baseline_price_per_day: decimalText(series.baseline.price), baseline_observed_at: instantText(instantOrder(series.baseline.observed_at)), coverage: 'observed_sample'});
  result.changes = selected.map(({source, series, change, index}) => {
    const observed_at = instantText(instantOrder(change.current.observed_at)), previous_observed_at = instantText(instantOrder(change.previous.observed_at));
    const delta = plus(change.current.price, multiply(change.previous.price, -1n));
    return {id: canonicalJSON([nft, source, observed_at]), source, source_last_observed_at: instantText(instantOrder(series.latest.observed_at)), observed_at, previous_observed_at, from_price_per_day: decimalText(change.previous.price), to_price_per_day: decimalText(change.current.price), delta_per_day: decimalText(delta), percent_change: change.previous.price.n === 0n ? null : decimalText(multiply(delta, 100n * change.previous.price.d, change.previous.price.n)), comparisons: comparisons(rental, series, index, instantOrder(now))};
  });
  return result;
}
