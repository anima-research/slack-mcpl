import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';

const firstPage = Array.from({ length: 26 }, (_, i) => ({ id: `U${i + 1}`, name: 'match' }));
const lastPage = { id: 'U27', name: 'match' };
const scenarios = [
  { label: 'empty, no cursor', nonempty: false, next: false },
  { label: 'empty, next cursor', nonempty: false, next: true },
  { label: 'nonempty, no cursor', nonempty: true, next: false },
  { label: 'nonempty, next cursor', nonempty: true, next: true },
] as const;

// Main's results for the four scenarios above: [first-page matches, follows cursor].
// The same test runs against main's adapter (which ignores the new page-limit setting).
const mainCases = [
  { max: 0, expected: [[0, false], [0, false], [1, false], [1, false]] },
  { max: -1, expected: [[0, false], [0, false], [1, false], [1, false]] },
  { max: NaN, expected: [[0, false], [0, true], [26, false], [26, true]] },
  { max: 1.5, expected: [[0, false], [0, true], [2, false], [2, false]] },
  { max: Number.MAX_VALUE, expected: [[0, false], [0, true], [26, false], [26, true]] },
  { max: undefined, expected: [[0, false], [0, true], [25, false], [25, false]] },
  { max: 1, expected: [[0, false], [0, true], [1, false], [1, false]] },
] as const;

for (const { max, expected } of mainCases) {
  for (const [i, { label, nonempty, next }] of scenarios.entries()) {
    test(`unset findUsers matches main: max=${max}, ${label}`, async (t) => {
      const requests: unknown[] = [];
      const adapter = new SlackAdapter({ users: { list: async (args: unknown) => {
        requests.push(args);
        if (requests.length === 1) {
          return { members: nonempty ? firstPage : [], ...(next ? { response_metadata: { next_cursor: 'next' } } : {}) };
        }
        assert.equal(requests.length, 2, 'no request should follow the last page');
        return { members: [lastPage] };
      } } } as never, { on() {}, async disconnect() {} } as never, 'UBOT', 'test',
      undefined, undefined, false, undefined, undefined, undefined, { users: 1 });
      t.after(() => adapter.stop());

      const [count, follows] = expected[i]!;
      const rows = [...firstPage.slice(0, count), ...(follows ? [lastPage] : [])];
      assert.deepEqual(await adapter.findUsers('MATCH', max), rows.map(({ id, name }) => ({
        userId: id, username: name, realName: undefined, displayName: undefined,
      })));
      assert.deepEqual(requests, [
        { limit: 200, cursor: undefined },
        ...(follows ? [{ limit: 200, cursor: 'next' }] : []),
      ]);
    });
  }
}
