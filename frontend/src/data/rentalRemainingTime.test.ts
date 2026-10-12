import test from 'node:test';
import assert from 'node:assert/strict';
import { rentalRemainingTime } from './rentalRemainingTime.ts';

const now = Date.parse('2026-10-11T12:00:00Z');
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

test('remaining time uses compact day, hour and minute labels', () => {
  for (const [remaining, label] of [
    [6 * day + 23 * hour + 59 * minute, '6d23h'],
    [4 * hour + 12 * minute + 59_000, '4h12m'],
    [23 * minute + 59_000, '23m'],
    [59_999, '<1m'],
    [1, '<1m'],
  ] as const) {
    assert.equal(rentalRemainingTime(now + remaining, now)?.label, label);
  }
});

test('unknown, invalid and expired timestamps never fabricate remaining time', () => {
  for (const expiresAt of [null, 0, -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER, now, now - 1]) {
    assert.equal(rentalRemainingTime(expiresAt, now), null, String(expiresAt));
  }
  for (const invalidNow of [NaN, Infinity, -Infinity, -1, 1.5]) {
    assert.equal(rentalRemainingTime(now + hour, invalidNow), null, String(invalidNow));
  }
  assert.equal(rentalRemainingTime('123' as unknown as number, now), null);
});

test('minute labels schedule only their next visible change, with expiry below one minute', () => {
  const expiresAt = now + 23 * minute + 12_345;
  const result = rentalRemainingTime(expiresAt, now);
  assert.deepEqual(result, { label: '23m', nextUpdateAt: now + 12_346 });
  assert.equal(rentalRemainingTime(expiresAt, result!.nextUpdateAt - 1)?.label, '23m');
  assert.equal(rentalRemainingTime(expiresAt, result!.nextUpdateAt)?.label, '22m');
  assert.deepEqual(rentalRemainingTime(now + 59_999, now), { label: '<1m', nextUpdateAt: now + 59_999 });
  assert.equal(rentalRemainingTime(now + 59_999, now + 59_999), null);
});

test('hour and day labels transition at the exact floored unit boundaries', () => {
  for (const [remaining, before, after] of [
    [minute, '1m', '<1m'],
    [hour, '1h0m', '59m'],
    [day, '1d0h', '23h59m'],
    [2 * day, '2d0h', '1d23h'],
  ] as const) {
    const expiresAt = now + remaining;
    assert.deepEqual(rentalRemainingTime(expiresAt, now), { label: before, nextUpdateAt: now + 1 });
    assert.equal(rentalRemainingTime(expiresAt, now + 1)?.label, after);
  }
});

test('day labels do not update when only their hidden minutes change', () => {
  const expiresAt = now + 6 * day + 23 * hour + 37 * minute + 12_345;
  const result = rentalRemainingTime(expiresAt, now);
  assert.deepEqual(result, { label: '6d23h', nextUpdateAt: now + 37 * minute + 12_346 });
  assert.equal(rentalRemainingTime(expiresAt, now + 20 * minute)?.label, '6d23h');
  assert.equal(rentalRemainingTime(expiresAt, result!.nextUpdateAt - 1)?.label, '6d23h');
  assert.equal(rentalRemainingTime(expiresAt, result!.nextUpdateAt)?.label, '6d22h');
});

test('very long rentals stay capped until the 99-day threshold', () => {
  const expiresAt = now + 130 * day + 4 * hour;
  const result = rentalRemainingTime(expiresAt, now);
  assert.deepEqual(result, { label: '99d+', nextUpdateAt: expiresAt - 99 * day });
  assert.equal(rentalRemainingTime(expiresAt, result!.nextUpdateAt - 1)?.label, '99d+');
  assert.deepEqual(rentalRemainingTime(expiresAt, result!.nextUpdateAt), { label: '99d0h', nextUpdateAt: result!.nextUpdateAt + 1 });
  assert.equal(rentalRemainingTime(expiresAt, result!.nextUpdateAt + 1)?.label, '98d23h');
});

test('every scheduled timestamp is in the future and does not pass expiration', () => {
  for (const remaining of [1, minute - 1, minute, minute + 1, hour - 1, hour, hour + 1, day - 1, day, day + 1, 99 * day, 100 * day]) {
    const result = rentalRemainingTime(now + remaining, now)!;
    assert.ok(result.nextUpdateAt > now, String(remaining));
    assert.ok(result.nextUpdateAt <= now + remaining, String(remaining));
  }
});
