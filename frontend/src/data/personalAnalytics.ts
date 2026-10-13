import type { PersonalRentalAnalytics, PersonalRentalAnalyticsAllTime, PersonalRentalAnalyticsReport } from './types.ts';
import { canonicalMainnetAddress, friendlyMainnetAddress } from '../serverless/walletIdentity.ts';

export type AnalyticsGrouping = 'day' | 'week' | 'month' | 'year';
export interface AnalyticsBucket {
  key: string;
  start: string;
  end: string;
  volume: string | null;
  newRentals: number | null;
  extensions: number | null;
  rentals: number | null;
  partial: boolean;
  gap?: boolean;
  coverage?: { observedDays: number; missingDays: number; partialDays: number };
}

const DAY = 86_400_000;
const SCALE = 10_000n;

/** Telegram authenticates imports through its owner SDK; local imports require CSRF. */
export function canImportPersonalAnalytics(cloud: boolean, csrf: string, hasTransport: boolean): boolean {
  return hasTransport && (cloud || Boolean(csrf));
}

/** Only captured windows are selectable; a shorter report is not synthesized from a year. */
export function personalAnalyticsSnapshots(latest?: PersonalRentalAnalytics | null, saved: PersonalRentalAnalytics[] = []): PersonalRentalAnalytics[] {
  const candidates = [...saved, ...(latest ? [latest] : [])].sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const durations = new Set<number>(), fingerprints = new Set<string>();
  return candidates.filter(snapshot => {
    if (durations.has(snapshot.daily.length) || fingerprints.has(snapshot.fingerprint)) return false;
    durations.add(snapshot.daily.length); fingerprints.add(snapshot.fingerprint);
    return true;
  }).slice(0, 8);
}

export function selectPersonalAnalyticsSnapshot(latest: PersonalRentalAnalytics | null | undefined, available: PersonalRentalAnalytics[], fingerprint?: string | null): PersonalRentalAnalytics | null {
  return available.find(snapshot => snapshot.fingerprint === fingerprint)
    || available.find(snapshot => snapshot.fingerprint === latest?.fingerprint)
    || available[0] || null;
}

export function analyticsReportingPeriod(snapshot: PersonalRentalAnalyticsReport): string {
  if ('report_kind' in snapshot && snapshot.report_kind === 'all_time') return 'All time · saved history';
  const days = snapshot.daily.length;
  if (days === 365 || days === 366) return 'Last 1 year';
  if ([7, 14, 30, 60, 90, 180].includes(days)) return `Last ${days} days`;
  return days === 1 ? '1-day snapshot' : `${days}-day snapshot`;
}

export function personalAnalyticsPeriodOptions(snapshots: PersonalRentalAnalytics[]): { fingerprint: string; label: string }[] {
  const labels = snapshots.map(analyticsReportingPeriod);
  return snapshots.map((snapshot, index) => ({ fingerprint: snapshot.fingerprint,
    label: labels.filter(label => label === labels[index]).length > 1
      ? `${labels[index]} · ${analyticsPeriod(snapshot.period_start, snapshot.period_end)}` : labels[index],
  }));
}

function utcDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid analytics date.');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid analytics date.');
  return date;
}

function amount(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match || value.length > 80) throw new Error('Invalid analytics amount.');
  return BigInt(match[1]) * SCALE + BigInt((match[2] || '').padEnd(4, '0'));
}

function decimal(value: bigint): string {
  const text = value.toString().padStart(5, '0');
  return `${text.slice(0, -4)}.${text.slice(-4)}`.replace(/\.?0+$/, '');
}

