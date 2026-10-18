import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { constants, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../src/content.js';
import { PathUploadReader, validatePathUploadPolicy, RESTRICTED_UPLOAD_WORKER_SOURCE } from '../src/upload-path.js';

function fixture(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slack-upload-reader-')));
  const root = join(base, 'root'), outside = join(base, 'root-other');
  mkdirSync(root); mkdirSync(outside); mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'file'), 'safe'); writeFileSync(join(root, 'nested', 'file'), 'nested');
  writeFileSync(join(outside, 'file'), 'outside');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, outside };
}
function reader(t: any, root: string) {
  const value = new PathUploadReader({ mode: 'restricted', directories: [root] });
  t.after(() => value.close());
  return value;
}

for (const policy of [null, {}, [], true, { mode: 'unknown' }, { mode: 'unrestricted', directories: undefined },
  { mode: 'unrestricted', extra: true }, { mode: 'restricted', directories: [] },
  { mode: 'restricted', directories: ['relative'] }, { mode: 'restricted', directories: ['/a\0b'] },
  { mode: 'restricted', directories: ['/a', 1] }, { mode: 'restricted', directories: ['/a'], extra: false }]) {
  test(`invalid policy fails closed: ${JSON.stringify(policy)}`, () => {
    assert.throws(() => validatePathUploadPolicy(policy));
    assert.throws(() => new PathUploadReader(policy as any));
  });
}

test('policy is a copied frozen value, including directories and nonenumerable unknown keys', () => {
  const source = { mode: 'restricted' as const, directories: ['/one'] };
  const result = validatePathUploadPolicy(source);
  source.directories.push('/two');
  assert.deepEqual(result, { mode: 'restricted', directories: ['/one'] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen((result as any).directories), true);
  assert.throws(() => validatePathUploadPolicy(Object.defineProperty({ mode: 'unrestricted' }, 'other', { value: 1 })));
});

test('restricted reader accepts configured/canonical aliases and nested regular files without changing cwd', async (t) => {
  const h = fixture(t), initialCwd = process.cwd();
  const alias = join(h.base, 'alias'); symlinkSync(h.root, alias);
  const r = reader(t, alias);
  assert.deepEqual(await r.read(join(alias, 'file')), Buffer.from('safe'));
  assert.deepEqual(await r.read(join(h.root, 'nested', 'file')), Buffer.from('nested'));
  assert.equal(process.cwd(), initialCwd);
  rmSync(alias); symlinkSync(h.outside, alias);
  assert.deepEqual(await r.read(join(alias, 'file')), Buffer.from('safe')); // alias is pinned at construction
});

test('restricted paths reject siblings, traversal, NULs, relative paths, roots and every inner symlink', async (t) => {
  const h = fixture(t), r = reader(t, h.root);
  symlinkSync(join(h.root, 'file'), join(h.root, 'internal-link'));
  symlinkSync(join(h.outside, 'file'), join(h.root, 'external-link'));
  symlinkSync(join(h.root, 'nested'), join(h.root, 'internal-dir'));
  symlinkSync(h.outside, join(h.root, 'external-dir'));
  for (const path of [join(h.outside, 'file'), `${h.root}/../root-other/file`, `${h.root}/f\0ile`, 'relative', h.root,
    join(h.root, 'internal-link'), join(h.root, 'external-link'), join(h.root, 'internal-dir', 'file'), join(h.root, 'external-dir', 'file')]) {
    await assert.rejects(r.read(path));
  }
});

test('configured root replacement fails rather than admitting its new tree', async (t) => {
  const h = fixture(t), r = reader(t, h.root);
  renameSync(h.root, join(h.base, 'moved'));
  mkdirSync(h.root); writeFileSync(join(h.root, 'file'), 'replacement');
  await assert.rejects(r.read(join(h.root, 'file')), /root.*replaced|root.*moved/);
});

test('overlapping roots choose the most specific pinned root', async (t) => {
  const h = fixture(t), nested = join(h.root, 'nested');
  const r = new PathUploadReader({ mode: 'restricted', directories: [h.root, nested] });
  t.after(() => r.close());
  assert.deepEqual(await r.read(join(nested, 'file')), Buffer.from('nested'));
  renameSync(nested, join(h.root, 'moved')); mkdirSync(nested); writeFileSync(join(nested, 'file'), 'replacement');
  await assert.rejects(r.read(join(nested, 'file')), /root.*replaced|root.*moved/);
});

test('both readers reject nonregular files and accept exact cap/empty regular files', async (t) => {
  const h = fixture(t);
  childProcess.execFileSync('mkfifo', [join(h.root, 'pipe')]);
  const unrestricted = new PathUploadReader({ mode: 'unrestricted' }); t.after(() => unrestricted.close());
  for (const r of [reader(t, h.root), unrestricted]) {
    await assert.rejects(r.read(join(h.root, 'nested')), /regular file/);
    await assert.rejects(r.read(join(h.root, 'pipe')), /regular file/);
    writeFileSync(join(h.root, 'bytes'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await assert.rejects(r.read(join(h.root, 'bytes')), /5 MiB/);
    writeFileSync(join(h.root, 'bytes'), Buffer.alloc(MAX_ATTACHMENT_BYTES, 3));
    assert.equal((await r.read(join(h.root, 'bytes'))).length, MAX_ATTACHMENT_BYTES);
    writeFileSync(join(h.root, 'bytes'), '');
    assert.equal((await r.read(join(h.root, 'bytes'))).length, 0);
  }
});

test('unrestricted mode needs no Python, permits symlinks and retains OS access limits', async (t) => {
  const h = fixture(t);
  const mock = t.mock.method(childProcess, 'spawnSync', () => { throw new Error('must not probe Python'); });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const r = new PathUploadReader({ mode: 'unrestricted' }); t.after(() => r.close());
  symlinkSync(join(h.outside, 'file'), join(h.root, 'link'));
  assert.deepEqual(await r.read(join(h.root, 'link')), Buffer.from('outside'));
  await assert.rejects(r.read('/dev/null'), /regular file/);
});

test('restricted mode fails closed when optional Python capability probing fails', (t) => {
  const h = fixture(t);
  const mock = t.mock.method(childProcess, 'spawnSync', () => ({ status: 1, stderr: 'untrusted secret text', stdout: '' }));
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => new PathUploadReader({ mode: 'restricted', directories: [h.root] }), (error: any) => {
    assert.match(error.message, /Python 3.9/); assert.ok(!error.message.includes('secret')); return true;
  });
});

test('constructor failure closes previously pinned roots and close is idempotent', (t) => {
  const h = fixture(t), fds: number[] = [], original = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args: any[]) => { const fd = (original as any)(...args); fds.push(fd); return fd; });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => new PathUploadReader({ mode: 'restricted', directories: [h.root, join(h.base, 'missing')] }));
  assert.equal(fds.length, 1); assert.throws(() => fstatSync(fds[0]), /bad file descriptor|EBADF/);
  const r = reader(t, h.root); r.close(); r.close();
  assert.throws(() => fstatSync(fds.at(-1)!), /bad file descriptor|EBADF/);
});

