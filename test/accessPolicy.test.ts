import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SlackAccessPolicy,
  parseAccessPolicy,
  type AccessConversation,
  type SlackAccessPolicyConfig,
} from '../src/access-policy.js';

type MutableConfig = { readJoinedChannels: boolean; writeChannels: string[]; dmUsers: string[] };
const config = (overrides: Partial<MutableConfig> = {}): MutableConfig => ({
  readJoinedChannels: true,
  writeChannels: ['C1', 'G1'],
  dmUsers: ['U1', 'W1'],
  ...overrides,
});
const channel = (id = 'C1', is_private = false): AccessConversation => ({
  id, is_im: false, is_mpim: false, is_private, is_member: true,
});
const dm = (user = 'U1'): AccessConversation => ({ id: 'D1', is_im: true, user });
const scopes = ['channels:read', 'groups:read', 'im:read', 'chat:write', 'files:write', 'reactions:write'];

test('required fields accept false and empty lists, which deny all access', () => {
  const empty = config({ readJoinedChannels: false, writeChannels: [], dmUsers: [] });
  assert.doesNotThrow(() => parseAccessPolicy(empty));
  const policy = new SlackAccessPolicy(empty);
  assert.equal(policy.dmsWritable, false);
  for (const id of ['C1', 'G1', 'D1']) assert.equal(policy.mayWrite(id), false);
  assert.throws(() => policy.requireReadable('C1', channel(), scopes));
  assert.throws(() => policy.requireReadable('D1', dm(), scopes));
});

test('validation and construction reject missing, unknown and null fields identically', () => {
  const invalid: unknown[] = [null, undefined, [], true, 1, 'policy', {},
    { ...config(), version: 1 }, { ...config(), extra: [] }];
  for (const key of ['readJoinedChannels', 'writeChannels', 'dmUsers'] as const) {
    const missing: Partial<MutableConfig> = config();
    delete missing[key];
    invalid.push(missing, { ...config(), [key]: null }, { ...config(), [key]: undefined });
  }
  // These extensions are deliberately unsupported in A1, even empty or null.
  for (const key of ['historyMembershipFallbackChannels']) {
    for (const value of [null, [], ['G1']]) invalid.push({ ...config(), [key]: value });
  }
  invalid.push({ ...config(), readJoinedChannels: 'true' });
  for (const value of invalid) {
    assert.throws(() => parseAccessPolicy(value), /Invalid Slack access policy/);
    assert.throws(() => new SlackAccessPolicy(value as SlackAccessPolicyConfig), /Invalid Slack access policy/);
  }
});

test('channel and user allow-lists require exact uppercase IDs, including U and W users', () => {
  for (const field of ['writeChannels', 'dmUsers'] as const) {
    const wrongKind = field === 'writeChannels' ? ['U1', 'W1', 'D1'] : ['C1', 'G1', 'D1'];
    const prefix = field === 'writeChannels' ? 'C' : 'U';
    for (const value of [null, 'C1', {}, [1], [null], new Array(1),
      ...['', prefix, `${prefix}a`, `${prefix}1 `, ` ${prefix}1`, `${prefix}1\n`, '#general', ...wrongKind].map((id) => [id])]) {
      const candidate = { ...config(), [field]: value };
      assert.throws(() => parseAccessPolicy(candidate));
      assert.throws(() => new SlackAccessPolicy(candidate as SlackAccessPolicyConfig));
    }
  }
  const policy = new SlackAccessPolicy(config());
  for (const user of ['U1', 'W1']) {
    assert.doesNotThrow(() => policy.requireDmUser(user));
    assert.equal(policy.requireReadable('D1', dm(user), scopes), 'dm');
    assert.doesNotThrow(() => policy.requireWritable('D1', dm(user), scopes, 'chat:write'));
  }
  for (const user of ['U2', 'W2', 'u1', 'U1 ', '']) assert.throws(() => policy.requireDmUser(user));
});

test('ordinary channel read/write matrix requires joined reads, membership and an exact write pin', () => {
  for (const id of ['C1', 'G1']) {
    for (const isPrivate of [false, true]) {
      for (const readJoinedChannels of [false, true]) {
        for (const isMember of [false, true]) {
          for (const pinned of [false, true]) {
            if (!readJoinedChannels && pinned) {
              assert.throws(() => new SlackAccessPolicy(config({ readJoinedChannels, writeChannels: [id] })), /readJoinedChannels/);
              continue;
            }
            const policy = new SlackAccessPolicy(config({ readJoinedChannels, writeChannels: pinned ? [id] : [] }));
            const metadata = { ...channel(id, isPrivate), is_member: isMember };
            const read = () => policy.requireReadable(id, metadata, scopes);
            const write = () => policy.requireWritable(id, metadata, scopes, 'chat:write');
            if (readJoinedChannels && isMember) {
              assert.equal(read(), isPrivate ? 'private_channel' : 'channel');
              if (pinned) assert.doesNotThrow(write); else assert.throws(write);
            } else {
              assert.throws(read);
              assert.throws(write);
            }
          }
        }
      }
    }
  }
});

