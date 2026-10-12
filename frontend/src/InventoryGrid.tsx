import type { ReactNode } from 'react';
import type { Gift } from './data/types';
import { dateTime, formatAmount, giftGroup, hasRecommendation } from './data/helpers';
import './inventoryGrid.css';
import { QuickPriceActions, RecommendedPrice } from './QuickPriceActions';

const STATE_LABELS = {
  for_rent: 'For rent', rented: 'Rented', direct: 'In wallet', idle: 'Idle contract',
  sale: 'For sale', review: 'Needs review',
};

function askingPriceUnit(gift: Gift): string {
  const unit = gift.price_unit?.trim();
  return unit ? unit.includes('/') ? unit : `${unit}/day` : 'Unit unknown';
}

export function InventoryGrid({ gifts, onSelect, renderImage, quickActions = false }: {
  gifts: Gift[];
  onSelect: (gift: Gift) => void;
  renderImage: (gift: Gift) => ReactNode;
  quickActions?: boolean;
}) {
  return <div className="inventory-gift-grid">{gifts.map(gift => {
    const state = giftGroup(gift);
    const stateLabel = gift.display_state || STATE_LABELS[state];
    const currentUnit = askingPriceUnit(gift);
    const recommended = hasRecommendation(gift);
    const prices = <span className="inventory-card-prices">
      <span title={gift.price_per_day == null ? 'No asking price saved' : `${gift.price_is_historical ? 'Saved asking price' : 'Observed asking price'} · ${dateTime(gift.price_observed_at, true)}`}>
        <span>{gift.price_is_historical ? 'Saved' : 'Current'}</span><strong>{formatAmount(gift.price_per_day)}</strong>
        {(gift.price_per_day == null || currentUnit !== 'GRAM/day' || gift.price_is_historical) && <small className={gift.price_is_historical ? 'historical' : ''}>{gift.price_per_day == null ? 'Not observed' : currentUnit !== 'GRAM/day' ? currentUnit : 'Previous observation'}</small>}
      </span>
      <span className={`inventory-card-recommendation${recommended ? ' ready' : ''}`} title={recommended ? 'Recommended daily price; comparison evidence is in gift details' : 'No daily recommendation available'}>
        <span>Recommended</span><RecommendedPrice gift={gift} enabled={quickActions}><strong>{formatAmount(recommended ? gift.pricing?.recommended_price_per_day : null)}</strong></RecommendedPrice>
        {!recommended && <small>{gift.pricing?.daily_comparable === false ? 'Daily rate unverified' : 'No estimate'}</small>}
      </span>
    </span>;
    return <article className={`inventory-gift-card${quickActions && gift.is_portfolio ? ' quick-actions' : ''}`} key={gift.id}><button type="button" className="inventory-gift-card-main" aria-label={`View details for ${gift.name || 'gift'}`} onClick={() => onSelect(gift)}>
      <div className="inventory-card-image">{renderImage(gift)}</div>
      <strong className="inventory-card-name">{gift.name || 'Unnamed gift'}</strong>
      <span className="inventory-card-statuses">
        <span className={`inventory-card-status ${state}`} title={`Saved status · ${dateTime(gift.status_observed_at ?? gift.observed_at, true)}`}><i aria-hidden="true" />{gift.status_is_historical && 'Saved · '}{stateLabel}</span>
        {!gift.is_portfolio && <span className="inventory-card-candidate" title="Candidate · ownership unverified">Candidate</span>}
      </span>
      {!quickActions && prices}
      <span className="sr-only">Open gift details</span>
    </button>{quickActions && prices}<QuickPriceActions gift={gift} enabled={quickActions} /></article>;
  })}</div>;
}
