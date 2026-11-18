import { SlackAccessDenied, SlackAccessUnverified, SlackFileAccessUnverified, SlackFileUnavailable, withAccessContext } from '../src/access-policy.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { method } from '@animalabs/mcpl-core';
import { associatedFile, privateFileUrl } from '../src/file-access.js';
import { fetchAttachmentBytes, MAX_ATTACHMENT_BYTES } from '../src/content.js';
import { fileLeftByUpload, SlackAdapter, SlackWebClient, SLACK_CLIENT_OPTIONS, withCallTime, CALL_SECONDS, type SlackWebLike } from '../src/slack-adapter.js';
import { fakeSlackApi } from './slackApi.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize, FULL_GRANT } from './harness.js';
import { accessTest as test, accessFixture, accessScopes, joined, installPolicy } from './adapterAccessFixture.js';

const url = 'https://files.slack.com/files-pri/T1-F1/canonical.txt';
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0], options: Parameters<typeof accessFixture>[0] = {}) {
  const f = accessFixture(options); t.after(() => f.adapter.stop());
  const state = { file: { mode: 'hosted', id: 'F1', channels: ['C1'], url_private: url } as unknown };
  Object.assign(f.web.files, { info: async (args: { file: string }) => { f.calls.push({ method: 'fileInfo', args }); return { file: state.file }; } });
  const downloads: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    downloads.push({ url: String(input), init });
    return new Response('hello', { headers: { 'content-type': 'text/plain' } });
  });
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, false);
  const call = (args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
    name: 'fetch_attachment', arguments: args,
  }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { ...f, fileState: state, downloads, fetchMock, h, call };
}

test('policy URL-only fetch refuses before any network request through the real server', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call({ url })).isError, true);
  const explicit = await f.call({ channelId: 'C1', fileId: 'F1', url });
  assert.equal(explicit.isError, true);
  assert.match(JSON.stringify(explicit), /not a URL/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.downloads, []);
});

test('policy canonical file fetch rechecks association and requests manual redirects', async (t) => {
  const f = await fixture(t);
  assert.notEqual((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  assert.deepEqual(f.methods(), ['info', 'fileInfo']);
  assert.equal(f.downloads[0].url, url);
  assert.equal(f.downloads[0].init?.redirect, 'manual');
  f.fileState.file = { mode: 'hosted', id: 'F1', channels: ['C2'], url_private: url };
  assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  assert.equal(f.downloads.length, 1);
});

test('policy deletion rejects a caller pair without upload provenance', async () => {
  const f = accessFixture();
  await assert.rejects(f.adapter.deleteFile('C1', 'F1'));
  assert.ok(!f.methods().includes('deleteFile'));
});

test('policy upload rechecks target after bytes and before completion', async (t) => {
  const f = accessFixture();
  f.state.uploadUrl = url;
  let bytesSent = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    bytesSent++;
    f.state.conversation = { ...f.state.conversation, is_member: false };
    return new Response('OK');
  });
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }), err => {
    assert.match(String(err), /Nothing was shared:.*a member can invite it/);
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false, policy: true });
    return true;
  });
  assert.equal(bytesSent, 1);
  assert.deepEqual(f.methods(), ['info', 'upload', 'info']);
  assert.ok(!f.methods().includes('complete'));
});

for (const association of [
  { channels: ['C1', 'COTHER'] }, { groups: ['C1'] }, { ims: ['D1'] },
  { shares: { public: { C1: [{ ts: '1.0' }] } } }, { shares: { private: { C1: [{ ts: '1.0' }] } } },
]) test(`association accepts exact positive evidence: ${JSON.stringify(association)}`, () => {
  const channel = 'ims' in association ? 'D1' : 'C1';
  assert.ok(associatedFile({ mode: 'hosted', id: 'F1', ...association }, 'F1', channel));
});

const invalidFiles: unknown[] = [undefined, null, [], {}, { mode: 'hosted', id: 'F2', channels: ['C1'] },
  { mode: 'hosted', id: 'F1' }, { mode: 'hosted', id: 'F1', channels: ['C11'] }, { mode: 'hosted', id: 'F1', channels: 'C1' },
  { mode: 'hosted', id: 'F1', shares: { public: { C1: [] } } }, { mode: 'hosted', id: 'F1', shares: { public: { C1: [null] } } },
  { mode: 'hosted', id: 'F1', shares: { public: { C1: [{}] } } }, { mode: 'hosted', id: 'F1', channels: ['C1'], shares: [] },
  ...[{ groups: [null] }, { shares: { public: { C1: [{ ts: 'bad' }] } } }, { deleted: true },
    { mode: 'tombstone' }, { file_access: 'check_file_info' }, { is_external: true }, { mode: 'external' },
  ].map((fields) => ({ mode: 'hosted', id: 'F1', channels: ['C1'], ...fields })),
];
for (const [i, file] of invalidFiles.entries()) test(`file evidence denial ${i} makes no byte request`, async (t) => {
  const f = await fixture(t);
  f.fileState.file = file && typeof file === 'object' && !Array.isArray(file) ? { url_private: url, ...file } : file;
  const result = await f.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(result.isError, true);
  assert.deepEqual(f.methods(), ['info', 'fileInfo']);
  assert.deepEqual(f.downloads, []);
  assert.ok(!JSON.stringify(result).includes('C11'));
});

