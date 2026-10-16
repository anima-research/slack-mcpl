- Track uploaded Slack files in `slack.messaging` checkpoints and delete them with
  `files.delete` during best-effort rollback, retaining destination write checks.
  Tracking survives host reconnects within the server process, as for sent messages.
