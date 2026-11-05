import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter, SlackWebClient, SLACK_CLIENT_OPTIONS, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackAccessPolicy } from '../src/access-policy.js';
import { fakeSlackApi } from './slackApi.js';

const notices: Array<Record<string, unknown>> = [
  {}, { warning: 'missing_charset' }, { warning: 'superfluous_charset' },
  { response_metadata: { warnings: ['missing_charset'] } },
  { response_metadata: { warnings: ['superfluous_charset'] } },
  // Notices and scope fields alone are not refusals, even on the fallback.
  { warnings: ['missing_scope'] }, { warning: 'missing_scope' },
  { response_metadata: { messages: ['[WARN] missing_charset'] } },
  { needed: 'channels:history' }, { provided: 'chat:write' },
  { needed: 'channels:history', provided: 'chat:write' },
];
// The SDK throws on these before the adapter sees them; test the adapter's
// warning-independence directly through the structural client instead.
const structuralNotices: Array<Record<string, unknown>> = [
  { response_metadata: { warnings: 'not an array' } }, { response_metadata: null },
];
const errors: Array<Record<string, unknown>> = [{ error: 'not_in_channel' }, { error: '' }, { error: null }, { error: undefined }];
const nonSuccess: Array<Record<string, unknown>> = [{ ok: undefined }, { ok: false }, { ok: 'true' }, { ok: null }];
const invalidMessages: Array<Record<string, unknown>> = [{ messages: undefined }, { messages: null }, { messages: {} }, { messages: 'not a list' }];

for (const proof of ['history', 'info', 'members'] as const) {
  for (const transport of ['structural', 'real client'] as const) {
    const cases = [...notices, ...(transport === 'structural' ? structuralNotices : []), ...errors, ...nonSuccess, ...(proof === 'history' ? invalidMessages : [])];
    for (const shape of cases) {
      // Preserve #61 info/member behavior, including contradictions. The SDK
      // itself rejects falsy ok; the structural boundary does not.
      const refused = proof === 'history'
        ? errors.includes(shape) || nonSuccess.includes(shape) || invalidMessages.includes(shape)
        : transport === 'real client' && 'ok' in shape && !shape.ok;
      // JSON cannot represent an error property whose value is undefined.
      if (transport === 'real client' && 'error' in shape && shape.error === undefined) continue;
      test(`${transport} ${proof} ${refused ? 'rejects' : 'accepts'} ${JSON.stringify(shape)}`, async t => {
        t.mock.method(console, 'error', () => {});
        const id = proof === 'members' ? 'G1' : 'C1';
        const valid = proof === 'history' ? { ok: true, messages: [] }
          : proof === 'members' ? { ok: true, members: ['UBOT'] }
          : { ok: true, channel: { id, is_im: false, is_mpim: false, is_private: false, is_member: true } };
        const answers: Record<string, Record<string, unknown>> = {
          info: { ok: true, channel: { id, is_im: false, is_mpim: true, is_private: true } },
          history: { ok: true, messages: [] },
          list: { ok: true, channels: [{ id, is_member: true, is_im: false, is_mpim: proof === 'members' }] },
          [proof]: { ...valid, ...shape },
        };
        let posts = 0;
        let web: SlackWebLike;
        if (transport === 'real client') {
          const api = await fakeSlackApi(); t.after(() => api.close());
          for (const [method, body] of Object.entries(answers)) api.answerFor(`conversations.${method}`, { body });
          api.answerFor('chat.postMessage', { body: { ok: true, ts: '1.0' } });
          web = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url }) as unknown as SlackWebLike;
          t.after(() => { assert.equal(api.calls.filter(m => m === 'chat.postMessage').length, refused ? 0 : 1); });
        } else {
          web = {
            conversations: Object.fromEntries(Object.entries(answers).map(([method, answer]) => [method, async () => answer])),
            chat: { async postMessage() { posts++; return { ts: '1.0' }; } },
          } as unknown as SlackWebLike;
          t.after(() => { assert.equal(posts, refused ? 0 : 1); });
        }
        const policy = new SlackAccessPolicy({ readJoinedChannels: true, writeChannels: [id], dmUsers: [],
          ...(proof === 'history' ? { historyMembershipFallbackChannels: [id] } : {}),
          ...(proof === 'members' ? { groupDms: [id] } : {}) });
        const scopes = ['channels:history', 'mpim:history', 'chat:write', 'mpim:write',
          ...(proof === 'history' ? [] : ['channels:read', 'mpim:read'])];
        const adapter = new SlackAdapter(web, { on() {}, async start() {}, async disconnect() {} },
          'UBOT', 'test', undefined, undefined, false, undefined, scopes, policy);
        t.after(() => adapter.stop());
        if (refused) {
          await assert.rejects(adapter.getConversationMeta(id));
          await assert.rejects(adapter.readHistory(id, {}));
          await assert.rejects(adapter.sendMessage(id, 'must not send'));
          if (transport === 'real client' && 'ok' in shape && !shape.ok) {
            // #61 propagates SDK failures with no Slack error code as transient.
            await assert.rejects(adapter.listConversations());
          } else {
            assert.deepEqual((await adapter.listConversations()).conversations, []);
          }
        } else {
          assert.equal((await adapter.getConversationMeta(id))?.isMember, true);
          await adapter.readHistory(id, {});
          await adapter.sendMessage(id, 'hello');
          assert.deepEqual((await adapter.listConversations()).conversations.map(c => c.id), [id]);
        }
      });
    }
  }
}
