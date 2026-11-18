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
      assert.match(result.stderr, /SLACK_ACCESS_POLICY.*value omitted/);
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
  const invalidRestrictions: Record<string, string>[] = [{ SLACK_DM_USERS: '' }, { SLACK_SEND_CHANNELS: '' }, { SLACK_DISABLE_DMS: 'bad' }];
  for (const restrictions of invalidRestrictions) {
    test(`real startup ${transport}: policy refuses invalid restriction ${JSON.stringify(restrictions)}`, () => {
      const call = invocation(Object.assign({}, policyEnv(policy), restrictions), tcp ? ['--tcp', '41321'] : ['--stdio']);
      const result = spawnSync(process.execPath, call.args, { ...call.options, input: '', encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /SLACK_DM_USERS|SLACK_SEND_CHANNELS|SLACK_DISABLE_DMS/);
      assert.doesNotMatch(result.stderr, /A4_CALL|A4_SOCKET/);
    });
  }
  const cases: Array<{ name: string; vars: Record<string, string>; target: string; writable: boolean; dm: boolean; scenario?: object }> = [
    { name: 'legacy absent', vars: {}, target: 'C1', writable: true, dm: true },
    { name: 'legacy controls', vars: { SLACK_DISABLE_DMS: 'true', SLACK_SEND_CHANNELS: 'COTHER' }, target: 'C1', writable: false, dm: false },
    { name: 'explicit', vars: policyEnv(policy), target: 'C1', writable: true, dm: true },
    { name: 'intersect conflicting legacy', vars: { ...policyEnv(policy), SLACK_DISABLE_DMS: 'true', SLACK_DM_USERS: 'UOTHER', SLACK_SEND_CHANNELS: 'COTHER' }, target: 'C1', writable: false, dm: false, scenario: { inspectEntryOptions: true } },
    { name: 'DM disabled by legacy', vars: { ...policyEnv(policy), SLACK_DISABLE_DMS: 'true' }, target: 'D1', writable: false, dm: false },
    { name: 'DM disjoint legacy peers', vars: { ...policyEnv(policy), SLACK_DM_USERS: 'UOTHER' }, target: 'D1', writable: false, dm: false },
    { name: 'DM intersecting peer and write pin', vars: { ...policyEnv(policy), SLACK_DM_USERS: 'W1', SLACK_SEND_CHANNELS: 'D1' }, target: 'D1', writable: true, dm: true },
    { name: 'group disabled by legacy', vars: { ...policyEnv({ readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] }), SLACK_DISABLE_DMS: 'true' }, target: 'G1', writable: false, dm: false },
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
    assert.equal((h.stderr().match(/ignoring legacy settings:/g) ?? []).length, 0);
    if (row.name.startsWith('intersect')) { assert.match(h.stderr(), /A4_ENTRY_INTERSECTION/); assert.match(h.stderr(), /effective DM peers: 0/); }
    if (row.name === 'group only') assert.doesNotMatch(h.stderr(), /unavailable|mpim:write/);
    if (row.name.startsWith('intersect')) {
      const denied = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'D1', content: 'denied' } }) as { isError?: boolean };
      assert.equal(denied.isError, true);
      assert.doesNotMatch(h.stderr(), /"name":"chat.postMessage"/);
    }
    if (row.name === 'group missing membership') await until(() => h.stderr().includes('conversations.members'), 'membership log');
    if (row.name === 'group missing membership') assert.match(h.stderr(), /conversations.members/);
    if (row.name === 'group false membership') assert.doesNotMatch(h.stderr(), /conversations.members/);
    if (tcp) assert.equal(h.stdout(), '');
  });
  for (const target of ['D1', 'D2']) test(`real startup ${transport}: send_dm exact destination ${target}`, async t => {
    const h = await running(t, tcp, { ...policyEnv(policy), SLACK_SEND_CHANNELS: target });
    await initialize(h, false);
    const result = await h.host.sendRequest('tools/call', { name: 'send_dm', arguments: { userId: 'W1', content: 'hello' } }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError === true, target !== 'D1');
    await until(() => h.stderr().includes('conversations.open'), 'DM-open log');
    assert.match(h.stderr(), /send_dm opens the peer DM to learn its ID before exact destination admission/);
    if (target === 'D2') {
      assert.match(result.content[0].text, /DM D1 was opened, but nothing was posted/);
      assert.doesNotMatch(h.stderr(), /chat.postMessage/);
    } else {
      await until(() => h.stderr().includes('chat.postMessage'), 'DM-post log');
      assert.match(result.content[0].text, /1\.0/);
    }
  });
  test(`real startup ${transport}: MCPL publish and rollback succeed at an intersecting allowed destination`, async (t) => {
    const h = await running(t, tcp, { ...policyEnv(policy), SLACK_SEND_CHANNELS: 'C1', SLACK_DISABLE_DMS: 'true' });
    await initialize(h, true); await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
    const sent = await h.host.sendRequest('tools/call', { name: 'send_message', arguments: { channelId: 'C1', content: 'one' } }) as { state: { parent: string } };
    const published = await h.host.sendRequest(method.CHANNELS_PUBLISH, { channelId: 'slack:C1', content: [{ type: 'text', text: 'two' }] }) as { delivered: boolean };
    assert.equal(published.delivered, true);
    await h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: 'slack.messaging', checkpoint: sent.state.parent });
    await until(() => h.stderr().includes('chat.delete'), 'rollback');
  });
}

