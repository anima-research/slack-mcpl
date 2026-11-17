// Shared ID alphabet for angle-token parsing; other API validators also constrain IDs.
export const SLACK_ID = '[A-Z0-9]+';

/** Single-pass Slack angle-token scan. Nested '<' starts a new
 * candidate; unclosed or multiline candidates stay literal. No suffix rescans. */
export function mapSlackAngles(text: string, map: (token: string, start: number) => string): string {
  const parts: string[] = [];
  let start = -1;
  let end = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[\r\n\u000b\u000c\u0085\u2028\u2029]/.test(text[i])) start = -1;
    else if (text[i] === '<') start = i;
    else if (text[i] === '>' && start >= 0) {
      parts.push(text.slice(end, start), map(text.slice(start, i + 1), start));
      end = i + 1;
      start = -1;
    }
  }
  parts.push(text.slice(end));
  return parts.join('');
}
