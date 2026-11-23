- When `SLACK_ACCESS_POLICY` is set, inbound admission and conversation
  candidate checks share slots released at least 1.2 seconds apart. DMs and
  mentions go first, foreground listing and refresh go next, then the oldest
  ambient work. The ambient admission and delivery backlogs each drop their
  oldest waiting item above 32. Final delivery, acknowledgements and backscroll
  can incur separate Slack requests.
- A foreground listing returns its admitted rows with an incomplete notice
  if a rate limit or the 25-second deadline stops a `conversations.list` page
  or candidate check. There is no
  continuation cursor: `list_channels` may stop near the same place again.
  `refresh_channels` skips already registered IDs before pacing and can
  reach newly joined conversations beyond them. Its visible count includes
  known IDs found in that scan, not a recheck of their access.
- Background registration skips and reports failed candidates and announces
  healthy conversations after its scan. With joined-channel reads off, scans
  request only enabled DM types. With no enabled type there is nothing to list.
- A final verification failure can drop delivery; a bounded transient fallback
  is allowed only without a known lasting refusal or withdrawn grant. A refused
  acknowledgement cleanup can leave the reaction visible. Routine inbound
  admission failures are counted on stderr without message IDs; an admission
  failure that prevents adding an acknowledgement is logged per message.
  Shutdown and overload
  diagnostics identify dropped work where available. Server-side policy drop
  logs include the thread root for replies. Slack does not replay
  acknowledged messages.
- An opened DM can remain open after the post is refused. An uncertain post
  says where to check before retrying, using the admitted conversation kind.
