/**
 * Run by slackClient.test.ts in a process of its own, so the test reads what
 * reaches this process's stdout: connects as the server does, against the
 * local endpoint its argument names, and starts Socket Mode, then exits once
 * Slack refuses Socket Mode's connection.
 */
import { connectSlack } from '../src/slack-adapter.js';

const adapter = await connectSlack({ botToken: 'xoxb-test', appToken: 'xapp-test' }, process.argv[2]);
await adapter.start().catch(() => undefined);
process.exit(0);
