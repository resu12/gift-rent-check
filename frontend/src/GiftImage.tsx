import { useEffect, useState } from 'react';
import { Icon } from './Icons';
import type { Gift } from './data/types';
import { dateTime, safeExternalUrl } from './data/helpers';
import { rentedImageMark } from './data/rentedImageMark';
import { rentalImageTime } from './data/rentalImageTime';
import './giftImage.css';

export function GiftImage({ gift, large = false }: { gift: Gift; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => setFailed(false), [gift.image_url]);
  const url = safeExternalUrl(gift.image_url);
  const currentNow = Math.max(now, Date.now());
  const rentalMark = rentedImageMark(gift, currentNow);
  const expiresAt = rentalMark?.expiresAt ?? null;
  const remaining = rentalImageTime(gift, currentNow);
  const nextUpdateAt = remaining?.nextUpdateAt ?? expiresAt;
  const rentalLabel = remaining?.checkRequired ? 'Rented · time estimate elapsed; refresh rental status to confirm'
    : remaining?.kind === 'approximate' ? `Rented · approximately ${remaining.label.slice(1)} remaining`
      : remaining ? `Rented · ${remaining.label} remaining` : 'Rented · remaining time unavailable';
  const rentalTitle = remaining?.kind === 'approximate'
    ? `${remaining.checkRequired ? 'Saved time estimate elapsed' : `Approximate remaining time: ${remaining.label.slice(1)}`} · Marketapp observed ${dateTime(gift.rental_remaining_observed_at)} · refresh rental status to confirm`
    : expiresAt == null ? 'Rented · remaining time unavailable; refresh rental status to check'
      : `Rented · ends ${dateTime(expiresAt / 1000)} · latest saved contract status`;
  useEffect(() => {
    if (nextUpdateAt == null) return;
    // Count down from saved expiry without provider requests. A hidden page
    // catches up on return rather than ticking in the background.
    const timeout = setTimeout(() => { if (!document.hidden) setNow(Date.now()); }, Math.min(Math.max(nextUpdateAt - Date.now(), 1), 2_147_483_647));
    const visible = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timeout); document.removeEventListener('visibilitychange', visible); };
  }, [nextUpdateAt, now]);
  return <div className={`gift-image ${large ? 'large' : ''}`}>
    {url && !failed
      ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span className="gift-placeholder" aria-label="No gift image"><Icon name="gift" size={large ? 56 : 23} />{large && <span>No image available</span>}</span>}
    {rentalMark && <span className={`gift-rented-mark${remaining ? ' has-time' : ''}`} role="img"
      aria-label={rentalLabel}
      title={rentalTitle}>
      <Icon name="clock" size={14} />{remaining && <span className="gift-rented-time">{remaining.label}</span>}
    </span>}
  </div>;
}
