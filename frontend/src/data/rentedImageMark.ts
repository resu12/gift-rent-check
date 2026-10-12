import type { Gift } from './types.ts';
import { giftGroup } from './helpers.ts';

export interface RentedImageMark { expiresAt: number | null }

/** Image marks describe a supported saved rental state, never listing visibility. */
export function rentedImageMark(gift: Gift, now = Date.now()): RentedImageMark | null {
  if (!gift.is_portfolio || gift.category !== 'portfolio' || gift.status_is_historical === true || gift.collection_conflict === true || gift.state !== 'rented' || giftGroup(gift) !== 'rented') return null;

  let expiresAt: number | null = null;
  if (gift.rental_until_unix_seconds != null) {
    const raw = gift.rental_until_unix_seconds;
    const seconds = typeof raw === 'number' ? raw : /^\d+$/.test(raw) ? Number(raw) : NaN;
    // Explicit seconds must remain representable and valid; malformed expiry is
    // insufficient evidence for a current-rental mark.
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000) return null;
    expiresAt = seconds * 1000;
  } else if (typeof gift.rental_until === 'string' && /T/.test(gift.rental_until)) {
    expiresAt = Date.parse(gift.rental_until);
    if (!Number.isFinite(expiresAt)) return null;
  }
  // Legacy raw duration/timestamp numbers have unspecified units. Only the
  // explicit seconds field or an ISO timestamp can establish expiration here.
  if (expiresAt != null && expiresAt <= now) return null;
  return { expiresAt };
}
