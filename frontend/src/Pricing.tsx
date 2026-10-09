import { useEffect, useMemo, useState } from 'react';

import type { ReactNode } from 'react';

import { Icon } from './Icons';

import type { Dashboard, Gift, PriceCohort, PricingBasis, PricingSelection, PricingTimeframe } from './data/types';

import { dateTime, filterPricingGifts, formatAmount, formatPriceDifference, hasRecommendation, humanize, isExactBlack, priceDifference, pricingBasisLabel, relativeTime, shorten, sortPricingGifts } from './data/helpers';

import type { PricingFilter, PricingFilters, PricingSort } from './data/helpers';

import { dateRangeError, pricingQuery, selectTimeframe, sourceDefaults, timeframeLabel, TIMEFRAME_OPTIONS, validDateRange } from './data/pricingSelection';
import { useProgressiveList } from './useProgressiveList';
import { ListFooter } from './ListFooter';
import { RentalCount } from './RentalCount';



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

    {compact ? <span className="sr-only" aria-live="polite">{loading ? 'Loading' : 'Showing'} {selection.source === 'rentals' ? 'actual rentals' : 'listing prices'} · {timeframeLabel(selection)}{selection.backdrop ? ' · Exact Black backdrop only' : ''}</span> : <p className="pricing-selection-caption" aria-live="polite">{loading ? 'Loading' : 'Showing'} {selection.source === 'rentals' ? 'recorded rentals' : 'listing observations'} · {timeframeLabel(selection)}{selection.backdrop ? ' · Exact Black backdrop only' : ''}. {selection.source === 'rentals' ? 'Filtered by rental event time.' : 'Filtered by listing observation time; each gift contributes its latest eligible observation.'} Default: 30 days. Maximum: 90 days. Low samples never extend the timeframe automatically.</p>}

  </section>;

}



function PriceValue({ value, compact = false, unit = 'GRAM/day' }: { value: string | null | undefined; compact?: boolean; unit?: string }) {

  const suffix = unit === 'GRAM/rental record' ? '/ record' : '/ day';

  return <span className={`comparison-price ${compact ? 'compact' : ''}`} title={value == null ? 'No price observation' : `${formatAmount(value)} ${unit}`}>

    <strong>{formatAmount(value)}</strong>{value != null && <small>GRAM<span>{suffix}</span></small>}

  </span>;

}



function CohortAverage({ cohort, rentals, unit }: { cohort?: PriceCohort; rentals: boolean; unit: string }) {

  if (!cohort || cohort.mean == null || cohort.sample_count === 0) return <div className="cohort-empty"><strong>—</strong><small>No eligible {rentals ? 'records' : 'gifts'}</small></div>;

  const noun = rentals ? (cohort.sample_count === 1 ? 'record' : 'records') : (cohort.sample_count === 1 ? 'gift' : 'gifts');
  const lowSample = (rentals ? cohort.distinct_nft_count ?? 0 : cohort.sample_count) < 3;
  return <div className="cohort-average"><PriceValue value={cohort.mean} compact unit={unit} /><span className={`sample-count ${lowSample ? 'limited' : ''}`}>{cohort.sample_count} {noun}{lowSample ? ' · low sample' : ''}</span>{rentals && cohort.distinct_nft_count != null && <small className="comparison-only">{cohort.distinct_nft_count} distinct {cohort.distinct_nft_count === 1 ? 'gift' : 'gifts'}</small>}</div>;
}



function Recommendation({ gift, selection }: { gift: Gift; selection: PricingSelection }) {

  if (gift.pricing?.daily_comparable === false) return <div className="recommendation-missing"><span>Daily rate unverified</span><small>Record amounts cannot establish a daily price</small></div>;

  if (!hasRecommendation(gift)) return <div className="recommendation-missing"><span>No daily suggestion</span><small>At least 3 eligible distinct gifts needed</small></div>;

  const difference = priceDifference(gift);
  return <div className="recommendation-ready"><PriceValue value={gift.pricing!.recommended_price_per_day} compact /><span>{pricingBasisLabel(gift.pricing!.basis, selection.backdrop)}<i />{gift.pricing!.confidence} confidence</span><small className="price-difference">{difference == null ? 'Difference unavailable' : <>Change from asking: <strong>{formatPriceDifference(difference)}</strong> GRAM/day</>}</small></div>;

}



