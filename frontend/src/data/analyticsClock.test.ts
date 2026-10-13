import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_CLOCK_SKEW_MS, validAnalyticsCapture, watchAnalyticsClock } from './analyticsClock.ts';

test('capture validation allows small clock differences but rejects invalid or genuinely future evidence', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(validAnalyticsCapture(new Date(now + 5_000).toISOString(), now), true);
  assert.equal(validAnalyticsCapture(new Date(now + ANALYTICS_CLOCK_SKEW_MS).toISOString(), now), true);
  assert.equal(validAnalyticsCapture(new Date(now + ANALYTICS_CLOCK_SKEW_MS + 1).toISOString(), now), false);
  for (const value of [undefined, null, '', 'not a date']) assert.equal(validAnalyticsCapture(value, now), false);
  assert.equal(validAnalyticsCapture(new Date(now).toISOString(), NaN), false);
});

test('the analytics clock revalidates on time, focus and foreground and stops while hidden or unmounted', () => {
  let now = 1_000, visible = true, tick: (() => void) | null = null;
  let visibility: (() => void) | null = null, focus: (() => void) | null = null;
  const observed: number[] = [], captures: boolean[] = [];
  const capture = new Date(40_000).toISOString();
  const stop = watchAnalyticsClock(value => { observed.push(value); captures.push(validAnalyticsCapture(capture, value)); }, {
    now: () => now, visible: () => visible,
    onVisibility: callback => { visibility = callback; return () => { visibility = null; }; },
    onFocus: callback => { focus = callback; return () => { focus = null; }; },
    everyMinute: callback => { assert.equal(tick, null); tick = callback; return () => { tick = null; }; },
  });
  const fire = (value: (() => void) | null) => { assert.ok(value); value(); };
  assert.deepEqual(captures, [false]);
  now = 61_000; fire(tick); assert.deepEqual(captures, [false, true], 'an initially rejected capture becomes available without replacing the report');
  now = 65_000; fire(focus); assert.equal(observed.at(-1), now);
  visible = false; fire(visibility); assert.equal(tick, null);
  now = 120_000; fire(focus); assert.equal(observed.at(-1), 65_000, 'hidden focus does not run an update');
  visible = true; fire(visibility); assert.equal(observed.at(-1), now); assert.ok(tick);
  stop(); assert.equal(tick, null); assert.equal(visibility, null); assert.equal(focus, null);
});