for (const raw of [undefined, '', 'http://files.slack.com/f', 'https://files.slack.com.evil.example/f',
  'https://workspace.slack.com/f', 'https://files.slack.com:8443/f', 'https://secret@files.slack.com/f']) {
  test(`private URL denial: ${raw ?? 'absent'}`, async (t) => {
    const f = await fixture(t);
    f.fileState.file = { mode: 'hosted', id: 'F1', channels: ['C1'], url_private: raw };
    const result = await f.call({ channelId: 'C1', fileId: 'F1' });
    assert.equal(result.isError, true);
    assert.equal(f.downloads.length, 0);
    assert.deepEqual(f.methods(), ['info', 'fileInfo']);
    assert.ok(!JSON.stringify(result).includes('secret@'));
  });
}

test('private download URL is preferred; invalid preferred URL never falls back', () => {
  assert.equal(privateFileUrl({ mode: 'hosted', url_private_download: url, url_private: 'https://invalid.example' }).href, url);
  for (const preferred of ['', null, 1]) assert.throws(() => privateFileUrl({ mode: 'hosted', url_private_download: preferred, url_private: url }));
});

for (const args of [{ url }, {}, { channelId: 'C1' }, { channelId: 'C1', fileId: 'bad' },
  { channelId: 'bad', fileId: 'F1' }, { channelId: 1, fileId: 'F1' },
  { channelId: 'C1', fileId: 1 }, { channelId: 'C1', fileId: 'F1', url }]) {
  test(`invalid policy arguments start no request: ${JSON.stringify(args)}`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.call(args)).isError, true);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.downloads, []);
  });
}

for (const scopes of [[], ['channels:read'], ['files:read']]) {
  test(`scope denial: ${scopes.join(',') || 'unknown'}`, async (t) => {
    const f = await fixture(t, { scopes });
    assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
    assert.ok(!f.methods().includes('fileInfo'));
    assert.deepEqual(f.downloads, []);
    if (!scopes.includes('files:read')) assert.deepEqual(f.calls, []);
  });
}

for (const conversation of [joined('C2'), { ...joined(), is_member: false }, { id: 'C1' },
  { ...joined(), is_mpim: true }, undefined]) {
  test(`conversation denial: ${JSON.stringify(conversation)}`, async (t) => {
    const f = await fixture(t);
    f.state.conversation = conversation;
    assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
    assert.deepEqual(f.methods(), ['info']);
    assert.deepEqual(f.downloads, []);
  });
}

