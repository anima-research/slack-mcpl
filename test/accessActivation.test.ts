import test from 'node:test';
import assert from 'node:assert/strict';
import { startupSettings } from '../src/config.js';
import { SlackAccessPolicy, parseAccessPolicy } from '../src/access-policy.js';
import { SlackAdapter } from '../src/slack-adapter.js';
import { associatedFile, policyFileRefs, privateFileUrl } from '../src/file-access.js';
import { accessFixture, accessScopes, joined } from './adapterAccessFixture.js';

const policy = { readJoinedChannels: true, writeChannels: ['C1'], dmUsers: ['W1'] };
const tokens = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' };
const start = (raw: string, extra = {}) => startupSettings(['--stdio'], { ...tokens, SLACK_ACCESS_POLICY: raw, ...extra });

test('activation snapshots the complete policy and omits optional groupDms', () => {
  const result = start(JSON.stringify(policy));
  assert.ok('settings' in result);
  const configured = (result.settings as unknown as { accessPolicy: typeof policy }).accessPolicy;
  assert.deepEqual(configured, policy);
  assert.equal(Object.hasOwn(configured, 'groupDms'), false);
  assert.ok(Object.isFrozen(configured.dmUsers));
});
for (const raw of ['', ' \n', '{', '{}', 'null', 'false', '[]', JSON.stringify({ ...policy, extra: [] }),
  JSON.stringify({ ...policy, dmUsers: ['w1'] }), JSON.stringify({ ...policy, groupDms: null })]) {
  test(`activation refuses bad value ${JSON.stringify(raw)} by name`, () => {
    const result = start(raw);
    assert.ok('refusal' in result);
    assert.ok(result.refusal.includes('SLACK_ACCESS_POLICY'));
    assert.ok(result.refusal.includes(JSON.stringify(raw)));
    assert.equal(result.refusal.split('\n').length, 1);
  });
}
test('explicit policy ignores even invalid legacy controls, but not unrelated switches', () => {
  assert.ok('settings' in start(JSON.stringify(policy), { SLACK_DISABLE_DMS: 'bad', SLACK_SEND_CHANNELS: '', SLACK_DM_USERS: 'U2' }));
  assert.ok('refusal' in start(JSON.stringify(policy), { SLACK_SUBSCRIBE_MEMBER_CHANNELS: 'bad' }));
});
test('impossible ordinary write pins refuse, but group-only writes remain valid', () => {
  assert.throws(() => parseAccessPolicy({ ...policy, readJoinedChannels: false }), /readJoinedChannels/);
  assert.doesNotThrow(() => parseAccessPolicy({ readJoinedChannels: false, writeChannels: ['G1'], dmUsers: [], groupDms: ['G1'] }));
});
test('construction installs policy before scope diagnostics and replaces sendChannels', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const f = accessFixture({ legacy: true });
  logs.mock.resetCalls();
  const a: SlackAdapter = Reflect.construct(SlackAdapter, [f.web, { on() {}, async start() {}, async disconnect() {} },
    'UBOT', 'test', ['U2'], ['C2'], true, undefined, accessScopes, new SlackAccessPolicy(policy)]);
  assert.equal(a.hasAccessPolicy, true);
  assert.equal(a.dmsWritable, true);
  assert.equal(a.canWrite('C1'), true);
  await a.sendMessage('C1', 'hello');
  assert.deepEqual(f.methods(), ['info', 'post']);
  assert.ok(!JSON.stringify(logs.mock.calls).includes('mpim'));
});
for (const mode of ['hosted', 'snippet', 'post']) test(`known file mode ${mode} offers hint`, () => {
  const file = { id: 'F1', mode, channels: ['C1'], url_private: 'https://files.slack.com/file' };
  assert.ok(associatedFile(file, 'F1', 'C1'));
  assert.equal(policyFileRefs([file], 'C1')[0].fileId, 'F1');
});
for (const state of [{ mode: undefined }, { mode: 'new' }, { mode: null }, { mode: { toString: () => 'hosted' } },
  { deleted: true }, { is_tombstoned: true }, { is_external: true }, { mode: 'external' }, { file_access: 'hidden' }]) {
  test(`gate and download hint share file state refusal: ${JSON.stringify(state)}`, () => {
    const file = { id: 'F1', mode: 'hosted', channels: ['C1'], url_private: 'https://files.slack.com/file', ...state };
    assert.throws(() => associatedFile(file, 'F1', 'C1'));
    assert.throws(() => privateFileUrl(file));
    assert.equal(policyFileRefs([file], 'C1')[0].fileId, undefined);
  });
}

test('explicit startup settings discard legacy lists and disable switch before entry wiring', () => {
  const result = start(JSON.stringify(policy), { SLACK_DM_USERS: 'UOTHER', SLACK_SEND_CHANNELS: 'COTHER', SLACK_DISABLE_DMS: 'true' });
  assert.ok('settings' in result);
  assert.equal(result.settings.dmUsers, undefined);
  assert.equal(result.settings.sendChannels, undefined);
  assert.equal(result.settings.disableDms, false);
});
for (const raw of ['x'.repeat(1000), JSON.stringify({ extra: '\n'.repeat(1000) })]) {
  test('long invalid policy has a bounded, escaped value preview', () => {
    const result = start(raw); assert.ok('refusal' in result);
    assert.ok(result.refusal.endsWith(`${JSON.stringify(raw).slice(0, 200)}…(${raw.length} chars)`));
    assert.ok(result.refusal.length < 350);
    assert.equal(result.refusal.split('\n').length, 1);
  });
}
