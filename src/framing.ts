const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/g;
const INVISIBLE = '\\p{Cf}\\p{Default_Ignorable_Code_Point}';
const GAP = `[\\s\\p{Cc}\\p{M}\\u2800${INVISIBLE}]`;
// A tag's name ends at a gap, `>`, `/`, `=`, a quote or the end of the text.
// In a tool result's JSON text a C0 control is written as an escape, and a
// quote as \" inside a string, beside the string's own closing quote; DEL and
// the C1 controls stay raw there, and the gap's own class matches them.
const JSON_GAP = `(?:${GAP}|\\\\[nrtbf]|\\\\u00[01][0-9a-fA-F])`;
const serverTag = (gap: string, end: string): RegExp => {
  const name = (n: string): string => [...n].join(`${gap}*`);
  return new RegExp(`<(?=${gap}*(?:\\/${gap}*)?(?:${name('system')}|${name('backscroll')})(?:${gap}|[>/="']|${end}))`, 'giu');
};
const OWN_TAG = serverTag(GAP, '$');
const OWN_TAG_IN_JSON = serverTag(JSON_GAP, '\\\\"');
const PLAIN_NAME = /^[\p{L}\p{M}\p{N}_.-]+(?: [\p{L}\p{M}\p{N}_.-]+)*$/u;
const HAS_INVISIBLE = new RegExp(`[${INVISIBLE}]`, 'u');
const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+(?:; ?[\w.+-]+=[\w.+-]+)*$/;

const UNSEEN = new RegExp(`[<>\\u007f-\\u009f\\u2028\\u2029\\u2800${INVISIBLE}]|(?! )\\p{Zs}`, 'gu');
const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}])?(?:\u{200D}\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}])?)*/gu;
const QUOTED_ESCAPES = new RegExp(`(${EMOJI_SEQUENCE.source})|${UNSEEN.source}`, 'gu');

export function senderText(text: string): string {
  return text.replace(LINE_BREAK, '\n  ').replace(OWN_TAG, '&lt;');
}

// A tool result's JSON text, with the server's tags and line breaks escaped;
// JSON.parse gives back the same value.
// JSON.stringify escapes the other line breaks, but not these three.
export function toolResultJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(OWN_TAG_IN_JSON, '\\u003c')
    .replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function quotedLabel(value: string): string {
  // JSON.stringify escapes the C0 controls, quotes and backslashes, but leaves
  // `<`, `>`, DEL, the C1 controls (U+0085 NEL breaks a line), U+2028, U+2029,
  // invisible characters, non-ASCII spaces and U+2800, which reads as a space,
  // literal.
  return JSON.stringify(value).replace(
    QUOTED_ESCAPES,
    (c, emoji?: string) => emoji ?? [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  );
}

const plain = (name: string): boolean => PLAIN_NAME.test(name) && !HAS_INVISIBLE.test(name);

export function nameShown(name: string): string {
  return plain(name) ? name : quotedLabel(name);
}

export function channelShown(name: string): string {
  return plain(name) ? `#${name}` : quotedLabel(`#${name}`);
}

export function mimeShown(mimeType: string): string {
  return MIME_TYPE.test(mimeType) ? mimeType : quotedLabel(mimeType);
}

// An http(s) link is shown as the URL parser writes it, which drops or
// percent-encodes what would break the line; fetch_attachment parses an https
// one back to the same URL. The parser leaves spaces, < and > as typed in the
// path of a scheme such as mailto:, so any other link is quoted.
export function urlShown(url: string): string {
  const link = URL.canParse(url) ? new URL(url) : undefined;
  return link && (link.protocol === 'https:' || link.protocol === 'http:') ? link.href : quotedLabel(url);
}
