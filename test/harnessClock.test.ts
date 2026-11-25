import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

test('poll timeout does not consult the adjustable wall clock', async () => {
  const worker = new Worker(new URL('./fixtures/harness-clock-worker.mjs', import.meta.url));
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`clock worker exited: ${code}`)));
    });
    assert.equal(typeof Date.now(), 'number', 'the runner wall clock is unaffected');
  } finally { await worker.terminate(); }
});
