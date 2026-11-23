import test from 'node:test';
import assert from 'node:assert/strict';
import { clock } from '../src/clock.js';

const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

test('a sleep waits out its time, and holds the process meanwhile unless it is unref', async () => {
  const ended: string[] = [];
  const shorter = new Promise<void>((resolve) => setTimeout(() => { ended.push('a 29 ms timer'); resolve(); }, 29));
  const beforeHeld = timers();
  const held = clock.sleep(30).then(() => { ended.push('the 30 ms sleep'); });
  assert.equal(timers(), beforeHeld + 1, 'a sleep holds the process');
  await Promise.all([shorter, held]);
  assert.deepEqual(ended, ['a 29 ms timer', 'the 30 ms sleep'], 'the sleep ends after a shorter timer set before it');

  const beforeUnref = timers();
  const unref = clock.sleep(30, { unref: true });
  assert.equal(timers(), beforeUnref, 'an unref sleep does not hold the process');
  const holding = setTimeout(() => {}, 1000);
  await unref;
  clearTimeout(holding);
});

test('abort wakes a real referenced sleep and removes its timer and listener', async () => {
  const { default: EventEmitter } = await import('node:events');
  const getEventListeners = EventEmitter.getEventListeners;
  const controller = new AbortController();
  const before = timers();
  const pending = clock.sleep(60000, { signal: controller.signal });
  assert.equal(timers(), before + 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(); await pending;
  assert.equal(timers(), before);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await clock.sleep(60000, { signal: controller.signal });
  assert.equal(timers(), before, 'already-aborted sleep never arms a timer');
});

test('abortable sleeps resolve and remove listeners on every exit path', async () => {
  const { EventEmitter } = await import('node:events');
  const getEventListeners = EventEmitter.getEventListeners;
  const already = new AbortController();
  already.abort();
  await clock.sleep(60_000, { signal: already.signal });
  assert.equal(getEventListeners(already.signal, 'abort').length, 0);
  const pending = new AbortController();
  const sleep = clock.sleep(60_000, { signal: pending.signal });
  assert.equal(getEventListeners(pending.signal, 'abort').length, 1);
  pending.abort();
  await sleep;
  assert.equal(getEventListeners(pending.signal, 'abort').length, 0);
  const completed = new AbortController();
  await clock.sleep(1, { signal: completed.signal });
  assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
});
