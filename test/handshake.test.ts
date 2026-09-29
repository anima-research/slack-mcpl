/**
 * SlackMcplServer — the MCPL 0.5 policy handshake (SPEC §5.3, §5.4, §6.7).
 *
 * Drives the real `SlackMcplServer` over an in-memory stream pair through the
 * actual `initialize` handshake and `featureSets/update` exchange, the same
 * way a host would: the fastest way to see the wire behaviour, mirroring
 * zulip-mcp's test/server.test.ts harness.
 *
 * Run: node --import tsx --test test/handshake.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until } from './harness.js';

// --- plain MCP ---------------------------------------------------------------

test('a plain-MCP client gets no MCPL manifest, and tool calls are ungated', async () => {
  const h = harness();
  const init = await initialize(h, false);
  assert.deepEqual(Object.keys(init.capabilities).sort(), ['tools']);

  const tools = (await h.host.sendRequest('tools/list')) as { tools: { name: string }[] };
  assert.ok(tools.tools.some((t) => t.name === 'send_message'));

  const called = (await h.host.sendRequest('tools/call', {
    name: 'list_channels',
    arguments: {},
  })) as { isError?: boolean };
  assert.notEqual(called.isError, true);

  // MCPL-only methods are not on offer to a client that never negotiated MCPL.
  await assert.rejects(h.host.sendRequest(method.CHANNELS_LIST), /-32601/);

  // No push events for a client that never negotiated MCPL, even on a mention.
  await h.socket.emitMessage(MENTION_EVENT);
  assert.equal(h.hostSaw.length, 0);

  await h.close();
});

// --- MCPL handshake -----------------------------------------------------------

test('featureSets/update is answered with a full-grant receipt, and registration follows it', async () => {
  const h = harness();
  await initialize(h, true);

  // Fail closed before the policy exchange: tools are gated on the `tools`
  // capability, which isn't granted until the grant is ready (§5.3).
  await assert.rejects(
    h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }),
    (err: Error & { code?: number }) => err.code === -32002,
  );
  assert.equal(h.hostSaw.length, 0, 'no channels/register before policy');

  const receipt = (await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
    effectiveCapabilities: FULL_GRANT,
  })) as { accepted: boolean; mode?: string; unavailableFeatures: unknown[] };
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, undefined, 'mode is omitted when nothing degraded (§6.7)');
  assert.deepEqual(receipt.unavailableFeatures, []);

  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
  const registered = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!.params as {
    channels: { id: string }[];
  };
  assert.deepEqual(registered.channels.map((c) => c.id), ['slack:C1']);

  const listed = (await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} })) as {
    isError?: boolean;
  };
  assert.notEqual(listed.isError, true);

  await h.close();
});

test('push events are suppressed before the grant and flow after it (§5.3)', async () => {
  const h = harness();
  await initialize(h, true);

  // Before any featureSets/update, an addressed message must not reach the host.
  await h.socket.emitMessage(MENTION_EVENT);
  assert.equal(h.hostSaw.some((r) => r.method === method.PUSH_EVENT), false);

  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');

  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '222.2' });
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  const pushed = h.hostSaw.find((r) => r.method === method.PUSH_EVENT)!.params as { tags: string[] };
  assert.ok(pushed.tags.includes('chat:mention'));
  assert.ok(pushed.tags.includes('chat:addressed'));

  await h.close();
});

test('a grant missing a capability degrades the feature set and suppresses its delivery (§6.4, §6.7)', async () => {
  const h = harness();
  await initialize(h, true);

  // channels.incoming is part of slack.messaging's `uses`; omitting it
  // disables the whole feature set (§6.4 derivation: one missing capability
  // disables the feature set that needs it).
  const receipt = (await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
    effectiveCapabilities: FULL_GRANT.filter((c) => c !== 'channels.incoming'),
  })) as { mode: string; unavailableFeatures: { featureSet: string; missingCapabilities: string[] }[] };
  assert.equal(receipt.mode, 'degraded');
  const messaging = receipt.unavailableFeatures.find((f) => f.featureSet === 'slack.messaging');
  assert.ok(messaging, 'slack.messaging reported unavailable');
  assert.ok(messaging!.missingCapabilities.includes('channels.incoming'));

  // A messaging tool is unavailable with its feature set (a soft tool error,
  // not an RPC error — §6.7 distinguishes "never granted" from "disabled").
  const send = (await h.host.sendRequest('tools/call', {
    name: 'send_message',
    arguments: { channelId: 'C1', content: 'hi' },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(send.isError, true);
  assert.match(send.content[0].text, /slack\.messaging/);

  // And no delivery reaches the host for an addressed message either.
  await h.socket.emitMessage(MENTION_EVENT);
  assert.equal(h.hostSaw.some((r) => r.method === method.PUSH_EVENT), false);
  assert.equal(h.hostSaw.some((r) => r.method === method.CHANNELS_INCOMING), false);

  await h.close();
});

test('a malformed policy (overlapping effective/denied capabilities) is rejected and fails closed (§5.4)', async () => {
  const h = harness();
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });

  await assert.rejects(
    h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
      effectiveCapabilities: ['tools'],
      deniedCapabilities: ['tools'],
    }),
    (err: Error & { code?: number }) => err.code === -32602,
  );

  // The malformed Request leaves the grant empty, not the previous full one.
  await assert.rejects(
    h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }),
    (err: Error & { code?: number }) => err.code === -32002,
  );

  await h.close();
});

test('a featureSets/update Notification never establishes readiness (§6.7)', async () => {
  const h = harness();
  await initialize(h, true);

  h.host.sendNotification(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  // Give the (synchronous) notification handler a tick, then confirm it did
  // not establish a grant: tools/call still fails closed.
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} }),
    (err: Error & { code?: number }) => err.code === -32002,
  );

  await h.close();
});

test('channels/outgoing/complete posts nothing; the reply arrives once, through channels/publish', async () => {
  const h = harness();
  const init = await initialize(h, true);
  const mcpl = (init.capabilities as any).experimental.mcpl;
  assert.equal(mcpl.channels.streaming, undefined, 'channels.streaming is not declared');

  // Even before the policy exchange, and after it, a completed stream is advisory.
  const complete = { channelId: 'slack:C1', inferenceId: 'i1', content: [{ type: 'text', text: 'hello' }] };
  h.host.sendNotification(method.CHANNELS_OUTGOING_COMPLETE, complete);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  h.host.sendNotification(method.CHANNELS_OUTGOING_COMPLETE, complete);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.posts.length, 0);

  // The same reply through channels/publish posts exactly once.
  await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: complete.content });
  assert.equal(h.posts.length, 1);

  await h.close();
});

test('registration follows a policy that first grants channels.register, even after a refresh under denial', async () => {
  const h = harness();
  await initialize(h, true);
  const registers = () => h.hostSaw.filter((r) => r.method === method.CHANNELS_REGISTER).length;

  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: ['tools'] });
  const refreshed = (await h.host.sendRequest('tools/call', { name: 'refresh_channels', arguments: {} })) as {
    content: { text: string }[];
  };
  assert.match(refreshed.content[0].text, /channels\.register/);
  assert.equal(registers(), 0, 'nothing registered while denied');

  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => registers() === 1, 'channels/register after the grant widened');

  // A repeat of the same grant does not register again.
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(registers(), 1);

  // Denied, then granted again: registers again.
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: ['tools'] });
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => registers() === 2, 'channels/register after a re-grant');

  await h.close();
});
