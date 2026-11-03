import assert from 'node:assert/strict';
import http from 'node:http';
import { method } from '@animalabs/mcpl-core';
import { associatedFile, privateFileUrl } from '../src/file-access.js';
import { fetchAttachmentBytes, MAX_ATTACHMENT_BYTES } from '../src/content.js';
import { fileLeftByUpload, SlackAdapter, SlackWebClient, SLACK_CLIENT_OPTIONS, withCallTime, CALL_SECONDS, type SlackWebLike } from '../src/slack-adapter.js';
import { fakeSlackApi } from './slackApi.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize, FULL_GRANT } from './harness.js';
import { accessTest as test, accessFixture, accessScopes, joined, fixturePolicy } from './adapterAccessFixture.js';

const url = 'https://files.slack.com/files-pri/T1-F1/canonical.txt';
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0], options: Parameters<typeof accessFixture>[0] = {}) {
  const f = accessFixture(options);
  const state = { file: { mode: 'hosted', id: 'F1', channels: ['C1'], url_private: url } as unknown };
  Object.assign(f.web.files, { info: async () => { f.calls.push({ method: 'fileInfo', args: {} }); return { file: state.file }; } });
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
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.downloads, []);
});

test('policy canonical file fetch rechecks association and refuses all redirects', async (t) => {
  const f = await fixture(t);
  assert.notEqual((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  assert.deepEqual(f.methods(), ['info', 'fileInfo']);
  assert.equal(f.downloads[0].url, url);
  assert.equal(f.downloads[0].init?.redirect, 'error');
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
  t.mock.method(globalThis, 'fetch', async () => {
    f.state.conversation = { ...f.state.conversation, is_member: false };
    return new Response('OK');
  });
  await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }));
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
  { mode: 'hosted', id: 'F1', shares: { public: { C1: [{}] } } }, { mode: 'hosted', id: 'F1', shares: [] },
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

test('schema declares protected IDs only in policy mode', async (t) => {
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
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xoxb-file-test');
    return new Response(null, { status: 302, headers: { location: 'https://other.example/secret' } });
  });
  const result = await f.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(result.isError, true);
  assert.equal(requests, 1);
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
    undefined, undefined, false, undefined, accessScopes, fixturePolicy());
  const h = connectHost(new SlackMcplServer(adapter));
  t.after(() => h.close());
  await initialize(h, false);
  let gets = 0;
  const endpoint = await bytesServer(t, (_req, res) => { gets++; res.writeHead(200, { 'content-type': 'text/plain' }).end('actual bytes'); });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, url);
    assert.equal(init?.redirect, 'error');
    return realFetch(endpoint, init);
  });
  const call = () => h.host.sendRequest('tools/call', { name: 'fetch_attachment', arguments: { channelId: 'C1', fileId: 'F1' } }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  assert.match((await call()).content[0].text, /actual bytes/);
  assert.deepEqual(api.calls, ['conversations.info', 'files.info']);
  assert.equal(api.sent[1].get('file'), 'F1');
  api.answerFor('files.info', { body: { ok: true, file: { mode: 'hosted', id: 'F1', channels: ['COTHER'], url_private: url } } });
  assert.equal((await call()).isError, true);
  assert.equal(gets, 1);
  for (const answer of [{ body: { ok: false, error: 'missing_scope' } }, { body: { ok: false, error: 'file_not_found' } },
    { status: 429, headers: { 'retry-after': '120' }, body: { ok: false, error: 'ratelimited' } }]) {
    api.answerFor('files.info', answer);
    assert.equal((await call()).isError, true);
  }
  assert.equal(gets, 1);
});

test('native transport rejects both same-origin and cross-origin redirects before a second GET', async (t) => {
  let reached = 0;
  const destination = await bytesServer(t, (_req, res) => { reached++; res.end('no'); });
  let redirect = destination;
  const origin = await bytesServer(t, (_req, res) => { res.writeHead(302, { location: redirect }).end(); });
  await assert.rejects(fetchAttachmentBytes(origin, 'x', { redirect: 'error' }));
  redirect = `${origin}/same-host`;
  await assert.rejects(fetchAttachmentBytes(origin, 'x', { redirect: 'error' }));
  assert.equal(reached, 0);
});

test('policy fetch retains streaming cap and exhausted-call start rule', async (t) => {
  const f = await fixture(t);
  f.fetchMock.mock.mockImplementation(async () => new Response(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)));
  assert.equal((await f.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  const client = new SlackWebClient('xoxb-test', SLACK_CLIENT_OPTIONS);
  const adapter = new SlackAdapter(client as unknown as SlackWebLike, { on() {}, async start() {}, async disconnect() {} }, 'UBOT', 'test',
    undefined, undefined, false, undefined, accessScopes, fixturePolicy());
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
  assert.match((await rollback(second.state.parent)).reason, /0\/1 files deleted/);
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
  f.web.files.info = async () => { throw Object.assign(new Error('no file'), { code: 'slack_webapi_platform_error', data: { error: 'file_not_found' } }); };
  t.mock.method(globalThis, 'fetch', async () => new Response('OK'));
  const h = connectHost(new SlackMcplServer(f.adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  const uploaded = await h.host.sendRequest('tools/call', { name: 'upload_file', arguments: { channelId: 'C1', filename: 'x', content: 'x' } }) as { state: { parent: string } };
  f.calls.length = 0;
  const rolled = await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: uploaded.state.parent }) as { reason: string };
  assert.match(rolled.reason, /1\/1 messages and 0\/1 files deleted/);
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
    await assert.rejects(f.adapter.uploadFile('C1', { filename: 'x', data: Buffer.from('x') }));
    assert.deepEqual(f.downloads, []);
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
    assert.deepEqual(fileLeftByUpload(err), { fileId: 'invalid-id', mayHaveShared: false });
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
      await assert.rejects(f.adapter.deleteFile('C1', 'F0'));
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
      config: { readJoinedChannels: false, writeChannels: [], dmUsers: [], groupDms: scenario === 'unnamed' ? [] : ['G1'] },
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
    assert.deepEqual(f.methods(), ['admitted', 'unrelated'].includes(scenario) ? ['info', 'fileInfo'] : ['info']);
  });
}

test('real group file upload requires mpim:write before a ticket or bytes', async (t) => {
  const f = await fixture(t, {
    config: { readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] },
    scopes: [...accessScopes, 'mpim:read'],
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
