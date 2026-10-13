import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersonalRentalAnalyticsAllTime, PersonalRentalAnalytics } from './types.ts';
import { analyticsReadLimitMessage } from './analyticsReadCoverage.ts';

const history = (read_coverage?: PersonalRentalAnalyticsAllTime['read_coverage']) => ({ report_kind: 'all_time', read_coverage }) as PersonalRentalAnalyticsAllTime;
const complete = { daily_limited: false, items_limited: false, collections_limited: false };

test('legacy and complete history add no read-limit warnings to the normal view', () => {
  for (const report of [undefined, null, history(), history(complete), {} as PersonalRentalAnalytics]) {
    for (const section of ['daily', 'items', 'collections'] as const) assert.equal(analyticsReadLimitMessage(report, section), null);
  }
});

test('each read limit identifies which figures are partial without claiming saved data was lost', () => {
  const expected = {
    daily: 'Limited history preview. Totals and chart cover loaded days only; all saved data is retained.',
    items: 'Limited history preview. Gift totals cover loaded reports only; all saved data is retained.',
    collections: 'Limited history preview. Collection totals cover loaded reports only; all saved data is retained.',
  };
  for (const section of ['daily', 'items', 'collections'] as const) {
    const report = history({ ...complete, [`${section}_limited`]: true });
    assert.equal(analyticsReadLimitMessage(report, section), expected[section]);
    assert.doesNotMatch(analyticsReadLimitMessage(report, section)!, /refresh|reload|deleted/i);
    for (const other of ['daily', 'items', 'collections'] as const) {
      if (other !== section) assert.equal(analyticsReadLimitMessage(report, other), null);
    }
  }
});

test('only explicit all-time read-limit flags produce a warning', () => {
  const report = { read_coverage: { ...complete, daily_limited: true } } as unknown as PersonalRentalAnalytics;
  assert.equal(analyticsReadLimitMessage(report, 'daily'), null);
  const invalid = history({ ...complete, items_limited: 'true' as unknown as boolean });
  assert.equal(analyticsReadLimitMessage(invalid, 'items'), null);
});
