import test from 'node:test';
import assert from 'node:assert/strict';
import { filterInventoryGifts, latestEvidenceAt } from './inventory.ts';
import type { Gift } from './types.ts';

const base: Gift = {
  id: 'owned', nft_address: 'nft-owned', name: 'Electric Skull #6175',
  collection_name: 'Electric Skulls', collection_address: 'skulls', image_url: null,
  state: 'rented', display_state: 'Rented', ui_state: 'rented', category: 'portfolio',
  is_portfolio: true, automatic_membership: true, membership_sources: ['ton_verified'],
  verification_method: 'rental_contract', proof_badges: [], price_per_day: null,
  price_unit: null, price_source: null, rental_until: null, observed_at: null,
  market_observed_at: null, explorer_url: null, uncertainties: [],
};

const candidate: Gift = {
  ...base, id: 'candidate', nft_address: 'nft-candidate', name: null,
  collection_name: null, collection_address: null, state: 'unknown', ui_state: 'unknown',
  category: 'unresolved', is_portfolio: false, automatic_membership: false,
  membership_sources: [], verification_method: null,
};

test('portfolio inventory matches the owned count without mixing in candidates', () => {
  const otherOwned = { ...base, id: 'other-owned', state: 'held_directly', ui_state: 'direct' };
  const gifts = [candidate, base, otherOwned];
  const owned = filterInventoryGifts(gifts, '', 'all', '', 'portfolio');
  assert.deepEqual(owned, [base, otherOwned]);
  assert.equal(owned.length, gifts.filter(gift => gift.is_portfolio).length);
  assert.deepEqual(filterInventoryGifts(gifts, '', 'all', '', 'candidates'), [candidate]);
  assert.deepEqual(filterInventoryGifts(gifts, '', 'all', '', 'all'), gifts);
});

test('review can include owned gifts and unknown candidates without deleting either', () => {
  const ownedUnknown = { ...base, id: 'owned-unknown', state: 'unknown', ui_state: 'unknown' };
  const gifts = [base, candidate, ownedUnknown];
  const before = structuredClone(gifts);
  assert.deepEqual(filterInventoryGifts(gifts, '', 'review', '', 'all'), [candidate, ownedUnknown]);
  assert.deepEqual(filterInventoryGifts(gifts, '', 'review', '', 'candidates'), [candidate]);
  assert.deepEqual(filterInventoryGifts(gifts, '', 'review', '', 'portfolio'), [ownedUnknown]);
  assert.deepEqual(gifts, before);
});

test('membership scope composes with search, collection and state filters', () => {
  const matching = { ...base, model: 'Big Brother', backdrop: 'Black' };
  const otherCollection = { ...matching, id: 'other-collection', collection_address: 'books' };
  const otherState = { ...matching, id: 'other-state', state: 'held_directly', ui_state: 'direct' };
  const otherModel = { ...matching, id: 'other-model', model: 'Vampire' };
  const matchingCandidate = { ...matching, id: 'matching-candidate', is_portfolio: false };
  const gifts = [matching, otherCollection, otherState, otherModel, matchingCandidate];
  assert.deepEqual(filterInventoryGifts(gifts, ' BIG BROTHER ', 'rented', 'skulls', 'portfolio'), [matching]);
  assert.deepEqual(filterInventoryGifts(gifts, 'black', 'rented', 'skulls', 'candidates'), [matchingCandidate]);
  assert.deepEqual(filterInventoryGifts(gifts, 'missing', 'all', '', 'all'), []);
});

test('collection-name fallback remains available for unresolved candidates', () => {
  const unresolvedCollection = { ...candidate, collection_name: 'Electric Skulls' };
  assert.deepEqual(filterInventoryGifts([unresolvedCollection], 'nft-candidate', 'review', 'Electric Skulls', 'candidates'), [unresolvedCollection]);
});

test('freshness includes a newer price-only observation and compares actual instants', () => {
  const gifts = [
    { ...base, observed_at: '2026-10-09T10:00:00Z', market_observed_at: '2026-10-09T10:30:00Z' },
    { ...base, id: 'later-price', price_observed_at: '2026-10-09T13:00:00+02:00' },
    { ...candidate, observed_at: '2026-10-09T12:45:00+02:00' },
  ];
  assert.equal(latestEvidenceAt(gifts), '2026-10-09T13:00:00+02:00');
  assert.equal(latestEvidenceAt([{ ...base, price_observed_at: '2026-10-09T11:00:00Z' }]), '2026-10-09T11:00:00Z');
});

test('freshness ignores missing and malformed dates instead of masking valid evidence', () => {
  const invalid = { ...candidate, observed_at: 'not-a-date', market_observed_at: '', price_observed_at: '2026-99-99T99:99:99Z' };
  assert.equal(latestEvidenceAt([invalid, { ...base, observed_at: '2026-10-09T10:00:00Z' }]), '2026-10-09T10:00:00Z');
  assert.equal(latestEvidenceAt([invalid, base]), null);
  assert.equal(latestEvidenceAt([]), null);
});
