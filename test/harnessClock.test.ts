import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './harness.js';

test('poll timeout does not consult the adjustable wall clock', async () => {
  const now = Date.now;
  Date.now = () => { throw new Error('wall clock consulted'); };
  try {
    await assert.rejects(until(() => false, 'monotonic timeout', 1),
      /timed out waiting for monotonic timeout/);
  } finally {
    Date.now = now;
  }
});
