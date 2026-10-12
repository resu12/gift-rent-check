import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
import type { Gift } from './data/types';
import { copyRecommendedPrice, quickPriceState } from './data/quickPriceActions';
import { telegramBridge } from './data/telegram';
import { formatAmount, hasRecommendation } from './data/helpers';
import './quickPriceActions.css';

/** Tapping a recommendation copies its exact displayed price; no saved price is changed. */
export function RecommendedPrice({ gift, enabled = false, children }: {
  gift: Gift; enabled?: boolean; children?: ReactNode;
}) {
  const action = quickPriceState(gift);
  const context = JSON.stringify([enabled, gift.id, gift.nft_address, action.price, gift.pricing?.source, gift.pricing?.timeframe,
    gift.pricing?.date_from, gift.pricing?.date_to, gift.pricing?.backdrop]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const operation = useRef(0);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const number = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    operation.current++;
    setCopied(false); setCopying(false); setManual(null);
    return () => { operation.current++; };
  }, [context]);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  useEffect(() => {
    if (manual && dialog.current && !dialog.current.open) {
      dialog.current.showModal(); number.current?.focus(); number.current?.select();
    }
  }, [manual]);

  const copy = async () => {
    if (!action.price) return;
    const token = ++operation.current, originalContext = context, price = action.price;
    setCopying(true); setCopied(false);
    const success = await copyRecommendedPrice(price, navigator.clipboard);
    if (token !== operation.current || currentContext.current !== originalContext) return;
    if (success) setCopied(true); else setManual(price);
    setCopying(false);
  };

  const content = children ?? <strong>{formatAmount(hasRecommendation(gift) ? gift.pricing?.recommended_price_per_day : null)}</strong>;
  if (!enabled || !action.eligible || !action.price) return <>{content}</>;
  const copyLabel = `Copy recommended price for ${gift.name || 'gift'}`;
  return <>
    <button ref={button} type="button" className="recommended-price-copy" aria-label={copyLabel} title={`Tap to copy ${action.price}`}
      disabled={copying} onClick={event => { event.stopPropagation(); void copy(); }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>{content}</button>
    {copied && createPortal(<span className="quick-price-toast" role="status">{action.price} copied</span>, button.current?.closest('dialog[open]') || document.body)}
    {manual && createPortal(<dialog ref={dialog} className="quick-price-copy-dialog" aria-label="Copy recommended price" onClose={event => { event.stopPropagation(); setManual(null); }} onCancel={event => { event.stopPropagation(); setManual(null); }}>
      <div className="quick-price-copy-heading"><strong>Copy recommended price</strong><button type="button" className="icon-button" aria-label="Close price copy" onClick={() => dialog.current?.close()}><Icon name="close" size={20} /></button></div>
      <p>Hold the selected number and choose Copy.</p>
      <input ref={number} type="text" aria-label="Recommended price to copy" value={manual} readOnly onFocus={event => event.target.select()} />
    </dialog>, document.body)}
  </>;
}

/** Opening Marketapp is separate from copying and never submits a change. */
export function QuickPriceActions({ gift, enabled = false, labelled = false }: {
  gift: Gift; enabled?: boolean; labelled?: boolean;
}) {
  const action = quickPriceState(gift);
  if (!enabled || !action.eligible) return null;
  const openLabel = 'Open gift on Marketapp';
  return <>
    <div className={`quick-price-actions${labelled ? ' labelled' : ' compact'}`} role="group" aria-label={`Price actions for ${gift.name || 'gift'}`}>
      {action.url ? <a className={labelled ? 'button secondary' : 'quick-price-icon'} href={action.url} target="_blank" rel="noopener noreferrer"
        aria-label={openLabel} title={openLabel} onClick={event => { event.stopPropagation(); if (telegramBridge.openLink(action.url!)) event.preventDefault(); }}>
        <Icon name="external" size={16} />{labelled && 'Open Marketapp'}
      </a> : <button type="button" className={labelled ? 'button secondary' : 'quick-price-icon'} aria-label={openLabel} title={action.openReason || openLabel} disabled>
        <Icon name="external" size={16} />{labelled && 'Open Marketapp'}
      </button>}
    </div>
    {labelled && action.rangeWarning && <p className="quick-price-range-warning">{action.rangeWarning}</p>}
  </>;
}
