- Operators can set `SLACK_DISABLED_TOOLS` to comma-separated tool names to
  hide them from tool listings and refuse direct calls in MCP and MCPL.
  Unknown names stop startup with a clean diagnostic naming the bad value;
  unset or empty leaves existing tool availability unchanged. Startup logs
  the effective disabled set. Only the agent's tool surface is affected:
  server-initiated and host-driven Slack calls (including automatic backscroll,
  acknowledgement reactions, MCPL `channels/publish` and `state/rollback`)
  are not.
