import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';

const root = fileURLToPath(new URL('../', import.meta.url));

test('initialize follows package.json version from source and built layouts, outside the package cwd', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'slack-mcpl-version-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedVersion = '9.8.7-version-probe';
  assert.notEqual(metadata.version, expectedVersion);
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ ...metadata, version: expectedVersion }));
  const { compilerOptions } = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  const builtSrc = join(compilerOptions.outDir, relative(compilerOptions.rootDir, 'src'));

  for (const layout of ['src', builtSrc]) {
    cpSync(join(root, 'src'), join(fixture, layout), { recursive: true });
    const { SlackMcplServer } = await import(pathToFileURL(join(fixture, layout, 'server.ts')).href);
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new SlackMcplServer({ onMessage() {} });
    const host = McplConnection.fromStreams(output, input);
    const serving = server.serve(McplConnection.fromStreams(input, output));
    const result = (await host.sendRequest('initialize', { capabilities: {} })) as { serverInfo: { name: string; version: string } };
    assert.equal(result.serverInfo.name, 'slack-mcpl', layout);
    assert.equal(result.serverInfo.version, expectedVersion, layout);
    host.sendNotification('notifications/initialized');
    input.end();
    await serving;
    host.close();
  }
});
