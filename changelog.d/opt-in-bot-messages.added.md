- Operators can opt in to other bots' live messages with `SLACK_BOT_MESSAGES=all`
  or a comma-separated allow-list of bot/user IDs. It defaults off; admitted
  messages carry `chat:from-bot` and a bot-source text marker. The connector's
  own user and bot IDs are always filtered. Existing DM and subscription
  controls still apply; admitted mentions can auto-subscribe and receive
  the configured acknowledgement reaction. With an ID allow-list, explicitly
  listed IDs pass even if verification fails, conservatively marked as bot.
  Unlisted senders must be verified human; first-seen human messages may be
  lost during users.info outages. Failures have a bounded 256-entry negative
  cache with a 30-second retry cooldown and per-user in-flight coalescing,
  never a human classification. Other bots can form reply loops,
  so prefer an allow-list and host-side bot wake restrictions/rate limits.
