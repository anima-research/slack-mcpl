- Every conversation now declares where a host's publish lands (MCPL
  RFC-011): its descriptor carries `capabilities.publish.target: 'exact'`,
  and `channels/publish` honors the RFC's `threadId` (#6). A thread's parent
  ts posts into exactly that thread, and `null` posts at the top level, even
  when a newer incoming message sits in some thread. When Slack's response
  describes the posted message, the result echoes `threadId` from it (the
  parent ts, or `null`); without that, there is no echo and the host counts
  the post unconfirmed. A target that can't be honored fails with nothing
  posted, as `delivered: false` with a `reason` and no message id: a ts that
  isn't a message in this conversation, or is a reply rather than a
  thread's parent (every thread target is checked with
  `conversations.replies` just before posting); an invalid value; a
  conversation `SLACK_SEND_CHANNELS` or `SLACK_DISABLE_DMS` blocks; an
  invalid channel ID or no text; or Slack's own refusal, such as a
  thread-only channel. An error after the post was sent (a lost
  connection, or Slack's `internal_error` or `fatal_error`) stays an error,
  which the host counts unconfirmed. A targeted publish sent as a
  Notification is dropped and logged, since only a Request can be
  answered. A request without `threadId` keeps the latest-incoming-thread
  placement and result shape exactly.
- A push about a message in a thread (a conversation the host hasn't
  opened) names that thread as `origin.threadId`, in the id space
  `channels/publish` takes, so a host answering it can name the same place;
  `origin.threadTs` stays for existing readers. A thread's parent, which
  sits at the top level, names no thread, in pushes and in
  `channels/incoming` alike.
