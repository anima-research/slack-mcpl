- Operator controls, all off by default (#3). Slack scopes apply to the whole
  workspace, so these limits live in the server:
  - `SLACK_SEND_CHANNELS`: conversation-ID allow-list for writes (send, DM,
    edit, delete, reactions, `channels/publish`). Other conversations are
    registered `inbound` and refused before the call reaches Slack. Set but
    empty is refused at startup.
  - `SLACK_DISABLE_DMS`: drops incoming DMs and group DMs, and refuses writes
    and history reads on them.
  - `SLACK_ACK_REACTION`: an emoji put on a message that addresses the bot,
    removed at the bot's next post in that conversation or after 10 minutes.
  - `SLACK_SUBSCRIBE_MEMBER_CHANNELS`: delivers ambient messages from every
    channel the bot is a member of, so inviting the bot is the subscription;
    `unsubscribe_channel` then mutes a conversation.
- Switches take `true`/`false`, `1`/`0` or `yes`/`no`; any other value stops
  the server at startup, so a typo cannot leave a guard off (#3).
