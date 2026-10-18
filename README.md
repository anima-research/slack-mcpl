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

- **Channels**: every conversation the bot can act in is registered as an MCPL channel (`slack:<conversationId>`) when the host grants `channels.register`, and `refresh_channels` registers ones joined since. `channels/publish` posts in the thread of the last message the server passed to the host from that conversation, which can change while the agent is answering. Use [`reply_message` for an explicit thread](#reply-to-a-specific-thread).
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
  token is never sent to any other host) and size-capped at 5MB. A download
  that takes longer than 10 seconds fails, and can be called again.
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

## Reply to a specific thread

When answering a particular message, use `reply_message` to select its thread explicitly. Automatic prose delivery through `channels/publish` carries no thread or triggering message ID. The server uses the thread of the last message it passed to the host from that Slack conversation instead, whether or not the host accepted it, so another message can redirect the reply to a different thread, or to the channel's top level ([#6](https://github.com/anima-research/slack-mcpl/issues/6)). The server keeps that in memory only: after a restart, a publish goes to the top level until the server passes on a message from the conversation.

1. Select the Slack conversation ID, such as `C123`, rather than its MCPL ID, `slack:C123`.
2. For `messageId`, use the target message's displayed `thread=` value. If it has no `thread=`, use its `id=`: the reply goes into that message's own thread, which starts one if it has none. History results call these fields `threadTs` and `id`.
3. Send the reply through `reply_message`.

For example, to answer `[thread=1718000000.000100 id=1718000000.000200] Ann: Can you check this?` in conversation `C123`, call `reply_message` with:

```json
{
  "channelId": "C123",
  "messageId": "1718000000.000100",
  "content": "Here is what I found."
}
```

This selects the thread root even if another message arrives before the tool call. The automatic `channels/publish` route still has the limitation above; explicit tool replies do not change its destination.

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

## Bounded history and thread reads

`fetch_history` searches one conversation's **channel-level messages**. It does
not search ordinary thread replies; an incidental broadcast reply does not make
it a complete thread search. Use `fetch_thread(channelId, threadTs)` for one
known root. No automatic thread expansion or workspace search occurs.

Both tools return `messages`, each with `id`, `author`, `timestamp`, `content`,
optional `threadTs` and attachment hints, as before, and add:

- `authorId` when Slack supplies a user ID, and `authorBotId` when supplied.
  Authors' and mentioned users' names are looked up as before, and an author
  whose name can't be had is shown by their ID.
- `rootTs`, the thread a message belongs to: its parent's ts, as Slack reports
  it on a reply or a broadcast reply, or the message's own. `threadTs`
  continues to identify a reply's parent. `replyCount` is included only when
  Slack supplies a valid nonnegative integer; missing means unknown, not zero.
- `channel`: the conversation's `id`, and `writable`, with
  `list_channels.writable`'s meaning.

`SLACK_DISABLE_DMS` checks a read's conversation as every read is checked, and
Slack's own refusal of a read is passed on as the other tools' are.

`fetch_history` also accepts `textContains`, `caseSensitive` (default `false`)
and `authorIds`. The literal substring is matched against **raw Slack text**,
before formatting. Case-insensitive matching uses JavaScript Unicode
`toLowerCase`, without locale rules or normalization. Author IDs are exact
Slack user IDs, ORed within the list and ANDed with the substring. Missing
authors do not match an author filter. Regex is not supported. Filtering reduces
returned context; it still retrieves candidate messages from Slack.

All numeric inputs are bounded integers, applied **per call**:

| Input | Default | Inclusive range | Meaning |
|---|---:|---:|---|
| `limit` | 50 history / 100 thread | 1–1,000 | Returned matches/messages; thread parent counts when present |
| `maxScanned` | 1,000 | 1–10,000 | Candidate messages examined |
| `maxBytes` | 65,536 | 2,048–1,048,576 | UTF-8 bytes of the complete result JSON, before MCP text-block wrapping |

Each page is one Slack request, made like every other request this server
makes: it goes out only if its 10-second timeout fits in what is left of the
call's 25 seconds, and a rate limit that fits the call's 5-second budget for
waiting is waited out. A page that doesn't fit, or a longer rate limit, ends the
read with what it found and a cursor. A read that has scanned nothing yet fails
instead, saying why, as any call does.

`pagination` reports `scanned`, `matched`, `returned`, `pages`, `scanComplete`,
`stopReason`, `scope` and `threadRepliesSearched`. `matched` counts examined
matches, including a match held back by the byte budget. Stop reasons are
`exhausted`, `match_limit`, `scan_limit`, `byte_limit`, `time_limit`,
`rate_limited` and `pagination_stalled`. A rate limit includes
`retryAfterSeconds` when Slack gave one; the caller chooses whether and when to
resume. A stalled pagination response is incomplete, never silently exhausted.

