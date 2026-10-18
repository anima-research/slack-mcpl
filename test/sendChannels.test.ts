/**
 * Tests for the SLACK_SEND_CHANNELS write allow-list.
 *
 * Run: node --import tsx --test test/sendChannels.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { uploadEndpoint } from './harness.js';

function makeAdapter(sendChannels?: string[]) {
  const calls: string[] = [];
  const record = (name: string) => async ({ channel }: { channel: string }) => {
    calls.push(`${name}:${channel}`);
    return { ts: '1.0' };
  };
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { postMessage: record('post'), update: record('update'), delete: record('delete') },
    reactions: { add: record('react') },
    conversations: { open: async () => ({ channel: { id: 'D9' } }) },
  } as any;
  return { adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, sendChannels), calls };
}

/** The refusal names what didn't happen, the allowed ids, and who decides; never the setting's name. */
const refusal = (notDone: string) =>
  `${notDone}: this bot may write only to CALLOWED, and COTHER isn't one of them. list_channels marks the ` +
  "conversations it may write to with writable: true. Calling again won't change that; whoever runs this host " +
  'decides where it may write.';

const noDm =
  "Nothing was sent: this bot may write only to CALLOWED, none of them a direct message, so send_dm can't reach " +
  "anyone. Calling again won't change that; whoever runs this host decides where it may write. To reach people, " +
  'post in a channel with send_message; list_channels marks where this bot may write with writable: true.';

test('writes outside the allow-list are refused before reaching Slack', async () => {
  const { adapter, calls } = makeAdapter(['CALLOWED']);
  await assert.rejects(adapter.sendMessage('COTHER', 'hi'), { message: refusal('Nothing was posted') });
  await assert.rejects(adapter.editMessage('COTHER', '1.0', 'hi'), { message: refusal("The message wasn't changed") });
  await assert.rejects(adapter.deleteMessage('COTHER', '1.0'), { message: refusal('Nothing was deleted') });
  await assert.rejects(adapter.addReaction('COTHER', '1.0', 'eyes'), { message: refusal('No reaction was added') });
  await assert.rejects(adapter.sendDM('U1', 'hi'), { message: noDm });
  assert.deepEqual(calls, []);
});

test('writes to an allow-listed conversation pass', async () => {
  const { adapter, calls } = makeAdapter(['CALLOWED']);
  await adapter.sendMessage('CALLOWED', 'hi');
  assert.deepEqual(calls, ['post:CALLOWED']);
});

test('no allow-list means no restriction', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.sendMessage('CANY', 'hi');
  await adapter.sendDM('U1', 'hi');
  assert.deepEqual(calls, ['post:CANY', 'post:D9']);
});

test("send_dm to a DM the allow-list doesn't name says nothing was sent", async () => {
  // The list names a DM, D8, so the DM is opened; Slack opens D9.
  const { adapter, calls } = makeAdapter(['D8']);
  await assert.rejects(adapter.sendDM('U1', 'hi'), (err: Error) => {
    assert.match(err.message, /^Nothing was sent: this bot may write only to D8, and D9 isn't one of them\./);
    return true;
  });
  assert.deepEqual(calls, [], 'nothing is posted');
});

test('send_dm is refused before a conversation is opened when the list names no DM', async () => {
  const calls: string[] = [];
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { postMessage: async () => { calls.push('post'); return { ts: '1.0' }; } },
    conversations: { open: async () => { calls.push('open'); return { channel: { id: 'D9' } }; } },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, ['CALLOWED']);
  await assert.rejects(adapter.sendDM('UNEW', 'hi'), { message: noDm });
  assert.deepEqual(calls, []);
});

test('send_dm says so when Slack opens no DM', async () => {
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = { conversations: { open: async () => ({ channel: {} }) } } as any;
  await assert.rejects(new SlackAdapter(web, socket, 'UBOT', 'acme').sendDM('U1', 'hi'), {
    message:
      "Nothing was sent: Slack opened no DM with user U1. Check the id with find_user, which returns each person's " +
      'userId, and call again.',
  });
});

test('canWrite follows the allow-list', () => {
  const { adapter } = makeAdapter(['CALLOWED']);
  assert.equal(adapter.canWrite('CALLOWED'), true);
  assert.equal(adapter.canWrite('COTHER'), false);
  assert.equal(makeAdapter().adapter.canWrite('COTHER'), true);
});

test('upload_file follows the allow-list and passes the file to Slack', async () => {
  const asked: any[] = [];
  const shared: any[] = [];
  const socket = { on() {} } as any;
  const { url, bytes } = await uploadEndpoint();
  const web = {
    files: {
      getUploadURLExternal: async (args: any) => { asked.push(args); return { upload_url: `${url}/FSC1`, file_id: 'FSC1' }; },
      completeUploadExternal: async (args: any) => { shared.push(args); return { files: [{ id: 'FSC1' }] }; },
    },
  } as any;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, ['CALLOWED']);
  await assert.rejects(adapter.uploadFile('COTHER', { filename: 'a.csv', data: Buffer.from('x') }), {
    message: refusal('Nothing was uploaded'),
  });
  assert.equal(asked.length, 0);
  const r = await adapter.uploadFile('CALLOWED', { filename: 'a.csv', data: Buffer.from('a,b'), threadTs: '1.0', comment: 'please load:' });
  assert.equal(r.fileId, 'FSC1');
  assert.deepEqual(asked[0], { filename: 'a.csv', length: 3 });
  assert.deepEqual(bytes.get('FSC1'), Buffer.from('a,b'));
  assert.deepEqual(shared[0], {
    files: [{ id: 'FSC1', title: 'a.csv' }], channel_id: 'CALLOWED', initial_comment: 'please load:', thread_ts: '1.0',
  });
});
