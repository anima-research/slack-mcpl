- Operators can set `SLACK_DISABLED_TOOLS` to comma-separated tool names to
  hide them from tool listings and refuse direct calls in MCP and MCPL.
  Unknown names stop startup with a clean diagnostic naming the bad value;
  unset leaves existing tool availability unchanged; a set value naming no tool
  stops startup. Duplicate names are normalized once. Startup logs
  the effective disabled set. Every tools/call is affected, whoever sends it;
  server-initiated Slack operations and non-tool host protocol requests (including automatic backscroll,
  acknowledgement reactions, MCPL `channels/publish` and `state/rollback`)
  are not directly blocked; rollback advice and messaging capability requirements
  still reflect tool availability.
- Attachment, argument, channel-open, member-unsubscribe and error guidance
  omit disabled-tool pointers (static tool descriptions and schemas may still
  cross-reference them). Refusals explain that nothing ran and
  retries cannot override operator policy. Tool-only MCPL feature sets disappear
  from the manifest and grant declarations when all their tools are disabled.
- Disabling either `subscribe_channel` or `unsubscribe_channel` also prevents
  new mention-triggered auto-subscriptions and their subscription note. Existing
  subscriptions (including persisted ones), member-channel delivery, mentions
  and DMs are unchanged. To remove saved subscriptions while unsubscribe is
  disabled, stop the server and edit `SLACK_SUBSCRIPTIONS_FILE` before restarting.
- Disabled-tool guidance distinguishes a message's own ID from its thread parent,
  avoids unavailable read, lookup and rollback retry tools, and names the setting
  and valid tool names when configuration is refused.
- Keep inbound messaging available without the tools capability when all messaging
  tools are disabled, even if tools in other feature sets remain enabled.

- Messaging does not require tools when operator controls and DM policy leave
  it with no offered tools; protocol delivery remains available.
- Preserve available error remedies when caller IDs or Slack scope values look
  like disabled tool names; offer channel-ID sources when list_channels is disabled.
- In-memory mute guidance notes restart recovery when subscribe_channel is disabled.
- Disabled send_message guidance omits channel-listing advice; message-ID
  fallbacks also point to the original sending tool's result.
- To undo subscription changes when the opposite tool is disabled, re-enable
  that tool or stop the server and edit SLACK_SUBSCRIPTIONS_FILE: undo subscribe
  by removing the ID from subscribed or adding it to muted (member-channel
  mode); undo unsubscribe by adding it to subscribed or removing it from muted.
  Without a subscriptions file, these changes last only until restart.
