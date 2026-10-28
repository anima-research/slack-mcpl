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
