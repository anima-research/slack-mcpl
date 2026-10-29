- Optional `slack.typing` maps `channels/typing` (and
  `notifications/typing`) to "is thinking…" on the latest accepted,
  addressed thread still waiting for an answer. Hosts without
  `channels.typing` keep messaging, with `mode: 'degraded'` naming
  `slack.typing`; hosts pinning `enabledFeatureSets` must add that set to
  enable status. Ambient, refused and top-level messages get no new
  status. Only writable conversations are eligible, respecting
  `SLACK_DISABLE_DMS`. The server clears status on the `op: 'stop'`
  extension, a confirmed post, peer disconnect or shutdown, best-effort;
  Slack expires it after 2 minutes, or clears it when the bot replies in
  that thread. A stop forgets only the thread the last typing start was
  for. The declared `ChannelsTypingParams` has only `{channelId}`, so
  hosts without the extension clear via post, disconnect, shutdown or
  expiry. Calls are ordered per conversation, successful refreshes are
  limited to once a minute, and lasting API refusals suppress further
  attempts until the peer changes, in that conversation, or in that thread
  for `invalid_thread_ts`.
