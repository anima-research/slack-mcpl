import { ownedTest as test } from './adapterAccessFixture.js';
import assert from 'node:assert/strict';
import { accessFixture, joined } from './adapterAccessFixture.js';

for (const kind of ['listing', 'directory', 'history'] as const) {
  for (const cyclic of [true, false]) test(`legacy ${kind}: ${cyclic ? 'repeated cursor returns page-limited incomplete result' : '1002 distinct pages complete'}`, async () => {
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
      : kind === 'directory' ? f.adapter.findUsersBounded('nobody') : f.adapter.fetchHistory('C1', {});
    if (cyclic) {
      const result: any = await run; assert.equal(pages, 1002);
      if (kind === 'listing') assert.deepEqual(result.truncation, { reason: 'page_limit', pages: 1002, limit: 1002 });
      else if (kind === 'directory') assert.deepEqual(result, { matches: [], truncated: true, reason: 'page_limit', pages: 1002, limit: 1002 });
      else assert.deepEqual(result, { messages: [], truncated: true, stopReason: 'page_limit' });
    }
    else {
      const result = await run;
      assert.equal(pages, 1002);
      if (kind === 'directory') assert.ok(Array.isArray(result), 'complete directory is an array, not a truncated result');
      if (kind === 'listing') assert.equal((result as { truncation?: unknown }).truncation, undefined);
      if (kind === 'history') assert.equal((result as { truncated: boolean }).truncated, false);
    }
  });
}

test('legacy listing keeps main sequencing: a scope change during a page asks the next page before restarting', async () => {

  const f = accessFixture({ legacy: true, scopes: ['channels:read', 'im:read'] });
  const asked: Array<[unknown, unknown]> = [];
  let page = 0;
  f.web.conversations.list = async (args: any) => {
    asked.push([args.types, args.cursor]);
    page++;
    return page === 1 ? { channels: [{ id: 'D1', is_im: true, user: 'U1' }], response_metadata: { next_cursor: 'c2' } } : { channels: [] };
  };
  f.web.users.info = async () => { (f.adapter as any).takeScopes(['groups:read']); return { user: { name: 'human' } }; };
  await f.adapter.listConversations();
  assert.deepEqual(asked.slice(0, 3), [['public_channel,im', undefined], ['public_channel,im', 'c2'], ['public_channel,private_channel,im', undefined]]);
});
