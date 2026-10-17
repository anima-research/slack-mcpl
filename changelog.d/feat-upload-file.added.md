- New tool `upload_file`: posts a file to a channel or DM, optionally into a
  thread (`messageId`) and with a comment. Supply a required `filename` and
  exactly one of `content` (UTF-8 text) or `contentBase64` (canonical RFC
  4648 base64, padded where required, without whitespace or a data-URI
  prefix). Empty content is refused. This server caps inline content
  at 5 MiB (5,242,880 bytes after encoding or decoding); it does not accept
  filesystem paths. The same write rules as `send_message` apply
  (`SLACK_SEND_CHANNELS`, `SLACK_DISABLE_DMS`), the tool is in the
  `slack.messaging` feature set and classed `comms`, and rollback attempts
  to delete uploads made after the checkpoint. **Operators:** the tool
  needs `files:write` on the bot token. After adding that scope, reinstall
  the app to the workspace through Slack's OAuth flow so the installed
  token receives it; otherwise Slack refuses uploads with `missing_scope`.