test('read admission is not a write pin; private channels and admitted DMs work without history scopes', async (t) => {
  const f = await fixture(t, { scopes: ['files:read', 'groups:read', 'im:read'],
    config: { readJoinedChannels: true, writeChannels: [], dmUsers: ['U1'] } });
  f.state.conversation = { ...joined(), is_private: true };
  assert.notEqual((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
  f.fileState.file = { mode: 'hosted', id: 'F1', ims: ['D1'], url_private: url };
  assert.notEqual((await f.call({ channelId: 'D1', fileId: 'F1' })).isError, true);
  f.state.conversation.user = 'U2';
  assert.equal((await f.call({ channelId: 'D1', fileId: 'F1' })).isError, true);
  assert.equal(f.downloads.length, 2);
});

test('file/API failure and revoked membership fail closed, without cached authorization', async (t) => {
  const f = await fixture(t);
  assert.notEqual((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  f.state.conversation = { ...joined(), is_member: false };
  assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  f.state.conversation = joined();
  f.web.files.info = async () => { throw new Error('metadata unavailable'); };
  assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  delete f.web.files.info;
  assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  assert.equal(f.downloads.length, 1);
});

test('policy schema declares protected conversation and file IDs', async (t) => {
  const f = await fixture(t);
  const list = await f.h.host.sendRequest('tools/list') as { tools: Array<{ name: string; inputSchema: { properties: object; required: string[] } }> };
  const schema = list.tools.find((tool) => tool.name === 'fetch_attachment')!.inputSchema;
  assert.deepEqual(schema.required, ['channelId', 'fileId']);
  assert.deepEqual(Object.keys(schema.properties), ['channelId', 'fileId']);
});

test('custom redirect answer fails closed and never leaks the bearer', async (t) => {
  const f = await fixture(t);
  const previous = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-file-test';
  t.after(() => { if (previous === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = previous; });
  let requests = 0;
  f.fetchMock.mock.mockImplementation(async (_url, init) => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://other.example/secret' } });
  });
  const result = await f.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(result.isError, true);
  assert.equal(requests, 1);
  const init = f.fetchMock.mock.calls[0].arguments[1];
  assert.equal(init?.redirect, 'manual');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xoxb-file-test');
  assert.ok(!JSON.stringify(result).includes('xoxb-file-test'));
  assert.ok(!JSON.stringify(result).includes('other.example'));
});

async function bytesServer(t: Parameters<Parameters<typeof test>[1]>[0], answer: http.RequestListener) {
  const server = http.createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/file`;
}

test('production server/client path uses canonical URL and real bounded bytes, never GETs a denied file', async (t) => {
  const api = await fakeSlackApi();
  t.after(() => api.close());
  api.answerFor('conversations.info', { body: { ok: true, channel: joined() } });
  api.answerFor('files.info', { body: { ok: true, file: { mode: 'hosted', id: 'F1', channels: ['C1'], url_private: url } } });
  const client = new SlackWebClient('xoxb-test', { ...SLACK_CLIENT_OPTIONS, slackApiUrl: api.url });
  const adapter = new SlackAdapter(client as unknown as SlackWebLike, { on() {}, async start() {}, async disconnect() {} }, 'UBOT', 'test',
    undefined, undefined, false, undefined, accessScopes);
  installPolicy(adapter);
  const h = connectHost(new SlackMcplServer(adapter));
  t.after(() => h.close());
  await initialize(h, false);
  let gets = 0;
  const endpoint = await bytesServer(t, (_req, res) => { gets++; res.writeHead(200, { 'content-type': 'text/plain' }).end('actual bytes'); });
  const realFetch = globalThis.fetch;
  const fetches: Array<{ input: unknown; redirect: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push({ input, redirect: init?.redirect });
    return realFetch(endpoint, init);
  });
  const call = () => h.host.sendRequest('tools/call', { name: 'fetch_attachment', arguments: { channelId: 'C1', fileId: 'F1' } }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  assert.match((await call()).content[0].text, /actual bytes/);
  assert.deepEqual(fetches, [{ input: url, redirect: 'manual' }]);
  assert.deepEqual(api.calls, ['conversations.info', 'files.info']);
  assert.equal(api.sent[1].get('file'), 'F1');
  api.answerFor('files.info', { body: { ok: true, file: { mode: 'hosted', id: 'F1', channels: ['COTHER'], url_private: url } } });
  assert.equal((await call()).isError, true);
  assert.equal(gets, 1);
  assert.equal(fetches.length, 1);
  for (const answer of [{ body: { ok: false, error: 'missing_scope' } }, { body: { ok: false, error: 'file_not_found' } },
    { status: 429, headers: { 'retry-after': '120' }, body: { ok: false, error: 'ratelimited' } }]) {
    api.answerFor('files.info', answer);
    assert.equal((await call()).isError, true);
  }
  assert.equal(gets, 1);
  assert.equal(fetches.length, 1);
});

test('native transport rejects both same-origin and cross-origin redirects before a second GET', async (t) => {
  let reached = 0;
  const destination = await bytesServer(t, (_req, res) => { reached++; res.end('no'); });
  let originGets = 0;
  let redirect = destination;
  const origin = await bytesServer(t, (_req, res) => { originGets++; res.writeHead(302, { location: redirect }).end(); });
  await assert.rejects(fetchAttachmentBytes(origin, 'x', { redirect: 'error' }), /Nothing was fetched:.*refuses file redirects/);
  redirect = `${origin}/same-host`;
  await assert.rejects(fetchAttachmentBytes(origin, 'x', { redirect: 'error' }), /Nothing was fetched:.*refuses file redirects/);
  assert.equal(reached, 0);
  assert.equal(originGets, 2);
});

test('policy fetch retains streaming cap and exhausted-call start rule', async (t) => {
  const f = await fixture(t);
  f.fetchMock.mock.mockImplementation(async () => new Response(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)));
  assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  const client = new SlackWebClient('xoxb-test', SLACK_CLIENT_OPTIONS);
  const adapter = new SlackAdapter(client as unknown as SlackWebLike, { on() {}, async start() {}, async disconnect() {} }, 'UBOT', 'test',
    undefined, undefined, false, undefined, accessScopes);
  installPolicy(adapter);
  await assert.rejects(withCallTime(Date.now() - CALL_SECONDS * 1000, () => adapter.resolveFileDownload('C1', 'F1')), /out of this call/);
});

test('policy deletion requires upload provenance plus current matching associated metadata, without a URL', async (t) => {
  const f = await fixture(t);
  f.state.uploadUrl = url;
  await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') });
  f.calls.length = 0;
  for (const file of [{ mode: 'hosted', id: 'F1', channels: [] }, { mode: 'hosted', id: 'F2', channels: ['C1'] }, { mode: 'hosted', id: 'F1', channels: ['COTHER'] }]) {
    f.fileState.file = file;
    await assert.rejects(f.adapter.deleteFile('C1', 'F1'));
  }
  assert.ok(!f.methods().includes('deleteFile'));
  f.fileState.file = { mode: 'hosted', id: 'F1', channels: ['C1', 'COTHER'] };
  await f.adapter.deleteFile('C1', 'F1');
  assert.deepEqual(f.methods().slice(-3), ['info', 'fileInfo', 'deleteFile']);
  await assert.rejects(f.adapter.deleteFile('C1', 'F1'), /recorded upload/);
});

test('upload-to-rollback through server keeps deletion but refuses an unshared orphan', async (t) => {
  const f = accessFixture();
  f.state.uploadUrl = url;
  let associated = true;
  f.web.files.info = async () => ({ file: { mode: 'hosted', id: 'F1', channels: associated ? ['C1'] : [] } });
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const upload = () => h.host.sendRequest('tools/call', { name: 'upload_file', arguments: { channelId: 'C1', filename: 'x', content: 'x' } }) as Promise<{ state: { parent: string } }>;
  const rollback = (checkpoint: string) => h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint }) as Promise<{ reason: string }>;
  const first = await upload();
  assert.match((await rollback(first.state.parent)).reason, /deletion removes the file from every conversation it is shared in/);
  assert.ok(f.methods().includes('deleteFile'));
  const second = await upload();
  associated = false;
  f.calls.length = 0;
  const orphanReason = (await rollback(second.state.parent)).reason;
  assert.match(orphanReason, /0\/1 files deleted/);
  assert.doesNotMatch(orphanReason, /deletion removes|Slack refused to delete/);
  assert.ok(!f.methods().includes('deleteFile'));
});

for (const scope of ['files:read', 'files:write']) test(`delete requires ${scope} independently of provenance`, async (t) => {
  const f = await fixture(t);
  f.state.uploadUrl = url;
  await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') });
  (f.adapter as unknown as { scopes: string[] }).scopes = accessScopes.filter((s) => s !== scope);
  f.calls.length = 0;
  await assert.rejects(f.adapter.deleteFile('C1', 'F1'), new RegExp(scope));
  assert.ok(!f.methods().includes('deleteFile'));
  assert.ok(!f.methods().includes('fileInfo'));
});

test('metadata file_not_found is not counted as deletion; sharing-message cleanup is independent', async (t) => {
  const f = accessFixture();
  f.state.uploadUrl = url;
  f.web.files.completeUploadExternal = async () => ({ files: [{ mode: 'hosted', id: 'F1', shares: { public: { C1: [{ ts: '5.0' }] } } }] });
  f.web.files.info = async () => { f.calls.push({ method: 'fileInfo', args: {} }); throw Object.assign(new Error('no file'), { code: 'slack_webapi_platform_error', data: { error: 'file_not_found' } }); };
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const uploaded = await h.host.sendRequest('tools/call', { name: 'upload_file', arguments: { channelId: 'C1', filename: 'x', content: 'x' } }) as { state: { parent: string } };
  f.calls.length = 0;
  const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: uploaded.state.parent }) as { reason: string };
  assert.equal(f.methods().filter(m => m === 'fileInfo').length, 1);
  assert.match(rolled.reason, /1\/1 messages and 0\/1 files deleted/);
  assert.doesNotMatch(rolled.reason ?? '', /deletion removes|Slack refused to delete/);
  assert.ok(!f.methods().includes('deleteFile'));
  assert.ok(f.methods().includes('delete'));
});

test('upload provenance cannot be reused with a different writable target', async (t) => {
  const f = await fixture(t, { config: { readJoinedChannels: true, writeChannels: ['C1', 'C2'], dmUsers: [] } });
  f.state.uploadUrl = url;
  await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') });
  f.state.conversation = joined('C2');
  f.calls.length = 0;
  await assert.rejects(f.adapter.deleteFile('C2', 'F1'), /recorded upload/);
  assert.deepEqual(f.methods(), ['info']);
});

for (const ticket of ['http://127.0.0.1:2/upload', 'https://secret@files.slack.com/upload', 'not a URL']) {
  test(`policy invalid upload ticket sends no bytes: ${ticket}`, async (t) => {
    const f = await fixture(t);
    f.state.uploadUrl = ticket;
    await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }), err => {
      assert.equal(fileLeftByUpload(err)?.fileId, 'F1'); return true;
    });
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.methods(), ['info', 'upload']);
    assert.ok(!f.methods().includes('complete'));
  });
}

test('MCPL grant denial prevents file authorization and download', async (t) => {
  const f = accessFixture();
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await assert.rejects(h.host.sendRequest('tools/call', { name: 'fetch_attachment', arguments: { channelId: 'C1', fileId: 'F1' } }));
  assert.deepEqual(f.calls, []);
});


for (const restricted of [{ mode: 'tombstone' }, { file_access: 'check_file_info' }, { is_external: true }]) {
  test(`policy deletion rejects restricted associated file: ${JSON.stringify(restricted)}`, async (t) => {
    const f = await fixture(t);
    f.state.uploadUrl = url;
    await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') });
    f.fileState.file = { mode: 'hosted', id: 'F1', channels: ['C1'], ...restricted };
    f.calls.length = 0;
    await assert.rejects(f.adapter.deleteFile('C1', 'F1'));
    assert.deepEqual(f.methods(), ['info', 'fileInfo']);
  });
}

test('invalid upload file ID retains unshared orphan evidence without provenance or bytes', async (t) => {
  const f = await fixture(t);
  f.web.files.getUploadURLExternal = async () => ({ file_id: 'invalid-id', upload_url: url });
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }), (err: unknown) => {
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'invalid-id', mayHaveShared: false, policy: true });
    return true;
  });
  assert.deepEqual(f.downloads, []);
  f.calls.length = 0;
  await assert.rejects(f.adapter.deleteFile('C1', 'invalid-id'), /recorded upload/);
  assert.deepEqual(f.methods(), ['info']);
});

test('upload provenance evicts the oldest insertion at 1000, not recently checked entries', async (t) => {
  const f = await fixture(t);
  let id = '';
  f.web.files.getUploadURLExternal = async () => ({ file_id: id, upload_url: url });
  f.web.files.completeUploadExternal = async () => ({ files: [{ id }] });
  for (let i = 0; i < 1001; i++) {
    id = `F${i}`;
    await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') });
    if (i === 999) {
      f.fileState.file = { mode: 'hosted', id: 'F0', channels: [] };
      await assert.rejects(f.adapter.deleteFile('C1', 'F0'), /file access could not be verified/);
    }
  }
  f.calls.length = 0;
  f.fileState.file = { mode: 'hosted', id: 'F0', channels: ['C1'] };
  await assert.rejects(f.adapter.deleteFile('C1', 'F0'), /recorded upload/);
  assert.deepEqual(f.methods(), ['info']);
  for (const retained of ['F1', 'F1000']) {
    f.fileState.file = { mode: 'hosted', id: retained, channels: ['C1'] };
    await f.adapter.deleteFile('C1', retained);
  }
  assert.equal(f.methods().filter((m) => m === 'deleteFile').length, 2);
});

test('policy tool description retains the inline return shapes', async (t) => {
  const f = await fixture(t);
  const list = await f.h.host.sendRequest('tools/list') as { tools: Array<{ name: string; description: string }> };
  assert.match(list.tools.find((tool) => tool.name === 'fetch_attachment')!.description,
    /images as image blocks, text-ish files decoded, other binary as base64/);
});

for (const scenario of ['admitted', 'unrelated', 'unnamed', 'missing mpim:read'] as const) {
  test(`real group file download inherits admission: ${scenario}`, async (t) => {
    const f = await fixture(t, {
      config: { readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: scenario === 'unnamed' ? [] : ['G1'] },
      scopes: [...accessScopes, ...(scenario === 'missing mpim:read' ? [] : ['mpim:read'])],
    });
    f.state.conversation = { ...joined('G1'), is_mpim: true, is_private: true };
    f.fileState.file = { mode: 'hosted', id: 'F1', groups: [scenario === 'unrelated' ? 'G2' : 'G1'], url_private: url };
    const result = await f.call({ channelId: 'G1', fileId: 'F1' });
    if (scenario === 'admitted') {
      assert.notEqual(result.isError, true);
      assert.equal(f.downloads.length, 1);
    } else {
      assert.equal(result.isError, true);
      assert.deepEqual(f.downloads, []);
    }
    assert.deepEqual(f.methods(), ['admitted', 'unrelated'].includes(scenario) ? ['info', 'fileInfo'] : scenario === 'unnamed' ? [] : ['info']);
  });
}

test('real group file upload requires files:write before a ticket or bytes', async (t) => {
  const f = await fixture(t, {
    config: { readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] },
    scopes: [...accessScopes.filter((s) => s !== 'files:write'), 'mpim:read'],
  });
  f.state.conversation = { ...joined('G1'), is_mpim: true, is_private: true };
  const result = await f.h.host.sendRequest('tools/call', { name: 'upload_file',
    arguments: { channelId: 'G1', filename: 'x', content: 'x' } }) as { isError?: boolean };
  assert.equal(result.isError, true);
  assert.deepEqual(f.methods(), ['info']);
  assert.deepEqual(f.downloads, []);
});


test('real server retains an invalid-ticket orphan for an honest rollback report', async (t) => {
  const f = accessFixture();
  f.web.files.getUploadURLExternal = async () => ({ file_id: 'invalid-id', upload_url: url });
  const bytes = t.mock.method(globalThis, 'fetch', async () => new Response('unexpected'));
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const before = await h.host.sendRequest('tools/call', { name: 'send_message',
    arguments: { channelId: 'C1', content: 'checkpoint' } }) as { state: { checkpoint: string } };
  const uploaded = await h.host.sendRequest('tools/call', { name: 'upload_file',
    arguments: { channelId: 'C1', filename: 'x', content: 'x' } }) as { isError?: boolean };
  assert.equal(uploaded.isError, true);
  assert.equal(bytes.mock.callCount(), 0);
  const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: before.state.checkpoint,
  }) as { reason: string };
  assert.match(rolled.reason, /0\/1 files deleted/);
  assert.match(rolled.reason, /invalid-id/);
  assert.ok(!f.methods().includes('deleteFile'));
  assert.ok(!f.methods().includes('fileInfo'));
});

for (const options of [{ disableDms: true }, { dmUsers: ['UOTHER'] }]) {
  test(`R2-3 download intersects DM switches ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    f.state.conversation = { id: 'D1', is_im: true, user: 'U1' };
    await assert.rejects(f.adapter.resolveFileDownload('D1', 'F1'), /direct message/i);
    assert.ok(!f.methods().includes('fileInfo'));
    assert.equal(f.downloads.length, 0);
  });
}

test('R2-3 group download intersects disabled DMs', async t => {
  const f = await fixture(t, { disableDms: true, config: { readJoinedChannels: true, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] }, scopes: [...accessScopes, 'mpim:read'] });
  f.state.conversation = { ...joined('G1'), is_mpim: true, is_private: true };
  await assert.rejects(f.adapter.resolveFileDownload('G1', 'F1'), /Group direct messages/);
  assert.deepEqual(f.methods(), ['info']);
});

test('R1-5 file metadata rate limits preserve retry information', async t => {
  const f = await fixture(t);
  const error = Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 12 });
  f.web.files.info = async () => { throw error; };
  await assert.rejects(f.adapter.resolveFileDownload('C1', 'F1'), err => { assert.equal((err as { retryAfter?: number }).retryAfter, 12); return true; });
});

