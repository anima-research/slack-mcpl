/** Bounded, single-pass Slack angle-token scan. Nested '<' starts a new
 * candidate; unclosed and overlong candidates stay literal. No suffix rescans. */
export function mapSlackAngles(text: string, map: (token: string, start: number) => string): string {
  const parts: string[] = [];
  let start = -1;
  let end = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') start = i;
    else if (start >= 0 && i - start >= 1000) start = -1;
    else if (text[i] === '>' && start >= 0) {
      parts.push(text.slice(end, start), map(text.slice(start, i + 1), start));
      end = i + 1;
      start = -1;
    }
  }
  parts.push(text.slice(end));
  return parts.join('');
}
