import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize, uploadEndpoint } from './harness.js';

/** The documented inline limit: 5 MiB of file bytes. */
const LIMIT = 5 * 1024 * 1024;

/** An upload_file caller over a fake client whose steps record what they're
 *  given: `asked` holds each files.getUploadURLExternal's arguments, `shared`
 *  each files.completeUploadExternal's, and `bytes` what each file's upload
 *  URL took. The last step answers with `answer`, given the file's ID. */
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  answer: (id: string) => unknown = (id) => ({ files: [{ id }] }),
) {
  const asked: Record<string, unknown>[] = [];
  const shared: Record<string, unknown>[] = [];
  const { url, bytes } = await uploadEndpoint();
  let n = 0;
  const slack = new SlackAdapter({
    files: {
      getUploadURLExternal: async (args: Record<string, unknown>) => {
        asked.push(args);
        const id = `FV${++n}`;
        return { upload_url: `${url}/${id}`, file_id: id };
      },
      completeUploadExternal: async (args: Record<string, unknown>) => {
        shared.push(args);
        return answer((args.files as Array<{ id: string }>)[0].id);
      },
      delete: async () => ({}),
    },
  } as any, { on() {} } as any, 'UBOT', 'acme');
  const h = connectHost(new SlackMcplServer(slack));
  t.after(() => h.close());
  await initialize(h, false);
  const call = async (args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
    name: 'upload_file', arguments: { channelId: 'C1', filename: 'data.bin', ...args },
  }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { asked, shared, bytes: (i: number) => bytes.get(`FV${i}`), call };
}

test('upload handler requires exactly one content argument', async (t) => {
  const { asked, call } = await fixture(t);
  for (const args of [{}, { content: 'hello', contentBase64: 'aGVsbG8=' }, { content: '', contentBase64: 'aGVsbG8=' }, { content: null, contentBase64: null }]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one of content or contentBase64/);
  }
  assert.equal(asked.length, 0);
});

test('a JSON null counts as an argument not given, and so does an empty string for an optional one', async (t) => {
  const { shared, bytes, call } = await fixture(t);
  assert.notEqual((await call({ content: 'hello', contentBase64: null, title: null, comment: null, messageId: null })).isError, true);
  assert.deepEqual(bytes(1), Buffer.from('hello'));
  assert.deepEqual(shared[0], { files: [{ id: 'FV1', title: 'data.bin' }], channel_id: 'C1' });
  assert.notEqual((await call({ content: 'hello', title: '', comment: '', messageId: '' })).isError, true);
  assert.deepEqual(shared[1], { files: [{ id: 'FV2', title: 'data.bin' }], channel_id: 'C1' });
});

test('upload handler requires a filename', async (t) => {
  const { asked, call } = await fixture(t);
  for (const [filename, passed] of [[undefined, 'left it out'], ['', 'passed an empty string'], [123, 'passed a number']]) {
    const result = await call({ filename, content: 'hello' });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      `Nothing was done: filename must be a non-empty string, and this call ${passed}. Pass the name the file is ` +
        'shown with in Slack, with its extension, such as positions.csv.',
    );
  }
  assert.equal(asked.length, 0);
});

test('upload handler refuses empty content with an explicit empty-content error', async (t) => {
  const { asked, call } = await fixture(t);
  for (const key of ['content', 'contentBase64']) {
    const result = await call({ [key]: '' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`^${key} is empty: give the file's content, at least one byte`));
  }
  assert.equal(asked.length, 0);
});

test('upload handler refuses non-string content before Slack', async (t) => {
  const { asked, call } = await fixture(t);
  for (const key of ['content', 'contentBase64']) {
    for (const value of [123, {}, ['hello']]) {
      const result = await call({ [key]: value });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(`${key} must be a string`));
    }
  }
  assert.equal(asked.length, 0);
});

test('an optional argument that is not a string is refused before Slack, not dropped', async (t) => {
  const { asked, call } = await fixture(t);
  for (const key of ['messageId', 'comment', 'title']) {
    for (const value of [17, true, {}, ['1.0']]) {
      const result = await call({ content: 'hello', [key]: value });
      assert.equal(result.isError, true, `${key}: ${JSON.stringify(value)}`);
      assert.match(result.content[0].text, new RegExp(`^${key} must be a string`));
    }
  }
  assert.equal(asked.length, 0);
});