for (const failure of ['redirect', 'recheck', 'membership', 'unexpected', 'denied', 'bytes', 'timeout'] as const) {
  test(`upload ${failure} retains issued ID without claiming nothing uploaded`, async t => {
    const f = accessFixture();
    f.state.uploadUrl = 'https://files.slack.com/upload';
    const requests: RequestInit[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init!);
      if (failure === 'bytes' || failure === 'timeout') throw new Error('byte connection failed');
      if (failure === 'unexpected') f.state.infoError = new Error('unexpected info failure: original cause');
      if (failure === 'denied') f.state.conversation = { ...joined(), is_member: false };
      if (failure === 'recheck') f.state.infoError = Object.assign(new Error('limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 12 });
      if (failure === 'membership') f.state.infoError = Object.assign(new Error('not in channel'), { code: 'slack_webapi_platform_error', data: { error: 'not_in_channel' } });
      return new Response(null, { status: failure === 'redirect' ? 302 : 200, headers: { location: 'https://other.example/' } });
    });
    const h = connectHost(new SlackMcplServer(f.adapter));
    t.after(() => h.close());
    await initialize(h, true);
    await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    if (failure === 'timeout') t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
    const result = await h.host.sendRequest('tools/call', { name: 'upload_file', arguments: { channelId: 'C1', filename: 'x', content: 'x' } }) as { isError?: boolean; content: { text: string }[] };
    const text = result.content.map(c => c.text).join('\n');
    assert.equal(text.match(/Upload did not complete/g)?.length, 1);
    assert.equal(text.match(/may remain/g)?.length, 1);
    assert.doesNotMatch(text, /calling again is safe|Check before retrying/);
    if (failure === 'unexpected') assert.match(text, /unexpected info failure: original cause/i);
    if (failure === 'timeout') assert.match(text, /didn't finish within 10 seconds/);
    if (failure === 'bytes') assert.doesNotMatch(text, /didn't finish within 10 seconds/);
    assert.equal(result.isError, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].redirect, 'manual');
    assert.equal(new Headers(requests[0].headers).has('authorization'), false);
    assert.ok(!f.methods().includes('complete'));
    assert.match(JSON.stringify(result), /F1.*may remain/);
    assert.doesNotMatch(JSON.stringify(result), /Nothing was uploaded/i);
    if (failure === 'recheck') assert.match(JSON.stringify(result), /12 seconds/);
    if (failure === 'membership') assert.match(JSON.stringify(result), /re-invite the bot/);
    if (failure === 'redirect') assert.match(JSON.stringify(result), /refuses upload redirects.*investigate/);
  });
}


test('already-gone file delete does not claim a global deletion effect', async t => {
  const f = accessFixture();
  f.state.uploadUrl = url;
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  f.web.files.delete = async () => { f.calls.push({ method: 'deleteFile', args: {} }); throw Object.assign(new Error('gone'), {
    code: 'slack_webapi_platform_error', data: { error: 'file_not_found' },
  }); };
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const uploaded = await h.host.sendRequest('tools/call', { name: 'upload_file', arguments: {
    channelId: 'C1', filename: 'x', content: 'x',
  } }) as { state: { parent: string } };
  const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: 'slack.messaging', checkpoint: uploaded.state.parent,
  }) as { reason: string };
  assert.equal(f.methods().filter(m => m === 'deleteFile').length, 1);
  assert.doesNotMatch(rolled.reason ?? '', /deletion removes|Slack refused to delete/);
});


