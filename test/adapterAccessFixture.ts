import test, { type TestContext } from 'node:test';
import { SlackAccessPolicy, parseAccessPolicy, type AccessConversation, type SlackAccessPolicyConfig } from '../src/access-policy.js';
import { SlackAdapter, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';

export const accessScopes = ['channels:read', 'groups:read', 'im:read', 'channels:history', 'groups:history',
  'im:history', 'files:read', 'chat:write', 'im:write', 'files:write', 'reactions:write', 'users:read'];
export const joined = (id = 'C1'): AccessConversation =>
  ({ id, is_im: false, is_mpim: false, is_private: false, is_member: true });
export const accessConfig: SlackAccessPolicyConfig = { readJoinedChannels: true, writeChannels: ['C1', 'G1'], dmUsers: ['U1', 'W1'] };

export const fixturePolicy = (config = accessConfig) => new SlackAccessPolicy(parseAccessPolicy(config));

export function accessFixture(options: { legacy?: boolean; scopes?: string[]; config?: SlackAccessPolicyConfig;
  sendChannels?: string[]; disableDms?: boolean; dmUsers?: string[]; ack?: string } = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const state = {
    conversation: joined() as AccessConversation | undefined,
    conversations: undefined as Record<string, AccessConversation | undefined> | undefined,
    listed: [] as AccessConversation[],
    messages: [] as Array<Record<string, unknown>>,
    more: false,
    infoError: undefined as Error | undefined,
    infoScopes: undefined as string[] | undefined,
    openId: 'D1',
    uploadUrl: 'https://example.invalid',
  };
  const record = <T>(method: string, result: (args?: unknown) => T) => async (args?: unknown): Promise<T> => {
    calls.push({ method, args });
    return result(args);
  };
  const web: SlackWebLike = {
    auth: { test: record('auth.test', () => ({})) },
    conversations: {
      info: record('info', (args) => { if (state.infoError) throw state.infoError; return { response_metadata: { scopes: state.infoScopes }, channel: state.conversations ? state.conversations[(args as { channel: string }).channel] : state.conversation }; }),
      list: record('list', () => ({ channels: state.listed })),
      open: record('open', () => ({ channel: { id: state.openId } })),
      history: record('history', () => ({ messages: state.messages, has_more: state.more })),
      replies: record('replies', () => ({ messages: state.messages, has_more: state.more })),
    },
    chat: { postMessage: record('post', () => ({ ts: '1.0' })), update: record('edit', () => ({})), delete: record('delete', () => ({})) },
    reactions: { add: record('react', () => ({})), remove: record('unreact', () => ({})) },
    files: { info: record('fileInfo', () => ({ file: { id: 'F1', mode: 'hosted', channels: [state.conversation?.id] } })),
      getUploadURLExternal: record('upload', () => ({ file_id: 'F1', upload_url: state.uploadUrl })),
      completeUploadExternal: record('complete', () => ({ files: [{ id: 'F1' }] })), delete: record('deleteFile', () => ({})) },
    users: { info: record('user', () => ({ user: { name: 'human' } })), list: record('users', () => ({ members: [] })) },
  };
  let message: Parameters<SlackSocketLike['on']>[1];
  const socket: SlackSocketLike = { on(_event, handler) { message = handler; }, async start() {}, async disconnect() {} };
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'test', options.dmUsers, options.sendChannels,
    options.disableDms, options.ack, options.scopes ?? accessScopes,
    options.legacy ? undefined : fixturePolicy(options.config));
  return { adapter, web, calls, state, methods: () => calls.map((c) => c.method),
    async emit(event: Record<string, unknown>) {
      let acked = false;
      message({ event: event as never, ack: async () => { acked = true; } });
      await Promise.all((adapter as unknown as { inbound: Map<string, Promise<void>> }).inbound.values());
      return acked;
    },
  };
}

/** One context-owned console mock per test, restored before unrelated tests run. */
export function accessTest(name: string, run: (t: TestContext) => unknown): void {
  test(name, async (t) => {
    t.mock.method(console, 'error', () => {});
    await run(t);
  });
}
