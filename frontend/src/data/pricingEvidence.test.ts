import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonMatch, sampleSize } from './pricingEvidence.ts';
import type { PriceCohort } from './types.ts';

function cohort(overrides: Partial<PriceCohort> = {}): PriceCohort {
  return {
    mean: '0.12', median: '0.1', minimum: '0.05', maximum: '0.2', sample_count: 555,
    distinct_nft_count: 131, observed_from: null, observed_to: null, coverage: 'observed_sample',
    ...overrides,
  };
}

test('rental sample size counts distinct gifts, never repeated rental records', () => {
  assert.deepEqual(sampleSize(cohort(), 'rentals'), {
    level: 'large', label: 'Large sample', distinctGifts: 131,
    explanation: '131 distinct gifts in this comparison. Large sample means 30+ distinct gifts. Sample size describes the amount of evidence, not statistical confidence.',
  });
  const repeatedGift = sampleSize(cohort({ distinct_nft_count: 1 }), 'rentals');
  assert.equal(repeatedGift.level, 'limited');
  assert.equal(repeatedGift.label, 'Limited sample');
  assert.equal(repeatedGift.distinctGifts, 1);
  assert.match(repeatedGift.explanation, /^1 distinct gift in this comparison\./);
  assert.equal(sampleSize(cohort({ sample_count: 3, distinct_nft_count: 1 }), 'rentals').level, 'limited');
});

test('sample bands include every boundary and listing counts ignore rental-only distinct fields', () => {
  for (const [count, level, label] of [
    [0, 'none', 'No sample'], [1, 'limited', 'Limited sample'], [2, 'limited', 'Limited sample'],
    [3, 'small', 'Small sample'], [9, 'small', 'Small sample'], [10, 'medium', 'Medium sample'],
    [29, 'medium', 'Medium sample'], [30, 'large', 'Large sample'], [131, 'large', 'Large sample'],
  ] as const) {
    for (const source of ['listings', 'rentals'] as const) {
      const result = sampleSize(cohort(source === 'listings' ? { sample_count: count, distinct_nft_count: 999 } : { distinct_nft_count: count }), source);
      assert.equal(result.level, level, `${source}: ${count}`);
      assert.equal(result.label, label);
      assert.equal(result.distinctGifts, count);
      assert.match(result.explanation, /distinct gift/);
      assert.match(result.explanation, /not statistical confidence/);
      if (count > 0) assert.ok(result.explanation.includes({ limited: '1–2', small: '3–9', medium: '10–29', large: '30+' }[level as 'limited' | 'small' | 'medium' | 'large']));
    }
  }
});

test('missing or invalid counts stay unknown rather than becoming a large record-count sample', () => {
  for (const count of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '131', true]) {
    const result = sampleSize(cohort({ distinct_nft_count: count as unknown as number }), 'rentals');
    assert.equal(result.level, 'unknown');
    assert.equal(result.label, 'Sample size unknown');
    assert.equal(result.distinctGifts, null);
    assert.match(result.explanation, /Rental record count cannot establish it/);
    for (const source of ['listings', 'rentals'] as const) {
      assert.equal(sampleSize(cohort({ sample_count: count as unknown as number }), source).level, 'unknown');
    }
  }
  assert.equal(sampleSize(cohort({ sample_count: Number.MAX_SAFE_INTEGER }), 'listings').level, 'large');
  const impossible = sampleSize(cohort({ sample_count: 3, distinct_nft_count: 4 }), 'rentals');
  assert.equal(impossible.level, 'unknown');
  assert.equal(impossible.distinctGifts, null);
  assert.equal(impossible.label, 'Sample size unknown');
});

test('absent averages and empty samples stay empty without inventing missing counts', () => {
  assert.equal(sampleSize(undefined, 'rentals').level, 'none');
  assert.equal(sampleSize(undefined, 'rentals').distinctGifts, null);
  for (const mean of [null, '', ' ']) {
    const result = sampleSize(cohort({ mean }), 'rentals');
    assert.equal(result.level, 'none');
    assert.equal(result.distinctGifts, 131);
    assert.match(result.explanation, /No eligible price average/);
  }
  assert.equal(sampleSize(cohort({ sample_count: 0, distinct_nft_count: undefined }), 'rentals').level, 'none');
  assert.equal(sampleSize(cohort({ mean: '0' }), 'rentals').level, 'large');
});

test('comparison match distinguishes collection breadth from exact-model and exact-Black scopes', () => {
  assert.equal(comparisonMatch('collection').label, 'Collection estimate');
  assert.match(comparisonMatch('collection').explanation, /across eligible models and backdrops/);
  assert.equal(comparisonMatch('model').label, 'Same model');
  assert.match(comparisonMatch('model').explanation, /same model, across eligible backdrops/);
  assert.equal(comparisonMatch('collection', 'Black').label, 'Collection + Black');
  assert.match(comparisonMatch('collection', 'Black').explanation, /across models/);
  assert.match(comparisonMatch('collection', 'Black').explanation, /only the exact Black backdrop/);
  for (const result of [comparisonMatch('model', 'Black'), comparisonMatch('model_black'), comparisonMatch('model_black', 'Black')]) {
    assert.equal(result.label, 'Model + Black');
    assert.match(result.explanation, /same model/);
    assert.match(result.explanation, /only the exact Black backdrop/);
  }
  for (const basis of [null, undefined]) {
    assert.equal(comparisonMatch(basis).label, 'Unknown comparison');
    assert.equal(comparisonMatch(basis, 'Black').label, 'Unknown comparison');
  }
});
