- **Operators:** optional `upload_file` path access is enabled only by an explicit
  `SLACK_PATH_UPLOADS` JSON policy, or the embedded server's `pathUploads` option.
  The default remains inline-only. Restricted mode pins configured absolute
  directory roots at startup and refuses every symlink below them; unrestricted
  mode explicitly permits regular files readable by the connector account,
  including symlinks, without a directory boundary. Both use the opened file
  descriptor, refuse non-regular files, cap reads at 5 MiB and check the existing
  Slack destination guards before reading and again before upload. A path is on
  the connector's filesystem, which may differ from the host agent's. Enabled
  path uploads add the `files` tool class alongside `comms`; inline content keeps
  its required filename, while path uploads may default to the path basename.
  Directory capabilities are not content snapshots or an OS sandbox, and do not
  isolate hard links, mounts, privileged renames or equivalent shell/sudo access.
