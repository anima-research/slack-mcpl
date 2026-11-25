/** Bot-policy extension kept separate from the protected readable-payload harness. */
import { SlackAdapter, type SlackAdapterConfig } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { fakeSlack, connectHost, type HarnessOptions, type Harness } from './harness.js';
export { FULL_GRANT, MENTION_EVENT, initialize, until } from './harness.js';

export function harness(opts: HarnessOptions & { botMessages?: SlackAdapterConfig['botMessages'] } = {}): Harness {
  const base = fakeSlack(opts);
  // Reuse the base fake Web API and recording arrays, but install the policy
  // through the real constructor so startup guards are exercised too.
  const web = (base.slack as any).web;
  const slack = new SlackAdapter(web, base.socket, 'UBOT', 'acme', undefined,
    opts.sendChannels, opts.disableDms, opts.ackReaction, opts.scopes, undefined, undefined, opts.botMessages, 'BSELF');
  const server = new SlackMcplServer(slack, { subscribeMemberChannels: opts.subscribeMemberChannels });
  const peer = connectHost(server, opts);
  const emit = base.socket.emitMessage.bind(base.socket);
  base.socket.emitMessage = async event => {
    await emit(event);
    await (slack as any).inbound.get(event.channel ?? '');
    await (server as any).forwarding.get(event.channel ?? '');
  };
  const { slack: _unused, ...recordings } = base;
  return { ...recordings, server, ...peer };
}
