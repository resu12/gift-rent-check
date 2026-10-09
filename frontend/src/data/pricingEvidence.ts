import type { PriceCohort, PricingBasis, PricingSource } from './types.ts';

export type SampleSizeLevel = 'none' | 'unknown' | 'limited' | 'small' | 'medium' | 'large';

export interface SampleSize {
  level: SampleSizeLevel;
  label: string;
  distinctGifts: number | null;
  explanation: string;
}

const SIZE_NOTE = 'Sample size describes the amount of evidence, not statistical confidence.';

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function giftCount(count: number): string {
  return `${count.toLocaleString('en-US')} distinct ${count === 1 ? 'gift' : 'gifts'}`;
}

/** Describe the number of eligible gifts; repeated rentals do not increase it. */
export function sampleSize(cohort: PriceCohort | undefined, source: PricingSource): SampleSize {
  const count = source === 'rentals' ? cohort?.distinct_nft_count : cohort?.sample_count;
  const distinctGifts = validCount(count) ? count : null;
  if (!cohort || typeof cohort.mean !== 'string' || !cohort.mean.trim() || cohort.sample_count === 0) {
    return {
      level: 'none', label: 'No sample', distinctGifts,
      explanation: `${distinctGifts === null ? '' : `${giftCount(distinctGifts)} counted. `}No eligible price average is available. ${SIZE_NOTE}`,
    };
  }
  if (!validCount(cohort.sample_count) || distinctGifts === null || (source === 'rentals' && distinctGifts > cohort.sample_count)) {
    return {
      level: 'unknown', label: 'Sample size unknown', distinctGifts: null,
      explanation: `The number of eligible distinct gifts is unavailable.${source === 'rentals' ? ' Rental record count cannot establish it.' : ''} ${SIZE_NOTE}`,
    };
  }
  const level: SampleSizeLevel = distinctGifts === 0 ? 'none'
    : distinctGifts < 3 ? 'limited'
      : distinctGifts < 10 ? 'small'
        : distinctGifts < 30 ? 'medium' : 'large';
  const labels: Record<Exclude<SampleSizeLevel, 'unknown'>, string> = {
    none: 'No sample', limited: 'Limited sample', small: 'Small sample', medium: 'Medium sample', large: 'Large sample',
  };
  const bands: Record<Exclude<SampleSizeLevel, 'unknown'>, string> = {
    none: 'No sample means zero distinct gifts.',
    limited: 'Limited sample means 1–2 distinct gifts.',
    small: 'Small sample means 3–9 distinct gifts.',
    medium: 'Medium sample means 10–29 distinct gifts.',
    large: 'Large sample means 30+ distinct gifts.',
  };
  return { level, label: labels[level], distinctGifts, explanation: `${giftCount(distinctGifts)} in this comparison. ${bands[level]} ${SIZE_NOTE}` };
}

/** Describe match specificity separately from the number of eligible gifts. */
export function comparisonMatch(basis: PricingBasis | null | undefined, backdrop?: 'Black' | null): { label: string; explanation: string } {
  if (basis === 'collection') return backdrop === 'Black'
    ? { label: 'Collection + Black', explanation: 'Average across models in the collection, using only the exact Black backdrop.' }
    : { label: 'Collection estimate', explanation: 'Average across eligible models and backdrops in the collection.' };
  if (basis === 'model_black' || (basis === 'model' && backdrop === 'Black')) {
    return { label: 'Model + Black', explanation: 'Average for the same model in the collection, using only the exact Black backdrop.' };
  }
  if (basis === 'model') return { label: 'Same model', explanation: 'Average for the same model, across eligible backdrops in the collection.' };
  return { label: 'Unknown comparison', explanation: 'No comparison group has been established.' };
}
