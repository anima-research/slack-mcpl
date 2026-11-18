- **Embedded callers:** `SlackAdapter.findUsers` now returns an array for a
  complete search or `{ matches, truncated, reason, pages, limit }` for a
  match/page-limit stop, including without an access policy. Handle both
  variants (for example with `Array.isArray`) before mapping search results.
  Complete searches still return arrays. This is a source/API change even
  with no policy; normal complete tool-result text is unchanged.
- **Embedded callers:** `SlackAdapter.listConversations` can return a partial listing at `pagination.conversations` (default 1000 pages); inspect `truncation` before treating it as complete. `SlackAdapter.fetchHistory` can return partial backscroll at `pagination.backscroll` (default 100 pages); inspect `truncated` and `stopReason`. Increase the corresponding limits deliberately when needed. Complete results remain unchanged, and no host/core version upgrade is required.
- **Embedded policy callers:** conversation listings, directory searches and backscroll reject cursor cycles and malformed directory pages/rows. Retry once, then ask the operator to investigate upstream pagination/data rather than assuming an empty complete inventory. Unset mode retains main validation and cursor behavior, bounded only by explicit incomplete page-limit results. The new optional `pagination` object and its finite integer limits are validated; remove unrelated/invalid values or supply supported limits. Other unknown configuration properties remain unaffected.
