- New tool `upload_file`: posts a file to a channel or DM, optionally into a
  thread (`messageId`) and with a comment. Supply a required `filename` and
  exactly one of `content` (UTF-8 text) or `contentBase64` (canonical RFC
  4648 base64, padded where required, without whitespace or a data-URI
  prefix, on one line). Empty content, and text holding a lone UTF-16
  surrogate, are refused, and so is an optional argument that isn't a string;
  JSON null counts as not given. This server caps inline content
  at 5 MiB (5,242,880 bytes after encoding or decoding); it does not accept
  filesystem paths. The same write rules as `send_message` apply
  (`SLACK_SEND_CHANNELS`, `SLACK_DISABLE_DMS`), the tool is in the
  `slack.messaging` feature set and classed `comms`, and rollback attempts
  to delete uploads made after the checkpoint, with `files.delete` and the
  same write rules, and the message that shared the file, which holds the
  comment, when Slack's answer names it; when it doesn't, the rollback's
  answer says the comment may remain. As for sent messages, uploads are
  tracked for the life of the server process, across host reconnects. The
  upload runs in Slack's three steps, each request under the call's time:
  a failure before the last step says nothing was uploaded, a refusal of
  the last step says nothing was shared, and a failure of the last step
  that may have shared the file says what to check before uploading again,
  as does an answer that names no file; a later rollback deletes that file
  too. Refusals the explainer doesn't know pass through as Slack gave them.
  **Operators:** the tool needs `files:write` on the bot token. After
  adding that scope, reinstall the app to the workspace through Slack's
  OAuth flow so the installed token receives it; otherwise Slack refuses
  uploads with `missing_scope`.
