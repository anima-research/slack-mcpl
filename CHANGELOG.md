# Changelog

Notable changes to `slack-mcpl`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog).

The initial server (package version 0.1.0, July 2026, never tagged) predates
this file; for its contents see the README and `git log`.

## Unreleased

### Fixed

- Concurrent acknowledgement cleanup shares one removal attempt and respects the five-attempt limit. Shutdown cancels pending expiry and retry timers instead of retrying against a disconnected Slack client (#9).
- Empty or whitespace-only `SLACK_DISABLE_DMS` and `SLACK_SUBSCRIBE_MEMBER_CHANNELS` values stop startup, as other invalid boolean values do (#9).
