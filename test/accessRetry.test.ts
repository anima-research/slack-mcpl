import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@slack/web-api';
import { method, type ChannelsListResult } from '@animalabs/mcpl-core';
import { SlackMcplServer } from '../src/server.js';
import type { SlackWaitOut } from '../src/slack-adapter.js';
import { accessFixture, joined } from './adapterAccessFixture.js';
import { connectHost, initialize, FULL_GRANT, until } from './harness.js';
import { virtualClock } from './virtualClock.js';

const limited = () => Object.assign(new Error('retryable'), { code: ErrorCode.RateLimitedError, retryAfter: 1 });

for (const legacy of [true, false]) test(legacy
  ? 'real registration gives up once on three failing DM names at REGISTRATION_TRIES'
  : 'real registration admits 25 candidates that each recover after one retry', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const time = virtualClock(t);
  const f = accessFixture({ legacy });
  const attempts = new Map<string, number>();
  if (legacy) {
    f.state.listed = ['1', '3', '4'].map((id) => ({ id: `D${id}`, user: `U${id}`, is_im: true }));
    f.web.users.info = async ({ user }) => {
      attempts.set(user, (attempts.get(user) ?? 0) + 1);
      if (attempts.get(user)! > 12) throw new Error('test safety ceiling');
      throw limited();
    };
  } else {
    f.state.listed = Array.from({ length: 25 }, (_, i) => joined(`C${i + 1}`));
    f.web.conversations.info = async ({ channel }) => {
      const count = (attempts.get(channel) ?? 0) + 1; attempts.set(channel, count);
      if (count === 1) throw limited();
      return { channel: joined(channel) };
    };
  }
  const waits: number[] = [];
  const listing = f.adapter.listConversations.bind(f.adapter);
  t.mock.method(f.adapter, 'listConversations', (include = false, wait?: SlackWaitOut) =>
    listing(include, async (why, n) => { waits.push(n); await wait!(why, n); }));
  const server = new SlackMcplServer(f.adapter);
  const h = connectHost(server); t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => (server as unknown as { registering?: unknown }).registering === undefined, 'registration to finish');
  const registered = (await h.host.sendRequest(method.CHANNELS_LIST)) as ChannelsListResult;
  assert.deepEqual(registered.channels.map((c) => c.id), f.state.listed.map((c) => `slack:${c.id}`));
  const lines = log.mock.calls.map((call) => call.arguments.join(' '));
  if (legacy) {
    // This invokes the real server waiter, including its REGISTRATION_TRIES = 10 threshold.
    assert.deepEqual(waits, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(time.slept.length, 9); // the tenth call throws GaveUp before sleeping
    assert.deepEqual([...attempts], [['U1', 10], ['U3', 1], ['U4', 1]]);
    assert.equal(lines.filter((line) => line.includes('Gave up on the name')).length, 1);
    assert.deepEqual(registered.channels.map((c) => c.label), ['DM: @U1 (test)', 'DM: @U3 (test)', 'DM: @U4 (test)']);
  } else {
    assert.deepEqual(waits, Array(25).fill(1));
    assert.deepEqual([...attempts.values()], Array(25).fill(2));
    assert.equal(time.slept.length, 25);
    assert.ok(!lines.some((line) => /Gave up|registration stopped/.test(line)));
  }
});
