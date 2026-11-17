import { formatSlackText } from './content.js';
import { mapSlackAngles } from './slack-angle.js';
import { LINE_BREAK } from './framing.js';

/** Readable Slack payload text. Never changes the original text; only the
 * suffix is bounded (16,384 UTF-16 code units including its separator).
 * A traversal budget and depth limit also bound malformed/nested payloads. */
export const MAX_MESSAGE_TEXT_APPEND = 16_384;

type Shape = Record<string, unknown>;
const object = (v: unknown): Shape => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Shape : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9]+$/.test(v);

// Normalize prose whitespace, but retain significant whitespace in code spans.
function normalized(value: string): string {
  let fence = '';
  return value.split(/(`+)/).map((part, i) => {
    if (i % 2) { if (!fence) fence = part; else if (part === fence) fence = ''; return part; }
    return fence ? part : part.replace(/\s+/g, ' ');
  }).join('').trim();
}

/** Truncate a UTF-16 prefix without splitting a supplementary code point.
 * Existing malformed input is not repaired; truncation must not create it. */
function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length &&
      text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF &&
      text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF) end--;
  return text.slice(0, end);
}

/** Attribution fields cannot introduce delimiters, controls or logical lines.
 * Cap encoded fields too, without splitting an entity or supplementary point. */
function headerField(value: string): string {
  const parts: string[] = [];
  let length = 0;
  for (const char of value) {
    const safe = /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(char) ? ' ' :
      char === '[' ? '&#91;' : char === ']' ? '&#93;' : escape(char);
    if (length + safe.length > 100) break;
    parts.push(safe);
    length += safe.length;
  }
  return parts.join('');
}

export function renderMessageText(
  message: { text?: unknown; attachments?: unknown; blocks?: unknown; bot_id?: unknown; client_msg_id?: unknown },
  _userNames: Map<string, string> = new Map(),
  maxAppend = MAX_MESSAGE_TEXT_APPEND,
): string {
  const original = string(message.text);
  const channelLabels = new Map<string, string>();
  mapSlackAngles(original, token => {
    const match = /^<#([A-Z0-9]+)\|([^>]+)>$/.exec(token);
    if (match) channelLabels.set(match[1], match[2]);
    return token;
  });
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
  const textObject = (v: unknown) => !visit() ? '' : object(v).type === 'plain_text' ? escape(bounded(object(v).text)) : bounded(object(v).text);
  function rich(v: unknown, depth = 0): string {
    if (!visit() || depth > 12) { truncated = true; return ''; }
    const e = object(v);
    const children = (separator: string) => join(take(e.elements).map(x => rich(x, depth + 1)), separator);
    switch (e.type) {
      case 'text': return styled(escape(bounded(e.text)), e.style);
      case 'user': return validId(e.user_id) ? styled(`<@${e.user_id}>`, e.style) : '';
      case 'channel': return validId(e.channel_id) ? styled(`<#${e.channel_id}${channelLabels.has(e.channel_id) ? '|' + channelLabels.get(e.channel_id) : ''}>`, e.style) : '';
      case 'link': {
        const url = escape(bounded(e.url)).replace(/\|/g, '%7C');
        const label = escape(bounded(e.text));
        return styled(url ? (label && label !== url ? `<${url}|${label}>` : `<${url}>`) : label, e.style);
      }
      case 'usergroup': return validId(e.usergroup_id) ? styled(`<!subteam^${e.usergroup_id}>`, e.style) : '';
      case 'date': return escape(bounded(e.fallback));
      case 'emoji': return typeof e.name === 'string' ? styled(`:${escape(bounded(e.name))}:${typeof e.skin_tone === 'number' ? ':skin-tone-' + e.skin_tone + ':' : ''}`, e.style) : '';
      case 'broadcast': return ['here', 'channel', 'everyone'].includes(string(e.range)) ? `<!${e.range}>` : '';
      case 'rich_text_section': return children('');
      case 'rich_text_list': return join(take(e.elements).map((x, i) =>
        '    '.repeat(Math.max(0, Math.min(12, Number(e.indent) || 0))) +
        (e.style === 'ordered' ? String(i + 1 + (Number(e.offset) || 0)) + '. ' : '• ') + rich(x, depth + 1)));
      case 'rich_text_quote': return children('').split('\n').map(line => '> ' + line).join('\n');
      case 'rich_text_preformatted': return '```\n' + children('') + '\n```';
      case 'rich_text': return children('\n');
      default: return '';
    }
  }
  function styled(value: string, raw: unknown): string {
    const style = object(raw);
    if (style.code === true) return '`' + value + '`';
    if (style.bold === true) value = '*' + value + '*';
    if (style.italic === true) value = '_' + value + '_';
    if (style.strike === true) value = '~' + value + '~';
    return value;
  }
  function block(raw: unknown): string {
    const b = object(raw);
    if (b.type === 'rich_text') return rich(b);
    if (!visit()) return '';
    switch (b.type) {
      case 'header': return textObject(b.text);
      case 'section': return join([textObject(b.text), ...take(b.fields).map(textObject)]);
      case 'context': return join(take(b.elements).map(textObject), ' ');
      case 'markdown': return bounded(b.text);
      case 'alert': return textObject(b.text);
      case 'card': return join([textObject(b.title), textObject(b.subtitle), textObject(b.body)]);
      case 'video': return join([textObject(b.title), textObject(b.description)]);
      case 'table': return join(take(b.rows).map(row => {
        if (!visit()) return '';
        return join(take(row).map(cell => object(cell).type === 'rich_text' ? rich(cell) :
          !visit() ? '' : escape(bounded(object(cell).text))), ' | ');
      }));
      case 'actions': case 'input': case 'image': case 'divider': return '';
      default: return typeof b.type === 'string' ? `[${escape(bounded(b.type))} omitted]` : '';
    }
  }
  const appended: string[] = [];
  let appendedLength = original ? 1 : 0;
  const full = () => { if (appendedLength <= maxAppend) return false; truncated = true; return true; };
  // Format keys only. Return raw Slack text so the adapter formats output once.
  const keyFor = (value: string) => normalized(formatSlackText(mapSlackAngles(value, token => {
    const match = /^<([@#])([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(token);
    return match ? `\x00${match[1] === '@' ? 'user' : 'channel'}:${match[2]}\x00` : token;
  }), new Map()));
  const originalKey = keyFor(original);
  const seen = new Set<string>();
  const rawSeen = new Set<string>();
  function append(value: string) {
    if (rawSeen.has(value)) return;
    rawSeen.add(value);
    const key = keyFor(value);
    if (key && key !== originalKey && !seen.has(key)) {
      appendedLength += value.length + (appended.length ? 1 : 0);
      appended.push(value); seen.add(key);
    }
  }
  const urls = new Set<string>();
  const bareOriginal = mapSlackAngles(original, token => {
    const match = /^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/.exec(token);
    if (match) urls.add(unescape(match[1]));
    return match ? '' : token;
  });
  for (const match of bareOriginal.matchAll(/https?:\/\/[^\s<>]+/g)) urls.add(unescape(match[0].replace(/[.,;:!?]+$/, '')));
  for (const raw of take(message.attachments)) {
    if (full() || !visit()) break;
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
    const nested = take(a.blocks).map(block).filter(Boolean);
    const value = join([body || (nested.length ? '' : bounded(a.fallback)), ...nested]);
    const shared = a.is_share === true || a.is_msg_unfurl === true;
    if (value && (shared || a.author_name)) {
      const name = headerField(string(a.author_name)) || 'unknown';
      const uid = validId(a.author_id) ? ` (uid:${headerField(a.author_id)})` : '';
      const source = headerField(string(a.footer)) || headerField(string(a.channel_name)) || 'unknown source';
      const header = shared ? `[shared message from ${name}${uid}, ${source}]` : `[attachment from ${name}${uid}]`;
      append(header + '\n' + value.split(LINE_BREAK).map(line => '> ' + line).join('\n'));
    } else {
      append(body || (nested.length ? '' : bounded(a.fallback)));
      for (const value of nested) append(value);
    }
  }
  // Slack clients supply rich_text mirrors. Trust provenance, not heuristics;
  // blocks-only messages (including apps posting as users) still need rendering.
  const skipHumanRichText = original !== '' &&
    (message.client_msg_id !== undefined || !message.bot_id);
  for (const b of take(message.blocks)) {
    if (full()) break;
    if (skipHumanRichText && object(b).type === 'rich_text') continue;
    append(block(b));
  }
  const suffix = join(appended);
  const addition = (original && suffix ? '\n' : '') + suffix;
  if (addition.length > maxAppend) truncated = true;
  const marker = '[…truncated]';
  return original + (truncated
    ? prefix(addition || (original ? '\n' : ''), maxAppend - marker.length) + marker
    : addition);
}