test('invalid file ID refusal names the value and outcome before requests', async () => {
  const f = accessFixture();
  await assert.rejects(f.adapter.resolveFileDownload('C1', 'bad'), /Nothing was fetched: Invalid Slack file ID "bad"/);
  assert.deepEqual(f.calls, []);
});


test('legacy upload completion preserves primitive rejection and has no invented residue', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  for (const failure of ['primitive failure', null, undefined, 42]) {
    const f = accessFixture({ legacy: true });
    f.state.uploadUrl = url;
    f.web.files.completeUploadExternal = async () => { throw failure; };
    let caught = false;
    try { await f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }); }
    catch (err) {
      caught = true;
      assert.equal(err, failure);
      assert.equal(fileLeftByUpload(err), undefined);
    }
    assert.equal(caught, true);
  }
});

test('policy HTTP download rate limit retains valid Retry-After seconds and rejects malformed values', async t => {
  for (const [header, expected] of [['120', /Wait 120 seconds/], ['bad', /Try again shortly/], ['-1', /Try again shortly/]] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response('limited', { status: 429, headers: { 'retry-after': header } }));
    await assert.rejects(fetchAttachmentBytes(url, 'x', { redirect: 'error' }), expected);
    t.mock.restoreAll();
  }
});

test('null policy completion retains allocated file and uncertain sharing outcome', async t => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  const f = accessFixture(); f.state.uploadUrl = url;
  f.web.files.completeUploadExternal = async () => null as never;
  for (const messageId of [undefined, '1.0']) {
    await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }), err => {
      assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: true, policy: true });
      const text = explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1', messageId } });
      assert.match(text, messageId ? /fetch_thread/ : /fetch_history/);
      assert.match(text, /Upload outcome is unknown/);
      assert.match(text, /If inspection confirms the upload succeeded, keep it; do not remove it/);
      assert.match(text, /If it did not succeed/);
      return true;
    });
  }
});