test('unrestricted reader caps growth despite stale size and closes the same descriptor', async (t) => {
  let closed = 0, capacity = 0;
  const mock = t.mock.method(fsPromises, 'open', async () => ({
    stat: async () => ({ isFile: () => true, size: 1 }),
    read: async (_data: Buffer, _offset: number, length: number) => { capacity += length; return { bytesRead: length }; },
    close: async () => { closed++; },
  }));
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const r = new PathUploadReader({ mode: 'unrestricted' }); t.after(() => r.close());
  await assert.rejects(r.read('/fake/growing'), /5 MiB/);
  assert.equal(closed, 1); assert.equal(capacity, MAX_ATTACHMENT_BYTES + 1);
});

// Derivative programs run only in this test runner. Production's static worker
// does not inspect a test flag, request hook, environment code or arbitrary script.
async function runWorker(t: any, root: string, parts: string[], source: string) {
  const r = reader(t, root), python: string = (r as any).python;
  const fd = openSync(realpathSync(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const child = childProcess.spawn(python, ['-I', '-S', '-c', source], { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe', fd] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout!.on('data', (data) => stdout.push(data)); child.stderr!.on('data', (data) => stderr.push(data));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdin!.end(JSON.stringify({ root: realpathSync(root), parts }));
  try {
    const code = await new Promise<number | null>((done, reject) => { child.on('close', done); child.on('error', reject); });
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() };
  } finally { clearTimeout(timeout); closeSync(fd); }
}
const py = (text: string) => JSON.stringify(text);
function observeReads(source: string, marker: string) {
  return source.replace('LIMIT = ', `original_read = os.read\ndef observed_read(fd, size):\n    with open(${py(marker)}, 'w') as marker: marker.write('read')\n    return original_read(fd, size)\nos.read = observed_read\nLIMIT = `);
}

for (const schedule of ['file-before-admission', 'parent-before-leaf', 'file-after-read', 'root-before-admission', 'unlinked-file'] as const) {
  test(`actual descriptor checks reject deterministic mutation: ${schedule}`, async (t) => {
    const h = fixture(t), marker = join(h.base, 'read-marker');
    let source = observeReads(RESTRICTED_UPLOAD_WORKER_SOURCE, marker);
    if (schedule === 'file-before-admission') source = source.replace('    info = os.fstat(file)', `    os.rename(${py(join(h.root, 'nested', 'file'))}, ${py(join(h.outside, 'moved'))})\n    info = os.fstat(file)`);
    if (schedule === 'parent-before-leaf') source = source.replace('    file = opened(parts[-1]', `    os.rename(${py(join(h.root, 'nested'))}, ${py(join(h.outside, 'moved-parent'))})\n    file = opened(parts[-1]`);
    if (schedule === 'file-after-read') source = source.replace("    if size > LIMIT: refuse('TOO_LARGE')\n    beneath(file, canonical)", `    if size > LIMIT: refuse('TOO_LARGE')\n    os.rename(${py(join(h.root, 'nested', 'file'))}, ${py(join(h.outside, 'moved'))})\n    beneath(file, canonical)`);
    if (schedule === 'root-before-admission') source = source.replace('    info = os.fstat(file)', `    os.rename(${py(h.root)}, ${py(join(h.outside, 'moved-root'))})\n    info = os.fstat(file)`);
    if (schedule === 'unlinked-file') source = source.replace('    info = os.fstat(file)', `    os.unlink(${py(join(h.root, 'nested', 'file'))})\n    info = os.fstat(file)`);
    const result = await runWorker(t, h.root, ['nested', 'file'], source);
    assert.equal(result.code, 1); assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr, schedule === 'root-before-admission' ? 'ROOT_CHANGED' : 'OUTSIDE');
    assert.equal(existsSync(marker), schedule === 'file-after-read');
  });
}

test('dirfd traversal does not follow an ancestor swapped to an outside symlink', async (t) => {
  const h = fixture(t);
  const source = RESTRICTED_UPLOAD_WORKER_SOURCE.replace('    file = opened(parts[-1]', `    os.rename(${py(join(h.root, 'nested'))}, ${py(join(h.root, 'moved-nested'))})\n    os.symlink(${py(h.outside)}, ${py(join(h.root, 'nested'))})\n    file = opened(parts[-1]`);
  const result = await runWorker(t, h.root, ['nested', 'file'], source);
  assert.equal(result.code, 0); assert.deepEqual(result.stdout, Buffer.from('nested'));
});

test('restricted worker caps bytes if the file grows after fstat', async (t) => {
  const h = fixture(t);
  const source = RESTRICTED_UPLOAD_WORKER_SOURCE.replace('    beneath(file, canonical)', `    with open(${py(join(h.root, 'nested', 'file'))}, 'wb') as growing: growing.truncate(LIMIT + 1)\n    beneath(file, canonical)`);
  const result = await runWorker(t, h.root, ['nested', 'file'], source);
  assert.equal(result.code, 1); assert.equal(result.stderr, 'TOO_LARGE'); assert.equal(result.stdout.length, 0);
});

test('restricted worker never realpaths a mutable descriptor-path string', async (t) => {
  const h = fixture(t);
  const source = RESTRICTED_UPLOAD_WORKER_SOURCE.replace('    beneath(file, canonical)', "    os.path.realpath = lambda *args: (_ for _ in ()).throw(RuntimeError('unexpected pathname resolution'))\n    beneath(file, canonical)");
  const result = await runWorker(t, h.root, ['nested', 'file'], source);
  assert.equal(result.code, 0); assert.deepEqual(result.stdout, Buffer.from('nested'));
});

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0; child.kill = () => { child.kills++; return true; };
  return child;
}
function replaceSpawn(t: any, replacement: (...args: any[]) => any) {
  const mock = t.mock.method(childProcess, 'spawn', replacement);
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test('helper uses isolated Python, fixed environment, fd3 and sanitized failures without partial output', async (t) => {
  const h = fixture(t), r = reader(t, h.root), child = fakeChild();
  replaceSpawn(t, (_executable, args, opts) => {
    assert.deepEqual(args.slice(0, 3), ['-I', '-S', '-c']);
    assert.deepEqual(Object.keys(opts.env), ['PATH']);
    assert.ok(!opts.env.PATH.includes('.:')); assert.equal(opts.shell, false); assert.equal(opts.cwd, '/');
    assert.equal(fstatSync(opts.stdio[3]).isDirectory(), true);
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('partial data')); child.stderr.emit('data', Buffer.from('untrusted token-shaped test value')); child.emit('close', 1); });
    return child;
  });
  await assert.rejects(r.read(join(h.root, 'file')), (error: any) => { assert.equal(error.message, 'Restricted upload reader failed'); return true; });
});

