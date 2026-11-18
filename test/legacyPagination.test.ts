import test from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, joined } from './adapterAccessFixture.js';

for (const kind of ['listing', 'directory'] as const) {
  for (const cyclic of [true, false]) test(`legacy ${kind}: ${cyclic ? 'repeated cursor preserves main behavior' : '1002 distinct pages complete'}`, async () => {
    const f = accessFixture({ legacy: true });
    let pages = 0;
    const metadata = () => {
      if (++pages > 1003) throw new Error('test safety ceiling');
      return { next_cursor: cyclic ? 'same' : pages < 1002 ? String(pages) : '' };
    };
    f.web.conversations.list = async () => ({ channels: [joined()], response_metadata: metadata() });
    f.web.users.list = async () => ({ members: [], response_metadata: metadata() });
    const run = kind === 'listing' ? f.adapter.listConversations()
      : f.adapter.findUsers('nobody');
    if (cyclic) { await assert.rejects(run, /test safety ceiling/); assert.equal(pages, 1004); }
    else { await run; assert.equal(pages, 1002); }
  });
}