export function PricingDetails({ gift, selection }: { gift: Gift; selection: PricingSelection }) {

  const pricing = gift.pricing;
  const cohorts = cohortsFor(selection);
  const blackOnly = selection.backdrop === 'Black';

  const rentals = selection.source === 'rentals';

  const unit = pricing?.unit || (rentals ? 'GRAM/rental record' : 'GRAM/day');

  const noun = rentals ? 'rental records' : 'comparable listings';

  return <section className="detail-section pricing-detail"><div className="pricing-detail-heading"><h3><Icon name="pricing" size={17} />Rental pricing</h3><span>{unit}</span></div><p className="pricing-detail-selection">{rentals ? 'Actual rental records' : 'Listing prices'} · {timeframeLabel(selection)}{blackOnly ? ' · Exact Black only' : ''}</p>

    <div className="trait-pair"><div><span>Model</span><strong>{gift.model || 'Not established'}</strong></div><div><span>Backdrop</span><strong>{isExactBlack(gift) && <i className="black-swatch" />}{gift.backdrop || 'Not established'}</strong></div></div>

    {gift.traits_source && <p className="traits-source">{humanize(gift.traits_source)}{gift.traits_observed_at ? ` · ${dateTime(gift.traits_observed_at, true)}` : ''}</p>}

    <div className={`recommendation-box ${hasRecommendation(gift) ? 'ready' : 'missing'}`}><span className="eyebrow">SUGGESTED DAILY ASKING PRICE</span><Recommendation gift={gift} selection={selection} /><p>{pricing?.reason ? humanize(pricing.reason) : rentals ? 'Collect actual rental records to compare this gift.' : 'Collect market prices to compare this gift with observed comparable listings.'}</p></div>

    <div className="cohort-detail-list">{cohorts.map(({ key, label }) => {

      const cohort = pricing?.[key];

      const selected = (pricing?.basis === key || (blackOnly && key === 'model' && pricing?.basis === 'model_black')) && hasRecommendation(gift);

      return <article className={`cohort-detail-card ${selected ? 'selected' : ''}`} key={key}><div className="cohort-detail-title"><strong>{label}</strong>{selected ? <span className="basis-tag"><Icon name="check" size={12} />Basis</span> : <span>{cohort?.sample_count || 0} {noun}</span>}</div>

        <div className="cohort-main-value"><div><span>Average</span><PriceValue value={cohort?.mean} unit={unit} /></div><div><span>Median</span><strong>{formatAmount(cohort?.median)}</strong></div></div>

        <dl><div><dt>Observed range</dt><dd>{cohort?.minimum != null && cohort?.maximum != null ? `${formatAmount(cohort.minimum)} – ${formatAmount(cohort.maximum)}` : 'Not enough samples'}</dd></div><div><dt>{rentals ? 'Rental records' : 'Distinct listed gifts'}</dt><dd>{cohort?.sample_count || 0}</dd></div><div><dt>{rentals ? 'First rental event' : 'First observation'}</dt><dd>{dateTime(cohort?.observed_from, true)}</dd></div><div><dt>{rentals ? 'Last rental event' : 'Last observation'}</dt><dd>{dateTime(cohort?.observed_to, true)}</dd></div>{rentals && cohort?.distinct_nft_count != null && <div><dt>Distinct gifts</dt><dd>{cohort.distinct_nft_count}</dd></div>}</dl>

        {key === 'model_black' && <p className="cohort-condition">{isExactBlack(gift) ? 'Eligible as a recommendation basis: this gift has the exact Black backdrop.' : 'Comparison only. This gift does not have a verified exact Black backdrop.'}</p>}

      </article>;

    })}</div>

    <p className="pricing-method-note"><Icon name="shield" size={14} />Your own gifts, including this gift, are included when eligible. {rentals ? 'Daily rates are derived from recorded rental totals and duration using the observed Marketapp interpretation; net income is not established.' : 'These are observed asking prices, not realized rental income.'} An eligible comparison needs at least 3 distinct gifts before it can support a suggestion. Coverage is an observed sample.</p>

    {(pricing?.warnings?.length || gift.trait_uncertainties?.length) ? <div className="pricing-warnings"><h4><Icon name="alert" size={15} />Pricing limitations</h4><ul>{[...(gift.trait_uncertainties || []), ...(pricing?.warnings || [])].map((warning, index) => <li key={index}>{humanize(warning)}</li>)}</ul></div> : null}

  </section>;

}



