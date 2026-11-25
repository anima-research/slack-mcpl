// Shared capture run against both the frozen #65 tree and the current tree.
import { pathToFileURL } from 'node:url';
delete process.env.SLACK_SUBSCRIPTIONS_FILE;
const root = process.argv[2];
const { harness, initialize, until, FULL_GRANT, MENTION_EVENT } = await import(pathToFileURL(`${root}/test/harness.ts`).href);
const { clock } = await import(pathToFileURL(`${root}/src/clock.ts`).href);
const snapshots = [];
for (const member of [false, true]) for (const tools of [false, true]) for (const lane of ['push/event', 'channels/incoming']) {
  const h = harness({ subscribeMemberChannels: member });
  try {
    const initialized = await initialize(h, true);
    await h.host.sendRequest('featureSets/update', { effectiveCapabilities: FULL_GRANT, disabled: tools ? [] : ['slack.subscriptions'] });
    await until(() => h.hostSaw.some(r => r.method === 'channels/register'), 'registration');
    if (lane === 'channels/incoming') await h.host.sendRequest('channels/open', { channelId: 'slack:C1' });
    await h.socket.emitMessage(MENTION_EVENT);
    await until(() => h.hostSaw.some(r => r.method === lane), 'delivery');
    await h.server.forwarding.get('C1');
    const params = h.hostSaw.find(r => r.method === lane).params;
    const content = lane === 'push/event' ? params.payload.content : params.messages[0].content;
    const results = [];
    const call = (name) => h.server.handleToolCall(name, { channelId: 'C1' });
    // Cover empty, subscribed/muted, duplicate and inverse operation results.
    for (const name of ['list_subscriptions', 'unsubscribe_channel', 'unsubscribe_channel', 'list_subscriptions',
      'subscribe_channel', 'subscribe_channel', 'list_subscriptions', 'unsubscribe_channel', 'list_subscriptions']) {
      results.push(await call(name));
    }
    const refresh = [];
    for (const seconds of [6.999, 0, -1, 30]) {
      h.server.slack.listConversations = async () => ({ conversations: [{ id: 'DNEW', name: 'UNEW', userId: 'UNEW',
        kind: 'dm', isMember: true, nameWait: { method: 'users.info', why: 'limited', seconds } }], leftOut: [] });
      refresh.push(await h.server.refreshChannels());
    }
    const retries = [];
    const sleep = clock.sleep;
    const error = console.error;
    try {
      for (const seconds of [1.0011, 0, -1, 2_592_000]) {
        const logs = [], sleeps = [];
        clock.sleep = async (ms, options) => { sleeps.push({ ms, options }); };
        console.error = line => logs.push(line);
        await h.server.waitToAskAgain({ method: 'users.info', seconds, why: 'limited' }, 1, () => true);
        retries.push({ logs, sleeps });
      }
    } finally { clock.sleep = sleep; console.error = error; }
    snapshots.push({ member, tools, lane, refresh, retries, ...(snapshots.length === 0 ? { capabilities: initialized.capabilities, toolText: h.server.offeredTools() } : {}), content, results });
  } finally { await h.close(); }
}
process.stdout.write(JSON.stringify(snapshots, null, 2));
