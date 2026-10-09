import { useEffect, useMemo, useState } from 'react';

import type { ReactNode } from 'react';

import { Icon } from './Icons';

import type { Dashboard, Gift, PriceCohort, PricingBasis, PricingSelection, PricingTimeframe } from './data/types';

import { dateTime, filterPricingGifts, formatAmount, formatPriceDifference, hasRecommendation, humanize, isExactBlack, priceDifference, relativeTime, shorten, sortPricingGifts } from './data/helpers';

import type { PricingFilter, PricingFilters, PricingSort } from './data/helpers';

import { dateRangeError, pricingQuery, selectTimeframe, sourceDefaults, timeframeLabel, TIMEFRAME_OPTIONS, validDateRange } from './data/pricingSelection';
import { useProgressiveList } from './useProgressiveList';
import { ListFooter } from './ListFooter';
import { RentalCount } from './RentalCount';
import { comparisonMatch, sampleSize } from './data/pricingEvidence';



const PAGE_SIZE = 15;

export type PricingViewMode = 'grid' | 'detailed';

const COHORTS: { key: PricingBasis; label: string; shortLabel: string }[] = [

  { key: 'collection', label: 'Collection average', shortLabel: 'Collection' },

  { key: 'model', label: 'Exact model average', shortLabel: 'Exact model' },

  { key: 'model_black', label: 'Same model + Black', shortLabel: 'Model + Black' },

];

function cohortsFor(selection: PricingSelection) {
  return selection.backdrop === 'Black' ? [
    { key: 'collection' as const, label: 'Collection + Black average', shortLabel: 'Collection + Black' },
    { key: 'model' as const, label: 'Exact model + Black', shortLabel: 'Exact model + Black' },
  ] : COHORTS;
}

const FILTERS: { key: PricingFilter; label: string }[] = [

  { key: 'all', label: 'All portfolio gifts' }, { key: 'ready', label: 'Recommendations ready' },

  { key: 'missing', label: 'No daily suggestion' }, { key: 'black', label: 'Black backdrop' },

];



