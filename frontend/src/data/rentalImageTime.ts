import type { Gift } from './types.ts';
import { rentedImageMark } from './rentedImageMark.ts';
import { rentalRemainingTime } from './rentalRemainingTime.ts';

export interface RentalImageTime {
  label: string;
  nextUpdateAt: number | null;
  kind: 'exact' | 'approximate';
  checkRequired: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function observedInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  // Date.parse normalizes invalid calendar dates such as 30 February.
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) return null;
  const observedAt = Date.parse(value);
  return Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : null;
}

/** Deduct elapsed time from a rounded label without creating an expiry. */
export function approximateRentalRemainingTime(display: unknown, observed: unknown, now = Date.now()): RentalImageTime | null {
  if (typeof display !== 'string' || display.length > 64 || !Number.isSafeInteger(now) || now < 0) return null;
  const observedAt = observedInstant(observed);
  if (observedAt === null || observedAt > now) return null;
  // Only compact, descending d/h/m units are supported. Bare numbers and
  // other website text cannot establish a duration or current rental state.
  const match = /^(?:([0-9]{1,3}) *d *)?(?:([0-9]{1,3}) *h *)?(?:([0-9]{1,3}) *m *)?$/.exec(display.trim());
  if (!match || match.slice(1).every(value => value === undefined)) return null;
  const days = Number(match[1] ?? 0), hours = Number(match[2] ?? 0), minutes = Number(match[3] ?? 0);
  if (days > 365 || (match[1] !== undefined && hours >= 24) || ((match[1] !== undefined || match[2] !== undefined) && minutes >= 60)) return null;
  const duration = days * DAY + hours * HOUR + minutes * MINUTE;
  if (duration > 366 * DAY) return null;
  const elapsed = now - observedAt;
  if (elapsed >= duration) return { label: 'Check time', nextUpdateAt: null, kind: 'approximate', checkRequired: true };
  const unit = match[3] !== undefined ? MINUTE : match[2] !== undefined ? HOUR : DAY;
  const remaining = duration - elapsed, wholeUnits = Math.floor(remaining / unit);
  // Retain the website's lowest supplied unit. An hours-only observation must
  // not acquire misleading minute precision as its local estimate decreases.
  let label: string;
  if (!wholeUnits) label = `<1${unit === DAY ? 'd' : unit === HOUR ? 'h' : 'm'}`;
  else if (unit === DAY) label = `${wholeUnits}d`;
  else if (unit === HOUR) label = wholeUnits >= 24 ? `${Math.floor(wholeUnits / 24)}d${wholeUnits % 24}h` : `${wholeUnits}h`;
  else if (wholeUnits >= 24 * 60) label = `${Math.floor(wholeUnits / (24 * 60))}d${Math.floor(wholeUnits / 60) % 24}h${wholeUnits % 60}m`;
  else label = wholeUnits >= 60 ? `${Math.floor(wholeUnits / 60)}h${wholeUnits % 60}m` : `${wholeUnits}m`;
  const nextUpdateAt = observedAt + duration - wholeUnits * unit + (wholeUnits ? 1 : 0);
  return { label: `≈${label}`, nextUpdateAt, kind: 'approximate', checkRequired: false };
}

/** Current rented evidence gates both exact and approximate image labels. */
export function rentalImageTime(gift: Gift, now = Date.now()): RentalImageTime | null {
  const mark = rentedImageMark(gift, now);
  if (!mark) return null;
  if (mark.expiresAt !== null) {
    const exact = rentalRemainingTime(mark.expiresAt, now);
    return exact ? { ...exact, kind: 'exact', checkRequired: false } : null;
  }
  return approximateRentalRemainingTime(gift.rental_remaining_display, gift.rental_remaining_observed_at, now);
}
