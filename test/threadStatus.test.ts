/**
 * channels/typing shown as a Slack thread status ("is thinking…").
 *
 * Run: node --import tsx --test test/threadStatus.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter } from '../src/slack-adapter.js';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until, type Harness } from './harness.js';

function makeAdapter(sendChannels?: string[]) {
  const calls: string[] = [];
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    chat: { postMessage: async () => ({ ts: '9.0' }) },
    reactions: { add: async () => {}, remove: async () => {} },
    assistant: {
      threads: {
        setStatus: async ({ channel_id, thread_ts, status }: any) => {
          calls.push(`${channel_id}:${thread_ts}:${status}`);
        },
      },
    },
  } as any;
  return { adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, sendChannels), calls };
}

test('set once, not again on the host refresh, cleared on stop', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', undefined);
  await adapter.setThreadStatus('C1', undefined);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

test('moving to another thread clears the old one first', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', '2.0');
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:', 'C1:2.0:is thinking…']);
});

test('nothing outside the write allow-list', async () => {
  const { adapter, calls } = makeAdapter(['C9']);
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', undefined);
  assert.deepEqual(calls, []);
});

test('a post in the thread ends the status, so the next refresh sets it again', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.sendMessage('C1', 'partial answer', { threadTs: '1.0' });
  await adapter.setThreadStatus('C1', '1.0');
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:is thinking…']);
});

async function ready(h: Harness, grant = FULL_GRANT) {
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: grant });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
}

test('host typing lands on the thread of the message that woke the agent', async () => {
  const h = harness();
  await ready(h);
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '5.0', thread_ts: '4.0' });
  h.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1', op: 'start' });
  await until(() => h.statuses.length === 1, 'status set');
  h.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1', op: 'stop' });
  await until(() => h.statuses.length === 2, 'status cleared');
  assert.deepEqual(h.statuses, ['C1:4.0:is thinking…', 'C1:4.0:']);
  await h.close();
});

test('a top-level message gets the status on its own thread', async () => {
  const h = harness();
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  h.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1' });
  await until(() => h.statuses.length === 1, 'status set');
  assert.deepEqual(h.statuses, [`C1:${MENTION_EVENT.ts}:is thinking…`]);
  await h.close();
});
