import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
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
    assert.equal(result.content[0].text, 'Nothing was uploaded: pass exactly one of content or contentBase64');
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

test('upload handler requires a conversation', async (t) => {
  const { asked, call } = await fixture(t);
  for (const [channelId, passed] of [[undefined, 'left it out'], ['', 'passed an empty string'], [42, 'passed a number']]) {
    const result = await call({ channelId, content: 'hello' });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      `Nothing was done: channelId must be a non-empty string, and this call ${passed}. list_channels shows each ` +
        "conversation's id.",
    );
  }
  assert.equal(asked.length, 0);
});

test("upload_file's schema names what its handler reads: these arguments, each a string, two of them required, each refused when it isn't one", async (t) => {
  const schema = toolDefinitions.find((d) => d.name === 'upload_file')!.inputSchema as {
    properties: Record<string, { type: string }>; required: string[];
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['channelId', 'comment', 'content', 'contentBase64', 'filename', 'messageId', 'title']);
  assert.deepEqual([...schema.required].sort(), ['channelId', 'filename']);
  const { asked, call } = await fixture(t);
  for (const [name, property] of Object.entries(schema.properties)) {
    assert.equal(property.type, 'string', name);
    // A number where the schema says a string is refused as one; contentBase64
    // goes alone, since with content the call is refused for giving both.
    const result = await call(name === 'contentBase64' ? { [name]: 17 } : { content: 'hello', [name]: 17 });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, new RegExp(`${name} must be a (non-empty )?string`), name);
  }
  assert.equal(asked.length, 0);
});

test('upload handler refuses empty content with an explicit empty-content error', async (t) => {
  const { asked, call } = await fixture(t);
  for (const key of ['content', 'contentBase64']) {
    const result = await call({ [key]: '' });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `Nothing was uploaded: ${key} is empty: give the file's content, at least one byte`);
  }
  assert.equal(asked.length, 0);
});

test('upload handler refuses non-string content before Slack', async (t) => {
  const { asked, call } = await fixture(t);
  for (const key of ['content', 'contentBase64']) {
    for (const value of [123, {}, ['hello']]) {
      const result = await call({ [key]: value });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, `Nothing was uploaded: ${key} must be a string`);
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
      assert.equal(result.content[0].text, `Nothing was uploaded: ${key} must be a string`);
    }
  }
  assert.equal(asked.length, 0);
});

test('text holding a lone UTF-16 surrogate is refused before Slack, and a whole pair is taken', async (t) => {
  const { asked, bytes, call } = await fixture(t);
  for (const content of ['\uD800', 'a\uDC00b', 'x\uD83D']) {
    const result = await call({ content });
    assert.equal(result.isError, true, JSON.stringify(content));
    assert.match(result.content[0].text, /^Nothing was uploaded: content holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it, or pass the file's bytes as contentBase64/);
  }
  for (const key of ['filename', 'title', 'comment']) {
    const result = await call({ content: 'a', [key]: 'x\uD800y' });
    assert.equal(result.isError, true, key);
    assert.match(result.content[0].text, new RegExp(`^Nothing was uploaded: ${key} holds a lone UTF-16 surrogate, which UTF-8 can't encode: remove it from the`));
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
    assert.equal(result.content[0].text,
      'Nothing was uploaded: contentBase64 must be canonical RFC 4648 base64 with padding, on one line: no line breaks, spaces or data URI');
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
    assert.match(result.content[0].text, /^Nothing was uploaded: inline file too large: \d+ bytes, past this server's inline limit of \d+ bytes, so upload_file can't send it\. A smaller file can go/);
  }
  assert.equal(asked.length, 0);
  // Base64's encoded representation exceeds the cap; its decoded bytes do not.
  const atLimit = Buffer.alloc(LIMIT, 97);
  const result = await call({ contentBase64: atLimit.toString('base64') });
  assert.notEqual(result.isError, true);
  assert.deepEqual(bytes(1), atLimit);
});

test("content past the cap, and contentBase64 longer than the cap's own base64, are refused before they're made into bytes (R1-1)", async (t) => {
  const { asked, call } = await fixture(t);
  const base64Cap = Math.ceil(LIMIT / 3) * 4;
  for (const [key, input, says] of [
    ['content', 'é'.repeat(LIMIT / 2 + 1), `inline file too large: ${LIMIT + 2} bytes, past this server's inline limit of ${LIMIT} bytes`],
    ['contentBase64', 'A'.repeat(base64Cap + 4), `inline file too large: contentBase64 is ${base64Cap + 4} characters, and ` +
      `canonical base64 longer than ${base64Cap} characters holds more than this server's inline limit of ${LIMIT} bytes`],
  ] as const) {
    // Buffer.from, watched for the input itself.
    const made: string[] = [];
    const from = Buffer.from;
    const watched = t.mock.method(Buffer, 'from', function (this: unknown, ...args: unknown[]) {
      if (args[0] === input) made.push(key);
      return (from as (...a: unknown[]) => Buffer).apply(this, args);
    });
    const result = await call({ [key]: input });
    watched.mock.restore();
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.startsWith(`Nothing was uploaded: ${says}`), result.content[0].text);
    assert.deepEqual(made, [], 'the input was never made into bytes');
  }
  assert.equal(asked.length, 0);
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
