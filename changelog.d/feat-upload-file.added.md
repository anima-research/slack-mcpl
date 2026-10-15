- New tool `upload_file`: posts a file to a channel or DM, optionally into a
  thread (`messageId`) and with a comment. The file comes as an absolute
  `path` the server can read, or inline as `content` (text) or
  `contentBase64` (binary, up to the attachment size limit); `filename`
  defaults to the path's name. The same write rules as `send_message` apply
  (`SLACK_SEND_CHANNELS`, `SLACK_DISABLE_DMS`), the tool is in the
  `slack.messaging` feature set and classed `comms`. **Operators:** the
  tool needs the `files:write` scope on the bot token; without it Slack
  answers `missing_scope` and nothing else changes.
