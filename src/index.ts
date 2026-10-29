#!/usr/bin/env node
/**
 * Slack MCPL server — CLI entry point.
 *
 * Usage:
 *   slack-mcpl --stdio           # MCP-compatible stdio transport
 *   slack-mcpl --tcp <port>      # TCP transport for MCPL hosts
 *
 * Environment:
 *   SLACK_BOT_TOKEN   - Required: bot token (xoxb-…) for Web API calls
 *   SLACK_APP_TOKEN   - Required: app-level token (xapp-…) with connections:write,
 *                       for Socket Mode events (no public webhook URL needed)
 *   SLACK_DM_USERS    - Optional: comma-separated user-ID whitelist for DMs.
 *                       When set, DMs from anyone else are dropped.
 *   SLACK_SEND_CHANNELS - Optional: comma-separated conversation-ID allow-list
 *                       for writes. When set, writes elsewhere are refused.
 *   SLACK_SUBSCRIBE_MEMBER_CHANNELS - Optional: 'true' delivers ambient messages from
 *                       every channel the bot is a member of; unsubscribe_channel
 *                       then mutes one
 *   SLACK_DISABLE_DMS - Optional: 'true' drops incoming DMs and refuses DM sends
 *                       and DM history reads.
 *   SLACK_ACK_REACTION - Optional: emoji name (e.g. eyes) put on a message that
 *                       addresses the bot, removed at the bot's next post in
 *                       that conversation that Slack confirms, or after 10
 *                       minutes.
 *   SLACK_SUBSCRIPTIONS_FILE - Optional: JSON file persisting ambient-channel
 *                       subscriptions across restarts
 *   SLACK_PATH_UPLOADS - Optional: explicit JSON policy for local path inputs:
 *                       restricted directories or trusted unrestricted mode
 *   SLACK_BACKSCROLL_LIMIT   - Optional: messages fetched on first interaction
 *                       with a conversation (default 50)
 */

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { connectSlack } from './slack-adapter.js';
import { SlackMcplServer } from './server.js';
import { startupSettings } from './config.js';
import { serveTcp } from './tcp.js';

async function main(): Promise<void> {
  const startup = startupSettings(process.argv.slice(2), process.env);
  if ('refusal' in startup) {
    console.error(startup.refusal);
    process.exit(1);
  }
  const { useStdio, tcpPort, botToken, appToken, dmUsers, sendChannels, disableDms, subscribeMemberChannels, ackReaction, pathUploads } =
    startup.settings;

  // Connect Slack first: auth.test resolves the bot's identity, then Socket
  // Mode comes up so no events are missed once the host attaches.
  const slack = await connectSlack({ botToken, appToken, dmUsers, sendChannels, disableDms, ackReaction });
  const server = new SlackMcplServer(slack, {
    subscribeMemberChannels,
    pathUploads,
  });
  await slack.start();
  console.error(
    `[slack-mcpl] Slack connected as bot ${slack.botUserId} in workspace "${slack.teamName}"`,
  );
  console.error(
    `[slack-mcpl] writes: ${sendChannels?.length ? `only ${sendChannels.join(', ')}` : 'anywhere'}; ` +
      `DMs: ${disableDms ? 'off' : 'on'}`,
  );

  // Take pending acknowledgement reactions off before exiting, for 5 s at
  // most: a Slack request can take up to its 10-second timeout to fail, so a
  // removal still waiting on Slack then is left on its message.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
    server.close();
    void slack.stop().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  if (useStdio) {
    // Stdio transport — single client, MCP-compatible
    // Log to stderr (stdout is the protocol channel)
    console.error('[slack-mcpl] Starting on stdio');
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await server.serve(conn);
    shutdown(); // the host closed stdin, or stdin or stdout failed
  } else if (tcpPort) {
    // TCP transport — single client
    console.error(`[slack-mcpl] Listening on TCP port ${tcpPort}`);
    const tcpServer = net.createServer();
    tcpServer.listen(tcpPort, '127.0.0.1');

    // A failure to listen (the port taken) emits 'error' with no listener
    // yet, which ends the process, as it should. serveTcp's own listener
    // goes on only once it's listening.
    await new Promise<void>((resolve) => tcpServer.once('listening', resolve));

    // One client at a time, for as long as the process runs.
    serveTcp(tcpServer, (conn) => server.serve(conn));
  }
}

main().catch((err) => {
  console.error('[slack-mcpl] Fatal error:', err);
  process.exit(1);
});
