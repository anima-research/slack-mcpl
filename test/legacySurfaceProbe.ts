/** Shared probe, also run verbatim against the independent main export. */
import { harness, initialize } from './harness.js';
import { backscrollLine } from '../src/server.js';
import { buildFeatureSets } from '../src/feature-sets.js';
export async function legacySurfaceProbe() {
  const h = harness({ subscribeMemberChannels: true });
  try {
    await initialize(h, false);
    const call = (name: string, args: Record<string, unknown> = {}) => h.host.sendRequest('tools/call', { name, arguments: args });
    return {
      legacyBackscroll: backscrollLine({ id: '1.0', timestamp: new Date(0), authorName: 'Ann', content: 'hi',
        attachments: [{ name: 'note', channelId: 'C1' } as { name: string }] }),
      features: buildFeatureSets(),
      tools: await h.host.sendRequest('tools/list'),
      mute: await call('unsubscribe_channel', { channelId: 'C1' }),
      unmute: await call('subscribe_channel', { channelId: 'C1' }),
      subscriptions: await call('list_subscriptions'),
      listing: await call('list_channels'),
      // MCPL also offers refresh_channels: pin that definition too.
      mcplTools: await mcplToolList(),
    };
  } finally { await h.close(); }
}

async function mcplToolList() {
  const h = harness({ subscribeMemberChannels: true });
  try {
    await initialize(h, true);
    return await h.host.sendRequest('tools/list');
  } finally { await h.close(); }
}
