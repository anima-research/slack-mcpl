import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { MAX_ATTACHMENT_BYTES } from '../src/content.js';
import { connectHost, initialize } from './harness.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, response: unknown = { files: [{ files: [{ id: 'F1' }] }] }) {
  const uploads: Record<string, unknown>[] = [];
  const slack = new SlackAdapter({
    filesUploadV2: async (args: Record<string, unknown>) => { uploads.push(args); return response; },
  } as any, { on() {} } as any, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  t.after(() => h.close());
  await initialize(h, false);
  const call = async (args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
    name: 'upload_file', arguments: { channelId: 'C1', filename: 'data.bin', ...args },
  }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { uploads, call };
}

test('upload handler requires exactly one content argument', async (t) => {
  const { uploads, call } = await fixture(t);
  for (const args of [{}, { content: 'hello', contentBase64: 'aGVsbG8=' }, { content: '', contentBase64: 'aGVsbG8=' }]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one of content or contentBase64/);
  }
  assert.equal(uploads.length, 0);
});

test('upload handler requires a filename', async (t) => {
  const { uploads, call } = await fixture(t);
  for (const filename of [undefined, '', 123]) {
    const result = await call({ filename, content: 'hello' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /filename is required/);
  }
  assert.equal(uploads.length, 0);
});

test('upload handler refuses empty content with an explicit empty-content error', async (t) => {
  const { uploads, call } = await fixture(t);
  for (const args of [{ content: '' }, { contentBase64: '' }]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /content.*empty/i);
    assert.doesNotMatch(result.content[0].text, /exactly one/);
  }
  assert.equal(uploads.length, 0);
});

test('upload handler refuses non-string content before Slack', async (t) => {
  const { uploads, call } = await fixture(t);
  for (const key of ['content', 'contentBase64']) {
    for (const value of [null, 123, {}, ['hello']]) {
      const result = await call({ [key]: value });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(`${key} must be a string`));
    }
  }
  assert.equal(uploads.length, 0);
});

test('upload handler refuses malformed and noncanonical base64 before Slack', async (t) => {
  const { uploads, call } = await fixture(t);
  for (const contentBase64 of ['data:text/plain;base64,aGVsbG8=', 'aGVsbG8=!', 'aGVs\nbG8=', 'aGVsbG8', 'a===', '====', 'aGVsbG8==', 'Zh==', 'SGVsbG_=', ' ']) {
    const result = await call({ contentBase64 });
    assert.equal(result.isError, true, contentBase64);
    assert.match(result.content[0].text, /valid base64/i);
  }
  assert.equal(uploads.length, 0);
});

test('upload handler enforces the inline cap on UTF-8 bytes and decoded base64 bytes', async (t) => {
  const { uploads, call } = await fixture(t);
  const tooLarge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 97);
  for (const args of [
    { content: tooLarge.toString('utf8') },
    { content: 'é'.repeat(MAX_ATTACHMENT_BYTES / 2 + 1) },
    { contentBase64: tooLarge.toString('base64') },
  ]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /too large/);
    assert.match(result.content[0].text, /server.*inline|inline.*server/i);
  }
  assert.equal(uploads.length, 0);
  // Base64's encoded representation exceeds the cap; its decoded bytes do not.
  const atLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES, 97);
  const result = await call({ contentBase64: atLimit.toString('base64') });
  assert.notEqual(result.isError, true);
  assert.deepEqual(uploads[0].file, atLimit);
});

test('upload handler preserves valid text, binary base64 and optional metadata', async (t) => {
  const { uploads, call } = await fixture(t);
  assert.notEqual((await call({ content: 'héllo', title: 'Report', comment: 'See this', messageId: '1.0' })).isError, true);
  assert.deepEqual(uploads[0], {
    channel_id: 'C1', file: Buffer.from('héllo'), filename: 'data.bin', title: 'Report', initial_comment: 'See this', thread_ts: '1.0',
  });
  const binary = Buffer.from([0, 255, 128, 10]);
  assert.notEqual((await call({ contentBase64: binary.toString('base64') })).isError, true);
  assert.deepEqual(uploads[1].file, binary);
});

test('Slack upload responses naming no file return a tool error', async (t) => {
  for (const response of [{}, { files: [] }, { files: [{}] }, { files: [{ files: [] }] }, { files: [{ files: [{}] }] },
    { files: [{ files: [{ id: '' }] }] }, { files: [{ files: [{ id: 123 }] }] }, { files: [{ files: [{ id: '   ' }] }] }]) {
    const { uploads, call } = await fixture(t, response);
    const result = await call({ content: 'hello' });
    assert.equal(result.isError, true, JSON.stringify(response));
    assert.match(result.content[0].text, /Slack.*named no file/);
    assert.equal(uploads.length, 1);
  }
});
