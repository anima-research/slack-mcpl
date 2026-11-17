- Operators can set `SLACK_DISABLED_TOOLS` to comma-separated tool names to
  hide them from tool listings and refuse direct calls in MCP and MCPL.
  Unknown names stop startup with a clean diagnostic naming the bad value;
  unset leaves existing tool availability unchanged; a set value naming no tool
  stops startup. Duplicate names are normalized once. Startup logs
  the effective disabled set. Every tools/call is affected, whoever sends it;
  server-initiated Slack operations and non-tool host protocol requests (including automatic backscroll,
  acknowledgement reactions, MCPL `channels/publish` and `state/rollback`)
  are not.
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