export function PricingControls({ selection, onChange, loading, compact = false }: { selection: PricingSelection; onChange: (next: PricingSelection) => void; loading: boolean; compact?: boolean }) {

  const today = new Date().toISOString().slice(0, 10);

  const [from, setFrom] = useState(selection.dateFrom || today);

  const [to, setTo] = useState(selection.dateTo || today);

  useEffect(() => { if (selection.dateFrom) setFrom(selection.dateFrom); if (selection.dateTo) setTo(selection.dateTo); }, [selection.dateFrom, selection.dateTo]);

  const pending = selection.timeframe === 'custom' && (from !== selection.dateFrom || to !== selection.dateTo);

  return <section className={`pricing-controls${compact ? ' compact' : ''}`} aria-label="Pricing data selection">

    <div className="pricing-source-control"><span className="control-label">Price source</span><div className="pricing-source-tabs" role="group" aria-label="Price source">

      <button className={selection.source === 'listings' ? 'active' : ''} aria-pressed={selection.source === 'listings'} onClick={() => { if (selection.source !== 'listings') onChange(sourceDefaults('listings', selection.backdrop)); }}><Icon name="layers" size={16} />Listing prices</button>

      <button className={selection.source === 'rentals' ? 'active' : ''} aria-pressed={selection.source === 'rentals'} onClick={() => { if (selection.source !== 'rentals') onChange(sourceDefaults('rentals', selection.backdrop)); }}><Icon name="clock" size={16} />Actual rentals</button>

    </div></div>

    <label className="pricing-timeframe"><span className="control-label">Timeframe</span><select aria-label="Pricing timeframe" value={selection.timeframe} onChange={event => {

      const timeframe = event.target.value as PricingTimeframe;

      onChange(selectTimeframe(selection, timeframe, today));

    }}>{TIMEFRAME_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>

    {selection.timeframe === 'custom' && <form className="pricing-custom-dates" onSubmit={event => { event.preventDefault(); if (validDateRange(from, to)) onChange({ ...selection, dateFrom: from, dateTo: to }); }}>

      <label><span className="control-label">From (UTC)</span><input type="date" aria-label="Pricing start date" value={from} onChange={event => setFrom(event.target.value)} required /></label>

      <label><span className="control-label">Through (UTC)</span><input type="date" aria-label="Pricing end date" value={to} onChange={event => setTo(event.target.value)} required /></label>

      <button className="button secondary" type="submit" disabled={!pending || !validDateRange(from, to)}>Apply dates</button>

      {pending && <p className="custom-date-hint">{dateRangeError(from, to) || 'Date changes are not applied yet.'}</p>}

    </form>}

    {compact ? <span className="sr-only" aria-live="polite">{loading ? 'Loading' : 'Showing'} {selection.source === 'rentals' ? 'actual rentals' : 'listing prices'} · {timeframeLabel(selection)}{selection.backdrop ? ' · Exact Black backdrop only' : ''}</span> : <p className="pricing-selection-caption" aria-live="polite">{loading ? 'Loading' : 'Showing'} {selection.source === 'rentals' ? 'actual rentals' : 'listing prices'} · {timeframeLabel(selection)}{selection.backdrop ? ' · Exact Black only' : ''}</p>}

  </section>;

}



function PriceValue({ value, compact = false, unit = 'GRAM/day' }: { value: string | null | undefined; compact?: boolean; unit?: string }) {

  const [currency, ...period] = unit.split('/');
  const suffix = period.length ? `/ ${period.join('/') === 'rental record' ? 'record' : period.join('/')}` : '';

  return <span className={`comparison-price ${compact ? 'compact' : ''}${unit !== 'GRAM/day' ? ' explicit-unit' : ''}`} title={value == null ? 'No price observation' : `${formatAmount(value)} ${unit}`}>

    <strong>{formatAmount(value)}</strong>{value != null && <small>{currency}<span>{suffix}</span></small>}

  </span>;

}



function askingPriceUnit(gift: Gift): string {
  const unit = gift.price_unit?.trim();
  return unit ? unit.includes('/') ? unit : `${unit}/day` : 'Unit unknown';
}

function CohortAverage({ cohort, rentals, unit }: { cohort?: PriceCohort; rentals: boolean; unit: string }) {

  if (!cohort || cohort.mean == null || cohort.sample_count === 0) return <div className="cohort-empty"><strong>—</strong><small>No eligible {rentals ? 'records' : 'gifts'}</small></div>;

  const noun = rentals ? (cohort.sample_count === 1 ? 'record' : 'records') : (cohort.sample_count === 1 ? 'gift' : 'gifts');
  const sample = sampleSize(cohort, rentals ? 'rentals' : 'listings');
  return <div className="cohort-average"><PriceValue value={cohort.mean} compact unit={unit} /><span className="sample-count">{cohort.sample_count} {noun}{rentals && cohort.distinct_nft_count != null && <> · {cohort.distinct_nft_count} {cohort.distinct_nft_count === 1 ? 'gift' : 'gifts'}</>}<span className={`sample-size sample-${sample.level}`} title={sample.explanation}>{sample.label}</span></span></div>;
}



function RecommendationEvidence({ gift, selection, compact = false }: { gift: Gift; selection: PricingSelection; compact?: boolean }) {
  const pricing = gift.pricing;
  const sample = sampleSize(pricing?.basis ? pricing[pricing.basis] : undefined, selection.source);
  const match = comparisonMatch(pricing?.basis, selection.backdrop);
  if (compact) {
    const count = sample.distinctGifts;
    const shortMatch = match.label === 'Collection estimate' ? 'Collection' : match.label === 'Same model' ? 'Model' : match.label;
    return <span className="grid-recommendation-evidence" aria-label={`${sample.label}. ${sample.explanation} ${match.explanation}`} title={`${sample.label} · ${match.label}. ${sample.explanation}`}>
      <span className={`sample-size sample-${sample.level}`}>{count == null ? 'Sample unknown' : `${count.toLocaleString()} ${count === 1 ? 'gift' : 'gifts'}`}</span><span className="evidence-separator" aria-hidden="true">·</span><span>{shortMatch}</span>
    </span>;
  }
  return <span className="recommendation-evidence"><span className={`sample-size sample-${sample.level}`} title={sample.explanation}>{sample.label}</span><span className="comparison-match" title={match.explanation}>{match.label}</span></span>;
}


function Recommendation({ gift, selection }: { gift: Gift; selection: PricingSelection }) {

  if (gift.pricing?.daily_comparable === false) return <div className="recommendation-missing"><span>Daily rate unverified</span><small>Record amounts cannot establish a daily price</small></div>;

  if (!hasRecommendation(gift)) return <div className="recommendation-missing"><span>No daily suggestion</span><small>No suitable comparison yet</small></div>;

  const difference = priceDifference(gift);
  return <div className="recommendation-ready"><PriceValue value={gift.pricing!.recommended_price_per_day} compact /><RecommendationEvidence gift={gift} selection={selection} /><small className="price-difference">{difference == null ? 'Difference unavailable' : <>Change: <strong>{formatPriceDifference(difference)}</strong> GRAM/day</>}</small></div>;

}



export function PricingDetails({ gift, selection }: { gift: Gift; selection: PricingSelection }) {
  const pricing = gift.pricing;
  const cohorts = cohortsFor(selection);
  const blackOnly = selection.backdrop === 'Black';
  const rentals = selection.source === 'rentals';
  const unit = pricing?.unit || (rentals ? 'GRAM/rental record' : 'GRAM/day');
  const warnings = [...new Set([...(gift.trait_uncertainties || []), ...(pricing?.warnings || [])])];
  const evidence = sampleSize(pricing?.basis ? pricing[pricing.basis] : undefined, selection.source);
  const match = comparisonMatch(pricing?.basis, selection.backdrop);

  return <section className="detail-section pricing-detail"><div className="pricing-detail-heading"><h3><Icon name="pricing" size={17} />Price comparison</h3><span>{gift.price_per_day != null && askingPriceUnit(gift) !== 'GRAM/day' ? 'Suggested: GRAM / day' : 'GRAM / day'}</span></div><p className="pricing-detail-selection">{rentals ? 'Actual rentals' : 'Listing prices'} · {timeframeLabel(selection)}{blackOnly ? ' · Exact Black only' : ''}</p>
    <div className="detail-price-comparison">
      <div className="detail-current-price"><span>{gift.price_is_historical ? 'Saved asking price' : 'Current asking price'}</span><PriceValue value={gift.price_per_day} compact unit={askingPriceUnit(gift)} />{gift.price_per_day == null ? <small>Not observed</small> : gift.price_is_historical && <small className="saved-price-cue">Saved {relativeTime(gift.price_observed_at)}</small>}</div>
      <div className={`detail-suggested-price ${hasRecommendation(gift) ? 'ready' : 'missing'}`}><span>Suggested price</span><Recommendation gift={gift} selection={selection} /></div>
    </div>
    <div className="trait-pair compact-traits"><div><span>Model</span><strong>{gift.model || 'Not established'}</strong></div><div><span>Backdrop</span><strong>{isExactBlack(gift) && <i className="black-swatch" />}{gift.backdrop || 'Not established'}</strong></div></div>
    <div className="cohort-list-heading"><h4>Comparison averages</h4><span>{unit}</span></div>
    <div className="cohort-detail-list">{cohorts.map(({ key, label }) => {
      const cohort = pricing?.[key];
      const selected = (pricing?.basis === key || (blackOnly && key === 'model' && pricing?.basis === 'model_black')) && hasRecommendation(gift);
      return <article className={`cohort-detail-card compact-cohort ${selected ? 'selected' : ''}`} key={key}>
        <div className="cohort-detail-title"><strong>{label}</strong>{selected && <span className="basis-tag"><Icon name="check" size={12} />Used</span>}</div>
        <CohortAverage cohort={cohort} rentals={rentals} unit={unit} />
        {key === 'model_black' && !isExactBlack(gift) && <p className="cohort-comparison-cue">Comparison only · gift is not verified Black</p>}
        <details className="cohort-statistics"><summary aria-label={`Statistics for ${label}`}>Statistics</summary><dl>
          <div><dt>Median</dt><dd>{formatAmount(cohort?.median)}</dd></div>
          <div><dt>Observed range</dt><dd>{cohort?.minimum != null && cohort?.maximum != null ? `${formatAmount(cohort.minimum)} – ${formatAmount(cohort.maximum)}` : 'Not enough samples'}</dd></div>
          <div><dt>{rentals ? 'Rental records' : 'Distinct listed gifts'}</dt><dd>{cohort?.sample_count || 0}</dd></div>
          {rentals && cohort?.distinct_nft_count != null && <div><dt>Distinct gifts</dt><dd>{cohort.distinct_nft_count}</dd></div>}
          <div><dt>{rentals ? 'First rental event' : 'First observation'}</dt><dd>{dateTime(cohort?.observed_from, true)}</dd></div>
          <div><dt>{rentals ? 'Last rental event' : 'Last observation'}</dt><dd>{dateTime(cohort?.observed_to, true)}</dd></div>
        </dl><p className="sample-explanation">{sampleSize(cohort, selection.source).explanation}</p></details>
      </article>;
    })}</div>
    <details className="pricing-evidence"><summary>Sources & limitations{warnings.length > 0 && <span> · {warnings.length}</span>}</summary><div>
      {pricing?.reason && <p>{humanize(pricing.reason)}</p>}
      {hasRecommendation(gift) && <p>{evidence.explanation} {match.explanation}</p>}
      <dl><div><dt>Asking price source</dt><dd>{gift.price_source ? humanize(gift.price_source) : 'Not established'}</dd></div><div><dt>Price observed</dt><dd>{dateTime(gift.price_observed_at)}</dd></div><div><dt>Trait source</dt><dd>{gift.traits_source ? humanize(gift.traits_source) : 'Not established'}</dd></div><div><dt>Traits observed</dt><dd>{dateTime(gift.traits_observed_at)}</dd></div></dl>
      <p>Your own gifts are included when eligible. {rentals ? 'Daily rates use reported rental totals and duration with the observed Marketapp interpretation; net income is not established.' : 'Asking prices do not establish realized rental income.'} Suggestions need at least 3 distinct gifts. Coverage is a saved sample.</p>
      {warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{humanize(warning)}</li>)}</ul>}
    </div></details>
  </section>;
}


