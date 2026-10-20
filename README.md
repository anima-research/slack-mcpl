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

- **Channels**: every conversation the bot can act in, of each kind its token has the read scope for, is registered as an MCPL channel (`slack:<conversationId>`) when the host grants `channels.register`, and `refresh_channels` registers ones joined since. `channels/publish` posts in the thread of the last message from that conversation the host took, which can change while the agent is answering. Use [`reply_message` for an explicit thread](#reply-to-a-specific-thread).
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
- **Typing**: `channels/typing` shows "is thinking…" on the thread of the
  conversation's newest incoming message (`assistant.threads.setStatus`,
  covered by `chat:write`), only where the bot may write. Slack clears it
  when the bot posts in that thread, on `op: 'stop'`, or after 2 minutes.
- **Attachments**: incoming files are forwarded as refs and fetched on demand
  via `fetch_attachment`, which is auth-locked to `files.slack.com` (the bot
  token is never sent to any other host) and size-capped at 5MB. A download
  that takes longer than 10 seconds fails, and can be called again.
- **Rollback**: `slack.messaging` supports MCPL checkpoints — rolling back
  deletes the messages and uploaded files the bot sent after the checkpoint
  (best-effort). Each of its tools' successful results names its checkpoint
  and that checkpoint's parent, the checkpoint before the call, so a rollback
  to a call's parent deletes what that call posted or uploaded. Edits,
  deletions and reactions aren't undone. A process's first call's parent is
  the tree's root, made when the server starts, which a host learns only as
  that parent: a host that rolls back only to checkpoints a result named as
  its own can't reach it.

## Tools

`send_message`, `reply_message`, `upload_file`, `send_dm`, `add_reaction`,
`edit_message`, `delete_message`, `list_channels`, `refresh_channels`, `fetch_history`,
`fetch_thread`, `find_user`, `fetch_attachment`, `subscribe_channel`,
`unsubscribe_channel`, `list_subscriptions`.

