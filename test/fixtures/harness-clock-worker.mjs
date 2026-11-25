import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { until } = await tsImport('../harness.ts', import.meta.url);
const now = Date.now;
Date.now = () => { throw new Error('wall clock consulted'); };
try {
  await assert.rejects(until(() => false, 'monotonic timeout', 1),
    /timed out waiting for monotonic timeout/);
} finally {
  Date.now = now;
}
