import type { PersonalRentalAnalytics } from './types.ts';
import { canonicalMainnetAddress } from '../serverless/walletIdentity.ts';

export type AnalyticsGrouping = 'day' | 'week' | 'month' | 'year';
export interface AnalyticsBucket {
  key: string;
  start: string;
  end: string;
  volume: string;
  newRentals: number;
  extensions: number;
  rentals: number;
  partial: boolean;
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

export function analyticsReportingPeriod(snapshot: PersonalRentalAnalytics): string {
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

export function groupPersonalAnalytics(snapshot: PersonalRentalAnalytics, grouping: AnalyticsGrouping): AnalyticsBucket[] {
  const buckets = new Map<string, AnalyticsBucket & { units: bigint; nominalStart: string; nominalEnd: string }>();
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

// Integer ratios are used only for chart geometry; money remains decimal text.
export function analyticsBarHeights(buckets: AnalyticsBucket[]): number[] {
  const values = buckets.map(bucket => amount(bucket.volume));
  const maximum = values.reduce((max, value) => value > max ? value : max, 0n);
  return values.map(value => maximum ? Number(value * 1000n / maximum) / 10 : 0);
}

export function personalAnalyticsUrl(wallet: string | null, snapshot?: PersonalRentalAnalytics | null): string {
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
  const raw = canonicalMainnetAddress(wallet);
  if (!raw) return 'https://marketapp.org/';
  const [workchain, hash] = raw.split(':');
  const bytes = Uint8Array.from([0x11, Number(workchain) & 255, ...hash.match(/../g)!.map(byte => Number.parseInt(byte, 16))]);
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  const friendly = btoa(String.fromCharCode(...bytes, crc >> 8, crc & 255)).replace(/\+/g, '-').replace(/\//g, '_');
  return `https://marketapp.org/user/${friendly}/?${query()}`;
}

export function analyticsDate(value: string): string {
  return utcDate(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function analyticsPeriod(start: string, end: string): string {
  const full = (value: string) => utcDate(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (start === end) return full(start);
  return start.slice(0, 4) === end.slice(0, 4) ? `${analyticsDate(start)}–${full(end)}` : `${full(start)}–${full(end)}`;
}
