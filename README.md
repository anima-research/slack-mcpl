# slack-mcpl

Standalone Slack MCPL server: connects a Slack workspace (channels, private
channels, DMs, group DMs) to an MCPL host as a first-class channel surface.
Sibling of [discord-mcpl](../discord-mcpl), built on
[`@connectome/mcpl-core`](../mcpl-core-ts).

Works in plain MCP mode too (tools only, no push events or channels).

The server negotiates MCPL when the host advertises `experimental.mcpl` in
`initialize`. It stays inert until the host's `featureSets/update` Request
establishes the capability grant (MCPL 0.5 SPEC §5.3 — absence is denial),
then registers Slack conversations as channels. Channel registration, push
events, and every other privileged inbound method stay unavailable until
that grant arrives; plain MCP tool calls are unaffected.

## Features

- **Channels**: every conversation the bot can act in is registered as an
  MCPL channel (`slack:<conversationId>`); `channels/publish` replies into
  the active thread of the conversation automatically.
- **Real-time events** via Socket Mode — no public webhook URL needed, so the
  server can be spawned over stdio like any other MCPL server.
- **Addressing model**: mentions (`<@bot>`) and DMs are always delivered;
  ambient channel chatter flows only from subscribed conversations
  (auto-subscribe on first mention, opt out with `unsubscribe_channel`).
  With `SLACK_SUBSCRIBE_MEMBER_CHANNELS`, every conversation the bot is in is
  subscribed and `unsubscribe_channel` mutes one instead.
  Events carry MCPL RFC-001 `chat:*` tags for host-side wake gating.
- **Threads**: incoming thread replies carry `threadId`; `reply_message`
  posts into a message's thread; `fetch_thread` reads one (Slack's
  channel-level history API does not include thread replies).
- **Attachments**: incoming files are forwarded as refs and fetched on demand
  via `fetch_attachment`, which is auth-locked to `files.slack.com` (the bot
  token is never sent to any other host) and size-capped at 5MB.
- **Rollback**: `slack.messaging` supports MCPL checkpoints — rolling back
  deletes the messages the bot sent after the checkpoint (best-effort).

## Tools

`send_message`, `reply_message`, `send_dm`, `add_reaction`, `edit_message`,
`delete_message`, `list_channels`, `refresh_channels`, `fetch_history`,
`fetch_thread`, `find_user`, `fetch_attachment`, `subscribe_channel`,
`unsubscribe_channel`, `list_subscriptions`.

Feature sets: `slack.messaging` (rollback-capable; `send_message`,
`reply_message`, `send_dm`, `add_reaction`, `edit_message`, `delete_message`,
plus push events and `channels/incoming` delivery),
`slack.history` (`fetch_history`, `fetch_thread`, `fetch_attachment`),
`slack.subscriptions` (`subscribe_channel`, `unsubscribe_channel`,
`list_subscriptions`). `list_channels`, `refresh_channels` and `find_user`
belong to no feature set, so disabling a feature set does not switch them
off. In MCPL mode they still need the `tools` grant: every tool is refused
until the host has granted `tools`. Channel registration and
`channels/publish` follow their own capabilities (`channels.register`,
`channels.publish`), not the `slack.messaging` feature set.

A host that grants `slack.messaging` a capability set missing what it
declares (§6.4) stops its tools, its incoming delivery, and its push events
all at once, and the degradation receipt to `featureSets/update` reports the
missing paths in `unavailableFeatures`. A host that only leaves
`slack.messaging` out of `enabled`, or lists it in `disabled`, gets the same
effect, but the receipt does not list it: the receipt reports missing
capabilities, not feature-set selection.

The host receives each reply once, through `channels/publish`. The server
does not declare `channels.streaming`.

## Setup

### 1. Create the Slack app

Go to https://api.slack.com/apps → **Create New App** → *From a manifest*,
and paste:

