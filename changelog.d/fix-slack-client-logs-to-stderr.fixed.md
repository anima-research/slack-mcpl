- Over stdio, a Slack client could write a log line to stdout, which carries
  the protocol: a rate-limited `auth.test` at launch, or a rate-limited
  `apps.connections.open` whenever Socket Mode connects, logged that it would
  try again with `console.info`. mcpl-core 0.3.0's reader emits an error for a
  line that isn't JSON. Every Slack client this server builds now writes its
  log lines to stderr, at the same level as before, info and above, so lines
  at info that went to stdout now go to stderr. Each line, warn and error
  included, now opens `[slack-mcpl] <client> (<level>):`, where the library
  opened it with its own label, such as
  `[WARN]  socket-mode:SocketModeClient:0`.
