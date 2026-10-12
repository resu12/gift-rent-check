import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInventorySortPreference } from './inventorySortPreference.ts';

test('absent or invalid v2 inventory preference defaults to Last rented', () => {
  for (const value of [null, '', 'name', 'price', 'unknown', ' last_rented', 'LAST_RENTED', '{"sort":"name_asc"}'])
    assert.equal(parseInventorySortPreference(value), 'last_rented');
});

test('every explicit supported preference survives subsequent app openings, including source order', () => {
  for (const value of ['default', 'name_asc', 'price_desc', 'price_asc', 'last_rented', 'rental_ending'] as const) {
    assert.equal(parseInventorySortPreference(value), value);
    assert.equal(parseInventorySortPreference(parseInventorySortPreference(value)), value);
  }
});
