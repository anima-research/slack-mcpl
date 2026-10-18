import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {SlackAdapter} from '../src/slack-adapter.js';
import {SlackMcplServer} from '../src/server.js';
import {MAX_ATTACHMENT_BYTES, SLACK_MAX_FILE_BYTES} from '../src/content.js';
import {PathUploadReader} from '../src/upload-path.js';
import type {PathUploadConfig} from '../src/upload-path.js';
import {connectHost, initialize, uploadEndpoint} from './harness.js';

async function fixture(t: {after(fn: () => unknown): void}, mode?: 'restricted' | 'unrestricted',
  options: {sendChannels?: string[]; disableDms?: boolean; maxBytes?: number} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'path-tool-'));
  const path = join(directory, 'report.txt'); writeFileSync(path, 'synthetic report');
  // Slack's three upload steps: each started upload is in `started`, and each
  // shared one in `uploads`, with the bytes its upload URL was sent.
  const endpoint = await uploadEndpoint();
  const started: any[] = [];
  const uploads: any[] = [];
  const prefix = `F${Math.random().toString(36).slice(2).toUpperCase()}`;
  const slack = new SlackAdapter({
    files: {
      async getUploadURLExternal(args: any) {
        started.push(args);
        const id = `${prefix}${started.length}`;
        return {upload_url: `${endpoint.url}/${id}`, file_id: id};
      },
      async completeUploadExternal(args: any) {
        const id = args.files[0].id;
        uploads.push({...args, filename: started.at(-1).filename, length: started.at(-1).length, file: endpoint.bytes.get(id)});
        return {files: [{id}]};
      },
    },
    conversations: {async info() {return {channel: {is_im: true}};}},
  } as any, {on() {}} as any, 'UBOT', 'test', undefined, options.sendChannels, options.disableDms);
  const limit = options.maxBytes === undefined ? {} : {maxBytes: options.maxBytes};
  const pathUploads: PathUploadConfig | undefined = mode === 'restricted' ? {mode, directories: [directory], ...limit}
    : mode === 'unrestricted' ? {mode, ...limit} : undefined;
  const server = new SlackMcplServer(slack, {pathUploads});
  const h = connectHost(server);
  t.after(async () => {await h.close(); server.close(); rmSync(directory, {recursive: true, force: true});});
  await initialize(h, false);
  return {...h, server, slack, directory, path, uploads, started,
    call: (args: Record<string, unknown>) => h.host.sendRequest('tools/call', {name: 'upload_file',
      arguments: {channelId: 'CDEST', ...args}}) as Promise<any>};
}

test('inline-only default retains schema/classes and refuses direct hidden path arguments', async t => {
  const h = await fixture(t);
  const {tools} = await h.host.sendRequest('tools/list', {}) as any;
  const upload = tools.find((tool: any) => tool.name === 'upload_file');
  assert.equal(upload.inputSchema.properties.path, undefined);
  assert.deepEqual(upload.inputSchema.required, ['channelId', 'filename']);
  assert.deepEqual(upload._meta['mcpl/class'], ['comms']);
  assert.equal((await h.call({path: h.path})).isError, true);
  assert.equal(h.started.length, 0);
  assert.equal((await h.call({filename: 'inline.txt', content: 'inline'})).isError, undefined);
});

for (const mode of ['restricted', 'unrestricted'] as const) {
  test(`${mode}: path capability is explicit, classed files+comms and sends only bounded bytes`, async t => {
    const h = await fixture(t, mode);
    const {tools} = await h.host.sendRequest('tools/list', {}) as any;
    const upload = tools.find((tool: any) => tool.name === 'upload_file');
    assert.ok(upload.inputSchema.properties.path);
    assert.deepEqual(upload.inputSchema.required, ['channelId']);
    assert.deepEqual(upload._meta['mcpl/class'], ['comms', 'files']);
    assert.equal((await h.call({path: h.path, messageId: '1.0', comment: 'report'})).isError, undefined);
    const effect = h.uploads[0];
    assert.ok(Buffer.isBuffer(effect.file));
    assert.equal(effect.file.toString(), 'synthetic report');
    assert.equal(effect.filename, 'report.txt');
    assert.equal(effect.thread_ts, '1.0');
    assert.equal(effect.initial_comment, 'report');
    assert.equal(effect.path, undefined);
  });
}

test('unrestricted mode preserves ordinary absolute parent spellings while restricted mode refuses them', async t => {
  for (const mode of ['restricted', 'unrestricted'] as const) {
    const h = await fixture(t, mode);
    mkdirSync(join(h.directory, 'sub'));
    const result = await h.call({path: `${h.directory}/sub/../report.txt`});
    assert.equal(result.isError, mode === 'restricted' ? true : undefined);
    assert.equal(h.uploads.length, mode === 'restricted' ? 0 : 1);
    if (mode === 'unrestricted') assert.equal(h.uploads[0].file.toString(), 'synthetic report');
  }
});