**Zero matches in an incomplete scan does not mean no matching message exists.**
`scanComplete` describes only the selected channel-message range or single
thread, never all channel threads. A default upper timestamp is fixed when the
initial read starts. `oldest` and `latest` are exclusive bounds on both tools.
Slack history remains live: edits and deletions can affect later pages; this is
not an immutable export.

For incomplete reads, pass `pagination.nextCursor` as `cursor` and repeat the
original channel, thread, time bounds and filters. Budget values may change
within their bounds. History traverses newest toward older messages, returning
each batch oldest-first; thread traversal proceeds oldest toward newer replies.
Append thread batches, but prepend later history batches when building a
chronological list. When `byte_limit` returns no messages, increase `maxBytes`
to fit the held match; it is not silently skipped. A match larger than the hard
maximum cannot be returned whole by this tool.

A cursor carries the position to continue from and a hash of its query. The
server keeps nothing for it, so it doesn't expire and survives a restart. A
cursor used with another channel, thread, time bounds or filters, or one this
server didn't give, is refused before Slack is asked. Every continuation reads
Slack again; a cursor never grants access or holds message content.

Compatibility: the former truncation `note` is replaced by structured
`pagination`; clients must check it and resume rather than assuming a complete
range. Previously unbounded or invalid numeric limits and unknown arguments now
refuse. Existing tool names, default match counts and `list_channels.writable`
remain stable. No new scopes, regex, bulk expansion, native search or
interaction-token handling are included.

## Environment

Switches take `true`/`false` (also `1`/`0`, `yes`/`no`); any other value stops the server, so a typo cannot leave a guard off.

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-…`) for Web API calls |
| `SLACK_APP_TOKEN` | yes | App-level token (`xapp-…`, `connections:write`) for Socket Mode |
| `SLACK_DM_USERS` | no | Comma-separated user-ID whitelist for DMs; others' DMs are dropped |
| `SLACK_SEND_CHANNELS` | no | Comma-separated conversation-ID allow-list for writes (send, DM, edit, delete, reaction, and the host's `channels/publish`); writes elsewhere are refused before the call reaches Slack. Other conversations are registered `inbound`, `list_channels` shows `writable: false`, and the first message the agent gets from one, addressed or not, carries a read-only note. A mention there still reaches the agent; whether it wakes is the host's policy. `send_dm` is refused before a DM is opened, and not offered, unless the list names a DM. Set but empty is refused at startup; the effective list is logged |
| `SLACK_SUBSCRIBE_MEMBER_CHANNELS` | no | `true` delivers ambient messages from every channel the bot is a member of, so inviting the bot is the subscription. `unsubscribe_channel` then mutes a conversation (`subscribe_channel` unmutes it) and `list_subscriptions` lists the muted ones. Takes `true` or `false` (also `1`/`0`, `yes`/`no`); unset is off, and any other value, empty included, stops startup |
| `SLACK_DISABLE_DMS` | no | `true` drops incoming DMs and group DMs, refuses every write to them and both history reads on them, and leaves them out of `conversations.list`, so they are neither listed nor registered; `send_dm` is not offered. Only a conversation Slack confirms as a channel passes: a group DM ID looks like a channel ID, and a user ID posts into that user's DM. An unknown ID is asked about until Slack confirms it. One Slack won't describe is refused; when the question can't be answered just now (a rate limit, a failure on the way or on Slack's side, or too little of the call's time), nothing is written, and the error says why and that the call can be made again. Incoming events pass only when Slack marks them `channel` or `group`. Takes `true` or `false` (also `1`/`0`, `yes`/`no`); unset is off, and any other value, empty included, stops startup |
| `SLACK_ACK_REACTION` | no | Emoji name (e.g. `eyes`) put on a message that addresses the bot. It means "received": it is removed at the bot's next post in that conversation, after 10 minutes, or at once if the host does not accept the message. A removal that fails without an answer from Slack (a rate limit, an HTTP error or a network failure) is retried every minute, 5 times at most; one Slack refuses is dropped. An add that fails isn't tried again. One that may have landed is removed as usual: `already_reacted` says it's there, and Slack's failure while handling it (`internal_error`, `fatal_error`, `service_unavailable`), an HTTP error, or a failure in transit after the request may have reached Slack leaves it unknown. One Slack refused, rate-limited or received only in part (`request_timeout`), one whose connection was never made, and one this server refused itself, such as outside `SLACK_SEND_CHANNELS`, isn't there. On SIGTERM, SIGINT or the host closing stdin, pending reactions are removed (5 s at most); a crash cannot, so removal is best-effort. Slack has no typing indicator for bots |
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
