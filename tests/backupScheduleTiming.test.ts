import assert from 'node:assert/strict';
import test from 'node:test';
import { backupScheduleTiming } from '../src/server/backupControl.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test('weekly backup waits through each 24-hour timer chunk', () => {
  const start = Date.UTC(2026, 9, 28, 21, 30);
  const nextAt = start + 7 * DAY;
  assert.deepEqual(backupScheduleTiming(nextAt, start), { delayMs: DAY, isDue: false });
  assert.deepEqual(backupScheduleTiming(nextAt, start + DAY), { delayMs: DAY, isDue: false });
  assert.deepEqual(backupScheduleTiming(nextAt, start + 6 * DAY), { delayMs: DAY, isDue: false });
  assert.deepEqual(backupScheduleTiming(nextAt, nextAt - 100), { delayMs: 1000, isDue: false });
  assert.deepEqual(backupScheduleTiming(nextAt, nextAt), { delayMs: 1000, isDue: true });
});

test('hourly schedule and missed deadlines preserve their due status', () => {
  const now = Date.UTC(2026, 9, 28);
  assert.deepEqual(backupScheduleTiming(now + HOUR, now), { delayMs: HOUR, isDue: false });
  assert.deepEqual(backupScheduleTiming(now - HOUR, now), { delayMs: 1000, isDue: true });
});