test('text holding a lone UTF-16 surrogate is refused before Slack, and a whole pair is taken', async (t) => {
  const { asked, bytes, call } = await fixture(t);
  for (const content of ['\uD800', 'a\uDC00b', 'x\uD83D']) {
    const result = await call({ content });
    assert.equal(result.isError, true, JSON.stringify(content));
    assert.match(result.content[0].text, /^content holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it, or pass the file's bytes as contentBase64/);
  }
  for (const key of ['filename', 'title', 'comment']) {
    const result = await call({ content: 'a', [key]: 'x\uD800y' });
    assert.equal(result.isError, true, key);
    assert.match(result.content[0].text, new RegExp(`^${key} holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it from the`));
  }
  assert.equal(asked.length, 0);
  assert.notEqual((await call({ content: 'smile \uD83D\uDE00' })).isError, true);
  assert.deepEqual(bytes(1), Buffer.from('smile 😀', 'utf8'));
});

test('upload handler refuses malformed and noncanonical base64 before Slack', async (t) => {
  const { asked, call } = await fixture(t);
  // 'aGVs\nbG8gd29ybGQ' is 16 characters, a length base64 can have, so only
  // writing it back tells that its line break isn't base64.
  for (const contentBase64 of ['data:text/plain;base64,aGVsbG8=', 'aGVsbG8=!', 'aGVs\nbG8=', 'aGVs\nbG8gd29ybGQ', 'aGVsbG8', 'a===', '====', 'aGVsbG8==', 'Zh==', 'SGVsbG_=', ' ']) {
    const result = await call({ contentBase64 });
    assert.equal(result.isError, true, contentBase64);
    assert.match(result.content[0].text, /canonical RFC 4648 base64 with padding, on one line: no line breaks, spaces or data URI/);
  }
  assert.equal(asked.length, 0);
});

test('upload handler enforces the inline cap on UTF-8 bytes and decoded base64 bytes', async (t) => {
  const { asked, bytes, call } = await fixture(t);
  const tooLarge = Buffer.alloc(LIMIT + 1, 97);
  for (const args of [
    { content: tooLarge.toString('utf8') },
    { content: 'é'.repeat(LIMIT / 2 + 1) },
    { contentBase64: tooLarge.toString('base64') },
  ]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^inline file too large: \d+ bytes, past this server's inline limit of \d+ bytes, so upload_file can't send it\. A smaller file can go/);
  }
  assert.equal(asked.length, 0);
  // Base64's encoded representation exceeds the cap; its decoded bytes do not.
  const atLimit = Buffer.alloc(LIMIT, 97);
  const result = await call({ contentBase64: atLimit.toString('base64') });
  assert.notEqual(result.isError, true);
  assert.deepEqual(bytes(1), atLimit);
});

test('upload handler preserves valid text, binary base64 and optional metadata, through the three steps', async (t) => {
  const { asked, shared, bytes, call } = await fixture(t);
  assert.notEqual((await call({ content: 'héllo', title: 'Report', comment: 'See this', messageId: '1.0' })).isError, true);
  assert.deepEqual(asked[0], { filename: 'data.bin', length: 6 });
  assert.deepEqual(bytes(1), Buffer.from('héllo'));
  assert.deepEqual(shared[0], {
    files: [{ id: 'FV1', title: 'Report' }], channel_id: 'C1', initial_comment: 'See this', thread_ts: '1.0',
  });
  const binary = Buffer.from([0, 255, 128, 10]);
  assert.notEqual((await call({ contentBase64: binary.toString('base64') })).isError, true);
  assert.deepEqual(bytes(2), binary);
});

test("an upload whose last step's answer names no file says whether it was shared is unknown", async (t) => {
  for (const answer of [() => ({}), () => ({ files: [] }), () => ({ files: [{}] }), () => ({ files: [{ id: 'FOTHER' }] })]) {
    const { shared, call } = await fixture(t, answer);
    const result = await call({ content: 'hello' });
    assert.equal(result.isError, true, JSON.stringify(answer()));
    assert.equal(result.content[0].text,
      'files.completeUploadExternal: the answer named no file FV1\n\n' +
        "Slack's answer to the upload's last step named no file, so whether the file was shared is unknown. Check " +
        "fetch_history for conversation C1 before uploading again, so it isn't shared twice.");
    assert.equal(shared.length, 1);
  }
});
