- Bound conversation listings, user-directory searches and backscroll pagination
  in both legacy and explicit-policy mode. Page-limit stops retain eligible
  results and explicitly report incompleteness rather than throwing; background
  registration and refresh distinguish partial enumeration from full coverage.
- Add validated operator page limits, defaulting to 1000 conversation pages,
  1000 directory pages and 100 backscroll pages. `find_user` now reports its existing 25-match stop with `truncated`,
  `stopReason: match_limit` and a note when directory rows remain unexamined; the normal backscroll message
  window does not carry an incomplete warning. Complete well-formed results below all
  limits retain their previous API, tool-text and log bytes; policy directory rows/pages are validated; unset validation is unchanged.
- Page limits bound background registration and backscroll requests. Interactive
  find_user and legacy list_channels/refresh_channels still error without partial
  results when their existing 25-second call budget or rate limit stops first;
  the default 1000-page ceilings are unlikely to be reached in a tool call.
  Backscroll delivery gives up after 5 seconds or the first rate limit, without
  context or an incomplete note; page caps bound abandoned fetch requests too.
- Incomplete `list_channels` results add a text block; `refresh_channels` adds
  `truncated`/`stopReason` and registration enumeration metadata where applicable.
  Page-limited backscroll uses `truncated="true"` and an incomplete-history note.
- Embedded `fetchHistory` results can include `stopReason`; `SlackListing` can
  include `truncation`, including without a policy. Policy directory readers reject malformed page shapes/rows; unset mode retains main behavior.

- Policy foreground candidate rate limits preserve collected rows with an explicit incomplete notice; candidate admissions share the initial pacer, not final delivery checks.
