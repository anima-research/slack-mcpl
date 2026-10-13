/**
 * MCPL RFC-008 tool classes: every tool the server can list is classed (or
 * deliberately unclassed), classes come from the RFC vocabulary, and
 * `tools/list` carries them in `_meta['mcpl/class']`.
 *
 * Run: node --import tsx --test test/toolClasses.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions, type ToolDefinition } from '../src/tools.js';
import { TOOL_CLASSES, TOOL_CLASS_VOCABULARY, UNCLASSED, withToolClasses } from '../src/tool-classes.js';
import { harness, initialize } from './harness.js';

/** RFC-008 §1, pinned here so the module's own vocabulary cannot drift. */
const RFC_008_VOCABULARY = ['comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control'];

type ListedTool = ToolDefinition & { _meta?: Record<string, unknown> };

// `toolDefinitions` is every tool the server can list; tools/list only ever
// filters it (send_dm when DMs are not writable).
const ALL_TOOLS = toolDefinitions.map((t) => t.name);

test('every tool the server can list is in TOOL_CLASSES or UNCLASSED', () => {
  const missing = ALL_TOOLS.filter((name) => !Object.hasOwn(TOOL_CLASSES, name) && !UNCLASSED.has(name));
  assert.deepEqual(missing, [], 'class new tools in src/tool-classes.ts (or list them in UNCLASSED)');
});

test('the class map names only real tools, and none is both classed and unclassed', () => {
  const names = new Set(ALL_TOOLS);
  assert.deepEqual(Object.keys(TOOL_CLASSES).filter((n) => !names.has(n)), []);
  assert.deepEqual([...UNCLASSED].filter((n) => !names.has(n)), []);
  assert.deepEqual([...UNCLASSED].filter((n) => Object.hasOwn(TOOL_CLASSES, n)), []);
});

test('every class is from the RFC-008 vocabulary', () => {
  assert.deepEqual([...TOOL_CLASS_VOCABULARY], RFC_008_VOCABULARY);
  for (const [name, classes] of Object.entries(TOOL_CLASSES)) {
    assert.ok(classes.length > 0, `${name}: empty class list (use UNCLASSED instead)`);
    assert.equal(new Set(classes).size, classes.length, `${name}: duplicate class`);
    for (const c of classes) assert.ok(RFC_008_VOCABULARY.includes(c), `${name}: unknown class ${c}`);
  }
});

test('tools/list carries each tool\'s class and leaves the model-facing definition alone', async () => {
  for (const mcpl of [false, true]) {
    const h = harness();
    await initialize(h, mcpl);
    const { tools } = (await h.host.sendRequest('tools/list')) as { tools: ListedTool[] };
    assert.deepEqual(tools.map((t) => t.name), ALL_TOOLS, 'send_dm is listed when DMs are writable');
    for (const tool of tools) {
      assert.deepEqual(tool._meta?.['mcpl/class'], TOOL_CLASSES[tool.name], tool.name);
      const { _meta, ...rest } = tool;
      assert.deepEqual(rest, toolDefinitions.find((t) => t.name === tool.name), tool.name);
    }
    assert.deepEqual(tools.find((t) => t.name === 'send_dm')?._meta, { 'mcpl/class': ['comms'] });
    await h.close();
  }
});

test('the remaining tools are still classed when send_dm is withheld', async () => {
  const h = harness({ disableDms: true });
  await initialize(h, true);
  const { tools } = (await h.host.sendRequest('tools/list')) as { tools: ListedTool[] };
  assert.equal(tools.some((t) => t.name === 'send_dm'), false);
  for (const tool of tools) assert.deepEqual(tool._meta?.['mcpl/class'], TOOL_CLASSES[tool.name], tool.name);
  await h.close();
});

test('the class merges into existing _meta without touching the definitions', () => {
  const defs = [
    { name: 'send_message', _meta: { 'example.com/x': 1 } },
    { name: 'not_a_tool', _meta: { 'example.com/y': 2 } },
  ];
  const before = structuredClone(defs);
  const out = withToolClasses(defs);
  assert.deepEqual(out[0]._meta, { 'example.com/x': 1, 'mcpl/class': ['comms'] });
  assert.equal(out[1], defs[1], 'an unclassed tool passes through unchanged, with no class key');
  assert.deepEqual(defs, before);
});
