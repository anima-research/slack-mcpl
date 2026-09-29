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
 *   SLACK_DISABLE_DMS - Optional: 'true' drops incoming DMs and refuses DM sends
 *                       and DM history reads.
 *   SLACK_SUBSCRIPTIONS_FILE - Optional: JSON file persisting ambient-channel
 *                       subscriptions across restarts
 *   SLACK_BACKSCROLL_LIMIT   - Optional: messages fetched on first interaction
 *                       with a conversation (default 50)
 */

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { connectSlack } from './slack-adapter.js';
import { SlackMcplServer } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !tcpPort) {
    console.error('Usage: slack-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    console.error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables are required');
    process.exit(1);
  }

  const dmUsers = process.env.SLACK_DM_USERS?.split(',').map((s) => s.trim()).filter(Boolean);

  // Connect Slack first: auth.test resolves the bot's identity, then Socket
  // Mode comes up so no events are missed once the host attaches.
  const sendChannels = process.env.SLACK_SEND_CHANNELS?.split(',').map((s) => s.trim()).filter(Boolean);
  const disableDms = process.env.SLACK_DISABLE_DMS === 'true';
  const slack = await connectSlack({ botToken, appToken, dmUsers, sendChannels, disableDms });
  const server = new SlackMcplServer(slack);
  await slack.start();
  console.error(
    `[slack-mcpl] Slack connected as bot ${slack.botUserId} in workspace "${slack.teamName}"`,
  );

  if (useStdio) {
    // Stdio transport — single client, MCP-compatible
    // Log to stderr (stdout is the protocol channel)
    console.error('[slack-mcpl] Starting on stdio');
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await server.serve(conn);
  } else if (tcpPort) {
    // TCP transport — single client
    console.error(`[slack-mcpl] Listening on TCP port ${tcpPort}`);
    const tcpServer = net.createServer();
    tcpServer.listen(tcpPort, '127.0.0.1');

    await new Promise<void>((resolve) => tcpServer.once('listening', resolve));

    // Accept and serve one connection at a time
    while (true) {
      const conn = await McplConnection.acceptTcp(tcpServer);
      console.error('[slack-mcpl] Client connected');
      await server.serve(conn);
      console.error('[slack-mcpl] Client disconnected, waiting for next...');
    }
  }
}

main().catch((err) => {
  console.error('[slack-mcpl] Fatal error:', err);
  process.exit(1);
});
