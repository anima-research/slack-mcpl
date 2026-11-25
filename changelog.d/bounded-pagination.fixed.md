- Bound pagination for conversation listings, the `find_user` directory search
  and backscroll in both legacy and explicit-policy mode (embedded `findUsers`
  without a policy keeps main's unbounded pagination; cursor-cycle refusal is
  policy-only). Page-limit stops retain eligible
  results and explicitly report incompleteness rather than throwing; background
  registration and refresh distinguish partial enumeration from full coverage.
- With the policy unset, embedded `SlackAdapter.findUsers` retains main's
  array result and pagination for every match limit; use `findUsersBounded`
  to opt into bounded directory pagination.
- Add validated operator page limits, defaulting to 1000 conversation pages,
  1000 directory pages and 100 backscroll pages. `find_user` now reports its existing 25-match stop with `truncated: true`,
  `stopReason: match_limit` and a note, also without a policy, when the 25th match is found and either more
  members follow it on that page or the page offers a next cursor; embedded `fetchHistory` adds
  `stopReason: 'message_limit'` to a result cut at its message limit, also without a policy. The normal backscroll message
  window does not carry an incomplete warning. Complete well-formed results below all
  limits retain their previous API, tool-text and log bytes; policy directory rows/pages are validated; unset validation is unchanged.
- Page limits bound background registration and backscroll requests. Interactive
  find_user and legacy list_channels/refresh_channels still error without partial
  results if a rate limit or the existing 25-second deadline stops a page first.
  Policy list_channels and refresh_channels instead return the rows admitted so
  far with an incomplete notice if either stop affects a page or candidate check.
  The default 1000-page ceilings are unlikely to be reached in a tool call.
  Backscroll delivery gives up after 5 seconds or the first rate limit, without
  context or an incomplete note; after timeout or disconnect no further pages
  are requested, though an in-flight request may still finish.
- Incomplete `list_channels` results add a text block; `refresh_channels` adds
  `truncated`/`stopReason` and registration enumeration metadata where applicable.
  Page-limited backscroll uses `truncated="true"` and an incomplete-history note.
- Embedded `fetchHistory` results can include `stopReason`; `SlackListing` can
  include `truncation`, including without a policy. With a policy, one page validator checks each conversation, directory, history and MPIM membership page as it arrives, before any row is used and before any limit, scope-restart, rate-limit or deadline return: it refuses a malformed container, a malformed listing candidate or directory row, a history row that is not a message object with a Slack timestamp naming a representable date, a present non-string `next_cursor` (such as `0`) and a repeated cursor. `fetch_history` and `fetch_thread`, which continue by timestamp, refuse a policy page whose `has_more`, `response_metadata` or `next_cursor` is malformed before taking any of its rows, instead of reporting the range complete. Unset mode runs main's code for these reads, error text included, bounded only by the documented limits.
