import { parseAccessPolicy, type SlackAccessPolicyConfig } from './access-policy.js';

/** Parse an operator switch. An absent value is off; a present value must
 *  say yes or no so a broken environment template cannot disable a guard. */
export function booleanFlag(name: string, raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  // Quoted as JSON, so whitespace shows and the line stays one line.
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

/** Bound escaped diagnostics too: control characters must not amplify a bad value. */
function policyValue(raw: string): string {
  const quoted = JSON.stringify(raw);
  return quoted.length <= 200 ? quoted : `${quoted.slice(0, 200)}…(${raw.length} chars)`;
}

export interface StartupSettings {
  accessPolicy?: SlackAccessPolicyConfig;
  ignoredLegacySettings?: string[];
  useStdio: boolean;
  tcpPort: number | undefined;
  botToken: string;
  appToken: string;
  dmUsers: string[] | undefined;
  sendChannels: string[] | undefined;
  disableDms: boolean;
  subscribeMemberChannels: boolean;
  ackReaction: string | undefined;
}

export function startupSettings(
  args: string[],
  env: Record<string, string | undefined>,
): { settings: StartupSettings } | { refusal: string } {
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;
  if (!useStdio && !tcpPort) return { refusal: 'Usage: slack-mcpl --stdio | --tcp <port>' };

  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) return { refusal: 'SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables are required' };

  let accessPolicy: SlackAccessPolicyConfig | undefined;
  if (env.SLACK_ACCESS_POLICY !== undefined) {
    let value: unknown;
    try { value = JSON.parse(env.SLACK_ACCESS_POLICY); }
    catch { return { refusal: `SLACK_ACCESS_POLICY must be valid JSON, got ${policyValue(env.SLACK_ACCESS_POLICY)}` }; }
    try { accessPolicy = parseAccessPolicy(value); }
    catch (err) { return { refusal: `SLACK_ACCESS_POLICY: ${(err as Error).message}, got ${policyValue(env.SLACK_ACCESS_POLICY)}` }; }
  }
  const list = (raw: string | undefined) => raw?.split(',').map((s) => s.trim()).filter(Boolean);
  const dmUsers = accessPolicy ? undefined : list(env.SLACK_DM_USERS);
  const sendChannels = accessPolicy ? undefined : list(env.SLACK_SEND_CHANNELS);
  if (!accessPolicy && env.SLACK_SEND_CHANNELS !== undefined && sendChannels!.length === 0) {
    return { refusal: 'SLACK_SEND_CHANNELS is set but names no conversation; unset it to allow writing anywhere' };
  }
  let disableDms: boolean;
  let subscribeMemberChannels: boolean;
  try {
    disableDms = accessPolicy ? false : booleanFlag('SLACK_DISABLE_DMS', env.SLACK_DISABLE_DMS);
    subscribeMemberChannels = booleanFlag('SLACK_SUBSCRIBE_MEMBER_CHANNELS', env.SLACK_SUBSCRIBE_MEMBER_CHANNELS);
  } catch (err) {
    return { refusal: (err as Error).message };
  }
  const ackReaction = env.SLACK_ACK_REACTION?.replace(/:/g, '').trim() || undefined;
  return {
    settings: { useStdio, tcpPort, botToken, appToken, dmUsers, sendChannels, disableDms, subscribeMemberChannels, ackReaction,
      ...(accessPolicy ? { accessPolicy, ignoredLegacySettings: ['SLACK_DISABLE_DMS', 'SLACK_DM_USERS', 'SLACK_SEND_CHANNELS']
        .filter((name) => env[name] !== undefined) } : {}) },
  };
}
