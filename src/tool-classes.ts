/**
 * Tool classes — MCPL RFC-008
 * (https://github.com/anima-research/mcpl/blob/main/RFC-008-tool-classes.md).
 *
 * Each classed tool in `tools/list` carries `_meta["mcpl/class"]`: what the
 * tool does, in a fixed vocabulary. It is a hint hosts use as a policy key, for
 * example to decide which tool calls a lifecycle observer may see. It grants
 * nothing and never changes the tool the model sees.
 *
 * The rule: a tool that carries or reads people's messages is classed
 * `comms`. Hosts never share `comms` arguments, so a messaging tool classed
 * without `comms` could expose a private conversation. A tool with no class
 * is handled most restrictively, so leaving one out (UNCLASSED) is always
 * safe; mislabelling one is not.
 *
 * Every tool the server can list must be in TOOL_CLASSES or UNCLASSED;
 * test/toolClasses.test.ts fails otherwise.
 */

/** The RFC-008 vocabulary. */
export const TOOL_CLASS_VOCABULARY = [
  'comms',
  'memory',
  'notes',
  'files',
  'shell',
  'web',
  'computer',
  'media',
  'body',
  'control',
] as const;

export type ToolClass = (typeof TOOL_CLASS_VOCABULARY)[number];

export const TOOL_CLASSES: Record<string, readonly ToolClass[]> = {
  // Messages, and the people and conversations they pass between.
  send_message: ['comms'],
  reply_message: ['comms'],
  send_dm: ['comms'],
  add_reaction: ['comms'],
  edit_message: ['comms'],
  delete_message: ['comms'],
  fetch_history: ['comms'],
  fetch_thread: ['comms'],
  fetch_attachment: ['comms'],
  find_user: ['comms'],
  list_channels: ['comms'],
  // This server's own delivery state.
  refresh_channels: ['control'],
  subscribe_channel: ['control'],
  unsubscribe_channel: ['control'],
  list_subscriptions: ['control'],
};

/** Tools deliberately left without a class. None today. */
export const UNCLASSED: ReadonlySet<string> = new Set<string>();

/** The tools with their class added to `_meta`, keeping any other `_meta`
 *  keys. Unclassed tools are returned as they are. */
export function withToolClasses<T extends { name: string; _meta?: Record<string, unknown> }>(
  tools: readonly T[],
): T[] {
  return tools.map((tool) => {
    if (!Object.hasOwn(TOOL_CLASSES, tool.name)) return tool;
    return { ...tool, _meta: { ...tool._meta, 'mcpl/class': [...TOOL_CLASSES[tool.name]] } };
  });
}