test('one-to-one DM access depends on the peer, not joined reads, membership or channel pins', () => {
  for (const readJoinedChannels of [false, true]) {
    for (const allowed of [false, true]) {
      const policy = new SlackAccessPolicy(config({ readJoinedChannels, writeChannels: [], dmUsers: allowed ? ['W1'] : [] }));
      for (const membership of [undefined, false, true]) {
        const metadata = { ...dm('W1'), is_member: membership };
        const read = () => policy.requireReadable('D1', metadata, scopes);
        const write = () => policy.requireWritable('D1', metadata, scopes, 'chat:write');
        if (allowed) { assert.equal(read(), 'dm'); assert.doesNotThrow(write); }
        else { assert.throws(read); assert.throws(write); }
      }
    }
  }
});

test('identity, kind and explicit ordinary-channel metadata fail closed', () => {
  const policy = new SlackAccessPolicy(config());
  const invalid: Array<AccessConversation | undefined> = [undefined, {},
    { ...channel(), id: 'C2' }, { ...channel(), id: undefined }];
  for (const key of ['is_im', 'is_mpim', 'is_private', 'is_member'] as const) {
    for (const value of [undefined, null, 'false', 0]) {
      invalid.push({ ...channel(), [key]: value } as AccessConversation);
    }
  }
  invalid.push({ ...channel(), is_im: true }, { ...channel(), is_mpim: true });
  for (const metadata of invalid) {
    assert.throws(() => policy.requireReadable('C1', metadata, scopes));
    assert.throws(() => policy.requireWritable('C1', metadata, scopes, 'chat:write'));
  }
  for (const id of ['', 'C', 'c1', 'C1 ', 'C1\n', 'D1', 'U1']) {
    assert.throws(() => policy.requireReadable(id, channel(id), scopes));
  }
});

test('DM identity and kind cannot be inferred from a prefix or mismatched metadata', () => {
  const policy = new SlackAccessPolicy(config());
  for (const metadata of [{ ...dm(), id: 'D2' }, { ...dm(), user: undefined },
    dm('U2'), { ...dm(), is_im: undefined }, { ...dm(), is_im: false },
    ...[true, null, 'false'].map((is_mpim) => ({ ...dm(), is_mpim } as AccessConversation))]) {
    assert.throws(() => policy.requireReadable('D1', metadata, scopes));
    assert.throws(() => policy.requireWritable('D1', metadata, scopes, 'chat:write'));
  }
  assert.equal(policy.requireReadable('D1', { ...dm(), is_mpim: false }, scopes), 'dm');
  for (const id of ['', 'D', 'd1', 'D1 ', 'D1\n', 'C1', 'G1']) {
    assert.throws(() => policy.requireReadable(id, { ...dm(), id }, scopes));
  }
});

test('unnamed group DMs are unsupported even with membership, a write pin and mpim scopes', () => {
  const policy = new SlackAccessPolicy(config());
  for (const id of ['C1', 'G1']) {
    for (const isIm of [undefined, false, true]) {
      const metadata = { ...channel(id, true), is_mpim: true, is_im: isIm };
      const allScopes = [...scopes, 'mpim:read', 'mpim:history'];
      assert.throws(() => policy.requireReadable(id, metadata, allScopes));
      assert.throws(() => policy.requireWritable(id, metadata, allScopes, 'chat:write'));
    }
  }
});

test('metadata scopes follow the kind, not the ID prefix, and unknown grants deny', () => {
  const policy = new SlackAccessPolicy(config());
  for (const [id, metadata, needed] of [
    ['C1', channel(), 'channels:read'], ['G1', channel('G1'), 'channels:read'],
    ['C1', channel('C1', true), 'groups:read'], ['G1', channel('G1', true), 'groups:read'],
    ['D1', dm(), 'im:read'],
  ] as const) {
    for (const granted of [undefined, [], scopes.filter((scope) => scope !== needed),
      [needed.toUpperCase()], [needed + ' '], [needed, 1] as unknown as string[]]) {
      assert.throws(() => policy.requireReadable(id, metadata, granted), /requires granted scope/);
      assert.throws(() => policy.requireWritable(id, metadata, granted, 'chat:write'));
    }
    assert.doesNotThrow(() => policy.requireReadable(id, metadata, [needed]));
  }
});

test('every effect requires its own scope as well as readability and channel write pins', () => {
  const policy = new SlackAccessPolicy(config());
  for (const [id, metadata] of [['C1', channel()], ['G1', channel('G1', true)], ['D1', dm()]] as const) {
    for (const effect of ['chat:write', 'files:write', 'reactions:write']) {
      assert.doesNotThrow(() => policy.requireWritable(id, metadata, scopes, effect));
      assert.throws(() => policy.requireWritable(id, metadata, scopes.filter((scope) => scope !== effect), effect));
    }
  }
  assert.doesNotThrow(() => policy.requireScope(['users:read'], 'users:read'));
  assert.throws(() => policy.requireScope(undefined, 'users:read'));
});