export function PricingPage({ data, selection, onSelectionChange, filters, onFiltersChange, onSelect, renderImage, collectPrices, disabled, viewMode = 'detailed', onViewModeChange }: {

  data: Dashboard; selection: PricingSelection; onSelectionChange: (selection: PricingSelection) => void;
  filters: PricingFilters; onFiltersChange: (filters: PricingFilters) => void; onSelect: (gift: Gift) => void; renderImage: (gift: Gift) => ReactNode;

  collectPrices: () => void; disabled: boolean;
  viewMode?: PricingViewMode; onViewModeChange?: (mode: PricingViewMode) => void;

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



  const comparisonGuide = <section className="pricing-guide"><span className="guide-icon"><Icon name="discover" size={24} /></span><div><h2>{blackOnly ? 'Compare Black gifts with Black gifts.' : rentals ? 'Compare what gifts actually rented for.' : 'Three comparisons. One evidence-based suggestion.'}</h2><p>{blackOnly ? <>Every average and suggestion uses the exact <b>Black</b> backdrop: the collection across all models, then your exact model. Missing Black evidence stays empty.</> : <>Compare your collection, the exact model, and the same model with the exact <b>Black</b> backdrop.</>} Your own gifts are included when eligible, including the gift being compared.</p><div className="cohort-steps">{cohorts.map((cohort, index) => <span key={cohort.key}>{index > 0 && <Icon name="chevron" size={12} />}{cohort.shortLabel}</span>)}</div></div><span className="read-only-tag">{rentals ? 'RENTAL RECORDS' : 'ASKING PRICES'}</span></section>;

  return <div className={`pricing-page pricing-view-${viewMode}`}>

    {!grid && <div className="pricing-summary"><button className="pricing-summary-card ready" onClick={() => setFilter('ready')}><span><Icon name="pricing" size={19} />Recommendations ready</span><strong>{ready.toLocaleString()}<small>of {portfolio.length.toLocaleString()} gifts</small></strong><p>{rentals ? 'Based on rentals of at least 3 distinct gifts' : 'Based on at least 3 distinct listed gifts'}</p></button><button className="pricing-summary-card missing" onClick={() => setFilter('missing')}><span><Icon name="layers" size={19} />{dailyComparable ? 'Needs more market data' : 'Daily suggestion unavailable'}</span><strong>{(portfolio.length - ready).toLocaleString()}<small>gifts</small></strong><p>{!dailyComparable ? 'Record averages remain available for inspection' : peerDataCount ? 'Broader collection coverage may add comparisons' : 'Collect prices to build your comparison sample'}</p></button><div className="pricing-summary-card freshness"><span><Icon name="clock" size={19} />{rentals ? 'Latest rental event' : 'Latest listing observation'}</span><strong>{latest ? relativeTime(latest) : 'Not collected'}</strong><p>{latest ? dateTime(latest) : 'No comparison prices have been saved yet'}</p></div></div>}

    {!grid && (data.capabilities.hosting === 'serverless' ? <details className="cloud-pricing-help"><summary>How the comparison groups work</summary>{comparisonGuide}</details> : comparisonGuide)}

    {portfolio.length > 0 && peerDataCount === 0 && <div className="pricing-empty-banner"><Icon name="layers" size={22} /><div><strong>No comparison samples in this timeframe</strong><p>{rentals ? 'Collect rental history or choose a wider timeframe. Recorded rental amounts are normalized per day for comparison.' : 'Collect current market listings or choose a wider timeframe. Missing samples remain empty.'}</p></div><button className="button primary" disabled={disabled} onClick={collectPrices}>{rentals ? 'Collect actual rentals' : 'Collect market prices'}<Icon name="arrow" size={15} /></button></div>}

    {rentals && !dailyComparable && <div className="notice info"><Icon name="shield" size={18} /><div><strong>Rental amounts and daily asking prices use different units</strong><p>Rental record averages remain useful for comparison. Until the API's price and duration units are verified, they are shown as GRAM per rental record and do not generate daily recommendations.</p></div></div>}

    {!grid && (warnings.length > 0 || excluded.length > 0) && <details className="pricing-coverage"><summary>Sample coverage and exclusions</summary><p>Only saved, eligible observations in this timeframe are included. Your own gifts are included on the same terms as other gifts. Duplicate observations and invalid or incompatible records do not add extra weight.</p>{warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{humanize(warning)}</li>)}</ul>}{excluded.length > 0 && <dl>{excluded.map(([reason, count]) => <div key={reason}><dt>{humanize(reason)}</dt><dd>{String(count)}</dd></div>)}</dl>}</details>}

    <section className="panel pricing-panel"><div className="section-heading"><div>{!grid && <span className="eyebrow">RENTAL PRICE COMPARISON</span>}<h2>{grid ? 'Your gifts' : 'Your gifts, compared'} <span className="heading-count">{portfolio.length}</span></h2>{grid && <span className="pricing-grid-unit">GRAM / day</span>}</div><div className="pricing-heading-options">{!grid && <span className="table-unit">Comparisons: {unit}</span>}{onViewModeChange && <div className="pricing-view-toggle" role="group" aria-label="Gift display"><button type="button" className={grid ? 'active' : ''} aria-pressed={grid} onClick={() => onViewModeChange('grid')}><Icon name="overview" size={15} />Grid</button><button type="button" className={!grid ? 'active' : ''} aria-pressed={!grid} onClick={() => onViewModeChange('detailed')}><Icon name="layers" size={15} />Detailed</button></div>}</div></div>

      <div className="filter-toolbar pricing-filter-toolbar"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Search pricing gifts" placeholder="Search gifts…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear pricing search" onClick={() => setSearch('')}><Icon name="close" size={15} /></button>}</label>{!grid && <label className="collection-filter"><span className="sr-only">Filter pricing by collection</span><select value={collection} onChange={event => setCollection(event.target.value)}><option value="">All collections</option>{collections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}</div>

      {!grid && <div className="pricing-sort-toolbar"><label className="pricing-sort"><span>Sort by</span><select aria-label="Sort pricing gifts" value={sort} onChange={event => setSort(event.target.value as PricingSort)}><option value="default">Default order</option><option value="gap">Largest price gap</option><option value="increase">Biggest increase first</option><option value="decrease">Biggest decrease first</option></select></label><p>Difference = suggested − asking (GRAM/day). Gifts missing either price sort last.</p></div>}

      {grid ? <div className="pricing-grid-filters"><div className="pricing-grid-quick-filters" role="group" aria-label="Gift backdrop"><button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All gifts</button><button type="button" className={blackOnly ? 'active' : ''} aria-pressed={blackOnly} onClick={() => setFilter(blackOnly ? 'all' : 'black')}><i className="black-swatch" />Black</button></div><details className="pricing-grid-advanced"><summary>Filters{(collection || sort !== 'default' || filter === 'ready' || filter === 'missing') && <span className="pricing-filter-active" aria-label="Additional filters active" />}</summary><div><label><span>Collection</span><select aria-label="Filter pricing by collection" value={collection} onChange={event => setCollection(event.target.value)}><option value="">All collections</option>{collections.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label><span>Sort by</span><select aria-label="Sort pricing gifts" value={sort} onChange={event => setSort(event.target.value as PricingSort)}><option value="default">Default order</option><option value="gap">Largest price gap</option><option value="increase">Biggest increase first</option><option value="decrease">Biggest decrease first</option></select></label><label><span>Show</span><select aria-label="Filter pricing by recommendation" value={filter} onChange={event => setFilter(event.target.value as PricingFilter)}>{FILTERS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label></div></details></div> : <div className="filter-tabs">{FILTERS.map(option => <button key={option.key} className={filter === option.key ? 'active' : ''} aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>{option.label}</button>)}</div>}

      {filtered.length ? grid ? <div className="pricing-gift-grid">{filtered.slice(0, list.visibleCount).map(gift => <button type="button" className="pricing-gift-card" key={gift.id} onClick={() => onSelect(gift)} aria-label={`View pricing details for ${gift.name || 'gift'}`}>
        {renderImage(gift)}
        <strong className="pricing-gift-card-name">{gift.name || 'Unnamed gift'}</strong>
        <span className="pricing-gift-card-prices"><span title={gift.price_per_day == null ? 'No current asking price saved' : `${gift.price_is_historical ? 'Saved asking price' : 'Observed asking price'} · ${dateTime(gift.price_observed_at, true)}`}><span>Current</span><strong>{formatAmount(gift.price_per_day)}</strong></span><span className="pricing-gift-card-recommendation" title={hasRecommendation(gift) ? `Recommended daily price · ${pricingBasisLabel(gift.pricing?.basis, selection.backdrop)}` : 'No daily recommendation available'}><span>Recommended</span><strong>{formatAmount(hasRecommendation(gift) ? gift.pricing?.recommended_price_per_day : null)}</strong></span></span>
      </button>)}</div> : <div className="table-scroll"><table className={`pricing-table ${blackOnly ? 'black-scope' : ''}`}><thead><tr><th>Gift & traits</th><th>Your asking price<small>GRAM / day</small></th>{cohorts.map(cohort => <th key={cohort.key}>{cohort.label}<small>{rentals ? 'Recorded rental average' : 'Observed asking average'}</small></th>)}<th className="suggested-heading">Suggested price<small>Manual decision</small></th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{filtered.slice(0, list.visibleCount).map(gift => <tr key={gift.id}><td className="pricing-identity"><button className="gift-name-button" onClick={() => onSelect(gift)}>{renderImage(gift)}<span className="pricing-gift-copy"><strong>{gift.name || 'Unnamed gift'}</strong><small>{gift.collection_name || shorten(gift.collection_address)}</small><span className="pricing-row-traits"><span>{gift.model || 'Model unknown'}</span><span>{isExactBlack(gift) && <i className="black-swatch" />}{gift.backdrop || 'Backdrop unknown'}</span></span></span><RentalCount gift={gift} /></button></td>

        <td className="own-price" data-label="Your asking price · GRAM/day"><PriceValue value={gift.price_per_day} compact />{gift.price_source && <small className="price-source-note" title={gift.price_source}>{humanize(gift.price_source)}</small>}{gift.price_per_day != null && <small className="price-observation-note" title={data.capabilities.hosting === 'serverless' ? 'Current public listings refresh in Telegram. Contract asking prices retain their imported observation time.' : 'Use Refresh gift status to read configured asking prices for gifts in rental contracts.'}>{gift.price_is_historical ? 'Saved price · ' : 'Observed '}{dateTime(gift.price_observed_at, true)}</small>}</td>

        {cohorts.map(({ key, label }) => <td className={`pricing-cohort cohort-${key}`} key={key} data-label={label}><CohortAverage cohort={gift.pricing?.[key]} rentals={rentals} unit={gift.pricing?.unit || unit} />{key === 'model_black' && !isExactBlack(gift) && (gift.pricing?.model_black.sample_count || 0) > 0 && <span className="comparison-only">Comparison only</span>}</td>)}

        <td className="suggested-cell" data-label="Suggested daily price"><Recommendation gift={gift} selection={selection} /></td><td className="pricing-detail-cell"><button className="icon-button" aria-label={`View pricing details for ${gift.name || 'gift'}`} onClick={() => onSelect(gift)}><Icon name="chevron" size={17} /></button></td></tr>)}</tbody></table></div>

        : <div className="empty-state"><span className="empty-icon"><Icon name={portfolio.length ? 'search' : 'gift'} size={29} /></span><h3>{portfolio.length ? 'No gifts match this pricing view' : 'Add gifts to start comparing prices'}</h3><p>{portfolio.length ? 'Try another search or collection, or switch back to all portfolio gifts.' : data.capabilities.hosting === 'serverless' ? 'Your portfolio has not been imported yet. Import your saved wallet evidence to compare these gifts.' : 'Discover your wallet or import a portfolio. Comparison prices will be calculated for your gifts.'}</p></div>}

      <ListFooter {...list} total={filtered.length} noun="portfolio gifts" />

    </section>

    {!grid && <p className="pricing-footnote"><Icon name="shield" size={15} /><span>{rentals ? 'Rental record totals are converted to daily rates using the observed Marketapp price and duration interpretation. Net proceeds are not established. Suggestions require at least 3 distinct gifts.' : 'Observed asking prices, not realized rental income. Suggestions use the most specific eligible group with at least 3 distinct gifts.'} {blackOnly ? 'All comparison groups and suggestions use exact Black only, including collection fallbacks.' : 'Model + Black is a recommendation basis only for gifts with the exact Black backdrop.'} These averages cover saved observations in the selected timeframe, not the entire market. No prices are changed automatically.</span></p>}

  </div>;

}