for (const [pins, peers, send, expected] of [
  [['C1'], [], 'C2', 'effective DM peers: 0; group DMs: 0; write intersection: no writable conversation'],
  [['C1', 'C2'], [], 'C2,C3', 'effective DM peers: 0; group DMs: 0; write intersection: C2'],
  [['C1', 'C1'], ['W1', 'W1'], 'C1,D9,D9', 'effective DM peers: 1; group DMs: 0; write intersection: C1, D9'],
] as const) {
  test(`R3-1 real startup summary ${send}`, async t => {
    const h = await running(t, false, { ...policyEnv({ readJoinedChannels: true, writeChannels: pins, dmUsers: peers }), SLACK_SEND_CHANNELS: send });
    assert.ok(h.stderr().includes(expected), h.stderr());
  });
}

for (const explicit of [false, true]) test(`fatal startup preserves legacy stacks: policy=${explicit}`, () => {
  const call = invocation(explicit ? policyEnv(policy) : {}, ['--stdio'], { fatalStart: true });
  const result = spawnSync(process.execPath, call.args, { ...call.options, input: '', encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic startup failure/);
  if (explicit) assert.doesNotMatch(result.stderr, /\n\s+at /);
  else assert.match(result.stderr, /\n\s+at /);
});


for (const [pins, send, writes] of [
  [['C1'], 'C2', false],
  [['C1', 'C2'], 'C2,C3', true],
  [['C1', 'C1'], 'C1,C1', true],
] as const) test(`write-scope warnings follow the effective intersection: ${send}`, async t => {
  const h = await running(t, false, {
    ...policyEnv({ readJoinedChannels: true, writeChannels: pins, dmUsers: [] }),
    SLACK_SEND_CHANNELS: send,
  }, { scopes: ['channels:read', 'groups:read', 'channels:history', 'groups:history', 'files:read', 'users:read'] });
  const warning = h.stderr().split('\n').find(line => line.includes('Access policy: unavailable scopes:')) ?? '';
  for (const scope of ['chat:write', 'files:write', 'reactions:write']) assert.equal(warning.includes(scope), writes, h.stderr());
});

test('pagination real startup source wires caps and refuses without echo', async (t) => {
  const h = await running(t, false, { SLACK_CONVERSATION_PAGE_LIMIT: '2', SLACK_USER_PAGE_LIMIT: '2', SLACK_BACKSCROLL_PAGE_LIMIT: '2' }, { pagination: true });
  await initialize(h, false);
  const listing = await h.host.sendRequest('tools/call', { name: 'list_channels', arguments: {} });
  assert.match(JSON.stringify(listing), /Incomplete conversation listing/);
  const directory = await h.host.sendRequest('tools/call', { name: 'find_user', arguments: { query: 'absent' } });
  assert.match(JSON.stringify(directory), /directory search is incomplete/);
  await until(() => (h.stderr().match(/"name":"conversations.list"/g) ?? []).length >= 2
    && (h.stderr().match(/"name":"users.list"/g) ?? []).length >= 2, 'listing and directory call logs');
  assert.equal((h.stderr().match(/"name":"conversations.list"/g) ?? []).length, 2);
  assert.equal((h.stderr().match(/"name":"users.list"/g) ?? []).length, 2);
  const call = invocation({ SLACK_USER_PAGE_LIMIT: 'do-not-echo' }, ['--stdio']);
  const refused = spawnSync(process.execPath, call.args, { ...call.options, input: '', encoding: 'utf8', timeout: 15000 });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, 'SLACK_USER_PAGE_LIMIT must be a decimal integer from 1 to 10000\n');
});

test('real startup forwards the backscroll page ceiling through connectSlack', async t => {
  const h = await running(t, false, { ...policyEnv(policy), SLACK_BACKSCROLL_PAGE_LIMIT: '2' }, { backscroll: true });
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.requests.some(r => r.method === method.CHANNELS_REGISTER), 'registration');
  await h.host.sendRequest('tools/call', { name: 'find_user', arguments: { query: 'directory' } });
  await until(() => h.requests.some(r => r.method === method.PUSH_EVENT), 'backscroll delivery');
  const push = h.requests.find(r => r.method === method.PUSH_EVENT)!;
  assert.match(JSON.stringify(push.params), /Backscroll is incomplete/);
  await until(() => (h.stderr().match(/"name":"conversations.history"/g) ?? []).length >= 2, 'history call logs');
  assert.equal((h.stderr().match(/"name":"conversations.history"/g) ?? []).length, 2);

});