test('duplicate IDs are harmless and construction snapshots both lists and the read flag', () => {
  const input = config({ writeChannels: ['C1', 'C1'], dmUsers: ['U1', 'U1'] });
  const policy = new SlackAccessPolicy(input);
  assert.doesNotThrow(() => policy.requireWritable('C1', channel(), scopes, 'chat:write'));
  assert.doesNotThrow(() => policy.requireWritable('D1', dm(), scopes, 'chat:write'));
  input.writeChannels.push('G1');
  input.dmUsers.push('W1');
  input.readJoinedChannels = false;
  assert.equal(policy.mayWrite('G1'), false);
  assert.throws(() => policy.requireWritable('G1', channel('G1', true), scopes, 'chat:write'));
  assert.throws(() => policy.requireReadable('D1', dm('W1'), scopes));
  assert.doesNotThrow(() => policy.requireReadable('C1', channel(), scopes));
  input.writeChannels.length = 0;
  input.dmUsers.length = 0;
  assert.doesNotThrow(() => policy.requireWritable('C1', channel(), scopes, 'chat:write'));
  assert.doesNotThrow(() => policy.requireReadable('D1', dm(), scopes));
});

test('synchronous write hints are not authorization decisions', () => {
  const policy = new SlackAccessPolicy(config());
  assert.equal(policy.dmsWritable, true);
  assert.equal(policy.mayWrite('C1'), true);
  assert.equal(policy.mayWrite('C2'), false);
  assert.equal(policy.mayWrite('D2'), true);
  assert.throws(() => policy.requireWritable('C1', { ...channel(), is_member: false }, scopes, 'chat:write'));
  assert.throws(() => policy.requireWritable('D2', { ...dm('U2'), id: 'D2' }, scopes, 'chat:write'));
});

test('construction stores the values validated from changing getters, reading each field once', () => {
  const reads = { readJoinedChannels: 0, writeChannels: 0, dmUsers: 0 };
  const input = {
    get readJoinedChannels() { return ++reads.readJoinedChannels === 1; },
    get writeChannels() { return ++reads.writeChannels === 1 ? ['C1'] : ['G1']; },
    get dmUsers() { return ++reads.dmUsers === 1 ? ['U1'] : ['not-a-user-id']; },
  };
  const policy = new SlackAccessPolicy(input);
  assert.doesNotThrow(() => policy.requireWritable('C1', channel(), scopes, 'chat:write'));
  assert.equal(policy.mayWrite('G1'), false);
  assert.doesNotThrow(() => policy.requireDmUser('U1'));
  assert.throws(() => policy.requireDmUser('not-a-user-id'));
  assert.deepEqual(reads, { readJoinedChannels: 1, writeChannels: 1, dmUsers: 1 });
});

test('a D-prefixed write hint deliberately does not validate a DM conversation ID', () => {
  const policy = new SlackAccessPolicy(config());
  const noPeers = new SlackAccessPolicy(config({ dmUsers: [] }));
  for (const id of ['D', 'D…', 'Dnot-an-id']) {
    assert.equal(policy.mayWrite(id), true);
    assert.equal(noPeers.mayWrite(id), false);
    assert.throws(() => policy.requireWritable(id, { ...dm(), id }, scopes, 'chat:write'), /invalid DM metadata/);
  }
});

test('parsing returns a normalized frozen object with fresh frozen arrays', () => {
  const input = config();
  const parsed = parseAccessPolicy(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.writeChannels, input.writeChannels);
  assert.notEqual(parsed.dmUsers, input.dmUsers);
  for (const value of [parsed, parsed.writeChannels, parsed.dmUsers]) assert.equal(Object.isFrozen(value), true);
  input.writeChannels.push('C2');
  input.dmUsers.push('U2');
  input.readJoinedChannels = false;
  assert.deepEqual(parsed, config());
  assert.throws(() => { (parsed as MutableConfig).readJoinedChannels = false; }, TypeError);
  assert.throws(() => { (parsed.writeChannels as string[]).push('C2'); }, TypeError);
  assert.throws(() => { (parsed.dmUsers as string[]).push('U2'); }, TypeError);
});

test('required and allowed keys are own keys, including non-enumerable and symbol keys', () => {
  assert.throws(() => parseAccessPolicy(Object.create(config())), /Invalid Slack access policy/);
  const hidden = Object.defineProperties({}, Object.fromEntries(
    Object.entries(config()).map(([key, value]) => [key, { value, enumerable: false }]),
  ));
  assert.deepEqual(parseAccessPolicy(hidden), config());
  for (const key of ['extra', Symbol('extra')]) {
    const extra = Object.defineProperty(config(), key, { value: [], enumerable: false });
    assert.throws(() => parseAccessPolicy(extra), /Invalid Slack access policy/);
  }
});
