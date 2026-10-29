import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { McplConnection, method } from '@animalabs/mcpl-core';
import { initialize, until, answerAsHost, FULL_GRANT } from './harness.js';

const policy = { readJoinedChannels: true, writeChannels: ['C1'], dmUsers: ['W1'] };
const policyEnv = (value: unknown) => ({ SLACK_ACCESS_POLICY: JSON.stringify(value) });
function invocation(vars: Record<string, string>, args: string[], scenario = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SLACK_')));
  return { args: ['--import', 'tsx', 'test/accessStartupChild.ts', ...args], options: {
    cwd: new URL('..', import.meta.url), env: { ...env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', ...vars, TEST_SCENARIO: JSON.stringify(scenario) },
  } };
}
async function running(t: TestContext, tcp: boolean, vars: Record<string, string>, scenario = {}) {
  let port = 0;
  if (tcp) {
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    port = (reserve.address() as net.AddressInfo).port; await new Promise<void>((resolve) => reserve.close(() => resolve()));
  }
  const call = invocation(vars, tcp ? ['--tcp', String(port)] : ['--stdio'], scenario);
  const child = spawn(process.execPath, call.args, { ...call.options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stdout = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = once(child, 'exit'); let host: McplConnection | undefined;
  t.after(async () => { host?.close(); child.stdin.end(); if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  await until(() => stderr.includes(tcp ? 'Listening on TCP' : 'Starting on stdio') || child.exitCode !== null, 'startup', 10000);
  assert.equal(child.exitCode, null, stderr);
  if (tcp) {
    // The startup notice precedes listen's callback; wait for the actual socket.
    let socket: net.Socket | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = net.connect(port, '127.0.0.1');
      try { await once(candidate, 'connect'); socket = candidate; break; }
      catch (err) {
        candidate.destroy();
        if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw err;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(socket, stderr);
    host = McplConnection.fromTcp(socket);
  } else host = McplConnection.fromStreams(child.stdout, child.stdin);
  const requests = answerAsHost(host);
  return { host, requests, stderr: () => stderr, stdout: () => stdout };
}
for (const tcp of [false, true]) {
  const transport = tcp ? 'tcp' : 'stdio';
  for (const raw of ['', ' \n', '{', '{}', 'null', 'false', '[]', JSON.stringify({ ...policy, groupDms: null }),
    JSON.stringify({ ...policy, readJoinedChannels: false }), JSON.stringify({ ...policy, extra: [] })]) {
    test(`real startup ${transport} refuses ${JSON.stringify(raw)} before Slack`, () => {
      const call = invocation({ SLACK_ACCESS_POLICY: raw }, tcp ? ['--tcp', '41321'] : ['--stdio']);
      const result = spawnSync(process.execPath, call.args, { ...call.options, input: '', encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(JSON.stringify(raw)), result.stderr);
      assert.equal(result.stderr.split('\n').filter(Boolean).length, 1);
      assert.doesNotMatch(result.stderr, /A4_CALL|A4_SOCKET/);
    });
  }
  for (const scopes of [null, []]) test(`real startup ${transport} refuses unknown scopes ${JSON.stringify(scopes)}`, () => {
    const call = invocation(policyEnv(policy), tcp ? ['--tcp', '41321'] : ['--stdio'], { scopes });
    const result = spawnSync(process.execPath, call.args, { ...call.options, input: '', encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
    assert.match(result.stderr, /scope metadata/); assert.doesNotMatch(result.stderr, /A4_SOCKET|Starting on|Listening on/);
    assert.equal((result.stderr.match(/A4_CALL/g) ?? []).length, 1);
  });
  const cases: Array<{ name: string; vars: Record<string, string>; target: string; writable: boolean; dm: boolean; scenario?: object }> = [
    { name: 'legacy absent', vars: {}, target: 'C1', writable: true, dm: true },
    { name: 'legacy controls', vars: { SLACK_DISABLE_DMS: 'true', SLACK_SEND_CHANNELS: 'COTHER' }, target: 'C1', writable: false, dm: false },
    { name: 'explicit', vars: policyEnv(policy), target: 'C1', writable: true, dm: true },
    { name: 'replace conflicting and invalid legacy', vars: { ...policyEnv(policy), SLACK_DISABLE_DMS: 'bad', SLACK_DM_USERS: 'UOTHER', SLACK_SEND_CHANNELS: '' }, target: 'C1', writable: true, dm: true, scenario: { inspectEntryOptions: true } },
    { name: 'deny conversations', vars: policyEnv({ readJoinedChannels: false, writeChannels: [], dmUsers: [] }), target: 'C1', writable: false, dm: false },
    { name: 'joined read only', vars: policyEnv({ ...policy, writeChannels: [], dmUsers: [] }), target: 'C1', writable: false, dm: false },
    { name: 'DM only', vars: policyEnv({ readJoinedChannels: false, writeChannels: [], dmUsers: ['W1'] }), target: 'D1', writable: true, dm: true },
    { name: 'group only', vars: policyEnv({ readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] }), target: 'G1', writable: true, dm: false },
    { name: 'group read only', vars: policyEnv({ readJoinedChannels: false, writeChannels: [], dmUsers: [], groupDms: ['G1'] }), target: 'G1', writable: false, dm: false },
    { name: 'group missing membership', vars: policyEnv({ readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] }), target: 'G1', writable: true, dm: false, scenario: { membership: 'absent' } },
    { name: 'group false membership', vars: policyEnv({ readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] }), target: 'G1', writable: false, dm: false, scenario: { membership: false } },
    { name: 'limited scopes', vars: policyEnv(policy), target: 'C1', writable: false, dm: true, scenario: { scopes: ['channels:read', 'users:read'] } },
  ];
  for (const row of cases) test(`real startup ${transport}: ${row.name}`, async (t) => {
    const h = await running(t, tcp, row.vars, row.scenario);
    await initialize(h, false);
    const list = await h.host.sendRequest('tools/list') as { tools: Array<{ name: string }> };
    assert.equal(list.tools.some((tool) => tool.name === 'send_dm'), row.dm);
    const result = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: row.target, content: 'test' } }) as { isError?: boolean };
    assert.equal(result.isError === true, !row.writable, JSON.stringify(result));
    const directory = await h.host.sendRequest('tools/call', { name: 'find_user', arguments: { query: 'directory' } });
    assert.match(JSON.stringify(directory), /UOTHER/);
    if (row.vars.SLACK_ACCESS_POLICY) {
      assert.match(h.stderr(), /access policy: explicit/); assert.match(h.stderr(), /outside conversation confinement/);
      assert.doesNotMatch(h.stderr(), /writes: anywhere/);
      assert.doesNotMatch(h.stderr(), /A4_CALL .*users.info.*U1/, 'early unjoined event was denied before resolving its author');
    } else assert.doesNotMatch(h.stderr(), /access policy: explicit|outside conversation confinement|ignoring legacy/);
    assert.equal((h.stderr().match(/ignoring legacy settings:/g) ?? []).length, row.name.startsWith('replace') ? 1 : 0);
    if (row.name.startsWith('replace')) assert.match(h.stderr(), /A4_ENTRY_POLICY_ONLY/);
    if (row.name === 'group missing membership') assert.match(h.stderr(), /conversations.members/);
    if (row.name === 'group false membership') assert.doesNotMatch(h.stderr(), /conversations.members/);
    if (tcp) assert.equal(h.stdout(), '');
  });
  test(`real startup ${transport}: MCPL publish and rollback replace legacy send list`, async (t) => {
    const h = await running(t, tcp, { ...policyEnv(policy), SLACK_SEND_CHANNELS: 'COTHER', SLACK_DISABLE_DMS: 'true' });
    await initialize(h, true); await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const sent = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'one' } }) as { state: { parent: string } };
    const published = await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'two' }] }) as { delivered: boolean };
    assert.equal(published.delivered, true);
    await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: sent.state.parent });
    await until(() => h.stderr().includes('chat.delete'), 'rollback');
  });
}
