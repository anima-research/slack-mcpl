- Opt in to live delivery of other bots' messages with `SLACK_BOT_MESSAGES`.
  Leave it unset to keep the legacy filter and delivery behavior unchanged.
  - Use `all` to admit all other bots. Recognized bots (including Slackbot)
    are marked as bots; a user-only sender whose lookup fails or is
    inconclusive is still delivered with `chat:from-human`.
  - Use a comma-separated list of bot or user IDs (e.g. `B012ABC,U034DEF`)
    to admit those identities and verified humans only. Unknown listed
    senders are marked as bots; unlisted, unverified senders are dropped.
  - Bot deliveries carry `chat:from-bot` instead of `chat:from-human` and a
    `[Slack source: bot]` text marker. Both delivery lanes carry `isBot` and,
    when available, `authorBotId`.
  - List mode fails closed when verification fails. Transient failures
    cool down for 30 seconds, or Slack's Retry-After when rate-limited.
    The 256-entry failure cache can evict cooldowns early; restarting clears
    all verification state. List-mode startup checks for `users:read` when
    Slack reports token scopes; add the scope and reinstall the app if needed.
  - Permanent refusals remain cached until restart in unset and `all` modes;
    allow-list mode can retry them after eviction from its bounded negative cache.
  - Both opt-in modes require the connector's authenticated user and bot
    IDs at startup and drop its own messages by either ID.
  - Self-filtering does not prevent loops between different bots. Prefer a
    list and configure host wake restrictions or rate limits before opting in.
