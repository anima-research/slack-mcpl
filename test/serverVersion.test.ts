import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

test('initialize follows package.json version from source and built layouts, outside the package cwd', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'slack-mcpl-version-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedVersion = '9.8.7-version-probe';
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ ...metadata, version: expectedVersion }));
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({ ...config, include: ['src/**/*'] }));

  const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(fixture, 'tsconfig.json')], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(build.status, 0, build.stdout + build.stderr);

  // Run a real initialize exchange without Slack credentials or network calls.
  writeFileSync(join(fixture, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection } from '@animalabs/mcpl-core';
const { SlackMcplServer } = await import(process.argv[2]);
const input = new PassThrough();
const output = new PassThrough();
const server = new SlackMcplServer({ onMessage() {} });
const host = McplConnection.fromStreams(output, input);
const serving = server.serve(McplConnection.fromStreams(input, output));
const result = await host.sendRequest('initialize', { capabilities: {} });
assert.equal(result.serverInfo.name, 'slack-mcpl');
assert.equal(result.serverInfo.version, process.argv[3]);
host.sendNotification('notifications/initialized');
input.end();
await serving;
host.close();
`);
  for (const entry of ['./src/server.ts', './dist/src/server.js']) {
    const args = entry.endsWith('.ts') ? ['--import', require.resolve('tsx')] : [];
    const probe = spawnSync(process.execPath, [...args, join(fixture, 'probe.mjs'), entry, expectedVersion], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(probe.status, 0, entry + '\n' + probe.stdout + probe.stderr);
  }
});
