/** Full public response fixtures captured from main d885b862, with policy unset.
 * Includes unknown outcomes and confirmed/pre-open errors, not just substrings.
 * The fixture is deliberately static: changing this implementation cannot update main.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SlackAdapter, type SlackWebLike } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';

const main = JSON.parse(readFileSync(new URL('./fixtures/main-send-dm.json', import.meta.url), 'utf8'));
const cases = ['no timestamp', 'type', 'unclassified', 'http', 'refusal', 'rate limit', 'open timeout', 'connection never made', 'timeout'];
assert.deepEqual(Object.keys(main).sort(), [...cases].sort());
for (const kind of cases) test(`unset-policy send_dm ${kind} matches main byte for byte`, async t => {
  const fail = () => {
    if (kind === 'no timestamp') return {};
    if (kind === 'type') throw new TypeError('unreadable answer');
    if (kind === 'unclassified') throw new Error('embedded client lost the answer');
    if (kind === 'http') throw Object.assign(new Error('bad gateway'), { code: 'slack_webapi_http_error', statusCode: 502 });
    if (kind === 'refusal') throw Object.assign(new Error('post refused'), { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } });
    if (kind === 'rate limit') throw Object.assign(new Error('post refused'), { code: 'slack_webapi_rate_limited_error', retryAfter: 20 });
    throw Object.assign(new Error('client timeout'), { code: 'slack_webapi_request_error', ...(kind === 'connection never made' ? { original: { code: 'ECONNREFUSED' } } : {}) });
  };
  const web = {
    conversations: { open: async () => kind === 'open timeout' ? fail() : { channel: { id: 'D1' } } },
    chat: { postMessage: async () => fail() },
  };
  const socket = { on() {}, async start() {}, async disconnect() {} };
  // No policy constructor argument: this is the supported legacy mode.
  const adapter = new SlackAdapter(web as unknown as SlackWebLike, socket, 'UBOT', 'acme');
  t.after(() => adapter.stop());
  const h = connectHost(new SlackMcplServer(adapter));
  t.after(() => h.close());
  await initialize(h, false);
  const result = await h.host.sendRequest('tools/call', {
    name: 'send_dm', arguments: { userId: 'U1', content: 'hi' },
  });
  assert.equal(JSON.stringify(result), JSON.stringify(main[kind]));
});
