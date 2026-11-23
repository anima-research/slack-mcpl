- **Embedded callers:** With an access policy, `SlackAdapter.findUsers`
  returns an array for a complete search or `{ matches, truncated, reason,
  pages, limit }` for a match/page-limit stop. With no policy it retains the
  original array result and pagination at runtime, but its declared TypeScript
  return type is the union in both modes: typed code that maps the result must
  narrow it first, even with no policy. To opt into bounds in either mode,
  use `SlackAdapter.findUsersBounded` and handle both result variants (for
  example with `Array.isArray`) before mapping search results.
- **Embedded callers:** `SlackAdapter.listConversations` can return a partial listing at `pagination.conversations` (default 1000 pages); inspect `truncation` before treating it as complete. `SlackAdapter.fetchHistory` can return partial backscroll at `pagination.backscroll` (default 100 pages); inspect `truncated` and `stopReason`. Increase the corresponding limits deliberately when needed. Complete results remain unchanged, and no host/core version upgrade is required.
- **Embedded policy callers:** conversation listings, directory searches and backscroll reject cursor cycles (even on the page where a match or message limit would stop), malformed listing candidates (background registration included), malformed directory pages/rows, history rows whose timestamp is not a representable date, and a present non-string `next_cursor`. Retry once, then ask the operator to investigate upstream pagination/data rather than assuming an empty complete inventory. Unset mode retains main validation and cursor behavior, with explicit incomplete results for bounded searches and reads. The new optional `pagination` object and its finite integer limits are validated, and an unknown key inside it (such as a misspelled `conversation`) is refused rather than ignored; remove unrelated/invalid values or supply supported limits. Other unknown configuration properties remain unaffected.
