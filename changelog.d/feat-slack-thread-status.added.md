- Optional `slack.typing` maps `channels/typing` (and
  `notifications/typing`) to "is thinking…" on the latest accepted,
  addressed thread still waiting for an answer. Hosts without
  `channels.typing` keep messaging, with `mode: 'degraded'` naming
  `slack.typing`; hosts pinning `enabledFeatureSets` must add that set to
  enable status. Ambient, refused and top-level messages get no new
  status. Only writable conversations are eligible, respecting
  `SLACK_DISABLE_DMS`. The server clears status on the `op: 'stop'`
  extension (even while typing is disabled), a typing-policy reduction,
  a confirmed post, peer disconnect or shutdown, best-effort;
  Slack expires it after 2 minutes, or clears it when the bot replies in
  that thread. A stop keeps the pending thread for retries and overlapping
  inferences; the root is forgotten on a confirmed post, a newer addressed
  message, or peer change. A new typing run is capped at the 10-minute
  acknowledgement lifetime since the message was taken, but continuous
  refreshes preserve a running turn. A stop or more than 60 seconds without
  a start ends a run; a first start at or after the cap gets no status.
  The declared `ChannelsTypingParams` has only `{channelId}`, so
  hosts without the extension clear via post, disconnect, shutdown or
  expiry. Calls are ordered per conversation, successful refreshes are
  limited to once a minute, and lasting API refusals suppress further
  attempts until the peer changes (including a lasting conversations.info
  refusal when DMs are disabled), in that conversation, or in that thread
  for `invalid_thread_ts`.