test('upload redirect refusal survives rejected response cancellation', async t => {
  const f = accessFixture();
  f.state.uploadUrl = url;
  let cancellations = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancellations++; return Promise.reject(new Error('cancel failed')); },
  }), { status: 302, headers: { location: 'https://other.example/' } }));
  const { explainSlackError } = await import('../src/slack-errors.js');
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }), err => {
    assert.ok(err instanceof SlackAccessDenied);
    assert.match(explainSlackError(err, { tool: 'upload_file', args: { channelId: 'C1' } }), /refuses upload redirects/);
    assert.doesNotMatch(String(err), /cancel failed/);
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'F1', mayHaveShared: false, policy: true });
    return true;
  });
  assert.equal(cancellations, 1);
  assert.equal(f.methods().includes('complete'), false);
});

test('file evidence classifications distinguish lasting state from missing evidence', async () => {
  const base = { id: 'F1', mode: 'hosted', channels: ['C1'], url_private: url };
  for (const state of [{ deleted: true }, { is_tombstoned: true }, { is_external: true }, { mode: 'external' }, { mode: 'new' }]) {
    for (const run of [() => associatedFile({ ...base, ...state }, 'F1', 'C1'), () => privateFileUrl({ ...base, ...state })]) {
      assert.throws(run, err => {
        assert.ok(err instanceof SlackAccessDenied && !(err instanceof SlackAccessUnverified));
        assert.match(err.message, /sender.*supported file/); return true;
      });
    }
  }
  for (const file of [undefined, { ...base, mode: undefined }, { ...base, mode: null },
    { ...base, id: 'F2' }, { ...base, channels: ['C2'] }, { ...base, channels: ['C1', 'invalid'] },
    { ...base, shares: { public: { invalid: [{ ts: '1.0' }] } } }]) {
    assert.throws(() => associatedFile(file, 'F1', 'C1'), SlackAccessUnverified);
  }
  for (const raw of [undefined, '', 'https://untrusted.example/f']) {
    assert.throws(() => privateFileUrl({ ...base, url_private: raw }), SlackAccessUnverified);
  }
  await assert.rejects(withAccessContext('Nothing was fetched', async () => associatedFile({ ...base, channels: ['C2'] }, 'F1', 'C1')), err => {
    assert.ok(err instanceof SlackAccessUnverified);
    assert.match(err.message, /Check the file reference.*sender.*supported file/);
    assert.doesNotMatch(err.message, /check membership/); return true;
  });
});


