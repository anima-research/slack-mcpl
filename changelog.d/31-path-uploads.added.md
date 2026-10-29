- **Operators:** opt in to connector-local `upload_file` paths with a
  `SLACK_PATH_UPLOADS` JSON policy or the embedded server's `pathUploads` option.
  Unset remains inline-only. Restricted mode pins one or more absolute directory
  roots (including root aliases), refuses below-root symlinks and parent traversal,
  and uses an isolated Python 3.9+ worker to check descriptor containment before
  reading and before returning bytes on Linux/macOS. Both enabled modes refuse
  Windows; missing restricted-mode support fails closed without a fallback.
  CLI policy/root/capability errors are refused before Slack authentication,
  without echoing raw configuration or filesystem paths.
- **Operators:** explicit `unrestricted` mode permits any regular file readable
  by the connector account, including through symlinks, without a directory
  boundary or Python dependency. On Linux this includes the connector process's
  own `/proc/self/environ`, and therefore its Slack tokens and any other secret
  in its environment. Enable unrestricted mode only where the agent is already
  trusted with those credentials. Both modes bound reads from the opened file;
  optional `maxBytes` sets a per-file cap from 1 byte to 1 GiB, defaulting to
  5 MiB. Inline content keeps its 5 MiB cap. Whole files may occupy multiple
  memory copies; this is not a process-memory or concurrency limit.
- Path uploads add the `files` tool class alongside `comms`, may omit `filename`
  to use the path's basename, and retain destination checks before reads and
  uploads, Slack's three-step upload, and rollback. Pinned roots and descriptor
  checks are not immutable snapshots, a perpetual atomic boundary or an OS
  sandbox; hard links, privileged mounts and equivalent account access remain
  outside that boundary.
