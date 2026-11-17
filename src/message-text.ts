import { formatSlackText } from './content.js';
import { mapSlackAngles, SLACK_ID } from './slack-angle.js';
import { LINE_BREAK, nameShown, channelShown } from './framing.js';

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
const ID = new RegExp(`^${SLACK_ID}$`);
const CHANNEL_LABEL = new RegExp(`^<#(${SLACK_ID})\\|([^>]+)>$`);
const REFERENCE = new RegExp(`^<([@#])(${SLACK_ID})(?:\\|[^>]*)?>$`);
const validId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

// Comparison keys only: normalize prose and equivalent emphasis/fence spellings,
// but retain significant whitespace inside code spans.
function normalized(value: string): string {
  let fence = '';
  let openedAt = -1;
  const parts = value.split(/(`+)/);
  return parts.map((part, i) => {
    if (i % 2) { if (!fence) { fence = part; openedAt = i; } else if (part === fence) fence = ''; return part; }
    if (fence) {
      if (fence.length < 3) return part;
      if (i === openedAt + 1) part = part.replace(/^\r?\n/, '');
      if (parts[i + 1] === fence) part = part.replace(/\r?\n$/, '');
      return part;
    }
    return part.replace(i === 0 ? /(^|\n)([ \t]*)[•◦▪] /g : /(\n)([ \t]*)[•◦▪] /g, '$1$2- ').replace(/_\*([^*_\n]+)\*_/g, '*_$1_*').replace(/\s+/g, ' ');
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

// Apply the same name rule as sender framing, then protect its literal output
// from the adapter's single Slack-formatting pass. Cap before name escaping.
const headerPrefix = (value: string) => value.length > 100 ? prefix(value, 99) + '…' : value;
const headerName = (value: string) => escape(nameShown(headerPrefix(value)));
const headerChannel = (value: string) => escape(channelShown(headerPrefix(value)));

export function renderMessageText(
  message: { text?: unknown; attachments?: unknown; blocks?: unknown; bot_id?: unknown; app_id?: unknown; bot_profile?: unknown; client_msg_id?: unknown },
  maxAppend = MAX_MESSAGE_TEXT_APPEND,
): string {
  const original = string(message.text);
  if (!list(message.attachments).length && !list(message.blocks).length) return original;
  const channelLabels = new Map<string, string>();
  mapSlackAngles(original, token => {
    const match = CHANNEL_LABEL.exec(token);
    if (match) channelLabels.set(match[1], match[2]);
    return token;
  });
  let truncated = false;
  let workTruncated = false;
  // Allow container visits along each character's depth-limited path.
  const cap = Math.max(2000, 14 * original.length + 2);
  let budget = cap;
  function* take(v: unknown): Generator<unknown> {
    const items = list(v);
    for (let i = 0; i < items.length; i++) {
      // Check before reading the next entry, including when a child spent
      // the remainder of the shared budget. Never eagerly copy pending lists.
      if (budget <= 0) { workTruncated = true; return; }
      yield items[i];
    }
  }
  const visit = () => { if (--budget < 0) { workTruncated = true; return false; } return true; };
  const renderLimit = Math.max(MAX_MESSAGE_TEXT_APPEND, original.length + 1);
  const bounded = (v: unknown) => { const text = string(v); if (text.length > renderLimit) truncated = true; return prefix(text, renderLimit); };
  // Consume children lazily: each expansion
  // spends the remaining output allowance before another child is rendered.
  function* map<T>(values: Iterable<T>, render: (value: T, index: number) => string): Generator<string> {
    let index = 0;
    for (const value of values) yield render(value, index++);
  }
  function join(values: Iterable<string>, separator = '\n'): string {
    let result = '';
    for (const value of values) {
      if (!value) continue;
      const part = (result ? separator : '') + value;
      const remaining = renderLimit - result.length;
      result += prefix(part, remaining);
      if (part.length > remaining) { truncated = true; break; }
    }
    return result;
  }
  const textObject = (v: unknown) => v == null || !visit() ? '' : object(v).type === 'plain_text' ? escape(bounded(object(v).text)) : bounded(object(v).text);
  const listTextObject = (v: unknown) => v == null ? (visit(), '') : textObject(v);
  function rich(v: unknown, depth = 0): string {
    if (!visit() || depth > 12) { truncated = true; return ''; }
    const e = object(v);
    const children = (separator: string) => join(map(take(e.elements), x => rich(x, depth + 1)), separator);
    switch (e.type) {
      case 'text': return styled(escape(bounded(e.text)), e.style);
      case 'user': return validId(e.user_id) ? styled(`<@${e.user_id}>`, e.style) : '';
      // Expand original channel labels only after deduplication. Mirrors must
      // not spend traversal/output allowance repeatedly expanding the same label.
      case 'channel': return validId(e.channel_id) ? styled(`<#${e.channel_id}>`, e.style) : '';
      case 'link': {
        const url = escape(bounded(e.url));
        const label = escape(bounded(e.text));
        // Preserve main's literal non-HTTP angle form, without creating tokens.
        if (url && !/^https?:\/\//.test(url)) return styled(`&lt;${url}${label ? '|' + label : ''}&gt;`, e.style);
        const angleUrl = url.replace(/\|/g, '%7C');
        return styled(url ? (label && label !== url ? `<${angleUrl}|${label}>` : `<${angleUrl}>`) : label, e.style);
      }
      case 'usergroup': return validId(e.usergroup_id) ? styled(`<!subteam^${e.usergroup_id}>`, e.style) : '';
      case 'team': return validId(e.team_id) ? styled(`team ${e.team_id}`, e.style) : '';
      case 'date': return styled(escape(bounded(e.fallback)), e.style);
      case 'emoji': return typeof e.name === 'string' ? styled(`:${escape(bounded(e.name))}:${typeof e.skin_tone === 'number' ? ':skin-tone-' + e.skin_tone + ':' : ''}`, e.style) : '';
      case 'broadcast': return ['here', 'channel', 'everyone'].includes(string(e.range)) ? styled(`<!${e.range}>`, e.style) : '';
      case 'rich_text_section': return children('');
      case 'rich_text_list': {
        // Payload fields are unvalidated: only finite numbers count, never coercion.
        const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? n : 0;
        const indent = Math.max(0, Math.min(12, finite(e.indent)));
        const offset = finite(e.offset);
        return join(map(take(e.elements), (x, i) => '    '.repeat(indent) +
          (e.style === 'ordered' ? String(i + 1 + offset) + '. ' : ['• ', '◦ ', '▪ '][Math.floor(indent) % 3]) + rich(x, depth + 1)));
      }
      case 'rich_text_quote': {
        const body = children('');
        return body ? body.split(LINE_BREAK).map(line => '&gt; ' + line).join('\n') : '';
      }
      case 'rich_text_preformatted': {
        const body = children('');
        return body ? '```' + body + '```' : '';
      }
      case 'rich_text': return children('\n');
      default: return '';
    }
  }
  function styled(value: string, raw: unknown): string {
    const style = object(raw);
    if (style.code === true) return '`' + value + '`';
    if (style.italic === true) value = '_' + value + '_';
    if (style.bold === true) value = '*' + value + '*';
    if (style.strike === true) value = '~' + value + '~';
    return value;
  }
  const silent = new Set(['actions', 'input', 'image', 'divider', 'file']);
  const readable = new Set(['rich_text', 'header', 'section', 'context', 'markdown', 'alert', 'card', 'video', 'table']);
  function placeholder(raw: unknown): boolean {
    const type = object(raw).type;
    return typeof type === 'string' && !silent.has(type) && !readable.has(type);
  }
  function block(raw: unknown): string {
    const b = object(raw);
    if (b.type === 'rich_text') return rich(b);
    if (!visit()) return '';
    switch (b.type) {
      case 'header': return textObject(b.text);
      case 'section': return join((function* () { yield textObject(b.text); yield* map(take(b.fields), listTextObject); })());
      case 'context': return join(map(take(b.elements), listTextObject), ' ');
      case 'markdown': return bounded(b.text);
      case 'alert': return textObject(b.text);
      case 'card': return join([textObject(b.title), textObject(b.subtitle), textObject(b.body)]);
      case 'video': return join([textObject(b.title), textObject(b.description)]);
      case 'table': return join(map(take(b.rows), row => {
        if (!visit()) return '';
        return join(map(take(row), cell => object(cell).type === 'rich_text' ? rich(cell) :
          !visit() ? '' : escape(bounded(object(cell).text))), ' | ');
      }));
      case 'actions': case 'input': case 'image': case 'divider': case 'file': return '';
      default: {
        if (typeof b.type !== 'string') return '';
        // Unsupported type labels are metadata, not message bodies. Bound
        // before escaping or computing comparison keys.
        if (b.type.length > 100) truncated = true;
        return `[${escape(headerPrefix(b.type))} omitted]`;
      }
    }
  }
  const appended: string[] = [];
  let appendedLength = original ? 1 : 0;
  const full = () => { if (appendedLength <= maxAppend) return false; truncated = true; return true; };
  // Format keys only. Return raw Slack text so the adapter formats output once.
  const keyFor = (value: string) => normalized(formatSlackText(mapSlackAngles(value, token => {
    const match = REFERENCE.exec(token);
    return match ? `\x00${match[1] === '@' ? 'user' : 'channel'}:${match[2]}\x00` : token;
  }), new Map()));
  const originalKey = keyFor(original);
  const scopes = new Map<string, { seen: Set<string>; rawSeen: Set<string> }>();
  function unique(value: string, attribution = '', remember = true): boolean {
    let scope = scopes.get(attribution);
    if (!scope) {
      scope = { seen: new Set(), rawSeen: new Set() };
      scopes.set(attribution, scope);
    }
    const { seen, rawSeen } = scope;
    if (rawSeen.has(value)) return false;
    if (remember) rawSeen.add(value);
    const key = keyFor(value);
    if (key && (attribution !== '' || key !== originalKey) && !seen.has(key)) {
      if (remember) seen.add(key);
      return true;
    }
    return false;
  }
  function emit(value: string) {
    appendedLength += value.length + (appended.length ? 1 : 0);
    appended.push(value);
  }
  // Rendering cuts belong to the unit retained after deduplication. Traversal
  // exhaustion is separate: unvisited units may still contain distinct text.
  function unit(render: () => string, attribution = '', remember = true): string {
    const previous = truncated;
    truncated = false;
    const value = render();
    const retained = unique(value, attribution, remember);
    truncated = previous || (truncated && (retained || !value.trim()));
    return retained ? value : '';
  }
  const urls = new Set<string>();
  const bareOriginal = mapSlackAngles(original, token => {
    const match = /^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/.exec(token);
    if (match) urls.add(unescape(match[1]));
    return match ? ' ' : token;
  });
  for (const match of bareOriginal.matchAll(/https?:\/\/[^\s<>]+/g)) urls.add(unescape(match[0].replace(/(?<![.,;:!?])[.,;:!?]+$/, '')));
  for (const raw of take(message.attachments)) {
    if (full() || !visit()) break;
    const a = object(raw);
    // App unfurls are URL previews, not message bodies. Classic URL previews
    // are omitted when the URL is already in text; standalone previews survive.
    if (a.is_share !== true && a.is_msg_unfurl !== true &&
        (a.is_app_unfurl === true || (typeof a.from_url === 'string' &&
          urls.has(a.from_url)))) continue;
    // Classic attachment fields carry Slack tokens/entities independently of
    // mrkdwn_in (which governs basic styling, passed through here either way).
    const fieldText = bounded;
    const shared = a.is_share === true || a.is_msg_unfurl === true;
    let header = '';
    if (shared || string(a.author_name)) {
      const name = string(a.author_name) ? headerName(string(a.author_name)) : 'unknown';
      const uid = validId(a.author_id) ? ` (uid:${headerName(a.author_id)})` : '';
      const source = string(a.channel_name) ? headerChannel(string(a.channel_name)) :
        validId(a.channel_id) ? headerChannel(a.channel_id) :
        string(a.footer) ? headerName(string(a.footer)) : 'unknown source';
      header = shared ? `[shared message from ${name}${uid}, ${source}]` : `[attachment from ${name}${uid}]`;
    }
    // Keep distinct source messages even when their displayed headers match.
    const identity = header ? JSON.stringify([header, string(a.channel_id), (typeof a.ts === 'number' && Number.isFinite(a.ts) ? String(a.ts) : string(a.ts))]) : '';
    let hasBody = false;
    const body = unit(() => {
      const title = fieldText(a.title);
      const value = join((function* () {
        yield fieldText(a.pretext);
        yield title ? join([title, escape(bounded(a.title_link))], ' ') : '';
        yield fieldText(a.text);
        yield* map(take(a.fields), rawField => {
          if (!visit()) return '';
          const f = object(rawField);
          return join([fieldText(f.title), fieldText(f.value)], ': ');
        });
      })());
      hasBody = !!value.trim();
      return value;
    }, identity);
    const nested: string[] = [];
    const placeholders: string[] = [];
    let omissionBytes = 0;
    const omissionLimit = Math.max(0, Math.min(maxAppend, renderLimit));
    let nestedLength = 0;
    let hasReadableNested = false;
    const units = body.trim() ? [body] : [];
    for (const rawBlock of take(a.blocks)) {
      const omitted = placeholder(rawBlock);
      const value = unit(() => {
        const rendered = block(rawBlock);
        if (!omitted && rendered.trim()) hasReadableNested = true;
        return rendered;
      }, identity, !omitted);
      if (value.trim()) {
        // Deferred notices get their own allowance so they cannot displace
        // readable blocks or retain unbounded keys while waiting for them.
        const omissionCost = value.length + (placeholders.length ? 1 : 0);
        if (omitted && omissionBytes + omissionCost > omissionLimit) {
          truncated = true;
          continue;
        }
        if (omitted) unique(value, identity);
        (omitted ? placeholders : nested).push(value);
        if (omitted) omissionBytes += omissionCost;
        // Deferred omission labels must not crowd out later readable blocks.
        if (!omitted) nestedLength += value.length + (nested.length > 1 ? 1 : 0);
        if (nestedLength > renderLimit) { truncated = true; break; }
      }
    }
    // Deduplicate mirrors within the same attribution and source message.
    if (!hasBody && !hasReadableNested) {
      const fallback = unit(() => fieldText(a.fallback), identity);
      if (fallback) units.push(fallback);
    }
    for (const value of nested) units.push(value);
    for (const value of placeholders) units.push(value);
    if (units.length && header) {
      emit(header + '\n' + join(units).split(LINE_BREAK).map(line => '&gt; ' + line).join('\n'));
    } else {
      for (const value of units) emit(value);
    }
  }
  // Slack clients supply rich_text mirrors. Trust provenance, not heuristics;
  // blocks-only messages (including apps posting as users) still need rendering.
  const skipHumanRichText = original.trim() !== '' &&
    (typeof message.client_msg_id === 'string' || (!message.bot_id && !message.app_id && !message.bot_profile));
  // Attachments must not consume the top-level mirror comparison allowance.
  budget = cap;
  for (const b of take(message.blocks)) {
    if (full()) break;
    if (skipHumanRichText && object(b).type === 'rich_text') { visit(); continue; }
    const value = unit(() => block(b));
    if (value) emit(value);
  }
  let expandedLength = 0;
  const joined = join(appended);
  let previousEnd = 0;
  const suffix = mapSlackAngles(joined, (token, start) => {
    expandedLength += start - previousEnd;
    previousEnd = start + token.length;
    const match = /^<#([A-Z0-9]+)>$/.exec(token);
    const label = match && channelLabels.get(match[1]);
    const remaining = Math.max(0, renderLimit - expandedLength);
    // Bound before constructing the expansion, not after allocating it.
    const value = label ? `<#${match![1]}|${prefix(label, remaining)}>` : token;
    if (value.length > remaining) truncated = true;
    const shown = prefix(value, remaining);
    expandedLength += shown.length;
    return shown;
  });
  const addition = (original && suffix ? '\n' : '') + suffix;
  if (addition.length > maxAppend) truncated = true;
  const marker = prefix('[…truncated]', Math.max(0, maxAppend));
  return original + (truncated || workTruncated
    ? prefix(addition || (original ? '\n' : ''), maxAppend - marker.length) + marker
    : addition);
}
