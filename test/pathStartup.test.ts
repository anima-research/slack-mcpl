import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, fstatSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startupSettings } from '../src/config.js';

const tokens = { SLACK_BOT_TOKEN: 'fixture-bot', SLACK_APP_TOKEN: 'fixture-app' };
const start = (raw?: string) => startupSettings(['--stdio'], {
  ...tokens, ...(raw === undefined ? {} : { SLACK_PATH_UPLOADS: raw }),
});
function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), 'path-startup-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function refused(result: ReturnType<typeof start>) {
  assert.ok('refusal' in result);
  assert.match(result.refusal, /^SLACK_PATH_UPLOADS /);
  assert.doesNotMatch(result.refusal, /private|fixture-bot|fixture-app|\n|Error:| at /);
}

test('startup leaves path access absent unless explicitly configured', () => {
  const result = start();
  assert.ok('settings' in result);
  assert.equal(result.settings.pathUploads, undefined);
});

for (const [name, raw] of Object.entries({
  empty: '', whitespace: ' ', malformed: 'private-not-json', boolean: 'true', null: 'null', array: '[]',
  missingMode: '{}', unknownMode: '{"mode":"private-mode"}',
  emptyRoots: '{"mode":"restricted","directories":[]}',
  relativeRoot: '{"mode":"restricted","directories":["private-relative"]}',
  nulRoot: JSON.stringify({ mode: 'restricted', directories: ['/private\0root'] }),
  unknownKey: '{"mode":"unrestricted","private-key":true}',
  unrestrictedRoots: '{"mode":"unrestricted","directories":["/private-root"]}',
  zeroCap: '{"mode":"unrestricted","maxBytes":0}',
  fractionalCap: '{"mode":"unrestricted","maxBytes":1.5}',
  stringCap: '{"mode":"unrestricted","maxBytes":"private"}',
  largeCap: '{"mode":"unrestricted","maxBytes":1073741825}',
})) {
  test(`startup refuses path policy: ${name}, without echoing input`, () => refused(start(raw)));
}

test('startup checks existing directory roots and releases all probe descriptors', t => {
  const base = fixture(t), root = join(base, 'root'), file = join(base, 'private-file');
  mkdirSync(root); writeFileSync(file, 'private contents');
  const opened: number[] = [], original = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args: any[]) => {
    const fd = (original as any)(...args); opened.push(fd); return fd;
  });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  for (const invalid of [file, join(base, 'private-missing')]) {
    const result = start(JSON.stringify({ mode: 'restricted', directories: [root, invalid] }));
    refused(result);
    assert.ok('refusal' in result && !result.refusal.includes(base));
  }
  const result = start(JSON.stringify({ mode: 'restricted', directories: [root], maxBytes: 12 }));
  assert.ok('settings' in result);
  assert.deepEqual(result.settings.pathUploads, { mode: 'restricted', directories: [root], maxBytes: 12 });
  assert.equal(opened.length, 3);
  for (const fd of opened) assert.throws(() => fstatSync(fd), /EBADF/);
});

test('startup refuses missing Python/capability without leaking diagnostics; unrestricted needs no Python', t => {
  const root = fixture(t);
  const mock = t.mock.method(childProcess, 'spawnSync', () => ({ status: 1, stdout: '', stderr: 'private diagnostic' }));
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  refused(start(JSON.stringify({ mode: 'restricted', directories: [root] })));
  const result = start('{"mode":"unrestricted","maxBytes":1}');
  assert.ok('settings' in result);
  assert.deepEqual(result.settings.pathUploads, { mode: 'unrestricted', maxBytes: 1 });
  assert.equal(mock.mock.callCount(), 1);
});

test('startup refuses both enabled modes on Windows without affecting inline-only', t => {
  const root = fixture(t), platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    refused(start(JSON.stringify({ mode: 'restricted', directories: [root] })));
    refused(start('{"mode":"unrestricted"}'));
    assert.ok('settings' in start());
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('CLI path refusals are one sanitized line before any network contact', t => {
  const base = fixture(t), guard = join(base, 'deny-network.cjs');
  // Any attempt to authenticate or open Socket Mode fails the assertion, not
  // merely a request with invalid credentials. Keep the outer loopback guard.
  writeFileSync(guard, `const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  // tsx may connect to its local IPC pipe; that is not Slack/network access.
  if (options && typeof options === 'object' && typeof options.path === 'string') return original.apply(this, args);
  process.stderr.write('NETWORK_CONTACT\\n'); process.exit(91);
};
`);
  for (const raw of ['private-not-json', '{"mode":"unrestricted","maxBytes":0}',
    JSON.stringify({ mode: 'restricted', directories: [join(base, 'private-missing')] }),
    JSON.stringify({ mode: 'restricted', directories: [guard] })]) {
    const run = childProcess.spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], {
      env: { PATH: process.env.PATH, NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${guard}`, ...tokens, SLACK_PATH_UPLOADS: raw },
      input: '', encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^SLACK_PATH_UPLOADS [^\n]+\n$/);
    assert.doesNotMatch(run.stderr, /private|NETWORK_CONTACT|Fatal error|fixture-bot|fixture-app/);
  }
});
