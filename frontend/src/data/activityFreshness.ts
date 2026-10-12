import type { Dashboard, DataRecord, Gift, Job, PersonalRentalAnalytics } from './types.ts';
import { analyticsFreshnessPresentation } from './analyticsFreshness.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';
import { TIMEFRAME_OPTIONS } from './pricingSelection.ts';
import type { OwnedPriceSnapshot } from './ownedPriceRefresh.ts';
import { dateTime } from './helpers.ts';
import { sha256 } from '../../../serverless/tgcloud/lib/ton-price-decoder.js';

/** These match the targeted gift cache, completed market cache and analytics refresh policies. */
export const ACTIVITY_FRESHNESS_MINUTES = Object.freeze({ gifts: 5, prices: 5, comparisons: 60, analytics: 15 });
/** Check recency is separate from the age or availability of an individual value. */
export const ACTIVITY_GIFT_CHECK_MINUTES = 60;

export interface ActivityComparisonSourceEvidence {
  total_collections: number;
  checked_collections: number;
  fresh_collections: number;
  freshest_checked_at: string | null;
  oldest_checked_at: string | null;
  /** Original rental-history watermarks; dashboard reads never advance them. */
  oldest_checked_through?: string | null;
  freshest_checked_through?: string | null;
  complete: boolean;
  unresolved_collections?: number;
  timeframe?: string;
  window_from?: string | null;
  window_to?: string | null;
}
export interface ActivityComparisonEvidence {
  version: 1;
  listings: ActivityComparisonSourceEvidence;
  rentals: ActivityComparisonSourceEvidence;
}
export interface ActivityFreshnessRow {
  id: string;
  label: string;
  tone: 'fresh' | 'older';
  state: 'fresh' | 'older' | 'incomplete' | 'missing';
  status: string;
  /** Latest actual successful source observation; never a job or projection timestamp. */
  updatedAt: string | null;
  /** Oldest successful evidence contributing to the stated coverage. */
  oldestUpdatedAt: string | null;
  coverage: string;
  detail: string;
  freshnessMinutes: number;
  /** Work in progress does not change the freshness of already displayed data. */
  updating: boolean;
  /** Check completion is separate from whether a current value could be confirmed. */
  checkStatus: string | null;
  /** An attempted check is not a successful update; cache reuse does not advance this date. */
  checkedAt: string | null;
  /** Gift rows can show a completed check without calling unavailable values fresh. */
  checkPresentation?: { tone: 'fresh' | 'older'; status: string; checkedAt: string | null };
  /** Missing or historical values remain a visible warning beside a completed check. */
  availabilityWarning?: boolean;
  /** Fixed local feedback for this opening's failed portfolio refresh, independent of saved evidence. */
  refreshFailure?: string;
}
export interface ActivityFreshnessOptions {
  now?: number;
  comparisonEvidence?: ActivityComparisonEvidence | null;
  giftRefresh?: OwnedPriceSnapshot | null;
}

