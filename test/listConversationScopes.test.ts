import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';

function fixture(scopes: string[] | undefined, disableDms = false, responses: any[] = []) {
  const calls: Record<string, unknown>[] = [];
  const web = { conversations: { async list(args: Record<string, unknown>) {
    calls.push(args);
    return responses.shift() ?? { channels: [] };
  } } } as any;
  const socket = { on() {} } as any;
  return { calls, adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, undefined, disableDms, undefined, scopes) };
}

const cases = [
  { name: 'without group-DM scope', scopes: ['channels:read', 'groups:read', 'im:read'], types: 'public_channel,private_channel,im' },
  { name: 'without DM scope', scopes: ['channels:read', 'groups:read', 'mpim:read'], types: 'public_channel,private_channel,mpim' },
  { name: 'all four scopes', scopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'], types: 'public_channel,private_channel,im,mpim' },
  { name: 'public channels only', scopes: ['channels:read'], types: 'public_channel' },
  { name: 'private channels only', scopes: ['groups:read'], types: 'private_channel' },
  { name: 'DMs disabled with all scopes', scopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'], disableDms: true, types: 'public_channel,private_channel' },
  { name: 'no readable scopes', scopes: ['chat:write'], types: '' },
  { name: 'explicitly empty scopes', scopes: [], types: '' },
  { name: 'DMs disabled with only DM scopes', scopes: ['im:read', 'mpim:read'], disableDms: true, types: '' },
  { name: 'unknown scopes keep legacy request', scopes: undefined, types: 'public_channel,private_channel,im,mpim' },
];
for (const row of cases) {
  test(`conversation scope matrix: ${row.name}`, async () => {
    const { adapter, calls } = fixture(row.scopes, row.disableDms);
    assert.deepEqual(await adapter.listConversations(), []);
    assert.equal(calls.length, row.types ? 1 : 0);
    if (row.types) assert.equal(calls[0].types, row.types);
  });
}

test('listing response refreshes scopes for the next listing without another request', async () => {
  const initial = ['channels:read', 'groups:read', 'im:read'];
  const updated = [...initial, 'mpim:read'];
  const { adapter, calls } = fixture(initial, false, [
    { channels: [], response_metadata: { scopes: initial, next_cursor: 'page2' } },
    { channels: [], response_metadata: { scopes: updated } },
    { channels: [], response_metadata: { scopes: updated } },
  ]);
  await adapter.listConversations();
  await adapter.listConversations();
  assert.deepEqual(calls.map((call) => call.types), [
    'public_channel,private_channel,im', 'public_channel,private_channel,im',
    'public_channel,private_channel,im,mpim',
  ]);
  assert.equal(calls[1].cursor, 'page2');
});

test('omitted or malformed scope metadata never widens the last known scope set', async () => {
  const { adapter, calls } = fixture(['channels:read'], false, [
    { response_metadata: {} }, { response_metadata: { scopes: 'groups:read' } },
    { response_metadata: { scopes: ['groups:read', null] } }, {},
  ]);
  for (let i = 0; i < 4; i++) await adapter.listConversations();
  assert.deepEqual(calls.map((call) => call.types), Array(4).fill('public_channel'));
});

test('an explicit empty listing scope set prevents subsequent listing calls', async () => {
  const { adapter, calls } = fixture(['channels:read'], false, [
    { channels: [], response_metadata: { scopes: [] } },
  ]);
  await adapter.listConversations();
  await adapter.listConversations();
  assert.equal(calls.length, 1);
});

test('connection emits one diagnostic naming each omitted type and its required scope', async (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => messages.push(args.join(' ')));
  const { adapter } = fixture(['chat:write']);
  await adapter.listConversations();
  await adapter.listConversations();
  assert.equal(messages.length, 1);
  for (const [type, scope] of [
    ['public_channel', 'channels:read'], ['private_channel', 'groups:read'],
    ['im', 'im:read'], ['mpim', 'mpim:read'],
  ]) assert.ok(messages[0].includes(`${type} (requires ${scope})`), messages[0]);
});