for (const stream of ['stdout', 'stderr']) {
  test(`parent bounds ${stream} and kills the helper`, async (t) => {
    const h = fixture(t), r = reader(t, h.root), child = fakeChild();
    replaceSpawn(t, () => {
      queueMicrotask(() => { child[stream].emit('data', Buffer.alloc(stream === 'stdout' ? MAX_ATTACHMENT_BYTES + 1 : 1025)); child.emit('close', 0); });
      return child;
    });
    await assert.rejects(r.read(join(h.root, 'file'))); assert.equal(child.kills, 1);
  });
}

test('timeout kills helper and close retains pinned FD until child closure then releases it', async (t) => {
  const h = fixture(t), r = reader(t, h.root), child = fakeChild(); let rootFd = -1;
  replaceSpawn(t, (_exe, _args, opts) => { rootFd = opts.stdio[3]; return child; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = r.read(join(h.root, 'file')), rejected = assert.rejects(pending, /timed out/);
  t.mock.timers.tick(5000); assert.equal(child.kills, 1);
  r.close(); assert.equal(fstatSync(rootFd).isDirectory(), true);
  child.emit('close', null); await rejected;
  assert.throws(() => fstatSync(rootFd), /bad file descriptor|EBADF/);
  await assert.rejects(r.read(join(h.root, 'file')), /closed/);
});


test('a parent returned under root cannot authorize its file FD moved elsewhere', async (t) => {
  const h = fixture(t), marker = join(h.base, 'read-marker'), moved = join(h.outside, 'moved-parent');
  let source = observeReads(RESTRICTED_UPLOAD_WORKER_SOURCE, marker);
  source = source.replace('    file = opened(parts[-1]', `    os.rename(${py(join(h.root, 'nested'))}, ${py(moved)})\n    file = opened(parts[-1]`);
  source = source.replace('    info = os.fstat(file)', `    os.rename(${py(join(moved, 'file'))}, ${py(join(h.outside, 'held-file'))})\n    os.rename(${py(moved)}, ${py(join(h.root, 'nested'))})\n    info = os.fstat(file)`);
  const result = await runWorker(t, h.root, ['nested', 'file'], source);
  assert.equal(result.code, 1); assert.equal(result.stderr, 'OUTSIDE');
  assert.equal(result.stdout.length, 0); assert.equal(existsSync(marker), false);
});

test('Linux rejects an unlinked opened dentry even with another hardlink', { skip: process.platform !== 'linux' }, async (t) => {
  const h = fixture(t);
  const source = RESTRICTED_UPLOAD_WORKER_SOURCE.replace('    info = os.fstat(file)', `    os.link(${py(join(h.root, 'nested', 'file'))}, ${py(join(h.root, 'other-link'))})\n    os.unlink(${py(join(h.root, 'nested', 'file'))})\n    info = os.fstat(file)`);
  const result = await runWorker(t, h.root, ['nested', 'file'], source);
  assert.equal(result.code, 1); assert.equal(result.stderr, 'OUTSIDE'); assert.equal(result.stdout.length, 0);
});

test('asynchronous helper startup errors are sanitized and settle on close', async (t) => {
  const h = fixture(t), r = reader(t, h.root), child = fakeChild();
  replaceSpawn(t, () => { queueMicrotask(() => { child.emit('error', new Error('private diagnostic')); child.emit('close', -1); }); return child; });
  await assert.rejects(r.read(join(h.root, 'file')), (error: any) => {
    assert.equal(error.message, 'Could not start restricted upload reader'); return true;
  });
});