const minute = 60000;
const statuses = { fresh: 'Fresh', older: 'Older data', incomplete: 'Partly updated', missing: 'Not updated' } as const;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A malformed or future provider timestamp must not turn a row green. */
function instant(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  // Comparing the supplied calendar date also rejects JavaScript's normalization of February 30.
  const localDate = value.slice(0, 10), zone = value.endsWith('Z') ? 0 :
    Number(value.slice(-5, -3)) * 60 + Number(value.slice(-2));
  const direction = value.endsWith('Z') || value.at(-6) === '+' ? 1 : -1;
  const calendarTime = parsed + direction * zone * minute;
  return Number.isFinite(now) && Number.isFinite(parsed) && parsed <= now && parsed >= 0
    && new Date(calendarTime).toISOString().slice(0, 10) === localDate ? parsed : null;
}
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const recent = (value: number | null, now: number, minutes: number) => value !== null && now - value < minutes * minute;
const identity = (value: string) => canonicalMainnetAddress(value) ?? value;
function stampRange(values: (number | null)[]) {
  const valid = values.filter((value): value is number => value !== null);
  return { updatedAt: iso(valid.length ? Math.max(...valid) : null), oldestUpdatedAt: iso(valid.length ? Math.min(...valid) : null) };
}
function row(base: Omit<ActivityFreshnessRow, 'tone' | 'status' | 'checkStatus' | 'checkedAt'>
  & Partial<Pick<ActivityFreshnessRow, 'checkStatus' | 'checkedAt'>>): ActivityFreshnessRow {
  return { checkStatus: null, checkedAt: null, ...base, tone: base.state === 'fresh' ? 'fresh' : 'older', status: statuses[base.state] };
}
function portfolioGroups(gifts: Gift[]): Gift[][] {
  const groups = new Map<string, Gift[]>();
  for (const gift of gifts) if (gift.is_portfolio) {
    const key = identity(gift.nft_address || gift.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(gift);
  }
  return [...groups.values()];
}
/** Match the backend's frozen wallet + NFT/collection pairs, not only its count. */
function checkedScopeSignature(groups: Gift[][], wallet: string | null): string | null {
  if (!wallet || !groups.length) return null;
  const targets = [];
  for (const group of groups) {
    const nfts = group.map(gift => canonicalMainnetAddress(gift.nft_address));
    const collections = group.map(gift => canonicalMainnetAddress(gift.collection_address));
    if (group.some(gift => gift.collection_conflict) || nfts.some(nft => nft === null)
      || collections.some(collection => collection === null) || new Set(nfts).size !== 1 || new Set(collections).size !== 1) return null;
    targets.push({ nft_address: nfts[0]!, collection_address: collections[0]! });
  }
  targets.sort((a, b) => a.nft_address.localeCompare(b.nft_address));
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify({ wallet, targets }))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function amount(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1000 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
}
function statusEvidence(gift: Gift, now: number) {
  const value = instant(gift.status_observed_at, now);
  const prior = gift as Gift & { ownership_observed_at?: string | null; previous_status_observed_at?: string | null };
  const historical = instant(prior.ownership_observed_at, now) ?? instant(prior.previous_status_observed_at, now);
  const available = gift.ui_state === 'for_rent' && ['unknown', 'idle_rental_contract', 'for_rent'].includes(gift.state);
  // A known expired rental is current status evidence, even though it still
  // needs attention. Imported membership/review labels do not age source data.
  const confirmed = value !== null && gift.status_is_historical === false && !gift.collection_conflict
    && (available || ['rented', 'idle_rental_contract', 'held_directly', 'expired_pending_return',
      'for_rent', 'on_sale', 'on_auction', 'listed_for_sale'].includes(gift.state));
  // The latest unsuccessful check can have a newer status_observed_at; its dated prior ownership stays separate.
  return { time: gift.status_is_historical === true ? historical : value ?? historical, confirmed,
    checked: gift.status_checked_at == null ? confirmed ? value : null : instant(gift.status_checked_at, now),
    key: `${gift.state}:${gift.ui_state ?? ''}` };
}
function priceEvidence(gift: Gift, now: number) {
  const price = amount(gift.price_per_day), value = instant(gift.price_observed_at, now);
  const valid = price !== null && value !== null && ['GRAM', 'GRAM/day'].includes(gift.price_unit ?? '') && Boolean(gift.price_source);
  return { time: valid ? value : null, confirmed: valid && gift.price_is_historical !== true && !gift.collection_conflict,
    checked: gift.price_checked_at == null ? valid && gift.price_is_historical !== true ? value : null : instant(gift.price_checked_at, now), key: price };
}
function refreshFailureMessage(error: unknown): string {
  // The driver creates these fixed diagnostics. Never display arbitrary provider errors or run.reason.
  const messages = [
    'Another gift check is still finishing. Wait for it or stop it in Status, then try again.',
    'This gift check no longer matches your saved wallet or gift. Reload your gifts before trying again.',
    'Wallet connection changed. Start a new gift refresh.',
    'Updates paused because app storage is full. Saved prices are kept.',
    'Updates paused to protect saved data. Clean up storage from Status, then try again.',
  ];
  return typeof error === 'string' && messages.includes(error) ? error
    : 'The latest gift refresh could not finish. Your saved data is kept. Try Refresh again.';
}
function refreshCheck(groups: Gift[][], now: number, evidence: { checked: number | null }[],
  dashboard: Dashboard, refresh?: OwnedPriceSnapshot | null) {
  const total = groups.length, checked = evidence.filter(item => item.checked !== null).length;
  const stamps = stampRange(evidence.map(item => item.checked));
  const run = refresh?.run, start = instant(run?.started_at, now), finish = instant(run?.completed_at, now);
  const failedPortfolioRefresh = (refresh?.scope ?? run?.scope) !== 'gift' && (refresh?.phase === 'unavailable' || run?.state === 'failed' || Boolean(refresh?.error));
  if (failedPortfolioRefresh) return {
    checkStatus: !total || !checked ? null : `Saved check coverage · ${checked}/${total} checked`,
    checkedAt: stamps.updatedAt,
    checkPresentation: { tone: 'older' as const, status: 'Check failed', checkedAt: null },
    refreshFailure: refreshFailureMessage(refresh?.error),
  };
  const wallet = canonicalMainnetAddress(dashboard.wallet ?? ''), runWallet = canonicalMainnetAddress(run?.wallet ?? '');
  const validRun = run && run.scope === 'portfolio' && wallet !== null && wallet === runWallet
    && count(run.total) && run.total === total && count(run.checked) && run.checked <= total
    && [run.updated, run.unresolved, run.status_updated ?? 0, run.status_unresolved ?? 0].every(count)
    && run.updated <= run.checked && run.unresolved <= run.checked
    && run.updated + run.unresolved <= run.checked
    && (run.status_updated ?? 0) <= run.checked && (run.status_unresolved ?? 0) <= run.checked
    && (run.status_updated ?? 0) + (run.status_unresolved ?? 0) <= run.checked
    && start !== null && (run.state === 'running' ? finish === null : finish !== null && finish >= start);
  if (validRun) {
    const complete = run.state === 'complete' && run.checked === total;
    const active = run.state === 'running' && refresh?.phase === 'checking';
    const signature = checkedScopeSignature(groups, wallet);
    const scopeMatches = signature !== null && run.scope_signature === signature;
    const successful = complete && scopeMatches && run.reason === null && refresh?.phase === 'complete' && !refresh?.error;
    const cachedStart = run.check_started_at;
    const originalStart = refresh?.cacheHit
      ? cachedStart !== undefined ? instant(cachedStart, now) : checked === total ? instant(stamps.oldestUpdatedAt, now) : null
      : cachedStart !== undefined ? instant(cachedStart, now) : start;
    const dated = total > 0 && originalStart !== null && originalStart <= start!;
    const current = successful && dated && recent(originalStart, now, ACTIVITY_GIFT_CHECK_MINUTES);
    return { checkStatus: `${complete ? 'Check complete' : active ? 'Checking' : 'Check paused'} · ${run.checked}/${total} checked`,
      checkedAt: refresh?.cacheHit ? stamps.updatedAt : iso(finish) ?? stamps.updatedAt,
      checkPresentation: { tone: current ? 'fresh' as const : 'older' as const,
        status: successful && dated ? current ? 'Checked' : 'Checked earlier'
          : run.state === 'failed' || refresh?.phase === 'unavailable' || refresh?.error ? 'Check failed'
            : complete ? 'Check not confirmed' : active ? 'Checking' : 'Check paused',
        // Completing the full scoped run proves every target was attempted;
        // its original start conservatively dates that check, independently of
        // older retained value/check fields. Cache copies need the source date.
        checkedAt: dated ? iso(originalStart) : null } };
  }
  return { checkStatus: !total || !checked ? null : `${checked === total ? 'Check complete' : 'Check incomplete'} · ${checked}/${total} checked`,
    checkedAt: stamps.updatedAt,
    ...(run?.scope === 'portfolio' ? { checkPresentation: { tone: 'older' as const,
      status: 'Check not confirmed', checkedAt: stamps.oldestUpdatedAt } } : {}) };
}
function giftRow(groups: Gift[][], now: number, kind: 'gifts' | 'prices', updating: boolean,
  dashboard: Dashboard, refresh?: OwnedPriceSnapshot | null): ActivityFreshnessRow {
  const freshnessMinutes = ACTIVITY_FRESHNESS_MINUTES[kind], evidence = groups.map(group => {
    const items = group.map(gift => kind === 'gifts' ? statusEvidence(gift, now) : priceEvidence(gift, now));
    const validTimes = items.map(item => item.time).filter((value): value is number => value !== null);
    // Address aliases count once. Conflicting duplicate rows never establish current status or price.
    const confirmed = items.every(item => item.confirmed) && new Set(items.map(item => item.key)).size === 1;
    const checkTimes = items.map(item => item.checked);
    return { time: validTimes.length ? Math.min(...validTimes) : null, confirmed,
      checked: checkTimes.every((value): value is number => value !== null) ? Math.min(...checkTimes) : null };
  });
  const total = groups.length, saved = evidence.filter(item => item.time !== null).length;
  const confirmed = evidence.filter(item => item.confirmed).length;
  const fresh = evidence.filter(item => item.confirmed && recent(item.time, now, freshnessMinutes)).length;
  const state = total === 0 || saved === 0 ? 'missing' : fresh === total ? 'fresh' : confirmed < total ? 'incomplete' : 'older';
  const noun = kind === 'gifts' ? 'statuses' : 'prices', unavailable = total - confirmed;
  const coveredNoun = kind === 'gifts' ? confirmed === 1 ? 'status' : 'statuses' : confirmed === 1 ? 'price' : 'prices';
  return row({ id: kind, label: kind === 'gifts' ? 'Gifts & rental status' : 'Your rent prices', state,
    ...stampRange(evidence.map(item => item.time)), ...refreshCheck(groups, now, evidence, dashboard, refresh),
    coverage: `${confirmed} ${coveredNoun} ${kind === 'gifts' ? 'confirmed' : 'available'}${unavailable ? ` · ${unavailable} ${kind === 'gifts' ? 'unverified' : 'unavailable'}` : ''}`,
    availabilityWarning: unavailable > 0,
    detail: !total ? 'Discover or import your gifts first.' : `${fresh} of ${total} gifts have current ${noun} observed within ${freshnessMinutes} minutes.`
      + ' A green Checked label means every saved gift was checked within the last hour; it does not confirm every value.'
      + (unavailable ? ' Unverified statuses and unavailable prices keep their warning. Saved older values remain dated; a refresh does not make them current.' : ''),
    freshnessMinutes, updating });
}
function comparisonRow(kind: 'listings' | 'rentals', evidence: ActivityComparisonSourceEvidence | undefined,
  now: number, updating: boolean, pricing: DataRecord | undefined): ActivityFreshnessRow {
  const freshnessMinutes = ACTIVITY_FRESHNESS_MINUTES.comparisons;
  const validCounts = evidence && [evidence.total_collections, evidence.checked_collections, evidence.fresh_collections].every(count)
    && evidence.checked_collections <= evidence.total_collections && evidence.fresh_collections <= evidence.checked_collections
    && typeof evidence.complete === 'boolean' && (evidence.unresolved_collections === undefined || count(evidence.unresolved_collections));
  const total = validCounts ? evidence!.total_collections : null, checked = validCounts ? evidence!.checked_collections : 0;
  const unresolved = validCounts ? evidence!.unresolved_collections ?? 0 : 0;
  const latest = validCounts ? instant(evidence!.freshest_checked_at, now) : null;
  const oldest = validCounts ? instant(evidence!.oldest_checked_at, now) : null;
  const validTimes = checked === 0 ? latest === null && oldest === null : latest !== null && oldest !== null && oldest <= latest;
  const hasWatermarks = kind === 'rentals' && evidence && (Object.hasOwn(evidence, 'oldest_checked_through') || Object.hasOwn(evidence, 'freshest_checked_through'));
  const oldestThrough = hasWatermarks ? instant(evidence!.oldest_checked_through, now) : null;
  const latestThrough = hasWatermarks ? instant(evidence!.freshest_checked_through, now) : null;
  const validWatermarks = !hasWatermarks || (checked === 0 ? oldestThrough === null && latestThrough === null
    : oldestThrough !== null && latestThrough !== null && oldestThrough <= latestThrough && latest !== null && latestThrough <= latest);
  const from = instant(evidence?.window_from, now), to = instant(evidence?.window_to, now);
  const timeframe = TIMEFRAME_OPTIONS.some(option => option.value === evidence?.timeframe);
  const validWindow = from !== null && to !== null && from <= to && to - from <= 90 * 86400000 && timeframe;
  const periodMatches = pricing?.timeframe === undefined || pricing.timeframe === evidence?.timeframe;
  const expectedFrom = instant(pricing?.window_from, now), expectedTo = instant(pricing?.window_to, now);
  const windowMatches = pricing?.window_from === undefined && pricing?.window_to === undefined
    || expectedFrom !== null && expectedTo !== null && from === expectedFrom && to === expectedTo;
  const fitsDisplayed = validWindow && periodMatches && windowMatches;
  const full = validCounts && total !== null && total > 0 && checked === total && unresolved === 0
    && evidence!.complete && validTimes && validWatermarks && fitsDisplayed;
  const movingEndpoint = evidence?.timeframe !== 'custom' || to !== null && new Date(to).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  const fresh = full && evidence!.fresh_collections === total && recent(oldest, now, freshnessMinutes)
    && (!hasWatermarks || !movingEndpoint || recent(oldestThrough, now, freshnessMinutes));
  const state = !validCounts || !validTimes || !validWatermarks || !fitsDisplayed || checked === 0 || total === 0 ? 'missing' : fresh ? 'fresh' : !full ? 'incomplete' : 'older';
  const period = TIMEFRAME_OPTIONS.find(option => option.value === evidence?.timeframe)?.label;
  const periodNote = period ? ` · ${period.toLowerCase()}` : '';
  return row({ id: kind, label: kind === 'listings' ? 'Listing averages' : 'Actual rental averages', state,
    updatedAt: validTimes && validWatermarks && fitsDisplayed ? iso(latest) : null, oldestUpdatedAt: validTimes && validWatermarks && fitsDisplayed ? iso(oldest) : null,
    coverage: total === null || !fitsDisplayed ? 'Coverage not confirmed' : `${checked} of ${total} collections checked${unresolved ? ` · ${unresolved} unresolved` : ''}${periodNote}`,
    detail: (!validCounts || !validTimes || !validWatermarks || !fitsDisplayed ? 'Start a comparison refresh to confirm coverage.' : total === 0 ? 'Discover or import your gifts first.'
      : unresolved ? 'Some gifts have unresolved collection information.'
        : state === 'fresh' ? 'Completed comparison checks from the last hour.' : !full ? 'Some relevant collections still need checking.'
        : 'Comparison data is more than an hour old.')
      + (validWatermarks && fitsDisplayed && oldestThrough !== null ? ` Rental history checked through ${dateTime(iso(oldestThrough)!, true)}.` : ''), freshnessMinutes, updating });
}
function analyticsRows(dashboard: Dashboard, now: number): ActivityFreshnessRow[] {
  const snapshots = [...(dashboard.personal_analytics_snapshots || []), ...(dashboard.personal_analytics ? [dashboard.personal_analytics] : [])];
  const reports = new Map<number, PersonalRentalAnalytics>();
  for (const snapshot of snapshots) {
    if (!snapshot || !Array.isArray(snapshot.daily) || !snapshot.daily.length) continue;
    if (dashboard.wallet && identity(snapshot.wallet) !== identity(dashboard.wallet)) continue;
    const days = snapshot.daily.length, prior = reports.get(days);
    if (!prior || (instant(snapshot.captured_at, now) ?? -1) > (instant(prior.captured_at, now) ?? -1)) reports.set(days, snapshot);
  }
  const days = reports.size ? [...reports.keys()].sort((a, b) => a - b) : [30];
  return days.map(length => {
    const report = reports.get(length) ?? null;
    const captured = instant(report?.captured_at, now);
    const presentation = analyticsFreshnessPresentation(report, length, { now, refreshable: true });
    const state = presentation.tone === 'recent' && captured !== null ? 'fresh' : !report ? 'missing' : 'older';
    const period = length === 365 ? '1 year' : `${length} days`;
    const dates = report && /^\d{4}-\d{2}-\d{2}$/.test(report.period_start) && /^\d{4}-\d{2}-\d{2}$/.test(report.period_end)
      ? ` Report covers ${report.period_start} to ${report.period_end} (UTC).` : '';
    return row({ id: `analytics-${length}`, label: `Analytics · ${period}`, state,
      updatedAt: iso(captured), oldestUpdatedAt: iso(captured), coverage: report ? `${period} report` : 'No saved report',
      detail: (state === 'fresh' ? 'Personal revenue and rental totals refreshed within 15 minutes.'
        : !report ? 'Connect Marketapp and refresh analytics.' : presentation.label === 'Date unavailable'
          ? 'The saved reporting dates need checking.' : 'Refresh to update personal revenue and rental totals.') + dates,
      freshnessMinutes: ACTIVITY_FRESHNESS_MINUTES.analytics, updating: false });
  });
}

/** Source-specific saved evidence only. Loading the dashboard or finishing an unrelated job proves no freshness. */
export function activityFreshnessRows(dashboard: Dashboard, jobs: Job[] = [], options: ActivityFreshnessOptions = {}): ActivityFreshnessRow[] {
  const now = options.now ?? Date.now(), groups = portfolioGroups(dashboard.gifts);
  const active = (kinds: Job['kind'][]) => jobs.some(job => kinds.includes(job.kind) && ['queued', 'running'].includes(job.state)
    && job.progress?.requires_resume !== true && job.progress?.client_interrupted !== true);
  const supplied = options.comparisonEvidence ?? (dashboard as Dashboard & { data_freshness?: ActivityComparisonEvidence }).data_freshness;
  const comparisons = supplied?.version === 1 ? supplied : null;
  return [giftRow(groups, now, 'gifts', active(['refresh', 'discover']), dashboard, options.giftRefresh),
    giftRow(groups, now, 'prices', active(['refresh']), dashboard, options.giftRefresh),
    comparisonRow('listings', comparisons?.listings, now, active(['prices', 'collect']), dashboard.pricing),
    comparisonRow('rentals', comparisons?.rentals, now, active(['rental_prices', 'collect']), dashboard.pricing), ...analyticsRows(dashboard, now)];
}