```yaml
display_information:
  name: Connectome Agent
features:
  bot_user:
    display_name: connectome-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - chat:write
      - users:read
      - reactions:write
      - files:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  socket_mode_enabled: true
```

### 2. Tokens

1. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
   → `SLACK_BOT_TOKEN`
2. Under **Basic Information → App-Level Tokens**, generate a token with the
   `connections:write` scope (`xapp-...`) → `SLACK_APP_TOKEN`
3. Invite the bot to channels you want it to see:
   `/invite @connectome-agent` (DMs work without invites — users can message
   the bot directly)

### 3. Run

```bash
npm install
npm run build

SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... slack-mcpl --stdio
# or: slack-mcpl --tcp 9040
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-…`) for Web API calls |
| `SLACK_APP_TOKEN` | yes | App-level token (`xapp-…`, `connections:write`) for Socket Mode |
| `SLACK_DM_USERS` | no | Comma-separated user-ID whitelist for DMs; others' DMs are dropped |
| `SLACK_SEND_CHANNELS` | no | Comma-separated conversation-ID allow-list for writes (send, DM, edit, delete, reaction, and the host's `channels/publish`); writes elsewhere are refused before the call reaches Slack. Other conversations are registered `inbound`, `list_channels` shows `writable: false`, and the first message the agent gets from one, addressed or not, carries a read-only note. A mention there still reaches the agent; whether it wakes is the host's policy. `send_dm` is refused before a DM is opened unless the list names a DM. Set but empty is refused at startup; the effective list is logged |
| `SLACK_SUBSCRIBE_MEMBER_CHANNELS` | no | `true` delivers ambient messages from every channel the bot is a member of, so inviting the bot is the subscription. `unsubscribe_channel` then mutes a conversation (`subscribe_channel` unmutes it) and `list_subscriptions` lists the muted ones |
| `SLACK_DISABLE_DMS` | no | `true` drops incoming DMs and group DMs, refuses every write to them and both history reads on them, and leaves them out of `conversations.list`, so they are neither listed nor registered; `send_dm` is not offered. Only a conversation Slack confirms as a channel passes: a group DM ID looks like a channel ID, and a user ID posts into that user's DM. An unknown ID is asked about once; if Slack cannot say, it is refused |
| `SLACK_ACK_REACTION` | no | Emoji name (e.g. `eyes`) put on a message that addresses the bot. It means "received": it is removed at the bot's next post in that conversation, after 10 minutes, or at once if the host does not accept the message. A removal that fails without an answer from Slack (rate limit, network) is retried every minute, 5 times at most; one Slack refuses is dropped. On SIGTERM, SIGINT or the host closing stdin, pending reactions are removed (5 s at most); a crash cannot, so removal is best-effort. Slack has no typing indicator for bots |
| `SLACK_SUBSCRIPTIONS_FILE` | no | JSON file persisting ambient subscriptions across restarts: an array of IDs, or `{subscribed, muted}` while anything is muted (older versions read the object form as empty) |
| `SLACK_BACKSCROLL_LIMIT` | no | Messages fetched on first interaction with a conversation (default 50) |
| `SLACK_MCPL_DEBUG_LOG` | no | Absolute path for a diagnostic file log |

## Tests

```bash
npm test
```

## Provenance

The Slack domain logic (Socket Mode event handling, mrkdwn formatting,
cursor-drained history pagination, attachment URL allowlisting) was salvaged
from zulip-mcp PR #8's multi-platform branch and re-homed here as a
standalone MCPL server following discord-mcpl's structure.

The MCPL 0.5 policy handshake (`src/grant.ts`, `src/errors.ts`, and the
`featureSets/update` wiring in `src/server.ts`) is ported from zulip-mcp's
`src/grant.ts`, which is itself protocol-generic — no Zulip-specific logic —
built on `@animalabs/mcpl-core`'s `grantFromUpdate`/`capabilityGranted`/
`deriveFeatureSets`.
