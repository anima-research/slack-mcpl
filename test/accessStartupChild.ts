/** Only Slack SDK boundaries are fake: the entry point, policy, adapter and server are real. */
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { register } from 'node:module';
const scenario = JSON.parse(process.env.TEST_SCENARIO ?? '{}');
if (scenario.inspectEntryOptions) register(new URL('./accessEntryLoader.mjs', import.meta.url));
const grants = ['channels:read', 'groups:read', 'im:read', 'mpim:read', 'channels:history', 'groups:history',
  'im:history', 'mpim:history', 'im:write', 'mpim:write', 'chat:write', 'files:read', 'files:write', 'reactions:write', 'users:read'];
const channel = (id: string) => id.startsWith('D') ? { id, is_im: true, user: 'W1' }
  : id.startsWith('G') ? { id, is_mpim: true, ...(scenario.membership === 'absent' ? {} : { is_member: scenario.membership !== false }) }
  : { id, name: 'room', is_im: false, is_mpim: false, is_private: false, is_member: id === 'C1' };
WebClient.prototype.apiCall = async function (name: string, args?: Record<string, unknown>): Promise<any> {
  // Do not record credentials, URLs or the full SDK options.
  console.error('A4_CALL ' + JSON.stringify({ name, ...(args ? { args } : {}) }));
  if (name === 'auth.test') return { ok: true, user_id: 'UBOT', team: 'test',
    ...(scenario.scopes === null ? {} : { response_metadata: { scopes: scenario.scopes ?? grants } }) };
  if (name === 'conversations.info') return { ok: true, channel: channel(String(args?.channel)) };
  if (name === 'conversations.list') return { ok: true, channels: ['C1', 'C2', 'D1', 'G1'].map(channel) };
  if (name === 'conversations.members') return { ok: true, members: ['UBOT', 'W1'] };
  if (name === 'conversations.open') return { ok: true, channel: { id: 'D1' } };
  if (name === 'conversations.history' || name === 'conversations.replies') return { ok: true, messages: [] };
  if (name === 'users.info') return { ok: true, user: { name: 'human' } };
  if (name === 'users.list') return { ok: true, members: [{ id: 'UOTHER', name: 'directory', real_name: 'Directory User' }] };
  if (name === 'chat.postMessage') return { ok: true, ts: '1.0' };
  if (name === 'chat.delete') return { ok: true };
  throw new Error('Unexpected Slack method: ' + name);
};
SocketModeClient.prototype.start = async function (): Promise<any> {
  console.error('A4_SOCKET_START');
  // The first event must already be subject to the constructed policy.
  this.emit('message', { event: { type: 'message', channel: 'C2', user: 'U1', ts: '2.0', text: 'early' }, ack: async () => {} });
  return {};
};
SocketModeClient.prototype.disconnect = async () => {};
const entry = process.env.A4_BUILT === '1' ? 'dist/src/index.js' : 'src/index.ts';
process.argv = [process.execPath, entry, ...process.argv.slice(2)];
await import(pathToFileURL(resolve(entry)).href);
