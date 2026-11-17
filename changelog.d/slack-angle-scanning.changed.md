- Slack angle formatting now renders usergroup references as @label or @ID.
  Malformed nested angle tokens restart at the inner opener, which can change
  which user mention addresses the bot. Multiline angle tokens (including HTTP
  links and mention labels) remain literal; multiline mentions no longer trigger
  mention-based wake or auto-subscription. These display changes also affect
  history textContains matches; valid single-line mentions retain their behavior.
