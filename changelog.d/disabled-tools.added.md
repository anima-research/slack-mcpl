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
