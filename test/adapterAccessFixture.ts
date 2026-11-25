import type { BotMessagePolicy } from '../src/config.js';
import type { PaginationLimits } from '../src/pagination.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import test, { type TestContext, type TestOptions } from 'node:test';
import { SlackAccessPolicy, parseAccessPolicy, type AccessConversation, type SlackAccessPolicyConfig } from '../src/access-policy.js';
import { SlackAdapter, type SlackSocketLike, type SlackWebLike } from '../src/slack-adapter.js';

export const accessScopes = ['channels:read', 'groups:read', 'im:read', 'channels:history', 'groups:history',
  'im:history', 'files:read', 'chat:write', 'im:write', 'files:write', 'reactions:write', 'users:read'];
export const joined = (id = 'C1'): AccessConversation =>
  ({ id, is_im: false, is_mpim: false, is_private: false, is_member: true });
export const accessConfig: SlackAccessPolicyConfig = { readJoinedChannels: true, writeChannels: ['C1', 'G1'], dmUsers: ['U1', 'W1'] };

export const fixturePolicy = (config = accessConfig) => new SlackAccessPolicy(parseAccessPolicy(config));

export function accessFixture(options: { legacy?: boolean; scopes?: string[]; config?: SlackAccessPolicyConfig;
  sendChannels?: string[]; disableDms?: boolean; dmUsers?: string[]; ack?: string; pagination?: Partial<PaginationLimits>;
  botMessages?: BotMessagePolicy } = {}) {
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
      // As Slack does, a listing returns only the conversation types it asked for.
      list: record('list', (args) => {
        const types = (args as { types?: unknown } | undefined)?.types;
        // A row with incomplete kind flags may be any kind its ID allows.
        const kinds = (c: AccessConversation) => c?.is_im ? ['im'] : c?.is_mpim ? ['mpim'] : c?.is_private ? ['private_channel']
          : c?.is_mpim === undefined && c?.id?.startsWith('G') ? ['mpim', 'private_channel', 'public_channel'] : ['public_channel'];
        return { channels: typeof types === 'string' ? state.listed.filter(c => kinds(c).some(k => types.split(',').includes(k))) : state.listed };
      }),
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
    options.legacy ? undefined : fixturePolicy(options.config), options.pagination, options.botMessages, 'BSELF');
  ownAdapter(adapter);
  return { adapter, web, calls, state, methods: () => calls.map((c) => c.method),
    async emit(event: Record<string, unknown>) {
      let acked = false;
      message({ event: event as never, ack: async () => { acked = true; } });
      await Promise.all((adapter as unknown as { inbound: Map<string, Promise<void>> }).inbound.values());
      return acked;
    },
  };
}

/** The adapters built while each owning test runs. */
const owners = new AsyncLocalStorage<Set<SlackAdapter>>();

/** Hands an adapter to the test now running, which stops it when it ends, so
 *  no policy adapter's 60-second admission-log flush timer outlives the test
 *  that built it or writes into a later test's console.error mock. Outside an
 *  ownedTest or accessTest it throws instead of leaving the adapter live. */
export function ownAdapter<T extends SlackAdapter>(adapter: T): T {
  const owned = owners.getStore();
  if (!owned) throw new Error('A test adapter was built outside ownedTest or accessTest, so no test would stop it');
  owned.add(adapter);
  return adapter;
}

/** node:test's test, owning (and stopping when it ends) every adapter built while it runs. */
export function ownedTest(name: string, run: (t: TestContext) => unknown): void;
export function ownedTest(name: string, options: TestOptions, run: (t: TestContext) => unknown): void;
export function ownedTest(name: string, ...rest: [(t: TestContext) => unknown] | [TestOptions, (t: TestContext) => unknown]): void {
  const [options, run] = rest.length === 1 ? [{}, rest[0]] : rest;
  test(name, options, async (t) => {
    const owned = new Set<SlackAdapter>();
    t.after(async () => {
      for (const adapter of owned) await adapter.stop().catch(() => {});
    });
    await owners.run(owned, () => run(t));
  });
}

/** An ownedTest with one context-owned console mock, restored before unrelated tests run. */
export function accessTest(name: string, run: (t: TestContext) => unknown): void {
  ownedTest(name, (t) => {
    t.mock.method(console, 'error', () => {});
    return run(t);
  });
}
