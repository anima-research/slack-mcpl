- Operators can opt in to other bots' live messages with `SLACK_BOT_MESSAGES=all`
  or a comma-separated allow-list of bot/user IDs. It defaults off; admitted
  messages carry `chat:from-bot` and a bot-source text marker. The connector's
  own user and bot IDs are always filtered. Existing DM and subscription
  controls still apply; other bots can form reply loops, so prefer an
  allow-list and host-side bot wake restrictions/rate limits.