export function groupPersonalAnalytics(snapshot: PersonalRentalAnalyticsReport, grouping: AnalyticsGrouping): AnalyticsBucket[] {
  if ('report_kind' in snapshot && snapshot.report_kind === 'all_time') return groupSavedAnalyticsHistory(snapshot, grouping);
  const buckets = new Map<string, Omit<AnalyticsBucket, 'newRentals' | 'extensions' | 'rentals'> & { newRentals: number; extensions: number; rentals: number; units: bigint; nominalStart: string; nominalEnd: string }>();
  const captureDay = snapshot.captured_at.slice(0, 10);
  for (const point of [...snapshot.daily].sort((a, b) => a.date.localeCompare(b.date))) {
    const date = utcDate(point.date);
    let first = date, last = date;
    if (grouping === 'week') {
      first = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY);
      last = new Date(first.getTime() + 6 * DAY);
    } else if (grouping === 'month') {
      first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    } else if (grouping === 'year') {
      first = new Date(date.getTime());
      last = new Date(date.getTime());
      first.setUTCMonth(0, 1);
      last.setUTCMonth(11, 31);
    }
    const nominalStart = first.toISOString().slice(0, 10), nominalEnd = last.toISOString().slice(0, 10);
    const bucket = buckets.get(nominalStart) || { key: nominalStart, start: point.date, end: point.date, volume: '0', units: 0n,
      newRentals: 0, extensions: 0, rentals: 0, partial: false, nominalStart, nominalEnd };
    bucket.end = point.date;
    bucket.units += amount(point.rent_volume);
    bucket.newRentals += point.new_rentals;
    bucket.extensions += point.extensions;
    bucket.rentals += point.rentals;
    buckets.set(nominalStart, bucket);
  }
  return [...buckets.values()].map(({ units, nominalStart, nominalEnd, ...bucket }) => ({ ...bucket,
    volume: decimal(units), partial: bucket.start > nominalStart || bucket.end < nominalEnd || (captureDay >= bucket.start && captureDay <= bucket.end) }));
}

/** Calendar gaps remain unknown. Totals in partially covered buckets include only saved days. */
export function groupSavedAnalyticsHistory(snapshot: PersonalRentalAnalyticsAllTime, grouping: AnalyticsGrouping): AnalyticsBucket[] {
  const first = utcDate(snapshot.period_start).getTime(), last = utcDate(snapshot.period_end).getTime();
  const buckets = new Map<string, AnalyticsBucket & { units: bigint; newCount: number; extensionCount: number; rentalCount: number; nominalStart: string; nominalEnd: string }>();
  for (const point of snapshot.daily) {
    const instant = utcDate(point.date).getTime(); if (instant < first || instant > last) continue;
    const { start, end } = historyPeriodBounds(instant, grouping);
    const nominalStart = start.toISOString().slice(0, 10), nominalEnd = end.toISOString().slice(0, 10);
    const bucket = buckets.get(nominalStart) ?? { key: nominalStart, start: new Date(Math.max(first, start.getTime())).toISOString().slice(0, 10),
      end: new Date(Math.min(last, end.getTime())).toISOString().slice(0, 10), volume: null, newRentals: null,
      extensions: null, rentals: null, partial: false, units: 0n, newCount: 0, extensionCount: 0, rentalCount: 0,
      nominalStart, nominalEnd, coverage: { observedDays: 0, missingDays: 0, partialDays: 0 } };
    bucket.units += amount(point.rent_volume); bucket.newCount += point.new_rentals;
    bucket.extensionCount += point.extensions; bucket.rentalCount += point.rentals;
    bucket.coverage!.observedDays++; if (point.partial) bucket.coverage!.partialDays++;
    buckets.set(nominalStart, bucket);
  }
  const result: AnalyticsBucket[] = [];
  let next = first;
  const gap = (from: number, to: number) => {
    if (to < from) return;
    const start = new Date(from).toISOString().slice(0, 10), end = new Date(to).toISOString().slice(0, 10);
    result.push({ key: `gap:${start}`, start, end, volume: null, newRentals: null, extensions: null, rentals: null, gap: true, partial: true,
      coverage: { observedDays: 0, missingDays: (to - from) / DAY + 1, partialDays: 0 } });
  };
  for (const { units, newCount, extensionCount, rentalCount, nominalStart, nominalEnd, ...bucket } of [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const from = utcDate(bucket.start).getTime(), to = utcDate(bucket.end).getTime();
    gap(next, from - DAY);
    bucket.coverage!.missingDays = (to - from) / DAY + 1 - bucket.coverage!.observedDays;
    result.push({ ...bucket, volume: decimal(units), newRentals: newCount, extensions: extensionCount, rentals: rentalCount, gap: false,
      partial: bucket.coverage!.missingDays > 0 || bucket.coverage!.partialDays > 0 || bucket.start > nominalStart || bucket.end < nominalEnd });
    next = to + DAY;
  }
  gap(next, last);
  return result;
}

function historyPeriodBounds(instant: number, grouping: AnalyticsGrouping): { start: Date; end: Date } {
  const date = new Date(instant), start = new Date(instant), end = new Date(instant);
  if (grouping === 'week') {
    start.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); end.setTime(start.getTime() + 6 * DAY);
  } else if (grouping === 'month') {
    start.setUTCDate(1); end.setUTCMonth(date.getUTCMonth() + 1, 0);
  } else if (grouping === 'year') {
    start.setUTCMonth(0, 1); end.setUTCMonth(11, 31);
  }
  return { start, end };
}

