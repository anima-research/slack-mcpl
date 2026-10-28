import type { TestContext } from 'node:test';
import { clock } from '../src/clock.js';

let advance: ((ms: number) => void) | undefined;

export function virtualClock(t: TestContext): { slept: number[] } {
  const base = Date.now();
  let offset = 0;
  const slept: number[] = [];
  t.mock.method(clock, 'now', () => base + offset);
  t.mock.method(clock, 'sleep', async (ms: number) => {
    slept.push(ms);
    offset += ms;
  });
  advance = (ms) => { offset += ms; };
  t.after(() => { advance = undefined; });
  return { slept };
}

export function elapse(ms: number): void {
  if (!advance) throw new Error('elapseMs needs virtualClock(t) in its test');
  advance(ms);
}
