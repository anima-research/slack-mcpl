/** Use only on server-authored guidance, never on Slack/user message content. */
export function toolHint(text: string, enabled: (name: string) => boolean, fallback = ''): string {
  return (text.match(/\b[a-z]+_[a-z_]+\b/g) ?? []).every(enabled) ? text : fallback;
}
