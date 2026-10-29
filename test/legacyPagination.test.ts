import test from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, joined } from './adapterAccessFixture.js';

for (const kind of ['listing', 'directory', 'history'] as const) {
  for (const cyclic of [true, false]) test(`legacy ${kind}: ${cyclic ? 'repeated cursor refuses' : '1002 distinct pages complete'}`, async () => {
    const f = accessFixture({ legacy: true, pagination: { conversations: 1002, users: 1002, backscroll: 1002 } });
    let pages = 0;
    const metadata = () => {
      if (++pages > 1003) throw new Error('test safety ceiling');
      return { next_cursor: cyclic ? 'same' : pages < 1002 ? String(pages) : '' };
    };
    f.web.conversations.list = async () => ({ channels: [joined()], response_metadata: metadata() });
    f.web.users.list = async () => ({ members: [], response_metadata: metadata() });
    f.web.conversations.history = async () => ({ messages: [], response_metadata: metadata() });
    const run = kind === 'listing' ? f.adapter.listConversations()
      : kind === 'directory' ? f.adapter.findUsers('nobody') : f.adapter.fetchHistory('C1', {});
    if (cyclic) { await assert.rejects(run, /cursor cycle/); assert.equal(pages, 2); }
    else { await run; assert.equal(pages, 1002); }
  });
}