for (const mode of ['hosted', 'snippet', 'post']) test(`authenticated supported mode ${mode} is readable`, () => {
  const file = { id: 'F1', mode, channels: ['C1'], url_private: url };
  assert.equal(associatedFile(file, 'F1', 'C1'), file);
  assert.equal(privateFileUrl(file).href, url);
});


for (const fields of [{ deleted: true }, { is_tombstoned: true }, { is_external: true }, { mode: 'tombstone' }, { mode: 'external' }]) {
  test(`confirmed unavailable file has replacement advice, not operator access advice: ${JSON.stringify(fields)}`, async t => {
    const f = await fixture(t);
    f.fileState.file = { mode: 'hosted', id: 'F1', channels: ['C1'], url_private: url, ...fields };
    const result = await f.call({ channelId: 'C1', fileId: 'F1' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /ask its sender to share a supported file/);
    assert.doesNotMatch(JSON.stringify(result), /whoever runs|check access|invite|reinstall/);
    assert.deepEqual(f.downloads, []);
  });
}

test('file flags accept literal false and refuse malformed values as unverified', () => {
  for (const key of ['deleted', 'is_tombstoned', 'is_external']) {
    const file = { mode: 'hosted', id: 'F1', channels: ['C1'], [key]: false };
    assert.equal(associatedFile(file, 'F1', 'C1'), file);
    for (const value of [null, 0, 'false', {}, []]) {
      assert.throws(() => associatedFile({ ...file, [key]: value }, 'F1', 'C1'), SlackAccessUnverified);
    }
  }
});

test('unassociated restrictive file states remain generic; empty mode remains unverified', async () => {
  for (const state of [{ deleted: true }, { is_external: true }, { mode: 'tombstone' }]) {
    assert.throws(() => associatedFile({ mode: 'hosted', id: 'F1', channels: ['COTHER'], ...state }, 'F1', 'C1'), SlackFileAccessUnverified);
  }
  assert.throws(() => associatedFile({ id: 'F1', channels: ['C1'], mode: '' }, 'F1', 'C1'), SlackFileAccessUnverified);
  const original = new SlackFileUnavailable('unavailable', undefined, false);
  await assert.rejects(withAccessContext('Nothing was fetched', async () => { throw original; }), err =>
    err instanceof SlackFileUnavailable && !err.authoritative && err === original);
});

test('policy declared-size refusal cancels the unread download body', async t => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } }));
  await assert.rejects(fetchAttachmentBytes(url, 'file', { redirect: 'error' }), /too large|limit|MiB|5 MB/i);
  assert.equal(cancelled, true);
});

