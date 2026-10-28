/** A hermetic child-process CLI invocation, shared by refusal and stdio tests.
 *  Slack calls fail locally unless startup is explicitly allowed. The real
 *  entry point, adapter and server run; only external SDK boundaries are fake. */
export function cliInvocation(vars: Record<string, string>, allowSlackStartup = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SLACK_')));
  const script = `
    import { WebClient } from '@slack/web-api';
    import { SocketModeClient } from '@slack/socket-mode';
    WebClient.prototype.apiCall = async (method) => {
      if (${allowSlackStartup}) {
        if (method === 'auth.test') return { ok: true, user_id: 'UBOT', team: 'test' };
        if (method === 'users.list') return { ok: true, members: [] };
      }
      throw new Error('Unexpected Slack API call: ' + method);
    };
    SocketModeClient.prototype.start = async () => {};
    SocketModeClient.prototype.disconnect = async () => {};
    process.argv = [process.execPath, 'src/index.ts', '--stdio'];
    await import('./src/index.ts');
  `;
  return {
    args: ['--import', 'tsx', '--input-type=module', '-e', script],
    options: {
      cwd: new URL('..', import.meta.url),
      env: { ...env, SLACK_BOT_TOKEN: 'xoxb-0-test', SLACK_APP_TOKEN: 'xapp-0-test', ...vars },
      timeout: 30_000,
    },
  };
}
