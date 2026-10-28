- **Hosts and operators:** slack-mcpl now needs Node.js 22.12.0 or later.
  If you install or run it on Node 20, 21, or 22 before 22.12, upgrade Node
  first. Its `engines` said `>=20.0.0`, and Node 20 reached end of life on
  2026-04-30. Apart from the Node version it needs, this change alters
  nothing about the server. On an older Node, npm warns with `EBADENGINE`
  and installs anyway; with `engine-strict` set, it refuses to install. CI
  runs the whole suite on Node 22.12.0 on Linux, and installs the server
  and checks that it loads on Node 22.12.0 and the newest release on Linux
  and macOS, and on Node 24 on Linux.
