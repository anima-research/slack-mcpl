import { formatSlackText } from './content.js';

/** Readable Slack payload text. Never changes the original text; only the
 * suffix is bounded (16,384 UTF-16 code units including its separator).
 * A traversal budget and depth limit also bound malformed/nested payloads. */
export const MAX_MESSAGE_TEXT_APPEND = 16_384;

type Shape = Record<string, unknown>;
const object = (v: unknown): Shape => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Shape : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const normalized = (v: string) => v.replace(/\s+/g, ' ').trim();

/** Truncate a UTF-16 prefix without splitting a supplementary code point.
 * Existing malformed input is not repaired; truncation must not create it. */
function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length &&
      text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF &&
      text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF) end--;
  return text.slice(0, end);
}

export function renderMessageText(
  message: { text?: unknown; attachments?: unknown; blocks?: unknown },
  userNames: Map<string, string> = new Map(),
): string {
  const original = string(message.text);
  const channelLabels = new Map(Array.from(original.matchAll(/<#([^|>]+)\|([^>]+)>/g), m => [m[1], m[2]]));
  let truncated = false;
  let budget = 2000;
  const take = (v: unknown): unknown[] => {
    const items = list(v);
    if (items.length > 2000) truncated = true;
    return items.slice(0, 2000);
  };
  const visit = () => { if (--budget < 0) { truncated = true; return false; } return true; };
  const renderLimit = Math.max(MAX_MESSAGE_TEXT_APPEND, original.length + 1);
  const bounded = (v: unknown) => { const text = string(v); if (text.length > renderLimit) truncated = true; return prefix(text, renderLimit); };
  const join = (v: string[], separator = '\n') => bounded(v.filter(Boolean).join(separator));
  const textObject = (v: unknown) => !visit() ? '' : bounded(object(v).text);
  function rich(v: unknown, depth = 0): string {
    if (!visit() || depth > 12) { truncated = true; return ''; }
    const e = object(v);
    const children = (separator: string) => join(take(e.elements).map(x => rich(x, depth + 1)), separator);
    switch (e.type) {
      case 'text': {
        let value = bounded(e.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const style = object(e.style);
        if (style.code === true) value = '`' + value + '`';
        else {
          if (style.bold === true) value = '*' + value + '*';
          if (style.italic === true) value = '_' + value + '_';
          if (style.strike === true) value = '~' + value + '~';
        }
        return value;
      }
      case 'user': return e.user_id && typeof e.user_id === 'string' ? `<@${bounded(e.user_id)}>` : '';
      case 'channel': return e.channel_id && typeof e.channel_id === 'string' ? `<#${bounded(e.channel_id)}${channelLabels.has(e.channel_id) ? '|' + channelLabels.get(e.channel_id) : ''}>` : '';
      case 'link': {
        const url = bounded(e.url);
        const label = bounded(e.text);
        return url ? (label && label !== url ? `<${url}|${label}>` : `<${url}>`) : label;
      }
      case 'usergroup': return typeof e.usergroup_id === 'string' ? `<!subteam^${bounded(e.usergroup_id)}>` : '';
      case 'date': return bounded(e.fallback);
      case 'emoji': return typeof e.name === 'string' ? `:${bounded(e.name)}:${typeof e.skin_tone === 'number' ? ':skin-tone-' + e.skin_tone + ':' : ''}` : '';
      case 'broadcast': return typeof e.range === 'string' ? `<!${bounded(e.range)}>` : '';
      case 'rich_text_section': return children('');
      case 'rich_text_list': return children('\n');
      case 'rich_text_quote': return children('');
      case 'rich_text_preformatted': return children('');
      case 'rich_text': return children('\n');
      default: return '';
    }
  }
  function block(raw: unknown): string {
    if (!visit()) return '';
    const b = object(raw);
    switch (b.type) {
      case 'header': return textObject(b.text);
      case 'section': return join([textObject(b.text), ...take(b.fields).map(textObject)]);
      case 'context': return join(take(b.elements).map(textObject), ' ');
      case 'rich_text': return rich(b);
      default: return ''; // actions, inputs and images are not readable message text
    }
  }
  const appended: string[] = [];
  // Format keys only. Return raw Slack text so the adapter formats output once.
  const keyFor = (value: string) => normalized(formatSlackText(
    value.replace(/<@([^|>]+)(?:\|[^>]*)?>/g, '<@$1>'), userNames,
  ).replace(/^\s*(?:[•*+-] |\d+\. |>|&gt;)\s?/gm, '').replace(/```(?:[\w-]+)?\n/g, '').replace(/```|`|[*_~]/g, ''));
  const seen = new Set([keyFor(original)]);
  function append(value: string) {
    const key = keyFor(value);
    if (key && !seen.has(key)) { appended.push(value); seen.add(key); }
  }
  const urls = new Set(Array.from(original.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, '$1').matchAll(/https?:\/\/[^\s<>]+/g), m => m[0]));
  for (const raw of take(message.attachments)) {
    if (!visit()) break;
    const a = object(raw);
    // App unfurls are URL previews, not message bodies. Classic URL previews
    // are omitted when the URL is already in text; standalone previews survive.
    if (a.is_share !== true && a.is_msg_unfurl !== true &&
        (a.is_app_unfurl === true || (typeof a.from_url === 'string' &&
          urls.has(a.from_url)))) continue;
    const title = bounded(a.title);
    const body = join([
      bounded(a.pretext),
      title ? join([title, bounded(a.title_link)], ' ') : '',
      bounded(a.text),
      ...take(a.fields).map(rawField => {
        if (!visit()) return '';
        const f = object(rawField);
        return join([bounded(f.title), bounded(f.value)], ': ');
      }),
    ]);
    append(body || bounded(a.fallback));
    for (const b of take(a.blocks)) append(block(b));
  }
  for (const b of take(message.blocks)) append(block(b));
  const suffix = join(appended);
  const addition = (original && suffix ? '\n' : '') + suffix;
  if (addition.length > MAX_MESSAGE_TEXT_APPEND) truncated = true;
  const marker = '[…truncated]';
  return original + (truncated
    ? prefix(addition || (original ? '\n' : ''), MAX_MESSAGE_TEXT_APPEND - marker.length) + marker
    : addition);
}
