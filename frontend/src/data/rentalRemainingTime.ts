export interface RentalRemainingTime {
  label: string;
  /** First millisecond at which the visible label or rental mark changes. */
  nextUpdateAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_DISPLAY_DAYS = 99;

/** Format a verified expiry in milliseconds; unknown or expired evidence stays absent. */
export function rentalRemainingTime(expiresAt: number | null, now = Date.now()): RentalRemainingTime | null {
  if (expiresAt == null || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8_640_000_000_000_000
    || !Number.isSafeInteger(now) || now < 0) return null;

  const remaining = expiresAt - now;
  if (remaining <= 0) return null;

  if (remaining > MAX_DISPLAY_DAYS * DAY) {
    return { label: '99d+', nextUpdateAt: expiresAt - MAX_DISPLAY_DAYS * DAY };
  }
  if (remaining < MINUTE) return { label: '<1m', nextUpdateAt: expiresAt };

  const unit = remaining >= DAY ? HOUR : MINUTE;
  const wholeUnits = Math.floor(remaining / unit);
  // Displayed units are floored. At an exact boundary the label changes in the
  // next millisecond; otherwise it stays unchanged until that same boundary.
  const nextUpdateAt = expiresAt - wholeUnits * unit + 1;
  if (remaining >= DAY) {
    return { label: `${Math.floor(wholeUnits / 24)}d${wholeUnits % 24}h`, nextUpdateAt };
  }
  if (remaining >= HOUR) {
    return { label: `${Math.floor(wholeUnits / 60)}h${wholeUnits % 60}m`, nextUpdateAt };
  }
  return { label: `${wholeUnits}m`, nextUpdateAt };
}