/** Keep chart and table rendering bounded by coarsening dense saved histories. Gaps are single intervals. */
export function analyticsHistoryGrouping(snapshot: PersonalRentalAnalyticsReport | null, requested: AnalyticsGrouping, maximum = 736): AnalyticsGrouping {
  if (!snapshot || !('report_kind' in snapshot) || snapshot.daily.length <= maximum / 2) return requested;
  const groups: AnalyticsGrouping[] = ['day', 'week', 'month', 'year'];
  for (const group of groups.slice(groups.indexOf(requested))) {
    const keys = new Set(snapshot.daily.map(point => historyPeriodBounds(utcDate(point.date).getTime(), group).start.getTime()));
    const ordered = [...keys].sort((a, b) => a - b);
    let count = ordered.length;
    for (let index = 1; index < ordered.length; index++) if (historyPeriodBounds(ordered[index - 1], group).end.getTime() + DAY < ordered[index]) count++;
    if (count <= maximum || group === 'year') return group;
  }
  return 'year';
}

// Integer ratios are used only for chart geometry; money remains decimal text.
export function analyticsBarHeights(buckets: AnalyticsBucket[]): number[] {
  const values = buckets.map(bucket => bucket.volume === null ? 0n : amount(bucket.volume));
  const maximum = values.reduce((max, value) => value > max ? value : max, 0n);
  return values.map(value => maximum ? Number(value * 1000n / maximum) / 10 : 0);
}

export function personalAnalyticsUrl(wallet: string | null, snapshot?: PersonalRentalAnalyticsReport | null): string {
  const query = (period?: string | null) => {
    const params = new URLSearchParams({ tab: 'analytics_rent', group_by: 'day' });
    if (period && /^last(7|14|30|60|90|180|365)days$/.test(period)) params.set('period_by', period);
    return params.toString();
  };
  if (snapshot?.source_url) {
    try {
      const url = new URL(snapshot.source_url);
      const address = /^\/user\/([A-Za-z0-9_-]{48})\/$/.exec(url.pathname)?.[1];
      if (url.origin === 'https://marketapp.org' && !url.username && !url.password && address && canonicalMainnetAddress(address)) {
        return `${url.origin}${url.pathname}?${query(url.searchParams.get('period_by'))}`;
      }
    } catch { /* Only the fixed Marketapp origin is linked below. */ }
  }
  const friendly = friendlyMainnetAddress(wallet);
  if (!friendly) return 'https://marketapp.org/';
  return `https://marketapp.org/user/${friendly}/?${query(snapshot && 'report_kind' in snapshot ? 'last365days' : undefined)}`;
}

export function analyticsDate(value: string): string {
  return utcDate(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function analyticsPeriod(start: string, end: string): string {
  const full = (value: string) => utcDate(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (start === end) return full(start);
  return start.slice(0, 4) === end.slice(0, 4) ? `${analyticsDate(start)}–${full(end)}` : `${full(start)}–${full(end)}`;
}