test('path cardinality, metadata and empty-file failures have no Slack effect', async t => {
  const h = await fixture(t, 'restricted');
  for (const args of [{path: h.path, content: 'inline'}, {path: h.path, contentBase64: ''},
    {path: h.path, filename: ''}, {path: 42}, {path: ''}]) {
    assert.equal((await h.call(args)).isError, true);
  }
  writeFileSync(h.path, '');
  const empty = await h.call({path: h.path});
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /empty/i);
  assert.equal(h.started.length, 0);
});

test('destination and DM guards run before local reads', async t => {
  for (const options of [{sendChannels: ['COTHER']}, {disableDms: true}]) {
    const h = await fixture(t, 'restricted', options);
    let reads = 0;
    (h.server as any).pathReader.read = async () => {reads++; return Buffer.from('must not read');};
    const result = await h.call({path: h.path, channelId: options.disableDms ? 'DPEER' : 'CDEST'});
    assert.equal(result.isError, true);
    assert.equal(reads, 0);
    assert.equal(h.started.length, 0);
  }
});

test('destination is revalidated after the file read before upload effects', async t => {
  const sendChannels = ['CDEST'];
  const h = await fixture(t, 'unrestricted', {sendChannels});
  const reader = (h.server as any).pathReader;
  const read = reader.read.bind(reader);
  reader.read = async (path: string) => {const data = await read(path); sendChannels[0] = 'COTHER'; return data;};
  assert.equal((await h.call({path: h.path})).isError, true);
  assert.equal(h.started.length, 0);
});

test('adapter never hands an unchecked path or oversized data to the Slack SDK', async t => {
  const h = await fixture(t, 'unrestricted');
  await assert.rejects(h.slack.uploadFile('CDEST', {filename: 'bad', data: h.path as any}), /bounded Buffer/);
  // Past Slack's own per-file limit, without allocating it.
  const large = Object.defineProperty(Buffer.alloc(1), 'byteLength', {value: SLACK_MAX_FILE_BYTES + 1});
  await assert.rejects(h.slack.uploadFile('CDEST', {filename: 'large', data: large}), /bounded Buffer/);
  assert.equal(h.started.length, 0);
});

test('malformed CLI mode fails without authenticating or printing its value', () => {
  for (const value of ['true', 'null', '{}', '{"mode":"restricted","directories":[]}',
    '{"mode":"unrestricted","directories":["/anything"]}', 'not-json',
    '{"mode":"unrestricted","maxBytes":0}', '{"mode":"unrestricted","maxBytes":1073741825}']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], {
      encoding: 'utf8', timeout: 5000,
      env: {PATH: process.env.PATH, SLACK_BOT_TOKEN: 'fixture', SLACK_APP_TOKEN: 'fixture', SLACK_PATH_UPLOADS: value},
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /SLACK_PATH_UPLOADS must configure/);
    assert.equal(child.stdout, '');
  }
});

const restrictedAvailable = (() => {
  try { new PathUploadReader({mode: 'restricted', directories: [tmpdir()]}).close(); return true; } catch { return false; }
})();

for (const mode of ['unrestricted', 'restricted'] as const) {
  test(`${mode}: maxBytes raises the path cap only, and the three steps get every byte`,
    {skip: mode === 'restricted' && !restrictedAvailable}, async t => {
      const six = 6 * 1024 * 1024;
      const capped = await fixture(t, mode);
      writeFileSync(join(capped.directory, 'six.bin'), Buffer.alloc(six, 9));
      const refused = await capped.call({path: join(capped.directory, 'six.bin')});
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /File exceeds the path upload limit of 5242880 bytes \(5 MiB\)/);
      assert.equal(capped.started.length, 0);

      const h = await fixture(t, mode, {maxBytes: 8 * 1024 * 1024});
      const {tools} = await h.host.sendRequest('tools/list', {}) as any;
      assert.match(tools.find((tool: any) => tool.name === 'upload_file').description,
        /Inline content is capped at 5 MiB .* path files up to 8 MiB \(8388608 bytes\)/);
      writeFileSync(join(h.directory, 'six.bin'), Buffer.alloc(six, 9));
      assert.equal((await h.call({path: join(h.directory, 'six.bin')})).isError, undefined);
      assert.equal(h.started[0].length, six);
      assert.equal(h.uploads[0].file.length, six);
      assert.ok(h.uploads[0].file.every((byte: number) => byte === 9));
      assert.equal(h.uploads[0].filename, 'six.bin');
      // Inline content keeps its 5 MiB cap.
      const inline = await h.call({filename: 'big.txt', contentBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')});
      assert.equal(inline.isError, true);
      assert.match(inline.content[0].text, /inline file too large/);
      assert.equal(h.started.length, 1);
    });
}
