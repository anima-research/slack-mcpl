- Rollback recommends message deletion only for stored message IDs. Unidentified
  posts and upload comments require manual checking, not generic deletion.
- Preserve available error remedies when caller IDs or Slack scope values look
  like disabled tool names; offer channel-ID sources when list_channels is disabled.
