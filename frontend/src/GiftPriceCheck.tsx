import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Gift } from './data/types';
import type { OwnedPriceRefreshDriver } from './data/ownedPriceRefresh';
import { quickGiftCheckBlocker, quickGiftCheckFeedback } from './data/quickGiftCheck';
import { Icon } from './Icons';
import './giftPriceCheck.css';

export function GiftPriceCheck({ gift, driver, onCheck, disabledReason }: {
  gift: Gift; driver: OwnedPriceRefreshDriver; onCheck: (nft: string) => Promise<void>; disabledReason?: string;
}) {
  const status = useSyncExternalStore(driver.subscribe, driver.getSnapshot);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const recommendation = gift.pricing?.recommended_price_per_day;
  useEffect(() => { setAttempted(false); setFailure(null); }, [gift.id, recommendation]);
  const blocker = disabledReason || quickGiftCheckBlocker(gift) || (status.canRefresh === false ? 'Another gift check is still finishing. Try again when it finishes.' : null);
  const message = attempted ? failure || (pending ? 'Checking this gift…' : quickGiftCheckFeedback(gift, status)) : null;
  return <div className="quick-gift-check">
    <button type="button" className="button secondary" disabled={pending || Boolean(blocker)} title={blocker || 'Check only this gift’s configured TON price and rental status'} onClick={async () => {
      if (blocker || pending) return;
      setAttempted(true); setPending(true); setFailure(null);
      try { await onCheck(gift.nft_address); }
      catch { setFailure('Another gift check may still be finishing. Try again when it finishes.'); }
      finally { setPending(false); }
    }}><Icon name="refresh" size={17} className={pending ? 'spinning' : ''} />{pending ? 'Checking…' : 'Check this gift'}</button>
    {message && <p role="status" aria-live="polite">{message}</p>}
  </div>;
}