test('legacy unknown file deletion errors do not become reaction advice', async () => {
  const { explainSlackError } = await import('../src/slack-errors.js');
  assert.equal(explainSlackError(new TypeError('bad response'), { tool: 'delete_file', args: { fileId: 'F1' } }), 'bad response');
});

for (const operation of ['download', 'upload'] as const) test(`a pending body cancellation cannot hang ${operation} redirect refusal`, async t => {
  const f = await fixture(t);
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => { cancelled = true; return new Promise<void>(() => {}); } });
  f.fetchMock.mock.mockImplementation(async () => new Response(body, { status: 302, headers: { location: 'https://files.slack.com/elsewhere' } }));
  const pending = operation === 'download'
    ? f.call({ channelId: 'C1', fileId: 'F1' }).then(result => { assert.equal(result.isError, true); assert.match(JSON.stringify(result), /redirect/); })
    : assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }), err => {
      assert.equal(fileLeftByUpload(err)?.fileId, 'F1'); assert.match(String(err), /redirect/); return true;
    });
  await Promise.race([pending, new Promise<never>((_, reject) => {
    setImmediate(() => reject(new Error('best-effort cancellation held refusal open')));
  })]);
  assert.equal(cancelled, true, 'redirect disposal callback was entered');
});

test('file admission tagging and access context preserve occurrence identity, not reusable source identity', async t => {
  const f = await fixture(t);
  const original = new Error('file metadata unavailable');
  f.web.files.info = async () => { throw original; };
  await assert.rejects(f.adapter.resolveFileDownload('C1', 'F1'), err => {
    assert.notEqual(err, original);
    assert.equal((err as Error).cause, original);
    assert.equal(original.message, 'file metadata unavailable');
    return true;
  });
});

for (const cancel of [() => { throw new Error('disposal'); }, () => undefined]) test('download redirect refusal survives nonstandard cancellation', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 302, body: { cancel } }) as unknown as Response);
  await assert.rejects(fetchAttachmentBytes(url, 'file', { redirect: 'error' }), /refuses file redirects/);
});


test('malformed share bucket refuses even with an otherwise valid channel association', () => {
  assert.throws(() => associatedFile({ id: 'F1', mode: 'hosted', channels: ['C1'], shares: { public: null } }, 'F1', 'C1'), err => err instanceof SlackFileAccessUnverified);
});