export function PricingPage({ data, selection, onSelectionChange, filters, onFiltersChange, onSelect, renderImage, collectPrices, disabled, viewMode = 'grid', viewControl }: {

  data: Dashboard; selection: PricingSelection; onSelectionChange: (selection: PricingSelection) => void;
  filters: PricingFilters; onFiltersChange: (filters: PricingFilters) => void; onSelect: (gift: Gift) => void; renderImage: (gift: Gift) => ReactNode;

  collectPrices: () => void; disabled: boolean;
  viewMode?: PricingViewMode;
  viewControl?: ReactNode;

}) {

  const rentals = selection.source === 'rentals';
  const grid = viewMode === 'grid';

  const cohorts = cohortsFor(selection);
  const blackOnly = selection.backdrop === 'Black';
  const unit = typeof data.pricing?.unit === 'string' ? data.pricing.unit : rentals ? 'GRAM/rental record' : 'GRAM/day';

  const dailyComparable = data.pricing?.daily_comparable !== false;

  const warnings = Array.isArray(data.pricing?.warnings) ? data.pricing.warnings.filter((value): value is string => typeof value === 'string') : [];

  const excluded = data.pricing?.excluded_counts && typeof data.pricing.excluded_counts === 'object' ? Object.entries(data.pricing.excluded_counts).filter(([, value]) => typeof value === 'number' && value > 0) : [];

  const { search, collection, filter, sort } = filters;
  const setSearch = (search: string) => onFiltersChange({ ...filters, search });
  const setCollection = (collection: string) => onFiltersChange({ ...filters, collection });
  const setSort = (sort: PricingSort) => onFiltersChange({ ...filters, sort });
  const setFilter = (filter: PricingFilter) => {
    onFiltersChange({ ...filters, filter });
    const backdrop = filter === 'black' ? 'Black' : undefined;
    if (selection.backdrop !== backdrop) onSelectionChange({ ...selection, backdrop });
  };



  const portfolio = data.gifts.filter(gift => gift.is_portfolio && (!blackOnly || isExactBlack(gift)));

  const mixedAskingUnits = portfolio.some(gift => gift.price_per_day != null && askingPriceUnit(gift) !== 'GRAM/day');

  const ready = portfolio.filter(hasRecommendation).length;

  const peerDataCount = portfolio.filter(gift => (gift.pricing?.collection.sample_count || 0) > 0).length;

  const filtered = useMemo(() => sortPricingGifts(filterPricingGifts(data.gifts, search, collection, filter), sort), [data.gifts, search, collection, filter, sort]);

  const collections = useMemo(() => {

    const entries = new Map<string, string>();

    for (const gift of data.gifts.filter(value => value.is_portfolio)) {

      const key = gift.collection_address || gift.collection_name;

      if (key) entries.set(key, gift.collection_name || shorten(key));

    }

    return [...entries].sort((a, b) => a[1].localeCompare(b[1]));

  }, [data.gifts]);

  const latest = portfolio.flatMap(gift => cohorts.map(({ key }) => gift.pricing?.[key]?.observed_to))

    .filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  const list = useProgressiveList(filtered.length, PAGE_SIZE,
    JSON.stringify([search, collection, filter, sort, pricingQuery(selection)]));





  return <div className={`pricing-page pricing-view-${viewMode}`}>

    {!grid && <div className="pricing-summary-strip" aria-label="Pricing summary"><button type="button" className="ready" onClick={() => setFilter('ready')}><strong>{ready.toLocaleString()}</strong> ready</button><button type="button" onClick={() => setFilter('missing')}><strong>{(portfolio.length - ready).toLocaleString()}</strong> {dailyComparable ? 'need more data' : 'daily rate unverified'}</button><span className="pricing-summary-age" title={latest ? dateTime(latest) : undefined}><Icon name="clock" size={14} />{latest ? <>{rentals ? 'Latest rental' : 'Observed'} {relativeTime(latest)}</> : 'No comparisons yet'}</span></div>}



    {portfolio.length > 0 && peerDataCount === 0 && <div className="pricing-empty-banner"><Icon name="layers" size={22} /><div><strong>No comparison samples in this timeframe</strong><p>{rentals ? 'Collect rental history or choose a wider timeframe. Recorded rental amounts are normalized per day for comparison.' : 'Collect current market listings or choose a wider timeframe. Missing samples remain empty.'}</p></div><button className="button primary" disabled={disabled} onClick={collectPrices}>{rentals ? 'Collect actual rentals' : 'Collect market prices'}<Icon name="arrow" size={15} /></button></div>}

    {rentals && !dailyComparable && <div className="notice info"><Icon name="shield" size={18} /><div><strong>Rental amounts and daily asking prices use different units</strong><p>Rental record averages remain useful for comparison. Until the API's price and duration units are verified, they are shown as GRAM per rental record and do not generate daily recommendations.</p></div></div>}

    {!grid && <details className="pricing-methodology"><summary>How prices are calculated{(warnings.length > 0 || excluded.length > 0) && <span> · coverage & limitations</span>}</summary><div>
      <p>{blackOnly ? <>All averages use the exact <b>Black</b> backdrop: collection across all models, then your exact model. Missing Black evidence stays empty.</> : <>Compare the collection, exact model, and same model with exact <b>Black</b>. Model + Black can support a suggestion only for a gift with that verified backdrop.</>} Your own gifts are included when eligible.</p>
      <p>Suggestions use the most specific eligible group with at least <b>3 distinct gifts</b>. {rentals ? 'Rental totals are converted to daily rates using the observed Marketapp price and duration interpretation. Net proceeds are not established.' : 'These are observed asking prices, not realized rental income.'} Saved observations are a sample, not the entire market. No prices are changed automatically.</p>
      <p>{rentals ? 'The timeframe filters rental event time.' : 'The timeframe filters listing observation time; each gift contributes its latest eligible observation.'} The default is 30 days and the maximum is 90 days. Low samples never extend the timeframe automatically.</p>
      <p>Price difference = suggested − asking, in GRAM/day. Gifts missing either price sort last. Duplicate observations and invalid or incompatible records do not add extra weight.</p>
      <p>Sample size counts distinct gifts: 1–2 limited, 3–9 small, 10–29 medium, 30 or more large. It describes the amount of evidence, not statistical confidence. The comparison label shows whether the estimate uses the collection, the same model, or the same model with Black.</p>
      {latest && <p>{rentals ? 'Latest rental event' : 'Latest listing observation'}: <time dateTime={latest}>{dateTime(latest)}</time>.</p>}
      {warnings.length > 0 && <><h3>Limitations</h3><ul>{warnings.map((warning, index) => <li key={index}>{humanize(warning)}</li>)}</ul></>}
      {excluded.length > 0 && <><h3>Excluded samples</h3><dl>{excluded.map(([reason, count]) => <div key={reason}><dt>{humanize(reason)}</dt><dd>{String(count)}</dd></div>)}</dl></>}
    </div></details>}

    <section className="panel pricing-panel"><div className="section-heading pricing-gifts-heading"><div><h2>Your gifts <span className="heading-count">{portfolio.length}</span></h2><span className="pricing-grid-unit">{grid ? mixedAskingUnits ? 'GRAM / day unless noted' : 'GRAM / day' : unit}</span></div>{viewControl}</div>

      <div className="filter-toolbar pricing-filter-toolbar"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Search pricing gifts" placeholder="Search gifts…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear pricing search" onClick={() => setSearch('')}><Icon name="close" size={15} /></button>}</label></div>



      <div className="pricing-grid-filters"><div className="pricing-grid-quick-filters" role="group" aria-label="Gift backdrop"><button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All gifts</button><button type="button" className={blackOnly ? 'active' : ''} aria-pressed={blackOnly} onClick={() => setFilter(blackOnly ? 'all' : 'black')}><i className="black-swatch" />Black</button></div><details className="pricing-grid-advanced"><summary>Filters{(collection || sort !== 'default' || filter === 'ready' || filter === 'missing') && <span className="pricing-filter-active" aria-label="Additional filters active" />}</summary><div><label><span>Collection</span><select aria-label="Filter pricing by collection" value={collection} onChange={event => setCollection(event.target.value)}><option value="">All collections</option>{collections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label><span>Sort by</span><select aria-label="Sort pricing gifts" value={sort} onChange={event => setSort(event.target.value as PricingSort)}><option value="default">Default order</option><option value="gap">Largest price gap</option><option value="increase">Biggest increase first</option><option value="decrease">Biggest decrease first</option></select></label><label><span>Show</span><select aria-label="Filter pricing by recommendation" value={filter} onChange={event => setFilter(event.target.value as PricingFilter)}>{FILTERS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label></div></details></div>

      {filtered.length ? grid ? <div className="pricing-gift-grid">{filtered.slice(0, list.visibleCount).map(gift => <button type="button" className="pricing-gift-card" key={gift.id} onClick={() => onSelect(gift)} aria-label={`View pricing details for ${gift.name || 'gift'}`}>
        {renderImage(gift)}
        <strong className="pricing-gift-card-name">{gift.name || 'Unnamed gift'}</strong>
        <span className="pricing-gift-card-prices"><span title={gift.price_per_day == null ? 'No current asking price saved' : `${gift.price_is_historical ? 'Saved asking price' : 'Observed asking price'} · ${dateTime(gift.price_observed_at, true)}`}><span>{gift.price_is_historical ? 'Saved' : 'Current'}</span><strong>{formatAmount(gift.price_per_day)}</strong>{gift.price_per_day != null && askingPriceUnit(gift) !== 'GRAM/day' && <small className="grid-price-cue">{askingPriceUnit(gift)}</small>}{gift.price_per_day == null && <small className="grid-price-cue">Not observed</small>}{gift.price_is_historical && gift.price_per_day != null && <small className="grid-price-cue stale">Previous observation</small>}</span><span className="pricing-gift-card-recommendation" title={hasRecommendation(gift) ? `Recommended daily price · ${comparisonMatch(gift.pricing?.basis, selection.backdrop).label}` : 'No daily recommendation available'}><span>Recommended</span><strong>{formatAmount(hasRecommendation(gift) ? gift.pricing?.recommended_price_per_day : null)}</strong>{!hasRecommendation(gift) && <small className="grid-price-cue">{gift.pricing?.daily_comparable === false ? 'Daily rate unverified' : 'No estimate'}</small>}</span></span>
        {hasRecommendation(gift) && <RecommendationEvidence gift={gift} selection={selection} compact />}
      </button>)}</div> : <div className="table-scroll"><table className={`pricing-table ${blackOnly ? 'black-scope' : ''}`}><thead><tr><th>Gift & traits</th><th>Current price<small>{mixedAskingUnits ? 'Units shown per gift' : 'GRAM / day'}</small></th><th className="suggested-heading">Suggested price<small>GRAM / day</small></th>{cohorts.map(cohort => <th key={cohort.key}>{cohort.shortLabel}<small>{rentals ? 'Rental average' : 'Listing average'}</small></th>)}<th><span className="sr-only">Details</span></th></tr></thead><tbody>{filtered.slice(0, list.visibleCount).map(gift => <tr key={gift.id}><td className="pricing-identity"><button className="gift-name-button" onClick={() => onSelect(gift)}>{renderImage(gift)}<span className="pricing-gift-copy"><strong>{gift.name || 'Unnamed gift'}</strong><small>{gift.collection_name || shorten(gift.collection_address)}</small><span className="pricing-row-traits"><span>{gift.model || 'Model unknown'}</span><span>{isExactBlack(gift) && <i className="black-swatch" />}{gift.backdrop || 'Backdrop unknown'}</span></span></span><RentalCount gift={gift} /></button></td>

        <td className="own-price" data-label={gift.price_is_historical ? 'Saved asking price' : 'Current price'}><PriceValue value={gift.price_per_day} compact unit={askingPriceUnit(gift)} />{gift.price_per_day == null ? <small className="price-observation-note">Not observed</small> : <small className={`price-observation-note${gift.price_is_historical ? ' saved-price-cue' : ''}`} title={dateTime(gift.price_observed_at)}>{gift.price_is_historical ? 'Saved · ' : 'Observed '}{relativeTime(gift.price_observed_at)}</small>}</td>

        <td className="suggested-cell" data-label="Suggested daily price"><Recommendation gift={gift} selection={selection} /></td>

        {cohorts.map(({ key, label }) => <td className={`pricing-cohort cohort-${key}`} key={key} data-label={label}><CohortAverage cohort={gift.pricing?.[key]} rentals={rentals} unit={gift.pricing?.unit || unit} />{key === 'model_black' && !isExactBlack(gift) && (gift.pricing?.model_black.sample_count || 0) > 0 && <span className="comparison-only">Comparison only</span>}</td>)}

        <td className="pricing-detail-cell"><button className="icon-button" aria-label={`View pricing details for ${gift.name || 'gift'}`} onClick={() => onSelect(gift)}><Icon name="chevron" size={17} /></button></td></tr>)}</tbody></table></div>

        : <div className="empty-state"><span className="empty-icon"><Icon name={portfolio.length ? 'search' : 'gift'} size={29} /></span><h3>{portfolio.length ? 'No gifts match this pricing view' : 'Add gifts to start comparing prices'}</h3><p>{portfolio.length ? 'Try another search or collection, or switch back to all portfolio gifts.' : data.capabilities.hosting === 'serverless' ? 'Your portfolio has not been imported yet. Import your saved wallet evidence to compare these gifts.' : 'Discover your wallet or import a portfolio. Comparison prices will be calculated for your gifts.'}</p></div>}

      <ListFooter {...list} total={filtered.length} noun="portfolio gifts" />

    </section>



  </div>;

}