Feature sets: `slack.messaging` (rollback-capable; `send_message`,
`reply_message`, `upload_file`, `send_dm`, `add_reaction`, `edit_message`, `delete_message`,
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

## Upload a file

Use `upload_file` with a Slack `channelId`, a required `filename`, and exactly
one of `content` (UTF-8 text) or `contentBase64` (canonical RFC 4648 base64,
with padding where required, and no whitespace or data-URI prefix). The
content must be nonempty. This server limits inline content to 5 MiB
(5,242,880 bytes), measured after UTF-8 encoding or base64 decoding; this is
the server's inline limit, not Slack's file-size limit. The tool accepts
inline content only; it does not read a path on the server. An agent writes
the whole file out as the tool's arguments, so the content goes through the
model's own output, and `contentBase64` suits small binary files.

Optional `messageId` selects the thread root (the message's `thread=` value,
or its `id=` when it has no `thread=`). `title` names the
file in Slack (defaulting to `filename`), and `comment` adds an initial
comment. An optional argument given as JSON null or an empty string counts as
not given. `SLACK_SEND_CHANNELS` and `SLACK_DISABLE_DMS` apply to uploads just
as they do to message sends.

An upload runs in Slack's three steps: `files.getUploadURLExternal` gives an
upload URL and the file's ID, the file's bytes go to that URL, and
`files.completeUploadExternal` shares the file. Slack shares a file only at
the last step, so an upload that fails before it shared nothing and can be
called again. When the last step fails, its error says whether the file may
have been shared anyway, and if it may, what to check before uploading again;
an error this server doesn't recognize passes through as it came.

Uploads belong to `slack.messaging` checkpoints, so rollback attempts to
delete them along with later messages: the file, through Slack's file
deletion API, and the message that shared it, which holds the comment, when
Slack's answer named that message. When it didn't, the rollback's answer says
the comment may remain, and that `delete_message` may delete it. An upload
that failed after Slack gave the file its ID is rolled back the same way.
Rollback is best-effort and reports partial failures by kind, naming each
message and file it couldn't delete, with its conversation, and apart from
the rest those Slack refused to delete for good. The items it couldn't delete
include a post this server can't name, because Slack's answer to it named no
message or its call failed in a way that may have posted it. The rollback
names it as one that may remain, with its conversation, and thread for a
reply, where `fetch_history` or `fetch_thread` shows its id for
`delete_message`. Checkpoint
history is kept in memory across host reconnects, but does not survive a
server restart. As with message rollback, failed deletions are logged and
reported in the rollback's answer, but are not retained for another rollback
attempt.

**Operators:** the bot token needs `files:write`. After adding that scope to
an existing Slack app, reinstall the app to the workspace through Slack's
OAuth flow so the installed token receives the new scope. Editing the app's
scope list alone does not update the token. Without the scope, Slack refuses
uploads with `missing_scope`.

## Reply to a specific thread

When answering a particular message, use `reply_message` to select its thread explicitly. Automatic prose delivery through `channels/publish` carries no thread or triggering message ID. The server uses the thread of the last message from that Slack conversation the host took instead, so another message can redirect the reply to a different thread, or to the channel's top level ([#6](https://github.com/anima-research/slack-mcpl/issues/6)). The server keeps that in memory only: after a restart, a publish goes to the top level until the host takes a message from the conversation.

1. Select the Slack conversation ID, such as `C123`, rather than its MCPL ID, `slack:C123`. Every incoming message's header gives it as `channelId=`; copy it from there, a DM's included, rather than from memory.
2. For `messageId`, use the target message's displayed `thread=` value. If it has no `thread=`, use its `id=`: the reply goes into that message's own thread, which starts one if it has none. History results call these fields `threadTs` and `id`.
3. Send the reply through `reply_message`.

For example, to answer `[channelId=C123 thread=1718000000.000100 id=1718000000.000200] Ann: Can you check this?`, call `reply_message` with:

```json
{
  "channelId": "C123",
  "messageId": "1718000000.000100",
  "content": "Here is what I found."
}
```

This selects the thread root even if another message arrives before the tool call. Its answer, like `send_message`'s, `send_dm`'s and `upload_file`'s, names the conversation it went to in `to`, by its label in this server's channel registry (`#support (acme)`, `DM: @Ann (acme)`), so a reply sent to the wrong conversation shows in the same turn. The registry holds the conversations an MCPL host took when this server connected, and those `refresh_channels` has registered since. A write to any other conversation, such as a DM first written in after the listing, answers without `to`, and so does every write from a plain MCP client, which registers none. The automatic `channels/publish` route still has the limitation above; explicit tool replies do not change its destination.

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
      - files:write   # upload_file
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

If you add scopes such as `files:write` to an already installed app,
reinstall it to the workspace through the OAuth flow to grant those scopes
to the bot token.

### 3. Run

```bash
npm install
npm run build

SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... slack-mcpl --stdio
# or: slack-mcpl --tcp 9040
```

## Environment

Switches take `true`/`false` (also `1`/`0`, `yes`/`no`); any other value stops the server, so a typo cannot leave a guard off.

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-…`) for Web API calls |
| `SLACK_APP_TOKEN` | yes | App-level token (`xapp-…`, `connections:write`) for Socket Mode |
| `SLACK_DM_USERS` | no | Comma-separated user-ID whitelist for DMs; others' DMs are dropped |
| `SLACK_SEND_CHANNELS` | no | Comma-separated conversation-ID allow-list for writes (send, upload, DM, edit, delete, reaction, and the host's `channels/publish`); writes elsewhere are refused before the call reaches Slack. Other conversations are registered `inbound`, `list_channels` shows `writable: false`, and the first message the agent gets from one, addressed or not, carries a read-only note. A mention there still reaches the agent; whether it wakes is the host's policy. `send_dm` is refused before a DM is opened, and not offered, unless the list names a DM. Set but empty is refused at startup; the effective list is logged |
| `SLACK_SUBSCRIBE_MEMBER_CHANNELS` | no | `true` delivers ambient messages from every channel the bot is a member of, so inviting the bot is the subscription. `unsubscribe_channel` then mutes a conversation (`subscribe_channel` unmutes it) and `list_subscriptions` lists the muted ones. Takes `true` or `false` (also `1`/`0`, `yes`/`no`); unset is off, and any other value, empty included, stops startup |
| `SLACK_DISABLE_DMS` | no | `true` drops incoming DMs and group DMs, refuses every write to them and both history reads on them, and leaves them out of `conversations.list`, so they are neither listed nor registered; `send_dm` is not offered. Only a conversation Slack confirms as a channel passes: a group DM ID looks like a channel ID, and a user ID posts into that user's DM. An unknown ID is asked about until Slack confirms it. One Slack won't describe is refused; when the question can't be answered just now (a rate limit, a failure on the way or on Slack's side, or too little of the call's time), nothing is written, and the error says why and that the call can be made again. Incoming events pass only when Slack marks them `channel` or `group`. Takes `true` or `false` (also `1`/`0`, `yes`/`no`); unset is off, and any other value, empty included, stops startup |
| `SLACK_ACK_REACTION` | no | Emoji name (e.g. `eyes`) put on a message that addresses the bot. It means "received": it is removed at the bot's next post in that conversation that Slack confirms, after 10 minutes, or at once if the host does not accept the message. A removal that fails in a way that can pass (a rate limit, an HTTP error, a network failure, or Slack's own failure such as `internal_error`) is tried again every minute, up to 5 tries in all; one Slack refuses is dropped. An add that fails isn't tried again. One that may have landed is removed as usual: `already_reacted` says it's there, and Slack's failure while handling it (`internal_error`, `fatal_error`, `service_unavailable`), an HTTP error, an answer not in Slack's form or one the client can't read, or a failure in transit after the request may have reached Slack leaves it unknown. One Slack refused, rate-limited or received only in part (`request_timeout`), one whose connection was never made, and one this server refused itself, such as outside `SLACK_SEND_CHANNELS`, isn't there. On SIGTERM, SIGINT or the host closing stdin, pending reactions are removed (5 s at most); a crash cannot, so removal is best-effort. For a typing signal see **Typing** above. |
| `SLACK_SUBSCRIPTIONS_FILE` | no | JSON file persisting ambient subscriptions across restarts: an array of IDs, or `{subscribed, muted}` while anything is muted (older versions read the object form as empty) |
| `SLACK_BACKSCROLL_LIMIT` | no | Messages fetched on first interaction with a conversation (default 50) |
| `SLACK_MCPL_DEBUG_LOG` | no | Absolute path for a diagnostic file log |

## Tests

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A change an operator, a host or an
agent would notice lands with a changelog fragment in
[`changelog.d/`](changelog.d/README.md).

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
